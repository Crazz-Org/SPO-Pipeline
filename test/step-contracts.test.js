'use strict';
// Unit tests for orchestrator/step-contracts.js -- the table + resolver that replaces the
// interim ctx.task.llm.<step> config source for a real `kind: "card"` task.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const {
  STEP_CONTRACTS,
  resolveStepContract,
  shouldEscalate,
  EFFORT_BY_SIZE,
  IMPLEMENT_EFFORT_BY_SIZE,
  PLAN_EFFORT_BY_SIZE,
  LLM_STEP_DEADLINE_MS,
  LLM_STEP_DEADLINE_MS_BY_STEP,
  MAX_LLM_STEP_DEADLINE_MS,
  checkOutputTypes,
  valueSatisfiesType,
  jsonSchemaPropertiesFor,
} = require('../orchestrator/step-contracts');
const { WORKTREE_SIDE_STEPS } = require('../orchestrator/config');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const FIVE_STEPS = ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'CITATION_VERIFIER', 'VALIDATE'];

test('one contract entry per orchestrator LLM step named in state-machine-spec.md, no more, no fewer', () => {
  assert.deepEqual(Object.keys(STEP_CONTRACTS).sort(), [...FIVE_STEPS].sort());
});

test('review-card.md has no entry -- not a state-machine-spec.md step (prompts/README.md says so itself)', () => {
  for (const contract of Object.values(STEP_CONTRACTS)) {
    assert.ok(!contract.promptFile.endsWith('review-card.md'));
  }
});

test('draft-card.md has no entry either -- intake path (spo ask), not a state-machine-spec.md step, same as review-card.md', () => {
  for (const contract of Object.values(STEP_CONTRACTS)) {
    assert.ok(!contract.promptFile.endsWith('draft-card.md'));
  }
});

test('triage-bug-report.md has no entry either -- intake path (spo triage), not a state-machine-spec.md step', () => {
  for (const contract of Object.values(STEP_CONTRACTS)) {
    assert.ok(!contract.promptFile.endsWith('triage-bug-report.md'));
  }
});

test('every contract promptFile exists under prompts/ and every non-intake-path prompt file is used by exactly one contract', () => {
  const usedFiles = new Set();
  for (const [step, contract] of Object.entries(STEP_CONTRACTS)) {
    assert.ok(fs.existsSync(contract.promptFile), `${step}'s promptFile ${contract.promptFile} does not exist`);
    usedFiles.add(path.basename(contract.promptFile));
  }
  const allPromptFiles = fs
    .readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md');
  // review-card.md, draft-card.md and triage-bug-report.md are all driven by the intake path
  // (orchestrator/intake.js: `spo ask` / `spo triage`), never by state-machine.js's callLlmStep
  // -- see the three tests above.
  const INTAKE_PATH_PROMPTS = ['review-card.md', 'draft-card.md', 'triage-bug-report.md'];
  const expected = allPromptFiles.filter((f) => !INTAKE_PATH_PROMPTS.includes(f)).sort();
  assert.deepEqual([...usedFiles].sort(), expected);
});

test('cwdKind matches config.js WORKTREE_SIDE_STEPS exactly (one policy, not duplicated)', () => {
  for (const step of FIVE_STEPS) {
    const expected = WORKTREE_SIDE_STEPS.has(step) ? 'worktree' : 'pipeline';
    assert.equal(STEP_CONTRACTS[step].cwdKind, expected, `${step} cwdKind`);
  }
});

test('resolveStepContract: PLAN never escalates on touchesRdoMembers (spec wins over prompts/README.md)', () => {
  const c = resolveStepContract('PLAN', { size: 'S', touchesRdoMembers: true });
  assert.equal(c.model, 'opus');
  assert.equal(c.escalated, false);
});

// 2026-09-13 (EXP-PLAN-OPUS, doc/model-experiments.md): PLAN is Opus-first with Fable as its
// fallback. This replaces 'PLAN never escalates' (2026-09-04), which guarded against re-adding a
// PLAN escalation with no trigger that could fire -- the `task.escalate` flag nothing ever set.
// The new trigger IS reachable: handlePlan (state-machine.js) assigns task.planInvalidRetry right
// before each PLAN call -- test/plan-writes.test.js drives both paths end to end. What this test
// still guards is the old failure's other half: every signal the OTHER steps escalate on is carried
// below, and none of them may move PLAN off Opus.
test('resolveStepContract: PLAN is Opus-first and falls back to Fable ONLY on planInvalidRetry', () => {
  const everyOtherSignal = {
    size: 'L',
    touchesRdoMembers: true,
    rdoDiffTouched: true,
    planDeclaresRdoMembers: true,
    diagnoseOrValidateRetry: true,
    escalate: true,
  };
  for (const task of [{ size: 'S' }, { size: 'S', escalate: true }, everyOtherSignal]) {
    const c = resolveStepContract('PLAN', task);
    assert.equal(c.model, 'opus', `PLAN must stay Opus for ${JSON.stringify(task)}`);
    assert.equal(c.escalated, false);
  }
  const fallback = resolveStepContract('PLAN', { size: 'M', planInvalidRetry: true });
  assert.equal(fallback.model, 'fable');
  assert.equal(fallback.escalated, true);
  assert.equal(STEP_CONTRACTS.PLAN.baseModel, 'opus');
  assert.equal(STEP_CONTRACTS.PLAN.escalatedModel, 'fable');
  assert.deepEqual(STEP_CONTRACTS.PLAN.escalatesOn, ['planInvalidRetry']);
});

// Same strictness convention as IMPLEMENT's signals below: only a boolean `true` buys the fallback.
for (const bogus of ['false', 'true', 0, 1, {}, []]) {
  test(`resolveStepContract: PLAN planInvalidRetry ${JSON.stringify(bogus)} is not boolean true -- stays Opus`, () => {
    assert.equal(resolveStepContract('PLAN', { size: 'S', planInvalidRetry: bogus }).model, 'opus');
  });
}

// planInvalidRetry is PLAN's own vocabulary: a card re-planned after a plan-invalid park must not
// also drag any other step's model with it.
test('resolveStepContract: no step other than PLAN escalates on planInvalidRetry', () => {
  for (const [name, def] of Object.entries(STEP_CONTRACTS)) {
    if (name === 'PLAN') continue;
    assert.ok(!def.escalatesOn.includes('planInvalidRetry'), `${name} must not list planInvalidRetry`);
    const task = { size: 'S', planInvalidRetry: true };
    assert.equal(resolveStepContract(name, task).model, def.baseModel, `${name} moved on planInvalidRetry`);
  }
});

// The flag is gone everywhere, not just from PLAN -- a sweep, so re-adding it to any one step is
// caught here rather than in whichever step's own test happens to pass a task that carries it.
test('resolveStepContract: no step escalates on the deleted `escalate` flag', () => {
  const task = { size: 'S', escalate: true };
  for (const [name, def] of Object.entries(STEP_CONTRACTS)) {
    assert.ok(!def.escalatesOn.includes('escalateFlag'), `${name} still lists the deleted escalateFlag trigger`);
    assert.equal(shouldEscalate(def, task), false, `${name} escalated on a flag nothing sets`);
  }
});

// Card #213, action 2: no plan declaration at all (task carries no planDeclaresRdoMembers key)
// means shouldEscalate's source 2 resolves to undefined, and it falls through to source 3 --
// touchesRdoMembers, today's pre-#213 behaviour. This covers acceptance criterion 2's
// declared-nothing case -- the phrase "a reply that declared NOTHING AT ALL falls through to step
// 3" is Action 2's own spec prose, NOT a numbered criterion (criterion 5 is the deadline record).
test('resolveStepContract: IMPLEMENT escalates on touchesRdoMembers when the plan never declared anything (source 3, the fallback)', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'S', touchesRdoMembers: true });
  assert.equal(c.model, 'opus');
});

test('resolveStepContract: IMPLEMENT escalates on an L-sized task even with no RDO touch', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'L', touchesRdoMembers: false });
  assert.equal(c.model, 'opus');
});

// Criterion 2 (its lSize clause): lSize is untouched by the #213 rework -- still escalates on size alone, whatever
// the (now three-source) RDO signals say.
test('resolveStepContract: IMPLEMENT escalates on an L-sized task even when the plan explicitly declared no RDO touch', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'L', planDeclaresRdoMembers: false, touchesRdoMembers: false });
  assert.equal(c.model, 'opus');
});

test('resolveStepContract: IMPLEMENT stays Sonnet for a plain S/M task', () => {
  assert.equal(resolveStepContract('IMPLEMENT', { size: 'S' }).model, 'sonnet');
  assert.equal(resolveStepContract('IMPLEMENT', { size: 'M' }).model, 'sonnet');
});

// =============================================================================================
// ---- Card #213, action 2: IMPLEMENT's three-source RDO escalation + trigger 4 -----------------
// =============================================================================================
// shouldEscalate resolves IMPLEMENT's 'planDeclaresRdoMembers' branch from THREE sources, most
// trustworthy first (see that function's own header in step-contracts.js for the full argument):
//   1. task.rdoDiffTouched === true -- the real diff, once PUSH_PR has run.
//   2. task.planDeclaresRdoMembers -- the plan's own declaration (true/false/undefined).
//   3. task.touchesRdoMembers === true -- the fallback, reached only when source 2 is undefined.
// Plus trigger 4 (2026-09-12 amendment), independent of the three above: task.diagnoseOrValidateRetry.
// These tests pass `task` objects with the fields already resolved (as state-machine.js's
// resolvePlanDeclaresRdoMembers / handleImplement would have set them) -- the WIRING that derives
// those fields (guardDeclaredFiles, lastJournaledPlanFiles, ctx.counters at the call site) is
// covered end to end in test/implement-rdo-escalation.test.js, which also pins restart-durability
// against reparkCrashedTask/orphan-scan.js's exact counter-restore shape.

test('resolveStepContract: IMPLEMENT source 1 -- rdoDiffTouched === true escalates, independent of the plan/intake signals', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'S', rdoDiffTouched: true, planDeclaresRdoMembers: false, touchesRdoMembers: false });
  assert.equal(c.model, 'opus');
});

test('resolveStepContract: IMPLEMENT source 2 -- an EMPTY plan declaration (planDeclaresRdoMembers: false) does NOT fall back to touchesRdoMembers', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'S', planDeclaresRdoMembers: false, touchesRdoMembers: true });
  assert.equal(c.model, 'sonnet', 'the plan declared and said no -- must not fall through to source 3');
});

test('resolveStepContract: IMPLEMENT source 2 -- a plan declaring rdo-members.ts escalates, even with touchesRdoMembers false', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'S', planDeclaresRdoMembers: true, touchesRdoMembers: false });
  assert.equal(c.model, 'opus');
});

// REGRESSION (card #213's own acceptance criterion 3): the hole scripted.js:1705-1708's
// touchesRdoMembers false->true promotion (after PUSH_PR) exists to close, from the other side --
// a plan that did NOT declare rdo-members.ts on a card whose real diff DID touch it must still
// escalate. Source 1 must win over source 2 here.
test('REGRESSION: rdoDiffTouched === true wins over a plan declaration that said no', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'S', rdoDiffTouched: true, planDeclaresRdoMembers: false, touchesRdoMembers: false });
  assert.equal(c.model, 'opus');
});

test('resolveStepContract: IMPLEMENT trigger 4 -- diagnoseOrValidateRetry escalates on its own, no wire/plan/size signal at all', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'S', diagnoseOrValidateRetry: true });
  assert.equal(c.model, 'opus');
});

test('resolveStepContract: IMPLEMENT trigger 4 false, nothing else set -- stays Sonnet', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'S', diagnoseOrValidateRetry: false });
  assert.equal(c.model, 'sonnet');
});

// REGRESSION (card #213, found by the Opus verifier 2026-09-12): trigger 4 must be INDEPENDENT of
// the three RDO sources. It first shipped BELOW the planDeclaresRdoMembers block, whose
// `=== false` arm returns out of the whole function -- so every card whose plan declared a list
// not naming rdo-members.ts never reached it. Measured on ~/.spo-state/journal at the time: of the
// 26 cards that had ever run DIAGNOSE or taken a VALIDATE reject, 19 (73%) had trigger 4 dead; it
// fired on 7. The original tests missed it because none crossed the two axes -- one had the
// declaration with counters at 0, the other the counter with no declaration. These three cross it.
test('resolveStepContract: IMPLEMENT trigger 4 fires even when the plan declared files that do NOT name the catalogue', () => {
  const c = resolveStepContract('IMPLEMENT', {
    size: 'S',
    planDeclaresRdoMembers: false,
    touchesRdoMembers: false,
    diagnoseOrValidateRetry: true,
  });
  assert.equal(c.model, 'opus');
});

test('resolveStepContract: IMPLEMENT trigger 4 fires on an EMPTY plan declaration (which is still a declaration, so source 2 says false)', () => {
  const c = resolveStepContract('IMPLEMENT', {
    size: 'S',
    planDeclaresRdoMembers: false,
    touchesRdoMembers: true,
    diagnoseOrValidateRetry: true,
  });
  assert.equal(c.model, 'opus');
});

test('resolveStepContract: IMPLEMENT -- a no-catalogue declaration with NO retry still stays Sonnet (the hoist must not turn trigger 4 into a free pass)', () => {
  const c = resolveStepContract('IMPLEMENT', {
    size: 'S',
    planDeclaresRdoMembers: false,
    touchesRdoMembers: true,
    diagnoseOrValidateRetry: false,
  });
  assert.equal(c.model, 'sonnet');
});

// STRICTNESS (card #213, D2 from the same verification): this repo's convention is a strict
// `=== true` on every escalation signal, so a task.json field rebuilt as the STRING "false", or a
// 0/1, never coerces into an escalation. The effort side had this loop; the model side -- which is
// $78-82 of the card's ~$88 -- had none, and relaxing `=== true` to a truthy check left all 2780
// tests passing. Each row below turns red on that relaxation.
for (const bogus of ['false', 'true', 0, 1, {}, []]) {
  test(`resolveStepContract: IMPLEMENT rdoDiffTouched ${JSON.stringify(bogus)} is not boolean true -- no source-1 escalation`, () => {
    const c = resolveStepContract('IMPLEMENT', {
      size: 'S',
      rdoDiffTouched: bogus,
      planDeclaresRdoMembers: false,
      touchesRdoMembers: false,
    });
    assert.equal(c.model, 'sonnet');
  });

  test(`resolveStepContract: IMPLEMENT diagnoseOrValidateRetry ${JSON.stringify(bogus)} is not boolean true -- trigger 4 does not fire`, () => {
    const c = resolveStepContract('IMPLEMENT', {
      size: 'S',
      diagnoseOrValidateRetry: bogus,
      planDeclaresRdoMembers: false,
      touchesRdoMembers: false,
    });
    assert.equal(c.model, 'sonnet');
  });

  test(`resolveStepContract: IMPLEMENT touchesRdoMembers ${JSON.stringify(bogus)} is not boolean true -- source 3 does not fire`, () => {
    const c = resolveStepContract('IMPLEMENT', { size: 'S', touchesRdoMembers: bogus });
    assert.equal(c.model, 'sonnet');
  });
}

// Sweep: IMPLEMENT's own table entry no longer names 'touchesRdoMembers' literally (folded into
// 'planDeclaresRdoMembers' as shouldEscalate's own step 3) -- pin that the token itself is gone
// from the array, since a future edit re-adding it verbatim would silently create a SECOND,
// unconditional touchesRdoMembers branch alongside the resolution order above.
test("resolveStepContract: IMPLEMENT's escalatesOn no longer names the literal string 'touchesRdoMembers'", () => {
  assert.ok(!STEP_CONTRACTS.IMPLEMENT.escalatesOn.includes('touchesRdoMembers'));
  assert.deepEqual(STEP_CONTRACTS.IMPLEMENT.escalatesOn, ['planDeclaresRdoMembers', 'lSize', 'diagnoseOrValidateRetry']);
});

// Rewritten 2026-09-04: VALIDATE escalates EFFORT, never model. `fable -> opus` was a downgrade
// (Fable is the more capable and twice the price), so the old rule made the judge weaker exactly on
// the RDO wire -- observed live on card #462, where IMPLEMENT escalated sonnet -> opus (up) while
// VALIDATE escalated fable -> opus (down) in the same run.
//
// Rewritten AGAIN, card #213 action 1 (2026-09-12): the trigger itself moves from
// `task.touchesRdoMembers` (an intake guess) to `task.rdoDiffTouched` (the real diff, resolved by
// state-machine.js's resolveRdoDiffTouched). This test used to pass `touchesRdoMembers` directly --
// that genuinely encoded the behaviour this action overturns, so it is rewritten rather than left
// stale: on the 36-card window measured 2026-09-12, `touchesRdoMembers` fired on 23 of 36 cards
// while the merged diff touched `rdo-members.ts` on only 2, so 17 of 19 `xhigh` calls under the old
// trigger judged a diff with no RDO in it at all. The false-positive scenario itself (intake true,
// diff false) is pinned by the dedicated test below.
test('resolveStepContract: VALIDATE escalates EFFORT on rdoDiffTouched, and never changes model', () => {
  const base = resolveStepContract('VALIDATE', { rdoDiffTouched: false });
  const escalated = resolveStepContract('VALIDATE', { rdoDiffTouched: true });

  assert.equal(base.effort, 'high');
  assert.equal(escalated.effort, 'xhigh', 'the diff-derived signal must buy more effort');
  assert.equal(base.effortEscalated, false);
  assert.equal(escalated.effortEscalated, true);

  // The model must not move in EITHER direction -- this is the whole point of the rewrite.
  assert.equal(base.model, 'fable');
  assert.equal(escalated.model, 'fable', 'the wire rule must never downgrade the judge to Opus');
  assert.equal(escalated.escalated, false, 'model escalation must not fire for VALIDATE at all');
  assert.equal(STEP_CONTRACTS.VALIDATE.escalatedModel, null);

  // The original invariant this test carried, kept verbatim in intent: the executor's model may
  // never judge its own work.
  assert.notEqual(base.model, 'sonnet');
  assert.notEqual(escalated.model, 'sonnet');
});

// The false-positive case this card is about: intake guessed RDO, but the real diff (rdoDiffTouched)
// says otherwise. 15 calls in the corpus took this exact shape. Effort must follow the diff, not
// the guess -- and the model must stay fable regardless, on every row.
test('resolveStepContract: VALIDATE effort follows rdoDiffTouched even when touchesRdoMembers disagrees (the false-positive case)', () => {
  const falsePositive = resolveStepContract('VALIDATE', { touchesRdoMembers: true, rdoDiffTouched: false });
  assert.equal(falsePositive.effort, 'high', 'intake guessed RDO but the diff says no -- must not buy xhigh');
  assert.equal(falsePositive.effortEscalated, false);
  assert.equal(falsePositive.model, 'fable');

  const truePositive = resolveStepContract('VALIDATE', { touchesRdoMembers: false, rdoDiffTouched: true });
  assert.equal(truePositive.effort, 'xhigh', 'the diff says RDO -- must buy xhigh even though intake guessed no');
  assert.equal(truePositive.effortEscalated, true);
  assert.equal(truePositive.model, 'fable');

  // Absent or non-boolean rdoDiffTouched (PUSH_PR hasn't run, or a corrupt task.json) must never be
  // coerced into an escalation -- same `=== true` strict-equality discipline as
  // resolveRdoDiffTouched's own guards (state-machine.js).
  for (const task of [{}, { rdoDiffTouched: undefined }, { rdoDiffTouched: 'true' }, { rdoDiffTouched: 1 }]) {
    const c = resolveStepContract('VALIDATE', task);
    assert.equal(c.effort, 'high', `${JSON.stringify(task)} must not escalate`);
    assert.equal(c.effortEscalated, false, `${JSON.stringify(task)} must not escalate`);
    assert.equal(c.model, 'fable', `${JSON.stringify(task)} must stay fable`);
  }
});

test('resolveStepContract: DIAGNOSE and CITATION_VERIFIER never escalate, whatever the task flags say', () => {
  const task = { size: 'L', touchesRdoMembers: true, escalate: true };
  // DIAGNOSE's BASE model moved fable -> opus on 2026-09-04 (price and Fable-quota concentration,
  // not diagnosis quality -- 7/7 calls succeeded post-C1). What this test pins is unchanged: no
  // task signal may move either step off its base.
  assert.equal(resolveStepContract('DIAGNOSE', task).model, 'opus');
  assert.equal(resolveStepContract('CITATION_VERIFIER', task).model, 'fable');
  assert.equal(shouldEscalate(STEP_CONTRACTS.DIAGNOSE, task), false);
  assert.equal(shouldEscalate(STEP_CONTRACTS.CITATION_VERIFIER, task), false);
});

// EXP-PLAN-OPUS (2026-09-13): PLAN runs one rung above the old low/medium/high. The ceiling matters as
// much as the floor: `xhigh` on L would push an Opus call plus its in-run Fable fallback toward
// PLAN's deadline. See PLAN_EFFORT_BY_SIZE's comment and doc/model-experiments.md.
test('resolveStepContract: PLAN effort follows task.size through PLAN_EFFORT_BY_SIZE (S/M/L -> medium/high/high)', () => {
  assert.equal(resolveStepContract('PLAN', { size: 'S' }).effort, 'medium');
  assert.equal(resolveStepContract('PLAN', { size: 'M' }).effort, 'high');
  assert.equal(resolveStepContract('PLAN', { size: 'L' }).effort, 'high');
  // The map belongs to the step, not the model: the Fable fallback call runs at the same effort.
  assert.equal(resolveStepContract('PLAN', { size: 'S', planInvalidRetry: true }).effort, 'medium');
  for (const size of ['S', 'M', 'L', undefined, 'nonsense']) {
    const { effort } = resolveStepContract('PLAN', { size });
    assert.ok(effort === 'medium' || effort === 'high', `size ${size} resolved PLAN effort ${effort}`);
  }
});

// IMPLEMENT stopped sharing PLAN's map on 2026-09-04: its S row is 'medium'. That change is a
// deliberate EXPERIMENT, not a measured win -- the corpus cannot settle it, because `effort` is a
// pure function of `size` through this map and so contains zero S-at-medium observations. See
// IMPLEMENT_EFFORT_BY_SIZE's comment for the real numbers and the revert criterion. What this test
// pins is only the FLOOR, so a future edit cannot restore `low` by accident rather than by
// deciding the experiment answered no.
test('resolveStepContract: IMPLEMENT has its own size map with a `medium` floor, never `low`', () => {
  assert.equal(resolveStepContract('IMPLEMENT', { size: 'S' }).effort, 'medium');
  assert.equal(resolveStepContract('IMPLEMENT', { size: 'M' }).effort, 'medium');
  assert.equal(resolveStepContract('IMPLEMENT', { size: 'L' }).effort, 'high');
  for (const size of ['S', 'M', 'L', undefined, 'nonsense']) {
    assert.notEqual(resolveStepContract('IMPLEMENT', { size }).effort, 'low', `size ${size} fell back to low`);
  }
});

// The maps must stay independent objects. Sharing one again would silently re-couple the two
// experiments, so reverting one of them would move the other.
test('resolveStepContract: PLAN and IMPLEMENT each carry their own size->effort map', () => {
  assert.notEqual(EFFORT_BY_SIZE.S, IMPLEMENT_EFFORT_BY_SIZE.S);
  assert.notEqual(EFFORT_BY_SIZE.S, PLAN_EFFORT_BY_SIZE.S);
  assert.notEqual(PLAN_EFFORT_BY_SIZE, IMPLEMENT_EFFORT_BY_SIZE);
  assert.equal(STEP_CONTRACTS.PLAN.effortBySize, PLAN_EFFORT_BY_SIZE);
  assert.equal(STEP_CONTRACTS.IMPLEMENT.effortBySize, IMPLEMENT_EFFORT_BY_SIZE);
});

// PLAN and IMPLEMENT (action 2.2, card #158) both carry a longer deadline than the other three
// steps, and MAX_LEASE_AGE_MS must follow the LONGEST one -- deriving it from the default (or from
// either literal in isolation) would understate the worst legitimate hold and reintroduce the C6
// defect where a waiter gives up while the holder is still alive.
test('resolveStepContract: PLAN and IMPLEMENT both carry the raised 1,800,000ms deadline; the rest keep the default', () => {
  assert.equal(resolveStepContract('PLAN', { size: 'L' }).deadlineMs, 1800000);
  assert.equal(resolveStepContract('IMPLEMENT', { size: 'L' }).deadlineMs, 1800000);
  for (const step of ['DIAGNOSE', 'CITATION_VERIFIER', 'VALIDATE']) {
    assert.equal(resolveStepContract(step, { size: 'L' }).deadlineMs, LLM_STEP_DEADLINE_MS, `${step} must keep the default`);
  }
  // Two different guards, verified by mutation to catch two different things -- neither one alone
  // is enough. Confirmed: stripping both assertions and adding `FUTURE_STEP: 3600000` to the map
  // still passed 22/0 with only the literal below restored, and the recomputed check ALONE cannot
  // ever fail against a mutated map, because MAX_LLM_STEP_DEADLINE_MS is DEFINED by this exact
  // expression in step-contracts.js -- recomputing the same formula here is tautological against
  // any map contents, so it guards a different mistake: MAX_LLM_STEP_DEADLINE_MS being replaced by
  // a hand-written literal that then silently drifts from the map (e.g. someone "simplifies" the
  // `Math.max(...)` to a number and forgets to update it when a new override is added).
  const recomputedMax = Math.max(LLM_STEP_DEADLINE_MS, ...Object.values(LLM_STEP_DEADLINE_MS_BY_STEP));
  assert.equal(MAX_LLM_STEP_DEADLINE_MS, recomputedMax, 'MAX_LLM_STEP_DEADLINE_MS must track the map, not drift from it');
  // THIS is the assertion that fails the moment a future override raises any step's deadline past
  // 1,800,000ms without whoever made that change re-checking what it does to the lease bound: a
  // hardcoded expected value that does NOT move with the map, unlike MAX_LLM_STEP_DEADLINE_MS
  // itself. Verified by mutation: adding `FUTURE_STEP: 3600000` to LLM_STEP_DEADLINE_MS_BY_STEP
  // fails exactly this line ("expected 1800000, got 3600000"), never the recomputed one above.
  assert.equal(
    MAX_LLM_STEP_DEADLINE_MS,
    1800000,
    'PLAN and IMPLEMENT tie at 1,800,000ms today -- the max must land there because of Math.max, not by coincidence'
  );
});

test('resolveStepContract: DIAGNOSE/CITATION_VERIFIER/VALIDATE are pinned high regardless of size', () => {
  for (const step of ['DIAGNOSE', 'CITATION_VERIFIER', 'VALIDATE']) {
    assert.equal(resolveStepContract(step, { size: 'S' }).effort, 'high');
    assert.equal(resolveStepContract(step, { size: 'L' }).effort, 'high');
  }
});

test('resolveStepContract: no $ budget cap on any step or size -- Claude Max subscription, no overage risk', () => {
  for (const step of ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'CITATION_VERIFIER', 'VALIDATE']) {
    for (const size of ['S', 'M', 'L']) {
      assert.equal(resolveStepContract(step, { size }).maxBudgetUsd, undefined);
    }
  }
});

test('resolveStepContract: jsonSchema.required mirrors the step outputContract', () => {
  const c = resolveStepContract('PLAN', {});
  assert.deepEqual(c.jsonSchema.required, c.outputContract.required);
  assert.equal(c.jsonSchema.type, 'object');
});

test('resolveStepContract: unknown step throws', () => {
  assert.throws(() => resolveStepContract('NOT_A_STEP', {}), /no contract for step/);
});

// =================================================================================================
// Card #207 -- outputContract `types` + checkOutputTypes/valueSatisfiesType/jsonSchemaPropertiesFor.
// =================================================================================================

// ---- valueSatisfiesType: one table-driven pass over every supported type spelling, a correct
// value, a wrongly-typed value, and (for the array spellings) the JSON-string-of-an-array case.
// checkOutputTypes' own JSON-string leniency is layered ON TOP of valueSatisfiesType (it re-tries
// JSON.parse(value) and re-checks the PARSED result against the same function) -- so
// valueSatisfiesType itself never accepts a string as satisfying an array type; that leniency is
// exercised separately, through checkOutputTypes, further down.
test('valueSatisfiesType: table-driven, one correct + one wrong value per supported type', () => {
  const cases = [
    ['string', 'a sentence', true],
    ['string', 42, false],
    ['number', 3.14, true],
    ['number', '3.14', false],
    ['number', NaN, false], // Number.isFinite(NaN) is false -- NaN is not a usable number
    ['boolean', true, true],
    ['boolean', 'true', false],
    ['object', { a: 1 }, true],
    ['object', [1, 2], false], // an array is NOT the 'object' type -- Array.isArray excluded explicitly
    ['array', [1, 2, 3], true],
    ['array', 'not an array', false],
    ['string[]', ['a', 'b'], true],
    ['string[]', [1, 2], false], // an array, but the wrong ELEMENT type
    ['string[]', 'a', false], // a bare string is not a string[] without the JSON-string leniency
    ['object[]', [{ a: 1 }, { b: 2 }], true],
    ['object[]', [{ a: 1 }, 'not an object'], false],
    ['object[]', [null], false], // null elements fail the 'object' element check (validate-findings.test.js's array-of-nulls case)
  ];
  for (const [type, value, expected] of cases) {
    assert.equal(
      valueSatisfiesType(value, type),
      expected,
      `valueSatisfiesType(${JSON.stringify(value)}, ${JSON.stringify(type)}) should be ${expected}`
    );
  }
});

// ---- checkOutputTypes: the JSON-string-of-an-array leniency, one case per array spelling.
test('checkOutputTypes: a JSON-encoded string that parses to an array of the right element type is accepted AND normalized in place', () => {
  const outputContract = { required: ['tags', 'notes'], types: { tags: 'string[]', notes: 'object[]' } };
  const payload = { tags: JSON.stringify(['a', 'b']), notes: JSON.stringify([{ x: 1 }]) };
  const { payload: normalized, failures } = checkOutputTypes(payload, outputContract);
  assert.deepEqual(failures, []);
  assert.deepEqual(normalized.tags, ['a', 'b'], 'the string was replaced with the parsed array');
  assert.deepEqual(normalized.notes, [{ x: 1 }]);
  assert.equal(normalized, payload, 'checkOutputTypes mutates and returns the SAME object, not a copy');
});

test('checkOutputTypes: a JSON-encoded string that parses to the WRONG element type is a genuine failure, not silently accepted', () => {
  const outputContract = { required: ['tags'], types: { tags: 'string[]' } };
  const { failures } = checkOutputTypes({ tags: JSON.stringify([1, 2, 3]) }, outputContract);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].key, 'tags');
});

test('checkOutputTypes: a present, non-null, wrongly-typed REQUIRED key fails and names the key/type/received value (verdict: 42)', () => {
  const { failures } = checkOutputTypes({ verdict: 42, reasons: [], findings: [] }, STEP_CONTRACTS.VALIDATE.outputContract);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], { key: 'verdict', type: 'string', received: 42 });
});

// Second fix pass (2026-09-13): the test above pins VALIDATE's `verdict` individually, but nothing
// pinned the other four enforced keys the same way -- an Opus verifier removed PLAN's
// `plan_markdown` type entirely and every existing test still passed (the only test that would
// have noticed, "at least one enforced key per step", is satisfied by `invariants_markdown`
// alone); removing `root_cause`'s type was caught only by that same generic test, never by a
// direct pin. This is table-driven and runs against the REAL `STEP_CONTRACTS`, one row per key
// this card actually enforces, so a future removal of any one of them fails HERE, by name, not by
// a generic "at least one" count going from 1 to 0.
test('checkOutputTypes: each of the five keys this card actually enforces fails INDIVIDUALLY when wrongly typed (table-driven, real STEP_CONTRACTS)', () => {
  const cases = [
    { step: 'VALIDATE', key: 'verdict', payload: { verdict: 42, reasons: [], findings: [] } },
    { step: 'CITATION_VERIFIER', key: 'verdict', payload: { verdict: 42, entries: [] } },
    { step: 'DIAGNOSE', key: 'root_cause', payload: { root_cause: 42 } },
    {
      step: 'PLAN',
      key: 'plan_markdown',
      payload: { plan_markdown: 42, invariants_markdown: '# Invariants\n', invariant_ids: '[]', check_commands: '[]' },
    },
    {
      step: 'PLAN',
      key: 'invariants_markdown',
      payload: { plan_markdown: '# Plan\n', invariants_markdown: 42, invariant_ids: '[]', check_commands: '[]' },
    },
    {
      step: 'IMPLEMENT',
      key: 'summary',
      payload: { summary: 42, files_changed: '[]', invariants: '[]', tests_run: '[]', all_green: 'true' },
    },
  ];
  for (const { step, key, payload } of cases) {
    const outputContract = STEP_CONTRACTS[step].outputContract;
    const { failures } = checkOutputTypes({ ...payload }, outputContract);
    assert.ok(
      failures.some((f) => f.key === key),
      `${step}.${key} wrongly typed (42) should fail -- got failures: ${JSON.stringify(failures)}`
    );
  }
});

test('checkOutputTypes: null is a wildcard against every declared type -- never a failure, never normalized', () => {
  const outputContract = { required: ['a', 'b', 'c'], types: { a: 'string', b: 'string[]', c: 'object' } };
  const payload = { a: null, b: null, c: null };
  const { payload: out, failures } = checkOutputTypes(payload, outputContract);
  assert.deepEqual(failures, []);
  assert.equal(out.a, null);
  assert.equal(out.b, null);
  assert.equal(out.c, null);
});

test('checkOutputTypes: a step whose outputContract declares no `types` at all is untouched -- behaves exactly as before this card', () => {
  const outputContract = { required: ['root_cause'] }; // no `types` key
  const { payload, failures } = checkOutputTypes({ root_cause: 42 }, outputContract);
  assert.deepEqual(failures, [], 'no types map means nothing is ever checked, however wrong the value');
  assert.equal(payload.root_cause, 42, 'and nothing is ever normalized either');
});

test('checkOutputTypes: a declared type on an OPTIONAL (non-required) key is schema-only -- never enforced, never normalized', () => {
  // Card #207 fix pass (2026-09-12): PLAN's `files_to_change` was this test's real-world example
  // until this same fix pass removed it from `types` entirely (see step-contracts.js's own header
  // comment -- 241/241 corpus occurrences are a JSON-encoded string, never measured before that
  // declaration was made). No key in the current table is BOTH optional and typed any more, so
  // this test now exercises the mechanism directly with a synthetic outputContract, the same way
  // the null-wildcard and no-`types`-at-all tests above already do -- it is testing
  // checkOutputTypes' own optional-is-schema-only rule, not any one step's current declarations.
  const outputContract = { required: ['a'], optional: ['b'], types: { a: 'string', b: 'string[]' } };
  const payload = { a: 'fine', b: 'not an array, not JSON, not anything sane' };
  const { payload: out, failures } = checkOutputTypes(payload, outputContract);
  assert.deepEqual(failures, [], 'a malformed OPTIONAL field must never fail the gate');
  assert.equal(out.b, payload.b, 'and must never be normalized either');
});

test('checkOutputTypes: VALIDATE reasons has no declared type -- a JSON-encoded string is left completely untouched, not normalized (state-machine.js journals it verbatim, card #640)', () => {
  const outputContract = STEP_CONTRACTS.VALIDATE.outputContract;
  assert.ok(!('reasons' in outputContract.types), 'sanity: reasons is deliberately undeclared');
  const raw = JSON.stringify(['the criterion is not met']);
  const payload = { verdict: 'REJECT', reasons: raw, findings: [] };
  const { payload: out, failures } = checkOutputTypes(payload, outputContract);
  assert.deepEqual(failures, []);
  assert.equal(out.reasons, raw, 'must stay the raw string -- normalizing here would corrupt the verbatim journal record');
});

test('checkOutputTypes: VALIDATE findings has no declared type -- a malformed value never fails here, matching test/validate-findings.test.js', () => {
  const outputContract = STEP_CONTRACTS.VALIDATE.outputContract;
  assert.ok(!('findings' in outputContract.types), 'sanity: findings is deliberately undeclared');
  for (const malformed of ['not json {{{', null, [null, null], { oops: true }]) {
    const { failures } = checkOutputTypes({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: malformed }, outputContract);
    assert.deepEqual(failures, [], `findings: ${JSON.stringify(malformed)} must never be a type failure`);
  }
});

// ---- F3 (card #207 fix pass, 2026-09-12): PLAN's `invariant_ids`/`check_commands` are the two
// exclusions NOTHING today would fail if they were reinstated (unlike `tests_run`/`invariants`,
// which the corpus replay above pins) -- reinstating either as `'string[]'` makes every existing
// test in this suite pass, because nothing else in the hermetic suite constructs a value with a
// comma INSIDE one array element (the shape that actually breaks prompt-template.js's
// `stringifyValue` re-join, per card #153: 14.5% of real `check_commands` contain one). This test
// exists so that a future "tidy-up" reinstating either declaration goes red here, even though it
// would go green everywhere else.
test('checkOutputTypes: PLAN check_commands/invariant_ids have no declared type -- a JSON-encoded array containing a comma inside one element reaches the consumer BYTE-IDENTICAL, never normalized in place (card #153\'s comma-corruption guard)', () => {
  const outputContract = STEP_CONTRACTS.PLAN.outputContract;
  assert.ok(!('check_commands' in outputContract.types), 'sanity: check_commands is deliberately undeclared');
  assert.ok(!('invariant_ids' in outputContract.types), 'sanity: invariant_ids is deliberately undeclared');

  // The comma sits INSIDE one command -- exactly the shape stringifyValue's `', '.join` would
  // corrupt if this were a real array instead of a JSON string re-read verbatim by
  // task-values.js/prompt-template.js.
  const checkCommandsRaw = JSON.stringify(['grep -Eq "kind, arity, and citation" src/foo.ts']);
  const invariantIdsRaw = JSON.stringify(['INV-1, the comma-bearing id']);
  const payload = {
    plan_markdown: '# Plan\n',
    invariants_markdown: '# Invariants\n',
    check_commands: checkCommandsRaw,
    invariant_ids: invariantIdsRaw,
  };
  const { payload: out, failures } = checkOutputTypes(payload, outputContract);
  assert.deepEqual(failures, []);
  assert.equal(out.check_commands, checkCommandsRaw, 'must stay the exact same JSON-encoded STRING -- normalizing to a real array here would silently reintroduce #153\'s comma-corruption once prompt-template.js\'s stringifyValue re-joins it with ", " for the next prompt');
  assert.equal(out.invariant_ids, invariantIdsRaw, 'same guard, same reason, for invariant_ids');
});

// ---- jsonSchemaPropertiesFor / the --json-schema envelope.
test('jsonSchemaPropertiesFor: undefined (not {}) for a step with no `types` at all -- omits `properties` entirely, byte-for-byte the pre-card-#207 envelope', () => {
  assert.equal(jsonSchemaPropertiesFor(undefined), undefined);
});

test('jsonSchemaPropertiesFor: translates every declared spelling to its JSON-Schema fragment', () => {
  const properties = jsonSchemaPropertiesFor({
    a: 'string',
    b: 'number',
    c: 'boolean',
    d: 'object',
    e: 'array',
    f: 'string[]',
    g: 'object[]',
  });
  assert.deepEqual(properties, {
    a: { type: 'string' },
    b: { type: 'number' },
    c: { type: 'boolean' },
    d: { type: 'object' },
    e: { type: 'array' },
    f: { type: 'array', items: { type: 'string' } },
    g: { type: 'array', items: { type: 'object' } },
  });
});

test('resolveStepContract: the generated --json-schema envelope carries `properties` for every declared key, on every step that declares any', () => {
  for (const step of ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'CITATION_VERIFIER', 'VALIDATE']) {
    const { jsonSchema, outputContract } = resolveStepContract(step, {});
    if (!outputContract.types) {
      assert.ok(!('properties' in jsonSchema), `${step}: no types declared, so no properties key expected`);
      continue;
    }
    assert.ok('properties' in jsonSchema, `${step}: types declared, so properties must be present`);
    assert.deepEqual(Object.keys(jsonSchema.properties).sort(), Object.keys(outputContract.types).sort());
  }
});

test('resolveStepContract: DIAGNOSE/CITATION_VERIFIER/VALIDATE/IMPLEMENT all declare at least one required-key type today', () => {
  // Not PLAN's invariant_ids/check_commands (deliberately undeclared, see step-contracts.js's own
  // header comment) -- but every step's outputContract should have SOME enforced type, so this
  // guards against a future edit silently emptying one out.
  for (const step of ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'CITATION_VERIFIER', 'VALIDATE']) {
    const { outputContract } = resolveStepContract(step, {});
    const enforcedKeys = Object.keys(outputContract.types || {}).filter((k) => outputContract.required.includes(k));
    assert.ok(enforcedKeys.length > 0, `${step}: expected at least one required key with a declared, enforced type`);
  }
});
