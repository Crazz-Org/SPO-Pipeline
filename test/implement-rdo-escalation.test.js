'use strict';
// Unit/wiring tests for card #213, action 2 -- "IMPLEMENT's Opus escalation resolves from the
// plan's declared files" -- plus its 2026-09-12 amendment (trigger 4: a retry after a DIAGNOSE or
// a VALIDATE reject also escalates).
//
// Since 2026-09-23 (EXP-IMPLEMENT-OPUS-5-5) IMPLEMENT runs OPUS_5_5 on every path and the same
// signals escalate EFFORT ('low' -> 'medium') instead of model (Sonnet -> Opus). The handler tests
// below therefore read `--effort` off the spawned argv, and every card is S-sized: S is the only
// size whose base effort ('low') differs from the escalated one ('medium').
//
// Pure resolveStepContract/shouldEscalate coverage of the three-source-plus-trigger-4 logic lives
// in test/step-contracts.test.js, next to the rest of that table's tests. THIS file is the
// state-machine-level half: the WIRING that feeds shouldEscalate its inputs --
//   - guardDeclaredFiles (state-machine.js) setting ctx.task.planFilesToChange from PLAN's own
//     declaration, for both shapes it accepts, and leaving it unset for the shapes that don't
//     count as a declaration at all (mirrors test/protected-files-guard.test.js's own handlePlan
//     coverage, but asserts the field this action added rather than the park/journal behaviour
//     that file already covers).
//   - task-values.js's lastJournaledPlanFiles, the restart-durable fallback read straight off the
//     PLAN 'result' journal event (decision recorded on the card itself: one event is enough, no
//     second journal event was added).
//   - handleImplement (state-machine.js) actually reaching the LLM step with the right model and
//     effort, end to end, real-mode ctx + an injected deps.spawnSync spy capturing the `claude
//     --model ... --effort ...` argv -- same idiom test/implement-empty-result.test.js and
//     test/protected-files-guard.test.js already use.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { appendEvent } = require('../orchestrator/journal');
const { lastJournaledPlanFiles } = require('../orchestrator/task-values');
const { OPUS_5_5 } = require('../orchestrator/step-contracts');
const { mkTmp, fakeSpawnDeps, fakeExecDeps } = require('./helpers');

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// =============================================================================================
// ---- task-values.js: lastJournaledPlanFiles ----------------------------------------------------
// =============================================================================================

test('lastJournaledPlanFiles: reads files_to_change straight off the last PLAN result event (array shape)', () => {
  const taskDir = mkTmp('spo-ljpf-array-');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { files_to_change: ['/wt/src/components/Header.tsx'], plan_path: '/wt/scratch/plan-1.md' },
  });
  assert.deepEqual(lastJournaledPlanFiles(taskDir), ['/wt/src/components/Header.tsx']);
});

test('lastJournaledPlanFiles: reads files_to_change off a JSON-encoded-string shape too (the wire shape #118 found on 93/93 real replies; pre-#229 -- since #229 the wire sends a real array, covered by the test above)', () => {
  const taskDir = mkTmp('spo-ljpf-jsonstring-');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { files_to_change: JSON.stringify(['/wt/src/shared/rdo-members.ts']) },
  });
  assert.deepEqual(lastJournaledPlanFiles(taskDir), ['/wt/src/shared/rdo-members.ts']);
});

test('lastJournaledPlanFiles: an EMPTY declared list is a real declaration -- returns [], not undefined', () => {
  const taskDir = mkTmp('spo-ljpf-empty-');
  appendEvent(taskDir, 'PLAN', 'result', { payload: { files_to_change: [] } });
  const result = lastJournaledPlanFiles(taskDir);
  assert.ok(Array.isArray(result), 'expected an array back for an empty declaration');
  assert.equal(result.length, 0);
});

test('lastJournaledPlanFiles: undefined when PLAN never declared at all (absent)', () => {
  const taskDir = mkTmp('spo-ljpf-absent-');
  appendEvent(taskDir, 'PLAN', 'result', { payload: { plan_path: '/wt/scratch/plan-1.md' } });
  assert.equal(lastJournaledPlanFiles(taskDir), undefined);
});

test('lastJournaledPlanFiles: undefined when PLAN never ran at all (no journal)', () => {
  const taskDir = mkTmp('spo-ljpf-none-');
  assert.equal(lastJournaledPlanFiles(taskDir), undefined);
});

test('lastJournaledPlanFiles: undefined for a malformed (non-JSON) string, same as guardDeclaredFiles treats it as undeclared', () => {
  const taskDir = mkTmp('spo-ljpf-malformed-');
  appendEvent(taskDir, 'PLAN', 'result', { payload: { files_to_change: 'not json' } });
  assert.equal(lastJournaledPlanFiles(taskDir), undefined);
});

test('lastJournaledPlanFiles: reads the MOST RECENT PLAN result event, not an earlier one', () => {
  const taskDir = mkTmp('spo-ljpf-latest-');
  appendEvent(taskDir, 'PLAN', 'result', { payload: { files_to_change: ['/wt/old.ts'] } });
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: { files_to_change: ['/wt/new.ts'], plan_path: '/wt/scratch/plan-1.md' },
  });
  assert.deepEqual(lastJournaledPlanFiles(taskDir), ['/wt/new.ts']);
});

// =============================================================================================
// ---- state-machine.js: guardDeclaredFiles sets ctx.task.planFilesToChange ----------------------
// =============================================================================================

// Card #239 chantier, action A5b-2: migrated off `deps.spawnSync`'s `{status, stdout: JSON string,
// stderr, signal}` shape onto `deps.spawn` (test/helpers.js's `fakeSpawnDeps`/`fakeSpawnedChild`) --
// same seam and idioms as test/llm-real-card.test.js's own `initMessage`/`resultMessage`.
function planInitMessage(sessionId = 'sess-implement-rdo-escalation-plan') {
  return { type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}

function planResultMessage(planPayload, overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: 'sess-implement-rdo-escalation-plan',
    modelUsage: { 'claude-fable-5': { inputTokens: 10, outputTokens: 5 } },
    result: JSON.stringify(planPayload),
    ...overrides,
  };
}

function planReplyLines(planPayload) {
  return [planInitMessage(), planResultMessage(planPayload)];
}

function realPlanCtx({ task, taskDir, worktreePath, spawn }) {
  const accountsDir = mkTmp('spo-ire-plan-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  return buildCtx(task.id, { ...task, worktreePath }, taskDir, {
    shadowMode: false,
    dryRun: false,
    claudeAccountsDir: accountsDir,
    stepDeadlineMs: 30000,
    deps: fakeExecDeps({ spawn }),
  });
}

function basePlanTask(overrides = {}) {
  return { id: 'card-2100', kind: 'card', issue: 2100, title: 'Some card', criterion: 'the thing is done', size: 'S', ...overrides };
}

test('guardDeclaredFiles: sets ctx.task.planFilesToChange to the normalized ARRAY-shape declaration', async () => {
  const taskDir = mkTmp('spo-ire-guard-array-');
  const worktreePath = mkTmp('spo-ire-guard-array-wt-');
  const plan = {
    ok: true,
    plan_markdown: '# Plan\n',
    invariants_markdown: '# Invariants\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: ['src/components/Header.tsx'],
  };
  const { spawn } = fakeSpawnDeps(planReplyLines(plan));
  const task = basePlanTask({ id: 'card-2101', issue: 2101 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawn });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  assert.deepEqual(ctx.task.planFilesToChange, ['src/components/Header.tsx']);
});

test('guardDeclaredFiles: sets ctx.task.planFilesToChange for the JSON-STRING shape too (the real-corpus wire shape)', async () => {
  const taskDir = mkTmp('spo-ire-guard-jsonstring-');
  const worktreePath = mkTmp('spo-ire-guard-jsonstring-wt-');
  const plan = {
    ok: true,
    plan_markdown: '# Plan\n',
    invariants_markdown: '# Invariants\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: JSON.stringify(['src/shared/rdo-members.ts']),
  };
  const { spawn } = fakeSpawnDeps(planReplyLines(plan));
  const task = basePlanTask({ id: 'card-2102', issue: 2102 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawn });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  assert.deepEqual(ctx.task.planFilesToChange, ['src/shared/rdo-members.ts']);
});

test('guardDeclaredFiles: EMPTY declared list still sets ctx.task.planFilesToChange (to []), not left unset', async () => {
  const taskDir = mkTmp('spo-ire-guard-empty-');
  const worktreePath = mkTmp('spo-ire-guard-empty-wt-');
  const plan = {
    ok: true,
    plan_markdown: '# Plan\n',
    invariants_markdown: '# Invariants\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: [],
  };
  const { spawn } = fakeSpawnDeps(planReplyLines(plan));
  const task = basePlanTask({ id: 'card-2103', issue: 2103 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawn });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  assert.ok(Array.isArray(ctx.task.planFilesToChange), 'expected an array, not left unset');
  assert.equal(ctx.task.planFilesToChange.length, 0);
});

test('guardDeclaredFiles: leaves ctx.task.planFilesToChange UNSET for the undeclared shapes (absent -- journals plan-files-undeclared)', async () => {
  const taskDir = mkTmp('spo-ire-guard-absent-');
  const worktreePath = mkTmp('spo-ire-guard-absent-wt-');
  const plan = {
    ok: true,
    plan_markdown: '# Plan\n',
    invariants_markdown: '# Invariants\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    // files_to_change omitted entirely.
  };
  const { spawn } = fakeSpawnDeps(planReplyLines(plan));
  const task = basePlanTask({ id: 'card-2104', issue: 2104 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawn });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(ctx.task.planFilesToChange, undefined);
  const events = readJournal(taskDir);
  assert.ok(events.some((e) => e.state === 'PLAN' && e.event === 'plan-files-undeclared'));
});

test('guardDeclaredFiles: leaves ctx.task.planFilesToChange UNSET for a malformed (non-JSON) string declaration', async () => {
  const taskDir = mkTmp('spo-ire-guard-malformed-');
  const worktreePath = mkTmp('spo-ire-guard-malformed-wt-');
  const plan = {
    ok: true,
    plan_markdown: '# Plan\n',
    invariants_markdown: '# Invariants\n',
    invariant_ids: ['INV-1'],
    check_commands: ['npm run typecheck'],
    files_to_change: 'not json at all',
  };
  const { spawn } = fakeSpawnDeps(planReplyLines(plan));
  const task = basePlanTask({ id: 'card-2105', issue: 2105 });
  const ctx = realPlanCtx({ task, taskDir, worktreePath, spawn });

  const next = await HANDLERS.PLAN(ctx);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(ctx.task.planFilesToChange, undefined);
});

// =============================================================================================
// ---- handleImplement: end-to-end model/effort resolution --------------------------------------------
// =============================================================================================

// Card #239 chantier, action A5b-2: `claude` no longer spawns through `deps.spawnSync` at all --
// migrated onto `deps.spawn` (fakeSpawnDeps/fakeExecDeps, test/helpers.js), same seam as the PLAN
// section above. Nothing in this section's tests ever exercises a git/npm spawnSync call (the
// worktreePath fixtures below are never real git repos), so there is no second, non-claude fake to
// keep -- `claudeSpy` below is the ONLY spawn seam these tests need.
function implementInitMessage(sessionId = 'sess-implement-rdo-escalation') {
  return { type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] };
}

function implementResultMessage(resultObj, overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: 'sess-implement-rdo-escalation',
    modelUsage: { 'claude-x': { inputTokens: 10, outputTokens: 5 } },
    result: JSON.stringify(resultObj),
    ...overrides,
  };
}

// claudeSpy(implementPayload) -- returns { spawn, calls } (fakeSpawnDeps' own shape). `calls[i].args`
// is the REAL argv the SDK built and handed to `spawn`, the same argv `modelUsed` below used to read
// straight off the old spawnSync call's own `args` parameter.
function claudeSpy(implementPayload) {
  return fakeSpawnDeps([implementInitMessage(), implementResultMessage(implementPayload)]);
}

function argvFlag(spy, flag) {
  assert.equal(spy.calls.length, 1, 'expected exactly one claude call');
  const args = spy.calls[0].args;
  const idx = args.indexOf(flag);
  assert.ok(idx !== -1, `expected ${flag} in argv, got ${JSON.stringify(args)}`);
  return args[idx + 1];
}

function modelUsed(spy) {
  return argvFlag(spy, '--model');
}

function effortUsed(spy) {
  return argvFlag(spy, '--effort');
}

// Escalated: Opus 5.5 at 'medium'. Base (S card): Opus 5.5 at 'low'. The model is asserted too, so
// a regression back to a model escalation (or to a Sonnet base) is caught here as well.
function assertEscalated(spy, msg) {
  assert.equal(modelUsed(spy), OPUS_5_5, msg);
  assert.equal(effortUsed(spy), 'medium', msg);
}

function assertBaseS(spy, msg) {
  assert.equal(modelUsed(spy), OPUS_5_5, msg);
  assert.equal(effortUsed(spy), 'low', msg);
}

const IMPLEMENT_OK_PAYLOAD = {
  summary: 'did the thing',
  files_changed: ['src/components/Header.tsx'],
  invariants: [],
  tests_run: ['npm test'],
  all_green: 'true',
};

// Real-mode ctx driving IMPLEMENT through the full `kind: "card"` path, same idiom as
// test/implement-empty-result.test.js's realCardCtx -- no ctx.task.llm.IMPLEMENT override, so
// step-contracts.js's resolveStepContract actually runs.
function realImplementCtx(task, taskDir, spawn) {
  const accountsDir = mkTmp('spo-ire-implement-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      plan_path: path.join(taskDir, 'scratch', `plan-${task.issue}.md`),
      invariants_path: path.join(taskDir, 'scratch', `invariants-${task.issue}.md`),
      invariant_ids: ['INV-1'],
      check_commands: ['npm test'],
    },
  });
  return buildCtx(task.id, task, taskDir, {
    shadowMode: false,
    dryRun: false,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
    // handleImplement also spawns `gh` for a real board move (board.js's moveCard/runSync) -- the
    // old `claudeSpy`'s `return ok('')` fallback branch answered that call too, before `claude`
    // itself moved off `deps.spawnSync` entirely. Kept here, blandly, for the exact same reason;
    // `deps.spawn`/fakeExecDeps below is the ONLY seam the actual `claude` call uses now.
    deps: { ...fakeExecDeps({ spawn }), spawnSync: () => ({ status: 0, stdout: '', stderr: '', signal: null }) },
  });
}

function baseImplementTask(issue, overrides = {}) {
  const worktreePath = mkTmp(`spo-ire-implement-wt-${issue}-`);
  return {
    id: `card-${issue}`,
    kind: 'card',
    issue,
    criterion: 'the widget renders',
    worktreePath,
    // S, deliberately: the only size whose base IMPLEMENT effort ('low') differs from the escalated
    // one ('medium'). An M card would read 'medium' whether or not a signal fired.
    size: 'S',
    ...overrides,
  };
}

// ---- source 1: the real diff (ctx.task.rdoDiffTouched) ----------------------------------------

test('handleImplement: rdoDiffTouched === true escalates effort to medium, no plan declaration and no intake guess needed', async () => {
  const task = baseImplementTask(3001, { rdoDiffTouched: true, touchesRdoMembers: false });
  const taskDir = mkTmp('spo-ire-src1-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);

  await HANDLERS.IMPLEMENT(ctx);
  assertEscalated(claude);
});

// ---- source 2: the plan's own declaration ------------------------------------------------------

test('handleImplement: an EMPTY plan declaration resolves planDeclaresRdoMembers false and does NOT fall back to touchesRdoMembers -- stays at low effort', async () => {
  const task = baseImplementTask(3002, { touchesRdoMembers: true, planFilesToChange: [] });
  const taskDir = mkTmp('spo-ire-src2-empty-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);

  await HANDLERS.IMPLEMENT(ctx);
  assertBaseS(claude);
});

test('handleImplement: a plan declaring rdo-members.ts escalates effort to medium even with touchesRdoMembers false', async () => {
  const task = baseImplementTask(3003, {
    touchesRdoMembers: false,
    planFilesToChange: ['/home/crazz/.spo-worktrees/issue-3003/src/shared/rdo-members.ts'],
  });
  const taskDir = mkTmp('spo-ire-src2-declared-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);

  await HANDLERS.IMPLEMENT(ctx);
  assertEscalated(claude);
});

test('handleImplement: a plan declaring OTHER files (not rdo-members.ts) resolves false and does not escalate, touchesRdoMembers true or not', async () => {
  const task = baseImplementTask(3004, {
    touchesRdoMembers: true,
    planFilesToChange: ['/wt/src/components/Header.tsx'],
  });
  const taskDir = mkTmp('spo-ire-src2-other-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);

  await HANDLERS.IMPLEMENT(ctx);
  assertBaseS(claude);
});

// ---- source 2, restart-durable fallback: ctx.task.planFilesToChange absent, read from the journal

test('handleImplement: planFilesToChange NOT set in-memory but journaled by an earlier PLAN result -- read via lastJournaledPlanFiles, still escalates', async () => {
  const task = baseImplementTask(3005, { touchesRdoMembers: false });
  const taskDir = mkTmp('spo-ire-src2-journal-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);
  // realImplementCtx already journaled one PLAN 'result' event (no files_to_change); journal a
  // second, later one that DOES declare the catalogue -- lastJournaledPlanFiles reads the LAST
  // PLAN result event, same convention as lastResultPayload/lastJournaledRdoDiffTouched. Carries
  // plan_path/invariants_path too, same as handlePlan's own re-journalled 'result' always does --
  // task-values.js's buildPromptValues reads THIS event for IMPLEMENT's own placeholders.
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      files_to_change: JSON.stringify(['/wt/src/shared/rdo-members.ts']),
      plan_path: path.join(taskDir, 'scratch', `plan-${task.issue}.md`),
      invariants_path: path.join(taskDir, 'scratch', `invariants-${task.issue}.md`),
      invariant_ids: ['INV-1'],
      check_commands: ['npm test'],
    },
  });

  await HANDLERS.IMPLEMENT(ctx);
  assertEscalated(claude);
});

// ---- source 3: touchesRdoMembers, the fallback for "reached neither of the above" --------------

test('handleImplement: no plan declaration at all -- falls through to touchesRdoMembers (today\'s pre-#213 behaviour)', async () => {
  const task = baseImplementTask(3006, { touchesRdoMembers: true });
  const taskDir = mkTmp('spo-ire-src3-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);

  await HANDLERS.IMPLEMENT(ctx);
  assertEscalated(claude);
});

test('handleImplement: no plan declaration at all AND touchesRdoMembers false -- stays at low effort', async () => {
  const task = baseImplementTask(3007, { touchesRdoMembers: false });
  const taskDir = mkTmp('spo-ire-src3-false-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);

  await HANDLERS.IMPLEMENT(ctx);
  assertBaseS(claude);
});

// ---- lSize: unchanged ---------------------------------------------------------------------------
// NOT discriminating end to end since 2026-09-23: an L card's base effort is already 'medium'
// (IMPLEMENT_EFFORT_BY_SIZE.L), the same as escalatedEffort, so the argv reads identically whether
// lSize fired or not. It still pins the argv (Opus 5.5, never above 'medium'); lSize itself firing
// is pinned through `effortEscalated` in test/step-contracts.test.js.

test('handleImplement: an L-sized card still escalates on size alone, no RDO signal at all', async () => {
  const task = baseImplementTask(3008, { size: 'L', touchesRdoMembers: false, planFilesToChange: [] });
  const taskDir = mkTmp('spo-ire-lsize-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);

  await HANDLERS.IMPLEMENT(ctx);
  assertEscalated(claude);
});

// ---- regression (card #213's own acceptance criterion 3): rdoDiffTouched must win over a plan
// that declared something else, the hole scripted.js's touchesRdoMembers false->true promotion
// exists to prevent from reopening on IMPLEMENT's own retry path.

test('REGRESSION: a retry after PUSH_PR on a card whose diff touched rdo-members.ts, but whose PLAN did not declare it, still resolves to medium effort', async () => {
  const task = baseImplementTask(3009, {
    touchesRdoMembers: false, // intake never guessed RDO
    planFilesToChange: ['/wt/src/components/Header.tsx'], // PLAN declared something else
    rdoDiffTouched: true, // PUSH_PR already ran once and the real diff disagrees
  });
  const taskDir = mkTmp('spo-ire-regression-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);

  await HANDLERS.IMPLEMENT(ctx);
  assertEscalated(claude, 'source 1 (the real diff) must win over source 2 (the plan said no)');
});

// ---- trigger 4 (2026-09-12 amendment): a retry after DIAGNOSE or a VALIDATE reject -------------

test('trigger 4: a first IMPLEMENT on a non-wire, non-L card resolves to low effort', async () => {
  const task = baseImplementTask(3010, { touchesRdoMembers: false });
  const taskDir = mkTmp('spo-ire-trigger4-first-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);
  assert.equal(ctx.counters.diagnoseAttempts, 0, 'sanity: a fresh ctx starts at 0 attempts');

  await HANDLERS.IMPLEMENT(ctx);
  assertBaseS(claude);
});

test('trigger 4: the SAME card, retried after a DIAGNOSE attempt, resolves to medium effort', async () => {
  const task = baseImplementTask(3011, { touchesRdoMembers: false });
  const taskDir = mkTmp('spo-ire-trigger4-diag-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);
  // Simulates what handleDiagnose does to this same counter (state-machine.js: `++ctx.counters.diagnoseAttempts`)
  // before routing back to IMPLEMENT, without re-running the whole DIAGNOSE handler.
  ctx.counters.diagnoseAttempts = 1;

  await HANDLERS.IMPLEMENT(ctx);
  assertEscalated(claude);
});

test('trigger 4: a retry after a VALIDATE reject (validateRejects > 0) also resolves to medium effort', async () => {
  const task = baseImplementTask(3012, { touchesRdoMembers: false });
  const taskDir = mkTmp('spo-ire-trigger4-validate-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);
  ctx.counters.validateRejects = 1;

  await HANDLERS.IMPLEMENT(ctx);
  assertEscalated(claude);
});

// ---- trigger 4 survives a --worker resume that rebuilt ctx.counters from state.json -----------
//
// daemon.js's --worker mode always calls runTask fresh from INTAKE (runTask's own header:
// "a retry always restarts a task at INTAKE"), so today the two places ctx.counters is ever
// restored from state.json -- reparkCrashedTask (state-machine.js) and orphan-scan.js's own
// identical restore -- use the restored value only to write an accurate PARK report, not to
// re-enter this handler on the same ctx. This test pins the property handleImplement actually
// guarantees, independent of whether a live mid-pipeline resume exists: because the field is
// resolved from ctx.counters AT THIS CALL rather than from anything decided earlier, a ctx whose
// counters were rebuilt by that exact restore sequence resolves the same escalation a ctx that
// lived through the DIAGNOSE loop in one continuous process would. Mirrors the restore lines
// verbatim (state-machine.js reparkCrashedTask, `ctx.counters.diagnoseAttempts = (state &&
// state.diagnoseAttempts) || 0`).
//
// NAMED FOR WHAT IT PINS, after the card's Opus verification pass (2026-09-12) confirmed the path
// itself does not exist: both restore sites call ONLY finalizePark, and orphan-scan.js imports
// just { buildCtx, finalizePark, isRealMode } -- no HANDLERS, no runTask. So the amendment's
// acceptance criterion "the same holds after a --worker resume that rebuilt the counters from
// state.json" is VACUOUS at HEAD: it cannot be satisfied against a real path, and an earlier name
// for this test ("trigger 4 survives a --worker resume") claimed a resume was pinned when what is
// pinned is call-time resolution. That property is real and is exercised for true on every live
// card by the IN-PROCESS retry loops (handleDiagnose -> IMPLEMENT, handleValidate REJECT ->
// IMPLEMENT, and the CI retry). Left at diagnoseAttempts: 2 deliberately, and noted here rather
// than dressed up: it therefore survives a `> 0` -> `> 1` mutation that the sibling test at
// diagnoseAttempts = 1 catches, so this test is a shape check, not the trigger's pinning.
test('trigger 4 resolves from ctx.counters AT CALL TIME, so a ctx rebuilt by reparkCrashedTask\'s restore lines escalates identically (the resume path itself does not exist -- see above)', async () => {
  const task = baseImplementTask(3013, { touchesRdoMembers: false });
  const taskDir = mkTmp('spo-ire-trigger4-resume-');
  const claude = claudeSpy(IMPLEMENT_OK_PAYLOAD);
  const ctx = realImplementCtx(task, taskDir, claude.spawn);
  assert.equal(ctx.counters.diagnoseAttempts, 0, 'sanity: buildCtx always starts a fresh ctx at 0');

  // The exact restore state-machine.js's reparkCrashedTask (and orphan-scan.js) apply to a
  // freshly-built ctx after reading a crashed task's last state.json snapshot.
  const restoredState = { diagnoseAttempts: 2, validateRejects: 0, ciImplementRetries: 1, mainMoveUsed: 0 };
  ctx.counters.diagnoseAttempts = restoredState.diagnoseAttempts || 0;
  ctx.counters.validateRejects = restoredState.validateRejects || 0;
  ctx.counters.ciImplementRetries = restoredState.ciImplementRetries || 0;
  ctx.counters.mainMoveUsed = Number(restoredState.mainMoveUsed) || 0;

  await HANDLERS.IMPLEMENT(ctx);
  assertEscalated(claude);
});
