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

const { acquireLock, lockPath, LockHeldError, LockLostError, watchLock } = require('../orchestrator/lock');
const { runTask } = require('../orchestrator/state-machine');
const { DAEMON, mkTmp, writeTask, runDaemonOnce, readState } = require('./helpers');

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

// ---- watchLock: periodic re-verification, not just at acquisition ---------------------------

test('watchLock: fires onLost once a different holder is read back twice in a row', async () => {
  const root = mkTmp('spo-lock-watch-');
  const lock = acquireLock(root, 'real');

  let calls = [];
  const holders = [
    { pid: 999999, host: os.hostname(), startedAt: 'other' },
    { pid: 999999, host: os.hostname(), startedAt: 'other' },
  ];
  let i = 0;
  const watch = watchLock(lock, {
    intervalMs: 5,
    onLost: (reason, holder) => calls.push({ reason, holder }),
    deps: { readHolder: () => holders[Math.min(i++, holders.length - 1)] },
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  watch.stop();
  assert.equal(calls.length, 1); // fires exactly once, not once per remaining tick
  assert.equal(calls[0].reason, 'taken-over');
  assert.equal(calls[0].holder.pid, 999999);
  lock.release();
});

test('watchLock: a single miss that recovers next read never fires onLost (sweep-retry race window)', async () => {
  const root = mkTmp('spo-lock-watch-');
  const lock = acquireLock(root, 'real');

  let calls = 0;
  let i = 0;
  const reads = [
    { pid: 999999, host: os.hostname(), startedAt: 'other' }, // one miss...
    lock.holder, // ...then back to ours before a second consecutive miss
    lock.holder,
    lock.holder,
  ];
  const watch = watchLock(lock, {
    intervalMs: 5,
    onLost: () => calls++,
    deps: { readHolder: () => reads[Math.min(i++, reads.length - 1)] },
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  watch.stop();
  assert.equal(calls, 0);
  lock.release();
});

test('watchLock: a missing lock file (unlinked, not yet recreated) counts as a miss, fires after two', async () => {
  const root = mkTmp('spo-lock-watch-');
  const lock = acquireLock(root, 'real');

  let calls = [];
  const watch = watchLock(lock, {
    intervalMs: 5,
    onLost: (reason, holder) => calls.push({ reason, holder }),
    deps: { readHolder: () => null },
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  watch.stop();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'lock-file-missing');
  assert.equal(calls[0].holder, null);
  lock.release();
});

test('daemon.js: another live process taking the lock file over stops the daemon with exit 75 and a lock-lost event', async () => {
  const queueDir = mkTmp('spo-lock-q-');
  const journalDir = mkTmp('spo-lock-j-');
  const { spawn } = require('child_process');
  const child = spawn(
    process.execPath,
    [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir],
    { stdio: 'ignore', env: { ...process.env, SPO_LOCK_WATCH_MS: '30' } }
  );

  for (let i = 0; i < 100 && !fs.existsSync(lockPath(journalDir)); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(fs.existsSync(lockPath(journalDir)), true, 'daemon never wrote its lock');

  // Overwrite with a different, alive pid (this test process itself answers process.kill) --
  // the daemon's watchLock has no isAlive check of its own (identity, not liveness, decides a
  // takeover), so this is enough to simulate another process winning the lock file.
  fs.writeFileSync(
    lockPath(journalDir),
    JSON.stringify({ host: os.hostname(), pid: process.pid, startedAt: 'someone-else', mode: 'real' }) + '\n'
  );

  const [code] = await new Promise((resolve) => child.once('exit', (c, s) => resolve([c, s])));
  assert.equal(code, 75);

  const daemonLog = fs
    .readFileSync(path.join(journalDir, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(daemonLog.some((e) => e.event === 'lock-lost'));
  // The takeover's own lock file must survive -- release() only ever removes OUR lock.
  assert.equal(fs.existsSync(lockPath(journalDir)), true);
});

// ---- runTask cooperative check: a lost lock stops before another park/write happens ----------

test('runTask: config.lockLost() true throws LockLostError before any handler runs -- no PARKED write', async () => {
  const journalDir = mkTmp('spo-lock-runtask-');
  const taskDir = path.join(journalDir, 'lockLostTask');
  fs.mkdirSync(taskDir, { recursive: true });

  const config = { shadowMode: true, lockLost: () => true, lockLostHolder: () => ({ pid: 1, host: 'x' }) };

  await assert.rejects(
    () => runTask('lockLostTask', { id: 'lockLostTask', shadow: {} }, taskDir, config),
    (err) => err instanceof LockLostError
  );

  const state = readState(journalDir, 'lockLostTask');
  assert.equal(state.state, 'INTAKE'); // the pre-loop snapshot only -- never overwritten to PARKED
});

// ---- action 2.5: atomic create (write-tmp + link, replacing a bare open(..., 'wx')) -----------
//
// The bug being fixed: 'wx' creates an EMPTY file, then a second syscall writes the content --
// a concurrent reader in that window sees a file that EXISTS but does not parse, which
// readHolder() treats as stale, so a starter could sweep and take over a lock another live
// daemon had just that instant created. These tests assert the actual observable contract: once
// the lock file exists at all, it is always complete JSON, and no tmp file is left behind.

test('acquireLock: the lock file, once it exists, always parses (never readable-but-empty)', () => {
  const root = mkTmp('spo-lock-atomic-');
  acquireLock(root, 'real');
  const file = lockPath(root);
  assert.equal(fs.existsSync(file), true);
  // Would throw if the file were empty or partial -- this is the actual bug the action fixes.
  const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(holder.pid, process.pid);
});

test('acquireLock: no leftover tmp file in the journal root after a clean acquire', () => {
  const root = mkTmp('spo-lock-atomic-');
  acquireLock(root, 'real');
  const leftovers = fs.readdirSync(root).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('acquireLock: no leftover tmp file after a stale-sweep takeover (two tryCreate passes)', () => {
  const root = mkTmp('spo-lock-atomic-');
  acquireLock(root, 'real', { isAlive: () => true });
  acquireLock(root, 'real', { isAlive: () => false }); // sweeps the first, creates its own
  const leftovers = fs.readdirSync(root).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('acquireLock: no leftover tmp file when the second acquire loses to a live holder (LockHeldError)', () => {
  const root = mkTmp('spo-lock-atomic-');
  acquireLock(root, 'real', { isAlive: () => true });
  assert.throws(() => acquireLock(root, 'real', { isAlive: () => true }), LockHeldError);
  const leftovers = fs.readdirSync(root).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('acquireLock: exclusive-create still holds -- a second acquire against a live lock fails', () => {
  const root = mkTmp('spo-lock-atomic-');
  const first = acquireLock(root, 'real', { isAlive: () => true });
  assert.throws(
    () => acquireLock(root, 'real', { isAlive: () => true }),
    (err) => {
      assert.ok(err instanceof LockHeldError);
      assert.equal(err.holder.pid, first.holder.pid);
      return true;
    }
  );
});

test('acquireLock: the file content is byte-identical to the pre-fix shape (same keys, pretty JSON + trailing newline)', () => {
  const root = mkTmp('spo-lock-atomic-');
  acquireLock(root, 'shadow');
  const raw = fs.readFileSync(lockPath(root), 'utf8');
  assert.match(raw, /\n$/);
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['host', 'mode', 'pid', 'startedAt'].sort());
  // Pretty-printed with 2-space indent, same as JSON.stringify(payload, null, 2) always produced.
  assert.equal(raw, JSON.stringify(parsed, null, 2) + '\n');
});

test('acquireLock: link() publishes the name only once the content is already complete, from the same directory', () => {
  const root = mkTmp('spo-lock-atomic-');
  // The four tests above assert what is true AFTER acquireLock returns -- which the old
  // open(..., 'wx') + writeSync implementation also satisfied. This one asserts the property that
  // actually changed: at the instant the lock NAME appears, the bytes behind it are already
  // complete JSON. Spying on linkSync is the only way to observe that window without a second
  // process. It also pins the tmp file to the lock's own directory: linkSync is not cross-device,
  // so a tmp in os.tmpdir() would throw EXDEV -- and refuse to start the daemon -- on any machine
  // where /tmp is a separate filesystem, while passing every other test in this file.
  const origLink = fs.linkSync;
  const calls = [];
  fs.linkSync = (src, dest) => {
    calls.push({ src, dest, srcContent: fs.readFileSync(src, 'utf8'), destExisted: fs.existsSync(dest) });
    return origLink(src, dest);
  };
  try {
    acquireLock(root, 'real');
  } finally {
    fs.linkSync = origLink;
  }

  assert.equal(calls.length, 1); // 0 here means the exclusive-create is no longer link-based
  assert.equal(calls[0].dest, lockPath(root));
  assert.equal(path.dirname(calls[0].src), root); // same filesystem, or link() throws EXDEV
  assert.equal(calls[0].destExisted, false); // the name did not exist an instant before it did
  assert.equal(JSON.parse(calls[0].srcContent).pid, process.pid); // complete BEFORE it is named
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
