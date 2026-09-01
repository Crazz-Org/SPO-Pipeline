'use strict';
// Unit tests for orchestrator/steps/scripted.js's real-mode per-state functions (realWorktree,
// realCheck, realPushPr, realGate, realCiChecks, realMerge, realFinish) and state-machine.js's
// --real gating on kind: "card" tasks. Every spawn here is a fake injected via deps.spawnSync
// (same convention as steps/llm.js's invokeClaudeReal) -- this file never touches a real git,
// npm, gh or claude binary, and every fs path used is a fs.mkdtempSync(os.tmpdir()) directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator requires directly below.
// This file was one of the two that measurably still leaked a handful of real spawns despite
// being "every spawn here is a fake" by convention (see the two HANDLERS.DIAGNOSE/VALIDATE(ctx2)
// fixes below) -- this require is the backstop for the next one.
require('./no-real-spawn');

const {
  realWorktree,
  realCheck,
  realPushPr,
  realGate,
  realCiChecks,
  realMerge,
  realFinish,
  preserveWorktreeWip,
  prepareJudgeInputs,
  spawnStep,
  classifyCommand,
  finalComment,
} = require('../orchestrator/steps/scripted');
const { HANDLERS, buildCtx, runTask } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { appendEvent } = require('../orchestrator/journal');
const { runLlm } = require('../orchestrator/steps/llm');
const { formatAttemptLines, formatDuration } = require('../orchestrator/task-summary');
const { diffPath, gateLogPath, gateReportPath } = require('../orchestrator/task-values');
const { buildBaseline } = require('../orchestrator/invariants');
const { writePoolDir } = require('./helpers');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

// action 2.1 -- what Node's real spawnSync actually returns when its own `timeout` option kills
// the child: BOTH `signal` (the kill signal) AND `error` (an Error with `.code === 'ETIMEDOUT'`)
// are set, `status` is null. Mirrors steps/llm.js's invokeClaudeReal fixtures for the exact same
// shape (that file learned this the hard way on card #449).
function timeoutResult(signal = 'SIGTERM') {
  const error = new Error(`spawnSync ${signal} ETIMEDOUT`);
  error.code = 'ETIMEDOUT';
  return { status: null, stdout: '', stderr: '', signal, error };
}

// A signalled child with NO deadline armed (an operator's kill -9, an OOM kill) -- must NOT be
// mistaken for a timeout: no `error`, no ETIMEDOUT code, just a bare signal.
function killedNoDeadline(signal = 'SIGKILL') {
  return { status: null, stdout: '', stderr: '', signal, error: null };
}

// The pre-existing "unknown" case this action must not change: no signal, no error, just a null
// status (whatever produces that in practice -- action 2.1's own spec calls this out by name).
function nullStatusNoSignal() {
  return { status: null, stdout: '', stderr: '', signal: null, error: null };
}

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-real-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-real-bench-'),
    stepDeadlineMs: 30000,
    // action 1.7: realCiChecks' bounded in-flight poll -- small numbers here are fine, every
    // existing CI_CHECKS test's fake spawnSync returns a fully-concluded check-run set on the
    // very first fetch, so these never actually get exercised except by the dedicated
    // in-flight tests below (which override them further where a specific bound matters).
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    ...overrides,
  };
}

function testCtx({ id = 'card-1', task, config, taskDir } = {}) {
  return buildCtx(id, task, taskDir || mkTmp('spo-real-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

// ---- WORKTREE -------------------------------------------------------------------------------

// Fake spawnSync for a `realWorktree` run with NO leftovers at all: `worktree list --porcelain`
// reports nothing, and both `rev-parse --verify --quiet` leftover-detection calls (local branch,
// remote branch) report "not found" (a real `git rev-parse --verify --quiet` on a missing ref
// exits non-zero) -- distinguished from the pre-existing `rev-parse origin/main` call, which has
// no `--verify` flag, by checking for it explicitly.
function noLeftoversSpawnSync(calls, { originMainSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } = {}) {
  return (command, args, opts) => {
    calls.push({ command, args: [...args], cwd: opts && opts.cwd });
    if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no leftover branch, local or remote
    if (args.includes('rev-parse')) return ok(`${originMainSha}\n`);
    if (args.includes('board:take')) return ok('claimed\n');
    return ok('');
  };
}

test('realWorktree: fetch -> rev-parse -> worktree add -> npm ci -> board:take -> board:move (Planning), exact argv, sets worktreePath', async () => {
  const config = testConfig();
  const task = { id: 'card-42', kind: 'card', issue: 42, title: 'Add a widget' };
  const ctx = testCtx({ id: 'card-42', task, config });

  const calls = [];
  const deps = { spawnSync: noLeftoversSpawnSync(calls) };

  const next = await realWorktree(ctx, deps);

  assert.equal(next, 'PLAN');
  const expectedWorktreePath = path.join(config.pipelineWorktreesDir, 'card-42');
  assert.equal(ctx.task.worktreePath, expectedWorktreePath);
  assert.equal(ctx.task.branch, 'claude-pipe/card-42');

  assert.deepEqual(calls[0], { command: 'git', args: ['-C', config.productRepo, 'fetch', 'origin'], cwd: undefined });
  assert.deepEqual(calls[1], {
    command: 'git',
    args: ['-C', config.productRepo, 'rev-parse', 'origin/main'],
    cwd: undefined,
  });
  // card #424: the leftover sweep (worktree list, then local/remote branch --verify checks --
  // see sweepWorktreeLeftovers) always runs between the nightly check and the add, even when it
  // finds nothing to clean.
  assert.deepEqual(calls[2], {
    command: 'git',
    args: ['-C', config.productRepo, 'worktree', 'list', '--porcelain'],
    cwd: undefined,
  });
  assert.deepEqual(calls[3], {
    command: 'git',
    args: ['-C', config.productRepo, 'rev-parse', '--verify', '--quiet', 'refs/heads/claude-pipe/card-42'],
    cwd: undefined,
  });
  assert.deepEqual(calls[4], {
    command: 'git',
    args: ['-C', config.productRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/claude-pipe/card-42'],
    cwd: undefined,
  });
  // Nothing found -> no worktree remove/prune, no branch -D, no push --delete -- the add and
  // everything after it is byte-identical to before this fix.
  assert.deepEqual(calls[5], {
    command: 'git',
    args: ['-C', config.productRepo, 'worktree', 'add', expectedWorktreePath, '-b', 'claude-pipe/card-42', 'origin/main'],
    cwd: undefined,
  });
  assert.deepEqual(calls[6], { command: 'npm', args: ['ci'], cwd: expectedWorktreePath });
  assert.deepEqual(calls[7], {
    command: 'npm',
    args: ['run', 'board:take', '--', '42'],
    cwd: expectedWorktreePath,
  });
  // Kanban piloting: once the claim succeeds (and the worktree exists), WORKTREE moves the card
  // to "Planning" -- see orchestrator/board.js's COLUMN_BY_STATE.
  assert.deepEqual(calls[8], {
    command: 'npm',
    args: ['run', 'board:move', '--', '42', 'Planning'],
    cwd: expectedWorktreePath,
  });
  assert.equal(calls.length, 9);
  assert.ok(!calls.some((c) => c.args.includes('remove') || c.args.includes('prune') || c.args.includes('-D') || c.args.includes('--delete')));
});

test('realWorktree: nightly says main is red at the fetched origin/main sha -> PARKED before worktree add', async () => {
  const config = testConfig();
  const originMainSha = 'cafef00dcafef00dcafef00dcafef00dcafef00d';
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: originMainSha });

  const task = { id: 'card-red', kind: 'card', issue: 43 };
  const ctx = testCtx({ id: 'card-red', task, config });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push(args);
      if (args.includes('rev-parse')) return ok(`${originMainSha}\n`);
      return ok('');
    },
  };

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'nightly-main-red'
  );
  // only fetch + rev-parse ran -- worktree add never attempted
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((a) => a.includes('worktree') && a.includes('add')));
});

test('realWorktree: nightly FAIL at a DIFFERENT sha does not refuse', async () => {
  const config = testConfig();
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: 'some-older-sha' });
  const task = { id: 'card-notred', kind: 'card', issue: 44 };
  const ctx = testCtx({ id: 'card-notred', task, config });

  const deps = { spawnSync: noLeftoversSpawnSync([], { originMainSha: 'freshsha0000000000000000000000000000000' }) };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');
});

for (const [exit, reason] of [
  [3, 'claim-lost'],
  [4, 'claim-rate-limited'],
  [5, 'claim-rate-limited'],
  [6, 'claim-finished-worktree'],
  [7, 'claim-unrecognized-exit'],
]) {
  test(`realWorktree: board:take exit ${exit} -> PARKED (${reason})`, async () => {
    const config = testConfig();
    const task = { id: `card-claim-${exit}`, kind: 'card', issue: 50 + exit };
    const ctx = testCtx({ id: `card-claim-${exit}`, task, config });

    const deps = {
      spawnSync: (command, args, opts) => {
        if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no leftovers
        if (args.includes('rev-parse')) return ok('sha0000000000000000000000000000000000000\n');
        if (args.includes('board:take')) return fail(exit, 'claim failed');
        return ok('');
      },
    };

    await assert.rejects(
      () => realWorktree(ctx, deps),
      (err) => err instanceof ParkSignal && err.reason === reason
    );
  });
}

test('realWorktree: git worktree add failure -> PARKED (worktree-add-failed), npm ci/claim never run', async () => {
  const config = testConfig();
  const task = { id: 'card-addfail', kind: 'card', issue: 60 };
  const ctx = testCtx({ id: 'card-addfail', task, config });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push(args);
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no leftovers
      if (args.includes('rev-parse')) return ok('sha0000000000000000000000000000000000000\n');
      if (args.includes('worktree') && args.includes('add')) return fail(1, 'already exists');
      return ok('');
    },
  };

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'worktree-add-failed'
  );
  assert.ok(!calls.some((a) => a[0] === 'ci'));
});

// ---- WORKTREE: card #424's leftover sweep (sweepWorktreeLeftovers) ------------------------
//
// The pipeline retries a task by restarting it at INTAKE (runTask, state-machine.js), so a
// second real pass of a task parked past WORKTREE collides with the first pass's own worktree
// directory / local branch / pushed remote branch, all three living in the pipeline's own
// exclusive namespace (worktrees/<taskId>, claude-pipe/<taskId>). realWorktree now cleans its
// own leftovers there before the add. These tests build a task id + worktreePath by hand
// (instead of testCtx's usual fresh id) so the "leftover" is a real directory this test itself
// creates ahead of time, standing in for a previous pass's worktree.

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// card #385's loop: preserveWorktreeWip's commit used to run on whatever branch the worktree was
// checked out on (claude-pipe/<id>), advancing it locally -- twelve lines later,
// sweepWorktreeLeftovers' rule 2 couldn't vouch for that advanced tip and parked
// branch-unmerged-leftover on the very commit this function had just made. `checkout --detach`
// must run before `add -A`, every time, so the commit lands on no branch at all.
test('preserveWorktreeWip: detaches HEAD before add -A, so the wip commit never advances the checked-out branch', () => {
  const worktreePath = mkTmp('spo-real-detach-wt-');
  fs.writeFileSync(path.join(worktreePath, 'stray.ts'), 'uncommitted');
  const taskDir = mkTmp('spo-real-detach-taskdir-');
  const ctx = { id: 'card-detach', taskDir };

  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('status') && args.includes('--porcelain')) return ok(' M stray.ts\n');
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok('detachedsha00000000000000000000000000000\n');
      return ok('');
    },
  };

  const preserved = preserveWorktreeWip(ctx, deps, { worktreePath, reason: 'leftover', state: 'WORKTREE' });
  assert.ok(preserved && preserved.ref.startsWith('wip/card-detach-'));

  const gitCalls = calls.filter((c) => c.command === 'git');
  const detachIdx = gitCalls.findIndex((c) => c.args.includes('checkout') && c.args.includes('--detach'));
  const addIdx = gitCalls.findIndex((c) => c.args.includes('add') && c.args.includes('-A'));
  assert.ok(detachIdx !== -1, 'expected a git checkout --detach call');
  assert.ok(addIdx !== -1, 'expected a git add -A call');
  assert.ok(detachIdx < addIdx, 'checkout --detach must run before add -A');
  assert.deepEqual(gitCalls[detachIdx].args, ['-C', worktreePath, 'checkout', '--detach']);
});

test('realWorktree leftover sweep: clean worktree dir + a local branch merged into origin/main -- both removed, add proceeds, both cleanups journaled', async () => {
  const config = testConfig();
  const task = { id: 'card-retry-a', kind: 'card', issue: 424 };
  const ctx = testCtx({ id: 'card-retry-a', task, config });
  const branch = 'claude-pipe/card-retry-a';
  const worktreePath = path.join(config.pipelineWorktreesDir, 'card-retry-a');
  fs.mkdirSync(worktreePath, { recursive: true }); // stands in for a previous pass's worktree

  const localSha = 'localsha00000000000000000000000000000000';
  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('status') && args.includes('--porcelain')) return ok(''); // clean
      if (args.includes('worktree') && args.includes('list')) return ok(''); // not registered -- found via disk instead
      if (args.includes('rev-parse') && args.includes(`refs/heads/${branch}`)) return ok(`${localSha}\n`);
      if (args.includes('merge-base') && args.includes('--is-ancestor')) return ok(''); // exit 0 -> ancestor of origin/main
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no remote branch leftover
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('originmainsha00000000000000000000000000\n');
      if (args.includes('board:take')) return ok('claimed\n');
      return ok('');
    },
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  assert.ok(calls.some((c) => c.args.includes('remove') && c.args.includes(worktreePath)), 'expected worktree remove');
  assert.ok(calls.some((c) => c.args.includes('prune')), 'expected worktree prune');
  assert.ok(calls.some((c) => c.args.includes('-D') && c.args.includes(branch)), 'expected branch -D');
  assert.ok(!calls.some((c) => c.args.includes('--delete')), 'no remote branch leftover -- push --delete must not run');

  const journal = readJournal(ctx.taskDir);
  const removedEvent = journal.find((e) => e.event === 'leftover-worktree-removed');
  assert.ok(removedEvent && removedEvent.wasOnDisk === true);
  const branchEvent = journal.find((e) => e.event === 'leftover-branch-deleted');
  assert.ok(branchEvent && branchEvent.branch === branch && branchEvent.sha === localSha);

  // The add ran (this is the whole point -- the collision from card #424 is gone).
  assert.ok(calls.some((c) => c.args.includes('add') && c.args.includes(worktreePath)));
});

test('realWorktree leftover sweep: a DIRTY leftover worktree whose WIP push fails still parks worktree-dirty-leftover -- nothing is removed', async () => {
  const config = testConfig();
  const task = { id: 'card-retry-b', kind: 'card', issue: 425 };
  const ctx = testCtx({ id: 'card-retry-b', task, config });
  const worktreePath = path.join(config.pipelineWorktreesDir, 'card-retry-b');
  fs.mkdirSync(worktreePath, { recursive: true });

  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('status') && args.includes('--porcelain')) return ok(' M some-uncommitted-file.ts\n'); // dirty
      if (args.includes('worktree') && args.includes('list')) return ok('');
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no branch leftovers
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('originmainsha00000000000000000000000000\n');
      if (args.includes('push')) return fail(1, 'could not push -- no network'); // WIP preservation fails
      return ok('');
    },
  };

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'worktree-dirty-leftover'
  );

  assert.ok(!calls.some((c) => c.args.includes('remove')), 'a dirty leftover must never be removed when its WIP could not be saved');
  assert.ok(fs.existsSync(worktreePath), 'the dirty directory itself must still be on disk');
  assert.ok(!calls.some((c) => c.args.includes('worktree') && c.args.includes('add')), 'worktree add must never run past a dirty-leftover park');

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'wip-preserve-failed' && e.step === 'push'));
});

test('realWorktree leftover sweep: a DIRTY leftover worktree with a WORKING push preserves the WIP, then proceeds (no park)', async () => {
  const config = testConfig();
  const task = { id: 'card-retry-b2', kind: 'card', issue: 425 };
  const ctx = testCtx({ id: 'card-retry-b2', task, config });
  const worktreePath = path.join(config.pipelineWorktreesDir, 'card-retry-b2');
  fs.mkdirSync(worktreePath, { recursive: true });

  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('status') && args.includes('--porcelain')) return ok(' M some-uncommitted-file.ts\n'); // dirty
      if (args.includes('worktree') && args.includes('list')) return ok('');
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no branch leftovers
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok('wipsha00000000000000000000000000000000\n');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('originmainsha00000000000000000000000000\n');
      if (args.includes('board:take')) return ok('claimed\n');
      return ok(''); // add / commit / push / worktree remove / prune / worktree add -- all succeed
    },
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN'); // the sweep finished and the add proceeded -- no park

  const pushCall = calls.find((c) => c.args.includes('push') && c.args.some((a) => a.startsWith('HEAD:refs/heads/wip/')));
  assert.ok(pushCall, 'expected a push to a wip/ ref, not claude-pipe/<id>');
  assert.ok(calls.some((c) => c.args.includes('remove') && c.args.includes('--force') && c.args.includes(worktreePath)));

  const journal = readJournal(ctx.taskDir);
  const preserved = journal.find((e) => e.event === 'leftover-wip-preserved');
  assert.ok(preserved && preserved.ref && preserved.ref.startsWith(`wip/card-retry-b2-`));
  assert.equal(preserved.sha, 'wipsha00000000000000000000000000000000');
});

test('realWorktree leftover sweep: a local branch with an unpushed, unmerged tip parks branch-unmerged-leftover -- never deleted', async () => {
  const config = testConfig();
  const task = { id: 'card-retry-c', kind: 'card', issue: 426 };
  const ctx = testCtx({ id: 'card-retry-c', task, config });
  const branch = 'claude-pipe/card-retry-c';

  const localSha = 'localonlysha0000000000000000000000000000';
  const remoteSha = 'staleremotesha000000000000000000000000000'; // an older push -- not the same commit
  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('worktree') && args.includes('list')) return ok(''); // no worktree-path leftover
      if (args.includes('rev-parse') && args.includes(`refs/heads/${branch}`)) return ok(`${localSha}\n`);
      if (args.includes('merge-base') && args.includes('--is-ancestor')) return fail(1); // NOT an ancestor of main
      if (args.includes('rev-parse') && args.includes(`refs/remotes/origin/${branch}`)) return ok(`${remoteSha}\n`);
      if (args.includes('for-each-ref')) return ok(''); // no wip/<id>-* ref exists for this task
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('originmainsha00000000000000000000000000\n');
      return ok('');
    },
  };

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'branch-unmerged-leftover' &&
      err.detail.localSha === localSha &&
      err.detail.remoteSha === remoteSha
  );

  assert.ok(!calls.some((c) => c.args.includes('-D')), 'an unmerged local-only branch must never be deleted');
  assert.ok(!calls.some((c) => c.args.includes('add') && c.args.includes('worktree')), 'worktree add must never run past this park');
});

// card #385's fix: a tip the pipeline itself already saved to a durable wip/<id>-* ref
// (preserveWorktreeWip) is not a mystery local commit -- rule 2's third safety case accepts it.
test('realWorktree leftover sweep: a local branch not an ancestor of origin/main but covered by a wip/<id>-* ref is still deleted, journals coveredByWipRef', async () => {
  const config = testConfig();
  const task = { id: 'card-retry-wip', kind: 'card', issue: 428 };
  const ctx = testCtx({ id: 'card-retry-wip', task, config });
  const branch = 'claude-pipe/card-retry-wip';
  const wipRefName = 'refs/remotes/origin/wip/card-retry-wip-1735689600000';

  const localSha = 'localwipcoveredsha0000000000000000000000';
  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('worktree') && args.includes('list')) return ok(''); // no worktree-path leftover
      if (args.includes('rev-parse') && args.includes(`refs/heads/${branch}`)) return ok(`${localSha}\n`);
      if (args.includes('merge-base') && args.includes('--is-ancestor') && args.includes('origin/main')) return fail(1); // not an ancestor of main
      if (args.includes('rev-parse') && args.includes(`refs/remotes/origin/${branch}`)) return fail(1); // never pushed to its own namespace
      if (args.includes('for-each-ref')) return ok(`${wipRefName}\n`);
      if (args.includes('merge-base') && args.includes('--is-ancestor') && args.includes(wipRefName)) return ok(''); // ancestor of the wip ref -- covered
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('originmainsha00000000000000000000000000\n');
      if (args.includes('board:take')) return ok('claimed\n');
      return ok('');
    },
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  assert.ok(calls.some((c) => c.args.includes('-D') && c.args.includes(branch)), 'expected branch -D once the wip ref vouches for the tip');

  const journal = readJournal(ctx.taskDir);
  const branchEvent = journal.find((e) => e.event === 'leftover-branch-deleted');
  assert.ok(branchEvent && branchEvent.branch === branch && branchEvent.sha === localSha);
  assert.equal(branchEvent.coveredByWipRef, wipRefName);
});

test('realWorktree leftover sweep: a pushed remote branch leftover (no local branch) is deleted with push --delete, before the add', async () => {
  const config = testConfig();
  const task = { id: 'card-retry-d', kind: 'card', issue: 427 };
  const ctx = testCtx({ id: 'card-retry-d', task, config });
  const branch = 'claude-pipe/card-retry-d';

  const remoteSha = 'remotesha0000000000000000000000000000000';
  const calls = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts && opts.cwd });
      if (args.includes('worktree') && args.includes('list')) return ok(''); // no worktree-path leftover
      if (args.includes('rev-parse') && args.includes(`refs/heads/${branch}`)) return fail(1); // no local branch
      if (args.includes('rev-parse') && args.includes(`refs/remotes/origin/${branch}`)) return ok(`${remoteSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('originmainsha00000000000000000000000000\n');
      if (args.includes('board:take')) return ok('claimed\n');
      // Action 4.6: rule 3 now checks for an open PR on the branch before deleting it (see
      // sweepWorktreeLeftovers). This test is about the delete-before-add ordering, not PR
      // safety (covered by test/leftover-remote-pr.test.js) -- an empty list keeps that lookup a
      // clean "no PR", same as it would be with no `gh` calls at all before this action.
      if (command === 'gh' && args.includes('pr') && args.includes('list')) return ok('[]\n');
      return ok('');
    },
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  const deleteIdx = calls.findIndex((c) => c.args.includes('push') && c.args.includes('--delete') && c.args.includes(branch));
  const addIdx = calls.findIndex((c) => c.command === 'git' && c.args.includes('worktree') && c.args.includes('add'));
  assert.ok(deleteIdx !== -1, 'expected git push origin --delete <branch>');
  assert.ok(addIdx !== -1);
  assert.ok(deleteIdx < addIdx, 'the remote-branch cleanup must run before worktree add, not after');

  const journal = readJournal(ctx.taskDir);
  const cleanedEvent = journal.find((e) => e.event === 'remote-branch-cleaned');
  assert.ok(cleanedEvent && cleanedEvent.branch === branch && cleanedEvent.sha === remoteSha);
});

// ---- CHECK ----------------------------------------------------------------------------------

test('realCheck: typecheck fails -> DIAGNOSE, names the alias, lint/coverage never run', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-check-wt-');
  const task = { id: 'card-check1', kind: 'card', issue: 70, worktreePath };
  const ctx = testCtx({ id: 'card-check1', task, config });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push(args);
      if (args.includes('typecheck')) return fail(1);
      return ok('');
    },
  };

  const next = await realCheck(ctx, deps);
  assert.equal(next, 'DIAGNOSE');
  // Kanban piloting: CHECK moves the card to "Checks & PR" before the alias loop -- that spawn
  // is calls[0], typecheck is calls[1].
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['run', 'board:move', '--', '70', 'Checks & PR']);
  assert.deepEqual(calls[1], ['run', 'typecheck']);

  const journal = fs
    .readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const failedEvent = journal.find((e) => e.event === 'check-failed');
  assert.equal(failedEvent.alias, 'typecheck');
});

test('realCheck: lint fails after typecheck passes -> DIAGNOSE names "lint", coverage never runs', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-check-wt2-');
  const task = { id: 'card-check2', kind: 'card', issue: 71, worktreePath };
  const ctx = testCtx({ id: 'card-check2', task, config });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push(args);
      if (args.includes('lint')) return fail(2);
      return ok('');
    },
  };

  const next = await realCheck(ctx, deps);
  assert.equal(next, 'DIAGNOSE');
  // board:move, typecheck (pass), lint (fail) -- coverage:changed never spawned
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['run', 'board:move', '--', '71', 'Checks & PR']);

  const journal = fs
    .readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(journal.some((e) => e.event === 'check-failed' && e.alias === 'lint'));
});

test('realCheck: all three pass -> PUSH_PR', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-check-wt3-');
  const task = { id: 'card-check3', kind: 'card', issue: 72, worktreePath };
  const ctx = testCtx({ id: 'card-check3', task, config });

  const calls = [];
  const deps = { spawnSync: (command, args) => { calls.push(args); return ok(''); } };

  const next = await realCheck(ctx, deps);
  assert.equal(next, 'PUSH_PR');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], ['run', 'board:move', '--', '72', 'Checks & PR']);
  assert.deepEqual(calls.slice(1).map((a) => a[1]), ['typecheck', 'lint', 'coverage:changed']);
});

// ---- realCheck: invariant substring check (action 1.8) ---------------------------------------
//
// Same shape a real PLAN pass would have left behind: a journalled PLAN 'result' event carrying
// invariants_path, and a journalled 'invariants-baseline' event carrying buildBaseline's own
// return value (orchestrator/invariants.js) -- realCheck's runInvariantCheck reads both back
// exactly the way task-values.js's lastResultPayload/lastInvariantsBaseline do in production.
function invariantsBlock(id, fileSpec, quoteLines) {
  return [`## ${id}`, `File: ${fileSpec}`, '>>> QUOTE', ...quoteLines, '>>> END QUOTE', ''].join('\n');
}

function seedPlanBaseline(ctx, worktreePath, invariantsMarkdown) {
  const invariantsPath = path.join(ctx.taskDir, 'scratch', 'invariants-1.md');
  fs.mkdirSync(path.dirname(invariantsPath), { recursive: true });
  fs.writeFileSync(invariantsPath, invariantsMarkdown);
  appendEvent(ctx.taskDir, 'PLAN', 'result', { payload: { invariants_path: invariantsPath } });
  const baseline = buildBaseline(worktreePath, invariantsPath);
  appendEvent(ctx.taskDir, 'PLAN', 'invariants-baseline', baseline);
  return { invariantsPath, baseline };
}

test('realCheck: a broken invariant (quote no longer present) fails CHECK before any alias spawns, and returns DIAGNOSE', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-check-inv-broken-wt-');
  const filePath = path.join(worktreePath, 'foo.js');
  fs.writeFileSync(filePath, 'function foo() {\n  return 42;\n}\n');

  const task = { id: 'card-check-inv1', kind: 'card', issue: 80, worktreePath };
  const ctx = testCtx({ id: 'card-check-inv1', task, config });

  seedPlanBaseline(ctx, worktreePath, invariantsBlock('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}']));

  // IMPLEMENT rewrote the file after PLAN's baseline was built -- the quote is gone.
  fs.writeFileSync(filePath, 'function foo() {\n  return 99;\n}\n');

  const calls = [];
  const deps = { spawnSync: (command, args) => { calls.push(args); return ok(''); } };

  const next = await realCheck(ctx, deps);
  assert.equal(next, 'DIAGNOSE');
  // Only the kanban board:move spawn happens -- typecheck/lint/coverage never run once the
  // (spawn-free) invariant check has already failed the visit.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['run', 'board:move', '--', '80', 'Checks & PR']);

  const journal = fs
    .readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const checked = journal.find((e) => e.event === 'invariants-checked');
  assert.ok(checked);
  assert.deepEqual(checked.broken, [{ id: 'INV-1', file: 'foo.js' }]);
  const failed = journal.find((e) => e.event === 'check-failed' && e.alias === 'invariants');
  assert.ok(failed);
  assert.deepEqual(failed.broken, [{ id: 'INV-1', file: 'foo.js' }]);
});

test('realCheck: an invariant baseline that still resolves does not block CHECK_ALIASES -- reaches PUSH_PR', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-check-inv-ok-wt-');
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const task = { id: 'card-check-inv2', kind: 'card', issue: 81, worktreePath };
  const ctx = testCtx({ id: 'card-check-inv2', task, config });

  seedPlanBaseline(ctx, worktreePath, invariantsBlock('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}']));

  const calls = [];
  const deps = { spawnSync: (command, args) => { calls.push(args); return ok(''); } };

  const next = await realCheck(ctx, deps);
  assert.equal(next, 'PUSH_PR');
  // board:move, typecheck, lint, coverage:changed -- the invariant check ran (pure fs, no spawn)
  // and passed, so the alias loop still runs in full.
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(1).map((a) => a[1]), ['typecheck', 'lint', 'coverage:changed']);
});

test('realCheck: an invariant that never resolved at PLAN stays excluded -- CHECK passes even though it still does not resolve', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-check-inv-excluded-wt-');
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const task = { id: 'card-check-inv3', kind: 'card', issue: 82, worktreePath };
  const ctx = testCtx({ id: 'card-check-inv3', task, config });

  seedPlanBaseline(ctx, worktreePath, invariantsBlock('INV-1', 'foo.js:99', ['this text was never in foo.js']));

  const deps = { spawnSync: () => ok('') };
  const next = await realCheck(ctx, deps);
  assert.equal(next, 'PUSH_PR');
});

test('realCheck: no PLAN baseline at all (task predates action 1.8, or PLAN never journaled one) -- invariant check is a silent no-op', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-check-inv-nobaseline-wt-');
  const task = { id: 'card-check-inv4', kind: 'card', issue: 83, worktreePath };
  const ctx = testCtx({ id: 'card-check-inv4', task, config });

  const calls = [];
  const deps = { spawnSync: (command, args) => { calls.push(args); return ok(''); } };
  const next = await realCheck(ctx, deps);
  assert.equal(next, 'PUSH_PR');

  const journal = fs
    .readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(journal.some((e) => e.event === 'invariants-checked'), false);
});

test('realCheck: the invariants file itself missing/unparsable at CHECK time -> journalled, CHECK still passes (fail-open on parse)', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-check-inv-fileGone-wt-');
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const task = { id: 'card-check-inv5', kind: 'card', issue: 84, worktreePath };
  const ctx = testCtx({ id: 'card-check-inv5', task, config });

  const { invariantsPath } = seedPlanBaseline(
    ctx,
    worktreePath,
    invariantsBlock('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}'])
  );
  // Simulate the invariants file itself having vanished by CHECK time (it never should, in
  // production, but checkRegressions must not treat this as a regression -- "we cannot know, so
  // we do not accuse").
  fs.unlinkSync(invariantsPath);

  const deps = { spawnSync: (command, args) => ok('') };
  const next = await realCheck(ctx, deps);
  assert.equal(next, 'PUSH_PR');

  const journal = fs
    .readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const checked = journal.find((e) => e.event === 'invariants-checked');
  assert.ok(checked);
  assert.equal(checked.parseError, 'invariants-file-unreadable');
  assert.deepEqual(checked.broken, []);
});

test('regression: --dry-run CHECK never runs the invariant check either', async () => {
  const taskDir = mkTmp('spo-check-inv-dryrun-taskdir-');
  const task = { id: 'card-inv-dryrun', kind: 'card', issue: 85, worktreePath: mkTmp('spo-check-inv-dryrun-wt-') };
  const ctx = buildCtx('card-inv-dryrun', task, taskDir, { shadowMode: false, dryRun: true });

  appendEvent(taskDir, 'PLAN', 'invariants-baseline', {
    parseError: null,
    invariants: [{ id: 'INV-1', file: 'foo.js', resolved: true, mode: 'exact' }],
  });

  const next = await HANDLERS.CHECK(ctx);
  assert.equal(next, 'PUSH_PR'); // --dry-run's own fixture-free "assumed success", unchanged

  const journal = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(journal.some((e) => e.event === 'invariants-checked'), false);
});

test('regression: shadow-mode CHECK never runs the invariant check, even if a PLAN invariants-baseline event exists in the journal', async () => {
  const taskDir = mkTmp('spo-check-inv-shadow-taskdir-');
  const task = { id: 'synth-inv-shadow', kind: 'synthetic' };
  const ctx = buildCtx('synth-inv-shadow', task, taskDir, { shadowMode: true, dryRun: false });

  // Hand-journalled as if a real PLAN had run earlier for this task id -- shadow mode must
  // never read it back at all.
  appendEvent(taskDir, 'PLAN', 'invariants-baseline', {
    parseError: null,
    invariants: [{ id: 'INV-1', file: 'foo.js', resolved: true, mode: 'exact' }],
  });

  const next = await HANDLERS.CHECK(ctx);
  assert.equal(next, 'PUSH_PR'); // shadow's own default-exit-0 fixture path, unchanged

  const journal = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(journal.some((e) => e.event === 'invariants-checked'), false);
});

// ---- PUSH_PR --------------------------------------------------------------------------------

test('realPushPr: parses the PR number out of the pull URL on gh pr create stdout', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-wt-');
  const task = { id: 'card-pr1', kind: 'card', issue: 80, title: 'Add a widget', worktreePath, branch: 'claude-pipe/card-pr1' };
  const ctx = testCtx({ id: 'card-pr1', task, config });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh') return ok('https://github.com/Crazz-Org/SPO-WebClient/pull/777\n');
      return ok('');
    },
  };

  const next = await realPushPr(ctx, deps);
  assert.equal(next, 'GATE');
  assert.equal(ctx.prNumber, 777);

  // card #452: `gh pr list` (the PR-reuse check) now runs before `gh pr create` and is also a
  // `gh` call this same fake stdout-URL mock happily answers -- find `pr create` specifically.
  const create = calls.find((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.deepEqual(create.args, [
    'pr',
    'create',
    '--repo',
    config.ghRepo,
    '--title',
    'Add a widget',
    '--body-file',
    path.join(ctx.taskDir, 'pr-body.md'),
    '--head',
    'claude-pipe/card-pr1',
    '--base',
    'main',
  ]);
  const commit = calls.find((c) => c.args.includes('commit'));
  assert.deepEqual(commit.args, ['-C', worktreePath, 'commit', '-F', path.join(ctx.taskDir, 'commit-message.txt')]);

  const bodyText = fs.readFileSync(path.join(ctx.taskDir, 'pr-body.md'), 'utf8');
  assert.match(bodyText, /Closes #80/);
  const messageText = fs.readFileSync(path.join(ctx.taskDir, 'commit-message.txt'), 'utf8');
  assert.match(messageText, /Closes #80/);
});

test('realPushPr: gh pr create always gets an explicit --head/--base -- gh has no cwd of its own here to infer the branch from', async () => {
  // Every other command in realPushPr targets the worktree explicitly via `git -C worktreePath`,
  // but `gh pr create` is spawned with no cwd override -- it runs from the daemon's own process
  // cwd (a git repo on `main`), not worktreePath. Without --head, gh silently resolved head ==
  // base == main and refused with "No commits between main and main (createPullRequest)" --
  // reproduced on card issue-247's 4th real pass (CHECK green, branch pushed and waiting).
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-head-wt-');
  const task = { id: 'card-pr9', kind: 'card', issue: 90, title: 't', worktreePath }; // no task.branch -> default
  const ctx = testCtx({ id: 'card-pr9', task, config });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh') return ok('https://github.com/Crazz-Org/SPO-WebClient/pull/900\n');
      return ok('');
    },
  };

  await realPushPr(ctx, deps);

  // card #452: `gh pr list` (the PR-reuse check) now runs before `gh pr create` and is also a
  // `gh` call this same fake stdout-URL mock happily answers -- find `pr create` specifically.
  const create = calls.find((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  const headIdx = create.args.indexOf('--head');
  const baseIdx = create.args.indexOf('--base');
  assert.ok(headIdx !== -1, '--head must be present');
  assert.ok(baseIdx !== -1, '--base must be present');
  assert.equal(create.args[headIdx + 1], 'claude-pipe/card-pr9'); // realPushPr's own branch default
  assert.equal(create.args[baseIdx + 1], 'main');
});

test('realPushPr: unparsable gh pr create stdout -> PARKED (push-pr-failed)', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-wt2-');
  const task = { id: 'card-pr2', kind: 'card', issue: 81, title: 't', worktreePath };
  const ctx = testCtx({ id: 'card-pr2', task, config });

  const deps = {
    spawnSync: (command) => (command === 'gh' ? ok('no url here') : ok('')),
  };

  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'push-pr-failed'
  );
});

test('realPushPr: git push failure -> PARKED (push-pr-failed), pr create never runs', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-wt3-');
  const task = { id: 'card-pr3', kind: 'card', issue: 82, title: 't', worktreePath };
  const ctx = testCtx({ id: 'card-pr3', task, config });

  let ghCalled = false;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh') ghCalled = true;
      if (args.includes('push')) return fail(1);
      return ok('');
    },
  };

  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'push-pr-failed'
  );
  assert.equal(ghCalled, false);
});

// card #385's first park: SPO-WebClient/scripts/check-pr-rules.js's required "typecheck + tests"
// check rejects any PR touching src/shared/rdo-members.ts with no `<Fichier>.pas:<Ligne>`
// citation anywhere in the PR body.
test('realPushPr: touches src/shared/rdo-members.ts with no citation in the diff or the task criterion -> PARKED (rdo-citation-missing)', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-rdo-missing-wt-');
  const task = {
    id: 'card-rdo-missing',
    kind: 'card',
    issue: 385,
    title: 't',
    worktreePath,
    criterion: 'add the new RDO member, no citation quoted here',
  };
  const ctx = testCtx({ id: 'card-rdo-missing', task, config });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('diff') && args.includes('--name-only')) return ok('src/shared/rdo-members.ts\n');
      if (args.includes('diff') && args.includes('-U0')) return ok('+  someMember: 42, // no citation on this line\n');
      return ok('');
    },
  };

  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'rdo-citation-missing' && err.detail.file === 'src/shared/rdo-members.ts'
  );
});

// The rdo-citation-missing park must land on a branch that is already pushed: a park between
// the commit and the push leaves a local-only tip over a clean worktree, which preserveWorktreeWip
// cannot save to a wip/ ref and sweepWorktreeLeftovers' rule 2 then refuses to clean -- card
// #385's branch-unmerged-leftover loop, re-created by a mis-ordered park.
test('realPushPr: pushes the branch BEFORE parking rdo-citation-missing, so the retry sweep can clean it', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-rdo-order-wt-');
  const task = { id: 'card-rdo-order', kind: 'card', issue: 385, title: 't', worktreePath, criterion: 'no citation' };
  const ctx = testCtx({ id: 'card-rdo-order', task, config });

  const argvs = [];
  const deps = {
    spawnSync: (command, args) => {
      argvs.push([command, ...args].join(' '));
      if (args.includes('diff') && args.includes('--name-only')) return ok('src/shared/rdo-members.ts\n');
      if (args.includes('diff') && args.includes('-U0')) return ok('+  someMember: 42,\n');
      return ok('');
    },
  };

  await assert.rejects(
    () => realPushPr(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'rdo-citation-missing'
  );
  const pushed = argvs.findIndex((line) => line.includes('push -u origin'));
  const diffed = argvs.findIndex((line) => line.includes('--name-only'));
  assert.ok(pushed !== -1, 'the branch must be pushed before the citation check parks');
  assert.ok(pushed < diffed, 'push must run before the rdo citation check');
});

test('realPushPr: extracts a citation from the rdo-members.ts diff, writes it into the PR body\'s "### RDO catalogue" section, rederives touchesRdoMembers', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-rdo-cited-wt-');
  const task = { id: 'card-rdo-cited', kind: 'card', issue: 386, title: 't', worktreePath, touchesRdoMembers: false };
  const ctx = testCtx({ id: 'card-rdo-cited', task, config });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('diff') && args.includes('--name-only')) return ok('src/shared/rdo-members.ts\n');
      if (args.includes('diff') && args.includes('-U0')) {
        return ok('+  // AdmMembersRDO.pas:512 -- new wire member\n+  newMember: 99,\n');
      }
      if (command === 'gh') return ok('https://github.com/Crazz-Org/SPO-WebClient/pull/386\n');
      return ok('');
    },
  };

  const next = await realPushPr(ctx, deps);
  assert.equal(next, 'GATE');
  assert.equal(ctx.task.touchesRdoMembers, true);

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'touches-rdo-members-rederived' && e.from === false && e.to === true));
  const citationEvent = journal.find((e) => e.event === 'rdo-citation');
  assert.ok(citationEvent && citationEvent.citations.some((c) => c.includes('AdmMembersRDO.pas:512')));

  // The bug this action fixes: realPushPr used to only journal the citations, never put them on
  // ctx.task, so CITATION_VERIFIER's own placeholder build (task-values.js) had nothing to read
  // and every RDO-touching card parked at prompt-missing-placeholder:citations before the
  // verifier could even spawn.
  assert.ok(ctx.task.citations.some((c) => c.includes('AdmMembersRDO.pas:512')));

  const body = fs.readFileSync(path.join(ctx.taskDir, 'pr-body.md'), 'utf8');
  assert.match(body, /### RDO catalogue/);
  assert.match(body, /AdmMembersRDO\.pas:512/);
});

test('realPushPr: sets ctx.task.citations from the criterion fallback when the diff itself carries no citation', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-rdo-criterion-wt-');
  const task = {
    id: 'card-rdo-criterion',
    kind: 'card',
    issue: 387,
    title: 't',
    worktreePath,
    touchesRdoMembers: true,
    criterion: 'Add newMember per AdmMembersRDO.pas:512',
  };
  const ctx = testCtx({ id: 'card-rdo-criterion', task, config });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('diff') && args.includes('--name-only')) return ok('src/shared/rdo-members.ts\n');
      if (args.includes('diff') && args.includes('-U0')) {
        // No `//`-commented citation in the diff itself -- forces the criterion fallback.
        return ok('+  newMember: 99,\n');
      }
      if (command === 'gh') return ok('https://github.com/Crazz-Org/SPO-WebClient/pull/387\n');
      return ok('');
    },
  };

  const next = await realPushPr(ctx, deps);
  assert.equal(next, 'GATE');

  const journal = readJournal(ctx.taskDir);
  const citationEvent = journal.find((e) => e.event === 'rdo-citation');
  assert.ok(citationEvent && citationEvent.citations.some((c) => c.includes('AdmMembersRDO.pas:512')));
  assert.ok(ctx.task.citations.some((c) => c.includes('AdmMembersRDO.pas:512')));
});

// ---- End-to-end proof: realPushPr -> CITATION_VERIFIER no longer parks -----------------------
//
// Neither --dry-run nor --shadow can demonstrate this fix through the full daemon: PUSH_PR under
// either mode goes through scripted.js's generic runScripted() fixture/stub (state-machine.js's
// isRealMode() gates realPushPr to --real only), which never runs the git-diff citation
// extraction and never journals an 'rdo-citation' event -- so a --dry-run or --shadow card can
// only reach CITATION_VERIFIER with a resolved `citations` placeholder if the input task JSON
// already carries `task.citations` verbatim, which the ORIGINAL (buggy) task-values.js already
// read straight off ctx.task. That would "pass" identically before and after this change and
// prove nothing.
//
// What genuinely depends on this fix -- realPushPr assigning ctx.task.citations, and
// task-values.js's journal fallback for a rebuilt ctx.task after a restart -- only runs in real
// mode (steps/scripted.js's realPushPr) and real mode's LLM path (steps/llm.js's runLlm, the
// same real-card path test/llm-real-card.test.js already exercises directly with a fake `claude`
// spawnSync). This test drives both, back to back, on one card: realPushPr populates
// ctx.task.citations from the rdo-members.ts diff (as card #385's real run would), and then the
// CITATION_VERIFIER call that used to throw `prompt-missing-placeholder:citations` before ever
// spawning `claude` now builds its prompt and spawns successfully. A second ctx, sharing the same
// taskDir but rebuilt with no `citations` field (simulating a daemon restart between PUSH_PR and
// VALIDATE, where ctx.task comes back from the task file with the in-memory field gone), proves
// the journal fallback keeps it working even then.
test('end-to-end: realPushPr feeds CITATION_VERIFIER, in-process and after a simulated restart via the journal fallback', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-citeverify-e2e-wt-');
  const task = {
    id: 'card-citeverify-e2e',
    kind: 'card',
    issue: 388,
    title: 'Add newMember to the RDO catalogue',
    worktreePath,
    touchesRdoMembers: false,
    size: 'S',
  };
  const ctx = testCtx({ id: 'card-citeverify-e2e', task, config });

  const gitDeps = {
    spawnSync: (command, args) => {
      if (args.includes('diff') && args.includes('--name-only')) return ok('src/shared/rdo-members.ts\n');
      if (args.includes('diff') && args.includes('-U0')) {
        return ok('+  // AdmMembersRDO.pas:512 -- new wire member\n+  newMember: 99,\n');
      }
      if (command === 'gh') return ok('https://github.com/Crazz-Org/SPO-WebClient/pull/388\n');
      return ok('');
    },
  };

  const next = await realPushPr(ctx, gitDeps);
  assert.equal(next, 'GATE');
  // The bug: before this action, ctx.task.citations was never set here, so the CITATION_VERIFIER
  // call below would throw ParkSignal('prompt-missing-placeholder:citations') the instant
  // buildPromptValues/fillPromptTemplate ran, never reaching invokeClaudeReal at all.
  assert.ok(ctx.task.citations.some((c) => c.includes('AdmMembersRDO.pas:512')));

  let seenInput = null;
  const llmDeps = {
    spawnSync: (command, argv, opts) => {
      assert.equal(command, 'claude');
      seenInput = opts.input;
      const reply = {
        result: JSON.stringify({ verdict: 'PASS', entries: [] }),
        is_error: false,
        num_turns: 1,
        session_id: 'sess-citeverify-e2e',
        modelUsage: { fable: { costUSD: 0.001 } },
        terminal_reason: 'success',
        api_error_status: null,
      };
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    },
  };

  // buildCtx() (state-machine.js) leaves ctx.account null until callLlmStep's account-rotation
  // loop sets it per-attempt; runLlm's real non-override path reads `account.name` unconditionally
  // for its own 'llm-call' journal event, so a direct runLlm call (bypassing callLlmStep, same as
  // test/llm-real-card.test.js's cardCtx convention) needs one set by hand.
  ctx.account = { name: 'default', configDir: null };

  // Same-process read: CITATION_VERIFIER's runLlm call reads ctx.task.citations directly, no
  // restart in between.
  const cv = await runLlm(ctx, 'CITATION_VERIFIER', 'llm.CITATION_VERIFIER', llmDeps);
  assert.equal(cv.ok, true);
  assert.equal(cv.verdict, 'PASS');
  assert.ok(seenInput.includes('AdmMembersRDO.pas:512'), 'expected the filled prompt to carry the citation');

  // Simulated restart: a fresh ctx sharing the same taskDir (so journal.jsonl still has the
  // 'rdo-citation' record realPushPr appended above), but ctx.task rebuilt from scratch with no
  // `citations` field at all -- exactly what a daemon restart between PUSH_PR and VALIDATE leaves
  // task-values.js to work with.
  const restartedTask = {
    id: 'card-citeverify-e2e',
    kind: 'card',
    issue: 388,
    title: 'Add newMember to the RDO catalogue',
    worktreePath,
    touchesRdoMembers: true,
    size: 'S',
  };
  const restartedCtx = testCtx({ id: 'card-citeverify-e2e', task: restartedTask, config, taskDir: ctx.taskDir });
  assert.equal(restartedCtx.task.citations, undefined);
  restartedCtx.account = { name: 'default', configDir: null };

  let seenInputAfterRestart = null;
  const llmDepsAfterRestart = {
    spawnSync: (command, argv, opts) => {
      seenInputAfterRestart = opts.input;
      const reply = {
        result: JSON.stringify({ verdict: 'PASS', entries: [] }),
        is_error: false,
        num_turns: 1,
        session_id: 'sess-citeverify-e2e-restart',
        modelUsage: { fable: { costUSD: 0.001 } },
        terminal_reason: 'success',
        api_error_status: null,
      };
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    },
  };

  const cvAfterRestart = await runLlm(restartedCtx, 'CITATION_VERIFIER', 'llm.CITATION_VERIFIER', llmDepsAfterRestart);
  assert.equal(cvAfterRestart.ok, true);
  assert.equal(cvAfterRestart.verdict, 'PASS');
  assert.ok(
    seenInputAfterRestart.includes('AdmMembersRDO.pas:512'),
    'expected the journal-fallback citations to still reach the filled prompt after a simulated restart'
  );
});

// A second PUSH_PR pass on the same branch (CI red -> DIAGNOSE -> IMPLEMENT -> CHECK -> back
// here) used to call `gh pr create` unconditionally and get refused -- "a pull request for
// branch ... already exists". `gh pr list` finding an open PR must reuse it instead.
test('realPushPr: reuses an already-open PR for this branch -- gh pr create never runs, patches the body via gh api, never gh pr edit', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-pushpr-reuse-wt-');
  const task = { id: 'card-pr-reuse', kind: 'card', issue: 452, title: 't', worktreePath, branch: 'claude-pipe/card-pr-reuse' };
  const ctx = testCtx({ id: 'card-pr-reuse', task, config });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify([{ number: 452 }]));
      return ok('');
    },
  };

  const next = await realPushPr(ctx, deps);

  assert.equal(next, 'GATE');
  assert.equal(ctx.prNumber, 452);
  assert.ok(!calls.some((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create'), 'gh pr create must never run');
  assert.ok(!calls.some((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'edit'), 'gh pr edit is in `deny` on this repo -- CLAUDE.md');

  const patchCall = calls.find((c) => c.command === 'gh' && c.args[0] === 'api');
  assert.ok(patchCall, 'expected a gh api PATCH call');
  assert.deepEqual(patchCall.args.slice(0, 4), ['api', `repos/${config.ghRepo}/pulls/452`, '-X', 'PATCH']);

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'pr-reused' && e.prNumber === 452));
});

// ---- GATE -----------------------------------------------------------------------------------

for (const [exit, nextOrReason, isPark] of [
  [0, 'CI_CHECKS', false],
  [1, 'DIAGNOSE', false],
  [2, 'gate-dirty-tree', true],
  [3, 'gate-worker-down', true],
  [4, 'gate-timeout', true],
  [9, 'gate-unrecognized-exit', true],
]) {
  test(`realGate: npm run gate exit ${exit}`, async () => {
    const config = testConfig();
    const worktreePath = mkTmp('spo-real-gate-wt-');
    const task = { id: `card-gate-${exit}`, kind: 'card', issue: 90, worktreePath };
    const ctx = testCtx({ id: `card-gate-${exit}`, task, config });
    const deps = { spawnSync: () => (exit === 0 ? ok('') : fail(exit)) };

    if (isPark) {
      await assert.rejects(
        () => realGate(ctx, deps),
        (err) => err instanceof ParkSignal && err.reason === nextOrReason
      );
    } else {
      const next = await realGate(ctx, deps);
      assert.equal(next, nextOrReason);
    }
  });
}

// ---- CI_CHECKS ------------------------------------------------------------------------------

function ciCtx(overrides = {}) {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-ci-wt-');
  const task = { id: 'card-ci', kind: 'card', issue: 100, worktreePath, ...overrides.task };
  const ctx = testCtx({ id: 'card-ci', task, config: overrides.config || config });
  return ctx;
}

// Action 4.3: `failing.name` (the check/job name, e.g. 'typecheck + tests') is no longer what
// classification runs on -- see ci-cause-table.js's header. realCiChecks now makes a SECOND
// `gh api` call, `repos/<repo>/actions/jobs/<id>` (`id` is `check_run.id`, which for a genuine
// GitHub Actions run IS the job id), and classifies on that job's failing STEP name instead.
// This test and the two after it were rewritten for that: routing on a bare check name like
// 'Lint' (with no `id`/`app` on the check run at all) now falls through to DIAGNOSE every time --
// exactly the bug this action fixes -- so a positive IMPLEMENT/PARK routing test has to supply
// `id`/`app: {slug: 'github-actions'}` on the failing check run AND stub the job-lookup response.
test('realCiChecks: extracts {name, conclusion, id, app} from gh api, looks up the failing job\'s steps, and routes step "Lint" to IMPLEMENT', async () => {
  const ctx = ciCtx();
  const headSha = 'headsha1111111111111111111111111111111';
  const jobId = 33373038192; // one of the six real failed runs action 4.3 verified this against

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (command === 'gh' && args[0] === 'api' && args[1].includes('check-runs')) {
        return ok(
          JSON.stringify({
            check_runs: [
              { name: 'analyze', conclusion: 'success' },
              { name: 'typecheck + tests', conclusion: 'failure', id: jobId, app: { slug: 'github-actions' } },
            ],
          })
        );
      }
      if (command === 'gh' && args[0] === 'api' && args[1].includes('/actions/jobs/')) {
        return ok(
          JSON.stringify({
            steps: [
              { name: 'Checkout', conclusion: 'success' },
              { name: 'Lint', conclusion: 'failure' },
              { name: 'Typecheck (server + client)', conclusion: 'skipped' },
            ],
          })
        );
      }
      return ok('');
    },
  };

  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'IMPLEMENT');

  const checkRunsCall = calls.find((c) => c.command === 'gh' && c.args[1].includes('check-runs'));
  assert.deepEqual(checkRunsCall.args, ['api', `repos/${ctx.config.ghRepo}/commits/${headSha}/check-runs`]);
  const jobCall = calls.find((c) => c.command === 'gh' && c.args[1].includes('/actions/jobs/'));
  assert.deepEqual(jobCall.args, ['api', `repos/${ctx.config.ghRepo}/actions/jobs/${jobId}`]);
});

test('realCiChecks: step "PR rules (coverage ratchet, RDO citation)" failure -> PARKED (pr-rules-needs-approval)', async () => {
  const ctx = ciCtx();
  const jobId = 33253561998;
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse')) return ok('sha\n');
      if (command === 'gh' && args[0] === 'api' && args[1].includes('check-runs')) {
        return ok(
          JSON.stringify({
            check_runs: [{ name: 'typecheck + tests', conclusion: 'failure', id: jobId, app: { slug: 'github-actions' } }],
          })
        );
      }
      if (command === 'gh' && args[0] === 'api' && args[1].includes('/actions/jobs/')) {
        return ok(JSON.stringify({ steps: [{ name: 'PR rules (coverage ratchet, RDO citation)', conclusion: 'failure' }] }));
      }
      return ok('');
    },
  };
  await assert.rejects(
    () => realCiChecks(ctx, deps),
    // The detail is asserted, not just the reason: it is the maintainer's only pointer at WHICH
    // ci.yml step demanded approval, and park-loop.js's countRepeatedParks fingerprints on
    // JSON.stringify(detail) -- so it must also stay identical in shape to the shadow-fixture
    // path's own park detail (state-machine.js's resolveShadowCiChecks) or a repeated park stops
    // being recognised as repeated.
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'pr-rules-needs-approval' &&
      err.detail.check === 'typecheck + tests' &&
      err.detail.step === 'PR rules (coverage ratchet, RDO citation)'
  );
});

// Unlike the two tests above, this one is unchanged by action 4.3: the check run here carries no
// `id`/`app` at all (same shape every check run had before this action), so the new job lookup
// never fires (see the `failing.app === 'github-actions' && typeof failing.id === 'number'`
// guard) and classification falls straight to the no-step-info branch -- DIAGNOSE, same as
// before.
test('realCiChecks: a failing check with no id/app (job lookup never fires) -> DIAGNOSE', async () => {
  const ctx = ciCtx();
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse')) return ok('sha\n');
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'Something Weird', conclusion: 'failure' }] }));
      }
      return ok('');
    },
  };
  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'DIAGNOSE');
});

test('realCiChecks: all green, no recorded baseMain verdict -> VALIDATE, no diff calls', async () => {
  const ctx = ciCtx();
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push(args);
      if (args.includes('rev-parse')) return ok('sha\n');
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      return ok('');
    },
  };
  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'VALIDATE');
  assert.ok(!calls.some((a) => a.includes('diff')));
});

test('realCiChecks: main-moved intersection non-empty -> merges origin/main, returns CHECK', async () => {
  const ctx = ciCtx();
  const headSha = 'headshaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { baseMain: 'basemainsha' });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push(args);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('freshoriginmainsha\n');
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      if (args.includes('diff') && args.includes(`basemainsha..origin/main`)) return ok('src/shared/rdo-types.ts\nsrc/other.ts\n');
      if (args.includes('diff') && args.includes('origin/main...HEAD')) return ok('src/shared/rdo-types.ts\nsrc/mine.ts\n');
      if (args.includes('merge')) return ok('');
      return ok('');
    },
  };

  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'CHECK');
  assert.equal(ctx.counters.mainMoveUsed, true);
  assert.ok(calls.some((a) => a.includes('merge') && a.includes('origin/main')));

  const journal = fs
    .readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(journal.some((e) => e.event === 'main-moved-merge'));
});

test('realCiChecks: main already moved once this task -> PARKED (main-moved-twice), no merge spawned', async () => {
  const ctx = ciCtx();
  ctx.counters.mainMoveUsed = true;
  const headSha = 'headshaBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { baseMain: 'basemainsha' });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push(args);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      if (args.includes('diff')) return ok('shared/file.ts\n');
      return ok('');
    },
  };

  await assert.rejects(
    () => realCiChecks(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'main-moved-twice'
  );
  assert.ok(!calls.some((a) => a.includes('merge')));
});

test('realCiChecks: nightly red at the fetched origin/main sha -> PARKED (main-red-no-merge)', async () => {
  const ctx = ciCtx();
  const headSha = 'headshaCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { baseMain: 'basemainsha' });
  writeJson(path.join(ctx.config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: 'redsha' });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('redsha\n');
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      if (args.includes('diff')) return ok('shared/file.ts\n');
      return ok('');
    },
  };

  await assert.rejects(
    () => realCiChecks(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'main-red-no-merge'
  );
});

// ---- CI_CHECKS: bounded in-flight wait (action 1.7) ------------------------------------------
//
// `conclusion: null` (still running) or zero check-runs (CI hasn't registered yet) must never
// read as green -- the audit measured 8/12 real "green" events with `claude review` still in
// progress. Every test here injects `deps.sleep` as a recording no-op so the suite never
// actually waits out ciChecksPollIntervalMs x ciChecksMaxPolls.

function noSleepDeps(spawnSyncFn, sleeps = []) {
  return {
    spawnSync: spawnSyncFn,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

test('realCiChecks: conclusion: null on one run -> re-polls, proceeds normally once the re-poll returns a concluded green set', async () => {
  const config = testConfig({ ciChecksMaxPolls: 4, ciChecksPollIntervalMs: 5000 });
  const ctx = ciCtx({ config });
  const headSha = 'headshaINFLIGHT1111111111111111111111111';
  let apiCalls = 0;
  const sleeps = [];
  const deps = noSleepDeps((command, args) => {
    if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
    if (command === 'gh' && args[0] === 'api') {
      apiCalls += 1;
      if (apiCalls === 1) {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: null }] }));
      }
      return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
    }
    return ok('');
  }, sleeps);

  const next = await realCiChecks(ctx, deps);

  assert.equal(next, 'VALIDATE');
  assert.equal(apiCalls, 2, 'expected the initial fetch plus exactly one re-poll');
  assert.deepEqual(sleeps, [5000], 'expected exactly one injected sleep, for the interval configured');

  const journal = readJournal(ctx.taskDir);
  assert.ok(
    journal.some((e) => e.event === 'checks-in-flight' && e.attempt === 1 && e.totalRuns === 1 && e.pendingRuns === 1),
    'expected the in-flight observation to be journalled'
  );
  assert.ok(journal.some((e) => e.event === 'checks-green'));
});

test('realCiChecks: zero check-runs registered -> same bounded in-flight wait as conclusion: null', async () => {
  const config = testConfig({ ciChecksMaxPolls: 4, ciChecksPollIntervalMs: 2000 });
  const ctx = ciCtx({ config });
  const headSha = 'headshaNOCHECKS2222222222222222222222222';
  let apiCalls = 0;
  const sleeps = [];
  const deps = noSleepDeps((command, args) => {
    if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
    if (command === 'gh' && args[0] === 'api') {
      apiCalls += 1;
      if (apiCalls === 1) return ok(JSON.stringify({ check_runs: [] }));
      return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
    }
    return ok('');
  }, sleeps);

  const next = await realCiChecks(ctx, deps);

  assert.equal(next, 'VALIDATE');
  assert.equal(apiCalls, 2);
  assert.deepEqual(sleeps, [2000]);

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'checks-in-flight' && e.attempt === 1 && e.totalRuns === 0));
});

test('realCiChecks: still in flight after the configured max polls -> PARKED ci-checks-still-running, never reaches MERGE', async () => {
  const config = testConfig({ ciChecksMaxPolls: 3, ciChecksPollIntervalMs: 1000 });
  const ctx = ciCtx({ config });
  const headSha = 'headshaNEVERGREEN33333333333333333333333';
  let apiCalls = 0;
  const sleeps = [];
  const deps = noSleepDeps((command, args) => {
    if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
    if (command === 'gh' && args[0] === 'api') {
      apiCalls += 1;
      // Always still running -- never concludes within the bound.
      return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: null }] }));
    }
    return ok('');
  }, sleeps);

  let caught = null;
  try {
    await realCiChecks(ctx, deps);
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof ParkSignal, 'expected a ParkSignal');
  assert.equal(caught.reason, 'ci-checks-still-running');
  assert.equal(apiCalls, config.ciChecksMaxPolls, 'expected exactly ciChecksMaxPolls fetches, no more');
  assert.equal(sleeps.length, config.ciChecksMaxPolls - 1, 'expected a sleep between every poll but the last');

  // Never advanced toward MERGE: no 'checks-green' event, no failing-check routing either.
  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'checks-green'));
  assert.ok(!journal.some((e) => e.event === 'check-failed'));
});

test('realCiChecks: a genuinely failing check still routes through the cause table exactly as before, even after an in-flight re-poll (action 4.3: now via the job-step lookup, same as the non-polling test above)', async () => {
  const config = testConfig({ ciChecksMaxPolls: 4, ciChecksPollIntervalMs: 500 });
  const ctx = ciCtx({ config });
  const headSha = 'headshaFAILAFTERPOLL4444444444444444444444';
  const jobId = 33286934385;
  let checkRunsCalls = 0;
  const sleeps = [];
  const deps = noSleepDeps((command, args) => {
    if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
    if (command === 'gh' && args[0] === 'api' && args[1].includes('check-runs')) {
      checkRunsCalls += 1;
      if (checkRunsCalls === 1) {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: null }] }));
      }
      return ok(
        JSON.stringify({
          check_runs: [
            { name: 'typecheck + tests', conclusion: 'failure', id: jobId, app: { slug: 'github-actions' } },
          ],
        })
      );
    }
    if (command === 'gh' && args[0] === 'api' && args[1].includes('/actions/jobs/')) {
      return ok(JSON.stringify({ steps: [{ name: 'Lint', conclusion: 'failure' }] }));
    }
    return ok('');
  }, sleeps);

  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'IMPLEMENT'); // same "Lint" step -> IMPLEMENT routing as the non-polling test above
  assert.equal(checkRunsCalls, 2);

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'check-failed' && e.check === 'typecheck + tests' && e.step === 'Lint'));
});

test('realCiChecks: a genuinely green set on the first fetch decides green in one call, no polling (no bench verdict, so it returns VALIDATE before the main-moved test)', async () => {
  const config = testConfig({ ciChecksMaxPolls: 4, ciChecksPollIntervalMs: 999 });
  const ctx = ciCtx({ config });
  let apiCalls = 0;
  const sleeps = [];
  const deps = noSleepDeps((command, args) => {
    if (args.includes('rev-parse')) return ok('sha\n');
    if (command === 'gh' && args[0] === 'api') {
      apiCalls += 1;
      return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
    }
    return ok('');
  }, sleeps);

  const next = await realCiChecks(ctx, deps);

  assert.equal(next, 'VALIDATE');
  assert.equal(apiCalls, 1, 'a genuinely green set must resolve on the first fetch, no re-poll');
  assert.deepEqual(sleeps, [], 'no sleep should ever be invoked when nothing is in flight');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'checks-in-flight'));
});

// ---- MERGE ----------------------------------------------------------------------------------

test('realMerge: gh pr merge --merge argv never includes --delete-branch', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-merge-wt-');
  const task = { id: 'card-merge1', kind: 'card', issue: 110, worktreePath };
  const ctx = testCtx({ id: 'card-merge1', task, config });
  ctx.prNumber = 999;

  const calls = [];
  const deps = { spawnSync: (command, args) => { calls.push({ command, args: [...args] }); return ok(''); } };

  const next = await realMerge(ctx, deps);
  assert.equal(next, 'FINISH');

  const mergeCall = calls.find((c) => c.command === 'gh');
  assert.deepEqual(mergeCall.args, ['pr', 'merge', '999', '--repo', config.ghRepo, '--merge']);
  assert.ok(!mergeCall.args.includes('--delete-branch'), 'gh pr merge must never carry --delete-branch');
});

test('realMerge: pr:wait exit 4 gets exactly one bounded re-wait, then FINISH on success', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-merge-wt2-');
  const task = { id: 'card-merge2', kind: 'card', issue: 111, worktreePath };
  const ctx = testCtx({ id: 'card-merge2', task, config });
  ctx.prNumber = 222;

  let waitCalls = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('pr:wait')) {
        waitCalls += 1;
        return waitCalls === 1 ? fail(4) : ok('');
      }
      return ok('');
    },
  };

  const next = await realMerge(ctx, deps);
  assert.equal(next, 'FINISH');
  assert.equal(waitCalls, 2);
});

test('realMerge: pr:wait [4,4] -> PARKED (merge-queue-not-landing), never a third wait', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-merge-wt3-');
  const task = { id: 'card-merge3', kind: 'card', issue: 112, worktreePath };
  const ctx = testCtx({ id: 'card-merge3', task, config });
  ctx.prNumber = 333;

  let waitCalls = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('pr:wait')) {
        waitCalls += 1;
        return fail(4);
      }
      return ok('');
    },
  };

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'merge-queue-not-landing'
  );
  assert.equal(waitCalls, 2);
});

// ---- FINISH ---------------------------------------------------------------------------------

test('realFinish: board:move, then gh issue comment, then git worktree remove --force, in order; sums llm billableTokens', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-wt-');
  const task = { id: 'card-finish1', kind: 'card', issue: 120, worktreePath };
  const ctx = testCtx({ id: 'card-finish1', task, config });
  ctx.prNumber = 444;

  appendEvent(ctx.taskDir, 'PLAN', 'llm-call', { billableTokens: 1000 });
  appendEvent(ctx.taskDir, 'IMPLEMENT', 'llm-call', { billableTokens: 2500 });

  const calls = [];
  const deps = { spawnSync: (command, args) => { calls.push({ command, args: [...args] }); return ok(''); } };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE');

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { command: 'npm', args: ['run', 'board:move', '--', '120', 'Done'] });
  assert.deepEqual(calls[1], {
    command: 'gh',
    args: ['issue', 'comment', '120', '--repo', config.ghRepo, '--body-file', path.join(ctx.taskDir, 'final-comment.md')],
  });
  assert.deepEqual(calls[2], {
    command: 'git',
    args: ['-C', config.productRepo, 'worktree', 'remove', '--force', worktreePath],
  });

  const journal = fs
    .readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const finished = journal.find((e) => e.event === 'finished');
  assert.ok(finished);
  assert.equal(finished.billableTokens, 3500);
  assert.equal(finished.prNumber, 444);

  // Action 5.1a: this move must land its OWN board-move event, not just spawnStep's compact
  // {argv, exit, ms} 'spawn' line -- measured 14 of 18 corpus tasks had `Merging` as their last
  // journalled board-move while the board itself showed Done, because this event never existed
  // before. Not the shared, non-blocking board.js:moveCard vocabulary reused through that
  // module (FINISH is deliberately absent from COLUMN_BY_STATE -- see board.js's own header),
  // but the identical event shape, written directly here.
  const moved = journal.find((e) => e.event === 'board-move');
  assert.ok(moved, 'FINISH must journal its own board-move event on a successful move to Done');
  assert.equal(moved.column, 'Done');
  assert.ok(!journal.some((e) => e.event === 'board-move-failed'));
});

test('realFinish: board:move failure -> PARKED (finish-failed), worktree never removed, board-move-failed journalled BEFORE the throw', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-wt2-');
  const task = { id: 'card-finish2', kind: 'card', issue: 121, worktreePath };
  const ctx = testCtx({ id: 'card-finish2', task, config });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push(args);
      if (args.includes('board:move')) return fail(1);
      return ok('');
    },
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'finish-failed'
  );
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((a) => a.includes('remove')));

  // Action 5.1a: even on the exit that immediately throws, the attempt is on the record --
  // the journal must be able to answer "did FINISH even try to move this card" for a task that
  // never reached DONE, not just for the ones that did.
  const journal = fs
    .readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const failed = journal.find((e) => e.event === 'board-move-failed');
  assert.ok(failed, 'the failed attempt must be journalled before finish-failed is thrown');
  assert.equal(failed.column, 'Done');
  assert.equal(failed.exit, 1);
  assert.ok(!journal.some((e) => e.event === 'board-move'), 'a failed move must never journal a plain board-move too');
});

test('realFinish: the board move is journalled BEFORE the issue comment -- a park between the two must not lose the record that the card reached Done', async () => {
  // Verification found this position asserted nowhere: moving the success `board-move` event to
  // after the `gh issue comment` exit check left the whole suite green. It matters because
  // FINISH parks on a failed comment, and a card whose column really did reach `Done` with no
  // journal line saying so is precisely the divergence action 5.1a exists to end -- 14 of the 18
  // tasks in the corpus were in that state for want of one event.
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-wt3-');
  const task = { id: 'card-finish3', kind: 'card', issue: 122, worktreePath };
  const ctx = testCtx({ id: 'card-finish3', task, config });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('board:move')) return ok('');
      if (args.includes('comment')) return fail(1);
      return ok('');
    },
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'finish-failed' && err.detail.step === 'issue-comment'
  );

  const journal = fs
    .readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const moved = journal.find((e) => e.event === 'board-move');
  assert.ok(moved, 'the successful move to Done must already be journalled when the comment parks');
  assert.equal(moved.column, 'Done');
});

// ---- finalComment (action 5.2: billable tokens, pipeline duration, attempt counts) ------------
//
// Every case below builds a bare ctx-shaped object ({id, taskDir, prNumber}) and calls
// finalComment directly -- it only ever reads ctx.id/ctx.prNumber/ctx.taskDir, same convention as
// buildParkComment's own direct-call tests in test/park-loop.test.js.

test('finalComment: real token data renders the summed billable count, formatted', () => {
  const taskDir = mkTmp('spo-final-comment-tokens-');
  appendEvent(taskDir, 'PLAN', 'llm-call', { billableTokens: 150000 });
  appendEvent(taskDir, 'IMPLEMENT', 'llm-call', { billableTokens: 44424 });

  const body = finalComment({ id: 'card-fc1', taskDir, prNumber: 471 });

  // 150000 + 44424 = 194424 -- formatTokenCount renders it as "194.4k".
  assert.match(body, /Billable-weighted tokens: 194\.4k/);
  assert.ok(!body.includes('not recorded'));
});

test('finalComment: a token-less journal (only the retired costUsd, no billableTokens field) says "not recorded", never "0"', () => {
  const taskDir = mkTmp('spo-final-comment-no-tokens-');
  appendEvent(taskDir, 'PLAN', 'llm-call', { costUsd: 1.23, numTurns: 4 });
  appendEvent(taskDir, 'IMPLEMENT', 'llm-call', { costUsd: 0.87, numTurns: 2 });

  const body = finalComment({ id: 'card-fc2', taskDir, prNumber: 213 });

  assert.match(body, /Billable-weighted tokens: not recorded/);
  assert.ok(!/Billable-weighted tokens: 0\b/.test(body), 'must never render a bare 0 for untracked tokens');
});

test('finalComment: a journal whose single llm-call genuinely carries billableTokens: 0 still renders 0, not "not recorded"', () => {
  const taskDir = mkTmp('spo-final-comment-genuine-zero-');
  appendEvent(taskDir, 'PLAN', 'llm-call', { billableTokens: 0 });

  const body = finalComment({ id: 'card-fc3', taskDir, prNumber: 1 });

  assert.match(body, /Billable-weighted tokens: 0\b/);
  assert.ok(!body.includes('not recorded'));
});

test('finalComment: duration renders from the task\'s first journal event to now, labelled as pipeline time', () => {
  const taskDir = mkTmp('spo-final-comment-duration-');
  // Written directly (not via appendEvent, which always stamps the real clock) so the gap is
  // exact and reproducible -- same fixture technique test/tokens.test.js's seedTaskJournal uses.
  // 06:21:42Z -> 06:36:54Z is issue-471's own measured span, 15m12s.
  const firstTs = '2026-08-31T06:21:42.000Z';
  const lines = [
    JSON.stringify({ ts: firstTs, state: 'WORKTREE', event: 'board-move', column: 'Planning' }),
    JSON.stringify({ ts: '2026-08-31T06:25:00.000Z', state: 'PLAN', event: 'llm-call', billableTokens: 1000 }),
  ];
  fs.writeFileSync(path.join(taskDir, 'journal.jsonl'), lines.join('\n') + '\n');

  const nowMs = Date.parse('2026-08-31T06:36:54.000Z'); // firstTs + 15m12s exactly
  const body = finalComment({ id: 'card-fc4', taskDir, prNumber: 471 }, { now: nowMs });

  assert.match(body, /Elapsed \(first journal event to now\): 15m12s/);
  // No dollar figure: costUsd is retired as a metric (2026-08-31) and 107 of the corpus's 110
  // llm-call events still carry one, so rendering it is always one line of code away.
  assert.ok(!/\$\s*\d/.test(body), 'a Done comment must never render a dollar figure');
  // A card that never parked gets no parked line at all -- the second number exists to stop the
  // first one from lying, and on a clean card there is nothing to correct.
  assert.ok(!body.includes('parked waiting for a maintainer'));
});

test('finalComment: an empty/unreadable journal renders no duration line at all (never "NaNm NaNs")', () => {
  const taskDir = mkTmp('spo-final-comment-no-journal-');
  // No journal.jsonl written at all.
  const body = finalComment({ id: 'card-fc5', taskDir, prNumber: 9 }, { now: Date.now() });

  assert.ok(!body.includes('Elapsed'));
  assert.ok(!body.includes('NaN'));
});

test('finalComment: a clean card (no diagnose/validate/ci-retry events) shows no Attempts section at all', () => {
  const taskDir = mkTmp('spo-final-comment-clean-');
  appendEvent(taskDir, 'PLAN', 'llm-call', { billableTokens: 500 });

  const body = finalComment({ id: 'card-fc6', taskDir, prNumber: 5 });

  assert.ok(!body.includes('Attempts:'), 'a card that went straight through must not be padded with a row of zeroes');
});

test('finalComment: diagnose attempts and validate rejects each render their own row when present', () => {
  const taskDir = mkTmp('spo-final-comment-attempts-');
  appendEvent(taskDir, 'DIAGNOSE', 'result', { attempt: 1, payload: { rootCause: 'x' } });
  appendEvent(taskDir, 'DIAGNOSE', 'result', { attempt: 2, payload: { rootCause: 'y' } });
  // The verdict event is what a validate reject is counted from -- a bare VALIDATE 'result' line
  // counts for nothing (measured: that rule found zero rejects across all 19 real journals,
  // including the only card that was ever rejected). Both are written here; only the first counts.
  appendEvent(taskDir, 'VALIDATE', 'change-validator', { verdict: 'REJECT' });
  appendEvent(taskDir, 'VALIDATE', 'result', { attempt: 1, payload: { reasons: ['z'] } });

  const body = finalComment({ id: 'card-fc7', taskDir, prNumber: 7 });

  assert.match(body, /Attempts:/);
  assert.match(body, /- DIAGNOSE attempts: 2/);
  assert.match(body, /- VALIDATE rejects: 1/);
  assert.ok(!body.includes('CI-triggered IMPLEMENT retries'), 'no ci-implement-retry events -- no row for it');
});

test('finalComment: cumulative across a retry -- the SAME taskDir/journal.jsonl carries an earlier attempt\'s DIAGNOSE result too', () => {
  const taskDir = mkTmp('spo-final-comment-cumulative-');
  // Simulates a card that parked once after one DIAGNOSE attempt, was retried (same taskDir --
  // park-loop.js's reEnqueueTask never creates a new one), and diagnosed twice more before
  // finally reaching FINISH.
  appendEvent(taskDir, 'DIAGNOSE', 'result', { attempt: 1, payload: { rootCause: 'first-run-cause' } });
  appendEvent(taskDir, 'PARKED', 'parked', { reason: 'diagnose-duplicate-root-cause', detail: {} });
  appendEvent(taskDir, 'DIAGNOSE', 'result', { attempt: 1, payload: { rootCause: 'second-run-cause-a' } });
  appendEvent(taskDir, 'DIAGNOSE', 'result', { attempt: 2, payload: { rootCause: 'second-run-cause-b' } });

  const body = finalComment({ id: 'card-fc8', taskDir, prNumber: 8 });

  assert.match(body, /- DIAGNOSE attempts: 3/, 'the total must span both runs, not just the last one');
});

// formatAttemptLines is exported straight off task-summary.js and used by both finalComment and
// buildParkComment -- pinned here directly, no fs, no ctx at all (errata 4's own null case).
test('formatAttemptLines: a null ciImplementRetries renders no row (never "0")', () => {
  const lines = formatAttemptLines({ diagnoseAttempts: 2, validateRejects: 0, ciImplementRetries: null });
  assert.deepEqual(lines, ['- DIAGNOSE attempts: 2']);
});

test('formatAttemptLines: a genuine 0 across the board renders no rows at all', () => {
  const lines = formatAttemptLines({ diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0 });
  assert.deepEqual(lines, []);
});

test('formatDuration: hours present -> zero-padded minutes/seconds; hours absent -> unpadded minutes, padded seconds', () => {
  assert.equal(formatDuration(15 * 60000 + 12000), '15m12s'); // issue-471
  assert.equal(formatDuration(2 * 3600000 + 48000), '2h00m48s'); // issue-213
  assert.equal(formatDuration(94 * 60000 + 21000), '1h34m21s'); // issue-452
  assert.equal(formatDuration(-1), null);
  assert.equal(formatDuration(NaN), null);
});

test('finalComment: a malformed journal.jsonl never throws -- FINISH must not fail over a journal read', () => {
  const taskDir = mkTmp('spo-final-comment-malformed-');
  fs.writeFileSync(path.join(taskDir, 'journal.jsonl'), '{not json at all\n{"ts": "bad", incomplete');

  assert.doesNotThrow(() => finalComment({ id: 'card-fc9', taskDir, prNumber: 3 }));
  const body = finalComment({ id: 'card-fc9', taskDir, prNumber: 3 });
  assert.match(body, /Billable-weighted tokens: not recorded/);
});

// ---- --real gating (state-machine.js's handleIntake) -----------------------------------------
// HANDLERS.INTAKE never spawns anything itself -- safe to drive directly even in "real" config,
// unlike runTask()/drainQueueOnce(), which would proceed into WORKTREE and actually spawn.

test('--real gating: a kind:"card" task in real mode without config.real -> PARKED (real-flag-required)', async () => {
  const taskDir = mkTmp('spo-real-gate-taskdir-');
  const task = { id: 'card-gate1', kind: 'card', issue: 130, title: 't' };
  const ctx = buildCtx('card-gate1', task, taskDir, { shadowMode: false, dryRun: false, real: false });

  await assert.rejects(
    () => HANDLERS.INTAKE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'real-flag-required'
  );
});

test('--real gating: a kind:"card" task in real mode WITH config.real -> proceeds to WORKTREE', async () => {
  const taskDir = mkTmp('spo-real-gate-taskdir2-');
  const task = { id: 'card-gate2', kind: 'card', issue: 131, title: 't' };
  const ctx = buildCtx('card-gate2', task, taskDir, { shadowMode: false, dryRun: false, real: true });

  const next = await HANDLERS.INTAKE(ctx);
  assert.equal(next, 'WORKTREE');
});

test('--real gating: a non-card (synthetic) task in real mode is never gated by --real', async () => {
  const taskDir = mkTmp('spo-real-gate-taskdir3-');
  const task = { id: 'synthetic-1', kind: 'synthetic', title: 't' };
  const ctx = buildCtx('synthetic-1', task, taskDir, { shadowMode: false, dryRun: false, real: false });

  const next = await HANDLERS.INTAKE(ctx);
  assert.equal(next, 'WORKTREE');
});

test('--real gating: --dry-run bypasses the gate even for a card task with no config.real', async () => {
  const taskDir = mkTmp('spo-real-gate-taskdir4-');
  const task = { id: 'card-gate4', kind: 'card', issue: 132, title: 't' };
  const ctx = buildCtx('card-gate4', task, taskDir, { shadowMode: false, dryRun: true, real: false });

  const next = await HANDLERS.INTAKE(ctx);
  assert.equal(next, 'WORKTREE');
});

// ---- full WORKTREE -> FINISH argv walkthrough (fake runner, one fictional card) -------------

test('full lifecycle walkthrough: WORKTREE -> CHECK -> PUSH_PR -> GATE -> CI_CHECKS -> MERGE -> FINISH, one fictional card', async () => {
  const config = testConfig();
  const taskDir = mkTmp('spo-real-walkthrough-taskdir-');
  const task = {
    id: 'card-4242',
    kind: 'card',
    issue: 4242,
    title: 'Add a status badge to the header',
    criterion: 'the header shows a status badge reflecting connection state',
    size: 'S',
  };
  const ctx = testCtx({ id: 'card-4242', task, config, taskDir });

  const headSha = 'headsha42424242424242424242424242424242';
  const log = [];
  const deps = {
    spawnSync: (command, args, opts) => {
      log.push({ command, args: [...args], cwd: opts && opts.cwd });
      // card #424's leftover sweep -- no leftovers for this fresh, never-retried task.
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('originmainsha000000000000000000000000000\n');
      if (args.includes('board:take')) return ok('claimed\n');
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return ok('Creating PR...\nhttps://github.com/Crazz-Org/SPO-WebClient/pull/4242\n');
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      return ok('');
    },
  };

  const states = [
    ['WORKTREE', realWorktree],
    ['CHECK', realCheck],
    ['PUSH_PR', realPushPr],
    ['GATE', realGate],
    ['CI_CHECKS', realCiChecks],
    ['MERGE', realMerge],
    ['FINISH', realFinish],
  ];

  const perStateArgv = [];
  for (const [label, fn] of states) {
    const before = log.length;
    // eslint-disable-next-line no-await-in-loop
    const next = await fn(ctx, deps);
    const spawned = log.slice(before).map((c) => `${c.command} ${c.args.join(' ')}`);
    perStateArgv.push(`${label}: ${spawned.join(' && ')}`);
    if (label === 'WORKTREE') assert.equal(next, 'PLAN');
    if (label === 'CHECK') assert.equal(next, 'PUSH_PR');
    if (label === 'PUSH_PR') assert.equal(next, 'GATE');
    if (label === 'GATE') assert.equal(next, 'CI_CHECKS');
    if (label === 'CI_CHECKS') assert.equal(next, 'VALIDATE');
    if (label === 'MERGE') assert.equal(next, 'FINISH');
    if (label === 'FINISH') assert.equal(next, 'DONE');
  }

  assert.equal(ctx.prNumber, 4242);
  assert.equal(ctx.task.worktreePath, path.join(config.pipelineWorktreesDir, 'card-4242'));

  // Printed for human inspection -- this is the "one line per state" argv sequence.
  console.log('\n--- WORKTREE -> FINISH argv sequence (fictional card-4242) ---');
  for (const line of perStateArgv) console.log(line);
});

// ---- action 1.3: judge inputs -- diff.patch / gate.log / gate-report.md --------------------
//
// task-values.js declares diff_path/gate_log_path/gate_report_path but, before this action, no
// step ever wrote the files at those paths -- DIAGNOSE and VALIDATE judged against files that
// did not exist. steps/scripted.js's prepareJudgeInputs is the generator, called from
// handleDiagnose/handleValidate (state-machine.js) under isRealMode(ctx); realGate (above)
// writes gate.log itself, overwriting on every real gate run.

function realShapedLlmReply(payload, overrides = {}) {
  return {
    status: 0,
    stdout: JSON.stringify({
      result: JSON.stringify(payload),
      is_error: false,
      num_turns: 1,
      session_id: 'sess-judge-inputs',
      modelUsage: { fable: { costUSD: 0.001 } },
      terminal_reason: 'success',
      api_error_status: null,
      ...overrides,
    }),
    stderr: '',
    signal: null,
  };
}

test('prepareJudgeInputs: DIAGNOSE entered from CHECK (nothing committed) -- diff.patch from plain `git diff`, no park despite no gate.log', () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-judge-check-wt-');
  const task = { id: 'card-judge-check', kind: 'card', issue: 500, worktreePath };
  const ctx = testCtx({ id: 'card-judge-check', task, config });
  ctx.cameFrom = 'CHECK'; // reachable from a CHECK failure, BEFORE any commit or push

  const sameSha = 'samesha00000000000000000000000000000000';
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${sameSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${sameSha}\n`);
      if (args.includes('status') && args.includes('--porcelain')) return ok('');
      if (args.includes('diff') && args.includes('origin/main...HEAD')) {
        throw new Error('must not diff against origin/main...HEAD -- HEAD == origin/main here');
      }
      if (args.includes('diff')) return ok('diff --git a/x.ts b/x.ts\n+hello\n');
      return ok('');
    },
  };

  // Must not throw -- the spec's "CHECK Failure -> DIAGNOSE, never PARKED" holds even with no
  // gate.log, because this DIAGNOSE was never entered from GATE.
  const result = prepareJudgeInputs(ctx, deps, { forState: 'DIAGNOSE' });
  assert.ok(result.diffProduced);
  assert.ok(!result.gateLogProduced);
  assert.ok(result.missing.includes('gate.log'));

  const plainDiffCall = calls.find((c) => c.command === 'git' && c.args.includes('diff') && c.args.length === 3);
  assert.ok(plainDiffCall, 'expected a plain `git diff` (working tree), not origin/main...HEAD');

  const content = fs.readFileSync(diffPath(ctx.taskDir), 'utf8');
  assert.match(content, /hello/);

  const journal = readJournal(ctx.taskDir);
  const prepared = journal.find((e) => e.event === 'judge-inputs-prepared');
  assert.ok(prepared && prepared.produced.includes('diff.patch') && prepared.missing.includes('gate.log'));
  assert.equal(prepared.cameFrom, 'CHECK');
});

test('prepareJudgeInputs: DIAGNOSE entered from GATE -- gate.log (written by realGate) is read, diff.patch comes from origin/main...HEAD', () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-judge-gate-wt-');
  const task = { id: 'card-judge-gate', kind: 'card', issue: 501, worktreePath };
  const ctx = testCtx({ id: 'card-judge-gate', task, config });
  ctx.cameFrom = 'GATE';

  const headSha = 'headshajudge0000000000000000000000000000';
  const mainSha = 'mainshajudge0000000000000000000000000000';

  // Simulates realGate having already run earlier in this same task attempt.
  fs.writeFileSync(gateLogPath(ctx.taskDir), 'gate run output: FAIL on typecheck\n');

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${mainSha}\n`);
      if (args.includes('status') && args.includes('--porcelain')) return ok('');
      if (args.includes('diff') && args.includes('origin/main...HEAD')) return ok('diff --git a/y.ts b/y.ts\n+committed change\n');
      if (args.includes('diff')) throw new Error('must not run a plain `git diff` -- HEAD != origin/main here');
      return ok('');
    },
  };

  const result = prepareJudgeInputs(ctx, deps, { forState: 'DIAGNOSE' });
  assert.ok(result.diffProduced);
  assert.ok(result.gateLogProduced);

  const content = fs.readFileSync(diffPath(ctx.taskDir), 'utf8');
  assert.match(content, /committed change/);

  const gateLogContent = fs.readFileSync(gateLogPath(ctx.taskDir), 'utf8');
  assert.match(gateLogContent, /FAIL on typecheck/);
});

test('prepareJudgeInputs: DIAGNOSE entered from GATE with gate.log unproducible -- parks judge-inputs-missing', () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-judge-gate-missing-wt-');
  const task = { id: 'card-judge-gate-missing', kind: 'card', issue: 502, worktreePath };
  const ctx = testCtx({ id: 'card-judge-gate-missing', task, config });
  ctx.cameFrom = 'GATE';
  // No gate.log written -- realGate never ran (or its write failed) for this attempt.

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok('shajudgemissing000000000000000000000000\n');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('shajudgemissing000000000000000000000000\n');
      if (args.includes('status') && args.includes('--porcelain')) return ok('');
      if (args.includes('diff')) return ok('');
      return ok('');
    },
  };

  assert.throws(
    () => prepareJudgeInputs(ctx, deps, { forState: 'DIAGNOSE' }),
    (err) => err instanceof ParkSignal && err.reason === 'judge-inputs-missing' && err.detail.step === 'DIAGNOSE' && err.detail.missing.includes('gate.log')
  );

  // Also exercised through the full handler, gated on isRealMode + ctx.cameFrom exactly as
  // state-machine.js's handleDiagnose wires it -- proves the wiring, not just the unit.
  // handleDiagnose reads ctx.deps (not a passed-in argument), so the same spawnSync stub above
  // has to be threaded onto ctx2 explicitly -- without it this call falls through to buildCtx's
  // `deps: (config && config.deps) || {}` default and reaches the REAL spawnSync (measured: this
  // exact call was one of test/no-real-spawn.js's two escaping-file findings).
  const ctx2 = testCtx({ id: 'card-judge-gate-missing-2', task: { ...task, id: 'card-judge-gate-missing-2' }, config });
  ctx2.cameFrom = 'GATE';
  ctx2.deps = deps;
  return assert.rejects(
    () => HANDLERS.DIAGNOSE(ctx2),
    (err) => err instanceof ParkSignal && err.reason === 'judge-inputs-missing' && err.detail.step === 'DIAGNOSE'
  );
});

test('prepareJudgeInputs: VALIDATE with a producible diff -- diff.patch exists and the subsequent LLM call proceeds', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-judge-validate-ok-wt-');
  const task = {
    id: 'card-judge-validate-ok',
    kind: 'card',
    issue: 503,
    title: 't',
    criterion: 'the thing works',
    worktreePath,
    touchesRdoMembers: false,
    size: 'S',
  };
  const ctx = testCtx({ id: 'card-judge-validate-ok', task, config });
  // VALIDATE's prompt also declares invariants_path/invariant_ids, PLAN's own output -- read
  // back via task-values.js's lastResultPayload the same way handlePlan's real 'result' event
  // would supply them. Not this action's concern (the diff is), so a minimal stand-in.
  appendEvent(ctx.taskDir, 'PLAN', 'result', {
    payload: { invariants_path: '/tmp/invariants-judge-validate-ok.md', invariant_ids: ['INV-1'] },
  });

  const headSha = 'headshavalidateok00000000000000000000000';
  const mainSha = 'mainshavalidateok00000000000000000000000';
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${mainSha}\n`);
      if (args.includes('status') && args.includes('--porcelain')) return ok('');
      if (args.includes('diff') && args.includes('origin/main...HEAD')) return ok('diff --git a/z.ts b/z.ts\n+validated change\n');
      return ok('');
    },
  };

  // Must not throw.
  const result = prepareJudgeInputs(ctx, deps, { forState: 'VALIDATE' });
  assert.ok(result.diffProduced);
  assert.ok(fs.existsSync(diffPath(ctx.taskDir)));

  // The follow-on LLM call (state-machine.js's handleValidate, same order: prepareJudgeInputs
  // before either LLM call) actually proceeds -- same direct-runLlm convention as the
  // CITATION_VERIFIER end-to-end test above, bypassing callLlmStep's account-rotation loop.
  ctx.account = { name: 'default', configDir: null };
  let claudeInvoked = false;
  const llmDeps = {
    spawnSync: (command) => {
      claudeInvoked = true;
      assert.equal(command, 'claude');
      return realShapedLlmReply({ verdict: 'PASS', reasons: ['looks fine'], findings: [] }, { session_id: 'sess-validate-ok' });
    },
  };

  const verdict = await runLlm(ctx, 'VALIDATE', 'llm.VALIDATE', llmDeps);
  assert.ok(claudeInvoked, 'expected the VALIDATE LLM call to actually spawn');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, 'PASS');
});

test('prepareJudgeInputs: VALIDATE where the diff cannot be produced -- parks judge-inputs-missing, no LLM call', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-judge-validate-missing-wt-');
  const task = { id: 'card-judge-validate-missing', kind: 'card', issue: 504, title: 't', worktreePath, touchesRdoMembers: false };
  const ctx = testCtx({ id: 'card-judge-validate-missing', task, config });

  const deps = {
    spawnSync: (command, args) => {
      // `git rev-parse HEAD` itself fails -- e.g. a corrupted/vanished worktree.
      if (args.includes('rev-parse') && args.includes('HEAD')) return fail(1, 'fatal: not a git repository');
      return ok('');
    },
  };

  assert.throws(
    () => prepareJudgeInputs(ctx, deps, { forState: 'VALIDATE' }),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'judge-inputs-missing' &&
      err.detail.step === 'VALIDATE' &&
      err.detail.missing.includes('diff.patch')
  );
  assert.ok(!fs.existsSync(diffPath(ctx.taskDir)));

  // Through the full handler too: HANDLERS.VALIDATE must park before ever reaching either LLM
  // call (citation-verifier or change-validator) -- no accounts pool is configured for this ctx
  // at all, so a real attempt to call callLlmStep would blow up on accounts.pick(), not just on
  // a park; the fact this rejects cleanly with judge-inputs-missing proves prepareJudgeInputs
  // runs, and short-circuits, before that ever happens.
  // handleValidate reads ctx.deps (not a passed-in argument) for both its moveCard('VALIDATE')
  // call and prepareJudgeInputs -- without threading the same stub onto ctx2, both fall through
  // to the REAL spawnSync (measured: this exact call produced two of test/no-real-spawn.js's
  // five escaping real spawns, a real `npm run board:move` and a real `git rev-parse HEAD`).
  const ctx2 = testCtx({ id: 'card-judge-validate-missing-2', task: { ...task, id: 'card-judge-validate-missing-2' }, config });
  ctx2.deps = deps;
  await assert.rejects(
    () => HANDLERS.VALIDATE(ctx2),
    (err) => err instanceof ParkSignal && err.reason === 'judge-inputs-missing' && err.detail.step === 'VALIDATE'
  );
});

test('realGate: overwrites gate.log on a second visit -- the file holds the LAST run only, never a concatenation', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-gate-overwrite-wt-');
  const task = { id: 'card-gate-overwrite', kind: 'card', issue: 505, worktreePath };
  const ctx = testCtx({ id: 'card-gate-overwrite', task, config });

  // Action 4.2: exit 1 now branches on the bench's own verdict for HEAD -- a FAIL that DOES
  // carry `baseMain` is a real failure (the bench had already merged origin/main before
  // building) and still routes straight to DIAGNOSE, same as before this action. Stub a HEAD
  // sha and a matching verdict file so the first (FAIL) run exercises that branch rather than
  // the no-verdict-file (`gate-non-attesting`) park this test isn't about -- it only cares about
  // gate.log's overwrite behaviour.
  // A VALID 40-char hex object name, not a readable pseudo-sha: realGate shape-checks
  // `git rev-parse HEAD`'s stdout before using it as a verdict-file key (action 4.1's
  // `HEAD`-on-stdout measurement), so a non-hex fixture would route through that guard instead of
  // the FAIL-with-baseMain branch this test means to exercise -- same answer, wrong reason.
  const headSha1 = 'a7e0be6a11e50f0e5a0d0ba5e0ffee0d0cafe0b1';
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha1}.json`), { verdict: 'FAIL', baseMain: 'somemainsha' });

  const deps1 = {
    spawnSync: (command, args) => {
      if (args.includes('gate')) return fail(1, 'FIRST RUN: gate FAIL on typecheck\n');
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha1}\n`);
      return ok('');
    },
  };
  const first = await realGate(ctx, deps1);
  assert.equal(first, 'DIAGNOSE');
  assert.match(fs.readFileSync(gateLogPath(ctx.taskDir), 'utf8'), /FIRST RUN/);

  const deps2 = {
    spawnSync: (command, args) => (args.includes('gate') ? ok('SECOND RUN: gate PASS\n') : ok('')),
  };
  const second = await realGate(ctx, deps2);
  assert.equal(second, 'CI_CHECKS');

  const finalContent = fs.readFileSync(gateLogPath(ctx.taskDir), 'utf8');
  assert.match(finalContent, /SECOND RUN/);
  assert.doesNotMatch(finalContent, /FIRST RUN/, 'gate.log must be overwritten, never accumulated');

  // logs/GATE.log (appendSpawnLog) is untouched by this fix -- it keeps accumulating across
  // every visit, unlike gate.log.
  const spawnLog = fs.readFileSync(path.join(ctx.taskDir, 'logs', 'GATE.log'), 'utf8');
  assert.match(spawnLog, /FIRST RUN/);
  assert.match(spawnLog, /SECOND RUN/);
});

test('prepareJudgeInputs: gate-report.md rendered from the bench verdict when present; absent and not fatal when it is not', () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-judge-gatereport-wt-');
  const headSha = 'headshagatereport00000000000000000000000';
  const mainSha = 'mainshagatereport00000000000000000000000';

  const diffDeps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${mainSha}\n`);
      if (args.includes('status') && args.includes('--porcelain')) return ok('');
      if (args.includes('diff') && args.includes('origin/main...HEAD')) return ok('diff --git a/g.ts b/g.ts\n+gate report test\n');
      return ok('');
    },
  };

  // -- present ------------------------------------------------------------------------------
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), {
    verdict: 'PASS',
    sha: headSha,
    baseMain: mainSha,
    summary: 'build + static + L2 drive all green.',
    findings: ['no findings'],
    extra: { note: 'kept but not a named field' },
  });

  const taskA = { id: 'card-judge-gatereport-a', kind: 'card', issue: 506, worktreePath };
  const ctxA = testCtx({ id: 'card-judge-gatereport-a', task: taskA, config });
  const resultA = prepareJudgeInputs(ctxA, diffDeps, { forState: 'VALIDATE' });
  assert.ok(resultA.gateReportProduced);
  const reportContent = fs.readFileSync(gateReportPath(ctxA.taskDir), 'utf8');
  assert.match(reportContent, /# Gate report/);
  assert.match(reportContent, /PASS/);
  assert.match(reportContent, /build \+ static \+ L2 drive all green\./);
  assert.ok(
    !reportContent.trim().startsWith('{'),
    'must be rendered markdown, not a raw JSON dump'
  );

  // -- absent -- a different task, no verdict recorded for ITS headSha ----------------------
  const otherHeadSha = 'otherheadshanoveridict0000000000000000000';
  const diffDepsNoVerdict = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${otherHeadSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${mainSha}\n`);
      if (args.includes('status') && args.includes('--porcelain')) return ok('');
      if (args.includes('diff') && args.includes('origin/main...HEAD')) return ok('diff --git a/h.ts b/h.ts\n+no verdict yet\n');
      return ok('');
    },
  };
  const taskB = { id: 'card-judge-gatereport-b', kind: 'card', issue: 507, worktreePath };
  const ctxB = testCtx({ id: 'card-judge-gatereport-b', task: taskB, config });
  const resultB = prepareJudgeInputs(ctxB, diffDepsNoVerdict, { forState: 'VALIDATE' });
  assert.ok(!resultB.gateReportProduced);
  assert.ok(!fs.existsSync(gateReportPath(ctxB.taskDir)));
  assert.ok(resultB.missing.includes('gate-report.md'));
  assert.ok(resultB.diffProduced, 'a missing gate-report.md must never block the diff/VALIDATE itself');
});

test('prepareJudgeInputs: untracked files are listed in a clearly-delimited diff.patch trailer, never inside the diff body', () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-judge-untracked-wt-');
  const task = { id: 'card-judge-untracked', kind: 'card', issue: 508, worktreePath };
  const ctx = testCtx({ id: 'card-judge-untracked', task, config });
  ctx.cameFrom = 'CHECK';

  const sameSha = 'sameshauntracked0000000000000000000000000';
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${sameSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${sameSha}\n`);
      if (args.includes('status') && args.includes('--porcelain')) {
        return ok('?? scratch/new-file.ts\n M tracked-file.ts\n?? another-new.ts\n');
      }
      if (args.includes('diff')) return ok('diff --git a/tracked-file.ts b/tracked-file.ts\n-old\n+new\n');
      return ok('');
    },
  };

  const result = prepareJudgeInputs(ctx, deps, { forState: 'DIAGNOSE' });
  assert.ok(result.diffProduced);

  const content = fs.readFileSync(diffPath(ctx.taskDir), 'utf8');
  assert.match(content, /-old/);
  assert.match(content, /\+new/);
  assert.match(content, /----- untracked/);
  assert.match(content, /\?\? scratch\/new-file\.ts/);
  assert.match(content, /\?\? another-new\.ts/);
  // the tracked, modified file must appear only in the diff body, never re-listed as untracked
  const trailerStart = content.indexOf('----- untracked');
  const trailer = content.slice(trailerStart);
  assert.doesNotMatch(trailer, /tracked-file\.ts/);
});

test('prepareJudgeInputs: an empty diff is still written (the empty-IMPLEMENT case IS a finding) and journaled as diff-empty, never treated as a failure to produce one', () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-judge-empty-wt-');
  const task = { id: 'card-judge-empty', kind: 'card', issue: 511, worktreePath };
  const ctx = testCtx({ id: 'card-judge-empty', task, config });
  ctx.cameFrom = 'IMPLEMENT'; // the empty-IMPLEMENT path -- no gate has run, worktree untouched

  const sameSha = 'sameshaempty000000000000000000000000000000';
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${sameSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${sameSha}\n`);
      if (args.includes('status') && args.includes('--porcelain')) return ok('');
      if (args.includes('diff')) return ok(''); // nothing changed -- an empty diff
      return ok('');
    },
  };

  const result = prepareJudgeInputs(ctx, deps, { forState: 'DIAGNOSE' });
  assert.ok(result.diffProduced, 'an empty diff still counts as produced -- it is itself a finding');
  assert.ok(fs.existsSync(diffPath(ctx.taskDir)));
  assert.equal(fs.readFileSync(diffPath(ctx.taskDir), 'utf8'), '');

  const journal = readJournal(ctx.taskDir);
  const emptyEvent = journal.find((e) => e.event === 'diff-empty');
  assert.ok(emptyEvent, 'expected a diff-empty event, not a silent missing-input');
  assert.equal(emptyEvent.committed, false);
});

// ---- action 1.3 regression: shadow mode and --dry-run must never attempt any of this --------

test('regression: shadow mode never writes diff.patch/gate.log/gate-report.md for DIAGNOSE or VALIDATE', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-judge-shadow-wt-');
  const taskDiag = {
    id: 'card-judge-shadow-diag',
    kind: 'synthetic',
    worktreePath,
    shadow: { llm: { DIAGNOSE: { rootCause: 'shadow-cause' } } },
  };
  const ctxDiag = buildCtx('card-judge-shadow-diag', taskDiag, mkTmp('spo-judge-shadow-diag-taskdir-'), {
    ...config,
    shadowMode: true,
  });

  const next = await HANDLERS.DIAGNOSE(ctxDiag);
  assert.equal(next, 'IMPLEMENT');
  assert.ok(!fs.existsSync(diffPath(ctxDiag.taskDir)), 'shadow mode must never write diff.patch');
  assert.ok(!fs.existsSync(gateLogPath(ctxDiag.taskDir)), 'shadow mode must never write gate.log');
  assert.ok(!fs.existsSync(gateReportPath(ctxDiag.taskDir)), 'shadow mode must never write gate-report.md');

  const taskValidate = {
    id: 'card-judge-shadow-validate',
    kind: 'synthetic',
    worktreePath,
    touchesRdoMembers: false,
    shadow: { llm: { VALIDATE: { verdict: 'PASS' } } },
  };
  const ctxValidate = buildCtx('card-judge-shadow-validate', taskValidate, mkTmp('spo-judge-shadow-validate-taskdir-'), {
    ...config,
    shadowMode: true,
  });

  const nextV = await HANDLERS.VALIDATE(ctxValidate);
  assert.equal(nextV, 'MERGE');
  assert.ok(!fs.existsSync(diffPath(ctxValidate.taskDir)), 'shadow mode must never write diff.patch for VALIDATE');
});

test('regression: --dry-run never writes diff.patch/gate.log/gate-report.md for DIAGNOSE or VALIDATE', async () => {
  const worktreePath = mkTmp('spo-judge-dryrun-wt-');
  const accountsDir = mkTmp('spo-judge-dryrun-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);
  const config = testConfig({ claudeAccountsDir: accountsDir });

  const taskDiag = { id: 'card-judge-dryrun-diag', kind: 'card', issue: 509, worktreePath };
  const ctxDiag = buildCtx('card-judge-dryrun-diag', taskDiag, mkTmp('spo-judge-dryrun-diag-taskdir-'), {
    ...config,
    shadowMode: false,
    dryRun: true,
  });

  // Action 1.5: --dry-run's canned DIAGNOSE payload is {ok: true, root_cause: null, reason:
  // '[dry-run] diagnose not performed'} (steps/llm.js's cannedDryRunPayload) -- an explicit,
  // present-but-null root_cause is diagnose.md's documented "no new cause" answer, so this now
  // parks 'diagnose-no-new-cause' instead of fabricating a cause and returning to IMPLEMENT
  // (the pre-1.5 behaviour this test used to assert). The file-writing assertions below are this
  // test's real purpose and are unaffected by which path DIAGNOSE takes.
  await assert.rejects(
    () => HANDLERS.DIAGNOSE(ctxDiag),
    (err) => err instanceof ParkSignal && err.reason === 'diagnose-no-new-cause'
  );
  assert.ok(!fs.existsSync(diffPath(ctxDiag.taskDir)), '--dry-run must never write diff.patch');
  assert.ok(!fs.existsSync(gateLogPath(ctxDiag.taskDir)), '--dry-run must never write gate.log');

  const taskValidate = {
    id: 'card-judge-dryrun-validate',
    kind: 'card',
    issue: 510,
    criterion: 'the thing works',
    worktreePath,
    touchesRdoMembers: false,
  };
  const ctxValidate = buildCtx('card-judge-dryrun-validate', taskValidate, mkTmp('spo-judge-dryrun-validate-taskdir-'), {
    ...config,
    shadowMode: false,
    dryRun: true,
  });
  // Same PLAN-output stand-in as the "producible diff" test above -- VALIDATE's prompt also
  // declares invariants_path/invariant_ids.
  appendEvent(ctxValidate.taskDir, 'PLAN', 'result', {
    payload: { invariants_path: '/tmp/invariants-judge-dryrun.md', invariant_ids: ['INV-1'] },
  });

  const nextV = await HANDLERS.VALIDATE(ctxValidate);
  assert.equal(nextV, 'MERGE');
  assert.ok(!fs.existsSync(diffPath(ctxValidate.taskDir)), '--dry-run must never write diff.patch for VALIDATE');
});

// ---- action 1.3: runTask's own cameFrom threading ------------------------------------------
//
// Every prepareJudgeInputs test above sets ctx.cameFrom by hand, which proves the RULE but not
// the WIRING -- and the wiring is the fragile half. `ctx.cameFrom = state` sits one line before
// `state = next` in runTask's loop; writing `next` there instead (the off-by-one) would make
// every DIAGNOSE report itself as its own cameFrom, and hardcoding 'GATE' would make a DIAGNOSE
// entered from a CHECK failure demand a gate.log that never existed -- the exact
// "CHECK Failure -> DIAGNOSE, never PARKED" violation this action exists to prevent. Neither
// mistake is observable from a hand-set ctx, so these two run the real loop (shadow mode: no
// spawns, prepareJudgeInputs itself never called) with every handler wrapped to record the
// cameFrom it was actually handed.

// Wraps every HANDLERS entry to record {state, cameFrom} on entry, runs fn, restores. The
// wrappers delegate to the untouched originals, so the state machine behaves exactly as it
// would without them.
async function recordCameFrom(fn) {
  const seen = [];
  const originals = {};
  for (const name of Object.keys(HANDLERS)) {
    originals[name] = HANDLERS[name];
    HANDLERS[name] = (ctx) => {
      seen.push({ state: name, cameFrom: ctx.cameFrom });
      return originals[name](ctx);
    };
  }
  try {
    await fn();
  } finally {
    for (const name of Object.keys(originals)) HANDLERS[name] = originals[name];
  }
  return seen;
}

test("runTask: ctx.cameFrom is the state the loop came FROM, never the state about to run (off-by-one guard)", async () => {
  const taskDir = mkTmp('spo-camefrom-happy-taskdir-');
  const task = {
    id: 'card-camefrom-happy',
    title: 'cameFrom threading',
    kind: 'synthetic',
    shadow: { llm: { VALIDATE: { verdict: 'PASS' } } },
  };

  let finalState;
  const seen = await recordCameFrom(async () => {
    finalState = await runTask('card-camefrom-happy', task, taskDir, { shadowMode: true, dryRun: false });
  });
  assert.equal(finalState, 'DONE');

  // The first handler call has no predecessor at all.
  assert.equal(seen[0].state, 'INTAKE');
  assert.equal(seen[0].cameFrom, null);

  // Every later call was handed exactly the state of the call before it -- this is what both
  // `cameFrom = next` (which would yield cameFrom === state) and a hardcoded constant break.
  for (let i = 1; i < seen.length; i++) {
    assert.equal(
      seen[i].cameFrom,
      seen[i - 1].state,
      `handler #${i} (${seen[i].state}) was handed cameFrom=${seen[i].cameFrom}, expected ${seen[i - 1].state}`
    );
    assert.notEqual(seen[i].cameFrom, seen[i].state, `${seen[i].state} must never be its own cameFrom`);
  }
});

test("runTask: DIAGNOSE from a CHECK failure is handed cameFrom 'CHECK'; DIAGNOSE from a gate failure is handed 'GATE'", async () => {
  // (a) CHECK fails once -> DIAGNOSE. No gate has run; prepareJudgeInputs must NOT be able to
  //     see 'GATE' here, or requirement (d)'s "never PARKED from a CHECK failure" collapses.
  const checkDir = mkTmp('spo-camefrom-check-taskdir-');
  const seenCheck = await recordCameFrom(() =>
    runTask(
      'card-camefrom-check',
      {
        id: 'card-camefrom-check',
        title: 'diagnose from check',
        kind: 'synthetic',
        shadow: {
          check: [1, 0],
          llm: { DIAGNOSE: { rootCause: 'check-cause' }, VALIDATE: { verdict: 'PASS' } },
        },
      },
      checkDir,
      { shadowMode: true, dryRun: false }
    )
  );
  const diagFromCheck = seenCheck.filter((e) => e.state === 'DIAGNOSE');
  assert.equal(diagFromCheck.length, 1);
  assert.equal(diagFromCheck[0].cameFrom, 'CHECK');

  // (b) GATE fails once -> DIAGNOSE. Here, and only here, gate.log is a hard requirement.
  const gateDir = mkTmp('spo-camefrom-gate-taskdir-');
  const seenGate = await recordCameFrom(() =>
    runTask(
      'card-camefrom-gate',
      {
        id: 'card-camefrom-gate',
        title: 'diagnose from gate',
        kind: 'synthetic',
        shadow: {
          gate: [1, 0],
          prWait: [0],
          llm: { DIAGNOSE: { rootCause: 'gate-cause' }, VALIDATE: { verdict: 'PASS' } },
        },
      },
      gateDir,
      { shadowMode: true, dryRun: false }
    )
  );
  const diagFromGate = seenGate.filter((e) => e.state === 'DIAGNOSE');
  assert.equal(diagFromGate.length, 1);
  assert.equal(diagFromGate[0].cameFrom, 'GATE');

  // A second DIAGNOSE reached through IMPLEMENT -> CHECK must report CHECK, not the stale GATE
  // of the first visit -- the retry loop is where a "last seen" cameFrom would rot.
  const secondDir = mkTmp('spo-camefrom-second-taskdir-');
  const seenSecond = await recordCameFrom(() =>
    runTask(
      'card-camefrom-second',
      {
        id: 'card-camefrom-second',
        title: 'gate fail then check fail',
        kind: 'synthetic',
        shadow: {
          gate: [1, 0],
          check: [0, 1, 0],
          prWait: [0],
          llm: {
            DIAGNOSE: [{ rootCause: 'first-cause' }, { rootCause: 'second-cause' }],
            VALIDATE: { verdict: 'PASS' },
          },
        },
      },
      secondDir,
      { shadowMode: true, dryRun: false }
    )
  );
  const diagVisits = seenSecond.filter((e) => e.state === 'DIAGNOSE').map((e) => e.cameFrom);
  assert.deepEqual(diagVisits, ['GATE', 'CHECK']);
});

// D3's hole: `conclusion === null` alone is not what "in flight" means. GitHub happens to send
// conclusion: null beside status queued/in_progress, but a run whose conclusion key is ABSENT or
// empty counted as neither pending (=== null) nor failing (truthiness) and read as GREEN -- the
// exact shape of the bug action 1.7 exists to close, re-opened one field over.
for (const [label, run] of [
  ['conclusion key absent, status queued', { name: 'claude review', status: 'queued' }],
  ['conclusion empty string', { name: 'claude review', conclusion: '', status: 'in_progress' }],
  ['conclusion success but status in_progress', { name: 'claude review', conclusion: 'success', status: 'in_progress' }],
]) {
  test(`realCiChecks: ${label} counts as in flight, never as green`, async () => {
    const taskDir = mkTmp('spo-ci-inflight-shape-');
    const worktreePath = mkTmp('spo-ci-inflight-wt-');
    const sleeps = [];
    const deps = {
      sleep: async (ms) => sleeps.push(ms),
      spawnSync: (command, args) => {
        if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: 'headsha\n', stderr: '' };
        if (command === 'gh' && args[0] === 'api') {
          return { status: 0, stdout: JSON.stringify({ check_runs: [run] }), stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };

    const ctx = testCtx({
      taskDir,
      task: { id: 'ci-inflight-shape', issue: 7, worktreePath },
      config: testConfig({ ciChecksMaxPolls: 2, ciChecksPollIntervalMs: 1000 }),
    });

    await assert.rejects(() => realCiChecks(ctx, deps), (err) => err.reason === 'ci-checks-still-running');
    assert.equal(sleeps.length, 1, 'one sleep between the two polls');
  });
}

// ---- action 2.1: real spawnSync per-command-class timeouts -------------------------------
//
// The spec claimed "every step has a wall-clock deadline"; in real mode that was false --
// deadline.js's callWithDeadline races a JS timer against a Promise, but every real command
// here runs through spawnSync, which BLOCKS the event loop, so that timer cannot fire while a
// git/gh/npm child is stuck. The only real defence is spawnSync's own `timeout` option, armed
// per call by spawnStep via classifyCommand + config.commandTimeoutsMs.

const TIMEOUT_TABLE = {
  git: 120000,
  gh: 120000,
  'npm-ci': 600000,
  'npm-gate': 900000,
  'npm-run': 660000,
};

function timeoutTestCtx(overrides = {}) {
  return testCtx({
    task: { id: 'card-timeout', issue: 55, worktreePath: '/fake/wt' },
    config: testConfig({ commandTimeoutsMs: TIMEOUT_TABLE, ...overrides }),
  });
}

test('classifyCommand: classifies every real call shape used in this file', () => {
  assert.equal(classifyCommand('git', ['-C', '/x', 'status', '--porcelain']), 'git');
  assert.equal(classifyCommand('gh', ['pr', 'list']), 'gh');
  assert.equal(classifyCommand('gh', ['api', 'repos/x/y/pulls/1', '-X', 'PATCH']), 'gh');
  assert.equal(classifyCommand('npm', ['ci']), 'npm-ci');
  assert.equal(classifyCommand('npm', ['run', 'gate']), 'npm-gate');
  assert.equal(classifyCommand('npm', ['run', 'typecheck']), 'npm-run');
  assert.equal(classifyCommand('npm', ['run', 'board:take', '--', '42']), 'npm-run');
  assert.equal(classifyCommand('npm', ['run', 'pr:wait', '--', '9']), 'npm-run');
  assert.equal(classifyCommand('curl', ['https://example.com']), null);
});

for (const [label, command, args, expectedClass] of [
  ['git', 'git', ['-C', '/wt', 'status', '--porcelain'], 'git'],
  ['gh', 'gh', ['pr', 'list'], 'gh'],
  ['npm ci', 'npm', ['ci'], 'npm-ci'],
  ['npm run gate', 'npm', ['run', 'gate'], 'npm-gate'],
  ['npm run <other alias>', 'npm', ['run', 'lint'], 'npm-run'],
]) {
  test(`spawnStep: arms spawnSync's own timeout with the ${label} class default`, () => {
    const ctx = timeoutTestCtx();
    const seenOpts = [];
    const deps = {
      spawnSync: (cmd, a, opts) => {
        seenOpts.push(opts);
        return ok('');
      },
    };
    const r = spawnStep(ctx, deps, 'CHECK', command, args);
    assert.equal(seenOpts.length, 1);
    assert.equal(seenOpts[0].timeout, TIMEOUT_TABLE[expectedClass]);
    assert.equal(r.exit, 0);
    assert.equal(r.timedOut, false);
  });
}

test('spawnStep: an explicit opts.timeout always overrides the command class default', () => {
  const ctx = timeoutTestCtx();
  const seenOpts = [];
  const deps = {
    spawnSync: (cmd, a, opts) => {
      seenOpts.push(opts);
      return ok('');
    },
  };
  spawnStep(ctx, deps, 'WORKTREE', 'npm', ['ci'], { timeout: 5000, cwd: '/wt' });
  assert.equal(seenOpts.length, 1);
  assert.equal(seenOpts[0].timeout, 5000, 'explicit opts.timeout beats the npm-ci class default');
  assert.equal(seenOpts[0].cwd, '/wt', 'other opts are still passed through');
});

test('spawnStep: a timeout-killed command (status: null, signal SIGTERM, error ETIMEDOUT) reports timedOut, never exit 1 -- retried once, second attempt succeeds', () => {
  const ctx = timeoutTestCtx();
  const calls = [];
  const deps = {
    spawnSync: (cmd, a, opts) => {
      calls.push({ cmd, args: [...a], timeout: opts.timeout });
      return calls.length === 1 ? timeoutResult() : ok('all good\n');
    },
  };

  const r = spawnStep(ctx, deps, 'CHECK', 'git', ['-C', '/wt', 'status', '--porcelain']);

  assert.equal(calls.length, 2, 'retried exactly once');
  assert.equal(r.timedOut, false, 'the RETURNED result is the second (successful) attempt');
  assert.equal(r.exit, 0);
  assert.equal(r.stdout, 'all good\n');

  const journal = readJournal(ctx.taskDir).filter((e) => e.event === 'spawn');
  assert.equal(journal.length, 2, 'both attempts journalled');
  assert.equal(journal[0].attempt, 1);
  assert.equal(journal[0].timedOut, true);
  assert.notEqual(journal[0].exit, 1, 'a timeout must never be journalled as a plain exit 1');
  assert.equal(journal[1].attempt, 2);
  assert.equal(journal[1].timedOut, false);
  assert.equal(journal[1].exit, 0);
});

// The fake MUST key on the command, not on a call counter: realGate's first spawn is moveCard's
// own `npm run board:move` (board.js's runSync, which swallows every failure by design), so a
// counter-keyed fake spends the timeout on the kanban move and never times out the gate at all --
// the test then passes with the whole timeout/retry path deleted (verified by mutation).
test('spawnStep: a timed-out GATE parks on its own reason and is NEVER retried -- a retry re-submits a bench job', async () => {
  const worktreePath = mkTmp('spo-gate-timeout-wt-');
  const config = testConfig({ commandTimeoutsMs: TIMEOUT_TABLE });
  const task = { id: 'card-gate-timeout-ok', kind: 'card', issue: 91, worktreePath };
  const ctx = testCtx({ id: 'card-gate-timeout-ok', task, config });
  let gateRuns = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'npm' && args[0] === 'run' && args[1] === 'gate') {
        gateRuns += 1;
        return timeoutResult();
      }
      return ok(''); // moveCard's board:move and anything else
    },
  };

  // The property this test exists for: realGate maps exit 1 -> DIAGNOSE, and a timeout-killed
  // child reports status:null which the pre-2.1 code mapped to exit 1. So without the
  // timeout/exit disambiguation, a hung gate would buy a real LLM diagnosis of a hang.
  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'npm-gate-timed-out');
      assert.notEqual(err.reason, 'gate-dirty-tree', 'a busy bench must never be reported as a dirty worktree');
      assert.equal(err.detail.retried, false);
      return true;
    }
  );

  // Exactly once. `npm run gate` submits to the live bench; job.ts refuses a second job for the
  // same (worktree, ref) with DuplicateJobError -> cli.ts exit 2 -> ParkSignal('gate-dirty-tree'),
  // and spawnSync kills only the direct child so the orphaned waiter keeps the first job alive.
  assert.equal(gateRuns, 1, 'the gate command must run exactly once -- a retry re-submits a bench job');

  const gateSpawns = readJournal(ctx.taskDir)
    .filter((e) => e.event === 'spawn')
    .filter((e) => e.argv[0] === 'npm' && e.argv[2] === 'gate');
  assert.deepEqual(
    gateSpawns.map((e) => [e.attempt, e.timedOut]),
    [[1, true]],
    'journalled as a timeout, never as an exit-1 gate failure'
  );
  assert.equal(gateSpawns[0].timeoutMs, TIMEOUT_TABLE['npm-gate']);
});

test('npm-gate timeout exceeds the bench\'s own wait bound, so the bench always renders its verdict first', () => {
  const config = require('../orchestrator/config.js');
  // src/e2e/bench/cli.ts: DEFAULT_WAIT_TIMEOUT_MIN = 120 -> bench-submit --wait gives up at
  // 7200s and exits 4, which realGate maps to the designed ParkSignal('gate-timeout'). Our kill
  // must stay the last resort behind that, or we destroy a legitimate queue wait. The plan's
  // stated 900s was eight times too small; this pins the relation so it cannot drift back.
  const BENCH_WAIT_BOUND_MS = 120 * 60 * 1000;
  assert.ok(
    config.commandTimeoutsMs['npm-gate'] > BENCH_WAIT_BOUND_MS,
    `npm-gate (${config.commandTimeoutsMs['npm-gate']}ms) must exceed the bench's own ${BENCH_WAIT_BOUND_MS}ms bound`
  );
});

test('spawnStep: BOTH attempts time out -> PARKED with a dedicated reason naming the command class, never the caller\'s own failure reason', () => {
  const ctx = timeoutTestCtx();
  const deps = { spawnSync: () => timeoutResult() };

  assert.throws(
    () => spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', '/wt', 'push', '-u', 'origin', 'claude-pipe/card-timeout']),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'git-timed-out');
      assert.notEqual(err.reason, 'push-pr-failed', "must be spawnStep's own reason, not the caller's");
      assert.equal(err.detail.commandClass, 'git');
      assert.equal(err.detail.timeoutMs, TIMEOUT_TABLE.git);
      return true;
    }
  );

  const journal = readJournal(ctx.taskDir).filter((e) => e.event === 'spawn');
  assert.equal(journal.length, 2, 'both timed-out attempts are journalled, explaining the park');
  assert.ok(journal.every((e) => e.timedOut === true));
  assert.deepEqual(journal.map((e) => e.attempt), [1, 2]);
});

test('spawnStep: a timed-out GATE that ALSO fails on retry parks npm-gate-timed-out -- never reaches DIAGNOSE, never gate-timeout (the domain exit-4 reason)', async () => {
  const worktreePath = mkTmp('spo-gate-timeout-park-wt-');
  const config = testConfig({ commandTimeoutsMs: TIMEOUT_TABLE });
  const task = { id: 'card-gate-timeout-park', kind: 'card', issue: 92, worktreePath };
  const ctx = testCtx({ id: 'card-gate-timeout-park', task, config });
  const deps = { spawnSync: () => timeoutResult() };

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'npm-gate-timed-out'
  );
});

test('spawnStep: a genuine non-zero exit is never retried and behaves exactly as before (one spawnSync call, one journal line)', () => {
  const ctx = timeoutTestCtx();
  const calls = [];
  const deps = {
    spawnSync: (cmd, a) => {
      calls.push([cmd, ...a]);
      return fail(1, 'lint errors');
    },
  };

  const r = spawnStep(ctx, deps, 'CHECK', 'npm', ['run', 'lint']);

  assert.equal(calls.length, 1, 'no retry on a genuine non-zero exit');
  assert.equal(r.exit, 1);
  assert.equal(r.timedOut, false);
});

test('spawnStep: status: null with NO signal and NO error (pre-existing "unknown" case) still maps to exit 1, unretried -- behaviour unchanged by this action', () => {
  const ctx = timeoutTestCtx();
  const calls = [];
  const deps = {
    spawnSync: () => {
      calls.push(1);
      return nullStatusNoSignal();
    },
  };

  const r = spawnStep(ctx, deps, 'CHECK', 'git', ['-C', '/wt', 'rev-parse', 'HEAD']);

  assert.equal(calls.length, 1, 'not treated as a timeout, so no retry');
  assert.equal(r.exit, 1);
  assert.equal(r.timedOut, false);
});

test('spawnStep: a bare signal with NO deadline armed (unclassified command, no opts.timeout) is not mistaken for a timeout', () => {
  const ctx = timeoutTestCtx(); // TIMEOUT_TABLE has no entry for an unrecognized command
  const calls = [];
  const deps = {
    spawnSync: () => {
      calls.push(1);
      return killedNoDeadline('SIGKILL');
    },
  };

  const r = spawnStep(ctx, deps, 'CHECK', 'some-unclassified-tool', ['--flag']);

  assert.equal(calls.length, 1, 'no timeout was armed, so no retry is triggered by the bare signal');
  assert.equal(r.timedOut, false);
  assert.equal(r.exit, 1, 'falls through to the pre-existing null-status default');
});

test('spawnStep: pre-existing spawn error (e.g. ENOENT, no timeout involved) still maps to exit -1, unretried', () => {
  const ctx = timeoutTestCtx();
  const calls = [];
  const deps = {
    spawnSync: () => {
      calls.push(1);
      const error = new Error('spawnSync git ENOENT');
      error.code = 'ENOENT';
      return { status: null, stdout: '', stderr: '', signal: null, error };
    },
  };

  const r = spawnStep(ctx, deps, 'CHECK', 'git', ['-C', '/wt', 'status']);

  assert.equal(calls.length, 1, 'ENOENT is not a timeout -- no retry');
  assert.equal(r.exit, -1);
  assert.equal(r.timedOut, false);
});


// ---- action 2.1, verifier follow-ups ------------------------------------------------------
//
// (a) spawnStep now THROWS from a place that previously always returned, and one of its 48 call
//     sites sits inside the park path itself: state-machine.js's finalizePark calls
//     preserveWorktreeWip, whose own header contract is "never blocks or throws". Uncaught, a
//     `git-timed-out` there is thrown from INSIDE runTask's `catch (ParkSignal)` handler --
//     state.json is never written, the task never reaches PARKED, and the throw escapes to
//     daemon.js's main().catch (exit 1), where the next start's orphanScan reparks the same
//     task through the same function and dies again.
test('preserveWorktreeWip: a git command killed by its own spawnSync timeout twice returns null, never throws (finalizePark must stay total)', () => {
  const worktreePath = mkTmp('spo-wip-timeout-wt-');
  fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'x');
  const ctx = timeoutTestCtx();
  const deps = { spawnSync: () => timeoutResult() };

  const preserved = preserveWorktreeWip(ctx, deps, { worktreePath, reason: 'gate-dirty-tree' });

  assert.equal(preserved, null, 'a timed-out preservation step is a failed preservation, not a new park');
  const failed = readJournal(ctx.taskDir).filter((e) => e.event === 'wip-preserve-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].step, 'timed-out');
  assert.equal(failed[0].reason, 'git-timed-out');
});

test('finalizePark stays total when preserveWorktreeWip times out: PARKED state.json and report.md still written', () => {
  const { finalizePark } = require('../orchestrator/state-machine');
  const worktreePath = mkTmp('spo-park-timeout-wt-');
  fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'x');
  const config = testConfig({ commandTimeoutsMs: TIMEOUT_TABLE });
  const task = { id: 'card-park-timeout', kind: 'card', issue: 93, worktreePath };
  const ctx = testCtx({ id: 'card-park-timeout', task, config });
  const deps = {
    spawnSync: (command, args) => (command === 'git' && args.includes('status') ? timeoutResult() : ok('')),
  };
  ctx.deps = deps;

  finalizePark(ctx, 'GATE', 'gate-dirty-tree', { exit: 2 });

  const state = JSON.parse(fs.readFileSync(path.join(ctx.taskDir, 'state.json'), 'utf8'));
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'gate-dirty-tree', 'the ORIGINAL park reason survives a timed-out WIP preservation');
  assert.ok(fs.existsSync(path.join(ctx.taskDir, 'report.md')));
});

// (b) The relation this action leaves implicit, pinned so it cannot break silently.
//     config.stepDeadlineMsByState has no GATE entry, so GATE keeps the generic 120s ceiling
//     even though npm-gate's spawnSync timeout is 900s. That is only safe because realGate never
//     yields the event loop: spawnSync BLOCKS, so callWithDeadline's timer cannot fire during the
//     spawn, and when the (long-expired) timer finally becomes runnable the handler's own
//     resolution -- a microtask -- has already won the race. Adding a single `await` to realGate
//     that yields to the macrotask queue breaks it: measured, the deadline then fires
//     RETROACTIVELY, callWithDeadline re-runs the whole step (a SECOND real bench gate) and parks
//     step-deadline-exceeded-twice. This test fails the moment that happens.
test('GATE: a spawn that blocks far past the state deadline still returns its real result -- the deadline never fires retroactively', async () => {
  const worktreePath = mkTmp('spo-gate-block-wt-');
  const config = testConfig({ stepDeadlineMs: 15, commandTimeoutsMs: TIMEOUT_TABLE });
  const task = { id: 'card-gate-block', kind: 'card', issue: 94, worktreePath };
  const ctx = testCtx({ id: 'card-gate-block', task, config });
  let gateRuns = 0;
  ctx.deps = {
    spawnSync: (command, args) => {
      if (command === 'npm' && args[0] === 'run' && args[1] === 'gate') {
        gateRuns += 1;
        const until = Date.now() + 60; // blocks the event loop past the 15ms step deadline
        while (Date.now() < until) {
          /* busy-wait: exactly what a real spawnSync does to the loop */
        }
        return ok('gate report\n');
      }
      return ok('');
    },
  };

  const next = await HANDLERS.GATE(ctx);

  assert.equal(next, 'CI_CHECKS');
  assert.equal(gateRuns, 1, 'the gate ran ONCE -- a retroactive deadline would re-run the bench job');
  assert.equal(
    readJournal(ctx.taskDir).filter((e) => e.event === 'deadline-exceeded').length,
    0,
    'no deadline-exceeded event: withTimeout cannot preempt a blocking spawnSync'
  );
});
