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
  LLM_STEP_DEADLINE_MS,
  MAX_LLM_STEP_DEADLINE_MS,
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
  assert.equal(c.model, 'fable');
  assert.equal(c.escalated, false);
});

// Replaces 'PLAN escalates on the generic task.escalate fallback flag' (2026-09-04). That flag was
// removed: `task.escalate` is assigned nowhere in orchestrator/, bin/ or console/, so the escalation
// both docs promised could never fire. The regression this guards is someone re-adding a PLAN
// escalation without a trigger that actually exists -- note it asserts on a task carrying EVERY
// signal the other steps escalate on, not just the deleted one.
test('resolveStepContract: PLAN never escalates -- no reachable trigger exists, and `escalate` is gone', () => {
  for (const task of [{ size: 'S' }, { size: 'S', escalate: true }, { size: 'L', touchesRdoMembers: true, escalate: true }]) {
    const c = resolveStepContract('PLAN', task);
    assert.equal(c.model, 'fable', `PLAN must stay Fable for ${JSON.stringify(task)}`);
    assert.equal(c.escalated, false);
  }
  assert.equal(STEP_CONTRACTS.PLAN.escalatedModel, null, 'the table must not advertise an unreachable escalation');
  assert.deepEqual(STEP_CONTRACTS.PLAN.escalatesOn, []);
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

test('resolveStepContract: IMPLEMENT escalates on touchesRdoMembers', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'S', touchesRdoMembers: true });
  assert.equal(c.model, 'opus');
});

test('resolveStepContract: IMPLEMENT escalates on an L-sized task even with no RDO touch', () => {
  const c = resolveStepContract('IMPLEMENT', { size: 'L', touchesRdoMembers: false });
  assert.equal(c.model, 'opus');
});

test('resolveStepContract: IMPLEMENT stays Sonnet for a plain S/M task', () => {
  assert.equal(resolveStepContract('IMPLEMENT', { size: 'S' }).model, 'sonnet');
  assert.equal(resolveStepContract('IMPLEMENT', { size: 'M' }).model, 'sonnet');
});

// Rewritten 2026-09-04: VALIDATE escalates EFFORT, never model. `fable -> opus` was a downgrade
// (Fable is the more capable and twice the price), so the old rule made the judge weaker exactly on
// the RDO wire -- observed live on card #462, where IMPLEMENT escalated sonnet -> opus (up) while
// VALIDATE escalated fable -> opus (down) in the same run.
test('resolveStepContract: VALIDATE escalates EFFORT on touchesRdoMembers, and never changes model', () => {
  const base = resolveStepContract('VALIDATE', { touchesRdoMembers: false });
  const escalated = resolveStepContract('VALIDATE', { touchesRdoMembers: true });

  assert.equal(base.effort, 'high');
  assert.equal(escalated.effort, 'xhigh', 'the wire rule must buy more effort');
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

test('resolveStepContract: PLAN effort follows task.size (S/M/L -> low/medium/high)', () => {
  assert.equal(resolveStepContract('PLAN', { size: 'S' }).effort, 'low');
  assert.equal(resolveStepContract('PLAN', { size: 'M' }).effort, 'medium');
  assert.equal(resolveStepContract('PLAN', { size: 'L' }).effort, 'high');
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

// The two maps must stay independent objects: sharing one again would silently re-couple the steps,
// and the next edit to PLAN's floor would move IMPLEMENT's with it.
test('resolveStepContract: PLAN and IMPLEMENT do not share one size->effort map', () => {
  assert.notEqual(EFFORT_BY_SIZE.S, IMPLEMENT_EFFORT_BY_SIZE.S);
  assert.equal(STEP_CONTRACTS.PLAN.effortBySize, undefined, 'PLAN uses the shared default');
  assert.equal(STEP_CONTRACTS.IMPLEMENT.effortBySize, IMPLEMENT_EFFORT_BY_SIZE);
});

// PLAN is the only step with a longer deadline, and MAX_LEASE_AGE_MS must follow the LONGEST one --
// deriving it from the default would understate the worst legitimate hold and reintroduce the C6
// defect where a waiter gives up while the holder is still alive.
test('resolveStepContract: PLAN carries a longer deadline than every other step', () => {
  assert.equal(resolveStepContract('PLAN', { size: 'L' }).deadlineMs, 1800000);
  for (const step of ['IMPLEMENT', 'DIAGNOSE', 'CITATION_VERIFIER', 'VALIDATE']) {
    assert.equal(resolveStepContract(step, { size: 'L' }).deadlineMs, LLM_STEP_DEADLINE_MS, `${step} must keep the default`);
  }
  assert.equal(MAX_LLM_STEP_DEADLINE_MS, 1800000, 'the lease bound must derive from the longest deadline, not the default');
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
