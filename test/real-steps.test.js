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

const {
  realWorktree,
  realCheck,
  realPushPr,
  realGate,
  realCiChecks,
  realMerge,
  realFinish,
} = require('../orchestrator/steps/scripted');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { appendEvent } = require('../orchestrator/journal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-real-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-real-bench-'),
    stepDeadlineMs: 30000,
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

  const create = calls.find((c) => c.command === 'gh');
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

  const create = calls.find((c) => c.command === 'gh');
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

test('realCiChecks: extracts {name, conclusion} from gh api and routes "Lint" failure to IMPLEMENT', async () => {
  const ctx = ciCtx();
  const headSha = 'headsha1111111111111111111111111111111';

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (command === 'gh' && args[0] === 'api') {
        return ok(
          JSON.stringify({
            check_runs: [
              { name: 'typecheck + tests', conclusion: 'success' },
              { name: 'Lint', conclusion: 'failure' },
            ],
          })
        );
      }
      return ok('');
    },
  };

  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'IMPLEMENT');

  const apiCall = calls.find((c) => c.command === 'gh');
  assert.deepEqual(apiCall.args, ['api', `repos/${ctx.config.ghRepo}/commits/${headSha}/check-runs`]);
});

test('realCiChecks: "PR rules" failure -> PARKED (pr-rules-needs-approval)', async () => {
  const ctx = ciCtx();
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse')) return ok('sha\n');
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'PR rules', conclusion: 'failure' }] }));
      }
      return ok('');
    },
  };
  await assert.rejects(
    () => realCiChecks(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'pr-rules-needs-approval'
  );
});

test('realCiChecks: an unmapped failing check -> DIAGNOSE', async () => {
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

test('realFinish: board:move, then gh issue comment, then git worktree remove --force, in order; sums llm costUsd', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-wt-');
  const task = { id: 'card-finish1', kind: 'card', issue: 120, worktreePath };
  const ctx = testCtx({ id: 'card-finish1', task, config });
  ctx.prNumber = 444;

  appendEvent(ctx.taskDir, 'PLAN', 'llm-call', { costUsd: 0.01 });
  appendEvent(ctx.taskDir, 'IMPLEMENT', 'llm-call', { costUsd: 0.025 });

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
  assert.ok(Math.abs(finished.costUsd - 0.035) < 1e-9);
  assert.equal(finished.prNumber, 444);
});

test('realFinish: board:move failure -> PARKED (finish-failed), worktree never removed', async () => {
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
