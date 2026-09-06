'use strict';
// Coverage for handleValidate's CITATION_VERIFIER branch (orchestrator/state-machine.js) --
// fail-closed judge: a verifier that cannot render a verdict parks the card, it never passes by
// default. Before this test file, zero tests exercised any of this. See
// doc/state-machine-spec.md's VALIDATE row for the park-reason list this covers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal } = require('./helpers');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js. Every test below this point that builds a ctx
// directly (rather than spawning daemon.js as a subprocess, like the rest of this file) runs
// shadowMode: true, so no spawn is ever reached -- this is belt-and-suspenders, matching every
// other test file in the suite that requires the orchestrator directly.
require('./no-real-spawn');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { appendEvent } = require('../orchestrator/journal');
const { ParkSignal } = require('../orchestrator/park-signal');

function citationEvents(journalDir, id) {
  return readJournal(journalDir, id).filter((e) => e.state === 'VALIDATE' && e.event === 'citation-verifier');
}

// Reads journal.jsonl straight off a taskDir, for the direct-ctx tests below (they build ctx via
// buildCtx themselves rather than through runDaemonOnce's queue/journalDir/id convention).
function taskJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function validateShadowCtx(id, task, taskDir) {
  return buildCtx(id, task, taskDir, { shadowMode: true, dryRun: false, stepDeadlineMs: 30000 });
}

test('shadow mode + no CITATION_VERIFIER fixture (cv === null) -> proceeds to the change-validator, journals source: no-fixture', () => {
  const queueDir = mkTmp('spo-queue-cv-nofixture-');
  const journalDir = mkTmp('spo-journal-cv-nofixture-');

  writeTask(queueDir, '001.json', {
    id: 'cv-no-fixture',
    title: 'RDO task, no citation-verifier fixture wired',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // Seeded because handleValidate now runs the verifier only when there is something to
    // verify (2026-09-04 interim narrowing, state-machine.js): touchesRdoMembers is an intake
    // GUESS, citations come from the real diff, and card #489 proved the two can disagree.
    // Every test in this file is about how a cv REPLY is classified, not about the trigger --
    // so each one supplies citations to reach the classification it exists to pin. The trigger
    // itself is pinned separately, by the two guards at the bottom of this file.
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      gate: [0],
      prWait: [0],
      llm: { VALIDATE: { verdict: 'PASS' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-no-fixture');
  assert.equal(state.state, 'DONE');

  const cvEvents = citationEvents(journalDir, 'cv-no-fixture');
  assert.equal(cvEvents.length, 1);
  assert.equal(cvEvents[0].verdict, 'PASS');
  assert.equal(cvEvents[0].source, 'no-fixture');

  const events = readJournal(journalDir, 'cv-no-fixture');
  assert.ok(events.some((e) => e.state === 'VALIDATE' && e.event === 'change-validator'), 'change-validator ran');
});

test('CITATION_VERIFIER transport error ({ok: false, kind: "error"}) -> PARKED citation-verifier-failed', () => {
  const queueDir = mkTmp('spo-queue-cv-error-');
  const journalDir = mkTmp('spo-journal-cv-error-');

  writeTask(queueDir, '001.json', {
    id: 'cv-transport-error',
    title: 'RDO task, citation-verifier transport error',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // Seeded because handleValidate now runs the verifier only when there is something to
    // verify (2026-09-04 interim narrowing, state-machine.js): touchesRdoMembers is an intake
    // GUESS, citations come from the real diff, and card #489 proved the two can disagree.
    // Every test in this file is about how a cv REPLY is classified, not about the trigger --
    // so each one supplies citations to reach the classification it exists to pin. The trigger
    // itself is pinned separately, by the two guards at the bottom of this file.
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      llm: { CITATION_VERIFIER: { ok: false, kind: 'error' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-transport-error');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'citation-verifier-failed');

  const cvEvents = citationEvents(journalDir, 'cv-transport-error');
  assert.equal(cvEvents.length, 1);
  assert.equal(cvEvents[0].ok, false);
  assert.equal(cvEvents[0].kind, 'error');
  assert.equal(cvEvents[0].verdict, undefined);

  const events = readJournal(journalDir, 'cv-transport-error');
  assert.ok(!events.some((e) => e.state === 'VALIDATE' && e.event === 'change-validator'), 'change-validator never ran');
});

test('CITATION_VERIFIER timeout ({ok: false, timedOut: true}) -> PARKED citation-verifier-failed', () => {
  const queueDir = mkTmp('spo-queue-cv-timeout-');
  const journalDir = mkTmp('spo-journal-cv-timeout-');

  writeTask(queueDir, '001.json', {
    id: 'cv-timeout',
    title: 'RDO task, citation-verifier timeout',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // Seeded because handleValidate now runs the verifier only when there is something to
    // verify (2026-09-04 interim narrowing, state-machine.js): touchesRdoMembers is an intake
    // GUESS, citations come from the real diff, and card #489 proved the two can disagree.
    // Every test in this file is about how a cv REPLY is classified, not about the trigger --
    // so each one supplies citations to reach the classification it exists to pin. The trigger
    // itself is pinned separately, by the two guards at the bottom of this file.
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      llm: { CITATION_VERIFIER: { ok: false, timedOut: true } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-timeout');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'citation-verifier-failed');

  const cvEvents = citationEvents(journalDir, 'cv-timeout');
  assert.equal(cvEvents.length, 1);
  assert.equal(cvEvents[0].ok, false);
  assert.equal(cvEvents[0].timedOut, true);
  assert.equal(cvEvents[0].verdict, undefined);
});

test('CITATION_VERIFIER payload with no verdict key -> PARKED citation-verifier-failed', () => {
  const queueDir = mkTmp('spo-queue-cv-noverdict-');
  const journalDir = mkTmp('spo-journal-cv-noverdict-');

  writeTask(queueDir, '001.json', {
    id: 'cv-no-verdict-key',
    title: 'RDO task, citation-verifier payload missing verdict',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // Seeded because handleValidate now runs the verifier only when there is something to
    // verify (2026-09-04 interim narrowing, state-machine.js): touchesRdoMembers is an intake
    // GUESS, citations come from the real diff, and card #489 proved the two can disagree.
    // Every test in this file is about how a cv REPLY is classified, not about the trigger --
    // so each one supplies citations to reach the classification it exists to pin. The trigger
    // itself is pinned separately, by the two guards at the bottom of this file.
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      llm: { CITATION_VERIFIER: { ok: true, entries: [] } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-no-verdict-key');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'citation-verifier-failed');

  const cvEvents = citationEvents(journalDir, 'cv-no-verdict-key');
  assert.equal(cvEvents.length, 1);
  assert.equal(cvEvents[0].ok, true);
  assert.equal(cvEvents[0].verdict, undefined);
});

test('CITATION_VERIFIER {verdict: "REJECT"} -> PARKED citation-false', () => {
  const queueDir = mkTmp('spo-queue-cv-reject-');
  const journalDir = mkTmp('spo-journal-cv-reject-');

  writeTask(queueDir, '001.json', {
    id: 'cv-reject',
    title: 'RDO task, citation-verifier rejects',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // Seeded because handleValidate now runs the verifier only when there is something to
    // verify (2026-09-04 interim narrowing, state-machine.js): touchesRdoMembers is an intake
    // GUESS, citations come from the real diff, and card #489 proved the two can disagree.
    // Every test in this file is about how a cv REPLY is classified, not about the trigger --
    // so each one supplies citations to reach the classification it exists to pin. The trigger
    // itself is pinned separately, by the two guards at the bottom of this file.
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      llm: { CITATION_VERIFIER: { verdict: 'REJECT' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-reject');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'citation-false');

  const cvEvents = citationEvents(journalDir, 'cv-reject');
  assert.equal(cvEvents.length, 1);
  assert.equal(cvEvents[0].verdict, 'REJECT');

  const events = readJournal(journalDir, 'cv-reject');
  assert.ok(!events.some((e) => e.state === 'VALIDATE' && e.event === 'change-validator'), 'change-validator never ran');
});

test('CITATION_VERIFIER {verdict: "PASS"} -> proceeds to the change-validator', () => {
  const queueDir = mkTmp('spo-queue-cv-pass-');
  const journalDir = mkTmp('spo-journal-cv-pass-');

  writeTask(queueDir, '001.json', {
    id: 'cv-pass',
    title: 'RDO task, citation-verifier passes',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // Seeded because handleValidate now runs the verifier only when there is something to
    // verify (2026-09-04 interim narrowing, state-machine.js): touchesRdoMembers is an intake
    // GUESS, citations come from the real diff, and card #489 proved the two can disagree.
    // Every test in this file is about how a cv REPLY is classified, not about the trigger --
    // so each one supplies citations to reach the classification it exists to pin. The trigger
    // itself is pinned separately, by the two guards at the bottom of this file.
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      gate: [0],
      prWait: [0],
      llm: {
        CITATION_VERIFIER: { verdict: 'PASS' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-pass');
  assert.equal(state.state, 'DONE');

  const cvEvents = citationEvents(journalDir, 'cv-pass');
  assert.equal(cvEvents.length, 1);
  assert.equal(cvEvents[0].verdict, 'PASS');

  const events = readJournal(journalDir, 'cv-pass');
  assert.ok(events.some((e) => e.state === 'VALIDATE' && e.event === 'change-validator'), 'change-validator ran');
});

test('CITATION_VERIFIER {verdict: "DIVERGES"} -> proceeds to the change-validator (flagged for a human, not blocking)', () => {
  const queueDir = mkTmp('spo-queue-cv-diverges-');
  const journalDir = mkTmp('spo-journal-cv-diverges-');

  writeTask(queueDir, '001.json', {
    id: 'cv-diverges',
    title: 'RDO task, citation-verifier diverges',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // Seeded because handleValidate now runs the verifier only when there is something to
    // verify (2026-09-04 interim narrowing, state-machine.js): touchesRdoMembers is an intake
    // GUESS, citations come from the real diff, and card #489 proved the two can disagree.
    // Every test in this file is about how a cv REPLY is classified, not about the trigger --
    // so each one supplies citations to reach the classification it exists to pin. The trigger
    // itself is pinned separately, by the two guards at the bottom of this file.
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      gate: [0],
      prWait: [0],
      llm: {
        CITATION_VERIFIER: { verdict: 'DIVERGES' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-diverges');
  assert.equal(state.state, 'DONE');

  const cvEvents = citationEvents(journalDir, 'cv-diverges');
  assert.equal(cvEvents.length, 1);
  assert.equal(cvEvents[0].verdict, 'DIVERGES');

  const events = readJournal(journalDir, 'cv-diverges');
  assert.ok(events.some((e) => e.state === 'VALIDATE' && e.event === 'change-validator'), 'change-validator ran');
});

test('CITATION_VERIFIER {verdict: "SOMETHING_ELSE"} -> PARKED citation-verifier-unrecognized-verdict', () => {
  const queueDir = mkTmp('spo-queue-cv-unrecognized-');
  const journalDir = mkTmp('spo-journal-cv-unrecognized-');

  writeTask(queueDir, '001.json', {
    id: 'cv-unrecognized',
    title: 'RDO task, citation-verifier returns an unrecognized verdict',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // Seeded because handleValidate now runs the verifier only when there is something to
    // verify (2026-09-04 interim narrowing, state-machine.js): touchesRdoMembers is an intake
    // GUESS, citations come from the real diff, and card #489 proved the two can disagree.
    // Every test in this file is about how a cv REPLY is classified, not about the trigger --
    // so each one supplies citations to reach the classification it exists to pin. The trigger
    // itself is pinned separately, by the two guards at the bottom of this file.
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      llm: { CITATION_VERIFIER: { verdict: 'SOMETHING_ELSE' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-unrecognized');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'citation-verifier-unrecognized-verdict');

  const cvEvents = citationEvents(journalDir, 'cv-unrecognized');
  assert.equal(cvEvents.length, 1);
  assert.equal(cvEvents[0].verdict, 'SOMETHING_ELSE');

  const events = readJournal(journalDir, 'cv-unrecognized');
  assert.ok(!events.some((e) => e.state === 'VALIDATE' && e.event === 'change-validator'), 'change-validator never ran');
});

test('touchesRdoMembers: false -> CITATION_VERIFIER never called (regression guard)', () => {
  const queueDir = mkTmp('spo-queue-cv-notrdo-');
  const journalDir = mkTmp('spo-journal-cv-notrdo-');

  writeTask(queueDir, '001.json', {
    id: 'cv-not-rdo',
    title: 'Non-RDO task',
    kind: 'synthetic',
    touchesRdoMembers: false,
    shadow: {
      gate: [0],
      prWait: [0],
      // If handleValidate ever called CITATION_VERIFIER despite touchesRdoMembers being false,
      // this REJECT fixture would park the task -- so a DONE outcome is itself proof it wasn't
      // consulted, not just an absent journal line.
      llm: {
        CITATION_VERIFIER: { verdict: 'REJECT' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-not-rdo');
  assert.equal(state.state, 'DONE');

  const cvEvents = citationEvents(journalDir, 'cv-not-rdo');
  assert.equal(cvEvents.length, 0);

  const events = readJournal(journalDir, 'cv-not-rdo');
  assert.ok(events.some((e) => e.state === 'VALIDATE' && e.event === 'change-validator'), 'change-validator ran');
});

// The ordering guard the other failure fixtures cannot provide: {ok: false} carrying a
// well-formed verdict. Every other failure case here is already caught by the
// `typeof cv.verdict !== 'string'` clause alone, so without this test the `cv.ok === false`
// clause survives mutation -- a refactor could move the verdict tests ahead of the failure
// test and silently reintroduce the fail-open default this whole file exists to prevent.
test('CITATION_VERIFIER {ok: false} with a well-formed verdict -> PARKED citation-verifier-failed, transport failure wins over the verdict', () => {
  const queueDir = mkTmp('spo-queue-cv-okfalse-pass-');
  const journalDir = mkTmp('spo-journal-cv-okfalse-pass-');

  writeTask(queueDir, '001.json', {
    id: 'cv-ok-false-verdict-pass',
    title: 'RDO task, citation-verifier failed but replied PASS',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // Seeded because handleValidate now runs the verifier only when there is something to
    // verify (2026-09-04 interim narrowing, state-machine.js): touchesRdoMembers is an intake
    // GUESS, citations come from the real diff, and card #489 proved the two can disagree.
    // Every test in this file is about how a cv REPLY is classified, not about the trigger --
    // so each one supplies citations to reach the classification it exists to pin. The trigger
    // itself is pinned separately, by the two guards at the bottom of this file.
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      llm: { CITATION_VERIFIER: { ok: false, kind: 'error', verdict: 'PASS' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-ok-false-verdict-pass');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'citation-verifier-failed');

  const cvEvents = citationEvents(journalDir, 'cv-ok-false-verdict-pass');
  assert.equal(cvEvents.length, 1);
  assert.equal(cvEvents[0].ok, false);
  assert.equal(cvEvents[0].verdict, 'PASS');

  const events = readJournal(journalDir, 'cv-ok-false-verdict-pass');
  assert.ok(!events.some((e) => e.state === 'VALIDATE' && e.event === 'change-validator'), 'change-validator never ran');
});

// The other half of the trigger contract (2026-09-04 interim narrowing). Its sibling above pins
// "intake says not-RDO -> never consulted"; this pins "intake says RDO but the real diff produced
// no citations -> still never consulted, and the skip is journaled rather than silent".
//
// Measured origin: card #489 was implemented, passed every invariant, opened PR #659 and went
// CI-green, then parked `prompt-missing-placeholder:citations` -- its diff touched no catalogue
// file, so realPushPr wrote no `rdo-citation` event, while intake's text heuristic had already
// set touchesRdoMembers. Card #385 parked the same way. Same REJECT-fixture proof technique as
// the guard above: a DONE outcome is itself evidence the verifier never ran.
test('touchesRdoMembers: true but no citations -> CITATION_VERIFIER never called, skip journaled', () => {
  const queueDir = mkTmp('spo-queue-cv-nocitations-');
  const journalDir = mkTmp('spo-journal-cv-nocitations-');

  writeTask(queueDir, '001.json', {
    id: 'cv-no-citations',
    title: 'Intake guessed RDO, the diff disagreed',
    kind: 'synthetic',
    touchesRdoMembers: true,
    // No `citations` key at all -- exactly issue-489's shape.
    shadow: {
      gate: [0],
      prWait: [0],
      llm: {
        CITATION_VERIFIER: { verdict: 'REJECT' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'cv-no-citations');
  assert.equal(state.state, 'DONE', 'a REJECT fixture that never ran cannot park the task');

  const cvEvents = citationEvents(journalDir, 'cv-no-citations');
  assert.equal(cvEvents.length, 0, 'no citation-verifier verdict may be journaled');

  const events = readJournal(journalDir, 'cv-no-citations');
  const skipped = events.filter((e) => e.state === 'VALIDATE' && e.event === 'citation-verifier-skipped-no-citations');
  assert.equal(skipped.length, 1, 'the skip must be journaled exactly once -- it is a real signal, not a silent path');
  assert.equal(skipped[0].touchesRdoMembers, true);
  assert.ok(events.some((e) => e.state === 'VALIDATE' && e.event === 'change-validator'), 'change-validator still ran');
});

// ---- resolveRdoDiffTouched: the trigger now reads the diff-derived field, not intake's guess ---
//
// 2026-09-06: realPushPr (orchestrator/steps/scripted.js) now journals a genuinely symmetric
// ctx.task.rdoDiffTouched (both true and false) separate from touchesRdoMembers, which stays a
// one-way intake guess reserved for IMPLEMENT's Opus escalation. handleValidate's trigger is
// resolved from rdoDiffTouched first (in-memory, then journal-durable), falling back to
// touchesRdoMembers only when PUSH_PR hasn't run yet. These four tests build ctx directly via
// buildCtx (shadowMode: true, so nothing ever spawns) rather than through runDaemonOnce's
// queue/intake path -- the intake path cannot express "PUSH_PR already ran and set rdoDiffTouched"
// or "a restart happened, only the journal remembers it".

test('handleValidate: rdoDiffTouched:false with intake touchesRdoMembers:true -> CITATION_VERIFIER never called, distinct not-rdo-diff skip journaled', async () => {
  const taskDir = mkTmp('spo-validate-rdo-diff-false-');
  const task = {
    id: 'validate-rdo-diff-false',
    kind: 'synthetic',
    touchesRdoMembers: true,
    rdoDiffTouched: false,
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      llm: {
        // A REJECT fixture that never runs cannot park -- 'MERGE' below is itself proof the
        // verifier was never consulted, same technique the file's earlier guards use.
        CITATION_VERIFIER: { verdict: 'REJECT' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  };
  const ctx = validateShadowCtx('validate-rdo-diff-false', task, taskDir);

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE', 'a REJECT fixture that never ran cannot park handleValidate');

  const events = taskJournal(taskDir);
  assert.equal(events.filter((e) => e.event === 'citation-verifier').length, 0);
  const skipped = events.filter((e) => e.event === 'citation-verifier-skipped-not-rdo-diff');
  assert.equal(skipped.length, 1, 'the not-rdo-diff skip must be journaled exactly once, distinct from the no-citations skip');
  assert.equal(skipped[0].intakeGuess, true);
});

test('handleValidate restart durability: rdoDiffTouched absent from ctx.task, but a journaled rdo-diff-derived {touched:false} survives -> resolver uses the journal, CITATION_VERIFIER never called', async () => {
  const taskDir = mkTmp('spo-validate-rdo-diff-restart-');
  // Simulates a daemon restart between PUSH_PR and VALIDATE: the in-memory field is gone, but
  // PUSH_PR's own journal record survives on disk. This appendEvent call is the real journal
  // realPushPr would have written -- task-values.js's lastJournaledRdoDiffTouched is the real
  // reader exercised through handleValidate below, not a stub.
  appendEvent(taskDir, 'PUSH_PR', 'rdo-diff-derived', { touched: false, path: 'src/shared/rdo-members.ts' });

  const task = {
    id: 'validate-rdo-diff-restart',
    kind: 'synthetic',
    touchesRdoMembers: true, // intake's stale guess -- must NOT win over the journal
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      llm: {
        CITATION_VERIFIER: { verdict: 'REJECT' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  };
  const ctx = validateShadowCtx('validate-rdo-diff-restart', task, taskDir);
  assert.equal(ctx.task.rdoDiffTouched, undefined, 'the rebuilt task must not carry the in-memory field');

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'MERGE');

  const events = taskJournal(taskDir);
  assert.equal(events.filter((e) => e.event === 'citation-verifier').length, 0);
  assert.equal(events.filter((e) => e.event === 'citation-verifier-skipped-not-rdo-diff').length, 1);
});

test('handleValidate: no-PUSH_PR fallback -- neither rdoDiffTouched nor a journaled rdo-diff-derived event, touchesRdoMembers:true, citations available -> CITATION_VERIFIER IS called (today\'s behaviour preserved)', async () => {
  const taskDir = mkTmp('spo-validate-rdo-diff-nopushpr-');
  const task = {
    id: 'validate-rdo-diff-nopushpr',
    kind: 'synthetic',
    touchesRdoMembers: true,
    citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
    shadow: {
      llm: {
        CITATION_VERIFIER: { verdict: 'REJECT' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  };
  const ctx = validateShadowCtx('validate-rdo-diff-nopushpr', task, taskDir);

  await assert.rejects(
    () => HANDLERS.VALIDATE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'citation-false'
  );

  const events = taskJournal(taskDir);
  assert.equal(events.filter((e) => e.event === 'citation-verifier').length, 1, 'the REJECT reaching a park is itself proof CITATION_VERIFIER ran');
});

test('handleValidate: rdoDiffTouched as a non-boolean ("false" string or 0) is not coerced -- falls through to the journal fallback instead of being treated as false', async () => {
  for (const nonBooleanValue of ['false', 0]) {
    const taskDir = mkTmp('spo-validate-rdo-diff-strict-');
    // The journal disagrees with the in-memory non-boolean value: if the resolver ever coerced
    // rdoDiffTouched instead of requiring typeof === 'boolean', it would use this falsy value and
    // skip, hiding the real journal signal (touched: true) underneath -- the same `=== true`
    // strict-equality class of bug measured at step-contracts.js:326's shouldEscalate.
    appendEvent(taskDir, 'PUSH_PR', 'rdo-diff-derived', { touched: true, path: 'src/shared/rdo-members.ts' });

    const task = {
      id: 'validate-rdo-diff-strict',
      kind: 'synthetic',
      touchesRdoMembers: false,
      rdoDiffTouched: nonBooleanValue,
      citations: ['RDOOpenSession — DServer/DirectoryServer.pas:143 — accessor get'],
      shadow: {
        llm: {
          CITATION_VERIFIER: { verdict: 'PASS', entries: [] },
          VALIDATE: { verdict: 'PASS' },
        },
      },
    };
    const ctx = validateShadowCtx('validate-rdo-diff-strict', task, taskDir);

    const next = await HANDLERS.VALIDATE(ctx);
    assert.equal(
      next,
      'MERGE',
      `rdoDiffTouched=${JSON.stringify(nonBooleanValue)} must fall through to the journal fallback, not be coerced to falsy`
    );

    const events = taskJournal(taskDir);
    assert.equal(
      events.filter((e) => e.event === 'citation-verifier').length,
      1,
      `rdoDiffTouched=${JSON.stringify(nonBooleanValue)} must not short-circuit the boolean branch`
    );
  }
});
