'use strict';
// Tests for scripts/park-alert.sh, the default SPO_PARK_ALERT_CMD.
//
// Its two obligations to the daemon (orchestrator/park-alert.js spawns it with a 10 s timeout
// and journals a non-zero exit as `park-alert-failed`) are: always exit 0, and stay fast. Both
// are asserted here, including on the paths where a channel is broken -- a dead ntfy endpoint
// must not cost the daemon its budget, and must not stop the log line from landing.
//
// No network: the ntfy channel is pointed at a local http server, or at a black-holed address.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const { REPO_ROOT, mkTmp } = require('./helpers');

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'park-alert.sh');

// Runs the notifier, resolving {out, ms}. Rejects if it exits non-zero -- which is itself the
// assertion: the daemon reads a non-zero exit as a failed alert.
//
// Deliberately ASYNC, not execFileSync: the ntfy test serves the endpoint from an http server
// in THIS process, and a synchronous child would block the event loop so that server could
// never accept or answer -- curl would hang to its own timeout and the test would fail on a
// bug in the test, not in the script.
function runAlert(env, args = ['issue-1', 'plan-invalid', 'PLAN']) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      [SCRIPT, ...args],
      { encoding: 'utf8', env: { ...process.env, SPO_PARK_TOAST: '0', ...env } },
      (err, stdout) => (err ? reject(err) : resolve({ out: stdout, ms: Date.now() - started }))
    );
  });
}

test('park-alert.sh: writes one log line and exits 0 with nothing else configured', async () => {
  const log = path.join(mkTmp('spo-notify-'), 'parks.log');
  await runAlert({ SPO_PARK_LOG: log, SPO_PARK_NTFY_URL: '' });

  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /PARKED {2}issue-1 {2}reason=plan-invalid {2}lastState=PLAN/);
});

test('park-alert.sh: appends, never truncates -- a soak accumulates its parks', async () => {
  const log = path.join(mkTmp('spo-notify-'), 'parks.log');
  await runAlert({ SPO_PARK_LOG: log, SPO_PARK_NTFY_URL: '' }, ['t1', 'r1', 'PLAN']);
  await runAlert({ SPO_PARK_LOG: log, SPO_PARK_NTFY_URL: '' }, ['t2', 'r2', 'GATE']);

  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /t1/);
  assert.match(lines[1], /t2/);
});

test('park-alert.sh: creates a missing log directory rather than losing the line', async () => {
  const log = path.join(mkTmp('spo-notify-'), 'nested', 'deeper', 'parks.log');
  await runAlert({ SPO_PARK_LOG: log, SPO_PARK_NTFY_URL: '' });
  assert.equal(fs.existsSync(log), true);
});

test('park-alert.sh: an unwritable log path still exits 0 (never fails the daemon)', async () => {
  await runAlert({ SPO_PARK_LOG: '/proc/definitely/not/writable/parks.log', SPO_PARK_NTFY_URL: '' });
});

test('park-alert.sh: POSTs a titled, actionable ntfy message', async () => {
  const log = path.join(mkTmp('spo-notify-'), 'parks.log');
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ title: req.headers.title, tags: req.headers.tags, body });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/spo`;

  try {
    await runAlert({ SPO_PARK_LOG: log, SPO_PARK_NTFY_URL: url }, ['issue-247', 'push-pr-failed', 'PUSH_PR']);
  } finally {
    await new Promise((r) => server.close(r));
  }

  assert.equal(received.length, 1);
  assert.equal(received[0].title, 'SPO pipeline parked: issue-247');
  assert.match(received[0].body, /push-pr-failed \(at PUSH_PR\)/);
  assert.match(received[0].body, /spo task issue-247/); // names the next command, not just the fact
});

test('park-alert.sh: a black-holed ntfy endpoint costs well under the daemon\'s 10 s and still logs', async () => {
  const log = path.join(mkTmp('spo-notify-'), 'parks.log');
  // Port 9 (discard) on a documentation address: connects nowhere, does not refuse quickly.
  const { ms } = await runAlert({ SPO_PARK_LOG: log, SPO_PARK_NTFY_URL: 'http://192.0.2.1:9/spo' });

  assert.ok(ms < 7000, `notifier took ${ms} ms, too close to the daemon's 10 s timeout`);
  assert.match(fs.readFileSync(log, 'utf8'), /PARKED/); // the ntfy failure did not eat the log
});

test('park-alert.sh: missing arguments degrade to "?" instead of erroring', async () => {
  const log = path.join(mkTmp('spo-notify-'), 'parks.log');
  await runAlert({ SPO_PARK_LOG: log, SPO_PARK_NTFY_URL: '' }, []);
  assert.match(fs.readFileSync(log, 'utf8'), /PARKED {2}\? {2}reason=\?/);
});
