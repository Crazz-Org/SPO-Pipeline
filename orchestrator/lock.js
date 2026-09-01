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

// ---- short-lived exclusive locks (action 6.2: account.js's per-account leases and its
// .state.lock around markLimit's read-modify-write) ------------------------------------------
//
// A SECOND, deliberately simpler idiom from acquireLock's own tmp+link dance above. That one
// exists because daemon.lock is read by `watchLock` on a timer for the LIFE of the daemon, so a
// reader catching it half-written (a bare `wx` create followed by a second write() for the
// content) is a real, standing risk acquireLock's own header explains. These locks are held for,
// at most, a handful of milliseconds around one small JSON read+write (a lease around one LLM
// step call, or the state.json critical section) -- the write is a single writeFileSync call, a
// SINGLE syscall for a payload this small, so there is no separate "create empty, then fill it"
// window to race in the first place. Same exclusivity guarantee (the OS's O_EXCL), same
// pid-liveness staleness idiom (this module's own `processAlive`), same release-only-if-ours
// doctrine (`pid` AND `startedAt` both have to match) -- just without the extra ceremony a
// long-lived, frequently-re-read file needs.
//
// acquireShortLock(filePath, {isAlive}) -> {pid, startedAt} on success, or null if a LIVE holder
// already has it (after one stale-sweep retry for a DEAD holder's leftover). Never throws for
// contention -- only for a real fs error (permissions, disk full, ...), same as acquireLock.
// holderExpired(holder, maxAgeMs, now) -- whether a short-lock holder is stale purely on AGE,
// independent of whether its pid is alive. `maxAgeMs` null/undefined disables the rule entirely,
// which is what markLimit's .state.lock passes: that lock is held for microseconds around one
// small JSON read+write, so a dead-pid sweep already covers every way it can be orphaned and an
// age rule would add a second lifecycle for no benefit. Only account-lease.js opts in -- see its
// MAX_LEASE_AGE_MS for the derivation and for the failure this closes.
//
// A `startedAt` that isn't a parseable ISO timestamp is NOT treated as expired: an unreadable or
// torn payload is already handled by readHolder returning null (the caller sweeps it as stale on
// the pid rule), and inventing an age for a value we cannot parse would sweep leases we have no
// evidence about. The same conservatism applies to a holder that appears to come from the future
// (a clock injected below the lease's own timestamps, as several tests do): `now - startedAt` is
// negative, so nothing expires. Both directions fail toward "leave it alone", which risks only a
// slower recovery, never two `claude` processes on one CLAUDE_CONFIG_DIR.
function holderExpired(holder, maxAgeMs, now = Date.now) {
  if (maxAgeMs === null || maxAgeMs === undefined) return false;
  if (!holder || typeof holder.startedAt !== 'string') return false;
  const startedAt = Date.parse(holder.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  return now() - startedAt > maxAgeMs;
}

function acquireShortLock(filePath, { isAlive = processAlive, maxAgeMs = null, now = Date.now } = {}) {
  const payload = { pid: process.pid, startedAt: new Date().toISOString() };
  // CREATE-AND-PUBLISH MUST BE ATOMIC (verification of action 6.3; the defect this closes was
  // measured, not reasoned about). `fs.writeFileSync(filePath, ..., {flag:'wx'})` is NOT atomic:
  // it is open(O_CREAT|O_EXCL) followed by a SEPARATE write(). Between those two syscalls the
  // lock file exists at its final name with ZERO BYTES in it, and any other process's
  // `readHolder` above reads it, fails to JSON.parse it, and gets `null` -- which the stale-sweep
  // below then treats as "unreadable or torn -- stale", unlinks, and takes. That is a LIVE
  // holder's lock being stolen, i.e. mutual exclusion silently broken, with NOTHING anywhere
  // reporting it (markLimit's own `degraded` flag stays FALSE -- both processes believe they
  // acquired cleanly).
  //
  // Measured on this box: 53136 of 135923 reads of an existing lock file (39%) came back
  // zero-length under create/unlink churn; 16 real processes running accounts.markLimit took the
  // unparseable-holder sweep 158 times and lost 119 of 800 cooldown entries, with degradedCalls
  // == 0. The bound (accountStateLockWaitMs) had nothing to do with it.
  //
  // The fix is the standard atomic-exclusive-create idiom: write the COMPLETE payload to a
  // private temp name first, then `link()` it to the lock path. link() is atomic and fails
  // EEXIST, so the lock file is only ever observable fully-formed -- there is no window in which
  // it exists but does not parse. Same directory, so the two names are always on one filesystem.
  // Was a bare `open(..., 'wx')` -- EXACTLY the non-atomic create tryCreate() above already
  // documents and fixes for daemon.lock, which acquireShortLock never got. 'wx' creates the file
  // EMPTY and writes the payload in a SECOND syscall; in that window readHolder() below returns
  // null for a lock a LIVE process holds, and the stale sweep further down unlinks it and takes
  // it. Mutual exclusion silently broken, with nothing reporting it -- markLimit's own `degraded`
  // flag stays FALSE, because both processes believe they acquired cleanly.
  //
  // Measured on this box (verification of action 6.3): 53136 of 135923 reads of an existing
  // 'wx'-created lock file (39%) came back zero-length under create/unlink churn. 16 real
  // processes running accounts.markLimit hit the unparseable-holder sweep 158 times and lost 119
  // of 800 cooldown entries, with degradedCalls == 0 -- i.e. every one of those losses happened on
  // the LOCKED path, not the documented "degrade, never fail" fallback the 2s
  // accountStateLockWaitMs bound governs.
  const tryWrite = () => tryCreate(filePath, payload);

  if (tryWrite()) return payload;

  const holder = readHolder(filePath);

  // NEVER SWEEP A HOLDER WE COULD NOT READ -- the residual half of the same defect, and the
  // reason this is a flat rule rather than a smarter re-read. readHolder collapses two very
  // different situations into one `null`: the file is GONE (the holder released between this
  // call's failed create and this read) or the file is genuinely CORRUPT. The sweep below then
  // unlinks UNCONDITIONALLY, so in the "gone" case it deletes whatever THIRD process legitimately
  // acquired the lock in that gap, and both that process and this one end up believing they hold
  // it -- with nothing reporting it, since markLimit's `degraded` flag stays FALSE for both.
  //
  // Measured with the atomic create above already in place: 3-5 sweeps per 800 contended
  // markLimit calls at 16 processes read null and then unlinked a different, LIVE holder's
  // freshly-created lock ('null/nowLIVE'), losing 2-4 cooldown entries. A re-read before the
  // sweep was tried first and does NOT fix it: re-reading is itself two steps (read, then test),
  // so it only narrows the same window -- measured still 5 'null/nowLIVE' sweeps.
  //
  // So: fail CLOSED. There is nothing here this process is entitled to delete, so it deletes
  // nothing and simply races for the exclusive create again. The cost is that a genuinely corrupt
  // lock file is no longer swept -- which is the right trade in both directions. For
  // .state.lock, markLimit degrades after its bounded wait (its documented fallback) instead of
  // wedging. For account-lease.js's lock, wedging one account is strictly safer than stealing a
  // live lease, which is precisely the "never two `claude` processes on one CLAUDE_CONFIG_DIR"
  // property that lock exists for. And the atomic create above has made a corrupt lock file
  // unproducible by a racing acquirer in the first place -- it was the ONLY producer of one.
  if (!holder) return tryWrite() ? payload : null;

  const holderAlive =
    holder && typeof holder.pid === 'number' && isAlive(holder.pid) && !holderExpired(holder, maxAgeMs, now);
  if (holderAlive) return null; // a live process really does hold this -- caller's problem to wait or degrade

  // Dead pid, over-age (when the caller opted into maxAgeMs), or an unreadable/torn file: stale.
  // Both rules are kept, and the pid rule is NOT subordinate to the age one: a dead pid is swept
  // immediately because that is the COMMON case (the post-merge deploy hook SIGTERMs this tree,
  // orphaning any lease mid-step), and making it wait out the age bound would be a plain
  // regression. Sweep and retry exactly once -- a second EEXIST
  // here means a racing acquirer won the sweep, and that racer is alive by construction (it just
  // created the file), so this attempt simply loses, same as the live-holder case above.
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err; // already swept by the racer -- fall through to the retry
  }
  return tryWrite() ? payload : null;
}

// releaseShortLock(filePath, held) -- removes the lock IFF it is still ours: both `pid` and
// `startedAt` must match the payload acquireShortLock returned. Guards the same reused-pid race
// releaseLock (daemon.lock) and orphan-scan.js's owner check both already guard: a process that
// died holding this lock, whose pid got recycled by an unrelated process before this lock's
// original owner's own cleanup runs, must never have its lock torn out from under it by that
// unrelated process's eventual (unrelated) release call.
function releaseShortLock(filePath, held) {
  if (!held) return;
  const holder = readHolder(filePath);
  if (!holder || holder.pid !== held.pid || holder.startedAt !== held.startedAt) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort, same posture as releaseLock -- a release must never crash the caller.
  }
}

module.exports = {
  acquireLock,
  lockPath,
  LockHeldError,
  LockLostError,
  processAlive,
  watchLock,
  acquireShortLock,
  releaseShortLock,
  holderExpired,
};
