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

test('spo resume <task-id> lists recorded LLM steps as claude --resume commands, never executes', () => {
  const journalDir = mkTmp('spo-journal-resume-');
  const fs = require('fs');
  const path = require('path');
  const taskDir = path.join(journalDir, 'resume-demo');
  fs.mkdirSync(taskDir, { recursive: true });
  const { appendEvent } = require('../orchestrator/journal');
  appendEvent(taskDir, 'PLAN', 'llm-call', {
    step: 'PLAN',
    model: 'fable',
    effort: 'medium',
    account: 'default',
    sessionId: 'sess-plan-1',
    costUsd: 0.0123,
    numTurns: 3,
    ok: true,
  });
  appendEvent(taskDir, 'IMPLEMENT', 'llm-call', {
    step: 'IMPLEMENT',
    model: 'sonnet',
    effort: 'medium',
    account: 'default',
    sessionId: 'sess-impl-1',
    costUsd: 0.5,
    numTurns: 12,
    ok: true,
  });

  const out = runSpo(['resume', 'resume-demo', '--journal', journalDir]);
  assert.match(out, /PLAN.*claude --resume sess-plan-1/);
  assert.match(out, /IMPLEMENT.*claude --resume sess-impl-1/);
});

test('spo resume <bare-session-id> just prints the command for an unknown task id', () => {
  const journalDir = mkTmp('spo-journal-resume-bare-');
  const out = runSpo(['resume', 'not-a-real-task-id', '--journal', journalDir]);
  assert.equal(out.trim(), 'claude --resume not-a-real-task-id');
});
