'use strict';
// Unit tests for HANDLERS.PLAN (state-machine.js's handlePlan) -- PLAN runs permissionMode:
// 'plan' (read-only) and cannot write files itself, so it returns plan_markdown/
// invariants_markdown and this handler writes them to scratch_dir/plan-<issue>.md /
// invariants-<issue>.md, journals what it wrote, and parks 'plan-invalid' when a field is
// missing or empty. See prompts/plan.md + step-contracts.js for the contract this enforces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { appendEvent } = require('../orchestrator/journal');
const { writePoolDir, mkTmp } = require('./helpers');


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

// ---- wire-shape fix, 2026-09-07: invariant_ids arrives JSON-ENCODED-STRING on the wire, exactly
// like files_to_change (#118) -- measured 159/159 on the live journal corpus. The canary's
// `Array.isArray(payload.invariant_ids) ? ... : []` test rejected that shape on every card, so
// `declared` was always 0 and none of the 58 mismatch events on record ever compared two real
// numbers. These tests pin state-machine.js's normalizeDeclaredInvariantIds against the shape
// production actually sends, not the array shape the pre-existing tests above use.

test('handlePlan: PLAN declaring invariant ids as a JSON-STRING (the real wire shape) that matches what the parser finds does NOT trip the canary -- pins the fix (fails under the old Array.isArray test: declared 0 vs parsed 2)', async () => {
  const worktreePath = mkTmp('spo-plan-canary-jsonstring-match-wt-');
  const accountsDir = mkTmp('spo-plan-canary-jsonstring-match-accounts-');
  writePoolDir(accountsDir, [{ name: 'acct-1', oauthToken: 'tok' }]);
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

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
      // The real wire shape: a JSON-encoded string, not a real array.
      invariant_ids: '["INV-1", "INV-2"]',
      check_commands: ['npm run typecheck'],
    }),
  };

  const task = {
    id: 'card-canary-jsonmatch-1',
    kind: 'card',
    issue: 603,
    title: 'Do the thing',
    criterion: 'the thing is done',
    worktreePath,
    size: 'S',
  };
  const ctx = realPlanCtx({
    id: 'card-canary-jsonmatch-1',
    task,
    taskDir: mkTmp('spo-plan-canary-jsonmatch-taskdir-'),
    accountsDir,
    deps,
  });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(ctx.taskDir);
  assert.ok(
    !journal.some((e) => e.event === 'invariants-declared-parsed-mismatch'),
    'declared (2, from the parsed JSON string) equals parsed (2) -- the canary must stay silent'
  );
});

test('handlePlan: PLAN declaring invariant ids as a JSON-STRING with a genuine count mismatch fires the canary with real numbers on both sides, and declaredIds holds the parsed-out ids, not the raw string', async () => {
  const worktreePath = mkTmp('spo-plan-canary-jsonstring-mismatch-wt-');
  const accountsDir = mkTmp('spo-plan-canary-jsonstring-mismatch-accounts-');
  writePoolDir(accountsDir, [{ name: 'acct-1', oauthToken: 'tok' }]);
  fs.writeFileSync(path.join(worktreePath, 'a.js'), 'const x = 1;\n');

  const deps = {
    spawnSync: fakePlanSpawn({
      plan_markdown: '# Plan\n\nDo the thing.\n',
      // No ## INV-<n> blocks at all -- the parser finds nothing.
      invariants_markdown: '# Invariants\n\nINV-1, INV-2 and INV-3 all hold in a.js.\n',
      invariant_ids: '["INV-1", "INV-2", "INV-3"]',
      check_commands: ['npm run typecheck'],
    }),
  };

  const task = {
    id: 'card-canary-jsonmismatch-1',
    kind: 'card',
    issue: 604,
    title: 'Do the thing',
    criterion: 'the thing is done',
    worktreePath,
    size: 'S',
  };
  const ctx = realPlanCtx({
    id: 'card-canary-jsonmismatch-1',
    task,
    taskDir: mkTmp('spo-plan-canary-jsonmismatch-taskdir-'),
    accountsDir,
    deps,
  });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT', 'a parser/prompt divergence must never park the card');

  const journal = readJournal(ctx.taskDir);
  const mismatch = journal.find((e) => e.event === 'invariants-declared-parsed-mismatch');
  assert.ok(mismatch, 'expected the declared-vs-parsed canary to fire');
  assert.equal(mismatch.declared, 3);
  assert.equal(mismatch.parsed, 0);
  assert.deepEqual(mismatch.declaredIds, ['INV-1', 'INV-2', 'INV-3'], 'declaredIds must be the parsed-out ids, not the raw JSON string');
  assert.equal(mismatch.declaredShape, 'json-string');
});

test('handlePlan: PLAN declaring invariant ids as a bare unparsable string is not a declaration -- still journals the mismatch, still does not park, and declaredShape distinguishes it from a real empty declaration', async () => {
  const worktreePath = mkTmp('spo-plan-canary-unparsable-wt-');
  const accountsDir = mkTmp('spo-plan-canary-unparsable-accounts-');
  writePoolDir(accountsDir, [{ name: 'acct-1', oauthToken: 'tok' }]);
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const invariantsMarkdown = ['## INV-1', 'File: foo.js:1-3', '>>> QUOTE', 'function foo() {\n  return 42;\n}', '>>> END QUOTE', ''].join('\n');

  const deps = {
    spawnSync: fakePlanSpawn({
      plan_markdown: '# Plan\n\nDo the thing.\n',
      invariants_markdown: invariantsMarkdown,
      // Not JSON, not an array -- a shape that is neither 'array' nor 'json-string', so it is no
      // declaration at all (normalizeDeclaredInvariantIds treats it as declaredIds: []).
      invariant_ids: 'INV-1',
      check_commands: ['npm run typecheck'],
    }),
  };

  const task = {
    id: 'card-canary-unparsable-1',
    kind: 'card',
    issue: 605,
    title: 'Do the thing',
    criterion: 'the thing is done',
    worktreePath,
    size: 'S',
  };
  const ctx = realPlanCtx({
    id: 'card-canary-unparsable-1',
    task,
    taskDir: mkTmp('spo-plan-canary-unparsable-taskdir-'),
    accountsDir,
    deps,
  });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT', 'a non-declaration shape must never park the card');

  const journal = readJournal(ctx.taskDir);
  const mismatch = journal.find((e) => e.event === 'invariants-declared-parsed-mismatch');
  assert.ok(mismatch, 'expected the canary to fire -- declared 0 vs parsed 1');
  assert.equal(mismatch.declared, 0);
  assert.equal(mismatch.parsed, 1);
  assert.deepEqual(mismatch.declaredIds, []);
  assert.equal(mismatch.declaredShape, 'unparsable-string', 'must be distinguishable from a real empty declaration ("[]", shape json-string)');
});

// ---- issue #112: PLAN-time plan-span-conflict flagging -----------------------------------------
//
// The measured defect: PLAN sometimes freezes an invariant over a span its OWN plan text goes on
// to reorder, which no IMPLEMENT can satisfy -- CHECK then fails the invariant and the card burns
// a full DIAGNOSE/IMPLEMENT cycle for something the plan already gave away. The shipped fix is
// flag-at-PLAN, honour-at-CHECK (orchestrator/plan-span-guard.js's detectSpanConflicts is the
// detector; annotatePlanSpanConflicts in state-machine.js is the wiring under test here): PLAN
// never drops the invariant, never parks, never changes `resolved`/`mode` -- it only stamps a
// `planSpanConflict` marker on the baseline row so CHECK (test/real-steps.test.js) can later
// decide whether to relieve a break that marker predicted.

test('handlePlan (real mode, fresh path): a plan that reorders the exact span an invariant just froze is flagged on the baseline row, and journals invariants-plan-span-conflict', async () => {
  const worktreePath = mkTmp('spo-plan-span-conflict-wt-');
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const accountsDir = mkTmp('spo-plan-span-conflict-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);

  const invariantsMarkdown = [
    '## INV-1',
    'File: foo.js:1-3',
    '>>> QUOTE',
    'function foo() {\n  return 42;\n}',
    '>>> END QUOTE',
    '',
  ].join('\n');
  // Line 3 (1-based) names foo.js:2-6 -- overlaps INV-1's real (exact-match) span of foo.js:1-3.
  const planMarkdown = '# Plan\n\nMove the code at foo.js:2-6 up.\n';

  const deps = {
    spawnSync: fakePlanSpawn({
      plan_markdown: planMarkdown,
      invariants_markdown: invariantsMarkdown,
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    }),
  };

  const task = {
    id: 'card-span-conflict-1',
    kind: 'card',
    issue: 701,
    title: 'Move the code',
    criterion: 'the code moved',
    worktreePath,
    size: 'S',
  };
  const ctx = realPlanCtx({ id: 'card-span-conflict-1', task, taskDir: mkTmp('spo-plan-span-conflict-taskdir-'), accountsDir, deps });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(ctx.taskDir);
  const baseline = journal.find((e) => e.event === 'invariants-baseline');
  assert.ok(baseline);
  const inv1 = baseline.invariants.find((i) => i.id === 'INV-1');
  // resolved/mode/reason must be exactly what buildBaseline alone would have produced -- the flag
  // rides alongside, it never replaces any of these.
  assert.equal(inv1.resolved, true);
  assert.equal(inv1.mode, 'exact');
  assert.deepEqual(inv1.planSpanConflict, { planSpan: { start: 2, end: 6 }, planLine: 3, syntax: 'path' });

  const conflictEvent = journal.find((e) => e.event === 'invariants-plan-span-conflict');
  assert.ok(conflictEvent, 'expected invariants-plan-span-conflict to be journalled');
  assert.deepEqual(conflictEvent.conflicts, [
    { id: 'INV-1', file: 'foo.js', planSpan: { start: 2, end: 6 }, planLine: 3, syntax: 'path' },
  ]);
});

test('handlePlan (real mode, fresh path): a plan that never mentions the invariant span at all leaves the baseline unflagged and journals no conflict event', async () => {
  const worktreePath = mkTmp('spo-plan-span-noconflict-wt-');
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const accountsDir = mkTmp('spo-plan-span-noconflict-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);

  const invariantsMarkdown = [
    '## INV-1',
    'File: foo.js:1-3',
    '>>> QUOTE',
    'function foo() {\n  return 42;\n}',
    '>>> END QUOTE',
    '',
  ].join('\n');
  const planMarkdown = '# Plan\n\nAdd a brand new helper function elsewhere.\n';

  const deps = {
    spawnSync: fakePlanSpawn({
      plan_markdown: planMarkdown,
      invariants_markdown: invariantsMarkdown,
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    }),
  };

  const task = {
    id: 'card-span-noconflict-1',
    kind: 'card',
    issue: 702,
    title: 'Add a helper',
    criterion: 'the helper exists',
    worktreePath,
    size: 'S',
  };
  const ctx = realPlanCtx({
    id: 'card-span-noconflict-1',
    task,
    taskDir: mkTmp('spo-plan-span-noconflict-taskdir-'),
    accountsDir,
    deps,
  });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(ctx.taskDir);
  const baseline = journal.find((e) => e.event === 'invariants-baseline');
  assert.ok(baseline);
  const inv1 = baseline.invariants.find((i) => i.id === 'INV-1');
  assert.equal(inv1.resolved, true);
  assert.equal('planSpanConflict' in inv1, false, 'a plan with no matching span must never add the key at all');
  assert.equal(journal.some((e) => e.event === 'invariants-plan-span-conflict'), false);
});

test('handlePlan (real mode, reuse path): a plan-span conflict is flagged too, reading the plan text from disk rather than from a payload field', async () => {
  const worktreePath = mkTmp('spo-plan-span-reuse-wt-');
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const taskDir = mkTmp('spo-plan-span-reuse-taskdir-');
  const scratch = path.join(taskDir, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const planPath = path.join(scratch, 'plan-703.md');
  const invariantsPath = path.join(scratch, 'invariants-703.md');
  // Same shape as the fresh-path conflict test above -- foo.js:2-6 overlaps INV-1's foo.js:1-3.
  fs.writeFileSync(planPath, '# Plan\n\nMove the code at foo.js:2-6 up.\n');
  fs.writeFileSync(
    invariantsPath,
    ['## INV-1', 'File: foo.js:1-3', '>>> QUOTE', 'function foo() {\n  return 42;\n}', '>>> END QUOTE', ''].join('\n')
  );

  // Hand-built prior-run journal state, exactly what decidePlanReuse (state-machine.js) requires
  // to reuse rather than re-run PLAN: a 'files-written' event carrying the matching baseMainSha,
  // and a non-failure 'result' payload. This is fixture setup for the RE-USE PATH itself (already
  // covered/trusted by test/plan-reuse*.test.js-style coverage elsewhere in this suite) -- the
  // thing actually under test here, the plan-span flag, is still fully DERIVED: handlePlan reads
  // planMarkdown back off `planPath` on disk and runs the real detector against it below.
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: 'sha-reuse-span-703' });
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { ok: true, plan_path: planPath, invariants_path: invariantsPath, invariant_ids: ['INV-1'], check_commands: [] },
  });

  const task = {
    id: 'card-span-reuse-1',
    kind: 'card',
    issue: 703,
    worktreePath,
    baseMainSha: 'sha-reuse-span-703',
  };
  const ctx = buildCtx('card-span-reuse-1', task, taskDir, { shadowMode: false, dryRun: false });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'plan-reused'), 'expected the reuse path to have actually been taken');

  const baseline = journal.find((e) => e.event === 'invariants-baseline');
  assert.ok(baseline);
  const inv1 = baseline.invariants.find((i) => i.id === 'INV-1');
  assert.deepEqual(inv1.planSpanConflict, { planSpan: { start: 2, end: 6 }, planLine: 3, syntax: 'path' });
  assert.ok(journal.some((e) => e.event === 'invariants-plan-span-conflict'), 'reuse path must journal the conflict event too, same as the fresh path');
});

test('handlePlan (real mode, reuse path): an unreadable plan file never throws and simply leaves the baseline unflagged', async () => {
  const worktreePath = mkTmp('spo-plan-span-reuse-nofile-wt-');
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  const taskDir = mkTmp('spo-plan-span-reuse-nofile-taskdir-');
  const scratch = path.join(taskDir, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const planPath = path.join(scratch, 'plan-704.md');
  const invariantsPath = path.join(scratch, 'invariants-704.md');
  fs.writeFileSync(
    invariantsPath,
    ['## INV-1', 'File: foo.js:1-3', '>>> QUOTE', 'function foo() {\n  return 42;\n}', '>>> END QUOTE', ''].join('\n')
  );
  fs.writeFileSync(planPath, 'placeholder');
  // decidePlanReuse's own condition 4 only STATS planPath (isFile() && size > 0) -- a mode-0 file
  // still passes that, so this exercises annotatePlanSpanConflicts' OWN read guard specifically,
  // not decidePlanReuse's file-existence gate (deleting the file instead would trip THAT gate
  // first and never reach the code this test means to cover).
  fs.chmodSync(planPath, 0o000);

  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: 'sha-reuse-span-704' });
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { ok: true, plan_path: planPath, invariants_path: invariantsPath, invariant_ids: ['INV-1'], check_commands: [] },
  });

  const task = {
    id: 'card-span-reuse-nofile-1',
    kind: 'card',
    issue: 704,
    worktreePath,
    baseMainSha: 'sha-reuse-span-704',
  };
  const ctx = buildCtx('card-span-reuse-nofile-1', task, taskDir, { shadowMode: false, dryRun: false });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(taskDir);
  const baseline = journal.find((e) => e.event === 'invariants-baseline');
  assert.ok(baseline);
  const inv1 = baseline.invariants.find((i) => i.id === 'INV-1');
  assert.equal('planSpanConflict' in inv1, false);
  assert.equal(journal.some((e) => e.event === 'invariants-plan-span-conflict'), false);
});

test('handlePlan (real mode): a plan-span-guard detector failure is swallowed -- PLAN still reaches IMPLEMENT with an unflagged baseline (defensive wrapping, not the detector\'s own robustness)', async () => {
  // orchestrator/plan-span-guard.js's detectSpanConflicts is itself written to never throw, on
  // any input -- there is no plan_markdown string that forces a real throw through it, which
  // makes "make the plan markdown pathological" unactionable as a way to exercise this. What is
  // still real and worth pinning is state-machine.js's OWN defensive wrapping around the call
  // (annotatePlanSpanConflicts's try/catch) -- if a future change to the detector, or to this
  // wiring, ever lets an exception through, PLAN must keep behaving exactly as it does today
  // rather than crashing the daemon (this file's own header: a handler-internal bug is not caught
  // anywhere else). This is a deliberate injection of an UPSTREAM DEPENDENCY failure, done via a
  // require.cache swap so state-machine.js is re-required against a patched plan-span-guard --
  // NOT an injection of the value annotatePlanSpanConflicts derives (that is real, derived output
  // in every other test in this section). Cache entries are restored in `finally` so no other
  // test in this process ever sees the patched module.
  const guardPath = require.resolve('../orchestrator/plan-span-guard');
  const smPath = require.resolve('../orchestrator/state-machine');
  const savedGuardEntry = require.cache[guardPath];
  const savedSmEntry = require.cache[smPath];
  delete require.cache[guardPath];
  delete require.cache[smPath];

  try {
    const guardModule = require('../orchestrator/plan-span-guard');
    guardModule.detectSpanConflicts = () => {
      throw new Error('injected plan-span-guard failure');
    };
    const { HANDLERS: HANDLERS2, buildCtx: buildCtx2 } = require('../orchestrator/state-machine');

    const worktreePath = mkTmp('spo-plan-span-guardthrows-wt-');
    fs.writeFileSync(path.join(worktreePath, 'foo.js'), 'function foo() {\n  return 42;\n}\n');
    const accountsDir = mkTmp('spo-plan-span-guardthrows-accts-');
    writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);

    const invariantsMarkdown = [
      '## INV-1',
      'File: foo.js:1-3',
      '>>> QUOTE',
      'function foo() {\n  return 42;\n}',
      '>>> END QUOTE',
      '',
    ].join('\n');

    const deps = {
      spawnSync: fakePlanSpawn({
        plan_markdown: '# Plan\n\nMove the code at foo.js:2-6 up.\n',
        invariants_markdown: invariantsMarkdown,
        invariant_ids: ['INV-1'],
        check_commands: ['npm run typecheck'],
      }),
    };
    const task = {
      id: 'card-span-guardthrows-1',
      kind: 'card',
      issue: 705,
      title: 'Move the code',
      criterion: 'the code moved',
      worktreePath,
      size: 'S',
    };
    const ctx = buildCtx2('card-span-guardthrows-1', task, mkTmp('spo-plan-span-guardthrows-taskdir-'), {
      claudeAccountsDir: accountsDir,
      stepDeadlineMs: 30000,
      shadowMode: false,
      dryRun: false,
      deps,
    });

    const next = await HANDLERS2.PLAN(ctx);
    assert.equal(next, 'IMPLEMENT');

    const journal = readJournal(ctx.taskDir);
    const baseline = journal.find((e) => e.event === 'invariants-baseline');
    assert.ok(baseline, 'a throwing detector must still leave the baseline itself journalled');
    const inv1 = baseline.invariants.find((i) => i.id === 'INV-1');
    assert.equal('planSpanConflict' in inv1, false, 'a throwing detector must never leave a flag behind');
    assert.equal(journal.some((e) => e.event === 'invariants-plan-span-conflict'), false);
  } finally {
    delete require.cache[guardPath];
    delete require.cache[smPath];
    if (savedGuardEntry) require.cache[guardPath] = savedGuardEntry;
    if (savedSmEntry) require.cache[smPath] = savedSmEntry;
  }
});

test('handlePlan (real mode): PLAN_SPAN_CONFLICT_CAP bounds BOTH the journalled conflicts array and the number of annotated baseline rows at 50', async () => {
  // The journalled `invariants-plan-span-conflict` detail can flow into a GitHub comment capped at
  // 65536 chars (state-machine.js's own note, same reasoning as PROTECTED_MATCH_CAP), so the cap
  // has to bind on the EVENT; and a row annotated past the cap would be relieved at CHECK by a
  // conflict the journal never recorded, so it has to bind on the ROWS too. 60 overlapping
  // invariants -- more than the cap, and well under plan-span-guard.js's own MAX_FINDINGS of 200,
  // so the 50 measured here is this wiring's cap and not the detector's.
  const worktreePath = mkTmp('spo-plan-span-cap-wt-');
  const lines = [];
  for (let i = 1; i <= 60; i++) lines.push(`const v${i} = ${i};`);
  fs.writeFileSync(path.join(worktreePath, 'foo.js'), lines.join('\n') + '\n');

  const accountsDir = mkTmp('spo-plan-span-cap-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);

  const blocks = [];
  for (let i = 1; i <= 60; i++) {
    blocks.push([`## INV-${i}`, `File: foo.js:${i}-${i}`, '>>> QUOTE', `const v${i} = ${i};`, '>>> END QUOTE', ''].join('\n'));
  }
  // One plan span covering the whole file: every one of the 60 invariants overlaps it.
  const planMarkdown = '# Plan\n\nRewrite foo.js:1-60 from scratch.\n';

  const deps = {
    spawnSync: fakePlanSpawn({
      plan_markdown: planMarkdown,
      invariants_markdown: blocks.join(''),
      invariant_ids: [],
      check_commands: ['npm run typecheck'],
    }),
  };

  const task = {
    id: 'card-span-cap-1',
    kind: 'card',
    issue: 709,
    title: 'Rewrite foo.js',
    criterion: 'foo.js rewritten',
    worktreePath,
    size: 'S',
  };
  const ctx = realPlanCtx({ id: 'card-span-cap-1', task, taskDir: mkTmp('spo-plan-span-cap-taskdir-'), accountsDir, deps });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(ctx.taskDir);
  const baseline = journal.find((e) => e.event === 'invariants-baseline');
  assert.equal(baseline.invariants.length, 60, 'all 60 invariants must still be in the baseline -- the cap bounds flagging, never the baseline itself');

  const conflictEvent = journal.find((e) => e.event === 'invariants-plan-span-conflict');
  assert.ok(conflictEvent);
  assert.equal(conflictEvent.conflicts.length, 50, 'the journalled conflicts array must be capped at 50');

  const flaggedRows = baseline.invariants.filter((i) => i.planSpanConflict);
  assert.equal(flaggedRows.length, 50, 'row annotation must be capped at 50 too, not just the event');
});
