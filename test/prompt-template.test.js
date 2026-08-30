'use strict';
// Unit tests for orchestrator/prompt-template.js (loader + filler) and
// orchestrator/task-values.js (the placeholder-derivation this task shape feeds it).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  fillPromptTemplate,
  extractPlaceholders,
  MissingPlaceholderError,
} = require('../orchestrator/prompt-template');
const { buildPromptValues } = require('../orchestrator/task-values');
const { appendEvent } = require('../orchestrator/journal');
const { STEP_CONTRACTS } = require('../orchestrator/step-contracts');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- extractPlaceholders / fillPromptTemplate, happy + missing path ----------------------

test('extractPlaceholders: plan.md declares exactly its header placeholders', () => {
  const placeholders = extractPlaceholders(fs.readFileSync(STEP_CONTRACTS.PLAN.promptFile, 'utf8'));
  for (const name of ['issue_number', 'task_title', 'task_criterion', 'worktree', 'scratch_dir', 'task_size']) {
    assert.ok(placeholders.includes(name), `expected ${name} in ${placeholders}`);
  }
});

test('fillPromptTemplate: happy path substitutes every declared placeholder, no {{...}} survives', () => {
  const filled = fillPromptTemplate(STEP_CONTRACTS.PLAN.promptFile, {
    issue_number: 42,
    task_title: 'Add widget',
    task_criterion: 'the widget renders',
    worktree: '/tmp/worktree-42',
    scratch_dir: '/tmp/scratch-42',
    task_size: 'S',
  });
  assert.ok(!/\{\{\w+\}\}/.test(filled), 'no unfilled {{placeholder}} should remain');
  assert.ok(filled.includes('/tmp/worktree-42'));
  assert.ok(filled.includes('Add widget'));
});

test('fillPromptTemplate: an array value is joined with ", "', () => {
  const filled = fillPromptTemplate(STEP_CONTRACTS.IMPLEMENT.promptFile, {
    issue_number: 1,
    worktree: '/tmp/w',
    task_criterion: 'c',
    plan_path: '/tmp/scratch/plan-1.md',
    invariants_path: '/tmp/scratch/invariants-1.md',
    invariant_ids: ['INV-1', 'INV-2'],
    check_commands: ['npm run typecheck', 'npm run lint'],
    diagnosis: '(none yet -- this is the first IMPLEMENT attempt for this task)',
  });
  assert.ok(filled.includes('INV-1, INV-2'));
  assert.ok(filled.includes('npm run typecheck, npm run lint'));
});

test('fillPromptTemplate: one missing placeholder throws MissingPlaceholderError naming it, no partial fill', () => {
  assert.throws(
    () =>
      fillPromptTemplate(STEP_CONTRACTS.PLAN.promptFile, {
        issue_number: 1,
        task_title: 't',
        task_criterion: 'c',
        worktree: '/tmp/w',
        // scratch_dir intentionally omitted
        task_size: 'S',
      }),
    (err) => err instanceof MissingPlaceholderError && err.placeholder === 'scratch_dir'
  );
});

test('fillPromptTemplate: a null value counts as missing, same as undefined', () => {
  assert.throws(
    () =>
      fillPromptTemplate(STEP_CONTRACTS.DIAGNOSE.promptFile, {
        diff_path: '/tmp/diff.patch',
        gate_log_path: null,
        ledger_path: '/tmp/ledger.md',
      }),
    MissingPlaceholderError
  );
});

test('fillPromptTemplate: an empty array is a valid value, not "missing" (zero invariants is valid per plan.md)', () => {
  const filled = fillPromptTemplate(STEP_CONTRACTS.IMPLEMENT.promptFile, {
    issue_number: 1,
    worktree: '/tmp/w',
    task_criterion: 'c',
    plan_path: '/tmp/plan.md',
    invariants_path: '/tmp/invariants.md',
    invariant_ids: [],
    check_commands: [],
    diagnosis: '(none yet -- this is the first IMPLEMENT attempt for this task)',
  });
  assert.ok(!/\{\{\w+\}\}/.test(filled));
});

// ---- task-values.js: placeholder derivation for a kind:"card" task -----------------------

test('buildPromptValues: PLAN reads straight off the task + taskDir, nothing from the journal yet', () => {
  const taskDir = mkTmp('spo-values-plan-');
  const ctx = {
    taskDir,
    task: {
      issue: 7,
      title: 'Fix the thing',
      criterion: 'the thing is fixed',
      worktreePath: '/tmp/worktree-7',
      size: 'M',
    },
  };
  const values = buildPromptValues(ctx, 'PLAN');
  assert.equal(values.issue_number, 7);
  assert.equal(values.task_title, 'Fix the thing');
  assert.equal(values.worktree, '/tmp/worktree-7');
  assert.equal(values.task_size, 'M');
  assert.equal(values.scratch_dir, path.join(taskDir, 'scratch'));
});

test('buildPromptValues: IMPLEMENT reads plan_path/invariants_path/invariant_ids/check_commands from PLAN\'s journaled result', () => {
  const taskDir = mkTmp('spo-values-implement-');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      ok: true,
      plan_path: '/tmp/scratch/plan-7.md',
      invariants_path: '/tmp/scratch/invariants-7.md',
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    },
  });
  const ctx = {
    taskDir,
    task: { issue: 7, criterion: 'the thing is fixed', worktreePath: '/tmp/worktree-7' },
  };
  const values = buildPromptValues(ctx, 'IMPLEMENT');
  assert.equal(values.plan_path, '/tmp/scratch/plan-7.md');
  assert.equal(values.invariants_path, '/tmp/scratch/invariants-7.md');
  assert.deepEqual(values.invariant_ids, ['INV-1']);
  assert.deepEqual(values.check_commands, ['npm run typecheck']);
});

test('buildPromptValues: IMPLEMENT before PLAN has run leaves plan_path etc. undefined (surfaces as MissingPlaceholderError upstream)', () => {
  const taskDir = mkTmp('spo-values-implement-noplan-');
  const ctx = { taskDir, task: { issue: 7, worktreePath: '/tmp/w' } };
  const values = buildPromptValues(ctx, 'IMPLEMENT');
  assert.equal(values.plan_path, undefined);
});

test('buildPromptValues: IMPLEMENT diagnosis defaults to a fixed "none yet" string when DIAGNOSE never ran (never undefined)', () => {
  const taskDir = mkTmp('spo-values-implement-nodiag-');
  const ctx = { taskDir, task: { issue: 7, worktreePath: '/tmp/w' } };
  const values = buildPromptValues(ctx, 'IMPLEMENT');
  assert.equal(values.diagnosis, '(none yet -- this is the first IMPLEMENT attempt for this task)');
});

test('buildPromptValues: IMPLEMENT diagnosis surfaces DIAGNOSE\'s rootCause/category/suggestedFix from the journal (the issue-213 gap)', () => {
  const taskDir = mkTmp('spo-values-implement-diag-');
  appendEvent(taskDir, 'DIAGNOSE', 'result', {
    attempt: 1,
    payload: {
      rootCause: 'SSRF: proxy-image.ts:163 fetches the raw user-controlled imageUrl',
      category: 'security',
      suggestedFix: 'Validate imageUrl against the allow-list before fetchWithTimeout is called.',
    },
  });
  const ctx = { taskDir, task: { issue: 213, worktreePath: '/tmp/w' } };
  const values = buildPromptValues(ctx, 'IMPLEMENT');
  assert.match(values.diagnosis, /root cause: SSRF/);
  assert.match(values.diagnosis, /category: security/);
  assert.match(values.diagnosis, /suggested fix: Validate imageUrl/);
});

test('buildPromptValues: IMPLEMENT diagnosis reads the LATEST DIAGNOSE result, not an earlier one', () => {
  const taskDir = mkTmp('spo-values-implement-diaglatest-');
  appendEvent(taskDir, 'DIAGNOSE', 'result', { attempt: 1, payload: { rootCause: 'first-cause', category: null, suggestedFix: null } });
  appendEvent(taskDir, 'DIAGNOSE', 'result', { attempt: 2, payload: { rootCause: 'second-cause', category: null, suggestedFix: null } });
  const ctx = { taskDir, task: { issue: 7, worktreePath: '/tmp/w' } };
  const values = buildPromptValues(ctx, 'IMPLEMENT');
  assert.match(values.diagnosis, /second-cause/);
  assert.ok(!/first-cause/.test(values.diagnosis));
});

test('buildPromptValues: DIAGNOSE ledger_path is always journal/<id>/ledger.md', () => {
  const taskDir = mkTmp('spo-values-diagnose-');
  const values = buildPromptValues({ taskDir, task: {} }, 'DIAGNOSE');
  assert.equal(values.ledger_path, path.join(taskDir, 'ledger.md'));
});

test('buildPromptValues: CITATION_VERIFIER defaults spo_original_path to ~/SPO-Original', () => {
  const taskDir = mkTmp('spo-values-citeverify-');
  const values = buildPromptValues({ taskDir, task: { citations: ['X — Y.pas:1 — claim'] } }, 'CITATION_VERIFIER');
  assert.equal(values.spo_original_path, path.join(os.homedir(), 'SPO-Original'));
  assert.deepEqual(values.citations, ['X — Y.pas:1 — claim']);
});

// ---- prompts/*.md: no unbounded network call ------------------------------------------------
// Card #449, 2026-08-30: prompts/triage-bug-report.md's server-log curl had no --max-time, so a
// slow/unresponsive third-party server could hang inside the intake deadline undetected until the
// kill. Guards every prompt against the same class of regression, not just that one line.

test('prompts/*.md: every curl call inside a code fence bounds its own time (--max-time or -m)', () => {
  const promptsDir = path.join(__dirname, '..', 'prompts');
  for (const file of fs.readdirSync(promptsDir)) {
    if (!file.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(promptsDir, file), 'utf8');
    const codeBlocks = text.match(/```[\s\S]*?```/g) || [];
    for (const block of codeBlocks) {
      for (const line of block.split('\n')) {
        if (!/^\s*curl\b/.test(line)) continue;
        assert.match(
          line,
          /(--max-time|-m\s)/,
          `${file}: curl call has no --max-time/-m: ${line.trim()}`
        );
      }
    }
  }
});
