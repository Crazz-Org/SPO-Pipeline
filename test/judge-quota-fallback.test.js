'use strict';
// SPO-Pipeline#166, action 1 -- the JUDGE QUOTA FALLBACK (maintainer decision, 2026-09-24).
//
// When NO enabled account has Fable QUOTA left -- a model limit, a session or weekly window, a
// cooldown with no recorded kind; a 529 overload does NOT count (Fable back within minutes) --
// VALIDATE and CITATION_VERIFIER retry on claude-opus-5-5, on an account that has Opus 5.5 quota,
// instead of pool-waiting (the judge rule yields under quota pressure). A
// limit on ONE account first rotates on Fable to the next account that still has it
// (SPO-Pipeline#277 and its verifier finding F1, maintainer decision 2026-09-25). A pool with no
// Opus 5.5 either -- every account account-wide limited -- never falls back (#166 decision 4); no
// other step ever changes model on a limit. See
// state-machine.js's callLlmStep header for the two triggers, step-contracts.js's STEP_CONTRACTS
// preamble for `quotaFallbackModel`, and EXP-JUDGE-QUOTA-FALLBACK in doc/model-experiments.md.
//
// Every call below goes through the REAL vendored query() with a fake child: a limited child
// replays a stream of test/fixtures/sdk-cli-exit1-error-results.json and EXITS 1, as the real CLI
// does after an error `result` (card #254/#250's harness -- test/limit-scope.test.js). What is
// asserted is where each call spawned: the account (off CLAUDE_CONFIG_DIR) and the model (off the
// argv's `--model`). Part 4 severs the dispatch: the same fallback reached through drainQueueOnce ->
// runTask -> handleValidate, with the verdict events that mark it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp, writePoolDir, fakeSpawnedChild, fakeExecDeps } = require('./helpers');

// Must land before the orchestrator requires below -- see test/no-real-spawn.js.
require('./no-real-spawn');

const { loadQuery } = require('../orchestrator/sdk');
const accounts = require('../orchestrator/accounts');
const { callLlmStep, buildCtx, drainQueueOnce } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { runLlm, resolveCallModel, resolveQuotaFallbackModel } = require('../orchestrator/steps/llm');
const { STEP_CONTRACTS, OPUS_5_5, resolveStepContract } = require('../orchestrator/step-contracts');
const { appendEvent } = require('../orchestrator/journal');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk-cli-exit1-error-results.json'), 'utf8'));
const STREAMS = { ...FIXTURE.streams, ...FIXTURE.limitScopeSyntheticStreams };
const INIT_LINE = FIXTURE.streams.five_hour[0];
const SESSION_ID = INIT_LINE.session_id;
const JUDGE_STEPS = ['VALIDATE', 'CITATION_VERIFIER'];
const HOUR = 60 * 60 * 1000;

// One reply that satisfies every step's outputContract, so a test can drive any step through the
// real runLlm contract branch without a per-step fixture.
const ANY_STEP_PAYLOAD = {
  verdict: 'PASS',
  reasons: [],
  findings: [],
  entries: [],
  plan_markdown: '# plan',
  invariants_markdown: '# invariants',
  invariant_ids: [],
  check_commands: [],
  summary: 'done',
  files_changed: [],
  invariants: [],
  tests_run: [],
  all_green: true,
  root_cause: 'none',
};

function okLines(payload = ANY_STEP_PAYLOAD) {
  return [
    INIT_LINE,
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      duration_ms: 900,
      session_id: SESSION_ID,
      modelUsage: { [OPUS_5_5]: { inputTokens: 10, outputTokens: 5 } },
      result: JSON.stringify(payload),
    },
  ];
}

// card #254's spy around the REAL vendored query(): records whether the stream threw (the SDK does,
// on the child's exit 1), so each test can assert its limited call went the real way.
async function spyingQuery() {
  const realQuery = await loadQuery();
  const spies = [];
  const query = (args) => {
    const spy = { threw: null };
    spies.push(spy);
    const stream = realQuery(args);
    return (async function* () {
      try {
        for await (const message of stream) yield message;
      } catch (err) {
        spy.threw = err;
        throw err;
      }
    })();
  };
  return { query, spies };
}

// poolSpawn(limitedFor) -- a `deps.spawn` for the whole pool. `limitedFor(account, model)` names the
// FIXTURE stream that (account, model) answers with (the child then exits 1), or a falsy value for
// an ok reply. `calls` records [account, model] per spawn, in order.
function poolSpawn(limitedFor) {
  const calls = [];
  const spawn = (command, args, spawnOpts) => {
    const account = path.basename(spawnOpts.env.CLAUDE_CONFIG_DIR);
    const i = args.indexOf('--model');
    const model = i >= 0 ? args[i + 1] : undefined;
    calls.push([account, model]);
    const streamName = limitedFor(account, model);
    if (streamName) return fakeSpawnedChild(STREAMS[streamName], { exitCode: 1, signal: spawnOpts.signal });
    return fakeSpawnedChild(okLines(), { signal: spawnOpts.signal });
  };
  return { spawn, calls };
}

function twoAccountPool(prefix) {
  return writePoolDir(mkTmp(prefix), [{ name: 'acct-a' }, { name: 'acct-b' }]);
}

// A card-shaped task every step's prompt template can fill (test/accounts-per-model-cooldown.test.js's
// shape); makeCtx seeds IMPLEMENT's PLAN-output prerequisite in the journal.
function cardTask(extra = {}) {
  return {
    id: 't-166-card',
    kind: 'card',
    issue: 1,
    title: 'judge quota fallback probe',
    criterion: 'the judge falls back on a Fable model limit',
    worktreePath: path.join(mkTmp('spo-166-wt-'), 'wt'),
    size: 'S',
    citations: ['AdmMembersRDO.pas:512'],
    ...extra,
  };
}

function makeCtx(accountsDir, task) {
  const taskDir = mkTmp('spo-166-taskdir-');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { plan_path: 'plan.md', invariants_path: 'invariants.md', invariant_ids: ['INV-1'], check_commands: ['x'] },
  });
  const ctx = buildCtx(task.id, task, taskDir, {
    shadowMode: false,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
    // Never inherit config.js's real 5-minute lease bound (test/account-rotation.test.js's reason).
    accountLeaseWaitMs: 2000,
    accountLeasePollMs: 25,
  });
  return { ctx, taskDir };
}

function journal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const eventsNamed = (taskDir, name) => journal(taskDir).filter((e) => e.event === name);

// The fields of a model-fallback event this card specifies, without the journal's own ts/state.
function fallbackFields(e) {
  const { step, from, to, cause, trigger, account, rateLimitType } = e;
  return { step, from, to, cause, trigger, account, rateLimitType };
}

// ---- 1. the contract --------------------------------------------------------------------------

test('#166 contract: exactly VALIDATE and CITATION_VERIFIER declare a quotaFallbackModel, claude-opus-5-5; every other step has none', () => {
  const declared = Object.entries(STEP_CONTRACTS)
    .filter(([, def]) => def.quotaFallbackModel !== undefined)
    .map(([step, def]) => [step, def.quotaFallbackModel])
    .sort();
  assert.deepEqual(declared, [
    ['CITATION_VERIFIER', OPUS_5_5],
    ['VALIDATE', OPUS_5_5],
  ]);
  assert.equal(OPUS_5_5, 'claude-opus-5-5');
  for (const step of JUDGE_STEPS) {
    assert.equal(STEP_CONTRACTS[step].baseModel, 'fable', `${step}: premise -- the judge runs on Fable`);
    assert.equal(STEP_CONTRACTS[step].escalatedModel, null, `${step}: a field distinct from the task-shape escalation slot`);
  }
  assert.equal(STEP_CONTRACTS.PLAN.escalatedModel, 'fable', "PLAN's escalation slot is plan-invalid's, untouched");
  assert.ok(accounts.KNOWN_MODELS.includes(OPUS_5_5), "the fallback model is in markLimit's no-model fail-safe");
});

test('#166 resolveStepContract: task.quotaFallbackStep moves only the NAMED judge step, to its quotaFallbackModel, and never its effort', () => {
  for (const step of JUDGE_STEPS) {
    const base = resolveStepContract(step, { size: 'S' });
    const armed = resolveStepContract(step, { size: 'S', quotaFallbackStep: step });
    assert.equal(base.model, 'fable');
    assert.equal(base.quotaFallback, false);
    assert.equal(armed.model, OPUS_5_5);
    assert.equal(armed.quotaFallback, true);
    assert.equal(armed.effort, base.effort, `${step}: the fallback keeps the contract's effort`);
  }
  const xhigh = resolveStepContract('VALIDATE', { rdoDiffTouched: true, quotaFallbackStep: 'VALIDATE' });
  assert.deepEqual([xhigh.model, xhigh.effort], [OPUS_5_5, 'xhigh'], 'the RDO-diff path stays xhigh on the fallback');
  assert.equal(resolveStepContract('VALIDATE', { quotaFallbackStep: 'CITATION_VERIFIER' }).model, 'fable', 'armed for the OTHER judge step');
  for (const step of Object.keys(STEP_CONTRACTS).filter((s) => !JUDGE_STEPS.includes(s))) {
    const armed = resolveStepContract(step, { size: 'S', quotaFallbackStep: step });
    assert.equal(armed.model, resolveStepContract(step, { size: 'S' }).model, `${step}: no quotaFallbackModel, the signal is ignored`);
    assert.equal(armed.quotaFallback, false);
  }
  assert.equal(resolveStepContract('PLAN', { planInvalidRetry: true, quotaFallbackStep: 'PLAN' }).model, 'fable');
});

test('#166 resolveQuotaFallbackModel: the contract field for a judge step; null for every other step and for a legacy override', () => {
  const ctxFor = (task) => ({ task });
  for (const step of JUDGE_STEPS) assert.equal(resolveQuotaFallbackModel(ctxFor(cardTask()), step), OPUS_5_5);
  for (const step of ['PLAN', 'IMPLEMENT', 'DIAGNOSE']) assert.equal(resolveQuotaFallbackModel(ctxFor(cardTask()), step), null);
  const override = { id: 'o', llm: { VALIDATE: { model: 'fable', promptText: 'x' } } };
  assert.equal(resolveQuotaFallbackModel(ctxFor(override), 'VALIDATE'), null, 'an override is honoured verbatim -- nowhere to fall back to');
  assert.equal(resolveQuotaFallbackModel(ctxFor(override), 'CITATION_VERIFIER'), OPUS_5_5, 'the override covers its own step only');
});

test("#166 correspondence: with the signal armed, resolveCallModel equals the --model the REAL query() argv carries", async () => {
  const cases = [
    ['VALIDATE', cardTask({ quotaFallbackStep: 'VALIDATE' })],
    ['VALIDATE', cardTask({ quotaFallbackStep: 'VALIDATE', rdoDiffTouched: true })],
    ['CITATION_VERIFIER', cardTask({ quotaFallbackStep: 'CITATION_VERIFIER' })],
    ['VALIDATE', cardTask()],
  ];
  const seen = [];
  for (const [step, task] of cases) {
    const { ctx } = makeCtx(mkTmp('spo-166-corr-accts-'), task);
    ctx.account = { name: 'acct-a', configDir: null };
    let argv = null;
    const spawn = (command, args, spawnOpts) => {
      argv = args;
      return fakeSpawnedChild(okLines(), { signal: spawnOpts.signal });
    };
    await runLlm(ctx, step, `llm.${step}`, fakeExecDeps({ spawn }));
    const argvModel = argv[argv.indexOf('--model') + 1];
    assert.equal(resolveCallModel(ctx, step), argvModel, `${step}: the lease/cool model is the argv model`);
    seen.push(argvModel);
  }
  assert.deepEqual(seen, [OPUS_5_5, OPUS_5_5, OPUS_5_5, 'fable']);
});

// ---- 2. callLlmStep, trigger (a): the limited call's own result ---------------------------------
//
// Registry order is pick order, so a lease that asks for a model acct-a is still healthy for lands
// on acct-a -- which is what makes the account column of `calls` say which model the LEASE asked
// for, not only which one the argv carried.
//
// SPO-Pipeline#277 (maintainer decision, 2026-09-25): a Fable model limit on ONE account rotates on
// Fable to the next account healthy for it; the switch to claude-opus-5-5 happens only when the
// limit leaves NO enabled account with Fable quota, whatever the reason, and some account still
// has Opus 5.5 (accounts.quotaFallbackServable). Until #277 the
// first test below pinned the opposite -- `[acct-a fable] -> [acct-a opus-5-5]`, "never tries Fable
// on acct-b" -- so a card was judged by the fallback while acct-b still had Fable.

// The model-scoped streams: the recorded Fable limit and the two typed routes of #250's cross-check.
const MODEL_LIMIT_STREAMS = {
  fable: 'seven_day_overage_included',
  no_event_fable_text: null,
  credits_required_error_code: null,
};

for (const step of JUDGE_STEPS) {
  for (const streamName of Object.keys(MODEL_LIMIT_STREAMS)) {
    test(`#277 ${step}: a Fable MODEL limit (${streamName}) on acct-a only -> rotates to acct-b ON FABLE, no model-fallback`, async () => {
      const accountsDir = twoAccountPool('spo-277-rot-');
      const { spawn, calls } = poolSpawn((account, model) => account === 'acct-a' && model === 'fable' && streamName);
      const { query, spies } = await spyingQuery();
      const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

      const result = await callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query }));

      assert.ok(spies[0].threw, 'premise: the SDK threw on the limited child exit 1');
      assert.equal(result.ok, true);
      assert.equal(result.verdict, 'PASS');
      assert.deepEqual(
        calls,
        [
          ['acct-a', 'fable'],
          ['acct-b', 'fable'],
        ],
        'acct-b still has Fable quota: the judge stays on Fable there'
      );
      assert.equal(ctx.account.name, 'acct-b');
      assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), [], 'no switch while an account has Fable');

      const [cooldown, ...moreCooldowns] = eventsNamed(taskDir, 'account-cooldown');
      assert.equal(moreCooldowns.length, 0);
      assert.deepEqual([cooldown.account, cooldown.model, cooldown.models, cooldown.limitScope], ['acct-a', 'fable', ['fable'], 'model']);
      assert.deepEqual(
        eventsNamed(taskDir, 'llm-call').map((e) => [e.account, e.model, e.quotaFallback]),
        [
          ['acct-a', 'fable', undefined],
          ['acct-b', 'fable', undefined],
        ]
      );
      assert.equal(ctx.task.quotaFallbackStep, undefined);
      assert.deepEqual(ctx.lastLlmCall, { step, model: 'fable', quotaFallback: null }, 'the verdict is not fallback-judged');
    });
  }
}

for (const step of JUDGE_STEPS) {
  for (const [streamName, rateLimitType] of Object.entries(MODEL_LIMIT_STREAMS)) {
    test(`#277 ${step}: a Fable MODEL limit (${streamName}) on EVERY account -> the same call retries on claude-opus-5-5, journalled and marked`, async () => {
      const accountsDir = twoAccountPool('spo-277-all-');
      const { spawn, calls } = poolSpawn((account, model) => model === 'fable' && streamName);
      const { query, spies } = await spyingQuery();
      const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

      const result = await callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query }));

      assert.ok(spies[0].threw && spies[1].threw, 'premise: the SDK threw on both limited children');
      assert.equal(result.ok, true);
      assert.equal(result.verdict, 'PASS');
      assert.deepEqual(
        calls,
        [
          ['acct-a', 'fable'],
          ['acct-b', 'fable'],
          ['acct-a', OPUS_5_5],
        ],
        'Fable on every account first; the fallback then leases acct-a again -- its Opus 5.5 quota is untouched'
      );
      assert.equal(ctx.account.name, 'acct-a');

      const [fallback, ...more] = eventsNamed(taskDir, 'model-fallback');
      assert.equal(more.length, 0, 'exactly one switch');
      assert.deepEqual(fallbackFields(fallback), {
        step,
        from: 'fable',
        to: OPUS_5_5,
        cause: 'model-limit',
        trigger: 'limit-result',
        account: 'acct-b', // the result that left no account with Fable
        rateLimitType,
      });
      assert.equal(fallback.state, step);

      assert.deepEqual(
        eventsNamed(taskDir, 'account-cooldown').map((e) => [e.account, e.model, e.models, e.limitScope]),
        [
          ['acct-a', 'fable', ['fable'], 'model'],
          ['acct-b', 'fable', ['fable'], 'model'],
        ]
      );

      const llmCalls = eventsNamed(taskDir, 'llm-call');
      assert.deepEqual(llmCalls.map((e) => [e.model, e.quotaFallback]), [['fable', undefined], ['fable', undefined], [OPUS_5_5, true]]);
      const order = journal(taskDir).map((e) => e.event).filter((e) => ['llm-call', 'account-cooldown', 'model-fallback'].includes(e));
      assert.deepEqual(order, ['llm-call', 'account-cooldown', 'llm-call', 'account-cooldown', 'model-fallback', 'llm-call']);

      for (const name of ['acct-a', 'acct-b']) {
        const byModel = accounts.readState(accountsDir)[name].byModel;
        assert.deepEqual(Object.keys(byModel), ['fable'], `only the Fable quota of ${name} cools`);
        assert.deepEqual([byModel.fable.cooldownScope, byModel.fable.cooldownKind], ['model', 'usage']);
      }

      assert.equal(ctx.task.quotaFallbackStep, undefined, 'the signal never outlives the call');
      assert.deepEqual(ctx.lastLlmCall, { step, model: OPUS_5_5, quotaFallback: { from: 'fable', to: OPUS_5_5 } });
    });
  }
}

// Three accounts: two model-limited on Fable is not "every" -- the third still judges on Fable.
test('#277 VALIDATE, three accounts: acct-a and acct-b model-limited on Fable -> acct-c judges on Fable, no model-fallback', async () => {
  const accountsDir = writePoolDir(mkTmp('spo-277-three-'), [{ name: 'acct-a' }, { name: 'acct-b' }, { name: 'acct-c' }]);
  const { spawn, calls } = poolSpawn((account, model) => account !== 'acct-c' && model === 'fable' && 'fable');
  const { query } = await spyingQuery();
  const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

  const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['acct-a', 'fable'],
    ['acct-b', 'fable'],
    ['acct-c', 'fable'],
  ]);
  assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
  assert.equal(ctx.lastLlmCall.quotaFallback, null);
});

// Mixed pools (#277 verifier finding F1, maintainer decision 2026-09-25): Fable is out on every
// account, NOT from a model limit everywhere -- one account is cooling ACCOUNT-WIDE (session/weekly).
// No account has Fable quota, and the model-limited account still has Opus 5.5, so the judge falls
// back THERE. #166 decision 4 still holds per account: the account-wide limited one cools every
// model, so the fallback never lands on it. (#277's first rule, which counted only model-scoped usage
// cooldowns, parked these.) `calls` ends on the one account healthy for Opus 5.5; `trigger` names
// the account whose result left no Fable anywhere (null: the lease found the pool so).
const MIXED_CASES = [
  {
    name: 'acct-a model limit, then acct-b account-wide limit (both results in this call)',
    limitedFor: (account, model) => model === 'fable' && (account === 'acct-a' ? 'fable' : 'five_hour'),
    calls: [
      ['acct-a', 'fable'],
      ['acct-b', 'fable'],
      ['acct-a', OPUS_5_5],
    ],
    trigger: ['limit-result', 'acct-b'],
  },
  {
    name: 'acct-a account-wide limit, then acct-b model limit (both results in this call)',
    limitedFor: (account, model) => model === 'fable' && (account === 'acct-a' ? 'seven_day' : 'fable'),
    calls: [
      ['acct-a', 'fable'],
      ['acct-b', 'fable'],
      ['acct-b', OPUS_5_5],
    ],
    trigger: ['limit-result', 'acct-b'],
  },
  {
    name: 'acct-b already cooling account-wide on disk, acct-a model limit in this call',
    setup: (dir) => markFable(dir, 'acct-b', 'usage', 'account'),
    limitedFor: (account, model) => account === 'acct-a' && model === 'fable' && 'fable',
    calls: [
      ['acct-a', 'fable'],
      ['acct-a', OPUS_5_5],
    ],
    trigger: ['limit-result', 'acct-a'],
  },
  {
    name: 'acct-a model-limited and acct-b account-wide, both on disk (the lease finds no Fable)',
    setup: (dir) => {
      markFable(dir, 'acct-a', 'usage', 'model');
      markFable(dir, 'acct-b', 'usage', 'account');
    },
    limitedFor: () => null,
    calls: [['acct-a', OPUS_5_5]],
    trigger: ['lease', null],
  },
];

for (const step of JUDGE_STEPS) {
  for (const c of MIXED_CASES) {
    test(`#277 F1 ${step}, mixed pool -- ${c.name}: no Fable anywhere -> falls back onto the account with Opus 5.5`, async () => {
      const accountsDir = twoAccountPool('spo-277-mixed-');
      if (c.setup) c.setup(accountsDir);
      const { spawn, calls } = poolSpawn(c.limitedFor);
      const { query } = await spyingQuery();
      const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

      const result = await callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query }));

      assert.equal(result.ok, true);
      assert.deepEqual(calls, c.calls);
      assert.deepEqual(
        eventsNamed(taskDir, 'model-fallback').map((e) => [e.trigger, e.account, e.from, e.to, e.cause]),
        [[...c.trigger, 'fable', OPUS_5_5, 'model-limit']],
        'exactly one switch'
      );
      assert.deepEqual(ctx.lastLlmCall, { step, model: OPUS_5_5, quotaFallback: { from: 'fable', to: OPUS_5_5 } }, 'the verdict is marked');
      assert.equal(ctx.task.quotaFallbackStep, undefined);
    });
  }
}

// Every account ACCOUNT-WIDE limited: no account has Fable, and none has Opus 5.5 either (an
// account-wide limit cools every model) -- switching model cannot get around it (#166 decision 4).
// No switch, no `model-fallback`, the pre-#166 park exactly, whether the limits come back in this
// call or are already on disk; 2 and 3 accounts.
const ALL_ACCOUNT_WIDE_CASES = [
  {
    name: '2 accounts, both results in this call',
    names: ['acct-a', 'acct-b'],
    limitedFor: (account, model) => model === 'fable' && (account === 'acct-a' ? 'five_hour' : 'seven_day'),
    calls: [
      ['acct-a', 'fable'],
      ['acct-b', 'fable'],
    ],
    reason: (r) => r === 'all-accounts-cooling-after-retry',
  },
  {
    name: '3 accounts, all results in this call',
    names: ['acct-a', 'acct-b', 'acct-c'],
    limitedFor: (account, model) => model === 'fable' && 'five_hour',
    calls: [
      ['acct-a', 'fable'],
      ['acct-b', 'fable'],
      ['acct-c', 'fable'],
    ],
    reason: (r) => r === 'all-accounts-cooling-after-retry',
  },
  {
    name: '2 accounts, both on disk',
    names: ['acct-a', 'acct-b'],
    setup: (dir) => {
      markFable(dir, 'acct-a', 'usage', 'account');
      markFable(dir, 'acct-b', 'usage', 'account');
    },
    limitedFor: () => null,
    calls: [],
    reason: (r) => r.startsWith('all-accounts-cooling-until-'),
  },
];

for (const step of JUDGE_STEPS) {
  for (const c of ALL_ACCOUNT_WIDE_CASES) {
    test(`#277 F1 ${step}, every account ACCOUNT-WIDE limited (${c.name}): no Opus 5.5 anywhere either -> no fallback, parks as before #166`, async () => {
      const accountsDir = writePoolDir(
        mkTmp('spo-277-allwide-'),
        c.names.map((name) => ({ name }))
      );
      if (c.setup) c.setup(accountsDir);
      const { spawn, calls } = poolSpawn(c.limitedFor);
      const { query } = await spyingQuery();
      const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

      await assert.rejects(
        () => callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query })),
        (err) => err instanceof ParkSignal && c.reason(err.reason) && !('quotaFallback' in (err.detail || {}))
      );
      assert.deepEqual(calls, c.calls, 'never an Opus 5.5 call');
      assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
      assert.equal(ctx.task.quotaFallbackStep, undefined);
    });
  }
}

// Three accounts, each out of Fable for a DIFFERENT reason (a session window, a weekly window, a
// Fable model limit): only acct-c keeps Opus 5.5, and the fallback lands there.
test('#277 F1 VALIDATE, three accounts out of Fable for three reasons -> falls back onto the one account with Opus 5.5', async () => {
  const accountsDir = writePoolDir(mkTmp('spo-277-three-mixed-'), [{ name: 'acct-a' }, { name: 'acct-b' }, { name: 'acct-c' }]);
  const streamFor = { 'acct-a': 'five_hour', 'acct-b': 'seven_day', 'acct-c': 'fable' };
  const { spawn, calls } = poolSpawn((account, model) => model === 'fable' && streamFor[account]);
  const { query } = await spyingQuery();
  const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

  const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['acct-a', 'fable'],
    ['acct-b', 'fable'],
    ['acct-c', 'fable'],
    ['acct-c', OPUS_5_5],
  ]);
  assert.deepEqual(eventsNamed(taskDir, 'model-fallback').map((e) => [e.trigger, e.account]), [['limit-result', 'acct-c']]);
});

// A 529 in THIS call is not quota either: the last account's 529 leaves its Fable coming back within
// minutes, so the call parks (and pool-waits) instead of switching -- whether acct-a before it was
// out of Fable quota or 529'd too.
const RESULT_529_CASES = [
  { name: 'acct-a model limit, then acct-b 529', limitedFor: (account, model) => model === 'fable' && (account === 'acct-a' ? 'fable' : 'overloaded') },
  { name: 'acct-a 529, then acct-b model limit', limitedFor: (account, model) => model === 'fable' && (account === 'acct-a' ? 'overloaded' : 'fable') },
  { name: '529 on both', limitedFor: (account, model) => model === 'fable' && 'overloaded' },
];

for (const step of JUDGE_STEPS) {
  for (const c of RESULT_529_CASES) {
    test(`#277 ${step}, a 529 is not quota -- ${c.name}: no fallback, parks all-accounts-cooling-after-retry`, async () => {
      const accountsDir = twoAccountPool('spo-277-529-');
      const { spawn, calls } = poolSpawn(c.limitedFor);
      const { query } = await spyingQuery();
      const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

      await assert.rejects(
        () => callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query })),
        (err) => err instanceof ParkSignal && err.reason === 'all-accounts-cooling-after-retry' && !('quotaFallback' in err.detail)
      );
      assert.deepEqual(calls, [
        ['acct-a', 'fable'],
        ['acct-b', 'fable'],
      ]);
      assert.ok(eventsNamed(taskDir, 'account-cooldown').some((e) => e.limitKind === 'overloaded'), 'premise: a 529 was cooled');
      assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
    });
  }
}

// Account-wide limits: the recorded session and weekly windows, an explicit five_hour window whose
// assistant line also carries the model api_error (the account window wins), and the fail-safe
// shape (no rejected event, no typed cause).
const ACCOUNT_WIDE_STREAMS = ['five_hour', 'seven_day', 'five_hour_with_model_api_error', 'no_event_no_api_error'];

for (const step of JUDGE_STEPS) {
  for (const streamName of ACCOUNT_WIDE_STREAMS) {
    test(`#166 ${step}: an ACCOUNT-WIDE limit (${streamName}) on acct-a, acct-b healthy -> rotation on Fable, no fallback`, async () => {
      const accountsDir = twoAccountPool('spo-166-acct-');
      const { spawn, calls } = poolSpawn((account) => account === 'acct-a' && streamName);
      const { query, spies } = await spyingQuery();
      const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

      const result = await callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query }));

      assert.ok(spies[0].threw, 'premise: the SDK threw on the limited child exit 1');
      assert.equal(result.ok, true);
      assert.deepEqual(calls, [
        ['acct-a', 'fable'],
        ['acct-b', 'fable'],
      ]);
      assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
      assert.equal(eventsNamed(taskDir, 'account-cooldown')[0].limitScope, 'account', 'premise: classified account-wide');
      assert.equal(ctx.lastLlmCall.quotaFallback, null);
    });
  }
}

test('#166 VALIDATE: an overloaded 529 on acct-a, acct-b healthy -> no fallback, its 5-minute cooldown and rotation on Fable unchanged', async () => {
  const accountsDir = twoAccountPool('spo-166-529-');
  const { spawn, calls } = poolSpawn((account, model) => account === 'acct-a' && model === 'fable' && 'overloaded');
  const { query } = await spyingQuery();
  const { ctx, taskDir } = makeCtx(accountsDir, cardTask());
  await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));
  assert.deepEqual(calls, [
    ['acct-a', 'fable'],
    ['acct-b', 'fable'],
  ]);
  const [cooldown] = eventsNamed(taskDir, 'account-cooldown');
  assert.deepEqual([cooldown.limitKind, cooldown.limitScope], ['overloaded', 'model'], 'premise: a model-scoped result, but not a usage one');
  assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
});

// Every other step: a model limit on the step's own model rotates on that model, as before. PLAN
// escalated to Fable (planInvalidRetry) is the sharp case -- a Fable model limit on a step with no
// quotaFallbackModel -- and a legacy override naming Fable at VALIDATE is honoured verbatim.
const NON_JUDGE_CASES = [
  { name: 'PLAN (claude-opus-5-5)', step: 'PLAN', task: cardTask(), model: OPUS_5_5 },
  { name: 'PLAN escalated by planInvalidRetry (fable)', step: 'PLAN', task: cardTask({ planInvalidRetry: true }), model: 'fable' },
  { name: 'IMPLEMENT (claude-opus-5-5)', step: 'IMPLEMENT', task: cardTask(), model: OPUS_5_5 },
  { name: 'DIAGNOSE (claude-opus-5-5)', step: 'DIAGNOSE', task: cardTask(), model: OPUS_5_5 },
  {
    name: 'VALIDATE on the legacy override branch (fable)',
    step: 'VALIDATE',
    task: { id: 't-166-ovr', llm: { VALIDATE: { model: 'fable', effort: 'medium', promptText: 'check it' } } },
    model: 'fable',
  },
];

for (const c of NON_JUDGE_CASES) {
  test(`#166 no fallback for ${c.name}: a model limit rotates on the same model`, async () => {
    const accountsDir = twoAccountPool('spo-166-nonjudge-');
    const { spawn, calls } = poolSpawn((account, model) => account === 'acct-a' && model === c.model && 'fable');
    const { query, spies } = await spyingQuery();
    const { ctx, taskDir } = makeCtx(accountsDir, c.task);
    assert.equal(resolveCallModel(ctx, c.step), c.model, 'premise');

    const result = await callLlmStep(ctx, c.step, `llm.${c.step}`, fakeExecDeps({ spawn, query }));

    assert.ok(spies[0].threw, 'premise: the SDK threw on the limited child exit 1');
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      ['acct-a', c.model],
      ['acct-b', c.model],
    ]);
    assert.equal(eventsNamed(taskDir, 'account-cooldown')[0].limitScope, 'model', 'premise: a model-scoped usage limit');
    assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
  });
}

// ---- 3. the fallback call itself: correspondence, its own limit, no ping-pong --------------------

test('#166 correspondence on the fallback call: lease, argv, cooldown key and llm-call.model all name claude-opus-5-5; its own limit rotates on Opus 5.5, never back to Fable', async () => {
  const accountsDir = twoAccountPool('spo-166-corr-');
  // acct-a is already cooling on sonnet (hand-written, no scope): the fallback call can only land
  // on acct-a if its lease asked for claude-opus-5-5, the one model acct-a is still healthy for
  // once its Fable quota is cooled below.
  accounts.writeState(accountsDir, { 'acct-a': { byModel: { sonnet: { cooldownUntil: Date.now() + HOUR } } } });
  // #277: Fable model-limited on BOTH accounts, so the switch happens (on acct-b's result).
  const { spawn, calls } = poolSpawn((account, model) => {
    if (model === 'fable') return 'fable';
    if (account === 'acct-a' && model === OPUS_5_5) return 'seven_day_opus'; // a model limit on Opus 5.5 too
    return null;
  });
  const { query } = await spyingQuery();
  const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

  const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['acct-a', 'fable'],
    ['acct-b', 'fable'],
    ['acct-a', OPUS_5_5],
    ['acct-b', OPUS_5_5],
  ]);
  const cooldowns = eventsNamed(taskDir, 'account-cooldown');
  assert.deepEqual(
    cooldowns.map((e) => [e.account, e.model, e.models, e.limitScope]),
    [
      ['acct-a', 'fable', ['fable'], 'model'],
      ['acct-b', 'fable', ['fable'], 'model'],
      ['acct-a', OPUS_5_5, [OPUS_5_5], 'model'],
    ],
    'each limit cools the model its call spent'
  );
  const byModel = accounts.readState(accountsDir)['acct-a'].byModel;
  const newlyCooled = Object.keys(byModel).filter((m) => byModel[m].lastUsageLimitAt !== undefined).sort();
  assert.deepEqual(newlyCooled, [OPUS_5_5, 'fable'].sort());
  assert.deepEqual(eventsNamed(taskDir, 'llm-call').map((e) => [e.account, e.model, e.quotaFallback]), [
    ['acct-a', 'fable', undefined],
    ['acct-b', 'fable', undefined],
    ['acct-a', OPUS_5_5, true],
    ['acct-b', OPUS_5_5, true],
  ]);
  assert.equal(eventsNamed(taskDir, 'model-fallback').length, 1, 'one switch, no ping-pong');
  assert.equal(ctx.lastLlmCall.model, OPUS_5_5);
});

test('#166 the pool exhausted on the FALLBACK model parks all-accounts-cooling-after-retry, naming the fallback -- Fable is never retried', async () => {
  const accountsDir = twoAccountPool('spo-166-exhaust-');
  // #277: Fable model-limited on both accounts (the switch), then Opus 5.5 limited on both.
  const { spawn, calls } = poolSpawn((account, model) => {
    if (model === 'fable') return 'fable';
    if (model === OPUS_5_5) return 'seven_day_opus';
    return null;
  });
  const { query } = await spyingQuery();
  const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

  let caught = null;
  try {
    await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ParkSignal, `expected a ParkSignal, got ${caught}`);
  assert.equal(caught.reason, 'all-accounts-cooling-after-retry');
  assert.deepEqual(caught.detail.quotaFallback, { from: 'fable', to: OPUS_5_5 });
  assert.equal(caught.detail.attempts, 4, 'the calls actually made on both models, not the per-model bound (2)');
  assert.deepEqual(calls, [
    ['acct-a', 'fable'],
    ['acct-b', 'fable'],
    ['acct-a', OPUS_5_5],
    ['acct-b', OPUS_5_5],
  ]);
  assert.equal(ctx.task.quotaFallbackStep, undefined, 'the signal is cleared on a throw too');
  assert.equal(eventsNamed(taskDir, 'model-fallback').length, 1);
});

test('#166 a park that never involved the fallback keeps its exact pre-#166 detail (no quotaFallback key)', async () => {
  const accountsDir = twoAccountPool('spo-166-plainpark-');
  const { spawn } = poolSpawn(() => 'five_hour');
  const { query } = await spyingQuery();
  const { ctx } = makeCtx(accountsDir, cardTask());
  await assert.rejects(
    () => callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query })),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'all-accounts-cooling-after-retry' &&
      !('quotaFallback' in err.detail) &&
      err.detail.attempts === 2 // = the pool size, exactly as before #166
  );
});

test('#166 a quotaFallbackStep carried in from task.json is dropped on entry: a healthy pool is judged on Fable, no model-fallback', async () => {
  const accountsDir = twoAccountPool('spo-166-carried-');
  const { spawn, calls } = poolSpawn(() => null);
  const { query } = await spyingQuery();
  const { ctx, taskDir } = makeCtx(accountsDir, cardTask({ quotaFallbackStep: 'VALIDATE' }));
  assert.equal(resolveCallModel(ctx, 'VALIDATE'), OPUS_5_5, 'premise: the carried signal would move the call if honoured');

  const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['acct-a', 'fable']]);
  assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
  assert.deepEqual(eventsNamed(taskDir, 'llm-call').map((e) => [e.model, e.quotaFallback]), [['fable', undefined]]);
  assert.equal(ctx.task.quotaFallbackStep, undefined);
});

// ---- 4. trigger (b): Fable exhausted pool-wide at LEASE time ------------------------------------
//
// The pool state is written through the REAL markLimit, the only writer production has, so the
// records carry exactly the cooldownScope/cooldownKind a real limit leaves behind.

function markFable(accountsDir, name, limitKind, limitScope) {
  accounts.markLimit(accountsDir, name, limitKind, Date.now(), { model: 'fable', limitScope, rateLimitType: null });
}

for (const step of JUDGE_STEPS) {
  test(`#166 ${step}: every account MODEL-limited on Fable -> the lease itself falls back, no Fable call at all`, async () => {
    const accountsDir = twoAccountPool('spo-166-lease-');
    markFable(accountsDir, 'acct-a', 'usage', 'model');
    markFable(accountsDir, 'acct-b', 'usage', 'model');
    const { spawn, calls } = poolSpawn(() => null);
    const { query } = await spyingQuery();
    const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

    const result = await callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query }));

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [['acct-a', OPUS_5_5]]);
    const [fallback, ...more] = eventsNamed(taskDir, 'model-fallback');
    assert.equal(more.length, 0);
    assert.deepEqual(fallbackFields(fallback), {
      step,
      from: 'fable',
      to: OPUS_5_5,
      cause: 'model-limit',
      trigger: 'lease',
      account: null,
      rateLimitType: null,
    });
    assert.deepEqual(eventsNamed(taskDir, 'account-cooldown'), []);
    assert.deepEqual(eventsNamed(taskDir, 'llm-call').map((e) => [e.model, e.quotaFallback]), [[OPUS_5_5, true]]);
    assert.equal(ctx.task.quotaFallbackStep, undefined);
  });
}

// Fable cooling on every account for OTHER reasons than a model limit everywhere. Under #166 these
// parked ("not known to be a model limit"); since #277's verifier finding F1 the only question is
// whether any account has Fable (none does) and whether one has Opus 5.5 -- so the lease falls back
// onto the first account healthy for it, with no Fable call. `fallbackOn` is that account.
const LEASE_FALLBACK_CASES = [
  {
    name: 'records written before #166 (no scope on disk)',
    setup: (dir) =>
      accounts.writeState(dir, {
        'acct-a': { byModel: { fable: { cooldownUntil: Date.now() + HOUR } } },
        'acct-b': { byModel: { fable: { cooldownUntil: Date.now() + HOUR } } },
      }),
    fallbackOn: 'acct-a',
  },
  {
    name: 'one account cooling for an ACCOUNT-WIDE limit, the other for a model limit',
    setup: (dir) => {
      markFable(dir, 'acct-a', 'usage', 'account');
      markFable(dir, 'acct-b', 'usage', 'model');
    },
    fallbackOn: 'acct-b',
  },
  {
    name: 'a model limit later overwritten by an account-wide one on the same account',
    setup: (dir) => {
      markFable(dir, 'acct-a', 'usage', 'model');
      markFable(dir, 'acct-b', 'usage', 'model');
      markFable(dir, 'acct-a', 'usage', 'account');
    },
    fallbackOn: 'acct-b',
  },
];

for (const c of LEASE_FALLBACK_CASES) {
  test(`#277 F1 VALIDATE lease-time -- ${c.name}: no Fable anywhere -> the lease falls back onto ${c.fallbackOn}, no Fable call`, async () => {
    const accountsDir = twoAccountPool('spo-277-leasefb-');
    c.setup(accountsDir);
    const { spawn, calls } = poolSpawn(() => null);
    const { query } = await spyingQuery();
    const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

    const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [[c.fallbackOn, OPUS_5_5]]);
    assert.deepEqual(eventsNamed(taskDir, 'model-fallback').map((e) => [e.trigger, e.account]), [['lease', null]]);
  });
}

// Neither model healthy anywhere at lease time: no switch, the pre-#166 lease park, no call.
// A 529 is not quota (driver refinement of F1, 2026-09-25, on decision 1's "under quota pressure"):
// an account whose Fable cooldown is a 529's has Fable back within minutes, so the judge waits for it
// -- whether every account is 529-cooling or only one is and the others are out of Fable quota.
const LEASE_PARK_CASES = [
  {
    name: 'an overloaded 529 on both (Fable back within minutes, not out of quota)',
    setup: (dir) => {
      markFable(dir, 'acct-a', 'overloaded', 'model');
      markFable(dir, 'acct-b', 'overloaded', 'model');
    },
  },
  {
    name: 'acct-a out of Fable quota (model limit), acct-b 529-cooling',
    setup: (dir) => {
      markFable(dir, 'acct-a', 'usage', 'model');
      markFable(dir, 'acct-b', 'overloaded', 'model');
    },
  },
  {
    name: 'every account ACCOUNT-WIDE limited',
    setup: (dir) => {
      markFable(dir, 'acct-a', 'usage', 'account');
      markFable(dir, 'acct-b', 'usage', 'account');
    },
  },
  {
    name: 'Fable model-limited everywhere, Opus 5.5 cooling everywhere too (no scope on disk)',
    setup: (dir) => {
      markFable(dir, 'acct-a', 'usage', 'model');
      markFable(dir, 'acct-b', 'usage', 'model');
      const state = accounts.readState(dir);
      for (const name of ['acct-a', 'acct-b']) state[name].byModel[OPUS_5_5] = { cooldownUntil: Date.now() + HOUR };
      accounts.writeState(dir, state);
    },
  },
];

for (const c of LEASE_PARK_CASES) {
  test(`#277 F1 VALIDATE lease-time -- ${c.name}: no fallback -> parks all-accounts-cooling-until-*, no call`, async () => {
    const accountsDir = twoAccountPool('spo-277-leasepark-');
    c.setup(accountsDir);
    const { spawn, calls } = poolSpawn(() => null);
    const { query } = await spyingQuery();
    const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

    await assert.rejects(
      () => callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query })),
      (err) => err instanceof ParkSignal && err.reason.startsWith('all-accounts-cooling-until-')
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
  });
}

test('#166 lease-time trigger is judge-only: PLAN escalated to Fable, with Fable model-limited everywhere, parks', async () => {
  const accountsDir = twoAccountPool('spo-166-leaseplan-');
  markFable(accountsDir, 'acct-a', 'usage', 'model');
  markFable(accountsDir, 'acct-b', 'usage', 'model');
  const { spawn, calls } = poolSpawn(() => null);
  const { query } = await spyingQuery();
  const { ctx, taskDir } = makeCtx(accountsDir, cardTask({ planInvalidRetry: true }));
  await assert.rejects(
    () => callLlmStep(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn, query })),
    (err) => err instanceof ParkSignal && err.reason.startsWith('all-accounts-cooling-until-')
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
});

// #277 with part of the limit already ON DISK (an earlier call's cooldown): the lease skips the
// model-limited account and judges on Fable where it is left; when this call's limit is the one
// that completes the pool-wide Fable limit, trigger (a) switches at once, with no extra lease.
for (const step of JUDGE_STEPS) {
  test(`#277 ${step}: acct-a already model-limited on Fable, acct-b healthy -> judged on Fable on acct-b, no model-fallback`, async () => {
    const accountsDir = twoAccountPool('spo-277-disk-');
    markFable(accountsDir, 'acct-a', 'usage', 'model');
    const { spawn, calls } = poolSpawn(() => null);
    const { query } = await spyingQuery();
    const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

    const result = await callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query }));

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [['acct-b', 'fable']]);
    assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
    assert.equal(ctx.lastLlmCall.quotaFallback, null);
  });

  test(`#277 ${step}: acct-a already model-limited on Fable, acct-b limits in this call -> switches on acct-b's result, no second Fable lease`, async () => {
    const accountsDir = twoAccountPool('spo-277-last-');
    markFable(accountsDir, 'acct-a', 'usage', 'model');
    const { spawn, calls } = poolSpawn((account, model) => model === 'fable' && 'fable');
    const { query } = await spyingQuery();
    const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

    const result = await callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query }));

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      ['acct-b', 'fable'],
      ['acct-a', OPUS_5_5],
    ]);
    assert.deepEqual(
      eventsNamed(taskDir, 'model-fallback').map((e) => [e.trigger, e.account]),
      [['limit-result', 'acct-b']],
      'the result that left no Fable anywhere is the trigger -- not a later lease'
    );
    assert.deepEqual(ctx.lastLlmCall, { step, model: OPUS_5_5, quotaFallback: { from: 'fable', to: OPUS_5_5 } });
  });
}

// ---- 5. the accounts.js predicate and the records markLimit writes ------------------------------

test('#166 markLimit records WHY each model is cooling (cooldownScope, cooldownKind), overwritten by every write', () => {
  const dir = writePoolDir(mkTmp('spo-166-mark-'), [{ name: 'acct-a' }]);
  markFable(dir, 'acct-a', 'usage', 'model');
  let byModel = accounts.readState(dir)['acct-a'].byModel;
  assert.deepEqual(Object.keys(byModel), ['fable']);
  assert.deepEqual([byModel.fable.cooldownScope, byModel.fable.cooldownKind], ['model', 'usage']);

  markFable(dir, 'acct-a', 'usage', 'account');
  byModel = accounts.readState(dir)['acct-a'].byModel;
  for (const m of accounts.KNOWN_MODELS) {
    assert.deepEqual([byModel[m].cooldownScope, byModel[m].cooldownKind], ['account', 'usage'], m);
  }

  // #277 re-verification finding 2: a 529 while that quota cooldown is still running neither
  // shortens it nor relabels it -- the longer cooldown wins, with its own kind and scope.
  const before = byModel.fable.cooldownUntil;
  markFable(dir, 'acct-a', 'overloaded', 'model');
  byModel = accounts.readState(dir)['acct-a'].byModel;
  assert.deepEqual([byModel.fable.cooldownUntil, byModel.fable.cooldownScope, byModel.fable.cooldownKind], [before, 'account', 'usage']);

  // Once it has expired, a 529 writes its own 5-minute cooldown and says so.
  const later = before + 1000;
  accounts.markLimit(dir, 'acct-a', 'overloaded', later, { model: 'fable', limitScope: 'model', rateLimitType: null });
  byModel = accounts.readState(dir)['acct-a'].byModel;
  assert.deepEqual([byModel.fable.cooldownScope, byModel.fable.cooldownKind], ['model', 'overloaded']);
  assert.equal(byModel.fable.cooldownUntil, later + 5 * 60 * 1000);
});

// #277 F1 replaced #166's modelLimitedOnEveryAccount and isModelQuotaLimit with this one predicate
// (both deleted: nothing in production read them any more).
test('#277 F1 quotaFallbackServable: no ENABLED account with quota left on the model (a 529 does not count), AND one healthy for the fallback', () => {
  const now = Date.now();
  const dir = writePoolDir(mkTmp('spo-277-servable-'), [{ name: 'acct-a' }, { name: 'acct-b' }, { name: 'acct-c', disabled: true }]);
  const servable = (at = now) => accounts.quotaFallbackServable(dir, 'fable', OPUS_5_5, at);
  assert.equal(servable(), false, 'nothing cooling: Fable is healthy');
  markFable(dir, 'acct-a', 'usage', 'model');
  assert.equal(servable(), false, 'acct-b still has Fable');
  markFable(dir, 'acct-b', 'usage', 'account');
  assert.equal(servable(), true, 'no Fable anywhere (model + account-wide), acct-a still has Opus 5.5; the disabled acct-c does not count');
  markFable(dir, 'acct-a', 'usage', 'account');
  assert.equal(servable(), false, 'every account account-wide limited: no Opus 5.5 either (#166 decision 4)');
  const dir529 = writePoolDir(mkTmp('spo-277-servable-529-'), [{ name: 'acct-a' }, { name: 'acct-b' }]);
  markFable(dir529, 'acct-a', 'overloaded', 'model');
  markFable(dir529, 'acct-b', 'overloaded', 'model');
  assert.equal(accounts.quotaFallbackServable(dir529, 'fable', OPUS_5_5, now), false, 'Fable 529-cooling everywhere is not out of quota');
  markFable(dir529, 'acct-a', 'usage', 'model');
  assert.equal(accounts.quotaFallbackServable(dir529, 'fable', OPUS_5_5, now), false, 'one 529-cooling account is enough to wait');
  markFable(dir529, 'acct-b', 'usage', 'account');
  assert.equal(accounts.quotaFallbackServable(dir529, 'fable', OPUS_5_5, now), true, 'a quota limit overwriting the 529 counts again');
  assert.equal(servable(now + 6 * HOUR), false, 'expired cooldowns: Fable is healthy again');
  assert.equal(accounts.quotaFallbackServable(dir, undefined, OPUS_5_5, now), false);
  assert.equal(accounts.quotaFallbackServable(dir, 'fable', null, now), false, 'no fallback model');
  assert.equal(accounts.quotaFallbackServable(dir, OPUS_5_5, OPUS_5_5, now), false, 'already on the fallback model');
  assert.equal(accounts.quotaFallbackServable(writePoolDir(mkTmp('spo-277-empty-'), []), 'fable', OPUS_5_5, now), false, 'an empty pool');
  assert.equal('modelLimitedOnEveryAccount' in accounts, false, 'the #166 predicate is gone, not left as dead code');
  assert.equal('isModelQuotaLimit' in accounts, false);
});

// ---- 6. severing the dispatch: drainQueueOnce -> runTask -> handleValidate -> callLlmStep --------
//
// A fresh real-mode card through the whole state machine, every git/gh/npm call and every claude
// spawn fake (test/pool-wait-resume.test.js's #888 replay world, trimmed). One account, pool1.
// Only the claude spawn differs between the two tests: which (step, model) gets which stream.

const ID = 'issue-166';
const HEAD_SHA = 'b'.repeat(40);
const ORIGIN_MAIN_SHA = 'a'.repeat(40);
const CATALOGUE = 'src/shared/rdo-members.ts';
const PAYLOADS = {
  'plan_markdown,invariants_markdown,invariant_ids,check_commands': {
    plan_markdown: '# Plan',
    invariants_markdown: '# Invariants',
    invariant_ids: [],
    check_commands: ['typecheck'],
    files_to_change: [CATALOGUE],
  },
  'summary,files_changed,invariants,tests_run,all_green': {
    summary: 'Synthetic change.',
    files_changed: [CATALOGUE],
    invariants: [],
    tests_run: ['typecheck'],
    all_green: true,
  },
  'verdict,entries': { verdict: 'PASS', entries: [] },
  'verdict,reasons,findings': { verdict: 'REJECT', reasons: ['synthetic reject'], findings: [] },
};
const STEP_OF_KEY = {
  'plan_markdown,invariants_markdown,invariant_ids,check_commands': 'PLAN',
  'summary,files_changed,invariants,tests_run,all_green': 'IMPLEMENT',
  'verdict,entries': 'CITATION_VERIFIER',
  'verdict,reasons,findings': 'VALIDATE',
};

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', signal: null, error: undefined });
const fail = (status, stderr = '') => ({ status, stdout: '', stderr, signal: null, error: undefined });

function makeWorld(config, { diffNames, limitedFor }) {
  const world = { remoteBranch: false, prOpen: null, treeDirty: true, claudeCalls: [], claudeAccounts: [] };
  const branch = `claude-pipe/${ID}`;
  world.spawnSync = (command, args) => {
    if (command === 'git') {
      if (args.includes('worktree') && args.includes('add')) {
        fs.mkdirSync(path.join(config.pipelineWorktreesDir, ID), { recursive: true });
        return ok('');
      }
      if (args.includes('worktree')) return ok('');
      if (args.includes('merge-base')) return fail(1);
      if (args.includes('fetch')) return ok('');
      if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) return fail(1);
      if (args.includes('rev-parse') && args.some((a) => String(a).startsWith('refs/remotes/origin/'))) {
        return world.remoteBranch ? ok(`${HEAD_SHA}\n`) : fail(1);
      }
      if (args.includes('rev-parse') && args.includes('--verify')) return fail(1);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${ORIGIN_MAIN_SHA}\n`);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${HEAD_SHA}\n`);
      if (args.includes('symbolic-ref')) return ok(`${branch}\n`);
      if (args.includes('status') && args.includes('--porcelain')) return ok(world.treeDirty ? ` M ${diffNames[0]}\n` : '');
      if (args.includes('add') && args.includes('-A')) return ok('');
      if (args.includes('commit')) {
        world.treeDirty = false;
        return ok('');
      }
      if (args.includes('push')) {
        world.remoteBranch = true;
        return ok('');
      }
      if (args.includes('diff') && args.includes('--name-only')) return ok(`${diffNames.join('\n')}\n`);
      if (args.includes('diff') && args.includes(CATALOGUE)) return ok('+  // AdmMembersRDO.pas:512\n');
      if (args.includes('diff')) return ok(`diff --git a/${diffNames[0]} b/${diffNames[0]}\n+one line\n`);
      return fail(1, `unhandled fake git call: ${args.join(' ')}`);
    }
    if (command === 'gh') {
      if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(world.prOpen ? [{ number: world.prOpen }] : []));
      if (args[0] === 'pr' && args[1] === 'create') {
        world.prOpen = 1661;
        return ok('https://github.com/Crazz-Org/SPO-WebClient/pull/1661\n');
      }
      if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: 'OPEN', headRefName: branch }));
      if (args[0] === 'pr' && args[1] === 'close') return ok('');
      if (args[0] === 'api' && args.some((a) => String(a).includes('check-runs'))) {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success', status: 'completed' }] }));
      }
      if (args[0] === 'api') return ok('{}');
      if (args[0] === 'issue' && args[1] === 'comment') return ok('https://github.com/o/r/issues/166#issuecomment-1\n');
      return fail(1, `unhandled fake gh call: ${args.join(' ')}`);
    }
    if (command === 'npm') return ok('');
    return fail(1, `unhandled fake command: ${command}`);
  };
  world.spawn = (command, args, spawnOpts) => {
    const i = args.indexOf('--json-schema');
    const key = (i >= 0 ? JSON.parse(args[i + 1]).required || [] : []).join(',');
    const m = args.indexOf('--model');
    const model = m >= 0 ? args[m + 1] : undefined;
    const step = STEP_OF_KEY[key];
    // #277: which pool account the call spawned on (off CLAUDE_CONFIG_DIR), for the 2-account runs.
    const account = path.basename(spawnOpts.env.CLAUDE_CONFIG_DIR);
    world.claudeCalls.push([step, model]);
    world.claudeAccounts.push(account);
    if (step === 'IMPLEMENT') world.treeDirty = true;
    const streamName = limitedFor(step, model, account);
    if (streamName) return fakeSpawnedChild(STREAMS[streamName], { exitCode: 1, signal: spawnOpts.signal });
    if (!PAYLOADS[key]) throw new Error(`no canned payload for required=[${key}]`);
    return fakeSpawnedChild(okLines(PAYLOADS[key]), { signal: spawnOpts.signal });
  };
  return world;
}

function setupCard(worldOpts) {
  const root = mkTmp('spo-166-e2e-');
  const queueDir = path.join(root, 'queue');
  const journalRoot = path.join(root, 'journal');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.mkdirSync(journalRoot, { recursive: true });
  const poolDir = writePoolDir(
    path.join(root, 'accts'),
    (worldOpts.accountNames || ['pool1']).map((name) => ({ name }))
  );
  const config = {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: path.join(root, 'SPO-WebClient'),
    pipelineWorktreesDir: path.join(root, 'worktrees'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: path.join(root, 'bench'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1,
    claudeAccountsDir: poolDir,
    accountLeaseWaitMs: 2000,
    accountLeasePollMs: 25,
    poolExhaustionWaitCapMs: 12 * HOUR,
    transientRetryBudget: 2,
    transientRetryDelaysMs: [60000, 300000],
    validateRejectBudget: 1, // the first REJECT parks: a clean, observable end to the run
  };
  const world = makeWorld(config, worldOpts);
  config.deps = {
    spawnSync: world.spawnSync,
    sleep: () => Promise.resolve(),
    spawn: (command, args, spawnOpts) => world.spawn(command, args, spawnOpts),
    resolveClaudeCodeExecutable: () => '/fake/bin/claude',
    isNoRealSpawnEnabled: () => false,
  };
  const task = { id: ID, kind: 'card', issue: 166, title: 'Judge quota fallback, end to end', criterion: 'replay only', size: 'S' };
  fs.writeFileSync(path.join(queueDir, `0001-${ID}.json`), JSON.stringify(task));
  return { queueDir, journalRoot, poolDir, config, world, taskDir: path.join(journalRoot, ID) };
}

test('#166 end to end (drainQueueOnce): CV hits a Fable model limit and falls back on its result; VALIDATE then falls back at the lease; both verdicts are marked', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir } = setupCard({
    diffNames: [CATALOGUE],
    limitedFor: (step, model) => step === 'CITATION_VERIFIER' && model === 'fable' && 'fable',
  });

  await drainQueueOnce(queueDir, journalRoot, config);

  // The claude calls, in order: the executor steps on Opus 5.5, CITATION_VERIFIER limited on Fable
  // and answered on Opus 5.5, then VALIDATE straight on Opus 5.5 -- the one account is known to be
  // model-limited on Fable, so it never spends a Fable call.
  assert.deepEqual(world.claudeCalls, [
    ['PLAN', OPUS_5_5],
    ['IMPLEMENT', OPUS_5_5],
    ['CITATION_VERIFIER', 'fable'],
    ['CITATION_VERIFIER', OPUS_5_5],
    ['VALIDATE', OPUS_5_5],
  ]);
  const events = journal(taskDir);
  assert.deepEqual(
    events.filter((e) => e.event === 'model-fallback').map((e) => [e.state, e.trigger, e.from, e.to, e.cause, e.account]),
    [
      ['CITATION_VERIFIER', 'limit-result', 'fable', OPUS_5_5, 'model-limit', 'pool1'],
      ['VALIDATE', 'lease', 'fable', OPUS_5_5, 'model-limit', null],
    ]
  );
  const cv = events.find((e) => e.event === 'citation-verifier');
  assert.deepEqual([cv.verdict, cv.quotaFallback, cv.judgeModel], ['PASS', true, OPUS_5_5], 'the CV verdict is marked fallback-judged');
  const cvLlm = events.filter((e) => e.event === 'llm-call' && e.state === 'CITATION_VERIFIER');
  assert.deepEqual(cvLlm.map((e) => [e.model, e.quotaFallback]), [['fable', undefined], [OPUS_5_5, true]]);
  const change = events.find((e) => e.event === 'change-validator');
  assert.deepEqual([change.verdict, change.quotaFallback, change.judgeModel], ['REJECT', true, OPUS_5_5], 'the VALIDATE verdict is marked fallback-judged');
  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked && parked.reason, 'validate-reject-budget-exhausted', 'the fallback verdict drives the card like any verdict');
  assert.deepEqual(Object.keys(accounts.readState(poolDir).pool1.byModel), ['fable'], 'only Fable cooled');
});

test('#166 end to end (drainQueueOnce): an ACCOUNT-WIDE limit at VALIDATE never falls back -- the card pool-waits exactly as before', async () => {
  const { queueDir, journalRoot, config, world, taskDir } = setupCard({
    diffNames: ['doc/x.md'],
    limitedFor: (step, model) => step === 'VALIDATE' && model === 'fable' && 'five_hour',
  });

  await drainQueueOnce(queueDir, journalRoot, config);

  assert.deepEqual(world.claudeCalls, [
    ['PLAN', OPUS_5_5],
    ['IMPLEMENT', OPUS_5_5],
    ['VALIDATE', 'fable'],
  ]);
  const events = journal(taskDir);
  assert.deepEqual(events.filter((e) => e.event === 'model-fallback'), []);
  const wait = events.find((e) => e.event === 'pool-wait');
  assert.ok(wait, 'the account-wide limit ends the run in a pool-wait');
  assert.equal(wait.state, 'VALIDATE');
  assert.equal(events.find((e) => e.event === 'account-cooldown').limitScope, 'account');
});

// ---- 7. SPO-Pipeline#277 end to end: two accounts, drainQueueOnce -> runTask -> handleValidate ----
//
// The same fake world with a two-account pool. The single-account runs above still fall back on the
// limit's own result -- with one account, its Fable limit IS Fable model-limited on every account --
// while these pin that a second account with Fable left keeps the judge on Fable.

test('#277 end to end (drainQueueOnce): a Fable model limit at VALIDATE on pool1 -> VALIDATE judges on Fable on pool2, no model-fallback, verdict unmarked', async () => {
  const { queueDir, journalRoot, poolDir, config, world, taskDir } = setupCard({
    accountNames: ['pool1', 'pool2'],
    diffNames: ['doc/x.md'],
    limitedFor: (step, model, account) => step === 'VALIDATE' && model === 'fable' && account === 'pool1' && 'fable',
  });

  await drainQueueOnce(queueDir, journalRoot, config);

  assert.deepEqual(world.claudeCalls.slice(-2), [
    ['VALIDATE', 'fable'],
    ['VALIDATE', 'fable'],
  ]);
  assert.deepEqual(world.claudeAccounts.slice(-2), ['pool1', 'pool2']);
  const events = journal(taskDir);
  assert.deepEqual(events.filter((e) => e.event === 'model-fallback'), []);
  const change = events.find((e) => e.event === 'change-validator');
  assert.equal(change.verdict, 'REJECT');
  assert.equal('quotaFallback' in change, false, 'a Fable-judged verdict carries no fallback marker');
  assert.equal('judgeModel' in change, false);
  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked && parked.reason, 'validate-reject-budget-exhausted');
  const state = accounts.readState(poolDir);
  assert.deepEqual([Object.keys(state.pool1.byModel), state.pool2], [['fable'], undefined], 'only pool1 Fable cooled');
});

test('#277 end to end (drainQueueOnce): a Fable model limit at CV on pool1 -> CV and VALIDATE both judge on Fable on pool2, no model-fallback', async () => {
  const { queueDir, journalRoot, config, world, taskDir } = setupCard({
    accountNames: ['pool1', 'pool2'],
    diffNames: [CATALOGUE],
    limitedFor: (step, model, account) => step === 'CITATION_VERIFIER' && model === 'fable' && account === 'pool1' && 'fable',
  });

  await drainQueueOnce(queueDir, journalRoot, config);

  const judged = world.claudeCalls.map((c, i) => [...c, world.claudeAccounts[i]]).filter(([step]) => JUDGE_STEPS.includes(step));
  assert.deepEqual(judged, [
    ['CITATION_VERIFIER', 'fable', 'pool1'],
    ['CITATION_VERIFIER', 'fable', 'pool2'],
    ['VALIDATE', 'fable', 'pool2'],
  ]);
  const events = journal(taskDir);
  assert.deepEqual(events.filter((e) => e.event === 'model-fallback'), []);
  const cv = events.find((e) => e.event === 'citation-verifier');
  assert.deepEqual([cv.verdict, 'quotaFallback' in cv], ['PASS', false]);
  const change = events.find((e) => e.event === 'change-validator');
  assert.deepEqual([change.verdict, 'quotaFallback' in change], ['REJECT', false]);
});

test('#277 end to end (drainQueueOnce): Fable model-limited on BOTH accounts at VALIDATE -> Opus 5.5, model-fallback journalled, verdict marked', async () => {
  const { queueDir, journalRoot, config, world, taskDir } = setupCard({
    accountNames: ['pool1', 'pool2'],
    diffNames: ['doc/x.md'],
    limitedFor: (step, model) => step === 'VALIDATE' && model === 'fable' && 'fable',
  });

  await drainQueueOnce(queueDir, journalRoot, config);

  const judged = world.claudeCalls.map((c, i) => [...c, world.claudeAccounts[i]]).filter(([step]) => step === 'VALIDATE');
  assert.deepEqual(judged, [
    ['VALIDATE', 'fable', 'pool1'],
    ['VALIDATE', 'fable', 'pool2'],
    ['VALIDATE', OPUS_5_5, 'pool1'],
  ]);
  const events = journal(taskDir);
  assert.deepEqual(
    events.filter((e) => e.event === 'model-fallback').map((e) => [e.state, e.trigger, e.from, e.to, e.cause, e.account]),
    [['VALIDATE', 'limit-result', 'fable', OPUS_5_5, 'model-limit', 'pool2']]
  );
  const change = events.find((e) => e.event === 'change-validator');
  assert.deepEqual([change.verdict, change.quotaFallback, change.judgeModel], ['REJECT', true, OPUS_5_5]);
});

test('#277 F1 end to end (drainQueueOnce): mixed pool at VALIDATE (pool1 Fable model limit, pool2 account-wide) -> Opus 5.5 on pool1, model-fallback, verdict marked', async () => {
  const { queueDir, journalRoot, config, world, taskDir } = setupCard({
    accountNames: ['pool1', 'pool2'],
    diffNames: ['doc/x.md'],
    limitedFor: (step, model, account) => step === 'VALIDATE' && model === 'fable' && (account === 'pool1' ? 'fable' : 'five_hour'),
  });

  await drainQueueOnce(queueDir, journalRoot, config);

  const judged = world.claudeCalls.map((c, i) => [...c, world.claudeAccounts[i]]).filter(([step]) => step === 'VALIDATE');
  assert.deepEqual(judged, [
    ['VALIDATE', 'fable', 'pool1'],
    ['VALIDATE', 'fable', 'pool2'],
    ['VALIDATE', OPUS_5_5, 'pool1'], // pool2's account-wide limit cooled its Opus 5.5 too
  ]);
  const events = journal(taskDir);
  assert.deepEqual(
    events.filter((e) => e.event === 'model-fallback').map((e) => [e.state, e.trigger, e.account]),
    [['VALIDATE', 'limit-result', 'pool2']]
  );
  const change = events.find((e) => e.event === 'change-validator');
  assert.deepEqual([change.verdict, change.quotaFallback, change.judgeModel], ['REJECT', true, OPUS_5_5]);
  assert.equal(events.some((e) => e.event === 'pool-wait'), false);
});

test('#277 F1 end to end (drainQueueOnce): both accounts ACCOUNT-WIDE limited at VALIDATE -> no fallback, the card pool-waits', async () => {
  const { queueDir, journalRoot, config, world, taskDir } = setupCard({
    accountNames: ['pool1', 'pool2'],
    diffNames: ['doc/x.md'],
    limitedFor: (step, model) => step === 'VALIDATE' && model === 'fable' && 'five_hour',
  });

  await drainQueueOnce(queueDir, journalRoot, config);

  const judged = world.claudeCalls.map((c, i) => [...c, world.claudeAccounts[i]]).filter(([step]) => step === 'VALIDATE');
  assert.deepEqual(judged, [
    ['VALIDATE', 'fable', 'pool1'],
    ['VALIDATE', 'fable', 'pool2'],
  ]);
  const events = journal(taskDir);
  assert.deepEqual(events.filter((e) => e.event === 'model-fallback'), []);
  const wait = events.find((e) => e.event === 'pool-wait');
  assert.ok(wait, 'the run ends in a pool-wait');
  assert.equal(wait.state, 'VALIDATE');
});

// ---- 8. SPO-Pipeline#277 re-verification: account-wide windows, 529s, and trigger (a)'s inputs --
//
// Finding 1: an ACCOUNT-scoped limit used to cool each model with its OWN escalation -- Fable, model-
// limited < 2 h before, escalated to 5 h while Opus 5.5 (no history) got 1 h -- so ~1 h later the
// account read "out of Fable, healthy for Opus 5.5" although its live limit was account-wide, and
// the fallback could lease it (#166 decision 4). `divergent` builds that exact history, 1.01 h ago.

const HOUR_AND_A_BIT = 1.01 * HOUR;
function divergent(dir, name, t0 = Date.now() - HOUR_AND_A_BIT) {
  accounts.markLimit(dir, name, 'usage', t0, { model: 'fable', limitScope: 'model', rateLimitType: null });
  accounts.markLimit(dir, name, 'usage', t0, { model: 'fable', limitScope: 'account', rateLimitType: 'five_hour' });
}

test('#277 re-verification 1: an ACCOUNT-scoped limit ends every model at the SAME instant, with one kind and scope; escalation history stays per model', () => {
  const dir = writePoolDir(mkTmp('spo-277-equal-'), [{ name: 'acct-a' }]);
  const t0 = Date.now();
  accounts.markLimit(dir, 'acct-a', 'usage', t0, { model: 'fable', limitScope: 'model', rateLimitType: null });
  const event = accounts.markLimit(dir, 'acct-a', 'usage', t0 + 60 * 1000, { model: 'fable', limitScope: 'account', rateLimitType: 'five_hour' });
  const byModel = accounts.readState(dir)['acct-a'].byModel;
  assert.equal(event.escalated, true, "premise: Fable's own history escalates it");
  for (const m of accounts.KNOWN_MODELS) {
    assert.equal(byModel[m].cooldownUntil, event.cooldownUntil, `${m}: the account-wide window's one end`);
    assert.deepEqual([byModel[m].cooldownScope, byModel[m].cooldownKind], ['account', 'usage'], m);
  }
  assert.ok(event.cooldownUntil - (t0 + 60 * 1000) > 2 * HOUR, 'the LATEST of the per-model computations (the escalated one)');
  assert.deepEqual([byModel.fable.usageLimitStreak, byModel[OPUS_5_5].usageLimitStreak], [2, 1], 'each model keeps its own escalation history');
});

test('#277 re-verification 1: the divergent history, 1.01 h later -- the account is still not healthy for Opus 5.5, and the fallback is not servable', () => {
  const dir = writePoolDir(mkTmp('spo-277-div-'), [{ name: 'acct-a' }]);
  divergent(dir, 'acct-a');
  const now = Date.now();
  assert.equal(accounts.countHealthyAccounts(dir, now, OPUS_5_5), 0, 'an account-wide limited account is healthy for no model before all of them');
  assert.equal(accounts.countHealthyAccounts(dir, now, 'fable'), 0);
  assert.equal(accounts.quotaFallbackServable(dir, 'fable', OPUS_5_5, now), false);
});

for (const size of [1, 2]) {
  test(`#277 re-verification 1: a pure account-wide pool (${size} account(s), divergent history, +1.01 h) -> no fallback, parks at the lease, no call`, async () => {
    const names = ['acct-a', 'acct-b'].slice(0, size);
    const accountsDir = writePoolDir(
      mkTmp('spo-277-divpool-'),
      names.map((name) => ({ name }))
    );
    for (const name of names) divergent(accountsDir, name);
    const { spawn, calls } = poolSpawn(() => null);
    const { query } = await spyingQuery();
    const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

    await assert.rejects(
      () => callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query })),
      (err) => err instanceof ParkSignal && err.reason.startsWith('all-accounts-cooling-until-')
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
  });
}

for (const step of JUDGE_STEPS) {
  test(`#277 re-verification 1, ${step}: mixed pool (acct-a account-wide with the divergent history, acct-b Fable model-limited) -> the fallback leases acct-b, never acct-a`, async () => {
    const accountsDir = twoAccountPool('spo-277-divmixed-');
    divergent(accountsDir, 'acct-a'); // registry order: the lease tries acct-a first if it reads healthy
    markFable(accountsDir, 'acct-b', 'usage', 'model');
    const { spawn, calls } = poolSpawn(() => null);
    const { query } = await spyingQuery();
    const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

    const result = await callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query }));

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [['acct-b', OPUS_5_5]]);
    assert.deepEqual(eventsNamed(taskDir, 'model-fallback').map((e) => [e.trigger, e.account]), [['lease', null]]);
  });
}

// Trigger (a)'s predicate reads each account's health for FABLE, not the account's union health:
// acct-b is Fable-healthy but cooling on Opus 5.5, so acct-a's Fable limit rotates onto it. (A
// union read would count acct-b "out", and would not find a Fable record there to read a kind off.)
for (const step of JUDGE_STEPS) {
  test(`#277 re-verification 4, ${step}: acct-a Fable limit, acct-b Fable-healthy but cooling on Opus 5.5 -> rotates to acct-b on Fable, no fallback`, async () => {
    const accountsDir = twoAccountPool('spo-277-otherModel-');
    accounts.markLimit(accountsDir, 'acct-b', 'usage', Date.now(), { model: OPUS_5_5, limitScope: 'model', rateLimitType: null });
    const { spawn, calls } = poolSpawn((account, model) => account === 'acct-a' && model === 'fable' && 'fable');
    const { query } = await spyingQuery();
    const { ctx, taskDir } = makeCtx(accountsDir, cardTask());

    const result = await callLlmStep(ctx, step, `llm.${step}`, fakeExecDeps({ spawn, query }));

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      ['acct-a', 'fable'],
      ['acct-b', 'fable'],
    ]);
    assert.deepEqual(eventsNamed(taskDir, 'model-fallback'), []);
  });
}

// The last Fable result carries a limitKind the real classifier cannot produce today (markLimit's R2
// fail-safe: an unrecognised kind is cooled as a usage limit, `defaulted: true`). It is not a 529, so
// that account is out of Fable quota, and trigger (a) must still ask its predicate -- and switch.
// Driven through callLlmStep's `deps.runLlm` test seam: no fixture stream can carry such a kind.
test('#277 re-verification 4: the last Fable result has an UNRECOGNISED limitKind -> trigger (a) still switches on it', async () => {
  const accountsDir = twoAccountPool('spo-277-unknownKind-');
  const { ctx, taskDir } = makeCtx(accountsDir, cardTask());
  const calls = [];
  const runLlmStub = async (c, step) => {
    const model = resolveCallModel(c, step);
    calls.push([c.account.name, model]);
    if (model === 'fable' && c.account.name === 'acct-a') return { ok: false, kind: 'limit', limitKind: 'usage', limitScope: 'model', rateLimitType: null };
    if (model === 'fable') return { ok: false, kind: 'limit', limitKind: 'mystery', limitScope: 'model', rateLimitType: null };
    return { ok: true, verdict: 'PASS', reasons: [], findings: [], entries: [] };
  };

  const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', { ...fakeExecDeps(), runLlm: runLlmStub });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['acct-a', 'fable'],
    ['acct-b', 'fable'],
    ['acct-a', OPUS_5_5],
  ]);
  const cooldowns = eventsNamed(taskDir, 'account-cooldown');
  assert.deepEqual(cooldowns.map((e) => [e.account, e.limitKind, e.defaulted]), [
    ['acct-a', 'usage', false],
    ['acct-b', 'mystery', true],
  ]);
  assert.deepEqual(eventsNamed(taskDir, 'model-fallback').map((e) => [e.trigger, e.account]), [['limit-result', 'acct-b']]);
});

// Round 4, F1: an ACCOUNT-scoped 529 (no production producer today -- limitScopeFor tags every 529
// 'model' -- but limitScopeOfResult defaults a missing scope to 'account') must not run the
// account-wide equal-end step: that step would stretch every model to Fable's kept 5 h quota
// cooldown and relabel them 'usage'/'account'. Each model keeps the later of its own cooldown and
// the 529's 5 minutes, with that cooldown's own kind and scope.
test('#277 round 4: an account-scoped 529 over a running Fable quota cooldown -- Fable keeps it (usage, model), every other model gets its own 5-minute overloaded record', () => {
  const dir = writePoolDir(mkTmp('spo-277-acct529-'), [{ name: 'acct-a' }]);
  const t0 = Date.now();
  accounts.markLimit(dir, 'acct-a', 'usage', t0 - 60 * 1000, { model: 'fable', limitScope: 'model', rateLimitType: null });
  accounts.markLimit(dir, 'acct-a', 'usage', t0, { model: 'fable', limitScope: 'model', rateLimitType: null }); // escalated
  const quota = accounts.readState(dir)['acct-a'].byModel.fable.cooldownUntil;
  assert.ok(quota - t0 > 4 * HOUR, 'premise: an escalated Fable quota cooldown');

  const event = accounts.markLimit(dir, 'acct-a', 'overloaded', t0, { model: 'fable', limitScope: 'account', rateLimitType: null });

  const byModel = accounts.readState(dir)['acct-a'].byModel;
  assert.deepEqual([byModel.fable.cooldownUntil, byModel.fable.cooldownKind, byModel.fable.cooldownScope], [quota, 'usage', 'model']);
  for (const m of accounts.KNOWN_MODELS.filter((x) => x !== 'fable')) {
    assert.deepEqual(
      [byModel[m].cooldownUntil, byModel[m].cooldownKind, byModel[m].cooldownScope],
      [t0 + 5 * 60 * 1000, 'overloaded', 'account'],
      `${m}: its own 5-minute 529, not stretched to Fable's quota cooldown`
    );
  }
  assert.deepEqual([event.limitScope, event.cooldownUntil], ['account', quota], 'the event reports the latest cooldown it left, the kept one');
});

// Finding 2: a 529 on an account whose Fable QUOTA cooldown is still running neither shortens it nor
// relabels it 'overloaded' -- the account stays out of Fable quota, so the fallback stays servable
// (and it is not "coming back within minutes").
test('#277 re-verification 2: a 529 on top of a running Fable quota cooldown keeps it -- still out of quota, still hours away', () => {
  const dir = twoAccountPool('spo-277-529over-');
  const t0 = Date.now();
  accounts.markLimit(dir, 'acct-a', 'usage', t0 - 60 * 1000, { model: 'fable', limitScope: 'model', rateLimitType: null });
  accounts.markLimit(dir, 'acct-a', 'usage', t0, { model: 'fable', limitScope: 'model', rateLimitType: null }); // escalated
  const quota = accounts.readState(dir)['acct-a'].byModel.fable.cooldownUntil;
  accounts.markLimit(dir, 'acct-a', 'overloaded', t0, { model: 'fable', limitScope: 'model', rateLimitType: null });
  markFable(dir, 'acct-b', 'usage', 'model');
  const fable = accounts.readState(dir)['acct-a'].byModel.fable;
  assert.deepEqual([fable.cooldownUntil, fable.cooldownKind], [quota, 'usage']);
  assert.ok(quota - t0 > 4 * HOUR, 'premise: the escalated cooldown');
  assert.equal(accounts.quotaFallbackServable(dir, 'fable', OPUS_5_5, t0 + 10 * 60 * 1000), true, 'ten minutes on: still no Fable quota anywhere');
});
