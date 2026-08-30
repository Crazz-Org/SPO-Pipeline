'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal, readLedger } = require('./helpers');

test('VALIDATE REJECT x3 -> PARKED on its own budget (separate from DIAGNOSE), still journals reasons to the ledger every attempt (action 1.6)', () => {
  const queueDir = mkTmp('spo-queue-validate-');
  const journalDir = mkTmp('spo-journal-validate-');

  writeTask(queueDir, '001.json', {
    id: 'validate-reject-budget',
    title: 'Validator rejects three times',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0, 0],
      llm: {
        VALIDATE: [
          { verdict: 'REJECT', reasons: ['criterion not met: first pass'] },
          { verdict: 'REJECT', reasons: ['criterion not met: second pass'] },
          { verdict: 'REJECT', reasons: ['criterion not met: third pass'] },
        ],
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'validate-reject-budget');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'validate-reject-budget-exhausted');
  assert.equal(state.validateRejects, 3);
  assert.equal(state.diagnoseAttempts, 0); // REJECT retries straight to IMPLEMENT, no DIAGNOSE

  // action 1.6: the reject budget/park behaviour above is unchanged; this is the new part --
  // one ledger line per REJECT, distinct `validate-reject` kind (never confused with a DIAGNOSE
  // "attempt" line), and the last one shows the park outcome.
  const ledgerLines = readLedger(journalDir, 'validate-reject-budget').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 3);
  assert.equal(ledgerLines[0], 'validate-reject 1 | criterion not met: first pass | retry (validate reject)');
  assert.equal(ledgerLines[1], 'validate-reject 2 | criterion not met: second pass | retry (validate reject)');
  assert.equal(
    ledgerLines[2],
    'validate-reject 3 | criterion not met: third pass | parked (validate-reject-budget-exhausted)'
  );
});

test('VALIDATE REJECT then PASS: exactly one validate-reject ledger line, distinct from any DIAGNOSE line (action 1.6)', () => {
  const queueDir = mkTmp('spo-queue-validate-reject-once-');
  const journalDir = mkTmp('spo-journal-validate-reject-once-');

  writeTask(queueDir, '001.json', {
    id: 'validate-reject-once',
    title: 'Validator rejects once then passes',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0],
      prWait: [0],
      llm: {
        VALIDATE: [
          { verdict: 'REJECT', reasons: ['missing edge-case handling'], findings: [] },
          { verdict: 'PASS' },
        ],
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'validate-reject-once');
  assert.equal(state.state, 'DONE');
  assert.equal(state.validateRejects, 1);

  const ledgerLines = readLedger(journalDir, 'validate-reject-once').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1);
  assert.equal(ledgerLines[0], 'validate-reject 1 | missing edge-case handling | retry (validate reject)');

  const events = readJournal(journalDir, 'validate-reject-once');
  const rejectResult = events.find(
    (e) => e.state === 'VALIDATE' && e.event === 'result' && e.payload && e.payload.reasons
  );
  assert.ok(rejectResult, 'expected a VALIDATE result event carrying the reject payload');
  assert.deepEqual(rejectResult.payload.reasons, ['missing edge-case handling']);
});

test('CI_CHECKS "Coverage of changed lines" -> back to IMPLEMENT, then succeeds', () => {
  const queueDir = mkTmp('spo-queue-cicov-');
  const journalDir = mkTmp('spo-journal-cicov-');

  writeTask(queueDir, '001.json', {
    id: 'ci-coverage',
    title: 'CI coverage check fails once',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0],
      ciChecks: ['Coverage of changed lines', null],
      prWait: [0],
      llm: { VALIDATE: { verdict: 'PASS' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'ci-coverage');
  assert.equal(state.state, 'DONE');
  const events = readJournal(journalDir, 'ci-coverage');
  assert.ok(events.some((e) => e.state === 'CI_CHECKS' && e.event === 'check-failed' && e.check === 'Coverage of changed lines'));
});

test('CI_CHECKS "PR rules" -> PARKED', () => {
  const queueDir = mkTmp('spo-queue-ciprrules-');
  const journalDir = mkTmp('spo-journal-ciprrules-');

  writeTask(queueDir, '001.json', {
    id: 'ci-pr-rules',
    title: 'CI PR rules check fails',
    kind: 'synthetic',
    shadow: { gate: [0], ciChecks: ['PR rules'] },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'ci-pr-rules');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'pr-rules-needs-approval');
});

test('CI_CHECKS "Something-unknown" -> DIAGNOSE, then retried to DONE', () => {
  const queueDir = mkTmp('spo-queue-ciunknown-');
  const journalDir = mkTmp('spo-journal-ciunknown-');

  writeTask(queueDir, '001.json', {
    id: 'ci-unknown-check',
    title: 'CI unrecognized check fails',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0],
      ciChecks: ['Something-unknown', null],
      prWait: [0],
      llm: {
        DIAGNOSE: { rootCause: 'unknown-ci-check' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'ci-unknown-check');
  assert.equal(state.state, 'DONE');
  const ledgerLines = readLedger(journalDir, 'ci-unknown-check').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1);
});
