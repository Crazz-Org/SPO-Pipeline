'use strict';
// Tests for SPO-Pipeline#294: MERGE asking GitHub's merge queue what happened to the PR
// (`orchestrator/merge-queue.js`'s pure `classifyMergeQueue`/`pickMergeGroupRun`, and
// `steps/scripted.js`'s `probeMergeQueue` wired into `realMerge`) instead of parking
// `merge-queue-not-landing` ("GitHub didn't say why") on a PR GitHub had removed, with a reason.
//
// Same two halves and same helper style as test/merge-cause.test.js: a pure table, then `realMerge`
// integration through an injected `deps.spawnSync`. Fixture shapes are GitHub's own, measured by
// the driver against SPO-WebClient PR 998 (2026-09-26/27) -- not guessed.

require('./no-real-spawn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { classifyMergeQueue, pickMergeGroupRun } = require('../orchestrator/merge-queue');
const { realMerge, probeMergeQueue } = require('../orchestrator/steps/scripted');
const { buildCtx, TERMINAL_PARK_REASONS, classifyParkReason } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { PARK_REASONS } = require('../console/plain-language');
const { mkTmp } = require('./helpers');

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

// A non-zero exit that still carries a well-formed body -- the exit-code guard, not JSON.parse,
// must be what rejects it (test/merge-cause.test.js's own M5 rationale).
function failWithStdout(status, stdout) {
  return { status, stdout, stderr: '', signal: null };
}

function killed() {
  return { status: null, stdout: '', stderr: '', signal: 'SIGTERM' };
}

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-mq-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-mq-bench-'),
    stepDeadlineMs: 30000,
    mainMovedRegateBudget: 1,
    ...overrides,
  };
}

function testCtx({ id, prNumber, config } = {}) {
  const dir = path.join(mkTmp('spo-mq-journalroot-'), id);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = buildCtx(id, { id, kind: 'card', issue: 900, worktreePath: mkTmp('spo-mq-wt-') }, dir, {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
  ctx.prNumber = prNumber;
  return ctx;
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---- fixtures: GitHub's own shapes -------------------------------------------------------------

const ADDED_1 = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-26T06:39:11Z' };
const REMOVED_FAILED = { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-26T06:41:56Z', reason: 'failed_checks' };
const ADDED_2 = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-27T07:51:44Z' };
const REMOVED_MERGED = { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-27T07:56:18Z', reason: 'merged' };

// PR 998 at the park moment (2026-09-26 06:48): open, out of the queue, removed after its addition.
const PR_998_AT_PARK = {
  state: 'OPEN',
  mergedAt: null,
  mergeQueueEntry: null,
  timelineItems: { nodes: [ADDED_1, REMOVED_FAILED] },
};

// PR 998 today, verbatim.
const PR_998_TODAY = {
  state: 'MERGED',
  mergedAt: '2026-09-27T07:56:18Z',
  mergeQueueEntry: null,
  timelineItems: { nodes: [ADDED_1, REMOVED_FAILED, ADDED_2, REMOVED_MERGED] },
};

function graphqlBody(pr) {
  return JSON.stringify({ data: { repository: { pullRequest: pr } } });
}

const RUN_998 = {
  id: 36224411591,
  head_branch: 'gh-readonly-queue/main/pr-998-e3a157f4aa00000000000000000000000000000000',
  conclusion: 'failure',
  created_at: '2026-09-26T06:39:29Z',
  html_url: 'https://github.com/Crazz-Org/SPO-WebClient/actions/runs/36224411591',
};
// Other PRs' merge-group runs share the window; `pr-9980-` and `pr-99-` must not match `pr-998-`.
const RUN_OTHER_9980 = {
  id: 111,
  head_branch: 'gh-readonly-queue/main/pr-9980-aaaa',
  conclusion: 'success',
  created_at: '2026-09-26T06:40:00Z',
  html_url: 'https://github.com/Crazz-Org/SPO-WebClient/actions/runs/111',
};
const RUN_OTHER_99 = {
  id: 222,
  head_branch: 'gh-readonly-queue/main/pr-99-bbbb',
  conclusion: 'success',
  created_at: '2026-09-26T06:40:30Z',
  html_url: 'https://github.com/Crazz-Org/SPO-WebClient/actions/runs/222',
};
const RUNS_BODY = JSON.stringify({ total_count: 3, workflow_runs: [RUN_OTHER_9980, RUN_998, RUN_OTHER_99] });

// ---- classifyMergeQueue: the pure table ----------------------------------------------------------

test('classifyMergeQueue: the park-time shape (OPEN, no entry, Removed failed_checks after Added) -> removed, GitHub\'s reason verbatim, both window bounds', () => {
  assert.deepEqual(classifyMergeQueue(PR_998_AT_PARK), {
    kind: 'removed',
    removedAt: '2026-09-26T06:41:56Z',
    removalReason: 'failed_checks',
    addedAt: '2026-09-26T06:39:11Z',
  });
});

test('classifyMergeQueue: last event Removed `merged` -> merged, even while state still reads OPEN', () => {
  assert.deepEqual(classifyMergeQueue({ ...PR_998_TODAY, state: 'OPEN', mergedAt: null }), { kind: 'merged' });
});

test('classifyMergeQueue: PR 998 today (state MERGED) -> merged', () => {
  assert.deepEqual(classifyMergeQueue(PR_998_TODAY), { kind: 'merged' });
});

test('classifyMergeQueue: a live mergeQueueEntry -> queued with its state -- and it wins over a trailing Removed event', () => {
  assert.deepEqual(
    classifyMergeQueue({ state: 'OPEN', mergeQueueEntry: { state: 'AWAITING_CHECKS' }, timelineItems: { nodes: [ADDED_1] } }),
    { kind: 'queued', entryState: 'AWAITING_CHECKS' }
  );
  assert.deepEqual(
    classifyMergeQueue({ ...PR_998_AT_PARK, mergeQueueEntry: { state: 'QUEUED' } }),
    { kind: 'queued', entryState: 'QUEUED' }
  );
});

test('classifyMergeQueue: Removed BEFORE the latest Added (a re-enqueue) -> queued, not removed', () => {
  assert.deepEqual(
    classifyMergeQueue({ state: 'OPEN', mergeQueueEntry: null, timelineItems: { nodes: [ADDED_1, REMOVED_FAILED, ADDED_2] } }),
    { kind: 'queued', entryState: null }
  );
});

test('classifyMergeQueue: a Removed with no Added inside the window -> removed with addedAt null', () => {
  assert.deepEqual(classifyMergeQueue({ state: 'OPEN', mergeQueueEntry: null, timelineItems: { nodes: [REMOVED_FAILED] } }), {
    kind: 'removed',
    removedAt: '2026-09-26T06:41:56Z',
    removalReason: 'failed_checks',
    addedAt: null,
  });
});

test('classifyMergeQueue: state CLOSED -> unknown (the mergeability probe\'s fact, not the queue\'s)', () => {
  assert.deepEqual(classifyMergeQueue({ ...PR_998_AT_PARK, state: 'CLOSED' }), { kind: 'unknown' });
});

test('classifyMergeQueue: empty or malformed input -> unknown, never a throw', () => {
  const inputs = [
    undefined,
    null,
    'OPEN',
    42,
    [],
    {},
    { state: 'OPEN' },
    { state: 'OPEN', mergeQueueEntry: null },
    { state: 'OPEN', timelineItems: null },
    { state: 'OPEN', timelineItems: { nodes: 'nope' } },
    { state: 'OPEN', timelineItems: { nodes: [] } },
    { state: 'OPEN', timelineItems: { nodes: [null, 42, 'x', { __typename: 'SomethingElse' }] } },
    { state: null, timelineItems: { nodes: [ADDED_1, REMOVED_FAILED] } },
  ];
  for (const input of inputs) {
    assert.deepEqual(classifyMergeQueue(input), { kind: 'unknown' }, `input ${JSON.stringify(input)}`);
  }
});

test('pickMergeGroupRun: filters on the `pr-<N>-` head-branch prefix (trailing dash included), maps id/url/conclusion; nothing matching or a non-array -> null', () => {
  assert.deepEqual(pickMergeGroupRun([RUN_OTHER_9980, RUN_998, RUN_OTHER_99], 998), {
    mergeGroupRunId: 36224411591,
    mergeGroupRunUrl: 'https://github.com/Crazz-Org/SPO-WebClient/actions/runs/36224411591',
    runConclusion: 'failure',
  });
  assert.equal(pickMergeGroupRun([RUN_OTHER_9980, RUN_OTHER_99], 998), null);
  assert.equal(pickMergeGroupRun(undefined, 998), null);
  assert.equal(pickMergeGroupRun({ workflow_runs: [RUN_998] }, 998), null);
  // Two runs for the same PR inside the window -> the most recently created.
  const rerun = { ...RUN_998, id: 36224499999, created_at: '2026-09-26T06:40:10Z', conclusion: 'cancelled' };
  assert.equal(pickMergeGroupRun([rerun, RUN_998], 998).mergeGroupRunId, 36224499999);
  assert.equal(pickMergeGroupRun([RUN_998, rerun], 998).mergeGroupRunId, 36224499999);
});

// ---- realMerge integration ----------------------------------------------------------------------

// queue: an array of responses for successive `gh api graphql` calls (the last one repeats), or a
// function. runs: the `gh api repos/.../actions/runs?...` response. probe: the mergeability read.
function makeDeps({ waitExits, queue, runs = ok(RUNS_BODY), probe = ok(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })) }) {
  const calls = [];
  const counts = { wait: 0, graphql: 0, runs: 0 };
  const spawnSync = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge') return ok('');
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return probe;
    if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
      const r = typeof queue === 'function' ? queue(counts.graphql) : queue[Math.min(counts.graphql, queue.length - 1)];
      counts.graphql += 1;
      return r;
    }
    if (command === 'gh' && args[0] === 'api' && String(args[1]).startsWith('repos/')) {
      counts.runs += 1;
      return typeof runs === 'function' ? runs() : runs;
    }
    if (command === 'npm' && args.includes('pr:wait')) {
      const exit = waitExits[Math.min(counts.wait, waitExits.length - 1)];
      counts.wait += 1;
      return exit === 0 ? ok('') : fail(exit);
    }
    return ok('');
  };
  return { deps: { spawnSync, sleep: () => Promise.resolve() }, calls, counts };
}

test('realMerge: pr:wait exits 4 and the queue says removed `failed_checks` -> PARKED merge-queue-removed with removalReason and mergeGroupRunId, and NO second pr:wait spawn', async () => {
  const ctx = testCtx({ id: 'card-mq-1', prNumber: 998 });
  const { deps, counts } = makeDeps({ waitExits: [4, 4], queue: [ok(graphqlBody(PR_998_AT_PARK))] });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'merge-queue-removed' &&
      err.detail.lastExit === 4 &&
      err.detail.removedAt === '2026-09-26T06:41:56Z' &&
      err.detail.removalReason === 'failed_checks' &&
      err.detail.mergeGroupRunId === 36224411591 &&
      err.detail.mergeGroupRunUrl === 'https://github.com/Crazz-Org/SPO-WebClient/actions/runs/36224411591' &&
      err.detail.runConclusion === 'failure'
  );
  assert.equal(counts.wait, 1, 'a removal parks before the second 600s wait is ever started');
  assert.equal(counts.graphql, 1);
  assert.equal(counts.runs, 1);

  const reads = readJournal(ctx.taskDir).filter((e) => e.event === 'merge-queue-read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].state, 'MERGE', 'the journal record\'s own state must not be clobbered by a detail field');
  assert.equal(reads[0].kind, 'removed');
  assert.equal(reads[0].prState, 'OPEN');
  assert.equal(reads[0].removalReason, 'failed_checks');
  assert.equal(reads[0].mergeGroupRunId, 36224411591);
  assert.equal(reads[0].prNumber, 998);
});

test('realMerge: the queue read FAILS (non-zero exit, even carrying a removed body) -> today\'s merge-queue-not-landing, unchanged, after both waits', async () => {
  const ctx = testCtx({ id: 'card-mq-2', prNumber: 998 });
  // A well-formed REMOVED body on exit 1: this passes only while `res.exit === 0` gates the parse.
  const { deps, counts } = makeDeps({ waitExits: [4, 4], queue: [failWithStdout(1, graphqlBody(PR_998_AT_PARK))] });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-queue-not-landing' && err.detail.lastExit === 4 && !('removedAt' in err.detail)
  );
  assert.equal(counts.wait, 2, 'no answer from the queue -> the second wait runs exactly as before');
  assert.equal(counts.graphql, 2, 'read after the first wait, and again before the fallback');
  assert.equal(counts.runs, 0, 'no removal was read, so no run lookup');
  const reads = readJournal(ctx.taskDir).filter((e) => e.event === 'merge-queue-read');
  assert.deepEqual(reads.map((e) => [e.kind, e.exit]), [['unknown', 1], ['unknown', 1]]);
});

test('realMerge: the queue read is killed on both spawn attempts (spawnStep throws its own ParkSignal) -> still merge-queue-not-landing, never command-killed-by-signal', async () => {
  const ctx = testCtx({ id: 'card-mq-3', prNumber: 998 });
  const { deps, counts } = makeDeps({ waitExits: [4, 4], queue: [killed()] });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-queue-not-landing' && err.detail.lastExit === 4
  );
  assert.equal(counts.wait, 2);
  assert.equal(counts.graphql, 4, 'two probe calls, each spawn retried once by spawnStep before it throws');
});

test('realMerge: queued on the first read, removed on the second -> merge-queue-removed after the second wait (the read before the fallback is live)', async () => {
  const ctx = testCtx({ id: 'card-mq-4', prNumber: 998 });
  const queued = graphqlBody({ state: 'OPEN', mergedAt: null, mergeQueueEntry: { state: 'AWAITING_CHECKS' }, timelineItems: { nodes: [ADDED_1] } });
  const { deps, counts } = makeDeps({ waitExits: [4, 4], queue: [ok(queued), ok(graphqlBody(PR_998_AT_PARK))] });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'merge-queue-removed' &&
      err.detail.lastExit === 4 &&
      err.detail.removalReason === 'failed_checks' &&
      err.detail.mergeGroupRunId === 36224411591
  );
  assert.equal(counts.wait, 2);
  assert.equal(counts.graphql, 2);
});

test('realMerge: a queued answer on both reads -> merge-queue-not-landing, unchanged', async () => {
  const ctx = testCtx({ id: 'card-mq-5', prNumber: 998 });
  const queued = graphqlBody({ state: 'OPEN', mergedAt: null, mergeQueueEntry: { state: 'QUEUED' }, timelineItems: { nodes: [ADDED_1] } });
  const { deps, counts } = makeDeps({ waitExits: [4, 4], queue: [ok(queued)] });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-queue-not-landing'
  );
  assert.equal(counts.runs, 0);
});

test('realMerge: removed, but the run lookup fails -> STILL merge-queue-removed (the removal is the fact), run fields null', async () => {
  const ctx = testCtx({ id: 'card-mq-6', prNumber: 998 });
  // A matching run in the body on a non-zero exit: only the `runs.exit === 0` guard keeps it out.
  const { deps, counts } = makeDeps({ waitExits: [4], queue: [ok(graphqlBody(PR_998_AT_PARK))], runs: failWithStdout(1, RUNS_BODY) });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'merge-queue-removed' &&
      err.detail.removalReason === 'failed_checks' &&
      err.detail.mergeGroupRunId === null &&
      err.detail.mergeGroupRunUrl === null &&
      err.detail.runConclusion === null
  );
  assert.equal(counts.runs, 1);
});

test('realMerge: removed, run lookup succeeds but finds no run for this PR (other PRs only) -> merge-queue-removed, run fields null', async () => {
  const ctx = testCtx({ id: 'card-mq-7', prNumber: 998 });
  const { deps } = makeDeps({
    waitExits: [4],
    queue: [ok(graphqlBody(PR_998_AT_PARK))],
    runs: ok(JSON.stringify({ workflow_runs: [RUN_OTHER_9980, RUN_OTHER_99] })),
  });

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-queue-removed' && err.detail.mergeGroupRunId === null
  );
});

test('realMerge: pr:wait exit 0 or 1 never reads the queue (only the exit-4 leg does)', async () => {
  for (const [id, waitExits] of [['card-mq-8a', [0]], ['card-mq-8b', [1]]]) {
    const ctx = testCtx({ id, prNumber: 998 });
    const { deps, counts } = makeDeps({ waitExits, queue: [ok(graphqlBody(PR_998_AT_PARK))] });
    await realMerge(ctx, deps).catch(() => {});
    assert.equal(counts.graphql, 0, `waitExits ${JSON.stringify(waitExits)}`);
  }
});

// ---- probeMergeQueue: argv, validation, degradation ---------------------------------------------

test('probeMergeQueue: owner/name come from config.ghRepo; the run lookup is a REST GET with its params in the path, windowed on Added..Removed', () => {
  const ctx = testCtx({ id: 'card-mq-9', prNumber: 998, config: testConfig({ ghRepo: 'Some-Org/Some.Repo' }) });
  const { deps, calls } = makeDeps({ waitExits: [0], queue: [ok(graphqlBody(PR_998_AT_PARK))] });

  const read = probeMergeQueue(ctx, deps, 998);
  assert.equal(read.kind, 'removed');

  const gql = calls.find((c) => c.args[1] === 'graphql');
  assert.deepEqual(gql.args.slice(0, 3), ['api', 'graphql', '-f']);
  assert.match(gql.args[3], /^query=\{repository\(owner:"Some-Org",name:"Some\.Repo"\)\{pullRequest\(number:998\)\{/);
  assert.match(gql.args[3], /mergeQueueEntry\{state\}/);
  assert.match(gql.args[3], /ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT/);

  const runs = calls.find((c) => c.args[0] === 'api' && String(c.args[1]).startsWith('repos/'));
  assert.deepEqual(runs.args, [
    'api',
    'repos/Some-Org/Some.Repo/actions/runs?event=merge_group&per_page=100&created=2026-09-26T06:39:11Z..2026-09-26T06:41:56Z',
  ]);
  assert.ok(!runs.args.includes('-f') && !runs.args.includes('-F'), 'a -f would turn this GET into a POST');
});

test('probeMergeQueue: a PR number that is not a positive integer is never interpolated -- no gh spawn, journalled as skipped, answer unknown', () => {
  for (const [i, bad] of [null, undefined, 0, -3, 1.5, '12', '12"){x}', 'abc'].entries()) {
    const ctx = testCtx({ id: `card-mq-10-${i}`, prNumber: bad });
    const { deps, calls } = makeDeps({ waitExits: [0], queue: [ok(graphqlBody(PR_998_AT_PARK))] });
    const read = probeMergeQueue(ctx, deps, bad);
    if (bad === '12') {
      // A digit-only string (state.json round trip) is the one non-number accepted.
      assert.equal(read.kind, 'removed');
      assert.match(calls[0].args[3], /pullRequest\(number:12\)/);
      continue;
    }
    assert.equal(read.kind, 'unknown', `prNumber ${JSON.stringify(bad)}`);
    assert.equal(calls.length, 0, `prNumber ${JSON.stringify(bad)} must never reach gh`);
    const [evt] = readJournal(ctx.taskDir).filter((e) => e.event === 'merge-queue-read');
    assert.equal(evt.skipped, 'invalid-pr-number');
  }
});

test('probeMergeQueue: a ghRepo that is not a plain owner/name pair is never interpolated -- no gh spawn, skipped invalid-gh-repo', () => {
  for (const [i, ghRepo] of ['Crazz-Org', 'a/b/c', 'Crazz-Org/SPO"){x}', '', 'Crazz Org/x'].entries()) {
    const ctx = testCtx({ id: `card-mq-11-${i}`, prNumber: 998, config: testConfig({ ghRepo }) });
    const { deps, calls } = makeDeps({ waitExits: [0], queue: [ok(graphqlBody(PR_998_AT_PARK))] });
    const read = probeMergeQueue(ctx, deps, 998);
    assert.equal(read.kind, 'unknown', `ghRepo ${JSON.stringify(ghRepo)}`);
    assert.equal(calls.length, 0);
    const [evt] = readJournal(ctx.taskDir).filter((e) => e.event === 'merge-queue-read');
    assert.equal(evt.skipped, 'invalid-gh-repo');
  }
});

test('probeMergeQueue: unparsable stdout, or JSON without data.repository -> unknown, no run lookup', () => {
  for (const [i, body] of ['not json', '{}', JSON.stringify({ data: { repository: null } }), JSON.stringify({ errors: [{ message: 'x' }] })].entries()) {
    const ctx = testCtx({ id: `card-mq-12-${i}`, prNumber: 998 });
    const { deps, counts } = makeDeps({ waitExits: [0], queue: [ok(body)] });
    assert.equal(probeMergeQueue(ctx, deps, 998).kind, 'unknown', body);
    assert.equal(counts.runs, 0);
  }
});

test('probeMergeQueue: a removal with no Added in the window has no bounds to look a run up by -- removed, no run lookup spawned', () => {
  const ctx = testCtx({ id: 'card-mq-13', prNumber: 998 });
  const pr = { state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [REMOVED_FAILED] } };
  const { deps, counts } = makeDeps({ waitExits: [0], queue: [ok(graphqlBody(pr))] });
  const read = probeMergeQueue(ctx, deps, 998);
  assert.equal(read.kind, 'removed');
  assert.equal(read.removalReason, 'failed_checks');
  assert.equal(counts.runs, 0);
  assert.equal(read.mergeGroupRunId, null);
});

// ---- registration -------------------------------------------------------------------------------

test('merge-queue-removed is registered: TERMINAL_PARK_REASONS, classified terminal, and a plain-language line exists', () => {
  assert.ok(TERMINAL_PARK_REASONS.has('merge-queue-removed'));
  assert.equal(classifyParkReason('merge-queue-removed'), 'terminal');
  assert.equal(typeof PARK_REASONS['merge-queue-removed'], 'string');
  assert.ok(!/didn't say why/.test(PARK_REASONS['merge-queue-removed']), 'GitHub DID say why -- the whole point of the reason');
});
