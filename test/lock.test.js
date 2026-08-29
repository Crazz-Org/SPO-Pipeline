'use strict';
// Tests for orchestrator/lock.js (the single-instance daemon lock) and its daemon.js wiring:
// atomic acquire, live-holder refusal, stale takeover + the `lock-stale-taken` daemon event,
// release-only-if-ours, and the daemon refusing to start against a held journal root. The
// liveness probe is injected (`deps.isAlive`) for the unit tests; the daemon integration
// tests use this test process's own (alive) pid and an absurdly dead one instead.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { acquireLock, lockPath, LockHeldError } = require('../orchestrator/lock');
const { DAEMON, mkTmp, writeTask, runDaemonOnce } = require('./helpers');

test('acquireLock: clean acquire writes {host, pid, startedAt, mode} and release removes it', () => {
  const root = mkTmp('spo-lock-');
  const lock = acquireLock(root, 'shadow');

  const file = lockPath(root);
  assert.equal(lock.path, file);
  assert.equal(lock.stale, null);
  const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.host, os.hostname());
  assert.equal(holder.mode, 'shadow');
  assert.ok(holder.startedAt);

  lock.release();
  assert.equal(fs.existsSync(file), false);
});

test('acquireLock: a live holder refuses the second acquire with LockHeldError naming it', () => {
  const root = mkTmp('spo-lock-');
  acquireLock(root, 'real', { isAlive: () => true });

  assert.throws(
    () => acquireLock(root, 'real', { isAlive: () => true }),
    (err) => {
      assert.ok(err instanceof LockHeldError);
      assert.equal(err.holder.pid, process.pid); // the first acquire above
      assert.match(err.message, /another daemon already holds/);
      assert.match(err.message, /systemctl --user status/);
      return true;
    }
  );
});

test('acquireLock: a dead holder is swept and reported as `stale`', () => {
  const root = mkTmp('spo-lock-');
  const first = acquireLock(root, 'real', { isAlive: () => true });
  // Simulate the holder dying hard: the file stays, the pid stops answering.
  const second = acquireLock(root, 'real', { isAlive: () => false });

  assert.ok(second.stale);
  assert.equal(second.stale.pid, process.pid); // the swept holder's recorded pid
  const holder = JSON.parse(fs.readFileSync(lockPath(root), 'utf8'));
  assert.equal(holder.mode, 'real'); // the new lock is in place
  void first; // its release() must now be a no-op -- covered by the next test
});

test('release: never deletes a successor\'s lock (pid check on read-back)', () => {
  const root = mkTmp('spo-lock-');
  const first = acquireLock(root, 'real', { isAlive: () => true });
  // A successor takes over after "our" crash...
  fs.writeFileSync(lockPath(root), JSON.stringify({ host: os.hostname(), pid: process.pid + 1 }) + '\n');
  // ...and our leftover release must leave it alone.
  first.release();
  assert.equal(fs.existsSync(lockPath(root)), true);
});

test('acquireLock: an unreadable lock file is treated as stale, flagged as such', () => {
  const root = mkTmp('spo-lock-');
  fs.writeFileSync(lockPath(root), 'not json{{{');
  const lock = acquireLock(root, 'shadow');
  assert.ok(lock.stale);
  assert.equal(lock.stale.unreadable, true);
});

test('daemon.js: refuses to start when a live daemon holds the journal root', () => {
  const queueDir = mkTmp('spo-lock-q-');
  const journalDir = mkTmp('spo-lock-j-');
  // This test process is the "live daemon": its pid answers process.kill(pid, 0).
  fs.writeFileSync(
    lockPath(journalDir),
    JSON.stringify({ host: os.hostname(), pid: process.pid, startedAt: 'x', mode: 'real' }) + '\n'
  );

  assert.throws(
    () => runDaemonOnce(queueDir, journalDir),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /another daemon already holds/);
      return true;
    }
  );
  // The refusal must not have deleted the holder's lock.
  assert.equal(fs.existsSync(lockPath(journalDir)), true);
});

test('daemon.js: takes over a dead holder\'s lock, journals lock-stale-taken, releases on exit', () => {
  const queueDir = mkTmp('spo-lock-q-');
  const journalDir = mkTmp('spo-lock-j-');
  // A pid far above kernel.pid_max: guaranteed dead without having to spawn-and-kill.
  fs.writeFileSync(
    lockPath(journalDir),
    JSON.stringify({ host: os.hostname(), pid: 2 ** 30, startedAt: 'x', mode: 'real' }) + '\n'
  );
  writeTask(queueDir, '001-demo.json', {
    id: 'demo-lock-001',
    kind: 'demo',
    title: 'lock takeover demo',
    shadow: { steps: {} },
  });

  runDaemonOnce(queueDir, journalDir);

  const daemonLog = fs
    .readFileSync(path.join(journalDir, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const taken = daemonLog.filter((e) => e.event === 'lock-stale-taken');
  assert.equal(taken.length, 1);
  assert.equal(taken[0].stale.pid, 2 ** 30);
  // Clean exit released the lock.
  assert.equal(fs.existsSync(lockPath(journalDir)), false);
});

test('daemon.js: two sequential --once runs on the same journal root both succeed (release works)', () => {
  const queueDir = mkTmp('spo-lock-q-');
  const journalDir = mkTmp('spo-lock-j-');
  runDaemonOnce(queueDir, journalDir);
  runDaemonOnce(queueDir, journalDir); // would throw if the first run's lock lingered
  assert.equal(fs.existsSync(lockPath(journalDir)), false);
});

test('daemon.js: SIGTERM releases the lock (signal handler reaches the exit hook)', async () => {
  const queueDir = mkTmp('spo-lock-q-');
  const journalDir = mkTmp('spo-lock-j-');
  const { spawn } = require('child_process');
  // No --once: the daemon polls forever until the signal.
  const child = spawn(process.execPath, [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir], {
    stdio: 'ignore',
  });
  // Wait for the lock to appear (daemon startup), then terminate.
  for (let i = 0; i < 100 && !fs.existsSync(lockPath(journalDir)); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(fs.existsSync(lockPath(journalDir)), true, 'daemon never wrote its lock');
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(fs.existsSync(lockPath(journalDir)), false);
});
