'use strict';

// computeDispatcherStatus(daemonEvents) -- dispatcher.js's own `dispatcher-idle-no-healthy-
// accounts` / `dispatcher-healthy-accounts-returned` pair (fillSlots's poolIdleDetail) is EDGE-
// TRIGGERED: one line when the pool first has zero healthy accounts, one line when it recovers,
// nothing in between (no matter how many fillSlots passes happen while still idle). So "is the
// dispatcher idle right now" is answered by walking the tail backwards for whichever of the two
// event names comes LAST -- an idle event with no later recovery event means still idle; a
// recovery event, or no matching event at all, means nothing to report. Same "walk backwards to
// the most recent relevant marker" shape as retry-channel.js's summarizeUnparkScanTail, for the same
// reason: this is daemon.jsonl's OWN edge history, not a poll of current pool health (`spo
// status`'s own account rows already do that separately, from the pool's state.json).
//
// Card #164: a dead PROCESS is a fourth marker, not a variant of "idle" -- `dispatcher-stopped`
// (action 3.3's single stop-path convergence point in dispatcher.js's run(), written on
// drain/stop-requested/either crash breaker) means there is no dispatcher left to be idle or
// healthy, so it must outrank a standing idle edge rather than being read as one. PRECEDENCE,
// walking backwards from the tail, first match wins -- renamed from computeDispatcherIdleStatus
// because it now reports a status, not just an idle flag:
//   dispatcher-healthy-accounts-returned  -> null (healthy right now, nothing to report)
//   dispatcher-start                      -> null (hard boundary -- see the comment on this
//                                            branch below; also what makes a `dispatcher-stopped`
//                                            followed by a fresh `dispatcher-start` read as
//                                            running again, for free, since the start is then the
//                                            newest of the two and this walk never reaches the
//                                            stop beneath it)
//   dispatcher-stopped                    -> {status: 'stopped', event: ev} -- the process is dead
//   dispatcher-idle-no-healthy-accounts   -> {status: 'idle', event: ev}
//   (falls off the end)                   -> null
//
// Card #186: shared into its own module (moved verbatim out of bin/spo) so bin/spo's `spo status`
// and console/collect.js's dashboard deck (applyWorkerStats -- the same liveness question the
// deck's Workers tile answers) both read one derivation instead of each carrying its own copy.
function computeDispatcherStatus(daemonEvents) {
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
    // reasoning is why it must be checked before `dispatcher-stopped` is even reachable in a later
    // (i.e. earlier-in-the-walk) iteration: once a start has been seen, nothing before it -- stopped
    // or idle alike -- describes the CURRENT process.
    if (ev.event === 'dispatcher-start') return null;
    if (ev.event === 'dispatcher-stopped') return { status: 'stopped', event: ev };
    if (ev.event === 'dispatcher-idle-no-healthy-accounts') return { status: 'idle', event: ev };
  }
  return null;
}

module.exports = { computeDispatcherStatus };
