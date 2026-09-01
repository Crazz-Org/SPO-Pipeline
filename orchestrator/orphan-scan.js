'use strict';
// orphan-scan.js -- recovers a task whose owning daemon process died mid-run.
//
// WHY: state-machine.js's writeState overwrites journal/<id>/state.json on every transition, but
// nothing ever revisits it once the process that was writing it dies -- unlike a queue/ entry
// (picked up by the next drain pass) or a PARKED task (picked up by unparkScan.js), a task killed
// mid-DIAGNOSE (say) just sits there: not in queue/, not PARKED, invisible to every existing
// recovery path. Reproduced 2026-08-30 on card #385 (see doc/state-machine-spec.md's own note and
// the memory record this fix responds to): the daemon's lock changed PID twice in ~16 minutes,
// the losing process's task died mid-DIAGNOSE, and getting it back into the retry loop took a
// hand edit of state.json/journal.jsonl and a fabricated park-comment to anchor unparkScan.
//
// WHAT COUNTS AS AN ORPHAN: a non-terminal state.json (state.state not in DONE/PARKED/ABANDONED)
// whose id has no queue/ entry (a re-enqueued retry is not an orphan, just waiting its turn) and
// whose recorded owner (state-machine.js's buildCtx -> config.owner, set once by daemon.js from
// its own lock holder) is a pid that is no longer alive on this host -- same liveness probe
// lock.js's own stale-lock takeover already uses. A missing/foreign-host owner is left alone
// (logged as 'orphan-scan-unknown-owner'/skipped): a false positive here means two writers on the
// same state.json, worse than the status quo of a silently stuck task. A grace window
// (config.orphanGraceMs) on top of the dead-pid check absorbs the race between a process dying
// and state.json's own last write landing on disk -- a task that is merely SLOW is caught by the
// pid-liveness check alone (a slow step's owner process is still alive and still answers
// process.kill(pid, 0)), never by staleness of updatedAt on its own.
//
// RECOVERY: reparks through state-machine.js's own finalizePark -- the exact same PARKED
// state.json/report.md/daemon.jsonl/park-alert/gh-comment round trip a normal ParkSignal produces
// -- with reason 'task-orphaned-daemon-restart', so unparkScan.js's existing retry/abandon comment
// loop picks it up on the next scan with no special-casing. state-machine.js requires this module
// lazily (inside orphanScan/shouldScanOrphans callers never need it eagerly) to avoid a load-time
// require cycle -- see the lazy require below.
//
// MODE-GATED: daemon.js calls this unconditionally on every start, in every mode (see its own
// header comment on that call site) -- but only a REAL repark (isRealMode(ctx), same helper
// finalizePark/moveCard/postParkComment already gate every side effect on) actually calls
// finalizePark. A --shadow or --dry-run start never does real side effects, so a park it wrote
// would land with no board move, no gh park comment and no unpark anchor -- invisible to the
// maintainer and to unparkScan.js forever. Shadow/dry-run therefore only detect the orphan and
// journal 'orphan-scan-would-repark' to daemon.jsonl (nothing under the task's own taskDir is
// touched) -- enough for a `--dry-run` start to report what a real start would have done, without
// burying a real card under a developer's local experiment.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendDaemonEvent } = require('./journal');
const { listTaskIds, readJsonSafe } = require('./park-loop');
const { processAlive } = require('./lock');

const TERMINAL_STATES = new Set(['DONE', 'PARKED', 'ABANDONED']);
const DEFAULT_ORPHAN_GRACE_MS = 4 * 60 * 1000;

// Pure decision function, same "injectable clock" shape as auto-pull.js's shouldAutoPull.
function shouldScanOrphans(lastScanAt, nowMs, orphanScanMs) {
  if (!(orphanScanMs > 0)) return false;
  if (lastScanAt === null || lastScanAt === undefined) return true;
  return nowMs - lastScanAt >= orphanScanMs;
}

// The set of task ids currently sitting in queue/, keyed the same way takeNextTask derives an id
// (task.id if present, else the filename) -- a retry re-enqueued by unparkScan.js or a fresh pull
// both land here under their real id, not the queue filename.
function queuedIds(queueDir) {
  const ids = new Set();
  if (!fs.existsSync(queueDir)) return ids;
  for (const file of fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'))) {
    const data = readJsonSafe(path.join(queueDir, file));
    ids.add(data && data.id ? String(data.id) : path.basename(file, '.json'));
  }
  return ids;
}

// orphanScan(queueDir, journalRoot, config, deps) -> [{id, reason}] for every task reparked this
// pass. `deps.isAlive` is the test-only liveness override (same convention as lock.js's own
// acquireLock); production never passes it.
async function orphanScan(queueDir, journalRoot, config, deps = {}) {
  const isAlive = deps.isAlive || processAlive;
  const graceMs = (config && config.orphanGraceMs) || DEFAULT_ORPHAN_GRACE_MS;
  const inQueue = queuedIds(queueDir);

  // Lazy require: state-machine.js requires this module (to wire the periodic scan into
  // runForever), so a top-level require here would be a load-time cycle. By the time orphanScan
  // actually runs, both modules have long finished loading.
  const { buildCtx, finalizePark, isRealMode } = require('./state-machine');

  const recovered = [];
  for (const id of listTaskIds(journalRoot)) {
    const taskDir = path.join(journalRoot, id);
    const state = readJsonSafe(path.join(taskDir, 'state.json'));
    if (!state || TERMINAL_STATES.has(state.state)) continue;
    if (inQueue.has(id)) continue;

    // Action 6.1 added a second owner shape: a worker-mode run (daemon.js --worker) writes
    // {host, workerPid, workerStartedAt} instead of the daemon's own {host, pid, lockStartedAt},
    // because there is no lock holder to borrow pid/startedAt from -- a worker never takes the
    // lock (see daemon.js's own comment on that). Reading `workerPid ?? pid` is load-bearing,
    // not cosmetic: `jq -c '.owner' journal/*/state.json` against the LIVE journal root
    // (measured 2026-09-01) shows 7 distinct owners still sitting in the old shape, and the
    // post-merge hook SIGTERMs the daemon on every deploy -- which leaves an in-flight card's
    // state.json holding whichever shape was current at the moment of death. The restarted
    // process's orphanScan is the only thing that ever revisits that file; if it stopped
    // recognising the old shape, every one of those tasks would be invisible forever, not just
    // the ones written after this action shipped.
    const owner = state.owner;
    const ownerPid = owner && (owner.workerPid ?? owner.pid);
    if (!owner || typeof ownerPid !== 'number') {
      appendDaemonEvent(journalRoot, 'orphan-scan-unknown-owner', { id, state: state.state });
      continue;
    }
    if (owner.host !== os.hostname()) continue; // cannot probe a remote host's pid
    if (ownerPid === process.pid) continue; // this process itself -- never an orphan of our own scan
    if (isAlive(ownerPid)) continue; // owner still alive -- slow, not orphaned

    const updatedAt = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
    if (Number.isNaN(updatedAt) || Date.now() - updatedAt < graceMs) continue; // startup-race window

    const task = readJsonSafe(path.join(taskDir, 'task.json')) || {};
    // buildCtx reads its own deps off config.deps (state-machine.js's own convention) -- thread
    // this call's `deps` through so a test's injected spawnSync reaches postParkComment/moveCard
    // exactly as it would for a normal park, instead of falling back to a real spawn.
    const ctx = buildCtx(id, task, taskDir, { ...config, deps: (config && config.deps) || deps });
    // Restore every runtime-only field the crashed process's ctx.task carried that state.json's
    // snapshot() (state-machine.js) persisted but task.json never did -- worktreePath is the one
    // measured gap (assigned only at WORKTREE time, steps/scripted.js's realWorktree). Left
    // undefined, finalizePark -> preserveWorktreeWip is a guaranteed no-op and a crashed task's
    // uncommitted work is silently lost instead of pushed to a wip/ ref. `|| null` also covers the
    // legitimate pre-WORKTREE case (a task that died in INTAKE, before any worktree existed) the
    // same way buildCtx's own fresh ctx.task would never have set it either.
    ctx.task.worktreePath = state.worktreePath || null;
    ctx.prNumber = state.prNumber || null;
    ctx.counters.diagnoseAttempts = state.diagnoseAttempts || 0;
    ctx.counters.validateRejects = state.validateRejects || 0;
    // Action 4.3's CI_CHECKS -> IMPLEMENT retry counter, restored for the same reason as the two
    // above: finalizePark below rewrites state.json through snapshot(), so a counter not restored
    // here is not merely absent from the park report -- it is overwritten with 0, and the parked
    // card's record then claims no CI retry ever happened when three may have.
    ctx.counters.ciImplementRetries = state.ciImplementRetries || 0;
    ctx.counters.mainMoveUsed = !!state.mainMoveUsed;

    if (!isRealMode(ctx)) {
      // shadow/dry-run: detect and journal only -- see this file's header note above. Nothing
      // under taskDir is touched (no state.json/report.md/journal.jsonl write), so this task is
      // still exactly where a real start would find it: eligible to be reparked for real next
      // time --real runs against this journal root.
      appendDaemonEvent(journalRoot, 'orphan-scan-would-repark', {
        id,
        reason: 'task-orphaned-daemon-restart',
        lastState: state.state,
        owner,
        lastUpdatedAt: state.updatedAt,
      });
      recovered.push({ id, reason: 'task-orphaned-daemon-restart', wouldRepark: true });
      continue;
    }

    finalizePark(ctx, state.state, 'task-orphaned-daemon-restart', {
      owner,
      lastUpdatedAt: state.updatedAt,
      recoveredBy: (config && config.owner) || null,
    });
    recovered.push({ id, reason: 'task-orphaned-daemon-restart' });
  }

  return recovered;
}

module.exports = { shouldScanOrphans, orphanScan, queuedIds };
