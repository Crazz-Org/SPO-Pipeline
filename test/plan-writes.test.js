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
const { writePoolDir } = require('./helpers');

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

// ---- action 1.8: PLAN-time invariants baseline (real mode only) --------------------------------

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// A real-mode PLAN reply's spawnSync stand-in: exactly invokeClaudeReal's expected envelope
// (steps/llm.js), stdout is the JSON string, `result` inside it is itself the JSON-encoded
// PLAN payload (plan_markdown/invariants_markdown/invariant_ids/check_commands).
function fakePlanSpawn(planPayload) {
  return () => ({
    status: 0,
    stdout: JSON.stringify({
      result: JSON.stringify(planPayload),
      is_error: false,
      num_turns: 1,
      session_id: 'sess-plan-baseline',
      modelUsage: { 'claude-fable-5': { costUSD: 0.001 } },
      terminal_reason: 'success',
      api_error_status: null,
    }),
    stderr: '',
    signal: null,
  });
}

function realPlanCtx({ id, task, taskDir, accountsDir, deps }) {
  return buildCtx(id, task, taskDir, {
    claudeAccountsDir: accountsDir,
    stepDeadlineMs: 30000,
    shadowMode: false,
    dryRun: false,
    deps,
  });
}

test('handlePlan (real mode): journals a PLAN-time invariants baseline -- a resolving quote is resolved (exact), a non-matching one is excluded with a reason', async () => {
  const worktreePath = mkTmp('spo-plan-baseline-wt-');
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const accountsDir = mkTmp('spo-plan-baseline-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);

  const invariantsMarkdown = [
    '## INV-1',
    'File: foo.js:1-3',
    '>>> QUOTE',
    'function foo() {\n  return 42;\n}',
    '>>> END QUOTE',
    '',
    '## INV-2',
    'File: foo.js:99',
    '>>> QUOTE',
    'this text was never in foo.js',
    '>>> END QUOTE',
    '',
  ].join('\n');

  const deps = {
    spawnSync: fakePlanSpawn({
      plan_markdown: '# Plan\n\nDo the thing.\n',
      invariants_markdown: invariantsMarkdown,
      invariant_ids: ['INV-1', 'INV-2'],
      check_commands: ['npm run typecheck'],
    }),
  };

  const task = {
    id: 'card-baseline-1',
    kind: 'card',
    issue: 601,
    title: 'Do the thing',
    criterion: 'the thing is done',
    worktreePath,
    size: 'S',
  };
  const ctx = realPlanCtx({ id: 'card-baseline-1', task, taskDir: mkTmp('spo-plan-baseline-taskdir-'), accountsDir, deps });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(ctx.taskDir);
  const baseline = journal.find((e) => e.event === 'invariants-baseline');
  assert.ok(baseline, 'expected an invariants-baseline event');
  assert.equal(baseline.parseError, null);

  // The canary: PLAN declared two ids and the parser found two. A mismatch here is journalled
  // loudly precisely because the feature otherwise fails silently open.
  assert.ok(
    !journal.some((e) => e.event === 'invariants-declared-parsed-mismatch'),
    'a well-formed plan must not trip the declared-vs-parsed canary'
  );

  const inv1 = baseline.invariants.find((i) => i.id === 'INV-1');
  const inv2 = baseline.invariants.find((i) => i.id === 'INV-2');
  assert.equal(inv1.resolved, true);
  assert.equal(inv1.mode, 'exact');
  assert.equal(inv2.resolved, false);
  assert.equal(inv2.reason, 'not-found');
});

test('handlePlan (real mode): zero invariants -> journals an empty baseline, not an error', async () => {
  const worktreePath = mkTmp('spo-plan-baseline-zero-wt-');
  const accountsDir = mkTmp('spo-plan-baseline-zero-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);

  const deps = {
    spawnSync: fakePlanSpawn({
      plan_markdown: '# Plan\n\nAdds wholly new ground, nothing to depend on.\n',
      invariants_markdown: '# Invariants\n\nNone -- new ground.\n',
      invariant_ids: [],
      check_commands: [],
    }),
  };

  const task = {
    id: 'card-baseline-2',
    kind: 'card',
    issue: 602,
    title: 'Add new ground',
    criterion: 'new ground exists',
    worktreePath,
    size: 'S',
  };
  const ctx = realPlanCtx({ id: 'card-baseline-2', task, taskDir: mkTmp('spo-plan-baseline-zero-taskdir-'), accountsDir, deps });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');

  const baseline = readJournal(ctx.taskDir).find((e) => e.event === 'invariants-baseline');
  assert.ok(baseline);
  assert.equal(baseline.parseError, null);
  assert.deepEqual(baseline.invariants, []);
});

test('regression: handlePlan never builds an invariants baseline in shadow mode', async () => {
  const worktreePath = mkTmp('spo-plan-baseline-shadow-wt-');
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const taskDir = mkTmp('spo-plan-baseline-shadow-taskdir-');
  const task = {
    id: 'card-baseline-shadow',
    kind: 'card',
    issue: 603,
    worktreePath,
    shadow: {
      llm: {
        PLAN: {
          ok: true,
          plan_markdown: '# Plan\n',
          invariants_markdown: ['## INV-1', 'File: foo.js:1-3', '>>> QUOTE', 'function foo() {', '>>> END QUOTE', ''].join('\n'),
          invariant_ids: ['INV-1'],
          check_commands: ['npm test'],
        },
      },
    },
  };
  const ctx = shadowCtx(task, taskDir);

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(readJournal(taskDir).some((e) => e.event === 'invariants-baseline'), false);
});

test('regression: handlePlan never builds an invariants baseline in --dry-run', async () => {
  const worktreePath = mkTmp('spo-plan-baseline-dryrun-wt-');
  const taskDir = mkTmp('spo-plan-baseline-dryrun-taskdir-');
  const accountsDir = mkTmp('spo-plan-baseline-dryrun-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);
  const task = {
    id: 'card-baseline-dryrun',
    kind: 'card',
    issue: 604,
    title: 'Dry run card',
    criterion: 'n/a',
    worktreePath,
    size: 'S',
  };
  // --dry-run still goes through callLlmStep's real-mode account-rotation branch (it only
  // branches on ctx.shadowMode, never ctx.dryRun) even though runLlm itself then takes the
  // dry-run short-circuit before ever spawning -- an account pool is still required here, same
  // as every other --dry-run test in this suite (see test/real-steps.test.js's own --dry-run
  // tests).
  const ctx = buildCtx('card-baseline-dryrun', task, taskDir, {
    shadowMode: false,
    dryRun: true,
    claudeAccountsDir: accountsDir,
    stepDeadlineMs: 30000,
  });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(readJournal(taskDir).some((e) => e.event === 'invariants-baseline'), false);
});

// The regression the canary exists for. The invariant check fails OPEN by design: if the parser
// stops recognising plan.md's format, every invariant lands unresolved, the baseline is empty,
// CHECK verifies nothing, and the pipeline looks healthy. The first cut of invariants.js did
// exactly this on a CRLF file. PLAN's own invariant_ids is an independent count of what the
// model believed it wrote, so declared-vs-parsed is the one cheap signal that surfaces it.
test('handlePlan: PLAN declaring invariant ids the parser cannot find journals a declared-vs-parsed mismatch, and still does not park', async () => {
  const worktreePath = mkTmp('spo-plan-canary-wt-');
  const accountsDir = mkTmp('spo-plan-canary-accounts-');
  writePoolDir(accountsDir, [{ name: 'acct-1', oauthToken: 'tok' }]);
  fs.writeFileSync(path.join(worktreePath, 'a.js'), 'const x = 1;\n');

  const deps = {
    spawnSync: fakePlanSpawn({
      plan_markdown: '# Plan\n\nDo the thing.\n',
      // Prose the parser cannot read: no ## INV-<n> blocks at all, yet three ids declared.
      invariants_markdown: '# Invariants\n\nINV-1, INV-2 and INV-3 all hold in a.js.\n',
      invariant_ids: ['INV-1', 'INV-2', 'INV-3'],
      check_commands: ['npm run typecheck'],
    }),
  };

  const task = {
    id: 'card-canary-1',
    kind: 'card',
    issue: 602,
    title: 'Do the thing',
    criterion: 'the thing is done',
    worktreePath,
    size: 'S',
  };
  const ctx = realPlanCtx({ id: 'card-canary-1', task, taskDir: mkTmp('spo-plan-canary-taskdir-'), accountsDir, deps });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT', 'a parser/prompt divergence must never park the card');

  const journal = readJournal(ctx.taskDir);
  const mismatch = journal.find((e) => e.event === 'invariants-declared-parsed-mismatch');
  assert.ok(mismatch, 'expected the declared-vs-parsed canary to fire');
  assert.equal(mismatch.declared, 3);
  assert.equal(mismatch.parsed, 0);
  assert.deepEqual(mismatch.declaredIds, ['INV-1', 'INV-2', 'INV-3']);

  // The baseline is still written, still empty, and CHECK will therefore verify nothing --
  // fail-open is the intended behaviour; the canary is what makes it visible.
  const baseline = journal.find((e) => e.event === 'invariants-baseline');
  assert.ok(baseline);
  assert.equal(baseline.invariants.length, 0);
});
