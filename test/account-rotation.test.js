'use strict';
// Integration test for the real-mode account-rotation retry loop (orchestrator/state-
// machine.js's callLlmStep): a {kind: 'limit'} result cools that account down and retries on
// the next healthy one, bounded to one pass over the registry; anything else fails without
// rotating. No real `claude` CLI call -- the spawn is injected all the way through
// callLlmStep -> runLlm -> invokeClaudeReal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { callLlmStep, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const accounts = require('../orchestrator/accounts');
const { leaseFilePath } = require('../orchestrator/account-lease');
const { writePoolDir, mkTmp, fakeSpawnedChild, fakeExecDeps } = require('./helpers');


// Discovery-based pool: one subdirectory per account (see orchestrator/accounts.js). `list` is
// an array of {name, configDir, enabled} the way the old accounts.json shaped it -- this
// adapter keeps every call site below unchanged, translating enabled: false into the
// `disabled` marker file writePoolDir understands.
function writeRegistry(dir, list) {
  writePoolDir(
    dir,
    list.map((a) => ({ name: a.name, disabled: a.enabled === false }))
  );
}

// Card #239 chantier, action A5b-2 (Job 3): migrated off `deps.spawnSync`/the old
// `claude -p`/`--output-format json` transport onto `deps.spawn` (test/helpers.js's
// `fakeSpawnedChild`) and `deps.resolveClaudeCodeExecutable`/`deps.isNoRealSpawnEnabled`
// (`fakeExecDeps`) -- same seam as test/llm-real-card.test.js. `initMessage`/`resultMessage` are
// this file's equivalent of the old flat `realShapedPayload()`: a `system`/`init` stream-json
// message reporting a session id, then a `result` message. Every `spawn(command, args, opts)`
// fake below can still inspect `opts.env.CLAUDE_CONFIG_DIR` exactly as the old `spawnSync(command,
// args, opts)` fakes did -- `sdk-call.js`'s `spawnClaudeCodeProcess` calls the injected `deps.spawn`
// with the SAME `{cwd, env, signal, ...}` third argument shape the old transport's spawnSync got.
function initMessage(sessionId = 'sess-abc') {
  return { type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}

function resultMessage(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: 'sess-abc',
    modelUsage: { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5 } },
    result: 'ok',
    terminal_reason: 'success',
    api_error_status: null,
    ...overrides,
  };
}

// cardShapedResult(resultObj, overrides) -- the real `kind: "card"` path's reply needs `result` to
// be the JSON-ENCODED payload string (runLlm's `JSON.parse(raw.result)`), not the bare string
// literal `resultMessage()`'s own default carries -- mirrors test/llm-real-card.test.js's own
// `resultMessage(resultObj, overrides)` helper, kept as a separate name here since this file also
// keeps the flat `resultMessage(overrides)` shape for its many non-card (`ctx.task.llm.<step>`
// override path) tests above.
function cardShapedResult(resultObj, overrides = {}) {
  return resultMessage({
    result: JSON.stringify(resultObj),
    modelUsage: { 'claude-fable-5': { inputTokens: 20, outputTokens: 8 } },
    ...overrides,
  });
}

function makeCtx({ taskDir, accountsDir, task }) {
  const ctx = buildCtx('t1', task, taskDir, {
    shadowMode: false,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
    // VERIFIER: never let these tests inherit config.js's REAL production bound (5 min / 1 s).
    // Every test here that reaches the lease wait does so only on a regression -- and with the
    // production bound a regression stalls the suite for five wall-clock minutes per test
    // instead of failing. Measured: disabling the lease exclusion made `node --test
    // test/*.test.js` hang past 90 s with no output rather than report a failure.
    accountLeaseWaitMs: 2000,
    accountLeasePollMs: 25,
  });
  return ctx;
}

test('429 (usage limit) on the first account cools it for the 1h probe tier and rotates to the second, which succeeds', async () => {
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
  const spawn = () => {
    call += 1;
    if (call === 1) {
      return fakeSpawnedChild([initMessage(), resultMessage({ is_error: true, api_error_status: 429, result: 'rate limited' })]);
    }
    return fakeSpawnedChild([initMessage(), resultMessage()]);
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));

  assert.equal(call, 2);
  assert.equal(result.ok, true);
  assert.equal(ctx.account.name, 'acct-b');

  const state = accounts.readState(accountsDir);
  assert.ok(state['acct-a'], 'acct-a should be cooling');
  // FACT, NOT MARGIN: this used to compare `state['acct-a'].cooldownUntil` against two raw
  // Date.now() reads taken in THIS test (`before`, and a fresh one here) -- but `markLimit` takes no
  // injectable clock through `callLlmStep` (production passes it exactly three args, so its `now`
  // parameter defaults to markLimit's own real Date.now() read). `pick()`'s clock IS injectable as
  // `deps.leaseNow` -- but that would not help pin this value: markLimit's `now` is a separate
  // Date.now() read that callLlmStep gives the test no way to inject, so nothing forwarded through
  // `deps.leaseNow` ever reaches it. (True side note: a frozen `deps.leaseNow` would also drive
  // leaseHealthyAccount's lease-wait clock, `elapsedNowMs`; it doesn't matter here because this
  // test's pick() finds an unleased healthy account immediately both times, so the wait is never
  // entered.) Nothing callLlmStep's deps accept reaches markLimit's `now`; pinning it could be done
  // with, e.g., a global Date stub (node:test mock.timers) or swapping `accounts.markLimit` on the
  // shared module object -- both work, and neither is needed, because comparing the two fields
  // production wrote is exact without any clock stub. On this WSL2 box, where Date.now() steps
  // backward ~2.85s every ~29.4s (measured in card #182; monotonic-clock.js's header carries the
  // independent -2515ms measurement), markLimit's internal read can land strictly BEFORE the test's
  // own `before` read even though it happened chronologically after it, making the old `>=`
  // comparison fail for a reason that has nothing to do with which tier was chosen.
  // computeLimitUpdate sets both `cooldownUntil` and `lastUsageLimitAt` from the SAME single
  // internal `now` snapshot (markLimit persists them), so comparing the two fields PRODUCTION wrote
  // against each other establishes the identical "1-hour probe tier, not the 5-hour escalated one" fact
  // exactly, with no clock read on the test's own side at all.
  // card #167: the cooldown lands under the model this step actually ran on -- the task's
  // `llm.PLAN.model` override ('fable'), which is what steps/llm.js's resolveCallModel resolves
  // and therefore what callLlmStep leased and cooled. Reading it from `byModel.fable` rather
  // than from a flat field is the whole point: acct-a's SONNET quota is untouched below.
  const fable = state['acct-a'].byModel.fable;
  assert.equal(
    typeof fable.lastUsageLimitAt,
    'number',
    'a first usage hit must record lastUsageLimitAt'
  );
  assert.equal(
    fable.cooldownUntil,
    fable.lastUsageLimitAt + accounts.USAGE_PROBE_COOLDOWN_MS,
    'a first 429 must cool the account for exactly the 1-hour probe tier, anchored to its own lastUsageLimitAt'
  );
  assert.deepEqual(
    Object.keys(state['acct-a'].byModel),
    ['fable'],
    'card #167: a fable limit must not cool this account for any other model'
  );
  assert.ok(!state['acct-b'], 'acct-b should not be cooling');

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const cooldownEvent = journalLines.find((e) => e.event === 'account-cooldown');
  assert.ok(cooldownEvent, 'expected an account-cooldown journal event');
  assert.equal(cooldownEvent.account, 'acct-a');
  assert.equal(cooldownEvent.limitKind, 'usage');
  assert.equal(cooldownEvent.cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);
  assert.equal(cooldownEvent.escalated, false);
});

test('429 (usage limit) through callLlmStep on an account whose PROBE already expired inside the escalation window -> the 5h escalated tier', async () => {
  // Simulates the scenario R1 exists for: acct-a's last usage hit (lastUsageLimitAt, seeded 5 s
  // ago -- well inside the 2h escalation window) is recent, its cooldown has already elapsed
  // (cooldownUntil seeded in the past, so pick() considers it healthy again), and it immediately
  // re-limits. pick()'s clock is injectable as deps.leaseNow, but markLimit's is not injectable
  // through callLlmStep -- and markLimit's own real Date.now() read is what decides escalation
  // (computeLimitUpdate compares it against the seeded lastUsageLimitAt), and that same read is
  // the value written as lastUsageLimitAt and as cooldownUntil's base, regardless of anything
  // callLlmStep forwards. That is why real wall-clock "now" is used throughout, so the seeded
  // lastUsageLimitAt is set relative to Date.now() rather than to a fixed test constant. (True
  // side note: an injected deps.leaseNow would also drive leaseHealthyAccount's lease-wait clock,
  // elapsedNowMs; irrelevant here, since this test's one unleased account is picked on the very
  // first try, so the wait is never entered.)
  const taskDir = mkTmp('spo-rotate-escalate-taskdir-');
  const accountsDir = mkTmp('spo-rotate-escalate-accts-');
  writeRegistry(accountsDir, [{ name: 'acct-a', configDir: null, enabled: true }]);

  const now = Date.now();
  const lastUsageLimitAt = now - 5000; // well within ESCALATION_WINDOW_MS (7,200,000ms) -- safe margin
  // cooldownUntil is 1h in the past, not just-expired: this WSL2 box's Date.now() steps backward
  // ~2.85s every ~29.4s (measured in card #182), so a `now - 1000` margin here is not safe -- a step
  // landing between this read and pick()'s own could make pick() still read acct-a as cooling,
  // throw AllAccountsCoolingError before markLimit ever runs, and fail this test's assertions below
  // for a reason that has nothing to do with escalation.
  // card #167: seeded under byModel.fable -- the model this task's `llm.PLAN` override runs on,
  // and therefore the quota whose escalation history decides the tier below. A flat pre-#167
  // entry here would carry no model attribution at all and would (correctly) read as "nothing on
  // record", probing at 1h instead of escalating -- see accounts.js's own header.
  accounts.writeState(accountsDir, {
    'acct-a': { byModel: { fable: { cooldownUntil: now - 3600_000, lastUsageLimitAt, usageLimitStreak: 1 } } }, // already expired -> pick()-able
  });

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't2', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  const spawn = () => fakeSpawnedChild([initMessage(), resultMessage({ is_error: true, api_error_status: 429, result: 'rate limited again' })]);

  await assert.rejects(() => callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn })), ParkSignal);

  const state = accounts.readState(accountsDir);
  // Same fix as the probe-tier test above: an exact relationship between the two fields
  // markLimit's OWN internal `now` snapshot wrote (accounts.js's computeLimitUpdate,
  // cooldownUntil = now + ms, lastUsageLimitAt = now), instead of comparing against this test's
  // own `now` -- which was captured before the call and is not what markLimit actually read.
  assert.equal(
    state['acct-a'].byModel.fable.cooldownUntil,
    state['acct-a'].byModel.fable.lastUsageLimitAt + accounts.USAGE_ESCALATED_COOLDOWN_MS,
    'must escalate to exactly the 5h tier, anchored to its own lastUsageLimitAt'
  );
  assert.equal(state['acct-a'].byModel.fable.usageLimitStreak, 2);

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const cooldownEvent = journalLines.find((e) => e.event === 'account-cooldown');
  assert.equal(cooldownEvent.escalated, true);
  assert.equal(cooldownEvent.cooldownMs, accounts.USAGE_ESCALATED_COOLDOWN_MS);
});

test('529 (overloaded) on the first account cools it for 5 minutes only, and rotates to the second, which succeeds', async () => {
  const taskDir = mkTmp('spo-rotate-overloaded-taskdir-');
  const accountsDir = mkTmp('spo-rotate-overloaded-accts-');
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
  const spawn = () => {
    call += 1;
    if (call === 1) {
      return fakeSpawnedChild([
        initMessage(),
        resultMessage({ is_error: true, api_error_status: 529, terminal_reason: 'overloaded_error', result: 'overloaded' }),
      ]);
    }
    return fakeSpawnedChild([initMessage(), resultMessage()]);
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));

  assert.equal(call, 2);
  assert.equal(result.ok, true);
  assert.equal(ctx.account.name, 'acct-b');

  const state = accounts.readState(accountsDir);
  assert.ok(state['acct-a'], 'acct-a should be cooling');
  // The `cooldownMsWritten = state['acct-a'].cooldownUntil - before` margin this replaced compared
  // a value PRODUCTION wrote (from markLimit's own `now` parameter, which callLlmStep never forwards
  // a value for, so it defaults to a real Date.now() read) against a
  // `before` read in THIS test -- unreliable on this WSL2 box, whose Date.now() steps backward
  // ~2.85s every ~29.4s (measured in card #182; monotonic-clock.js's header carries the independent
  // -2515ms measurement). Unlike the usage/probe path, the overloaded branch of computeLimitUpdate
  // (accounts.js:470-471, 480-481) writes no lastUsageLimitAt to anchor an exact equality against, so
  // there is no clock-free field on `state['acct-a']` alone to compare here. `cooldownEvent.cooldownMs`
  // below pins only the JOURNAL EVENT, not the persisted state -- the field `pick()` (accounts.js:364-365)
  // actually consults to decide account health is `state['acct-a'].cooldownUntil`, on disk, which
  // `cooldownMs` says nothing about on its own. What pins THAT, with no clock read at all:
  // computeLimitUpdate writes both `cooldownUntil` and the event's own `cooldownUntil` field
  // (accounts.js:477, 496) from the same `const cooldownUntil`, so asserting the persisted value
  // equals the journalled event's `cooldownUntil` is exact and clock-free.
  assert.ok(!state['acct-b'], 'acct-b should not be cooling');

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const cooldownEvent = journalLines.find((e) => e.event === 'account-cooldown');
  assert.ok(cooldownEvent, 'expected an account-cooldown journal event');
  assert.equal(cooldownEvent.account, 'acct-a');
  assert.equal(
    state['acct-a'].byModel.fable.cooldownUntil,
    cooldownEvent.cooldownUntil,
    'the persisted cooldown must be exactly the one the journalled event reported'
  );
  assert.equal(cooldownEvent.model, 'fable', 'card #167: the event names the model that was cooled');
  assert.equal(cooldownEvent.cooldownMs, accounts.OVERLOADED_COOLDOWN_MS);
});

// R4 (F4): every test above drives callLlmStep through ctx.task.llm.<step>, the "legacy interim
// path" runLlm documents as kept only for backward compatibility with this suite. The daemon's
// REAL path for an actual card is the other branch -- step-contracts.js + prompt-template.js,
// landing on steps/llm.js's `if (!raw.ok) return raw;` -- and until now nothing exercised limit
// classification/rotation through it at all. This is that one test: a real `kind: 'card'` PLAN
// task, no llm.PLAN override, first account 529s, rotation still finds the second.
test('529 (overloaded) through the REAL kind:"card" path (no llm.<step> override) still rotates and cools for the 5-minute tier', async () => {
  const taskDir = mkTmp('spo-rotate-cardpath-taskdir-');
  const accountsDir = mkTmp('spo-rotate-cardpath-accts-');
  writeRegistry(accountsDir, [
    { name: 'acct-a', configDir: null, enabled: true },
    { name: 'acct-b', configDir: null, enabled: true },
  ]);

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: {
      id: 't-card',
      kind: 'card',
      issue: 501,
      title: 'Add a widget',
      criterion: 'the widget renders',
      worktreePath: '/tmp/worktree-501',
      size: 'S',
    },
  });

  let call = 0;
  const spawn = () => {
    call += 1;
    if (call === 1) {
      return fakeSpawnedChild([
        initMessage(),
        // is_error on this subtype carries no `result` payload string to JSON.parse -- see
        // cardShapedResult's own header; a 529 failure never reaches runLlm's JSON.parse at all
        // (raw.ok is false first), so passing `{}` through the JSON-encode here is harmless.
        cardShapedResult({}, { is_error: true, api_error_status: 529, terminal_reason: 'overloaded_error', result: 'overloaded' }),
      ]);
    }
    return fakeSpawnedChild([
      initMessage(),
      cardShapedResult({
        plan_markdown: '# Plan\n\nAdd a widget.\n',
        invariants_markdown: '# Invariants\n\nNone -- new ground.\n',
        invariant_ids: [],
        check_commands: ['npm run typecheck'],
      }),
    ]);
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));

  assert.equal(call, 2, 'first account 529s, second serves the real reply');
  assert.equal(result.ok, true);
  assert.equal(result.plan_markdown, '# Plan\n\nAdd a widget.\n');
  assert.equal(ctx.account.name, 'acct-b');

  const state = accounts.readState(accountsDir);
  assert.ok(state['acct-a'], 'acct-a should be cooling');
  assert.ok(!state['acct-b'], 'acct-b should not be cooling');

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const cooldownEvent = journalLines.find((e) => e.event === 'account-cooldown');
  assert.ok(cooldownEvent, 'expected an account-cooldown journal event');
  assert.equal(cooldownEvent.limitKind, 'overloaded');
  assert.equal(cooldownEvent.cooldownMs, accounts.OVERLOADED_COOLDOWN_MS);
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
  const spawn = () => {
    call += 1;
    return fakeSpawnedChild([initMessage(), resultMessage({ is_error: true, api_error_status: 400, result: 'bad schema' })]);
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));

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
  const spawn = () => {
    call += 1;
    return fakeSpawnedChild([initMessage(), resultMessage({ is_error: true, api_error_status: 429, result: 'rate limited' })]);
  };

  // R6 (F3): exhausting the pool inside the loop means callLlmStep's own ParkSignal, not pick()'s
  // -- the maintainer must still see a wall-clock retry time in its detail, not just an account
  // count and a stale lastResult.
  let caught = null;
  try {
    await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ParkSignal);
  assert.equal(caught.reason, 'all-accounts-cooling-after-retry');
  assert.equal(typeof caught.detail.cooldownUntilIso, 'string');
  assert.doesNotThrow(() => new Date(caught.detail.cooldownUntilIso).toISOString());
  assert.equal(call, 2, 'exactly one attempt per enabled account, never a third');

  const state = accounts.readState(accountsDir);
  assert.ok(state['acct-a']);
  assert.ok(state['acct-b']);
});

test('starting with every account already cooling -> ParkSignal without spawning at all', async () => {
  const taskDir = mkTmp('spo-rotate-precool-taskdir-');
  const accountsDir = mkTmp('spo-rotate-precool-accts-');
  writeRegistry(accountsDir, [{ name: 'acct-a', configDir: null, enabled: true }]);
  accounts.markLimit(accountsDir, 'acct-a', 'overloaded');

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  let called = false;
  const spawn = () => {
    called = true;
    return fakeSpawnedChild([initMessage(), resultMessage()]);
  };

  let caught = null;
  try {
    await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ParkSignal);
  assert.match(caught.reason, /all-accounts-cooling-until-/);
  assert.equal(called, false, 'must never spawn once pick() already finds nothing healthy');
});

test('an empty pool (no accounts registered at all) -> ParkSignal("no-accounts-registered") without spawning', async () => {
  const taskDir = mkTmp('spo-rotate-nopool-taskdir-');
  const accountsDir = mkTmp('spo-rotate-nopool-accts-'); // created by mkTmp, but never populated

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  let called = false;
  const spawn = () => {
    called = true;
    return fakeSpawnedChild([initMessage(), resultMessage()]);
  };

  let caught = null;
  try {
    await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ParkSignal);
  assert.equal(caught.reason, 'no-accounts-registered');
  assert.equal(called, false, 'must never spawn when the pool has nothing registered');
});

// ---- action 6.2: callLlmStep's own per-step lease wiring -----------------------------------

test('callLlmStep: the leased account is released once the call succeeds', async () => {
  const taskDir = mkTmp('spo-rotate-lease-release-ok-taskdir-');
  const accountsDir = mkTmp('spo-rotate-lease-release-ok-accts-');
  writeRegistry(accountsDir, [{ name: 'acct-a', configDir: null, enabled: true }]);

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  const spawn = () => fakeSpawnedChild([initMessage(), resultMessage()]);
  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));

  assert.equal(result.ok, true);
  assert.equal(
    fs.existsSync(leaseFilePath(accountsDir, 'acct-a')),
    false,
    'the lease must be released the instant the step it guarded is done -- per-step, not held past it'
  );
});

test('callLlmStep: the leased account is released even when the step THROWS', async () => {
  const taskDir = mkTmp('spo-rotate-lease-release-throw-taskdir-');
  const accountsDir = mkTmp('spo-rotate-lease-release-throw-accts-');
  writeRegistry(accountsDir, [{ name: 'acct-a', configDir: null, enabled: true }]);

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  // Card #239 chantier, action A5b-2 (Job 3): a `deps.spawn` that throws synchronously no longer
  // reaches callLlmStep as an uncaught exception on this transport -- MEASURED (this action):
  // `spawnClaudeCodeProcess` (sdk-call.js) calls the injected `deps.spawn` synchronously during
  // `query()`'s own construction, and a throw there DOES propagate out of `query()` itself (that
  // file's own header), but `invokeClaudeReal`'s `stream = queryFn({prompt, options})` call site
  // (llm.js) wraps that in an UNCONDITIONAL try/catch that turns ANY throw there into an ordinary
  // `{ok:false, kind:'error', error:'llm.js: query() failed to start: ...'}` step failure -- never
  // a rethrow. So a throwing `deps.spawn` can no longer stand in for "a real programming-error-
  // shaped throw" the way the old transport's throwing `deps.spawnSync` did (a real synchronous
  // spawnSync call had no such catch around it).
  //
  // The equivalent seam that DOES still propagate uncaught: `deps.buildQueryOptions`, called from
  // `invokeClaudeReal`'s OWN try/catch (llm.js) which only ever swallows THREE named error classes
  // (OauthTokenUnreadableError/ClaudeExecutableNotFoundError/JsonSchemaParseError) and rethrows
  // anything else -- exactly the "only a programming error throws" contract this test exists to
  // exercise, unchanged by the cutover, just moved one seam over. A bare Error from
  // `deps.buildQueryOptions` propagates through callLlmStep exactly like the old throwing spawnSync
  // did, exercising the identical release-in-a-`finally` path this test's own title names.
  const buildQueryOptions = () => {
    throw new Error('boom -- a real programming-error-shaped throw, not a normal step failure');
  };

  await assert.rejects(() => callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ buildQueryOptions })), /boom/);

  assert.equal(
    fs.existsSync(leaseFilePath(accountsDir, 'acct-a')),
    false,
    'the lease must still be released even though the call it guarded threw'
  );
});

test('callLlmStep: an account already leased by another live process is skipped -- rotation lands on the other healthy account without ever calling markLimit', async () => {
  const taskDir = mkTmp('spo-rotate-lease-skip-taskdir-');
  const accountsDir = mkTmp('spo-rotate-lease-skip-accts-');
  writeRegistry(accountsDir, [
    { name: 'acct-a', configDir: null, enabled: true },
    { name: 'acct-b', configDir: null, enabled: true },
  ]);
  // Simulate a sibling worker mid-step on acct-a: a lease file naming a pid that really is
  // alive (this test process's own pid answers process.kill(pid, 0) truthfully).
  fs.writeFileSync(leaseFilePath(accountsDir, 'acct-a'), JSON.stringify({ pid: process.pid, startedAt: 'sibling-mid-step' }));

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  const seenConfigDirs = [];
  const spawn = (command, args, opts) => {
    seenConfigDirs.push(opts.env.CLAUDE_CONFIG_DIR);
    return fakeSpawnedChild([initMessage(), resultMessage()]);
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));

  assert.equal(result.ok, true);
  assert.equal(ctx.account.name, 'acct-b', 'acct-a is leased by a live sibling -- must land on acct-b, never call it');
  assert.equal(seenConfigDirs.length, 1);
  assert.ok(seenConfigDirs[0].endsWith('acct-b'));

  const state = accounts.readState(accountsDir);
  assert.deepEqual(state, {}, 'a leased-but-not-cooling account must never be cooled down -- nothing here was a limit');
  // The sibling's simulated lease is untouched -- callLlmStep must never have tried to release
  // a lease it does not own.
  assert.ok(fs.existsSync(leaseFilePath(accountsDir, 'acct-a')));
});

test('callLlmStep: every healthy account leased -> waits (injected clock/sleep, no real delay), then parks all-accounts-leased', async () => {
  const taskDir = mkTmp('spo-rotate-lease-allleased-taskdir-');
  const accountsDir = mkTmp('spo-rotate-lease-allleased-accts-');
  writeRegistry(accountsDir, [{ name: 'acct-a', configDir: null, enabled: true }]);
  fs.writeFileSync(leaseFilePath(accountsDir, 'acct-a'), JSON.stringify({ pid: process.pid, startedAt: 'sibling-mid-step' }));

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });
  // config.accountLeaseWaitMs/PollMs are real (5min/1s) production defaults -- this test drives
  // the wait entirely through the injected leaseSleep/leaseNow deps instead, per the spec's "an
  // injected clock/short bound, never a real multi-second sleep in the suite."
  let fakeNow = 0;
  const leaseNow = () => fakeNow;
  const leaseSleep = async (ms) => {
    fakeNow += ms;
  };

  let called = false;
  const spawn = () => {
    called = true;
    return fakeSpawnedChild([initMessage(), resultMessage()]);
  };

  let caught = null;
  try {
    await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn, leaseNow, leaseSleep }));
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof ParkSignal);
  assert.equal(caught.reason, 'all-accounts-leased');
  assert.equal(called, false, 'must never spawn once every healthy account is confirmed leased');
});

// ---- VERIFIER (action 6.2): the lease must be HELD ACROSS the `claude` spawn ----------------
//
// The tests above pin only that the lease is GONE once the step is over. That is satisfied just
// as well by releasing it the instant after acquiring it, before the spawn -- which is the exact
// bug this whole action exists to prevent (two processes handing the same CLAUDE_CONFIG_DIR to
// two concurrent `claude` calls), and which passed the entire suite green when introduced as a
// mutation. Measured, not reasoned: with the release moved above callWithDeadline, two real OS
// processes contending for a two-account pool both got `acct-a`, 3 runs out of 3.
//
// So: assert from INSIDE the spawn that the lease file for the account being handed to `claude`
// exists at that moment. This is the only assertion in the file that can tell "held across the
// call" apart from "acquired and dropped".
test('callLlmStep: the lease is HELD for the whole spawn -- the lease file exists at the moment CLAUDE_CONFIG_DIR is handed over', async () => {
  const taskDir = mkTmp('spo-rotate-lease-held-taskdir-');
  const accountsDir = mkTmp('spo-rotate-lease-held-accts-');
  writeRegistry(accountsDir, [{ name: 'acct-a', configDir: null, enabled: true }]);

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  let leaseSeenDuringSpawn = null;
  let holderDuringSpawn = null;
  const spawn = (command, args, opts) => {
    const name = path.basename(opts.env.CLAUDE_CONFIG_DIR);
    const file = leaseFilePath(accountsDir, name);
    leaseSeenDuringSpawn = fs.existsSync(file);
    holderDuringSpawn = leaseSeenDuringSpawn ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return fakeSpawnedChild([initMessage(), resultMessage()]);
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));

  assert.equal(result.ok, true);
  assert.equal(
    leaseSeenDuringSpawn,
    true,
    'the lease on the account being handed to `claude` must still be on disk DURING the call -- a lease released before the spawn protects nothing'
  );
  assert.equal(holderDuringSpawn.pid, process.pid, 'and it must be OUR lease, not some leftover');
  // ...and still released afterwards, so this test pins the whole window, not just its start.
  assert.equal(fs.existsSync(leaseFilePath(accountsDir, 'acct-a')), false);
});

// The same guarantee on the rotation path: the account cooled down by markLimit must have been
// leased at the moment its own call ran, and the SECOND account's lease must be held during the
// second call -- not the first account's leftover.
test('callLlmStep: on a limit rotation, each account is leased during its OWN call and released before the next', async () => {
  const taskDir = mkTmp('spo-rotate-lease-held-rot-taskdir-');
  const accountsDir = mkTmp('spo-rotate-lease-held-rot-accts-');
  writeRegistry(accountsDir, [
    { name: 'acct-a', configDir: null, enabled: true },
    { name: 'acct-b', configDir: null, enabled: true },
  ]);

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  const observed = [];
  let call = 0;
  const spawn = (command, args, opts) => {
    const name = path.basename(opts.env.CLAUDE_CONFIG_DIR);
    observed.push({
      name,
      ownLeaseHeld: fs.existsSync(leaseFilePath(accountsDir, name)),
      otherLeaseHeld: fs.existsSync(leaseFilePath(accountsDir, name === 'acct-a' ? 'acct-b' : 'acct-a')),
    });
    call += 1;
    if (call === 1) {
      return fakeSpawnedChild([initMessage(), resultMessage({ is_error: true, api_error_status: 429, result: 'usage limit' })]);
    }
    return fakeSpawnedChild([initMessage(), resultMessage()]);
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));
  assert.equal(result.ok, true);
  assert.deepEqual(
    observed,
    [
      { name: 'acct-a', ownLeaseHeld: true, otherLeaseHeld: false },
      { name: 'acct-b', ownLeaseHeld: true, otherLeaseHeld: false },
    ],
    'each call must run under its OWN account lease, with the previous account already released'
  );
  assert.deepEqual(fs.readdirSync(accountsDir).filter((f) => f.startsWith('.lease-')), [], 'no lease survives the step');
});
