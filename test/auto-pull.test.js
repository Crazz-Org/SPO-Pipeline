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
const path = require('path');
const { execFileSync } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const {
  shouldAutoPull,
  runAutoPull,
  computeAutoPullBudget,
  resolveNonNegativeInt,
  OFF_BOARD_CEILING_MULTIPLE,
  DEFAULT_AUTO_PULL_MS,
  DEFAULT_AUTO_PULL_LIMIT,
} = require('../orchestrator/auto-pull');
const { writeLiveWorkerIds, appendEvent } = require('../orchestrator/journal');
const { reEnqueueTask } = require('../orchestrator/park-loop');
const { takeNextTask } = require('../orchestrator/state-machine');
const realConfig = require('../orchestrator/config');
const accounts = require('../orchestrator/accounts');
const { nextLlmCallForTask, servableFor } = require('../orchestrator/dispatcher');
const { OPUS_5_5 } = require('../orchestrator/step-contracts');
const { mkTmp, isolatedEnv, writePoolDir } = require('./helpers');

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
  // but the file still lists it because this scanner's own read simply landed before the next
  // publishLiveWorkerIds() write reached disk. CARD #78 CORRECTION: this comment used to explain
  // the staleness as "handleExit only publishes AFTER any repark it warrants has landed" -- true
  // only while a crash repark ran synchronously, in-process. It no longer does (see dispatcher.js's
  // own header): handleExit drops the id and publishes the instant it has SPAWNED the repark
  // child, not after that child's own park lands. The scenario this test exercises (a stale,
  // over-reporting file) is still real and handled the same way; it just is not caused by a
  // repark still landing. The scanner has no way to know the id is gone.
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

  // Card #268: the budget now reads config.claudeAccountsDir, which the shipped config resolves to
  // SPO_ACCOUNTS_DIR or ~/.claude-accounts -- the machine's REAL pool. That made this test pass on
  // a box with a healthy pool and fail on a CI runner with none (PR #273). The shipped
  // workers/autoPullLimit are kept, and the pool is pinned, once per pool shape the shipped config
  // can meet: a pool directory that is missing, one that exists with no account registered, and a
  // healthy one.
  const pools = [
    ['missing pool dir', path.join(mkTmp('spo-budget-pool7-'), 'absent')],
    ['empty pool dir', mkTmp('spo-budget-pool7-empty-')],
    ['healthy pool', writePoolDir(mkTmp('spo-budget-pool7-healthy-'), [{ name: 'acct0' }])],
  ];
  for (const [label, claudeAccountsDir] of pools) {
    const shipped = { ...realConfig, claudeAccountsDir };
    const queueDir = mkTmp('spo-budget-queue7-');
    const journalRoot = mkTmp('spo-budget-journal7-'); // no live-workers.json -> inFlight treated as K
    const empty = computeAutoPullBudget(queueDir, journalRoot, shipped);
    // Missing file -> inFlight assumed = K = 1 -> already at the (shipped) ceiling.
    assert.equal(empty.limit, 0, label);
    assert.equal(empty.atWatermark, true, label);

    // Once the scanner has SOME view of in-flight (0 workers, freshly published), the shipped
    // ceiling allows exactly 1 -- matching the maintainer's 2026-08-29 "one card at a time" intent,
    // now also bounded so it can never exceed K.
    writeLiveWorkerIds(journalRoot, []);
    const fresh = computeAutoPullBudget(queueDir, journalRoot, shipped);
    assert.equal(fresh.limit, 1, label);
    assert.equal(fresh.freshUnservable, false, label);

    // And with that one worker slot occupied, the shipped ceiling correctly refuses a second pull.
    writeLiveWorkerIds(journalRoot, ['issue-1']);
    const busy = computeAutoPullBudget(queueDir, journalRoot, shipped);
    assert.equal(busy.limit, 0, label);
    assert.equal(busy.atWatermark, true, label);
  }
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

// ---- card #263: a DEFERRED queue entry (notBefore in the future) is not runnable work ----------
//
// Every pool-waiting fixture below is written through park-loop.js's REAL reEnqueueTask, with the
// `extra` shape finalizePark's pool-wait branch passes it (poolWaitMs, poolWaitAttempts,
// notBefore), so the filename (`0000-retry-t-...`) and the body are the ones production writes,
// not a hand-typed guess. The clock is injected (computeAutoPullBudget's 4th argument), so
// "future" and "just passed" are exact, never a wall-clock margin.

const NOW_263 = Date.parse('2026-09-25T12:00:00.000Z');

function poolWaitEntry(queueDir, journalRoot, n, notBeforeMs) {
  const id = `issue-${n}`;
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, kind: 'card', issue: n }));
  return reEnqueueTask(
    queueDir,
    taskDir,
    id,
    { poolWaitMs: 3 * 60 * 60 * 1000, poolWaitAttempts: 1, notBefore: new Date(notBeforeMs).toISOString() },
    1,
    't'
  );
}

function runnableEntry(queueDir, n) {
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, `0001-issue-${n}.json`), JSON.stringify({ id: `issue-${n}`, kind: 'card', issue: n }));
}

test('card #263 (a): K pool-waiting entries and a free slot -> auto-pull pulls; they do not hold the watermark shut', () => {
  const queueDir = mkTmp('spo-263a-queue-');
  const journalRoot = mkTmp('spo-263a-journal-');
  writeLiveWorkerIds(journalRoot, []); // a dispatcher owns the root, 0 in flight
  const future = NOW_263 + 3 * 60 * 60 * 1000; // a 3h Fable cooldown
  poolWaitEntry(queueDir, journalRoot, 901, future);
  poolWaitEntry(queueDir, journalRoot, 902, future);

  // Production shape: SPO_WORKERS=2, autoPullLimit 1.
  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 1 }, NOW_263);
  assert.equal(budget.queued, 0, 'a pool-waiting entry is not RUNNABLE queued work');
  assert.equal(budget.deferred, 2);
  assert.equal(budget.inFlight, 0);
  assert.equal(budget.limit, 1, 'K=2 pool-waits must not hold the watermark shut');
  assert.equal(budget.atWatermark, false);

  // With the per-cycle cap out of the way, K itself is the limit: both slots are free.
  const wide = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 5 }, NOW_263);
  assert.equal(wide.limit, 2);
});

test('card #263 (a): three pool-waits at K=2 -- still pulls one card, and the off-board ceiling is what caps it', () => {
  const queueDir = mkTmp('spo-263a2-queue-');
  const journalRoot = mkTmp('spo-263a2-journal-');
  writeLiveWorkerIds(journalRoot, []);
  const future = NOW_263 + 3 * 60 * 60 * 1000;
  for (const n of [901, 902, 903]) poolWaitEntry(queueDir, journalRoot, n, future);

  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 5 }, NOW_263);
  assert.equal(budget.deferred, 3);
  assert.equal(budget.offBoardCeiling, 4);
  // K alone would allow 2; the off-board ceiling (2K = 4) leaves room for exactly 1.
  assert.equal(budget.limit, 1);
  assert.equal(budget.atWatermark, false);
});

test('card #263 (b): K RUNNABLE entries still hold the watermark -- no over-pull when the waiting cards can run', () => {
  const queueDir = mkTmp('spo-263b-queue-');
  const journalRoot = mkTmp('spo-263b-journal-');
  writeLiveWorkerIds(journalRoot, []);
  runnableEntry(queueDir, 901);
  runnableEntry(queueDir, 902);

  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 5 }, NOW_263);
  assert.equal(budget.queued, 2);
  assert.equal(budget.deferred, 0);
  assert.equal(budget.limit, 0);
  assert.equal(budget.atWatermark, true);

  // A pool-wait whose cooldown has ENDED is runnable again and counts exactly the same.
  const q2 = mkTmp('spo-263b2-queue-');
  const j2 = mkTmp('spo-263b2-journal-');
  writeLiveWorkerIds(j2, []);
  poolWaitEntry(q2, j2, 911, NOW_263 - 60 * 1000);
  poolWaitEntry(q2, j2, 912, NOW_263 - 60 * 1000);
  const elapsed = computeAutoPullBudget(q2, j2, { workers: 2, autoPullLimit: 5 }, NOW_263);
  assert.equal(elapsed.queued, 2);
  assert.equal(elapsed.deferred, 0);
  assert.equal(elapsed.limit, 0);
  assert.equal(elapsed.atWatermark, true);
});

test('card #263 (c): mixed -- runnable and in-flight count against K, deferred only against the off-board ceiling', () => {
  const queueDir = mkTmp('spo-263c-queue-');
  const journalRoot = mkTmp('spo-263c-journal-');
  writeLiveWorkerIds(journalRoot, ['issue-950']); // 1 in flight
  runnableEntry(queueDir, 901); // 1 runnable
  const future = NOW_263 + 60 * 60 * 1000;
  poolWaitEntry(queueDir, journalRoot, 902, future);
  poolWaitEntry(queueDir, journalRoot, 903, future); // 2 deferred

  // K=3: watermark headroom 3-1-1 = 1; off-board headroom 6-1-2-1 = 2 -> 1.
  const k3 = computeAutoPullBudget(queueDir, journalRoot, { workers: 3, autoPullLimit: 5 }, NOW_263);
  assert.deepEqual(
    { queued: k3.queued, deferred: k3.deferred, inFlight: k3.inFlight, limit: k3.limit, atWatermark: k3.atWatermark },
    { queued: 1, deferred: 2, inFlight: 1, limit: 1, atWatermark: false }
  );

  // K=2: runnable + in flight already fill K -- the deferred entries do not change that answer.
  const k2 = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 5 }, NOW_263);
  assert.equal(k2.limit, 0);
  assert.equal(k2.atWatermark, true);

  // K=4 with two more deferred: watermark headroom 4-1-1 = 2, off-board 8-1-4-1 = 2 -> 2. One
  // more deferred and the off-board ceiling binds first: 8-1-5-1 = 1.
  poolWaitEntry(queueDir, journalRoot, 904, future);
  poolWaitEntry(queueDir, journalRoot, 905, future);
  assert.equal(computeAutoPullBudget(queueDir, journalRoot, { workers: 4, autoPullLimit: 5 }, NOW_263).limit, 2);
  poolWaitEntry(queueDir, journalRoot, 906, future);
  assert.equal(computeAutoPullBudget(queueDir, journalRoot, { workers: 4, autoPullLimit: 5 }, NOW_263).limit, 1);
});

test('card #263 (d): an entry whose notBefore has just passed counts; one a millisecond ahead does not', () => {
  const journalRoot = mkTmp('spo-263d-journal-');
  writeLiveWorkerIds(journalRoot, []);
  const cases = [
    { notBeforeMs: NOW_263 - 1, runnable: true, label: '1 ms ago' },
    { notBeforeMs: NOW_263, runnable: true, label: 'exactly now (takeNextTask takes it: `!(notBefore > now)`)' },
    { notBeforeMs: NOW_263 + 1, runnable: false, label: '1 ms ahead' },
  ];
  for (const c of cases) {
    const queueDir = mkTmp('spo-263d-queue-');
    poolWaitEntry(queueDir, journalRoot, 901, c.notBeforeMs);
    const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 1, autoPullLimit: 5 }, NOW_263);
    assert.equal(budget.queued, c.runnable ? 1 : 0, `${c.label}: queued`);
    assert.equal(budget.deferred, c.runnable ? 0 : 1, `${c.label}: deferred`);
    assert.equal(budget.limit, c.runnable ? 0 : 1, `${c.label}: limit at K=1`);
  }

  // The SAME entry judged at two instants: the budget follows the clock it is given.
  const queueDir = mkTmp('spo-263d2-queue-');
  poolWaitEntry(queueDir, journalRoot, 902, NOW_263 + 5 * 60 * 1000);
  assert.equal(computeAutoPullBudget(queueDir, journalRoot, { workers: 1, autoPullLimit: 5 }, NOW_263).limit, 1);
  assert.equal(computeAutoPullBudget(queueDir, journalRoot, { workers: 1, autoPullLimit: 5 }, NOW_263 + 5 * 60 * 1000).limit, 0);
});

test('card #263: "runnable" is takeNextTask\'s own eligibility -- no, unparsable and garbage notBefore all count', () => {
  const queueDir = mkTmp('spo-263e-queue-');
  const journalRoot = mkTmp('spo-263e-journal-');
  writeLiveWorkerIds(journalRoot, []);
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0001-issue-1.json'), JSON.stringify({ id: 'issue-1', issue: 1 }));
  fs.writeFileSync(path.join(queueDir, '0001-issue-2.json'), JSON.stringify({ id: 'issue-2', issue: 2, notBefore: 'not a date' }));
  fs.writeFileSync(path.join(queueDir, '0001-issue-3.json'), '{ this is not json');

  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 3, autoPullLimit: 5 }, NOW_263);
  assert.equal(budget.queued, 3, 'all three are entries takeNextTask would take now');
  assert.equal(budget.deferred, 0);
  assert.equal(budget.limit, 0);
});

test('card #263: an id queued twice is runnable if ANY of its entries is -- and is still one id, as queuedIds counted it', () => {
  const queueDir = mkTmp('spo-263f-queue-');
  const journalRoot = mkTmp('spo-263f-journal-');
  writeLiveWorkerIds(journalRoot, []);
  poolWaitEntry(queueDir, journalRoot, 901, NOW_263 + 60 * 60 * 1000); // a deferred entry for issue-901...
  runnableEntry(queueDir, 901); // ...and a runnable duplicate of the same id (sorts AFTER it)

  const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 5 }, NOW_263);
  assert.equal(budget.queued, 1);
  assert.equal(budget.deferred, 0);
  assert.equal(budget.limit, 1);

  // The reverse listing order: the runnable entry sorts FIRST, the deferred one after it. Either
  // order must give the same answer -- neither "first entry wins" nor "last entry wins" is the rule.
  const q2 = mkTmp('spo-263f2-queue-');
  runnableEntry(q2, 902); // 0001-issue-902.json
  fs.writeFileSync(
    path.join(q2, '0002-issue-902.json'),
    JSON.stringify({ id: 'issue-902', kind: 'card', issue: 902, notBefore: new Date(NOW_263 + 60 * 60 * 1000).toISOString() })
  );
  assert.deepEqual(fs.readdirSync(q2).sort(), ['0001-issue-902.json', '0002-issue-902.json'], 'runnable sorts first');
  const reversed = computeAutoPullBudget(q2, journalRoot, { workers: 2, autoPullLimit: 5 }, NOW_263);
  assert.equal(reversed.queued, 1);
  assert.equal(reversed.deferred, 0);
  assert.equal(reversed.limit, 1);
});

test('card #263: the 2026-09-16/17 shape -- 2 pool-waits at K=2, 0 in flight -- pulls one card per cycle, twice, then stops at 2 deferred + 2 in flight', () => {
  // Re-measured from the journal's `pool-wait` events: issue-887 and issue-888 were both deferred,
  // with nothing in flight, for 11.7h. Each card this budget lets through is spawned by the
  // dispatcher (moves from queue/ to live-workers.json) before the next cycle.
  const queueDir = mkTmp('spo-263real-queue-');
  const journalRoot = mkTmp('spo-263real-journal-');
  const future = NOW_263 + 5 * 60 * 60 * 1000;
  poolWaitEntry(queueDir, journalRoot, 887, future);
  poolWaitEntry(queueDir, journalRoot, 888, future);
  const live = [];
  writeLiveWorkerIds(journalRoot, live);

  const limits = [];
  for (let cycle = 0; cycle < 4; cycle += 1) {
    const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 1 }, NOW_263);
    limits.push(budget.limit);
    if (budget.limit === 0) {
      assert.deepEqual(
        { queued: budget.queued, deferred: budget.deferred, inFlight: budget.inFlight, atWatermark: budget.atWatermark },
        { queued: 0, deferred: 2, inFlight: 2, atWatermark: true }
      );
      continue;
    }
    live.push(`issue-${1000 + cycle}`); // pulled, then taken and spawned by the dispatcher
    writeLiveWorkerIds(journalRoot, live);
  }
  assert.deepEqual(limits, [1, 1, 0, 0]);
});

test('card #263: the at-watermark early return of runAutoPull reports `deferred` too', async () => {
  const queueDir = mkTmp('spo-263wm-queue-');
  const journalRoot = mkTmp('spo-263wm-journal-');
  writeLiveWorkerIds(journalRoot, []);
  runnableEntry(queueDir, 901); // fills K=1
  poolWaitEntry(queueDir, journalRoot, 902, Date.now() + 3 * 60 * 60 * 1000);

  const deps = makeDeps({ candidates: [{ rank: 1, issue: 777, area: 'client', title: 'not pulled' }] });
  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', workers: 1, autoPullLimit: 1 }, deps);
  assert.equal(result.enqueued, 0);
  assert.equal(result.atWatermark, true);
  assert.equal(result.queued, 1);
  assert.equal(result.deferred, 1);
});

test('card #263: auto-pull.js keeps its state-machine.js require LAZY -- the daemon loads state-machine.js first', () => {
  // daemon.js requires state-machine.js, which requires auto-pull.js at load. A TOP-LEVEL require
  // of state-machine.js inside auto-pull.js would receive state-machine.js's still-empty exports
  // there, so computeAutoPullBudget would throw `isQueueEntryEligibleNow is not a function` on
  // every scan cycle. This file requires auto-pull.js first, the order in which that hoist works,
  // so only a fresh process loading in the daemon's own order can catch it.
  const queueDir = mkTmp('spo-263lazy-queue-');
  const journalRoot = mkTmp('spo-263lazy-journal-');
  writeLiveWorkerIds(journalRoot, []);
  runnableEntry(queueDir, 901);
  poolWaitEntry(queueDir, journalRoot, 902, NOW_263 + 60 * 60 * 1000);

  const orch = path.join(__dirname, '..', 'orchestrator');
  const script = [
    `require(${JSON.stringify(path.join(orch, 'state-machine'))});`,
    `const { computeAutoPullBudget } = require(${JSON.stringify(path.join(orch, 'auto-pull'))});`,
    `const b = computeAutoPullBudget(${JSON.stringify(queueDir)}, ${JSON.stringify(journalRoot)}, { workers: 3, autoPullLimit: 5 }, ${NOW_263});`,
    'process.stdout.write(JSON.stringify(b));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { env: isolatedEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const budget = JSON.parse(out);
  assert.equal(budget.queued, 1);
  assert.equal(budget.deferred, 1);
  assert.equal(budget.limit, 2);
});

test('card #263: THE BOUND -- a long exhaustion in which every pulled card pool-waits never takes more than 2K cards off the board', () => {
  // Cycle after cycle of the worst case the exclusion opens: every card this budget lets through
  // is pulled, runs, pool-waits (deferred 12h), and so leaves the K count. Without the off-board
  // ceiling this pulls one card per cycle for as long as the exhaustion lasts; with it, it stops
  // at 2K and stays there.
  assert.equal(OFF_BOARD_CEILING_MULTIPLE, 2, 'auto-pull.js\'s header and orchestrator/README.md both state 2K');
  for (const K of [1, 2, 3]) {
    const queueDir = mkTmp('spo-263g-queue-');
    const journalRoot = mkTmp('spo-263g-journal-');
    writeLiveWorkerIds(journalRoot, []);
    const future = NOW_263 + 12 * 60 * 60 * 1000;
    let n = 1000;
    let stopped = false;
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: K, autoPullLimit: 1 }, NOW_263);
      if (budget.limit === 0) {
        assert.equal(budget.atWatermark, true, `K=${K}: a ceiling, not the per-cycle cap, must be what stopped the pull`);
        stopped = true;
        break;
      }
      for (let i = 0; i < budget.limit; i += 1) poolWaitEntry(queueDir, journalRoot, (n += 1), future);
    }
    assert.equal(stopped, true, `K=${K}: the pull must stop on its own`);
    const offBoard = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length;
    assert.equal(offBoard, 2 * K, `K=${K}: pulled up to the off-board ceiling (2K), then stopped`);
  }
});

// ---- card #268: a DUE entry the model-aware clamp SKIPS is not runnable work either ------------
//
// #166 action 2's fillSlots asks `admit` of every due entry and skips one no account is healthy
// for: servableFor(nextLlmCallForTask(entry)).healthy === 0. Such an entry is never spawned while
// its model cools, so it must not hold K shut -- it counts against the 2K off-board ceiling only,
// like a deferred one. A HELD entry (servable, waiting on live workers) still counts toward K.
// The pool fixtures write the pool's state.json directly with the exact shapes the card's probe
// names (Fable cooling with NO recorded scope -- no judge quota fallback applies); the clock is
// injected where computeAutoPullBudget takes one.

const HOUR_268 = 60 * 60 * 1000;

function pool268(state) {
  const dir = writePoolDir(mkTmp('spo-268-pool-'), [{ name: 'acct0' }, { name: 'acct1' }]);
  if (state) accounts.writeState(dir, state);
  return dir;
}

// Fable cooling on both accounts, no recorded scope (a pre-#166 record, or an unscoped limit):
// modelLimitedOnEveryAccount is false, so the judge's quota fallback never applies.
function fableCoolingUnscoped(until) {
  return pool268({ acct0: { byModel: { fable: { cooldownUntil: until } } }, acct1: { byModel: { fable: { cooldownUntil: until } } } });
}

// A pool-wait resume at CHECK whose notBefore has passed: due, and its first call is the Fable judge.
function dueResumeEntry(queueDir, n, dueAtMs) {
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(
    path.join(queueDir, `0000-retry-t-issue-${n}.json`),
    JSON.stringify({
      id: `issue-${n}`,
      kind: 'card',
      issue: n,
      resume: { startState: 'CHECK', prNumber: 4000 + n, worktreePath: `/tmp/spo-268-wt-${n}`, source: 'pool-wait' },
      notBefore: new Date(dueAtMs).toISOString(),
    })
  );
}

// dispatcher.js's fillSlots admit, restated with the same two first-call-model.js functions (read
// through dispatcher.js's re-export) and the same verdict rule, so takeNextTask answers what the
// clamp would do next. The real loop is driven end to end in test/dispatcher.test.js.
function fillSlotsAdmit(poolDir, config, liveSize, workers, nowMs, verdicts = []) {
  return (task, { id, taskDir }) => {
    const servable = servableFor(nextLlmCallForTask(task, taskDir, config), poolDir, nowMs);
    const verdict = servable.healthy === 0 ? 'skip' : liveSize < Math.min(workers, servable.healthy) ? 'take' : 'hold';
    verdicts.push({ id, verdict });
    return verdict;
  };
}

test('card #268 (a): the card\'s probe -- Fable cooling unscoped, Opus 5.5 healthy, due resumes do not hold K; before the fix every row was limit 0 but the last', () => {
  const until = NOW_263 + 3 * HOUR_268;
  // [resumes, in flight, limit at autoPullLimit 1, limit at autoPullLimit 5]
  const rows = [
    [2, 0, 1, 2], // was 0 / shut
    [1, 1, 1, 1], // was 0 / shut
    [1, 0, 1, 2], // was 1 / 1
  ];
  for (const [resumes, inFlight, limit1, limit5] of rows) {
    const queueDir = mkTmp('spo-268a-queue-');
    const journalRoot = mkTmp('spo-268a-journal-');
    writeLiveWorkerIds(journalRoot, Array.from({ length: inFlight }, (_, i) => `issue-${50 + i}`));
    for (let i = 0; i < resumes; i += 1) dueResumeEntry(queueDir, 900 + i, NOW_263 - 60 * 1000);
    const claudeAccountsDir = fableCoolingUnscoped(until);
    const label = `${resumes} skipped, ${inFlight} in flight`;
    const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 1, claudeAccountsDir }, NOW_263);
    assert.deepEqual(
      [budget.queued, budget.unservable, budget.deferred, budget.inFlight, budget.limit, budget.atWatermark],
      [0, resumes, 0, inFlight, limit1, false],
      label
    );
    assert.equal(computeAutoPullBudget(queueDir, journalRoot, { workers: 2, autoPullLimit: 5, claudeAccountsDir }, NOW_263).limit, limit5, label);
  }
});

test('card #268 (a): runAutoPull pulls a fresh card past 2 skipped resumes, and the clamp takes the fresh card, not a resume', async () => {
  const queueDir = mkTmp('spo-268a2-queue-');
  const journalRoot = mkTmp('spo-268a2-journal-');
  writeLiveWorkerIds(journalRoot, []);
  const now = Date.now();
  dueResumeEntry(queueDir, 901, now - 60 * 1000);
  dueResumeEntry(queueDir, 902, now - 60 * 1000);
  const claudeAccountsDir = fableCoolingUnscoped(now + 3 * HOUR_268);
  const config = { productRepo: '/fake/repo', workers: 2, autoPullLimit: 1, claudeAccountsDir };

  const result = await runAutoPull(queueDir, journalRoot, config, makeDeps({ candidates: [{ rank: 1, issue: 777, area: 'client', title: 'fresh' }] }));
  assert.deepEqual([result.enqueued, result.issues, result.atWatermark, result.queued, result.unservable], [1, [777], false, 0, 2]);

  const verdicts = [];
  const taken = takeNextTask(queueDir, journalRoot, new Set(), fillSlotsAdmit(claudeAccountsDir, config, 0, 2, Date.now(), verdicts));
  assert.equal(taken && taken.id, 'issue-777', 'the pulled card is the one the clamp spawns');
  assert.deepEqual(
    verdicts.map((v) => `${v.id}:${v.verdict}`),
    ['issue-901:skip', 'issue-902:skip', 'issue-777:take'],
    'the resumes are skipped (VALIDATE on fable), the fresh card taken (PLAN on claude-opus-5-5)'
  );
});

test('card #268 (a): a fresh card whose last park was plan-invalid (PLAN on Fable) is judged with its own journal -- skipped, so unservable', () => {
  const queueDir = mkTmp('spo-268pi-queue-');
  const journalRoot = mkTmp('spo-268pi-journal-');
  writeLiveWorkerIds(journalRoot, []);
  const taskDir = path.join(journalRoot, 'issue-903');
  fs.mkdirSync(taskDir, { recursive: true });
  appendEvent(taskDir, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });
  runnableEntry(queueDir, 903); // a due `retry` entry for the same card, no resume descriptor
  const claudeAccountsDir = fableCoolingUnscoped(NOW_263 + HOUR_268);
  const config = { workers: 2, autoPullLimit: 5, claudeAccountsDir };
  assert.equal(nextLlmCallForTask({ id: 'issue-903' }, taskDir, config).model, 'fable', 'test premise: PLAN moves to Fable after a plan-invalid park');
  const budget = computeAutoPullBudget(queueDir, journalRoot, config, NOW_263);
  assert.deepEqual([budget.queued, budget.unservable, budget.limit], [0, 1, 2]);
});

test('card #268 (b): a HELD entry (servable, waiting on the live workers) still counts toward K -- no over-pull', () => {
  const queueDir = mkTmp('spo-268b-queue-');
  const journalRoot = mkTmp('spo-268b-journal-');
  writeLiveWorkerIds(journalRoot, ['issue-50']); // 1 in flight
  runnableEntry(queueDir, 904); // a fresh card: PLAN on claude-opus-5-5
  // Opus 5.5 healthy on ONE account only: 1 live worker already matches it, so the clamp holds.
  const claudeAccountsDir = pool268({ acct1: { byModel: { [OPUS_5_5]: { cooldownUntil: NOW_263 + HOUR_268 } } } });
  const config = { workers: 2, autoPullLimit: 5, claudeAccountsDir };

  const verdicts = [];
  assert.equal(takeNextTask(queueDir, journalRoot, new Set(['issue-50']), fillSlotsAdmit(claudeAccountsDir, config, 1, 2, NOW_263, verdicts)), null);
  assert.deepEqual(verdicts.map((v) => v.verdict), ['hold'], 'test premise: fillSlots would HOLD this entry, not skip it');

  const budget = computeAutoPullBudget(queueDir, journalRoot, config, NOW_263);
  assert.deepEqual([budget.queued, budget.unservable, budget.inFlight, budget.limit, budget.atWatermark], [1, 0, 1, 0, true]);
});

// Every model cooling on one account -- the account-wide exhaustion shape.
function coolAll268(until) {
  return { byModel: Object.fromEntries(accounts.KNOWN_MODELS.map((m) => [m, { cooldownUntil: until }])) };
}

// A model-scoped usage limit on `model`, on both accounts, with the fields computeLimitUpdate writes.
function modelLimited268(model, until) {
  const rec = { byModel: { [model]: { cooldownUntil: until, cooldownScope: 'model', cooldownKind: 'usage' } } };
  return pool268({ acct0: rec, acct1: rec });
}

test('card #268 (c): the gate -- when no account could serve a fresh card\'s PLAN, auto-pull pulls nothing, and says why', async () => {
  // Every entry is skipped here, the resumes AND any fresh card pulled behind them, so without
  // the gate auto-pull would fill to 2K with cards that are never spawned (the verifier's finding).
  for (const K of [1, 2, 3]) {
    const until = NOW_263 + 12 * HOUR_268;
    // A due resume is skipped under whole-account cooling; under an Opus-only limit its Fable judge
    // is servable, so it is runnable and would fill K on its own -- that shape is asked empty.
    for (const [shape, claudeAccountsDir, resumeCounts] of [
      ['whole-account cooling', pool268({ acct0: coolAll268(until), acct1: coolAll268(until) }), [0, 1]],
      ['model-scoped Opus 5.5 limit', modelLimited268(OPUS_5_5, until), [0]],
    ]) {
      const queueDir = mkTmp('spo-268c-queue-');
      const journalRoot = mkTmp('spo-268c-journal-');
      writeLiveWorkerIds(journalRoot, []);
      for (const resumes of resumeCounts) {
        if (resumes) dueResumeEntry(queueDir, 900, NOW_263 - 60 * 1000);
        const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: K, autoPullLimit: 5, claudeAccountsDir }, NOW_263);
        const label = `K=${K}, ${shape}, ${resumes} due resume(s)`;
        assert.deepEqual(
          [budget.limit, budget.freshUnservable, budget.atWatermark],
          [0, true, false],
          `${label}: limit 0 from the gate -- the ceilings alone still had room`
        );
      }
    }
  }

  // runAutoPull: the gate closes before pullBoard's GraphQL read, and is reported, not journalled.
  const queueDir = mkTmp('spo-268c-run-queue-');
  const journalRoot = mkTmp('spo-268c-run-journal-');
  writeLiveWorkerIds(journalRoot, []);
  const until = Date.now() + 12 * HOUR_268;
  let boardRead = false;
  const deps = makeDeps({ candidates: [{ rank: 1, issue: 777, area: 'client', title: 'not pulled' }] });
  const spawnSync = deps.spawnSync;
  deps.spawnSync = (command, args, opts) => {
    if (command === 'npm') boardRead = true;
    return spawnSync(command, args, opts);
  };
  const config = { productRepo: '/fake/repo', workers: 2, autoPullLimit: 1, claudeAccountsDir: pool268({ acct0: coolAll268(until), acct1: coolAll268(until) }) };
  const result = await runAutoPull(queueDir, journalRoot, config, deps);
  assert.deepEqual([result.enqueued, result.freshUnservable, result.atWatermark, boardRead], [0, true, false, false]);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false, 'no auto-pull event for a gated cycle');
});

test('card #268 (c): the 2K ceiling still binds while fresh cards ARE servable -- Fable-only exhaustion, every pulled card turning into a skipped Fable judge', () => {
  // Each pulled card runs PLAN and IMPLEMENT on Opus 5.5, then resumes at CHECK waiting on the
  // Fable judge -- skipped, so out of K. The gate stays open (PLAN is servable); only the 2K
  // ceiling stops the pull.
  for (const K of [1, 2, 3]) {
    const queueDir = mkTmp('spo-268c2-queue-');
    const journalRoot = mkTmp('spo-268c2-journal-');
    writeLiveWorkerIds(journalRoot, []);
    const claudeAccountsDir = fableCoolingUnscoped(NOW_263 + 12 * HOUR_268);
    let n = 1000;
    let stopped = false;
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const budget = computeAutoPullBudget(queueDir, journalRoot, { workers: K, autoPullLimit: 1, claudeAccountsDir }, NOW_263);
      assert.equal(budget.freshUnservable, false, `K=${K}: a fresh card's PLAN is servable`);
      if (budget.limit === 0) {
        assert.equal(budget.atWatermark, true, `K=${K}: the off-board ceiling, not the per-cycle cap or the gate, stopped the pull`);
        stopped = true;
        break;
      }
      for (let i = 0; i < budget.limit; i += 1) dueResumeEntry(queueDir, (n += 1), NOW_263 - 60 * 1000);
    }
    assert.equal(stopped, true, `K=${K}: the pull must stop on its own`);
    assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 2 * K, `K=${K}: up to 2K off the board, then stop`);
  }

  // Mixed, K=2: unservable, deferred and in flight all share the 2K ceiling.
  const queueDir = mkTmp('spo-268c2-queue-');
  const journalRoot = mkTmp('spo-268c2-journal-');
  writeLiveWorkerIds(journalRoot, ['issue-50']);
  const claudeAccountsDir = fableCoolingUnscoped(NOW_263 + HOUR_268);
  dueResumeEntry(queueDir, 901, NOW_263 - 60 * 1000);
  poolWaitEntry(queueDir, journalRoot, 902, NOW_263 + HOUR_268);
  const config = { workers: 2, autoPullLimit: 5, claudeAccountsDir };
  let budget = computeAutoPullBudget(queueDir, journalRoot, config, NOW_263);
  assert.deepEqual([budget.queued, budget.unservable, budget.deferred, budget.inFlight, budget.limit], [0, 1, 1, 1, 1]);
  dueResumeEntry(queueDir, 903, NOW_263 - 60 * 1000);
  budget = computeAutoPullBudget(queueDir, journalRoot, config, NOW_263);
  assert.deepEqual([budget.unservable, budget.limit, budget.atWatermark], [2, 0, true], '2 unservable + 1 deferred + 1 in flight = 2K');
});

test('card #268: the verifier\'s simulation -- cycle by cycle, #268 never pulls more than main\'s rule unless a fresh card can run and main is held by skipped entries', () => {
  // main's rule (#263) is this same function with no pool configured: every due entry counts
  // toward K and there is no gate. Each cycle pulls `limit` fresh cards (autoPullLimit 1), which
  // stay queued -- under an exhaustion the dispatcher cannot spawn them, and elsewhere a queued or
  // spawned fresh card weighs the same against K.
  function pulledUntilStop({ K, pool, setup }) {
    const queueDir = mkTmp('spo-268sim-queue-');
    const journalRoot = mkTmp('spo-268sim-journal-');
    writeLiveWorkerIds(journalRoot, []);
    setup(queueDir, journalRoot);
    const config = { workers: K, autoPullLimit: 1, ...(pool ? { claudeAccountsDir: pool } : {}) };
    let pulled = 0;
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const { limit } = computeAutoPullBudget(queueDir, journalRoot, config, NOW_263);
      if (limit === 0) return pulled;
      for (let i = 0; i < limit; i += 1) runnableEntry(queueDir, 5000 + (pulled += 1));
    }
    throw new Error('never stopped');
  }
  const until = NOW_263 + 12 * HOUR_268;
  const wholeAccount = () => pool268({ acct0: coolAll268(until), acct1: coolAll268(until) });
  const fableOnly = () => fableCoolingUnscoped(until);
  const healthy = () => pool268(null);
  const empty = () => {};
  const oneDeferred = (q, j) => poolWaitEntry(q, j, 901, until);
  const twoDueResumes = (q) => {
    dueResumeEntry(q, 901, NOW_263 - 60 * 1000);
    dueResumeEntry(q, 902, NOW_263 - 60 * 1000);
  };
  // [label, K, pool, setup, main pulls, #268 pulls]
  const rows = [
    ['whole-account cooling, empty queue', 2, wholeAccount, empty, 2, 0],
    ['whole-account cooling, empty queue', 3, wholeAccount, empty, 3, 0],
    ['whole-account cooling, 1 deferred', 2, wholeAccount, oneDeferred, 2, 0],
    ['whole-account cooling, 2 due resumes', 2, wholeAccount, twoDueResumes, 0, 0],
    ['Fable-only cooling, 2 due resumes', 2, fableOnly, twoDueResumes, 0, 2],
    ['healthy pool, empty queue', 2, healthy, empty, 2, 2],
  ];
  for (const [label, K, pool, setup, mainPulls, newPulls] of rows) {
    const main = pulledUntilStop({ K, pool: null, setup });
    const now268 = pulledUntilStop({ K, pool: pool(), setup });
    assert.deepEqual([main, now268], [mainPulls, newPulls], `K=${K}, ${label}: [main, #268] pulls`);
    if (label.startsWith('Fable-only')) continue; // the one state #268 exists to open
    assert.ok(now268 <= main, `K=${K}, ${label}: #268 must never pull more than main`);
  }
});

test('card #268 (d): a skipped entry counts toward K again the instant its model\'s cooldown expires (injected clock)', () => {
  const queueDir = mkTmp('spo-268d-queue-');
  const journalRoot = mkTmp('spo-268d-journal-');
  writeLiveWorkerIds(journalRoot, []);
  const until = NOW_263 + HOUR_268;
  dueResumeEntry(queueDir, 901, NOW_263 - 60 * 1000);
  dueResumeEntry(queueDir, 902, NOW_263 - 60 * 1000);
  const config = { workers: 2, autoPullLimit: 5, claudeAccountsDir: fableCoolingUnscoped(until) };

  const cooling = computeAutoPullBudget(queueDir, journalRoot, config, until - 1);
  assert.deepEqual([cooling.queued, cooling.unservable, cooling.limit], [0, 2, 2], '1 ms before expiry: skipped');
  const expired = computeAutoPullBudget(queueDir, journalRoot, config, until);
  assert.deepEqual([expired.queued, expired.unservable, expired.limit, expired.atWatermark], [2, 0, 0, true], 'at expiry: runnable, K is full');

  // The gate reads the same injected instant: a whole-account cooldown lifts, and pulling resumes.
  const gated = { workers: 2, autoPullLimit: 5, claudeAccountsDir: pool268({ acct0: coolAll268(until), acct1: coolAll268(until) }) };
  const emptyQueue = mkTmp('spo-268d-empty-queue-');
  const before = computeAutoPullBudget(emptyQueue, journalRoot, gated, until - 1);
  assert.deepEqual([before.limit, before.freshUnservable], [0, true], '1 ms before expiry: gated');
  const after = computeAutoPullBudget(emptyQueue, journalRoot, gated, until);
  assert.deepEqual([after.limit, after.freshUnservable], [2, false], 'at expiry: the gate opens');
});

test('card #268: when servability cannot be judged, a due entry counts as runnable -- under-pull, never over-pull', () => {
  const queueDir = mkTmp('spo-268u-queue-');
  const journalRoot = mkTmp('spo-268u-journal-');
  writeLiveWorkerIds(journalRoot, []);
  dueResumeEntry(queueDir, 901, NOW_263 - 60 * 1000);
  dueResumeEntry(queueDir, 902, NOW_263 - 60 * 1000);
  const emptyQueue = mkTmp('spo-268u-empty-queue-');

  // A regular file where the pool should be: readRegistry's readdirSync throws ENOTDIR.
  const notADir = path.join(mkTmp('spo-268u-file-'), 'pool');
  fs.writeFileSync(notADir, 'not a directory');
  assert.throws(() => accounts.readRegistry(notADir), 'test premise: the registry read throws');
  // A registered, readable pool whose judgement throws: a state.json holding `null` makes readState
  // return null and countHealthyAccounts dereference it. This reaches both judges' own catch, past
  // the "is there a pool" check.
  const throwingState = pool268(null);
  fs.writeFileSync(path.join(throwingState, 'state.json'), 'null\n');
  assert.equal(accounts.readRegistry(throwingState).length, 2, 'test premise: two accounts registered');
  assert.throws(() => accounts.countHealthyAccounts(throwingState, NOW_263, 'fable'), 'test premise: the judgement throws');

  // CANNOT JUDGE (auto-pull.js's header): every one of these is #263's behaviour, for both judges.
  // A due entry counts as runnable, and on an empty queue the gate stays open (limit K), never 0.
  const cannotJudge = [
    ['no pool configured', undefined],
    ['missing pool dir', path.join(mkTmp('spo-268u-missing-'), 'absent')],
    ['empty pool dir (no account registered)', mkTmp('spo-268u-emptypool-')],
    ['unreadable registry (not a directory)', notADir],
    ['a throw while judging', throwingState],
  ];
  for (const [label, claudeAccountsDir] of cannotJudge) {
    const withResumes = computeAutoPullBudget(queueDir, journalRoot, { workers: 3, autoPullLimit: 5, claudeAccountsDir }, NOW_263);
    assert.deepEqual([withResumes.queued, withResumes.unservable, withResumes.limit], [2, 0, 1], `${label}: due entries count toward K`);
    const empty = computeAutoPullBudget(emptyQueue, journalRoot, { workers: 2, autoPullLimit: 5, claudeAccountsDir }, NOW_263);
    assert.deepEqual([empty.limit, empty.freshUnservable], [2, false], `${label}: the gate stays open`);
  }

  // The boundary: a pool that EXISTS is judged, even when nothing in it can serve. Every
  // registered account disabled -> nothing servable -> skipped entries, gate shut.
  const allDisabled = writePoolDir(mkTmp('spo-268u-disabled-'), [{ name: 'acct0', disabled: true }, { name: 'acct1', disabled: true }]);
  const judged = computeAutoPullBudget(queueDir, journalRoot, { workers: 3, autoPullLimit: 5, claudeAccountsDir: allDisabled }, NOW_263);
  assert.deepEqual([judged.queued, judged.unservable, judged.limit, judged.freshUnservable], [0, 2, 0, true]);
});

test('card #268: auto-pull.js asks first-call-model.js at RUN time -- the daemon\'s load order (state-machine.js first) still judges servability', () => {
  // first-call-model.js looks state-machine.js up lazily and throws if called while it is still
  // loading. state-machine.js loads auto-pull.js, so any load-time call into it from auto-pull.js
  // fails in this order, which this file's own require order (auto-pull.js first) cannot show.
  const queueDir = mkTmp('spo-268lazy-queue-');
  const journalRoot = mkTmp('spo-268lazy-journal-');
  writeLiveWorkerIds(journalRoot, []);
  dueResumeEntry(queueDir, 901, NOW_263 - 60 * 1000);
  const taskDir = path.join(journalRoot, 'issue-902');
  fs.mkdirSync(taskDir, { recursive: true });
  appendEvent(taskDir, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });
  runnableEntry(queueDir, 902);
  const claudeAccountsDir = fableCoolingUnscoped(NOW_263 + HOUR_268);

  const orch = path.join(__dirname, '..', 'orchestrator');
  const script = [
    `require(${JSON.stringify(path.join(orch, 'state-machine'))});`,
    `const { computeAutoPullBudget } = require(${JSON.stringify(path.join(orch, 'auto-pull'))});`,
    `const b = computeAutoPullBudget(${JSON.stringify(queueDir)}, ${JSON.stringify(journalRoot)}, { workers: 2, autoPullLimit: 5, claudeAccountsDir: ${JSON.stringify(claudeAccountsDir)} }, ${NOW_263});`,
    'process.stdout.write(JSON.stringify(b));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { env: isolatedEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const budget = JSON.parse(out);
  // Both lazy state-machine.js lookups ran: resumeValidationError (the resume) and
  // lastParkWasPlanInvalid (the plan-invalid retry) -- a swallowed throw would read as runnable.
  assert.deepEqual([budget.queued, budget.unservable, budget.limit], [0, 2, 2]);
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

test('card #263: runAutoPull with K pool-waiting cards queued pulls a fresh card, and takeNextTask takes THAT one, not a pool-wait', async () => {
  // End to end through the real scanner entry point: the budget, pullBoard, makeTask, then the
  // dispatcher's own takeNextTask. Wall-clock here (runAutoPull uses Date.now()), so the
  // pool-waits sit a full 3h ahead -- no margin to race.
  const queueDir = mkTmp('spo-263h-queue-');
  const journalRoot = mkTmp('spo-263h-journal-');
  writeLiveWorkerIds(journalRoot, []);
  const future = Date.now() + 3 * 60 * 60 * 1000;
  poolWaitEntry(queueDir, journalRoot, 901, future);
  poolWaitEntry(queueDir, journalRoot, 902, future);

  const deps = makeDeps({ candidates: [{ rank: 1, issue: 777, area: 'client', title: 'fresh card' }] });
  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', workers: 2, autoPullLimit: 1 }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.enqueued, 1, 'K pool-waits and a free slot: the scanner must pull');
  assert.deepEqual(result.issues, [777]);
  assert.equal(result.queued, 0);
  assert.equal(result.deferred, 2);

  const taken = takeNextTask(queueDir, journalRoot);
  assert.ok(taken, 'the fresh card is takeable now');
  assert.equal(String(taken.task.issue), '777', 'the dispatcher starts the fresh card; the pool-waits stay queued');
  assert.equal(takeNextTask(queueDir, journalRoot), null, 'both pool-waits are still deferred');
});
