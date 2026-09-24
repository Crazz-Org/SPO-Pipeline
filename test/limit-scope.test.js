'use strict';
// Card SPO-Pipeline#250 -- a session or weekly limit is ACCOUNT-WIDE, a model limit is not.
//
// Since #167 a limit cooled exactly one (account, model) pair. Right for a model limit ("You've
// reached your Fable limit. Switch to another model to continue."), wrong for the 5-hour session
// window and the weekly window, which every model on the account shares: the limited account was
// leased again once per OTHER model in every cooldown window (measured: 3 calls on the limited
// account per window instead of 1). Both kinds reach the pipeline as the same 429 `result`; the
// structured discriminator is the `rate_limit_event` the CLI writes before it, `status:'rejected'`
// with a `rateLimitType` -- see steps/llm.js's limitScopeFor for the table and the fail-safe.
//
// Every stream here goes through the REAL vendored query() with a child that EXITS 1, as the real
// CLI does after an error `result` (card #254's harness shape; a spy asserts the SDK really threw).
// The streams are test/fixtures/sdk-cli-exit1-error-results.json: `streams` are recordings of the
// real CLI 2.1.280 (five_hour, seven_day, and the Fable limit's seven_day_overage_included),
// `limitScopeSyntheticStreams` are those recordings with only the rate_limit_event edited, for the
// values no live limit has produced yet -- each one's provenance is in the fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp, writePoolDir, fakeSpawnedChild, fakeExecDeps } = require('./helpers');

// Must land before the orchestrator requires below -- see test/no-real-spawn.js.
require('./no-real-spawn');

const { consumeQueryStream } = require('../orchestrator/steps/sdk-call');
const llm = require('../orchestrator/steps/llm');
const { loadQuery } = require('../orchestrator/sdk');
const accounts = require('../orchestrator/accounts');
const { callLlmStep, buildCtx } = require('../orchestrator/state-machine');
const intake = require('../orchestrator/intake');
const { OPUS_5_5 } = require('../orchestrator/step-contracts');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk-cli-exit1-error-results.json'), 'utf8'));
const STREAMS = { ...FIXTURE.streams, ...FIXTURE.limitScopeSyntheticStreams };

// The absolute answer per stream -- never derived from limitScopeFor itself, so a change to its
// table cannot move both sides together.
const EXPECTED_SCOPE = {
  // recorded
  five_hour: { limitScope: 'account', rateLimitType: 'five_hour' },
  seven_day: { limitScope: 'account', rateLimitType: 'seven_day' },
  fable: { limitScope: 'model', rateLimitType: 'seven_day_overage_included' },
  overloaded: { limitScope: 'model', rateLimitType: null, limitKind: 'overloaded' },
  // synthetic
  seven_day_opus: { limitScope: 'model', rateLimitType: 'seven_day_opus' },
  seven_day_sonnet: { limitScope: 'model', rateLimitType: 'seven_day_sonnet' },
  overage: { limitScope: 'account', rateLimitType: 'overage' },
  unknown_type: { limitScope: 'account', rateLimitType: 'fourteen_day' },
  // the typed cross-check (verifier fix): the recorded Fable assistant line's api_error survives
  // the deleted event, so it is still a model limit; with nothing typed left it is the default.
  no_event_fable_text: { limitScope: 'model', rateLimitType: null, apiError: 'model_requires_usage_credits' },
  no_event_no_api_error: { limitScope: 'account', rateLimitType: null, apiError: null },
  credits_required_error_code: { limitScope: 'model', rateLimitType: null, apiError: null, rateLimitErrorCode: 'credits_required' },
  five_hour_with_model_api_error: { limitScope: 'account', rateLimitType: 'five_hour', apiError: 'model_requires_usage_credits' },
  allowed_warning_only: { limitScope: 'account', rateLimitType: null, apiError: null },
  fable_then_allowed_warning: { limitScope: 'model', rateLimitType: 'seven_day_overage_included' },
  two_rejected_last_wins: { limitScope: 'model', rateLimitType: 'seven_day_overage_included' },
};

// spyOnStream(stream) -- card #254's spy: forwards every message unchanged and records the error
// the stream threw, if any (`spy.threw` is null when it ended cleanly).
function spyOnStream(stream) {
  const spy = { threw: null, messages: 0 };
  const wrapped = (async function* () {
    try {
      for await (const message of stream) {
        spy.messages += 1;
        yield message;
      }
    } catch (err) {
      spy.threw = err;
      throw err;
    }
  })();
  return { stream: wrapped, spy };
}

// The REAL vendored query(), each stream wrapped by spyOnStream -- injected as `deps.query`.
async function spyingQuery() {
  const realQuery = await loadQuery();
  const spies = [];
  const query = (args) => {
    const { stream, spy } = spyOnStream(realQuery(args));
    spies.push(spy);
    return stream;
  };
  return { query, spies };
}

// Runs `lines` through the real query() on an in-memory child that exits `exitCode`, and returns
// consumeQueryStream's classification plus the spy.
async function classify(lines, exitCode = 1) {
  const { query, spies } = await spyingQuery();
  const stream = query({
    prompt: 'hello',
    options: {
      pathToClaudeCodeExecutable: '/nonexistent/claude',
      cwd: '/tmp',
      env: process.env,
      spawnClaudeCodeProcess: (spawnOpts) => fakeSpawnedChild(lines, { exitCode, signal: spawnOpts.signal }),
    },
  });
  const out = await consumeQueryStream(stream);
  return { out, spy: spies[0] };
}

// ---- 1. the scope table, and the classification of every stream -------------------------------

test('#250 limitScopeFor: the table in its header, entry by entry, and the fail-safe default', () => {
  assert.deepEqual([...llm.ACCOUNT_SCOPE_RATE_LIMIT_TYPES].sort(), ['five_hour', 'seven_day']);
  assert.deepEqual([...llm.MODEL_SCOPE_RATE_LIMIT_TYPES].sort(), ['seven_day_opus', 'seven_day_overage_included', 'seven_day_sonnet']);
  assert.equal(llm.LIMIT_SCOPE_DEFAULT, 'account', 'an unrecognised or absent scope cools the whole account (fail-safe)');
  const table = [
    ['usage', 'five_hour', 'account'],
    ['usage', 'seven_day', 'account'],
    ['usage', 'seven_day_overage_included', 'model'],
    ['usage', 'seven_day_opus', 'model'],
    ['usage', 'seven_day_sonnet', 'model'],
    ['usage', 'overage', 'account'],
    ['usage', 'fourteen_day', 'account'],
    ['usage', null, 'account'],
    ['usage', undefined, 'account'],
    [undefined, null, 'account'],
    // 529 has no quota scope: its pre-#250 model-only cooldown is kept, whatever the event says.
    ['overloaded', null, 'model'],
    ['overloaded', 'five_hour', 'model'],
    // the typed cross-check: after the account windows, before the default
    ['usage', null, 'model', { apiError: 'model_requires_usage_credits' }],
    ['usage', null, 'model', { errorCode: 'credits_required' }],
    ['usage', 'overage', 'model', { apiError: 'model_requires_usage_credits' }],
    ['usage', 'five_hour', 'account', { apiError: 'model_requires_usage_credits' }],
    ['usage', 'seven_day', 'account', { errorCode: 'credits_required' }],
    ['usage', null, 'account', { apiError: 'some_other_error', errorCode: 'other' }],
    ['usage', null, 'account', null],
  ];
  assert.equal(llm.MODEL_LIMIT_API_ERROR, 'model_requires_usage_credits');
  assert.equal(llm.MODEL_LIMIT_ERROR_CODE, 'credits_required');
  for (const [limitKind, rateLimitType, expected, cause] of table) {
    assert.equal(llm.limitScopeFor(limitKind, rateLimitType, cause), expected, `${limitKind} / ${rateLimitType} / ${JSON.stringify(cause)}`);
  }
});

test('#250 accounts.limitScopeOfResult: only an explicit model scope is model-wide; anything else fails safe to account', () => {
  assert.equal(accounts.limitScopeOfResult({ limitScope: 'model' }), 'model');
  assert.equal(accounts.limitScopeOfResult({ limitScope: 'account' }), 'account');
  assert.equal(accounts.limitScopeOfResult({}), 'account', 'a result that never classified the scope');
  assert.equal(accounts.limitScopeOfResult({ limitScope: 'MODEL' }), 'account');
  assert.equal(accounts.limitScopeOfResult(null), 'account');
});

test('#250 fixture: every stream has an expectation, every synthetic one ends in the recorded 429 result', () => {
  const limitStreams = Object.keys(STREAMS).filter((n) => n !== 'prompt_too_long');
  assert.deepEqual(limitStreams.sort(), Object.keys(EXPECTED_SCOPE).sort());
  for (const name of Object.keys(FIXTURE.limitScopeSyntheticStreams)) {
    const lines = FIXTURE.limitScopeSyntheticStreams[name];
    assert.equal(lines[lines.length - 1].type, 'result', `${name}: ends in the recorded result`);
    assert.equal(lines[lines.length - 1].api_error_status, 429, `${name}: a 429`);
  }
  assert.ok(FIXTURE.limitScopeSyntheticProvenance.startsWith('SYNTHETIC, not recorded (card SPO-Pipeline#250)'));
});

for (const name of Object.keys(EXPECTED_SCOPE)) {
  test(`#250: ${name} stream + exit 1, through the real query() -> limitScope ${EXPECTED_SCOPE[name].limitScope}`, async () => {
    const { out, spy } = await classify(STREAMS[name], 1);
    assert.ok(spy.threw, `${name}: premise -- the SDK threw on the child's exit 1`);
    assert.equal(spy.messages, STREAMS[name].length, `${name}: every line, the rate_limit_event included, reached the stream`);
    assert.equal(out.kind, 'limit');
    assert.equal(out.limitKind, EXPECTED_SCOPE[name].limitKind || 'usage');
    assert.equal(out.limitScope, EXPECTED_SCOPE[name].limitScope, `${name}: limitScope`);
    assert.equal(out.rateLimitType, EXPECTED_SCOPE[name].rateLimitType, `${name}: rateLimitType`);
    if ('apiError' in EXPECTED_SCOPE[name]) assert.equal(out.apiError, EXPECTED_SCOPE[name].apiError, `${name}: apiError`);
    assert.equal(out.rateLimitErrorCode, EXPECTED_SCOPE[name].rateLimitErrorCode || null, `${name}: rateLimitErrorCode`);
  });
}

test('#250: a non-limit failure (400 prompt_too_long) carries neither limitScope nor rateLimitType', async () => {
  const { out, spy } = await classify(STREAMS.prompt_too_long, 1);
  assert.ok(spy.threw);
  assert.equal(out.kind, 'error');
  assert.equal('limitScope' in out, false);
  assert.equal('rateLimitType' in out, false);
});

// ---- 2. end to end on a 2-account pool: which account the NEXT call leases ---------------------
//
// acct-a is the limited account; acct-b always answers. Every call is a real callLlmStep (or a
// real intake step) through the real lease, markLimit and vendored query(); only the child is
// fake. What is asserted is WHERE each call spawned (the account, read off CLAUDE_CONFIG_DIR, and
// the model, read off the argv's --model) -- i.e. whether the limited account was leased again.

const SESSION_ID = FIXTURE.streams.five_hour[0].session_id;

function okResultLines(result) {
  return [
    FIXTURE.streams.five_hour[0],
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      duration_ms: 900,
      session_id: SESSION_ID,
      modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5 } },
      result,
    },
  ];
}

// poolSpawn(limitedLines, opts) -- a `deps.spawn` for the whole pool. acct-a answers
// `limitedLines` and exits 1 (as the real CLI does after an error result) -- on every model, or
// only on `opts.onlyModel` when given; everything else answers `opts.okResult` (default 'ok').
// `calls` records [account, model] per spawn, in order.
function poolSpawn(limitedLines, opts = {}) {
  const calls = [];
  const spawn = (command, args, spawnOpts) => {
    const account = path.basename(spawnOpts.env.CLAUDE_CONFIG_DIR);
    const i = args.indexOf('--model');
    const model = i >= 0 ? args[i + 1] : undefined;
    calls.push([account, model]);
    if (account === 'acct-a' && (!opts.onlyModel || opts.onlyModel === model)) {
      return fakeSpawnedChild(limitedLines, { exitCode: 1, signal: spawnOpts.signal });
    }
    return fakeSpawnedChild(okResultLines(opts.okResult || 'ok'), { signal: spawnOpts.signal });
  };
  return { spawn, calls };
}

// A callLlmStep ctx on the legacy override path, so each call names its own model: VALIDATE,
// overridden to `model` (steps/llm.js's resolveCallModel -- the same model the lease asks for,
// the argv carries and markLimit cools).
function overrideCtx(accountsDir, model) {
  const taskDir = mkTmp('spo-250-taskdir-');
  const task = { id: 't-250', llm: { VALIDATE: { model, effort: 'medium', promptText: 'check it' } } };
  const ctx = buildCtx('t-250', task, taskDir, {
    shadowMode: false,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
    accountLeaseWaitMs: 2000,
    accountLeasePollMs: 25,
  });
  return { ctx, taskDir };
}

function cooldownEvents(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'account-cooldown');
}

function twoAccountPool(prefix) {
  return writePoolDir(mkTmp(prefix), [{ name: 'acct-a' }, { name: 'acct-b' }]);
}

// One call per KNOWN model, in this order -- the #250 reproduction's shape (pre-#250, each one
// leased the limited account once more).
const EVERY_MODEL = ['fable', 'sonnet', OPUS_5_5];

// Account-wide: the recorded session and weekly limits, the three fail-safe shapes (no rejected
// event and no typed cause, an unknown window, 'overage'), and an explicit five_hour window whose
// assistant line ALSO carries the model-limit api_error (the account window wins).
const ACCOUNT_WIDE_CASES = ['five_hour', 'seven_day', 'no_event_no_api_error', 'unknown_type', 'overage', 'five_hour_with_model_api_error'];

for (const name of ACCOUNT_WIDE_CASES) {
  test(`#250 e2e callLlmStep: a ${name} limit on acct-a cools it for EVERY model -- one call per window on acct-a, not one per model`, async () => {
    const accountsDir = twoAccountPool('spo-250-acct-');
    const { spawn, calls } = poolSpawn(STREAMS[name]);
    const { query, spies } = await spyingQuery();

    const taskDirs = [];
    for (const model of EVERY_MODEL) {
      const { ctx, taskDir } = overrideCtx(accountsDir, model);
      taskDirs.push(taskDir);
      const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));
      assert.equal(result.ok, true, `${name}/${model}: answered by acct-b`);
      assert.equal(ctx.account.name, 'acct-b');
    }

    assert.ok(spies[0].threw, `${name}: premise -- the SDK threw on the limited child's exit 1`);
    // THE #250 REPRODUCTION: pre-#250 this was 3 (one per model); pre-#167 and now, 1.
    const onA = calls.filter(([account]) => account === 'acct-a');
    assert.deepEqual(onA, [['acct-a', 'fable']], `${name}: acct-a is leased ONCE in the window, by the first call`);
    assert.deepEqual(
      calls,
      [['acct-a', 'fable'], ['acct-b', 'fable'], ['acct-b', 'sonnet'], ['acct-b', OPUS_5_5]],
      `${name}: every later call, on every other model, went straight to acct-b`
    );

    const byModel = accounts.readState(accountsDir)['acct-a'].byModel;
    assert.deepEqual(Object.keys(byModel).sort(), [...accounts.KNOWN_MODELS].sort(), `${name}: every known model cools`);
    for (const m of accounts.KNOWN_MODELS) {
      assert.equal(byModel[m].cooldownUntil - byModel[m].lastUsageLimitAt, accounts.USAGE_PROBE_COOLDOWN_MS, `${m}: the 1h probe`);
    }
    assert.equal(accounts.readState(accountsDir)['acct-b'], undefined);

    // The journal says it was account-wide, and which window the server named.
    const events = cooldownEvents(taskDirs[0]);
    assert.equal(events.length, 1);
    assert.equal(events[0].account, 'acct-a');
    assert.equal(events[0].limitScope, 'account');
    assert.equal(events[0].rateLimitType, EXPECTED_SCOPE[name].rateLimitType);
    assert.equal(events[0].model, 'fable', 'the model of the call that hit it is still recorded');
    assert.deepEqual([...events[0].models].sort(), [...accounts.KNOWN_MODELS].sort());
    assert.equal(cooldownEvents(taskDirs[1]).length + cooldownEvents(taskDirs[2]).length, 0, 'no further limit was hit');
  });
}

// Model-scoped: the recorded Fable limit, the two per-model windows of the CLI enum, the two
// multi-event shapes, and the two routes of the typed cross-check (api_error with no event;
// errorCode credits_required with no rateLimitType). acct-a is limited on fable ONLY.
const MODEL_SCOPED_CASES = [
  'fable',
  'seven_day_opus',
  'seven_day_sonnet',
  'fable_then_allowed_warning',
  'two_rejected_last_wins',
  'no_event_fable_text',
  'credits_required_error_code',
];

for (const name of MODEL_SCOPED_CASES) {
  test(`#250 e2e callLlmStep: a ${name} MODEL limit cools only (acct-a, fable) -- a following opus call still leases acct-a (#167 kept)`, async () => {
    const accountsDir = twoAccountPool('spo-250-model-');
    const { spawn, calls } = poolSpawn(STREAMS[name], { onlyModel: 'fable' });
    const { query, spies } = await spyingQuery();

    const first = overrideCtx(accountsDir, 'fable');
    const r1 = await callLlmStep(first.ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));
    assert.ok(spies[0].threw, `${name}: premise -- the SDK threw on the limited child's exit 1`);
    assert.equal(r1.ok, true);

    const second = overrideCtx(accountsDir, OPUS_5_5);
    const r2 = await callLlmStep(second.ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));
    assert.equal(r2.ok, true);
    assert.equal(second.ctx.account.name, 'acct-a', `${name}: acct-a still serves opus`);

    const third = overrideCtx(accountsDir, 'fable');
    await callLlmStep(third.ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));
    assert.equal(third.ctx.account.name, 'acct-b', `${name}: but not fable, which is cooling`);

    assert.deepEqual(calls, [
      ['acct-a', 'fable'],
      ['acct-b', 'fable'],
      ['acct-a', OPUS_5_5],
      ['acct-b', 'fable'],
    ]);
    assert.deepEqual(Object.keys(accounts.readState(accountsDir)['acct-a'].byModel), ['fable'], `${name}: exactly fable cools`);

    const events = cooldownEvents(first.taskDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].limitScope, 'model');
    assert.equal(events[0].rateLimitType, EXPECTED_SCOPE[name].rateLimitType);
    assert.equal(events[0].model, 'fable');
    assert.deepEqual(events[0].models, ['fable']);
  });
}

test('#250 e2e callLlmStep: a 529 keeps its pre-#250 model-only 5-minute cooldown (no quota scope)', async () => {
  const accountsDir = twoAccountPool('spo-250-529-');
  const { spawn, calls } = poolSpawn(STREAMS.overloaded, { onlyModel: 'fable' });
  const { query } = await spyingQuery();
  const first = overrideCtx(accountsDir, 'fable');
  await callLlmStep(first.ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));
  const second = overrideCtx(accountsDir, 'sonnet');
  await callLlmStep(second.ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));
  assert.deepEqual(calls, [['acct-a', 'fable'], ['acct-b', 'fable'], ['acct-a', 'sonnet']]);
  const byModel = accounts.readState(accountsDir)['acct-a'].byModel;
  assert.deepEqual(Object.keys(byModel), ['fable']);
  const [event] = cooldownEvents(first.taskDir);
  assert.equal(event.limitKind, 'overloaded');
  assert.equal(event.cooldownMs, accounts.OVERLOADED_COOLDOWN_MS);
  assert.equal(event.limitScope, 'model');
  assert.equal(event.rateLimitType, null);
});

// ---- 3. the same through the intake rotation (callIntakeStepWithRotation) ----------------------

const VALID_DRAFT = {
  title: 'Header lacks a connection-state badge',
  body_markdown: ['The header never shows whether the gateway connection is up.', '', '## Done means', 'A badge.'].join('\n'),
  category: 'feature',
  size: 'S',
  area: 'client',
  priority: 'Medium',
  is_bug_report: false,
  confirmed: false,
};

function intakeDeps(accountsDir, spawn, query) {
  return { ...fakeExecDeps(), accountsDir, journalRoot: mkTmp('spo-250-intake-journal-'), spawn, query };
}

for (const name of ['five_hour', 'no_event_no_api_error']) {
  test(`#250 e2e intake: a ${name} limit on draftCard (sonnet) cools acct-a for every model -- the following reviewCard (fable) goes straight to acct-b`, async () => {
    assert.equal(intake.INTAKE_MODELS.draftCard, 'sonnet', 'premise');
    assert.equal(intake.INTAKE_MODELS.reviewCard, 'fable', 'premise');
    const accountsDir = twoAccountPool('spo-250-intake-acct-');
    const { spawn, calls } = poolSpawn(STREAMS[name], { okResult: JSON.stringify(VALID_DRAFT) });
    const { query, spies } = await spyingQuery();

    const drafted = await intake.draftCard('add a badge', intakeDeps(accountsDir, spawn, query));
    assert.ok(spies[0].threw, `${name}: premise -- the SDK threw on the limited child's exit 1`);
    assert.equal(drafted.ok, true);
    assert.equal(drafted.cooldowns.length, 1);
    assert.equal(drafted.cooldowns[0].account, 'acct-a');
    assert.equal(drafted.cooldowns[0].limitScope, 'account', `${name}: the intake cooldown record carries the scope`);
    assert.equal(drafted.cooldowns[0].rateLimitType, EXPECTED_SCOPE[name].rateLimitType);

    await intake.reviewCard(VALID_DRAFT, intakeDeps(accountsDir, spawn, query));

    assert.deepEqual(calls, [['acct-a', 'sonnet'], ['acct-b', 'sonnet'], ['acct-b', 'fable']], `${name}: acct-a leased once`);
    assert.deepEqual(
      Object.keys(accounts.readState(accountsDir)['acct-a'].byModel).sort(),
      [...accounts.KNOWN_MODELS].sort()
    );
  });
}

test('#250 e2e intake: a Fable MODEL limit on reviewCard cools only (acct-a, fable) -- the following draftCard (sonnet) still leases acct-a', async () => {
  const accountsDir = twoAccountPool('spo-250-intake-model-');
  const { spawn, calls } = poolSpawn(STREAMS.fable, { onlyModel: 'fable', okResult: JSON.stringify(VALID_DRAFT) });
  const { query, spies } = await spyingQuery();

  const reviewed = await intake.reviewCard(VALID_DRAFT, intakeDeps(accountsDir, spawn, query));
  assert.ok(spies[0].threw, 'premise: the SDK threw on the limited child exit 1');
  assert.equal(reviewed.cooldowns.length, 1);
  assert.equal(reviewed.cooldowns[0].limitScope, 'model');
  assert.equal(reviewed.cooldowns[0].rateLimitType, 'seven_day_overage_included');
  assert.equal(reviewed.cooldowns[0].model, 'fable');

  const drafted = await intake.draftCard('add a badge', intakeDeps(accountsDir, spawn, query));
  assert.equal(drafted.ok, true);

  assert.deepEqual(calls, [['acct-a', 'fable'], ['acct-b', 'fable'], ['acct-a', 'sonnet']]);
  assert.deepEqual(Object.keys(accounts.readState(accountsDir)['acct-a'].byModel), ['fable']);
});

// ---- 4. markLimit's scope contract ---------------------------------------------------------------

test('#250 markLimit: account scope cools every known model PLUS the named one; model scope exactly the named one; omitted = the pre-#250 contract', () => {
  const now = Date.now();
  const cases = [
    // [opts, expected cooled models, expected event.limitScope]
    [{ model: 'haiku', limitScope: 'account', rateLimitType: 'five_hour' }, [...accounts.KNOWN_MODELS, 'haiku'], 'account'],
    [{ model: 'fable', limitScope: 'account', rateLimitType: 'seven_day' }, [...accounts.KNOWN_MODELS], 'account'],
    [{ model: 'fable', limitScope: 'model', rateLimitType: 'seven_day_overage_included' }, ['fable'], 'model'],
    [{ limitScope: 'model' }, [...accounts.KNOWN_MODELS], 'account'], // no model named: fail-safe
    [{ model: 'fable' }, ['fable'], 'model'], // pre-#250 direct call, unchanged
    [{}, [...accounts.KNOWN_MODELS], 'account'], // pre-#250 no-model path, unchanged
    [{ model: 'fable', limitScope: 'model', rateLimitType: '' }, ['fable'], 'model'], // '' is normalised to null
  ];
  for (const [opts, expected, scope] of cases) {
    const dir = writePoolDir(mkTmp('spo-250-mark-'), [{ name: 'acct-a' }]);
    const event = accounts.markLimit(dir, 'acct-a', 'usage', now, opts);
    const label = JSON.stringify(opts);
    assert.deepEqual(Object.keys(accounts.readState(dir)['acct-a'].byModel).sort(), [...expected].sort(), label);
    assert.deepEqual([...event.models].sort(), [...expected].sort(), label);
    assert.equal(event.limitScope, scope, label);
    assert.equal(event.rateLimitType, opts.rateLimitType || null, label);
    assert.equal(event.model, opts.model || null, label);
  }
});

// ---- 5. the callers' fail-safe: a limit result that carries NO scope ---------------------------
//
// consumeQueryStream always states a scope, so the callers' own fail-safe
// (accounts.limitScopeOfResult) is only reachable from a result some other producer built. The
// seam: invokeClaudeReal reads consumeQueryStream off sdk-call.js's exports on every call, so it
// is wrapped here to delete `limitScope` from an otherwise real classification. The stream is the
// recorded FABLE limit -- a MODEL limit -- so only the fail-safe can make the cooling account-wide:
// a caller that passed `result.limitScope` raw would hand markLimit `undefined`, i.e. the pre-#250
// one-model contract.
const sdkCall = require('../orchestrator/steps/sdk-call');

async function withScopeStripped(fn) {
  const original = sdkCall.consumeQueryStream;
  sdkCall.consumeQueryStream = async (...args) => {
    const out = await original(...args);
    delete out.limitScope;
    return out;
  };
  try {
    return await fn();
  } finally {
    sdkCall.consumeQueryStream = original;
  }
}

test('#250 L1 callLlmStep: a kind:limit usage result with NO limitScope fails safe to account-wide cooling', async () => {
  const accountsDir = twoAccountPool('spo-250-l1-');
  const { spawn, calls } = poolSpawn(STREAMS.fable, { onlyModel: 'fable' });
  const { query, spies } = await spyingQuery();
  const first = overrideCtx(accountsDir, 'fable');

  await withScopeStripped(() => callLlmStep(first.ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query })));

  assert.ok(spies[0].threw, 'premise: the SDK threw on the limited child exit 1');
  assert.deepEqual(calls, [['acct-a', 'fable'], ['acct-b', 'fable']], 'premise: the limit was classified and rotated');
  assert.deepEqual(
    Object.keys(accounts.readState(accountsDir)['acct-a'].byModel).sort(),
    [...accounts.KNOWN_MODELS].sort(),
    'no scope on the result -> every model cools (fail-safe), not just fable'
  );
  const [event] = cooldownEvents(first.taskDir);
  assert.equal(event.limitScope, 'account');
  assert.equal(event.rateLimitType, 'seven_day_overage_included', 'the rest of the classification still reached the journal');
});

test('#250 L1 intake: a kind:limit usage result with NO limitScope fails safe to account-wide cooling', async () => {
  const accountsDir = twoAccountPool('spo-250-l1-intake-');
  const { spawn, calls } = poolSpawn(STREAMS.fable, { onlyModel: 'fable', okResult: JSON.stringify(VALID_DRAFT) });
  const { query } = await spyingQuery();

  const reviewed = await withScopeStripped(() => intake.reviewCard(VALID_DRAFT, intakeDeps(accountsDir, spawn, query)));

  assert.deepEqual(calls.slice(0, 2), [['acct-a', 'fable'], ['acct-b', 'fable']], 'premise: the limit was classified and rotated');
  assert.equal(reviewed.cooldowns[0].limitScope, 'account');
  assert.deepEqual(
    Object.keys(accounts.readState(accountsDir)['acct-a'].byModel).sort(),
    [...accounts.KNOWN_MODELS].sort()
  );
});
