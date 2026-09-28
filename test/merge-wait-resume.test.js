'use strict';
// merge-wait-resume.test.js -- SPO-Pipeline#295: a task whose daemon died while it sat in MERGE,
// with its PR still in GitHub's merge queue (or already merged), is re-enqueued by orphan-scan.js
// as a MERGE-wait resume instead of being parked `task-orphaned-daemon-restart` (whose `retry`
// restarts at INTAKE and rebuilds the validated PR). Maintainer decision, 2026-09-27. See
// doc/state-machine-spec.md, "Machine resume of a MERGE wait".
//
// Four parts: (1) orphanScan decides and writes the descriptor; (2) runTask's MERGE-wait resume
// (real mode, every spawn a fake) waits once and ends through FINISH or parks; (3) prepareResume's
// refusals of that descriptor -- a MERGED PR goes to FINISH, everything else parks, never INTAKE;
// (4) descriptor validation, registration, carriedResume, and the spawn-count source pin. Fixture
// shapes for the queue read are GitHub's own (SPO-WebClient PR 998, 2026-09-26), as in
// test/orphan-scan.test.js's #294 block.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must land before any orchestrator require (see test/no-real-spawn.js's header).
require('./no-real-spawn');
const { orphanScan } = require('../orchestrator/orphan-scan');
const { unparkScan } = require('../orchestrator/park-loop');
const { writeState } = require('../orchestrator/journal');
const {
  runTask,
  drainQueueOnce,
  buildCtx,
  resumeValidationError,
  RESUME_START_STATES,
  MERGE_WAIT_RESUME_SOURCE,
  MERGE_WAIT_RESUME_MAX,
  mergeWaitResume,
  carriedResume,
} = require('../orchestrator/state-machine');
const { mkTmp } = require('./helpers');

const PR = 998;
const DEAD_PID = 999999;
const MERGE_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const TIP_SHA = 'e3a157f4e3a157f4e3a157f4e3a157f4e3a157f4';

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}
function exitWith(status, stdout = '') {
  return { status, stdout, stderr: '', signal: null };
}

function readJournal(taskDir) {
  const file = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function readDaemonEvents(journalRoot) {
  const file = path.join(journalRoot, 'daemon.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function readState(taskDir) {
  return JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
}
function queuedFiles(queueDir) {
  return fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).sort() : [];
}

// ---- the merge-queue read (gh api graphql) --------------------------------------------------
const MQ_ADDED = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-09-26T06:39:11Z' };
const MQ_REMOVED = { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-26T06:41:56Z', reason: 'failed_checks' };
const MQ_REMOVED_MERGED = { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-26T06:41:56Z', reason: 'merged' };
function mqBody(pr) {
  return JSON.stringify({ data: { repository: { pullRequest: pr } } });
}
const QUEUE = {
  queued: mqBody({ state: 'OPEN', mergedAt: null, mergeQueueEntry: { state: 'AWAITING_CHECKS' }, timelineItems: { nodes: [MQ_ADDED] } }),
  merged: mqBody({ state: 'MERGED', mergedAt: '2026-09-26T06:41:56Z', mergeQueueEntry: null, timelineItems: { nodes: [MQ_ADDED, MQ_REMOVED_MERGED] } }),
  mergedEvent: mqBody({ state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [MQ_ADDED, MQ_REMOVED_MERGED] } }),
  removed: mqBody({ state: 'OPEN', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [MQ_ADDED, MQ_REMOVED] } }),
  closed: mqBody({ state: 'CLOSED', mergedAt: null, mergeQueueEntry: null, timelineItems: { nodes: [MQ_ADDED] } }),
};
const RUNS_BODY = JSON.stringify({
  workflow_runs: [
    {
      id: 36224411591,
      head_branch: `gh-readonly-queue/main/pr-${PR}-e3a157f4`,
      conclusion: 'failure',
      created_at: '2026-09-26T06:39:29Z',
      html_url: 'https://github.com/Crazz-Org/SPO-WebClient/actions/runs/36224411591',
    },
  ],
});

// One fake for every command an orphan scan and a MERGE-wait wake-up can spawn. `calls` records
// them all, in order. Options describe the world: the queue answer, the PR as `gh pr view` reads it
// at the wake-up, `pr:wait`'s exit, the worktree's status, whether the remote branch still exists.
function makeWorld(opts = {}) {
  const w = {
    queue: 'queued',
    prState: 'OPEN',
    headRefName: null, // defaults to the task's own branch (set by seedMergeOrphan)
    prWaitExit: 0,
    dirty: '',
    remoteBranch: true,
    onGraphql: null, // a hook a race test uses to act while the scan is "on the network"
    calls: [],
    ...opts,
  };
  w.spawnSync = (command, args, spawnOpts) => {
    const argv = [...args];
    w.calls.push({ command, args: argv, cwd: (spawnOpts && spawnOpts.cwd) || null });
    if (w.onSpawn) w.onSpawn(command, argv);
    if (command === 'gh') {
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        if (w.onGraphql) w.onGraphql();
        return typeof w.queue === 'string' && QUEUE[w.queue] ? ok(QUEUE[w.queue]) : w.queue;
      }
      if (argv[0] === 'api' && String(argv[1]).startsWith('repos/')) return ok(RUNS_BODY);
      if (argv[0] === 'pr' && argv[1] === 'view') {
        const json = argv[argv.indexOf('--json') + 1];
        if (json === 'mergeCommit') return ok(JSON.stringify({ mergeCommit: { oid: MERGE_SHA } }));
        return ok(JSON.stringify({ state: w.prState, headRefName: w.headRefName }));
      }
      if (argv[0] === 'issue' && argv[1] === 'comment') return ok(`https://github.com/x/y/issues/1#issuecomment-${w.calls.length}`);
      return ok('');
    }
    if (command === 'git') {
      if (argv.includes('rev-parse') && argv.includes('MERGE_HEAD')) return exitWith(1);
      if (argv.includes('symbolic-ref')) return ok(`${w.branch}\n`);
      if (argv.includes('--abbrev-ref')) return ok('main\n');
      if (argv.includes('status') && argv.includes('--porcelain')) {
        return argv[1] === w.worktreePath ? ok(w.dirty) : ok('');
      }
      if (argv.includes('rev-parse') && argv.some((a) => String(a).startsWith('refs/remotes/origin/'))) {
        return w.remoteBranch ? ok(`${TIP_SHA}\n`) : exitWith(1);
      }
      if (argv.includes('rev-parse') && argv.includes('HEAD')) return ok(`${TIP_SHA}\n`);
      return ok('');
    }
    if (command === 'npm') {
      if (argv[1] === 'pr:wait') return exitWith(w.prWaitExit);
      return ok('');
    }
    return ok('');
  };
  return w;
}

function testConfig(pipelineWorktreesDir, overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir,
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-mwr-bench-'),
    stepDeadlineMs: 30000,
    claudeAccountsDir: mkTmp('spo-mwr-accts-'),
    orphanGraceMs: 1000,
    benchIdleWaitMaxPolls: 3,
    benchIdleWaitPollIntervalMs: 10,
    owner: { host: os.hostname(), pid: process.pid, lockStartedAt: '2026-09-27T00:00:00.000Z' },
    ...overrides,
  };
}

// A task that died in MERGE: task.json (the queue entry its run was taken from), a state.json
// written by a now-dead owner, its worktree on disk under the pipeline's own namespace.
function seedMergeOrphan({ id = 'issue-951', taskExtra = {}, stateExtra = {}, worldOpts = {}, configOverrides = {} } = {}) {
  const journalRoot = mkTmp('spo-mwr-journal-');
  const queueDir = mkTmp('spo-mwr-queue-');
  const pipelineWorktreesDir = mkTmp('spo-mwr-worktrees-');
  const worktreePath = path.join(pipelineWorktreesDir, id);
  fs.mkdirSync(worktreePath, { recursive: true });
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id, kind: 'card', issue: 951, title: 'Merge-wait card', ...taskExtra }, null, 2)
  );
  writeState(taskDir, {
    id,
    state: 'MERGE',
    diagnoseAttempts: 1,
    validateRejects: 2,
    ciImplementRetries: 1,
    mainMoveUsed: 1,
    prNumber: PR,
    worktreePath,
    owner: { host: os.hostname(), workerPid: DEAD_PID, workerStartedAt: 'old' },
    updatedAt: new Date(Date.now() - 10_000).toISOString(),
    ...stateExtra,
  });
  const world = makeWorld(worldOpts);
  world.branch = `claude-pipe/${id}`;
  world.worktreePath = worktreePath;
  if (world.headRefName === null) world.headRefName = world.branch;
  const config = testConfig(pipelineWorktreesDir, { ...configOverrides, deps: { spawnSync: world.spawnSync } });
  const deps = { isAlive: () => false, spawnSync: world.spawnSync };
  return { id, journalRoot, queueDir, pipelineWorktreesDir, worktreePath, taskDir, world, config, deps };
}

function onlyQueued(queueDir) {
  const files = queuedFiles(queueDir);
  assert.equal(files.length, 1, `expected exactly one queue entry, found ${JSON.stringify(files)}`);
  return { file: files[0], entry: JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf8')) };
}

const isGh = (c, a0, a1) => c.command === 'gh' && c.args[0] === a0 && c.args[1] === a1;
const ghPrMerge = (calls) => calls.filter((c) => isGh(c, 'pr', 'merge'));
const ghComments = (calls) => calls.filter((c) => isGh(c, 'issue', 'comment'));
const prWaits = (calls) => calls.filter((c) => c.command === 'npm' && c.args[1] === 'pr:wait');
const graphqlReads = (calls) => calls.filter((c) => isGh(c, 'api', 'graphql'));
const worktreeAdds = (calls) => calls.filter((c) => c.command === 'git' && c.args.includes('worktree') && c.args.includes('add'));
// Every npm script but the two a MERGE-wait run legitimately spawns: CHECK's aliases, GATE, a claim.
const otherNpm = (calls) => calls.filter((c) => c.command === 'npm' && !['pr:wait', 'board:move'].includes(c.args[1]));

// The states a MERGE-wait wake-up is allowed to journal under. Anything else (INTAKE, WORKTREE,
// PLAN, IMPLEMENT, CHECK, PUSH_PR, GATE, CI_CHECKS, VALIDATE, DIAGNOSE) means the resume re-gated,
// re-validated or restarted.
const WAKE_STATES = new Set(['MERGE', 'FINISH', 'DONE']);
function statesAfter(taskDir, fromEvent) {
  const j = readJournal(taskDir);
  const i = j.findIndex((e) => e.event === fromEvent);
  assert.ok(i >= 0, `expected a '${fromEvent}' event`);
  return new Set(j.slice(i).map((e) => e.state));
}

// ================================================================================================
// ---- part 1: orphanScan re-enqueues a queued or merged MERGE orphan --------------------------
// ================================================================================================

for (const queue of ['queued', 'merged', 'mergedEvent']) {
  test(`orphanScan (#295): MERGE orphan, probe ${queue} -> re-enqueued as a machine MERGE-wait resume; no park, no comment, state.json untouched`, async () => {
    const s = seedMergeOrphan({
      taskExtra: { transientRetries: 1, poolWaitMs: 5000, poolWaitAttempts: 1, notBefore: '2099-01-01T00:00:00.000Z' },
      worldOpts: { queue },
    });
    const stateBefore = fs.readFileSync(path.join(s.taskDir, 'state.json'), 'utf8');

    const recovered = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
    const kind = queue === 'queued' ? 'queued' : 'merged';
    assert.deepEqual(recovered, [{ id: s.id, resumed: 'MERGE', queue: kind }]);

    const { file, entry } = onlyQueued(s.queueDir);
    assert.equal(file, `0000-retry-t-${String(1).padStart(20, '0')}-${s.id}.json`, 'keyed on the resume count, machine class t');
    assert.deepEqual(entry.resume, {
      startState: 'MERGE',
      prNumber: PR,
      worktreePath: s.worktreePath,
      fromReason: 'task-orphaned-daemon-restart',
      source: MERGE_WAIT_RESUME_SOURCE,
      counters: { diagnoseAttempts: 1, validateRejects: 2, ciImplementRetries: 1, outOfScopeRecheckUsed: 0, seenRootCauses: [], mergeWaitResumes: 1 },
    });
    assert.equal(resumeValidationError(entry.resume), null, 'the descriptor the scan writes is one runTask accepts');
    // Machine allowances carried, the deadline not (the resume should run now).
    assert.equal(entry.transientRetries, 1);
    assert.equal(entry.poolWaitMs, 5000);
    assert.equal(entry.poolWaitAttempts, 1);
    assert.ok(!('notBefore' in entry));

    assert.equal(fs.readFileSync(path.join(s.taskDir, 'state.json'), 'utf8'), stateBefore, 'no PARKED write');
    const journal = readJournal(s.taskDir);
    assert.ok(!journal.some((e) => e.event === 'parked'));
    assert.equal(ghComments(s.world.calls).length, 0, 'no park comment');
    assert.equal(s.world.calls.filter((c) => c.command === 'npm').length, 0, 'no board move');
    const resumed = journal.find((e) => e.event === 'orphan-resumed-in-merge-queue');
    assert.ok(resumed);
    assert.equal(resumed.state, 'MERGE');
    assert.equal(resumed.queue, kind);
    assert.equal(resumed.mergeWaitResumes, 1);
    assert.equal(resumed.prNumber, PR);
    assert.ok(readDaemonEvents(s.journalRoot).some((e) => e.event === 'orphan-resumed-in-merge-queue' && e.id === s.id));

    // The next scan sees the entry in queue/ and leaves the task alone: no second resume, no park.
    const again = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
    assert.deepEqual(again, []);
    assert.equal(queuedFiles(s.queueDir).length, 1);
  });
}

test('orphanScan (#295) -> drainQueueOnce: probe `merged` -> the resume ends DONE through FINISH, no pr:wait, no gh pr merge, no worktree rebuilt, never INTAKE', async () => {
  const s = seedMergeOrphan({ worldOpts: { queue: 'merged' } });
  await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
  // By the wake-up GitHub reads the PR MERGED -- and has auto-deleted its branch.
  s.world.prState = 'MERGED';
  s.world.remoteBranch = false;
  const before = s.world.calls.length;

  const results = await drainQueueOnce(s.queueDir, s.journalRoot, s.config);
  assert.deepEqual(results, [{ id: s.id, finalState: 'DONE' }]);
  const wake = s.world.calls.slice(before);
  assert.equal(ghPrMerge(wake).length, 0);
  assert.equal(prWaits(wake).length, 0, 'already merged: nothing to wait for');
  assert.equal(worktreeAdds(wake).length, 0);
  assert.deepEqual(otherNpm(wake), [], 'no CHECK alias, no GATE, no claim');
  assert.ok(readJournal(s.taskDir).some((e) => e.event === 'resume-pr-already-merged'));
  assert.ok(readJournal(s.taskDir).some((e) => e.event === 'finished'));
  for (const st of statesAfter(s.taskDir, 'resumed-at-merge')) assert.ok(WAKE_STATES.has(st), `journalled under ${st}`);
  assert.equal(readState(s.taskDir).state, 'DONE');
  // FINISH did its uninterrupted-MERGE work: board Done, final comment, worktree retired.
  assert.ok(wake.some((c) => c.command === 'npm' && c.args[1] === 'board:move' && c.args.includes('Done')));
  assert.equal(ghComments(wake).length, 1);
  assert.ok(wake.some((c) => c.command === 'git' && c.args.includes('worktree') && c.args.includes('remove')));
});

test('orphanScan (#295) -> drainQueueOnce: probe `queued`, the wait lands -> DONE through FINISH; one pr:wait, no gh pr merge, no gate, no validation', async () => {
  const s = seedMergeOrphan({ worldOpts: { queue: 'queued', prWaitExit: 0 } });
  await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
  const before = s.world.calls.length;

  const results = await drainQueueOnce(s.queueDir, s.journalRoot, s.config);
  assert.deepEqual(results, [{ id: s.id, finalState: 'DONE' }]);
  const wake = s.world.calls.slice(before);
  assert.equal(ghPrMerge(wake).length, 0, 'never re-enqueued in GitHub\'s queue');
  assert.equal(prWaits(wake).length, 1);
  assert.equal(prWaits(wake)[0].cwd, s.worktreePath, 'waits from the task\'s own worktree');
  assert.deepEqual(otherNpm(wake), []);
  assert.equal(worktreeAdds(wake).length, 0);
  for (const st of statesAfter(s.taskDir, 'resumed-at-merge')) assert.ok(WAKE_STATES.has(st), `journalled under ${st}`);
  const j = readJournal(s.taskDir);
  const resumedAt = j.find((e) => e.event === 'resumed-at-merge');
  assert.equal(resumedAt.source, MERGE_WAIT_RESUME_SOURCE);
  assert.equal(resumedAt.prNumber, PR);
  assert.ok(j.some((e) => e.event === 'resume-prepared'));
  assert.ok(j.some((e) => e.event === 'pr-wait' && e.resumed === true && e.exit === 0));
  assert.ok(j.some((e) => e.event === 'finished'));
});

// ---- the loop bound -----------------------------------------------------------------------

test(`orphanScan (#295): the MERGE-wait resume count is read off task.json -- 1 -> resumed as #2; ${MERGE_WAIT_RESUME_MAX} -> parked task-orphaned-daemon-restart (budget-exhausted)`, async () => {
  assert.equal(MERGE_WAIT_RESUME_MAX, 2);
  const lineage = (n) => ({
    resume: {
      startState: 'MERGE',
      prNumber: PR,
      worktreePath: '/irrelevant',
      fromReason: 'task-orphaned-daemon-restart',
      source: MERGE_WAIT_RESUME_SOURCE,
      counters: { diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0, seenRootCauses: [], mergeWaitResumes: n },
    },
  });

  const second = seedMergeOrphan({ taskExtra: lineage(1) });
  assert.deepEqual(await orphanScan(second.queueDir, second.journalRoot, second.config, second.deps), [
    { id: second.id, resumed: 'MERGE', queue: 'queued' },
  ]);
  const { file, entry } = onlyQueued(second.queueDir);
  assert.equal(entry.resume.counters.mergeWaitResumes, 2);
  assert.equal(file, `0000-retry-t-${String(2).padStart(20, '0')}-${second.id}.json`);

  for (const [label, n] of [['exhausted', MERGE_WAIT_RESUME_MAX], ['malformed count reads as exhausted', 'x']]) {
    const third = seedMergeOrphan({ taskExtra: lineage(n) });
    const recovered = await orphanScan(third.queueDir, third.journalRoot, third.config, third.deps);
    assert.deepEqual(recovered, [{ id: third.id, reason: 'task-orphaned-daemon-restart' }], label);
    assert.deepEqual(queuedFiles(third.queueDir), [], label);
    const parked = readJournal(third.taskDir).find((e) => e.event === 'parked');
    assert.equal(parked.reason, 'task-orphaned-daemon-restart', label);
    assert.equal(parked.detail.mergeWaitResume, 'budget-exhausted', label);
    assert.equal(parked.detail.mergeWaitResumes, MERGE_WAIT_RESUME_MAX, label);
    assert.equal(readState(third.taskDir).state, 'PARKED', label);
  }
});

test('orphanScan (#295): a resumed run that orphans again, twice, ends parked -- the resume cannot loop', async () => {
  const s = seedMergeOrphan();
  // Rounds 1..MAX: resumed. Between rounds the wake-up is "taken" (the queue file renamed over
  // task.json, as takeNextTask does) and dies in MERGE again, leaving a MERGE state.json behind.
  for (let round = 1; round <= MERGE_WAIT_RESUME_MAX; round++) {
    const recovered = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
    assert.deepEqual(recovered, [{ id: s.id, resumed: 'MERGE', queue: 'queued' }], `round ${round}`);
    const { file } = onlyQueued(s.queueDir);
    fs.renameSync(path.join(s.queueDir, file), path.join(s.taskDir, 'task.json'));
    writeState(s.taskDir, { ...readState(s.taskDir), updatedAt: new Date(Date.now() - 10_000).toISOString() });
  }
  const last = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
  assert.deepEqual(last, [{ id: s.id, reason: 'task-orphaned-daemon-restart' }]);
  assert.equal(readJournal(s.taskDir).filter((e) => e.event === 'orphan-resumed-in-merge-queue').length, MERGE_WAIT_RESUME_MAX);
});

// ---- refusals that keep today's park, and the no-answer case --------------------------------

test('orphanScan (#295): a MERGE orphan whose recorded worktree is not <pipelineWorktreesDir>/<id> is parked, not resumed (no-trusted-worktree)', async () => {
  for (const [label, worktreePath] of [['null', null], ['foreign', '/somewhere/else/issue-951']]) {
    const s = seedMergeOrphan({ stateExtra: { worktreePath } });
    const recovered = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
    assert.deepEqual(recovered, [{ id: s.id, reason: 'task-orphaned-daemon-restart' }], label);
    assert.deepEqual(queuedFiles(s.queueDir), [], label);
    assert.equal(readJournal(s.taskDir).find((e) => e.event === 'parked').detail.mergeWaitResume, 'no-trusted-worktree', label);
  }
});

test('orphanScan (#295): a queue write that fails parks the orphan as before (requeue-failed), never loses it', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores directory permissions');
    return;
  }
  const s = seedMergeOrphan();
  fs.chmodSync(s.queueDir, 0o500);
  try {
    const recovered = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
    assert.deepEqual(recovered, [{ id: s.id, reason: 'task-orphaned-daemon-restart' }]);
    assert.equal(readJournal(s.taskDir).find((e) => e.event === 'parked').detail.mergeWaitResume, 'requeue-failed');
    assert.ok(!readJournal(s.taskDir).some((e) => e.event === 'orphan-resumed-in-merge-queue'));
  } finally {
    fs.chmodSync(s.queueDir, 0o700);
  }
});

test('orphanScan (#295): no queue answer (a gh failure) keeps task-orphaned-daemon-restart, with no resume attempted', async () => {
  const s = seedMergeOrphan({ worldOpts: { queue: exitWith(1) } });
  const recovered = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
  assert.deepEqual(recovered, [{ id: s.id, reason: 'task-orphaned-daemon-restart' }]);
  assert.deepEqual(queuedFiles(s.queueDir), []);
  const parked = readJournal(s.taskDir).find((e) => e.event === 'parked');
  assert.ok(!('mergeWaitResume' in parked.detail));
});

test('orphanScan (#295): a non-MERGE orphan with a trusted worktree and a PR is never resumed', async () => {
  const s = seedMergeOrphan({ stateExtra: { state: 'VALIDATE' } });
  const recovered = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
  assert.deepEqual(recovered, [{ id: s.id, reason: 'task-orphaned-daemon-restart' }]);
  assert.deepEqual(queuedFiles(s.queueDir), []);
  assert.equal(graphqlReads(s.world.calls).length, 0);
});

test('orphanScan (#295): dry-run never resumes (and never reads the queue)', async () => {
  const s = seedMergeOrphan({ configOverrides: { dryRun: true, real: false } });
  const recovered = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps);
  assert.deepEqual(recovered, [{ id: s.id, reason: 'task-orphaned-daemon-restart', wouldRepark: true }]);
  assert.deepEqual(queuedFiles(s.queueDir), []);
  assert.equal(s.world.calls.length, 0);
});

// ---- two scans on one orphan ------------------------------------------------------------------

test('orphanScan (#295): another scan that resumed the task while this one was reading the queue -> skipped, neither resumed twice nor parked', async () => {
  const cases = {
    // Its entry is still waiting in queue/.
    'already-queued': (s) => fs.writeFileSync(path.join(s.queueDir, `0000-retry-t-${String(1).padStart(20, '0')}-${s.id}.json`), JSON.stringify({ id: s.id })),
    // Its entry was already taken: task.json now carries the new count.
    'task-changed': (s) => {
      const tj = JSON.parse(fs.readFileSync(path.join(s.taskDir, 'task.json'), 'utf8'));
      tj.resume = mergeWaitResume({ prNumber: PR, counters: { diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0, seenRootCauses: new Set() } }, s.worktreePath, 1);
      fs.writeFileSync(path.join(s.taskDir, 'task.json'), JSON.stringify(tj));
    },
    // Its run already started and wrote state.json.
    'state-changed': (s) => writeState(s.taskDir, { ...readState(s.taskDir), updatedAt: new Date().toISOString() }),
  };
  for (const [why, act] of Object.entries(cases)) {
    const s = seedMergeOrphan();
    s.world.onGraphql = () => act(s);
    const recovered = await orphanScan(s.queueDir, s.journalRoot, s.config, s.deps, null, new Set());
    assert.deepEqual(recovered, [], why);
    assert.ok(!readJournal(s.taskDir).some((e) => e.event === 'parked' || e.event === 'orphan-resumed-in-merge-queue'), why);
    assert.ok(readDaemonEvents(s.journalRoot).some((e) => e.event === 'orphan-scan-merge-resume-raced' && e.why === why), why);
    assert.equal(queuedFiles(s.queueDir).length, why === 'already-queued' ? 1 : 0, why);
  }
});

// ================================================================================================
// ---- part 2: runTask's MERGE-wait resume -----------------------------------------------------
// ================================================================================================

// The queue entry orphanScan writes, handed straight to runTask (what takeNextTask would do).
function mergeWaitTask(s) {
  const ctx = buildCtx(s.id, { id: s.id }, s.taskDir, { ...s.config, deps: {} });
  ctx.prNumber = PR;
  return {
    id: s.id,
    kind: 'card',
    issue: 951,
    title: 'Merge-wait card',
    resume: mergeWaitResume(ctx, s.worktreePath, 1),
  };
}
async function wake(s) {
  const finalState = await runTask(s.id, mergeWaitTask(s), s.taskDir, s.config);
  return { finalState, calls: s.world.calls, journal: readJournal(s.taskDir) };
}
function parkedOf(journal) {
  return journal.find((e) => e.event === 'parked');
}

test('MERGE-wait resume: pr:wait exit 4 and GitHub removed the PR -> merge-queue-removed (resumed: true); one wait, no gh pr merge', async () => {
  const s = seedMergeOrphan({ worldOpts: { prWaitExit: 4, queue: 'removed' } });
  const { finalState, calls, journal } = await wake(s);
  assert.equal(finalState, 'PARKED');
  const parked = parkedOf(journal);
  assert.equal(parked.reason, 'merge-queue-removed');
  assert.equal(parked.state, 'MERGE');
  assert.equal(parked.detail.resumed, true);
  assert.equal(parked.detail.lastExit, 4);
  assert.equal(parked.detail.removalReason, 'failed_checks');
  assert.equal(parked.detail.mergeGroupRunId, 36224411591);
  assert.equal(prWaits(calls).length, 1, 'no second wait');
  assert.equal(ghPrMerge(calls).length, 0);
  assert.deepEqual(otherNpm(calls), []);
});

test('MERGE-wait resume: pr:wait exit 4, still queued -> merge-queue-not-landing (resumed: true); no second wait, no mergeability probe, no re-gate', async () => {
  const s = seedMergeOrphan({ worldOpts: { prWaitExit: 4, queue: 'queued' } });
  const { finalState, calls, journal } = await wake(s);
  assert.equal(finalState, 'PARKED');
  const parked = parkedOf(journal);
  assert.equal(parked.reason, 'merge-queue-not-landing');
  assert.deepEqual({ lastExit: parked.detail.lastExit, resumed: parked.detail.resumed }, { lastExit: 4, resumed: true });
  assert.equal(prWaits(calls).length, 1);
  assert.equal(graphqlReads(calls).length, 1);
  assert.equal(calls.filter((c) => isGh(c, 'pr', 'view') && c.args.includes('state,mergeable,mergeStateStatus')).length, 0);
  assert.ok(!calls.some((c) => c.command === 'git' && c.args.includes('merge') && c.args.includes('origin/main')), 'no re-gate merge');
  assert.ok(!journal.some((e) => e.event === 'merge-regate'));
});

test('MERGE-wait resume: pr:wait exit 4 but the queue read says merged -> DONE through FINISH', async () => {
  const s = seedMergeOrphan({ worldOpts: { prWaitExit: 4, queue: 'merged' } });
  const { finalState, calls, journal } = await wake(s);
  assert.equal(finalState, 'DONE');
  assert.equal(prWaits(calls).length, 1);
  assert.ok(journal.some((e) => e.event === 'finished'));
});

test('MERGE-wait resume: pr:wait exit 1 (closed) and the queue read has no merge -> pr-closed-unmerged (resumed: true); exit 9 -> pr-wait-unrecognized-exit', async () => {
  const closed = seedMergeOrphan({ worldOpts: { prWaitExit: 1, queue: 'closed' } });
  const a = await wake(closed);
  assert.equal(a.finalState, 'PARKED');
  assert.equal(parkedOf(a.journal).reason, 'pr-closed-unmerged');
  assert.deepEqual({ exit: parkedOf(a.journal).detail.exit, resumed: parkedOf(a.journal).detail.resumed }, { exit: 1, resumed: true });

  const odd = seedMergeOrphan({ worldOpts: { prWaitExit: 9, queue: 'queued' } });
  const b = await wake(odd);
  assert.equal(parkedOf(b.journal).reason, 'pr-wait-unrecognized-exit');
  assert.equal(parkedOf(b.journal).detail.resumed, true);
});

test('MERGE-wait resume: the flag is one-shot -- realMerge clears it, and the next call is an ordinary MERGE that enqueues', async () => {
  const { realMerge } = require('../orchestrator/steps/scripted');
  const s = seedMergeOrphan({ worldOpts: { prWaitExit: 0 } });
  const ctx = buildCtx(s.id, { id: s.id, kind: 'card', issue: 951, worktreePath: s.worktreePath }, s.taskDir, s.config);
  assert.equal(ctx.resumeMergeWait, false, 'a fresh ctx never has it');
  ctx.prNumber = PR;
  ctx.resumeMergeWait = true;
  assert.equal(await realMerge(ctx, { spawnSync: s.world.spawnSync }), 'FINISH');
  assert.equal(ctx.resumeMergeWait, false);
  assert.equal(ghPrMerge(s.world.calls).length, 0);
  assert.equal(await realMerge(ctx, { spawnSync: s.world.spawnSync }), 'FINISH');
  assert.equal(ghPrMerge(s.world.calls).length, 1, 'the second call is an ordinary MERGE');
});

// ================================================================================================
// ---- part 3: prepareResume's refusals of a MERGE-wait descriptor -----------------------------
// ================================================================================================

test('MERGE-wait resume waking to an already-MERGED PR (branch auto-deleted) -> DONE through FINISH; no worktree built, never INTAKE, no pr:wait', async () => {
  const s = seedMergeOrphan({ worldOpts: { prState: 'MERGED', remoteBranch: false } });
  // What an orphan scan would read if this run died inside FINISH: state.json must already say
  // FINISH (not the MERGE it woke up in), exactly as an uninterrupted MERGE -> FINISH transition
  // leaves it. Read at FINISH's first spawn, its fetch in the product checkout.
  let stateDuringFinish = null;
  s.world.onSpawn = (command, argv) => {
    if (stateDuringFinish === null && command === 'git' && argv[1] === s.config.productRepo && argv.includes('fetch')) {
      stateDuringFinish = readState(s.taskDir).state;
    }
  };
  const { finalState, calls, journal } = await wake(s);
  assert.equal(finalState, 'DONE');
  assert.equal(stateDuringFinish, 'FINISH');
  const merged = journal.find((e) => e.event === 'resume-pr-already-merged');
  assert.ok(merged);
  assert.equal(merged.prNumber, PR);
  assert.equal(worktreeAdds(calls).length, 0);
  assert.equal(prWaits(calls).length, 0);
  assert.equal(ghPrMerge(calls).length, 0);
  assert.ok(!journal.some((e) => e.event === 'machine-resume-refused'));
  assert.ok(!journal.some((e) => e.event === 'parked'));
  for (const st of statesAfter(s.taskDir, 'resumed-at-merge')) assert.ok(WAKE_STATES.has(st), `journalled under ${st}`);
  const toFinish = journal.find((e) => e.event === 'transition' && e.to === 'FINISH');
  assert.equal(toFinish.state, 'MERGE');
  assert.equal(readState(s.taskDir).state, 'DONE');
  assert.equal(readState(s.taskDir).prNumber, PR);
});

// Every other refusal parks `resume-precondition-failed` at MERGE -- never the INTAKE fallback a
// pool-wait descriptor takes, and never FINISH.
const REFUSALS = [
  ['merged on ANOTHER branch', { prState: 'MERGED', headRefName: 'claude-pipe/someone-else' }, 'pr-not-open'],
  ['closed', { prState: 'CLOSED' }, 'pr-not-open'],
  ['open on another branch', { headRefName: 'claude-pipe/someone-else' }, 'pr-branch-mismatch'],
  ['a dirty tree -- refused at MERGE, never kept', { dirty: ' M src/x.ts\n' }, 'dirty-worktree'],
  ['remote branch gone on an OPEN PR', { remoteBranch: false }, 'remote-branch-missing'],
];
for (const [label, worldOpts, step] of REFUSALS) {
  test(`MERGE-wait resume refused (${label}) -> PARKED resume-precondition-failed ${step} at MERGE, never INTAKE, never FINISH`, async () => {
    const s = seedMergeOrphan({ worldOpts });
    const { finalState, calls, journal } = await wake(s);
    assert.equal(finalState, 'PARKED');
    const parked = parkedOf(journal);
    assert.equal(parked.reason, 'resume-precondition-failed');
    assert.equal(parked.detail.step, step);
    assert.equal(parked.state, 'MERGE');
    assert.equal(readState(s.taskDir).lastState, 'MERGE');
    assert.ok(!journal.some((e) => e.event === 'machine-resume-refused'));
    assert.ok(!journal.some((e) => e.event === 'finished'));
    assert.ok(!journal.some((e) => e.state === 'INTAKE' || e.state === 'WORKTREE'));
    assert.equal(worktreeAdds(calls).length, 0);
    assert.equal(prWaits(calls).length, 0);
    assert.ok(journal.some((e) => e.event === 'wip-preserve-skipped'), 'the tree is left exactly as found');
  });
}

test('MERGE-wait resume with a worktree that is gone -> parks worktree-missing at MERGE, never INTAKE', async () => {
  const s = seedMergeOrphan();
  fs.rmSync(s.worktreePath, { recursive: true, force: true });
  const { finalState, journal } = await wake(s);
  assert.equal(finalState, 'PARKED');
  assert.equal(parkedOf(journal).detail.step, 'worktree-missing');
  assert.ok(!journal.some((e) => e.event === 'machine-resume-refused'));
  assert.ok(!journal.some((e) => e.state === 'INTAKE'));
});

// ================================================================================================
// ---- part 4: descriptor validation, registration, carriedResume, the source pin --------------
// ================================================================================================

test('RESUME_START_STATES registers MERGE alongside CHECK and IMPLEMENT', () => {
  assert.deepEqual([...RESUME_START_STATES].sort(), ['CHECK', 'IMPLEMENT', 'MERGE']);
});

test('resumeValidationError: startState MERGE only on a machine MERGE-wait descriptor, and a MERGE-wait descriptor only at MERGE', () => {
  const base = { prNumber: PR, worktreePath: '/wt/issue-951', fromReason: 'task-orphaned-daemon-restart' };
  const counters = { diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0, seenRootCauses: [], mergeWaitResumes: 1 };
  assert.equal(resumeValidationError({ ...base, startState: 'MERGE', source: MERGE_WAIT_RESUME_SOURCE, counters }), null);
  // A maintainer's `continue` shape (no counters, no source), or with only one of the two marks.
  assert.equal(resumeValidationError({ ...base, startState: 'MERGE', commentId: 1 }), 'startState');
  assert.equal(resumeValidationError({ ...base, startState: 'MERGE', source: MERGE_WAIT_RESUME_SOURCE }), 'startState');
  assert.equal(resumeValidationError({ ...base, startState: 'MERGE', counters }), 'startState');
  // A pool-wait descriptor claiming MERGE.
  assert.equal(resumeValidationError({ ...base, startState: 'MERGE', source: 'pool-wait', counters }), 'startState');
  // A MERGE-wait descriptor anywhere but MERGE.
  assert.equal(resumeValidationError({ ...base, startState: 'CHECK', source: MERGE_WAIT_RESUME_SOURCE, counters }), 'startState');
  // Unchanged: a `continue` at CHECK.
  assert.equal(resumeValidationError({ ...base, startState: 'CHECK', commentId: 1 }), null);
});

test('runTask: a `continue`-shaped descriptor claiming MERGE is parked invalid-resume before anything runs -- realMerge never reached', async () => {
  const s = seedMergeOrphan();
  const task = { id: s.id, kind: 'card', issue: 951, resume: { startState: 'MERGE', prNumber: PR, worktreePath: s.worktreePath, commentId: 7, fromReason: 'merge-conflict' } };
  const finalState = await runTask(s.id, task, s.taskDir, s.config);
  assert.equal(finalState, 'PARKED');
  const parked = parkedOf(readJournal(s.taskDir));
  assert.equal(parked.reason, 'resume-precondition-failed');
  assert.deepEqual({ step: parked.detail.step, field: parked.detail.field }, { step: 'invalid-resume', field: 'startState' });
  assert.equal(prWaits(s.world.calls).length, 0);
  assert.equal(ghPrMerge(s.world.calls).length, 0);
});

test('unparkScan: a maintainer `continue` on a park a MERGE-wait resume left still writes startState CHECK, no counters, no source', async () => {
  const journalRoot = mkTmp('spo-mwr-journal-');
  const queueDir = mkTmp('spo-mwr-queue-');
  const pipelineWorktreesDir = mkTmp('spo-mwr-worktrees-');
  const id = 'issue-952';
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, kind: 'card', issue: 952 }));
  fs.writeFileSync(
    path.join(taskDir, 'journal.jsonl'),
    JSON.stringify({ ts: '2026-09-27T00:00:00.000Z', state: 'MERGE', event: 'park-comment', commentId: 100 }) + '\n'
  );
  writeState(taskDir, { id, state: 'PARKED', lastState: 'MERGE', reason: 'resume-precondition-failed', prNumber: PR, worktreePath: path.join(pipelineWorktreesDir, id) });
  const config = testConfig(pipelineWorktreesDir);
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).includes('/comments')) {
        return ok(JSON.stringify([{ id: 105, user: { login: 'Crazz-E' }, created_at: '2026-09-27T01:00:00Z', body: 'continue' }]));
      }
      if (command === 'gh' && args[0] === 'api' && String(args[1]).includes('/collaborators/')) return ok(JSON.stringify({ permission: 'admin' }));
      return ok('');
    },
  };
  await unparkScan(queueDir, journalRoot, config, deps);
  const { entry } = onlyQueued(queueDir);
  assert.equal(entry.resume.startState, 'CHECK');
  assert.ok(!('counters' in entry.resume));
  assert.ok(!('source' in entry.resume));
});

test('carriedResume: a MERGE-wait lineage re-enqueued from MERGE or FINISH stays at MERGE with its count; a `continue` from MERGE still goes to CHECK', () => {
  const taskDir = mkTmp('spo-mwr-carried-');
  const config = testConfig(mkTmp('spo-mwr-worktrees-'));
  for (const lastState of ['MERGE', 'FINISH']) {
    const ctx = buildCtx('issue-951', { id: 'issue-951' }, taskDir, config);
    ctx.prNumber = PR;
    ctx.counters.validateRejects = 2;
    ctx.task.resume = mergeWaitResume(ctx, '/wt/issue-951', 2);
    const { resume } = carriedResume(ctx, lastState);
    assert.equal(resume.startState, 'MERGE', lastState);
    assert.equal(resume.source, MERGE_WAIT_RESUME_SOURCE, lastState);
    assert.equal(resume.counters.mergeWaitResumes, 2, `${lastState}: a re-enqueue is not a new orphan resume`);
    assert.equal(resume.counters.validateRejects, 2, lastState);
    assert.equal(resumeValidationError(resume), null, lastState);
  }
  const ctx = buildCtx('issue-951', { id: 'issue-951' }, taskDir, config);
  ctx.prNumber = PR;
  ctx.task.resume = { startState: 'CHECK', prNumber: PR, worktreePath: '/wt/issue-951', commentId: 1, fromReason: 'merge-conflict' };
  assert.equal(carriedResume(ctx, 'MERGE').resume.startState, 'CHECK');
});

test('source pin: the MERGE-wait leg reads the queue once and spawns nothing of its own; realMerge hands it the w1 exit exactly once', () => {
  const source = fs.readFileSync(require.resolve('../orchestrator/steps/scripted.js'), 'utf8');
  const start = source.indexOf('function settleResumedMergeWait(');
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.equal(body.split('probeMergeQueue(').length - 1, 1);
  assert.equal(body.split('spawnStep(').length - 1, 0, 'a spawn here would need config.js\'s MERGE derivation updated');
  const realMergeBody = source.slice(source.indexOf('async function realMerge('), source.indexOf('// ---- FINISH ----'));
  assert.equal(realMergeBody.split('settleResumedMergeWait(').length - 1, 1);
  // The resumed call goes straight to the w1 site: the enqueue is the only thing it skips.
  assert.match(realMergeBody, /if \(!resumedWait\) \{\s*const enqueue = spawnStep\(ctx, deps, 'MERGE', 'gh'/);
});
