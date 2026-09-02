'use strict';
// Action 7.1 -- "replay holes closed": unit tests for a set of uncovered error legs and catch-alls
// in orchestrator/state-machine.js, measured by `--experimental-test-coverage` as the intersection
// of two runs over the whole suite (see doc/remediation-progress.md's chantier 7 row for how this
// list was produced). Every leg here is a recognized, named ParkSignal (or the finalizePark/runTask
// machinery around one) that the existing suite happens never to reach -- not a hypothetical bug,
// a real branch with zero coverage. Each test asserts the EXACT reason string and the EXACT detail
// payload, not just "it threw" or "it parked": a reason/detail regression is exactly the class of
// bug an uncovered leg lets through silently (see doc/remediation-progress.md's C6 retrospective on
// this same mistake).
//
// Every case here drives a HANDLERS.<STATE> function directly (state-machine.js's own exported
// dispatch table) against a hand-built ctx (buildCtx, also exported) in SHADOW mode -- the fastest,
// most direct way to reach a specific handler leg without standing up a real git/gh/npm/claude
// call. Real-mode counterparts of some of these same reason strings (push-pr-failed,
// gate-unrecognized-exit, finish-failed, pr-wait-unrecognized-exit, main-red-no-merge) are already
// covered elsewhere, in orchestrator/steps/scripted.js's own real-mode functions (test/real-steps
// .test.js, test/gate-main-moved.test.js, test/push-pr-nothing-staged.test.js) -- this file is
// specifically the SHADOW-mode leg of each, a genuinely different code path (state-machine.js's own
// handleX, not steps/scripted.js's realX) that happened to share a reason string with an already-
// tested sibling and so looked covered under a reason-only grep without actually being exercised.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { HANDLERS, buildCtx, finalizePark, runTask } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJournal(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// =============================================================================================
// ---- handleIntake: invalid-task-json (lines 181-182) ----------------------------------------
// =============================================================================================
//
// The shape takeNextTask actually produces for an unparsable queue file (test/transient-retry
// .test.js's own 'an unparsable queue file still produces __invalid' test proves THAT shape) --
// what nothing in the suite proves is what handleIntake does with it once runTask reaches INTAKE.

test('HANDLERS.INTAKE: ctx.task.__invalid -> ParkSignal invalid-task-json carrying the raw preview, before INTAKE ever journals its own "ok" event', async () => {
  const taskDir = mkTmp('spo-replay-invalidtask-');
  const rawPreview = 'this is not valid JSON {{{';
  const task = { __invalid: true, rawPreview };
  const ctx = buildCtx('bad-task-1', task, taskDir, { shadowMode: true, dryRun: false });

  await assert.rejects(
    () => HANDLERS.INTAKE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'invalid-task-json' && err.detail.rawPreview === rawPreview
  );
  assert.equal(
    fs.existsSync(path.join(taskDir, 'journal.jsonl')),
    false,
    'a __invalid task must park before INTAKE ever appends its own ok/force-state event'
  );
});

// =============================================================================================
// ---- handleWorktree: main-red-refuse-worktree (lines 227-228), worktree-failed (line 250) ---
// =============================================================================================

test('HANDLERS.WORKTREE (shadow mode): nightlyMainRed fixture -> ParkSignal main-red-refuse-worktree with an empty detail, checked before any worktree spawn is even attempted', async () => {
  const taskDir = mkTmp('spo-replay-mainredworktree-');
  // shadow.worktree: 0 is wired too (a "success" exit for runScripted's own fixture) precisely so
  // the assertion below (no WORKTREE 'result' event) proves the nightlyMainRed check short-
  // circuits BEFORE runScripted('worktree') is ever reached, not merely that the eventual outcome
  // happens to match what a success exit would also have produced.
  const task = { id: 'mainred-1', kind: 'synthetic', shadow: { nightlyMainRed: true, worktree: 0 } };
  const ctx = buildCtx('mainred-1', task, taskDir, { shadowMode: true, dryRun: false });

  await assert.rejects(
    () => HANDLERS.WORKTREE(ctx),
    (err) => {
      assert.ok(err instanceof ParkSignal);
      assert.equal(err.reason, 'main-red-refuse-worktree');
      assert.deepEqual(err.detail, {}, 'main-red-refuse-worktree carries no detail fields at all');
      return true;
    }
  );
  assert.ok(
    !readJournal(taskDir).some((e) => e.event === 'result' && e.state === 'WORKTREE'),
    'no WORKTREE result event -- the park happens before runScripted is ever reached'
  );
});

test('HANDLERS.WORKTREE (shadow mode): a nonzero worktree fixture exit -> ParkSignal worktree-failed{exit}, with the WORKTREE result event still journalled first', async () => {
  const taskDir = mkTmp('spo-replay-worktreefailed-');
  const task = { id: 'wtfail-1', kind: 'synthetic', shadow: { worktree: 17 } };
  const ctx = buildCtx('wtfail-1', task, taskDir, { shadowMode: true, dryRun: false });

  await assert.rejects(
    () => HANDLERS.WORKTREE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'worktree-failed' && err.detail.exit === 17
  );
  const result = readJournal(taskDir).find((e) => e.event === 'result' && e.state === 'WORKTREE');
  assert.ok(result, 'expected the WORKTREE "result" event to be journalled even though this attempt failed');
  assert.equal(result.exit, 17);
});

// =============================================================================================
// ---- handlePushPr: push-pr-failed, shadow mode (line 699) -----------------------------------
// =============================================================================================
//
// steps/scripted.js's realPushPr already has thorough push-pr-failed coverage (test/push-pr-
// nothing-staged.test.js) -- this is the OTHER caller of that exact reason string, the shadow-
// mode fixture path in this file, which nothing exercises.

test('HANDLERS.PUSH_PR (shadow mode): a nonzero pushPr fixture exit -> ParkSignal push-pr-failed{exit}', async () => {
  const taskDir = mkTmp('spo-replay-pushprfailed-');
  const task = { id: 'pushfail-1', kind: 'synthetic', shadow: { pushPr: 21 } };
  const ctx = buildCtx('pushfail-1', task, taskDir, { shadowMode: true, dryRun: false });

  await assert.rejects(
    () => HANDLERS.PUSH_PR(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'push-pr-failed' && err.detail.exit === 21
  );
});

// =============================================================================================
// ---- handleGate: gate-unrecognized-exit, shadow mode (line 715) -----------------------------
// =============================================================================================
//
// steps/scripted.js's realGate already has this exact reason covered (test/real-steps.test.js,
// exit 9 there); this is the shadow-mode fixture path, a different function, uncovered. Exit 55
// here so this cannot be confused with (or accidentally pass because of) that other file's fixture.

test('HANDLERS.GATE (shadow mode): an exit outside the recognized {0,1,2,3,4} set -> ParkSignal gate-unrecognized-exit{exit}', async () => {
  const taskDir = mkTmp('spo-replay-gateunrecognized-');
  const task = { id: 'gateunrec-1', kind: 'synthetic', shadow: { gate: 55 } };
  const ctx = buildCtx('gateunrec-1', task, taskDir, { shadowMode: true, dryRun: false });

  await assert.rejects(
    () => HANDLERS.GATE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'gate-unrecognized-exit' && err.detail.exit === 55
  );
});

// =============================================================================================
// ---- resolveShadowCiChecks: main-red-no-merge, shadow mode (lines 771-772) ------------------
// =============================================================================================
//
// realGate/realCiChecks' own main-red-no-merge is covered in test/gate-main-moved.test.js; this
// is CI_CHECKS' shadow-fixture sibling (green checks + a moved main + the nightly-red fixture),
// a separate function (resolveShadowCiChecks) that nothing else in the suite drives.

test('HANDLERS.CI_CHECKS (shadow mode): checks green + main moved + nightlyMainRed fixture -> ParkSignal main-red-no-merge, never spends the main-moved budget', async () => {
  const taskDir = mkTmp('spo-replay-mainrednomerge-');
  const task = {
    id: 'mainrednomerge-1',
    kind: 'synthetic',
    shadow: { mainMoved: true, nightlyMainRed: true },
  };
  const ctx = buildCtx('mainrednomerge-1', task, taskDir, {
    shadowMode: true,
    dryRun: false,
    mainMovedRegateBudget: 1,
  });

  await assert.rejects(
    () => HANDLERS.CI_CHECKS(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'main-red-no-merge'
  );
  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'checks-green'), 'checks-green must be journalled before the main-moved check ever runs');
  assert.equal(ctx.counters.mainMoveUsed, 0, 'the nightly-red park must trip BEFORE the merge budget is spent -- it is never incremented on this leg');
});

// =============================================================================================
// ---- handleDiagnose: the defensive budget-exhausted guard (lines 826-830) -------------------
// =============================================================================================
//
// This IS the leg diagnose-no-new-cause.test.js / gate-and-diagnose.test.js's own
// 'diagnose-budget-exhausted' assertions do NOT cover: those go through the LATER budget check
// (line ~940, `{attempt, rootCause}` detail shape, reached after a real DIAGNOSE attempt runs and
// journals a root cause) -- the handler's OWN comment calls THIS earlier guard "defensive...
// should be unreachable, since the budget check below always parks on the attempt that reaches
// it". Reached here exactly as the action's own instructions say to: constructing the counter
// state directly (ctx.counters.diagnoseAttempts already AT the budget) rather than looping a real
// task through DIAGNOSE config.diagnoseBudget times first -- the normal loop can never leave this
// counter sitting at-or-past budget on entry, so there is no other way in from test/ alone.

test('HANDLERS.DIAGNOSE: diagnoseAttempts already at config.diagnoseBudget on entry -> immediate ParkSignal diagnose-budget-exhausted{attempts}, no LLM call', async () => {
  const taskDir = mkTmp('spo-replay-diagbudgetdefensive-');
  const spawnSync = () => {
    throw new Error('this defensive leg must return before ever reaching callLlmStep or postDiagnoseSurfaceComment');
  };
  const task = { id: 'diagdefensive-1', kind: 'synthetic' };
  const ctx = buildCtx('diagdefensive-1', task, taskDir, {
    shadowMode: true,
    dryRun: false,
    diagnoseBudget: 5, // distinctive: not 0, not 1, and not config.js's own default of 3
    deps: { spawnSync },
  });
  // Constructed directly, per the leg's own "defensive/unreachable through the normal loop"
  // comment -- the ordinary DIAGNOSE flow always parks ON the attempt that first reaches budget,
  // so diagnoseAttempts can never legitimately already equal it when this handler is entered.
  ctx.counters.diagnoseAttempts = 5;

  await assert.rejects(
    () => HANDLERS.DIAGNOSE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'diagnose-budget-exhausted' && err.detail.attempts === 5
  );
  assert.equal(readJournal(taskDir).length, 0, 'no journal event of any kind -- this guard returns before any write');
});

// =============================================================================================
// ---- handleMerge: pr-wait-unrecognized-exit, shadow mode (line 1160) ------------------------
// =============================================================================================
//
// steps/scripted.js's realMerge has its own copy of this exact reason (see test/real-steps
// .test.js's action-7.1 addition, exit 9 there too -- deliberately the same number, to make clear
// these are the SAME observable behaviour reached through two different functions, not two
// different behaviours that happen to share a name).

test('HANDLERS.MERGE (shadow mode): a prWait fixture exit outside {0,1,4} -> ParkSignal pr-wait-unrecognized-exit{exit}, no bounded re-wait attempted', async () => {
  const taskDir = mkTmp('spo-replay-prwaitunrec-');
  const task = { id: 'prwaitunrec-1', kind: 'synthetic', shadow: { prWait: 9 } };
  const ctx = buildCtx('prwaitunrec-1', task, taskDir, { shadowMode: true, dryRun: false });

  await assert.rejects(
    () => HANDLERS.MERGE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'pr-wait-unrecognized-exit' && err.detail.exit === 9
  );
  const waits = readJournal(taskDir).filter((e) => e.event === 'pr-wait');
  assert.equal(waits.length, 1, 'exit 9 is not exit 4 -- the bounded re-wait is reserved for "still open", never a third state');
  assert.equal(waits[0].attempt, 1);
});

// =============================================================================================
// ---- handleFinish: finish-failed, shadow mode (line 1172) -----------------------------------
// =============================================================================================
//
// steps/scripted.js's realFinish has THREE finish-failed cases covered (board-move/issue-comment/
// worktree-remove, each carrying a `step` field -- test/real-steps.test.js), but that detail shape
// is `{step, exit}`; this shadow-mode sibling's detail is plain `{exit}`, a genuinely different
// payload for the same reason string, and nothing in the suite drives it.

test('HANDLERS.FINISH (shadow mode): a nonzero finish fixture exit -> ParkSignal finish-failed{exit}, plain detail shape (no step field)', async () => {
  const taskDir = mkTmp('spo-replay-finishfailed-');
  const task = { id: 'finishfail-1', kind: 'synthetic', shadow: { finish: 13 } };
  const ctx = buildCtx('finishfail-1', task, taskDir, { shadowMode: true, dryRun: false });

  await assert.rejects(
    () => HANDLERS.FINISH(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'finish-failed' && err.detail.exit === 13 && !('step' in err.detail)
  );
});

// =============================================================================================
// ---- finalizePark: park-repeat (lines 1432-1434) ---------------------------------------------
// =============================================================================================
//
// countRepeatedParks fingerprints on reason + JSON.stringify(detail) over the journal's own
// trailing 'parked' events (including the one finalizePark just appended for THIS call) -- so the
// first park of a given reason+detail is never a "repeat" (count 1), and only the SECOND
// consecutive identical one trips the >= 2 threshold. Driven directly through the exported
// finalizePark (state-machine.js exports it for orphan-scan.js's own reuse), twice on the same
// ctx/taskDir, rather than looping a real task through two genuine parks of the same shape.

test('finalizePark: a second consecutive park with the identical reason+detail appends park-repeat{reason, repeat:2}; the first does not', () => {
  const taskDir = mkTmp('spo-replay-parkrepeat-');
  const task = { id: 'parkrepeat-1', kind: 'synthetic' };
  const ctx = buildCtx('parkrepeat-1', task, taskDir, { shadowMode: true, dryRun: false });

  finalizePark(ctx, 'GATE', 'gate-worker-down', { exit: 3 });
  assert.equal(
    readJournal(taskDir).filter((e) => e.event === 'park-repeat').length,
    0,
    'a first-time park must never claim to be a repeat'
  );

  finalizePark(ctx, 'GATE', 'gate-worker-down', { exit: 3 });
  const repeats = readJournal(taskDir).filter((e) => e.event === 'park-repeat');
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].reason, 'gate-worker-down');
  assert.equal(repeats[0].repeat, 2);
});

// A DIFFERENT detail on the second park must NOT count as a repeat -- countRepeatedParks
// fingerprints on the full detail payload, not just the reason string. Guards against a mutation
// that dropped the detail half of the fingerprint comparison, which would make every park of a
// given REASON look like an escalating repeat regardless of what actually changed.
test('finalizePark: a second park with the SAME reason but a DIFFERENT detail is not counted as a repeat', () => {
  const taskDir = mkTmp('spo-replay-parkrepeat-diffdetail-');
  const task = { id: 'parkrepeat-2', kind: 'synthetic' };
  const ctx = buildCtx('parkrepeat-2', task, taskDir, { shadowMode: true, dryRun: false });

  finalizePark(ctx, 'GATE', 'gate-worker-down', { exit: 3 });
  finalizePark(ctx, 'GATE', 'gate-worker-down', { exit: 4 }); // same reason, different exit

  assert.equal(readJournal(taskDir).filter((e) => e.event === 'park-repeat').length, 0);
});

// =============================================================================================
// ---- runTask: the hop-limit runaway guard (lines 1496-1498) ---------------------------------
// =============================================================================================
//
// HOP_LIMIT is a hardcoded local literal (200) inside runTask -- not exported, not in config.js --
// so this pins the literal number directly rather than importing a constant that does not exist to
// import. A real handler bug that keeps returning valid-looking state names (here: an IMPLEMENT
// that always fails, routing to DIAGNOSE, which -- with no rootCause fixture wired -- always
// fabricates a fresh, never-duplicate "unspecified-cause-N" and routes straight back to IMPLEMENT)
// must still terminate instead of hanging the daemon forever. diagnoseBudget is set far above 200
// hops' worth of DIAGNOSE attempts (~100) so THIS guard trips first, not the ordinary budget one.
test('runTask: a handler cycle that never reaches DONE/PARKED on its own still terminates at the hop limit -- 201 hops, park reason state-machine-runaway', async () => {
  const taskDir = mkTmp('spo-replay-hoplimit-');
  const task = {
    id: 'hoplimit-1',
    kind: 'synthetic',
    // Always fails, every IMPLEMENT visit, unconditionally -- see this block's own header.
    shadow: { llm: { IMPLEMENT: { ok: false } } },
  };
  const config = { shadowMode: true, dryRun: false, diagnoseBudget: 1000 };

  const outcome = await runTask('hoplimit-1', task, taskDir, config);
  assert.equal(outcome, 'PARKED');

  const parked = readJournal(taskDir).find((e) => e.event === 'parked');
  assert.ok(parked);
  assert.equal(parked.reason, 'state-machine-runaway');
  // HOP_LIMIT (200, see this test's own header) is the LAST hop the loop lets a handler actually
  // run; the park is written on the NEXT loop iteration, where hops becomes 201 before any further
  // handler call -- 201, not 200, is what the park's own detail carries.
  assert.equal(parked.detail.hops, 201);

  // The task must have spent real DIAGNOSE attempts getting there (proving the loop actually ran
  // the IMPLEMENT<->DIAGNOSE cycle rather than parking immediately for an unrelated reason), and
  // must NOT have exhausted the (deliberately huge) diagnose budget -- this park is the hop limit,
  // not the ordinary budget guard.
  const diagnoseAttempts = readJournal(taskDir).filter((e) => e.state === 'DIAGNOSE' && e.event === 'result').length;
  assert.ok(diagnoseAttempts > 50, `expected well over 50 real DIAGNOSE attempts before the hop limit tripped, got ${diagnoseAttempts}`);
  assert.ok(diagnoseAttempts < 1000, 'the diagnose budget itself must never have been the thing that stopped this run');
});
