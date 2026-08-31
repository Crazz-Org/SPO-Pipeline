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
// SHAPE: one JSON file at <journalRoot>/daemon.lock, created by write-tmp + link() -- atomic:
// exactly one creator wins, and the name never exists holding anything but the finished JSON
// (see tryCreate) -- holding {host, pid, startedAt, mode}. Scoped to the journal
// root, not the process, so the test suite's daemons on fs.mkdtempSync temp dirs never
// collide with a live daemon on the repo's own journal/.
//
// STALENESS: a daemon killed hard (SIGKILL, power loss) leaves its lock behind. On acquire,
// a lock whose pid is no longer alive on this host is taken over -- same liveness probe as
// the bench worker's processAlive (SPO-WebClient src/e2e/bench/paths.ts): process.kill(pid, 0).
// The takeover is returned to the caller (daemon.js journals it as a `lock-stale-taken`
// daemon event). If two starters race for the same stale lock, the unlink + exclusive-create
// retry lets exactly one win; the other sees the winner's fresh, alive lock and refuses normally.
//
// `deps.isAlive` is the test-only override, same convention as steps/scripted.js's
// deps.spawnSync: production code never passes it.

const crypto = require('crypto');
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

// Thrown by watchLock's onLost handler wiring in daemon.js (never by this module itself) once a
// running daemon discovers another process now holds its lock -- see watchLock's own header.
// Deliberately NOT a ParkSignal (park-signal.js's doctrine): this is not an outcome of the task
// running, it is this process losing the authority to keep writing shared state at all, so
// state-machine.js's runTask must let it propagate uncaught rather than turn it into a park (a
// park is itself a write to the state this process may no longer own).
class LockLostError extends Error {
  constructor(reason, holder) {
    super(`lock lost: ${reason}${holder ? ` (now held by pid ${holder.pid} on ${holder.host})` : ''}`);
    this.name = 'LockLostError';
    this.reason = reason;
    this.holder = holder || null;
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

// One exclusive-create attempt. Returns true when this process created the file.
//
// Was a bare `open(..., 'wx')`: atomic, but it creates an EMPTY file and the content lands in a
// second syscall -- a concurrent reader in that window sees a file that exists but doesn't parse,
// which readHolder() below treats as "stale" (line 98's comment), so a starter could sweep and
// take over a lock another live daemon had just this instant created. Write-tmp-then-link keeps
// the same exclusive-create semantics (link() fails EEXIST if the target is already there, same
// as 'wx' did) while making the moment the file becomes visible under `file` the same moment it
// is already fully-formed JSON: linkSync's target is only ever the finished tmp file's content.
// The tmp file lives in the SAME directory as `file` (same filesystem -- link() is not atomic
// across filesystems), named with this process's pid plus a random suffix so two attempts, even
// from the same process's own stale-sweep retry, never collide.
function tryCreate(file, payload) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const content = JSON.stringify(payload, null, 2) + '\n';
  fs.writeFileSync(tmp, content);
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone (link succeeded and we're cleaning up the now-redundant tmp name), or
      // never created -- either way there's nothing left to remove.
    }
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

// watchLock(lock, {intervalMs, onLost, deps}) -> {stop()}
//
// Re-reads the lock file on a timer and calls onLost(reason, holder) the first time it finds a
// holder that is not this process's own (a live process took the lock file over -- another
// daemon started, this one's stale-sweep window raced, systemd restarted the unit while the old
// process was still exiting). acquireLock only ever checks liveness once, at startup; this is
// the periodic re-check the header's WHY section describes -- see daemon.js for the wiring that
// turns onLost into a clean, silent process exit (never a park -- see LockLostError above).
//
// Two consecutive "not ours" reads are required before firing, not one: unlinkSync followed by a
// fresh tryCreate (acquireLock's own stale-sweep retry, and this process's own eventual release)
// each pass through a brief window where the file is briefly absent or briefly holds a
// transitional value -- see lock.js's own stale-sweep comment on the identical race. A watch on
// our OWN lock must never fire on that.
//
// `deps.readHolder` is the test-only override (same convention as `deps.isAlive`); production
// never passes it. The timer is unref()'d -- it must never be the reason the process stays alive.
function watchLock(lock, { intervalMs, onLost, deps = {} } = {}) {
  const readHolderFn = deps.readHolder || readHolder;
  let misses = 0;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    const holder = readHolderFn(lock.path);
    const ours = holder && holder.pid === lock.holder.pid && holder.startedAt === lock.holder.startedAt;
    if (ours) {
      misses = 0;
      return;
    }
    misses += 1;
    if (misses < 2) return; // one miss might just be the sweep-retry race -- wait for a second
    stopped = true;
    clearInterval(timer);
    onLost(holder ? 'taken-over' : 'lock-file-missing', holder);
  }, intervalMs);
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
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

module.exports = { acquireLock, lockPath, LockHeldError, LockLostError, processAlive, watchLock };
