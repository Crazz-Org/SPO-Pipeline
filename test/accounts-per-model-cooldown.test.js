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
// model the call actually ran on, read as `--model` off the argv the vendored Agent SDK's REAL
// query() builds (card #241's transport; test/helpers.js's fakeSpawnDeps/fakeSpawnedChild fake
// only the child process), for both of runLlm's branches, every step's escalation flags, and all
// three intake steps. A limit is driven the same way -- a `result` message with `is_error:true,
// api_error_status:429` through the real query() and sdk-call.js's consumeQueryStream -- never by
// calling markLimit directly.
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
const { resolveCallModel, runLlm } = require('../orchestrator/steps/llm');
const { STEP_CONTRACTS, INTAKE_MODELS, OPUS_5_5, resolveStepContract } = require('../orchestrator/step-contracts');
const { appendEvent } = require('../orchestrator/journal');
const intake = require('../orchestrator/intake');
const { writePoolDir, mkTmp, fakeSpawnDeps, fakeExecDeps, fakeSpawnedChild } = require('./helpers');

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
  // Probed at now+500, while BOTH cooldowns are still active, so min and max differ there: the
  // union's answer (and the park reason naming when to retry) must be the LATER of the two. At
  // now+2000 fable has already expired and min == max, which cannot tell the two apart.
  assert.throws(
    () => accounts.pick(dir, now + 500),
    (err) =>
      err instanceof accounts.AllAccountsCoolingError &&
      err.reason === `all-accounts-cooling-until-${new Date(now + HOUR).toISOString()}`
  );
  assert.equal(accounts.activeCooldownUntil(accounts.readState(dir)['acct-a'], undefined, now + 500), now + HOUR);
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
  // A step that introduces another model must move the fail-safe's reach with it. Re-derived here
  // from step-contracts.js itself -- every STEP_CONTRACTS baseModel/escalatedModel PLUS the three
  // intake steps' INTAKE_MODELS -- rather than compared against a spelled-out list: a literal here
  // would pass even after accounts.js stopped reading the table.
  const fromTable = Array.from(
    new Set(
      Object.values(STEP_CONTRACTS)
        .flatMap((d) => [d.baseModel, d.escalatedModel])
        .concat(Object.values(INTAKE_MODELS))
        .filter((m) => typeof m === 'string')
    )
  ).sort();
  assert.deepEqual([...accounts.KNOWN_MODELS], fromTable);
  // Every model any real call can spend is in the fail-safe's reach. `sonnet` is the one that
  // proves INTAKE_MODELS is read at all: since IMPLEMENT moved to OPUS_5_5 (2026-09-23) no
  // STEP_CONTRACTS entry names it, and DRAFT_CARD is its only spender.
  for (const m of [OPUS_5_5, 'fable', 'sonnet']) assert.ok(accounts.KNOWN_MODELS.includes(m), `${m} must be in KNOWN_MODELS`);
  assert.ok(
    !Object.values(STEP_CONTRACTS).some((d) => d.baseModel === 'sonnet' || d.escalatedModel === 'sonnet'),
    'test premise: no pipeline step spends sonnet, so only INTAKE_MODELS can put it in KNOWN_MODELS'
  );
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

test('card #167 clearCooldown(): escalationWasArmed is true when ANY model is armed -- including one that is not iterated last', () => {
  // clearCooldown walks the models in sorted order (['fable', 'opus'] here). The armed record is
  // fable, deliberately FIRST: a computation that only looked at the last model it visited -- or
  // let a later, unarmed model overwrite the flag -- would read opus's stale history and say
  // "not armed", telling the maintainer the clear discarded nothing when it discarded a live
  // escalation streak.
  const dir = poolWith('spo-167-clear-armed-', ['acct-a']);
  const t0 = Date.now();
  accounts.writeState(dir, {
    'acct-a': {
      byModel: {
        fable: { cooldownUntil: t0 + HOUR, lastUsageLimitAt: t0 - 1000, usageLimitStreak: 2 },
        opus: { cooldownUntil: t0 - 10 * HOUR, lastUsageLimitAt: t0 - 10 * HOUR, usageLimitStreak: 1 },
      },
    },
  });

  const result = accounts.clearCooldown(dir, 'acct-a', t0);
  assert.deepEqual(result.clearedModels, ['fable', 'opus'], 'test premise: the armed model is not the last one visited');
  assert.ok(10 * HOUR > accounts.ESCALATION_WINDOW_MS, 'test premise: opus\'s history is outside the escalation window');
  assert.equal(result.escalationWasArmed, true, 'fable was armed 1s ago -- an armed model anywhere in the entry arms the clear');
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

// The SDK stream a fake child replays (same shapes as test/account-rotation.test.js and
// test/sdk-deny-list-e2e.test.js): a system/init message, then one `result` message. The vendored
// query() parses these off the fake child's stdout exactly as it would a real `claude`'s.
const SESSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function initMessage() {
  return { type: 'system', subtype: 'init', session_id: SESSION_ID, apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}
function resultMessage(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: SESSION_ID,
    modelUsage: { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5 } },
    result: 'ok',
    terminal_reason: 'success',
    api_error_status: null,
    ...overrides,
  };
}
// The real observed limit shape (sdk-call.js's consumeQueryStream header, item 3): subtype
// 'success', is_error true, api_error_status 429 -- classified `kind:'limit'` by llm.js's
// classifyFailure/limitKindForFailure.
const LIMIT_429 = { is_error: true, api_error_status: 429, result: "You've reached your limit" };

// `--model <value>` off the real argv the vendored query() handed to spawnClaudeCodeProcess;
// undefined when no --model was emitted at all.
function modelArgvValue(argv) {
  const i = argv.indexOf('--model');
  return i === -1 ? undefined : argv[i + 1];
}

// A card-shaped task every real step's prompt template can fill (sdk-deny-list-e2e.test.js's own
// shape), plus IMPLEMENT's PLAN-output prerequisite in the journal.
function cardTask(extra = {}) {
  return {
    id: 't-167-card',
    kind: 'card',
    issue: 1,
    title: 'per-model cooldown probe',
    criterion: 'the model leased and cooled is the model on the argv',
    worktreePath: '/tmp/wt-167',
    size: 'S',
    citations: ['AdmMembersRDO.pas:512'],
    ...extra,
  };
}
function seedPlan(taskDir) {
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { plan_path: '/p', invariants_path: '/i', invariant_ids: ['INV-1'], check_commands: ['x'] },
  });
}

// Every branch resolveCallModel has to mirror: each real step on the contract path, each
// escalation flag that could move a model (PLAN's planInvalidRetry is the only one that does
// today; IMPLEMENT's and VALIDATE's triggers move effort, not model, since 2026-09-23 -- included
// so a future model escalation there is covered too), and the legacy override branch with a model,
// with none, and with an empty one.
const CORRESPONDENCE_CASES = [
  { name: 'PLAN, base', step: 'PLAN', task: cardTask() },
  { name: 'PLAN, planInvalidRetry (model escalation -> fable)', step: 'PLAN', task: cardTask({ planInvalidRetry: true }) },
  { name: 'IMPLEMENT, S', step: 'IMPLEMENT', task: cardTask() },
  { name: 'IMPLEMENT, L (lSize trigger)', step: 'IMPLEMENT', task: cardTask({ size: 'L' }) },
  { name: 'IMPLEMENT, diagnoseOrValidateRetry', step: 'IMPLEMENT', task: cardTask({ diagnoseOrValidateRetry: true }) },
  { name: 'IMPLEMENT, planDeclaresRdoMembers', step: 'IMPLEMENT', task: cardTask({ planDeclaresRdoMembers: true }) },
  { name: 'DIAGNOSE', step: 'DIAGNOSE', task: cardTask() },
  { name: 'VALIDATE', step: 'VALIDATE', task: cardTask() },
  { name: 'VALIDATE, rdoDiffTouched', step: 'VALIDATE', task: cardTask({ rdoDiffTouched: true }) },
  { name: 'CITATION_VERIFIER', step: 'CITATION_VERIFIER', task: cardTask() },
  {
    name: 'legacy override wins over the contract (VALIDATE -> sonnet, contract says fable)',
    step: 'VALIDATE',
    task: { id: 'c-ovr', llm: { VALIDATE: { model: 'sonnet', effort: 'medium', promptText: 'x' } } },
  },
  {
    name: 'legacy override naming NO model (no --model on the argv at all)',
    step: 'VALIDATE',
    task: { id: 'c-ovr-none', llm: { VALIDATE: { effort: 'medium', promptText: 'x' } } },
  },
  {
    name: 'legacy override naming an EMPTY model (buildQueryOptions drops it too)',
    step: 'VALIDATE',
    task: { id: 'c-ovr-empty', llm: { VALIDATE: { model: '', effort: 'medium', promptText: 'x' } } },
  },
];

test("card #167: resolveCallModel equals the --model the vendored SDK's REAL query() argv carries -- every step, every escalation flag, both branches", async () => {
  // The bug this test exists to make impossible: leasing/cooling for one model while the call
  // runs on another. Measured, not reviewed: each case runs the real runLlm -> buildQueryOptions ->
  // vendored query(), which builds the real argv and hands it to a fake spawnClaudeCodeProcess;
  // `--model` is read back off THAT argv and compared against resolveCallModel's answer for the
  // same ctx. The two are independent expressions (llm.js's resolveCallModel is deliberately not
  // called by runLlm -- see its own header), so a mutation to either side shows up here.
  const seen = new Set();
  for (const c of CORRESPONDENCE_CASES) {
    const taskDir = mkTmp('spo-167-corr-');
    seedPlan(taskDir);
    const ctx = makeCtx({ taskDir, accountsDir: mkTmp('spo-167-corr-accts-'), task: c.task });
    ctx.account = { name: 'acct-a', configDir: null };
    const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage({ result: JSON.stringify({ verdict: 'PASS' }) })]);
    try {
      await runLlm(ctx, c.step, `llm.${c.step}`, fakeExecDeps({ spawn }));
    } catch (err) {
      // The fake reply is not shaped to satisfy every step's outputContract; only a spawn that
      // never happened is a failure for THIS test.
      if (!calls.length) throw err;
    }
    assert.equal(calls.length, 1, `${c.name}: must reach exactly one real query() spawn`);
    const argvModel = modelArgvValue(calls[0].args);
    assert.equal(resolveCallModel(ctx, c.step), argvModel, `${c.name}: resolveCallModel must equal the argv's --model`);
    seen.add(String(argvModel));
  }
  // The table must actually discriminate: a resolveCallModel returning one constant, or always
  // the contract's answer, must fail at least one case above. These are the distinct values the
  // real argv carried across the table.
  assert.deepEqual([...seen].sort(), [OPUS_5_5, 'fable', 'sonnet', 'undefined'].sort());
});

test("card #167: a 429 through the real query() stream cools EXACTLY the argv's --model on that account -- contract and override branches", async () => {
  // A limit on the SDK path is classified by llm.js's classifyFailure / limitKindForFailure off
  // the `result` message's api_error_status, not by any code this card wrote. This drives that
  // whole path -- vendored query() -> sdk-call.js's consumeQueryStream -> invokeClaudeReal ->
  // callLlmStep's markLimit -- and asserts the cooled key is the model the argv carried.
  //
  // Each case also PRE-COOLS the account on every other known model. The call can only have
  // spawned if the LEASE asked for the argv's own model (every other model is cooling), so one
  // run pins lease model == argv model == cooled model.
  const cases = [
    { name: 'contract path, VALIDATE (fable)', step: 'VALIDATE', task: cardTask() },
    { name: 'contract path, IMPLEMENT (OPUS_5_5)', step: 'IMPLEMENT', task: cardTask() },
    { name: 'contract path, PLAN escalated by planInvalidRetry (fable)', step: 'PLAN', task: cardTask({ planInvalidRetry: true }) },
    {
      // VALIDATE with an override naming SONNET, chosen because the contract says `fable`: the
      // two DISAGREE, which is what discriminates a callLlmStep that cooled the contract's answer
      // instead of the model the call really used.
      name: 'legacy override path, VALIDATE -> sonnet',
      step: 'VALIDATE',
      task: { id: 't-argv', llm: { VALIDATE: { model: 'sonnet', effort: 'medium', promptText: 'do it' } } },
    },
  ];
  assert.equal(resolveStepContract('VALIDATE', {}).model, 'fable', 'test setup: the override must disagree with the contract');

  for (const c of cases) {
    const taskDir = mkTmp('spo-167-429-taskdir-');
    seedPlan(taskDir);
    const accountsDir = poolWith('spo-167-429-accts-', ['acct-a']);
    const ctx = makeCtx({ taskDir, accountsDir, task: c.task });
    const expected = resolveCallModel(ctx, c.step);
    const others = accounts.KNOWN_MODELS.filter((m) => m !== expected);
    assert.ok(others.length >= 2, `${c.name}: test premise -- at least two other models are pre-cooled`);
    accounts.writeState(accountsDir, { 'acct-a': coolingEntry(others, Date.now() + HOUR) });

    let argvSeen = null;
    const spawn = (command, args, spawnOpts) => {
      argvSeen = args;
      return fakeSpawnedChild([initMessage(), resultMessage(LIMIT_429)], { signal: spawnOpts.signal });
    };

    await assert.rejects(() => callLlmStep(ctx, c.step, `llm.${c.step}`, fakeExecDeps({ spawn })), ParkSignal, c.name);

    assert.ok(argvSeen, `${c.name}: the lease must have granted the account for its own model, and the call spawned`);
    const argvModel = modelArgvValue(argvSeen);
    assert.equal(argvModel, expected, `${c.name}: the argv's --model is resolveCallModel's answer`);
    const byModel = accounts.readState(accountsDir)['acct-a'].byModel;
    const newlyCooled = Object.keys(byModel).filter((m) => byModel[m].lastUsageLimitAt !== undefined);
    assert.deepEqual(
      newlyCooled,
      [argvModel],
      `${c.name}: the cooled model must be exactly the one the query() argv carried -- anything else cools a quota nobody spent`
    );
    assert.equal(byModel[argvModel].usageLimitStreak, 1, `${c.name}: classified as a usage limit (429), first hit`);
  }
});

test('card #167: each intake step leases, spends and cools ONE model -- INTAKE_MODELS, read off the real query() argv', async () => {
  // INTAKE_MODELS (step-contracts.js) is passed BOTH into each intake step's call opts and into
  // callIntakeStepWithRotation's lease/markLimit. This drives each step through the real vendored
  // query() with a 429 reply, on a one-account pool pre-cooled on every OTHER known model: the
  // call spawning at all proves the lease asked for the step's own model, the argv's --model
  // proves the spend, and the one newly-cooled key proves markLimit's.
  assert.equal(intake.INTAKE_MODELS, INTAKE_MODELS, "intake.js re-exports step-contracts.js's own object");
  assert.deepEqual({ ...INTAKE_MODELS }, { draftCard: 'sonnet', reviewCard: 'fable', triageBugReport: OPUS_5_5 });

  const calls = {
    draftCard: (deps) => intake.draftCard('add a widget', deps),
    reviewCard: (deps) =>
      intake.reviewCard(
        { title: 't', body_markdown: 'b', category: 'feature', size: 'S', area: 'client', priority: 'Low', is_bug_report: false, confirmed: false },
        deps
      ),
    triageBugReport: (deps) => {
      const reportFile = path.join(mkTmp('spo-167-intake-report-'), 'report.json');
      fs.writeFileSync(reportFile, '{}');
      return intake.triageBugReport(reportFile, 1, deps);
    },
  };
  assert.deepEqual(Object.keys(calls).sort(), Object.keys(INTAKE_MODELS).sort(), 'every intake step is covered');

  for (const [name, call] of Object.entries(calls)) {
    const model = INTAKE_MODELS[name];
    assert.ok(accounts.KNOWN_MODELS.includes(model), `${name}: ${model} must be in markLimit's no-model fail-safe`);
    const accountsDir = poolWith(`spo-167-intake-${name}-`, ['acct-a']);
    const others = accounts.KNOWN_MODELS.filter((m) => m !== model);
    accounts.writeState(accountsDir, { 'acct-a': coolingEntry(others, Date.now() + HOUR) });

    let argvSeen = null;
    const deps = {
      ...fakeExecDeps(),
      accountsDir,
      journalRoot: mkTmp(`spo-167-intake-journal-${name}-`),
      spawn: (command, args, spawnOpts) => {
        argvSeen = args;
        return fakeSpawnedChild([initMessage(), resultMessage(LIMIT_429)], { signal: spawnOpts.signal });
      },
    };

    const result = await call(deps);

    assert.ok(argvSeen, `${name}: must spawn -- the lease was for ${model}, the only model not cooling`);
    assert.equal(modelArgvValue(argvSeen), model, `${name}: the argv's --model is INTAKE_MODELS.${name}`);
    assert.equal(result.ok, false, `${name}: a one-account pool exhausted by a 429 reports failure`);
    const byModel = accounts.readState(accountsDir)['acct-a'].byModel;
    const newlyCooled = Object.keys(byModel).filter((m) => byModel[m].lastUsageLimitAt !== undefined);
    assert.deepEqual(newlyCooled, [model], `${name}: exactly the argv's model was cooled`);
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
  const spawn = (command, args, spawnOpts) => {
    spawned += 1;
    return fakeSpawnedChild([initMessage(), resultMessage()], { signal: spawnOpts.signal });
  };

  let caught = null;
  try {
    await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn }));
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

test('card #167 POSITIVE: fable cooled on the only account, and an OPUS_5_5 step leases it instead of parking', async () => {
  // The issue's own decisive observation, reconstructed: `IMPLEMENT/sonnet ok=true` at 07:55:26,
  // `VALIDATE/fable` limited at 08:02:42, same account, seven minutes apart. Before this change
  // the fable limit would have taken that account's IMPLEMENT capacity with it. IMPLEMENT has run
  // OPUS_5_5 since 2026-09-23 (EXP-IMPLEMENT-OPUS-5-5), so that is the model reconstructed here --
  // on the real contract branch, so the lease's model is resolveCallModel's own contract answer.
  const taskDir = mkTmp('spo-167-positive-taskdir-');
  seedPlan(taskDir);
  const accountsDir = poolWith('spo-167-positive-accts-', ['acct-a']);
  const now = Date.now();
  accounts.writeState(accountsDir, { 'acct-a': coolingEntry(['fable'], now + 5 * HOUR) });

  const ctx = makeCtx({ taskDir, accountsDir, task: cardTask() });
  assert.equal(resolveCallModel(ctx, 'IMPLEMENT'), OPUS_5_5, 'test premise: IMPLEMENT resolves to OPUS_5_5');

  let argvSeen = null;
  const spawn = (command, args, spawnOpts) => {
    argvSeen = args;
    return fakeSpawnedChild([initMessage(), resultMessage({ result: JSON.stringify({ summary: 'done', files_changed: [], invariants: [], tests_run: [], all_green: true }) })], {
      signal: spawnOpts.signal,
    });
  };

  const result = await callLlmStep(ctx, 'IMPLEMENT', 'llm.IMPLEMENT', fakeExecDeps({ spawn }));

  assert.equal(result.ok, true, 'a fable-only cooldown must not park an OPUS_5_5 step');
  assert.ok(argvSeen, 'the call spawned');
  assert.equal(modelArgvValue(argvSeen), OPUS_5_5);
  assert.equal(ctx.account.name, 'acct-a', 'the very account that is cooling on fable did the Opus 5.5 work');
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
