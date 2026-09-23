'use strict';
// Unit tests for orchestrator/steps/sdk-call.js's consumeQueryStream (card #239 chantier, action
// A4). Same hermetic shape as test/sdk-call-options.test.js's own "argv-level" test (A3, case 3),
// reused here rather than invented a second time (per this action's brief): a fake `claude`
// executable -- a throwaway `node` script that writes literal stream-json lines to its own
// stdout, never a live agent -- run through a REAL `query()` call from the vendored SDK, so every
// test here exercises the SDK's own message parser/validator, not this builder's idea of it. No
// test writes to a raw os.tmpdir() path directly (mkTmp() only, test/*-sweep.test.js enforces this
// repo-wide) and no test reaches a real `claude` process (SPO_NO_REAL_SPAWN's own guard covers
// spawnSync only -- see sdk-call-options.test.js's own comment on why that is not a gap here: this
// file's fixture is a `node` script, never `claude`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp } = require('./helpers');

// See sdk-call-options.test.js's own comment on why this require has to land before the
// orchestrator require(s) below -- repeated here because this is a separate test file/process.
require('./no-real-spawn');

const { consumeQueryStream } = require('../orchestrator/steps/sdk-call');
const { loadQuery } = require('../orchestrator/sdk');

// writeFakeClaude(dir, lines, exitCode) -- a `node` script that writes each of `lines` (already
// plain JS objects, embedded as a JSON literal -- JSON is a syntactic subset of a JS array/object
// literal, so no escaping step is needed between "the message this test wants the SDK to see" and
// "the source text of the fixture that emits it") as one stream-json line each, then exits with
// `exitCode`. Embedding the messages directly into the fixture's source (rather than round-
// tripping them through an env var, the way sdk-call-options.test.js's argv probe does for its one
// dump-file PATH) avoids that file's own cross-test env-var-name concern entirely: this fixture
// carries its own fixed content, nothing shared mutates between tests.
function writeFakeClaude(dir, lines, exitCode = 0) {
  const fixturePath = path.join(dir, 'fake-claude.js');
  const body = [
    '#!/usr/bin/env node',
    `const lines = ${JSON.stringify(lines)};`,
    'for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");',
    `process.exit(${exitCode});`,
    '',
  ].join('\n');
  fs.writeFileSync(fixturePath, body, { mode: 0o755 });
  return fixturePath;
}

// runStream(lines, opts) -- the one call every test below makes: build the fake `claude`, get a
// REAL query() stream from it (never faked/stubbed), and hand that stream to the function under
// test. `opts.exitCode` simulates a crashed/killed child (header item 4 of consumeQueryStream's
// own comment); `opts.onMessage` exercises the optional per-message callback (this action's
// "sixth decision").
async function runStream(lines, opts = {}) {
  const tmpDir = mkTmp('sdk-call-stream-');
  const fixturePath = writeFakeClaude(tmpDir, lines, opts.exitCode || 0);
  const query = await loadQuery();
  const stream = query({
    prompt: 'hello',
    options: { pathToClaudeCodeExecutable: fixturePath, cwd: tmpDir, env: process.env },
  });
  const ctx = {};
  if (opts.onMessage) ctx.onMessage = opts.onMessage;
  return consumeQueryStream(stream, ctx);
}

const INIT_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function initMessage(sessionId = INIT_SESSION_ID) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    apiKeySource: 'none',
    model: 'claude-sonnet-4-5',
    cwd: '/tmp',
    tools: [],
    mcp_servers: [],
  };
}

// ---- success, with a json-schema reply (structured_output) -------------------------------------

test('consumeQueryStream: success with structured_output prefers it over result, stringified back into a JSON string', async () => {
  const out = await runStream([
    initMessage(),
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      duration_ms: 1234,
      session_id: INIT_SESSION_ID,
      modelUsage: { 'claude-sonnet-4-5': { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 7 } },
      // Both present -- MEASURED (this file's own header comment) that the real SDK forwards
      // both untouched when a reply carries them, so this test pins structured_output winning
      // rather than assuming the two always agree (they deliberately do NOT here).
      result: '{"foo":"stale text, must not win"}',
      structured_output: { foo: 'bar' },
    },
  ]);

  assert.equal(out.ok, true);
  assert.equal('kind' in out, false, 'a success return must carry no kind key at all, matching invokeClaudeReal');
  assert.equal(out.result, JSON.stringify({ foo: 'bar' }), 'structured_output must win over a stale result string');
  assert.doesNotThrow(() => JSON.parse(out.result), "runLlm's JSON.parse(raw.result) contract must still hold");
  assert.equal(out.sessionId, INIT_SESSION_ID);
  assert.equal(out.tokensSource, 'modelUsage');
  assert.equal(out.freshInputTokens, 10);
  assert.equal(out.cacheCreationTokens, 5);
  assert.equal(out.cacheReadTokens, 2);
  assert.equal(out.outputTokens, 7);
  assert.equal(out.billableTokens, 10 + 5 + 7);
  assert.equal(out.numTurns, 3);
  assert.equal(out.durationS, 1.234);
  assert.equal(out.raw, undefined, 'decision 1: raw is always undefined on this transport, never a fabricated exit code');
});

test('consumeQueryStream: success with only a result string (no structured_output) falls back to it verbatim', async () => {
  const out = await runStream([
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: INIT_SESSION_ID, modelUsage: {}, result: '{"plain":"text"}' },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.result, '{"plain":"text"}');
  // F5 (Opus verifier, fix pass): MUTATION PROOF that this was missing -- adding a hardcoded
  // `tokensSource: 'modelUsage'` after `...tokens` on the success return left 22/22 green, because
  // every success test in this file used `modelUsage:{}` and none pinned the "zero tokens" vs "not
  // reported" distinction `extractTokens` (llm.js) exists to preserve. That distinction is load-
  // bearing: `maybeRecoverTokens` (llm.js, wired in by A7 -- see this file's F6 header note) keys
  // its own recovery attempt on `tokensSource` being FALSY, so a falsely-populated 'modelUsage'
  // here would silently suppress transcript-based recovery on exactly the calls that need it most
  // (a reply that reported nothing recognizable). Pinned here rather than in a new test: this is
  // already the "empty modelUsage" success fixture the mutation exploited.
  assert.equal(out.tokensSource, null, 'an empty modelUsage object must read as "not reported", never a false "modelUsage" source');
  assert.equal(out.billableTokens, 0);
});

test('consumeQueryStream: success with only structured_output (no result key at all) still produces a JSON string', async () => {
  const out = await runStream([
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: INIT_SESSION_ID, modelUsage: {}, structured_output: { hello: 'world' } },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.result, JSON.stringify({ hello: 'world' }));
});

test('consumeQueryStream: success with neither result nor structured_output leaves result undefined (no new failure mode)', async () => {
  const out = await runStream([
    { type: 'result', subtype: 'success', is_error: false, num_turns: 0, session_id: INIT_SESSION_ID, modelUsage: {} },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.result, undefined);
});

// ---- is_error: true, api_error_status: 429 -- the one real limit ever recorded in this repo -----
//
// F1/F2 (Opus verifier, fix pass): the ORIGINAL version of this test used
// `subtype:'error_during_execution'` -- a combination the real CLI's own zod schemas cannot
// produce (measured by the verifier against the live binary, 2.1.274: `api_error_status` and
// `result` exist ONLY on the `subtype:'success'` schema; the error-subtype schema declares
// neither). The Fable incident -- the one limit this repo has ever actually recorded -- arrives
// as `subtype:'success', is_error:true, api_error_status:429, result:'<limit text>'`, with NO
// `errors` field at all. Re-pointed at that realistic shape; the mutation this test exists to
// catch (`if (resultMessage.is_error)` -> `if (resultMessage.subtype !== 'success')` at this
// file's own is_error branch) left 22/22 green against the OLD fixture, because nothing in this
// file exercised `is_error:true` on `subtype:'success'` at all -- re-run below, now red.
test('consumeQueryStream: is_error with api_error_status 429 on subtype:success classifies kind:limit, limitKind:usage, and the limit text survives into result (the Fable incident shape)', async () => {
  const out = await runStream([
    initMessage(),
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      num_turns: 1,
      session_id: INIT_SESSION_ID,
      modelUsage: {},
      result: "You've reached your Fable 5 limit. Your limit resets at 3pm.",
      // No `errors` field -- the error-subtype-only field, structurally absent here (F1).
    },
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'limit');
  assert.equal(out.limitKind, 'usage');
  assert.equal(
    out.result,
    "You've reached your Fable 5 limit. Your limit resets at 3pm.",
    'result must survive on subtype:success -- that schema declares it required, and today\'s transport already carries diagnostic text there on failure'
  );
  assert.equal('error' in out, false, "no error key on subtype:success -- result alone is the diagnostic text, matching today's transport exactly (it never sets error on this branch either)");
  assert.equal(out.apiErrorStatus, 429);
  assert.equal(out.sessionId, INIT_SESSION_ID);
  assert.equal(out.raw, undefined);
});

// ---- a terminal_reason from the allowlist (no api_error_status this time) ----------------------

test('consumeQueryStream: is_error with terminal_reason rate_limit_error (no api_error_status) still classifies kind:limit, limitKind:usage', async () => {
  const out = await runStream([
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'rate_limit_error',
      num_turns: 1,
      session_id: INIT_SESSION_ID,
      modelUsage: {},
      errors: ['rate_limit'],
    },
  ]);
  assert.equal(out.kind, 'limit');
  assert.equal(out.limitKind, 'usage');
  assert.equal(out.terminalReason, 'rate_limit_error');
});

test('consumeQueryStream: is_error with terminal_reason overloaded_error classifies kind:limit, limitKind:overloaded', async () => {
  const out = await runStream([
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'overloaded_error',
      num_turns: 1,
      session_id: INIT_SESSION_ID,
      modelUsage: {},
      errors: ['overloaded'],
    },
  ]);
  assert.equal(out.kind, 'limit');
  assert.equal(out.limitKind, 'overloaded');
});

// ---- each of the four SDKResultError subtypes, mapped without inventing a new failure channel ---

const ERROR_SUBTYPES = ['error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'];

for (const subtype of ERROR_SUBTYPES) {
  test(`consumeQueryStream: is_error subtype ${subtype} with no api_error_status/terminal_reason falls through to kind:error (today's plain-error vocabulary, no new channel)`, async () => {
    const out = await runStream([
      {
        type: 'result',
        subtype,
        is_error: true,
        num_turns: 5,
        session_id: INIT_SESSION_ID,
        modelUsage: {},
        errors: [`${subtype} fired`],
      },
    ]);
    assert.equal(out.ok, false);
    assert.equal(out.kind, 'error');
    assert.equal('limitKind' in out, false, 'a plain error classification must not carry a limitKind key');
    assert.equal(out.error, `${subtype} fired`);
    assert.equal('result' in out, false);
  });
}

// ---- errors: multiple entries joined, never dropped ---------------------------------------------

test('consumeQueryStream: multiple errors entries are joined into one diagnosable string', async () => {
  const out = await runStream([
    { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, session_id: INIT_SESSION_ID, modelUsage: {}, errors: ['first problem', 'second problem'] },
  ]);
  assert.equal(out.error, 'first problem; second problem');
});

// F4 (Opus verifier, fix pass): mutation proof this was missing -- the ORIGINAL code gated
// whether to include `error` at all on `resultMessage.errors.length > 0` (the RAW array), then
// trimmed/filtered AFTER building the object. `errors:['']` has length 1 (passes that gate) but
// trims/filters down to nothing -- so the original code produced `error: ''`, which
// `orchestrator/intake.js`'s `formatLlmFailure` (`raw.error || raw.result || ''`) treats as NO
// SIGNAL AT ALL, the exact collapse the `error` field exists to prevent. And
// `errors:['', '  boom  ', '']` produced `'; boom  ; '` (untrimmed, unfiltered join of the
// ORIGINAL entries) instead of the SDK's own `'boom'` (grepped from the real `sdk.mjs`, see the
// is_error branch's own header comment). Both are asserted here against the fix (gate on the
// POST-filter joined string, not the raw array).
test('consumeQueryStream: an errors array of only blank/whitespace entries never sets a false empty error key', async () => {
  const out = await runStream([
    { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, session_id: INIT_SESSION_ID, modelUsage: {}, errors: [''] },
  ]);
  assert.equal('error' in out, false, "errors:[''] must not produce error:'' -- that reads as formatLlmFailure's 'no signal at all' case");
});

test('consumeQueryStream: errors entries are trimmed and empty entries dropped before joining, matching the SDK\'s own construction', async () => {
  const out = await runStream([
    { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, session_id: INIT_SESSION_ID, modelUsage: {}, errors: ['', '  boom  ', ''] },
  ]);
  assert.equal(out.error, 'boom', "must match the SDK's own errors.map(trim).filter(Boolean).join('; ') construction exactly");
});

// ---- a stream that ends with no result message ---------------------------------------------------

test('consumeQueryStream: a clean exit with no result message reports kind:error with an honest sessionId (known from init)', async () => {
  const out = await runStream([initMessage()], { exitCode: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'error');
  assert.match(out.error, /no result message/);
  assert.equal(out.sessionId, INIT_SESSION_ID, 'a session really was created (init arrived) -- must not report null');
  assert.equal(out.tokensSource, null);
  assert.equal(out.billableTokens, 0);
  assert.equal(out.numTurns, undefined);
  assert.equal(out.durationS, undefined);
  assert.equal(out.raw, undefined);
});

test('consumeQueryStream: a clean exit with no messages at all reports kind:error with sessionId null (no session ever existed)', async () => {
  const out = await runStream([], { exitCode: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'error');
  assert.equal(out.sessionId, null, 'no init message arrived -- must not fabricate a session id');
});

// ---- a stream that throws mid-iteration (a killed/crashed child) --------------------------------

test('consumeQueryStream: a nonzero-exit child with no result message throws mid-stream; caught, sessionId from init preserved', async () => {
  const out = await runStream([initMessage(), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] }, session_id: INIT_SESSION_ID }], {
    exitCode: 1,
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'error');
  assert.match(out.error, /stream threw before a result message arrived/);
  assert.match(out.error, /exited with code 1/, 'the underlying SDK error text must not be swallowed');
  assert.equal(out.sessionId, INIT_SESSION_ID, 'the session really was created before the crash -- must be reported, not nulled out');
  assert.equal(out.tokensSource, null);
  assert.equal(out.raw, undefined);
});

test('consumeQueryStream: a nonzero-exit child with NO init message either reports sessionId null (nothing to be honest about yet)', async () => {
  const out = await runStream([], { exitCode: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'error');
  assert.equal(out.sessionId, null);
});

// ---- sessionId precedence: the result message's own id is the CLI's last word -------------------

test('consumeQueryStream: a result message session_id DIFFERENT from init\'s own wins (the CLI\'s last word, not the first)', async () => {
  const initId = INIT_SESSION_ID;
  const resultId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const out = await runStream([
    initMessage(initId),
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: resultId, modelUsage: {}, result: '{}' },
  ]);
  assert.equal(out.sessionId, resultId, "the result message's own session_id must win over init's");
});

test('consumeQueryStream: a result message with NO session_id keeps whatever init already established', async () => {
  const out = await runStream([initMessage(), { type: 'result', subtype: 'success', is_error: false, num_turns: 1, modelUsage: {}, result: '{}' }]);
  assert.equal(out.sessionId, INIT_SESSION_ID, "absent session_id on the result message must not null out init's");
});

// ---- modelUsage carrying two models (card #214's subagent case) --------------------------------

test('consumeQueryStream: modelUsage with two models preserves the per-model breakdown (card #214)', async () => {
  const out = await runStream([
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 12,
      session_id: INIT_SESSION_ID,
      result: '{"ok":true}',
      modelUsage: {
        'claude-opus-4': { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 30 },
        'claude-haiku-4': { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 1, output_tokens: 3 },
      },
    },
  ]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.modelUsage, {
    'claude-opus-4': { freshInputTokens: 100, cacheCreationTokens: 20, cacheReadTokens: 5, outputTokens: 30, billableTokens: 150 },
    'claude-haiku-4': { freshInputTokens: 10, cacheCreationTokens: 2, cacheReadTokens: 1, outputTokens: 3, billableTokens: 15 },
  });
  // Flat totals are still the SUM across both models -- extractTokens' existing behaviour,
  // unchanged by this transport (see this file's header on "pass-through, not transformed").
  assert.equal(out.freshInputTokens, 110);
  assert.equal(out.cacheCreationTokens, 22);
  assert.equal(out.cacheReadTokens, 6);
  assert.equal(out.outputTokens, 33);
  assert.equal(out.billableTokens, 110 + 22 + 33);
});

// ---- the per-message callback (this action's "sixth decision") ----------------------------------

test('consumeQueryStream: onMessage is called once per message, in order, including the terminal result message', async () => {
  const seen = [];
  const out = await runStream(
    [initMessage(), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, session_id: INIT_SESSION_ID }, { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: INIT_SESSION_ID, modelUsage: {}, result: '{}' }],
    { onMessage: (msg) => seen.push(msg.type) }
  );
  assert.deepEqual(seen, ['system', 'assistant', 'result']);
  assert.equal(out.ok, true);
});

test('consumeQueryStream: an onMessage callback that throws never breaks the primitive\'s own return', async () => {
  const out = await runStream([initMessage(), { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: INIT_SESSION_ID, modelUsage: {}, result: '{}' }], {
    onMessage: () => {
      throw new Error('A6 bug, not consumeQueryStream\'s problem');
    },
  });
  assert.equal(out.ok, true, 'a throwing callback must not get misreported as the stream itself throwing');
  assert.equal(out.result, '{}');
});

test('consumeQueryStream: called with no ctx argument at all (A5 until A6 lands) still works', async () => {
  const tmpDir = mkTmp('sdk-call-stream-');
  const fixturePath = writeFakeClaude(tmpDir, [{ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: INIT_SESSION_ID, modelUsage: {}, result: '{}' }]);
  const query = await loadQuery();
  const stream = query({ prompt: 'hi', options: { pathToClaudeCodeExecutable: fixturePath, cwd: tmpDir, env: process.env } });
  const out = await consumeQueryStream(stream); // no second argument
  assert.equal(out.ok, true);
});
