'use strict';
// Tests for orchestrator/park-alert.js (the SPO_PARK_ALERT_CMD push half of a park) and
// finalizePark's daemon-level `parked` event. The alert spawn is exercised through the
// injected deps.spawnSync only -- same convention as board-move.test.js; no real process is
// ever spawned. The daemon-event half is exercised through a real shadow-mode park (the
// deadline fixture), where the alert must NOT fire (real mode only) but the daemon.jsonl
// line must.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { execFileSync } = require('child_process');

const { alertPark } = require('../orchestrator/park-alert');
const { DAEMON, mkTmp, writeTask, readState } = require('./helpers');

function fakeCtx(taskDir, parkAlertCmd) {
  return { id: 'task-1', taskDir, config: { parkAlertCmd } };
}

function readTaskJournal(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('alertPark: spawns <cmd> <taskId> <reason> <lastState> and journals park-alert', () => {
  const taskDir = mkTmp('spo-alert-');
  const calls = [];
  const deps = {
    spawnSync: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0 };
    },
  };

  alertPark(fakeCtx(taskDir, '/usr/local/bin/spo-alert'), deps, { reason: 'plan-invalid', lastState: 'PLAN' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/usr/local/bin/spo-alert');
  assert.deepEqual(calls[0].args, ['task-1', 'plan-invalid', 'PLAN']);
  assert.ok(calls[0].opts.timeout > 0); // a hung alert must not hang the daemon

  const events = readTaskJournal(taskDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'park-alert');
  assert.equal(events[0].reason, 'plan-invalid');
});

test('alertPark: non-zero exit journals park-alert-failed and never throws', () => {
  const taskDir = mkTmp('spo-alert-');
  const deps = { spawnSync: () => ({ status: 7 }) };

  alertPark(fakeCtx(taskDir, '/x/alert'), deps, { reason: 'r', lastState: 'GATE' });

  const events = readTaskJournal(taskDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'park-alert-failed');
  assert.equal(events[0].exit, 7);
});

test('alertPark: a spawn error (missing binary) is park-alert-failed exit -1, not a crash', () => {
  const taskDir = mkTmp('spo-alert-');
  const deps = { spawnSync: () => ({ error: new Error('ENOENT'), status: null }) };

  alertPark(fakeCtx(taskDir, '/does/not/exist'), deps, { reason: 'r', lastState: 'GATE' });

  const events = readTaskJournal(taskDir);
  assert.equal(events[0].event, 'park-alert-failed');
  assert.equal(events[0].exit, -1);
});

test('alertPark: no configured command is a silent no-op -- no spawn, no journal line', () => {
  const taskDir = mkTmp('spo-alert-');
  let spawned = 0;
  const deps = { spawnSync: () => (spawned++, { status: 0 }) };

  alertPark(fakeCtx(taskDir, null), deps, { reason: 'r', lastState: 'GATE' });

  assert.equal(spawned, 0);
  assert.equal(readTaskJournal(taskDir).length, 0);
});

test('finalizePark: a shadow-mode park lands one `parked` event in <journalRoot>/daemon.jsonl', () => {
  const queueDir = mkTmp('spo-alert-q-');
  const journalDir = mkTmp('spo-alert-j-');
  writeTask(queueDir, '001.json', {
    id: 'alert-park-demo',
    title: 'parks on deadline',
    kind: 'synthetic',
    shadow: { delays: { IMPLEMENT: 80 } },
  });

  // SPO_PARK_ALERT_CMD deliberately set to a missing binary: shadow mode must spawn NOTHING
  // (real mode only) -- if the gate were wrong, the spawn failure would journal
  // park-alert-failed, asserted absent below.
  execFileSync(
    process.execPath,
    [DAEMON, '--shadow', '--once', '--queue', queueDir, '--journal', journalDir, '--deadline-ms', '15'],
    { encoding: 'utf8', env: { ...process.env, SPO_PARK_ALERT_CMD: '/does/not/exist-alert' } }
  );

  assert.equal(readState(journalDir, 'alert-park-demo').state, 'PARKED');

  const daemonLog = fs
    .readFileSync(path.join(journalDir, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const parked = daemonLog.filter((e) => e.event === 'parked');
  assert.equal(parked.length, 1);
  assert.equal(parked[0].id, 'alert-park-demo');
  assert.equal(parked[0].reason, 'step-deadline-exceeded-twice');
  assert.equal(parked[0].lastState, 'IMPLEMENT');

  // And the shadow park fired no alert.
  const taskEvents = readTaskJournal(path.join(journalDir, 'alert-park-demo'));
  assert.equal(taskEvents.some((e) => String(e.event).startsWith('park-alert')), false);
});
