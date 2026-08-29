'use strict';
// Unit tests for HANDLERS.IMPLEMENT (state-machine.js's handleImplement) validating the
// filesChanged payload before routing to CHECK. Evidence: a real run of card issue-247 saw
// IMPLEMENT return {ok: true, filesChanged: "[]", allGreen: "false", summary: "Cannot proceed:
// ..."}; the old code took payload.ok !== false at face value and sent it to CHECK, which
// passed on the untouched worktree, and PUSH_PR only then parked (push-pr-failed) two states and
// one misleading reason later. This handler now also validates files_changed in real mode, only
// when the payload actually carries that field -- see state-machine.js's handleImplement for why
// (--dry-run's canned payload and the legacy ctx.task.llm.IMPLEMENT override both need to keep
// working unmodified; test/board-move.test.js and test/dry-run-demo.test.js cover those).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { appendEvent } = require('../orchestrator/journal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}
function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Real-mode ctx driving IMPLEMENT through the full `kind: "card"` path (step-contracts.js +
// prompt-template.js + task-values.js) -- no ctx.task.llm.IMPLEMENT override, so the payload
// actually carries files_changed the way a real reply does. Mirrors
// test/board-move.test.js's realCtxWithOneAccount/appendEvent-PLAN-result setup.
function realCardCtx(task, taskDir, spawnSync) {
  const accountsDir = mkTmp('spo-implement-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      plan_path: path.join(taskDir, 'scratch', `plan-${task.issue}.md`),
      invariants_path: path.join(taskDir, 'scratch', `invariants-${task.issue}.md`),
      invariant_ids: ['INV-1'],
      check_commands: ['npm test'],
    },
  });
  return buildCtx(task.id, task, taskDir, {
    shadowMode: false,
    dryRun: false,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
    deps: { spawnSync },
  });
}

function claudeReply(resultObj) {
  return JSON.stringify({
    result: JSON.stringify(resultObj),
    is_error: false,
    num_turns: 1,
    session_id: 'sess-implement-1',
    modelUsage: { 'claude-x': { costUSD: 0.01 } },
    terminal_reason: 'success',
    api_error_status: null,
  });
}

function baseTask(issue) {
  const worktreePath = mkTmp(`spo-implement-wt-${issue}-`);
  return {
    id: `card-${issue}`,
    kind: 'card',
    issue,
    criterion: 'the widget renders',
    worktreePath,
    size: 'S',
    touchesRdoMembers: false,
  };
}

test('handleImplement (real mode): filesChanged as a JSON-encoded empty-array string routes to DIAGNOSE, not CHECK (today\'s issue-247 shape)', async () => {
  const task = baseTask(247);
  const taskDir = mkTmp('spo-implement-emptystr-');
  const spawnSync = (command) => {
    if (command === 'claude') {
      return ok(
        claudeReply({
          summary: 'Cannot proceed: the required plan file ... does not exist',
          files_changed: '[]',
          invariants: [],
          tests_run: [],
          all_green: 'false',
        })
      );
    }
    return ok('');
  };
  const ctx = realCardCtx(task, taskDir, spawnSync);

  const next = await HANDLERS.IMPLEMENT(ctx);

  assert.equal(next, 'DIAGNOSE');
  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'empty-implement'), 'expected an empty-implement journal event');
});

test('handleImplement (real mode): a real empty array (not a string) also routes to DIAGNOSE', async () => {
  const task = baseTask(248);
  const taskDir = mkTmp('spo-implement-emptyarr-');
  const spawnSync = (command) => {
    if (command === 'claude') {
      return ok(claudeReply({ summary: 'nothing to do', files_changed: [], invariants: [], tests_run: [], all_green: false }));
    }
    return ok('');
  };
  const ctx = realCardCtx(task, taskDir, spawnSync);

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'DIAGNOSE');
});

test('handleImplement (real mode): an unparsable filesChanged string routes to DIAGNOSE (missing/unparsable treated as empty)', async () => {
  const task = baseTask(249);
  const taskDir = mkTmp('spo-implement-badjson-');
  const spawnSync = (command) => {
    if (command === 'claude') {
      return ok(claudeReply({ summary: 'x', files_changed: 'not json', invariants: [], tests_run: [], all_green: false }));
    }
    return ok('');
  };
  const ctx = realCardCtx(task, taskDir, spawnSync);

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'DIAGNOSE');
});

test('handleImplement (real mode): a legitimate implement with red tests (non-empty filesChanged, all_green false) still goes to CHECK', async () => {
  const task = baseTask(250);
  const taskDir = mkTmp('spo-implement-redtests-');
  const spawnSync = (command) => {
    if (command === 'claude') {
      return ok(
        claudeReply({
          summary: 'added the widget, one test still failing',
          files_changed: ['src/widget.ts'],
          invariants: [{ id: 'INV-1', status: 'HELD' }],
          tests_run: ['npm run typecheck'],
          all_green: false,
        })
      );
    }
    return ok('');
  };
  const ctx = realCardCtx(task, taskDir, spawnSync);

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'CHECK');
});

test('handleImplement (shadow mode): an explicit empty-filesChanged fixture is exempt -- shadow mode is not validated, still reaches CHECK', async () => {
  const taskDir = mkTmp('spo-implement-shadow-empty-');
  const task = {
    id: 'synth-1',
    kind: 'synthetic',
    shadow: { llm: { IMPLEMENT: { ok: true, filesChanged: '[]', allGreen: false } } },
  };
  const ctx = buildCtx(task.id, task, taskDir, { shadowMode: true, dryRun: false });

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'CHECK');
});

test('handleImplement (shadow mode): no llm.IMPLEMENT fixture wired (null default) still reaches CHECK, unchanged pre-existing behaviour', async () => {
  const taskDir = mkTmp('spo-implement-shadow-nofixture-');
  const task = { id: 'synth-2', kind: 'synthetic' };
  const ctx = buildCtx(task.id, task, taskDir, { shadowMode: true, dryRun: false });

  const next = await HANDLERS.IMPLEMENT(ctx);
  assert.equal(next, 'CHECK');
});
