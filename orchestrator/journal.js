'use strict';
// Append-only journal I/O for one task's runtime directory (journal/<id>/).
//
//   journal.jsonl - one JSON object per line: {ts, state, event, ...detail}. Never rewritten.
//   ledger.md     - one line per DIAGNOSE attempt ("attempt N | root cause | outcome") plus one
//                   line per VALIDATE REJECT ("validate-reject N | <reasons> | outcome") --
//                   action 1.6, see appendLedgerLine's own `kind` parameter.
//   state.json    - current state + counters, overwritten on every transition (a snapshot,
//                   not a log -- the console reads it for the "current" columns).
//   report.md     - written once, only when a task is PARKED.
//
// This module never decides anything; it only records what the state machine already decided.
//
// THE taskDir SINGLE-WRITER INVARIANT (action 6.3, written down here so every scanner can find
// it) -- restated for the CROSS-PROCESS arrangement action 6.3's own verification forced (see
// dispatcher.js's header): a scanner (orphan-scan.js's orphanScan, park-loop.js's unparkScan, or
// anything else that walks journal/ rather than being handed one specific taskDir to run) may
// only WRITE into a taskDir that is either
//   (a) terminal -- state.json's state is DONE, PARKED, or ABANDONED, or
//   (b) whose owner is dead -- no live process (a worker, or pre-6.3 the daemon itself) still
//       holds it, per orphan-scan.js's own pid-liveness check.
//
// THIS INVARIANT NOW CROSSES A PROCESS BOUNDARY. Blocking `claude` calls inside the scan cycle
// (intake.js's callIntakeStepWithRotation, reached from auto-triage) measured at 3-3.5 minutes on
// the live daemon's own journal -- long enough that running the scans inside the dispatcher's own
// loop would freeze worker-slot refills, timer service, and SIGTERM handling for that whole
// window (see dispatcher.js's header for the full measurement). So the scans now run in a
// SEPARATE, long-lived SCANNER process (daemon.js --scanner, state-machine.js's runForever) that
// the dispatcher spawns and supervises, and "not owned by a live worker" -- case (b)'s own
// sub-question -- is something the scanner's own process CANNOT answer from memory: the
// live-worker table lives in the DISPATCHER's memory, not the scanner's.
//
// So the dispatcher PUBLISHES it: `writeLiveWorkerIds(journalRoot, ids)` writes
// <journalRoot>/live-workers.json, atomically (tmp-in-the-same-dir + rename, the exact idiom
// writeState above already uses), every time a worker is spawned or its exit is handled -- see
// dispatcher.js's own `publishLiveWorkerIds`. The scanner reads it fresh with
// `readLiveWorkerIds(journalRoot)` at the top of EVERY scan cycle (state-machine.js's
// runScanCycle) and hands the result to orphanScan as `liveWorkerIds` -- see orphan-scan.js's own
// comment on that parameter for what it protects.
//
// STALENESS, reasoned in both directions, because a file read by one process and written by
// another is stale by construction the instant after it is read:
//   - File says a task IS live, but the worker actually just died (the file hasn't caught up to
//     the dispatcher's own in-memory `live.delete(id)` yet) -- SAFE. orphanScan simply skips this
//     task for ONE MORE scan cycle; the next read picks up the dispatcher's now-current write, and
//     nothing was lost -- a bounded delay in recovery, not a correctness violation. This is the
//     direction the file exists to create ON PURPOSE: the dispatcher always finishes its own
//     synchronous crash-repark (buildCtx/finalizePark, still dispatcher-side -- see
//     dispatcher.js's handleExit) and only THEN rewrites the file to drop the id, so by the time
//     an outside reader can ever see the id missing, that task's terminal state is ALREADY durable
//     on disk. A scanner that raced the file update into this exact window still lists the id as
//     live and defers, never touching a task the dispatcher is mid-reparking.
//   - File says a task is NOT live, but the worker is actually still running (a fresh spawn whose
//     publish hasn't landed yet) -- also safe, but for a DIFFERENT reason: this is caught by
//     orphanScan's PRIMARY mechanism, not by this file at all. A genuinely live worker's pid
//     answers `isAlive(ownerPid)` truthfully regardless of what the file says, and orphanScan
//     checks that FIRST (`if (isAlive(ownerPid)) continue`) -- the file is belt-and-braces for the
//     narrow crash-handling window above, never the sole thing standing between a live task and a
//     stray repark. This is exactly what the invariant's case (b) already said before this file
//     existed: pid-liveness is the primary answer to "is this owned"; the live-workers file only
//     covers the moment pid-liveness alone would give the WRONG answer (a pid that just died but
//     whose task the dispatcher has not finished reparking).
// The file being READ ONCE PER CYCLE (never cached, per the instruction that produced it) is what
// keeps the first direction bounded to one cycle's staleness rather than compounding indefinitely.
//
// THE INVARIANT ALSO HAS A NAMED EXCEPTION, predating this action: C5's reconciler
// (park-loop.js's reconcileExternalClosure, called from inside unparkScan's own per-task loop)
// writes `externallyResolved` into the state.json of a task whose state is PARKED or ABANDONED.
// That COMPLIES with the invariant above (both are terminal states, case (a)) -- but it is worth
// naming explicitly rather than leaving the invariant to read as "scanners never write, full
// stop", which would be false and would mislead the next person extending one of these scanners.
// A terminal taskDir is not "owned" by anything in the sense case (b) cares about (no process is
// mid-transition inside it), so more than one scanner-process writer touching it sequentially is
// safe by construction -- each write is a small, self-contained patch (writeState's own
// tmp+rename atomicity) that never assumes it is the only writer that has ever touched the file,
// only that nothing else is writing it AT THIS INSTANT. unparkScan's own abandon branch is a
// second, related example worth citing here: it re-reads state.json from disk immediately before
// writing the ABANDONED transition, rather than spreading the in-memory snapshot captured earlier
// in the SAME loop iteration -- because reconcileExternalClosure may have already written
// `externallyResolved` to that same file earlier in that same cycle, and spreading the stale
// in-memory copy would silently drop it. Any future scanner touching a terminal taskDir more than
// once per pass should follow the same re-read-before-write discipline, not the
// spread-the-snapshot one.

const fs = require('fs');
const path = require('path');

function appendEvent(taskDir, state, event, detail = {}) {
  const record = { ts: new Date().toISOString(), state, event, ...detail };
  fs.appendFileSync(path.join(taskDir, 'journal.jsonl'), JSON.stringify(record) + '\n');
}

// A daemon-level counterpart to appendEvent, for events that belong to no single task -- auto-
// pull.js's `auto-pull` cycle summary, lock.js/daemon.js's lock-takeover events, and, as of
// action 6.3, dispatcher.js's `worker-spawn`/`worker-exit`/`parked` (crash repark) lines. Lives at
// <journalRoot>/daemon.jsonl, sibling to the per-task journal/<id>/ directories, same append-only
// shape minus the `state` field (there is no state machine involved).
//
// MULTI-PROCESS POLICY (action 6.3, decided and measured, not assumed): daemon.jsonl is now
// written by MORE than one process at once -- the dispatcher's own process AND every worker it
// spawns, all appending to the same file, concurrently, for as long as their lifetimes overlap.
// The chosen policy is: keep this function exactly as it already is (a single fs.appendFileSync
// call per event, no locking, no queueing, no relay-through-the-parent) and keep every event's
// detail SMALL. This was action 6.1's own verification, not a fresh assumption for 6.3: 8
// concurrent processes x 400 appendDaemonEvent calls each, at 100 B / 2 KB / 40 KB per line,
// produced 3200/3200 lines present and 0 unparsable AT EVERY SIZE -- see
// test/journal-concurrent-append.test.js for the pinned, real-child-process version of that
// measurement. The mechanism this rests on: fs.appendFileSync opens O_APPEND and issues exactly
// ONE write(2) syscall per call, and POSIX guarantees a single write(2) to an O_APPEND-opened
// regular file on a LOCAL filesystem is atomic with respect to other writers -- the kernel seeks
// to the current end-of-file and performs the write as one indivisible operation, so two
// concurrent small appends can never interleave byte-for-byte into a torn/unparsable line the way
// two `open()` + `write()` pairs without O_APPEND could.
//
// The plan explicitly asked to "pick one" over the alternative (relaying every worker event
// through the dispatcher's own exit-summary handling instead of letting workers write directly) --
// this is the one picked, ON EVIDENCE: relaying would mean a worker's own `worker-spawn`-adjacent
// events (there are none today, but a future one is plausible) or mid-run daemon-level events
// would have no path to daemon.jsonl at all without inventing an IPC channel this project has no
// other use for, purely to avoid a race the measurement above already shows does not exist at the
// sizes this project actually produces.
//
// TWO CAVEATS, both load-bearing and both explicitly scoped to what was actually measured:
//   1. This is single-write(2)-atomicity, not "large messages are safe" -- a write() large enough
//      to force the kernel to split it into multiple underlying operations (not observed at 40 KB
//      on this filesystem, but never guaranteed at unbounded size by POSIX) could still tear.
//      This is exactly why park detail on this file stays SMALL: finalizePark's own daemon.jsonl
//      'parked' line is `{id, reason, lastState}` -- three short fields, not the full detail
//      object report.md/journal.jsonl already carry in full. The full detail belongs in the
//      per-task journal (single-writer, one process at a time, no atomicity question at all),
//      never duplicated at whatever size onto the one file every worker shares.
//   2. This rests on LOCAL-FILESYSTEM O_APPEND semantics. It would NOT survive the journal root
//      being moved onto NFS (or another network filesystem) -- NFS's O_APPEND support is
//      famously not atomic across clients (well-documented kernel/NFS-protocol behaviour: an
//      NFS client's "seek to end, then write" is not a single atomic RPC the way a local
//      write(2) is a single atomic syscall), so two processes on two different NFS clients
//      appending at once CAN interleave. journal/ has never lived anywhere but a local disk in
//      this project's history; if that ever changes, this whole policy needs re-deriving, not
//      just re-measuring on the new mount.
function appendDaemonEvent(journalRoot, event, detail = {}) {
  fs.mkdirSync(journalRoot, { recursive: true });
  const record = { ts: new Date().toISOString(), event, ...detail };
  fs.appendFileSync(path.join(journalRoot, 'daemon.jsonl'), JSON.stringify(record) + '\n');
}

// `kind` defaults to 'attempt' (DIAGNOSE's own lines, unchanged shape) -- action 1.6 passes
// 'validate-reject' for a VALIDATE REJECT so the two are visually distinct in ledger.md while
// keeping the same readable "<kind> N | <text> | <outcome>" one-liner-per-attempt shape, and
// without touching any existing DIAGNOSE call site or the ledger parsing tests already rely on.
function appendLedgerLine(taskDir, attemptN, rootCause, outcome, kind = 'attempt') {
  fs.appendFileSync(path.join(taskDir, 'ledger.md'), `${kind} ${attemptN} | ${rootCause} | ${outcome}\n`);
}

// Atomic within a filesystem: write to a tmp file in the SAME directory as state.json, then
// rename over it. A crash or kill -9 mid-write leaves the tmp file behind (harmless, ignored by
// every reader) but state.json itself is always either the old complete snapshot or the new
// complete snapshot -- never truncated. orphan-scan.js and every daemon restart depend on that.
function writeState(taskDir, snapshot) {
  const target = path.join(taskDir, 'state.json');
  const tmp = path.join(taskDir, `.state.json.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp was never created, or rename already moved it -- nothing to clean up either way.
    }
    throw err;
  }
}

// liveWorkersPath/writeLiveWorkerIds/readLiveWorkerIds -- action 6.3's cross-process live-worker
// publication, <journalRoot>/live-workers.json, `{ids: [...], updatedAt}`. See this file's own
// header (the taskDir single-writer invariant section) for the full design and the staleness
// reasoning in both directions; this is just the I/O.
//
// Same atomic tmp-then-rename idiom as writeState above (and accounts.js's own writeState for its
// pool state.json) -- a reader must never see a half-written file, and it is dispatcher.js's own
// job to call this OFTEN (every spawn, every exit), not this function's job to be cheap about
// anything more elaborate than "replace the whole file".
function liveWorkersPath(journalRoot) {
  return path.join(journalRoot, 'live-workers.json');
}

function writeLiveWorkerIds(journalRoot, ids) {
  fs.mkdirSync(journalRoot, { recursive: true });
  const target = liveWorkersPath(journalRoot);
  const tmp = path.join(journalRoot, `.live-workers.json.${process.pid}.${Date.now()}.tmp`);
  const payload = { ids: Array.from(ids).sort(), updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp was never created, or rename already moved it -- nothing to clean up either way.
    }
    throw err;
  }
}

// readLiveWorkersRaw(journalRoot) -> {present, ids, updatedAt} -- action 6.7. Same tolerant read
// as readLiveWorkerIds below, but WITHOUT collapsing "no dispatcher has ever published this
// file" into the same shape as "a dispatcher published it and it is empty right now". The one
// caller this file had before 6.7 (state-machine.js's runScanCycle -> orphanScan) never needed
// that distinction -- an empty Set means "treat nothing as live" either way, for orphanScan's
// purposes. `spo status`'s worker section (bin/spo's cmdStatus, orchestrator/worker-status.js)
// does need it: reporting a missing file as "0 workers running" is indistinguishable from "no
// dispatcher has ever run here", and the action's own spec calls that out by name as a rendering
// bug to avoid, not a hypothetical one. Rather than change readLiveWorkerIds's return shape out
// from under its one real caller, this is a second, raw read that readLiveWorkerIds now
// delegates to -- one parse path, two views of the same file.
function readLiveWorkersRaw(journalRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(liveWorkersPath(journalRoot), 'utf8'));
    return {
      present: true,
      ids: new Set(Array.isArray(raw && raw.ids) ? raw.ids : []),
      updatedAt: raw && typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch {
    return { present: false, ids: new Set(), updatedAt: null };
  }
}

// Tolerant read -> Set<string>: a missing file (no dispatcher has ever run against this journal
// root, or this is a --once/--worker/--scanner-only invocation with no dispatcher at all) or an
// unparsable one (read mid-rename is impossible thanks to the atomic write above, but a read of a
// file this process does not own should never throw regardless) both mean "no known live workers"
// -- the same "absence is not an error" posture this module already applies to appendDaemonEvent
// and to orphan-scan.js's own owner-shape tolerance.
function readLiveWorkerIds(journalRoot) {
  return readLiveWorkersRaw(journalRoot).ids;
}

// benchReinstallOwedPath/writeBenchReinstallOwed/readBenchReinstallOwed/clearBenchReinstallOwed --
// action B1.4 R1 (post-verification, third pass): the durable "a bench reinstall is owed" record,
// <journalRoot>/bench-reinstall-owed.json, same atomic tmp-then-rename idiom as
// writeLiveWorkerIds/writeState above. steps/scripted.js's realFinish writes this instead of
// parking when the bounded bench-idle wait (waitForBenchIdle) times out with the bench still
// busy -- a card whose PR has already merged must not sit terminally parked over a shared
// resource's ordinary use (a human's routine bench lease can run up to 120 minutes,
// worker.ts:111's own MAX_LEASE_MINUTES, dwarfing the 15-minute wait) -- so FINISH completes
// normally (board move, comment, worktree remove, DONE) and the debt is recorded here instead.
// steps/scripted.js's realWorktree (payBenchReinstallDebtIfOwed) reads/clears it the NEXT time
// any card reaches WORKTREE and finds the bench idle -- round 4: paid from inside a worker's own
// existing product-repo lock span, never a separate daemon scan timer (round 3's
// orchestrator/bench-reconcile.js, since deleted -- it held that same lock from a THIRD process
// the mutex's own wait-bound derivation assumes cannot exist).
//
// A SINGLE record, not a queue keyed per-card: bash scripts/bench-install.sh always rebuilds from
// WHATEVER config.productRepo is currently fast-forwarded to, so a SECOND bench-touching card
// deferring during the same busy window does not need a second entry -- reinstalling once, from
// the LATEST fast-forwarded checkout, already covers every merge that landed since the debt was
// first recorded. Overwriting (writeFileSync + rename, never append) is what keeps the record
// from accumulating duplicates for free -- a second write during the same busy window simply
// replaces the first with the newer mergeSha, which is also the more useful one to retry with.
//
// "A deferred reinstall that never happens is the original defect" (this action's own report) --
// so this file is never unlinked on completion, only overwritten with an explicit {owed: false}
// record (clearBenchReinstallOwed), so a maintainer inspecting it directly can always tell "never
// owed" (file absent) apart from "owed, then paid" (file present, owed: false) apart from "owed
// right now" (file present, owed: true) -- and readBenchReinstallOwed's own null-on-anything-else
// tolerance (same posture as readLiveWorkerIds above) means a reader never has to special-case a
// half-written or missing file, only ever the three meaningful shapes above.
function benchReinstallOwedPath(journalRoot) {
  return path.join(journalRoot, 'bench-reinstall-owed.json');
}

function writeBenchReinstallOwed(journalRoot, detail = {}) {
  fs.mkdirSync(journalRoot, { recursive: true });
  const target = benchReinstallOwedPath(journalRoot);
  const tmp = path.join(journalRoot, `.bench-reinstall-owed.json.${process.pid}.${Date.now()}.tmp`);
  const payload = { ...detail, owed: true, recordedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp was never created, or rename already moved it -- nothing to clean up either way.
    }
    throw err;
  }
  return payload;
}

// Tolerant read -> the record object when (and only when) `owed === true`, else `null` -- a
// missing file (nothing has ever been deferred against this journal root), an unparsable one
// (impossible mid-rename thanks to the atomic write above, but tolerated regardless, same posture
// readLiveWorkerIds already takes), and a present-but-cleared record ({owed: false}) all collapse
// to the same "nothing owed right now" answer a caller actually needs.
function readBenchReinstallOwed(journalRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(benchReinstallOwedPath(journalRoot), 'utf8'));
    return raw && raw.owed === true ? raw : null;
  } catch {
    return null;
  }
}

function clearBenchReinstallOwed(journalRoot, detail = {}) {
  fs.mkdirSync(journalRoot, { recursive: true });
  const target = benchReinstallOwedPath(journalRoot);
  const tmp = path.join(journalRoot, `.bench-reinstall-owed.json.${process.pid}.${Date.now()}.tmp`);
  const payload = { ...detail, owed: false, clearedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp was never created, or rename already moved it -- nothing to clean up either way.
    }
    throw err;
  }
  return payload;
}

function writeReport(taskDir, { id, reason, lastState, ts, detail }) {
  const body = [
    `# Parked: ${id}`,
    '',
    `reason: ${reason}`,
    `lastState: ${lastState}`,
    `timestamp: ${ts}`,
    '',
    '## detail',
    '```json',
    JSON.stringify(detail || {}, null, 2),
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(taskDir, 'report.md'), body);
}

module.exports = {
  appendEvent,
  appendDaemonEvent,
  appendLedgerLine,
  writeState,
  writeReport,
  liveWorkersPath,
  writeLiveWorkerIds,
  readLiveWorkerIds,
  readLiveWorkersRaw,
  benchReinstallOwedPath,
  writeBenchReinstallOwed,
  readBenchReinstallOwed,
  clearBenchReinstallOwed,
};
