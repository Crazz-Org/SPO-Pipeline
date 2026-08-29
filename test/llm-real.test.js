'use strict';
// Unit tests for orchestrator/steps/llm.js's real-mode primitive (invokeClaudeReal/buildArgv).
// Every spawn here is a fake injected via deps.spawnSync -- this file never touches the real
// `claude` CLI (see scripts/smoke-llm.js for the one allowed real invocation).

const test = require('node:test');
const assert = require('node:assert/strict');

const { runLlm, invokeClaudeReal, buildArgv, sumCost, classifyFailure } = require('../orchestrator/steps/llm');

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
        costUSD: 0.0012,
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

test('buildArgv: full option set, exact flag order', () => {
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
    'hello world',
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
  assert.deepEqual(argv, ['-p', 'hi', '--model', 'sonnet', '--effort', 'medium', '--output-format', 'json']);
});

test('buildArgv: promptFile is read and used as the prompt text', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-promptfile-'));
  const file = path.join(dir, 'prompt.txt');
  fs.writeFileSync(file, 'from a file');
  const argv = buildArgv({ promptFile: file, model: 'haiku', effort: 'low' });
  assert.equal(argv[1], 'from a file');
});

test('buildArgv: no promptText or promptFile throws', () => {
  assert.throws(() => buildArgv({ model: 'haiku' }), /promptText or promptFile/);
});

// ---- sumCost / classifyFailure ------------------------------------------------------------

test('sumCost adds costUSD across every modelUsage entry', () => {
  const total = sumCost({
    'model-a': { costUSD: 0.01 },
    'model-b': { costUSD: 0.0025 },
    'model-c': {}, // no costUSD -- contributes 0, does not throw
  });
  assert.equal(total, 0.0125);
});

test('sumCost of a missing/empty modelUsage is 0', () => {
  assert.equal(sumCost(undefined), 0);
  assert.equal(sumCost({}), 0);
});

test('classifyFailure: api_error_status 429 -> limit', () => {
  assert.equal(classifyFailure({ api_error_status: 429, result: 'nope' }), 'limit');
});

test('classifyFailure: message text matching /limit|overloaded|rate/i -> limit', () => {
  assert.equal(classifyFailure({ result: 'You have hit the usage limit for this account' }), 'limit');
  assert.equal(classifyFailure({ terminal_reason: 'overloaded_error' }), 'limit');
});

test('classifyFailure: anything else -> error', () => {
  assert.equal(classifyFailure({ result: 'invalid tool call' }), 'error');
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

test('invokeClaudeReal: parses a real-shaped success payload and sums cost', async () => {
  const payload = realShapedPayload({
    modelUsage: {
      'claude-haiku-4-5': { costUSD: 0.001 },
      'claude-fable-5': { costUSD: 0.002 },
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
  assert.ok(Math.abs(result.costUsd - 0.003) < 1e-9);
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

// ---- runLlm real branch (thin wrapper: reads ctx.task.llm.<step>, journals, returns) ---------

test('runLlm real branch: builds the call from ctx.task.llm.<step>, uses ctx.account, journals llm-call', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-llmreal-taskdir-'));

  const payload = realShapedPayload({ result: 'plan complete' });
  let seenArgv = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      seenArgv = argv;
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
  assert.ok(seenArgv.includes('plan this'));
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
