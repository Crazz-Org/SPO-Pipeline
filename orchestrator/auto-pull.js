'use strict';
// auto-pull.js -- the daemon's own periodic pull-and-enqueue, real mode only (state-machine.js's
// runForever calls this from the scanner process's own scan cycle -- action 6.3 moved the scans
// out of the dispatcher's process; see dispatcher.js's header). Wraps orchestrator/intake.js's existing
// pullBoard/makeTask -- the exact same read-only `npm run board:claim` scan and per-candidate
// `gh api` issue fetch `spo pull` already runs by hand -- on a config.autoPullMs timer instead
// of a human running `spo pull`.
//
// GraphQL cost: `npm run board:claim` is the same ~2-4 point cheap pool read
// doc/kanban-workflow.md § GitHub API discipline already documents for `spo pull` (see
// orchestrator/README.md § Kanban piloting) -- this timer does not add a new kind of GitHub
// read, it just runs the existing one on a schedule instead of only on request.
//
// action 6.6: the watermark. `autoPullLimit` used to mean "how many candidates ONE cycle takes
// off the board", full stop -- safe only because auto-pull used to run inside the same serial
// loop `runForever` awaited `drainQueueOnce` on, so a pull only ever landed with the daemon idle
// and the limit doubled as a ceiling on how many cards could ever sit off the board at once.
// Action 6.3 moved the scans into their own scanner process on their own timer (see this file's
// first paragraph above and dispatcher.js's header) -- config.js's own action-6.3 correction note
// already says the old guarantee "is no longer true". It genuinely was not: at the shipped
// defaults (workers=1, autoPullMs=5min, autoPullLimit=1) a scanner with no ceiling at all would
// pull one more claimable card off the board every 5 minutes FOREVER, regardless of how many were
// already in flight or queued -- 12/hour, unclaimable by a human, piling into queue/ -- with no
// self-correction, because nothing ever shrank the count back down.
//
// THE FIX: `autoPullLimit` survives as a per-cycle RATE cap ("take at most this many off the
// board on any one pass" -- the maintainer's 2026-08-29 "one card at a time" decision, still
// true), but a second, harder ceiling now sits above it: `in-flight + queued <= config.workers`.
// The plan names this ceiling as K, not K+autoPullLimit, and K is the right choice -- the
// maintainer's own stated rationale for autoPullLimit ("cards stay on the board -- visible,
// reorderable, claimable by a human -- until a worker is actually ready for them") is only kept
// true if the board can never hold more off-board cards than there are workers to ever pick them
// up. A K+autoPullLimit ceiling would let autoPullLimit's "headroom" sit permanently unclaimable
// once every worker is busy -- exactly the failure this action exists to close. So: pull
// min(autoPullLimit, K - inFlight - queued), never negative, capped at whatever pullBoard
// actually found claimable.
//
// STALENESS: `journal.readLiveWorkerIds` is this (separate) process's only view of "in flight" --
// see journal.js's own header for the full cross-process design. Two directions to reason about,
// same as 6.3 did for the SAME file:
//   - OVER-reporting in-flight (the file still lists a worker that has already exited) makes
//     this cycle see LESS headroom than truly exists -- under-pulls. Safe: self-corrects the
//     moment dispatcher.js's handleExit publishes the departure (which it does only AFTER any
//     repark that exit warranted has already landed -- see dispatcher.js's own header), and at
//     worst costs one delayed cycle, exactly like orphanScan's own tolerance of the same file.
//   - UNDER-reporting in-flight (the file doesn't yet list a worker dispatcher.js only just
//     spawned) makes this cycle see MORE headroom than truly exists -- over-pulls. Unsafe: this
//     is the direction that recreates the regression this action closes.
// computeAutoPullBudget below reads `queued` BEFORE `inFlight`, not incidentally: dispatcher.js's
// fillSlots takes a task out of queue/ (takeNextTask's rename) and only THEN spawns and publishes
// it as in-flight (spawnOne) -- there is a real, if small (bounded by one appendDaemonEvent write
// plus one writeLiveWorkerIds write), cross-process window where a task is in NEITHER place.
// Reading queued first means this scanner's own read pair can only land BOTH inside that window
// (undercounting by 1, unsafe) if both reads happen to fall strictly between the rename and the
// publish; reading inFlight first would let ANY overlap between the scanner's reads and that
// window undercount, and would make the safe (double-counting) outcome structurally impossible.
// Reversing the read order is therefore not cosmetic.
//
// ABSENT FILE: a scanner running before the dispatcher's first spawn (or with no dispatcher at
// all -- a --scanner-only test, a standalone scan) finds no live-workers.json. journal.js's
// readLiveWorkerIds tolerates that by returning an empty Set, which is the RIGHT answer for
// orphanScan (nothing to protect from a repark) but the WRONG answer here -- "no file" must never
// be read as "0 workers running", or a scanner started moments before the dispatcher would use
// that accidental ordering to fill the queue past K before a single worker exists to drain it.
// computeAutoPullBudget below therefore treats a missing file as inFlight=K (the real worst case
// dispatcher.js's fillSlots can ever produce -- it never lets `live.size` exceed K), which forces
// headroom to <=0 and this cycle pulls nothing.
//
// THIS PARAGRAPH USED TO END "safe and self-correcting: the instant the dispatcher's first spawn
// writes the file, the next cycle sees the real number". That was wrong, and it was the defect
// this action shipped. publishLiveWorkerIds only ran from spawnOne/handleExit, so on a cold start
// with an EMPTY QUEUE there was no first spawn, hence no file -- and auto-pull is the only thing
// that puts a card in the queue. No file -> budget 0 -> no queue entry -> no spawn -> no file:
// a closed loop with nothing outside it to break the cycle, so the daemon would simply never pull
// a card again. Measured with a real `--real` dispatcher on an empty queue at
// SPO_AUTO_PULL_MS=3000: ZERO `npm run board:claim` calls in 20s (~6 due cycles), against 3 in
// the next 20s once an empty live-workers.json was written into the same journal root by hand.
// The same loop closed on a RESTART, from the other side: a SIGTERM'd daemon left the file
// listing whatever was in flight at death, nothing ever cleared it, and those dead ids held the
// watermark shut forever.
//
// dispatcher.js's run() now publishes the empty table ONCE at startup, before it spawns the
// scanner -- see the comment there. That is what makes "absent" mean what this paragraph says it
// means: absent now genuinely distinguishes "no dispatcher owns this journal root" (a standalone
// scan, a --scanner-only test -- pull nothing, correctly) from "a dispatcher owns it and is
// idle" (pull up to K), instead of conflating the two into the first.

const fs = require('fs');
const intake = require('./intake');
const { appendDaemonEvent, liveWorkersPath, readLiveWorkerIds } = require('./journal');
const { queuedIds } = require('./orphan-scan');

const DEFAULT_AUTO_PULL_MS = 5 * 60 * 1000;
// Mirrors config.js's own shipped autoPullLimit (SPO_AUTO_PULL_LIMIT, default 1). It used to be
// 3, and never matched: the earlier verification round noticed the mismatch, reasoned it was
// unreachable in production ("only a caller that omits the field"), and left it. That reasoning
// was wrong in the one direction that matters -- see resolveNonNegativeInt below -- and it is
// pinned to config.js's own value by a test now, so the two cannot drift apart again silently.
const DEFAULT_AUTO_PULL_LIMIT = 1;
const DEFAULT_WORKERS = 1; // mirrors config.js's own WORKERS fallback (SPO_WORKERS, default 1)

// Resolving a numeric knob for which 0 IS A MEANINGFUL SETTING, not a synonym for "unset".
//
// `(config && config.autoPullLimit) || DEFAULT_AUTO_PULL_LIMIT` -- what this replaces -- turned
// the one input an operator would reach for to switch auto-pull off into its opposite: 0 is
// falsy, so the fallback fired and `SPO_AUTO_PULL_LIMIT=0` resolved to the module default. The
// trap is baited by config.js's own neighbouring knob, whose comment says "0 disables the timer
// entirely" about autoPullMs -- so the sibling knob quietly meaning "0 => the default instead"
// is exactly the assumption an operator carries over. `Number(process.env.X)` upstream means the
// same fallback also swallowed `SPO_AUTO_PULL_LIMIT=abc` (NaN) and any negative value.
//
// The three cases are now distinct on purpose:
//   - absent (undefined/null): the caller has no opinion -> `fallback`. A test that only cares
//     about top-N behaviour still gets a working default, and production still gets config.js's.
//   - a non-negative integer, INCLUDING 0: honoured exactly. 0 means pull nothing.
//   - anything else (NaN, negative, fractional, a string): 0, i.e. pull nothing.
// That last choice is deliberate and asymmetric. config.js is the layer that turns an operator's
// typo into the documented default (positiveIntFromEnv already does this for SPO_WORKERS, and
// nonNegativeIntFromEnv now does it for SPO_AUTO_PULL_LIMIT), so a value that is still malformed
// by the time it reaches HERE came from a programmatic caller, not a typo -- and this is the last
// gate before cards come off a live board. For a rate cap the safe failure direction is to pull
// nothing and be noticed, never to invent a number nobody configured.
function resolveNonNegativeInt(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

// Pure decision function -- no Date.now() call baked in, so a test drives it with any
// (lastPullAt, nowMs) pair (the "injectable clock"). autoPullMs <= 0 disables the timer
// entirely regardless of lastPullAt (config.js's SPO_AUTO_PULL_MS=0 override).
function shouldAutoPull(lastPullAt, nowMs, autoPullMs) {
  if (!(autoPullMs > 0)) return false;
  if (lastPullAt === null || lastPullAt === undefined) return true;
  return nowMs - lastPullAt >= autoPullMs;
}

// computeAutoPullBudget(queueDir, journalRoot, config) -- pure-ish (its only I/O is two cheap
// reads: queue/'s own directory listing and live-workers.json) ceiling computation, kept separate
// from runAutoPull's pullBoard/makeTask side effects so a test can exercise the watermark
// arithmetic directly, the same way shouldAutoPull is kept separate from the timer's own I/O.
// Returns {limit, queued, inFlight, K, atWatermark} -- `limit` is how many candidates THIS cycle
// may turn into queue files, already clamped to [0, autoPullLimit]; `atWatermark` is true whenever
// queued+inFlight had already reached (or passed) K BEFORE this cycle pulled anything, distinct
// from "limit came out 0 because autoPullLimit itself is 0".
function computeAutoPullBudget(queueDir, journalRoot, config) {
  // K keeps the `|| DEFAULT_WORKERS` shape deliberately, unlike perCycleCap below: 0 is NOT a
  // meaningful worker count (config.js's positiveIntFromEnv already refuses SPO_WORKERS=0, and
  // dispatcher.js's resolveWorkerCount refuses it again), so there is no legitimate 0 here for a
  // falsy test to swallow -- and a K of 0 would silently mean "this daemon can never run a card".
  const K = (config && config.workers) || DEFAULT_WORKERS;
  const perCycleCap = resolveNonNegativeInt(config && config.autoPullLimit, DEFAULT_AUTO_PULL_LIMIT);

  // Read order matters -- see this file's header for the full race derivation.
  const queued = queuedIds(queueDir).size;

  let inFlight;
  if (fs.existsSync(liveWorkersPath(journalRoot))) {
    inFlight = readLiveWorkerIds(journalRoot).size;
  } else {
    // No dispatcher has ever published to this journal root -- see this file's header ("ABSENT
    // FILE"). Assume the worst reachable value, not zero.
    inFlight = K;
  }

  const headroom = K - queued - inFlight;
  return {
    limit: Math.max(0, Math.min(perCycleCap, headroom)),
    queued,
    inFlight,
    K,
    atWatermark: headroom <= 0,
  };
}

// runAutoPull(queueDir, journalRoot, config, deps) -- pullBoard + makeTask for the top N
// claimable candidates, N = computeAutoPullBudget's `limit` above (at most config.autoPullLimit,
// and never more than would push in-flight + queued past config.workers). Same dedup rules as
// `spo pull` (intake.makeTask skips one already in queue/ or journal/). Journals exactly one
// `auto-pull` event to journalRoot's own daemon.jsonl per call, and only when at least one
// candidate was actually written -- never for a cycle that found nothing new, and never for a
// cycle blocked by the watermark either (see this file's header for the noise-vs-signal
// reasoning: this project once buried a real 33-hour outage under 1164 near-identical
// steady-state events; "we are at the watermark" is exactly that same shape of repeating,
// no-state-change event once a maintainer deliberately runs a busy queue at a low K, so it stays
// silent here for the same reason, not journalled as a new event type). The caller gets the
// distinction for free in the return value (`atWatermark`) without a daemon.jsonl entry for it.
// Returns {ok, enqueued, issues, warnings, errors, atWatermark, queued, inFlight}.
async function runAutoPull(queueDir, journalRoot, config, deps = {}) {
  const budget = computeAutoPullBudget(queueDir, journalRoot, config);
  const pullDeps = { productRepo: config && config.productRepo, ...deps };

  if (budget.limit <= 0) {
    // At (or already over) the watermark: skip pullBoard entirely rather than spending a
    // GraphQL read to discover candidates this cycle cannot take anyway -- see this file's
    // header's GraphQL-cost paragraph for why that read is not free to begin with.
    return {
      ok: true,
      enqueued: 0,
      issues: [],
      warnings: [],
      errors: [],
      atWatermark: budget.atWatermark,
      queued: budget.queued,
      inFlight: budget.inFlight,
    };
  }

  const pulled = intake.pullBoard(pullDeps);
  if (!pulled.ok) {
    return { ok: false, error: pulled.error, enqueued: 0, issues: [], warnings: [], errors: [] };
  }

  const top = pulled.candidates.slice(0, budget.limit);
  const enqueuedIssues = [];
  const errors = [];

  for (const candidate of top) {
    const made = intake.makeTask(candidate, { ...deps, queueDir, journalRoot });
    if (!made.ok) {
      errors.push({ issue: candidate.issue, error: made.error });
      continue;
    }
    if (!made.skipped) enqueuedIssues.push(candidate.issue);
  }

  if (enqueuedIssues.length > 0) {
    appendDaemonEvent(journalRoot, 'auto-pull', { enqueued: enqueuedIssues.length, issues: enqueuedIssues });
  }

  return {
    ok: true,
    enqueued: enqueuedIssues.length,
    issues: enqueuedIssues,
    warnings: pulled.warnings,
    errors,
    atWatermark: false,
    queued: budget.queued,
    inFlight: budget.inFlight,
  };
}

module.exports = {
  shouldAutoPull,
  runAutoPull,
  computeAutoPullBudget,
  resolveNonNegativeInt,
  DEFAULT_AUTO_PULL_MS,
  DEFAULT_AUTO_PULL_LIMIT,
};
