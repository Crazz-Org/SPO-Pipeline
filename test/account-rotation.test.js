'use strict';
// Integration test for the real-mode account-rotation retry loop (orchestrator/state-
// machine.js's callLlmStep): a {kind: 'limit'} result cools that account down and retries on
// the next healthy one, bounded to one pass over the registry; anything else fails without
// rotating. No real `claude` CLI call -- the spawn is injected all the way through
// callLlmStep -> runLlm -> invokeClaudeReal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { callLlmStep, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const accounts = require('../orchestrator/accounts');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRegistry(dir, list) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(list, null, 2));
}

function realShapedPayload(overrides = {}) {
  return {
    result: 'ok',
    is_error: false,
    num_turns: 1,
    session_id: 'sess-abc',
    modelUsage: { 'claude-haiku-4-5': { costUSD: 0.001 } },
    terminal_reason: 'success',
    api_error_status: null,
    ...overrides,
  };
}

function makeCtx({ taskDir, accountsDir, task }) {
  const ctx = buildCtx('t1', task, taskDir, {
    shadowMode: false,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
  });
  return ctx;
}

test('limit on the first account rotates to the second, which succeeds; first account is cooled down', async () => {
  const taskDir = mkTmp('spo-rotate-taskdir-');
  const accountsDir = mkTmp('spo-rotate-accts-');
  writeRegistry(accountsDir, [
    { name: 'acct-a', configDir: null, enabled: true },
    { name: 'acct-b', configDir: null, enabled: true },
  ]);

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  let call = 0;
  const spawnSync = () => {
    call += 1;
    if (call === 1) {
      return {
        status: 1,
        stdout: JSON.stringify(realShapedPayload({ is_error: true, api_error_status: 429, result: 'rate limited' })),
        stderr: '',
        signal: null,
      };
    }
    return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync });

  assert.equal(call, 2);
  assert.equal(result.ok, true);
  assert.equal(ctx.account.name, 'acct-b');

  const state = accounts.readState(accountsDir);
  assert.ok(state['acct-a'], 'acct-a should be cooling');
  assert.ok(state['acct-a'].cooldownUntil > Date.now());
  assert.ok(!state['acct-b'], 'acct-b should not be cooling');

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const cooldownEvent = journalLines.find((e) => e.event === 'account-cooldown');
  assert.ok(cooldownEvent, 'expected an account-cooldown journal event');
  assert.equal(cooldownEvent.account, 'acct-a');
});

test('a non-limit error fails on the first attempt without rotating accounts', async () => {
  const taskDir = mkTmp('spo-rotate-nolimit-taskdir-');
  const accountsDir = mkTmp('spo-rotate-nolimit-accts-');
  writeRegistry(accountsDir, [
    { name: 'acct-a', configDir: null, enabled: true },
    { name: 'acct-b', configDir: null, enabled: true },
  ]);

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  let call = 0;
  const spawnSync = () => {
    call += 1;
    return {
      status: 1,
      stdout: JSON.stringify(realShapedPayload({ is_error: true, api_error_status: 400, result: 'bad schema' })),
      stderr: '',
      signal: null,
    };
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync });

  assert.equal(call, 1, 'must not retry on a non-limit failure');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');

  const state = accounts.readState(accountsDir);
  assert.deepEqual(state, {}, 'no account should be cooled down for a non-limit failure');
});

test('every account limited -> one pass over the registry, then ParkSignal', async () => {
  const taskDir = mkTmp('spo-rotate-allcool-taskdir-');
  const accountsDir = mkTmp('spo-rotate-allcool-accts-');
  writeRegistry(accountsDir, [
    { name: 'acct-a', configDir: null, enabled: true },
    { name: 'acct-b', configDir: null, enabled: true },
  ]);

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  let call = 0;
  const spawnSync = () => {
    call += 1;
    return {
      status: 1,
      stdout: JSON.stringify(realShapedPayload({ is_error: true, api_error_status: 429, result: 'rate limited' })),
      stderr: '',
      signal: null,
    };
  };

  await assert.rejects(() => callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync }), ParkSignal);
  assert.equal(call, 2, 'exactly one attempt per enabled account, never a third');

  const state = accounts.readState(accountsDir);
  assert.ok(state['acct-a']);
  assert.ok(state['acct-b']);
});

test('starting with every account already cooling -> ParkSignal without spawning at all', async () => {
  const taskDir = mkTmp('spo-rotate-precool-taskdir-');
  const accountsDir = mkTmp('spo-rotate-precool-accts-');
  writeRegistry(accountsDir, [{ name: 'acct-a', configDir: null, enabled: true }]);
  accounts.markLimit(accountsDir, 'acct-a', 60_000);

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  let called = false;
  const spawnSync = () => {
    called = true;
    return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
  };

  let caught = null;
  try {
    await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ParkSignal);
  assert.match(caught.reason, /all-accounts-cooling-until-/);
  assert.equal(called, false, 'must never spawn once pick() already finds nothing healthy');
});
