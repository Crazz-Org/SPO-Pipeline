'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, readState, readJournal } = require('./helpers');

test('step deadline expiry: retry once, then PARKED', () => {
  const queueDir = mkTmp('spo-queue-deadline-');
  const journalDir = mkTmp('spo-journal-deadline-');

  writeTask(queueDir, '001.json', {
    id: 'deadline-exceeded',
    title: 'IMPLEMENT is artificially slow',
    kind: 'synthetic',
    shadow: {
      delays: { IMPLEMENT: 80 }, // ms, always slower than the 15ms deadline below
    },
  });

  runDaemonOnce(queueDir, journalDir, ['--deadline-ms', '15']);

  const state = readState(journalDir, 'deadline-exceeded');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'step-deadline-exceeded-twice');

  const events = readJournal(journalDir, 'deadline-exceeded');
  const expired = events.filter((e) => e.state === 'IMPLEMENT' && e.event === 'deadline-exceeded');
  assert.equal(expired.length, 2); // spawn once, retry once, never a third live executor
  assert.equal(expired[0].attempt, 1);
  assert.equal(expired[1].attempt, 2);
});

test('unknown fixture-injected state -> PARKED via the catch-all', () => {
  const queueDir = mkTmp('spo-queue-badstate-');
  const journalDir = mkTmp('spo-journal-badstate-');

  writeTask(queueDir, '001.json', {
    id: 'bad-state',
    title: 'fixture injects a bogus state',
    kind: 'synthetic',
    shadow: { forceState: 'NONSENSE_STATE' },
  });

  runDaemonOnce(queueDir, journalDir);

  const state = readState(journalDir, 'bad-state');
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'unrecognized-state');
  assert.equal(state.lastState, 'NONSENSE_STATE');
});
