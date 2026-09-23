'use strict';
// sdk-deny-list-e2e.test.js -- promoted from an Opus verifier's own scratch probe (fix pass on
// card #241's merge of origin/main into chantier/sdk-transport, 2026-09-23). The merge combined
// #239's SDK cutover (steps/llm.js's invokeClaudeReal now drives every LLM call through
// orchestrator/steps/sdk-call.js's buildQueryOptions + the vendored Agent SDK's real query(),
// never `spawnSync('claude', buildArgv(opts), ...)`) with #240's per-policy Bash deny lists
// (orchestrator/bash-policy.js). Without buildQueryOptions carrying opts.disallowedTools through
// to options.disallowedTools, the SDK path would have silently dropped #240's deny lists on
// every real call -- a security regression with no failing test to catch it, since every
// existing test asserted against buildArgv, which the same merge deleted as dead code.
//
// WHY THIS IS A SEPARATE FILE FROM test/sdk-call-options.test.js's own contract-parity tests
// -----------------------------------------------------------------------------------------------
// test/sdk-call-options.test.js's table-driven "carries model/effort/tools/... unchanged from its
// resolved contract" tests (test 1) call buildQueryOptions DIRECTLY and check its return value.
// That proves buildQueryOptions is wired correctly, but not that production actually REACHES
// buildQueryOptions with the right opts -- the standing lesson this repo has paid for more than
// once (see CLAUDE.md's own citation of it): "calling a step function directly proves the
// function works, not that production reaches it." This file goes one layer further, through the
// SAME real path a production call takes: `runLlm` (steps/llm.js) resolves the step's contract
// (step-contracts.js's resolveStepContract, which reads orchestrator/bash-policy.js's lists) into
// `opts.disallowedTools`, hands it to buildQueryOptions, and THAT hands `{prompt, options}` to a
// REAL `query()` call from the vendored SDK -- which itself builds the real `--disallowedTools`
// argv and calls `spawnClaudeCodeProcess` with it. This file reads the deny list back off that
// real argv, not off any intermediate object.
//
// Every "spawn" here is still fake: test/helpers.js's fakeSpawnDeps/fakeSpawnedChild substitute a
// pure-JS duck-typed ChildProcess for spawnClaudeCodeProcess to return, so `query()` runs for
// real and builds real argv, but no real `claude` process, network call or credential is ever
// touched. See test/helpers.js's own fakeSpawnedChild header for the measurement behind that
// claim.
//
// PROVEN LOAD-BEARING (this fix pass, manual mutation testing -- not encoded in this file, since
// the driver owns commits and mutation testing is meant to be thrown away, not shipped): each of
// the four links below was cut, one at a time, and every test in this file that covers it went
// red (exactly the affected tests, nothing else); restoring the line made the whole file green
// again.
//   1. steps/llm.js's runLlm, the real (non-override) branch: `disallowedTools:
//      contract.disallowedTools` removed from the `opts` object passed to buildQueryOptions --
//      PLAN/IMPLEMENT/DIAGNOSE/VALIDATE (4 of 9) went red, CITATION_VERIFIER (no deny list to
//      lose) and the intake/override tests stayed green.
//   2. step-contracts.js's resolveStepContract: the `disallowedTools: stepDef.disallowedTools`
//      field removed from its returned contract -- same 4 red, same 5 green.
//   3. orchestrator/intake.js's draftCard: its `disallowedTools: INTAKE_BASH_DENY` argument
//      emptied to `disallowedTools: []` (the surrounding comment text left untouched, so a
//      text-only sweep would not catch it -- only an argv-level probe like this one does) --
//      exactly the draftCard test went red.
//   4. steps/llm.js's runLlm, the legacy override branch: `disallowedTools:
//      override.disallowedTools` removed from the `opts` object -- exactly the override test
//      (below) went red.
//
// EXTENDED (card #241 remerge fix pass, 2026-09-23, maintainer-directed): the driver found no
// standing test asserted any step's --model on the real command line -- changing DIAGNOSE's
// baseModel in step-contracts.js (line ~992) failed only ONE contract-table test
// (test/step-contracts.test.js), never an argv-level one. Every case in both tables below (STEP_
// CASES and INTAKE_CASES) plus the legacy-override test now also asserts modelArgvValue against
// each call's own intended model, read directly from step-contracts.js/intake.js. PROVEN
// LOAD-BEARING the same way as above (manual mutation, this fix pass, restored after):
//   5. step-contracts.js's DIAGNOSE.baseModel changed from OPUS_5_5 to 'fable' -- exactly the
//      DIAGNOSE case went red (its own --model assertion), the other four STEP_CASES and every
//      intake/override test stayed green.
//   6. step-contracts.js's VALIDATE.baseModel changed from 'fable' to 'sonnet' -- exactly the
//      VALIDATE case went red, nothing else.
//   7. sdk-call.js's buildQueryOptions: `if (opts.model) options.model = opts.model;` removed --
//      every case in this file and test/sdk-call-options.test.js that carries a model went red:
//      15 of 15 (re-measured, fix pass 2026-09-23; this comment previously said 14, undercounting
//      test/sdk-call-options.test.js's own `buildQueryOptions: a real query() spawn emits the
//      exact measured argv shape` test, which also asserts --model on the real argv and went red
//      too). Reproduce: comment out that `if (opts.model) ...` line in buildQueryOptions, then run
//      `node --test test/sdk-deny-list-e2e.test.js test/sdk-call-options.test.js` -- the 5
//      STEP_CASES + 3 INTAKE_CASES + the legacy-override test here (9), plus the 5 REAL_STEPS
//      contract-parity cases + the one real-argv-shape test in test/sdk-call-options.test.js (6),
//      go red; none of the --disallowedTools-only assertions were newly broken by this cut alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- must land before the orchestrator require(s) below (test/no-real-spawn-sweep.test.js
// enforces this ordering repo-wide; see test/no-real-spawn.js's own header for the incident).
require('./no-real-spawn');
const { runLlm } = require('../orchestrator/steps/llm');
const { appendEvent } = require('../orchestrator/journal');
const intake = require('../orchestrator/intake');
const { READ_ONLY_STEP_BASH_DENY, WRITE_STEP_BASH_DENY, INTAKE_BASH_DENY } = require('../orchestrator/bash-policy');
const { OPUS_5_5 } = require('../orchestrator/step-contracts');
const { mkTmp, writePoolDir, fakeSpawnDeps, fakeExecDeps, fakeSpawnedChild } = require('./helpers');

const SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function initMessage() {
  return { type: 'system', subtype: 'init', session_id: SESSION_ID, apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}

function resultMessage(resultObj) {
  return { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: SESSION_ID, modelUsage: {}, result: typeof resultObj === 'string' ? resultObj : JSON.stringify(resultObj) };
}

// Reads the `--disallowedTools <value>` argv pair spawnClaudeCodeProcess's real `command`/`args`
// were called with -- undefined when the flag was never emitted at all (CITATION_VERIFIER's own
// contract carries no disallowedTools, and buildQueryOptions omits the option entirely rather
// than sending an empty array -- see that function's own comment).
function denyArgvValue(argv) {
  const i = argv.indexOf('--disallowedTools');
  return i === -1 ? undefined : argv[i + 1];
}

// Reads the `--model <value>` argv pair spawnClaudeCodeProcess's real `command`/`args` were
// called with. Card #241 remerge (2026-09-23): the driver confirmed no standing test asserted
// DIAGNOSE's own --model on the real command line -- changing DIAGNOSE's baseModel in
// step-contracts.js failed only one contract-table test (test/step-contracts.test.js), never an
// argv-level one. This helper backs the model assertions added to both tables below, closing that
// gap for every step/intake call this file already drives through the real vendored SDK argv.
function modelArgvValue(argv) {
  const i = argv.indexOf('--model');
  return i === -1 ? undefined : argv[i + 1];
}

// ---- the five real LLM steps, table-driven over step-contracts.js's own resolved deny list -----

// Expected --model is each step's own resolved baseModel (step-contracts.js's STEP_CONTRACTS),
// read directly from OPUS_5_5/the literal 'fable' rather than re-typed, so a future re-spelling of
// OPUS_5_5's own value cannot silently desync this table from the source it is meant to pin. The
// plain task built below (no planInvalidRetry/diagnoseOrValidateRetry/etc. flags) never fires any
// step's shouldEscalate, so every case here resolves to baseModel, never escalatedModel -- PLAN's
// own escalatedModel ('fable', on planInvalidRetry) is exercised separately by
// test/plan-model-fallback.test.js, not duplicated here.
const STEP_CASES = [
  ['PLAN', READ_ONLY_STEP_BASH_DENY, OPUS_5_5],
  ['IMPLEMENT', WRITE_STEP_BASH_DENY, OPUS_5_5],
  ['DIAGNOSE', READ_ONLY_STEP_BASH_DENY, OPUS_5_5],
  ['VALIDATE', READ_ONLY_STEP_BASH_DENY, 'fable'],
  ['CITATION_VERIFIER', undefined, 'fable'], // the one contract with no Bash entry at all -- see step-contracts.js:1240's own comment
];

for (const [step, expectedDenyList, expectedModel] of STEP_CASES) {
  test(`sdk deny-list e2e: runLlm(${step}) reaches the vendored SDK's real argv with ${expectedDenyList ? 'its own resolved deny list' : 'no --disallowedTools at all'}`, async () => {
    const taskDir = mkTmp('sdk-deny-e2e-');
    const task = {
      kind: 'card',
      issue: 1,
      title: 'e2e deny-list probe',
      criterion: 'the deny list reaches real argv',
      worktreePath: '/tmp/wt-sdk-deny-e2e',
      size: 'S',
      citations: ['AdmMembersRDO.pas:512'], // CITATION_VERIFIER's own template needs at least one
    };
    // IMPLEMENT's own template reads PLAN's prior journal output -- harmless for the other four
    // steps, which never look at it.
    appendEvent(taskDir, 'PLAN', 'result', {
      payload: { plan_path: '/p', invariants_path: '/i', invariant_ids: ['INV-1'], check_commands: ['x'] },
    });

    const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage({ verdict: 'PASS' })]);
    const ctx = {
      shadowMode: false,
      dryRun: false,
      taskDir,
      task,
      account: { name: 'default', configDir: null },
      config: { stepDeadlineMs: 30000 },
    };

    try {
      await runLlm(ctx, step, `llm.${step}`, fakeExecDeps({ spawn }));
    } catch (err) {
      // The fake reply above is not shaped to satisfy every step's own outputContract -- this
      // test only cares whether a real spawn happened and what argv it carried, not whether
      // runLlm's own validation accepted the fake payload.
      if (!calls.length) throw err;
    }

    assert.equal(calls.length, 1, `${step} must reach a real spawn exactly once`);
    const got = denyArgvValue(calls[0].args);
    if (expectedDenyList === undefined) {
      assert.equal(got, undefined, `${step} must carry no --disallowedTools at all`);
    } else {
      assert.equal(got, expectedDenyList.join(','), `${step}'s --disallowedTools must be its own resolved deny list, comma-joined`);
    }
    assert.equal(
      modelArgvValue(calls[0].args),
      expectedModel,
      `${step}'s --model must be its own resolved baseModel (step-contracts.js), reaching the real argv unchanged`
    );
  });
}

// ---- the three intake steps, each with their own INTAKE_BASH_DENY ------------------------------

// Expected --model per intake call (orchestrator/intake.js): draftCard is 'sonnet' (unchanged by
// PR #249 -- the maintainer decision moved PLAN/IMPLEMENT/DIAGNOSE/TRIAGE_BUG_REPORT to Opus 5.5,
// DRAFT_CARD stays on Sonnet 5, see that commit's own message), reviewCard is 'fable' (untouched by
// #249, not in its list of moved steps), triageBugReport is OPUS_5_5 (moved off the `opus` alias by
// #249, verified by reading intake.js's own triageBugReport call site directly).
const INTAKE_CASES = [
  ['draftCard', (deps) => intake.draftCard('add a widget', deps), 'sonnet'],
  [
    'reviewCard',
    (deps) =>
      intake.reviewCard(
        { title: 't', body_markdown: 'b', category: 'feature', size: 'S', area: 'client', priority: 'Low', is_bug_report: false, confirmed: false },
        deps
      ),
    'fable',
  ],
  [
    'triageBugReport',
    (deps) => {
      const reportFile = path.join(mkTmp('sdk-deny-e2e-report-'), 'report.json');
      fs.writeFileSync(reportFile, '{}');
      return intake.triageBugReport(reportFile, 1, deps);
    },
    OPUS_5_5,
  ],
];

for (const [name, call, expectedModel] of INTAKE_CASES) {
  test(`sdk deny-list e2e: intake.${name} reaches the vendored SDK's real argv with INTAKE_BASH_DENY`, async () => {
    let capturedArgs = null;
    const deps = {
      ...fakeExecDeps(),
      accountsDir: writePoolDir(mkTmp('sdk-deny-e2e-pool-'), [{ name: 'a1' }]),
      spawn: (command, args, spawnOpts) => {
        capturedArgs = args;
        return fakeSpawnedChild([initMessage(), resultMessage({ verdict: 'PASS' })], { signal: spawnOpts.signal });
      },
    };

    try {
      await call(deps);
    } catch (err) {
      // Same posture as the step-table above: only a spawn that never happened is a real failure
      // for THIS test's purpose.
      if (!capturedArgs) throw err;
    }

    assert.ok(capturedArgs, `intake.${name} must reach a real spawn`);
    assert.equal(denyArgvValue(capturedArgs), INTAKE_BASH_DENY.join(','), `intake.${name}'s --disallowedTools must be INTAKE_BASH_DENY, comma-joined`);
    assert.equal(
      modelArgvValue(capturedArgs),
      expectedModel,
      `intake.${name}'s --model must be its own hand-built call config's model, reaching the real argv unchanged`
    );
  });
}

// ---- the legacy ctx.task.llm.<step> override branch (llm.js's runLlm, `override.disallowedTools`
// at llm.js:1060) -- a hand-authored task file's own escape hatch, honoured verbatim, no template
// fill, no outputContract validation. Fits the same real-argv probe cleanly: same runLlm entry
// point, just the other branch. Also doubles as this fix pass's own F1 pin at the runLlm layer (a
// STRING disallowedTools, the only shape a hand-authored task file could realistically carry,
// must survive to argv unsplit -- see test/sdk-call-options.test.js for the buildQueryOptions- and
// argv-level version of this same proof).
test('sdk deny-list e2e: runLlm legacy ctx.task.llm.<step> override -- a string disallowedTools reaches real argv unsplit', async () => {
  const taskDir = mkTmp('sdk-deny-e2e-override-');
  const rule = 'Bash(git reset --hard*) Bash(sudo *)';
  const { spawn, calls } = fakeSpawnDeps([initMessage(), resultMessage({ result: 'ok' })]);
  const ctx = {
    shadowMode: false,
    taskDir,
    config: { stepDeadlineMs: 30000 },
    account: { name: 'acct-x', configDir: null },
    task: { id: 't1', llm: { PLAN: { model: 'fable', effort: 'medium', promptText: 'plan this', disallowedTools: rule } } },
  };

  await runLlm(ctx, 'PLAN', 'llm.PLAN', fakeExecDeps({ spawn }));

  assert.equal(calls.length, 1);
  assert.equal(denyArgvValue(calls[0].args), rule, 'a legacy override string must reach real argv completely unsplit');
  assert.equal(
    modelArgvValue(calls[0].args),
    'fable',
    "the override's own model ('fable' above) must reach real argv unchanged, independent of step-contracts.js's baseModel"
  );
});
