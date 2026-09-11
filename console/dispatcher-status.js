'use strict';

// computeDispatcherStatus(daemonEvents, { isAlive, now, killGraceMs }) -- dispatcher.js's own `dispatcher-idle-no-
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
// that can tell a live drain from a dead one when nothing else can, and this module stays
// dependency-free -- see the module doc-comment below -- so it is INJECTED as `isAlive(pid)`,
// never required directly.
//
// Card #188 follow-up (2026-09-11): liveness alone still reads DRAINING FOREVER once the process
// that wrote the drain-start is gone AND its pid has since been reused by any other process on the
// box (`isAlive(reused pid)` is true -- it is a different process, but this walk has no way to
// know that), or when no pid resolves at all. A drain-start also carries its own bound: it can
// never legitimately still be waiting past `timeoutMs` (dispatcher.js's run() writes
// `dispatcher-stopped` the instant that wait resolves, win or lose) plus the kill grace the reap
// that follows actually uses (`killGraceMs`, resolveDrainKillGraceMs -- card #188 follow-up added
// the field to the write; a record from before that exists is read with the CALLER's injected
// `killGraceMs`, the grace THIS process's own config would apply). Past that bound, a drain that
// ran as designed has already written its conclusion, and under the installed unit
// (`TimeoutStopSec=2820`, scripts/daemon-install.sh) a process that has not is SIGKILLed at most
// 60s later -- so the bound is checked FIRST and, when it fires, short-circuits straight to
// 'stopped'/diedDraining without ever consulting `isAlive`. That verdict means 'the drain overran
// its own bound with no conclusion recorded', not a measured death. It applies ONLY when every
// input it needs is actually known: `now`, `Date.parse(ev.ts)`, `ev.timeoutMs` and a grace must
// each be a finite number (field-by-field detail below); missing any one of them falls through to
// the liveness read exactly as before. Three residual gaps the bound does not
// close, stated rather than left implicit: a drain that is genuinely still within its own bound
// and whose pid has already been reused still reads 'draining' (this is the SAME "no isAlive/no
// pid -> draining" default as before, now merely narrower); a record with no parseable `ts` has
// no age to bound, so it too falls through to liveness, and the bound is measured on the WALL
// clock (`now` minus `ts`) while the wait it bounds runs on the MONOTONIC one (dispatcher.js's
// awaitInFlight). A forward clock step, or a suspend (CLOCK_MONOTONIC does not advance while the
// machine sleeps, and neither does systemd's TimeoutStopSec), can put a live, still-waiting drain
// past this bound, and it then reads 'stopped'.
//
// `now`/`killGraceMs` are INJECTED, exactly like `isAlive`, for the same dependency-free reason:
// this module must never read the clock itself (a caller that cached `daemonEvents` and evaluated
// them later would get a silently different verdict from one call to the next) and must never
// import config.js directly (the callers already have it, and requiring it here would make a pure
// event-array function depend on this process's SPO_* environment, which config.js reads at
// require time). A caller that omits `now`
// gets the pre-bound behaviour exactly -- see the missing-input list below.
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
//   dispatcher-drain-start                -> THE BOUND (checked first, before any pid/isAlive
//                                              logic): applies only when `now` (injected), the
//                                              event's own `Date.parse(ev.ts)`, and `ev.timeoutMs`
//                                              are all finite numbers (`ev.timeoutMs` also >= 0),
//                                              AND a grace is resolvable --
//                                              `ev.killGraceMs` if it is a finite number >= 0,
//                                              else the injected `killGraceMs` if IT is a finite
//                                              number >= 0 (a legacy record written before this
//                                              follow-up carries no `killGraceMs` of its own, so
//                                              the caller's config supplies it). When every one of
//                                              those resolves and
//                                              `now - Date.parse(ev.ts) > ev.timeoutMs + grace`:
//                                              {status: 'stopped', event: ev, diedDraining: true}
//                                              regardless of isAlive -- past its own wait bound
//                                              plus the reap's own kill grace, a drain that ran as
//                                              designed has already written its conclusion (run()
//                                              writes `dispatcher-stopped` the moment the wait
//                                              ends, before any kill or reap even starts), so an
//                                              unconcluded one is read as stopped; residual gaps
//                                              in the header. Any
//                                              missing input (no `now` injected, no parseable
//                                              `ts`, a non-finite/absent `timeoutMs`, or no
//                                              resolvable grace) skips the bound entirely and
//                                              falls through to the liveness read below -- a
//                                              future `ts` (negative age) is always INSIDE the
//                                              bound, never past it, so it never short-circuits.
//                                            Otherwise (the bound did not fire, or could not be
//                                              applied), liveness decides exactly as before card
//                                              #188's follow-up: pid known and isAlive(pid) ===
//                                              false ->
//                                              {status: 'stopped', event: ev, diedDraining: true}
//                                              -- a drain-start is written only after requestDrain
//                                              accepted a drain (dispatcher.js's run(), gated on
//                                              `drainRequest`), and this process is provably gone
//                                              with no dispatcher-stopped recorded.
//                                            otherwise: {status: 'draining', event: ev} -- a live
//                                              wait, one whose liveness cannot be checked (no
//                                              isAlive injected, or no pid resolvable), or one
//                                              whose bound cannot be evaluated -- the residual gap
//                                              named above: a drain still inside its own bound
//                                              whose pid has been reused reads 'draining' here,
//                                              same as it always has.
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
function computeDispatcherStatus(daemonEvents, { isAlive, now, killGraceMs } = {}) {
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
      // THE BOUND (card #188 follow-up) -- checked BEFORE any pid/isAlive logic, and entirely
      // independent of it: past its own `timeoutMs` plus the reap's kill grace, a drain that ran
      // as designed has already written its conclusion, so an unconcluded one is read as stopped
      // whatever `isAlive` would say about a pid that may since have been reused (residual gaps:
      // module header). Requires every input to be a real, usable number --
      // partial information never partially applies the bound, it just skips it.
      const tsMs = typeof ev.ts === 'string' ? Date.parse(ev.ts) : NaN;
      const grace = Number.isFinite(ev.killGraceMs) && ev.killGraceMs >= 0 ? ev.killGraceMs
        : Number.isFinite(killGraceMs) && killGraceMs >= 0 ? killGraceMs
        : null;
      if (Number.isFinite(now) && Number.isFinite(tsMs) && Number.isFinite(ev.timeoutMs) && ev.timeoutMs >= 0 && grace !== null) {
        if (now - tsMs > ev.timeoutMs + grace) {
          return { status: 'stopped', event: ev, diedDraining: true };
        }
      }
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
