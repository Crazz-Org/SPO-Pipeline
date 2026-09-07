'use strict';
// Tests for SPO-Pipeline#85: MERGE parking on GitHub's own reported CAUSE (`orchestrator/merge-
// cause.js`'s pure `classifyMergeCause`, and `steps/scripted.js`'s `realMerge`/`probeMergeability`
// wiring it in) rather than the bare local SYMPTOM (`merge-queue-not-landing`).
//
// Two halves, same convention as test/real-steps.test.js's own MERGE section:
//   1. a plain unit table over `classifyMergeCause` -- no I/O, no ctx, no spawn.
//   2. `realMerge` integration tests using the SAME injected-`deps.spawnSync` style
//      test/real-steps.test.js:2646-2699 already uses -- copied here rather than reinvented, down
//      to the `ok`/`fail`/`testConfig`/`testCtx`/`readJournal` helper bodies.

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials (see test/real-steps.test.js's own header for the incident this backstops) -- must
// land before the orchestrator requires directly below, same convention every real-mode test file
// in this suite follows.
require('./no-real-spawn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { classifyMergeCause, MERGE_CAUSE_REASONS } = require('../orchestrator/merge-cause');
const { realMerge } = require('../orchestrator/steps/scripted');
const { buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { mkTmp } = require('./helpers');


function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

// failWithStdout(status, stdout) -- a NON-zero exit that still carries a well-formed JSON body.
// M5 (mutation testing): a test asserting "the exit code guard is honoured" must use a fixture
// whose stdout WOULD resolve to a definite answer if the guard were ever dropped -- otherwise a
// mutant that deletes the `exit === 0` check entirely still passes, because the only thing
// killing the mutant would have been `JSON.parse('')` throwing on empty stdout, not the guard
// itself. `fail()` above (empty stdout) stays for the genuinely-empty-response cases.
function failWithStdout(status, stdout) {
  return { status, stdout, stderr: '', signal: null };
}

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-mergecause-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-mergecause-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    mainMovedRegateBudget: 1,
    benchIdleWaitMaxPolls: 3,
    benchIdleWaitPollIntervalMs: 10,
    ...overrides,
  };
}

function testCtx({ id = 'card-1', task, config, taskDir } = {}) {
  const dir = taskDir || path.join(mkTmp('spo-mergecause-journalroot-'), id);
  fs.mkdirSync(dir, { recursive: true });
  return buildCtx(id, task, dir, {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---- classifyMergeCause: pure unit table --------------------------------------------------------

test('classifyMergeCause: state MERGED -> {kind: "merged"}, regardless of any other field', () => {
  assert.deepEqual(classifyMergeCause({ state: 'MERGED' }), { kind: 'merged' });
  // precedence: merged wins even over a DIRTY mergeStateStatus that would otherwise be a conflict.
  assert.deepEqual(classifyMergeCause({ state: 'MERGED', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), {
    kind: 'merged',
  });
});

test('classifyMergeCause: state CLOSED -> {kind: "closed"}, and wins over a BLOCKED mergeStateStatus', () => {
  assert.deepEqual(classifyMergeCause({ state: 'CLOSED' }), { kind: 'closed' });
  assert.deepEqual(classifyMergeCause({ state: 'CLOSED', mergeStateStatus: 'BLOCKED' }), { kind: 'closed' });
});

test('classifyMergeCause: mergeable CONFLICTING -> merge-conflict', () => {
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeable: 'CONFLICTING' }), {
    kind: 'cause',
    reason: MERGE_CAUSE_REASONS.CONFLICT,
  });
});

test('classifyMergeCause: mergeStateStatus DIRTY -> merge-conflict (same reason as CONFLICTING)', () => {
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeStateStatus: 'DIRTY' }), {
    kind: 'cause',
    reason: 'merge-conflict',
  });
});

test('classifyMergeCause: precedence -- mergeable CONFLICTING together with mergeStateStatus BLOCKED resolves to merge-conflict, not merge-blocked', () => {
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'BLOCKED' }), {
    kind: 'cause',
    reason: 'merge-conflict',
  });
});

test('classifyMergeCause: mergeStateStatus BLOCKED -> merge-blocked', () => {
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }), {
    kind: 'cause',
    reason: 'merge-blocked',
  });
});

test('classifyMergeCause: mergeStateStatus BEHIND -> merge-behind-base', () => {
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeStateStatus: 'BEHIND' }), {
    kind: 'cause',
    reason: 'merge-behind-base',
  });
});

test('classifyMergeCause: mergeStateStatus DRAFT -> merge-pr-draft', () => {
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeStateStatus: 'DRAFT' }), {
    kind: 'cause',
    reason: 'merge-pr-draft',
  });
});

test('classifyMergeCause: mergeStateStatus UNSTABLE -> merge-checks-failing', () => {
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeStateStatus: 'UNSTABLE' }), {
    kind: 'cause',
    reason: 'merge-checks-failing',
  });
});

test('classifyMergeCause: CLEAN, UNKNOWN, and HAS_HOOKS are never a cause -- all degrade to unknown', () => {
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeStateStatus: 'CLEAN' }), { kind: 'unknown' });
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), {
    kind: 'unknown',
  });
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeStateStatus: 'HAS_HOOKS' }), { kind: 'unknown' });
});

test('classifyMergeCause: an unrecognised enum value -> unknown, never invented', () => {
  assert.deepEqual(classifyMergeCause({ state: 'OPEN', mergeStateStatus: 'SOME_FUTURE_GITHUB_VALUE' }), {
    kind: 'unknown',
  });
});

test('classifyMergeCause: missing/null/undefined input -> unknown, never throws', () => {
  assert.deepEqual(classifyMergeCause({}), { kind: 'unknown' });
  assert.deepEqual(classifyMergeCause(undefined), { kind: 'unknown' });
  assert.deepEqual(classifyMergeCause({ state: null, mergeable: null, mergeStateStatus: null }), { kind: 'unknown' });
});

test('classifyMergeCause: lowercase input is classified exactly like uppercase (case-tolerant)', () => {
  assert.deepEqual(classifyMergeCause({ state: 'merged' }), { kind: 'merged' });
  assert.deepEqual(classifyMergeCause({ state: 'open', mergeStateStatus: 'blocked' }), {
    kind: 'cause',
    reason: 'merge-blocked',
  });
  assert.deepEqual(classifyMergeCause({ state: 'open', mergeable: 'conflicting' }), {
    kind: 'cause',
    reason: 'merge-conflict',
  });
});

// ---- realMerge integration: the mergeability probe wired in --------------------------------------

// `sleep` -- FIX 1's bounded re-poll (probeMergeability, steps/scripted.js) injects
// `deps.sleep`/`pollSleep`, the SAME convention `realCiChecks`'s own in-flight poll already uses
// (test/real-steps.test.js): production always sleeps for real, tests inject a no-op so the suite
// never actually waits out MERGE_PROBE_POLL_INTERVAL_MS x MERGE_PROBE_MAX_ATTEMPTS. Defaults to a
// recording no-op here so every existing call site keeps working unchanged, and any test that
// cares about the wait itself can read `sleeps` (an array of every `ms` argument, in call order)
// off the returned object.
function makeDeps({ enqueueExit = 0, waitExits, probe, sleep }) {
  let waitCalls = 0;
  const calls = [];
  const sleeps = [];
  const spawnSync = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'gh' && args.includes('merge')) return ok('');
    if (command === 'gh' && args.includes('view')) {
      if (typeof probe === 'function') return probe();
      return probe;
    }
    if (command === 'npm' && args.includes('pr:wait')) {
      const exit = waitExits[Math.min(waitCalls, waitExits.length - 1)];
      waitCalls += 1;
      return exit === 0 ? ok('') : fail(exit);
    }
    return ok('');
  };
  const sleepFn =
    sleep ||
    ((ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    });
  return {
    deps: { spawnSync, sleep: sleepFn },
    calls,
    sleeps,
    waitCallsRef: () => waitCalls,
  };
}

test('realMerge: [4,4] + probe reports CONFLICTING -> PARKED merge-conflict, detail carries mergeStateStatus, waitCalls === 2', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wt1-');
  const task = { id: 'card-mc1', kind: 'card', issue: 601, worktreePath };
  const ctx = testCtx({ id: 'card-mc1', task, config });
  ctx.prNumber = 601;

  const { deps, waitCallsRef } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-conflict' && err.detail.mergeStateStatus === 'DIRTY'
  );
  assert.equal(waitCallsRef(), 2);
});

test('realMerge: [4,4] + probe reports state MERGED -> returns FINISH, no park', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wt2-');
  const task = { id: 'card-mc2', kind: 'card', issue: 602, worktreePath };
  const ctx = testCtx({ id: 'card-mc2', task, config });
  ctx.prNumber = 602;

  const { deps } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'MERGED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })),
  });

  const next = await realMerge(ctx, deps);
  assert.equal(next, 'FINISH');
});

test('realMerge: [4,4] + probe exits non-zero (even carrying a valid, definite JSON body) -> falls back to merge-queue-not-landing with detail.lastExit === 4 (the exit-code guard, not JSON.parse, is what gates this -- M5)', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wt3-');
  const task = { id: 'card-mc3', kind: 'card', issue: 603, worktreePath };
  const ctx = testCtx({ id: 'card-mc3', task, config });
  ctx.prNumber = 603;

  // Deliberately a WELL-FORMED, DEFINITE body (OPEN/CONFLICTING/DIRTY -- would resolve to
  // merge-conflict if only `JSON.parse` were consulted) on a non-zero exit: this fixture passes
  // ONLY if the `exit === 0` guard in probeMergeability is actually honoured. `fail()`'s empty
  // stdout (used elsewhere for the genuinely-unparsable case) would let this test pass for the
  // wrong reason -- killed by `JSON.parse('')` throwing rather than by the guard -- which is
  // exactly the mutant this rewrite exists to catch.
  const { deps } = makeDeps({
    waitExits: [4, 4],
    probe: failWithStdout(1, JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-queue-not-landing' && err.detail.lastExit === 4
  );
});

test('realMerge: [4,4] + probe stdout is not JSON -> same fallback (merge-queue-not-landing, detail.lastExit === 4)', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wt4-');
  const task = { id: 'card-mc4', kind: 'card', issue: 604, worktreePath };
  const ctx = testCtx({ id: 'card-mc4', task, config });
  ctx.prNumber = 604;

  const { deps } = makeDeps({ waitExits: [4, 4], probe: ok('not json at all') });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-queue-not-landing' && err.detail.lastExit === 4
  );
});

test('realMerge: w1 exit 1 + probe reports MERGED -> returns FINISH (the measured issue-443 case: pr:wait said closed, GitHub says merged)', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wt5-');
  const task = { id: 'card-mc5', kind: 'card', issue: 443, worktreePath };
  const ctx = testCtx({ id: 'card-mc5', task, config });
  ctx.prNumber = 447;

  const { deps } = makeDeps({
    waitExits: [1],
    probe: ok(JSON.stringify({ state: 'MERGED', mergeable: null, mergeStateStatus: null })),
  });

  const next = await realMerge(ctx, deps);
  assert.equal(next, 'FINISH');
});

test('realMerge: w1 exit 1 + probe reports CLOSED -> PARKED pr-closed-unmerged', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wt6-');
  const task = { id: 'card-mc6', kind: 'card', issue: 606, worktreePath };
  const ctx = testCtx({ id: 'card-mc6', task, config });
  ctx.prNumber = 606;

  const { deps } = makeDeps({
    waitExits: [1],
    probe: ok(JSON.stringify({ state: 'CLOSED', mergeable: null, mergeStateStatus: null })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'pr-closed-unmerged' && err.detail.prState === 'CLOSED'
  );
});

test('realMerge: a pr-mergeability journal event is appended with the fields GitHub returned', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wt7-');
  const task = { id: 'card-mc7', kind: 'card', issue: 607, worktreePath };
  const ctx = testCtx({ id: 'card-mc7', task, config });
  ctx.prNumber = 607;

  const { deps } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })),
  });

  await assert.rejects(() => realMerge(ctx, deps), ParkSignal);

  const events = readJournal(ctx.taskDir).filter((e) => e.state === 'MERGE' && e.event === 'pr-mergeability');
  assert.equal(events.length, 1);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].exit, 0);
  assert.equal(events[0].prState, 'OPEN');
  assert.equal(events[0].mergeable, 'MERGEABLE');
  assert.equal(events[0].mergeStateStatus, 'BEHIND');
});

// ---- probeMergeability's gh argv -- M9 -----------------------------------------------------------
//
// M9 (mutation testing): dropping `--repo` from the probe's argv, or dropping a field from
// `--json`, survives every test above unnoticed. `--repo` is load-bearing: probeMergeability
// passes no `cwd` to spawnStep, and runSync (scripted.js) injects none either, so without
// `--repo <config.ghRepo>` a real `gh pr view` would resolve the PR number against the DAEMON's
// own cwd -- the wrong repo entirely -- rather than config.ghRepo. Pin the argv exactly.

test('realMerge: the mergeability probe\'s gh argv is exactly ["pr","view",<prNumber>,"--repo",config.ghRepo,"--json","state,mergeable,mergeStateStatus"] -- M9', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wt9-');
  const task = { id: 'card-mc9', kind: 'card', issue: 609, worktreePath };
  const ctx = testCtx({ id: 'card-mc9', task, config });
  ctx.prNumber = 609;

  // A definite answer on the FIRST read (CONFLICTING) so the bounded re-poll never fires a
  // second `gh view` call -- this test is about the argv of one call, not the retry loop.
  const { deps, calls } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })),
  });

  await assert.rejects(() => realMerge(ctx, deps), ParkSignal);

  const viewCalls = calls.filter((c) => c.command === 'gh' && c.args.includes('view'));
  assert.equal(viewCalls.length, 1, 'a definite first read must not trigger a second gh view call');
  assert.deepEqual(viewCalls[0].args, [
    'pr',
    'view',
    '609',
    '--repo',
    config.ghRepo,
    '--json',
    'state,mergeable,mergeStateStatus',
  ]);
});

// ---- parkFromMergeCause's four untested branches -- M6c ------------------------------------------
//
// M6c (mutation testing, HIGHEST impact): swapping the BLOCKED<->BEHIND or DRAFT<->UNSTABLE
// mappings in parkFromMergeCause survives every test above unnoticed -- only CONFLICT had a
// behavioural realMerge test. A branch-protection block silently parking as merge-behind-base
// would tell a maintainer to rebase when the real fix is an approval. One realMerge test per
// remaining branch, each asserting the reason AND that mergeStateStatus rode along in the detail.

test('realMerge: probe reports mergeStateStatus BLOCKED -> PARKED merge-blocked -- M6c', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtM6c-blocked-');
  const task = { id: 'card-mc-blocked', kind: 'card', issue: 6101, worktreePath };
  const ctx = testCtx({ id: 'card-mc-blocked', task, config });
  ctx.prNumber = 6101;

  const { deps } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-blocked' && err.detail.mergeStateStatus === 'BLOCKED'
  );
});

test('realMerge: probe reports mergeStateStatus BEHIND -> PARKED merge-behind-base -- M6c', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtM6c-behind-');
  const task = { id: 'card-mc-behind', kind: 'card', issue: 6102, worktreePath };
  const ctx = testCtx({ id: 'card-mc-behind', task, config });
  ctx.prNumber = 6102;

  const { deps } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-behind-base' && err.detail.mergeStateStatus === 'BEHIND'
  );
});

test('realMerge: probe reports mergeStateStatus DRAFT -> PARKED merge-pr-draft -- M6c', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtM6c-draft-');
  const task = { id: 'card-mc-draft', kind: 'card', issue: 6103, worktreePath };
  const ctx = testCtx({ id: 'card-mc-draft', task, config });
  ctx.prNumber = 6103;

  const { deps } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-pr-draft' && err.detail.mergeStateStatus === 'DRAFT'
  );
});

test('realMerge: probe reports mergeStateStatus UNSTABLE -> PARKED merge-checks-failing -- M6c', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtM6c-unstable-');
  const task = { id: 'card-mc-unstable', kind: 'card', issue: 6104, worktreePath };
  const ctx = testCtx({ id: 'card-mc-unstable', task, config });
  ctx.prNumber = 6104;

  const { deps } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) =>
      err instanceof ParkSignal && err.reason === 'merge-checks-failing' && err.detail.mergeStateStatus === 'UNSTABLE'
  );
});

// ---- the w1-exit-1 branches -- M2c and M10 --------------------------------------------------------
//
// M2c (mutation testing, most-travelled path in production once FIX 1 lands): the `w1.exit === 1`
// + probe-stays-`unknown` fallback had zero tests -- its exit-4 twin (the "probe stdout is not
// JSON" test above) had two. Given GitHub's `UNKNOWN`-first laziness (this file's own header,
// merge-cause.js's), this exact shape -- pr:wait says closed, GitHub never resolves past UNKNOWN
// across all three bounded attempts -- is the single most likely production path.

test('realMerge: w1 exit 1 + probe stays UNKNOWN across all bounded attempts -> PARKED pr-closed-unmerged with the ORIGINAL (unenriched) detail -- M2c', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtM2c-');
  const task = { id: 'card-mc-m2c', kind: 'card', issue: 6105, worktreePath };
  const ctx = testCtx({ id: 'card-mc-m2c', task, config });
  ctx.prNumber = 6105;

  const { deps } = makeDeps({
    waitExits: [1],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'pr-closed-unmerged' &&
      err.detail.exit === 1 &&
      err.detail.prState === undefined // the ORIGINAL, unenriched detail shape -- exit only, no prState/mergeable/mergeStateStatus
  );

  const events = readJournal(ctx.taskDir).filter((e) => e.state === 'MERGE' && e.event === 'pr-mergeability');
  assert.equal(events.length, 3, 'GitHub never resolving past UNKNOWN must spend every bounded attempt, not fewer');
  assert.deepEqual(events.map((e) => e.attempt), [1, 2, 3]);
});

// M10: the exit-1 + GitHub-gives-a-cause path is untested (only the exit-4 twin, via the very
// first realMerge test in this file, covers a probe cause).

test('realMerge: w1 exit 1 + probe reports CONFLICTING -> PARKED merge-conflict -- M10', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtM10-');
  const task = { id: 'card-mc-m10', kind: 'card', issue: 6106, worktreePath };
  const ctx = testCtx({ id: 'card-mc-m10', task, config });
  ctx.prNumber = 6106;

  const { deps } = makeDeps({
    waitExits: [1],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-conflict' && err.detail.exit === 1
  );
});

// ---- the probe's own try/catch -- M3b ---------------------------------------------------------
//
// M3b (mutation testing): narrowing probeMergeability's catch to `if (e instanceof ParkSignal)
// throw e;` survives every test above unnoticed -- the guard the code's own comment calls
// load-bearing (spawnStep really does throw a ParkSignal on its own command timeout, e.g.
// `gh-timed-out`) was never exercised. Replacing a diagnosable MERGE park with a generic timeout
// park would be a real regression: simulate spawnStep's own `gh pr view` throwing a ParkSignal on
// every bounded attempt and assert the card still parks with the ORIGINAL merge reason, never
// `gh-timed-out`.

test('realMerge: probe\'s own gh pr view throws a ParkSignal (as spawnStep does on its own timeout) on every bounded attempt -> still PARKED with the ORIGINAL merge-queue-not-landing reason, never gh-timed-out -- M3b', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtM3b-');
  const task = { id: 'card-mc-m3b', kind: 'card', issue: 6107, worktreePath };
  const ctx = testCtx({ id: 'card-mc-m3b', task, config });
  ctx.prNumber = 6107;

  const { deps } = makeDeps({
    waitExits: [4, 4],
    probe: () => {
      throw new ParkSignal('gh-timed-out', { state: 'MERGE' });
    },
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-queue-not-landing' && err.detail.lastExit === 4
  );
});

// ---- FIX 1: the bounded re-poll on UNKNOWN --------------------------------------------------------
//
// GitHub computes mergeable/mergeStateStatus LAZILY (measured: 4/4 cold PRs on this account
// answered UNKNOWN/UNKNOWN on the first read; a definite answer arrived, across 9 timed cold
// PRs, once ~1.55s of wall-clock had elapsed since that first UNKNOWN, regardless of call count).
// probeMergeability re-reads up to MERGE_PROBE_MAX_ATTEMPTS (3) times, sleeping between reads via
// the injected deps.sleep, and stops the moment an attempt lands a definite answer.

test('realMerge: probe reads UNKNOWN twice then DIRTY on the third read -> PARKED merge-conflict, exactly 3 gh view calls, exactly 2 sleeps of ~750ms', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtF1a-');
  const task = { id: 'card-f1a', kind: 'card', issue: 6201, worktreePath };
  const ctx = testCtx({ id: 'card-f1a', task, config });
  ctx.prNumber = 6201;

  let probeCalls = 0;
  const { deps, calls, sleeps } = makeDeps({
    waitExits: [4, 4],
    probe: () => {
      probeCalls += 1;
      if (probeCalls < 3) {
        return ok(JSON.stringify({ state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }));
      }
      return ok(JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
    },
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-conflict' && err.detail.mergeStateStatus === 'DIRTY'
  );

  const viewCalls = calls.filter((c) => c.command === 'gh' && c.args.includes('view'));
  assert.equal(viewCalls.length, 3, 'the third, definite read must actually be reached');
  assert.equal(sleeps.length, 2, 'one sleep BETWEEN each pair of reads -- never after the last, definite one');
  sleeps.forEach((ms) => assert.equal(ms, 750));

  const events = readJournal(ctx.taskDir).filter((e) => e.state === 'MERGE' && e.event === 'pr-mergeability');
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.attempt), [1, 2, 3]);
  assert.equal(events[0].mergeStateStatus, 'UNKNOWN');
  assert.equal(events[1].mergeStateStatus, 'UNKNOWN');
  assert.equal(events[2].mergeStateStatus, 'DIRTY');
});

test('realMerge: probe reads UNKNOWN on the first attempt and DIRTY on the second -> stops early, exactly 2 gh view calls, exactly 1 sleep', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtF1b-');
  const task = { id: 'card-f1b', kind: 'card', issue: 6202, worktreePath };
  const ctx = testCtx({ id: 'card-f1b', task, config });
  ctx.prNumber = 6202;

  let probeCalls = 0;
  const { deps, calls, sleeps } = makeDeps({
    waitExits: [4, 4],
    probe: () => {
      probeCalls += 1;
      if (probeCalls === 1) {
        return ok(JSON.stringify({ state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }));
      }
      return ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }));
    },
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-blocked'
  );

  const viewCalls = calls.filter((c) => c.command === 'gh' && c.args.includes('view'));
  assert.equal(viewCalls.length, 2, 'stop the instant the answer is definite -- never spend the third attempt');
  assert.equal(sleeps.length, 1);
});

test('realMerge: probe stays UNKNOWN across all 3 bounded attempts -> falls back to the original symptom reason, never more than 3 gh view calls or 2 sleeps', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtF1c-');
  const task = { id: 'card-f1c', kind: 'card', issue: 6203, worktreePath };
  const ctx = testCtx({ id: 'card-f1c', task, config });
  ctx.prNumber = 6203;

  const { deps, calls, sleeps } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-queue-not-landing' && err.detail.lastExit === 4
  );

  const viewCalls = calls.filter((c) => c.command === 'gh' && c.args.includes('view'));
  assert.equal(viewCalls.length, 3, 'the bound is exactly 3 -- never re-polled forever');
  assert.equal(sleeps.length, 2);
});

test('realMerge: probe reports state MERGED on the FIRST read even though mergeable/mergeStateStatus are still UNKNOWN -> stops immediately, no re-poll (a terminal state is definite regardless of the other two fields)', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-mergecause-wtF1d-');
  const task = { id: 'card-f1d', kind: 'card', issue: 6204, worktreePath };
  const ctx = testCtx({ id: 'card-f1d', task, config });
  ctx.prNumber = 6204;

  const { deps, calls, sleeps } = makeDeps({
    waitExits: [4, 4],
    probe: ok(JSON.stringify({ state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })),
  });

  const next = await realMerge(ctx, deps);
  assert.equal(next, 'FINISH');

  const viewCalls = calls.filter((c) => c.command === 'gh' && c.args.includes('view'));
  assert.equal(viewCalls.length, 1);
  assert.equal(sleeps.length, 0);
});
