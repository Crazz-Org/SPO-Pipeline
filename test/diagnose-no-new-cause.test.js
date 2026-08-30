'use strict';
// Action 1.5 -- honour DIAGNOSE's `root_cause: null` contract. prompts/diagnose.md declares two
// mutually-exclusive reply shapes, and step-contracts.js's outputContract deliberately treats a
// present-but-null root_cause as satisfying the contract: it is the documented "I have no cause
// that is not already on the ledger" answer, not "no answer at all". The old
// `(result && result.rootCause) || 'unspecified-cause-N'` conflated the two -- null is falsy, so
// the honest answer was silently replaced by an always-unique fabricated cause that could never
// trip the duplicate-root-cause guard, and the machine paid a full extra IMPLEMENT attempt for
// nothing (issues 213, 428, 452).

const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal, readLedger } = require('./helpers');

test('DIAGNOSE {ok:true, root_cause:null, reason:"..."} -> PARKED diagnose-no-new-cause, ledger has the attempt line, no unspecified-cause-N anywhere', () => {
  const queueDir = mkTmp('spo-queue-diag-nonewcause-');
  const journalDir = mkTmp('spo-journal-diag-nonewcause-');
  const id = 'diag-no-new-cause';

  writeTask(queueDir, '001.json', {
    id,
    title: 'DIAGNOSE has nothing new to say',
    kind: 'synthetic',
    shadow: {
      gate: [1],
      // Shadow-mode fixtures in this suite are already camelCase (see DIAGNOSE's own
      // snake_case->camelCase bridge in llm.js) -- rootCause: null is the fixture-side spelling
      // of the wire's root_cause: null.
      llm: { DIAGNOSE: { ok: true, rootCause: null, reason: 'same failure as the ledger already has' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-no-new-cause');

  // The wasted-attempt regression: this task's only path to DIAGNOSE is PLAN -> IMPLEMENT ->
  // CHECK -> PUSH_PR -> GATE (fails once) -> DIAGNOSE, so IMPLEMENT legitimately ran once already
  // -- what must NOT happen is DIAGNOSE sending it back to IMPLEMENT for a second, wasted attempt.
  const events = readJournal(journalDir, id);
  const implementEntries = events.filter((e) => e.event === 'transition' && e.to === 'IMPLEMENT');
  assert.equal(implementEntries.length, 1, 'IMPLEMENT must not be re-entered after diagnose-no-new-cause');

  const ledgerLines = readLedger(journalDir, id).trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1, 'the attempt still gets a ledger line');
  assert.equal(ledgerLines[0], 'attempt 1 | (no new cause) | parked (no new cause)');

  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked.detail.attempt, 1);
  assert.equal(parked.detail.reason, 'same failure as the ledger already has');

  const journalText = JSON.stringify(events);
  const ledgerText = readLedger(journalDir, id);
  assert.doesNotMatch(journalText, /unspecified-cause-/, 'no fabricated cause anywhere in the journal');
  assert.doesNotMatch(ledgerText, /unspecified-cause-/, 'no fabricated cause anywhere in the ledger');
});

test('DIAGNOSE {ok:true, root_cause:null} with no reason supplied still parks diagnose-no-new-cause, detail.reason is null', () => {
  const queueDir = mkTmp('spo-queue-diag-nonewcause-noreason-');
  const journalDir = mkTmp('spo-journal-diag-nonewcause-noreason-');
  const id = 'diag-no-new-cause-noreason';

  writeTask(queueDir, '001.json', {
    id,
    title: 'DIAGNOSE null root cause, no reason field',
    kind: 'synthetic',
    shadow: {
      gate: [1],
      llm: { DIAGNOSE: { ok: true, rootCause: null } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-no-new-cause');

  const events = readJournal(journalDir, id);
  const parked = events.find((e) => e.event === 'parked');
  assert.equal(parked.detail.reason, null);
});

// The "absent entirely" case: no rootCause/root_cause key at all is not one of diagnose.md's two
// documented shapes (present-with-a-string, or present-and-null). It is a different problem from
// the honest "no new cause" answer, so it must not park diagnose-no-new-cause -- it keeps the
// pre-existing fallback behaviour (a fabricated, unique placeholder cause), which in real mode is
// actually unreachable past action 1.4 (llm.js already turns a reply missing the required
// root_cause key into a transport-style {ok:false, kind:'error'}, caught before this line). This
// only still fires for a shadow-mode fixture that forgot to wire rootCause at all.
test('DIAGNOSE result missing the rootCause key entirely does NOT park diagnose-no-new-cause (distinct from an explicit null)', () => {
  const queueDir = mkTmp('spo-queue-diag-absent-');
  const journalDir = mkTmp('spo-journal-diag-absent-');
  const id = 'diag-rootcause-absent';

  writeTask(queueDir, '001.json', {
    id,
    title: 'DIAGNOSE reply has no rootCause key at all',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: {
        DIAGNOSE: { ok: true, category: 'unknown' }, // no rootCause/root_cause key
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  // Falls back to the pre-existing fabricated-cause retry path, not the new park.
  assert.equal(state.state, 'DONE');
  assert.equal(state.diagnoseAttempts, 1);

  const ledgerLines = readLedger(journalDir, id).trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1);
  assert.match(ledgerLines[0], /^attempt 1 \| unspecified-cause-1 \| retry$/);
});

// Regression guards: the duplicate-root-cause and budget-exhausted parks must keep working
// unchanged by this action -- both already covered end-to-end in test/gate-and-diagnose.test.js;
// this is a narrower guard specifically confirming they still fire when the model DOES supply a
// real (non-null) root cause, right alongside the new null-handling branch in the same handler.
test('regression: a real duplicate root cause (not null) still parks diagnose-duplicate-root-cause', () => {
  const queueDir = mkTmp('spo-queue-diag-realdup-');
  const journalDir = mkTmp('spo-journal-diag-realdup-');
  const id = 'diag-real-duplicate';

  writeTask(queueDir, '001.json', {
    id,
    title: 'Real duplicate root cause',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1],
      llm: { DIAGNOSE: { ok: true, rootCause: 'same-real-cause' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-duplicate-root-cause');
});

test('regression: budget exhaustion with real distinct root causes still parks diagnose-budget-exhausted', () => {
  const queueDir = mkTmp('spo-queue-diag-realbudget-');
  const journalDir = mkTmp('spo-journal-diag-realbudget-');
  const id = 'diag-real-budget';

  writeTask(queueDir, '001.json', {
    id,
    title: 'Real distinct root causes exhaust the budget',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1, 1],
      llm: {
        DIAGNOSE: [{ ok: true, rootCause: 'cause-x' }, { ok: true, rootCause: 'cause-y' }, { ok: true, rootCause: 'cause-z' }],
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, id);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-budget-exhausted');
  assert.equal(state.diagnoseAttempts, 3);
});
