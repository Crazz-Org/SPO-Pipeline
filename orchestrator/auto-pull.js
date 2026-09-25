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
// actually found claimable. Card #263 narrowed `queued` to RUNNABLE entries -- see "THE RULE" below.
//
// STALENESS: `journal.readLiveWorkerIds` is this (separate) process's only view of "in flight" --
// see journal.js's own header for the full cross-process design. Two directions to reason about,
// same as 6.3 did for the SAME file:
//   - OVER-reporting in-flight (the file still lists a worker that has already exited) makes
//     this cycle see LESS headroom than truly exists -- under-pulls. Safe: self-corrects the
//     moment dispatcher.js's handleExit publishes the departure, and at worst costs one delayed
//     cycle, exactly like orphanScan's own tolerance of the same file. CARD #78 CORRECTION: this
//     used to say the departure is published "only AFTER any repark that exit warranted has
//     already landed" -- true only while a crash repark ran synchronously, in-process. It is
//     FALSE now: handleExit drops the id from `live` (and publishes) the INSTANT it has spawned
//     the repark child (reparkCrashedWorker), before that child's own park has done anything at
//     all -- see dispatcher.js's own header. That is the CORRECT thing for THIS file's own
//     purpose, not a new risk: a repark child holds no worker slot (dispatcher.js's `reparking`
//     Map is tracked separately from `live` for exactly this reason -- see that Map's own
//     comment), so the slot really IS free the moment the id leaves `live`, and this budget
//     should count it as free at that same instant rather than wait for a park that has nothing
//     to do with worker-slot headroom to finish first.
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
//
// CARD #263: A DEFERRED QUEUE ENTRY IS NOT A RUNNABLE ONE. `queued` above used to be every id in
// queue/ (orphan-scan.js's queuedIds), including entries whose `notBefore` is still in the future:
// finalizePark's pool-waits (card #119 -- a card re-enqueued until its account-pool cooldown ends,
// up to config.poolExhaustionWaitCapMs = 12h) and its deferred transient retries (1-5 min).
// takeNextTask skips those (state-machine.js's isQueueEntryEligibleNow), so no worker can start
// them -- yet they held the watermark shut. Probed against this function on 2026-09-25: K=2, an
// empty live-workers.json and 2 pool-waiting entries gave `limit: 0, atWatermark: true`. That is
// the 2026-09-16/17 shape, re-measured from the journal's `pool-wait` events: 2 pool-waits
// (issue-887, issue-888), 11.7h with both deferred and 0 in flight (4 wake-ups each); issue-894
// pool-waited alone on 09-17. The scanner pulled nothing, so the dispatcher had nothing it could
// run even where a fresh card's first step was servable.
//
// THE RULE: an entry counts toward K only if takeNextTask could take it NOW -- the same
// isQueueEntryEligibleNow predicate, so "runnable" here cannot drift from "runnable" there. An
// entry whose notBefore has passed (or that has none, or is unparsable) counts exactly as before
// -- unless the model-aware clamp would skip it (card #268 added that second condition, below).
//
// THE BOUND: excluding deferred entries outright would reopen the unbounded pull action 6.6
// closed, one level down. During a long exhaustion, each fresh card can run a step, pool-wait,
// leave the K count, and free room for the next pull -- one card per cycle (12/hour at
// SPO_AUTO_PULL_MS=300000) off the board for up to 12h each. No existing ceiling stops that:
// nothing else caps the task queue/ (SPO_REMOTE_REPORT_QUEUE_CEILING caps the bug-report queue,
// ~/.spo-reports, not this one). So a second ceiling sits above K: every card off the
// board -- runnable queued + deferred queued + in flight (+ unservable queued, card #268) -- is never pulled past
// OFF_BOARD_CEILING_MULTIPLE * K. At 2 that is K workers' worth of deferred cards on top of the K
// watermark. At production K=2 the 09-16/17 shape (2 deferred, 0 in flight) pulls one card per
// cycle, twice, until 2 deferred + 2 in flight = 4, then stops until one leaves. The deferred
// cards are not lost: they come back on
// their own at notBefore and then count toward K again, which can briefly leave runnable + inFlight
// above K. The existing clamp to 0 absorbs that, as it already does for a manual `spo pull` past K.
//
// CARD #268: A DUE ENTRY THE MODEL-AWARE CLAMP SKIPS IS NOT RUNNABLE EITHER. #166 (action 2) gave
// takeNextTask a per-candidate `admit` (dispatcher.js's fillSlots): 'take', 'hold', or 'skip' when
// servableFor(nextLlmCallForTask(entry)).healthy === 0 -- no enabled account is healthy for the
// model the entry's FIRST LLM call needs. A skipped entry is due, so #263's rule still counted it,
// yet it is never spawned while its model is unservable, and so never deferred again either: it
// stays due, and counted, for as long as the model cools (up to 5h for a session-scoped Fable
// cooldown, days for a weekly one, ~32h of Fable model limit on 09-16/17 for a fresh card whose
// last park was plan-invalid). Probed against this function on 2026-09-25: K=2, Fable cooling on
// both accounts with no recorded scope, Opus 5.5 healthy on both, 2 due resumes-at-CHECK (first
// call a Fable judge) and 0 in flight gave `limit: 0, atWatermark: true` -- the healthy Opus
// capacity the relaxed clamp was built for sat idle. (That exact pool no longer skips a contract
// judge since SPO-Pipeline#277 -- no Fable quota anywhere and Opus 5.5 healthy, so it falls back and
// is servable; a skipped judge now needs a Fable 529 holding the fallback back, and a plan-invalid
// fresh card's Fable PLAN still skips as before.) So THE RULE is now: an entry counts toward K
// only if it is due AND servable now (servableFor(...).healthy > 0), the same two first-call-model.js
// functions fillSlots' admit asks, with the same arguments (the entry, <journalRoot>/<id> as its
// taskDir, config; config.claudeAccountsDir as the pool). A due-but-unservable entry is counted
// like a deferred one: against the 2K off-board ceiling only (THE BOUND above covers it unchanged).
// A HELD entry (servable, but the live workers already match its healthy accounts) still counts
// toward K -- it runs next, and nothing pulled behind it could overtake it (takeNextTask's queue
// order rule), so pulling for it would only park a card off the board. That is why this asks
// `healthy > 0`, never fillSlots' `live.size < min(K, healthy)`.
//
// CANNOT JUDGE -- one rule for this per-entry count and for THE GATE below, applied consistently.
// Servability is judged only against a pool that exists: config.claudeAccountsDir set, its
// directory present, its registry readable, and at least one account registered in it
// (judgeablePoolDir). Anything else -- an unset key, a missing directory, a pool with no
// registered account, an unreadable registry -- means this cycle cannot judge: every due entry
// counts as runnable and the gate stays open, which is #263's behaviour exactly. So does a throw
// while judging one entry (that entry counts as runnable) or the fresh card (the gate stays
// open). Why not read "no pool" as "nothing is servable": config.js defaults claudeAccountsDir to
// ~/.claude-accounts, so a checkout or CI runner with no pool there would silently stop
// auto-pulling. That is a stall with no cooldown to lift it, found when this card's own CI run
// went red on the one test that reads the shipped config. Nothing is lost by it either: an
// all-cooling pool that DOES exist is still judged, and spawning is decided by the dispatcher's
// own clamp, which reads the same pool. On an empty pool that clamp finds nothing to spawn, and
// daemon.js refuses to start --real at all. Every direction here under-pulls relative to #268's
// judgement and never over-pulls relative to #263. (A pool whose registered accounts are all
// DISABLED is a pool that exists: it is judged, and nothing is servable.) Cost: nextLlmCallForTask reads a fresh card's
// journal.jsonl (lastParkWasPlanInvalid, up to ~880 KB for the longest-lived card on disk) plus the
// pool's registry and state.json, per due queue entry, once per auto-pull cycle (5 min by
// default) -- the same reads fillSlots already makes per candidate on every 5s poll.
//
// THE GATE (card #268 verification, R1): excluding skipped entries must not claim cards that
// cannot run either. When the model a FRESH card's first call needs is itself unservable -- an
// account-wide exhaustion, or a model-scoped limit on claude-opus-5-5 (PLAN, IMPLEMENT and
// DIAGNOSE all run on it) -- every card this scanner pulls would be skipped too. Counted as
// unservable, they would leave K open, and auto-pull would fill to the 2K ceiling with cards
// that are never spawned. The #119 cap and the reconciler never see such a card, and it stays in
// Todo on the board while already committed in queue/. The verifier measured it against main at K=2:
// whole-account cooling on an empty queue pulled 4 (main: 2), with 2 due resumes 2 (main: 0),
// and at K=3 6 (main: 3). So once per cycle computeAutoPullBudget asks the same question of the
// card it would bring, the hypothetical fresh card fillSlots judges for STARVED
// (nextLlmCallForTask({}, null, config)); if no account can serve it, `limit` is 0 and
// `freshUnservable` says why -- distinct from `atWatermark`, which stays about the two ceilings.
// The judgement is exact for anything auto-pull can bring, not an approximation: intake.js's
// makeTask skips a card whose journal dir already exists (taskAlreadyExists), and writes no
// `llm` override or `resume` descriptor, so an auto-pulled card is always a fresh card with no
// history -- its first call is PLAN on PLAN's base model, exactly the null-taskDir row. The 2K
// ceiling now binds only while fresh cards ARE servable (skipped entries on another model, e.g.
// Fable judges held back from their fallback by a Fable 529, or plan-invalid cards' Fable PLAN). A
// pool that cannot be judged (CANNOT JUDGE above:
// unset, missing, no registered account, unreadable) or a throw while judging counts as servable
// -- which errs toward #263's behaviour, never past it.
//
// first-call-model.js is required inside the functions that use it (servableNowJudge,
// freshCardServable), not at the top of this file. Only CALLING it while state-machine.js is
// still loading would throw -- its own state-machine.js lookups are lazy, and this module is
// loaded BY state-machine.js; the require itself is lazy for symmetry with the state-machine.js
// require below, and so a process that never judges never loads it.

const fs = require('fs');
const path = require('path');
const intake = require('./intake');
// accounts.js requires none of state-machine.js / auto-pull.js / dispatcher.js (first-call-model.js's
// header, pinned by test/dispatcher-model-clamp.test.js), so a top-level require is cycle-free.
const accounts = require('./accounts');
const { appendDaemonEvent, liveWorkersPath, readLiveWorkerIds } = require('./journal');
const { readJsonSafe } = require('./park-loop');

const DEFAULT_AUTO_PULL_MS = 5 * 60 * 1000;
// Mirrors config.js's own shipped autoPullLimit (SPO_AUTO_PULL_LIMIT, default 1). It used to be
// 3, and never matched: the earlier verification round noticed the mismatch, reasoned it was
// unreachable in production ("only a caller that omits the field"), and left it. That reasoning
// was wrong in the one direction that matters -- see resolveNonNegativeInt below -- and it is
// pinned to config.js's own value by a test now, so the two cannot drift apart again silently.
const DEFAULT_AUTO_PULL_LIMIT = 1;
const DEFAULT_WORKERS = 1; // mirrors config.js's own WORKERS fallback (SPO_WORKERS, default 1)
// Card #263: the ceiling on every card off the board (runnable queued + unservable queued (card
// #268) + deferred queued + in flight) is this multiple of K -- see this file's header, "THE BOUND".
const OFF_BOARD_CEILING_MULTIPLE = 2;

// judgeablePoolDir(config) -> the account pool fillSlots judges against (config.claudeAccountsDir),
// or null when this cycle cannot judge servability at all (this file's header, "CANNOT JUDGE"):
// the key is unset, the directory is missing, it registers no account, or its registry cannot be
// read. "No account registered" is keyed on the condition accounts.js itself uses for it --
// readRegistry() comes back empty (a missing directory included), which is exactly when pick()
// throws NoAccountsRegisteredError and daemon.js refuses to start --real -- never on an error
// string. Read ONCE per cycle, in computeAutoPullBudget, and handed to both judges, so the
// fresh-card gate and the per-entry count can never disagree about whether a pool exists.
function judgeablePoolDir(config) {
  const accountsDir = config && config.claudeAccountsDir;
  if (typeof accountsDir !== 'string' || accountsDir === '') return null;
  try {
    return accounts.readRegistry(accountsDir).length > 0 ? accountsDir : null;
  } catch {
    return null; // unreadable registry (e.g. the path is a regular file: ENOTDIR)
  }
}

// freshCardServable(config, poolDir, nowMs) -> boolean: could any account serve the first call of
// the card auto-pull would bring -- a fresh card, no history (this file's header, "THE GATE")? The
// same hypothetical fresh card fillSlots judges for STARVED. No judgeable pool (poolDir null), or
// a throw, answers true.
function freshCardServable(config, poolDir, nowMs) {
  if (poolDir === null) return true;
  const { nextLlmCallForTask, servableFor } = require('./first-call-model');
  try {
    return servableFor(nextLlmCallForTask({}, null, config), poolDir, nowMs).healthy > 0;
  } catch {
    return true; // unanswerable -> #263's behaviour, never a pull past it
  }
}

// servableNowJudge(journalRoot, config, poolDir, nowMs) -> (task, id) => boolean, or null when no
// pool is judgeable. Card #268: fillSlots' admit's 'skip' test, negated -- see this file's header.
// Asked with exactly admit's arguments: the parsed entry, <journalRoot>/<id> as its taskDir (what
// takeNextTask hands admit), config, and config.claudeAccountsDir (what fillSlots' accountsDir is).
// `nowMs` is the same instant notBefore is judged against, so an injected clock moves both.
function servableNowJudge(journalRoot, config, poolDir, nowMs) {
  if (poolDir === null) return null;
  // Lazy -- see this file's header: only a CALL during state-machine.js's load would throw.
  const { nextLlmCallForTask, servableFor } = require('./first-call-model');
  return (task, id) => {
    try {
      return servableFor(nextLlmCallForTask(task, path.join(journalRoot, id), config), poolDir, nowMs).healthy > 0;
    } catch {
      return true; // unanswerable -> runnable: under-pull, never over-pull (this file's header)
    }
  };
}

// Per-entry verdicts, ranked: an id with several entries takes its most runnable one.
const RUNNABLE = 2;
const UNSERVABLE = 1; // due, but no account is healthy for its first call's model (card #268)
const DEFERRED = 0; // notBefore still ahead (card #263)

// countQueuedByEligibility(queueDir, journalRoot, config, poolDir, nowMs) -> {runnable, unservable,
// deferred}: queue/'s ids, split by whether takeNextTask (with fillSlots' admit) could take them
// at nowMs. Ids are derived exactly as orphan-scan.js's queuedIds derives them (task.id if
// present, else the filename), so the three counts together equal the queuedIds(queueDir).size
// #263 replaced. An id with several entries (a duplicate pull landing next to a retry) is runnable
// if ANY of its entries is -- takeNextTask would take that one.
function countQueuedByEligibility(queueDir, journalRoot, config, poolDir, nowMs) {
  // Lazy require: state-machine.js requires this module at load time (runScanCycle's auto-pull
  // timer), so a top-level require here would be a load-time cycle -- the same reason, and the
  // same fix, as orphan-scan.js's own lazy require of state-machine.js.
  const { isQueueEntryEligibleNow } = require('./state-machine');
  const verdictById = new Map();
  if (fs.existsSync(queueDir)) {
    const servableNow = servableNowJudge(journalRoot, config, poolDir, nowMs);
    for (const file of fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'))) {
      const data = readJsonSafe(path.join(queueDir, file));
      const id = data && data.id ? String(data.id) : path.basename(file, '.json');
      // readJsonSafe's null (unparsable) is eligible, as takeNextTask's `__invalid` entry is; to
      // nextLlmCallForTask it is a fresh card, as takeNextTask's `__invalid` entry is to admit.
      let verdict;
      if (!isQueueEntryEligibleNow(data, nowMs)) verdict = DEFERRED;
      else if (servableNow && !servableNow(data, id)) verdict = UNSERVABLE;
      else verdict = RUNNABLE;
      verdictById.set(id, Math.max(verdictById.has(id) ? verdictById.get(id) : DEFERRED, verdict));
    }
  }
  const counts = { runnable: 0, unservable: 0, deferred: 0 };
  for (const verdict of verdictById.values()) {
    if (verdict === RUNNABLE) counts.runnable += 1;
    else if (verdict === UNSERVABLE) counts.unservable += 1;
    else counts.deferred += 1;
  }
  return counts;
}

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

// computeAutoPullBudget(queueDir, journalRoot, config, nowMs) -- pure-ish (its only I/O is reads:
// queue/'s own entries, live-workers.json, and -- card #268 -- per due entry the account pool and
// a fresh card's journal.jsonl, through first-call-model.js) ceiling computation, kept separate
// from runAutoPull's pullBoard/makeTask side effects so a test can exercise the watermark
// arithmetic directly, the same way shouldAutoPull is kept separate from the timer's own I/O.
// `nowMs` (default Date.now()) is the instant a queue entry's notBefore is judged against.
// Returns {limit, queued, unservable, deferred, inFlight, K, offBoardCeiling, atWatermark,
// freshUnservable} --
// `limit` is how many candidates THIS cycle may turn into queue files, already clamped to
// [0, autoPullLimit]; `queued` counts only RUNNABLE queue ids (due and servable now),
// `unservable` the due ones no account is healthy for (card #268) and `deferred` the ones whose
// notBefore is still ahead (card #263 -- see this file's header). `atWatermark` is true whenever,
// BEFORE this cycle pulled anything, queued+inFlight had already reached (or passed) K, or
// queued+unservable+deferred+inFlight had reached offBoardCeiling -- distinct from "limit came out
// 0 because autoPullLimit itself is 0". `freshUnservable` is true when no account could serve the
// first call of the card this cycle would pull (this file's header, "THE GATE"), which forces
// `limit` to 0 whatever the two ceilings leave -- also distinct from `atWatermark`.
function computeAutoPullBudget(queueDir, journalRoot, config, nowMs = Date.now()) {
  // K keeps the `|| DEFAULT_WORKERS` shape deliberately, unlike perCycleCap below: 0 is NOT a
  // meaningful worker count (config.js's positiveIntFromEnv already refuses SPO_WORKERS=0, and
  // dispatcher.js's resolveWorkerCount refuses it again), so there is no legitimate 0 here for a
  // falsy test to swallow -- and a K of 0 would silently mean "this daemon can never run a card".
  const K = (config && config.workers) || DEFAULT_WORKERS;
  const perCycleCap = resolveNonNegativeInt(config && config.autoPullLimit, DEFAULT_AUTO_PULL_LIMIT);

  // Card #268: whether a pool can be judged at all, decided once for both judges below. The pool
  // is not part of the queue/live-workers.json race, so reading it first changes nothing there.
  const poolDir = judgeablePoolDir(config);

  // Read order matters -- see this file's header for the full race derivation.
  const { runnable: queued, unservable, deferred } = countQueuedByEligibility(queueDir, journalRoot, config, poolDir, nowMs);

  let inFlight;
  if (fs.existsSync(liveWorkersPath(journalRoot))) {
    inFlight = readLiveWorkerIds(journalRoot).size;
  } else {
    // No dispatcher has ever published to this journal root -- see this file's header ("ABSENT
    // FILE"). Assume the worst reachable value, not zero.
    inFlight = K;
  }

  // Two ceilings, the tighter one binds (cards #263/#268 -- this file's header, "THE RULE" / "THE
  // BOUND"): runnable work against K, and every off-board card against OFF_BOARD_CEILING_MULTIPLE * K.
  const offBoardCeiling = OFF_BOARD_CEILING_MULTIPLE * K;
  const headroom = Math.min(K - queued - inFlight, offBoardCeiling - queued - unservable - deferred - inFlight);
  // THE GATE (this file's header): nothing is pulled while no account could serve the card auto-pull
  // would bring. Judged once per cycle, after the queue and live-workers.json reads above, so the
  // read-order argument is untouched.
  const freshUnservable = !freshCardServable(config, poolDir, nowMs);
  return {
    limit: freshUnservable ? 0 : Math.max(0, Math.min(perCycleCap, headroom)),
    queued,
    unservable,
    deferred,
    inFlight,
    K,
    offBoardCeiling,
    atWatermark: headroom <= 0,
    freshUnservable,
  };
}

// runAutoPull(queueDir, journalRoot, config, deps) -- pullBoard + makeTask for the top N
// claimable candidates, N = computeAutoPullBudget's `limit` above (at most config.autoPullLimit,
// never more than would push in-flight + RUNNABLE queued past config.workers, nor every off-board
// card past OFF_BOARD_CEILING_MULTIPLE * config.workers -- cards #263/#268). Same dedup rules as
// `spo pull` (intake.makeTask skips one already in queue/ or journal/). Journals exactly one
// `auto-pull` event to journalRoot's own daemon.jsonl per call, and only when at least one
// candidate was actually written -- never for a cycle that found nothing new, and never for a
// cycle blocked by the watermark either (see this file's header for the noise-vs-signal
// reasoning: this project once buried a real 33-hour outage under 1164 near-identical
// steady-state events; "we are at the watermark" is exactly that same shape of repeating,
// no-state-change event once a maintainer deliberately runs a busy queue at a low K, so it stays
// silent here for the same reason, not journalled as a new event type). The caller gets the
// distinction for free in the return value (`atWatermark`) without a daemon.jsonl entry for it.
// Returns {ok, enqueued, issues, warnings, errors, atWatermark, freshUnservable, queued, unservable,
// deferred, inFlight}.
async function runAutoPull(queueDir, journalRoot, config, deps = {}) {
  const budget = computeAutoPullBudget(queueDir, journalRoot, config);
  const pullDeps = { productRepo: config && config.productRepo, ...deps };

  if (budget.limit <= 0) {
    // At (or already over) the watermark, or no fresh card could run (card #268's gate): skip pullBoard entirely rather than spending a
    // GraphQL read to discover candidates this cycle cannot take anyway -- see this file's
    // header's GraphQL-cost paragraph for why that read is not free to begin with.
    return {
      ok: true,
      enqueued: 0,
      issues: [],
      warnings: [],
      errors: [],
      atWatermark: budget.atWatermark,
      freshUnservable: budget.freshUnservable,
      queued: budget.queued,
      unservable: budget.unservable,
      deferred: budget.deferred,
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
    freshUnservable: false,
    queued: budget.queued,
    unservable: budget.unservable,
    deferred: budget.deferred,
    inFlight: budget.inFlight,
  };
}

module.exports = {
  shouldAutoPull,
  runAutoPull,
  computeAutoPullBudget,
  resolveNonNegativeInt,
  OFF_BOARD_CEILING_MULTIPLE,
  DEFAULT_AUTO_PULL_MS,
  DEFAULT_AUTO_PULL_LIMIT,
};
