'use strict';
// Tests for orchestrator/auto-pull.js: shouldAutoPull's pure timer decision (the "injectable
// clock or interval fn" -- no real setInterval/Date.now() call is exercised here, every (now,
// lastPullAt) pair is passed in directly), computeAutoPullBudget's watermark arithmetic (action
// 6.6), and runAutoPull's pullBoard+makeTask wiring (same deps.spawnSync injection convention as
// test/intake.test.js, which already covers pullBoard's own parsing and makeTask's own
// dedup/shape in depth -- this file only asserts the parts specific to the daemon timer: the
// top-N cut, the watermark ceiling, the "only journal when something was enqueued" rule, and the
// daemon.jsonl shape).
//
// action 6.6: every fixture below that wants "plenty of headroom" now has to say so explicitly,
// by writing a live-workers.json (via journal.writeLiveWorkerIds) and/or setting `workers` high
// enough -- a bare tmp journalRoot with no live-workers.json is deliberately read as "in-flight
// unknown, assume the worst" (see auto-pull.js's own header, "ABSENT FILE"), not as "0 workers".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const {
  shouldAutoPull,
  runAutoPull,
  computeAutoPullBudget,
  resolveNonNegativeInt,
  DEFAULT_AUTO_PULL_MS,
  DEFAULT_AUTO_PULL_LIMIT,
} = require('../orchestrator/auto-pull');
const { writeLiveWorkerIds } = require('../orchestrator/journal');
const realConfig = require('../orchestrator/config');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

// Plenty of headroom, spelled out explicitly (see file header): a fresh journalRoot with an
// EMPTY-but-present live-workers.json (0 in flight) and a generous `workers`, so a test that only
// cares about top-N/dedup/journal-shape behaviour isn't also, incidentally, exercising the
// watermark.
function noHeadroomLimit(journalRoot, workers = 50) {
  writeLiveWorkerIds(journalRoot, []);
  return workers;
}

// ---- shouldAutoPull: pure decision function ---------------------------------------------------

test('shouldAutoPull: disabled at 0, regardless of lastPullAt', () => {
  assert.equal(shouldAutoPull(null, Date.now(), 0), false);
  assert.equal(shouldAutoPull(Date.now() - 10_000_000, Date.now(), 0), false);
});

test('shouldAutoPull: a never-run timer (lastPullAt null/undefined) is due immediately', () => {
  assert.equal(shouldAutoPull(null, 1_000, 300_000), true);
  assert.equal(shouldAutoPull(undefined, 1_000, 300_000), true);
});

test('shouldAutoPull: not yet due before the interval elapses', () => {
  const last = 1_000_000;
  assert.equal(shouldAutoPull(last, last + 100_000, 300_000), false);
});

test('shouldAutoPull: due exactly at and past the interval', () => {
  const last = 1_000_000;
  assert.equal(shouldAutoPull(last, last + 300_000, 300_000), true);
  assert.equal(shouldAutoPull(last, last + 400_000, 300_000), true);
});

test('defaults: 5 minutes / one card per cycle', () => {
  assert.equal(DEFAULT_AUTO_PULL_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_AUTO_PULL_LIMIT, 1);
});

// ---- computeAutoPullBudget: the watermark, in isolation from any pullBoard/makeTask I/O --------

test('computeAutoPullBudget: at the watermark (queued+inFlight === K), limit is 0 even with autoPullLimit > 0', () => {
  const queueDir = mkTmp('spo-budget-queue-');
  const journalRoot = mkTmp('spo-budget-journal-');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0001-issue-1.json'), JSON.stringify({ id: 'issue-1', kind: 'card', issue: 1 }));
  writeLiveWorkerIds(journalRoot, ['issue-2']); // 1 in flight

  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 5 });

  assert.equal(budget.queued, 1);
  assert.equal(budget.inFlight, 1);
  assert.equal(budget.K, 2);
  assert.equal(budget.limit, 0);
  assert.equal(budget.atWatermark, true);
});

test('computeAutoPullBudget: below the watermark, limit is exactly the difference -- not autoPullLimit, not unbounded', () => {
  const queueDir = mkTmp('spo-budget-queue2-');
  const journalRoot = mkTmp('spo-budget-journal2-');
  writeLiveWorkerIds(journalRoot, ['issue-1']); // 1 in flight, 0 queued

  // K=5, inFlight=1, queued=0 -> headroom=4, but autoPullLimit=2 caps the per-cycle pull.
  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 5, autoPullLimit: 2 });
  assert.equal(budget.limit, 2);
  assert.equal(budget.atWatermark, false);

  // K=5, inFlight=1, queued=0 -> headroom=4, autoPullLimit=10 -- limit is the headroom (4), never
  // the full autoPullLimit and never "all candidates" (runAutoPull-level test covers the latter).
  const budget2 = computeAutoPullBudget(queueDir, journalRoot, { workers: 5, autoPullLimit: 10 });
  assert.equal(budget2.limit, 4);
});

test('computeAutoPullBudget: in-flight workers (live-workers.json) count toward the ceiling, not just queued files', () => {
  const queueDir = mkTmp('spo-budget-queue3-'); // empty -- 0 queued
  const journalRoot = mkTmp('spo-budget-journal3-');
  writeLiveWorkerIds(journalRoot, ['issue-1', 'issue-2', 'issue-3']); // 3 in flight, 0 queued files

  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 3, autoPullLimit: 5 });
  assert.equal(budget.queued, 0);
  assert.equal(budget.inFlight, 3);
  assert.equal(budget.limit, 0); // 3 in-flight alone already exhausts K=3
  assert.equal(budget.atWatermark, true);
});

test('computeAutoPullBudget: a MISSING live-workers.json is not read as 0 in flight', () => {
  const queueDir = mkTmp('spo-budget-queue4-'); // empty
  const journalRoot = mkTmp('spo-budget-journal4-'); // never had writeLiveWorkerIds called
  assert.equal(fs.existsSync(path.join(journalRoot, 'live-workers.json')), false);

  // K=3, 0 queued -- if the missing file were read as inFlight=0, headroom would be 3 and this
  // would pull. It must not: the absent file means "unknown", assumed to be the worst case (K).
  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 3, autoPullLimit: 5 });
  assert.equal(budget.inFlight, 3); // treated as K, not 0
  assert.equal(budget.limit, 0);
  assert.equal(budget.atWatermark, true);
});

test('computeAutoPullBudget: a STALE (over-reporting) live-workers.json fails toward under-pulling', () => {
  const queueDir = mkTmp('spo-budget-queue5-');
  const journalRoot = mkTmp('spo-budget-journal5-');
  // Simulates dispatcher.js's own documented staleness direction: a worker exited a while ago,
  // but the file still lists it (handleExit only publishes AFTER any repark it warrants has
  // landed -- see dispatcher.js's own header). The scanner has no way to know the id is gone.
  writeLiveWorkerIds(journalRoot, ['issue-stale-1', 'issue-stale-2']);

  // Truth: only 0 workers are really alive, K=4 -- a perfectly fresh read would allow limit=4
  // (capped by autoPullLimit). The stale file makes this cycle see inFlight=2 instead, so it
  // under-pulls (limit=2) rather than over-pulling past the true, unknown-to-this-process state.
  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 4, autoPullLimit: 10 });
  assert.equal(budget.inFlight, 2);
  assert.equal(budget.limit, 2); // capped by the (stale) reported in-flight count, not by truth
});

test('computeAutoPullBudget: repeated cycles at the watermark do not accumulate -- N cycles, still zero', () => {
  const queueDir = mkTmp('spo-budget-queue6-');
  const journalRoot = mkTmp('spo-budget-journal6-');
  fs.mkdirSync(queueDir, { recursive: true });
  // Exactly at K=2: 1 queued file + 1 in-flight worker.
  fs.writeFileSync(path.join(queueDir, '0001-issue-1.json'), JSON.stringify({ id: 'issue-1', kind: 'card', issue: 1 }));
  writeLiveWorkerIds(journalRoot, ['issue-2']);

  // This is the actual regression action 6.6 closes: pre-6.6, `runAutoPull` had no memory of
  // "already pulled" between cycles and no ceiling either, so N cycles of the OLD code would
  // enqueue up to N * autoPullLimit more cards regardless of how many sat unclaimed already.
  for (let i = 0; i < 10; i++) {
    const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 1 });
    assert.equal(budget.limit, 0, `cycle ${i}: still at the watermark, must still pull 0`);
  }
});

test('computeAutoPullBudget: the shipped config.js values (workers=1, autoPullLimit=1) produce a ceiling of 1', () => {
  // action 6.5's own mistake, named explicitly in this action's spec: every prior test baked its
  // own value into a testConfig() and none ever read the real shipped config, so a wrong shipped
  // default passed green. Guard against repeating that here by driving this one test off
  // orchestrator/config.js's own real, un-overridden values.
  assert.equal(realConfig.workers, 1);
  assert.equal(realConfig.autoPullLimit, 1);

  const queueDir = mkTmp('spo-budget-queue7-');
  const journalRoot = mkTmp('spo-budget-journal7-'); // no live-workers.json -> inFlight treated as K
  const empty = computeAutoPullBudget(queueDir, journalRoot, realConfig);
  // Missing file -> inFlight assumed = K = 1 -> already at the (shipped) ceiling.
  assert.equal(empty.limit, 0);
  assert.equal(empty.atWatermark, true);

  // Once the scanner has SOME view of in-flight (0 workers, freshly published), the shipped
  // ceiling allows exactly 1 -- matching the maintainer's 2026-08-29 "one card at a time" intent,
  // now also bounded so it can never exceed K.
  writeLiveWorkerIds(journalRoot, []);
  const fresh = computeAutoPullBudget(queueDir, journalRoot, realConfig);
  assert.equal(fresh.limit, 1);

  // And with that one worker slot occupied, the shipped ceiling correctly refuses a second pull.
  writeLiveWorkerIds(journalRoot, ['issue-1']);
  const busy = computeAutoPullBudget(queueDir, journalRoot, realConfig);
  assert.equal(busy.limit, 0);
  assert.equal(busy.atWatermark, true);
});

test('computeAutoPullBudget: OVER the watermark (queued+inFlight > K) clamps to 0, never a negative limit', () => {
  // The Math.max(0, ...) clamp had no test: every prior case landed on headroom EXACTLY 0, so
  // dropping the clamp passed the whole suite (measured: mutation M9, 1324/1324 green). Reachable
  // in production without anything going wrong -- a queue that still holds a backlog from a
  // higher K, then a restart at a lower one.
  const queueDir = mkTmp('spo-budget-over-queue-');
  const journalRoot = mkTmp('spo-budget-over-journal-');
  fs.mkdirSync(queueDir, { recursive: true });
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(queueDir, `000${n}-issue-${n}.json`), JSON.stringify({ id: `issue-${n}`, issue: n }));
  }
  writeLiveWorkerIds(journalRoot, ['issue-9']); // 3 queued + 1 in flight, against K=1

  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 1, autoPullLimit: 5 });
  assert.equal(budget.queued, 3);
  assert.equal(budget.inFlight, 1);
  assert.equal(budget.limit, 0, 'a limit of -3 is not a limit');
  assert.equal(budget.atWatermark, true);
});

test('computeAutoPullBudget: reads the QUEUE before live-workers.json -- the order the staleness argument depends on', () => {
  // auto-pull.js's header argues at length that reading `queued` first is "not cosmetic": it
  // makes the unsafe double-miss require BOTH reads to land inside dispatcher.js's own
  // rename -> publish window, where the reverse order makes any overlap with that window
  // undercount. That argument was load-bearing and pinned by nothing -- swapping the two reads
  // passed the entire suite (measured: mutation M8, 1324/1324 green). This asserts the order
  // itself, by recording which file each read touches first.
  const queueDir = mkTmp('spo-order-queue-');
  const journalRoot = mkTmp('spo-order-journal-');
  writeLiveWorkerIds(journalRoot, ['issue-1']);
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0001-issue-2.json'), JSON.stringify({ id: 'issue-2', issue: 2 }));

  const touched = [];
  const record = (name, target) => {
    if (String(target).startsWith(queueDir)) touched.push(`queue:${name}`);
    else if (String(target).includes('live-workers.json')) touched.push(`live:${name}`);
  };
  // orphan-scan.js, journal.js and auto-pull.js all hold the SAME `require('fs')` module object,
  // so patching these three observes every read computeAutoPullBudget makes, in either module.
  const real = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, existsSync: fs.existsSync };
  fs.readdirSync = (t, ...rest) => (record('readdir', t), real.readdirSync(t, ...rest));
  fs.readFileSync = (t, ...rest) => (record('read', t), real.readFileSync(t, ...rest));
  fs.existsSync = (t, ...rest) => (record('exists', t), real.existsSync(t, ...rest));
  try {
    computeAutoPullBudget(queueDir, journalRoot, { workers: 5, autoPullLimit: 1 });
  } finally {
    Object.assign(fs, real);
  }

  const firstQueue = touched.findIndex((t) => t.startsWith('queue:'));
  const firstLive = touched.findIndex((t) => t.startsWith('live:'));
  assert.ok(firstQueue >= 0, `no queue read observed: ${touched.join(', ')}`);
  assert.ok(firstLive >= 0, `no live-workers.json read observed: ${touched.join(', ')}`);
  assert.ok(
    firstQueue < firstLive,
    `queue/ must be read BEFORE live-workers.json (see auto-pull.js's staleness derivation), got: ${touched.join(', ')}`
  );
});

test('computeAutoPullBudget: a card that is BOTH in live-workers.json and still queued is DOUBLE-counted, never missed', () => {
  // Reachable without anything going wrong: finalizePark's auto-retry path re-enqueues a task
  // into queue/ from inside the worker, which is still live and still listed, so for that window
  // the same id legitimately sits in both places. Double-counting under-states headroom by one
  // (the daemon pulls one card less than it strictly could, for one cycle); MISSING it -- e.g. by
  // unioning the two id sets instead of summing their sizes -- would over-state headroom, which
  // is the direction that breaks the invariant this action exists to hold.
  const queueDir = mkTmp('spo-dup-queue-');
  const journalRoot = mkTmp('spo-dup-journal-');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0001-issue-7.json'), JSON.stringify({ id: 'issue-7', issue: 7 }));
  writeLiveWorkerIds(journalRoot, ['issue-7']); // the SAME id, in flight and queued at once

  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 5 });
  assert.equal(budget.queued, 1);
  assert.equal(budget.inFlight, 1);
  assert.equal(budget.limit, 0, 'K=2 minus one id counted twice leaves no headroom -- the safe answer');
  assert.equal(budget.atWatermark, true);
});

// ---- the per-cycle cap's own resolution: 0 means zero -----------------------------------------

test('computeAutoPullBudget: an EXPLICIT autoPullLimit of 0 pulls nothing -- it is not "unset"', () => {
  // `(config && config.autoPullLimit) || DEFAULT_AUTO_PULL_LIMIT` made the one input an operator
  // would reach for to switch auto-pull off resolve to the module default instead: 0 is falsy.
  // The trap is baited by config.js's neighbouring autoPullMs, documented as "0 disables the
  // timer entirely".
  const queueDir = mkTmp('spo-zero-queue-');
  const journalRoot = mkTmp('spo-zero-journal-');
  writeLiveWorkerIds(journalRoot, []); // 0 in flight, 0 queued: all the headroom K allows

  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 8, autoPullLimit: 0 });
  assert.equal(budget.limit, 0, 'autoPullLimit=0 must mean zero, never the fallback');
  assert.equal(budget.atWatermark, false, 'zero-by-configuration is NOT "at the watermark"');
});

test('computeAutoPullBudget: an ABSENT autoPullLimit still falls back to the default', () => {
  const queueDir = mkTmp('spo-absent-queue-');
  const journalRoot = mkTmp('spo-absent-journal-');
  writeLiveWorkerIds(journalRoot, []);
  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 8 });
  assert.equal(budget.limit, DEFAULT_AUTO_PULL_LIMIT, 'omitting the field is not the same as setting it to 0');
});

test('resolveNonNegativeInt: 0 is honoured, absent falls back, malformed pulls nothing', () => {
  assert.equal(resolveNonNegativeInt(0, 7), 0);
  assert.equal(resolveNonNegativeInt(5, 7), 5);
  assert.equal(resolveNonNegativeInt(undefined, 7), 7);
  assert.equal(resolveNonNegativeInt(null, 7), 7);
  // Malformed values resolve to 0, not to the fallback: config.js already turns an operator's
  // typo into the documented default, so anything still malformed here is a programmatic caller,
  // and the safe direction for a rate cap is to pull nothing rather than invent a number.
  assert.equal(resolveNonNegativeInt(NaN, 7), 0);
  assert.equal(resolveNonNegativeInt(-1, 7), 0);
  assert.equal(resolveNonNegativeInt(1.5, 7), 0);
  assert.equal(resolveNonNegativeInt('3', 7), 0);
});

test('DEFAULT_AUTO_PULL_LIMIT tracks config.js\'s own shipped autoPullLimit -- the two cannot drift', () => {
  // They were 3 and 1 for the whole life of this module. The mismatch was noticed once and
  // dismissed as unreachable ("only a caller that omits the field"); it was reachable, via the
  // falsy-0 fallback above, and every test that omitted the field was silently running at 3x the
  // shipped rate. Pinned rather than re-argued.
  assert.equal(DEFAULT_AUTO_PULL_LIMIT, realConfig.autoPullLimit);
});

// ---- runAutoPull: pullBoard + makeTask, top N, journal-only-when-enqueued ----------------------

function boardClaimStdout(candidates) {
  const lines = ['rateLimit cost=2 remaining=4998 resetAt=2026-08-29T12:00:00Z', `candidates: ${candidates.length}`];
  for (const c of candidates) lines.push(`  ${c.rank} #${c.issue} area=${c.area} ${c.title}`);
  return lines.join('\n');
}

function makeDeps({ candidates, issueBodies = {} }) {
  return {
    spawnSync: (command, args, opts) => {
      if (command === 'npm' && args.join(' ') === 'run board:claim') {
        return ok(boardClaimStdout(candidates));
      }
      if (command === 'gh' && args[0] === 'api') {
        const m = args[1].match(/issues\/(\d+)$/);
        const issue = Number(m[1]);
        const body = issueBodies[issue] || { title: `issue ${issue}`, body: 'no special markers', labels: [] };
        return ok(JSON.stringify(body));
      }
      return ok('');
    },
  };
}

test('runAutoPull: below the watermark, only the top N of 5 candidates are turned into queue files (N = headroom, capped by autoPullLimit)', async () => {
  const queueDir = mkTmp('spo-autopull-queue-');
  const journalRoot = mkTmp('spo-autopull-journal-');
  const workers = noHeadroomLimit(journalRoot, 50); // plenty of headroom -- this test is about the top-N cut, not the ceiling
  const candidates = [1, 2, 3, 4, 5].map((n) => ({ rank: n, issue: 500 + n, area: 'client', title: `card ${n}` }));
  const deps = makeDeps({ candidates });

  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', workers, autoPullLimit: 3 }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.enqueued, 3);
  assert.deepEqual(result.issues, [501, 502, 503]);
  const written = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  assert.equal(written.length, 3);
});

test('runAutoPull: AT the watermark, pulls zero even with claimable candidates on the board, and never calls pullBoard', async () => {
  const queueDir = mkTmp('spo-autopull-watermark-queue-');
  const journalRoot = mkTmp('spo-autopull-watermark-journal-');
  writeLiveWorkerIds(journalRoot, ['issue-1', 'issue-2']); // 2 in flight, K=2 -> already at watermark

  let pullBoardCalled = false;
  const candidates = [{ rank: 1, issue: 901, area: 'client', title: 'should not be pulled' }];
  const deps = makeDeps({ candidates });
  deps.spawnSync = new Proxy(deps.spawnSync, {
    apply(target, thisArg, args) {
      if (args[0] === 'npm' && args[1].join(' ') === 'run board:claim') pullBoardCalled = true;
      return Reflect.apply(target, thisArg, args);
    },
  });

  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', workers: 2, autoPullLimit: 5 }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.enqueued, 0);
  assert.deepEqual(result.issues, []);
  assert.equal(result.atWatermark, true);
  assert.equal(pullBoardCalled, false, 'a cycle blocked by the watermark must not spend a board:claim read');
  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 0);
  // Silent in daemon.jsonl, same as "nothing claimable" -- see auto-pull.js's own header.
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
});

test('runAutoPull: repeated cycles at the watermark do not accumulate -- 10 cycles, still zero enqueued total', async () => {
  const queueDir = mkTmp('spo-autopull-repeat-queue-');
  const journalRoot = mkTmp('spo-autopull-repeat-journal-');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0001-issue-1.json'), JSON.stringify({ id: 'issue-1', kind: 'card', issue: 1 }));
  writeLiveWorkerIds(journalRoot, []); // 0 in flight, 1 queued, K=1 -> exactly at watermark

  const candidates = [1, 2, 3].map((n) => ({ rank: n, issue: 900 + n, area: 'client', title: `card ${n}` }));
  const deps = makeDeps({ candidates });

  let totalEnqueued = 0;
  for (let i = 0; i < 10; i++) {
    const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', workers: 1, autoPullLimit: 1 }, deps);
    totalEnqueued += result.enqueued;
  }

  assert.equal(totalEnqueued, 0);
  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 1); // still just the original
});

test('runAutoPull: journals exactly one auto-pull event to <journalRoot>/daemon.jsonl when something was enqueued', async () => {
  const queueDir = mkTmp('spo-autopull-queue2-');
  const journalRoot = mkTmp('spo-autopull-journal2-');
  const workers = noHeadroomLimit(journalRoot);
  const candidates = [{ rank: 1, issue: 601, area: 'client', title: 'a' }];
  const deps = makeDeps({ candidates });

  await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', workers }, deps);

  const daemonLog = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(daemonLog.length, 1);
  assert.equal(daemonLog[0].event, 'auto-pull');
  assert.equal(daemonLog[0].enqueued, 1);
  assert.deepEqual(daemonLog[0].issues, [601]);
});

test('runAutoPull: nothing claimable -- no queue file, no daemon.jsonl event at all', async () => {
  const queueDir = mkTmp('spo-autopull-queue3-');
  const journalRoot = mkTmp('spo-autopull-journal3-');
  const workers = noHeadroomLimit(journalRoot);
  const deps = makeDeps({ candidates: [] });

  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', workers }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.enqueued, 0);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
});

test('runAutoPull: every candidate already queued (dedup) -- makeTask skips all, no daemon.jsonl event', async () => {
  const queueDir = mkTmp('spo-autopull-queue4-');
  const journalRoot = mkTmp('spo-autopull-journal4-');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0001-issue-701.json'), JSON.stringify({ id: 'issue-701', kind: 'card', issue: 701 }));
  // 1 already queued -- give plenty of headroom above that so this test is only about dedup, not
  // the ceiling.
  const workers = noHeadroomLimit(journalRoot);

  const candidates = [{ rank: 1, issue: 701, area: 'client', title: 'a' }];
  const deps = makeDeps({ candidates });

  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', workers }, deps);

  assert.equal(result.enqueued, 0);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
  // still exactly the one pre-existing queue file -- nothing new written
  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 1);
});

test('runAutoPull: a failing board:claim is reported, never throws, never journals', async () => {
  const queueDir = mkTmp('spo-autopull-queue5-');
  const journalRoot = mkTmp('spo-autopull-journal5-');
  const workers = noHeadroomLimit(journalRoot);
  const deps = { spawnSync: () => ({ status: 3, stdout: '', stderr: 'boom', signal: null }) };

  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', workers }, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /exited 3/);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
});
