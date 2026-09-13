'use strict';
// EXP-PLAN-OPUS (2026-09-13, doc/model-experiments.md): PLAN is Opus-first with a Fable fallback.
// These drive handlePlan end to end in real mode with an injected spawnSync, reading the `--model`
// each call was actually launched with. step-contracts.test.js pins the table. What this file pins
// is that the trigger is REACHABLE -- the exact failure the removed 2026-09-04 fallback had -- and
// that it fires only where it should: once per run, on a plan-invalid reply or after a plan-invalid
// park, never on a transport failure, never in shadow mode.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { appendEvent } = require('../orchestrator/journal');
const { writePoolDir, mkTmp } = require('./helpers');

function readJournal(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function envelope(planPayload) {
  return {
    status: 0,
    stdout: JSON.stringify({
      result: JSON.stringify(planPayload),
      is_error: false,
      num_turns: 1,
      session_id: 'sess-plan-fallback',
      modelUsage: { 'claude-opus-5': { costUSD: 0.001 } },
      terminal_reason: 'success',
      api_error_status: null,
    }),
    stderr: '',
    signal: null,
  };
}

const VALID = {
  ok: true,
  plan_markdown: '# Plan\n\nDo the thing.\n',
  invariants_markdown: '# Invariants\n\nINV-1: ...\n',
  invariant_ids: ['INV-1'],
  check_commands: ['npm run typecheck'],
};
const INVALID = { ...VALID, invariants_markdown: '' };
const TRANSPORT_FAILURE = { status: 0, stdout: 'not json at all', stderr: '', signal: null };

// Replies in order, one per spawn. Records each call's --model and --effort.
function scriptedSpawn(replies) {
  const calls = [];
  function spawn(command, argv) {
    calls.push({ model: argv[argv.indexOf('--model') + 1], effort: argv[argv.indexOf('--effort') + 1] });
    if (replies.length === 0) throw new Error('scriptedSpawn: more calls than scripted replies');
    return replies.shift();
  }
  spawn.calls = calls;
  return spawn;
}

function realCtx({ id, taskDir, spawnSync, size = 'S' }) {
  const accountsDir = mkTmp('spo-plan-fallback-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);
  const worktreePath = mkTmp('spo-plan-fallback-wt-');
  const task = { id, kind: 'card', issue: 700, title: 'Some card', criterion: 'done', size, worktreePath };
  return buildCtx(id, task, taskDir, {
    shadowMode: false,
    dryRun: false,
    claudeAccountsDir: accountsDir,
    stepDeadlineMs: 30000,
    deps: { spawnSync },
  });
}

const fallbackEvents = (taskDir) => readJournal(taskDir).filter((e) => e.event === 'plan-model-fallback');
const llmCallModels = (taskDir) => readJournal(taskDir).filter((e) => e.event === 'llm-call').map((e) => e.model);

test('a valid Opus plan: one call, on Opus, at PLAN_EFFORT_BY_SIZE, no fallback event', async () => {
  const taskDir = mkTmp('spo-plan-fallback-a-');
  const spawnSync = scriptedSpawn([envelope(VALID)]);
  const next = await HANDLERS.PLAN(realCtx({ id: 'card-701', taskDir, spawnSync, size: 'M' }));

  assert.equal(next, 'IMPLEMENT');
  assert.deepEqual(spawnSync.calls, [{ model: 'opus', effort: 'high' }]);
  assert.deepEqual(fallbackEvents(taskDir), []);
  assert.deepEqual(llmCallModels(taskDir), ['opus']);
});

test('an invalid Opus reply falls back to ONE Fable call in the same run, which plans the card', async () => {
  const taskDir = mkTmp('spo-plan-fallback-b-');
  const spawnSync = scriptedSpawn([envelope(INVALID), envelope(VALID)]);
  const next = await HANDLERS.PLAN(realCtx({ id: 'card-702', taskDir, spawnSync }));

  assert.equal(next, 'IMPLEMENT');
  assert.deepEqual(
    spawnSync.calls.map((c) => c.model),
    ['opus', 'fable']
  );
  assert.equal(spawnSync.calls[1].effort, 'medium', 'the fallback runs at the same PLAN effort');
  const events = fallbackEvents(taskDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].cause, 'plan-invalid-reply');
  assert.deepEqual(events[0].missing, ['invariants_markdown']);
  assert.deepEqual(llmCallModels(taskDir), ['opus', 'fable']);
  assert.ok(readJournal(taskDir).some((e) => e.event === 'files-written'), 'the Fable plan was written');
});

test('an invalid Fable fallback reply parks plan-invalid -- exactly two calls, never a third', async () => {
  const taskDir = mkTmp('spo-plan-fallback-c-');
  const spawnSync = scriptedSpawn([envelope(INVALID), envelope({ ...VALID, plan_markdown: '  ' })]);

  await assert.rejects(
    () => HANDLERS.PLAN(realCtx({ id: 'card-703', taskDir, spawnSync })),
    (err) => err instanceof ParkSignal && err.reason === 'plan-invalid' && err.detail.missing.includes('plan_markdown')
  );
  assert.equal(spawnSync.calls.length, 2);
  assert.equal(fallbackEvents(taskDir).length, 1);
});

test('a card whose most recent park was plan-invalid starts on Fable, and a still-invalid reply parks after one call', async () => {
  const taskDir = mkTmp('spo-plan-fallback-d-');
  appendEvent(taskDir, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });

  const okSpawn = scriptedSpawn([envelope(VALID)]);
  assert.equal(await HANDLERS.PLAN(realCtx({ id: 'card-704', taskDir, spawnSync: okSpawn })), 'IMPLEMENT');
  assert.deepEqual(
    okSpawn.calls.map((c) => c.model),
    ['fable']
  );
  assert.deepEqual(
    fallbackEvents(taskDir).map((e) => e.cause),
    ['prior-plan-invalid-park']
  );

  const taskDir2 = mkTmp('spo-plan-fallback-d2-');
  appendEvent(taskDir2, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });
  const badSpawn = scriptedSpawn([envelope(INVALID)]);
  await assert.rejects(
    () => HANDLERS.PLAN(realCtx({ id: 'card-705', taskDir: taskDir2, spawnSync: badSpawn })),
    (err) => err instanceof ParkSignal && err.reason === 'plan-invalid'
  );
  assert.equal(badSpawn.calls.length, 1, 'already on Fable -- no second call');
});

test('a plan-invalid park followed by an orthogonal park does not keep the card off Opus', async () => {
  const taskDir = mkTmp('spo-plan-fallback-e-');
  appendEvent(taskDir, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });
  appendEvent(taskDir, 'GATE', 'parked', { reason: 'gate-failed', detail: {} });
  const spawnSync = scriptedSpawn([envelope(VALID)]);

  assert.equal(await HANDLERS.PLAN(realCtx({ id: 'card-706', taskDir, spawnSync })), 'IMPLEMENT');
  assert.deepEqual(
    spawnSync.calls.map((c) => c.model),
    ['opus']
  );
  assert.deepEqual(fallbackEvents(taskDir), []);
});

test('a transport failure on Opus parks llm-transport-failed:PLAN and never falls back', async () => {
  const taskDir = mkTmp('spo-plan-fallback-f-');
  const spawnSync = scriptedSpawn([TRANSPORT_FAILURE]);

  await assert.rejects(
    () => HANDLERS.PLAN(realCtx({ id: 'card-707', taskDir, spawnSync })),
    (err) => err instanceof ParkSignal && err.reason === 'llm-transport-failed:PLAN'
  );
  assert.equal(spawnSync.calls.length, 1);
  assert.deepEqual(fallbackEvents(taskDir), []);
});

test('shadow mode never falls back: an invalid fixture parks plan-invalid with no fallback event', async () => {
  const taskDir = mkTmp('spo-plan-fallback-g-');
  appendEvent(taskDir, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });
  const task = { id: 'card-708', kind: 'card', issue: 708, shadow: { llm: { PLAN: INVALID } } };
  const ctx = buildCtx(task.id, task, taskDir, { shadowMode: true, dryRun: false });

  await assert.rejects(() => HANDLERS.PLAN(ctx), (err) => err instanceof ParkSignal && err.reason === 'plan-invalid');
  assert.deepEqual(fallbackEvents(taskDir), []);
  assert.equal(ctx.task.planInvalidRetry, false);
});
