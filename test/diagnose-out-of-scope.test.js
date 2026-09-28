'use strict';
// SPO-Pipeline#305 -- DIAGNOSE's out-of-scope answer gets a route. prompts/diagnose.md step 3 asks
// the judge to start `root_cause` with `out-of-scope:` (category `out-of-scope`) when the failure
// is not this card's code; until #305 nothing read that answer. diagnoseAndRoute always returned
// IMPLEMENT, IMPLEMENT correctly changed nothing (`empty-implement`), and the next DIAGNOSE attempt
// parked a plan-invalidating `diagnose-budget-exhausted` on a PR with nothing wrong with it
// (SPO-WebClient#1033 / PR #1082, #1073 / PR #1103). Now: back to GATE or CI_CHECKS on the same
// head, once per task, then a resumable `diagnose-out-of-scope` park.
//
// Most cases here go through the real dispatch -- `runDaemonOnce` (daemon.js --shadow --once ->
// runTask's transition loop), or `runTask` for the resume case -- so the route is proven reachable
// from production, not only from a direct handler call. The two real-mode cases call
// HANDLERS.DIAGNOSE directly because only real mode reads a HEAD sha (prepareJudgeInputs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js; must land before the orchestrator requires below.
require('./no-real-spawn');
const {
  HANDLERS,
  buildCtx,
  runTask,
  isOutOfScopeDiagnosis,
  isNullRootCauseString,
  OUT_OF_SCOPE_RECHECK_BUDGET,
  TRANSIENT_RETRY_REASONS,
  TERMINAL_PARK_REASONS,
} = require('../orchestrator/state-machine');
const { RESUMABLE_PARK_REASONS, buildParkComment } = require('../orchestrator/park-loop');
const { gateLogPath } = require('../orchestrator/task-values');
const { ParkSignal } = require('../orchestrator/park-signal');
const { mkTmp, writeTask, runDaemonOnce, readState, readJournal, readLedger, fakeExecDeps } = require('./helpers');

// #1033's attempt-2 answer, abridged: the prefix is there, the top-level category is not (the
// model wrote "Category: infra." inside the prose).
const OOS_1033 = {
  ok: true,
  rootCause:
    "out-of-scope: the bench gate failed on a live-server timeout, not on this card's code -- REQ_SEARCH_MENU_TOWNS FAIL 'Request timeout'. Category: infra.",
  category: null,
  suggestedFix: null,
};

function transitions(events) {
  return events.filter((e) => e.event === 'transition').map((e) => `${e.state}->${e.to}`);
}

// ---- the recogniser ------------------------------------------------------------------------

test('isOutOfScopeDiagnosis: the prefix alone, with category null (the #1033 attempt-2 shape)', () => {
  assert.equal(isOutOfScopeDiagnosis({ rootCause: OOS_1033.rootCause, category: null }), true);
  assert.equal(isOutOfScopeDiagnosis({ rootCause: '  OUT-OF-SCOPE: orchestrator/steps/scripted.js -- a pipeline bug' }), true);
});

test('isOutOfScopeDiagnosis: category `infra` or `out-of-scope` alone, trimmed and case-insensitive', () => {
  assert.equal(isOutOfScopeDiagnosis({ rootCause: 'the live DA service timed out', category: 'infra' }), true);
  assert.equal(isOutOfScopeDiagnosis({ rootCause: 'x', category: ' Out-Of-Scope ' }), true);
  assert.equal(isOutOfScopeDiagnosis({ rootCause: null, category: 'INFRA' }), true);
});

test('isOutOfScopeDiagnosis: an in-scope cause is not out of scope -- including one that merely mentions the phrase mid-sentence', () => {
  assert.equal(isOutOfScopeDiagnosis({ rootCause: 'coverage of changed lines dropped', category: 'coverage' }), false);
  assert.equal(isOutOfScopeDiagnosis({ rootCause: 'the fix is not out-of-scope: it is in src/a.ts', category: null }), false);
  assert.equal(isOutOfScopeDiagnosis({ rootCause: 'x', category: 'infrastructure' }), false);
  assert.equal(isOutOfScopeDiagnosis({}), false);
  assert.equal(isOutOfScopeDiagnosis(), false);
});

test('isNullRootCauseString: the string "null", trimmed, any case -- nothing else', () => {
  for (const v of ['null', ' NULL ', 'Null']) assert.equal(isNullRootCauseString(v), true, v);
  for (const v of [null, '', 'nullable field', 'not null', undefined, 0]) assert.equal(isNullRootCauseString(v), false, String(v));
});

// ---- the reason tables ---------------------------------------------------------------------

test('diagnose-out-of-scope: terminal, resumable by `continue`, NOT auto-retried, re-check budget is one', () => {
  assert.ok(TERMINAL_PARK_REASONS.has('diagnose-out-of-scope'));
  assert.ok(RESUMABLE_PARK_REASONS.has('diagnose-out-of-scope'));
  assert.ok(!TRANSIENT_RETRY_REASONS.has('diagnose-out-of-scope'));
  assert.equal(OUT_OF_SCOPE_RECHECK_BUDGET, 1);
});

// Not plan-invalidating: pinned through the real handlePlan in test/plan-resume.test.js's
// "orthogonal to the plan -> still reuses" loop, which lists `diagnose-out-of-scope`.

test('buildParkComment: diagnose-out-of-scope offers `continue` with its own phrasing (no conflict to merge)', () => {
  const body = buildParkComment({ reason: 'diagnose-out-of-scope', detail: { why: 'recheck-spent' }, lastState: 'DIAGNOSE', id: 'card-305', prNumber: 1082 });
  assert.match(body, /fix what the diagnosis below names outside this card/);
  assert.match(body, /reply "continue" to resume at CHECK on `claude-pipe\/card-305`/);
  assert.doesNotMatch(body, /resolving the conflict/);
});

// ---- through the real dispatch (daemon.js --shadow --once) ----------------------------------

test('GATE fail -> out-of-scope DIAGNOSE -> back to GATE on the same head (no IMPLEMENT/CHECK/PUSH_PR between), gate passes -> DONE', () => {
  const queueDir = mkTmp('spo-queue-oos-gate-');
  const journalDir = mkTmp('spo-journal-oos-gate-');
  const id = 'oos-gate-recheck';
  writeTask(queueDir, '001.json', {
    id,
    title: 'Out-of-scope gate failure, re-gated',
    kind: 'synthetic',
    shadow: { gate: [1, 0], prWait: [0], llm: { DIAGNOSE: OOS_1033, VALIDATE: { verdict: 'PASS' } } },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'DONE');
  assert.equal(state.diagnoseAttempts, 1, 'the out-of-scope attempt counts against the DIAGNOSE budget');
  assert.equal(state.outOfScopeRecheckUsed, 1, 'persisted in state.json');

  const events = readJournal(journalDir, id);
  const t = transitions(events);
  const i = t.indexOf('GATE->DIAGNOSE');
  assert.ok(i >= 0);
  assert.equal(t[i + 1], 'DIAGNOSE->GATE', 'DIAGNOSE goes straight back to GATE');
  assert.equal(t.filter((x) => x.endsWith('->IMPLEMENT')).length, 1, 'IMPLEMENT ran once, before the gate -- never after DIAGNOSE');
  assert.equal(t.filter((x) => x === 'PUSH_PR->GATE').length, 1, 'no second PUSH_PR: no new commit, the same head');

  const recheck = events.filter((e) => e.event === 'diagnose-out-of-scope-recheck');
  assert.equal(recheck.length, 1);
  assert.equal(recheck[0].from, 'GATE');
  assert.equal(recheck[0].attempt, 1);
  assert.equal(recheck[0].headSha, null, 'shadow mode has no worktree to read a sha from');

  const ledger = readLedger(journalDir, id).trim().split('\n').filter(Boolean);
  assert.deepEqual(ledger, [`attempt 1 | ${OOS_1033.rootCause} | recheck (out of scope)`]);
});

test('a second out-of-scope answer on the same task parks diagnose-out-of-scope -- not the duplicate-root-cause park its identical text would otherwise trip', () => {
  const queueDir = mkTmp('spo-queue-oos-twice-');
  const journalDir = mkTmp('spo-journal-oos-twice-');
  const id = 'oos-gate-twice';
  writeTask(queueDir, '001.json', {
    id,
    title: 'Out-of-scope twice',
    kind: 'synthetic',
    shadow: { gate: [1, 1], llm: { DIAGNOSE: OOS_1033 } },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-out-of-scope');
  assert.equal(state.diagnoseAttempts, 2);
  assert.equal(state.outOfScopeRecheckUsed, 1);

  const events = readJournal(journalDir, id);
  const t = transitions(events);
  assert.equal(t.filter((x) => x.endsWith('->IMPLEMENT')).length, 1, 'no IMPLEMENT after either DIAGNOSE');
  assert.deepEqual(
    t.filter((x) => x.includes('DIAGNOSE')),
    ['GATE->DIAGNOSE', 'DIAGNOSE->GATE', 'GATE->DIAGNOSE'],
    'one re-check, then the park'
  );
  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked.detail.why, 'recheck-spent');
  assert.equal(parked.detail.from, 'GATE');
  assert.equal(parked.detail.rootCause, OOS_1033.rootCause, 'the park carries the diagnosis text');

  const ledger = readLedger(journalDir, id).trim().split('\n').filter(Boolean);
  assert.deepEqual(ledger, [
    `attempt 1 | ${OOS_1033.rootCause} | recheck (out of scope)`,
    `attempt 2 | ${OOS_1033.rootCause} | parked (out of scope)`,
  ]);
});

test('CI_CHECKS fail -> out-of-scope DIAGNOSE -> back to CI_CHECKS (no IMPLEMENT, no CI retry charged), checks green -> DONE', () => {
  const queueDir = mkTmp('spo-queue-oos-ci-');
  const journalDir = mkTmp('spo-journal-oos-ci-');
  const id = 'oos-ci-recheck';
  writeTask(queueDir, '001.json', {
    id,
    title: 'Out-of-scope CI failure, re-polled',
    kind: 'synthetic',
    shadow: {
      gate: [0],
      ciChecks: ['Something-unknown', null],
      prWait: [0],
      llm: { DIAGNOSE: { ok: true, rootCause: 'the CodeQL runner was cancelled', category: 'infra' }, VALIDATE: { verdict: 'PASS' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'DONE');
  assert.equal(state.ciImplementRetries, 0);
  const events = readJournal(journalDir, id);
  const t = transitions(events);
  const i = t.indexOf('CI_CHECKS->DIAGNOSE');
  assert.ok(i >= 0);
  assert.equal(t[i + 1], 'DIAGNOSE->CI_CHECKS');
  assert.equal(t.filter((x) => x.endsWith('->IMPLEMENT')).length, 1);
  assert.equal(t.filter((x) => x === 'PUSH_PR->GATE').length, 1);
  const recheck = events.find((e) => e.event === 'diagnose-out-of-scope-recheck');
  assert.equal(recheck.from, 'CI_CHECKS');
});

test('an in-scope cause (category "coverage") still routes DIAGNOSE -> IMPLEMENT, as before #305', () => {
  const queueDir = mkTmp('spo-queue-oos-inscope-');
  const journalDir = mkTmp('spo-journal-oos-inscope-');
  const id = 'oos-in-scope';
  writeTask(queueDir, '001.json', {
    id,
    title: 'In-scope gate failure',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: { DIAGNOSE: { ok: true, rootCause: 'coverage of changed lines dropped', category: 'coverage' }, VALIDATE: { verdict: 'PASS' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'DONE');
  assert.equal(state.outOfScopeRecheckUsed, 0);
  const events = readJournal(journalDir, id);
  assert.ok(transitions(events).includes('DIAGNOSE->IMPLEMENT'));
  assert.ok(!events.some((e) => e.event === 'diagnose-out-of-scope-recheck'));
});

test('out-of-scope entered from CHECK (nothing to re-check) parks diagnose-out-of-scope at once, why origin-not-recheckable', () => {
  const queueDir = mkTmp('spo-queue-oos-check-');
  const journalDir = mkTmp('spo-journal-oos-check-');
  const id = 'oos-from-check';
  writeTask(queueDir, '001.json', {
    id,
    title: 'Out-of-scope CHECK failure',
    kind: 'synthetic',
    shadow: { check: [1], llm: { DIAGNOSE: OOS_1033 } },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-out-of-scope');
  assert.equal(state.outOfScopeRecheckUsed, 0);
  const parked = readJournal(journalDir, id).find((e) => e.event === 'parked');
  assert.equal(parked.detail.from, 'CHECK');
  assert.equal(parked.detail.why, 'origin-not-recheckable');
});

test('root_cause "null" (the STRING, #1033 attempt 3) parks diagnose-no-new-cause exactly like root_cause null -- even with category "infra"', () => {
  for (const rootCause of ['null', ' NULL ']) {
    const queueDir = mkTmp('spo-queue-oos-nullstr-');
    const journalDir = mkTmp('spo-journal-oos-nullstr-');
    const id = 'oos-null-string';
    writeTask(queueDir, '001.json', {
      id,
      title: 'DIAGNOSE returns the string null',
      kind: 'synthetic',
      shadow: { gate: [1], llm: { DIAGNOSE: { ok: true, rootCause, category: 'infra', suggestedFix: null } } },
    });

    runDaemonOnce(queueDir, journalDir);

    const state = readState(journalDir, id);
    assert.equal(state.state, 'PARKED', JSON.stringify(rootCause));
    assert.equal(state.reason, 'diagnose-no-new-cause', JSON.stringify(rootCause));
    const ledger = readLedger(journalDir, id).trim().split('\n').filter(Boolean);
    assert.deepEqual(ledger, ['attempt 1 | (no new cause) | parked (no new cause)']);
  }
});

// ---- the bound survives a machine resume (runTask, shadow) ---------------------------------

function resumedTask(id, counters) {
  return {
    id,
    kind: 'synthetic',
    title: 'Resumed after a machine re-enqueue',
    shadow: { gate: [1], llm: { DIAGNOSE: OOS_1033 } },
    resume: {
      startState: 'CHECK',
      prNumber: 1082,
      worktreePath: '/tmp/spo-oos-resume-worktree',
      commentId: 305,
      fromReason: 'merge-conflict',
      counters,
    },
  };
}

test('outOfScopeRecheckUsed carried in a resume descriptor survives the wake-up: a spent re-check parks on the FIRST out-of-scope answer', async () => {
  const counters = { diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0, outOfScopeRecheckUsed: 1, seenRootCauses: [] };
  const taskDir = mkTmp('spo-oos-resume-spent-');
  const final = await runTask('oos-resume-spent', resumedTask('oos-resume-spent', counters), taskDir, { shadowMode: true, dryRun: false });

  assert.equal(final, 'PARKED');
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.reason, 'diagnose-out-of-scope');
  assert.equal(state.diagnoseAttempts, 1, 'parked on the first DIAGNOSE of this run');
  const events = fs.readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(!events.some((e) => e.event === 'diagnose-out-of-scope-recheck'));
  assert.equal(events.find((e) => e.event === 'parked').detail.why, 'recheck-spent');
});

test('control: the same resume with outOfScopeRecheckUsed 0 re-checks once before parking', async () => {
  const counters = { diagnoseAttempts: 0, validateRejects: 0, ciImplementRetries: 0, outOfScopeRecheckUsed: 0, seenRootCauses: [] };
  const taskDir = mkTmp('spo-oos-resume-fresh-');
  const final = await runTask('oos-resume-fresh', resumedTask('oos-resume-fresh', counters), taskDir, { shadowMode: true, dryRun: false });

  assert.equal(final, 'PARKED');
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.reason, 'diagnose-out-of-scope');
  assert.equal(state.diagnoseAttempts, 2);
  const events = fs.readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.event === 'diagnose-out-of-scope-recheck').length, 1);
});

// ---- real mode: the re-check names the HEAD sha, and DIAGNOSE commits nothing ----------------

const HEAD = '8b5f6409aaaabbbbccccddddeeeeffff00001111';

function realDiagnoseCtx({ id, reply, spawnSync, configOverrides = {} }) {
  const accountsDir = mkTmp('spo-oos-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  const worktreePath = mkTmp('spo-oos-wt-');
  const task = {
    id,
    kind: 'card',
    issue: 1033,
    worktreePath,
    llm: { DIAGNOSE: { model: 'sonnet', effort: 'low', promptText: 'diagnose it' } },
  };
  const ctx = buildCtx(id, task, mkTmp('spo-oos-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    real: true,
    stepDeadlineMs: 30000,
    diagnoseBudget: 3,
    ghRepo: 'Crazz-Org/SPO-WebClient',
    claudeAccountsDir: accountsDir,
    // deps.runLlm: callLlmStep's test seam -- hands the handler a parsed DIAGNOSE reply directly.
    deps: { spawnSync, ...fakeExecDeps(), runLlm: async () => reply },
    ...configOverrides,
  });
  ctx.task.worktreePath = worktreePath;
  // DIAGNOSE entered from GATE requires gate.log (prepareJudgeInputs) -- realGate writes it.
  fs.writeFileSync(gateLogPath(ctx.taskDir), 'REQ_SEARCH_MENU_TOWNS FAIL Request timeout\n');
  return ctx;
}

function recordingSpawn(calls) {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args.includes('rev-parse') && args.includes('HEAD')) return { status: 0, stdout: `${HEAD}\n`, stderr: '', signal: null };
    if (command === 'gh') return { status: 0, stdout: 'https://github.com/Crazz-Org/SPO-WebClient/issues/1033#issuecomment-1\n', stderr: '', signal: null };
    return { status: 0, stdout: '', stderr: '', signal: null };
  };
}

test('real mode: out-of-scope from GATE returns GATE, journals the HEAD sha it re-checks; the second parks with it; DIAGNOSE never commits or pushes', async () => {
  const calls = [];
  const ctx = realDiagnoseCtx({ id: 'card-oos-real', reply: OOS_1033, spawnSync: recordingSpawn(calls) });
  ctx.cameFrom = 'GATE';

  const next = await HANDLERS.DIAGNOSE(ctx);
  assert.equal(next, 'GATE');
  const journal = fs.readFileSync(path.join(ctx.taskDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const recheck = journal.find((e) => e.event === 'diagnose-out-of-scope-recheck');
  assert.deepEqual(
    { from: recheck.from, headSha: recheck.headSha, attempt: recheck.attempt, used: recheck.outOfScopeRecheckUsed },
    { from: 'GATE', headSha: HEAD, attempt: 1, used: 1 }
  );

  ctx.cameFrom = 'GATE'; // what runTask's loop sets after the re-gate fails again
  await assert.rejects(
    () => HANDLERS.DIAGNOSE(ctx),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'diagnose-out-of-scope' &&
      err.detail.why === 'recheck-spent' &&
      err.detail.headSha === HEAD &&
      err.detail.from === 'GATE'
  );

  const mutating = calls.filter((c) => c[0] === 'git' && (c.includes('commit') || c.includes('push') || c.includes('merge')));
  assert.deepEqual(mutating, [], 'DIAGNOSE must not move HEAD: the re-check is on the same sha');
});

test('real mode: an out-of-scope answer on the attempt that spends the DIAGNOSE budget parks (why diagnose-budget-spent) instead of re-gating into a budget-exhausted park', async () => {
  const ctx = realDiagnoseCtx({ id: 'card-oos-real-budget', reply: { ...OOS_1033, category: 'infra' }, spawnSync: recordingSpawn([]) });
  ctx.cameFrom = 'CI_CHECKS';
  ctx.counters.diagnoseAttempts = ctx.config.diagnoseBudget - 1;
  await assert.rejects(
    () => HANDLERS.DIAGNOSE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'diagnose-out-of-scope' && err.detail.why === 'diagnose-budget-spent' && err.detail.from === 'CI_CHECKS'
  );
  assert.equal(ctx.counters.outOfScopeRecheckUsed, 0, 'no re-check spent');
});
