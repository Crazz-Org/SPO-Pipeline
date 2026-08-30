'use strict';
// Unit tests for orchestrator/steps/llm.js's real `kind: "card"` path: step-contracts.js +
// prompt-template.js wired into runLlm's real branch (no ctx.task.llm.<step> override present).
// Every spawn is injected via deps.spawnSync -- no real `claude` CLI call, ever.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runLlm } = require('../orchestrator/steps/llm');
const { ParkSignal } = require('../orchestrator/park-signal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeSpawnSync(responder) {
  return (command, argv, opts) => responder(command, argv, opts);
}

function realShapedReply(resultObj, overrides = {}) {
  return {
    result: JSON.stringify(resultObj),
    is_error: false,
    num_turns: 1,
    session_id: 'sess-card-1',
    modelUsage: { 'claude-fable-5': { costUSD: 0.002 } },
    terminal_reason: 'success',
    api_error_status: null,
    ...overrides,
  };
}

function cardCtx({ taskDir, task, account }) {
  return {
    shadowMode: false,
    dryRun: false,
    taskDir,
    task,
    account: account || { name: 'default', configDir: null },
    config: { stepDeadlineMs: 30000 },
  };
}

// ---- happy path: contract + template feed a real spawn ------------------------------------

test('PLAN real card path: builds argv from step-contracts + filled template, returns the parsed+validated payload', async () => {
  const taskDir = mkTmp('spo-card-plan-');
  const task = {
    kind: 'card',
    issue: 99,
    title: 'Add a widget',
    criterion: 'the widget renders',
    worktreePath: '/tmp/worktree-99',
    size: 'S',
  };

  let seenArgv = null;
  let seenInput = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenArgv = argv;
      seenInput = opts.input;
      const reply = realShapedReply({
        plan_markdown: '# Plan\n\nAdd a widget to the header.\n',
        invariants_markdown: '# Invariants\n\nNone -- new ground.\n',
        invariant_ids: [],
        check_commands: ['npm run typecheck'],
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);

  assert.equal(result.ok, true);
  assert.equal(result.plan_markdown, '# Plan\n\nAdd a widget to the header.\n');
  assert.deepEqual(result.check_commands, ['npm run typecheck']);
  assert.equal(result.sessionId, 'sess-card-1');

  assert.ok(seenArgv.includes('--model'));
  assert.ok(seenArgv.includes('fable')); // no escalation flags on this task
  assert.ok(seenArgv.includes('--effort'));
  assert.ok(seenArgv.includes('low')); // S -> low
  assert.ok(seenArgv.includes('--json-schema'));
  const promptArg = seenInput;
  assert.ok(promptArg.includes('/tmp/worktree-99'));
  assert.ok(promptArg.includes('Add a widget'));

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const call = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(call);
  assert.equal(call.model, 'fable');
});

test('IMPLEMENT real card path escalates to opus when task.touchesRdoMembers is true', async () => {
  const taskDir = mkTmp('spo-card-implement-rdo-');
  const { appendEvent } = require('../orchestrator/journal');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      ok: true,
      plan_path: '/tmp/plan.md',
      invariants_path: '/tmp/invariants.md',
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    },
  });

  const task = {
    kind: 'card',
    issue: 5,
    criterion: 'rdo-members.ts gets a new entry',
    worktreePath: '/tmp/worktree-5',
    size: 'S',
    touchesRdoMembers: true,
  };

  let seenArgv = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      seenArgv = argv;
      const reply = realShapedReply({
        summary: 'added ObjectAt',
        files_changed: ['src/shared/rdo-members.ts'],
        invariants: [{ id: 'INV-1', status: 'HELD' }],
        tests_run: ['npm run typecheck'],
        all_green: true,
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'IMPLEMENT', 'llm.IMPLEMENT', deps);

  assert.equal(result.ok, true);
  assert.equal(result.all_green, true);
  const modelIdx = seenArgv.indexOf('--model');
  assert.equal(seenArgv[modelIdx + 1], 'opus');
});

// ---- missing placeholder -> ParkSignal, no partial fill, no spawn --------------------------

test('missing placeholder value (worktreePath absent) parks instead of spawning', async () => {
  const taskDir = mkTmp('spo-card-missing-placeholder-');
  const task = { kind: 'card', issue: 1, title: 't', criterion: 'c', size: 'S' }; // no worktreePath

  let called = false;
  const deps = { spawnSync: fakeSpawnSync(() => { called = true; return { status: 0, stdout: '{}', stderr: '', signal: null }; }) };

  await assert.rejects(
    () => runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps),
    (err) => err instanceof ParkSignal && err.reason === 'prompt-missing-placeholder:worktree'
  );
  assert.equal(called, false, 'must never spawn once the prompt cannot be filled');
});

// ---- output-contract validation failure -> {kind:'error'}, same shape as a spawn failure ---

test('reply missing a required output key -> {ok:false, kind:"error"}, existing failure path', async () => {
  const taskDir = mkTmp('spo-card-missing-outputkey-');
  const task = {
    kind: 'card',
    issue: 2,
    title: 't',
    criterion: 'c',
    worktreePath: '/tmp/worktree-2',
    size: 'S',
  };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      // PLAN's contract requires plan_markdown/invariants_markdown/invariant_ids/check_commands
      // -- this reply is missing check_commands.
      const reply = realShapedReply({
        plan_markdown: '# Plan\n',
        invariants_markdown: '# Invariants\n',
        invariant_ids: [],
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.error, /check_commands/);
});

test('reply whose result field is not JSON at all -> {ok:false, kind:"error"}', async () => {
  const taskDir = mkTmp('spo-card-nonjson-reply-');
  const task = { kind: 'card', issue: 3, title: 't', criterion: 'c', worktreePath: '/tmp/worktree-3', size: 'S' };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({});
      reply.result = 'not json at all';
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
});

// ---- DIAGNOSE's snake_case/camelCase bridge -------------------------------------------------

test('DIAGNOSE reply root_cause is also exposed as rootCause (handleDiagnose reads the camelCase name)', async () => {
  const taskDir = mkTmp('spo-card-diagnose-alias-');
  const task = { kind: 'card', issue: 4, worktreePath: '/tmp/worktree-4' };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({
        root_cause: 'coverage regression in foo.ts',
        category: 'coverage',
        suggested_fix: 'add a test for the new branch',
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'DIAGNOSE', 'llm.DIAGNOSE', deps);
  assert.equal(result.ok, true);
  assert.equal(result.root_cause, 'coverage regression in foo.ts');
  assert.equal(result.rootCause, 'coverage regression in foo.ts');
});
