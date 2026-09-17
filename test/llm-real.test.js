'use strict';
// Unit tests for orchestrator/steps/llm.js's real-mode primitive, invokeClaudeReal.
//
// Card #239 chantier, action A5b (the cutover): this file used to fake the old `claude -p`
// transport via `deps.spawnSync`. That transport (and its argv builder, buildArgv) is deleted.
// Every `invokeClaudeReal`-level test below is migrated onto the new seam instead: `deps.spawn`,
// injected via test/helpers.js's `fakeSpawnDeps`/`fakeSpawnedChild` (a duck-typed, in-memory
// ChildProcess stand-in the vendored Agent SDK's own `query()` runs for real against -- see that
// helper's own header for why this is not a mock of the SDK, only of the OS process boundary one
// layer below it) and `deps.resolveClaudeCodeExecutable` (resolves to a fixed fake path; no real
// PATH walk). Every real spawn is still fake -- this file never touches a real `claude` CLI, or
// even a real spawned OS process, for any test below.
//
// WHAT DID NOT SURVIVE THE CUTOVER, AND WHY (read before assuming a missing test is an oversight):
//   - buildArgv's own 6 tests (exact flag order, --session-id position, non-string sessionId
//     rejection) are deleted outright: buildArgv is deleted production code, and there is no argv
//     any more for these tests to have an opinion about.
//   - invokeClaudeReal generating its OWN session id (deps.randomUUID) was briefly gone for the few
//     days between action A5b's cutover and this action's own Job 2 fix pass -- token-recovery.js's
//     own header tells that story (a killed-before-`init` call had no id for it to search by in
//     between). RESTORED here, so the "session id generation" test block below is back too, adapted
//     onto the new seam (asserting against the real argv `fakeSpawnDeps` captured via its injected
//     `deps.spawn`, since there is no argv array for this function to build and hand to spawnSync
//     any more -- `query()` builds real CLI argv from `options.sessionId` itself, and the fake
//     child never parses it back, so an argv-level assertion has to read `calls[i].args`, the exact
//     list the vendored SDK decided to spawn `claude` with). The "malformed sessionId throws
//     TypeError" property is tested at BOTH levels now, same as before Job 2 touched anything:
//     buildQueryOptions's own throw in detail (test/sdk-call-options.test.js), and here, proving
//     invokeClaudeReal lets it propagate uncaught rather than minting around it.
//   - the CLI reply's `uuid` field (a fallback session id source alongside `session_id`) has no
//     equivalent on this transport -- consumeQueryStream (sdk-call.js, action A4) reads
//     `message.session_id` only, never a `uuid` field; that fallback was specific to the old
//     `--output-format json` reply shape.
//   - E2BIG (a spawnSync argv-size failure) is UNREACHABLE on this transport: the prompt travels
//     as a stdin protocol write with no OS argv/environ size limit, not through argv at all -- see
//     sdk-call.js's own "E2BIG lesson" comment on buildQueryOptions's resolvePromptText call for
//     where this is now recorded. The 200KB-prompt regression test below is kept, adapted to prove
//     the successor property (a huge prompt reaches the child via stdin, never via the spawn
//     call's own argv) rather than a failure mode that no longer exists.
//   - the OLD deadline-vs-external-kill classification read `spawnResult.error.code === 'ETIMEDOUT'`
//     off Node's own spawnSync result -- an OS-level signal carrying no direct evidence of WHO
//     decided to kill the process. This transport's classification is direct instead: `deadlineHit`
//     is a boolean THIS function's own setTimeout sets when IT decides to call `abort()` -- there is
//     no ETIMEDOUT/signal-guessing matrix to reproduce, so the ~6 old tests that pinned every cell
//     of that guessing matrix (deadline+SIGTERM, deadline+SIGKILL, external+SIGTERM,
//     external+SIGKILL, the corpus's own ETIMEDOUT/signal-null/status-143 shape, ...) are
//     consolidated into the smaller set the new, simpler decision actually has.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp, fakeSpawnDeps, fakeSpawnedChild, fakeExecDeps } = require('./helpers');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const {
  runLlm,
  invokeClaudeReal,
  resolvePromptText,
  extractTokens,
  classifyFailure,
  cannedDryRunPayload,
  maybeRecoverTokens,
} = require('../orchestrator/steps/llm');

const FAKE_EXECUTABLE_PATH = '/fake/bin/claude'; // never resolved for real -- always injected
const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fakeResolver(returnValue) {
  return () => returnValue;
}

// initMessage/resultMessage -- the two stream-json messages consumeQueryStream (sdk-call.js)
// actually reads; same shapes test/sdk-call-stream.test.js's own fixtures use. Card #239 chantier,
// action A5b: this file's equivalent of the old realShapedPayload() helper, one layer down (a
// stream of messages instead of one parsed `--output-format json` object).
function initMessage(sessionId = SESSION_ID) {
  return { type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}

function resultMessage(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: SESSION_ID,
    modelUsage: {
      'claude-haiku-4-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
    result: 'ok',
    ...overrides,
  };
}

// A minimal opts base every invokeClaudeReal call below extends -- cuts the per-test boilerplate
// the old file's every single test repeated (promptText/model/effort/cwd/account).
function baseOpts(overrides = {}) {
  return {
    promptText: 'hi',
    model: 'haiku',
    effort: 'low',
    cwd: '/tmp',
    account: { name: 'default', configDir: null },
    ...overrides,
  };
}

// fakeExecDeps -- F9 (Opus verifier, fix pass): now shared from test/helpers.js (this file's own
// FAKE_EXECUTABLE_PATH above and helpers.js's own hardcoded fake path are the same literal
// '/fake/bin/claude'), rather than hand-rolled here. This file's own top-of-file
// `require('./no-real-spawn')` arms SPO_NO_REAL_SPAWN process-wide (see that require's own
// comment, and orchestrator/steps/sdk-call.js's spawnClaudeCodeProcess, which action A5b wired to
// that SAME check) -- every deps object built for an invokeClaudeReal call in this file therefore
// has to opt back out explicitly, which is exactly what the shared helper does. The override is
// deps-scoped, never an env mutation, so it can never leak into a sibling test.

// ---- resolvePromptText ------------------------------------------------------------------------
// Untouched by action A5b -- still the same function, still called the same way (now from
// sdk-call.js's buildQueryOptions instead of the old buildArgv). No migration needed.

test('resolvePromptText: promptFile is read and used as the prompt text', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = mkTmp('spo-promptfile-');
  const file = path.join(dir, 'prompt.txt');
  fs.writeFileSync(file, 'from a file');
  assert.equal(resolvePromptText({ promptFile: file }), 'from a file');
});

test('resolvePromptText: no promptText or promptFile throws', () => {
  assert.throws(() => resolvePromptText({ model: 'haiku' }), /promptText or promptFile/);
});

// ---- extractTokens / classifyFailure -----------------------------------------------------------
// Untouched by action A5b -- both are pure functions invoked identically by consumeQueryStream
// (sdk-call.js) as they were by the old transport's invokeClaudeReal (see that file's own header:
// "MEASURED... there is nothing SDK-specific to translate"). No migration needed.

test('extractTokens: camelCase modelUsage fields (the shape this repo has actually observed)', () => {
  const tokens = extractTokens({
    'claude-haiku-4-5': { inputTokens: 100, cacheCreationInputTokens: 50, cacheReadInputTokens: 10, outputTokens: 20 },
  });
  assert.equal(tokens.tokensSource, 'modelUsage');
  assert.equal(tokens.freshInputTokens, 100);
  assert.equal(tokens.cacheCreationTokens, 50);
  assert.equal(tokens.cacheReadTokens, 10);
  assert.equal(tokens.outputTokens, 20);
  assert.equal(tokens.billableTokens, 100 + 50 + 20); // NOT + cacheRead
});

test('extractTokens: snake_case modelUsage fields (the real per-message usage block\'s spelling)', () => {
  const tokens = extractTokens({
    'claude-sonnet-5': { input_tokens: 200, cache_creation_input_tokens: 30, cache_read_input_tokens: 5, output_tokens: 15 },
  });
  assert.equal(tokens.tokensSource, 'modelUsage');
  assert.equal(tokens.freshInputTokens, 200);
  assert.equal(tokens.cacheCreationTokens, 30);
  assert.equal(tokens.cacheReadTokens, 5);
  assert.equal(tokens.outputTokens, 15);
  assert.equal(tokens.billableTokens, 200 + 30 + 15);
});

test('extractTokens: mixed casing across two model entries sums correctly and stays defensive per-field', () => {
  const tokens = extractTokens({
    'model-a': { inputTokens: 10, output_tokens: 2 },
    'model-b': { input_tokens: 5, outputTokens: 1, cacheCreationInputTokens: 3 },
  });
  assert.equal(tokens.tokensSource, 'modelUsage');
  assert.equal(tokens.freshInputTokens, 15);
  assert.equal(tokens.outputTokens, 3);
  assert.equal(tokens.cacheCreationTokens, 3);
  assert.equal(tokens.cacheReadTokens, 0);
});

test('extractTokens: a model entry with no recognized field contributes 0, never throws', () => {
  const tokens = extractTokens({
    'model-a': { inputTokens: 10, outputTokens: 2 },
    'model-c': {},
    'model-d': { someUnrelatedField: 'x' },
  });
  assert.equal(tokens.tokensSource, 'modelUsage');
  assert.equal(tokens.freshInputTokens, 10);
  assert.equal(tokens.outputTokens, 2);
});

test('extractTokens: absent/empty/malformed modelUsage -> tokensSource null, every count 0 (never silently "0 cost")', () => {
  assert.equal(extractTokens(undefined).tokensSource, null);
  assert.equal(extractTokens(null).tokensSource, null);
  assert.equal(extractTokens('not an object').tokensSource, null);
  assert.equal(extractTokens({}).tokensSource, null);
  const tokens = extractTokens({ 'model-a': {}, 'model-b': { someUnrelatedField: 1 } });
  assert.equal(tokens.tokensSource, null);
  assert.equal(tokens.freshInputTokens, 0);
  assert.equal(tokens.cacheCreationTokens, 0);
  assert.equal(tokens.cacheReadTokens, 0);
  assert.equal(tokens.outputTokens, 0);
  assert.equal(tokens.billableTokens, 0);
});

test('extractTokens: billable-weighted total excludes cache-read even when cache-read dwarfs the rest', () => {
  const tokens = extractTokens({
    'claude-fable-5': { inputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 40_000_000, outputTokens: 100 },
  });
  assert.equal(tokens.cacheReadTokens, 40_000_000);
  assert.equal(tokens.billableTokens, 500 + 200 + 100);
});

test('extractTokens: best-effort ephemeral 1h/5m cache-creation split, read from a nested cache_creation/cacheCreation object when present', () => {
  const snakeNested = extractTokens({
    'claude-sonnet-5': {
      input_tokens: 10,
      cache_creation_input_tokens: 335,
      cache_read_input_tokens: 0,
      output_tokens: 5,
      cache_creation: { ephemeral_1h_input_tokens: 335, ephemeral_5m_input_tokens: 0 },
    },
  });
  assert.equal(snakeNested.cacheCreationEphemeral1h, 335);
  assert.equal(snakeNested.cacheCreationEphemeral5m, 0);

  const camelNested = extractTokens({
    'claude-sonnet-5': {
      inputTokens: 10,
      cacheCreationInputTokens: 335,
      cacheCreation: { ephemeral1hInputTokens: 0, ephemeral5mInputTokens: 335 },
    },
  });
  assert.equal(camelNested.cacheCreationEphemeral5m, 335);
  assert.equal(camelNested.cacheCreationEphemeral1h, 0);
});

test('extractTokens: no nested cache_creation/cacheCreation object -- ephemeral split reads back 0, never throws (the documented common case: modelUsage has not been observed to carry this split)', () => {
  const tokens = extractTokens({ 'claude-haiku-4-5': { inputTokens: 100, outputTokens: 20 } });
  assert.equal(tokens.cacheCreationEphemeral1h, 0);
  assert.equal(tokens.cacheCreationEphemeral5m, 0);
});

test('extractTokens: a two-model modelUsage payload carries a per-model breakdown alongside the flat totals, keyed by model name (card #214 acceptance criterion 1)', () => {
  const tokens = extractTokens({
    'claude-fable-5': { inputTokens: 1000, cacheCreationInputTokens: 200, cacheReadInputTokens: 50, outputTokens: 100 },
    'claude-opus-5': { inputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 400 },
  });
  assert.equal(tokens.tokensSource, 'modelUsage');
  assert.equal(tokens.freshInputTokens, 1300);
  assert.equal(tokens.cacheCreationTokens, 200);
  assert.equal(tokens.cacheReadTokens, 50);
  assert.equal(tokens.outputTokens, 500);
  assert.equal(tokens.billableTokens, 1300 + 200 + 500);
  assert.deepEqual(tokens.modelUsage, {
    'claude-fable-5': { freshInputTokens: 1000, cacheCreationTokens: 200, cacheReadTokens: 50, outputTokens: 100, billableTokens: 1300 },
    'claude-opus-5': { freshInputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 400, billableTokens: 700 },
  });
});

test('extractTokens: a single-model modelUsage payload still gets a one-entry modelUsage breakdown', () => {
  const tokens = extractTokens({ 'claude-sonnet-5': { input_tokens: 10, output_tokens: 5 } });
  assert.deepEqual(tokens.modelUsage, {
    'claude-sonnet-5': { freshInputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 5, billableTokens: 15 },
  });
});

test('extractTokens: modelUsage breakdown is ABSENT (not an empty object) when nothing recognizable was found, matching tokensSource: null', () => {
  assert.equal(extractTokens(undefined).modelUsage, undefined);
  assert.equal(extractTokens({}).modelUsage, undefined);
  assert.equal(extractTokens({ 'model-a': {}, 'model-b': { someUnrelatedField: 1 } }).modelUsage, undefined);
});

test('classifyFailure: api_error_status 429 -> limit', () => {
  assert.equal(classifyFailure({ api_error_status: 429, result: 'nope' }), 'limit');
});

test('classifyFailure: api_error_status 529 (Anthropic "overloaded") -> limit', () => {
  assert.equal(classifyFailure({ api_error_status: 529, result: 'nope' }), 'limit');
});

test('classifyFailure: allowlisted terminal_reason values -> limit, exact match only', () => {
  for (const reason of ['overloaded_error', 'rate_limit_error', 'usage_limit_reached']) {
    assert.equal(classifyFailure({ terminal_reason: reason }), 'limit', reason);
    assert.equal(classifyFailure({ terminal_reason: reason.toUpperCase() }), 'limit', `${reason} uppercase`);
    assert.equal(classifyFailure({ terminal_reason: `  ${reason}  ` }), 'limit', `${reason} padded`);
  }
});

test('classifyFailure: terminal_reason merely CONTAINING an allowlisted reason is NOT a limit -- exact match, never a substring test', () => {
  assert.equal(classifyFailure({ terminal_reason: 'was_not_a_rate_limit_error' }), 'error');
  assert.equal(classifyFailure({ terminal_reason: 'overloaded_error_recovered' }), 'error');
});

test('classifyFailure: terminal_reason "success" -> error (not a limit shape)', () => {
  assert.equal(classifyFailure({ terminal_reason: 'success' }), 'error');
});

test('classifyFailure: null -> error (defends the unreachable-from-invokeClaudeReal case directly)', () => {
  assert.equal(classifyFailure(null), 'error');
});

test('classifyFailure: api_error_status 400 -> error', () => {
  assert.equal(classifyFailure({ api_error_status: 400, result: 'bad request' }), 'error');
});

test('classifyFailure: anything else -> error', () => {
  assert.equal(classifyFailure({ result: 'invalid tool call' }), 'error');
});

test('classifyFailure: free text merely containing "rate"/"generate"/"accurate" is NOT a limit (the regression this action exists for)', () => {
  assert.equal(classifyFailure({ result: 'invalid rate parameter' }), 'error');
  assert.equal(classifyFailure({ result: 'could not generate the file' }), 'error');
  assert.equal(classifyFailure({ result: 'accurate output required' }), 'error');
  assert.equal(classifyFailure({ terminal_reason: 'error', result: 'rate of change too high' }), 'error');
});

// ---- invokeClaudeReal: env / cwd / executable passthrough ---------------------------------------

test('invokeClaudeReal: sets CLAUDE_CONFIG_DIR only when account.configDir is non-null', async () => {
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, undefined);
});

test('invokeClaudeReal: passes CLAUDE_CONFIG_DIR through when the account sets one', async () => {
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  await invokeClaudeReal(baseOpts({ account: { name: 'acct-b', configDir: '/home/x/.claude-acct-b' } }), fakeExecDeps({ spawn }));
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, '/home/x/.claude-acct-b');
});

test('invokeClaudeReal: resolves and spawns the executable buildQueryOptions resolved, with cwd passed through', async () => {
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  await invokeClaudeReal(baseOpts({ cwd: '/home/crazz/SPO-Pipeline' }), fakeExecDeps({ spawn }));
  assert.equal(calls[0].command, FAKE_EXECUTABLE_PATH);
  assert.equal(calls[0].cwd, '/home/crazz/SPO-Pipeline');
});

test('invokeClaudeReal: parses a real-shaped success payload and sums tokens across model entries', async () => {
  const payload = resultMessage({
    modelUsage: {
      'claude-haiku-4-5': { inputTokens: 100, outputTokens: 10 },
      'claude-fable-5': { inputTokens: 50, outputTokens: 5, cacheCreationInputTokens: 20 },
    },
  });
  const { spawn } = fakeSpawnDeps([initMessage(), payload]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));

  assert.equal(result.ok, true);
  assert.equal(result.result, 'ok');
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.numTurns, 1);
  assert.equal(result.tokensSource, 'modelUsage');
  assert.equal(result.freshInputTokens, 150);
  assert.equal(result.cacheCreationTokens, 20);
  assert.equal(result.outputTokens, 15);
  assert.equal(result.billableTokens, 150 + 20 + 15);
  // decision 1 (sdk-call.js's consumeQueryStream): raw is always undefined on this transport --
  // there is no OS exit code to report. The old transport's equivalent test asserted `raw === 0`.
  assert.equal(result.raw, undefined);
});

test('invokeClaudeReal: sessionId is read from the message stream when the caller supplied none -- opts.sessionId, when supplied, is used verbatim instead', async () => {
  // Caller supplies nothing -- invokeClaudeReal mints its own (Job 2) and buildQueryOptions passes
  // IT through as options.sessionId; this fake "CLI" reports a different session_id of its own
  // (SESSION_ID, via initMessage/resultMessage above), and that CLI-reported value is what comes
  // back -- the "CLI wins" half of the fallback (see the dedicated session-id-generation block
  // below for the "falls back to ours" half, and for the argv-level proof of what got minted).
  const { spawn: spawn1 } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const r1 = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn: spawn1 }));
  assert.equal(r1.sessionId, SESSION_ID);

  // Caller supplies one -- buildQueryOptions passes it through as options.sessionId; this file's
  // fake CLI is not wired to actually honour --session-id (that argv-level property is
  // sdk-call-options.test.js's own "argv-level" test's job), but the caller-supplied id must still
  // be the one this function reports when the fake replies with ITS OWN different session_id, since
  // the real CLI is documented to honour the id it was asked to use.
  const CALLER_ID = '11111111-1111-4111-8111-111111111111';
  const { spawn: spawn2 } = fakeSpawnDeps([initMessage(CALLER_ID), resultMessage({ session_id: CALLER_ID })]);
  const r2 = await invokeClaudeReal(baseOpts({ sessionId: CALLER_ID }), fakeExecDeps({ spawn: spawn2 }));
  assert.equal(r2.sessionId, CALLER_ID);
});

// ---- invokeClaudeReal: session id generation, RESTORED (card #239 chantier, Job 2 fix pass) ----
//
// Dropped for a few days by action A5b's cutover, then restored here -- see this file's own header
// ("WHAT DID NOT SURVIVE THE CUTOVER") and token-recovery.js's own header for the recovery
// guarantee this closes: a call killed before the CLI's first `system`/`init` message now still
// has an id, because invokeClaudeReal generated one and told the CLI to use it, exactly like the
// pre-A5b spawnSync transport did.
//
// Asserted at the argv level via fakeSpawnDeps's own `calls` recorder: `calls[i].args` is the REAL
// argv the vendored SDK decided to spawn `claude` with (this function builds no argv of its own any
// more -- see sdk-call.js's own header) -- `--session-id=<uuid>` is one joined token (measured, see
// that file's header probe), not a `--session-id`/`<uuid>` pair.

// Literal generated ids below are UUID-v4 SHAPED on purpose, unlike the pre-A5b equivalents of
// these tests (which used plain literals like 'generated-uuid-1'): this transport's buildQueryOptions
// validates opts.sessionId against SESSION_ID_UUID_V4_RE uniformly, regardless of whether it came
// from a caller or from invokeClaudeReal's own mint (see llm.js's `suppliedSessionId` comment) --
// stricter than the pre-A5b transport, which only validated the caller-supplied branch and left a
// self-generated one unchecked. A real `crypto.randomUUID()` always produces this shape, so this
// tightening changes nothing for production; it does mean a fake `deps.randomUUID` in a test must
// return something UUID-v4 shaped too, same as a caller-supplied opts.sessionId already had to.
const GENERATED_UUID_1 = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1';

test('invokeClaudeReal: generates a session id via deps.randomUUID and passes it to the real spawn argv as --session-id=<uuid>', async () => {
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn, randomUUID: () => GENERATED_UUID_1 }));
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].args.includes(`--session-id=${GENERATED_UUID_1}`),
    `expected --session-id=${GENERATED_UUID_1} in argv, got ${JSON.stringify(calls[0].args)}`
  );
  assert.equal(result.ok, true);
});

// Mutation-testing posture carried forward from the pre-A5b test this one replaces: every OTHER
// test in this file injects deps.randomUUID and asserts against the injected literal, so none of
// them exercises the REAL generator (node's own crypto.randomUUID, the production fallback when
// deps.randomUUID is absent). If that ever returned something falsy/malformed, buildQueryOptions's
// own SESSION_ID_UUID_V4_RE check (applied uniformly now, see GENERATED_UUID_1's own comment above)
// would throw a TypeError instead of silently passing a bad value through -- but a TypeError from
// deep inside the production path, on a value this function generated itself rather than one a
// caller supplied, would be a confusing crash to debug blind; this is the one assertion in the
// suite that proves the real generator's output actually clears that bar today.
test('invokeClaudeReal: with deps.randomUUID absent, the PRODUCTION generator (crypto.randomUUID) still passes a UUID-v4-shaped --session-id', async () => {
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  // deps.randomUUID deliberately absent -- only spawn is injected.
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  const sessionArg = calls[0].args.find((a) => a.startsWith('--session-id='));
  assert.ok(sessionArg, 'the production path must still pass --session-id when deps.randomUUID is not injected');
  assert.match(
    sessionArg.slice('--session-id='.length),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'the real crypto.randomUUID output must be UUID-v4 shaped'
  );
  assert.equal(result.ok, true);
});

test('invokeClaudeReal: opts.sessionId, when supplied, is used verbatim and deps.randomUUID is never called', async () => {
  let randomUUIDCalls = 0;
  const CALLER_ID = '11111111-1111-4111-8111-111111111111';
  const { spawn, calls } = fakeSpawnDeps([initMessage(CALLER_ID), resultMessage({ session_id: undefined })]);
  const result = await invokeClaudeReal(
    baseOpts({ sessionId: CALLER_ID }),
    fakeExecDeps({
      spawn,
      randomUUID: () => {
        randomUUIDCalls += 1;
        return 'should-never-be-used';
      },
    })
  );
  assert.equal(randomUUIDCalls, 0);
  assert.ok(calls[0].args.includes(`--session-id=${CALLER_ID}`));
  assert.equal(result.sessionId, CALLER_ID);
});

test('invokeClaudeReal: falls back to the generated id when the stream never reports one at all (killed/exited before any message)', async () => {
  // A zero-exit child that writes NO lines at all -- consumeQueryStream's own "stream ended with no
  // result message" branch (its header item 5), sessionId null on ITS OWN return because no
  // `system`/`init` or `result` message ever arrived to read one off of. Exactly the case
  // token-recovery.js's own header names: a call killed/exited before the first message still needs
  // an id to search a transcript by, and this function's own fallback (`suppliedSessionId`, see its
  // comment at the call site) is what supplies it.
  const GENERATED_FALLBACK_ID = 'aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaa2';
  const { spawn, calls } = fakeSpawnDeps([]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn, randomUUID: () => GENERATED_FALLBACK_ID }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.sessionId, GENERATED_FALLBACK_ID);
  assert.ok(calls[0].args.includes(`--session-id=${GENERATED_FALLBACK_ID}`));
});

test('invokeClaudeReal: an unreadable oauthTokenFile still returns sessionId: null even though a session id was generated before the check failed -- claude was never spawned', async () => {
  // Ordering note (Job 2, honestly recorded rather than silently inherited): the pre-A5b transport
  // generated its session id AFTER the oauthTokenFile read, so deps.randomUUID was never called on
  // this branch at all. This transport's buildQueryOptions needs opts.sessionId resolved before it
  // can validate/build `options` in one pass (see llm.js's own comment on `suppliedSessionId`), so
  // the generation now happens BEFORE buildQueryOptions -- and therefore before its own internal
  // oauthTokenFile read fails. That is a real, measured difference in WHEN deps.randomUUID gets
  // called; it changes nothing about WHAT gets reported: a generated id for a call that never
  // spawned is still discarded, never returned, because this failure shape hardcodes
  // `sessionId: null` (see invokeClaudeReal's own OauthTokenUnreadableError branch) regardless of
  // what `suppliedSessionId` resolved to.
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const result = await invokeClaudeReal(
    baseOpts({ account: { name: 'acct-missing-token', configDir: null, oauthTokenFile: '/nonexistent/spo-lot4-token-ledger/does-not-exist' } }),
    fakeExecDeps({ spawn, randomUUID: () => 'unused-oauth-branch-id' })
  );
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, null);
  assert.equal(calls.length, 0); // claude was never spawned, generated id or not
});

test('invokeClaudeReal: an unreadable oauthTokenFile returns sessionId: null and never spawns -- claude was never started', async () => {
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const result = await invokeClaudeReal(
    baseOpts({ account: { name: 'acct-missing-token', configDir: null, oauthTokenFile: '/nonexistent/spo-lot4-token-ledger/does-not-exist' } }),
    fakeExecDeps({ spawn })
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.error, /cannot read oauthTokenFile/);
  assert.equal(result.sessionId, null);
  assert.equal(calls.length, 0); // claude was never spawned
});

test('invokeClaudeReal: no `claude` resolved on PATH returns a clean step failure, never spawns, sessionId null', async () => {
  // The new transport's own failure mode with no equivalent in the old one -- buildArgv never
  // needed to resolve an executable at all (spawnSync just tries "claude" on PATH itself). See
  // sdk-call.js's ClaudeExecutableNotFoundError for the full reasoning; buildQueryOptions's own
  // throw behaviour is tested directly in test/sdk-call-options.test.js -- this test only proves
  // invokeClaudeReal CATCHES it and maps it onto the ordinary {ok:false, kind:'error'} shape.
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const result = await invokeClaudeReal(baseOpts(), { resolveClaudeCodeExecutable: fakeResolver(null), spawn, isNoRealSpawnEnabled: () => false });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.error, /no "claude" executable found on PATH/);
  assert.equal(result.sessionId, null);
  assert.equal(calls.length, 0);
});

// ---- invokeClaudeReal: the no-real-spawn killswitch (this function's OWN check, first thing it
// does) -----------------------------------------------------------------------------------------
// F1 (fix pass, this action). sdk-call.js's spawnClaudeCodeProcess carries a SECOND copy of this
// same isEnabled() check (the "defense-in-depth half" -- see that file's own header on "Both, not
// either") and IS covered elsewhere. THIS function's own check at its very top -- the "fast, clean
// shape half", read before anything else touches the account/oauth-token file or resolves `claude`
// on PATH -- had no test of its own at all: mutating `if (isEnabledFn(process.env))` to `if (false)`
// left the full suite at 3269/3270, byte-identical to baseline. Proven here by asserting the actual
// property the code's own comment claims ("an armed run must never even attempt to resolve `claude`
// on PATH"), not merely that some failure came back -- a resolveClaudeCodeExecutable call counter,
// not just an assertion on the returned shape, is what makes this test fail red under that mutation.
// LOAD-BEARING, MEASURED (re-verification pass, in-process re-run of the exact `if (false)`
// mutation): every OTHER assertion below still passes under it, because `sdk-call.js`'s
// `spawnClaudeCodeProcess` carries its own copy of this same check (the "defense-in-depth half")
// and throws its OWN `SPO_NO_REAL_SPAWN is set` error -- caught by this function's `query()`
// try/catch and re-wrapped as `llm.js: query() failed to start: sdk-call.js: ...`, which still
// matches /SPO_NO_REAL_SPAWN is set/, still carries `sessionId: null`, `billableTokens: 0`, and
// -- because that second throw fires from INSIDE `spawnClaudeCodeProcess`, before the injected
// `spawn` function is ever reached -- `calls.length` stays 0 too. Only `resolveClaudeCodeExecutable`
// gets called once under the mutation (it does not under the real guard, which returns before
// `buildQueryOptions` is ever invoked) -- the `resolveCalls` counter below is the ONLY assertion
// in this test that actually discriminates the two. Do not let a later cleanup pass "simplify" it
// away as redundant with the assertions around it.
test('invokeClaudeReal: SPO_NO_REAL_SPAWN armed (the real guard, reading process.env -- not a stubbed deps.isNoRealSpawnEnabled) refuses before ever resolving `claude` on PATH or attempting a spawn', async () => {
  // Deliberately the one test in this file that does NOT pass fakeExecDeps()'s own
  // `isNoRealSpawnEnabled: () => false` override -- every other test opts OUT of this check that
  // way (see that helper's header). Here, invokeClaudeReal's own top-of-function `isEnabledFn`
  // falls back to the REAL orchestrator/no-real-spawn-guard.js#isEnabled, reading
  // process.env.SPO_NO_REAL_SPAWN -- which this file's own top-of-file `require('./no-real-spawn')`
  // already set to '1' for the whole process (see that require's own comment). No env mutation of
  // this test's own: reusing the same ambient state every OTHER test in this file already has to
  // explicitly opt out of is the point.
  let resolveCalls = 0;
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const result = await invokeClaudeReal(baseOpts(), {
    resolveClaudeCodeExecutable: () => {
      resolveCalls += 1;
      return '/fake/bin/claude';
    },
    spawn,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.error, /SPO_NO_REAL_SPAWN is set/);
  assert.equal(result.sessionId, null);
  assert.equal(result.tokensSource, null);
  assert.equal(result.billableTokens, 0);
  assert.equal(result.numTurns, undefined);
  assert.equal(result.raw, undefined);
  assert.equal(resolveCalls, 0, 'an armed run must never even attempt to resolve `claude` on PATH');
  assert.equal(calls.length, 0, 'an armed run must never attempt a spawn');
});

test('invokeClaudeReal: a non-UUID opts.sessionId string throws a TypeError naming the field and value -- never spawns', async () => {
  // buildQueryOptions's own throw (test/sdk-call-options.test.js tests the throw itself in
  // detail); this test proves invokeClaudeReal lets it PROPAGATE uncaught, matching its own
  // "only a programming error (bad opts) throws" contract, rather than swallowing it into a step
  // failure the way the three named error classes are.
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()]);
  await assert.rejects(
    () => invokeClaudeReal(baseOpts({ sessionId: 'not-a-uuid' }), fakeExecDeps({ spawn })),
    (err) => {
      assert.ok(err instanceof TypeError, 'expected a TypeError');
      assert.match(err.message, /sessionId/);
      assert.match(err.message, /not-a-uuid/);
      return true;
    }
  );
  assert.equal(calls.length, 0, 'claude must never be spawned on a malformed sessionId');
});

// ---- invokeClaudeReal: limit classification (api_error_status / terminal_reason) ----------------
// Unchanged reasoning from the old transport (classifyFailure/limitKindForFailure are the exact
// same functions, called on the exact same field names -- consumeQueryStream's own header, "there
// is nothing SDK-specific to translate"); migrated onto the new fixture shape only.

test('invokeClaudeReal: is_error + api_error_status 429 -> {ok:false, kind:"limit"}', async () => {
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage({ is_error: true, api_error_status: 429, result: 'rate limited' })]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'usage');
});

test('invokeClaudeReal: is_error + api_error_status 529 -> {ok:false, kind:"limit", limitKind:"overloaded"}', async () => {
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage({ is_error: true, api_error_status: 529, result: 'overloaded' })]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'overloaded');
});

test('invokeClaudeReal: terminal_reason "rate_limit_error" alone (no api_error_status match) -> limitKind "usage"', async () => {
  const { spawn } = fakeSpawnDeps([
    initMessage(),
    resultMessage({ is_error: true, api_error_status: null, terminal_reason: 'rate_limit_error', result: 'rate limited, no structured status this time' }),
  ]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'usage');
});

test('invokeClaudeReal: terminal_reason "overloaded_error" alone (no api_error_status match) -> limitKind "overloaded"', async () => {
  const { spawn } = fakeSpawnDeps([
    initMessage(),
    resultMessage({ is_error: true, api_error_status: null, terminal_reason: 'overloaded_error', result: 'server overloaded, no structured status this time' }),
  ]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'overloaded');
});

// action 7.1 (round 2, verifier finding), unchanged reasoning: limitKindForFailure checks
// LIMIT_STATUSES (api_error_status) FIRST, unconditionally, before terminal_reason is even read --
// #483's cooldown model depends on this: a spent-quota 429 with a stale "overloaded" terminal_reason
// must still cool for the SHORTER usage tier, not the overloaded one.
test('invokeClaudeReal: api_error_status AND a conflicting terminal_reason both present -> the status table wins (429 + overloaded_error -> limitKind "usage", not "overloaded")', async () => {
  const { spawn } = fakeSpawnDeps([
    initMessage(),
    resultMessage({ is_error: true, api_error_status: 429, terminal_reason: 'overloaded_error', result: 'a reply that disagrees with itself about which kind of limit this is' }),
  ]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'usage', 'api_error_status must be checked (and win) before terminal_reason is ever consulted');
});

test('invokeClaudeReal: a non-limit failure never carries a limitKind at all', async () => {
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage({ is_error: true, api_error_status: 400, result: 'invalid json schema' })]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.kind, 'error');
  assert.equal('limitKind' in result, false);
});

test('invokeClaudeReal: is_error with an unrelated message -> {ok:false, kind:"error"}', async () => {
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage({ is_error: true, api_error_status: 400, result: 'invalid json schema' })]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
});

test('invokeClaudeReal: a stream that ends with no result message at all -> {ok:false, kind:"error"}', async () => {
  // The successor of the old transport's "unparsable stdout" case: there is no JSON.parse on this
  // transport (the SDK does its own message parsing/validation before this file ever sees a
  // message), so the equivalent "something is structurally wrong with what came back" shape is a
  // clean exit with no `result` message (consumeQueryStream's header item 5).
  const { spawn } = fakeSpawnDeps([initMessage()]); // no result message, exits 0
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.error, /no result message/);
});

// ---- invokeClaudeReal: deadline ownership (action A5b's own core rewrite) -----------------------
//
// The old transport's spawnSync `timeout` option enforced the deadline; this function now owns it
// explicitly (this file's own header has the full design/measurement). These tests use SHORT
// deadlines (tens of ms) against a cooperative fake child (dies the instant `.kill()` is called,
// fakeSpawnedChild's default) so the suite stays fast -- only the dedicated "stubborn child"
// test below pays the real ~7s grace-window cost, and only once.

test('invokeClaudeReal: a call exceeding opts.deadlineMs is terminated -- timedOut, killConfirmed, killedBySignal, signal, deadlineMs', async () => {
  const { spawn } = fakeSpawnDeps([initMessage()], { hang: true }); // never replies on its own
  const result = await invokeClaudeReal(baseOpts({ deadlineMs: 30 }), fakeExecDeps({ spawn }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.timedOut, true);
  assert.equal(result.killConfirmed, true);
  assert.equal(result.killedBySignal, true);
  assert.ok(result.signal, 'expected a signal name');
  assert.equal(result.deadlineMs, 30);
  assert.match(result.error, /exceeded the 30ms deadline/);
  assert.equal(result.sessionId, SESSION_ID, 'the init message already arrived, so the session id is honestly reported even though the call was killed');
});

test('invokeClaudeReal: a call that finishes well inside its deadline is not timedOut, even with a deadline armed', async () => {
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const result = await invokeClaudeReal(baseOpts({ deadlineMs: 60000 }), fakeExecDeps({ spawn }));
  assert.equal(result.ok, true);
  assert.equal('timedOut' in result, false);
  assert.equal('killConfirmed' in result, false);
});

test('invokeClaudeReal: no deadline armed at all (opts.deadlineMs absent) never times out, however long the call takes', async () => {
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
  assert.equal(result.ok, true);
  assert.equal('timedOut' in result, false);
});

// ---- invokeClaudeReal: durationS must be measured on a monotonic clock, not Date.now() ---------
//
// F5 (Opus verifier, fix pass): RESTORED. Card #158's own property (durationS must ignore this
// host's Date.now() steps -- see orchestrator/monotonic-clock.js's own header for the measured
// -2515ms jump, and llm.js's own header/comment on why `durationS` is `monotonicNowMs()`-based)
// survived action A5b's own production rewrite unchanged -- `invokeClaudeReal` still reads
// `monotonicNowMs()` before the call and again after, never `Date.now()`, for exactly this
// `durationS` computation (see the `startedAtMs`/`durationS` lines) -- but its three dedicated
// tests were silently dropped in the cutover rather than migrated, even though nothing about the
// property they proved stopped being true. Re-expressed here against the shipped, query()-based
// transport: SAME three properties, same three test names/shapes as before this cutover, adapted
// onto `fakeSpawnDeps`/`opts.onStdinWrite` (this transport's equivalent of the old fake
// `spawnSync`'s synchronous callback -- fired while the call is genuinely "in flight", before its
// reply arrives) instead of the old fake `spawnSync`. Zero production change; no clock injection
// needed in `orchestrator/` itself -- only `Date.now` is stubbed here, in the test process, exactly
// as before.
//
// Each test's `onStdinWrite` hook LEAVES the patched `Date.now` in place when it returns, restored
// only in the outer try/finally, after `invokeClaudeReal` has returned -- so a failing assertion
// still cannot leak the patch into the rest of this suite, and the patch stays live for as long as
// `invokeClaudeReal` itself might still read `Date.now()` (it never does, by design; asserting
// against a monotonic-only `durationS` while `Date.now` is jumped is the whole point).

test('invokeClaudeReal: durationS ignores a forward Date.now() jump during the call (issue-517 shape)', async () => {
  const realDateNow = Date.now;
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage()], {
    onStdinWrite: () => {
      // Realtime runs 80s ahead of monotonic time while the call is "running" -- issue-517's
      // shape: a call that finished quickly on the monotonic clock durationS actually uses, but
      // whose Date.now()-based reading (if this file still used one) would have made it look 80s
      // slower than it really was.
      Date.now = () => realDateNow() + 80000;
    },
  });
  try {
    const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
    assert.equal(result.ok, true);
    // < 1, not < 5: the fake spawn settles in well under a second, so real durationS is ~0 --
    // this also catches a hardcoded-1-second durationS, which a looser bound would let through.
    assert.ok(result.durationS < 1, `expected durationS < 1s (real elapsed time), got ${result.durationS}`);
  } finally {
    Date.now = realDateNow;
  }
});

test('invokeClaudeReal: durationS ignores a backward Date.now() jump and is never negative (issue-385/#492 shape)', async () => {
  // The mirror case: realtime LAGGING behind monotonic time must never make durationS negative.
  const realDateNow = Date.now;
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage()], {
    onStdinWrite: () => {
      Date.now = () => realDateNow() - 80000;
    },
  });
  try {
    const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));
    assert.equal(result.ok, true);
    // >= 0 alone would also pass for a sign-flipped durationS on a sub-second fake spawn (-0 >= 0
    // is true) -- Object.is rejects that mutant too.
    assert.ok(
      result.durationS >= 0 && !Object.is(result.durationS, -0),
      `durationS must never be negative, got ${result.durationS}`
    );
    assert.ok(result.durationS < 5, `expected durationS < 5s (real elapsed time), got ${result.durationS}`);
  } finally {
    Date.now = realDateNow;
  }
});

test('invokeClaudeReal: the decisive issue-517 case -- a call that was never killed never reports more than its armed deadline', async () => {
  // issue-517: a call that succeeded (never killed) journalled a duration EXCEEDING its own armed
  // deadline under the old Date.now()-based measurement -- impossible under a monotonic clock,
  // since a call the deadline timer let finish cannot have taken longer than that timer's own
  // bound. Realtime jumps far past the armed deadline while the (monotonically fast) call
  // succeeds -- the exact shape that made the old code's duration exceed a deadline that never
  // fired.
  const realDateNow = Date.now;
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage()], {
    onStdinWrite: () => {
      Date.now = () => realDateNow() + 950000;
    },
  });
  try {
    const result = await invokeClaudeReal(baseOpts({ deadlineMs: 900000 }), fakeExecDeps({ spawn }));
    assert.equal(result.ok, true);
    assert.ok(
      result.durationS <= 900,
      `a call that was never killed cannot report more than its 900000ms deadline, got ${result.durationS}s`
    );
  } finally {
    Date.now = realDateNow;
  }
});

// F4 (Opus verifier, fix pass): RENAMED -- this test's old name ("a SIGTERM-ignoring child is
// still confirmed dead within the grace window") and its old "THE PROOF this action exists for"
// comment both claimed the OPPOSITE of what the body below actually asserts: `killConfirmed ===
// false` and a `/did not confirm exit within the/` error. This is a good test of the HONEST
// GIVE-UP branch -- a fake that never dies (ignoreSignal:true, nothing ever calls forceExit) proves
// `killConfirmed` can honestly read false, rather than the function optimistically claiming a kill
// it never actually witnessed. It does NOT prove a real child is dead by the time this function
// returns; see the NEW test immediately below this one for that property, against a REAL OS child.
test('invokeClaudeReal: a fake child that never exits (grace window exhausted) is honestly reported as NOT confirmed dead, never optimistically "killed"', async () => {
  let child;
  // Built INSIDE the spawn wrapper, not before it, so fakeSpawnedChild receives the real
  // spawnOpts.signal the SDK passes -- see that helper's own header on `opts.signal` for why this
  // matters here specifically (it is what makes the async iterator itself end promptly, the same
  // way a real child_process.spawn(...,{signal}) would, even though the fake process's OWN death
  // is still gated by opts.ignoreSignal and must wait out the full grace window below).
  const spawn = (command, args, spawnOpts) => {
    child = fakeSpawnedChild([initMessage()], { hang: true, ignoreSignal: true, signal: spawnOpts.signal });
    return child;
  };
  const t0 = Date.now();
  const result = await invokeClaudeReal(baseOpts({ deadlineMs: 50 }), fakeExecDeps({ spawn }));
  const elapsedMs = Date.now() - t0;

  assert.equal(result.timedOut, true);
  // The fake never actually dies on its own (ignoreSignal:true, and nothing ever calls
  // forceExit) -- so confirmProcessExit's grace window must have been the thing that gave up,
  // proving killConfirmed can honestly be false rather than always optimistically true.
  assert.equal(result.killConfirmed, false);
  assert.match(result.error, /did not confirm exit within the/);
  assert.ok(elapsedMs >= 8000, `expected this function to hold for close to the full grace window, only waited ${elapsedMs}ms`);
  // The fake's own .kill() WAS called (by the abort escalation) even though it chose to ignore it
  // -- proving the abort signal really was sent, not merely that nothing happened.
  assert.equal(child.killed, true);
});

// F4 (Opus verifier, fix pass): THE MISSING PROOF -- until this test, no committed test actually
// established the no-orphan property this action exists for (the test above, honestly renamed,
// only proves the fake's own `killConfirmed: false` branch; it never demonstrates that a REAL OS
// child is actually dead once this function returns). A REAL PROCESS TEST, deliberately not faked:
// spawns an actual `node` child (via a throwaway fixture script, mkTmp()) that installs a SIGTERM
// handler which never exits, run through a REAL `query()` call from this repo's own vendored SDK
// (no `deps.spawn` override for the SDK's own internal spawn -- only a thin wrapper around the
// real `child_process.spawn` so this test can capture the child's pid; the process itself, the
// escalation, and the eventual SIGKILL are all real). Costs real wall-clock time (~8s, the SDK's
// own kill-escalation window -- see sdk-call.js's own SDK_ABORT_KILL_DELAY_MS/
// SDK_ABORT_SIGKILL_ESCALATION_MS header) -- worth paying once for the one property this whole
// action exists to establish: liveness is read with `process.kill(pid, 0)` on the line
// IMMEDIATELY after `invokeClaudeReal`'s own `await` resolves, with nothing else awaited in
// between, so a pass here means the child was truly dead at the instant this function returned to
// its caller, not merely "probably dead by now".
test('invokeClaudeReal (REAL PROCESS): a real SIGTERM-ignoring child is truly dead -- not merely believed dead -- the instant this function returns', async () => {
  const tmpDir = mkTmp('llm-real-orphan-proof-');
  const fixturePath = path.join(tmpDir, 'sigterm-ignoring-claude.js');
  fs.writeFileSync(
    fixturePath,
    [
      '#!/usr/bin/env node',
      '// Real fixture for F4\'s no-orphan proof -- ignores SIGTERM, never exits on its own; only',
      '// SIGKILL (the SDK\'s own escalation) can end this process. MEASURED (fix pass F4): an',
      '// earlier draft of this fixture called `process.stdin.resume()` to drain the prompt write --',
      '// which backfired, since Node exits on its own once stdin reaches EOF (the SDK closes the',
      '// child\'s stdin after writing the prompt) and nothing else was keeping the loop alive, so the',
      '// fixture exited cooperatively (code 0, no signal) well before the deadline ever fired. A',
      '// ref\'d interval keeps the process alive unconditionally instead -- the prompt itself is tiny',
      '// (\'hi\'), well under a pipe\'s buffer, so leaving stdin unread never blocks the write.',
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );

  const { spawn: realSpawn } = require('child_process');
  let capturedChild;
  // A thin, transparent wrapper around the REAL child_process.spawn -- not a fake, not a mock of
  // behaviour, only a way for this test to get its hands on the resulting child's pid afterward
  // (invokeClaudeReal itself never returns one). Every argument passes straight through unchanged.
  const spawn = (command, args, spawnOpts) => {
    capturedChild = realSpawn(command, args, spawnOpts);
    return capturedChild;
  };

  const t0 = Date.now();
  const result = await invokeClaudeReal(
    baseOpts({ deadlineMs: 1000 }),
    fakeExecDeps({ spawn, resolveClaudeCodeExecutable: () => fixturePath })
  );
  const elapsedMs = Date.now() - t0;

  // THE PROOF: read liveness the line right after the await resolves, nothing else awaited in
  // between -- process.kill(pid, 0) sends no signal, it only probes whether the pid still exists
  // (throws ESRCH once it does not).
  let aliveAtReturn = true;
  try {
    process.kill(capturedChild.pid, 0);
  } catch (err) {
    aliveAtReturn = !(err && err.code === 'ESRCH');
  }

  assert.equal(aliveAtReturn, false, 'the real child must already be dead by the instant invokeClaudeReal returns');
  assert.equal(result.timedOut, true);
  assert.equal(result.killConfirmed, true);
  assert.equal(result.killedBySignal, true);
  assert.equal(result.signal, 'SIGKILL', 'a SIGTERM-ignoring child must have been escalated all the way to SIGKILL');
  assert.ok(elapsedMs >= 1000, `expected at least the ${1000}ms deadline to have elapsed, only took ${elapsedMs}ms`);
});

// ---- invokeClaudeReal: external kill (no deadline decision involved) ----------------------------

test('invokeClaudeReal: an external signal kill (no deadline armed) is reported as killedBySignal, never timedOut', async () => {
  const child = fakeSpawnedChild([initMessage()], { hang: true });
  const spawn = () => child;
  const resultPromise = invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn })); // no deadlineMs
  // Simulate an operator's kill / an OOM kill -- something OTHER than this function's own deadline
  // timer (which was never armed here) ending the child.
  setTimeout(() => child.forceExit(null, 'SIGKILL'), 10);
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal('timedOut' in result, false, 'a kill this function did not decide to make must never read as a deadline timeout');
  assert.equal(result.killedBySignal, true);
  assert.equal(result.signal, 'SIGKILL');
});

test('invokeClaudeReal: an external signal kill even WITH a deadline armed is not timedOut, when the deadline never actually fires', async () => {
  // The #127-class regression this repo has already been burned by once (see this file's own
  // header pointer and llm.js's deadline-handling comment): a deadline being ARMED must never by
  // itself make an unrelated external kill read as a timeout.
  const child = fakeSpawnedChild([initMessage()], { hang: true });
  const spawn = () => child;
  const resultPromise = invokeClaudeReal(baseOpts({ deadlineMs: 900000 }), fakeExecDeps({ spawn }));
  setTimeout(() => child.forceExit(null, 'SIGTERM'), 10); // long before the 900s deadline could ever fire
  const result = await resultPromise;

  assert.equal('timedOut' in result, false);
  assert.equal(result.killedBySignal, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.deadlineMs, undefined, 'deadlineMs is only ever attached to a branch THIS function decided was a timeout');
});

// ---- runLlm real branch (thin wrapper: reads ctx.task.llm.<step>, journals, returns) ------------

test('runLlm real branch: builds the call from ctx.task.llm.<step>, uses ctx.account, journals llm-call', async () => {
  const fs = require('fs');
  const path = require('path');
  const taskDir = mkTmp('spo-llmreal-taskdir-');

  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage({ result: 'plan complete' })]);
  const ctx = {
    shadowMode: false,
    taskDir,
    config: { stepDeadlineMs: 30000 },
    account: { name: 'acct-x', configDir: null },
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan this', maxBudgetUsd: 1 } } },
  };

  const result = await runLlm(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));

  assert.equal(result.ok, true);
  assert.equal(result.result, 'plan complete');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, undefined);

  const journalLines = fs.readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const llmCallEvent = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(llmCallEvent, 'expected an llm-call journal event');
  assert.equal(llmCallEvent.step, 'PLAN');
  assert.equal(llmCallEvent.account, 'acct-x');
  assert.equal(llmCallEvent.ok, true);
  assert.equal(llmCallEvent.sessionId, SESSION_ID);
  assert.equal('numTurns' in llmCallEvent, false, 'the override branch must not journal numTurns');
});

// F2 (fix pass, this action). The success-path test directly above proves the override branch's
// journal write carries an id when invokeClaudeReal returns ok:true -- it says NOTHING about a
// FAILED call on this same path, because `result.ok` is true in both branches there, so
// `sessionId: result.ok ? result.sessionId : null` and `sessionId: result.sessionId` are
// indistinguishable under that test alone. This test drives runLlm's legacy ctx.task.llm.<step>
// override branch through an EXTERNALLY-killed spawn (no deadline decision involved -- see the GAP
// comment below for why a real elapsed DEADLINE kill is not reproduced at unit-test speed here) and
// reads the id back out of the journal file on disk, never off the return value -- pinning that a
// killed call's real sessionId reaches the ledger, not just invokeClaudeReal's own return value.
test('runLlm legacy ctx.task.llm.<step> override path: an externally-killed call still journals the non-null sessionId (read back from journal.jsonl, not from the return value), even though ok is false', async () => {
  const taskDir = mkTmp('spo-llmreal-legacy-killed-taskdir-');

  const child = fakeSpawnedChild([initMessage()], { hang: true }); // init arrives (a real sessionId), then nothing
  const spawn = () => child;

  const ctx = {
    shadowMode: false,
    taskDir,
    config: { stepDeadlineMs: 30000 },
    account: { name: 'acct-x', configDir: null },
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan this', maxBudgetUsd: 1 } } },
  };

  const resultPromise = runLlm(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));
  setTimeout(() => child.forceExit(null, 'SIGKILL'), 10); // an operator/OOM kill, not this call's own (real) deadline timer
  const result = await resultPromise;

  // Confirm this call actually took the killed/failed branch -- not a stand-in for the journal
  // assertions below, which are the actual deliverable.
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, SESSION_ID);

  const journalLines = fs.readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const llmCallEvent = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(llmCallEvent, 'expected an llm-call journal event');
  assert.equal(llmCallEvent.ok, false);
  // THE ACTUAL DELIVERABLE: the id `claude` reported (read off the init message that DID arrive
  // before the kill) is the one that landed in the journal line on disk -- not null, not undefined
  // -- exactly what token-recovery.js needs to find this call's transcript by.
  assert.equal(llmCallEvent.sessionId, SESSION_ID, 'a killed call must journal the id that lets token-recovery.js find its transcript');
});

// GAP, NARROWED BUT NOT FULLY CLOSED (per this chantier's own "do not weaken a test to make it
// pass" rule): the old file had two tests proving the journal write on a DEADLINE-killed call
// specifically, through BOTH runLlm paths (this legacy `ctx.task.llm.<step>` override, and the real
// `kind:"card"` path), including a recovery-injected variant of each. The test above (and its card-
// path sibling in test/llm-real-card.test.js) restores the underlying property -- a failed call's
// real sessionId reaches the journal line, not just invokeClaudeReal's return value -- via an
// EXTERNAL kill instead, which settles in milliseconds. What remains genuinely unreproduced at
// unit-test speed is the DEADLINE-specific combination, explained below.
//
// The override branch's own opts construction (a few lines above this comment, unchanged by
// action A5b: `deadlineMs: deadlineMsForStep(stepName)`) has ALWAYS ignored a caller-supplied
// `override.deadlineMs` -- there never was a hook to substitute a short deadline through runLlm,
// on either transport. The OLD transport's tests never needed one: `deps.spawnSync`'s fake simply
// RETURNED a canned `{error: ETIMEDOUT, ...}` result synchronously, regardless of what
// `spawnOpts.timeout` had actually been armed to -- a "timeout occurred" was simulated data, never
// a real elapsed wait. This transport's deadline is a REAL `setTimeout` racing a real (if faked)
// async stream (this file's own header, and llm.js's own "Deadline ownership" section) -- there is
// no way to fake "the deadline fired" without the armed `deadlineMs` actually elapsing. PLAN and
// IMPLEMENT's real deadlines are both 1,800,000ms (step-contracts.js's LLM_STEP_DEADLINE_MS_BY_STEP);
// DIAGNOSE/CITATION_VERIFIER/VALIDATE's is 900,000ms -- all real production values
// no unit test should pay for, and attempting to (an earlier draft of this file's own test did)
// hangs the whole suite for the real 30 minutes rather than failing fast.
//
// What is NOT lost: the invokeClaudeReal-level tests above ("a call exceeding opts.deadlineMs is
// terminated...", using a real but SHORT injected deadlineMs since invokeClaudeReal itself has no
// such hardcoding) already prove `timedOut`/`sessionId`/`tokensSource` come back correctly shaped
// on a deadline kill. runLlm's own `appendEvent` call site (a few lines below the opts
// construction) is unchanged by this action -- it reads `result.sessionId`/`result.tokensSource`/
// `result.ok` verbatim off whatever invokeClaudeReal returned, the exact same lines the EXTERNAL-
// KILL journal test above ("an externally-killed call still journals the non-null sessionId...")
// now exercises for the ok:false case, and the SUCCESS-path journal test earlier in this file
// ("runLlm real branch: builds the call from...") already exercised for ok:true. What is genuinely
// still not provable at unit-test speed is the SPECIFIC combination "a real elapsed DEADLINE, driven
// through runLlm's own deadlineMsForStep resolution, with the journal read back from disk" -- that
// combination costs 15-30 real minutes to reach, on either transport, and always did; the old tests
// only ever avoided that cost by faking data at a layer (spawnSync's own return value) that no
// longer exists. The property a deadline-specific test would have added on top of the external-kill
// coverage above is narrow: that `appendEvent` reads the SAME `result.sessionId` field regardless of
// which failure branch produced it -- true by construction (one call site, no branch on `kind` or
// `timedOut`), and already implied by combining the external-kill test above with the
// invokeClaudeReal-level deadline tests' own proof that a deadline kill returns that same field
// shaped the same way.

// ---- regression: #452's E2BIG lesson, successor property -----------------------------------------
// E2BIG itself is unreachable on this transport (see this file's own header) -- what survives is
// the underlying property the old test proved: a prompt far larger than a single argv entry could
// ever hold must never be placed anywhere near argv, because it travels over stdin instead.

test('invokeClaudeReal: a 200KB prompt (over Linux MAX_ARG_STRLEN) reaches the child over stdin, never via the spawn call\'s own argv', async () => {
  const huge = 'x'.repeat(200 * 1024); // 200KB > MAX_ARG_STRLEN (131072 bytes/argv entry)
  let seenStdinWrite = '';
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage()], {
    onStdinWrite: (chunk) => {
      seenStdinWrite += chunk;
    },
  });

  const result = await invokeClaudeReal(baseOpts({ step: 'IMPLEMENT', model: 'fable', effort: 'high', promptText: huge }), fakeExecDeps({ spawn }));

  assert.equal(result.ok, true);
  assert.ok(seenStdinWrite.includes(huge), 'expected the huge prompt to reach the child over stdin');
  for (const arg of calls[0].args) {
    assert.ok(!arg.includes(huge), 'the huge prompt must never appear in the spawn call\'s own argv');
    assert.ok(Buffer.byteLength(arg) < 131072, `argv entry exceeds MAX_ARG_STRLEN: ${arg.slice(0, 60)}...`);
  }
});

// ---- action 7.1: cannedDryRunPayload's three least-exercised shapes ------------------------------
// Untouched by action A5b -- this function is not part of the transport at all. No migration needed.

test('cannedDryRunPayload: CITATION_VERIFIER stub is a real PASS-shaped verdict with no entries', () => {
  const payload = cannedDryRunPayload('CITATION_VERIFIER', null, null);
  assert.deepEqual(payload, { ok: true, dryRun: true, verdict: 'PASS', entries: [] });
});

test('cannedDryRunPayload: VALIDATE stub is a real PASS-shaped verdict with a canned reason and no findings', () => {
  const payload = cannedDryRunPayload('VALIDATE', null, null);
  assert.deepEqual(payload, { ok: true, dryRun: true, verdict: 'PASS', reasons: ['[dry-run] no verdict rendered'], findings: [] });
});

test('cannedDryRunPayload: an unrecognized step falls to the defensive default -- every declared outputContract.required key comes back present and null, alongside ok/dryRun', () => {
  const contract = { outputContract: { required: ['foo', 'bar', 'baz'] } };
  const payload = cannedDryRunPayload('SOME_FUTURE_STEP', contract, null);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.deepEqual(Object.keys(payload).sort(), ['bar', 'baz', 'dryRun', 'foo', 'ok']);
  assert.equal(payload.foo, null);
  assert.equal(payload.bar, null);
  assert.equal(payload.baz, null);
});

// ---- token-ledger lot, action 4.3: token recovery wiring -----------------------------------------
// invokeClaudeReal's own maybeRecoverTokens (exported for these tests) attempts recovery when BOTH
// conditions hold on the branch's own result: tokensSource is falsy AND sessionId is a non-empty
// string. deps.recoverSessionTokens is the injection point, unchanged by action A5b (this
// mechanism lives entirely inside invokeClaudeReal, downstream of whichever transport produced the
// result object it's handed) -- every test below injects a fake so none of them touch the real
// filesystem via orchestrator/token-recovery.js's default export.

const RECOVERED_SAMPLE = Object.freeze({
  tokensSource: 'transcript',
  freshInputTokens: 1000,
  cacheCreationTokens: 200,
  cacheReadTokens: 50,
  outputTokens: 300,
  billableTokens: 1500,
  transcriptFilesRead: 2,
  // Non-zero on purpose (Fix 7): pins that maybeRecoverTokens/runLlm carry this completeness
  // signal through to the journal too, including the "some files were lost" case.
  transcriptFilesSkipped: 1,
});

test('invokeClaudeReal: a deadline-killed call whose injected recovery succeeds returns tokensSource: "transcript" and the recovered numbers', async () => {
  const { spawn } = fakeSpawnDeps([initMessage()], { hang: true });
  const result = await invokeClaudeReal(
    baseOpts({ account: { name: 'default', configDir: '/tmp/acct' }, deadlineMs: 30 }),
    fakeExecDeps({ spawn, recoverSessionTokens: async () => ({ ...RECOVERED_SAMPLE }) })
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.freshInputTokens, 1000);
  assert.equal(result.cacheCreationTokens, 200);
  assert.equal(result.cacheReadTokens, 50);
  assert.equal(result.outputTokens, 300);
  assert.equal(result.billableTokens, 1500);
});

// The recovery-journal variant of the same test is removed for the identical reason the plain
// deadline-journal test above states in full: it too can only be driven through a real, unpayable
// elapsed deadline (15-30 real minutes) via either runLlm path, on either transport. The
// recovery DECISION and its journal fields are proven at the invokeClaudeReal level just above
// ("a deadline-killed call whose injected recovery succeeds..."), and the plain journal-write
// mechanics (appendEvent reading tokensSource/freshInputTokens/... off whatever invokeClaudeReal
// returned) are proven by the non-recovery journal test above -- the two combined cover every line
// this removed test exercised, without the unpayable wait.

test('invokeClaudeReal: a stream that ends with no result message, with injected recovery -- recovery is called once with the session id, and the result carries tokensSource: "transcript"', async () => {
  let recoverCalls = 0;
  let recoverArgs = null;
  const { spawn } = fakeSpawnDeps([initMessage()]); // exits 0, no result message
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({
    spawn,
    recoverSessionTokens: async (opts) => {
      recoverCalls += 1;
      recoverArgs = opts;
      return { ...RECOVERED_SAMPLE };
    },
  }));

  assert.equal(recoverCalls, 1, 'recovery must be attempted exactly once for a no-result-message call');
  assert.equal(recoverArgs.sessionId, SESSION_ID);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
});

test('invokeClaudeReal: an external signal kill with injected recovery -- killedBySignal stays true AND tokensSource becomes "transcript", the classification undisturbed by recovery', async () => {
  let recoverCalls = 0;
  const child = fakeSpawnedChild([initMessage()], { hang: true });
  const spawn = () => child;
  const resultPromise = invokeClaudeReal(baseOpts(), fakeExecDeps({
    spawn,
    recoverSessionTokens: async () => {
      recoverCalls += 1;
      return { ...RECOVERED_SAMPLE };
    },
  }));
  setTimeout(() => child.forceExit(null, 'SIGKILL'), 10);
  const result = await resultPromise;

  assert.equal(recoverCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.killedBySignal, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
});

test('invokeClaudeReal: no `claude` resolved on PATH never calls the injected recovery function -- claude never started', async () => {
  let recoverCalls = 0;
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const result = await invokeClaudeReal(baseOpts(), {
    resolveClaudeCodeExecutable: fakeResolver(null),
    spawn,
    isNoRealSpawnEnabled: () => false,
    recoverSessionTokens: async () => {
      recoverCalls += 1;
      return { ...RECOVERED_SAMPLE };
    },
  });

  assert.equal(recoverCalls, 0, 'recovery must never be attempted when claude never started');
  assert.equal(result.sessionId, null);
  assert.equal(result.tokensSource, null);
  assert.equal(result.billableTokens, 0);
});

test('invokeClaudeReal: an unreadable oauthTokenFile never calls the injected recovery function either -- claude never started', async () => {
  let recoverCalls = 0;
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage()]);
  const result = await invokeClaudeReal(baseOpts({
    account: { name: 'acct-missing-token', configDir: null, oauthTokenFile: '/nonexistent/spo-lot4-token-ledger/gone' },
  }), fakeExecDeps({
    spawn,
    recoverSessionTokens: async () => {
      recoverCalls += 1;
      return { ...RECOVERED_SAMPLE };
    },
  }));

  assert.equal(recoverCalls, 0);
  assert.equal(result.sessionId, null);
  assert.equal(result.tokensSource, null);
});

// ---- A5: recovery is informational only, never a control-flow change -----------------------------
// Untouched by action A5b -- maybeRecoverTokens itself is not part of the transport. No migration
// needed for the fixed-object test; the live-spawn variant below is migrated onto the new fixture.

test('maybeRecoverTokens (A5): every non-token field is returned byte-identical whether recovery finds something or returns null', async () => {
  const base = Object.freeze({
    ok: false,
    kind: 'error',
    timedOut: true,
    deadlineMs: 900000,
    error: 'llm.js: claude ran but exceeded the 900000ms deadline and was killed (confirmed, signal SIGTERM)',
    sessionId: 'a5-fixed-session-id',
    tokensSource: null,
    freshInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    billableTokens: 0,
    cacheCreationEphemeral1h: 0,
    cacheCreationEphemeral5m: 0,
    numTurns: undefined,
    durationS: 812.345,
    raw: undefined,
  });
  const opts = { account: { name: 'default', configDir: '/tmp/acct' } };

  const withoutRecovery = await maybeRecoverTokens({ ...base }, opts, { recoverSessionTokens: async () => null });
  const withRecovery = await maybeRecoverTokens({ ...base }, opts, { recoverSessionTokens: async () => ({ ...RECOVERED_SAMPLE }) });

  const TOKEN_FIELDS = ['tokensSource', 'freshInputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'outputTokens', 'billableTokens', 'transcriptFilesRead', 'transcriptFilesSkipped'];
  const stripTokenFields = (obj) => {
    const copy = { ...obj };
    for (const f of TOKEN_FIELDS) delete copy[f];
    return copy;
  };

  assert.deepEqual(stripTokenFields(withoutRecovery), stripTokenFields(base));
  assert.deepEqual(stripTokenFields(withRecovery), stripTokenFields(base));
  assert.equal(withoutRecovery.tokensSource, null);
  assert.equal(withoutRecovery.billableTokens, 0);
  assert.equal(withoutRecovery.transcriptFilesRead, undefined);
  assert.equal(withoutRecovery.transcriptFilesSkipped, undefined);
  assert.equal(withRecovery.tokensSource, 'transcript');
  assert.equal(withRecovery.billableTokens, 1500);
  assert.equal(withRecovery.transcriptFilesRead, 2);
  assert.equal(withRecovery.transcriptFilesSkipped, 1);
  assert.equal(withRecovery.cacheCreationEphemeral1h, 0);
  assert.equal(withRecovery.cacheCreationEphemeral5m, 0);
});

test('invokeClaudeReal (A5, live spawn): a deadline kill\'s kind/ok/error/timedOut/deadlineMs/numTurns/raw are identical whether recovery succeeds or returns null', async () => {
  const opts = baseOpts({ deadlineMs: 30 });

  const { spawn: spawn1 } = fakeSpawnDeps([initMessage()], { hang: true });
  const resultNull = await invokeClaudeReal(opts, fakeExecDeps({ spawn: spawn1, recoverSessionTokens: async () => null }));

  const { spawn: spawn2 } = fakeSpawnDeps([initMessage()], { hang: true });
  const resultRecovered = await invokeClaudeReal(opts, fakeExecDeps({ spawn: spawn2, recoverSessionTokens: async () => ({ ...RECOVERED_SAMPLE }) }));

  for (const field of ['kind', 'ok', 'error', 'timedOut', 'deadlineMs', 'numTurns', 'raw', 'sessionId']) {
    assert.deepEqual(resultRecovered[field], resultNull[field], `field "${field}" must not depend on whether recovery ran`);
  }
  assert.equal(resultNull.tokensSource, null);
  assert.equal(resultRecovered.tokensSource, 'transcript');
});

// ---- A3: the recovery decision is structural (sessionId + tokensSource), never a text scan -------
// Untouched by action A5b -- exercises maybeRecoverTokens directly against a hand-built fixture,
// nothing transport-specific. No migration needed.

test('maybeRecoverTokens (A3, issue-439/issue-247 regression): a "failed to spawn claude" error message with a real sessionId is still recovered -- error text is never consulted', async () => {
  const legacyMisclassifiedShape = {
    ok: false,
    kind: 'error',
    error: 'llm.js: failed to spawn claude: spawnSync claude ETIMEDOUT',
    sessionId: 'issue-439-and-247-fixture-session-id',
    tokensSource: null,
    freshInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    billableTokens: 0,
    numTurns: undefined,
    durationS: 900.001,
    raw: null,
  };

  let recoverCalls = 0;
  const result = await maybeRecoverTokens(
    legacyMisclassifiedShape,
    { account: { name: 'default', configDir: '/tmp/acct' } },
    {
      recoverSessionTokens: async (opts) => {
        recoverCalls += 1;
        assert.equal(opts.sessionId, 'issue-439-and-247-fixture-session-id');
        return { ...RECOVERED_SAMPLE };
      },
    }
  );

  assert.equal(recoverCalls, 1, 'recovery must be attempted regardless of what result.error says');
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
  assert.equal(result.error, 'llm.js: failed to spawn claude: spawnSync claude ETIMEDOUT');
});

// ---- a successful call that reported no modelUsage is also recovered -----------------------------

test('invokeClaudeReal: a SUCCESSFUL call that reported no modelUsage at all is also recovered, not only killed/signalled calls', async () => {
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage({ modelUsage: {} })]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn, recoverSessionTokens: async (opts) => {
    assert.equal(opts.sessionId, SESSION_ID);
    return { ...RECOVERED_SAMPLE };
  } }));

  assert.equal(result.ok, true);
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
});

test('invokeClaudeReal: an is_error reply (no modelUsage) is also recovered', async () => {
  const { spawn } = fakeSpawnDeps([initMessage(), resultMessage({ is_error: true, modelUsage: {}, result: 'boom' })]);
  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn, recoverSessionTokens: async () => ({ ...RECOVERED_SAMPLE }) }));

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
});
