'use strict';
// Unit tests for orchestrator/steps/llm.js's real-mode primitive (invokeClaudeReal/buildArgv).
// Every spawn here is a fake injected via deps.spawnSync -- this file never touches the real
// `claude` CLI (see scripts/smoke-llm.js for the one allowed real invocation).

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkTmp } = require('./helpers');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const {
  runLlm,
  invokeClaudeReal,
  buildArgv,
  resolvePromptText,
  extractTokens,
  classifyFailure,
  cannedDryRunPayload,
  maybeRecoverTokens,
} = require('../orchestrator/steps/llm');

function realShapedPayload(overrides = {}) {
  return {
    result: 'ok',
    is_error: false,
    num_turns: 1,
    session_id: 'sess-123',
    modelUsage: {
      'claude-haiku-4-5': {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    terminal_reason: 'success',
    api_error_status: null,
    ...overrides,
  };
}

function fakeSpawnSync(responder) {
  return (command, argv, opts) => responder(command, argv, opts);
}

// ---- buildArgv ------------------------------------------------------------------------------

test('buildArgv: full option set, exact flag order -- no prompt in argv (it travels on stdin)', () => {
  const argv = buildArgv({
    promptText: 'hello world',
    model: 'haiku',
    effort: 'low',
    maxBudgetUsd: 0.1,
    allowedTools: ['Read', 'Grep'],
    permissionMode: 'plan',
    jsonSchema: { type: 'object' },
  });
  assert.deepEqual(argv, [
    '-p',
    '--model',
    'haiku',
    '--effort',
    'low',
    '--output-format',
    'json',
    '--max-budget-usd',
    '0.1',
    '--allowedTools',
    'Read Grep',
    '--permission-mode',
    'plan',
    '--json-schema',
    '{"type":"object"}',
  ]);
});

test('buildArgv: only the required fields -- optional flags omitted entirely', () => {
  const argv = buildArgv({ promptText: 'hi', model: 'sonnet', effort: 'medium' });
  assert.deepEqual(argv, ['-p', '--model', 'sonnet', '--effort', 'medium', '--output-format', 'json']);
});

// ---- buildArgv: --session-id (action 4.1, token-ledger lot) --------------------------------

test('buildArgv: includes --session-id right after --output-format json when opts.sessionId is a non-empty string', () => {
  const argv = buildArgv({ promptText: 'hi', model: 'sonnet', effort: 'medium', sessionId: 'sid-abc' });
  assert.deepEqual(argv, [
    '-p',
    '--model',
    'sonnet',
    '--effort',
    'medium',
    '--output-format',
    'json',
    '--session-id',
    'sid-abc',
  ]);
});

test('buildArgv: omits --session-id entirely when opts.sessionId is absent, undefined, null, or empty string', () => {
  const base = { promptText: 'hi', model: 'sonnet', effort: 'medium' };
  const expected = ['-p', '--model', 'sonnet', '--effort', 'medium', '--output-format', 'json'];
  assert.deepEqual(buildArgv(base), expected); // absent entirely
  assert.deepEqual(buildArgv({ ...base, sessionId: undefined }), expected);
  assert.deepEqual(buildArgv({ ...base, sessionId: null }), expected);
  assert.deepEqual(buildArgv({ ...base, sessionId: '' }), expected);
});

test('buildArgv: --session-id sits before the other optional flags, at a pinned position, when all are present', () => {
  const argv = buildArgv({
    promptText: 'hi',
    model: 'haiku',
    effort: 'low',
    sessionId: 'sid-full',
    maxBudgetUsd: 0.1,
    allowedTools: ['Read', 'Grep'],
    permissionMode: 'plan',
    jsonSchema: { type: 'object' },
  });
  assert.deepEqual(argv, [
    '-p',
    '--model',
    'haiku',
    '--effort',
    'low',
    '--output-format',
    'json',
    '--session-id',
    'sid-full',
    '--max-budget-usd',
    '0.1',
    '--allowedTools',
    'Read Grep',
    '--permission-mode',
    'plan',
    '--json-schema',
    '{"type":"object"}',
  ]);
});

// Mutation-testing fixes M1/M5: the `typeof opts.sessionId === 'string' && opts.sessionId !== ''`
// guard was never pinned against a non-string TRUTHY sessionId (a number, boolean, object,
// array) -- under a mutant that drops or loosens the typeof check, buildArgv would push a
// non-string value straight into argv (or, in invokeClaudeReal's resolution, the function would
// report a sessionId that was never actually passed to the CLI -- precisely the falsehood this
// whole action exists to eliminate).

test('buildArgv: a non-string truthy sessionId is rejected -- no --session-id in argv at all', () => {
  const base = { promptText: 'hi', model: 'sonnet', effort: 'medium' };
  const expected = ['-p', '--model', 'sonnet', '--effort', 'medium', '--output-format', 'json'];
  for (const nonString of [12345, true, {}, ['x']]) {
    assert.deepEqual(
      buildArgv({ ...base, sessionId: nonString }),
      expected,
      `a non-string sessionId (${JSON.stringify(nonString)}) must not reach argv`
    );
  }
});

test('invokeClaudeReal: a non-string truthy opts.sessionId is treated as absent -- a fresh id is generated, passed to argv, and reported, all in agreement', async () => {
  let seenArgv = null;
  let randomUUIDCalls = 0;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      seenArgv = argv;
      return {
        status: 0,
        stdout: JSON.stringify(realShapedPayload({ session_id: undefined, uuid: undefined })),
        stderr: '',
        signal: null,
      };
    }),
    randomUUID: () => {
      randomUUIDCalls += 1;
      return 'GENERATED';
    },
  };
  const result = await invokeClaudeReal(
    {
      promptText: 'hi',
      model: 'haiku',
      effort: 'low',
      cwd: '/tmp',
      account: { name: 'default', configDir: null },
      sessionId: 12345, // non-string truthy -- must NOT count as caller-supplied
    },
    deps
  );
  // The invariant is the pairing: whatever id was reported must be the SAME id that was passed
  // to the CLI, and a non-string sessionId must not short-circuit generation.
  assert.equal(randomUUIDCalls, 1, 'a non-string sessionId does not count as caller-supplied');
  const idx = seenArgv.indexOf('--session-id');
  assert.equal(seenArgv[idx + 1], 'GENERATED');
  assert.equal(result.sessionId, 'GENERATED');
});

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

// ---- extractTokens / classifyFailure ------------------------------------------------------

test('extractTokens: camelCase modelUsage fields (the shape this repo has actually observed)', () => {
  const tokens = extractTokens({
    'claude-haiku-4-5': {
      inputTokens: 100,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 10,
      outputTokens: 20,
    },
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
    'claude-sonnet-5': {
      input_tokens: 200,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 5,
      output_tokens: 15,
    },
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
    'model-a': { inputTokens: 10, output_tokens: 2 }, // camelCase input, snake_case output
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
    'model-c': {}, // nothing recognizable -- contributes 0
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
  // Entries present but carrying nothing recognizable at all -- still null, not a false zero.
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
    'claude-fable-5': {
      inputTokens: 500,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 40_000_000, // a huge cache hit
      outputTokens: 100,
    },
  });
  assert.equal(tokens.cacheReadTokens, 40_000_000);
  assert.equal(tokens.billableTokens, 500 + 200 + 100); // unaffected by the 40M cache-read
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
  const tokens = extractTokens({
    'claude-haiku-4-5': { inputTokens: 100, outputTokens: 20 },
  });
  assert.equal(tokens.cacheCreationEphemeral1h, 0);
  assert.equal(tokens.cacheCreationEphemeral5m, 0);
});

// ---- extractTokens: modelUsage per-model breakdown (card #214) ----------------------------

test('extractTokens: a two-model modelUsage payload carries a per-model breakdown alongside the flat totals, keyed by model name (card #214 acceptance criterion 1)', () => {
  // Exactly the shape a PLAN call that delegated to an Opus subagent would report: the CLI's
  // own reply's `modelUsage` has one entry per model the call actually touched.
  const tokens = extractTokens({
    'claude-fable-5': { inputTokens: 1000, cacheCreationInputTokens: 200, cacheReadInputTokens: 50, outputTokens: 100 },
    'claude-opus-5': { inputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 400 },
  });

  // Flat totals are unaffected -- still the sum across every model, exactly as before this card.
  assert.equal(tokens.tokensSource, 'modelUsage');
  assert.equal(tokens.freshInputTokens, 1300);
  assert.equal(tokens.cacheCreationTokens, 200);
  assert.equal(tokens.cacheReadTokens, 50);
  assert.equal(tokens.outputTokens, 500);
  assert.equal(tokens.billableTokens, 1300 + 200 + 500);

  // The new per-model breakdown: one entry per model, each with its own four fields plus its
  // own billableTokens (same fresh+cache-creation+output formula, never cache-read).
  assert.deepEqual(tokens.modelUsage, {
    'claude-fable-5': {
      freshInputTokens: 1000,
      cacheCreationTokens: 200,
      cacheReadTokens: 50,
      outputTokens: 100,
      billableTokens: 1300,
    },
    'claude-opus-5': {
      freshInputTokens: 300,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 400,
      billableTokens: 700,
    },
  });
});

test('extractTokens: a single-model modelUsage payload still gets a one-entry modelUsage breakdown', () => {
  const tokens = extractTokens({
    'claude-sonnet-5': { input_tokens: 10, output_tokens: 5 },
  });
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
    // Case and whitespace insensitive -- compared lowercased + trimmed, never a substring test.
    assert.equal(classifyFailure({ terminal_reason: reason.toUpperCase() }), 'limit', `${reason} uppercase`);
    assert.equal(classifyFailure({ terminal_reason: `  ${reason}  ` }), 'limit', `${reason} padded`);
  }
});

// R3 (F1): "exact match only" was this test file's own claim, above, but nothing actually
// pinned it -- every positive case in the loop above ('reason', 'reason.toUpperCase()',
// ' reason ') also passes under a substring implementation (`.some(r => reason.includes(r))`),
// so that mutation left the whole suite green. These two are the load-bearing negative cases:
// each CONTAINS an allowlisted reason as a substring but is not equal to one, so only a true
// exact-match implementation classifies them as 'error'.
test('classifyFailure: terminal_reason merely CONTAINING an allowlisted reason is NOT a limit -- exact match, never a substring test', () => {
  assert.equal(classifyFailure({ terminal_reason: 'was_not_a_rate_limit_error' }), 'error');
  assert.equal(classifyFailure({ terminal_reason: 'overloaded_error_recovered' }), 'error');
});

test('classifyFailure: terminal_reason "success" -> error (not a limit shape)', () => {
  assert.equal(classifyFailure({ terminal_reason: 'success' }), 'error');
});

// R8 (F7): invokeClaudeReal already guards `!parsed || typeof parsed !== 'object'` before ever
// calling classifyFailure, so this branch is unreachable from that one real call site -- but
// classifyFailure is exported and called directly all over this file, so its own defence
// deserves its own pin rather than relying on an indirect guard elsewhere never slipping.
test('classifyFailure: null -> error (defends the unreachable-from-invokeClaudeReal case directly)', () => {
  assert.equal(classifyFailure(null), 'error');
});

test('classifyFailure: api_error_status 400 -> error', () => {
  assert.equal(classifyFailure({ api_error_status: 400, result: 'bad request' }), 'error');
});

test('classifyFailure: anything else -> error', () => {
  assert.equal(classifyFailure({ result: 'invalid tool call' }), 'error');
});

// The regression this action exists for: a substring scan over free text used to misclassify
// any failure message merely containing "rate" as a rate limit -- expensive, because
// callLlmStep's response to 'limit' is to rotate to the next account (re-paying the whole step)
// and, once the pool is exhausted, cool every account for hours. None of these are limit-shaped
// (no 429/529, no allowlisted terminal_reason) and must all classify as 'error'.
test('classifyFailure: free text merely containing "rate"/"generate"/"accurate" is NOT a limit (the regression this action exists for)', () => {
  assert.equal(classifyFailure({ result: 'invalid rate parameter' }), 'error');
  assert.equal(classifyFailure({ result: 'could not generate the file' }), 'error');
  assert.equal(classifyFailure({ result: 'accurate output required' }), 'error');
  assert.equal(classifyFailure({ terminal_reason: 'error', result: 'rate of change too high' }), 'error');
});

// ---- invokeClaudeReal -----------------------------------------------------------------------

test('invokeClaudeReal: sets CLAUDE_CONFIG_DIR only when account.configDir is non-null', () => {
  let seenEnv = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenEnv = opts.env;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
  };

  return invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  ).then(() => {
    assert.equal(seenEnv.CLAUDE_CONFIG_DIR, undefined);
  });
});

test('invokeClaudeReal: passes CLAUDE_CONFIG_DIR through when the account sets one', () => {
  let seenEnv = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenEnv = opts.env;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
  };

  return invokeClaudeReal(
    {
      promptText: 'hi',
      model: 'haiku',
      effort: 'low',
      cwd: '/tmp',
      account: { name: 'acct-b', configDir: '/home/x/.claude-acct-b' },
    },
    deps
  ).then(() => {
    assert.equal(seenEnv.CLAUDE_CONFIG_DIR, '/home/x/.claude-acct-b');
  });
});

test('invokeClaudeReal: spawns "claude" with cwd passed through', () => {
  let seenCommand = null;
  let seenCwd = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenCommand = command;
      seenCwd = opts.cwd;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
  };

  return invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/home/crazz/SPO-Pipeline', account: { name: 'default', configDir: null } },
    deps
  ).then(() => {
    assert.equal(seenCommand, 'claude');
    assert.equal(seenCwd, '/home/crazz/SPO-Pipeline');
  });
});

test('invokeClaudeReal: parses a real-shaped success payload and sums tokens across model entries', async () => {
  const payload = realShapedPayload({
    modelUsage: {
      'claude-haiku-4-5': { inputTokens: 100, outputTokens: 10 },
      'claude-fable-5': { inputTokens: 50, outputTokens: 5, cacheCreationInputTokens: 20 },
    },
  });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 0, stdout: JSON.stringify(payload), stderr: '', signal: null })),
  };

  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );

  assert.equal(result.ok, true);
  assert.equal(result.result, 'ok');
  assert.equal(result.sessionId, 'sess-123');
  assert.equal(result.numTurns, 1);
  assert.equal(result.tokensSource, 'modelUsage');
  assert.equal(result.freshInputTokens, 150);
  assert.equal(result.cacheCreationTokens, 20);
  assert.equal(result.outputTokens, 15);
  assert.equal(result.billableTokens, 150 + 20 + 15);
  assert.equal(result.raw, 0);
});

test('invokeClaudeReal: falls back to uuid when session_id is absent', async () => {
  const payload = realShapedPayload({ session_id: undefined, uuid: 'uuid-456' });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 0, stdout: JSON.stringify(payload), stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.sessionId, 'uuid-456');
});

// ---- invokeClaudeReal: session id generation (action 4.1, token-ledger lot) -----------------
//
// --session-id is passed nowhere in this repo before this action (verified by grep). The id is
// generated (or taken verbatim from opts.sessionId) immediately before the spawn, and passed to
// `claude` as --session-id, so a killed or unparsable call can still be tied back to the session
// transcript that call actually wrote to disk.

test('invokeClaudeReal: generates a session id via deps.randomUUID and passes it to the spawn argv as --session-id', async () => {
  let seenArgv = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      seenArgv = argv;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
    randomUUID: () => 'generated-uuid-1',
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  const idx = seenArgv.indexOf('--session-id');
  assert.notEqual(idx, -1, 'expected --session-id in argv');
  assert.equal(seenArgv[idx + 1], 'generated-uuid-1');
  assert.equal(result.ok, true);
});

// Mutation-testing fix M14: every test above injects deps.randomUUID and asserts against the
// injected literal, so none of them ever exercises the REAL generator (node's own
// crypto.randomUUID, the production fallback when deps.randomUUID is absent). If that ever
// returned something falsy/malformed, buildArgv's guard would drop --session-id entirely, claude
// would run with no session id requested, and every failure branch would silently go back to
// reporting null -- the whole action reverted to a no-op with this suite still fully green. This
// is the only assertion in the suite that would catch a non-UUID-shaped id, which the real CLI
// (per its own --help) rejects outright.
test('invokeClaudeReal: with deps.randomUUID absent, the PRODUCTION generator (crypto.randomUUID) still passes a UUID-v4-shaped --session-id', async () => {
  let seenArgv = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      seenArgv = argv;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
    // deps.randomUUID deliberately absent -- only spawnSync is injected.
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  const idx = seenArgv.indexOf('--session-id');
  assert.notEqual(idx, -1, 'the production path must still pass --session-id when deps.randomUUID is not injected');
  assert.match(
    seenArgv[idx + 1],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'the real crypto.randomUUID output must be UUID-v4 shaped'
  );
  assert.equal(result.ok, true);
});

test('invokeClaudeReal: opts.sessionId, when supplied, is used verbatim and deps.randomUUID is never called', async () => {
  let seenArgv = null;
  let randomUUIDCalls = 0;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      seenArgv = argv;
      return {
        status: 0,
        stdout: JSON.stringify(realShapedPayload({ session_id: undefined, uuid: undefined })),
        stderr: '',
        signal: null,
      };
    }),
    randomUUID: () => {
      randomUUIDCalls += 1;
      return 'should-never-be-used';
    },
  };
  const result = await invokeClaudeReal(
    {
      promptText: 'hi',
      model: 'haiku',
      effort: 'low',
      cwd: '/tmp',
      account: { name: 'default', configDir: null },
      // Must be UUID-v4 shaped (see Fix 4's throw below on a malformed caller-supplied id).
      sessionId: '11111111-1111-4111-8111-111111111111',
    },
    deps
  );
  assert.equal(randomUUIDCalls, 0);
  const idx = seenArgv.indexOf('--session-id');
  assert.equal(seenArgv[idx + 1], '11111111-1111-4111-8111-111111111111');
  assert.equal(result.sessionId, '11111111-1111-4111-8111-111111111111');
});

test('invokeClaudeReal: success branch prefers the CLI-reported session_id over the generated id when they differ', async () => {
  const payload = realShapedPayload({ session_id: 'cli-reported-id' });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 0, stdout: JSON.stringify(payload), stderr: '', signal: null })),
    randomUUID: () => 'generated-id-that-should-lose',
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.sessionId, 'cli-reported-id');
  assert.notEqual(result.sessionId, 'generated-id-that-should-lose');
});

test('invokeClaudeReal: success branch falls back to the generated id when the reply carries neither session_id nor uuid', async () => {
  const payload = realShapedPayload({ session_id: undefined, uuid: undefined });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 0, stdout: JSON.stringify(payload), stderr: '', signal: null })),
    randomUUID: () => 'generated-fallback-id',
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.sessionId, 'generated-fallback-id');
});

test('invokeClaudeReal: an unreadable oauthTokenFile returns sessionId: null and never generates one -- claude was never spawned', async () => {
  let spawnCalls = 0;
  let randomUUIDCalls = 0;
  const deps = {
    spawnSync: fakeSpawnSync(() => {
      spawnCalls += 1;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
    randomUUID: () => {
      randomUUIDCalls += 1;
      return 'should-not-be-generated';
    },
  };
  const result = await invokeClaudeReal(
    {
      promptText: 'hi',
      model: 'haiku',
      effort: 'low',
      cwd: '/tmp',
      account: {
        name: 'acct-missing-token',
        configDir: null,
        oauthTokenFile: '/nonexistent/spo-lot4-token-ledger/does-not-exist',
      },
    },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.error, /cannot read oauthTokenFile/);
  assert.equal(result.sessionId, null);
  assert.equal(spawnCalls, 0); // claude was never spawned
  assert.equal(randomUUIDCalls, 0); // no id generated for a session that never existed
});

test('invokeClaudeReal: a deadline kill returns the generated session id (claude ran and was killed, so its transcript exists) -- kind/ok/timedOut/deadlineMs/error are unchanged from before this action', async () => {
  const timeoutErr = new Error('spawnSync claude ETIMEDOUT');
  timeoutErr.code = 'ETIMEDOUT';
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: timeoutErr, status: 143, stdout: '', stderr: '', signal: 'SIGTERM' })),
    randomUUID: () => 'gen-deadline-id',
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 5000 },
    deps
  );
  assert.equal(result.sessionId, 'gen-deadline-id');
  // A5 pin: everything else about this branch is exactly what it was before this action.
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.timedOut, true);
  assert.equal(result.killedBySignal, undefined);
  assert.equal(result.deadlineMs, 5000);
  assert.equal(
    result.error,
    'llm.js: claude ran but exceeded the 5000ms deadline and was killed (signal SIGTERM)'
  );
  assert.equal(result.raw, 143);
});

test('invokeClaudeReal: an external signal kill returns the generated session id -- kind/ok/killedBySignal/signal/error are unchanged from before this action', async () => {
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: null, stdout: '', stderr: '', signal: 'SIGTERM' })),
    randomUUID: () => 'gen-killed-id',
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null } }, // no deadlineMs
    deps
  );
  assert.equal(result.sessionId, 'gen-killed-id');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.timedOut, undefined);
  assert.equal(result.killedBySignal, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.error, 'llm.js: claude was killed by signal SIGTERM (no deadline was armed)');
});

test('invokeClaudeReal: unparsable stdout returns the generated session id -- claude exited, its transcript exists', async () => {
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: 'not json at all', stderr: 'boom', signal: null })),
    randomUUID: () => 'gen-unparsable-id',
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.sessionId, 'gen-unparsable-id');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.error, 'llm.js: claude stdout was not valid JSON (exit 1)');
});

test('invokeClaudeReal: a generic spawn failure (ENOENT) keeps sessionId null -- claude was never started, so no transcript exists', async () => {
  const enoent = new Error('spawnSync claude ENOENT');
  enoent.code = 'ENOENT';
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: enoent, status: null, stdout: '', stderr: '', signal: null })),
    randomUUID: () => 'should-not-appear-in-result',
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 5000 },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.sessionId, null);
  assert.notEqual(result.sessionId, 'should-not-appear-in-result');
});

test('invokeClaudeReal: E2BIG keeps sessionId null -- claude never started (argv too large for exec), so a future recovery action must treat this call as unrecoverable, not recovered-as-zero', async () => {
  const e2big = new Error('spawnSync claude E2BIG');
  e2big.code = 'E2BIG';
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: e2big, status: null, stdout: '', stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.sessionId, null);
  assert.match(result.error, /failed to spawn claude/);
});

// Fix 4 (defect, not a mutant): a malformed opts.sessionId string passes buildArgv's loose
// typeof/non-empty guard untouched, reaches `claude --session-id <bad-value>`, and makes the CLI
// exit 1 before any API call (per its own --help: "must be a valid UUID"). Left unguarded, that
// would land in the "claude stdout was not valid JSON" branch -- a *parse* failure reported for
// what is actually an *argument* fault, the exact misdiagnosis class this file's own header
// documents being burned by twice. invokeClaudeReal's contract is "only a programming error (bad
// opts) throws" -- a malformed sessionId is exactly that, so it must throw, not spawn.
test('invokeClaudeReal: a non-UUID opts.sessionId string throws a TypeError naming the field and value -- never reaches spawnSync', async () => {
  let spawnCalls = 0;
  const deps = {
    spawnSync: fakeSpawnSync(() => {
      spawnCalls += 1;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
  };
  await assert.rejects(
    () =>
      invokeClaudeReal(
        {
          promptText: 'hi',
          model: 'haiku',
          effort: 'low',
          cwd: '/tmp',
          account: { name: 'default', configDir: null },
          sessionId: 'not-a-uuid',
        },
        deps
      ),
    (err) => {
      assert.ok(err instanceof TypeError, 'expected a TypeError');
      assert.match(err.message, /sessionId/);
      assert.match(err.message, /not-a-uuid/);
      return true;
    }
  );
  assert.equal(spawnCalls, 0, 'claude must never be spawned on a malformed sessionId');
});

test('invokeClaudeReal: is_error + api_error_status 429 -> {ok:false, kind:"limit"}', async () => {
  const payload = realShapedPayload({ is_error: true, api_error_status: 429, result: 'rate limited' });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: JSON.stringify(payload), stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'usage');
});

test('invokeClaudeReal: is_error + api_error_status 529 -> {ok:false, kind:"limit", limitKind:"overloaded"}', async () => {
  const payload = realShapedPayload({ is_error: true, api_error_status: 529, result: 'overloaded' });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: JSON.stringify(payload), stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'overloaded');
});

// action 7.1: the two tests above drive limitKind through LIMIT_STATUSES (api_error_status 429/
// 529) -- llm.js's own limitKindForFailure is not exported (a deliberately small, private pure
// function; see its own header), so its OTHER branch, the terminal_reason-only Sets
// (USAGE_LIMIT_TERMINAL_REASONS / OVERLOADED_TERMINAL_REASONS), has to be reached the same way
// production reaches it: a reply with NO api_error_status match at all, classified purely on
// terminal_reason. classifyFailure's own tests already prove these strings classify as 'limit';
// what those tests do NOT cover is which limitKind invokeClaudeReal then attaches -- exactly the
// distinction accounts.markLimit uses to pick a cooldown tier (R5's own comment: a status and a
// terminal_reason used to be able to disagree on kind silently).
test('invokeClaudeReal: terminal_reason "rate_limit_error" alone (no api_error_status match) -> limitKind "usage"', async () => {
  const payload = realShapedPayload({
    is_error: true,
    api_error_status: null,
    terminal_reason: 'rate_limit_error',
    result: 'rate limited, no structured status this time',
  });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: JSON.stringify(payload), stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'usage');
});

test('invokeClaudeReal: terminal_reason "overloaded_error" alone (no api_error_status match) -> limitKind "overloaded"', async () => {
  const payload = realShapedPayload({
    is_error: true,
    api_error_status: null,
    terminal_reason: 'overloaded_error',
    result: 'server overloaded, no structured status this time',
  });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: JSON.stringify(payload), stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'overloaded');
});

// action 7.1 (round 2, verifier finding): the arbitration BETWEEN api_error_status and
// terminal_reason, when a reply carries a limit-shaped value on both, is exactly what R5's own
// comment (llm.js, above LIMIT_STATUSES) exists to keep consistent -- and nothing in this suite
// had ever set both at once. limitKindForFailure checks LIMIT_STATUSES (api_error_status) FIRST,
// unconditionally returning on a match before terminal_reason is even read -- so the status
// table must win. This is not cosmetic: #483 (the cooldown model) is the project's live risk, and
// getting this wrong means a reply with a spent-quota status (429, "usage" tier: 1h/5h cooldown)
// but a stale/mismatched "overloaded" terminal_reason would cool for the much SHORTER overloaded
// tier instead -- hammering an account whose quota is actually exhausted. Also pins classifyFailure
// itself the same way: it must classify 'limit' on the first matching condition, not evaluate both
// and disagree with limitKindForFailure about which one "wins".
test('invokeClaudeReal: api_error_status AND a conflicting terminal_reason both present -> the status table wins (429 + overloaded_error -> limitKind "usage", not "overloaded")', async () => {
  const payload = realShapedPayload({
    is_error: true,
    api_error_status: 429, // usage-tier status
    terminal_reason: 'overloaded_error', // overloaded-tier reason -- deliberately conflicting
    result: 'a reply that disagrees with itself about which kind of limit this is',
  });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: JSON.stringify(payload), stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.kind, 'limit');
  assert.equal(result.limitKind, 'usage', 'api_error_status must be checked (and win) before terminal_reason is ever consulted');
});

test('invokeClaudeReal: a non-limit failure never carries a limitKind at all', async () => {
  const payload = realShapedPayload({ is_error: true, api_error_status: 400, result: 'invalid json schema' });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: JSON.stringify(payload), stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.kind, 'error');
  assert.equal('limitKind' in result, false);
});

test('invokeClaudeReal: is_error with an unrelated message -> {ok:false, kind:"error"}', async () => {
  const payload = realShapedPayload({ is_error: true, api_error_status: 400, result: 'invalid json schema' });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: JSON.stringify(payload), stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
});

test('invokeClaudeReal: non-zero exit with unparsable stdout -> {ok:false, kind:"error"}', async () => {
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: 'not json at all', stderr: 'boom', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
});

test('invokeClaudeReal: passes deadlineMs through to spawnSync as its timeout option', async () => {
  let seenTimeout;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenTimeout = opts.timeout;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
  };
  await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 5000 },
    deps
  );
  assert.equal(seenTimeout, 5000);
});

// ---- invokeClaudeReal: durationS must be measured on a monotonic clock, not Date.now() ------
// Card #158, 2026-09-08: the old code read Date.now() before and after spawnSync, but the
// deadline that actually kills the call is spawnOpts.timeout, enforced by libuv's MONOTONIC
// timer -- a different clock. This host steps Date.now() -- a WSL2 clock-sync artifact (see
// orchestrator/monotonic-clock.js's own header for the measured -2515ms jump), not something
// this file claims a cause for -- so the two clocks can disagree about how much time passed for
// the same spawn.
//
// Corpus evidence (~/.spo-state/journal/, measured 2026-09-08): all 9 deadline-killed calls were
// armed with the identical 900,000ms deadline, and the 8 that carry a duration_s at all (the
// 9th, issue-385 on 2026-08-30, predates the field) ranged, under the old Date.now()-based
// measurement, 818.536s-960.461s -- from 81.5s under to 60.5s over a bound that is identical by
// construction. issue-517 (2026-09-05T02:03:20.692Z) is the decisive case: a SUCCESSFUL call
// (ok: true, 123 turns, never killed) journalled 920.322s against its own 900,000ms deadline --
// the monotonic timer that actually gates spawnSync never fired, so realtime alone said it
// should have.
//
// The isolation axis below is a realtime clock jump injected through the fake spawnSync, not the
// clock reading the fix itself uses -- asserting against an injected hrtime would prove nothing
// (the guard's own knob). Each test's responder LEAVES the patched Date.now in place when it
// returns -- the code under test takes its own Date.now() reading AFTER spawnSync returns (the
// old `(Date.now() - startedAt) / 1000` line), so restoring inside the responder would undo the
// jump before that second reading ever happened, silently turning the test into decoration (it
// would pass even against the reverted, un-fixed code -- exactly the failure mode the revert
// check below exists to catch). Restoration happens only in the outer try/finally, after
// invokeClaudeReal has returned, so a failing assertion still cannot leak the patch into the
// rest of this suite.

test('invokeClaudeReal: durationS ignores a forward Date.now() jump during the call (issue-517 shape)', async () => {
  const realDateNow = Date.now;
  const deps = {
    spawnSync: fakeSpawnSync(() => {
      // Realtime runs 80s ahead of monotonic time while claude is "running" -- issue-517's
      // shape: a call that finished quickly on the clock libuv's timeout actually uses, but
      // whose Date.now()-based reading made it look like it took 80s longer than it did. Left
      // patched on return -- the code under test reads Date.now() again AFTER spawnSync returns
      // (the old `(Date.now() - startedAt) / 1000` line), so restoring here would undo the jump
      // before that read ever happens. The outer try/finally below is what restores it.
      Date.now = () => realDateNow() + 80000;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
  };
  try {
    const result = await invokeClaudeReal(
      { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
      deps
    );
    assert.equal(result.ok, true);
    // < 1, not < 5: the fake spawn is sub-millisecond, so real durationS is ~0 -- this also
    // catches a hardcoded-1-second durationS, which a looser bound would let through silently.
    assert.ok(result.durationS < 1, `expected durationS < 1s (real elapsed time), got ${result.durationS}`);
  } finally {
    Date.now = realDateNow;
  }
});

test('invokeClaudeReal: durationS ignores a backward Date.now() jump and is never negative (issue-385/#492 shape)', async () => {
  // issue-385 (2026-08-30) and its siblings on the "under" side of the corpus spread (81.5s,
  // 78.5s, 75.5s, 74.8s under the 900,000ms bound) are the mirror case: realtime LAGGING
  // monotonic made a call killed at exactly its 900,000ms deadline look as if it had been cut up
  // to ~81s short. A -80s Date.now() step reproduces that direction; duration_s must never go
  // negative regardless of which way the realtime clock steps.
  const realDateNow = Date.now;
  const deps = {
    spawnSync: fakeSpawnSync(() => {
      // Left patched on return -- see the sibling forward-jump test's comment for why restoring
      // here (before the code under test's post-spawn Date.now() read) would undo the point.
      Date.now = () => realDateNow() - 80000;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
  };
  try {
    const result = await invokeClaudeReal(
      { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
      deps
    );
    assert.equal(result.ok, true);
    // >= 0 alone would also pass for a sign-flipped durationS on a sub-millisecond fake spawn
    // (-0 >= 0 is true) -- Object.is rejects that mutant too.
    assert.ok(
      result.durationS >= 0 && !Object.is(result.durationS, -0),
      `duration_s must never be negative, got ${result.durationS}`
    );
    assert.ok(result.durationS < 5, `expected durationS < 5s (real elapsed time), got ${result.durationS}`);
  } finally {
    Date.now = realDateNow;
  }
});

test('invokeClaudeReal: the decisive issue-517 case -- a call spawnSync did not kill never reports more than its armed deadline', async () => {
  // issue-517, 2026-09-05T02:03:20.692Z: ok:true, 123 turns, never killed -- yet the old
  // Date.now()-based duration_s (920.322s) exceeded its own 900,000ms armed deadline. That is
  // impossible under the monotonic clock spawnOpts.timeout actually enforces: a call spawnSync
  // let succeed cannot have taken longer than the timeout that would otherwise have killed it.
  const realDateNow = Date.now;
  const deps = {
    spawnSync: fakeSpawnSync(() => {
      // Realtime runs far past the armed deadline while the (monotonically fast) call succeeds
      // -- the exact shape that made the old code's duration_s exceed a deadline that never
      // fired. Left patched on return -- see the first test in this block's comment for why.
      Date.now = () => realDateNow() + 950000;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
  };
  try {
    const result = await invokeClaudeReal(
      {
        promptText: 'hi',
        model: 'haiku',
        effort: 'low',
        cwd: '/tmp',
        account: { name: 'default', configDir: null },
        deadlineMs: 900000,
      },
      deps
    );
    assert.equal(result.ok, true);
    assert.ok(
      result.durationS <= 900,
      `a call spawnSync did not kill cannot report more than its 900000ms deadline, got ${result.durationS}s`
    );
  } finally {
    Date.now = realDateNow;
  }
});

// ---- invokeClaudeReal: telling a deadline kill apart from a real spawn failure --------------
// Card #449, 2026-08-30: a deadline kill sets BOTH spawnResult.error (ETIMEDOUT) AND
// spawnResult.signal, and the old code tested `error` first, so every deadline kill was reported
// as "failed to spawn claude" -- exactly backwards, since claude ran and was killed for taking
// too long. These three tests lock in the three distinct outcomes.

test('invokeClaudeReal: a deadline kill (error ETIMEDOUT + signal) -> timedOut:true, deadlineMs, and a message that says the call RAN', async () => {
  const timeoutErr = new Error('spawnSync claude ETIMEDOUT');
  timeoutErr.code = 'ETIMEDOUT';
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: timeoutErr, status: 143, stdout: '', stderr: '', signal: 'SIGTERM' })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 5000 },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.timedOut, true);
  assert.equal(result.deadlineMs, 5000);
  assert.match(result.error, /exceeded the 5000ms deadline/);
  assert.doesNotMatch(result.error, /failed to spawn/); // the regression itself
  assert.equal(result.raw, 143);
});

test('invokeClaudeReal: a genuine spawn failure (ENOENT, no signal) still says "failed to spawn" and is NOT timedOut', async () => {
  const enoent = new Error('spawnSync claude ENOENT');
  enoent.code = 'ENOENT';
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: enoent, status: null, stdout: '', stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 5000 },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, undefined);
  assert.match(result.error, /failed to spawn/);
});

test('invokeClaudeReal: a signal with no deadline armed is reported as an external kill, not a timeout', async () => {
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: null, stdout: '', stderr: '', signal: 'SIGKILL' })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null } }, // no deadlineMs
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, undefined);
  assert.match(result.error, /killed by signal SIGKILL \(no deadline was armed\)/);
});

// ---- invokeClaudeReal: an EXTERNAL kill with a deadline armed is not a timeout ---------------
// The same defect PR #127 fixed in command-timeout.js, which this file was the second copy of.
// The deleted clause was `|| (!!spawnResult.signal && deadlineArmed)`, which classified ANY
// externally-signalled child as a deadline kill. Blast radius: `timedOut` drives intake.js's
// retry-once-on-the-same-account policy (intake.js's callIntakeStepWithRotation), so a
// deploy's SIGTERM bought a second full metered call to re-run a prompt nobody asked to keep
// running.
//
// Measured on node v22.23.2 (deadline armed in every row): a genuine expiry always sets
// `error.code === 'ETIMEDOUT'` -- with signal SIGTERM, with signal SIGKILL under a different
// killSignal, and (what `claude` actually does) with signal NULL and status 143 when the child
// traps TERM and exits itself. An external kill sets no `error` at all. So ETIMEDOUT is
// necessary and sufficient, and `signal` alone is true only for the excluded cases. The corpus
// re-count (62 journals, 2026-09-05) found 22 transport failures: 11 ETIMEDOUT, 8 `exit 143`,
// 3 E2BIG, and zero bare signals -- the clause never once produced a true positive.

test('invokeClaudeReal: an EXTERNAL signal with a deadline armed is NOT timedOut (the #127 twin)', async () => {
  const deps = {
    // No `error` at all -- node only fills one in when ITS deadline fired.
    spawnSync: fakeSpawnSync(() => ({ status: null, stdout: '', stderr: '', signal: 'SIGTERM' })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 900000 },
    deps
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  // The regression itself: this used to be `true`, and intake.js would have paid for a retry.
  assert.notEqual(result.timedOut, true);
  assert.equal(result.killedBySignal, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.match(result.error, /killed by signal SIGTERM/);
  assert.match(result.error, /an external kill, not a timeout/);
  assert.doesNotMatch(result.error, /exceeded the .* deadline/);
  // It must also not be misreported as a spawn failure or as unparsable output -- the two
  // branches it would fall through to if the kill branch were simply deleted.
  assert.doesNotMatch(result.error, /failed to spawn/);
  assert.doesNotMatch(result.error, /not valid JSON/);
});

test('invokeClaudeReal: an external SIGKILL with a deadline armed is NOT timedOut either', async () => {
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: null, stdout: '', stderr: '', signal: 'SIGKILL' })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 900000 },
    deps
  );
  assert.notEqual(result.timedOut, true);
  assert.equal(result.killedBySignal, true);
  assert.equal(result.deadlineMs, 900000); // carried so a reader can see the kill was inside it
});

test('invokeClaudeReal: a deadline kill under killSignal SIGKILL is STILL a timeout, not an external kill', async () => {
  // The row that proves `error.code === 'ETIMEDOUT'` survives a different killSignal: a child
  // that traps TERM forces node to escalate, and the signal it reports is SIGKILL -- which under
  // the deleted clause was indistinguishable from an operator's `kill -9`.
  const timeoutErr = new Error('spawnSync claude ETIMEDOUT');
  timeoutErr.code = 'ETIMEDOUT';
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: timeoutErr, status: null, stdout: '', stderr: '', signal: 'SIGKILL' })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 5000 },
    deps
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.killedBySignal, undefined);
  assert.match(result.error, /exceeded the 5000ms deadline and was killed \(signal SIGKILL\)/);
});

test('invokeClaudeReal: the shape the corpus actually records -- ETIMEDOUT, signal null, status 143', async () => {
  // 9 of the 9 flagged `timedOut: true` events in ~/.spo-state/journal carry the detail
  // "(ETIMEDOUT)", never "(signal SIGTERM)": `claude` traps SIGTERM and exits 143 itself, so
  // node reports no signal at all. The deleted clause therefore did not fire on a single
  // genuine timeout on record -- this test is what pins that claim to the code.
  const timeoutErr = new Error('spawnSync claude ETIMEDOUT');
  timeoutErr.code = 'ETIMEDOUT';
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: timeoutErr, status: 143, stdout: '', stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 900000 },
    deps
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.killedBySignal, undefined);
  assert.equal(result.raw, 143);
  assert.match(result.error, /exceeded the 900000ms deadline and was killed \(ETIMEDOUT\)/);
});

test('invokeClaudeReal: an ordinary non-zero exit with no signal is neither timedOut nor killedBySignal', async () => {
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 3, stdout: 'not json', stderr: '', signal: null })),
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 900000 },
    deps
  );
  assert.notEqual(result.timedOut, true);
  assert.equal(result.killedBySignal, undefined);
  assert.match(result.error, /not valid JSON \(exit 3\)/);
});

// ---- runLlm real branch (thin wrapper: reads ctx.task.llm.<step>, journals, returns) ---------

test('runLlm real branch: builds the call from ctx.task.llm.<step>, uses ctx.account, journals llm-call', async () => {
  const fs = require('fs');
    const path = require('path');
  const taskDir = mkTmp('spo-llmreal-taskdir-');

  const payload = realShapedPayload({ result: 'plan complete' });
  let seenArgv = null;
  let seenInput = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenArgv = argv;
      seenInput = opts.input;
      return { status: 0, stdout: JSON.stringify(payload), stderr: '', signal: null };
    }),
  };

  const ctx = {
    shadowMode: false,
    taskDir,
    config: { stepDeadlineMs: 30000 },
    account: { name: 'acct-x', configDir: null },
    task: {
      id: 't1',
      llm: {
        PLAN: { model: 'fable', effort: 'medium', promptText: 'plan this', maxBudgetUsd: 1 },
      },
    },
  };

  const result = await runLlm(ctx, 'PLAN', 'llm.PLAN', deps);

  assert.equal(result.ok, true);
  assert.equal(result.result, 'plan complete');
  assert.equal(seenInput, 'plan this');
  assert.ok(seenArgv.includes('fable'));

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const llmCallEvent = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(llmCallEvent, 'expected an llm-call journal event');
  assert.equal(llmCallEvent.step, 'PLAN');
  assert.equal(llmCallEvent.account, 'acct-x');
  assert.equal(llmCallEvent.ok, true);
  assert.equal(llmCallEvent.sessionId, 'sess-123');
  // Fix pass, card #214, F3(a): the legacy ctx.task.llm.<step> OVERRIDE branch's own appendEvent
  // call must not journal `numTurns` either -- realShapedPayload sets `num_turns: 1` above, so
  // this fails if that field is ever put back into this branch's journalled event.
  assert.equal('numTurns' in llmCallEvent, false, 'the override branch must not journal numTurns');
});

// The success-path test above proves the legacy override path's journal write carries an id when
// invokeClaudeReal returns ok:true -- it says nothing about a FAILED call on this same path. This
// test drives runLlm's legacy ctx.task.llm.<step> override branch through a deadline-killed spawn
// and reads the id back out of the journal file on disk (never off the return value), pinning
// that a killed call's generated sessionId reaches the ledger, not just invokeClaudeReal's return.
test('runLlm legacy ctx.task.llm.<step> override path: a deadline-killed call still journals the generated sessionId, with tokensSource null (read back from journal.jsonl, not from the return value)', async () => {
  const fs = require('fs');
  const path = require('path');
  const taskDir = mkTmp('spo-llmreal-legacy-deadline-taskdir-');

  const timeoutErr = new Error('spawnSync claude ETIMEDOUT');
  timeoutErr.code = 'ETIMEDOUT';
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: timeoutErr, status: 143, stdout: '', stderr: '', signal: null })),
    randomUUID: () => '11111111-2222-4333-8444-555555555555',
  };

  const ctx = {
    shadowMode: false,
    taskDir,
    config: { stepDeadlineMs: 30000 },
    account: { name: 'acct-x', configDir: null },
    task: {
      id: 't1',
      llm: {
        PLAN: { model: 'fable', effort: 'medium', promptText: 'plan this', maxBudgetUsd: 1 },
      },
    },
  };

  const result = await runLlm(ctx, 'PLAN', 'llm.PLAN', deps);

  // Confirm this call actually took the deadline-kill branch -- not a stand-in for the journal
  // assertions below, which are the actual deliverable.
  assert.equal(result.timedOut, true);

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const llmCallEvent = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(llmCallEvent, 'expected an llm-call journal event');
  assert.equal(llmCallEvent.sessionId, '11111111-2222-4333-8444-555555555555');
  assert.equal(llmCallEvent.ok, false);
  // A killed call reported no tokens -- the distinction the next action (token ledger) builds on.
  assert.equal(llmCallEvent.tokensSource, null);
});

// Fix 6 (driver's verification pass): every test above this line exercises invokeClaudeReal's
// RETURN VALUE, or the legacy ctx.task.llm.<step> override path's journal write -- none of them
// prove the REAL `kind: "card"` path's journal write carries the id, and that write is a
// SEPARATE line of code (`sessionId: raw.sessionId` in runLlm's card branch) from the one the
// test above pins. "the function returns the right value" is not "production journals it" -- see
// this repo's own doctrine on severing a dispatch from what it's supposed to prove reachable.
// This test drives runLlm's real card path (no ctx.task.llm override) through a deadline-killed
// spawn and reads the id back out of the journal file on disk, not out of runLlm's return value.
test('runLlm real kind:"card" path: a deadline-killed call still journals the non-null generated sessionId (read back from journal.jsonl, not from the return value)', async () => {
  const fs = require('fs');
  const path = require('path');
  const taskDir = mkTmp('spo-llmreal-cardpath-taskdir-');
  const worktreePath = mkTmp('spo-llmreal-cardpath-worktree-');

  const timeoutErr = new Error('spawnSync claude ETIMEDOUT');
  timeoutErr.code = 'ETIMEDOUT';
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: timeoutErr, status: 143, stdout: '', stderr: '', signal: 'SIGTERM' })),
    randomUUID: () => 'card-path-deadline-uuid',
  };

  const ctx = {
    shadowMode: false,
    dryRun: false,
    taskDir,
    account: { name: 'acct-cardpath', configDir: null },
    task: {
      id: 'card-fix6',
      kind: 'card',
      issue: 8877,
      title: 'Add a status badge',
      criterion: 'a badge appears',
      worktreePath,
      size: 'S',
      touchesRdoMembers: false,
    },
  };

  const result = await runLlm(ctx, 'PLAN', 'llm.PLAN', deps);

  // The return value (already pinned by test/llm-real.test.js's invokeClaudeReal-level deadline
  // test above) -- checked here too only to confirm this call actually took the deadline-kill
  // branch, not to stand in for the journal assertion below.
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const llmCallEvent = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(llmCallEvent, 'expected an llm-call journal event');
  assert.equal(llmCallEvent.step, 'PLAN');
  assert.equal(llmCallEvent.ok, false);
  // The actual deliverable: the id invokeClaudeReal generated and asked `claude` to use is the
  // one that landed in the journal line on disk -- not null, not undefined, exactly the injected
  // uuid.
  assert.equal(llmCallEvent.sessionId, 'card-path-deadline-uuid');
});

// ---- regression: #452's E2BIG (a big prompt must never land in argv) -----------------------

test('invokeClaudeReal: a 200KB prompt (over Linux MAX_ARG_STRLEN) goes to stdin, never into argv', async () => {
  const huge = 'x'.repeat(200 * 1024); // 200KB > MAX_ARG_STRLEN (131072 bytes/argv entry)
  let seenArgv = null;
  let seenInput = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenArgv = argv;
      seenInput = opts.input;
      return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
    }),
  };

  const result = await invokeClaudeReal(
    { step: 'IMPLEMENT', model: 'fable', effort: 'high', promptText: huge, cwd: '/tmp', account: null },
    deps
  );

  assert.equal(result.ok, true);
  assert.equal(seenInput, huge);
  assert.ok(!seenArgv.includes(huge));
  for (const arg of seenArgv) {
    assert.ok(
      Buffer.byteLength(arg) < 131072,
      `argv entry exceeds MAX_ARG_STRLEN: ${arg.slice(0, 60)}...`
    );
  }
});

// ---- action 7.1: cannedDryRunPayload's three least-exercised shapes ------------------------
//
// --dry-run's stub table is exported and dedicated per-step, but end-to-end --dry-run runs
// (test/dry-run-demo.test.js) only ever walk a happy-path card through PLAN/IMPLEMENT/VALIDATE --
// DIAGNOSE and CITATION_VERIFIER are both explicitly asserted NEVER reached there, and nothing
// drives an unrecognized step through the `default` branch at all (no --dry-run task can name one
// -- STEP_CONTRACTS is a closed set). These three shapes are only reachable, and only worth
// pinning, as direct unit calls.

test('cannedDryRunPayload: CITATION_VERIFIER stub is a real PASS-shaped verdict with no entries', () => {
  const payload = cannedDryRunPayload('CITATION_VERIFIER', null, null);
  assert.deepEqual(payload, { ok: true, dryRun: true, verdict: 'PASS', entries: [] });
});

test('cannedDryRunPayload: VALIDATE stub is a real PASS-shaped verdict with a canned reason and no findings', () => {
  const payload = cannedDryRunPayload('VALIDATE', null, null);
  assert.deepEqual(payload, {
    ok: true,
    dryRun: true,
    verdict: 'PASS',
    reasons: ['[dry-run] no verdict rendered'],
    findings: [],
  });
});

// The defensive fallthrough: a step this module has never heard of still has to satisfy whatever
// outputContract.required a future STEP_CONTRACTS entry declares, or a --dry-run walk through that
// step would fail its own contract validation immediately after cannedDryRunPayload runs --
// defeating the entire point of --dry-run as a pre-flight check that never fails on missing keys.
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

// ---- token-ledger lot, action 4.3: token recovery wiring -------------------------------------
//
// invokeClaudeReal's own maybeRecoverTokens (exported for these tests) attempts recovery when
// BOTH conditions hold on the branch's own result: tokensSource is falsy AND sessionId is a
// non-empty string. deps.recoverSessionTokens is the injection point (this file's existing
// deps.spawnSync/deps.randomUUID convention) -- every test below injects a fake so none of them
// touch the real filesystem via orchestrator/token-recovery.js's default export.

function timeoutSpawnResult(overrides = {}) {
  const timeoutErr = new Error('spawnSync claude ETIMEDOUT');
  timeoutErr.code = 'ETIMEDOUT';
  return { error: timeoutErr, status: 143, stdout: '', stderr: '', signal: null, ...overrides };
}

const RECOVERED_SAMPLE = Object.freeze({
  tokensSource: 'transcript',
  freshInputTokens: 1000,
  cacheCreationTokens: 200,
  cacheReadTokens: 50,
  outputTokens: 300,
  billableTokens: 1500,
  transcriptFilesRead: 2,
  // Non-zero on purpose (Fix 7): pins that maybeRecoverTokens/runLlm carry this completeness
  // signal through to the journal too, including the "some files were lost" case, not only the
  // "0 skipped" happy path.
  transcriptFilesSkipped: 1,
});

test('invokeClaudeReal: a deadline-killed call whose injected recovery succeeds returns tokensSource: "transcript" and the recovered numbers', async () => {
  const deps = {
    spawnSync: fakeSpawnSync(() => timeoutSpawnResult()),
    randomUUID: () => 'deadline-recovered-uuid',
    recoverSessionTokens: async () => ({ ...RECOVERED_SAMPLE }),
  };

  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: '/tmp/acct' }, deadlineMs: 5000 },
    deps
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.sessionId, 'deadline-recovered-uuid');
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.freshInputTokens, 1000);
  assert.equal(result.cacheCreationTokens, 200);
  assert.equal(result.cacheReadTokens, 50);
  assert.equal(result.outputTokens, 300);
  assert.equal(result.billableTokens, 1500);
});

test('runLlm real kind:"card" path: a deadline-killed call whose recovery succeeds journals tokensSource: "transcript" and the recovered numbers (read from journal.jsonl, not the return value)', async () => {
  const fs = require('fs');
  const path = require('path');
  const taskDir = mkTmp('spo-llmreal-recovery-cardpath-taskdir-');
  const worktreePath = mkTmp('spo-llmreal-recovery-cardpath-worktree-');

  let recoverCalls = 0;
  let recoverArgs = null;
  const deps = {
    spawnSync: fakeSpawnSync(() => timeoutSpawnResult()),
    randomUUID: () => 'card-path-recovered-uuid',
    recoverSessionTokens: async (opts) => {
      recoverCalls += 1;
      recoverArgs = opts;
      return { ...RECOVERED_SAMPLE };
    },
  };

  const ctx = {
    shadowMode: false,
    dryRun: false,
    taskDir,
    account: { name: 'acct-recover', configDir: '/tmp/acct-recover-config' },
    task: {
      id: 'card-recover',
      kind: 'card',
      issue: 9001,
      title: 'Recover killed-call tokens',
      criterion: 'tokens are recovered',
      worktreePath,
      size: 'S',
      touchesRdoMembers: false,
    },
  };

  const result = await runLlm(ctx, 'PLAN', 'llm.PLAN', deps);

  assert.equal(result.timedOut, true);
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
  assert.equal(recoverCalls, 1);
  assert.equal(recoverArgs.sessionId, 'card-path-recovered-uuid');
  assert.equal(recoverArgs.accountConfigDir, '/tmp/acct-recover-config');

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const llmCallEvent = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(llmCallEvent, 'expected an llm-call journal event');
  assert.equal(llmCallEvent.sessionId, 'card-path-recovered-uuid');
  assert.equal(llmCallEvent.tokensSource, 'transcript');
  assert.equal(llmCallEvent.freshInputTokens, 1000);
  assert.equal(llmCallEvent.cacheCreationTokens, 200);
  assert.equal(llmCallEvent.cacheReadTokens, 50);
  assert.equal(llmCallEvent.outputTokens, 300);
  assert.equal(llmCallEvent.billableTokens, 1500);
  // Fix 7: the completeness signal recoverSessionTokens computes must reach the journal too, not
  // just the six token fields -- transcriptFilesSkipped non-zero here (RECOVERED_SAMPLE) pins the
  // "some files were lost" case, not only the "0 skipped" happy path.
  assert.equal(llmCallEvent.transcriptFilesRead, 2);
  assert.equal(llmCallEvent.transcriptFilesSkipped, 1);
});

// ---- Fix 2 (M10c/M10d, finding F2): two of the five recovery branches were unpinned -----------
// Recovery is wired to five branches (deadline kill, external signal kill, unparsable stdout,
// is_error/non-zero-exit, and a success with no modelUsage) -- only the deadline kill, is_error and
// success branches had a recovery-injected test before this fix. These two close the gap.

test('invokeClaudeReal: unparsable stdout with injected recovery -- recovery is called once with the generated sessionId, and the result carries tokensSource: "transcript"', async () => {
  let recoverCalls = 0;
  let recoverArgs = null;
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: 'not json', stderr: '', signal: null })),
    randomUUID: () => 'unparsable-uuid',
    recoverSessionTokens: async (opts) => {
      recoverCalls += 1;
      recoverArgs = opts;
      return { ...RECOVERED_SAMPLE };
    },
  };

  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );

  assert.equal(recoverCalls, 1, 'recovery must be attempted exactly once for an unparsable-stdout call');
  assert.equal(recoverArgs.sessionId, 'unparsable-uuid');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.sessionId, 'unparsable-uuid');
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
});

test('invokeClaudeReal: an external signal kill (SIGKILL, no error) with injected recovery -- killedBySignal stays true AND tokensSource becomes "transcript", the classification undisturbed by recovery', async () => {
  let recoverCalls = 0;
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' })),
    randomUUID: () => 'sigkill-recovered-uuid',
    recoverSessionTokens: async () => {
      recoverCalls += 1;
      return { ...RECOVERED_SAMPLE };
    },
  };

  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null } }, // no deadlineMs
    deps
  );

  assert.equal(recoverCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.killedBySignal, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
});

test('invokeClaudeReal: E2BIG never calls the injected recovery function -- claude never started, sessionId stays null, tokensSource stays null', async () => {
  const e2big = new Error('spawnSync claude E2BIG');
  e2big.code = 'E2BIG';
  let recoverCalls = 0;
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ error: e2big, status: null, stdout: '', stderr: '', signal: null })),
    recoverSessionTokens: async () => {
      recoverCalls += 1;
      return { ...RECOVERED_SAMPLE };
    },
  };

  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );

  assert.equal(recoverCalls, 0, 'recovery must never be attempted when claude never started');
  assert.equal(result.sessionId, null);
  assert.equal(result.tokensSource, null);
  assert.equal(result.billableTokens, 0);
});

test('invokeClaudeReal: an unreadable oauthTokenFile never calls the injected recovery function either -- claude never started', async () => {
  let recoverCalls = 0;
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null })),
    recoverSessionTokens: async () => {
      recoverCalls += 1;
      return { ...RECOVERED_SAMPLE };
    },
  };

  const result = await invokeClaudeReal(
    {
      promptText: 'hi',
      model: 'haiku',
      cwd: '/tmp',
      account: { name: 'acct-missing-token', configDir: null, oauthTokenFile: '/nonexistent/spo-lot4-token-ledger/gone' },
    },
    deps
  );

  assert.equal(recoverCalls, 0);
  assert.equal(result.sessionId, null);
  assert.equal(result.tokensSource, null);
});

// ---- A5: recovery is informational only, never a control-flow change ---------------------------

test('maybeRecoverTokens (A5): every non-token field is returned byte-identical whether recovery finds something or returns null', async () => {
  // A fixed, realistic "deadline kill" shape -- the exact object invokeClaudeReal's own deadline
  // branch builds, captured once so durationS (a live wall-clock measurement, not something this
  // module recomputes) cannot introduce flakiness into the comparison below: both calls read the
  // SAME base object, proving maybeRecoverTokens itself never rewrites a non-token field, rather
  // than proving two independent live spawns happened to measure the same duration.
  const base = Object.freeze({
    ok: false,
    kind: 'error',
    timedOut: true,
    deadlineMs: 900000,
    error: 'llm.js: claude ran but exceeded the 900000ms deadline and was killed (signal SIGTERM)',
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
    raw: 143,
  });
  const opts = { account: { name: 'default', configDir: '/tmp/acct' } };

  const withoutRecovery = await maybeRecoverTokens({ ...base }, opts, { recoverSessionTokens: async () => null });
  const withRecovery = await maybeRecoverTokens({ ...base }, opts, { recoverSessionTokens: async () => ({ ...RECOVERED_SAMPLE }) });

  // Fix 7 extended this list: transcriptFilesRead/transcriptFilesSkipped are recovery-owned
  // fields exactly like the six token fields -- present only when recovery actually ran and
  // found something, absent (never a false 0) otherwise.
  const TOKEN_FIELDS = [
    'tokensSource',
    'freshInputTokens',
    'cacheCreationTokens',
    'cacheReadTokens',
    'outputTokens',
    'billableTokens',
    'transcriptFilesRead',
    'transcriptFilesSkipped',
  ];
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
  // cacheCreationEphemeral1h/5m are not part of what a transcript recovery collects -- they stay
  // whatever the original ZERO_TOKENS shape had them at (0), not overwritten to anything else.
  assert.equal(withRecovery.cacheCreationEphemeral1h, 0);
  assert.equal(withRecovery.cacheCreationEphemeral5m, 0);
});

test('invokeClaudeReal (A5, live spawn): a deadline kill\'s kind/ok/error/timedOut/deadlineMs/numTurns/raw are identical whether recovery succeeds or returns null', async () => {
  const spawnFn = fakeSpawnSync(() => timeoutSpawnResult({ signal: 'SIGTERM' }));
  const opts = { promptText: 'hi', model: 'haiku', cwd: '/tmp', account: { name: 'default', configDir: null }, deadlineMs: 5000 };

  const resultNull = await invokeClaudeReal(opts, {
    spawnSync: spawnFn,
    randomUUID: () => 'a5-live-uuid',
    recoverSessionTokens: async () => null,
  });
  const resultRecovered = await invokeClaudeReal(opts, {
    spawnSync: spawnFn,
    randomUUID: () => 'a5-live-uuid',
    recoverSessionTokens: async () => ({ ...RECOVERED_SAMPLE }),
  });

  for (const field of ['kind', 'ok', 'error', 'timedOut', 'deadlineMs', 'numTurns', 'raw', 'sessionId']) {
    assert.deepEqual(resultRecovered[field], resultNull[field], `field "${field}" must not depend on whether recovery ran`);
  }
  assert.equal(resultNull.tokensSource, null);
  assert.equal(resultRecovered.tokensSource, 'transcript');
});

// ---- A3: the recovery decision is structural (sessionId + tokensSource), never a text scan -----
//
// Regression fixtures, both real corpus cases: issue-439 and issue-247 journalled
// "llm.js: failed to spawn claude: spawnSync claude ETIMEDOUT" -- text that says "failed to
// spawn" for calls that in fact ran and were deadline-killed (that message predates the fix that
// split timeouts out of the generic spawn-failure branch, PR referenced in this file's own
// deadline-kill comment). This constructs exactly that historical shape -- an error string
// containing "failed to spawn claude" alongside a real sessionId and tokensSource: null -- and
// proves maybeRecoverTokens still recovers it: the decision reads sessionId/tokensSource only,
// never `result.error`.

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
  // The error text itself is untouched -- recovery is informational only (A5).
  assert.equal(result.error, 'llm.js: failed to spawn claude: spawnSync claude ETIMEDOUT');
});

// ---- a successful call that reported no modelUsage is also recovered ---------------------------

test('invokeClaudeReal: a SUCCESSFUL call that reported no modelUsage at all is also recovered, not only killed/signalled/unparsable calls', async () => {
  const payload = realShapedPayload({ modelUsage: undefined });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 0, stdout: JSON.stringify(payload), stderr: '', signal: null })),
    randomUUID: () => 'success-no-modelusage-uuid',
    recoverSessionTokens: async (opts) => {
      // The CLI's own reported session_id ('sess-123', from realShapedPayload) wins over the
      // generated one -- see invokeClaudeReal's own comment on reportedSessionId. Recovery must
      // be attempted against THAT id, not the generated one.
      assert.equal(opts.sessionId, 'sess-123');
      return { ...RECOVERED_SAMPLE };
    },
  };

  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );

  assert.equal(result.ok, true);
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
});

// ---- an is_error/non-zero-exit reply with a sessionId is recovered the same way -----------------

test('invokeClaudeReal: an is_error reply (non-zero exit, real sessionId, no modelUsage) is also recovered', async () => {
  const payload = realShapedPayload({ is_error: true, modelUsage: undefined, result: 'boom' });
  const deps = {
    spawnSync: fakeSpawnSync(() => ({ status: 1, stdout: JSON.stringify(payload), stderr: '', signal: null })),
    randomUUID: () => 'is-error-no-modelusage-uuid',
    recoverSessionTokens: async () => ({ ...RECOVERED_SAMPLE }),
  };

  const result = await invokeClaudeReal(
    { promptText: 'hi', model: 'haiku', effort: 'low', cwd: '/tmp', account: { name: 'default', configDir: null } },
    deps
  );

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.tokensSource, 'transcript');
  assert.equal(result.billableTokens, 1500);
});
