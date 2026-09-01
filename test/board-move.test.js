'use strict';
// Unit tests for orchestrator/board.js's moveCard (every mapped state's argv, the skip/failure
// policy) and the two call sites inside state-machine.js itself that have no realX(ctx, deps)
// split of their own -- HANDLERS.IMPLEMENT and HANDLERS.VALIDATE, real mode. steps/scripted.js's
// own moveCard call sites (WORKTREE/CHECK/GATE/MERGE) are covered in test/real-steps.test.js,
// alongside the rest of those functions' argv. Every spawn here is an injected deps.spawnSync
// (or, for the HANDLERS tests, ctx.deps via buildCtx's config.deps) -- nothing touches a real
// npm/claude process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { COLUMN_BY_STATE, moveCard, moveIssueToColumn, runSync } = require('../orchestrator/board');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { appendEvent } = require('../orchestrator/journal');
const { timeoutResult } = require('./helpers');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}
function fail(status) {
  return { status, stdout: '', stderr: 'boom', signal: null };
}
function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function ctxFor(issue, worktreePath) {
  return { task: { issue, worktreePath }, taskDir: mkTmp('spo-board-taskdir-') };
}

// ---- COLUMN_BY_STATE / moveCard argv, one line per mapped state ------------------------------

test('COLUMN_BY_STATE: the exact column mapping the pilot specifies', () => {
  assert.deepEqual(COLUMN_BY_STATE, {
    WORKTREE: 'Planning',
    IMPLEMENT: 'Implementing',
    CHECK: 'Checks & PR',
    GATE: 'Gate',
    VALIDATE: 'Validation',
    MERGE: 'Merging',
    PARKED: 'Parked',
  });
  // CI_CHECKS is deliberately absent -- it stays under "Gate", no move.
  assert.ok(!('CI_CHECKS' in COLUMN_BY_STATE));
  // FINISH is deliberately absent too -- it keeps its own existing (blocking) move to "Done" in
  // steps/scripted.js's realFinish, never through this shared, non-blocking helper.
  assert.ok(!('FINISH' in COLUMN_BY_STATE));
});

for (const [state, column] of Object.entries({
  WORKTREE: 'Planning',
  IMPLEMENT: 'Implementing',
  CHECK: 'Checks & PR',
  GATE: 'Gate',
  VALIDATE: 'Validation',
  MERGE: 'Merging',
  PARKED: 'Parked',
})) {
  test(`moveCard(${state}): npm run board:move -- <issue> "${column}", cwd = worktree`, () => {
    const worktreePath = mkTmp('spo-board-wt-');
    const ctx = ctxFor(4242, worktreePath);
    let call = null;
    const deps = {
      spawnSync: (command, args, opts) => {
        call = { command, args: [...args], cwd: opts && opts.cwd };
        return ok('');
      },
    };

    moveCard(ctx, deps, state);

    assert.deepEqual(call, { command: 'npm', args: ['run', 'board:move', '--', '4242', column], cwd: worktreePath });
    const journal = readJournal(ctx.taskDir);
    assert.ok(journal.some((e) => e.event === 'board-move' && e.column === column));
  });
}

test('moveCard: CI_CHECKS (unmapped) is a silent no-op -- no spawn, no journal write', () => {
  const ctx = ctxFor(1, mkTmp('spo-board-wt-noop-'));
  let called = false;
  const deps = { spawnSync: () => { called = true; return ok(''); } };

  moveCard(ctx, deps, 'CI_CHECKS');

  assert.equal(called, false);
  assert.equal(fs.existsSync(path.join(ctx.taskDir, 'journal.jsonl')), false);
});

test('moveCard: no worktree yet -- skips the spawn, journals board-move-skipped (reason: no worktree)', () => {
  const ctx = ctxFor(5, undefined);
  let called = false;
  const deps = { spawnSync: () => { called = true; return ok(''); } };

  moveCard(ctx, deps, 'GATE');

  assert.equal(called, false);
  const journal = readJournal(ctx.taskDir);
  const skipped = journal.find((e) => e.event === 'board-move-skipped');
  assert.ok(skipped);
  assert.equal(skipped.reason, 'no worktree');
  assert.equal(skipped.column, 'Gate');
});

test('moveCard: no issue number -- skips the spawn, journals board-move-skipped (reason: no issue)', () => {
  const ctx = ctxFor(undefined, mkTmp('spo-board-wt-noissue-'));
  let called = false;
  const deps = { spawnSync: () => { called = true; return ok(''); } };

  moveCard(ctx, deps, 'MERGE');

  assert.equal(called, false);
  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'board-move-skipped' && e.reason === 'no issue'));
});

test('moveCard: a failing board:move exit is journaled but never blocks (never throws)', () => {
  const worktreePath = mkTmp('spo-board-wt-fail-');
  const ctx = ctxFor(6, worktreePath);
  const deps = { spawnSync: () => fail(1) };

  assert.doesNotThrow(() => moveCard(ctx, deps, 'MERGE'));

  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'board-move-failed' && e.column === 'Merging' && e.exit === 1));
});

// ---- action 2.1b: board.js's own spawns are now bounded too ----------------------------------
//
// board.js used to spawn `npm run board:move` through its own private runSync with NO timeout at
// all -- moveCard is called mid-step from INSIDE realWorktree/realCheck/realGate/realMerge
// (steps/scripted.js), so a hung board:move could freeze the daemon just as effectively as any
// of the calls action 2.1 already bounded. Unlike spawnStep's own retry-then-ParkSignal policy, a
// timeout here must stay inside board.js's own "never blocks the task" contract: journalled as
// board-move-failed (the failure moveCard already models), never thrown, never retried.

test('moveCard: action 2.1b -- arms the npm-run class timeout from ctx.config.commandTimeoutsMs', () => {
  const worktreePath = mkTmp('spo-board-wt-timeout-');
  const ctx = { ...ctxFor(4300, worktreePath), config: { commandTimeoutsMs: { 'npm-run': 660000 } } };
  let seenOpts = null;
  const deps = { spawnSync: (command, args, opts) => { seenOpts = opts; return ok(''); } };

  moveCard(ctx, deps, 'GATE');

  assert.equal(seenOpts.timeout, 660000);
});

test('moveCard: no config on ctx -- arms no timeout (pre-2.1b behaviour), never crashes', () => {
  const worktreePath = mkTmp('spo-board-wt-noconfig-');
  const ctx = ctxFor(4301, worktreePath); // no .config at all, like every pre-existing test above
  let seenOpts = null;
  const deps = { spawnSync: (command, args, opts) => { seenOpts = opts; return ok(''); } };

  moveCard(ctx, deps, 'GATE');

  assert.equal(seenOpts.timeout, undefined);
});

test('moveCard: a timed-out board:move never throws (board.js\'s "never blocks" contract) and is journalled as board-move-failed with timedOut: true', () => {
  const worktreePath = mkTmp('spo-board-wt-timeout2-');
  const ctx = { ...ctxFor(4302, worktreePath), config: { commandTimeoutsMs: { 'npm-run': 660000 } } };
  const deps = { spawnSync: () => timeoutResult() };

  assert.doesNotThrow(() => moveCard(ctx, deps, 'GATE'));

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'board-move-failed');
  assert.ok(failed, 'the timeout must still be reported through board-move-failed, not silently swallowed');
  assert.equal(failed.column, 'Gate');
  assert.equal(failed.timedOut, true);
  assert.notEqual(failed.exit, 1, 'a timeout must never be journalled as a plain exit 1');
});

test('moveCard: a timed-out board:move mid-step does not break the caller -- realGate/realWorktree/realMerge see moveCard return normally', async () => {
  // realGate/realWorktree/realCheck/realMerge all call moveCard as their very first line and
  // never look at its return value -- the property that matters is simply that moveCard RETURNS
  // (never throws), which the previous test already proves directly. This test exercises it one
  // level up, through the real state-machine handler, so a future moveCard call site cannot
  // silently start propagating a park signal without a test failing here.
  const { realCheck } = require('../orchestrator/steps/scripted');
  const worktreePath = mkTmp('spo-board-wt-realcheck-');
  const ctx = buildCtx(
    'card-realcheck-timeout',
    { id: 'card-realcheck-timeout', kind: 'card', issue: 4303, worktreePath },
    mkTmp('spo-board-taskdir-realcheck-'),
    { commandTimeoutsMs: { 'npm-run': 660000 }, deps: {} }
  );
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'npm' && args.includes('board:move')) return timeoutResult();
      return ok(''); // typecheck/lint/coverage:changed all pass
    },
  };

  const next = await realCheck(ctx, deps);

  assert.equal(next, 'PUSH_PR', 'CHECK still proceeds normally -- the board move never blocked it');
  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'board-move-failed' && e.timedOut === true));
});

test('runSync (board.js): action 2.1b -- an explicit opts.timeout still wins over the class default', () => {
  let seenOpts = null;
  const deps = { spawnSync: (command, args, opts) => { seenOpts = opts; return ok(''); } };

  runSync(deps, 'npm', ['run', 'board:move', '--', '1', 'Gate'], { timeout: 5000, cwd: '/wt' }, { commandTimeoutsMs: { 'npm-run': 660000 } });

  assert.equal(seenOpts.timeout, 5000);
  assert.equal(seenOpts.cwd, '/wt');
});

// ---- moveIssueToColumn: the ctx/taskDir-free sibling for report-intake.js/auto-triage.js -----

test('moveIssueToColumn: spawns npm run board:move -- <issue> <column> with the given cwd, returns {ok: true}', () => {
  let seen = null;
  const deps = { spawnSync: (command, args, opts) => { seen = { command, args, opts }; return ok(''); } };

  const result = moveIssueToColumn(707, 'Intake', deps, { cwd: '/fake/product-repo' });

  assert.equal(result.ok, true);
  assert.equal(seen.command, 'npm');
  assert.deepEqual(seen.args, ['run', 'board:move', '--', '707', 'Intake']);
  assert.equal(seen.opts.cwd, '/fake/product-repo');
});

test('moveIssueToColumn: a failing exit returns {ok: false, exit} -- never throws, no journal (caller\'s job)', () => {
  const deps = { spawnSync: () => fail(4) };
  const result = moveIssueToColumn(707, 'Intake', deps, { cwd: '/fake/product-repo' });
  assert.equal(result.ok, false);
  assert.equal(result.exit, 4);
});

test('moveIssueToColumn: action 2.1b -- arms the npm-run class timeout only when opts.config is passed', () => {
  let seenOpts = null;
  const deps = { spawnSync: (command, args, opts) => { seenOpts = opts; return ok(''); } };

  moveIssueToColumn(707, 'Intake', deps, { cwd: '/fake/product-repo', config: { commandTimeoutsMs: { 'npm-run': 660000 } } });
  assert.equal(seenOpts.timeout, 660000);

  moveIssueToColumn(707, 'Intake', deps, { cwd: '/fake/product-repo' }); // no config -- pre-2.1b behaviour
  assert.equal(seenOpts.timeout, undefined);
});

test('moveIssueToColumn: a timed-out spawn returns {ok: false, exit: -1, timedOut: true} -- never throws', () => {
  const deps = { spawnSync: () => timeoutResult() };
  const result = moveIssueToColumn(707, 'Intake', deps, {
    cwd: '/fake/product-repo',
    config: { commandTimeoutsMs: { 'npm-run': 660000 } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exit, 1, 'a timeout must never be reported as a plain exit 1');
});

// ---- HANDLERS.IMPLEMENT / HANDLERS.VALIDATE, real mode: moveCard fires before the LLM call ---
//
// Neither IMPLEMENT nor VALIDATE has a realX(ctx, deps) split of its own (they are LLM steps,
// steps/llm.js's runLlm) -- moveCard is called directly inside the handler, gated on
// isRealMode(ctx), sourcing its deps from ctx.deps (buildCtx's config.deps). The "legacy
// ctx.task.llm.<STEP>" override shape (same one test/account-rotation.test.js uses) is used
// here to reach a real callLlmStep call without needing the full step-contracts.js /
// prompt-template.js / task-values.js wiring a `kind: "card"` task would otherwise need.

function realShapedPayload(resultString) {
  return JSON.stringify({
    result: resultString,
    is_error: false,
    num_turns: 1,
    session_id: 'sess-board-1',
    modelUsage: { 'claude-x': { costUSD: 0.001 } },
    terminal_reason: 'success',
    api_error_status: null,
  });
}

function realCtxWithOneAccount(task, taskDir) {
  const accountsDir = mkTmp('spo-board-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  return buildCtx(task.id, task, taskDir, {
    shadowMode: false,
    dryRun: false,
    real: true,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
    deps: { spawnSync: task.__spawnSync },
  });
}

test('HANDLERS.IMPLEMENT (real mode): moves the card to "Implementing" before the llm call', async () => {
  const taskDir = mkTmp('spo-implement-board-');
  const worktreePath = mkTmp('spo-implement-board-wt-');
  const calls = [];
  const spawnSync = (command, args, opts) => {
    calls.push({ command, args: [...args], cwd: opts && opts.cwd });
    if (command === 'claude') return ok(realShapedPayload('ok'));
    return ok('');
  };
  const task = {
    id: 'card-701',
    kind: 'card',
    issue: 701,
    worktreePath,
    llm: { IMPLEMENT: { model: 'sonnet', effort: 'low', promptText: 'implement it' } },
    __spawnSync: spawnSync,
  };
  const ctx = realCtxWithOneAccount(task, taskDir);

  const next = await HANDLERS.IMPLEMENT(ctx);

  assert.equal(next, 'CHECK');
  const moveIdx = calls.findIndex((c) => c.command === 'npm');
  const claudeIdx = calls.findIndex((c) => c.command === 'claude');
  assert.ok(moveIdx !== -1 && claudeIdx !== -1 && moveIdx < claudeIdx, 'board move happens before the llm call');
  assert.deepEqual(calls[moveIdx], {
    command: 'npm',
    args: ['run', 'board:move', '--', '701', 'Implementing'],
    cwd: worktreePath,
  });
});

test('HANDLERS.VALIDATE (real mode): moves the card to "Validation" before either llm call, once, regardless of touchesRdoMembers', async () => {
  const taskDir = mkTmp('spo-validate-board-');
  const worktreePath = mkTmp('spo-validate-board-wt-');
  const calls = [];
  // The legacy ctx.task.llm.<STEP> override (used by the IMPLEMENT test above) returns
  // invokeClaudeReal's own {ok, result: <string>, ...} shape unparsed -- handleValidate needs
  // result.verdict, which only the real `kind: "card"` path (step-contracts.js +
  // prompt-template.js, JSON.parse'd against the outputContract) produces. So this test drives
  // that real path instead: no ctx.task.llm.VALIDATE, and a PLAN 'result' event pre-journaled to
  // satisfy VALIDATE's own {{invariants_path}}/{{invariant_ids}} placeholders (task-values.js).
  const spawnSync = (command, args, opts) => {
    calls.push({ command, args: [...args], cwd: opts && opts.cwd });
    if (command === 'claude') {
      return ok(
        JSON.stringify({
          result: JSON.stringify({ verdict: 'PASS', reasons: ['looks fine'], findings: [] }),
          is_error: false,
          num_turns: 1,
          session_id: 'sess-validate-1',
          modelUsage: { 'claude-x': { costUSD: 0.002 } },
          terminal_reason: 'success',
          api_error_status: null,
        })
      );
    }
    return ok('');
  };
  const task = {
    id: 'card-702',
    kind: 'card',
    issue: 702,
    worktreePath,
    criterion: 'the header shows a connection-state badge',
    size: 'S',
    touchesRdoMembers: false,
    __spawnSync: spawnSync,
  };
  const ctx = realCtxWithOneAccount(task, taskDir);
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      plan_path: path.join(taskDir, 'scratch', 'plan-702.md'),
      invariants_path: path.join(taskDir, 'scratch', 'invariants-702.md'),
      invariant_ids: ['INV-1'],
      check_commands: ['npm test'],
    },
  });

  const next = await HANDLERS.VALIDATE(ctx);

  assert.equal(next, 'MERGE');
  const moveIdx = calls.findIndex((c) => c.command === 'npm' && c.args.includes('board:move'));
  assert.equal(moveIdx, 0, 'board move is the very first spawn');
  assert.deepEqual(calls[moveIdx], {
    command: 'npm',
    args: ['run', 'board:move', '--', '702', 'Validation'],
    cwd: worktreePath,
  });
  // Exactly one move -- touchesRdoMembers is false, so citation-verifier never runs and never
  // triggers a second one.
  assert.equal(calls.filter((c) => c.command === 'npm').length, 1);
});
