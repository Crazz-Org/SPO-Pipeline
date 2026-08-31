'use strict';
// Unit tests for orchestrator/steps/llm.js's real-mode primitive (invokeClaudeReal/buildArgv).
// Every spawn here is a fake injected via deps.spawnSync -- this file never touches the real
// `claude` CLI (see scripts/smoke-llm.js for the one allowed real invocation).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runLlm,
  invokeClaudeReal,
  buildArgv,
  resolvePromptText,
  extractTokens,
  classifyFailure,
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

test('resolvePromptText: promptFile is read and used as the prompt text', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-promptfile-'));
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

// ---- runLlm real branch (thin wrapper: reads ctx.task.llm.<step>, journals, returns) ---------

test('runLlm real branch: builds the call from ctx.task.llm.<step>, uses ctx.account, journals llm-call', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-llmreal-taskdir-'));

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
