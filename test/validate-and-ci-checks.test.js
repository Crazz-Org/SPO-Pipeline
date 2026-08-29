'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal, readLedger } = require('./helpers');

test('VALIDATE REJECT x3 -> PARKED on its own budget (separate from DIAGNOSE)', () => {
  const queueDir = mkTmp('spo-queue-validate-');
  const journalDir = mkTmp('spo-journal-validate-');

  writeTask(queueDir, '001.json', {
    id: 'validate-reject-budget',
    title: 'Validator rejects three times',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0, 0],
      llm: {
        VALIDATE: [{ verdict: 'REJECT' }, { verdict: 'REJECT' }, { verdict: 'REJECT' }],
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'validate-reject-budget');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'validate-reject-budget-exhausted');
  assert.equal(state.validateRejects, 3);
  assert.equal(state.diagnoseAttempts, 0); // REJECT retries straight to IMPLEMENT, no DIAGNOSE
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
