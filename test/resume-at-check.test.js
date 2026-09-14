'use strict';
// resume-at-check.test.js -- card #212, action C1: `runTask` honours `task.resume`, entering the
// state machine at CHECK on an existing worktree/branch/PR instead of INTAKE's destructive
// restart. See orchestrator/state-machine.js's own header on `resumeValidationError`/`runTask`
// for the full contract this pins; `task.resume` itself is written by a LATER action's
// unpark-scan (C4) -- for now, only these tests construct it by hand.
//
// Every case here drives `runTask` directly (the actual queue-entry entry point), in SHADOW mode
// unless a test is specifically about the real-mode `--real` guard, following
// test/replay-holes.test.js's own convention for the fastest, most direct way to exercise this
// without a real git/gh/npm/claude call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js's own header for the incident this backstops. Must
// land before the orchestrator require below, same convention every real-mode test file in this
// suite follows (this file has one real-mode case, the `real-flag-required` resume test).
require('./no-real-spawn');
const { runTask } = require('../orchestrator/state-machine');
const { mkTmp } = require('./helpers');

function readJournal(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readState(taskDir) {
  return JSON.parse(fs.readFileSync(path.join(taskDir, 'state.json'), 'utf8'));
}

// Wraps fs.writeFileSync for the duration of one runTask call, capturing every JSON payload
// written to <taskDir>/.state.json.<pid>.<ts>.tmp -- the atomic writer's own temp file
// (journal.js's writeState) -- IN ORDER. The first entry is the first state.json snapshot this
// run ever produced, even though state.json itself, by the time runTask returns, holds only the
// LAST one (a park overwrites the CHECK-entry snapshot with a PARKED one). Restored in `finally`
// regardless of outcome, so a throwing run never leaves fs.writeFileSync patched for later tests.
async function captureStateWrites(taskDir, fn) {
  const writes = [];
  const orig = fs.writeFileSync;
  const prefix = path.join(taskDir, '.state.json.');
  fs.writeFileSync = function patched(filePath, data, ...rest) {
    if (typeof filePath === 'string' && filePath.startsWith(prefix)) {
      try {
        writes.push(JSON.parse(data));
      } catch {
        // not JSON -- not a state.json write this helper cares about; fall through and still
        // perform the real write below.
      }
    }
    return orig.call(fs, filePath, data, ...rest);
  };
  try {
    const finalState = await fn();
    return { finalState, writes };
  } finally {
    fs.writeFileSync = orig;
  }
}

function shadowConfig(overrides = {}) {
  return { shadowMode: true, dryRun: false, ...overrides };
}

function validResume(overrides = {}) {
  return {
    startState: 'CHECK',
    prNumber: 777,
    worktreePath: '/tmp/spo-resume-fixture-worktree',
    commentId: 4242,
    fromReason: 'merge-conflict',
    ...overrides,
  };
}

// ============================================================================================
// ---- valid resume: shadow mode enters at CHECK, skips INTAKE/WORKTREE/PLAN/IMPLEMENT --------
// ============================================================================================

test('runTask (shadow mode): a valid task.resume enters at CHECK -- journals resumed-at-check, no INTAKE/WORKTREE/PLAN/IMPLEMENT event, first transition is from CHECK', async () => {
  const taskDir = mkTmp('spo-resume-valid-');
  const task = { id: 'resume-1', kind: 'card', issue: 501, title: 'Resumed card', resume: validResume() };

  const finalState = await runTask('resume-1', task, taskDir, shadowConfig());
  assert.equal(finalState, 'PARKED'); // VALIDATE has no llm.VALIDATE fixture -- see file header

  const journal = readJournal(taskDir);
  assert.ok(journal.length > 0, 'expected a non-empty journal');

  const resumedEvents = journal.filter((e) => e.event === 'resumed-at-check');
  assert.equal(resumedEvents.length, 1, 'expected exactly one resumed-at-check event');
  const resumed = resumedEvents[0];
  assert.equal(resumed.state, 'CHECK');
  assert.equal(resumed.prNumber, 777);
  assert.equal(resumed.worktreePath, '/tmp/spo-resume-fixture-worktree');
  assert.equal(resumed.commentId, 4242);
  assert.equal(resumed.fromReason, 'merge-conflict');

  const earlyStates = new Set(['INTAKE', 'WORKTREE', 'PLAN', 'IMPLEMENT']);
  const earlyEvent = journal.find((e) => earlyStates.has(e.state));
  assert.equal(earlyEvent, undefined, `expected no INTAKE/WORKTREE/PLAN/IMPLEMENT event, found ${JSON.stringify(earlyEvent)}`);

  const firstTransition = journal.find((e) => e.event === 'transition');
  assert.ok(firstTransition, 'expected at least one transition event');
  assert.equal(firstTransition.state, 'CHECK');
});

test('runTask (shadow mode): a valid task.resume writes state.json with state CHECK, prNumber and worktreePath on its VERY FIRST write', async () => {
  const taskDir = mkTmp('spo-resume-firstwrite-');
  const task = { id: 'resume-2', kind: 'card', issue: 502, title: 'Resumed card', resume: validResume({ prNumber: 55 }) };

  const { writes } = await captureStateWrites(taskDir, () => runTask('resume-2', task, taskDir, shadowConfig()));

  assert.ok(writes.length > 0, 'expected at least one state.json write');
  const first = writes[0];
  assert.equal(first.state, 'CHECK');
  assert.equal(first.prNumber, 55);
  assert.equal(first.worktreePath, '/tmp/spo-resume-fixture-worktree');

  // The final on-disk state.json is a LATER write (this run parks past CHECK) -- confirming the
  // two differ is what proves the assertions above are about the FIRST write, not merely the
  // only one.
  const finalOnDisk = readState(taskDir);
  assert.notDeepEqual(finalOnDisk, first, 'expected state.json to have moved past the CHECK-entry snapshot');
});

test('runTask (shadow mode): a valid task.resume starts every counter at 0, even when the task carries stale counter-like fields', async () => {
  const taskDir = mkTmp('spo-resume-counters-');
  const task = {
    id: 'resume-3',
    kind: 'card',
    issue: 503,
    title: 'Resumed card',
    resume: validResume(),
    // Stale fields a queue entry or an old task.json could plausibly carry -- buildCtx never
    // reads counters off `task` regardless of resume, but the test pins that explicitly rather
    // than trusting it silently.
    diagnoseAttempts: 9,
    validateRejects: 4,
    ciImplementRetries: 6,
    mainMoveUsed: 2,
    transientRetries: 3,
  };

  const { writes } = await captureStateWrites(taskDir, () => runTask('resume-3', task, taskDir, shadowConfig()));

  const first = writes[0];
  assert.equal(first.diagnoseAttempts, 0);
  assert.equal(first.validateRejects, 0);
  assert.equal(first.ciImplementRetries, 0);
  assert.equal(first.mainMoveUsed, 0);
});

// ============================================================================================
// ---- invalid resume: parks resume-precondition-failed BEFORE any handler runs ---------------
// ============================================================================================

const INVALID_RESUME_CASES = [
  { label: 'startState INTAKE', resume: validResume({ startState: 'INTAKE' }), field: 'startState' },
  { label: 'startState GATE', resume: validResume({ startState: 'GATE' }), field: 'startState' },
  { label: 'missing prNumber', resume: (() => { const r = validResume(); delete r.prNumber; return r; })(), field: 'prNumber' },
  { label: 'prNumber 0', resume: validResume({ prNumber: 0 }), field: 'prNumber' },
  { label: "prNumber '12' (string)", resume: validResume({ prNumber: '12' }), field: 'prNumber' },
  { label: 'prNumber 1.5', resume: validResume({ prNumber: 1.5 }), field: 'prNumber' },
  { label: 'empty worktreePath', resume: validResume({ worktreePath: '' }), field: 'worktreePath' },
  { label: 'missing worktreePath', resume: (() => { const r = validResume(); delete r.worktreePath; return r; })(), field: 'worktreePath' },
  { label: 'worktreePath 42 (number)', resume: validResume({ worktreePath: 42 }), field: 'worktreePath' },
  { label: 'resume is a bare string, not an object', resume: 'CHECK', field: 'resume' },
];

for (const { label, resume, field } of INVALID_RESUME_CASES) {
  test(`runTask (shadow mode): invalid task.resume (${label}) parks resume-precondition-failed with step invalid-resume, field ${field}, and runs no handler`, async () => {
    const taskDir = mkTmp('spo-resume-invalid-');
    const task = { id: `resume-bad-${field}-${label}`, kind: 'card', issue: 509, title: 'Bad resume', resume };

    const finalState = await runTask(task.id, task, taskDir, shadowConfig());
    assert.equal(finalState, 'PARKED');

    const journal = readJournal(taskDir);
    const parked = journal.find((e) => e.event === 'parked');
    assert.ok(parked, 'expected a parked event');
    assert.equal(parked.reason, 'resume-precondition-failed');
    assert.equal(parked.detail.step, 'invalid-resume');
    assert.equal(parked.detail.field, field);

    assert.ok(!journal.some((e) => e.state === 'INTAKE'), 'INTAKE must never run for an invalid resume');
    assert.ok(!journal.some((e) => e.event === 'transition'), 'no handler (and so no transition) may run for an invalid resume');
    assert.ok(!journal.some((e) => e.event === 'resumed-at-check'), 'an invalid resume must never journal resumed-at-check');
  });
}

// ============================================================================================
// ---- real mode: the real-flag guard is replicated on the resume path ------------------------
// ============================================================================================

test('runTask (real mode, no config.real): a valid resume on a kind:"card" task parks real-flag-required and runs no CHECK handler', async () => {
  const taskDir = mkTmp('spo-resume-realflag-');
  // Deliberately no productRepo/ghRepo/parkAlertCmd -- finalizePark's own board-move and
  // park-comment paths both no-op without a worktree/productRepo/issue to move or comment on
  // (board.js's moveCard, park-loop.js's postParkComment), so this reaches no real `gh`/`npm`
  // spawn at all; test/no-real-spawn.js is still required above as the backstop.
  const config = { shadowMode: false, dryRun: false, real: false };
  const task = { id: 'resume-realflag', kind: 'card', title: 'Resumed card, no --real', resume: validResume() };

  const finalState = await runTask('resume-realflag', task, taskDir, config);
  assert.equal(finalState, 'PARKED');

  const journal = readJournal(taskDir);
  const parked = journal.find((e) => e.event === 'parked');
  assert.ok(parked, 'expected a parked event');
  assert.equal(parked.reason, 'real-flag-required');
  assert.deepEqual(parked.detail, { kind: 'card' });

  assert.ok(!journal.some((e) => e.event === 'transition'), 'no CHECK handler (and so no transition) may run without --real');
  assert.ok(!journal.some((e) => e.event === 'resumed-at-check'), 'the real-flag park must pre-empt resumed-at-check');
});

// ============================================================================================
// ---- a resume park never erases the PR/worktree a later abandon or continue needs ----------
// ============================================================================================

test('runTask (real mode, no config.real): the real-flag park keeps the resume\'s prNumber and worktreePath in state.json', async () => {
  const taskDir = mkTmp('spo-resume-realflag-state-');
  const config = { shadowMode: false, dryRun: false, real: false };
  const task = { id: 'resume-realflag-state', kind: 'card', title: 'Resumed card, no --real', resume: validResume() };

  assert.equal(await runTask(task.id, task, taskDir, config), 'PARKED');
  const state = readState(taskDir);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.prNumber, 777);
  assert.equal(state.worktreePath, '/tmp/spo-resume-fixture-worktree');
});

test('runTask (shadow mode): an invalid resume carries the PREVIOUS park\'s prNumber and worktreePath forward, never the descriptor\'s and never null', async () => {
  const taskDir = mkTmp('spo-resume-invalid-state-');
  fs.writeFileSync(
    path.join(taskDir, 'state.json'),
    JSON.stringify({ id: 'resume-bad-prior', state: 'PARKED', reason: 'merge-conflict', prNumber: 321, worktreePath: '/tmp/prior-worktree' }),
  );
  const task = {
    id: 'resume-bad-prior',
    kind: 'card',
    issue: 510,
    title: 'Bad resume over a real park',
    resume: validResume({ startState: 'GATE', prNumber: 999, worktreePath: '/tmp/descriptor-worktree' }),
  };

  assert.equal(await runTask(task.id, task, taskDir, shadowConfig()), 'PARKED');
  const state = readState(taskDir);
  assert.equal(state.reason, 'resume-precondition-failed');
  assert.equal(state.prNumber, 321);
  assert.equal(state.worktreePath, '/tmp/prior-worktree');
});

// ============================================================================================
// ---- absent / null resume: byte-identical to today --------------------------------------------
// ============================================================================================

test('runTask (shadow mode): a task with no resume field starts at INTAKE exactly as before -- no resumed-at-check anywhere', async () => {
  const taskDir = mkTmp('spo-resume-absent-');
  const task = { id: 'no-resume-1', kind: 'card', issue: 510, title: 'Ordinary card' };

  const { finalState, writes } = await captureStateWrites(taskDir, () => runTask('no-resume-1', task, taskDir, shadowConfig()));
  assert.equal(finalState, 'PARKED'); // same VALIDATE-fixture-free park as the resume run above

  assert.equal(writes[0].state, 'INTAKE');

  const journal = readJournal(taskDir);
  assert.equal(journal[0].state, 'INTAKE');
  assert.equal(journal[0].event, 'ok');
  assert.ok(!journal.some((e) => e.event === 'resumed-at-check'));

  const firstTransition = journal.find((e) => e.event === 'transition');
  assert.equal(firstTransition.state, 'INTAKE');
});

test('runTask (shadow mode): task.resume === null behaves exactly like an absent resume', async () => {
  const taskDir = mkTmp('spo-resume-null-');
  const task = { id: 'no-resume-2', kind: 'card', issue: 511, title: 'Ordinary card', resume: null };

  const { writes } = await captureStateWrites(taskDir, () => runTask('no-resume-2', task, taskDir, shadowConfig()));
  assert.equal(writes[0].state, 'INTAKE');

  const journal = readJournal(taskDir);
  assert.equal(journal[0].state, 'INTAKE');
  assert.equal(journal[0].event, 'ok');
  assert.ok(!journal.some((e) => e.event === 'resumed-at-check'));
});
