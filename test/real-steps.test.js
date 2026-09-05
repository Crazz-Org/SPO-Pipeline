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
  runScripted,
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
  benchQueueDepth,
} = require('../orchestrator/steps/scripted');
const { HANDLERS, buildCtx, runTask } = require('../orchestrator/state-machine');
const { lockFilePath, acquireProductRepoLock, releaseProductRepoLock } = require('../orchestrator/product-repo-lock');
const { ParkSignal } = require('../orchestrator/park-signal');
const { appendEvent, readBenchReinstallOwed, writeBenchReinstallOwed } = require('../orchestrator/journal');
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

// An EXTERNALLY KILLED child (an operator's kill -9, an OOM kill, a deploy restart's SIGTERM):
// no `error`, no ETIMEDOUT code, just a bare signal. The name is historical -- what makes this
// not a timeout is the ABSENT ETIMEDOUT, not the absent deadline, and isSpawnKilled recognises it
// either way (a deadline being armed or not is unrelated to who killed the child).
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
    // Action 6.5: real config.js's default (1) -- baked in here, not left to
    // main-moved-budget.js's own fallback, so a test that overrides it is visibly opting OUT of
    // the default rather than relying on an implicit one.
    mainMovedRegateBudget: 1,
    // Post-verification hazard fix: waitForBenchIdle's own bound. Small numbers here for the SAME
    // reason ciChecksMaxPolls/ciChecksPollIntervalMs above are -- every existing bench test's
    // spoBenchDir is a fresh, empty tmp dir (spool/running never even created), so
    // benchQueueDepth reads 0/0 on the FIRST poll and this never actually gets exercised except
    // by the dedicated bench-idle-wait tests below (which override it further where a specific
    // bound matters).
    benchIdleWaitMaxPolls: 3,
    benchIdleWaitPollIntervalMs: 10,
    ...overrides,
  };
}

// action B1.4 round 4: taskDir's PARENT is journalRoot in production
// (state-machine.js's takeNextTask: `taskDir = path.join(journalRoot, id)`) -- and
// payBenchReinstallDebtIfOwed/readBenchReinstallOwed now read/write
// `<journalRoot>/bench-reinstall-owed.json` off exactly that parent, unconditionally, at the
// very start of every realWorktree call. A bare `mkTmp('spo-real-taskdir-')` (a NEW mkdtemp
// dropped directly under os.tmpdir()) makes every test's own "journalRoot" the SAME shared OS tmp
// directory -- so an EARLIER test's realFinish deferring a reinstall (writeBenchReinstallOwed)
// left a real /tmp/bench-reinstall-owed.json that a LATER, unrelated realWorktree test then read
// back, inserting extra git calls into argv assertions that had nothing to do with this debt.
// Nesting taskDir one level inside its OWN fresh mkTmp gives every test call a private
// journalRoot, matching production's real shape, with no cross-test leakage through the real
// filesystem.
function testCtx({ id = 'card-1', task, config, taskDir } = {}) {
  const dir = taskDir || path.join(mkTmp('spo-real-journalroot-'), id);
  fs.mkdirSync(dir, { recursive: true });
  return buildCtx(id, task, dir, {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

// ---- runScripted itself (action 7.1) -----------------------------------------------------------
//
// The generic shadow/dry-run/real dispatcher every handleX in state-machine.js's shadow path
// calls through (runScripted(ctx, fixtureKey, opts)). Its shadow and dry-run branches are
// exercised end to end by nearly every other test file in this suite; the one branch nothing
// reaches is real execution with no `command` configured at all -- today that is EVERY caller,
// since state-machine.js only ever calls runScripted from its shadow-mode handlers (real mode
// dispatches to the realX(ctx, deps) functions in this same file instead) and no opts.command is
// ever passed. The comment at the throw site calls this "not implemented in this skeleton" --
// still true, and still worth pinning: a future caller that reaches real execution without first
// wiring a command must fail loudly with a message naming the fixture key, not silently spawn
// nothing.
test('runScripted: real execution (not shadow, not dry-run) with no command configured rejects with a plain Error naming the fixture key, never a ParkSignal', async () => {
  const ctx = { shadowMode: false, dryRun: false };
  // runScripted is declared `async`, so even a throw before its first `await` never escapes
  // synchronously -- it always surfaces as a rejected promise. assert.rejects, not assert.throws.
  await assert.rejects(
    () => runScripted(ctx, 'someUnwiredFixtureKey'),
    (err) => {
      assert.ok(!(err instanceof ParkSignal), 'a missing command wiring is a programming error, not a recognized park reason');
      assert.match(err.message, /no real command configured for "someUnwiredFixtureKey"/);
      return true;
    }
  );
});

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

// action 7.1: the four ORDINARY (non-timeout) error legs preserveWorktreeWipUnguarded can hit, one
// per git subcommand in its sequence (status -> checkout --detach -> add -A -> commit -F). Each is
// handled inline -- NOT by preserveWorktreeWip's own outer try/catch, which exists only to catch a
// ParkSignal from a spawnStep TIMEOUT (see the two-timeout test further below and this function's
// own header comment) -- by appending 'wip-preserve-failed' with the step name and the exit code,
// then returning null, short-circuiting before any later command in the sequence runs. Distinct
// exit codes per case (17/23/29/31) so a mutation that swapped which step's exit gets journalled,
// or that dropped the step label, cannot pass by accident.

test('preserveWorktreeWip: git status itself fails -> wip-preserve-failed{step:"status"}, returns null, no further git calls', () => {
  const worktreePath = mkTmp('spo-real-wip-statusfail-wt-');
  const taskDir = mkTmp('spo-real-wip-statusfail-taskdir-');
  const ctx = { id: 'card-wip-status', taskDir };
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push([...args]);
      if (args.includes('status') && args.includes('--porcelain')) return fail(17);
      return ok('');
    },
  };

  const preserved = preserveWorktreeWip(ctx, deps, { worktreePath, reason: 'leftover', state: 'WORKTREE' });
  assert.equal(preserved, null);
  assert.equal(calls.length, 1, 'a failed status must short-circuit before any further git command');

  const journal = readJournal(taskDir);
  const failed = journal.find((e) => e.event === 'wip-preserve-failed');
  assert.ok(failed, 'expected a wip-preserve-failed event');
  assert.equal(failed.step, 'status');
  assert.equal(failed.exit, 17);
});

test('preserveWorktreeWip: git checkout --detach fails -> wip-preserve-failed{step:"detach"}, returns null, add/commit never attempted', () => {
  const worktreePath = mkTmp('spo-real-wip-detachfail-wt-');
  fs.writeFileSync(path.join(worktreePath, 'stray.ts'), 'uncommitted');
  const taskDir = mkTmp('spo-real-wip-detachfail-taskdir-');
  const ctx = { id: 'card-wip-detach', taskDir };
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push([...args]);
      if (args.includes('status') && args.includes('--porcelain')) return ok(' M stray.ts\n');
      if (args.includes('checkout') && args.includes('--detach')) return fail(23);
      return ok('');
    },
  };

  const preserved = preserveWorktreeWip(ctx, deps, { worktreePath, reason: 'leftover', state: 'WORKTREE' });
  assert.equal(preserved, null);
  assert.ok(!calls.some((a) => a.includes('add') && a.includes('-A')), 'add -A must never run after a failed detach');

  const journal = readJournal(taskDir);
  const failed = journal.find((e) => e.event === 'wip-preserve-failed');
  assert.ok(failed);
  assert.equal(failed.step, 'detach');
  assert.equal(failed.exit, 23);
});

test('preserveWorktreeWip: git add -A fails -> wip-preserve-failed{step:"add"}, returns null, commit never attempted', () => {
  const worktreePath = mkTmp('spo-real-wip-addfail-wt-');
  fs.writeFileSync(path.join(worktreePath, 'stray.ts'), 'uncommitted');
  const taskDir = mkTmp('spo-real-wip-addfail-taskdir-');
  const ctx = { id: 'card-wip-add', taskDir };
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push([...args]);
      if (args.includes('status') && args.includes('--porcelain')) return ok(' M stray.ts\n');
      if (args.includes('checkout') && args.includes('--detach')) return ok('');
      if (args.includes('add') && args.includes('-A')) return fail(29);
      return ok('');
    },
  };

  const preserved = preserveWorktreeWip(ctx, deps, { worktreePath, reason: 'leftover', state: 'WORKTREE' });
  assert.equal(preserved, null);
  assert.ok(!calls.some((a) => a.includes('commit')), 'commit must never run after a failed add -A');

  const journal = readJournal(taskDir);
  const failed = journal.find((e) => e.event === 'wip-preserve-failed');
  assert.ok(failed);
  assert.equal(failed.step, 'add');
  assert.equal(failed.exit, 29);
});

test('preserveWorktreeWip: git commit -F fails -> wip-preserve-failed{step:"commit"}, returns null, no rev-parse/push follows', () => {
  const worktreePath = mkTmp('spo-real-wip-commitfail-wt-');
  fs.writeFileSync(path.join(worktreePath, 'stray.ts'), 'uncommitted');
  const taskDir = mkTmp('spo-real-wip-commitfail-taskdir-');
  const ctx = { id: 'card-wip-commit', taskDir };
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push([...args]);
      if (args.includes('status') && args.includes('--porcelain')) return ok(' M stray.ts\n');
      if (args.includes('checkout') && args.includes('--detach')) return ok('');
      if (args.includes('add') && args.includes('-A')) return ok('');
      if (args.includes('commit') && args.includes('-F')) return fail(31);
      return ok('');
    },
  };

  const preserved = preserveWorktreeWip(ctx, deps, { worktreePath, reason: 'leftover', state: 'WORKTREE' });
  assert.equal(preserved, null);
  assert.ok(!calls.some((a) => a.includes('push')), 'push must never run after a failed commit');

  const journal = readJournal(taskDir);
  const failed = journal.find((e) => e.event === 'wip-preserve-failed');
  assert.ok(failed);
  assert.equal(failed.step, 'commit');
  assert.equal(failed.exit, 31);
});

// The negative half of the same contract: a genuinely clean worktree has nothing to preserve and
// must return null WITHOUT ever writing wip-preserve-failed (or any other event) -- a mutation
// that turned this early return into "fall through and fail on the very next step anyway" would
// still pass a bare `assert.equal(preserved, null)`, so this asserts journal.jsonl is never even
// created, not merely that it lacks the one event name.
test('preserveWorktreeWip: a clean worktree returns null and writes NO wip-preserve-failed (or wip-preserved) event', () => {
  const worktreePath = mkTmp('spo-real-wip-clean-wt-');
  const taskDir = mkTmp('spo-real-wip-clean-taskdir-');
  const ctx = { id: 'card-wip-clean', taskDir };
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push([...args]);
      return ok(''); // status --porcelain (and anything else) reports a clean tree
    },
  };

  const preserved = preserveWorktreeWip(ctx, deps, { worktreePath, reason: 'leftover', state: 'WORKTREE' });
  assert.equal(preserved, null);
  assert.equal(calls.length, 1, 'a clean tree must stop after the single status check');
  // spawnStep's own bookkeeping ('spawn' events, one per command) is unconditional and unrelated
  // to this leg -- what must be ABSENT is preserveWorktreeWip's own outcome event. A mutation that
  // turned the clean-tree early return into "fall through and fail on the very next (nonexistent)
  // step anyway" would still pass a bare `assert.equal(preserved, null)`.
  const journal = readJournal(taskDir);
  assert.ok(!journal.some((e) => e.event === 'wip-preserve-failed'), 'a clean tree must never journal wip-preserve-failed');
  assert.ok(!journal.some((e) => e.event === 'wip-preserved'), 'a clean tree preserved nothing -- must never journal wip-preserved either');
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

// ---- WORKTREE: action B1.4 round 4 -- payBenchReinstallDebtIfOwed, paying back an EARLIER
// card's deferred bench-worker reinstall from INSIDE this WORKTREE's own product-repo lock span
// ------------------------------------------------------------------------------------------------
//
// Round 3's answer to the same debt was a separate daemon scan timer
// (orchestrator/bench-reconcile.js), since deleted -- see payBenchReinstallDebtIfOwed's own header
// in steps/scripted.js for why. These tests pin round 4's replacement: reuse the SAME
// fastForwardMainAndInstall function realFinish calls (no second copy of the preconditions), reuse
// the lock realWorktree already holds (no new lock holder), and -- the property every failure mode
// below exists to prove -- NEVER block or park the card paying the debt, even when the debt itself
// cannot be paid this cycle.

// debtPaySpawnSync(calls, opts) -- a superset of noLeftoversSpawnSync above: handles both
// payBenchReinstallDebtIfOwed's own calls (the `--abbrev-ref` branch check, `status
// --untracked-files=no`, `merge --ff-only`, `merge-base --is-ancestor`, `bash` install) AND
// realWorktree's own ordinary calls (fetch, `rev-parse origin/main`, the leftover sweep's
// `--verify` probes, `worktree add`, `npm ci`, `board:take`) -- so a debt-owed test still reaches
// PLAN exactly like an ordinary run once the debt itself is settled one way or another.
function debtPaySpawnSync(calls, { onMain = true, dirty = false, ffOk = true, ancestryOk = true, installExit = 0 } = {}) {
  return (command, args, opts) => {
    calls.push({ command, args: [...args], cwd: opts && opts.cwd });
    if (command === 'git' && args.includes('rev-parse') && args.includes('--abbrev-ref')) {
      return onMain ? ok('main\n') : ok('some-feature-branch\n');
    }
    if (command === 'git' && args.includes('status') && args.includes('--porcelain')) {
      return dirty ? ok(' M some/tracked/file.ts\n') : ok('');
    }
    if (command === 'git' && args.includes('merge') && args.includes('--ff-only')) {
      return ffOk ? ok('') : fail(1, 'not fast forward');
    }
    if (command === 'git' && args.includes('merge-base') && args.includes('--is-ancestor')) {
      return ancestryOk ? ok('') : fail(1);
    }
    if (command === 'bash') {
      return installExit === 0 ? ok('') : fail(installExit);
    }
    if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no leftovers
    if (args.includes('rev-parse')) return ok('originmainsha00000000000000000000000000\n');
    if (args.includes('board:take')) return ok('claimed\n');
    return ok('');
  };
}

test('realWorktree: NO debt owed -- payBenchReinstallDebtIfOwed is a true no-op, byte-identical argv and journal to a run with no debt-repayment code at all', async () => {
  const config = testConfig();
  const task = { id: 'card-nodebt', kind: 'card', issue: 900 };
  const ctx = testCtx({ id: 'card-nodebt', task, config });

  const calls = [];
  const deps = { spawnSync: noLeftoversSpawnSync(calls) };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');
  // Exactly the 9 calls the very first WORKTREE test in this file pins -- no extra fetch, no
  // branch/status/merge/ancestry/install call ever appears when nothing is owed.
  assert.equal(calls.length, 9, 'no debt owed must mean no extra spawnStep calls at all');
  assert.deepEqual(calls[0], { command: 'git', args: ['-C', config.productRepo, 'fetch', 'origin'], cwd: undefined });

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event.startsWith('bench-debt-') || e.event === 'main-fast-forward-failed'));
});

test('realWorktree (B1.4 round 4): an OWED debt, idle bench, valid ancestry -- paid BEFORE any of WORKTREE\'s own calls, record cleared, bench-debt-paid journalled, and the card still reaches PLAN', async () => {
  const config = testConfig();
  const task = { id: 'card-debt-pay', kind: 'card', issue: 901 };
  const ctx = testCtx({ id: 'card-debt-pay', task, config });
  const journalRoot = path.dirname(ctx.taskDir);
  const owedSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  writeBenchReinstallOwed(journalRoot, { mergeSha: owedSha, prNumber: 777, issue: 700 });

  const calls = [];
  const deps = { spawnSync: debtPaySpawnSync(calls), readdirSync: benchDirFake([0], [0]) };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN', 'paying back an earlier card\'s debt must never block or park THIS card');

  // Exact ordering: the debt's own fetch/branch/status/merge/ancestry/install run FIRST, entirely
  // ahead of realWorktree's own fetch -- this is the "skip the preconditions before installing"
  // mutation's kill site, along with the argv assertions below.
  const debtCalls = calls.slice(0, 6);
  assert.deepEqual(debtCalls[0], { command: 'git', args: ['-C', config.productRepo, 'fetch', 'origin'], cwd: undefined });
  assert.deepEqual(debtCalls[1], {
    command: 'git',
    args: ['-C', config.productRepo, 'rev-parse', '--abbrev-ref', 'HEAD'],
    cwd: undefined,
  });
  assert.deepEqual(debtCalls[2], {
    command: 'git',
    args: ['-C', config.productRepo, 'status', '--porcelain', '--untracked-files=no'],
    cwd: undefined,
  });
  assert.deepEqual(debtCalls[3], {
    command: 'git',
    args: ['-C', config.productRepo, 'merge', '--ff-only', 'origin/main'],
    cwd: undefined,
  });
  assert.deepEqual(debtCalls[4], {
    command: 'git',
    args: ['-C', config.productRepo, 'merge-base', '--is-ancestor', owedSha, 'HEAD'],
    cwd: undefined,
  });
  assert.deepEqual(debtCalls[5], {
    command: 'bash',
    args: [path.join(config.productRepo, 'scripts', 'bench-install.sh')],
    cwd: config.productRepo,
  });
  // realWorktree's own sequence starts fresh right after, unaffected -- same shape as the
  // no-debt-owed test above.
  assert.deepEqual(calls[6], { command: 'git', args: ['-C', config.productRepo, 'fetch', 'origin'], cwd: undefined });
  assert.equal(calls.length, 6 + 9, 'the debt-repayment calls plus the ordinary WORKTREE sequence, nothing more');

  const owedAfter = readBenchReinstallOwed(journalRoot);
  assert.equal(owedAfter, null, 'the debt must be CLEARED once the install actually ran and succeeded');

  const journal = readJournal(ctx.taskDir);
  const paid = journal.find((e) => e.event === 'bench-debt-paid');
  assert.ok(paid, 'paying the debt must be journalled by its own name');
  assert.equal(paid.mergeSha, owedSha);
  assert.ok(journal.some((e) => e.event === 'main-fast-forwarded' && e.state === 'WORKTREE'));
  assert.ok(journal.some((e) => e.event === 'bench-reinstalled' && e.state === 'WORKTREE'));
});

test('realWorktree (B1.4 round 4): an OWED debt with a BUSY bench is left owed, journals bench-debt-still-busy, never installs, never blocks the card -- a single check, not a poll', async () => {
  const config = testConfig();
  const task = { id: 'card-debt-busy', kind: 'card', issue: 902 };
  const ctx = testCtx({ id: 'card-debt-busy', task, config });
  const journalRoot = path.dirname(ctx.taskDir);
  const owedSha = 'b'.repeat(40);
  writeBenchReinstallOwed(journalRoot, { mergeSha: owedSha, prNumber: 778, issue: 701 });

  let bashRan = false;
  const deps = {
    spawnSync: (command, args, opts) => {
      if (command === 'bash') bashRan = true;
      return debtPaySpawnSync([])(command, args, opts);
    },
    readdirSync: benchDirFake([1], [0]), // spool has one job -- busy
    sleep: () => {
      throw new Error('payBenchReinstallDebtIfOwed must never sleep/poll -- it checks ONCE and moves on');
    },
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN', 'a busy bench must never block or park the card paying the debt');
  assert.ok(!bashRan, 'a busy bench must never run the reinstall -- this is the "pay it while the bench is busy" mutation this test kills');

  const owedAfter = readBenchReinstallOwed(journalRoot);
  assert.ok(owedAfter, 'the debt must stay owed -- clearing it without installing is the "clear the debt without installing" mutation this test kills');
  assert.equal(owedAfter.mergeSha, owedSha);

  const journal = readJournal(ctx.taskDir);
  const busy = journal.find((e) => e.event === 'bench-debt-still-busy');
  assert.ok(busy, 'a busy bench at debt-repayment time must be journalled by its own name');
  assert.equal(busy.spool, 1);
  assert.equal(busy.running, 0);
  assert.equal(busy.mergeSha, owedSha);
});

test('realWorktree (B1.4 round 4): an OWED debt with an UNREADABLE bench dir is left owed, journals bench-debt-dir-unreadable, never installs, never blocks the card', async () => {
  const config = testConfig();
  const task = { id: 'card-debt-unreadable', kind: 'card', issue: 903 };
  const ctx = testCtx({ id: 'card-debt-unreadable', task, config });
  const journalRoot = path.dirname(ctx.taskDir);
  const owedSha = 'c'.repeat(40);
  writeBenchReinstallOwed(journalRoot, { mergeSha: owedSha, prNumber: 779, issue: 702 });

  let bashRan = false;
  const eacces = () => {
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    throw err;
  };
  const deps = {
    spawnSync: (command, args, opts) => {
      if (command === 'bash') bashRan = true;
      return debtPaySpawnSync([])(command, args, opts);
    },
    readdirSync: eacces,
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN', 'an unreadable bench dir must never block or park the card paying the debt');
  assert.ok(!bashRan);

  const owedAfter = readBenchReinstallOwed(journalRoot);
  assert.ok(owedAfter, 'the debt must stay owed when the bench dir cannot even be read');

  const journal = readJournal(ctx.taskDir);
  const unreadable = journal.find((e) => e.event === 'bench-debt-dir-unreadable');
  assert.ok(unreadable, 'an unreadable bench dir at debt-repayment time must be journalled by its own name');
  assert.equal(unreadable.code, 'EACCES');
});

test('realWorktree (B1.4 round 4): an OWED debt whose mergeSha is NOT an ancestor of the fast-forwarded HEAD is left owed, journals bench-debt-ancestry-check-failed, never installs -- defense in depth against a stale/corrupted record', async () => {
  const config = testConfig();
  const task = { id: 'card-debt-badancestry', kind: 'card', issue: 904 };
  const ctx = testCtx({ id: 'card-debt-badancestry', task, config });
  const journalRoot = path.dirname(ctx.taskDir);
  const owedSha = 'd'.repeat(40);
  writeBenchReinstallOwed(journalRoot, { mergeSha: owedSha, prNumber: 780, issue: 703 });

  let bashRan = false;
  const deps = {
    spawnSync: (command, args, opts) => {
      if (command === 'bash') bashRan = true;
      return debtPaySpawnSync([], { ancestryOk: false })(command, args, opts);
    },
    readdirSync: benchDirFake([0], [0]),
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');
  assert.ok(!bashRan, 'an unverified ancestry must never run the reinstall -- the "skip the preconditions before installing" mutation this test kills');

  const owedAfter = readBenchReinstallOwed(journalRoot);
  assert.ok(owedAfter, 'the debt must stay owed when its mergeSha cannot be confirmed as an ancestor of HEAD');

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'bench-debt-ancestry-check-failed');
  assert.ok(failed, 'a failed ancestry check must be journalled by its own name');
  assert.equal(failed.mergeSha, owedSha);
});

test('realWorktree (B1.4 round 4): an OWED debt whose fast-forward itself fails (dirty tree) is left owed, journals main-fast-forward-failed under WORKTREE, never installs, never parks', async () => {
  const config = testConfig();
  const task = { id: 'card-debt-dirty', kind: 'card', issue: 905 };
  const ctx = testCtx({ id: 'card-debt-dirty', task, config });
  const journalRoot = path.dirname(ctx.taskDir);
  const owedSha = 'e'.repeat(40);
  writeBenchReinstallOwed(journalRoot, { mergeSha: owedSha, prNumber: 781, issue: 704 });

  let bashRan = false;
  const deps = {
    spawnSync: (command, args, opts) => {
      if (command === 'bash') bashRan = true;
      return debtPaySpawnSync([], { dirty: true })(command, args, opts);
    },
    readdirSync: benchDirFake([0], [0]),
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN', 'a dirty product-repo checkout at debt-repayment time must never park THIS card -- only realFinish\'s OWN merge parks on a dirty tree');
  assert.ok(!bashRan, 'a failed fast-forward must never reach the install step -- the "skip the preconditions before installing" mutation this test kills');

  const owedAfter = readBenchReinstallOwed(journalRoot);
  assert.ok(owedAfter, 'the debt must stay owed when the fast-forward itself fails');

  const journal = readJournal(ctx.taskDir);
  const ffFailed = journal.find((e) => e.event === 'main-fast-forward-failed' && e.state === 'WORKTREE');
  assert.ok(ffFailed, 'a failed fast-forward during debt-repayment must still be journalled under WORKTREE, same vocabulary realFinish uses');
  assert.equal(ffFailed.reason, 'dirty');
  assert.ok(!journal.some((e) => e.event === 'bench-debt-paid'));
});

test('realWorktree (B1.4 round 4): an OWED debt whose reinstall itself FAILS (bench-install.sh exits non-zero) is left owed, journals bench-reinstall-failed under WORKTREE, never parks', async () => {
  const config = testConfig();
  const task = { id: 'card-debt-installfail', kind: 'card', issue: 906 };
  const ctx = testCtx({ id: 'card-debt-installfail', task, config });
  const journalRoot = path.dirname(ctx.taskDir);
  const owedSha = 'f'.repeat(40);
  writeBenchReinstallOwed(journalRoot, { mergeSha: owedSha, prNumber: 782, issue: 705 });

  const deps = {
    spawnSync: debtPaySpawnSync([], { installExit: 1 }),
    readdirSync: benchDirFake([0], [0]),
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN', 'a failed reinstall attempt must never park THIS card -- the next card\'s WORKTREE simply tries again');

  const owedAfter = readBenchReinstallOwed(journalRoot);
  assert.ok(owedAfter, 'clearing the debt on a FAILED install would be exactly the "clear the debt without installing [successfully]" mutation this test kills');
  assert.equal(owedAfter.mergeSha, owedSha);

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'bench-reinstall-failed' && e.state === 'WORKTREE');
  assert.ok(failed, 'a failed reinstall must be journalled under WORKTREE using the SAME event name realFinish uses');
  assert.ok(!journal.some((e) => e.event === 'bench-debt-paid'));
});

test('realWorktree (B1.4 R4, fifth pass F1): a TIMED-OUT bench-install.sh while paying an EARLIER card\'s debt never parks or crashes THIS card -- caught, journalled bench-debt-attempt-failed, debt stays owed', async () => {
  // The contract payBenchReinstallDebtIfOwed's own header, orchestrator/README.md and this spec
  // all claimed before this fix: "never parks or blocks the card, on any failure mode". That was
  // true only of NON-ZERO EXIT failures -- spawnStep converts a TIMEOUT into a thrown ParkSignal,
  // not an exit code, and an uncaught throw here would both park THIS card (over a debt it did not
  // create, on a reason -- bench-install-timed-out -- that is not on TRANSIENT_RETRY_REASONS, so
  // terminally) AND leave the debt owed, so the NEXT card's WORKTREE hits the same wedged
  // installer and parks the same way: a single stuck `bash scripts/bench-install.sh` would
  // terminally stall every card that starts. This test pins the fix.
  //
  // commandTimeoutsMs must actually name 'bench-install' -- spawnOnce only treats an ETIMEDOUT
  // fake result as a real timeout when a numeric deadline was armed (`deadlineArmed`); testConfig's
  // own default has no commandTimeoutsMs at all, which would silently make this ETIMEDOUT result
  // read as a plain exit failure instead, same shape test/real-steps.test.js:4671 already learned.
  const config = testConfig({ commandTimeoutsMs: { 'bench-install': 900000 } });
  const task = { id: 'card-debt-installtimeout', kind: 'card', issue: 907 };
  const ctx = testCtx({ id: 'card-debt-installtimeout', task, config });
  const journalRoot = path.dirname(ctx.taskDir);
  const owedSha = '1'.repeat(40);
  writeBenchReinstallOwed(journalRoot, { mergeSha: owedSha, prNumber: 783, issue: 706 });

  let bashRuns = 0;
  const deps = {
    spawnSync: (command, args, opts) => {
      if (command === 'bash') {
        bashRuns += 1;
        return timeoutResult();
      }
      return debtPaySpawnSync([])(command, args, opts);
    },
    readdirSync: benchDirFake([0], [0]),
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN', 'a wedged installer paying an EARLIER card\'s debt must never park or crash THIS card');
  assert.equal(bashRuns, 1, 'bench-install is never retried on a timeout -- spawnStep\'s own bench-install exemption');

  const owedAfter = readBenchReinstallOwed(journalRoot);
  assert.ok(owedAfter, 'the debt must stay owed when the install itself times out');
  assert.equal(owedAfter.mergeSha, owedSha);

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'bench-debt-attempt-failed');
  assert.ok(failed, 'a caught throw while paying the debt must be journalled by its own name, not silently swallowed');
  assert.equal(failed.reason, 'bench-install-timed-out');
  assert.equal(failed.mergeSha, owedSha);
  assert.ok(!journal.some((e) => e.event === 'bench-debt-paid'));
});

test('realWorktree (B1.4 R4, fifth pass F1): a TIMED-OUT git call (two consecutive timeouts) while paying an EARLIER card\'s debt never parks or crashes THIS card -- caught, journalled bench-debt-attempt-failed, debt stays owed', async () => {
  // Same deadlineArmed requirement as the bench-install test above -- 'git' must be a real key in
  // commandTimeoutsMs or the fake ETIMEDOUT result is read as a plain exit failure instead.
  const config = testConfig({ commandTimeoutsMs: { git: 120000 } });
  const task = { id: 'card-debt-gittimeout', kind: 'card', issue: 908 };
  const ctx = testCtx({ id: 'card-debt-gittimeout', task, config });
  const journalRoot = path.dirname(ctx.taskDir);
  const owedSha = '3'.repeat(40);
  writeBenchReinstallOwed(journalRoot, { mergeSha: owedSha, prNumber: 785, issue: 708 });

  let ancestryAttempts = 0;
  let bashRan = false;
  const deps = {
    spawnSync: (command, args, opts) => {
      if (command === 'git' && args.includes('merge-base') && args.includes('--is-ancestor')) {
        ancestryAttempts += 1;
        return timeoutResult();
      }
      if (command === 'bash') bashRan = true;
      return debtPaySpawnSync([])(command, args, opts);
    },
    readdirSync: benchDirFake([0], [0]),
  };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN', 'two timed-out git calls paying an EARLIER card\'s debt must never park or crash THIS card');
  assert.equal(ancestryAttempts, 2, 'a `git` command IS retried once before a second timeout parks -- pinning the ordinary retry policy still runs on this path');
  assert.ok(!bashRan, 'the ancestry check never resolved, so the reinstall must never run');

  const owedAfter = readBenchReinstallOwed(journalRoot);
  assert.ok(owedAfter, 'the debt must stay owed when the ancestry check itself times out');
  assert.equal(owedAfter.mergeSha, owedSha);

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'bench-debt-attempt-failed');
  assert.ok(failed, 'a caught throw while paying the debt must be journalled by its own name, not silently swallowed');
  assert.equal(failed.reason, 'git-timed-out');
  assert.equal(failed.mergeSha, owedSha);
  assert.ok(!journal.some((e) => e.event === 'bench-debt-paid'));
});

test('realWorktree (B1.4 R4, fifth pass F1): clearBenchReinstallOwed itself THROWING (a read-only journalRoot) while paying an EARLIER card\'s debt never crashes THIS card -- caught, journalled bench-debt-attempt-failed, debt stays owed', async () => {
  // The one vector that is NOT a ParkSignal: clearBenchReinstallOwed's own fs.writeFileSync/
  // renameSync raise a raw Error (park-signal.js's own header: runTask deliberately does NOT
  // convert a bare Error into a park, "a real bug -- surface it, do not disguise it as a park") --
  // so before this fix, an install that succeeded but then failed to CLEAR the record would crash
  // the worker outright rather than merely leave the debt owed for a retry.
  const config = testConfig();
  const task = { id: 'card-debt-clearfail', kind: 'card', issue: 909 };
  const ctx = testCtx({ id: 'card-debt-clearfail', task, config });
  const journalRoot = path.dirname(ctx.taskDir);
  const owedSha = '2'.repeat(40);
  writeBenchReinstallOwed(journalRoot, { mergeSha: owedSha, prNumber: 786, issue: 709 });

  const deps = {
    spawnSync: debtPaySpawnSync([]),
    readdirSync: benchDirFake([0], [0]),
  };

  // journalRoot itself (not ctx.taskDir, already created and independently writable) loses its
  // write bit -- clearBenchReinstallOwed's own tmp-file write inside journalRoot fails EACCES,
  // exactly as reproduced live against a real read-only journalRoot in the fourth-round audit.
  fs.chmodSync(journalRoot, 0o500);
  let next;
  try {
    next = await realWorktree(ctx, deps);
  } finally {
    fs.chmodSync(journalRoot, 0o700);
  }
  assert.equal(next, 'PLAN', 'a broken journalRoot must never crash the card paying an EARLIER card\'s debt');

  const owedAfter = readBenchReinstallOwed(journalRoot);
  assert.ok(owedAfter, 'the debt must stay owed when clearing the record itself fails -- clearing is what would otherwise have marked it paid');
  assert.equal(owedAfter.mergeSha, owedSha);

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'bench-debt-attempt-failed');
  assert.ok(failed, 'a raw Error thrown by clearBenchReinstallOwed must be caught and journalled, not left to crash the worker');
  assert.equal(failed.reason, 'EACCES');
  assert.ok(!journal.some((e) => e.event === 'bench-debt-paid'), 'bench-debt-paid must not be journalled when clearing itself failed');
});

test('realWorktree: payBenchReinstallDebtIfOwed is wired into runScanCycle\'s replacement (WORKTREE) -- deleting the call from realWorktree must be caught, not merely unit-tested in isolation', async () => {
  // Source-level guard, same shape as test/worker-mode.test.js's config-literal guards: an owed
  // debt that a future edit accidentally stops calling would otherwise only be caught by the
  // tests above still passing (which they would NOT, since they call realWorktree directly) --
  // this pins that the WIRING itself -- the call site inside realWorktree's own lock span --
  // still exists in source, the "never pay the debt at WORKTREE" mutation's kill site.
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'steps', 'scripted.js'), 'utf8');
  const worktreeFnStart = src.indexOf('async function realWorktree(');
  assert.notEqual(worktreeFnStart, -1);
  const worktreeFnBody = src.slice(worktreeFnStart, src.indexOf('\n}\n', worktreeFnStart));
  assert.match(
    worktreeFnBody,
    /await payBenchReinstallDebtIfOwed\(ctx, deps, config\)/,
    'realWorktree must call payBenchReinstallDebtIfOwed -- deleting this call site is the "never pay the debt at WORKTREE" mutation'
  );
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

// ---- GATE, action B3.4: done/<jobId>.json splits the collapsed exit-1 causes ------------------
//
// `worker.ts`'s `NON_ATTESTING = {DIRTY, ENVIRONMENT, ABANDONED}` plus INTERRUPTED
// (`recoverInterrupted` never writes `verdicts/<sha>.json` at all) all fall into today's
// undifferentiated `gate-non-attesting` when no `verdicts/<sha>.json` entry exists for HEAD --
// see steps/scripted.js's own B3.4 header comment. Four tests, one shared shape: `npm run gate`
// exits 1, prints a job id at deposit (captured in stdout, exactly as the real CLI does), no
// `verdicts/<sha>.json` exists for HEAD, but a real, well-shaped `done/<jobId>.json` names which
// of the four this actually was.

function gateJobStdout(jobId) {
  return `job ${jobId} queued (ref, position 1)\nreport will land in <spoBenchDir>/done/${jobId}.json\n`;
}

const B34_VERDICT_CASES = [
  ['ENVIRONMENT', 'gate-environment', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'job-00000000000001-aaaaaa'],
  ['DIRTY', 'gate-worker-dirty-checkout', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'job-00000000000002-bbbbbb'],
  ['ABANDONED', 'gate-abandoned', 'cccccccccccccccccccccccccccccccccccccccc', 'job-00000000000003-cccccc'],
  ['INTERRUPTED', 'gate-interrupted', 'dddddddddddddddddddddddddddddddddddddddd', 'job-00000000000004-dddddd'],
];

for (const [verdict, expectedReason, headSha, jobId] of B34_VERDICT_CASES) {
  test(`realGate (action B3.4): exit 1, no verdicts/<sha>.json, done/<jobId>.json verdict ${verdict} -> PARKED ${expectedReason}, not the collapsed gate-non-attesting`, async () => {
    const config = testConfig();
    const worktreePath = mkTmp('spo-real-gate-b34-wt-');
    const task = { id: `card-b34-${verdict}`, kind: 'card', issue: 910, worktreePath };
    const ctx = testCtx({ id: `card-b34-${verdict}`, task, config });

    writeJson(path.join(config.spoBenchDir, 'done', `${jobId}.json`), {
      id: jobId,
      type: 'ref',
      worktree: '/fake/checkout',
      branch: 'main',
      verdict,
      fingerprints: { atSubmit: { head: headSha, hash: 'x', clean: true } },
      targetMoved: false,
      startedAt: '2026-09-03T00:00:00.000Z',
      detail: `synthetic ${verdict} detail for the B3.4 test`,
    });

    const deps = {
      spawnSync: (command, args) => {
        if (args.includes('gate')) return { status: 1, stdout: gateJobStdout(jobId), stderr: '', signal: null };
        if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
        return ok('');
      },
    };

    await assert.rejects(
      () => realGate(ctx, deps),
      (err) => err instanceof ParkSignal && err.reason === expectedReason
    );

    const journal = readJournal(ctx.taskDir);
    const readEvent = journal.find((e) => e.event === 'gate-job-report-read');
    assert.ok(readEvent, 'expected a gate-job-report-read journal event');
    assert.equal(readEvent.jobId, jobId);
    assert.equal(readEvent.skipped, null);
    assert.equal(readEvent.verdict, verdict);
    assert.ok(
      !journal.some((e) => e.event === 'gate-non-attesting'),
      'the split reason must fire INSTEAD of gate-non-attesting, not alongside it'
    );
  });
}

// STALE is already written to verdicts/<sha>.json (it is not in NON_ATTESTING) -- unlike the four
// above, this used to fall through to the generic `return 'DIAGNOSE'` at the end of realGate's
// exit-1 block, spending a judge call on a body verdict ("the tree changed mid-run") that no
// longer describes any tree that exists. done/<jobId>.json is read best-effort here purely to
// enrich the park's `jobDetail` -- STALE itself is already known without it.
test('realGate (action B3.4): exit 1, verdicts/<sha>.json verdict STALE -> PARKED gate-stale (never DIAGNOSE), enriched with the job report\'s own detail text', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-gate-stale-wt-');
  const headSha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const jobId = 'job-00000000000005-eeeeee';
  const task = { id: 'card-b34-stale', kind: 'card', issue: 911, worktreePath };
  const ctx = testCtx({ id: 'card-b34-stale', task, config });

  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'STALE' });
  writeJson(path.join(config.spoBenchDir, 'done', `${jobId}.json`), {
    id: jobId,
    verdict: 'STALE',
    detail: 'the tree changed between deposit and the end of the run -- resubmit',
  });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('gate')) return { status: 1, stdout: gateJobStdout(jobId), stderr: '', signal: null };
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      return ok('');
    },
  };

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'gate-stale' && err.detail.jobDetail === 'the tree changed between deposit and the end of the run -- resubmit'
  );
});

// ---- GATE, action B3.4: the richer read must fall back SAFELY -- never a new failure mode -----
//
// Four shapes, one property each: `done/<jobId>.json` missing, malformed JSON, a JSON array, and
// a JSON `null` must ALL leave the outcome exactly what it was before this action
// (`gate-non-attesting`, same detail shape) and journal WHY the richer read did not apply. The
// array/null cases are the exact hazard named in this action's own brief -- a bookkeeping file
// parsed with no shape guard turning a good gate into a false park elsewhere in this same
// chantier.
const B34_FALLBACK_CASES = [
  ['missing (no done/<jobId>.json written at all)', 'missing', undefined],
  ['malformed (invalid JSON syntax)', 'malformed', '{not valid json'],
  ['a JSON array (parses fine, is not the JobReport object shape)', 'wrong-shape', '[1,2,3]'],
  ['a JSON null (parses fine, is not the JobReport object shape)', 'wrong-shape', 'null'],
];

for (const [label, expectedSkipped, rawContent] of B34_FALLBACK_CASES) {
  test(`realGate (action B3.4): done/<jobId>.json ${label} -> falls back to gate-non-attesting exactly as before this action, journalled skipped:'${expectedSkipped}'`, async () => {
    const config = testConfig();
    const worktreePath = mkTmp('spo-real-gate-b34fallback-wt-');
    const headSha = 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0';
    const jobId = 'job-00000000000006-f0f0f0';
    const id = `card-b34-fallback-${expectedSkipped}-${B34_FALLBACK_CASES.findIndex((c) => c[1] === expectedSkipped && c[2] === rawContent)}`;
    const task = { id, kind: 'card', issue: 912, worktreePath };
    const ctx = testCtx({ id, task, config });

    if (rawContent !== undefined) {
      const donePath = path.join(config.spoBenchDir, 'done', `${jobId}.json`);
      fs.mkdirSync(path.dirname(donePath), { recursive: true });
      fs.writeFileSync(donePath, rawContent);
    }

    const deps = {
      spawnSync: (command, args) => {
        if (args.includes('gate')) return { status: 1, stdout: gateJobStdout(jobId), stderr: '', signal: null };
        if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
        return ok('');
      },
    };

    await assert.rejects(
      () => realGate(ctx, deps),
      (err) => err instanceof ParkSignal && err.reason === 'gate-non-attesting' && err.detail.headSha === headSha
    );

    const journal = readJournal(ctx.taskDir);
    const readEvent = journal.find((e) => e.event === 'gate-job-report-read');
    assert.ok(readEvent, 'expected a gate-job-report-read journal event even on a failed read');
    assert.equal(readEvent.jobId, jobId);
    assert.equal(readEvent.skipped, expectedSkipped);
    assert.equal(readEvent.verdict, null, 'a failed/unusable read must never surface a verdict, even a wrong one');
  });
}

test("realGate (action B3.4): no job id in npm run gate's stdout at all (the pre-existing gate-legs-reachability fixture shape) -> falls back exactly as before, journalled skipped:'no-job-id'", async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-gate-b34-nojobid-wt-');
  const headSha = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
  const task = { id: 'card-b34-nojobid', kind: 'card', issue: 913, worktreePath };
  const ctx = testCtx({ id: 'card-b34-nojobid', task, config });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('gate')) return fail(1); // empty stdout -- no "job ... queued" line
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      return ok('');
    },
  };

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'gate-non-attesting'
  );

  const readEvent = readJournal(ctx.taskDir).find((e) => e.event === 'gate-job-report-read');
  assert.ok(readEvent);
  assert.equal(readEvent.jobId, null);
  assert.equal(readEvent.skipped, 'no-job-id');
});

// ---- GATE, action B3.4: exit 2/3 sub-causes named from the CLI's own printed stderr -----------
//
// No job id exists to read a done/<jobId>.json by for any of these -- see the GATE row of
// doc/state-machine-spec.md and steps/scripted.js's own comment on this block for why. The route
// stays exit-code-only (Principle 1); only the park's NAME is refined by matching the literal,
// stable diagnostic text scripts/bench-gate.sh / scripts/bench-submit.sh / cli.ts already print.
for (const [exit, stderrText, expectedReason] of [
  [2, 'NOT PUSHED: abc12345 is not on origin, so the worker cannot fetch it.\n', 'gate-not-pushed'],
  [2, 'This worktree already has job job-1-abc (ref) waiting in the queue.\n', 'gate-duplicate-job'],
  [2, 'DIRTY TREE: this worktree has uncommitted or untracked changes.\n', 'gate-dirty-tree'],
  [3, "bench client not built at /home/x/SPO-WebClient/dist/e2e/bench/cli.js -- run 'npm run build:e2e'\n", 'gate-worker-not-built'],
  [3, 'WORKER DIED while job job-1-abc was pending: heartbeat stale\n', 'gate-worker-died-midjob'],
  [3, 'WORKER DOWN: worker pid 12345 is not running\n', 'gate-worker-down'],
]) {
  test(`realGate (action B3.4): exit ${exit}, stderr "${stderrText.slice(0, 40).trim()}..." -> PARKED ${expectedReason}`, async () => {
    const config = testConfig();
    const worktreePath = mkTmp('spo-real-gate-b34-exit23-wt-');
    const task = { id: `card-b34-exit${exit}-${expectedReason}`, kind: 'card', issue: 914, worktreePath };
    const ctx = testCtx({ id: `card-b34-exit${exit}-${expectedReason}`, task, config });
    const deps = { spawnSync: (command, args) => (args.includes('gate') ? fail(exit, stderrText) : ok('')) };

    await assert.rejects(
      () => realGate(ctx, deps),
      (err) => err instanceof ParkSignal && err.reason === expectedReason && err.detail.exit === exit
    );
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
  assert.equal(ctx.counters.mainMoveUsed, 1); // action 6.5: a count now, not a boolean
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
  ctx.counters.mainMoveUsed = 1; // action 6.5: at the default budget of 1, this task's move is already spent
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

// ---- action 6.5: the main-moved counter is now compared against config.mainMovedRegateBudget
// (default 1, unchanged behaviour) instead of a hardcoded "once" -- see main-moved-budget.js and
// config.js's own mainMovedRegateBudget comment for the settled decision and the corpus this
// default rests on.

test('realCiChecks: mainMovedRegateBudget raised to 2 -> two re-gates succeed, a third parks main-moved-twice', async () => {
  const ctx = ciCtx({ config: testConfig({ mainMovedRegateBudget: 2 }) });
  const headSha = 'headshaDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { baseMain: 'basemainsha' });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      if (args.includes('diff')) return ok('shared/file.ts\n');
      return ok('');
    },
  };

  assert.equal(await realCiChecks(ctx, deps), 'CHECK', 'first move: under budget 2');
  assert.equal(ctx.counters.mainMoveUsed, 1);

  assert.equal(await realCiChecks(ctx, deps), 'CHECK', 'second move: still under budget 2');
  assert.equal(ctx.counters.mainMoveUsed, 2);

  await assert.rejects(
    () => realCiChecks(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'main-moved-twice' &&
      err.detail.mainMoveUsed === 2 &&
      err.detail.mainMovedRegateBudget === 2,
    'third move: budget of 2 is spent'
  );
});

test('realGate and realCiChecks share ctx.counters.mainMoveUsed -- a move GATE spends counts against CI_CHECKS\' own budget on the same task (action 4.2\'s sharing, still true under action 6.5\'s counter)', async () => {
  const worktreePath = mkTmp('spo-shared-mainmoved-wt-');
  const config = testConfig({ mainMovedRegateBudget: 1 });
  const task = { id: 'card-shared-mm', kind: 'card', issue: 501, worktreePath };
  const ctx = testCtx({ id: 'card-shared-mm', task, config });

  // realGate (unlike realCiChecks) shape-checks HEAD's rev-parse output against
  // /^[0-9a-f]{7,64}$/ (action 4.1's measurement) -- must be genuine lowercase hex, not the
  // readable-but-invalid placeholders realCiChecks' own tests use below.
  const gateHeadSha = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${gateHeadSha}.json`), { verdict: 'FAIL' });
  const gateDeps = {
    spawnSync: (command, args) => {
      if (args.includes('run') && args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${gateHeadSha}\n`);
      if (args.includes('fetch')) return ok('');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('freshoriginmainsha\n');
      if (args.includes('merge')) return ok('');
      return ok('');
    },
  };

  assert.equal(await realGate(ctx, gateDeps), 'CHECK', 'GATE spends the one move this task has under budget 1');
  assert.equal(ctx.counters.mainMoveUsed, 1);

  const ciHeadSha = 'cishaEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${ciHeadSha}.json`), { baseMain: 'basemainsha' });
  const ciDeps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${ciHeadSha}\n`);
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      if (args.includes('diff')) return ok('shared/file.ts\n');
      return ok('');
    },
  };

  // CI_CHECKS reads the SAME ctx.counters: GATE already spent this task's one move under budget
  // 1, so CI_CHECKS' own main-moved test must park rather than merge again -- one shared budget
  // per task, not one each.
  await assert.rejects(
    () => realCiChecks(ctx, ciDeps),
    (err) => err instanceof ParkSignal && err.reason === 'main-moved-twice'
  );
  assert.equal(ctx.counters.mainMoveUsed, 1, 'a refused move must not itself spend any more of the budget');
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

// action 7.1: fetchCheckRuns' own try/catch around JSON.parse(checkRuns.stdout) -- `gh api` can
// return a non-JSON body on a transient GitHub error (a 502 HTML page, a truncated response), and
// that must degrade to "zero runs" (the same in-flight/re-poll treatment the "zero check-runs
// registered" case above already exercises), never an uncaught SyntaxError bubbling out of
// realCiChecks and crashing the task on what is, from the caller's perspective, exactly the same
// shape of transient hiccup a genuinely-empty check_runs array already handles cleanly.
test('realCiChecks: gh api check-runs stdout that is not parsable JSON is treated as zero runs (in-flight, re-poll), never an uncaught parse error', async () => {
  const config = testConfig({ ciChecksMaxPolls: 4, ciChecksPollIntervalMs: 750 });
  const ctx = ciCtx({ config });
  const headSha = 'headshaGARBAGEJSON44444444444444444444444';
  let apiCalls = 0;
  const sleeps = [];
  const deps = noSleepDeps((command, args) => {
    if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
    if (command === 'gh' && args[0] === 'api') {
      apiCalls += 1;
      // Not JSON at all -- stands in for a 502/proxy-error body `gh api` can hand back verbatim.
      if (apiCalls === 1) return ok('<html><body>502 Bad Gateway</body></html>');
      return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
    }
    return ok('');
  }, sleeps);

  const next = await realCiChecks(ctx, deps);

  assert.equal(next, 'VALIDATE', 'an unparsable fetch must never itself abort the call -- it just re-polls');
  assert.equal(apiCalls, 2, 'the unparsable response must trigger exactly one re-poll, same as an empty check_runs array');
  assert.deepEqual(sleeps, [750]);

  const journal = readJournal(ctx.taskDir);
  const inFlight = journal.find((e) => e.event === 'checks-in-flight');
  assert.ok(inFlight, 'expected the in-flight observation to be journalled on the unparsable fetch');
  assert.equal(inFlight.totalRuns, 0, 'unparsable JSON must be treated as ZERO check runs, not a crash and not a fabricated count');
  assert.ok(journal.some((e) => e.event === 'checks-green'), 'the second, parsable poll must still resolve normally');
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

// action 7.1: the fallthrough below exits 0/1/4 -- an exit realMerge has never seen from `npm run
// pr:wait` in production, but the fallthrough exists precisely because a script's exit code is not
// a closed set this code controls. Exit 9 is arbitrary and distinct from every other case in this
// section (0/1/4) so this cannot pass by accident of matching one of the real branches.
test('realMerge: pr:wait exit 9 (unrecognized) -> PARKED pr-wait-unrecognized-exit, no bounded re-wait attempted', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-merge-wt4-');
  const task = { id: 'card-merge4', kind: 'card', issue: 113, worktreePath };
  const ctx = testCtx({ id: 'card-merge4', task, config });
  ctx.prNumber = 444;

  let waitCalls = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('pr:wait')) {
        waitCalls += 1;
        return fail(9);
      }
      return ok('');
    },
  };

  await assert.rejects(
    () => realMerge(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'pr-wait-unrecognized-exit' && err.detail.exit === 9
  );
  assert.equal(waitCalls, 1, 'exit 9 is not exit 4 -- the bounded re-wait is reserved for "still open", never a third state');
});

// ---- FINISH ---------------------------------------------------------------------------------
//
// Action B1.4 gave realFinish a new preamble (inside a FIRST, separate product-repo-lock
// acquisition, phase 'finish-sync'): fetch, look up this card's own merge commit by PR number
// (`gh pr view`), check whether the merge touched the bench worker (`git diff --name-only`),
// fast-forward config.productRepo (branch/dirty checks + `git merge --ff-only`), and -- only when
// the merge touched the bench worker AND the fast-forward succeeded -- reinstall it. Every test
// below this point that predates that action is about board-move/issue-comment/worktree-remove,
// not this new preamble -- `finishSyncOk` below gives every one of them a default happy path for
// it (on `main`, clean, fast-forwardable, merge touched nothing under src/e2e/bench/ or
// scripts/bench-) so their OWN assertions keep meaning what they always meant, and
// `isPostSyncCall` lets a test that records every spawnStep call filter down to just the three
// calls it actually cares about, exactly as if the preamble were not there.

// finishSyncOk(overrideFn) -- `overrideFn(command, args)` is checked FIRST (same override-then-
// fallback convention noLeftoversSpawnSync already uses elsewhere in this file); returning a
// falsy value falls through to the happy-path default below. The only two calls needing anything
// beyond a bare `ok('')` are the branch check (must say 'main', not empty) and the merge-sha
// lookup (must be valid JSON, or JSON.parse throws and the whole preamble parks
// 'merge-sha-lookup' before ever reaching board-move) -- fetch/status/merge/diff all read a
// correct "nothing to see here" from a bare success with empty stdout.
function finishSyncOk(overrideFn) {
  return (command, args, opts) => {
    if (overrideFn) {
      const overridden = overrideFn(command, args, opts);
      if (overridden) return overridden;
    }
    if (command === 'git' && args.includes('rev-parse') && args.includes('--abbrev-ref')) return ok('main\n');
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return ok(JSON.stringify({ mergeCommit: { oid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } }));
    }
    return ok('');
  };
}

// isPostSyncCall(args) -- true for exactly the three calls the PRE-B1.4 tests below were written
// to observe (board:move, the issue comment, `git worktree remove`), false for anything in the
// new finish-sync preamble. `args.includes('view')` on its own would also match nothing else here
// (no other FINISH call passes 'view'), so this stays a plain OR of three narrow, specific checks
// rather than an exclusion list that would have to be updated every time the preamble grows.
function isPostSyncCall(args) {
  return args.includes('board:move') || args.includes('comment') || (args.includes('worktree') && args.includes('remove'));
}

test('realFinish: board:move, then gh issue comment, then git worktree remove --force, in order; sums llm billableTokens', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-wt-');
  const task = { id: 'card-finish1', kind: 'card', issue: 120, worktreePath };
  const ctx = testCtx({ id: 'card-finish1', task, config });
  ctx.prNumber = 444;

  appendEvent(ctx.taskDir, 'PLAN', 'llm-call', { billableTokens: 1000 });
  appendEvent(ctx.taskDir, 'IMPLEMENT', 'llm-call', { billableTokens: 2500 });

  const calls = [];
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (isPostSyncCall(args)) calls.push({ command, args: [...args] });
      return null;
    }),
  };

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
  ctx.prNumber = 121;

  const calls = [];
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (isPostSyncCall(args)) calls.push(args);
      if (args.includes('board:move')) return fail(1);
      return null;
    }),
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
  ctx.prNumber = 122;

  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (args.includes('board:move')) return ok('');
      if (args.includes('comment')) return fail(1);
      return null;
    }),
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

// ---- action B1.4: fast-forward config.productRepo, then (conditionally) reinstall the bench
// worker -- the behaviours that must fail LOUDLY when removed, per this action's own design
// constraint, not merely pass today. ------------------------------------------------------------

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('realFinish (action B1.4): a merge touching src/e2e/bench/worker.ts runs the reinstall, AFTER the fast-forward -- asserted on the actual argv and the ordering', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-bench1-');
  const task = { id: 'card-bench1', kind: 'card', issue: 1001, worktreePath };
  const ctx = testCtx({ id: 'card-bench1', task, config });
  ctx.prNumber = 1001;

  const order = [];
  let installArgs = null;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'git' && args.includes('merge') && args.includes('--ff-only')) order.push('fast-forward');
      if (command === 'bash') {
        order.push('reinstall');
        installArgs = [...args];
      }
      return null;
    }),
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE');

  assert.deepEqual(order, ['fast-forward', 'reinstall'], 'the fast-forward must run, and succeed, BEFORE the reinstall ever does');
  assert.ok(installArgs, 'bash scripts/bench-install.sh must actually have been spawned');
  assert.deepEqual(installArgs, [path.join(config.productRepo, 'scripts', 'bench-install.sh')]);

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'main-fast-forwarded'), 'the fast-forward success must be journalled by name');
  assert.ok(journal.some((e) => e.event === 'bench-reinstalled'), 'the reinstall success must be journalled by name');
});

// ---- D2 (adversarial verification): mutation M14 -- dropping the '^' from `${mergeSha}^` left
// the diff range empty, benchTouched permanently false, and the ENTIRE reinstall silently
// disabled -- with all 1572 pre-existing tests staying green, because every fake matches on
// `diff` + `--name-only` alone and never inspects the revs themselves. Assert the actual argv,
// both revisions included, so a caret dropped (or a rev swapped, or a third rev appended) cannot
// survive unnoticed again.
test("realFinish (action B1.4): the merge-diff call's actual argv is `git -C <productRepo> diff --name-only <mergeSha>^ <mergeSha>` -- both revisions, caret included, asserted directly (not just 'a diff call happened')", async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-diffargv-');
  const task = { id: 'card-diffargv', kind: 'card', issue: 1009, worktreePath };
  const ctx = testCtx({ id: 'card-diffargv', task, config });
  ctx.prNumber = 1009;

  let diffArgs = null;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) {
        diffArgs = [...args];
      }
      return null;
    }),
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE');

  assert.ok(diffArgs, 'the merge-diff call must actually have been spawned');
  // finishSyncOk's own gh pr view fake always answers with this exact sha.
  const mergeSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  assert.deepEqual(
    diffArgs,
    ['-C', config.productRepo, 'diff', '--name-only', `${mergeSha}^`, mergeSha],
    'both revisions must be present, in order, with the caret on the FIRST one -- a caret dropped ' +
      '(diff range collapses to empty, benchTouched permanently false, reinstall silently never ' +
      'runs) or a rev swapped/duplicated must fail this even though every OTHER test here only ' +
      "matches on the call happening at all, never its actual revs"
  );
});

test('realFinish (action B1.4): a merge touching NOTHING under src/e2e/bench/ or scripts/bench- does NOT run the reinstall', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-bench2-');
  const task = { id: 'card-bench2', kind: 'card', issue: 1002, worktreePath };
  const ctx = testCtx({ id: 'card-bench2', task, config });
  ctx.prNumber = 1002;

  const calls = [];
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) {
        return ok('src/client/App.tsx\ndoc/README.md\n');
      }
      return null;
    }),
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE');
  assert.ok(!calls.some((c) => c.command === 'bash'), 'no `bash` call at all -- the reinstall must never even be attempted');

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'bench-reinstall-skipped'), 'the skip must be journalled by name, not merely absent from the log');
});

test("realFinish (action B1.4): a merge touching scripts/bench-install.sh itself ALSO runs the reinstall -- the 'scripts/bench-' half of the pattern, kept as its own test rather than sharing one with the src/e2e/bench/ half", async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-bench3-');
  const task = { id: 'card-bench3', kind: 'card', issue: 1003, worktreePath };
  const ctx = testCtx({ id: 'card-bench3', task, config });
  ctx.prNumber = 1003;

  let installRan = false;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('scripts/bench-install.sh\n');
      if (command === 'bash') installRan = true;
      return null;
    }),
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE');
  assert.ok(installRan, "a change to scripts/bench-install.sh itself must trip the 'scripts/bench-' half of the path match");
});

// ---- post-verification hazard fix: waitForBenchIdle, ahead of the reinstall -------------------
//
// bench-install.sh ends in an unconditional `systemctl --user restart spo-bench-worker.service`;
// this daemon runs K=2 in production, so reinstalling while the bench is still busy can cut a
// SIBLING card's in-flight GATE. These three tests are the minimum the fix's own instructions
// call for: an idle bench never waits at all, a busy bench defers and then proceeds once it
// drains, and a bench that never drains hits the bound and PARKS rather than reinstalling anyway
// or silently skipping (see waitForBenchIdle's own header in steps/scripted.js).

// benchDirFake(spoolCounts, runningCounts) -- deps.readdirSync stand-in. Each call to
// readdirSync(<spoBenchDir>/spool) consumes the next entry of `spoolCounts` (an array of ENTRY
// COUNTS, one per poll -- e.g. [2, 1, 0] means "2 queued, then 1, then drained"), clamped to the
// last element once exhausted; `running` works the same way off `runningCounts`. Throws for
// anything else, matching countDirEntries' own "missing directory -> 0" contract being exercised
// by every OTHER bench test via a real (but empty, never-created) tmp dir instead.
function benchDirFake(spoolCounts, runningCounts) {
  let spoolCalls = 0;
  let runningCalls = 0;
  return (dir) => {
    const base = path.basename(dir);
    if (base === 'spool') {
      const n = spoolCounts[Math.min(spoolCalls, spoolCounts.length - 1)];
      spoolCalls += 1;
      return Array.from({ length: n }, (_, i) => `job-${i}`);
    }
    if (base === 'running') {
      const n = runningCounts[Math.min(runningCalls, runningCounts.length - 1)];
      runningCalls += 1;
      return Array.from({ length: n }, (_, i) => `job-${i}`);
    }
    const err = new Error(`ENOENT: benchDirFake does not know directory ${dir}`);
    err.code = 'ENOENT';
    throw err;
  };
}

// ---- W2 (post-verification, third pass): benchQueueDepth must read config.spoBenchDir, and an
// UNREADABLE bench dir must never be silently read as "idle" -- see countDirEntries'/
// benchQueueDepth's own header in steps/scripted.js for the full rationale (a misconfigured
// SPO_BENCH_DIR used to reduce the whole guard to a no-op while the suite stayed green). --------

test('benchQueueDepth: reads config.spoBenchDir specifically, not a hardcoded or derived path', () => {
  const dirsRead = [];
  const config = { spoBenchDir: '/a/distinctive/bench/dir/nobody/else/would/pick' };
  const deps = {
    readdirSync: (dir) => {
      dirsRead.push(dir);
      return [];
    },
  };
  const depth = benchQueueDepth(deps, config);
  assert.equal(depth.spool, 0);
  assert.equal(depth.running, 0);
  assert.equal(depth.error, null);
  assert.deepEqual(dirsRead.sort(), [
    path.join(config.spoBenchDir, 'running'),
    path.join(config.spoBenchDir, 'spool'),
  ]);
});

test('benchQueueDepth: a MISSING subdirectory (ENOENT) reads as an honest 0, no error -- "no bench installed" and "never spooled a job" are both legitimate', () => {
  const config = { spoBenchDir: mkTmp('spo-real-benchqd-enoent-') };
  const deps = {}; // no deps.readdirSync override -- exercises the REAL fs.readdirSync against a genuinely empty tmp dir
  const depth = benchQueueDepth(deps, config);
  assert.deepEqual(depth, { spool: 0, running: 0, error: null });
});

test('benchQueueDepth: an UNREADABLE subdirectory (EACCES, or any error other than ENOENT) is reported as an error, NEVER silently collapsed to 0 -- the guard must not become a no-op on a misconfigured or permission-denied bench dir', () => {
  const config = { spoBenchDir: '/wherever' };
  const deps = {
    readdirSync: (dir) => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  const depth = benchQueueDepth(deps, config);
  assert.equal(depth.spool, 0);
  assert.equal(depth.running, 0);
  assert.ok(depth.error, 'a non-ENOENT read failure must be surfaced, never swallowed as "idle"');
  assert.equal(depth.error.code, 'EACCES');
});

test('realFinish (W2, post-verification third pass): an UNREADABLE bench dir PARKS finish-failed/bench-idle-wait/bench-dir-unreadable IMMEDIATELY -- distinguishable from a merely BUSY bench (which defers, never parks) -- no sleep, no reinstall attempted, and no owed record written (this is a park, not a defer)', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-benchunreadable-');
  // Isolated journalRoot -- the default testCtx taskDir lands directly under os.tmpdir(), shared
  // by every other default-taskDir test in this file, which would make the "no owed record"
  // assertion below meaningless if another test's leftover file happened to still be there.
  const journalRoot = mkTmp('spo-real-finish-benchunreadable-root-');
  const taskDir = path.join(journalRoot, 'card-benchunreadable');
  fs.mkdirSync(taskDir, { recursive: true });
  const task = { id: 'card-benchunreadable', kind: 'card', issue: 1016, worktreePath };
  const ctx = testCtx({ id: 'card-benchunreadable', task, config, taskDir });
  ctx.prNumber = 1016;

  const sleeps = [];
  let installRan = false;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'bash') installRan = true;
      return null;
    }),
    readdirSync: () => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'finish-failed' &&
      err.detail.step === 'bench-idle-wait' &&
      err.detail.reason === 'bench-dir-unreadable' &&
      err.detail.code === 'EACCES'
  );
  assert.ok(!installRan, 'the reinstall must never be attempted against an unreadable bench dir');
  assert.deepEqual(sleeps, [], 'an unreadable bench dir must be reported on the FIRST read -- no pointless polling of a directory that will never become readable by waiting');

  const journal = readJournal(ctx.taskDir);
  const unreadable = journal.find((e) => e.event === 'bench-dir-unreadable');
  assert.ok(unreadable, 'the unreadable dir must be journalled by its own name, distinct from bench-busy-wait/bench-idle-wait-timed-out');
  assert.equal(unreadable.code, 'EACCES');
  assert.ok(!journal.some((e) => e.event === 'bench-busy-wait' || e.event === 'bench-idle-wait-timed-out' || e.event === 'bench-reinstall-deferred'));

  const owed = readBenchReinstallOwed(journalRoot);
  assert.equal(owed, null, 'a PARK (unreadable dir) must never also write a durable owed record -- that record is exclusively for the DEFER path');
});

test('realFinish (hazard fix): an IDLE bench (the default -- spool and running both empty) reinstalls immediately, with NO wait and NO bench-busy-wait events', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-benchidle-');
  const task = { id: 'card-benchidle', kind: 'card', issue: 1012, worktreePath };
  const ctx = testCtx({ id: 'card-benchidle', task, config });
  ctx.prNumber = 1012;

  const sleeps = [];
  let installRan = false;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'bash') installRan = true;
      return null;
    }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE');
  assert.ok(installRan, 'the reinstall must still run once the bench is confirmed idle');
  assert.deepEqual(sleeps, [], 'an already-idle bench must never sleep at all');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'bench-busy-wait'), 'an already-idle bench must never journal a busy-wait poll');
  const idle = journal.find((e) => e.event === 'bench-idle');
  assert.ok(idle, 'the idle confirmation must be journalled by name');
  assert.equal(idle.attempts, 0, 'zero busy-wait attempts when the bench was already idle on the first check');
});

test('realFinish (hazard fix): a BUSY bench defers (journals bench-busy-wait, actually sleeps between polls) and then proceeds once it drains -- reinstall still runs', async () => {
  const config = testConfig({ benchIdleWaitMaxPolls: 5, benchIdleWaitPollIntervalMs: 10 });
  const worktreePath = mkTmp('spo-real-finish-benchbusy-');
  const task = { id: 'card-benchbusy', kind: 'card', issue: 1013, worktreePath };
  const ctx = testCtx({ id: 'card-benchbusy', task, config });
  ctx.prNumber = 1013;

  const sleeps = [];
  let installRan = false;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'bash') installRan = true;
      return null;
    }),
    // Busy (1 running job) for the first two polls, drained by the third.
    readdirSync: benchDirFake([0, 0, 0], [1, 1, 0]),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE');
  assert.ok(installRan, 'the reinstall must run once the bench actually drains');
  assert.deepEqual(sleeps, [10, 10], 'must sleep exactly once per busy poll, at the configured interval');

  const journal = readJournal(ctx.taskDir);
  const busyEvents = journal.filter((e) => e.event === 'bench-busy-wait');
  assert.equal(busyEvents.length, 2, 'exactly two busy polls must be journalled before the bench drains');
  assert.equal(busyEvents[0].attempt, 1);
  assert.equal(busyEvents[1].attempt, 2);
  const idle = journal.find((e) => e.event === 'bench-idle');
  assert.ok(idle, 'the eventual idle confirmation must be journalled by name');
  assert.equal(idle.attempts, 2);
});

test('realFinish (R1, post-verification third pass): a bench that NEVER goes idle DEFERS the reinstall (bench-reinstall-deferred + a durable owed record) and still completes the card to DONE -- the old bench-idle-wait PARK terminally stranded a card whose PR had already merged over an ordinary bench lease', async () => {
  const config = testConfig({ benchIdleWaitMaxPolls: 3, benchIdleWaitPollIntervalMs: 10 });
  const worktreePath = mkTmp('spo-real-finish-benchstuck-');
  // NOT the default testCtx taskDir -- that lands directly under os.tmpdir() (mkTmp's own root),
  // which every OTHER default-taskDir test in this file also shares, so path.dirname(taskDir)
  // would collide with other tests' owed-record writes. An explicit, isolated journalRoot keeps
  // this test's readBenchReinstallOwed assertions meaningful.
  const journalRoot = mkTmp('spo-real-finish-benchstuck-root-');
  const taskDir = path.join(journalRoot, 'card-benchstuck');
  fs.mkdirSync(taskDir, { recursive: true });
  const task = { id: 'card-benchstuck', kind: 'card', issue: 1014, worktreePath };
  const ctx = testCtx({ id: 'card-benchstuck', task, config, taskDir });
  ctx.prNumber = 1014;

  const sleeps = [];
  let installRan = false;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'bash') installRan = true;
      return null;
    }),
    // Permanently busy: always 1 queued job, never drains.
    readdirSync: benchDirFake([1], [0]),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE', "a bench that never goes idle must not block a card whose PR already merged -- realFinish must still complete it to DONE, not park");
  assert.ok(!installRan, 'the reinstall must never run against a still-busy bench -- that is still the unsafe half of the trap this fix closes, just no longer paid for with a terminal park');
  assert.equal(sleeps.length, config.benchIdleWaitMaxPolls, 'must sleep exactly maxPolls times before giving up on the wait, never fewer and never more');

  const journal = readJournal(ctx.taskDir);
  const busyEvents = journal.filter((e) => e.event === 'bench-busy-wait');
  assert.equal(busyEvents.length, config.benchIdleWaitMaxPolls, 'every busy poll must be journalled, including the last one before giving up');
  const timedOut = journal.find((e) => e.event === 'bench-idle-wait-timed-out');
  assert.ok(timedOut, 'giving up on the wait must be journalled by its own name');
  assert.equal(timedOut.attempts, config.benchIdleWaitMaxPolls);
  assert.ok(!journal.some((e) => e.event === 'bench-idle' || e.event === 'bench-reinstalled' || e.event === 'bench-reinstall-failed'));

  // R1's own design constraint: "a deferred reinstall that never happens is the original defect"
  // -- so the defer itself must be loud (a named event) AND durable (survives this process, this
  // ctx -- readBenchReinstallOwed reads it back straight off disk, not from any in-memory state
  // realFinish might have kept).
  const deferred = journal.find((e) => e.event === 'bench-reinstall-deferred');
  assert.ok(deferred, 'the defer must be journalled by its own name -- the journal alone must answer "was a reinstall ever owed and never paid"');
  assert.equal(deferred.spool, 1);
  assert.equal(deferred.running, 0);
  assert.equal(deferred.attempts, config.benchIdleWaitMaxPolls);
  assert.equal(deferred.prNumber, 1014);

  assert.equal(path.dirname(ctx.taskDir), journalRoot, 'sanity: taskDir must actually live under the isolated journalRoot');
  const owed = readBenchReinstallOwed(journalRoot);
  assert.ok(owed, 'the debt must be recorded durably (journal.js\'s writeBenchReinstallOwed) so a daemon restart cannot lose it');
  assert.equal(owed.owed, true);
  assert.equal(owed.prNumber, 1014);
  assert.equal(owed.issue, 1014);
  assert.equal(owed.spool, 1);
  assert.equal(owed.running, 0);

  // And the card itself finished exactly as if nothing were owed: board move, comment, worktree
  // remove, `finished` -- the whole point of deferring instead of parking.
  assert.ok(journal.some((e) => e.event === 'board-move' && e.column === 'Done'));
  assert.ok(journal.some((e) => e.event === 'finished'));
});

test('realFinish (R1, post-verification third pass): TWO bench-touching cards deferring during the SAME busy window must not accumulate duplicate owed records -- one journal root, one record, the SECOND card\'s mergeSha wins', async () => {
  const config = testConfig({ benchIdleWaitMaxPolls: 2, benchIdleWaitPollIntervalMs: 10 });
  const journalRoot = mkTmp('spo-real-finish-benchowed-root-');
  const taskDirA = path.join(journalRoot, 'card-owed-a');
  const taskDirB = path.join(journalRoot, 'card-owed-b');
  fs.mkdirSync(taskDirA, { recursive: true });
  fs.mkdirSync(taskDirB, { recursive: true });

  const worktreeA = mkTmp('spo-real-finish-benchowed-wt-a-');
  const worktreeB = mkTmp('spo-real-finish-benchowed-wt-b-');
  const ctxA = testCtx({ id: 'card-owed-a', task: { id: 'card-owed-a', kind: 'card', issue: 2001, worktreePath: worktreeA }, config, taskDir: taskDirA });
  ctxA.prNumber = 2001;
  const ctxB = testCtx({ id: 'card-owed-b', task: { id: 'card-owed-b', kind: 'card', issue: 2002, worktreePath: worktreeB }, config, taskDir: taskDirB });
  ctxB.prNumber = 2002;

  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);
  const makeDeps = (mergeSha) => ({
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return ok(JSON.stringify({ mergeCommit: { oid: mergeSha } }));
      }
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      return null;
    }),
    // Permanently busy for both cards -- each independently exhausts its own bound and defers.
    readdirSync: benchDirFake([1], [0]),
    sleep: () => Promise.resolve(),
  });

  const nextA = await realFinish(ctxA, makeDeps(shaA));
  assert.equal(nextA, 'DONE');
  const nextB = await realFinish(ctxB, makeDeps(shaB));
  assert.equal(nextB, 'DONE');

  // Both defers must be on the record -- one journal.jsonl per task, never merged or dropped.
  assert.ok(readJournal(taskDirA).some((e) => e.event === 'bench-reinstall-deferred' && e.mergeSha === shaA));
  assert.ok(readJournal(taskDirB).some((e) => e.event === 'bench-reinstall-deferred' && e.mergeSha === shaB));

  // But the SHARED durable owed record must hold exactly ONE entry -- the latest defer -- never
  // an array, never one file per card. bench-install.sh always rebuilds from whatever is
  // CURRENTLY fast-forwarded, so paying the debt back once (from card B's sha, the more recent
  // one) already covers whatever card A's merge needed too.
  const owed = readBenchReinstallOwed(journalRoot);
  assert.ok(owed);
  assert.equal(owed.mergeSha, shaB, 'the SECOND defer must win -- the record is overwritten, not appended to');
  assert.equal(owed.owed, true);

  const entries = fs.readdirSync(journalRoot).filter((f) => f.includes('bench-reinstall-owed'));
  assert.deepEqual(entries, ['bench-reinstall-owed.json'], 'two cards deferring must never produce two owed-record files');
});

test('realFinish (action B1.4): a FAILED fast-forward means the reinstall never runs at all -- even though the merge touched the bench worker', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-ff-order-');
  const task = { id: 'card-ff-order', kind: 'card', issue: 1004, worktreePath };
  const ctx = testCtx({ id: 'card-ff-order', task, config });
  ctx.prNumber = 1004;

  const order = [];
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'git' && args.includes('merge') && args.includes('--ff-only')) {
        order.push('fast-forward-attempted');
        return fail(1);
      }
      if (command === 'bash') order.push('reinstall'); // must never be reached
      return null;
    }),
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'finish-failed' && err.detail.step === 'fast-forward'
  );

  assert.deepEqual(order, ['fast-forward-attempted'], 'the reinstall must never run once the fast-forward itself failed');

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'main-fast-forward-failed'), 'the failure must be journalled by name, loud on the failure path too');
  assert.ok(!journal.some((e) => e.event === 'bench-reinstalled' || e.event === 'bench-reinstall-failed'));
});

test('realFinish (action B1.4/hazard fix): a TRACKED modification still refuses the fast-forward, never forced -- and, since the merge touched the bench worker, PARKS finish-failed/fast-forward/dirty', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-dirty-');
  const task = { id: 'card-dirty', kind: 'card', issue: 1005, worktreePath };
  const ctx = testCtx({ id: 'card-dirty', task, config });
  ctx.prNumber = 1005;

  const calls = [];
  let statusArgs = null;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      calls.push([...args]);
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('scripts/bench-install.sh\n');
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) {
        statusArgs = [...args];
        return ok(' M some/tracked-file.ts\n');
      }
      return null;
    }),
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'finish-failed' &&
      err.detail.step === 'fast-forward' &&
      err.detail.reason === 'dirty'
  );

  // The hazard fix itself: the status call must actually narrow to tracked changes
  // (`--untracked-files=no`), not just bare `--porcelain` -- a test that only fakes on
  // `includes('--porcelain')` cannot tell the narrowed call from the old one.
  assert.ok(statusArgs, 'the status call must actually have been spawned');
  assert.ok(statusArgs.includes('--untracked-files=no'), 'the dirty check must pass --untracked-files=no, narrowing it to what can actually block a fast-forward');

  // Fail-closed, never force: no call anywhere in this run may carry a force/discard flag -- a
  // human works in config.productRepo, and this checkout being dirty means real, uncommitted work
  // may be sitting there.
  const forceLike = calls.filter(
    (a) => a.includes('--force') || a.includes('-f') || (a.includes('reset') && a.includes('--hard')) || a.includes('-D')
  );
  assert.deepEqual(forceLike, [], 'a dirty productRepo checkout must never be forced, reset --hard, or otherwise discarded');
  assert.ok(!calls.some((a) => a.includes('merge') && a.includes('--ff-only')), 'the merge itself must never even be attempted once the tree is known dirty');
});

test("realFinish (action B1.4/hazard fix): a STRAY UNTRACKED file does NOT refuse the fast-forward -- `git status --porcelain` alone would call this dirty, but `git pull --ff-only` (the human rule this mirrors, scripts/finish.sh's sync_main) does not care, so neither should this", async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-untracked-');
  const task = { id: 'card-untracked', kind: 'card', issue: 1011, worktreePath };
  const ctx = testCtx({ id: 'card-untracked', task, config });
  ctx.prNumber = 1011;

  const order = [];
  const deps = {
    // Genuinely differential, not just "an empty status proceeds": simulates what git ITSELF
    // would report for a tree with exactly one stray untracked file, under EITHER invocation --
    // `--untracked-files=no` present -> git omits untracked entries entirely -> empty; absent
    // (the pre-fix, bare `--porcelain` shape) -> git reports it as a `??` line, which the
    // pre-fix code would then read as dirty. A fake that ignored args and always answered empty
    // could not tell "the code asks the narrow question" apart from "the code asks the broad one
    // and got lucky" -- this one can, and does fail under the pre-fix shape (proven by mutation
    // below).
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) {
        return ok(args.includes('--untracked-files=no') ? '' : '?? some/stray-scratch-file.tmp\n');
      }
      if (command === 'git' && args.includes('merge') && args.includes('--ff-only')) order.push('fast-forward');
      if (command === 'bash') order.push('reinstall');
      return null;
    }),
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE', 'a stray untracked file must never block the fast-forward or the reinstall');
  assert.deepEqual(order, ['fast-forward', 'reinstall'], 'both must actually have run');

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'main-fast-forwarded'), 'the fast-forward must be journalled as a SUCCESS, not refused as dirty');
  assert.ok(!journal.some((e) => e.event === 'main-fast-forward-failed'), 'a stray untracked file must never be journalled as a fast-forward failure');
});

test('realFinish (action B1.4): the WRONG branch is refused too -- and, when the merge did NOT touch the bench worker, this is JOURNALLED, not parked (the card\'s PR already merged)', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-wrongbranch-');
  const task = { id: 'card-wrongbranch', kind: 'card', issue: 1006, worktreePath };
  const ctx = testCtx({ id: 'card-wrongbranch', task, config });
  ctx.prNumber = 1006;

  const calls = [];
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      calls.push([...args]);
      if (command === 'git' && args.includes('rev-parse') && args.includes('--abbrev-ref')) return ok('some-other-branch\n');
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('doc/README.md\n');
      return null;
    }),
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE', "a card whose PR already merged must not be blocked over a repo-hygiene issue the merge itself didn't touch");
  assert.ok(!calls.some((a) => a.includes('status') && a.includes('--porcelain')), 'the dirty check is never even reached once the branch check already failed');
  assert.ok(!calls.some((a) => a.includes('merge') && a.includes('--ff-only')), 'the merge itself must never be attempted on the wrong branch');
  assert.ok(!calls.some((a) => a[0] === 'scripts/bench-install.sh' || (a.length && String(a[a.length - 1]).endsWith('bench-install.sh'))));

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'main-fast-forward-failed');
  assert.ok(failed, 'the wrong-branch refusal must be journalled by name even though it never parks');
  assert.equal(failed.reason, 'wrong-branch');
});

// ---- R3 (post-verification, third pass): a FAILED probe is not the same fact as a genuinely
// dirty tree or a genuinely wrong branch -- `check-failed` gives the failure its own value so a
// maintainer reading the journal does not go hunting for uncommitted work that was never there. --

test("realFinish (R3, post-verification third pass): the BRANCH check command itself FAILING (git rev-parse exits non-zero) is journalled/parked as check-failed/branch, never misreported as wrong-branch", async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-branchcheckfailed-');
  const task = { id: 'card-branchcheckfailed', kind: 'card', issue: 1017, worktreePath };
  const ctx = testCtx({ id: 'card-branchcheckfailed', task, config });
  ctx.prNumber = 1017;

  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('rev-parse') && args.includes('--abbrev-ref')) return fail(1);
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      return null;
    }),
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'finish-failed' &&
      err.detail.step === 'fast-forward' &&
      err.detail.reason === 'check-failed' &&
      err.detail.check === 'branch' &&
      err.detail.exit === 1
  );

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'main-fast-forward-failed');
  assert.ok(failed);
  assert.equal(failed.reason, 'check-failed');
  assert.equal(failed.check, 'branch');
  assert.notEqual(failed.reason, 'wrong-branch', 'a FAILED command is not the same fact as a genuinely wrong branch');
});

test("realFinish (R3, post-verification third pass): the STATUS check command itself FAILING (git status exits non-zero) is journalled/parked as check-failed/status, never misreported as dirty -- and never on a merge that didn't touch the bench worker (journalled only, not parked)", async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-statuscheckfailed-');
  const task = { id: 'card-statuscheckfailed', kind: 'card', issue: 1018, worktreePath };
  const ctx = testCtx({ id: 'card-statuscheckfailed', task, config });
  ctx.prNumber = 1018;

  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('status') && args.includes('--porcelain')) return fail(2);
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('scripts/bench-install.sh\n');
      return null;
    }),
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'finish-failed' &&
      err.detail.step === 'fast-forward' &&
      err.detail.reason === 'check-failed' &&
      err.detail.check === 'status' &&
      err.detail.exit === 2
  );

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'main-fast-forward-failed');
  assert.ok(failed);
  assert.equal(failed.reason, 'check-failed');
  assert.equal(failed.check, 'status');
  assert.notEqual(failed.reason, 'dirty', 'a FAILED command is not the same fact as a genuinely dirty tree');
});


test('realFinish (action B1.4): the merge-sha lookup failing ALWAYS parks -- benchTouched is genuinely unknowable at that point, so there is no lenient path', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-shafail-');
  const task = { id: 'card-shafail', kind: 'card', issue: 1007, worktreePath };
  const ctx = testCtx({ id: 'card-shafail', task, config });
  ctx.prNumber = 1007;

  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return fail(1);
      return null;
    }),
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'finish-failed' && err.detail.step === 'merge-sha-lookup'
  );

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'merge-sha-lookup-failed'), 'the failure must be journalled by name');
});

// ---- D4 (adversarial verification): mutation M13 -- `gh pr view` exiting 0 with a NULL
// `mergeCommit` was untested, and it is the LIKELIER real-world shape than a non-zero exit: probed
// against the real repo, both an open PR (#465) and a closed-unmerged one (#633) return exit 0
// with `{"mergeCommit":null}` -- `gh` only fails non-zero on a transport/auth problem, never on
// "this PR has no merge commit yet". Mutating `if (!mergeSha)` to `if (prView.exit !== 0)` let an
// exit-0/null response sail straight through into `git diff --name-only null^ null` with the
// ENTIRE suite still green, because the only merge-sha test above ever drives `gh` to a non-zero
// exit. The code's own handling is already correct (`(parsed && parsed.mergeCommit &&
// parsed.mergeCommit.oid) || null`, then the SAME merge-sha-lookup park as a hard failure) --
// this only makes sure a regression here is caught.
test('realFinish (action B1.4): `gh pr view` exiting 0 with a NULL mergeCommit (an open or closed-unmerged PR -- the shape a real `gh` actually returns) parks merge-sha-lookup too, and nothing downstream ever runs on the undefined sha', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-nullmerge-');
  const task = { id: 'card-nullmerge', kind: 'card', issue: 1010, worktreePath };
  const ctx = testCtx({ id: 'card-nullmerge', task, config });
  ctx.prNumber = 1010;

  const calls = [];
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        // Exit 0, valid JSON, but `mergeCommit` is null -- the real shape `gh pr view` returns
        // for a PR that has not (yet, or ever) actually merged. `fail(1)` above only covers a
        // transport/auth failure, a DIFFERENT and less likely real-world case.
        return ok(JSON.stringify({ mergeCommit: null }));
      }
      return null;
    }),
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'finish-failed' &&
      err.detail.step === 'merge-sha-lookup' &&
      err.detail.exit === 0
  );

  // Nothing past the lookup may ever run: benchTouched is genuinely unknowable without a sha, so
  // no `git diff`, no branch/status check, no `git merge --ff-only`, and certainly no `bash`
  // reinstall may be spawned on an undefined mergeSha.
  assert.ok(
    !calls.some((c) => c.command === 'git' && c.args.includes('diff') && c.args.includes('--name-only')),
    'the merge-diff call must never run once the sha lookup came back with no usable oid'
  );
  assert.ok(
    !calls.some((c) => c.command === 'git' && (c.args.includes('merge') || (c.args.includes('status') && c.args.includes('--porcelain')))),
    'the fast-forward itself must never even be attempted'
  );
  assert.ok(!calls.some((c) => c.command === 'bash'), 'the reinstall must never be attempted');

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'merge-sha-lookup-failed');
  assert.ok(failed, 'the failure must be journalled by name even though `gh` itself exited 0');
  assert.equal(failed.exit, 0, 'the journalled exit code must be the REAL gh exit code (0), not inferred as if it had failed to run at all');
});

test('realFinish (action B1.4): bench-install.sh itself exiting non-zero PARKS finish-failed/bench-reinstall, journalled by name', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-installfail-');
  const task = { id: 'card-installfail', kind: 'card', issue: 1008, worktreePath };
  const ctx = testCtx({ id: 'card-installfail', task, config });
  ctx.prNumber = 1008;

  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'bash') return fail(1, 'npm run build:e2e failed');
      return null;
    }),
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'finish-failed' && err.detail.step === 'bench-reinstall'
  );

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'bench-reinstall-failed'), 'the failure must be journalled by name');
  assert.ok(journal.some((e) => e.event === 'main-fast-forwarded'), 'the fast-forward itself must have succeeded first');
});

// ---- action 6.4: the product-repo mutex, as wired into realWorktree/realFinish ----------------
//
// Real exclusion (two processes can never both be inside the critical section) and the
// dead-pid/live-in-bound/over-age sweep rules are covered directly against
// orchestrator/product-repo-lock.js in test/product-repo-lock.test.js -- that file owns the
// mutex's own behaviour. What belongs HERE, alongside every other realWorktree/realFinish test, is
// the WIRING: does setup actually acquire-and-release around the right span, does teardown do the
// same around just `worktree remove`, does a thrown ParkSignal still release (try/finally), does a
// wait-bound timeout become the documented ParkSignal reason, and do both call sites end up
// pointed at the SAME lock file for the same config (the empirical half of "one mutex, not two" --
// product-repo-lock.test.js proves the OTHER half, that two real holders of that file exclude each
// other, using role-labelled fixture processes).

test('realWorktree (action 6.4): the product-repo lock is released once setup finishes -- the lock file does not survive a successful run', async () => {
  const config = testConfig();
  const task = { id: 'card-lock-ok', kind: 'card', issue: 900, title: 'Add a widget' };
  const ctx = testCtx({ id: 'card-lock-ok', task, config });
  const deps = { spawnSync: noLeftoversSpawnSync([]) };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');
  assert.equal(fs.existsSync(lockFilePath(config)), false, 'the lock must be released once the setup phase returns');
});

test('realWorktree (action 6.4): the product-repo lock is released even when a step inside throws ParkSignal (npm ci failure)', async () => {
  const config = testConfig();
  const task = { id: 'card-lock-park', kind: 'card', issue: 901, title: 'Add a widget' };
  const ctx = testCtx({ id: 'card-lock-park', task, config });
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1); // no leftovers
      if (args.includes('rev-parse')) return ok('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
      if (command === 'npm' && args[0] === 'ci') return fail(1);
      return ok('');
    },
  };

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'worktree-npm-ci-failed'
  );
  assert.equal(
    fs.existsSync(lockFilePath(config)),
    false,
    'a ParkSignal thrown from inside the locked span must still release the lock (try/finally), not wedge every other worker behind it'
  );
});

test('realFinish (action 6.4): the product-repo lock is released after a successful worktree remove', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-lock-ok-');
  const task = { id: 'card-lock-finish-ok', kind: 'card', issue: 902, worktreePath };
  const ctx = testCtx({ id: 'card-lock-finish-ok', task, config });
  ctx.prNumber = 902;

  const next = await realFinish(ctx, { spawnSync: finishSyncOk() });
  assert.equal(next, 'DONE');
  assert.equal(fs.existsSync(lockFilePath(config)), false);
});

test('realFinish (action 6.4): the product-repo lock is released even when `git worktree remove` itself fails', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-lock-fail-');
  const task = { id: 'card-lock-finish-fail', kind: 'card', issue: 903, worktreePath };
  const ctx = testCtx({ id: 'card-lock-finish-fail', task, config });
  ctx.prNumber = 903;
  const deps = {
    spawnSync: finishSyncOk((command, args) => (args.includes('remove') ? fail(1) : null)),
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'finish-failed' && err.detail.step === 'worktree-remove'
  );
  assert.equal(fs.existsSync(lockFilePath(config)), false, 'the remove call itself failing must still release the lock');
});

// WHY THESE TWO TESTS OBSERVE FROM INSIDE THE SPAN, and not merely that the lock is gone
// afterwards. Every action of chantier 6 shipped a central claim that passed the whole suite while
// being false, and the shape was the same each time: an assertion on the state AFTER the span
// (which "acquire and immediately drop" satisfies exactly as well as "hold throughout"), or a
// single-process test standing in for a property that is only meaningful across processes. 6.2's
// lease-release-before-spawn survived 1223 tests on the first shape; verification of 6.4 measured
// the same two holes here -- moving `releaseFn(acquired)` to BEFORE `await fn()` (the literal 6.2
// shape), and shrinking the locked span to `git worktree add` alone so that fetch, the whole
// leftover sweep and `npm ci` ran unprotected, EACH passed all 1295 tests while two real processes
// running this very function overlapped inside the critical section 8 times.
//
// So: assert the lock is HELD, from inside, at both ENDS of the span -- the first spawn (`fetch`)
// and the last (`npm ci`) -- and that the holder is THIS process. A lock that is acquired and
// dropped early fails at `npm ci`; a span that starts late fails at `fetch`; a span that is never
// taken fails at both.
function lockHolderDuring(config) {
  try {
    return JSON.parse(fs.readFileSync(lockFilePath(config), 'utf8'));
  } catch {
    return null;
  }
}

test('realWorktree (action 6.4): the product-repo lock is HELD BY THIS PROCESS at both ends of the span -- observed from inside, at `fetch` and at `npm ci`', async () => {
  const config = testConfig();
  const task = { id: 'card-lock-inside', kind: 'card', issue: 908, title: 'Add a widget' };
  const ctx = testCtx({ id: 'card-lock-inside', task, config });

  const seen = {};
  const deps = {
    spawnSync: (command, args) => {
      const argv = [command, ...args].join(' ');
      if (argv.includes('fetch')) seen.atFetch = lockHolderDuring(config);
      if (command === 'npm' && args[0] === 'ci') seen.atNpmCi = lockHolderDuring(config);
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1);
      if (args.includes('rev-parse')) return ok('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
      return ok('');
    },
  };

  assert.equal(await realWorktree(ctx, deps), 'PLAN');

  assert.ok(seen.atFetch, 'the lock must already be held at the FIRST spawn of the span (`git fetch`)');
  assert.equal(seen.atFetch.pid, process.pid, 'and held by THIS process, not merely present on disk');
  assert.ok(seen.atNpmCi, 'the lock must STILL be held at the LAST spawn of the span (`npm ci`) -- an early release is the 6.2 shape');
  assert.equal(seen.atNpmCi.pid, process.pid);
  assert.equal(seen.atFetch.startedAt, seen.atNpmCi.startedAt, 'and it must be the SAME acquisition throughout, never released and retaken mid-span');
  assert.equal(fs.existsSync(lockFilePath(config)), false, 'and released once the span returns');
});

test('realFinish (action 6.4): the product-repo lock is HELD BY THIS PROCESS during `git worktree remove` itself', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-lock-inside-');
  const task = { id: 'card-lock-finish-inside', kind: 'card', issue: 909, worktreePath };
  const ctx = testCtx({ id: 'card-lock-finish-inside', task, config });
  ctx.prNumber = 909;

  let atRemove;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (args.includes('worktree') && args.includes('remove')) atRemove = lockHolderDuring(config);
      return null;
    }),
  };

  assert.equal(await realFinish(ctx, deps), 'DONE');
  assert.ok(atRemove, 'the teardown lock must be held DURING the remove, not merely around it');
  assert.equal(atRemove.pid, process.pid);
  assert.equal(fs.existsSync(lockFilePath(config)), false);
});

test('realWorktree (action 6.4): the product-repo lock wait bound exceeded -> ParkSignal(product-repo-lock-timeout), phase "worktree"', async () => {
  const config = testConfig();
  const task = { id: 'card-lock-timeout-wt', kind: 'card', issue: 904, title: 'Add a widget' };
  const ctx = testCtx({ id: 'card-lock-timeout-wt', task, config });

  // A LIVE, in-bound holder pre-seeded directly on disk under this test's OWN pid -- genuinely
  // alive, so acquireProductRepoLock's default isAlive sees it as held and the bounded wait below
  // must time out rather than sweep it.
  fs.mkdirSync(path.dirname(lockFilePath(config)), { recursive: true });
  fs.writeFileSync(lockFilePath(config), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const deps = { spawnSync: noLeftoversSpawnSync([]), productRepoLockOpts: { waitMs: 40, pollMs: 10 } };

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'product-repo-lock-timeout' && err.detail.phase === 'worktree'
  );
});

test('realFinish (action B1.4/6.4): the product-repo lock wait bound exceeded on FINISH\'s FIRST acquisition -> ParkSignal(product-repo-lock-timeout), phase "finish-sync"', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-lock-timeout-');
  const task = { id: 'card-lock-timeout-fin', kind: 'card', issue: 905, worktreePath };
  const ctx = testCtx({ id: 'card-lock-timeout-fin', task, config });
  ctx.prNumber = 905;

  // Pre-seeded busy and never released within this test -- realFinish's very FIRST acquisition
  // ('finish-sync', action B1.4's own new preamble) is the one that blocks and times out here; it
  // never even reaches the second ('finish', worktree-remove).
  fs.mkdirSync(path.dirname(lockFilePath(config)), { recursive: true });
  fs.writeFileSync(lockFilePath(config), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const deps = { spawnSync: finishSyncOk(), productRepoLockOpts: { waitMs: 40, pollMs: 10 } };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'product-repo-lock-timeout' && err.detail.phase === 'finish-sync'
  );
});

test('realFinish (action B1.4/6.4): the product-repo lock wait bound exceeded on FINISH\'s SECOND acquisition -> ParkSignal(product-repo-lock-timeout), phase "finish"', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-lock-timeout2-');
  const task = { id: 'card-lock-timeout-fin2', kind: 'card', issue: 9052, worktreePath };
  const ctx = testCtx({ id: 'card-lock-timeout-fin2', task, config });
  ctx.prNumber = 9052;

  // The FIRST acquisition ('finish-sync') must succeed cleanly (real acquire/release against the
  // real lock file, so board-move/issue-comment run for real too); only the SECOND ('finish',
  // guarding `git worktree remove`) is made to time out, by re-seeding a busy holder the instant
  // the first release happens. Proves the "finish" reason from THIS run's own second acquisition,
  // not merely a phase string the first acquisition happens to share.
  let acquireCalls = 0;
  const deps = {
    spawnSync: finishSyncOk(),
    acquireProductRepoLock: async (cfg, opts) => {
      acquireCalls += 1;
      if (acquireCalls === 1) return acquireProductRepoLock(cfg, opts);
      fs.mkdirSync(path.dirname(lockFilePath(cfg)), { recursive: true });
      fs.writeFileSync(lockFilePath(cfg), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return acquireProductRepoLock(cfg, { ...opts, waitMs: 40, pollMs: 10 });
    },
    releaseProductRepoLock,
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'product-repo-lock-timeout' && err.detail.phase === 'finish'
  );
  assert.equal(acquireCalls, 2, 'both of FINISH\'s own acquisitions must have been attempted');
});

test('action 6.4: realWorktree (setup) and realFinish (teardown) acquire the SAME product-repo lock file for the same config -- one mutex, not two', async () => {
  const config = testConfig();
  const capturedPaths = [];
  const spyAcquire = async (cfg, opts) => {
    const filePath = (opts && opts.filePath) || lockFilePath(cfg);
    capturedPaths.push(filePath);
    return { filePath, held: { pid: process.pid, startedAt: new Date().toISOString() } };
  };
  const spyRelease = () => {};

  const wtTask = { id: 'card-samefile-wt', kind: 'card', issue: 906, title: 'Add a widget' };
  const wtCtx = testCtx({ id: 'card-samefile-wt', task: wtTask, config });
  await realWorktree(wtCtx, {
    spawnSync: noLeftoversSpawnSync([]),
    acquireProductRepoLock: spyAcquire,
    releaseProductRepoLock: spyRelease,
  });

  const worktreePath = mkTmp('spo-real-finish-samefile-');
  const finTask = { id: 'card-samefile-fin', kind: 'card', issue: 907, worktreePath };
  const finCtx = testCtx({ id: 'card-samefile-fin', task: finTask, config });
  finCtx.prNumber = 907;
  await realFinish(finCtx, {
    spawnSync: finishSyncOk(),
    acquireProductRepoLock: spyAcquire,
    releaseProductRepoLock: spyRelease,
  });

  // Action B1.4: realFinish now acquires the lock TWICE -- 'finish-sync' (this action's own new
  // preamble) ahead of 'finish' (the pre-existing worktree-remove) -- so the spy sees THREE calls
  // total: one from realWorktree's setup, two from realFinish's own two critical sections. All
  // three must resolve to the SAME file: that is what makes every phase contend on ONE mutex, not
  // two (or three).
  assert.equal(capturedPaths.length, 3);
  assert.equal(
    capturedPaths[0],
    capturedPaths[1],
    'setup and FINISH\'s first (finish-sync) acquisition must resolve to the identical lock file'
  );
  assert.equal(
    capturedPaths[1],
    capturedPaths[2],
    'FINISH\'s own two acquisitions (finish-sync, then finish) must resolve to the identical lock file too'
  );
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
  // R4 (fifth pass, F2): this test passes an explicit taskDir, so it bypasses testCtx's own fix
  // (nesting taskDir inside a FRESH mkTmp root, one per test) -- a bare mkTmp() here drops
  // journalRoot (path.dirname(taskDir)) directly under the shared OS tmpdir, same as every OTHER
  // call site testCtx's fix was written to close. Reproduced live: a `/tmp/bench-reinstall-owed.json`
  // planted before this test ran was silently consumed and cleared by this walkthrough's own
  // realWorktree call, and the test still passed -- nesting one level inside its own fresh mkTmp
  // root gives this test a private journalRoot, matching production's real shape and every other
  // call site in this file.
  const taskDir = path.join(mkTmp('spo-real-walkthrough-jr-'), 'card-4242');
  fs.mkdirSync(taskDir, { recursive: true });
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
      // Action B1.4: FINISH's own branch check (`rev-parse --abbrev-ref HEAD`) -- checked BEFORE
      // the more general 'HEAD' branch below, which would otherwise also match it (both include
      // 'HEAD' in argv) and hand it a raw sha instead of a branch name.
      if (args.includes('rev-parse') && args.includes('--abbrev-ref')) return ok('main\n');
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('originmainsha000000000000000000000000000\n');
      if (args.includes('board:take')) return ok('claimed\n');
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return ok('Creating PR...\nhttps://github.com/Crazz-Org/SPO-WebClient/pull/4242\n');
      }
      // Action B1.4: FINISH's own merge-sha lookup -- a real card's own merge commit, by PR
      // number. This fictional card never touches src/e2e/bench/ or scripts/bench-, so the
      // default `git diff --name-only` fallback below (empty stdout) correctly reports no bench
      // paths touched and FINISH skips the reinstall.
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return ok(JSON.stringify({ mergeCommit: { oid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } }));
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

test('full lifecycle walkthrough (B1.4 R4, fifth pass F2): its taskDir must be nested inside its OWN fresh mkTmp root, never a bare mkTmp() dropped straight into the shared OS tmpdir', () => {
  // Source-level guard, same shape as the payBenchReinstallDebtIfOwed wiring guard elsewhere in
  // this file: pins that a future edit cannot silently reintroduce the bug this exact test line
  // carried through round 4 -- a bare `mkTmp('spo-real-walkthrough-taskdir-')` assigned straight to
  // taskDir makes journalRoot (path.dirname(taskDir)) the SHARED os.tmpdir() itself, so an EARLIER
  // test's planted `bench-reinstall-owed.json` (or this walkthrough's own realFinish deferring one)
  // silently leaks into whatever OTHER test reaches realWorktree next. Reproduced live before this
  // fix: a real `/tmp/bench-reinstall-owed.json` planted ahead of time was silently consumed and
  // cleared by this walkthrough's own realWorktree call, and the walkthrough still passed.
  const src = fs.readFileSync(__filename, 'utf8');
  const testStart = src.indexOf("test('full lifecycle walkthrough: WORKTREE ->");
  assert.notEqual(testStart, -1, 'the walkthrough test itself must still exist under this exact name');
  const testBody = src.slice(testStart, src.indexOf('\n});', testStart));
  assert.doesNotMatch(
    testBody,
    /const taskDir = mkTmp\(/,
    "the walkthrough's taskDir must be NESTED inside its own fresh mkTmp root (path.join(mkTmp(...), id)), never a bare mkTmp() -- a bare one drops journalRoot directly into the shared OS tmpdir"
  );
  assert.match(
    testBody,
    /const taskDir = path\.join\(mkTmp\('spo-real-walkthrough-jr-'\), 'card-4242'\)/,
    "the walkthrough must nest its taskDir one level inside a fresh mkTmp root, matching testCtx's own fix"
  );
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

test("spawnStep (R2, post-verification third pass): a timed-out bench-install (FINISH's `bash scripts/bench-install.sh`) parks bench-install-timed-out and is NEVER retried -- a retry would start a SECOND `npm run build:e2e` into the SAME dist/, exactly the mechanics npm-gate's own exemption above already names", async () => {
  const config = testConfig({ commandTimeoutsMs: { ...TIMEOUT_TABLE, 'bench-install': 900000 } });
  const worktreePath = mkTmp('spo-real-finish-benchinstalltimeout-');
  const task = { id: 'card-benchinstalltimeout', kind: 'card', issue: 1015, worktreePath };
  const ctx = testCtx({ id: 'card-benchinstalltimeout', task, config });
  ctx.prNumber = 1015;

  let installRuns = 0;
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'bash') {
        installRuns += 1;
        return timeoutResult();
      }
      return null;
    }),
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'bench-install-timed-out');
      assert.notEqual(err.reason, 'finish-failed', 'a stuck reinstall must not be mistaken for a plain finish-failed step');
      assert.equal(err.detail.retried, false);
      return true;
    }
  );
  assert.equal(
    installRuns,
    1,
    'bash scripts/bench-install.sh must run exactly once -- a retry would build into the SAME dist/ concurrently and race a second `systemctl restart`'
  );

  const installSpawns = readJournal(ctx.taskDir)
    .filter((e) => e.event === 'spawn')
    .filter((e) => e.argv[0] === 'bash');
  assert.deepEqual(
    installSpawns.map((e) => [e.attempt, e.timedOut]),
    [[1, true]],
    'journalled as a single timed-out attempt, never a second one'
  );
});

// ---- W11 (post-verification, third pass): benchIdleWaitMaxMs must be pinned BY VALUE, not just
// by shape -- a shape-only test (e.g. asserting `finishStepDeadlineMs(` appears in the source)
// stays green even when the ARITHMETIC inside config.js silently changes from `x` to `+`, which
// leaves the FINISH deadline covering 185ms of what is documented (and, separately, load-bearing
// in product-repo-hold.js's own finishSyncHoldMs) as a 900000ms wait -- reintroducing D1's exact
// defect shape (a step deadline shorter than a legitimate wait it must cover) through the hazard
// fix's own constant. ------------------------------------------------------------------------

test('config.benchIdleWaitMaxMs is the PRODUCT of benchIdleWaitMaxPolls and benchIdleWaitPollIntervalMs (900000 = 180 x 5000), never their sum or anything else -- pinned BY VALUE so a `*` silently mutated to `+` cannot survive a green suite', () => {
  const config = require('../orchestrator/config.js');
  assert.equal(config.benchIdleWaitMaxPolls, 180, 'the documented default poll count');
  assert.equal(config.benchIdleWaitPollIntervalMs, 5000, 'the documented default poll interval');
  // Recomputed with THIS test's own `*`, independent of whatever operator config.js's own
  // BENCH_IDLE_WAIT_MAX_MS derivation actually used -- a mutation from `*` to `+` inside config.js
  // changes config.benchIdleWaitMaxMs (5180) while leaving these two INPUT constants untouched
  // (180, 5000), so the two sides genuinely diverge under that mutation rather than both silently
  // recomputing the same wrong answer.
  assert.equal(
    config.benchIdleWaitMaxMs,
    config.benchIdleWaitMaxPolls * config.benchIdleWaitPollIntervalMs,
    'benchIdleWaitMaxMs must be the PRODUCT of the two, not their sum -- a `+` here leaves the FINISH deadline covering 185ms of what must cover a 900000ms wait'
  );
  assert.equal(config.benchIdleWaitMaxMs, 900000, 'the documented 180 x 5s = 15 minutes default');
});

// ---- V20 (post-verification, third pass): the bench-idle wait must run ONLY when a reinstall is
// actually needed (fast-forward succeeded AND benchTouched) -- not on every card. The pre-existing
// bench-reinstall-skipped test only asserted "no `bash` call", which cannot tell "the wait ran and
// then correctly found nothing to install" apart from "the wait never ran at all"; moving
// `waitForBenchIdle` ahead of the benchTouched/ffOk gate survived the whole suite under
// adversarial verification. -----------------------------------------------------------------------

test('realFinish (V20, post-verification third pass): a merge that did NOT touch the bench worker never even CHECKS the bench queue depth -- the wait must be gated on benchTouched, not run unconditionally on every card', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-v20-skip-');
  const task = { id: 'card-v20-skip', kind: 'card', issue: 1019, worktreePath };
  const ctx = testCtx({ id: 'card-v20-skip', task, config });
  ctx.prNumber = 1019;

  let readdirCalls = 0;
  const sleeps = [];
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('doc/README.md\n');
      return null;
    }),
    // A bench that WOULD report busy (and, downstream, defer with a sleep) if the wait ever
    // checked it at all -- counted directly (readdirCalls), which is the load-bearing assertion;
    // the sleeps/journal checks below are belt-and-suspenders on the same property.
    readdirSync: (dir) => {
      readdirCalls += 1;
      return benchDirFake([1], [0])(dir);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };

  const next = await realFinish(ctx, deps);
  assert.equal(next, 'DONE');

  assert.equal(readdirCalls, 0, 'benchQueueDepth must never be called at all when benchTouched is false -- the wait must be gated on it, not merely its OUTCOME');
  assert.deepEqual(sleeps, [], 'a merge that never touched the bench worker must never sleep waiting for it');
  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'bench-reinstall-skipped'));
  assert.ok(
    !journal.some((e) => e.event === 'bench-busy-wait' || e.event === 'bench-idle' || e.event === 'bench-idle-wait-timed-out'),
    'the bench-idle wait must never even run (no bench-busy-wait/bench-idle/bench-idle-wait-timed-out event) when benchTouched is false'
  );
});

test('realFinish (V20, post-verification third pass): a FAILED fast-forward on a merge that DID touch the bench worker still never checks bench queue depth -- the wait is gated on ffOk too, not merely benchTouched', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-real-finish-v20-ffgate-');
  const task = { id: 'card-v20-ffgate', kind: 'card', issue: 1020, worktreePath };
  const ctx = testCtx({ id: 'card-v20-ffgate', task, config });
  ctx.prNumber = 1020;

  const sleeps = [];
  const deps = {
    spawnSync: finishSyncOk((command, args) => {
      if (command === 'git' && args.includes('diff') && args.includes('--name-only')) return ok('src/e2e/bench/worker.ts\n');
      if (command === 'git' && args.includes('merge') && args.includes('--ff-only')) return fail(1);
      return null;
    }),
    readdirSync: benchDirFake([1], [0]),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };

  await assert.rejects(
    () => realFinish(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'finish-failed' && err.detail.step === 'fast-forward'
  );
  assert.deepEqual(sleeps, [], 'a failed fast-forward must never reach the bench-idle wait, even on a bench-touching merge');
  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'bench-busy-wait' || e.event === 'bench-idle' || e.event === 'bench-idle-wait-timed-out'));
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

// Action 6.5: the plan asked whether npm-gate's timeout covers the WORST-CASE QUEUE WAIT once K
// workers can all reach GATE at once (plus a nightly caught mid-run on the same single bench
// worker) -- a distinct question from the bench's own internal 120-min give-up bound the test
// above pins. Measured before building anything, per this chantier's own habit: at K=2 (this
// machine's real ceiling) the worst case is ~10.5 min, at K=3 (shadow-only today) ~13.2 min --
// see orchestrator/bench-queue-wait.js's own header for the three measured constants and where
// each comes from. Both are dwarfed by npm-gate's existing 7800000ms (130 min), so THE CORRECT
// OUTPUT OF THIS ACTION IS THIS ASSERTION, not new machinery: no bench-queue-aware timeout, no
// per-worker submit-time budget, nothing built. This test is what keeps that verdict honest --
// it fails the moment `workers` is raised far enough, or the measured constants revised far
// enough, to actually threaten the margin, rather than trusting the arithmetic to stay true
// forever unchecked.
test('npm-gate timeout also covers K workers\' worst-case bench queue wait, including a nightly caught mid-run (action 6.5)', () => {
  const config = require('../orchestrator/config.js');
  const { benchQueueWaitBoundMs } = require('../orchestrator/bench-queue-wait.js');

  // Asserted at the K values this action actually REASONED about, not only at the K the config
  // happens to ship (1). Checking only `config.workers` made this assertion vacuous: it was
  // strictly implied by the 120-min bench-wait test just above, since benchQueueWaitBoundMs(1)
  // is ~7.9 min and that test already requires npm-gate > 120 min -- it could not have failed
  // independently below K=44.
  for (const k of [1, 2, 3]) {
    const bound = benchQueueWaitBoundMs(k);
    assert.ok(
      config.commandTimeoutsMs['npm-gate'] > bound,
      `npm-gate (${config.commandTimeoutsMs['npm-gate']}ms) must exceed the worst-case K=${k} bench queue wait (${bound}ms)`
    );
  }

  // The shipped K itself, so a raise to 2 or 3 stays inside the range checked above.
  assert.ok(
    [1, 2, 3].includes(config.workers),
    `config.workers is ${config.workers}: extend the K list above before raising it further`
  );
});

// The three constants benchQueueWaitBoundMs is built from, pinned as LITERALS with their
// provenance. The derivation test below deliberately recomputes from these same constants (that
// is what makes it a test of the FORMULA), so it cannot notice one of them changing value --
// verified by mutation: SIBLING_REF_JOB_MAX_MS 161000 -> 1000, NIGHTLY_JOB_MAX_MS -> 0 and
// OWN_GATE_JOB_MAX_MS -> 1 each passed the entire suite. That is the same shape as action 6.4's
// SETUP_GIT_CALLS, where recomputing the expectation from the constant under test let a safety
// bound be halved against 1303 green tests. The margin assertion above cannot catch it either:
// shrinking a constant shrinks the bound, which only makes `npm-gate > bound` MORE true.
//
// A CAVEAT these numbers carry, and the reason a bare "max on disk" is not a max: the spool they
// were measured from rotates. SPO-WebClient/src/e2e/bench/job.ts's `purgeDone` (line 217) deletes
// every report in ~/.spo-bench/done older than worker.ts's DONE_RETENTION_MS (24h), called from
// worker.ts's own loop. So these are the worst service times seen in a ONE-DAY window, not
// all-time records, and re-measuring on a different day legitimately yields a different sample
// count -- which is exactly what happened between C6's earlier pass and this action's. Revising
// them upward is expected; this test is here so a revision is a deliberate edit rather than a
// silent drift, and the margin loop above is what says whether a revision still fits.
test('bench-queue-wait: the three measured constants are the values action 6.5 derived its verdict from (action 6.5)', () => {
  const {
    OWN_GATE_JOB_MAX_MS,
    SIBLING_REF_JOB_MAX_MS,
    NIGHTLY_JOB_MAX_MS,
    benchQueueWaitBoundMs,
  } = require('../orchestrator/bench-queue-wait.js');

  // 239.9s -- GATE's own client-observed max, n=23 real `npm run gate` spawns across 20 journals.
  assert.strictEqual(OWN_GATE_JOB_MAX_MS, 239900);
  // 161s -- max 'ref' service time in ~/.spo-bench/done (123.8/125.4/160.2s), rounded up.
  assert.strictEqual(SIBLING_REF_JOB_MAX_MS, 161000);
  // 232s -- max 'nightly' service time in the same spool (212.5/232.0s).
  assert.strictEqual(NIGHTLY_JOB_MAX_MS, 232000);

  // And the bounds those literals produce, stated independently of the formula, so that neither
  // a changed constant NOR a changed formula can leave both tests green.
  assert.strictEqual(benchQueueWaitBoundMs(1), 471900);
  assert.strictEqual(benchQueueWaitBoundMs(2), 632900);
  assert.strictEqual(benchQueueWaitBoundMs(3), 793900);
});

test('benchQueueWaitBoundMs: K=1 has no sibling term, each extra worker adds exactly one sibling-job cost, a non-positive/non-integer K falls back to 1', () => {
  const {
    benchQueueWaitBoundMs,
    OWN_GATE_JOB_MAX_MS,
    SIBLING_REF_JOB_MAX_MS,
    NIGHTLY_JOB_MAX_MS,
  } = require('../orchestrator/bench-queue-wait.js');

  assert.equal(benchQueueWaitBoundMs(1), NIGHTLY_JOB_MAX_MS + OWN_GATE_JOB_MAX_MS);
  assert.equal(benchQueueWaitBoundMs(2), NIGHTLY_JOB_MAX_MS + SIBLING_REF_JOB_MAX_MS + OWN_GATE_JOB_MAX_MS);
  assert.equal(benchQueueWaitBoundMs(3), NIGHTLY_JOB_MAX_MS + 2 * SIBLING_REF_JOB_MAX_MS + OWN_GATE_JOB_MAX_MS);
  assert.equal(benchQueueWaitBoundMs(0), benchQueueWaitBoundMs(1), 'a non-positive K must not go negative or drop the floor');
  assert.equal(benchQueueWaitBoundMs(-5), benchQueueWaitBoundMs(1));
  assert.equal(benchQueueWaitBoundMs(1.5), benchQueueWaitBoundMs(1), 'a non-integer K falls back to the safe default, same as product-repo-hold.js\'s own workers guard');
  assert.equal(benchQueueWaitBoundMs(undefined), benchQueueWaitBoundMs(1));
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

// This test used to assert that a bare signal with no deadline armed FELL THROUGH to `exit: 1`,
// unretried -- the "pre-existing null-status default". That is no longer the behaviour, and the
// change is deliberate: `exit: 1` is an ORDINARY COMMAND FAILURE, so a card whose command was
// killed from outside got routed as though the command had genuinely failed. spawnStep's own park
// comment says why that matters ("realGate's exit-1 -> DIAGNOSE routing never even sees this"):
// the fall-through buys a real DIAGNOSE LLM call to explain a failure that never happened.
//
// The old asymmetry had no defender either. The SAME SIGKILL was a "timeout" when a deadline
// happened to be armed and an ordinary exit-1 failure when one was not -- a classification
// turning on an unrelated config default. `isSpawnKilled` is not gated on `deadlineArmed` for
// exactly that reason.
//
// Production blast radius: none. test/park-reason-doc-sweep.test.js enforces that
// `classifyCommand` never returns null for any real spawnStep call site, so a deadline is always
// armed in production and this "unclassified command" case exists only in tests.
test('spawnStep: a bare signal is an EXTERNAL kill -- retried once, then parked as such, never routed as exit 1', () => {
  const ctx = timeoutTestCtx(); // TIMEOUT_TABLE has no entry for an unrecognized command
  const calls = [];
  const deps = {
    spawnSync: () => {
      calls.push(1);
      return killedNoDeadline('SIGKILL');
    },
  };

  assert.throws(
    () => spawnStep(ctx, deps, 'CHECK', 'some-unclassified-tool', ['--flag']),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'command-killed-by-signal' &&
      err.detail.signal === 'SIGKILL' &&
      err.detail.retried === true
  );
  assert.equal(calls.length, 2, 'an external kill is retried once, exactly like a timeout');

  const spawns = readJournal(ctx.taskDir).filter((e) => e.event === 'spawn');
  assert.equal(spawns.length, 2);
  for (const e of spawns) {
    assert.equal(e.killedBySignal, true);
    assert.equal(e.timedOut, false, 'a kill is never journalled as a timeout');
    assert.equal(e.exit, -1, 'never routed on');
  }
});

test('spawnStep: an external kill that succeeds on the retry returns normally, no park', () => {
  const ctx = timeoutTestCtx();
  const calls = [];
  const deps = {
    spawnSync: () => {
      calls.push(1);
      return calls.length === 1 ? killedNoDeadline('SIGTERM') : ok('fine');
    },
  };

  const r = spawnStep(ctx, deps, 'CHECK', 'git', ['-C', '/wt', 'status']);
  assert.equal(calls.length, 2);
  assert.equal(r.exit, 0);
  assert.equal(r.killedBySignal, false);
  assert.equal(r.timedOut, false);
});

test('spawnStep: npm-gate killed from outside parks WITHOUT a retry -- same orphaned-job reasoning as a timeout', () => {
  const ctx = timeoutTestCtx();
  const calls = [];
  const deps = {
    spawnSync: () => {
      calls.push(1);
      return killedNoDeadline('SIGTERM');
    },
  };

  assert.throws(
    () => spawnStep(ctx, deps, 'GATE', 'npm', ['run', 'gate']),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'command-killed-by-signal' &&
      err.detail.commandClass === 'npm-gate' &&
      err.detail.retried === false
  );
  // Re-running `npm run gate` re-submits a bench job for the same (worktree, ref); a killed
  // spawn leaves the grandchild `node cli.js wait` alive just as a timed-out one does, so the
  // no-retry rule has to cover both causes or it covers neither.
  assert.equal(calls.length, 1, 'npm-gate must never be retried, however it was killed');
});

test('spawnStep: bench-install killed from outside parks WITHOUT a retry', () => {
  const ctx = timeoutTestCtx();
  const calls = [];
  const deps = {
    spawnSync: () => {
      calls.push(1);
      return killedNoDeadline('SIGTERM');
    },
  };

  assert.throws(
    () => spawnStep(ctx, deps, 'FINISH', 'bash', ['/home/x/SPO-WebClient/scripts/bench-install.sh']),
    (err) => err instanceof ParkSignal && err.reason === 'command-killed-by-signal' && err.detail.retried === false
  );
  assert.equal(calls.length, 1);
});

test('spawnStep: a park for an external kill carries the evidence that it was NOT a deadline', () => {
  const ctx = timeoutTestCtx();
  const deps = { spawnSync: () => killedNoDeadline('SIGTERM') };

  // The whole point of the reason split: issue-517 parked `npm-run-timed-out` after 345s of a
  // 660s budget, and nothing in the reason said the budget had not been reached. The detail now
  // carries both numbers so the journal contradicts a wrong reading on its own.
  assert.throws(
    () => spawnStep(ctx, deps, 'MERGE', 'npm', ['run', 'pr:wait', '--', '698']),
    (err) => {
      assert.equal(err.reason, 'command-killed-by-signal');
      assert.equal(err.detail.commandClass, 'npm-run');
      assert.equal(err.detail.signal, 'SIGTERM');
      assert.equal(typeof err.detail.ms, 'number');
      assert.ok(err.detail.timeoutMs > err.detail.ms, 'the budget must be shown to be unspent');
      assert.match(err.detail.detail, /not its own deadline/);
      return true;
    }
  );
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
