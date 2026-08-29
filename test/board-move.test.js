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

const { COLUMN_BY_STATE, moveCard } = require('../orchestrator/board');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { appendEvent } = require('../orchestrator/journal');

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
