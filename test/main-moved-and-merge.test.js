'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal } = require('./helpers');

test('mainMoved true once -> re-CHECK+re-gate path taken exactly once, then DONE', () => {
  const queueDir = mkTmp('spo-queue-mmonce-');
  const journalDir = mkTmp('spo-journal-mmonce-');

  writeTask(queueDir, '001.json', {
    id: 'main-moved-once',
    title: 'main moved once',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0],
      mainMoved: [true, false],
      prWait: [0],
      llm: { VALIDATE: { verdict: 'PASS' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'main-moved-once');
  assert.equal(state.state, 'DONE');
  assert.equal(state.mainMoveUsed, 1); // action 6.5: a count now, not a boolean -- 1 spent of the default budget of 1

  const events = readJournal(journalDir, 'main-moved-once');
  const merges = events.filter((e) => e.state === 'CI_CHECKS' && e.event === 'main-moved-merge');
  assert.equal(merges.length, 1);
});

test('mainMoved true twice -> PARKED (second move refused)', () => {
  const queueDir = mkTmp('spo-queue-mmtwice-');
  const journalDir = mkTmp('spo-journal-mmtwice-');

  writeTask(queueDir, '001.json', {
    id: 'main-moved-twice',
    title: 'main moved twice',
    kind: 'synthetic',
    shadow: {
      gate: [0, 0],
      mainMoved: true, // scalar: stays true on every CI_CHECKS visit
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'main-moved-twice');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'main-moved-twice');
});

test('prWait [4,4] -> exactly one bounded re-wait, then PARKED', () => {
  const queueDir = mkTmp('spo-queue-prwait44-');
  const journalDir = mkTmp('spo-journal-prwait44-');

  writeTask(queueDir, '001.json', {
    id: 'pr-wait-4-4',
    title: 'merge queue never lands',
    kind: 'synthetic',
    shadow: {
      gate: [0],
      prWait: [4, 4],
      llm: { VALIDATE: { verdict: 'PASS' } },
    },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'pr-wait-4-4');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'merge-queue-not-landing');

  const events = readJournal(journalDir, 'pr-wait-4-4');
  const waits = events.filter((e) => e.state === 'MERGE' && e.event === 'pr-wait');
  assert.equal(waits.length, 2); // never a third
  assert.equal(waits[0].attempt, 1);
  assert.equal(waits[1].attempt, 2);
  assert.equal(waits[1].bounded, true);
});
