'use strict';
// Unit tests for HANDLERS.PLAN (state-machine.js's handlePlan) -- PLAN runs permissionMode:
// 'plan' (read-only) and cannot write files itself, so it returns plan_markdown/
// invariants_markdown and this handler writes them to scratch_dir/plan-<issue>.md /
// invariants-<issue>.md, journals what it wrote, and parks 'plan-invalid' when a field is
// missing or empty. See prompts/plan.md + step-contracts.js for the contract this enforces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function shadowCtx(task, taskDir) {
  return buildCtx(task.id, task, taskDir, { shadowMode: true, dryRun: false });
}

test('handlePlan: no llm.PLAN fixture wired (shadow default) -- trivially ok, nothing to validate or write, still reaches IMPLEMENT', async () => {
  const taskDir = mkTmp('spo-plan-nofixture-');
  const task = { id: 'synth-1', kind: 'synthetic' };
  const ctx = shadowCtx(task, taskDir);

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(fs.existsSync(path.join(taskDir, 'scratch')), false, 'no fixture means nothing to write');
});

test('handlePlan: a real PLAN payload writes plan-<issue>.md and invariants-<issue>.md under scratch_dir, journals both, and re-journals the result with plan_path/invariants_path added', async () => {
  const taskDir = mkTmp('spo-plan-write-');
  const task = {
    id: 'card-247',
    kind: 'card',
    issue: 247,
    shadow: {
      llm: {
        PLAN: {
          ok: true,
          plan_markdown: '# Plan\n\nAdd the widget.\n',
          invariants_markdown: '# Invariants\n\nINV-1: ...\n',
          invariant_ids: ['INV-1'],
          check_commands: ['npm run typecheck'],
        },
      },
    },
  };
  const ctx = shadowCtx(task, taskDir);

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');

  const scratchDir = path.join(taskDir, 'scratch');
  const planPath = path.join(scratchDir, 'plan-247.md');
  const invariantsPath = path.join(scratchDir, 'invariants-247.md');
  assert.equal(fs.readFileSync(planPath, 'utf8'), '# Plan\n\nAdd the widget.\n');
  assert.equal(fs.readFileSync(invariantsPath, 'utf8'), '# Invariants\n\nINV-1: ...\n');

  const journal = readJournal(taskDir);
  const written = journal.find((e) => e.event === 'files-written');
  assert.ok(written, 'expected a files-written journal event');
  assert.equal(written.planPath, planPath);
  assert.equal(written.invariantsPath, invariantsPath);

  // task-values.js's IMPLEMENT/VALIDATE placeholder derivation reads the *last* PLAN 'result'
  // event back off the journal -- it must carry plan_path/invariants_path, not just the raw
  // plan_markdown/invariants_markdown text the model returned.
  const results = journal.filter((e) => e.event === 'result');
  const lastResult = results[results.length - 1];
  assert.equal(lastResult.payload.plan_path, planPath);
  assert.equal(lastResult.payload.invariants_path, invariantsPath);
  assert.deepEqual(lastResult.payload.invariant_ids, ['INV-1']);
  assert.deepEqual(lastResult.payload.check_commands, ['npm run typecheck']);
});

test('handlePlan: empty invariants_markdown parks plan-invalid and writes nothing', async () => {
  const taskDir = mkTmp('spo-plan-empty-invariants-');
  const task = {
    id: 'card-9',
    kind: 'card',
    issue: 9,
    shadow: {
      llm: {
        PLAN: {
          ok: true,
          plan_markdown: '# Plan\n',
          invariants_markdown: '   ', // whitespace only -- not real content
          invariant_ids: [],
          check_commands: ['npm test'],
        },
      },
    },
  };
  const ctx = shadowCtx(task, taskDir);

  await assert.rejects(
    () => HANDLERS.PLAN(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'plan-invalid' && err.detail.missing.includes('invariants_markdown')
  );
  assert.equal(fs.existsSync(path.join(taskDir, 'scratch')), false, 'must not write a partial plan');
});

test('handlePlan: missing plan_markdown entirely parks plan-invalid', async () => {
  const taskDir = mkTmp('spo-plan-missing-plan-');
  const task = {
    id: 'card-10',
    kind: 'card',
    issue: 10,
    shadow: {
      llm: {
        PLAN: {
          ok: true,
          invariants_markdown: '# Invariants\n',
          invariant_ids: [],
          check_commands: [],
        },
      },
    },
  };
  const ctx = shadowCtx(task, taskDir);

  await assert.rejects(
    () => HANDLERS.PLAN(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'plan-invalid' && err.detail.missing.includes('plan_markdown')
  );
});

test('handlePlan: an explicit ok:false payload still parks plan-invalid (unchanged pre-existing behaviour)', async () => {
  const taskDir = mkTmp('spo-plan-ok-false-');
  const task = {
    id: 'card-11',
    kind: 'card',
    issue: 11,
    shadow: { llm: { PLAN: { ok: false, error: 'boom' } } },
  };
  const ctx = shadowCtx(task, taskDir);

  await assert.rejects(() => HANDLERS.PLAN(ctx), (err) => err instanceof ParkSignal && err.reason === 'plan-invalid');
});
