'use strict';
// Coverage for handleValidate's CITATION_VERIFIER branch (orchestrator/state-machine.js) --
// fail-closed judge: a verifier that cannot render a verdict parks the card, it never passes by
// default. Before this test file, zero tests exercised any of this. See
// doc/state-machine-spec.md's VALIDATE row for the park-reason list this covers.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal } = require('./helpers');

function citationEvents(journalDir, id) {
  return readJournal(journalDir, id).filter((e) => e.state === 'VALIDATE' && e.event === 'citation-verifier');
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
