'use strict';
// SPO-Pipeline#166, maintainer decision 2 (2026-09-24): the dispatcher's K-clamp counts an account
// healthy for the model the queued card's NEXT step needs. orchestrator/first-call-model.js holds
// the rule in two halves -- nextLlmCallForTask (which call, on which model) and servableFor (how
// many accounts can serve it, on which model) -- and dispatcher.js's fillSlots asks them per
// candidate. test/dispatcher.test.js drives
// that through the real dispatcher loop. This file pins the halves themselves, and above all their
// AGREEMENT with the worker: the model the clamp says a card is servable on must be the `--model`
// the card's first real call is launched with, and "not servable" must mean the first call never
// launches. A clamp that disagrees either spawns cards whose first call parks straight into a
// pool-wait (a spin with a worker boot per wake-up) or holds cards the pool could have served.

const test = require('node:test');
const assert = require('node:assert/strict');

require('./no-real-spawn');
const accounts = require('../orchestrator/accounts');
const { spawn } = require('child_process');
const path = require('path');
const { nextLlmCallForTask, servableFor } = require('../orchestrator/first-call-model');
const dispatcher = require('../orchestrator/dispatcher');
const { HANDLERS, buildCtx, callLlmStep } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { appendEvent } = require('../orchestrator/journal');
const { STEP_CONTRACTS, OPUS_5_5, resolveStepContract } = require('../orchestrator/step-contracts');
const { writePoolDir, mkTmp, fakeSpawnedChild, fakeExecDeps, isolatedEnv } = require('./helpers');

const HOUR_MS = 60 * 60 * 1000;
const REAL = { shadowMode: false, dryRun: false };
const SHADOW = { shadowMode: true, dryRun: false };

function pool(names = ['acct0', 'acct1']) {
  const dir = mkTmp('spo-166-clamp-pool-');
  writePoolDir(
    dir,
    names.map((name) => ({ name }))
  );
  return dir;
}

// A model-scoped usage limit, through the real markLimit -- the record callLlmStep writes after a
// Fable "Switch to another model" limit (#167 + #250), whatever fields a later change adds to it.
function modelLimitEverywhere(poolDir, model, names = ['acct0', 'acct1']) {
  for (const name of names) accounts.markLimit(poolDir, name, 'usage', Date.now(), { model, limitScope: 'model' });
}

function resumeDescriptor() {
  return { startState: 'CHECK', prNumber: 4242, worktreePath: '/tmp/spo-166-wt', source: 'pool-wait' };
}

// ---- 0. where the rule lives -------------------------------------------------------------------

// A fresh node process (so this file's own requires above do not pre-populate the module cache),
// running `code` from the repo root. Async spawn of node itself -- never git/gh/npm/claude.
function runNode(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: isolatedEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('first-call-model.js loads none of state-machine / auto-pull / dispatcher, so auto-pull.js can require it without a cycle; dispatcher.js re-exports the same functions', async () => {
  const probe = await runNode(
    "require('./orchestrator/first-call-model'); " +
      "console.log(JSON.stringify(Object.keys(require.cache).map((k) => require('path').basename(k)).filter((b) => ['state-machine.js', 'auto-pull.js', 'dispatcher.js'].includes(b))))"
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [], 'first-call-model.js must not load the state-machine -> auto-pull -> dispatcher cycle at require time');
  // Loaded the way auto-pull.js would sit in the graph (state-machine first, which loads
  // auto-pull), the lazy state-machine lookups still resolve.
  const viaCycle = await runNode(
    "require('./orchestrator/state-machine'); const m = require('./orchestrator/first-call-model'); " +
      "console.log(m.nextLlmCallForTask({ resume: { startState: 'CHECK', prNumber: 1, worktreePath: '/w' } }, null, {}).step)"
  );
  assert.equal(viaCycle.stdout.trim(), 'VALIDATE', viaCycle.stderr);
  assert.equal(dispatcher.nextLlmCallForTask, nextLlmCallForTask);
  assert.equal(dispatcher.servableFor, servableFor);
});

// ---- 1. the per-task rule --------------------------------------------------------------------

test('nextLlmCallForTask: the rule table -- fresh card -> PLAN, resume at CHECK -> the judge, both on their contract models', () => {
  const taskDir = mkTmp('spo-166-rule-');
  const fresh = nextLlmCallForTask({ id: 'c1', kind: 'card' }, taskDir, REAL);
  assert.deepEqual(
    [fresh.step, fresh.model, fresh.basis],
    ['PLAN', OPUS_5_5, 'fresh']
  );
  assert.equal(fresh.quotaFallbackModel, STEP_CONTRACTS.PLAN.quotaFallbackModel || null, 'PLAN has no quota fallback (#166 decision 3)');
  assert.equal(fresh.quotaFallbackModel, null);

  const resumed = nextLlmCallForTask({ id: 'c1', kind: 'card', resume: resumeDescriptor() }, taskDir, REAL);
  assert.deepEqual([resumed.step, resumed.model, resumed.basis], ['VALIDATE', 'fable', 'resume-at-check']);
  assert.equal(resumed.quotaFallbackModel, STEP_CONTRACTS.VALIDATE.quotaFallbackModel || null, 'the judge fallback, when the contract declares one');

  // A maintainer's `continue` descriptor (no `source`) resumes at CHECK too.
  const cont = nextLlmCallForTask({ id: 'c1', resume: { startState: 'CHECK', prNumber: 7, worktreePath: '/w' } }, taskDir, REAL);
  assert.equal(cont.step, 'VALIDATE');

  // A resume runTask would REFUSE never reaches CHECK: a machine one restarts at INTAKE, a
  // `continue` parks with no call. Either way the judge row is wrong for it.
  for (const bad of [{ startState: 'CHECK', worktreePath: '/w' }, { startState: 'PLAN', prNumber: 7, worktreePath: '/w' }, 'CHECK', []]) {
    assert.equal(nextLlmCallForTask({ id: 'c1', resume: bad }, taskDir, REAL).step, 'PLAN', JSON.stringify(bad));
  }
  assert.equal(nextLlmCallForTask({ id: 'c1', resume: null }, taskDir, REAL).step, 'PLAN');
  assert.equal(nextLlmCallForTask({ __invalid: true, rawPreview: '{' }, taskDir, REAL).step, 'PLAN', 'an unparsable entry is a fresh card to the clamp');
});

test('nextLlmCallForTask: PLAN moves to Fable after a plan-invalid park -- real mode only, most recent park only, read from the same journal handlePlan reads', () => {
  const taskDir = mkTmp('spo-166-rule-pi-');
  appendEvent(taskDir, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });
  const real = nextLlmCallForTask({ id: 'c2' }, taskDir, REAL);
  assert.deepEqual([real.model, real.basis], ['fable', 'fresh-after-plan-invalid-park']);
  assert.equal(nextLlmCallForTask({ id: 'c2' }, taskDir, SHADOW).model, OPUS_5_5, 'shadow: handlePlan never switches model');
  assert.equal(nextLlmCallForTask({ id: 'c2' }, taskDir, { shadowMode: false, dryRun: true }).model, OPUS_5_5, 'dry-run: same');
  // A queue entry carrying a stale flag does not decide it; the journal does, as in handlePlan.
  assert.equal(nextLlmCallForTask({ id: 'c2', planInvalidRetry: true }, mkTmp('spo-166-rule-clean-'), REAL).model, OPUS_5_5);

  appendEvent(taskDir, 'GATE', 'parked', { reason: 'gate-failed', detail: {} });
  assert.equal(nextLlmCallForTask({ id: 'c2' }, taskDir, REAL).model, OPUS_5_5, 'an orthogonal later park puts the card back on Opus');
  assert.equal(nextLlmCallForTask({ id: 'c2' }, null, REAL).model, OPUS_5_5, 'no taskDir (the hypothetical fresh card): no history');
});

test('nextLlmCallForTask: a legacy task.llm.<step> override decides the model, and has no quota fallback -- as in callLlmStep', () => {
  const call = nextLlmCallForTask({ id: 'c3', llm: { PLAN: { model: 'sonnet', promptText: 'x' } } }, null, REAL);
  assert.deepEqual([call.step, call.model, call.quotaFallbackModel], ['PLAN', 'sonnet', null]);
  const judge = nextLlmCallForTask({ id: 'c3', resume: resumeDescriptor(), llm: { VALIDATE: { model: 'sonnet', promptText: 'x' } } }, null, REAL);
  assert.deepEqual([judge.model, judge.quotaFallbackModel], ['sonnet', null]);
});

test('nextLlmCallForTask: a quotaFallbackStep carried in on the queue entry is dropped, as callLlmStep drops it -- the first call is on the base model', () => {
  const carried = nextLlmCallForTask({ id: 'c4', resume: resumeDescriptor(), quotaFallbackStep: 'VALIDATE' }, null, REAL);
  assert.deepEqual([carried.step, carried.model, carried.quotaFallbackModel], ['VALIDATE', 'fable', OPUS_5_5]);
  const plan = nextLlmCallForTask({ id: 'c4', quotaFallbackStep: 'PLAN' }, null, REAL);
  assert.equal(plan.model, OPUS_5_5);
});

test('the resume row names VALIDATE, and is right only while CITATION_VERIFIER shares its model and quota fallback', () => {
  // A resumed card's first call is CITATION_VERIFIER when the diff touches the RDO catalogue and
  // VALIDATE otherwise, which the dispatcher cannot tell before the worker runs. One row serves
  // both only while the two contracts agree; if they ever split, this fails and the rule must too.
  for (const task of [{}, { rdoDiffTouched: true }, { size: 'L' }]) {
    assert.equal(resolveStepContract('CITATION_VERIFIER', task).model, resolveStepContract('VALIDATE', task).model);
  }
  assert.equal(STEP_CONTRACTS.CITATION_VERIFIER.quotaFallbackModel || null, STEP_CONTRACTS.VALIDATE.quotaFallbackModel || null);
});

// ---- 2. servableFor ----------------------------------------------------------------------------

test('servableFor: the step model first; the quota fallback exactly when accounts.quotaFallbackServable says so; nothing looser', () => {
  const dir = pool();
  const now = Date.now();
  const judge = { step: 'VALIDATE', model: 'fable', quotaFallbackModel: OPUS_5_5 };
  // accounts.quotaFallbackServable (#277 F1, the one condition callLlmStep's two triggers ask) is
  // injected here so each branch of the rule is pinned on its own; the REAL function is exercised
  // below, by the agreement tests and by the agreement matrix.
  const servable = (answer) => ({ ...accounts, quotaFallbackServable: () => answer });

  assert.deepEqual(
    servableFor(judge, dir, now, servable(true)),
    { model: 'fable', healthy: 2, viaFallback: false, fallbackConsidered: false },
    'Fable healthy: the fallback is never asked'
  );

  accounts.writeState(dir, { acct0: { byModel: { fable: { cooldownUntil: now + HOUR_MS } } }, acct1: { byModel: { fable: { cooldownUntil: now + HOUR_MS } } } });
  assert.deepEqual(servableFor(judge, dir, now, servable(true)), { model: OPUS_5_5, healthy: 2, viaFallback: true, fallbackConsidered: true });
  assert.deepEqual(
    servableFor(judge, dir, now, servable(false)),
    { model: 'fable', healthy: 0, viaFallback: false, fallbackConsidered: true },
    'the worker would not switch: held'
  );
  assert.equal(servableFor({ ...judge, quotaFallbackModel: null }, dir, now, servable(true)).healthy, 0, 'no fallback declared, none taken');
  // The real predicate on that pool: Fable out everywhere (no recorded scope), Opus 5.5 healthy on both.
  assert.deepEqual(servableFor(judge, dir, now), { model: OPUS_5_5, healthy: 2, viaFallback: true, fallbackConsidered: true }, '#277 F1: whatever the reason');

  // Only ONE account can serve the fallback model: the count is that one, not the pool size.
  accounts.writeState(dir, {
    acct0: { byModel: { fable: { cooldownUntil: now + HOUR_MS }, [OPUS_5_5]: { cooldownUntil: now + HOUR_MS } } },
    acct1: { byModel: { fable: { cooldownUntil: now + HOUR_MS } } },
  });
  assert.deepEqual(servableFor(judge, dir, now), { model: OPUS_5_5, healthy: 1, viaFallback: true, fallbackConsidered: true });

  // A plain PLAN call counts its own model, whatever else is cooling.
  assert.equal(servableFor({ step: 'PLAN', model: OPUS_5_5, quotaFallbackModel: null }, dir, now).healthy, 1);
});

test('servableFor: an account-wide limit (#250 limitScope "account") cools every model, so it starves a fresh card AND a judge with a fallback', () => {
  const dir = pool();
  for (const name of ['acct0', 'acct1']) accounts.markLimit(dir, name, 'usage', Date.now(), { model: 'fable', limitScope: 'account' });
  const now = Date.now();
  for (const model of accounts.KNOWN_MODELS) assert.equal(accounts.countHealthyAccounts(dir, now, model), 0, `premise: ${model} cooled by an account-wide limit`);
  assert.equal(servableFor(nextLlmCallForTask({}, null, REAL), dir, now).healthy, 0, 'a fresh card');
  const judge = { step: 'VALIDATE', model: 'fable', quotaFallbackModel: OPUS_5_5 };
  assert.equal(accounts.quotaFallbackServable(dir, 'fable', OPUS_5_5, now), false, 'premise: no account has Opus 5.5 either');
  assert.deepEqual(
    servableFor(judge, dir, now),
    { model: 'fable', healthy: 0, viaFallback: false, fallbackConsidered: true },
    'a judge: held, its fallback considered but not servable (#166 decision 4)'
  );
});

// ---- 3. agreement with the worker's first call ---------------------------------------------

function initMessage() {
  return { type: 'system', subtype: 'init', session_id: 'sess-166-clamp', apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}
function reply(resultObj) {
  return [
    initMessage(),
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      session_id: 'sess-166-clamp',
      modelUsage: { x: { inputTokens: 1, outputTokens: 1 } },
      result: JSON.stringify(resultObj),
      terminal_reason: 'success',
      api_error_status: null,
    },
  ];
}
const VALID_PLAN = {
  ok: true,
  plan_markdown: '# Plan\n',
  invariants_markdown: '# Invariants\n\nINV-1: x\n',
  invariant_ids: ['INV-1'],
  check_commands: ['npm run typecheck'],
};
const VALID_VERDICT = { verdict: 'PASS', reasons: [], findings: [], entries: [] };

// Records the --model of every call the SDK really launches, off the argv it built.
function recordingSpawn(lines) {
  const models = [];
  function spawn(command, args, opts) {
    models.push(args[args.indexOf('--model') + 1]);
    return fakeSpawnedChild(lines, { signal: opts && opts.signal });
  }
  spawn.models = models;
  return spawn;
}

function cardTask(extra = {}) {
  return {
    id: 'c-166',
    kind: 'card',
    issue: 166,
    title: 'model-aware clamp agreement',
    criterion: 'the clamp and the lease name one model',
    worktreePath: mkTmp('spo-166-agree-wt-'),
    size: 'S',
    citations: ['AdmMembersRDO.pas:512'],
    ...extra,
  };
}

function realCtx(taskDir, poolDir, task, spawn) {
  return buildCtx(task.id, task, taskDir, {
    ...REAL,
    claudeAccountsDir: poolDir,
    stepDeadlineMs: 30000,
    accountLeaseWaitMs: 500,
    accountLeasePollMs: 25,
    deps: fakeExecDeps({ spawn }),
  });
}

function readLlmCallModels(taskDir) {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'llm-call')
    .map((e) => e.model);
}

// The clamp's answer for a queue entry: the model it would admit the card on, or null when it
// would hold it. Exactly what fillSlots' `admit` computes.
function clampModel(queueTask, taskDir, poolDir) {
  const s = servableFor(nextLlmCallForTask(queueTask, taskDir, REAL), poolDir, Date.now());
  return s.healthy > 0 ? s.model : null;
}

// Runs the first LLM call the worker would make and returns its model (null when none launched).
async function firstCallModel(run, spawn, taskDir) {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof ParkSignal)) throw err;
    assert.match(err.reason, /^all-accounts-/, `a first call that did not launch must be a pool park, got ${err.reason}`);
  }
  const argvModel = spawn.models.length > 0 ? spawn.models[0] : null;
  const journalled = readLlmCallModels(taskDir);
  assert.equal(journalled.length > 0 ? journalled[0] : null, argvModel, 'the llm-call event names the argv model');
  return argvModel;
}

const PLAN_CASES = [
  { name: 'fresh card, healthy pool', setup: () => {}, expected: OPUS_5_5 },
  { name: 'fresh card, Fable model-limited on every account', setup: (p) => modelLimitEverywhere(p, 'fable'), expected: OPUS_5_5 },
  { name: 'fresh card, Opus 5.5 limited on one account of two', setup: (p) => modelLimitEverywhere(p, OPUS_5_5, ['acct0']), expected: OPUS_5_5 },
  { name: 'fresh card, Opus 5.5 limited on every account', setup: (p) => modelLimitEverywhere(p, OPUS_5_5), expected: null },
  { name: 'after a plan-invalid park, healthy pool', planInvalidPark: true, setup: () => {}, expected: 'fable' },
  { name: 'after a plan-invalid park, Fable limited everywhere', planInvalidPark: true, setup: (p) => modelLimitEverywhere(p, 'fable'), expected: null },
];

for (const c of PLAN_CASES) {
  test(`agreement, PLAN (through handlePlan): ${c.name} -- the clamp's model is the first call's --model`, async () => {
    const poolDir = pool();
    c.setup(poolDir);
    const taskDir = mkTmp('spo-166-agree-plan-');
    if (c.planInvalidPark) appendEvent(taskDir, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });
    const task = cardTask();

    const clamp = clampModel(task, taskDir, poolDir);
    assert.equal(clamp, c.expected, 'the clamp');

    const spawn = recordingSpawn(reply(VALID_PLAN));
    const first = await firstCallModel(() => HANDLERS.PLAN(realCtx(taskDir, poolDir, task, spawn)), spawn, taskDir);
    assert.equal(first, clamp, 'the worker must launch its first call on exactly the model the clamp admitted it on (null: never launched)');
  });
}

const JUDGE_CASES = [
  { name: 'healthy pool', setup: () => {} },
  // A hand-written task.json carrying the transient fallback signal: callLlmStep drops it before
  // the first call, so that call is on Fable -- and the clamp must say Fable too.
  { name: 'healthy pool, task carries quotaFallbackStep', setup: () => {}, extra: { quotaFallbackStep: 'VALIDATE' }, steps: ['VALIDATE'] },
  { name: 'Fable MODEL-limited on every account (the judge quota fallback case)', setup: (p) => modelLimitEverywhere(p, 'fable'), expected: OPUS_5_5 },
  // SPO-Pipeline#277: one account with Fable left is enough -- the worker judges on Fable there, never
  // on the fallback, and the clamp admits the card on Fable (not on Opus 5.5, not held).
  { name: 'Fable MODEL-limited on one account of two, the other healthy (#277)', setup: (p) => modelLimitEverywhere(p, 'fable', ['acct0']), expected: 'fable' },
  {
    name: 'Fable MODEL-limited on two accounts of three, the third healthy (#277)',
    names: ['acct0', 'acct1', 'acct2'],
    setup: (p) => modelLimitEverywhere(p, 'fable', ['acct0', 'acct1']),
    expected: 'fable',
  },
  {
    name: 'Fable cooling everywhere with no recorded scope (a pre-#166 record)',
    setup: (p) => {
      const until = Date.now() + HOUR_MS;
      accounts.writeState(p, { acct0: { byModel: { fable: { cooldownUntil: until } } }, acct1: { byModel: { fable: { cooldownUntil: until } } } });
    },
    expected: OPUS_5_5, // #277 F1: no Fable anywhere, whatever the reason, and Opus 5.5 on both
  },
  {
    name: 'an account-wide limit on every account',
    setup: (p) => {
      for (const n of ['acct0', 'acct1']) accounts.markLimit(p, n, 'usage', Date.now(), { model: 'fable', limitScope: 'account' });
    },
    expected: null, // no Opus 5.5 anywhere either: held, and the worker parks (#166 decision 4)
  },
  {
    name: 'Fable model-limited on one account, account-wide on the other',
    setup: (p) => {
      accounts.markLimit(p, 'acct0', 'usage', Date.now(), { model: 'fable', limitScope: 'model' });
      accounts.markLimit(p, 'acct1', 'usage', Date.now(), { model: 'fable', limitScope: 'account' });
    },
    expected: OPUS_5_5, // #277 F1: the fallback lands on acct0, which still has Opus 5.5
  },
];

for (const c of JUDGE_CASES) {
  for (const step of c.steps || ['CITATION_VERIFIER', 'VALIDATE']) {
    test(`agreement, resume at CHECK -> ${step} (through callLlmStep): ${c.name}`, async () => {
      const poolDir = pool(c.names);
      c.setup(poolDir);
      const taskDir = mkTmp('spo-166-agree-judge-');
      // VALIDATE's prompt reads the plan's paths back from the journal: a resumed card has them.
      appendEvent(taskDir, 'PLAN', 'result', {
        payload: { plan_path: '/p', invariants_path: '/i', invariant_ids: ['INV-1'], check_commands: ['x'] },
      });
      const task = cardTask({ resume: resumeDescriptor(), ...(c.extra || {}) });

      const clamp = clampModel(task, taskDir, poolDir);
      if (c.expected !== undefined) assert.equal(clamp, c.expected, 'the clamp');
      const spawn = recordingSpawn(reply(VALID_VERDICT));
      // callLlmStep is the one function both judge steps' calls go through (handleValidate calls it
      // with these two step names); VALIDATE's scripted preamble (board move, judge inputs) makes
      // no call and is not what is being agreed on. In the Fable-model-limited case the worker's
      // first launched call is on the quota fallback model, and so must the clamp's answer be.
      const first = await firstCallModel(() => callLlmStep(realCtx(taskDir, poolDir, task, spawn), step, `llm.${step}`, fakeExecDeps({ spawn })), spawn, taskDir);
      assert.equal(first, clamp, `the clamp said ${clamp}, the worker's first ${step} call launched on ${first}`);
    });
  }
}

// ---- 4. the agreement MATRIX (SPO-Pipeline#277 verifier finding F1) ------------------------------
//
// Every per-account combination of seven Fable/Opus 5.5 states (a Fable 529 among them: not out of
// quota, so it holds the fallback back; and #277's `acct-wide-divergent` account-wide history), over
// 2 and 3 accounts, for both
// judge steps: the clamp's model must be the worker's first call's `--model`, and "held" must mean
// the first call never launches. The hand-picked JUDGE_CASES above are a sample of this; the
// matrix is what makes "the clamp changes IN STEP with the worker" a checked property rather than
// a claim. Each state is written through the real markLimit (or, for the unscoped one, the pre-#166
// shape a real state.json can still hold).
const ACCOUNT_STATES = {
  healthy: () => {},
  'fable-model-limit': (p, n) => accounts.markLimit(p, n, 'usage', Date.now(), { model: 'fable', limitScope: 'model' }),
  'fable-unscoped': (p, n) => {
    const state = accounts.readState(p);
    state[n] = { byModel: { ...((state[n] && state[n].byModel) || {}), fable: { cooldownUntil: Date.now() + HOUR_MS } } };
    accounts.writeState(p, state);
  },
  'fable-529': (p, n) => accounts.markLimit(p, n, 'overloaded', Date.now(), { model: 'fable', limitScope: 'model' }),
  'opus-5-5-model-limit': (p, n) => accounts.markLimit(p, n, 'usage', Date.now(), { model: OPUS_5_5, limitScope: 'model' }),
  'account-wide': (p, n) => accounts.markLimit(p, n, 'usage', Date.now(), { model: 'fable', limitScope: 'account' }),
  // #277 re-verification finding 1: a Fable model limit, then an account-wide one, both 1.01 h ago
  // -- Fable's own history escalates it; the account-wide window must still end every model at once.
  'acct-wide-divergent': (p, n) => {
    const t0 = Date.now() - 1.01 * HOUR_MS;
    accounts.markLimit(p, n, 'usage', t0, { model: 'fable', limitScope: 'model' });
    accounts.markLimit(p, n, 'usage', t0, { model: 'fable', limitScope: 'account' });
  },
};

function combos(n) {
  const names = Object.keys(ACCOUNT_STATES);
  let out = [[]];
  for (let i = 0; i < n; i++) out = out.flatMap((prefix) => names.map((s) => [...prefix, s]));
  return out;
}

for (const size of [2, 3]) {
  for (const step of ['CITATION_VERIFIER', 'VALIDATE']) {
    test(`agreement MATRIX, ${size} accounts, resume at CHECK -> ${step}: the clamp's model is the worker's first --model for every per-account Fable/Opus 5.5 state`, { timeout: 120000 }, async () => {
      const names = Array.from({ length: size }, (_, i) => `acct${i}`);
      const mismatches = [];
      const outcomes = { fable: 0, [OPUS_5_5]: 0, held: 0 };
      for (const combo of combos(size)) {
        const poolDir = pool(names);
        combo.forEach((state, i) => ACCOUNT_STATES[state](poolDir, names[i]));
        const taskDir = mkTmp('spo-277-matrix-');
        appendEvent(taskDir, 'PLAN', 'result', {
          payload: { plan_path: '/p', invariants_path: '/i', invariant_ids: ['INV-1'], check_commands: ['x'] },
        });
        const task = cardTask({ resume: resumeDescriptor() });
        const clamp = clampModel(task, taskDir, poolDir);
        const spawn = recordingSpawn(reply(VALID_VERDICT));
        const first = await firstCallModel(
          () => callLlmStep(realCtx(taskDir, poolDir, task, spawn), step, `llm.${step}`, fakeExecDeps({ spawn })),
          spawn,
          taskDir
        );
        if (first !== clamp) mismatches.push(`${combo.join(' / ')}: clamp ${clamp}, worker ${first}`);
        outcomes[clamp === null ? 'held' : clamp] += 1;
      }
      assert.deepEqual(mismatches, [], 'clamp and worker disagree');
      // The matrix exercises all three answers, so an agreement that holds only because one branch
      // is never reached cannot pass.
      for (const [outcome, count] of Object.entries(outcomes)) assert.ok(count > 0, `no combination answered ${outcome}`);
    });
  }
}
