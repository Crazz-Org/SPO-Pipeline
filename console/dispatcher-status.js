'use strict';

// computeDispatcherStatus(daemonEvents, { isAlive }) -- dispatcher.js's own `dispatcher-idle-no-
// healthy-accounts` / `dispatcher-healthy-accounts-returned` pair (fillSlots's poolIdleDetail) is
// EDGE-TRIGGERED: one line when the pool first has zero healthy accounts, one line when it
// recovers, nothing in between (no matter how many fillSlots passes happen while still idle). So
// "is the dispatcher idle right now" is answered by walking the tail backwards for whichever of
// the two event names comes LAST -- an idle event with no later recovery event means still idle;
// a recovery event, or no matching event at all, means nothing to report. Same "walk backwards to
// the most recent relevant marker" shape as retry-channel.js's summarizeUnparkScanTail, for the same
// reason: this is daemon.jsonl's OWN edge history, not a poll of current pool health (`spo
// status`'s own account rows already do that separately, from the pool's state.json).
//
// Card #164: a dead PROCESS is a fourth marker, not a variant of "idle" -- `dispatcher-stopped`
// (action 3.3's single stop-path convergence point in dispatcher.js's run(), written on
// drain/stop-requested/either crash breaker) means there is no dispatcher left to be idle or
// healthy, so it must outrank a standing idle edge rather than being read as one.
//
// Card #188: `dispatcher-drain-start` is written BEFORE the (up to 45-minute) wait for in-flight
// cards, and the process can die inside that wait -- dispatcher.js's run() drain block itself
// (the code between this write and the `await awaitInFlight` call) writes no FURTHER event of the
// kind this walk reads until `dispatcher-stopped`/`dispatcher-drain-end`, both written only AFTER
// the wait resolves (ordinary worker-exit/scanner-exit events can still land from elsewhere while
// the wait is in progress -- they are not part of this precedence walk at all). Before this card
// an unconcluded drain-start fell through every branch
// below and read as null -- a region nothing could read. A drain-start is now its own branch, and
// it is NOT automatically 'stopped': `dispatcher-stopped` is the durable fact that the process
// finished shutting down, and a live drain must never be misread as one (`spo status` printing
// STOPPED while a card is still mid-park would tell an operator it is safe to act on a process
// that is still there -- the exact inversion #164 exists to prevent). Liveness is the only thing
// that can tell a live drain from a dead one, and this module stays dependency-free -- see the
// module doc-comment below -- so it is INJECTED as `isAlive(pid)`, never required directly.
// Without an `isAlive` function (or without a resolvable pid) the safe default is 'draining':
// never claim 'stopped' without positive evidence the process is gone.
//
// PRECEDENCE, walking backwards from the tail, first match wins -- renamed from
// computeDispatcherIdleStatus because it now reports a status, not just an idle flag:
//   dispatcher-healthy-accounts-returned  -> null (healthy right now, nothing to report)
//   dispatcher-start                      -> null (hard boundary -- see the comment on this
//                                            branch below; also what makes a `dispatcher-stopped`
//                                            or a resolved `dispatcher-drain-start` followed by a
//                                            fresh `dispatcher-start` read as running again, for
//                                            free, since the start is then the newest of the two
//                                            and this walk never reaches the marker beneath it)
//   dispatcher-drain-start                -> pid known and isAlive(pid) === false:
//                                              {status: 'stopped', event: ev, diedDraining: true}
//                                              -- a drain-start is written only after requestDrain
//                                              accepted a drain (dispatcher.js's run(), gated on
//                                              `drainRequest`), and this process is provably gone
//                                              with no dispatcher-stopped recorded.
//                                            otherwise: {status: 'draining', event: ev} -- a live
//                                              wait, or one whose liveness cannot be checked
//                                              (no isAlive injected, or no pid resolvable).
//                                            pid resolution: `ev.pid` if it is a positive integer
//                                              (card #188 added the field); else the pid of the
//                                              nearest EARLIER `dispatcher-start` in the array (a
//                                              legacy record from before this card, e.g. a daemon
//                                              already draining during the very deploy that
//                                              installs this code); else unknown.
//   dispatcher-stopped                    -> {status: 'stopped', event: ev} -- the process is dead
//   dispatcher-idle-no-healthy-accounts   -> {status: 'idle', event: ev}
//   (falls off the end)                   -> null
//
// Card #186: shared into its own module (moved verbatim out of bin/spo) so bin/spo's `spo status`
// and console/collect.js's dashboard deck (applyWorkerStats -- the same liveness question the
// deck's Workers tile answers) both read one derivation instead of each carrying its own copy.
// Kept dependency-free deliberately: liveness needs a real `process.kill(pid, 0)` probe
// (orchestrator/lock.js's `processAlive`/`pidExists` -- the real callers (bin/spo's `cmdStatus`,
// console/collect.js's `applyWorkerStats`) inject `pidExists`, which reads EPERM as "still there"
// rather than `processAlive`'s "gone", the correct answer for a pid this process may not own), and
// requiring that module here would make a pure event-array
// function reach out to the OS on every call, including in tests that hand it synthetic events
// with no real pid behind them. Callers inject `isAlive` instead.
function computeDispatcherStatus(daemonEvents, { isAlive } = {}) {
  for (let i = daemonEvents.length - 1; i >= 0; i--) {
    const ev = daemonEvents[i];
    if (!ev) continue;
    if (ev.event === 'dispatcher-healthy-accounts-returned') return null;
    // Verification fix: `dispatcher-start` (dispatcher.js's run(), see its own comment) is a hard
    // boundary for this walk. The idle flag driving these two events lives in the dispatcher's
    // MEMORY, so an idle edge written by an earlier process says nothing about the current one --
    // and because a restart resets that flag to false, the matching `returned` edge is never
    // written after a restart at all. Without this line, one idle edge plus one restart (this
    // project restarts the daemon on every merge) made `spo status` claim IDLE forever. The same
    // reasoning is why it must be checked before `dispatcher-stopped` (or a drain-start) is even
    // reachable in a later (i.e. earlier-in-the-walk) iteration: once a start has been seen,
    // nothing before it -- stopped, draining or idle alike -- describes the CURRENT process.
    if (ev.event === 'dispatcher-start') return null;
    if (ev.event === 'dispatcher-drain-start') {
      let pid = Number.isInteger(ev.pid) && ev.pid > 0 ? ev.pid : null;
      if (pid === null) {
        for (let j = i - 1; j >= 0; j--) {
          const earlier = daemonEvents[j];
          if (earlier && earlier.event === 'dispatcher-start') {
            pid = Number.isInteger(earlier.pid) && earlier.pid > 0 ? earlier.pid : null;
            break;
          }
        }
      }
      if (pid !== null && typeof isAlive === 'function' && isAlive(pid) === false) {
        return { status: 'stopped', event: ev, diedDraining: true };
      }
      return { status: 'draining', event: ev };
    }
    if (ev.event === 'dispatcher-stopped') return { status: 'stopped', event: ev };
    if (ev.event === 'dispatcher-idle-no-healthy-accounts') return { status: 'idle', event: ev };
  }
  return null;
}

module.exports = { computeDispatcherStatus };
