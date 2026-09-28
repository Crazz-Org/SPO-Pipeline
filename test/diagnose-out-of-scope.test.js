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
  sanitizeRecheckPending,
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

test('sanitizeRecheckPending: only a record from GATE/CI_CHECKS survives, and only a hex sha is kept as headSha', () => {
  const ok = { from: 'GATE', headSha: '8b5f6409', rootCause: 'out-of-scope: x', category: null, suggestedFix: null };
  assert.deepEqual(sanitizeRecheckPending(ok), ok);
  assert.equal(sanitizeRecheckPending({ ...ok, from: 'CHECK' }), null, 'CHECK is never a re-check origin');
  assert.equal(sanitizeRecheckPending({ ...ok, from: undefined }), null);
  assert.equal(sanitizeRecheckPending({ ...ok, headSha: 'HEAD' }).headSha, null, "a failed rev-parse prints the ref name; it is not a sha");
  assert.equal(sanitizeRecheckPending({ ...ok, headSha: 42 }).headSha, null);
  for (const v of [null, undefined, 'GATE', 7, [ok], true]) assert.equal(sanitizeRecheckPending(v), null, JSON.stringify(v));
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

// Verifier F1: after a failed re-check the judge usually has nothing new -- the cause is on the
// ledger, and diagnose.md step 4 asks for null then. #1033's real third answer was
// `{"root_cause": "null", "category": "infra"}`. Every one of these shapes must park the resumable
// `diagnose-out-of-scope` (why `recheck-failed`), carrying the EARLIER diagnosis -- never the
// plan-invalidating `diagnose-no-new-cause` / `diagnose-duplicate-root-cause`.
const AFTER_RECHECK = [
  ['the same out-of-scope answer, word for word', OOS_1033, OOS_1033.rootCause],
  ['root_cause "null" + category infra (the real #1033 attempt-3 shape)', { ok: true, rootCause: 'null', reason: 'Same cause as attempt 1', category: 'infra' }, '(no new cause)'],
  ['a bare null + reason (the prompt-documented shape)', { ok: true, rootCause: null, reason: 'same timeout as attempt 1' }, '(no new cause)'],
  ['a reworded out-of-scope answer', { ok: true, rootCause: 'out-of-scope: the planitia DA service is still down', category: 'out-of-scope' }, 'out-of-scope: the planitia DA service is still down'],
];
for (const [label, second, ledgerCause] of AFTER_RECHECK) {
  test(`re-gate fails, then DIAGNOSE answers ${label} -> PARKED diagnose-out-of-scope (recheck-failed), carrying the first diagnosis`, () => {
    const queueDir = mkTmp('spo-queue-oos-twice-');
    const journalDir = mkTmp('spo-journal-oos-twice-');
    const id = 'oos-gate-twice';
    writeTask(queueDir, '001.json', {
      id,
      title: 'Out-of-scope, re-gate fails',
      kind: 'synthetic',
      shadow: { gate: [1, 1], llm: { DIAGNOSE: [OOS_1033, second] } },
    });

    runDaemonOnce(queueDir, journalDir);

    const state = readState(journalDir, id);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, 'diagnose-out-of-scope');
    assert.equal(state.diagnoseAttempts, 2);
    assert.equal(state.outOfScopeRecheckUsed, 1);
    assert.equal(state.outOfScopeRecheckPending, null, 'read, then cleared');

    const events = readJournal(journalDir, id);
    const t = transitions(events);
    assert.equal(t.filter((x) => x.endsWith('->IMPLEMENT')).length, 1, 'no IMPLEMENT after either DIAGNOSE');
    assert.deepEqual(
      t.filter((x) => x.includes('DIAGNOSE')),
      ['GATE->DIAGNOSE', 'DIAGNOSE->GATE', 'GATE->DIAGNOSE'],
      'one re-check, then the park'
    );
    const parked = events.find((e) => e.event === 'parked');
    assert.equal(parked.detail.why, 'recheck-failed');
    assert.equal(parked.detail.from, 'GATE');
    assert.equal(parked.detail.rootCause, OOS_1033.rootCause, 'the park carries the diagnosis that sent it on the re-check');
    assert.ok(parked.detail.recheckAnswer, "and what this attempt said");

    const ledger = readLedger(journalDir, id).trim().split('\n').filter(Boolean);
    assert.deepEqual(ledger, [
      `attempt 1 | ${OOS_1033.rootCause} | recheck (out of scope)`,
      `attempt 2 | ${ledgerCause} | parked (out of scope, re-check failed)`,
    ]);
  });
}

// Verifier F1, the other side: the pending re-check is SETTLED once the origin state passes, so a
// later DIAGNOSE from another state (on what is by then another question) is judged on its own.
test('re-gate PASSES (pending settled), CI then fails and DIAGNOSE answers null -> diagnose-no-new-cause, as without #305', () => {
  const queueDir = mkTmp('spo-queue-oos-settled-null-');
  const journalDir = mkTmp('spo-journal-oos-settled-null-');
  const id = 'oos-settled-null';
  writeTask(queueDir, '001.json', {
    id,
    title: 'Re-gate passes, CI fails later',
    kind: 'synthetic',
    shadow: { gate: [1, 0], ciChecks: ['Something-unknown'], llm: { DIAGNOSE: [OOS_1033, { ok: true, rootCause: null, reason: 'nothing new' }] } },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.reason, 'diagnose-no-new-cause');
  const settled = readJournal(journalDir, id).filter((e) => e.event === 'diagnose-out-of-scope-recheck-settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].state, 'GATE');
  assert.equal(settled[0].to, 'CI_CHECKS');
});

test('re-gate PASSES, CI then fails out of scope -> diagnose-out-of-scope, why recheck-spent (the one re-check was already used)', () => {
  const queueDir = mkTmp('spo-queue-oos-spent-');
  const journalDir = mkTmp('spo-journal-oos-spent-');
  const id = 'oos-recheck-spent';
  writeTask(queueDir, '001.json', {
    id,
    title: 'Re-gate passes, CI fails out of scope',
    kind: 'synthetic',
    shadow: { gate: [1, 0], ciChecks: ['Something-unknown'], llm: { DIAGNOSE: [OOS_1033, { ok: true, rootCause: 'CodeQL runner cancelled', category: 'infra' }] } },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.reason, 'diagnose-out-of-scope');
  const parked = readJournal(journalDir, id).find((e) => e.event === 'parked');
  assert.equal(parked.detail.why, 'recheck-spent');
  assert.equal(parked.detail.from, 'CI_CHECKS');
});

// Verifier N4: the card asks for ONE re-check, and #1073's out-of-scope answer came on its LAST
// DIAGNOSE attempt. It still re-checks; the re-check failing lands on DIAGNOSE's budget entry guard,
// which parks the resumable diagnose-out-of-scope (recheck-failed) instead of budget-exhausted.
// runDaemonOnce returning at all is the termination proof: no fourth DIAGNOSE call is ever made.
const IN_SCOPE_A = { ok: true, rootCause: 'cause A in src/a.ts', category: 'logic' };
const IN_SCOPE_B = { ok: true, rootCause: 'cause B in src/b.ts', category: 'logic' };

test('budget edge: out-of-scope on the LAST attempt (from GATE) still re-gates; the re-gate fails -> entry guard parks diagnose-out-of-scope (recheck-failed), and it terminates', () => {
  const queueDir = mkTmp('spo-queue-oos-edge-');
  const journalDir = mkTmp('spo-journal-oos-edge-');
  const id = 'oos-budget-edge';
  writeTask(queueDir, '001.json', {
    id,
    title: 'Out-of-scope on the last DIAGNOSE attempt',
    kind: 'synthetic',
    shadow: { gate: [1, 1, 1, 1], llm: { DIAGNOSE: [IN_SCOPE_A, IN_SCOPE_B, OOS_1033, IN_SCOPE_A] } },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-out-of-scope');
  assert.equal(state.diagnoseAttempts, 3, 'no fourth DIAGNOSE attempt');
  const events = readJournal(journalDir, id);
  assert.equal(events.filter((e) => e.state === 'DIAGNOSE' && e.event === 'result').length, 3, 'three verdicts, the entry guard asks no judge');
  const recheck = events.filter((e) => e.event === 'diagnose-out-of-scope-recheck');
  assert.equal(recheck.length, 1);
  assert.equal(recheck[0].attempt, 3, 're-checked on the attempt that spent the budget');
  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked.detail.why, 'recheck-failed');
  assert.equal(parked.detail.recheckAnswer, null, 'the entry guard ran no attempt');
  assert.equal(parked.detail.rootCause, OOS_1033.rootCause);
});

test('budget edge, #1073 shape: out-of-scope on the LAST attempt from CI_CHECKS re-polls CI; checks come back green -> DONE', () => {
  const queueDir = mkTmp('spo-queue-oos-edge-ci-');
  const journalDir = mkTmp('spo-journal-oos-edge-ci-');
  const id = 'oos-budget-edge-ci';
  writeTask(queueDir, '001.json', {
    id,
    title: 'Out-of-scope CI on the last DIAGNOSE attempt',
    kind: 'synthetic',
    shadow: {
      gate: [0],
      ciChecks: ['Something-unknown', 'Something-unknown', 'Something-unknown', null],
      prWait: [0],
      llm: { DIAGNOSE: [IN_SCOPE_A, IN_SCOPE_B, { ok: true, rootCause: 'out-of-scope: orchestrator/steps/scripted.js -- a pipeline bug', category: null }], VALIDATE: { verdict: 'PASS' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'DONE');
  assert.equal(state.diagnoseAttempts, 3);
  const recheck = readJournal(journalDir, id).find((e) => e.event === 'diagnose-out-of-scope-recheck');
  assert.equal(recheck.from, 'CI_CHECKS');
  assert.equal(recheck.attempt, 3);
});

test('budget entry guard with no pending re-check still parks diagnose-budget-exhausted, as before', async () => {
  const ctx = buildCtx('oos-guard-plain', { id: 'oos-guard-plain', kind: 'synthetic' }, mkTmp('spo-oos-guard-'), { shadowMode: true, diagnoseBudget: 3 });
  ctx.counters.diagnoseAttempts = 3;
  ctx.cameFrom = 'GATE';
  await assert.rejects(() => HANDLERS.DIAGNOSE(ctx), (err) => err instanceof ParkSignal && err.reason === 'diagnose-budget-exhausted');
  // ... and with a pending re-check from ANOTHER state.
  const ctx2 = buildCtx('oos-guard-other', { id: 'oos-guard-other', kind: 'synthetic' }, mkTmp('spo-oos-guard2-'), { shadowMode: true, diagnoseBudget: 3 });
  ctx2.counters.diagnoseAttempts = 3;
  ctx2.counters.outOfScopeRecheckPending = { from: 'CI_CHECKS', headSha: null, rootCause: 'out-of-scope: x', category: null, suggestedFix: null };
  ctx2.cameFrom = 'GATE';
  await assert.rejects(() => HANDLERS.DIAGNOSE(ctx2), (err) => err instanceof ParkSignal && err.reason === 'diagnose-budget-exhausted');
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
  // The green re-poll settles the pending re-check, under CI_CHECKS itself.
  const settled = events.filter((e) => e.event === 'diagnose-out-of-scope-recheck-settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].state, 'CI_CHECKS');
  assert.equal(settled[0].to, 'VALIDATE');
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

test('a pending re-check carried in a resume descriptor survives the wake-up: the re-gate fails, DIAGNOSE answers null -> diagnose-out-of-scope (recheck-failed), not diagnose-no-new-cause', async () => {
  const counters = {
    diagnoseAttempts: 1,
    validateRejects: 0,
    ciImplementRetries: 0,
    outOfScopeRecheckUsed: 1,
    outOfScopeRecheckPending: { from: 'GATE', headSha: null, rootCause: OOS_1033.rootCause, category: null, suggestedFix: null },
    seenRootCauses: [OOS_1033.rootCause],
  };
  const task = resumedTask('oos-resume-pending', counters);
  task.shadow.llm.DIAGNOSE = { ok: true, rootCause: 'null', category: 'infra' };
  const taskDir = mkTmp('spo-oos-resume-pending-');
  const final = await runTask('oos-resume-pending', task, taskDir, { shadowMode: true, dryRun: false });

  assert.equal(final, 'PARKED');
  const state = JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
  assert.equal(state.reason, 'diagnose-out-of-scope');
  const events = fs.readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked.detail.why, 'recheck-failed');
  assert.equal(parked.detail.rootCause, OOS_1033.rootCause);
});

test('a pending re-check from CI_CHECKS is NOT settled by a passing GATE: resumed at CHECK, gate green, CI fails, DIAGNOSE null -> recheck-failed', async () => {
  const counters = {
    diagnoseAttempts: 1,
    validateRejects: 0,
    ciImplementRetries: 0,
    outOfScopeRecheckUsed: 1,
    outOfScopeRecheckPending: { from: 'CI_CHECKS', headSha: null, rootCause: 'out-of-scope: CodeQL runner cancelled', category: 'infra', suggestedFix: null },
    seenRootCauses: [],
  };
  const task = resumedTask('oos-resume-ci-pending', counters);
  task.shadow = { gate: [0], ciChecks: ['Something-unknown'], llm: { DIAGNOSE: { ok: true, rootCause: null, reason: 'the same cancellation' } } };
  const taskDir = mkTmp('spo-oos-resume-ci-pending-');
  const final = await runTask('oos-resume-ci-pending', task, taskDir, { shadowMode: true, dryRun: false });

  assert.equal(final, 'PARKED');
  const events = fs.readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked.reason, 'diagnose-out-of-scope');
  assert.equal(parked.detail.why, 'recheck-failed');
  assert.equal(parked.detail.from, 'CI_CHECKS');
  assert.ok(
    !events.some((e) => e.event === 'diagnose-out-of-scope-recheck-settled' && e.state === 'GATE'),
    'GATE passing must not settle a re-check CI_CHECKS owns'
  );
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
      err.detail.why === 'recheck-failed' &&
      err.detail.headSha === HEAD &&
      err.detail.from === 'GATE'
  );

  const mutating = calls.filter((c) => c[0] === 'git' && (c.includes('commit') || c.includes('push') || c.includes('merge')));
  assert.deepEqual(mutating, [], 'DIAGNOSE must not move HEAD: the re-check is on the same sha');
});

function shaSpawn(shaRef) {
  return (command, args) => {
    if (command === 'git' && args.includes('rev-parse') && args.includes('HEAD')) return { status: 0, stdout: `${shaRef.sha}\n`, stderr: '', signal: null };
    if (command === 'gh') return { status: 0, stdout: 'https://github.com/Crazz-Org/SPO-WebClient/issues/1033#issuecomment-1\n', stderr: '', signal: null };
    return { status: 0, stdout: '', stderr: '', signal: null };
  };
}
const OTHER = 'ffffeeeeddddccccbbbbaaaa0000111122223333';

test('real mode: a null after the re-check on ANOTHER head sha is judged on its own -> diagnose-no-new-cause', async () => {
  const shaRef = { sha: HEAD };
  let reply = OOS_1033;
  const ctx = realDiagnoseCtx({ id: 'card-oos-real-othersha', reply: null, spawnSync: shaSpawn(shaRef) });
  ctx.deps.runLlm = async () => reply;
  ctx.cameFrom = 'GATE';
  assert.equal(await HANDLERS.DIAGNOSE(ctx), 'GATE');
  assert.equal(ctx.counters.outOfScopeRecheckPending.headSha, HEAD);

  shaRef.sha = OTHER; // the head moved between the re-check and this DIAGNOSE
  reply = { ok: true, rootCause: 'null', category: 'infra', suggestedFix: null };
  ctx.cameFrom = 'GATE';
  await assert.rejects(() => HANDLERS.DIAGNOSE(ctx), (err) => err instanceof ParkSignal && err.reason === 'diagnose-no-new-cause');
});

test('real mode: an UNREADABLE head never counts as "the same head" -- a null after the re-check is judged on its own (diagnose-no-new-cause)', async () => {
  const unreadable = (command, args) => {
    if (command === 'git' && args.includes('rev-parse')) return { status: 128, stdout: 'HEAD\n', stderr: 'fatal', signal: null };
    if (command === 'gh') return { status: 0, stdout: 'https://github.com/Crazz-Org/SPO-WebClient/issues/1033#issuecomment-1\n', stderr: '', signal: null };
    return { status: 0, stdout: '', stderr: '', signal: null };
  };
  let reply = OOS_1033;
  const ctx = realDiagnoseCtx({ id: 'card-oos-real-nohead', reply: null, spawnSync: unreadable });
  ctx.deps.runLlm = async () => reply;
  ctx.cameFrom = 'GATE';
  assert.equal(await HANDLERS.DIAGNOSE(ctx), 'GATE');
  assert.equal(ctx.counters.outOfScopeRecheckPending.headSha, null);
  reply = { ok: true, rootCause: null, reason: 'same' };
  await assert.rejects(() => HANDLERS.DIAGNOSE(ctx), (err) => err instanceof ParkSignal && err.reason === 'diagnose-no-new-cause');
});

test('real mode, same head: a null after the re-check -> diagnose-out-of-scope (recheck-failed); a null with the pending re-check from the OTHER state -> diagnose-no-new-cause', async () => {
  const shaRef = { sha: HEAD };
  let reply = OOS_1033;
  const ctx = realDiagnoseCtx({ id: 'card-oos-real-null', reply: null, spawnSync: shaSpawn(shaRef) });
  ctx.deps.runLlm = async () => reply;
  ctx.cameFrom = 'GATE';
  assert.equal(await HANDLERS.DIAGNOSE(ctx), 'GATE');
  reply = { ok: true, rootCause: null, reason: 'same timeout' };
  await assert.rejects(
    () => HANDLERS.DIAGNOSE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'diagnose-out-of-scope' && err.detail.why === 'recheck-failed' && err.detail.headSha === HEAD && err.detail.recheckAnswer.reason === 'same timeout'
  );

  const ctx2 = realDiagnoseCtx({ id: 'card-oos-real-null-2', reply: { ok: true, rootCause: null, reason: 'x' }, spawnSync: shaSpawn({ sha: HEAD }) });
  ctx2.counters.outOfScopeRecheckPending = { from: 'CI_CHECKS', headSha: HEAD, rootCause: 'out-of-scope: x', category: null, suggestedFix: null };
  ctx2.cameFrom = 'GATE';
  await assert.rejects(() => HANDLERS.DIAGNOSE(ctx2), (err) => err instanceof ParkSignal && err.reason === 'diagnose-no-new-cause');
});

test('real mode, budget entry guard: pending re-check on the same head -> diagnose-out-of-scope (recheck-failed); on another head -> diagnose-budget-exhausted', async () => {
  const pending = { from: 'CI_CHECKS', headSha: HEAD, rootCause: 'out-of-scope: a pipeline bug', category: null, suggestedFix: null };
  const same = realDiagnoseCtx({ id: 'card-oos-guard-same', reply: null, spawnSync: shaSpawn({ sha: HEAD }) });
  same.counters.diagnoseAttempts = 3;
  same.counters.outOfScopeRecheckPending = { ...pending };
  same.cameFrom = 'CI_CHECKS';
  await assert.rejects(
    () => HANDLERS.DIAGNOSE(same),
    (err) => err instanceof ParkSignal && err.reason === 'diagnose-out-of-scope' && err.detail.why === 'recheck-failed' && err.detail.rootCause === pending.rootCause
  );

  const other = realDiagnoseCtx({ id: 'card-oos-guard-other', reply: null, spawnSync: shaSpawn({ sha: OTHER }) });
  other.counters.diagnoseAttempts = 3;
  other.counters.outOfScopeRecheckPending = { ...pending };
  other.cameFrom = 'CI_CHECKS';
  await assert.rejects(() => HANDLERS.DIAGNOSE(other), (err) => err instanceof ParkSignal && err.reason === 'diagnose-budget-exhausted');
});

test('real mode: a transport failure on the DIAGNOSE after a failed re-check parks llm-transport-failed:DIAGNOSE and KEEPS the pending re-check (no verdict judged it)', async () => {
  let reply = OOS_1033;
  const ctx = realDiagnoseCtx({ id: 'card-oos-real-transport', reply: null, spawnSync: shaSpawn({ sha: HEAD }) });
  ctx.deps.runLlm = async () => reply;
  ctx.cameFrom = 'GATE';
  assert.equal(await HANDLERS.DIAGNOSE(ctx), 'GATE');
  reply = { ok: false, kind: 'error', error: 'spawn E2BIG' };
  ctx.cameFrom = 'GATE'; // the re-gate failed
  await assert.rejects(() => HANDLERS.DIAGNOSE(ctx), (err) => err instanceof ParkSignal && err.reason === 'llm-transport-failed:DIAGNOSE');
  assert.ok(ctx.counters.outOfScopeRecheckPending, 'still pending');
  assert.equal(ctx.counters.outOfScopeRecheckPending.headSha, HEAD);
  assert.equal(ctx.counters.outOfScopeRecheckPending.from, 'GATE');
});

test('real mode, budget entry guard: a rev-parse that parks (killed by a signal) is caught -> diagnose-budget-exhausted, never the spawn park', async () => {
  const killedRevParse = (command, args) => {
    if (command === 'git' && args.includes('rev-parse')) return { status: null, stdout: '', stderr: '', signal: 'SIGKILL', error: null };
    return { status: 0, stdout: '', stderr: '', signal: null };
  };
  const ctx = realDiagnoseCtx({ id: 'card-oos-guard-killed', reply: null, spawnSync: killedRevParse });
  ctx.counters.diagnoseAttempts = 3;
  ctx.counters.outOfScopeRecheckPending = { from: 'GATE', headSha: HEAD, rootCause: 'out-of-scope: x', category: null, suggestedFix: null };
  ctx.cameFrom = 'GATE';
  await assert.rejects(() => HANDLERS.DIAGNOSE(ctx), (err) => err instanceof ParkSignal && err.reason === 'diagnose-budget-exhausted');
});
