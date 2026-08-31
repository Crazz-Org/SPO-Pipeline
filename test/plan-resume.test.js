'use strict';
// Unit tests for action 3.1 -- resuming a parked task's PLAN without re-paying for it.
//
// Three pieces, in one file because they only make sense together:
//   - steps/scripted.js's realWorktree now journals a 'base-main' event and sets
//     ctx.task.baseMainSha the moment origin/main's sha is known (test 9 below).
//   - state-machine.js's handlePlan gains a reuse short-circuit, decidePlanReuse, that decides
//     whether a plan already on disk from an EARLIER run of this task is still safe to reuse
//     instead of calling PLAN's LLM step again (tests 1-8 below). See decidePlanReuse's own
//     header comment in state-machine.js for the six conditions this exercises one at a time.
//   - park-loop.js's reEnqueueTask strips the stale baseMainSha on a maintainer's `retry` --
//     covered in test/park-loop.test.js (kept there, alongside its worktreePath/branch strip
//     sibling, rather than duplicated here).
//
// Same fake-spawnSync-via-deps idiom as test/plan-writes.test.js and test/real-steps.test.js:
// never touches a real git/npm/gh/claude binary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { appendEvent } = require('../orchestrator/journal');
const { lastResultPayload } = require('../orchestrator/task-values');
const { realWorktree } = require('../orchestrator/steps/scripted');
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

// The envelope invokeClaudeReal (steps/llm.js) expects from a real spawnSync call -- same shape
// test/plan-writes.test.js's fakePlanSpawn returns, `result` itself a JSON-encoded PLAN payload.
function planReplyEnvelope(planPayload) {
  return {
    status: 0,
    stdout: JSON.stringify({
      result: JSON.stringify(planPayload),
      is_error: false,
      num_turns: 1,
      session_id: 'sess-plan-resume',
      modelUsage: { 'claude-fable-5': { costUSD: 0.001 } },
      terminal_reason: 'success',
      api_error_status: null,
    }),
    stderr: '',
    signal: null,
  };
}

// A valid PLAN reply -- used by every "must run PLAN normally" test so a successful non-reuse
// run is unambiguous (next === 'IMPLEMENT', not a plan-invalid park for unrelated reasons).
function validPlanPayload() {
  return {
    ok: true,
    plan_markdown: '# Plan\n\nDo the (new) thing.\n',
    invariants_markdown: '# Invariants\n\nINV-9: ...\n',
    invariant_ids: ['INV-9'],
    check_commands: ['npm run typecheck'],
  };
}

// Wraps a fixed spawnSync reply with a call counter. The reuse path's entire point is that
// callLlmStep -- and therefore this -- is never invoked at all; every reuse test asserts
// spy.callCount === 0, every "runs normally" test asserts it is exactly 1.
function countingSpawn(reply) {
  function spy() {
    spy.callCount += 1;
    return reply;
  }
  spy.callCount = 0;
  return spy;
}

function baseTask(overrides = {}) {
  return {
    id: 'card-900',
    kind: 'card',
    issue: 900,
    title: 'Some card',
    criterion: 'the thing is done',
    size: 'S',
    ...overrides,
  };
}

// A real-mode ctx wired for handlePlan: an account pool (only ever actually consulted if the
// reuse guard falls through and callLlmStep runs for real) and an injectable spawnSync.
function realPlanCtx({ task, taskDir, worktreePath, spawnSync }) {
  const accountsDir = mkTmp('spo-plan-resume-accts-');
  writePoolDir(accountsDir, [{ name: 'default', disabled: false }]);
  return buildCtx(task.id, { ...task, worktreePath }, taskDir, {
    shadowMode: false,
    dryRun: false,
    claudeAccountsDir: accountsDir,
    stepDeadlineMs: 30000,
    deps: { spawnSync },
  });
}

// Journals a PLAN 'files-written' + 'result' pair matching what a PRIOR run of handlePlan would
// have produced (state-machine.js's own normal-path shape) and writes the plan/invariants files
// to disk, non-empty -- the on-disk half of decidePlanReuse's conditions 2-4. `baseMainSha`
// omitted entirely (rather than passed as undefined) reproduces a journal written before this
// action -- JSON.stringify drops an undefined-valued key, so the resulting record carries no
// baseMainSha field at all, exactly like a pre-existing task's journal.
function priorPlanRun(taskDir, { baseMainSha, invariantIds = ['INV-1'], checkCommands = ['npm run typecheck'] } = {}) {
  const dir = path.join(taskDir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, 'plan-900.md');
  const invariantsPath = path.join(dir, 'invariants-900.md');
  fs.writeFileSync(planPath, '# Plan\n\nDo the thing.\n');
  fs.writeFileSync(invariantsPath, '# Invariants\n\nINV-1: ...\n');

  const payload = {
    ok: true,
    plan_path: planPath,
    invariants_path: invariantsPath,
    invariant_ids: invariantIds,
    check_commands: checkCommands,
  };
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha });
  appendEvent(taskDir, 'PLAN', 'result', { payload });
  return { planPath, invariantsPath, payload };
}

// ---- (1) reuse happy path -----------------------------------------------------------------

test('handlePlan: reuse happy path -- same baseMainSha, plan files intact, no invalidating park -> IMPLEMENT, LLM never invoked, plan-reused journalled', async () => {
  const taskDir = mkTmp('spo-plan-resume-happy-');
  const worktreePath = mkTmp('spo-plan-resume-happy-wt-');
  const { planPath, invariantsPath } = priorPlanRun(taskDir, { baseMainSha: 'sha-X' });

  const spawnSync = countingSpawn(planReplyEnvelope({ ok: true, plan_markdown: 'must not be read', invariants_markdown: 'must not be read' }));
  const task = baseTask({ baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 0, 'the LLM step must never be invoked on a reuse');

  const journal = readJournal(taskDir);
  const reused = journal.find((e) => e.event === 'plan-reused');
  assert.ok(reused, 'expected a plan-reused event');
  assert.equal(reused.planPath, planPath);
  assert.equal(reused.invariantsPath, invariantsPath);
  assert.equal(reused.baseMainSha, 'sha-X');
});

// ---- (2) sha moved -------------------------------------------------------------------------

test('handlePlan: origin/main moved since the plan was written -> runs PLAN normally, LLM invoked once', async () => {
  const taskDir = mkTmp('spo-plan-resume-shamoved-');
  const worktreePath = mkTmp('spo-plan-resume-shamoved-wt-');
  priorPlanRun(taskDir, { baseMainSha: 'sha-X' });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-901', issue: 901, baseMainSha: 'sha-Y' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1);
  assert.equal(readJournal(taskDir).some((e) => e.event === 'plan-reused'), false);
});

// ---- (3) plan file missing on disk ----------------------------------------------------------

test('handlePlan: plan file missing on disk -> runs PLAN normally', async () => {
  const taskDir = mkTmp('spo-plan-resume-missing-');
  const worktreePath = mkTmp('spo-plan-resume-missing-wt-');
  const { planPath } = priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
  fs.unlinkSync(planPath);

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-902', issue: 902, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1);
});

// ---- (4) plan file present but empty --------------------------------------------------------

test('handlePlan: plan file present but empty -> runs PLAN normally', async () => {
  const taskDir = mkTmp('spo-plan-resume-empty-');
  const worktreePath = mkTmp('spo-plan-resume-empty-wt-');
  const { planPath } = priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
  fs.writeFileSync(planPath, '');

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-903', issue: 903, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1);
});

// ---- (5) no baseMainSha on the prior files-written event (backward compatibility) -----------

test('handlePlan: prior files-written event has no baseMainSha field (a journal written before this action) -> runs PLAN normally, never throws', async () => {
  const taskDir = mkTmp('spo-plan-resume-nofield-');
  const worktreePath = mkTmp('spo-plan-resume-nofield-wt-');
  priorPlanRun(taskDir, {}); // no baseMainSha at all -- see priorPlanRun's own comment

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-904', issue: 904, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1);
});

// ---- (6) ctx.task.baseMainSha absent (shadow mode / dry-run) --------------------------------

test('handlePlan: ctx.task.baseMainSha absent -> runs PLAN normally (condition 1 alone rules out reuse, independent of the journal)', async () => {
  const taskDir = mkTmp('spo-plan-resume-nosha-');
  const worktreePath = mkTmp('spo-plan-resume-nosha-wt-');
  // The journal alone would satisfy every other condition -- only the absent ctx.task.baseMainSha
  // (never set at all here, exactly as it never is in shadow mode or --dry-run, which never call
  // realWorktree) rules out reuse.
  priorPlanRun(taskDir, { baseMainSha: 'sha-X' });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-905', issue: 905 }); // no baseMainSha field
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1);
});

// Mutation-kill note (M1a/M1b): the test above is a mismatch case (ctx side absent, journal side
// 'sha-X') -- condition 3's `!==` comparison ALSO refuses reuse there (undefined !== 'sha-X'), so
// with condition 1 deleted entirely that test would still correctly refuse reuse via condition 3
// alone, and would NOT catch condition 1 going missing. This test isolates condition 1 (and
// specifically its `=== ''` half) by making BOTH sides an empty string, so condition 3's `!==`
// check finds them EQUAL ('' === '') and would happily fall through to reuse if condition 1's own
// explicit empty-string refusal were ever deleted.
test('handlePlan: ctx.task.baseMainSha is the empty string and the journal event also carries "" -- condition 1 alone must refuse, condition 3 would pass ("" === "")', async () => {
  const taskDir = mkTmp('spo-plan-resume-emptysha-');
  const worktreePath = mkTmp('spo-plan-resume-emptysha-wt-');
  priorPlanRun(taskDir, { baseMainSha: '' });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-910', issue: 910, baseMainSha: '' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1, 'an empty-string baseMainSha on both sides must still refuse reuse');
});

// ---- (7) park-reason gate: six invalidating reasons, some that aren't ------------------------

// F3: diagnose-budget-exhausted and validate-reject-budget-exhausted added to the original four.
// Without these two, reuse -> IMPLEMENT fails -> DIAGNOSE burns config.diagnoseBudget attempts (or
// change-validator rejects config.validateRejectBudget times) -> park -> retry with main unmoved
// -> identical reuse -> identical cycle, bounded only by a human giving up.
const INVALIDATING_REASONS = [
  'plan-invalid',
  'plan-requires-protected-files',
  'diagnose-duplicate-root-cause',
  'diagnose-no-new-cause',
  'diagnose-budget-exhausted',
  'validate-reject-budget-exhausted',
];

for (const reason of INVALIDATING_REASONS) {
  test(`handlePlan: most recent park was '${reason}' (indicts the plan itself) -> runs PLAN normally, does not reuse`, async () => {
    const taskDir = mkTmp(`spo-plan-resume-park-${reason}-`);
    const worktreePath = mkTmp(`spo-plan-resume-park-${reason}-wt-`);
    priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
    appendEvent(taskDir, 'PLAN', 'parked', { reason, detail: {} });

    const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
    const task = baseTask({ id: `card-906-${reason}`, issue: 906, baseMainSha: 'sha-X' });
    const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

    const next = await HANDLERS.PLAN(ctx);

    assert.equal(next, 'IMPLEMENT');
    assert.equal(spawnSync.callCount, 1, `${reason} must force a normal PLAN run, never a reuse`);
  });
}

for (const reason of ['llm-transport-failed:GATE', 'gate-failed']) {
  test(`handlePlan: most recent park was '${reason}' (orthogonal to the plan) -> still reuses`, async () => {
    const taskDir = mkTmp(`spo-plan-resume-okpark-${reason.replace(/[^a-z0-9-]/gi, '_')}-`);
    const worktreePath = mkTmp('spo-plan-resume-okpark-wt-');
    priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
    appendEvent(taskDir, 'GATE', 'parked', { reason, detail: {} });

    const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
    const task = baseTask({ id: 'card-907', issue: 907, baseMainSha: 'sha-X' });
    const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

    const next = await HANDLERS.PLAN(ctx);

    assert.equal(next, 'IMPLEMENT');
    assert.equal(spawnSync.callCount, 0, `${reason} is orthogonal to plan validity and must still reuse`);
  });
}

// ---- (8) the reused payload carries invariant_ids/check_commands forward --------------------

test('handlePlan: reused result payload preserves invariant_ids and check_commands -- lastResultPayload(taskDir, "PLAN") still returns them after reuse', async () => {
  const taskDir = mkTmp('spo-plan-resume-preserve-');
  const worktreePath = mkTmp('spo-plan-resume-preserve-wt-');
  priorPlanRun(taskDir, {
    baseMainSha: 'sha-X',
    invariantIds: ['INV-1', 'INV-2'],
    checkCommands: ['npm run typecheck', 'npm run lint'],
  });

  const spawnSync = countingSpawn(planReplyEnvelope({ ok: true, plan_markdown: 'x', invariants_markdown: 'x' }));
  const task = baseTask({ id: 'card-908', issue: 908, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 0);

  const payload = lastResultPayload(taskDir, 'PLAN');
  assert.deepEqual(payload.invariant_ids, ['INV-1', 'INV-2']);
  assert.deepEqual(payload.check_commands, ['npm run typecheck', 'npm run lint']);
  assert.equal(payload.reused, true);
});

// ---- (9) realWorktree journals base-main and sets ctx.task.baseMainSha ----------------------

// Fake spawnSync for a full-success realWorktree run with no leftovers to sweep -- same shape as
// test/real-steps.test.js's noLeftoversSpawnSync, kept local here since that one isn't exported.
function fakeWorktreeSpawn(originMainSha) {
  return (command, args) => {
    if (args.includes('rev-parse') && args.includes('--verify')) return { status: 1, stdout: '', stderr: '', signal: null };
    if (args.includes('rev-parse')) return { status: 0, stdout: `${originMainSha}\n`, stderr: '', signal: null };
    if (args.includes('board:take')) return { status: 0, stdout: 'claimed\n', stderr: '', signal: null };
    return { status: 0, stdout: '', stderr: '', signal: null };
  };
}

test('realWorktree: journals base-main with the rev-parse sha and sets ctx.task.baseMainSha, before the worktree add (and so before any park that could follow, including nightly-main-red)', async () => {
  const config = {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-plan-resume-realwt-dir-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-plan-resume-realwt-bench-'),
    stepDeadlineMs: 30000,
  };
  const task = { id: 'card-909', kind: 'card', issue: 909, title: 'Add a widget' };
  const taskDir = mkTmp('spo-plan-resume-realwt-taskdir-');
  const ctx = buildCtx('card-909', task, taskDir, { shadowMode: false, dryRun: false, ...config });
  const originMainSha = 'basemainsha0000000000000000000000000000';
  const deps = { spawnSync: fakeWorktreeSpawn(originMainSha) };

  const next = await realWorktree(ctx, deps);

  assert.equal(next, 'PLAN');
  assert.equal(ctx.task.baseMainSha, originMainSha);

  const journal = readJournal(taskDir);
  const baseMainEvent = journal.find((e) => e.event === 'base-main');
  assert.ok(baseMainEvent, 'expected a base-main journal event');
  assert.equal(baseMainEvent.state, 'WORKTREE');
  assert.equal(baseMainEvent.sha, originMainSha);

  const baseMainIndex = journal.indexOf(baseMainEvent);
  const addSpawnIndex = journal.findIndex((e) => e.event === 'spawn' && Array.isArray(e.argv) && e.argv.includes('add'));
  assert.ok(addSpawnIndex > baseMainIndex, 'base-main must be journalled before the worktree add spawn');
});

// Mutation-kill note (M11c): if realWorktree's base-main journal + ctx.task.baseMainSha
// assignment ever moved to AFTER the nightly-red check, a run that PARKS nightly-main-red would
// never journal base-main at all -- silently contradicting F6's rewritten comment ("journalled
// ... so it exists even for a run that parks right there"). Pin the ordering directly against
// that park outcome, not just against the happy path test 9 already covers.
test('realWorktree: a run that parks nightly-main-red still journals base-main first (F6 / M11c ordering pin)', async () => {
  const spoBenchDir = mkTmp('spo-plan-resume-nightlyred-bench-');
  const originMainSha = 'redmainsha00000000000000000000000000000';
  fs.mkdirSync(path.join(spoBenchDir, 'nightly'), { recursive: true });
  fs.writeFileSync(
    path.join(spoBenchDir, 'nightly', 'latest.json'),
    JSON.stringify({ verdict: 'FAIL', sha: originMainSha })
  );

  const config = {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-plan-resume-nightlyred-dir-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir,
    stepDeadlineMs: 30000,
  };
  const task = { id: 'card-911', kind: 'card', issue: 911, title: 'Add a widget' };
  const taskDir = mkTmp('spo-plan-resume-nightlyred-taskdir-');
  const ctx = buildCtx('card-911', task, taskDir, { shadowMode: false, dryRun: false, ...config });
  const deps = { spawnSync: fakeWorktreeSpawn(originMainSha) };

  await assert.rejects(() => realWorktree(ctx, deps), (err) => err.reason === 'nightly-main-red');

  assert.equal(ctx.task.baseMainSha, originMainSha, 'ctx.task.baseMainSha must still be set even on this park');

  const journal = readJournal(taskDir);
  const baseMainEvent = journal.find((e) => e.event === 'base-main');
  assert.ok(baseMainEvent, 'base-main must be journalled even on a run that parks nightly-main-red');
  assert.equal(baseMainEvent.sha, originMainSha);
});

// ---- (10) M13: the two-run test -- the production writer of baseMainSha feeds decidePlanReuse -

// Every reuse test above hand-builds the prior journal via priorPlanRun, so none of them exercise
// the actual NORMAL-path write of `files-written`'s baseMainSha field (state-machine.js's
// handlePlan, non-reuse branch, "Action 3.1: baseMainSha rides along..."). If that write ever
// regressed (deleted, or the field renamed), every hand-built-journal reuse test above would stay
// green -- action 3.1 would become a permanent no-op in production and CI would say nothing. This
// runs handlePlan for real, twice, on the SAME taskDir: run 1 with the LLM producing a real plan
// (baseMainSha set on ctx.task, as realWorktree would set it), then run 2 -- simulating a `retry`
// with `origin/main` unmoved -- asserting the second call reuses without invoking the LLM at all.
test('handlePlan: two real runs on the same taskDir -- run 1 journals files-written with baseMainSha, run 2 (retry, main unmoved) reuses it, LLM not invoked', async () => {
  const taskDir = mkTmp('spo-plan-resume-tworun-');
  const worktreePath = mkTmp('spo-plan-resume-tworun-wt-');

  // Run 1: normal PLAN, LLM invoked once.
  const spawn1 = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task1 = baseTask({ id: 'card-913', issue: 913, baseMainSha: 'sha-tworun' });
  const ctx1 = realPlanCtx({ task: task1, taskDir, worktreePath, spawnSync: spawn1 });

  const next1 = await HANDLERS.PLAN(ctx1);
  assert.equal(next1, 'IMPLEMENT');
  assert.equal(spawn1.callCount, 1, 'run 1 must call the LLM -- nothing to reuse yet');

  const journalAfterRun1 = readJournal(taskDir);
  const filesWritten1 = journalAfterRun1.filter((e) => e.event === 'files-written');
  assert.equal(filesWritten1.length, 1);
  assert.equal(filesWritten1[0].baseMainSha, 'sha-tworun', 'run 1 must journal the baseMainSha it was given');

  // Run 2: a fresh handlePlan call against the SAME taskDir (retry restarts at INTAKE, so this is
  // a fresh ctx, but journal.jsonl and scratch/ from run 1 are still on disk, exactly as a retry
  // leaves them), origin/main unmoved (same baseMainSha) -- must reuse, LLM never invoked.
  const spawn2 = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task2 = baseTask({ id: 'card-913', issue: 913, baseMainSha: 'sha-tworun' });
  const ctx2 = realPlanCtx({ task: task2, taskDir, worktreePath, spawnSync: spawn2 });

  const next2 = await HANDLERS.PLAN(ctx2);
  assert.equal(next2, 'IMPLEMENT');
  assert.equal(spawn2.callCount, 0, "run 2 must reuse run 1's plan, never re-invoking the LLM");

  const journalAfterRun2 = readJournal(taskDir);
  assert.ok(journalAfterRun2.some((e) => e.event === 'plan-reused'), 'run 2 must journal plan-reused');
});

// ---- (11) M9: the reuse path rebuilds the invariants baseline against THIS run's worktree ------

test('handlePlan (reuse path): journals a fresh PLAN invariants-baseline event, built against ctx.task.worktreePath', async () => {
  const taskDir = mkTmp('spo-plan-resume-baseline-');
  const worktreePath = mkTmp('spo-plan-resume-baseline-wt-');
  priorPlanRun(taskDir, { baseMainSha: 'sha-X' });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-914', issue: 914, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 0);

  const journal = readJournal(taskDir);
  const baseline = journal.find((e) => e.state === 'PLAN' && e.event === 'invariants-baseline');
  assert.ok(baseline, 'reuse must still rebuild and journal an invariants-baseline event');
});

// ---- (12) M4a: condition 4 must also guard the invariants file, not just the plan file --------

test('handlePlan: invariants file missing on disk -> runs PLAN normally', async () => {
  const taskDir = mkTmp('spo-plan-resume-invmissing-');
  const worktreePath = mkTmp('spo-plan-resume-invmissing-wt-');
  const { invariantsPath } = priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
  fs.unlinkSync(invariantsPath);

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-915', issue: 915, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1);
});

test('handlePlan: invariants file present but empty -> runs PLAN normally', async () => {
  const taskDir = mkTmp('spo-plan-resume-invempty-');
  const worktreePath = mkTmp('spo-plan-resume-invempty-wt-');
  const { invariantsPath } = priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
  fs.writeFileSync(invariantsPath, '');

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-916', issue: 916, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1);
});

// F4's directory case: a planPath that resolves to a DIRECTORY must never be treated as reusable
// -- fs.statSync(dir).size is 4096 (non-zero), so a bare `.size > 0` check alone would pass a
// directory through; isFile() is what actually rejects it.
test('handlePlan: planPath resolves to a directory, not a file -> runs PLAN normally, never throws', async () => {
  const taskDir = mkTmp('spo-plan-resume-plandir-');
  const worktreePath = mkTmp('spo-plan-resume-plandir-wt-');
  const { planPath } = priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
  fs.unlinkSync(planPath);
  fs.mkdirSync(planPath); // same path, now a directory

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-917', issue: 917, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1, 'a directory at planPath must never be treated as a reusable plan file');
});

// ---- (13) M6a: condition 6 must take the LAST parked event, not the first ----------------------

test('handlePlan: park order plan-invalid THEN gate-failed (last is orthogonal) -> still reuses', async () => {
  const taskDir = mkTmp('spo-plan-resume-parkorder-a-');
  const worktreePath = mkTmp('spo-plan-resume-parkorder-a-wt-');
  priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
  appendEvent(taskDir, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });
  appendEvent(taskDir, 'GATE', 'parked', { reason: 'gate-failed', detail: {} });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-918', issue: 918, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 0, 'the LAST park (gate-failed) is orthogonal -- must reuse despite an earlier plan-invalid');
});

test('handlePlan: park order gate-failed THEN plan-invalid (last indicts the plan) -> runs PLAN normally', async () => {
  const taskDir = mkTmp('spo-plan-resume-parkorder-b-');
  const worktreePath = mkTmp('spo-plan-resume-parkorder-b-wt-');
  priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
  appendEvent(taskDir, 'GATE', 'parked', { reason: 'gate-failed', detail: {} });
  appendEvent(taskDir, 'PLAN', 'parked', { reason: 'plan-invalid', detail: {} });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-919', issue: 919, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1, 'the LAST park (plan-invalid) indicts the plan -- must re-PLAN despite an earlier gate-failed');
});

// ---- (14) M5: condition 5 -- no result event at all, and F2's failure-payload case --------------

test('handlePlan: a valid files-written event but NO PLAN result event at all -> runs PLAN normally', async () => {
  const taskDir = mkTmp('spo-plan-resume-noresult-');
  const worktreePath = mkTmp('spo-plan-resume-noresult-wt-');
  const dir = path.join(taskDir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, 'plan-920.md');
  const invariantsPath = path.join(dir, 'invariants-920.md');
  fs.writeFileSync(planPath, '# Plan\n');
  fs.writeFileSync(invariantsPath, '# Invariants\n');
  // files-written only -- no PLAN 'result' event journalled at all, unlike priorPlanRun's usual
  // pair. Simulates a journal truncated/corrupted between the two writes.
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: 'sha-X' });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-920', issue: 920, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1, 'no PLAN result event at all means nothing safe to hand IMPLEMENT/VALIDATE -- must re-PLAN');
});

// F2: the LAST PLAN 'result' payload can be a FAILURE (action 1.4's transport-failure branch,
// {ok:false, kind:'error'}) even though a valid files-written event from an EARLIER, successful
// PLAN also exists in the same journal -- e.g. run 1 PLANned fine at sha X and parked at GATE; a
// retry at sha Y re-ran PLAN and hit a transport failure (parked llm-transport-failed:PLAN,
// correctly not plan-invalidating); main was then reverted to X and retried again. Conditions
// 2/3 match run 1's files-written; condition 5 must still refuse on the failure payload.
test('handlePlan: last PLAN result payload is a transport-failure ({ok:false, kind:"error"}) -> runs PLAN normally (F2)', async () => {
  const taskDir = mkTmp('spo-plan-resume-failpayload-');
  const worktreePath = mkTmp('spo-plan-resume-failpayload-wt-');
  priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
  // A later, failed PLAN attempt's transport-failure payload becomes the LAST PLAN 'result' event.
  appendEvent(taskDir, 'PLAN', 'result', { payload: { ok: false, kind: 'error', error: 'spawn ENOMEM' } });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-921', issue: 921, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1, 'a failure payload as the last PLAN result must force a normal PLAN run');
});

// ---- (15) M2a/M2b: the typeof filter, and "last files-written wins" ----------------------------

// M2a: a files-written event whose baseMainSha is a NUMBER must be excluded by the `typeof ===
// 'string'` filter -- if that filter were deleted, this non-string event (journalled LAST) would
// become "the last files-written event" instead of the earlier, legitimate string-typed one,
// and a strict `!==` compare against ctx.task.baseMainSha (a string) would then always refuse
// reuse, even though a perfectly valid string match exists one event earlier.
test('handlePlan: a later files-written event with a NUMBER baseMainSha must not shadow an earlier valid string match (M2a)', async () => {
  const taskDir = mkTmp('spo-plan-resume-numsha-');
  const worktreePath = mkTmp('spo-plan-resume-numsha-wt-');
  const { planPath, invariantsPath } = priorPlanRun(taskDir, { baseMainSha: 'sha-X' });
  // A later files-written event with a non-string baseMainSha -- e.g. a hand-edited or corrupted
  // journal line. typeof 12345 !== 'string', so condition 2's filter must exclude it.
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: 12345 });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-922', issue: 922, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 0, 'the number-typed event must be filtered out, leaving the earlier string match reusable');
});

// M2b: "last files-written wins" -- two string-typed events, only one of which matches the
// current sha; whichever is JOURNALLED LAST must be the one that decides the outcome.
test('handlePlan: two files-written events, only the LAST matches the current sha -> reuses', async () => {
  const taskDir = mkTmp('spo-plan-resume-lastwins-a-');
  const worktreePath = mkTmp('spo-plan-resume-lastwins-a-wt-');
  const dir = path.join(taskDir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, 'plan-923.md');
  const invariantsPath = path.join(dir, 'invariants-923.md');
  fs.writeFileSync(planPath, '# Plan\n');
  fs.writeFileSync(invariantsPath, '# Invariants\n');
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: 'sha-OLD' });
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: 'sha-NEW' });
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { ok: true, plan_path: planPath, invariants_path: invariantsPath, invariant_ids: [], check_commands: [] },
  });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-923', issue: 923, baseMainSha: 'sha-NEW' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 0, 'the LAST files-written event matches the current sha -- must reuse');
});

test('handlePlan: two files-written events, only the FIRST matches the current sha -> runs PLAN normally', async () => {
  const taskDir = mkTmp('spo-plan-resume-lastwins-b-');
  const worktreePath = mkTmp('spo-plan-resume-lastwins-b-wt-');
  const dir = path.join(taskDir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, 'plan-924.md');
  const invariantsPath = path.join(dir, 'invariants-924.md');
  fs.writeFileSync(planPath, '# Plan\n');
  fs.writeFileSync(invariantsPath, '# Invariants\n');
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: 'sha-NEW' });
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: 'sha-OLD' });
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { ok: true, plan_path: planPath, invariants_path: invariantsPath, invariant_ids: [], check_commands: [] },
  });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-924', issue: 924, baseMainSha: 'sha-NEW' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 1, 'the LAST files-written event does not match -- must re-PLAN even though an earlier one did');
});

// ---- (16) M7: the reuse path re-journals files-written -----------------------------------------

test('handlePlan (reuse path): re-journals a files-written event on top of the one already in the journal', async () => {
  const taskDir = mkTmp('spo-plan-resume-refileswritten-');
  const worktreePath = mkTmp('spo-plan-resume-refileswritten-wt-');
  priorPlanRun(taskDir, { baseMainSha: 'sha-X' });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-925', issue: 925, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 0);

  const journal = readJournal(taskDir);
  const filesWritten = journal.filter((e) => e.state === 'PLAN' && e.event === 'files-written');
  assert.equal(filesWritten.length, 2, 'reuse must re-journal files-written on top of the original one from priorPlanRun');
});

// ---- (17) F1-F5 coverage: the reused payload stamps paths explicitly, and shadow never reuses --

// F1: previousPayload can lack plan_path/invariants_path entirely (the SIGTERM-during-buildBaseline
// window this fix targets: 'result' journalled markdown-only, then 'files-written', daemon dies
// before the second 'result' re-journal that would normally add the paths). The reused payload
// must still carry them, stamped from `reuse` itself (which condition 4 already verified on
// disk), not from previousPayload.
test('handlePlan (reuse path): reused result payload carries plan_path/invariants_path even when previousPayload lacks them (F1)', async () => {
  const taskDir = mkTmp('spo-plan-resume-stamp-');
  const worktreePath = mkTmp('spo-plan-resume-stamp-wt-');
  const dir = path.join(taskDir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, 'plan-926.md');
  const invariantsPath = path.join(dir, 'invariants-926.md');
  fs.writeFileSync(planPath, '# Plan\n');
  fs.writeFileSync(invariantsPath, '# Invariants\n');
  appendEvent(taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: 'sha-X' });
  // The markdown-only 'result' shape handlePlan journals right after the LLM reply, BEFORE the
  // normal path's own end-of-function re-journal adds plan_path/invariants_path -- exactly what
  // a SIGTERM in that window leaves behind.
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      ok: true,
      plan_markdown: '# Plan\n',
      invariants_markdown: '# Invariants\n',
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    },
  });

  const spawnSync = countingSpawn(planReplyEnvelope(validPlanPayload()));
  const task = baseTask({ id: 'card-926', issue: 926, baseMainSha: 'sha-X' });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawnSync });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  assert.equal(spawnSync.callCount, 0, 'still a reuse -- previousPayload.ok is not false');

  const payload = lastResultPayload(taskDir, 'PLAN');
  assert.equal(payload.plan_path, planPath, 'plan_path must be stamped from reuse, not left undefined');
  assert.equal(payload.invariants_path, invariantsPath, 'invariants_path must be stamped from reuse, not left undefined');
});

// F5: a shadow-mode ctx whose task.json happens to carry a baseMainSha field (a hand-built
// fixture, a copy-pasted task.json, ...) must never reuse -- the exclusion is now an explicit,
// first check in decidePlanReuse, not merely incidental to condition 1 never passing outside real
// mode.
test('handlePlan: shadow mode with a baseMainSha present on ctx.task still never reuses (F5)', async () => {
  const taskDir = mkTmp('spo-plan-resume-shadownosha-');
  priorPlanRun(taskDir, { baseMainSha: 'sha-X' }); // a real-mode-shaped prior run sitting in the journal

  const task = {
    id: 'card-927',
    kind: 'card',
    issue: 927,
    baseMainSha: 'sha-X', // matches the journal exactly -- would satisfy every other condition
    shadow: {
      llm: {
        PLAN: {
          ok: true,
          plan_markdown: '# Fresh shadow plan\n',
          invariants_markdown: '# Fresh shadow invariants\n',
          invariant_ids: ['INV-SHADOW'],
          check_commands: ['npm run typecheck'],
        },
      },
    },
  };
  const ctx = buildCtx(task.id, task, taskDir, { shadowMode: true, dryRun: false });

  const next = await HANDLERS.PLAN(ctx);

  assert.equal(next, 'IMPLEMENT');
  const journal = readJournal(taskDir);
  assert.equal(journal.some((e) => e.event === 'plan-reused'), false, 'shadow mode must never reuse, regardless of baseMainSha');
  // A fresh normal-path write happened instead, with the shadow fixture's own (different) content.
  const scratchPlanPath = journal.filter((e) => e.event === 'files-written').pop().planPath;
  assert.equal(fs.readFileSync(scratchPlanPath, 'utf8'), '# Fresh shadow plan\n');
});
