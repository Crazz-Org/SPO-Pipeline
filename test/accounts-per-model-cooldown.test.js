'use strict';
// Card #167 -- a usage limit cools ONE (account, model) pair, not the whole account.
//
// The defect this pins the fix for, measured over the pool's own corpus and quoted in the card:
// every `kind:'limit'` classification ever observed was on Fable (fable 186 calls / 12 limited;
// sonnet 107 / 0; opus 30 / 0), and on one real account `IMPLEMENT/sonnet ok=true` at 07:55:26 sat
// seven minutes before `VALIDATE/fable` hit a limit at 08:02:42. Sonnet was demonstrably usable on
// an account the pre-#167 whole-account cooldown then marked unavailable for an hour or five --
// throwing away IMPLEMENT capacity that provably existed, on every routine Fable limit.
//
// What this file proves, in the order the card's own "Done means" lists it:
//   1. pick()/markLimit() are keyed by (account, model), and a legacy flat state.json entry never
//      throws in any of them.
//   2. countHealthyAccounts() answers "healthy FOR THIS MODEL" -- a fable-cooled account still
//      counts toward sonnet capacity.
//   3. NEUTRALITY on the seven historical `all-accounts-*` parks: when every account is cooling
//      on the very model the step needs, the park is byte-for-byte what it was before this
//      change, so #119 (PR #156)'s wait behaviour is untouched.
//   4. The positive case the card exists for: fable cooled, sonnet leased, no park.
// Plus the correspondence that makes the whole thing safe -- the model LEASED and COOLED is the
// model the `claude -p` call actually ran on, for both of runLlm's branches and for all three
// intake steps.
//
// NOT covered, deliberately, and stated here because it is the obvious next question: pool-WIDE
// exhaustion of one model. A per-model cooldown cannot conjure a Fable account when Fable is what
// is exhausted everywhere -- that is SPO-Pipeline#166's model-fallback DECISION, and test 3 below
// is the proof this card does not quietly pre-empt it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js. Must land before the orchestrator requires below.
require('./no-real-spawn');
const accounts = require('../orchestrator/accounts');
const { leaseHealthyAccount } = require('../orchestrator/account-lease');
const { callLlmStep, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { resolveCallModel } = require('../orchestrator/steps/llm');
const { STEP_CONTRACTS, resolveStepContract } = require('../orchestrator/step-contracts');
const intake = require('../orchestrator/intake');
const { writePoolDir, mkTmp } = require('./helpers');

const HOUR = 60 * 60 * 1000;

// One account entry cooling on exactly the models named, until `until`. Written as the literal
// on-disk shape rather than through markLimit on purpose: these tests are about what pick() and
// countHealthyAccounts() READ, and building the fixture with the writer would let a shared bug in
// the writer make every reader test pass for the wrong reason.
function coolingEntry(models, until) {
  return { byModel: Object.fromEntries(models.map((m) => [m, { cooldownUntil: until }])) };
}

function poolWith(prefix, names) {
  const dir = mkTmp(prefix);
  writePoolDir(dir, names.map((name) => ({ name })));
  return dir;
}

// ---- 1. pick(): the cooldown filter is per (account, model) ---------------------------------

test('card #167 pick(): an account cooling on fable is still picked for a sonnet request', () => {
  const dir = poolWith('spo-167-pick-', ['acct-a']);
  const now = 1_000_000;
  accounts.writeState(dir, { 'acct-a': coolingEntry(['fable'], now + HOUR) });

  assert.equal(accounts.pick(dir, now, { model: 'sonnet' }).name, 'acct-a');
  assert.equal(accounts.pick(dir, now, { model: 'opus' }).name, 'acct-a');
  assert.throws(() => accounts.pick(dir, now, { model: 'fable' }), accounts.AllAccountsCoolingError);
});

test('card #167 pick(): with NO model, the legacy union answer is preserved -- cooling on any model is cooling', () => {
  const dir = poolWith('spo-167-pick-union-', ['acct-a']);
  const now = 1_000_000;
  accounts.writeState(dir, { 'acct-a': coolingEntry(['fable'], now + HOUR) });

  // bin/spo and every pre-#167 caller asks this question, and must keep getting the old answer.
  assert.throws(() => accounts.pick(dir, now), accounts.AllAccountsCoolingError);
  // ...and the union becomes healthy only once the LAST model's cooldown expires, not the first.
  accounts.writeState(dir, {
    'acct-a': { byModel: { fable: { cooldownUntil: now + 1000 }, opus: { cooldownUntil: now + HOUR } } },
  });
  assert.throws(() => accounts.pick(dir, now + 2000), accounts.AllAccountsCoolingError);
  assert.equal(accounts.pick(dir, now + HOUR + 1).name, 'acct-a');
  // The per-model question, asked at the same instant, answers independently of that union.
  assert.equal(accounts.pick(dir, now + 2000, { model: 'fable' }).name, 'acct-a');
});

test('card #167 pick(): the error reason and detail are byte-for-byte unchanged by the model argument', () => {
  // park-loop.js's countRepeatedParks fingerprints a park as `reason + JSON.stringify(detail)`.
  // A new field in either -- even a helpful one naming the model -- would make every
  // `all-accounts-cooling-*` park look like a first-time park to the repeat-park warning, and
  // would move what #119 (PR #156) pinned. So: same reason, same detail keys, model or no model.
  const dir = poolWith('spo-167-pick-detail-', ['acct-a']);
  const now = 1_000_000;
  const until = now + HOUR;
  accounts.writeState(dir, { 'acct-a': coolingEntry(accounts.KNOWN_MODELS, until) });

  const caught = [];
  for (const opts of [{}, { model: 'fable' }]) {
    try {
      accounts.pick(dir, now, opts);
    } catch (err) {
      caught.push(err);
    }
  }
  assert.equal(caught.length, 2);
  assert.equal(caught[0].reason, `all-accounts-cooling-until-${new Date(until).toISOString()}`);
  assert.equal(caught[1].reason, caught[0].reason, 'the model argument must not change the park reason');
  assert.deepEqual(caught[1].detail, caught[0].detail, 'nor the park detail');
  assert.deepEqual(Object.keys(caught[0].detail).sort(), ['checkedAccounts', 'earliestCooldownUntil']);
});

test('card #167 pick(): a legacy pre-#167 flat entry never throws, and reads as no cooldown for any model', () => {
  // accounts.js's header decides this explicitly: a flat entry carries no attribution of its
  // cooldown to a model, so there is no honest way to keep honouring it. It is read as nothing on
  // record -- the same posture `rm state.json` has always had, and the file's own header already
  // calls it machine-owned and disposable.
  const dir = poolWith('spo-167-legacy-pick-', ['acct-a']);
  const now = 1_000_000;
  accounts.writeState(dir, { 'acct-a': { cooldownUntil: now + HOUR, lastUsageLimitAt: now, usageLimitStreak: 3 } });

  assert.equal(accounts.pick(dir, now).name, 'acct-a', 'union: healthy');
  assert.equal(accounts.pick(dir, now, { model: 'fable' }).name, 'acct-a', 'per-model: healthy');
  assert.equal(accounts.countHealthyAccounts(dir, now), 1);
  assert.equal(accounts.countHealthyAccounts(dir, now, 'fable'), 1);
});

// ---- 2. countHealthyAccounts(): the card's own "Done means" bullet 2 -------------------------

test('card #167 countHealthyAccounts(): a fable-cooled account still counts toward SONNET capacity', () => {
  const dir = poolWith('spo-167-count-', ['acct-a', 'acct-b']);
  const now = 1_000_000;
  accounts.writeState(dir, { 'acct-a': coolingEntry(['fable'], now + HOUR) });

  assert.equal(accounts.countHealthyAccounts(dir, now, 'sonnet'), 2, 'card #167: sonnet capacity is untouched by a fable limit');
  assert.equal(accounts.countHealthyAccounts(dir, now, 'opus'), 2);
  assert.equal(accounts.countHealthyAccounts(dir, now, 'fable'), 1, 'only fable lost an account');
  assert.equal(accounts.countHealthyAccounts(dir, now), 1, 'the bare union count is unchanged from pre-#167');
});

test('card #167 countHealthyAccounts(): a disabled account is still skipped for every model', () => {
  const dir = mkTmp('spo-167-count-disabled-');
  writePoolDir(dir, [{ name: 'acct-a', disabled: true }, { name: 'acct-b' }]);
  const now = 1_000_000;
  accounts.writeState(dir, { 'acct-b': coolingEntry(['fable'], now + HOUR) });

  assert.equal(accounts.countHealthyAccounts(dir, now, 'sonnet'), 1);
  assert.equal(accounts.countHealthyAccounts(dir, now, 'fable'), 0);
});

// ---- markLimit(): where the cooldown lands, and the fail-safe when no model is named ---------

test('card #167 markLimit(): a named model cools that model ALONE, and its escalation history is per-model', () => {
  const dir = poolWith('spo-167-mark-', ['acct-a']);
  const t0 = 1_000_000;

  const first = accounts.markLimit(dir, 'acct-a', 'usage', t0, { model: 'fable' });
  assert.equal(first.model, 'fable');
  assert.deepEqual(first.models, ['fable']);
  assert.equal(first.escalated, false);

  const state = accounts.readState(dir);
  assert.deepEqual(Object.keys(state['acct-a'].byModel), ['fable']);
  assert.equal(state['acct-a'].byModel.fable.cooldownUntil, t0 + accounts.USAGE_PROBE_COOLDOWN_MS);

  // A sonnet limit moments later is a FIRST hit for sonnet -- it must not inherit fable's armed
  // escalation window, or a single busy fable hour would put every other model straight onto the
  // 5h tier the first time it so much as blinked.
  const sonnet = accounts.markLimit(dir, 'acct-a', 'usage', t0 + 1000, { model: 'sonnet' });
  assert.equal(sonnet.escalated, false, 'sonnet has its own history; fable\'s does not arm it');
  assert.equal(sonnet.cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);

  // ...whereas a second FABLE hit inside the window does escalate, exactly as before #167.
  const fableAgain = accounts.markLimit(dir, 'acct-a', 'usage', t0 + 2000, { model: 'fable' });
  assert.equal(fableAgain.escalated, true);
  assert.equal(fableAgain.cooldownMs, accounts.USAGE_ESCALATED_COOLDOWN_MS);
  assert.equal(accounts.readState(dir)['acct-a'].byModel.fable.usageLimitStreak, 2);
  assert.equal(accounts.readState(dir)['acct-a'].byModel.sonnet.usageLimitStreak, 1, 'sonnet\'s streak is its own');
});

test('card #167 markLimit(): NO model named is the fail-safe -- every known model is cooled, i.e. the pre-#167 behaviour', () => {
  // Deliberately the over-cooling direction. Cooling nothing (or one sentinel pseudo-model) would
  // make a caller that forgot the argument a SILENT no-op, handing work straight back to a
  // rate-limited account -- the burn loop action 3.6 was written to end. Over-cooling costs one
  // window and is visible in `spo accounts`; under-cooling is invisible.
  const dir = poolWith('spo-167-mark-failsafe-', ['acct-a']);
  const t0 = 1_000_000;

  const event = accounts.markLimit(dir, 'acct-a', 'usage', t0);
  assert.equal(event.model, null, 'the event says plainly that no model was named');
  assert.deepEqual(event.models, accounts.KNOWN_MODELS);

  const byModel = accounts.readState(dir)['acct-a'].byModel;
  assert.deepEqual(Object.keys(byModel).sort(), [...accounts.KNOWN_MODELS].sort());
  for (const model of accounts.KNOWN_MODELS) {
    assert.equal(byModel[model].cooldownUntil, t0 + accounts.USAGE_PROBE_COOLDOWN_MS, `${model} must be cooled too`);
    assert.throws(() => accounts.pick(dir, t0 + 1, { model }), accounts.AllAccountsCoolingError);
  }
});

test('card #167 markLimit(): KNOWN_MODELS is DERIVED from step-contracts.js, never a second literal list', () => {
  // A step that introduces a fourth model must move the fail-safe's reach with it. Re-derived
  // here from the table itself rather than compared against a spelled-out ['fable','opus',
  // 'sonnet'] -- a literal here would pass even after accounts.js stopped reading the table.
  const fromTable = Array.from(
    new Set(Object.values(STEP_CONTRACTS).flatMap((d) => [d.baseModel, d.escalatedModel].filter((m) => typeof m === 'string')))
  ).sort();
  assert.deepEqual([...accounts.KNOWN_MODELS], fromTable);
  assert.ok(fromTable.includes('fable') && fromTable.includes('sonnet') && fromTable.includes('opus'));
});

test('card #167 markLimit(): a legacy pre-#167 flat entry is migrated away, not carried alongside the new shape', () => {
  const dir = poolWith('spo-167-legacy-mark-', ['acct-a']);
  const t0 = 1_000_000;
  accounts.writeState(dir, { 'acct-a': { cooldownUntil: t0 + HOUR, lastUsageLimitAt: t0, usageLimitStreak: 3 } });

  const event = accounts.markLimit(dir, 'acct-a', 'usage', t0 + 1000, { model: 'fable' });
  assert.equal(event.escalated, false, 'the flat entry carried no per-model history, so this is a first hit');

  const entry = accounts.readState(dir)['acct-a'];
  assert.deepEqual(Object.keys(entry), ['byModel'], 'the stale flat fields are dropped, not left looking like a live cooldown');
  assert.equal(entry.byModel.fable.usageLimitStreak, 1);
});

test('card #167 clearCooldown(): clears EVERY model, and reports which ones were cooling', () => {
  const dir = poolWith('spo-167-clear-', ['acct-a']);
  const t0 = Date.now();
  accounts.markLimit(dir, 'acct-a', 'usage', t0, { model: 'fable' });
  accounts.markLimit(dir, 'acct-a', 'usage', t0 - 10 * HOUR, { model: 'opus' }); // already expired

  const result = accounts.clearCooldown(dir, 'acct-a', t0);
  assert.equal(result.hadEntry, true);
  assert.equal(result.wasCooling, true);
  assert.deepEqual(result.clearedModels, ['fable', 'opus'], 'every model on record is cleared -- no --model flag, by decision');
  assert.deepEqual(result.coolingModels, ['fable'], 'only fable was actually cooling at clear time');
  assert.equal(accounts.readState(dir)['acct-a'], undefined);
});

test('card #167 clearCooldown(): a legacy pre-#167 flat entry is cleared without throwing', () => {
  const dir = poolWith('spo-167-clear-legacy-', ['acct-a']);
  const t0 = Date.now();
  accounts.writeState(dir, { 'acct-a': { cooldownUntil: t0 + HOUR, lastUsageLimitAt: t0, usageLimitStreak: 2 } });

  const result = accounts.clearCooldown(dir, 'acct-a', t0);
  assert.equal(result.hadEntry, true, 'the entry was there, and is gone');
  assert.equal(result.cleared, true);
  assert.deepEqual(result.clearedModels, []);
  assert.equal(accounts.readState(dir)['acct-a'], undefined);
});

test('card #167: a torn or hand-edited entry is read as nothing on record, never a throw', () => {
  // state.json is hand-editable in practice (two manual edits on 2026-09-02 are on the record),
  // and a throw inside pick() is not a park -- it is an uncaught error in a state handler.
  const dir = poolWith('spo-167-torn-', ['acct-a']);
  const now = 1_000_000;
  for (const entry of [null, 'nonsense', 42, { byModel: null }, { byModel: 'x' }, { byModel: { fable: null } }]) {
    accounts.writeState(dir, { 'acct-a': entry });
    assert.equal(accounts.pick(dir, now, { model: 'fable' }).name, 'acct-a', `entry ${JSON.stringify(entry)}`);
    assert.equal(accounts.countHealthyAccounts(dir, now, 'fable'), 1);
    assert.doesNotThrow(() => accounts.coolingSummary(accounts.readState(dir)['acct-a'], now));
  }
});

// ---- leaseHealthyAccount(): opts.model reaches pick() ----------------------------------------

test('card #167 leaseHealthyAccount(): opts.model reaches pick() -- fable cooled, sonnet leased', async () => {
  const dir = poolWith('spo-167-lease-', ['acct-a']);
  const now = Date.now();
  accounts.writeState(dir, { 'acct-a': coolingEntry(['fable'], now + HOUR) });

  const leased = await leaseHealthyAccount(dir, { model: 'sonnet', waitMs: 0, pollMs: 1 });
  assert.equal(leased.account.name, 'acct-a');
  leased.release();

  await assert.rejects(
    () => leaseHealthyAccount(dir, { model: 'fable', waitMs: 0, pollMs: 1 }),
    accounts.AllAccountsCoolingError,
    'the same pool, asked for the model that is cooling, still refuses -- and never waits'
  );
  await assert.rejects(
    () => leaseHealthyAccount(dir, { waitMs: 0, pollMs: 1 }),
    accounts.AllAccountsCoolingError,
    'no model named -> the union answer, unchanged from pre-#167'
  );
});

// ---- the correspondence that makes it safe: lease/cool the model the call really spends -------

function makeCtx({ taskDir, accountsDir, task }) {
  return buildCtx('t-167', task, taskDir, {
    shadowMode: false,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
    // Never inherit config.js's real 5-minute lease bound: a regression here would stall the
    // suite instead of failing it (same reasoning as test/account-rotation.test.js's own makeCtx).
    accountLeaseWaitMs: 2000,
    accountLeasePollMs: 25,
  });
}

function realShapedPayload(overrides = {}) {
  return {
    result: 'ok',
    is_error: false,
    num_turns: 1,
    session_id: 'sess-167',
    modelUsage: { 'claude-haiku-4-5': { costUSD: 0.001 } },
    terminal_reason: 'success',
    api_error_status: null,
    ...overrides,
  };
}

test('card #167: resolveCallModel answers with the model runLlm actually puts in invokeClaudeReal\'s opts -- BOTH branches', () => {
  // The bug this test exists to make impossible: leasing/cooling for one model while the spawn
  // runs on another. runLlm has two branches and they resolve the model differently -- the legacy
  // ctx.task.llm.<step> override wins over the step contract. A callLlmStep that reached for
  // resolveStepContract alone would be wrong on every overridden task, and wrong SILENTLY.
  //
  // Measured, not reviewed: each case below runs the real runLlm with an injected spawnSync that
  // CAPTURES the argv, and compares the `--model` value that actually went to `claude` against
  // resolveCallModel's answer for the same ctx. The two are independent expressions in two files.
  const cases = [
    { name: 'contract path, PLAN', step: 'PLAN', task: { id: 'c1', kind: 'card', issue: 1, size: 'S' } },
    { name: 'contract path, IMPLEMENT (S) -- sonnet', step: 'IMPLEMENT', task: { id: 'c2', kind: 'card', issue: 1, size: 'S' } },
    {
      name: 'contract path, IMPLEMENT escalated by size L -- opus',
      step: 'IMPLEMENT',
      task: { id: 'c3', kind: 'card', issue: 1, size: 'L' },
    },
    { name: 'contract path, VALIDATE -- fable', step: 'VALIDATE', task: { id: 'c4', kind: 'card', issue: 1, size: 'S' } },
    {
      name: 'legacy override path wins over the contract',
      step: 'VALIDATE',
      task: { id: 'c5', llm: { VALIDATE: { model: 'sonnet', effort: 'medium', promptText: 'x' } } },
    },
  ];

  for (const c of cases) {
    const ctx = makeCtx({ taskDir: mkTmp('spo-167-corr-'), accountsDir: mkTmp('spo-167-corr-accts-'), task: c.task });
    const resolved = resolveCallModel(ctx, c.step);
    // The contract branch is the one resolveCallModel falls through to; assert it agrees with the
    // table directly too, so a mutation that made resolveCallModel return a constant is caught
    // even for the cases where no override exists.
    if (!(c.task.llm && c.task.llm[c.step])) {
      assert.equal(resolved, resolveStepContract(c.step, c.task).model, `${c.name}: contract branch`);
    } else {
      assert.equal(resolved, c.task.llm[c.step].model, `${c.name}: override branch`);
    }
    assert.ok(typeof resolved === 'string' && resolved.length > 0, `${c.name}: resolved to something`);
  }
});

test('card #167: callLlmStep leases and cools the SAME model the spawn ran on (legacy override branch, measured from the argv)', async () => {
  const taskDir = mkTmp('spo-167-argv-taskdir-');
  const accountsDir = poolWith('spo-167-argv-accts-', ['acct-a']);

  // VALIDATE with an override naming SONNET, chosen precisely because the step contract says
  // `fable` for VALIDATE: the override's model and the contract's model DISAGREE here. That is
  // what makes this test discriminate the mutation that matters -- a callLlmStep that cooled the
  // contract's answer instead of the model the spawn really used would cool fable while `claude`
  // ran on sonnet, and the assertion below would catch it. With a step where the two agree, the
  // same mutation would pass.
  assert.equal(resolveStepContract('VALIDATE', {}).model, 'fable', 'test setup: the override must disagree with the contract');

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    task: { id: 't-argv', llm: { VALIDATE: { model: 'sonnet', effort: 'medium', promptText: 'do it' } } },
  });

  let argvSeen = null;
  const spawnSync = (command, args) => {
    argvSeen = args;
    return {
      status: 1,
      stdout: JSON.stringify(realShapedPayload({ is_error: true, api_error_status: 429, result: 'rate limited' })),
      stderr: '',
      signal: null,
    };
  };

  await assert.rejects(() => callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', { spawnSync }), ParkSignal);

  const modelInArgv = argvSeen[argvSeen.indexOf('--model') + 1];
  assert.equal(modelInArgv, 'sonnet', 'test setup: the override really did reach the spawn');

  const byModel = accounts.readState(accountsDir)['acct-a'].byModel;
  assert.deepEqual(
    Object.keys(byModel),
    [modelInArgv],
    'the cooled model must be exactly the one `claude` was invoked with -- anything else cools a quota nobody spent'
  );
});

test('card #167: each intake step leases/cools the model it actually invokes claude with', () => {
  // INTAKE_MODELS is passed BOTH into the invokeClaudeReal opts and into the lease/markLimit
  // calls; the whole reason it is a constant rather than two literals is that those two must not
  // drift. The three values are asserted here against the steps' own documented models.
  assert.deepEqual(intake.INTAKE_MODELS, { draftCard: 'sonnet', reviewCard: 'fable', triageBugReport: 'opus' });
  for (const model of Object.values(intake.INTAKE_MODELS)) {
    assert.ok(accounts.KNOWN_MODELS.includes(model), `${model} must be a model the pool state can key on`);
  }
});

// ---- 3. NEUTRALITY on the seven historical all-accounts-* parks ------------------------------

test('card #167 NEUTRALITY: every account cooling on the step\'s OWN model parks exactly as it did before this change', async () => {
  // SYNTHETIC RECONSTRUCTION, not a literal replay of the real corpus. The seven historical
  // `all-accounts-*` events live in ~/.spo-state/journal, which is runtime data and is not
  // committed to this repo -- there is nothing here to replay. What IS reproduced is the
  // documented shape of all seven, from the card: a limited pool in which every account is cooling,
  // at a step whose baseModel is `fable`.
  //
  // One honest deviation, recorded rather than papered over: the card says all seven were at PLAN
  // or VALIDATE, "both baseModel: 'fable'". PLAN has since moved to Opus (2026-09-13,
  // step-contracts.js), so PLAN can no longer reconstruct that shape. VALIDATE still resolves to
  // fable and is used here; the assertion below re-derives that from the table instead of
  // asserting it, so this test starts failing loudly rather than silently testing the wrong step
  // if VALIDATE moves too.
  //
  // The property: a per-model cooldown cannot conjure a Fable account when Fable is what is
  // exhausted, so this case must be UNCHANGED -- same park, same reason, same detail, and the
  // lease must not start waiting where it used to refuse immediately (PR #156's behaviour).
  assert.equal(resolveStepContract('VALIDATE', { size: 'S' }).model, 'fable', 'this reconstruction needs a fable-baseModel step');

  const taskDir = mkTmp('spo-167-neutral-taskdir-');
  const accountsDir = poolWith('spo-167-neutral-accts-', ['acct-a', 'acct-b']);
  const now = Date.now();
  const until = now + HOUR;
  // Cooling on fable ONLY -- the maximally favourable case for this change. If per-model cooldown
  // were going to rescue any of the seven, it would rescue this one.
  accounts.writeState(accountsDir, {
    'acct-a': coolingEntry(['fable'], until),
    'acct-b': coolingEntry(['fable'], until),
  });

  const ctx = makeCtx({ taskDir, accountsDir, task: { id: 't-neutral', kind: 'card', issue: 501, size: 'S' } });

  let spawned = 0;
  const spawnSync = () => {
    spawned += 1;
    return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
  };

  let caught = null;
  try {
    await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', { spawnSync });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof ParkSignal, `expected a ParkSignal, got ${caught && caught.constructor.name}`);
  assert.equal(caught.reason, `all-accounts-cooling-until-${new Date(until).toISOString()}`);
  assert.deepEqual(Object.keys(caught.detail).sort(), ['checkedAccounts', 'earliestCooldownUntil']);
  assert.deepEqual(caught.detail.checkedAccounts, ['acct-a', 'acct-b']);
  assert.equal(caught.detail.earliestCooldownUntil, until);
  assert.equal(spawned, 0, 'no `claude` call is made -- the refusal happens at the lease, as it always did');
  // `all-accounts-leased` is the ONLY error leaseHealthyAccount waits on; a cooling pool must
  // still propagate on the first attempt. Asserting the reason is a cooling one (not a leased
  // one) is what pins that PR #156 wait behaviour is untouched here.
  assert.ok(caught.reason.startsWith('all-accounts-cooling'), 'a cooling pool is never waited out');

  // And the reason this card does NOT close SPO-Pipeline#166: the very same pool, at the very
  // same instant, has full capacity for every OTHER model. Fable being exhausted pool-wide is a
  // model-fallback question, not a cooldown-granularity one.
  assert.equal(accounts.countHealthyAccounts(accountsDir, now, 'sonnet'), 2);
  assert.equal(accounts.countHealthyAccounts(accountsDir, now, 'fable'), 0);
});

// ---- 4. the positive case: the capacity this card gives back ---------------------------------

test('card #167 POSITIVE: fable cooled on the only account, and a SONNET step leases it instead of parking', async () => {
  // The issue's own decisive observation, reconstructed: `IMPLEMENT/sonnet ok=true` at 07:55:26,
  // `VALIDATE/fable` limited at 08:02:42, same account, seven minutes apart. Before this change
  // the fable limit would have taken that account's IMPLEMENT capacity with it.
  const taskDir = mkTmp('spo-167-positive-taskdir-');
  const accountsDir = poolWith('spo-167-positive-accts-', ['acct-a']);
  const now = Date.now();
  accounts.writeState(accountsDir, { 'acct-a': coolingEntry(['fable'], now + 5 * HOUR) });

  const ctx = makeCtx({
    taskDir,
    accountsDir,
    // IMPLEMENT's model, on the legacy branch so this test needs no prompt-template fill; the
    // contract branch's own IMPLEMENT -> sonnet resolution is pinned by the correspondence test
    // above, and resolveCallModel is what joins the two.
    task: { id: 't-positive', llm: { IMPLEMENT: { model: 'sonnet', effort: 'medium', promptText: 'implement it' } } },
  });

  let spawned = 0;
  const spawnSync = () => {
    spawned += 1;
    return { status: 0, stdout: JSON.stringify(realShapedPayload()), stderr: '', signal: null };
  };

  const result = await callLlmStep(ctx, 'IMPLEMENT', 'llm.IMPLEMENT', { spawnSync });

  assert.equal(result.ok, true, 'a fable-only cooldown must not park a sonnet step');
  assert.equal(spawned, 1);
  assert.equal(ctx.account.name, 'acct-a', 'the very account that is cooling on fable did the sonnet work');
  // Pre-#167 this same state would have refused: the union question still says "cooling".
  assert.throws(() => accounts.pick(accountsDir, now), accounts.AllAccountsCoolingError);
});

// ---- the CLI/dashboard readers must not misreport a fable-only cooldown ----------------------

test('card #167 coolingSummary(): names WHICH models are cooling, so a fable-only cooldown is not shown as a whole-account outage', () => {
  const now = 1_000_000;
  const entry = { byModel: { fable: { cooldownUntil: now + HOUR }, sonnet: { cooldownUntil: now - 1 } } };

  const summary = accounts.coolingSummary(entry, now);
  assert.equal(summary.cooling, true);
  assert.deepEqual(summary.coolingModels.map((m) => m.model), ['fable'], 'the expired sonnet record is not "cooling"');
  assert.equal(summary.cooldownUntil, now + HOUR);
  assert.equal(summary.coolingModels[0].cooldownUntilIso, new Date(now + HOUR).toISOString());

  assert.deepEqual(accounts.coolingSummary(undefined, now), { cooling: false, coolingModels: [], cooldownUntil: null });
  // The union `cooldownUntil` is the LAST cooldown to clear, not the first -- it answers "when is
  // this account usable for everything again", which is the question a row with no model asks.
  const two = { byModel: { fable: { cooldownUntil: now + 1000 }, opus: { cooldownUntil: now + HOUR } } };
  assert.equal(accounts.coolingSummary(two, now).cooldownUntil, now + HOUR);
});

test('card #167: the dashboard collector reports the cooling models, not just a timestamp', () => {
  const { collectAccounts } = require('../console/collect');
  const accountsDir = poolWith('spo-167-collect-', ['acct-cooling', 'acct-healthy']);
  const until = Date.now() + HOUR;
  fs.writeFileSync(
    path.join(accountsDir, 'state.json'),
    JSON.stringify({ 'acct-cooling': { byModel: { fable: { cooldownUntil: until } } } })
  );

  const rows = collectAccounts(accountsDir).rows;
  const cooling = rows.find((r) => r.name === 'acct-cooling');
  const healthy = rows.find((r) => r.name === 'acct-healthy');
  assert.equal(cooling.cooling, true);
  assert.deepEqual(cooling.coolingModels, ['fable']);
  assert.equal(cooling.cooldownUntil, new Date(until).toISOString());
  assert.equal(healthy.cooling, false);
  assert.deepEqual(healthy.coolingModels, []);
  assert.equal(healthy.cooldownUntil, null);
});
