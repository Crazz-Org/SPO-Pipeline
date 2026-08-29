'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readLedger } = require('./helpers');

test('gate [1,0] with a DIAGNOSE fixture: one retry reaches DONE, ledger has exactly 1 attempt line', () => {
  const queueDir = mkTmp('spo-queue-retry-');
  const journalDir = mkTmp('spo-journal-retry-');

  writeTask(queueDir, '001.json', {
    id: 'retry-001',
    title: 'Retry once',
    kind: 'synthetic',
    shadow: {
      gate: [1, 0],
      prWait: [0],
      llm: {
        DIAGNOSE: { rootCause: 'flaky-timeout' },
        VALIDATE: { verdict: 'PASS' },
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'retry-001');
  assert.equal(state.state, 'DONE');
  assert.equal(state.diagnoseAttempts, 1);

  const ledgerLines = readLedger(journalDir, 'retry-001').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1);
  assert.equal(ledgerLines[0], 'attempt 1 | flaky-timeout | retry');
});

for (const [exit, expectedReasonPart] of [
  [2, 'dirty'],
  [3, 'worker-down'],
  [4, 'timeout'],
]) {
  test(`gate exit ${exit} -> PARKED (${expectedReasonPart})`, () => {
    const queueDir = mkTmp(`spo-queue-gate${exit}-`);
    const journalDir = mkTmp(`spo-journal-gate${exit}-`);
    const id = `gate-exit-${exit}`;

    writeTask(queueDir, '001.json', {
      id,
      title: `gate exit ${exit}`,
      kind: 'synthetic',
      shadow: { gate: [exit] },
    });

    runDaemonOnce(queueDir, journalDir);

    const state = readState(journalDir, id);
    assert.equal(state.state, 'PARKED');
    assert.match(state.reason, new RegExp(expectedReasonPart));
  });
}

test('three gate fails with distinct root causes -> PARKED at budget (3 ledger lines)', () => {
  const queueDir = mkTmp('spo-queue-budget3-');
  const journalDir = mkTmp('spo-journal-budget3-');

  writeTask(queueDir, '001.json', {
    id: 'budget-distinct',
    title: 'Budget exhausted, distinct causes',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1, 1],
      llm: {
        DIAGNOSE: [{ rootCause: 'cause-a' }, { rootCause: 'cause-b' }, { rootCause: 'cause-c' }],
      },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'budget-distinct');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-budget-exhausted');
  assert.equal(state.diagnoseAttempts, 3);

  const ledgerLines = readLedger(journalDir, 'budget-distinct').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 3);
});

test('two gate fails with the SAME root cause -> PARKED early (before budget)', () => {
  const queueDir = mkTmp('spo-queue-dupcause-');
  const journalDir = mkTmp('spo-journal-dupcause-');

  writeTask(queueDir, '001.json', {
    id: 'dup-cause',
    title: 'Duplicate root cause',
    kind: 'synthetic',
    shadow: {
      gate: [1, 1],
      llm: { DIAGNOSE: { rootCause: 'same-cause' } }, // scalar: repeats every call
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'dup-cause');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'diagnose-duplicate-root-cause');

  const ledgerLines = readLedger(journalDir, 'dup-cause').trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 2);
  assert.ok(ledgerLines.every((l) => l.includes('same-cause')));
});
