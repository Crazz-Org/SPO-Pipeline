'use strict';
// Integration-level tests for card #239 chantier action A6's wiring: orchestrator/steps/llm.js's
// invokeClaudeReal attaches orchestrator/live-progress.js's per-message callback to the REAL
// consumeQueryStream (orchestrator/steps/sdk-call.js), not a stubbed one -- same fake-child seam
// test/llm-real.test.js already uses (test/helpers.js's fakeSpawnDeps/fakeSpawnedChild), so every
// test here exercises the real query() stream boundary, not this file's idea of it. Unit-level
// throttle/accumulation/atomicity properties live in test/live-progress.test.js and
// test/dashboard-live-step.test.js; this file proves the three pieces are actually wired together:
// a real call writes a record while it is in flight, and invokeClaudeReal's own `finally` clears
// it no matter how the call ends.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp, fakeSpawnDeps, fakeExecDeps } = require('./helpers');
require('./no-real-spawn');

const { invokeClaudeReal } = require('../orchestrator/steps/llm');
const { readLiveProgress, liveProgressPath } = require('../orchestrator/live-progress');

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function initMessage(sessionId = SESSION_ID) {
  return { type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}

function assistantMessage(text, toolName) {
  const content = [];
  if (toolName) content.push({ type: 'tool_use', name: toolName });
  if (text) content.push({ type: 'text', text });
  return { type: 'assistant', session_id: SESSION_ID, timestamp: new Date().toISOString(), message: { role: 'assistant', content } };
}

function resultMessage(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: SESSION_ID,
    modelUsage: { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 2 } },
    result: 'ok',
    ...overrides,
  };
}

function baseOpts(overrides = {}) {
  return {
    promptText: 'hi',
    model: 'haiku',
    effort: 'low',
    cwd: '/tmp',
    account: { name: 'pool1', configDir: null },
    step: 'IMPLEMENT',
    ...overrides,
  };
}

// captureLiveProgressWrites(taskDir) -> {writes, restore()}. Spies on fs.renameSync for exactly
// the tmp-then-rename pair writeLiveProgress uses, capturing the record's content at each rename
// (read from the tmp source just before it moves) -- the only way to observe what was written
// DURING invokeClaudeReal's own await, since the function does not return until the whole call
// (and its own finally-clear) has already happened.
function captureLiveProgressWrites(taskDir) {
  const writes = [];
  const target = liveProgressPath(taskDir);
  const realRename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (dest === target) {
      try {
        writes.push(JSON.parse(fs.readFileSync(src, 'utf8')));
      } catch {
        /* ignore -- the assertion below on writes.length would fail loudly if this ever happened */
      }
    }
    return realRename.call(fs, src, dest);
  };
  return {
    writes,
    restore() {
      fs.renameSync = realRename;
    },
  };
}

test('invokeClaudeReal: a call with a taskDir writes at least one live-progress record while it runs, and clears it once it returns (success path)', async () => {
  const taskDir = mkTmp('spo-live-wire-');
  const { spawn } = fakeSpawnDeps([initMessage(), assistantMessage('reading the failing test', 'Read'), resultMessage()]);
  const cap = captureLiveProgressWrites(taskDir);
  try {
    const result = await invokeClaudeReal(baseOpts({ taskDir }), fakeExecDeps({ spawn }));
    assert.equal(result.ok, true);
  } finally {
    cap.restore();
  }

  assert.ok(cap.writes.length >= 1, 'expected at least one live-progress write during the call');
  const last = cap.writes[cap.writes.length - 1];
  assert.equal(last.step, 'IMPLEMENT');
  assert.equal(last.account, 'pool1');
  assert.equal(last.turns, 1);
  assert.deepEqual(last.toolCounts, { Read: 1 });
  assert.equal(last.lastText, 'reading the failing test');

  // The property card #239's Done means names explicitly: a card that finished must not leave a
  // record that reads as live.
  assert.equal(readLiveProgress(taskDir), null, 'the record must be cleared once the call returns');
});

test('invokeClaudeReal: a call that FAILS (is_error) still clears its live-progress record -- finished is finished, however it ended', async () => {
  const taskDir = mkTmp('spo-live-wire-');
  const { spawn } = fakeSpawnDeps([
    initMessage(),
    assistantMessage('about to hit a limit', 'Bash'),
    resultMessage({ is_error: true, api_error_status: 429, errors: undefined, result: 'rate limited' }),
  ]);
  const result = await invokeClaudeReal(baseOpts({ taskDir }), fakeExecDeps({ spawn }));
  assert.equal(result.ok, false);
  assert.equal(readLiveProgress(taskDir), null, 'a failed call must not leave a live-looking record behind either');
});

test('invokeClaudeReal: no taskDir supplied -- no progress recording attempted, and the call is otherwise unaffected (existing callers that never pass one)', async () => {
  const { spawn } = fakeSpawnDeps([initMessage(), assistantMessage('x', 'Bash'), resultMessage()]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.ok, true); // no throw, no crash from the missing taskDir
});

test('invokeClaudeReal: two sequential calls against the SAME taskDir (an account-rotation retry) never leave the first call\'s record behind for the second to inherit', async () => {
  const taskDir = mkTmp('spo-live-wire-');
  const { spawn: spawn1 } = fakeSpawnDeps([initMessage(), assistantMessage('first attempt', 'Bash'), resultMessage({ is_error: true, api_error_status: 429, result: 'rate limited' })]);
  await invokeClaudeReal(baseOpts({ taskDir, account: { name: 'pool1', configDir: null } }), fakeExecDeps({ spawn: spawn1 }));
  assert.equal(readLiveProgress(taskDir), null); // cleared after the failed first attempt

  const { spawn: spawn2 } = fakeSpawnDeps([initMessage(), assistantMessage('second attempt, different account', 'Read'), resultMessage()]);
  const cap = captureLiveProgressWrites(taskDir);
  try {
    const result2 = await invokeClaudeReal(baseOpts({ taskDir, account: { name: 'pool2', configDir: null } }), fakeExecDeps({ spawn: spawn2 }));
    assert.equal(result2.ok, true);
  } finally {
    cap.restore();
  }
  // Every record captured during the SECOND call must carry the second call's own account --
  // never a mix of the first attempt's leftover state (proving createProgressCallback's
  // per-call, not per-taskDir, accumulator: a fresh closure every invokeClaudeReal call).
  assert.ok(cap.writes.length >= 1);
  for (const w of cap.writes) assert.equal(w.account, 'pool2');
  assert.equal(cap.writes[cap.writes.length - 1].lastText, 'second attempt, different account');
  assert.equal(readLiveProgress(taskDir), null);
});
