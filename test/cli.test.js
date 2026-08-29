'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { mkTmp, writeTask, runDaemonOnce, runSpo } = require('./helpers');

test('spo status and spo task exit 0 and render the produced journals', () => {
  const queueDir = mkTmp('spo-queue-cli-');
  const journalDir = mkTmp('spo-journal-cli-');

  writeTask(queueDir, '001.json', {
    id: 'cli-demo',
    title: 'CLI demo task',
    kind: 'synthetic',
    shadow: {
      gate: [0],
      prWait: [0],
      llm: { VALIDATE: { verdict: 'PASS' } },
    },
  });
  writeTask(queueDir, '002.json', {
    id: 'cli-parked',
    title: 'CLI parked task',
    kind: 'synthetic',
    shadow: { gate: [2] },
  });

  runDaemonOnce(queueDir, journalDir);

  // execFileSync throws on non-zero exit -- reaching these assertions IS the exit-0 proof.
  const statusOut = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(statusOut, /queue depth: 0/);
  assert.match(statusOut, /active: 0\s+parked: 1\s+done: 1/);
  assert.match(statusOut, /cli-demo\s+DONE/);
  assert.match(statusOut, /cli-parked\s+PARKED/);

  const taskOut = runSpo(['task', 'cli-demo', '--journal', journalDir]);
  assert.match(taskOut, /INTAKE/);
  assert.match(taskOut, /DONE/);

  const parkedOut = runSpo(['parked', '--journal', journalDir]);
  assert.match(parkedOut, /cli-parked\s+reason=gate-dirty-tree/);
});
