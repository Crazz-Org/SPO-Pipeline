'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { mkTmp, writeTask, runDaemonOnce, readJournal, readState } = require('./helpers');

test('happy path: synthetic task reaches DONE with every lifecycle state in order', () => {
  const queueDir = mkTmp('spo-queue-happy-');
  const journalDir = mkTmp('spo-journal-happy-');

  writeTask(queueDir, '001-happy.json', {
    id: 'happy-001',
    title: 'Synthetic happy path',
    kind: 'synthetic',
    shadow: {
      gate: [0],
      prWait: [0],
      llm: { VALIDATE: { verdict: 'PASS' } },
    },
  });

  const out = runDaemonOnce(queueDir, journalDir);
  assert.match(out, /happy-001\s+DONE/);

  const state = readState(journalDir, 'happy-001');
  assert.equal(state.state, 'DONE');

  const events = readJournal(journalDir, 'happy-001');
  const order = [];
  for (const e of events) {
    if (order[order.length - 1] !== e.state) order.push(e.state);
  }
  assert.deepEqual(order, [
    'INTAKE',
    'WORKTREE',
    'PLAN',
    'IMPLEMENT',
    'CHECK',
    'PUSH_PR',
    'GATE',
    'CI_CHECKS',
    'VALIDATE',
    'MERGE',
    'FINISH',
    'DONE',
  ]);

  // the task file was taken out of queue/
  assert.deepEqual(
    fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')),
    []
  );
});
