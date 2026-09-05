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

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { acquireLock, lockPath, LockHeldError, LockLostError, watchLock } = require('../orchestrator/lock');
const shortLock = require('../orchestrator/lock'); // acquireShortLock/releaseShortLock -- see the verifier tests at the end of this file
const { runTask } = require('../orchestrator/state-machine');
const { DAEMON, mkTmp, writeTask, runDaemonOnce, runDaemonWorker, readState, isolatedEnv } = require('./helpers');

// Same layout a dispatcher's takeNextTask would leave behind (<taskDir>/task.json, no queue/
// entry) -- worker mode reads it directly, never through the queue. Shared by both action 6.1
// tests below; see test/worker-mode.test.js for the fuller worker-mode coverage (exit codes,
// owner shape, usage errors) -- these two live here instead because what they actually pin is
// LOCK behaviour: a worker takes none at all.
function seedWorkerTask(journalDir, id, taskObj) {
  const taskDir = path.join(journalDir, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(taskObj, null, 2));
  return taskDir;
}

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

  // Wait on the CONDITION, never on a fixed budget. intervalMs is 5, so two ticks is ~10ms --
  // but under a 4x-parallel full-suite run the event loop starves long enough that a flat 60ms
  // wait saw fewer than two ticks and read calls.length === 0. That is a harness artifact, not
  // the behaviour under test: measured at 4 failures in 16 parallel full-suite runs (#480), the
  // more frequent of that card's two flakes. The "exactly once" half is still asserted below,
  // after ~20 further intervals -- watchLock clearIntervals itself on the first onLost, so a
  // regression that removed that stop is what the second assertion catches.
  const firstCallDeadline = Date.now() + 10000;
  while (calls.length === 0 && Date.now() < firstCallDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(calls.length, 1, 'onLost never fired within 10s -- the watch timer never ran twice');
  await new Promise((resolve) => setTimeout(resolve, 100)); // ~20 further 5ms intervals
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

// Deterministic companion to the SIGTERM test below, which can only catch this race by winning
// it -- measured at ~2 runs in 44 even under a 4x-parallel suite, and 0 in 44 on an idle box. A
// probabilistic guard is not a guard: the ordering it protects is a one-line edit away from
// regressing, and the reversal would sit green for weeks. Same standing-guard shape as
// test/gh-api-argv.test.js, which fails any `gh api` call site that repeats the `-f`-is-a-POST
// trap rather than waiting to observe the 422.
test('daemon.js registers its signal handlers BEFORE acquiring the lock (no default-disposition window)', () => {
  const source = fs.readFileSync(DAEMON, 'utf8');

  // The registration is `process.on`, NOT `process.once`, since the drain landed: a `once`
  // handler is removed after the first signal, so the SECOND SIGTERM -- the operator's escape
  // hatch out of a drain that may wait 45 minutes -- would fall through to the OS default
  // disposition and kill the process mid-anything, leaking the very lock file the ordering below
  // exists to protect. Both facts are pinned here because they are the same fact.
  const sigtermAt = source.indexOf("process.on(sig, () => {");
  assert.equal(
    source.includes("process.once(sig,"),
    false,
    'daemon.js registers its signal handlers with process.once -- a second SIGTERM would then hit the OS default disposition and leak the lock file (see the drain escape hatch in dispatcher.js requestDrain)'
  );
  const acquireAt = source.indexOf('acquireLock(journalRoot');
  const exitHookAt = source.indexOf("process.once('exit', () => {");

  assert.notEqual(sigtermAt, -1, 'the SIGINT/SIGTERM registration is no longer recognisable -- update this guard');
  assert.notEqual(acquireAt, -1, 'the acquireLock call is no longer recognisable -- update this guard');
  assert.notEqual(exitHookAt, -1, 'the lock-releasing exit hook is no longer recognisable -- update this guard');

  // Until a JS handler exists, Node terminates on SIGTERM immediately and runs no 'exit' hooks,
  // so anything acquired before the handler is installed can leak. Both the exit hook and the
  // signal handlers must therefore precede acquisition.
  assert.ok(
    sigtermAt < acquireAt,
    'daemon.js acquires the lock before registering its SIGTERM handler -- a signal in that window kills the process on the OS default disposition and leaks the lock file'
  );
  assert.ok(
    exitHookAt < acquireAt,
    "daemon.js acquires the lock before registering the 'exit' hook that releases it"
  );
});

test('daemon.js: SIGTERM releases the lock (signal handler reaches the exit hook)', async () => {
  const queueDir = mkTmp('spo-lock-q-');
  const journalDir = mkTmp('spo-lock-j-');
  const { spawn } = require('child_process');
  // No --once: the daemon polls forever until the signal.
  const child = spawn(process.execPath, [DAEMON, '--shadow', '--queue', queueDir, '--journal', journalDir], {
    stdio: 'ignore',
  });
  // Wait for the lock to appear (daemon startup), then terminate. Deadline-based and generous:
  // this waits on a real node process booting and requiring the whole orchestrator tree, which
  // under a 4x-parallel full-suite run takes longer than the 5s the first cut allowed
  // (100 x 50ms).
  //
  // Raising that budget is NOT what fixed this test's intermittent failure, and the distinction
  // matters. #480 filed it alongside the watchLock case as a second timing-budget flake; it was
  // not one. This test kills the daemon the instant its lock file appears, which is exactly the
  // window in which daemon.js had not yet registered a SIGTERM handler -- so the child died on
  // Node's default disposition, skipping the 'exit' hook that releases the lock, and the final
  // assertion below correctly reported a leaked lock. The fix is in daemon.js (handlers hoisted
  // above acquireLock); see its comment. This test was reporting a real production race the
  // whole time, and it must keep killing the daemon as early as it can in order to keep
  // reporting it.
  const bootDeadline = Date.now() + 30000;
  while (!fs.existsSync(lockPath(journalDir)) && Date.now() < bootDeadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(fs.existsSync(lockPath(journalDir)), true, 'daemon never wrote its lock within 30s');
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(fs.existsSync(lockPath(journalDir)), false);
});

// ---- action 6.1: --worker takes no lock at all -----------------------------------------------

test('daemon.js --worker: leaves no lock file behind -- the whole point of skipping acquireLock', () => {
  const journalDir = mkTmp('spo-lock-worker-j-');
  const taskDir = seedWorkerTask(journalDir, 'worker-no-lock', {
    id: 'worker-no-lock',
    kind: 'synthetic',
    shadow: { forceState: 'DONE' },
  });

  const result = runDaemonWorker(taskDir, journalDir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readState(journalDir, 'worker-no-lock').state, 'DONE');

  // A mutation that re-added acquireLock to the --worker path would fail exactly this line: the
  // lock file would exist right up until the worker's own 'exit' hook released it, and by the
  // time execFileSync returns here that release has already happened -- so a re-added
  // acquireLock would be caught by the DAEMON test above ("SIGTERM releases the lock") passing
  // for the wrong reason, not by a leftover file. What actually distinguishes "never acquired"
  // from "acquired and released" is the concurrency test directly below: two workers against the
  // SAME journal root, overlapping in wall-clock time, both succeeding. That is the one a
  // reintroduced acquireLock cannot fake.
  assert.equal(fs.existsSync(lockPath(journalDir)), false);
});

test('daemon.js --worker: two workers run CONCURRENTLY against the SAME journal root and both succeed', async () => {
  const journalDir = mkTmp('spo-lock-worker-j-');
  // Same shape as test/citation-verifier.test.js's proven "reaches DONE in shadow mode" fixture
  // (gate/prWait exit-0 fixtures + a VALIDATE PASS verdict), plus a delays.IMPLEMENT slow enough
  // that both children are still alive, mid-task, at the same wall-clock instant -- a real
  // overlap, not two runs that merely didn't happen to collide.
  const taskDirA = seedWorkerTask(journalDir, 'worker-concurrent-a', {
    id: 'worker-concurrent-a',
    kind: 'synthetic',
    touchesRdoMembers: true,
    shadow: { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } }, delays: { IMPLEMENT: 150 } },
  });
  const taskDirB = seedWorkerTask(journalDir, 'worker-concurrent-b', {
    id: 'worker-concurrent-b',
    kind: 'synthetic',
    touchesRdoMembers: true,
    shadow: { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } }, delays: { IMPLEMENT: 150 } },
  });

  const queueDirA = mkTmp('spo-lock-worker-q-');
  const queueDirB = mkTmp('spo-lock-worker-q-');
  const { spawn } = require('child_process');
  // isolatedEnv(), not bare process.env: these two children run the real daemon to completion,
  // and helpers.js's isolatedEnv header says why every daemon subprocess goes through it -- a
  // mutation that makes a shadow-mode step take a real path turns fixture ids into git worktrees
  // and branches in the maintainer's live ~/SPO-WebClient (44 of them, on 2026-08-31, invisible
  // to `git status` because worktrees/ is gitignored). "Shadow mode never reaches realWorktree"
  // is precisely the invariant a mutation round exists to break, so it cannot also be the reason
  // this test is allowed to skip the isolation.
  const spawnOpts = { stdio: 'ignore', env: isolatedEnv() };
  const childA = spawn(
    process.execPath,
    [DAEMON, '--shadow', '--worker', taskDirA, '--queue', queueDirA, '--journal', journalDir],
    spawnOpts
  );
  const childB = spawn(
    process.execPath,
    [DAEMON, '--shadow', '--worker', taskDirB, '--queue', queueDirB, '--journal', journalDir],
    spawnOpts
  );

  // Both must be alive at the same time for this to actually test concurrency rather than two
  // sequential runs that merely didn't error. If either has already exited, the delay above
  // wasn't long enough on this machine and the test would silently stop proving anything.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(childA.exitCode, null, 'worker A finished before the concurrency window -- raise the IMPLEMENT delay');
  assert.equal(childB.exitCode, null, 'worker B finished before the concurrency window -- raise the IMPLEMENT delay');

  const [codeA, codeB] = await Promise.all([
    new Promise((resolve) => childA.once('exit', resolve)),
    new Promise((resolve) => childB.once('exit', resolve)),
  ]);

  // Today's non-worker daemon would refuse the second of these with LockHeldError (exit 1) --
  // that is exactly the contention --worker mode exists to remove. Both reaching DONE (0) proves
  // neither ever contended for a lock the other held.
  assert.equal(codeA, 0, 'worker A did not exit 0');
  assert.equal(codeB, 0, 'worker B did not exit 0');
  assert.equal(readState(journalDir, 'worker-concurrent-a').state, 'DONE');
  assert.equal(readState(journalDir, 'worker-concurrent-b').state, 'DONE');
  assert.equal(fs.existsSync(lockPath(journalDir)), false, 'neither worker may leave a lock file');
});

// ---- VERIFIER (action 6.3): acquireShortLock must never STEAL a live holder's lock -----------
//
// The defect these pin, measured during 6.3's verification rather than reasoned about:
// acquireShortLock created its lock with `fs.writeFileSync(..., {flag:'wx'})`, which is
// open(O_CREAT|O_EXCL) followed by a SEPARATE write(). In that window the lock file exists at its
// final name with ZERO BYTES, readHolder() returns null for it, and the stale sweep unlinked it
// and took it -- from a process that was alive and holding it. Mutual exclusion silently broken,
// and silently is the operative word: accounts.markLimit's own `degraded` flag stays FALSE,
// because both processes believe they acquired cleanly.
//
// Measured: 53136 of 135923 reads of a 'wx'-created lock file (39%) came back zero-length under
// create/unlink churn; 16 real processes running markLimit hit the unparseable-holder sweep 158
// times and lost 119 of 800 cooldown entries, all with degradedCalls == 0 -- i.e. on the LOCKED
// path, nothing to do with the accountStateLockWaitMs bound or the "degrade, never fail" path
// that bound governs. After the fix (write-tmp + link, and never sweeping a holder that could not
// be read) the same probe loses 0 of 800 over five runs, 0 of 960 at 32 processes.
//
// Both tests below are deterministic and fail FAST (no hang, no timing dependence): they
// construct the exact on-disk state the race produces, rather than trying to hit the race.

test('acquireShortLock: a lock file that exists but does not parse is NEVER stolen from a live holder', () => {
  const dir = mkTmp('spo-shortlock-torn-');
  const file = path.join(dir, '.state.lock');

  // Exactly what 'wx' leaves on disk between its open() and its write(): the name exists, the
  // payload is not there yet. The holder is alive and holding.
  fs.writeFileSync(file, '');

  const held = shortLock.acquireShortLock(file, { isAlive: () => true });
  assert.strictEqual(
    held,
    null,
    'acquireShortLock stole a lock whose payload was not yet written -- two processes now hold it, and neither is told'
  );
  assert.ok(fs.existsSync(file), 'the live holder\'s lock file must still be there -- it was not this caller\'s to delete');
});

test('acquireShortLock: creating the lock is atomic -- it is never observable as a file that does not parse', () => {
  const dir = mkTmp('spo-shortlock-atomic-');
  const file = path.join(dir, '.state.lock');

  const held = shortLock.acquireShortLock(file);
  assert.ok(held, 'test setup: the lock must be acquired');
  // The published name carries a COMPLETE payload -- this is what write-tmp+link buys, and what a
  // bare open('wx') cannot give. A mutation back to 'wx' leaves this assertion passing only
  // because the write happens to have landed by now, so the previous test is the real guard;
  // this one pins the payload shape the sweep depends on being readable.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.pid, process.pid);
  assert.strictEqual(typeof onDisk.startedAt, 'string');

  // No temp files left behind in the lock's own directory.
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], `acquireShortLock left temp files behind: ${leftovers.join(', ')}`);

  shortLock.releaseShortLock(file, held);
  assert.strictEqual(fs.existsSync(file), false, 'release must remove the lock');
});

test('acquireShortLock: a DEAD holder is still swept -- the fix above must not cost stale recovery', () => {
  const dir = mkTmp('spo-shortlock-dead-');
  const file = path.join(dir, '.state.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));

  const held = shortLock.acquireShortLock(file, { isAlive: () => false });
  assert.ok(held, 'a lock held by a dead pid must still be swept and taken');
  assert.strictEqual(held.pid, process.pid);
});
