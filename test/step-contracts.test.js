'use strict';
// Unit tests for orchestrator/step-contracts.js -- the table + resolver that replaces the
// interim ctx.task.llm.<step> config source for a real `kind: "card"` task.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { STEP_CONTRACTS, resolveStepContract, shouldEscalate } = require('../orchestrator/step-contracts');
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

test('resolveStepContract: PLAN escalates on the generic task.escalate fallback flag', () => {
  const c = resolveStepContract('PLAN', { size: 'S', escalate: true });
  assert.equal(c.model, 'opus');
  assert.equal(c.escalated, true);
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

test('resolveStepContract: VALIDATE escalates on touchesRdoMembers, never becomes sonnet', () => {
  const base = resolveStepContract('VALIDATE', { touchesRdoMembers: false });
  assert.equal(base.model, 'fable');
  const escalated = resolveStepContract('VALIDATE', { touchesRdoMembers: true });
  assert.equal(escalated.model, 'opus');
  assert.notEqual(base.model, 'sonnet');
  assert.notEqual(escalated.model, 'sonnet');
});

test('resolveStepContract: DIAGNOSE and CITATION_VERIFIER never escalate, whatever the task flags say', () => {
  const task = { size: 'L', touchesRdoMembers: true, escalate: true };
  assert.equal(resolveStepContract('DIAGNOSE', task).model, 'fable');
  assert.equal(resolveStepContract('CITATION_VERIFIER', task).model, 'fable');
  assert.equal(shouldEscalate(STEP_CONTRACTS.DIAGNOSE, task), false);
  assert.equal(shouldEscalate(STEP_CONTRACTS.CITATION_VERIFIER, task), false);
});

test('resolveStepContract: effort follows task.size for PLAN/IMPLEMENT (S/M/L -> low/medium/high)', () => {
  assert.equal(resolveStepContract('PLAN', { size: 'S' }).effort, 'low');
  assert.equal(resolveStepContract('PLAN', { size: 'M' }).effort, 'medium');
  assert.equal(resolveStepContract('PLAN', { size: 'L' }).effort, 'high');
  assert.equal(resolveStepContract('IMPLEMENT', { size: 'S' }).effort, 'low');
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
