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

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { callLlmStep, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const accounts = require('../orchestrator/accounts');
const { leaseFilePath } = require('../orchestrator/account-lease');
const { writePoolDir } = require('./helpers');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

  const before = Date.now();
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
  // 429 -> limitKind 'usage' -> R1's PROBE tier (1h) on a first-ever hit for this account, not
  // the escalated 5h tier and not the 5-minute overloaded tier.
  assert.ok(
    state['acct-a'].cooldownUntil >= before + accounts.USAGE_PROBE_COOLDOWN_MS,
    'a first 429 must cool the account for the 1-hour probe tier'
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
  // Simulates the exact scenario R1 exists for: acct-a probed an hour ago (lastUsageLimitAt),
  // its cooldown has already elapsed (cooldownUntil in the past, so pick() considers it healthy
  // again), and it immediately re-limits -- real wall-clock "now" (via callLlmStep -> pick() ->
  // markLimit, none of which take an injectable clock) is used throughout, so the seeded
  // lastUsageLimitAt is set relative to Date.now() rather than to a fixed test constant.
  const taskDir = mkTmp('spo-rotate-escalate-taskdir-');
  const accountsDir = mkTmp('spo-rotate-escalate-accts-');
  writeRegistry(accountsDir, [{ name: 'acct-a', configDir: null, enabled: true }]);

  const now = Date.now();
  const lastUsageLimitAt = now - 5000; // well within ESCALATION_WINDOW_MS
  accounts.writeState(accountsDir, {
    'acct-a': { cooldownUntil: now - 1000, lastUsageLimitAt, usageLimitStreak: 1 }, // already expired -> pick()-able
  });

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't2', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan it' } } },
  });

  const spawnSync = () => ({
    status: 1,
    stdout: JSON.stringify(realShapedPayload({ is_error: true, api_error_status: 429, result: 'rate limited again' })),
    stderr: '',
    signal: null,
  });

  await assert.rejects(() => callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync }), ParkSignal);

  const state = accounts.readState(accountsDir);
  assert.ok(state['acct-a'].cooldownUntil >= now + accounts.USAGE_ESCALATED_COOLDOWN_MS, 'must escalate to the 5h tier');
  assert.equal(state['acct-a'].usageLimitStreak, 2);

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

  const before = Date.now();
  let call = 0;
  const spawnSync = () => {
    call += 1;
    if (call === 1) {
      return {
        status: 1,
        stdout: JSON.stringify(
          realShapedPayload({ is_error: true, api_error_status: 529, terminal_reason: 'overloaded_error', result: 'overloaded' })
        ),
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
  const cooldownMsWritten = state['acct-a'].cooldownUntil - before;
  assert.ok(
    cooldownMsWritten <= accounts.OVERLOADED_COOLDOWN_MS + 5000,
    `a 529 must cool the account for the short 5-minute overloaded tier, not the 5-hour usage tier (got ~${cooldownMsWritten}ms)`
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

  function cardShapedReply(resultObj, overrides = {}) {
    return realShapedPayload({
      result: JSON.stringify(resultObj),
      modelUsage: { 'claude-fable-5': { costUSD: 0.002 } },
      ...overrides,
    });
  }

  let call = 0;
  const spawnSync = () => {
    call += 1;
    if (call === 1) {
      return {
        status: 1,
        stdout: JSON.stringify(
          cardShapedReply(
            {},
            { is_error: true, api_error_status: 529, terminal_reason: 'overloaded_error', result: 'overloaded' }
          )
        ),
        stderr: '',
        signal: null,
      };
    }
    return {
      status: 0,
      stdout: JSON.stringify(
        cardShapedReply({
          plan_markdown: '# Plan\n\nAdd a widget.\n',
          invariants_markdown: '# Invariants\n\nNone -- new ground.\n',
          invariant_ids: [],
          check_commands: ['npm run typecheck'],
        })
      ),
      stderr: '',
      signal: null,
    };
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync });

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

  // R6 (F3): exhausting the pool inside the loop means callLlmStep's own ParkSignal, not pick()'s
  // -- the maintainer must still see a wall-clock retry time in its detail, not just an account
  // count and a stale lastResult.
  let caught = null;
  try {
    await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync });
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

test('an empty pool (no accounts registered at all) -> ParkSignal("no-accounts-registered") without spawning', async () => {
  const taskDir = mkTmp('spo-rotate-nopool-taskdir-');
  const accountsDir = mkTmp('spo-rotate-nopool-accts-'); // created by mkTmp, but never populated

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

  const spawnSync = () => ({ status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null });
  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync });

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

  // A spawnSync that throws synchronously reaches invokeClaudeReal as an unhandled rejection
  // (steps/llm.js's own header: "only a programming error throws"), which propagates straight
  // through callWithDeadline (it only ever catches DeadlineError) and out of callLlmStep's own
  // try block -- exactly the path the spec's item 9 asks to be covered, and exactly why the
  // release has to live in a `finally`, not just after a normal return.
  const spawnSync = () => {
    throw new Error('boom -- a real programming-error-shaped throw, not a normal step failure');
  };

  await assert.rejects(() => callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync }), /boom/);

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
  const spawnSync = (command, args, opts) => {
    seenConfigDirs.push(opts.env.CLAUDE_CONFIG_DIR);
    return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync });

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
  const spawnSync = () => {
    called = true;
    return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
  };

  let caught = null;
  try {
    await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync, leaseNow, leaseSleep });
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
  const spawnSync = (command, args, opts) => {
    const name = path.basename(opts.env.CLAUDE_CONFIG_DIR);
    const file = leaseFilePath(accountsDir, name);
    leaseSeenDuringSpawn = fs.existsSync(file);
    holderDuringSpawn = leaseSeenDuringSpawn ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync });

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
  const spawnSync = (command, args, opts) => {
    const name = path.basename(opts.env.CLAUDE_CONFIG_DIR);
    observed.push({
      name,
      ownLeaseHeld: fs.existsSync(leaseFilePath(accountsDir, name)),
      otherLeaseHeld: fs.existsSync(leaseFilePath(accountsDir, name === 'acct-a' ? 'acct-b' : 'acct-a')),
    });
    call += 1;
    if (call === 1) {
      return {
        status: 1,
        stdout: JSON.stringify(realShapedPayload({ is_error: true, api_error_status: 429, result: 'usage limit' })),
        stderr: '',
        signal: null,
      };
    }
    return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
  };

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', { spawnSync });
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
