'use strict';
// lock.js -- the daemon's single-instance lock, scoped to one journal root.
//
// WHY: nothing else stops two daemons sharing a queue. takeNextTask's rename is atomic, so a
// contended task is never run twice -- but the LOSING daemon's fs.renameSync throws ENOENT,
// and per park-signal.js's doctrine a non-ParkSignal error is a real bug that crashes the
// daemon (reproduced 2026-08-29). Beyond the crash, two daemons also silently clobber the
// account pool's state.json read-modify-write (accounts.js -- a lost cooldown resurfaces
// later as an unexplained rate-limit park) and double-run the auto-pull timer. The likely
// accident is not two systemd units (systemd itself prevents that): it is a hand-run
// `node orchestrator/daemon.js --real` in a terminal while the unit is up.
//
// SHAPE: one JSON file at <journalRoot>/daemon.lock, created with open(..., 'wx') -- atomic:
// exactly one creator wins -- holding {host, pid, startedAt, mode}. Scoped to the journal
// root, not the process, so the test suite's daemons on fs.mkdtempSync temp dirs never
// collide with a live daemon on the repo's own journal/.
//
// STALENESS: a daemon killed hard (SIGKILL, power loss) leaves its lock behind. On acquire,
// a lock whose pid is no longer alive on this host is taken over -- same liveness probe as
// the bench worker's processAlive (SPO-WebClient src/e2e/bench/paths.ts): process.kill(pid, 0).
// The takeover is returned to the caller (daemon.js journals it as a `lock-stale-taken`
// daemon event). If two starters race for the same stale lock, the unlink+'wx' retry lets
// exactly one win; the other sees the winner's fresh, alive lock and refuses normally.
//
// `deps.isAlive` is the test-only override, same convention as steps/scripted.js's
// deps.spawnSync: production code never passes it.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Thrown when another live daemon already holds the lock. daemon.js turns this into a
// refuse-to-start, the same way it refuses an empty account pool.
class LockHeldError extends Error {
  constructor(holder, lockPath) {
    super(
      `another daemon already holds ${lockPath} ` +
        `(pid ${holder.pid} on ${holder.host}, mode ${holder.mode || '?'}, since ${holder.startedAt || '?'}). ` +
        `If that is the systemd unit, this is the collision the lock exists to catch -- check ` +
        `\`systemctl --user status spo-pipeline-daemon.service\`. A crashed daemon's lock is ` +
        `taken over automatically once its pid is gone.`
    );
    this.name = 'LockHeldError';
    this.holder = holder;
    this.lockPath = lockPath;
  }
}

function lockPath(journalRoot) {
  return path.join(journalRoot, 'daemon.lock');
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// One 'wx' attempt. Returns true when this process created the file.
function tryCreate(file, payload) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify(payload, null, 2) + '\n');
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function readHolder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // unreadable or torn -- treated as stale below
  }
}

// acquireLock(journalRoot, mode, deps) -> {path, stale: <holder|null>, release()}
//
//   stale     the dead holder that was swept aside, or null on a clean acquire -- the caller
//             journals it; this module never journals (same rule as journal.js: record what
//             was already decided, decide nothing).
//   release() removes the lock IF it is still ours (pid check on read-back) -- a stale
//             takeover by a successor must never be deleted by the crashed-and-restarted
//             predecessor's leftover exit handler.
//
// Throws LockHeldError when a live holder exists. Any other fs error propagates (real bug).
function acquireLock(journalRoot, mode, deps = {}) {
  const isAlive = deps.isAlive || processAlive;
  const file = lockPath(journalRoot);
  const payload = { host: os.hostname(), pid: process.pid, startedAt: new Date().toISOString(), mode };

  let stale = null;
  // Two passes at most: a clean create, or one stale sweep followed by a create. A second
  // EEXIST after the sweep means somebody else won the stale race fair and square.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(file, payload)) {
      return { path: file, stale, holder: payload, release: () => releaseLock(file) };
    }
    const holder = readHolder(file);
    const holderAlive =
      holder && typeof holder.pid === 'number' && holder.host === os.hostname() && isAlive(holder.pid);
    if (holderAlive) throw new LockHeldError(holder, file);
    // Dead pid, foreign host leftover, or an unreadable file: stale. Sweep and retry once.
    stale = holder || { pid: null, host: null, unreadable: true };
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err; // already swept by the racer -- retry
    }
  }
  // Lost the post-sweep race: whoever won is alive by construction (they just started).
  const winner = readHolder(file) || { pid: null, host: null };
  throw new LockHeldError(winner, file);
}

function releaseLock(file) {
  const holder = readHolder(file);
  if (!holder || holder.pid !== process.pid) return; // not ours (or already gone) -- leave it
  try {
    fs.unlinkSync(file);
  } catch {
    // Releasing on exit must never turn a clean shutdown into a crash.
  }
}

module.exports = { acquireLock, lockPath, LockHeldError, processAlive };
