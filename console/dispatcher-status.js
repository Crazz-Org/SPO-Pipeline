'use strict';

// computeDispatcherStatus(daemonEvents, { isAlive, now, hostUptimeNowMs, killGraceMs }) -- dispatcher.js's own `dispatcher-idle-no-
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
// input it needs is actually known: a usable age reading (see below), `ev.timeoutMs` and a grace
// must each be a finite number (field-by-field detail below); missing any one of them falls
// through to the liveness read exactly as before. Residual gaps the bound does not close, stated
// rather than left implicit: a drain that is genuinely still within its own bound and whose pid
// has already been reused still reads 'draining' (this is the SAME "no isAlive/no pid -> draining"
// default as before, now merely narrower).
//
// Card #208: the age reading itself has TWO paths, preferred and legacy. `ev.hostUptimeAtMs`
// (dispatcher.js's write, `os.uptime() * 1000` -- seconds since boot converted to ms) is the
// PREFERRED one whenever the event carries it: `os.uptime()` is monotonic (never steps backward or
// forward the way `Date.now()` has been measured doing on this box -- see the WALL-clock paragraph
// below) AND, unlike `process.hrtime.bigint()`/`monotonicNowMs()` (orchestrator/monotonic-clock.js,
// whose own header says an hrtime reading is "meaningless outside the ONE process that read it"),
// comparable across processes on the same boot -- exactly what this comparison needs, since the
// event is written by the daemon and read by a DIFFERENT process (`spo status`, the dashboard's
// collectAll). The bound then reads `hostUptimeNowMs - ev.hostUptimeAtMs > ev.timeoutMs + grace`, where
// `hostUptimeNowMs` is injected exactly like `now` (see below) -- a caller that does not inject it
// skips the uptime bound entirely (falls through to the liveness read) rather than silently
// re-deriving an age from wall time, which would defeat the point for exactly the events this path
// exists to fix. `hostUptimeNowMs` LESS than `ev.hostUptimeAtMs` means a reboot happened between the write
// and this read -- uptime resets on boot, so that ordering can only occur across a reboot, and
// nothing survives a reboot: the drain, and the whole process that was running it, is certainly
// over, so this reads 'stopped'/diedDraining unconditionally, without ever falling into the
// pid/isAlive logic below (a pid from a previous boot is not the same process as whatever now holds
// that pid number, so `isAlive(pid)` could not answer this question even if it were asked).
//
// LEGACY events -- written before card #208, so carrying no `ev.hostUptimeAtMs` at all -- fall back to
// EXACTLY today's wall-clock comparison (`now - Date.parse(ev.ts) > ev.timeoutMs + grace`,
// `now`/`Date.parse(ev.ts)` each required to be finite). The wait it bounds, `awaitInFlight` in
// dispatcher.js, runs on the MONOTONIC clock (`monotonicNowMsFn()`; that function's own comment:
// "never Date.now(): a bound that a clock step could double or erase is not a bound"), so a
// FORWARD WALL-CLOCK STEP during a live LEGACY drain can put it past this fallback bound before
// the monotonic wait has actually expired, reading a still-running drain as 'stopped'. A record
// with no parseable `ts` has no age to bound at all here either, and falls through to liveness
// exactly as before.
//
// Scope of what card #208 actually closes (2026-09-12 fix pass, F7): the forward-WALL-CLOCK-STEP
// half of this gap is closed for the PREFERRED path -- `os.uptime()` never gets the NTP-style step
// corrections this box's own `Date.now()` has been measured taking (see the PREFERRED paragraph
// above), so a record carrying `ev.hostUptimeAtMs` cannot be pushed past its bound by one. A HOST
// SUSPEND is NOT closed by either path, PREFERRED included, and this header must not claim it is:
// on a standard Linux kernel `/proc/uptime` (what `os.uptime()` reads) is `CLOCK_BOOTTIME`, which
// INCLUDES suspended time, while the monotonic wait this bound approximates is `CLOCK_MONOTONIC`
// (hrtime), which does not -- so a host suspending mid-drain would advance `ev.hostUptimeAtMs`'s
// reading but not the wait it is meant to track, on the PREFERRED path too. Measured (not
// reasoned): `CLOCK_BOOTTIME - CLOCK_MONOTONIC` held at -1.7 microseconds after 63 hours of uptime
// on this box -- consistent with either "this host has never suspended" or "WSL2 collapses the two
// clocks", and the measurement cannot tell those apart. Unverified, not refuted: treat a suspend
// during a live drain as a remaining residual on BOTH paths, not a closed gap on either.
//
// `now`/`hostUptimeNowMs`/`killGraceMs` are INJECTED, exactly like `isAlive`, for the same
// dependency-free reason: this module must never read a clock itself (a caller that cached
// `daemonEvents` and evaluated them later would get a silently different verdict from one call to
// the next) and must never import config.js directly (the callers already have it, and requiring
// it here would make a pure event-array function depend on this process's SPO_* environment, which
// config.js reads at require time). A caller that omits `now` and/or `hostUptimeNowMs`
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
//                                              logic). Card #208: two paths, PREFERRED then
//                                              LEGACY, either of which can short-circuit straight
//                                              to {status: 'stopped', event: ev, diedDraining:
//                                              true} (or, reboot only, that plus `rebooted: true`)
//                                              regardless of isAlive.
//                                              PREFERRED, when `ev.hostUptimeAtMs` is a finite number:
//                                              needs `hostUptimeNowMs` (injected) also finite, plus a
//                                              resolvable `ev.timeoutMs` (finite, >= 0) and grace
//                                              (`ev.killGraceMs` if finite >= 0, else the injected
//                                              `killGraceMs` if finite >= 0). `hostUptimeNowMs <
//                                              ev.hostUptimeAtMs` -> a reboot happened since the write ->
//                                              stopped/diedDraining/rebooted unconditionally, pid/
//                                              isAlive never consulted (see the header for why a
//                                              pre-reboot pid cannot answer this). Otherwise, when
//                                              `ev.timeoutMs`/grace resolve and `hostUptimeNowMs -
//                                              ev.hostUptimeAtMs > ev.timeoutMs + grace` ->
//                                              stopped/diedDraining. `hostUptimeNowMs` not injected, or
//                                              `ev.timeoutMs`/grace not resolvable, skips this path
//                                              (does NOT fall back to the legacy wall-clock path --
//                                              see the header) and falls through to liveness.
//                                              LEGACY, only when `ev.hostUptimeAtMs` is NOT a finite
//                                              number (a record from before card #208): applies
//                                              only when `now` (injected), the event's own
//                                              `Date.parse(ev.ts)`, and `ev.timeoutMs` are all
//                                              finite numbers (`ev.timeoutMs` also >= 0), AND a
//                                              grace is resolvable exactly as above. When those
//                                              resolve and `now - Date.parse(ev.ts) > ev.timeoutMs
//                                              + grace` -> stopped/diedDraining -- past its own
//                                              wait bound plus the reap's own kill grace, a drain
//                                              that ran as designed has already written its
//                                              conclusion (run() writes `dispatcher-stopped` the
//                                              moment the wait ends, before any kill or reap even
//                                              starts), so an unconcluded one is read as stopped;
//                                              residual gaps in the header. Any missing input (no
//                                              `now` injected, no parseable `ts`, a non-finite/
//                                              absent `timeoutMs`, or no resolvable grace) skips
//                                              this path too and falls through to liveness -- a
//                                              future `ts` (negative age) is always INSIDE this
//                                              bound, never past it, so it never short-circuits.
//                                            Otherwise (neither path fired, or neither could be
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
// resolveDrainGrace: the same "event's own grace wins, else the caller's injected config grace"
// resolution the PREFERRED (uptime) and LEGACY (wall-clock) bound paths both need -- factored out
// once rather than duplicated, since it does not depend on which age reading is in use.
function resolveDrainGrace(ev, killGraceMs) {
  return Number.isFinite(ev.killGraceMs) && ev.killGraceMs >= 0 ? ev.killGraceMs
    : Number.isFinite(killGraceMs) && killGraceMs >= 0 ? killGraceMs
    : null;
}

function computeDispatcherStatus(daemonEvents, { isAlive, now, hostUptimeNowMs, killGraceMs } = {}) {
  for (let i = daemonEvents.length - 1; i >= 0; i--) {
    const ev = daemonEvents[i];
    if (!ev) continue;
    if (ev.event === 'dispatcher-healthy-accounts-returned') return null;
    // Verification fix: `dispatcher-start` (dispatcher.js's run(), see its own comment) is a hard
    // boundary for this walk. The idle flag driving these two events lives in the dispatcher's
    // MEMORY, so an idle edge written by an earlier process says nothing about the current one --
    // and because a restart resets that flag to false, the matching `returned` edge is never
    // written after a restart at all. Without this line, one idle edge plus one restart (a deploy
    // -- a `git pull` that lands commits in the deploy checkout -- restarts a running daemon; a
    // GitHub merge alone restarts nothing) made `spo status` claim IDLE forever. The same
    // reasoning is why it must be checked before `dispatcher-stopped` (or a drain-start) is even
    // reachable in a later (i.e. earlier-in-the-walk) iteration: once a start has been seen,
    // nothing before it -- stopped, draining or idle alike -- describes the CURRENT process.
    if (ev.event === 'dispatcher-start') return null;
    if (ev.event === 'dispatcher-drain-start') {
      // THE BOUND (card #188 follow-up, card #208) -- checked BEFORE any pid/isAlive logic, and
      // entirely independent of it: past its own `timeoutMs` plus the reap's kill grace, a drain
      // that ran as designed has already written its conclusion, so an unconcluded one is read as
      // stopped whatever `isAlive` would say about a pid that may since have been reused (residual
      // gaps: module header). Requires every input to be a real, usable number -- partial
      // information never partially applies a bound, it just skips it.
      //
      // PREFERRED path (card #208): `ev.hostUptimeAtMs`, when present, is boot-relative and comparable
      // ACROSS PROCESSES on the same boot -- see the module header for why that beats both `ts`
      // (wall clock; steps on this box) and `monotonicNowMs()` (meaningless outside the writing
      // process). Only a record written before this card has no `ev.hostUptimeAtMs` at all; that is the
      // ONLY case that falls to the LEGACY wall-clock path below -- a record that has `ev.hostUptimeAtMs`
      // but for which the caller did not inject `hostUptimeNowMs` skips straight past both paths to the
      // liveness read, rather than silently re-deriving an age from `ts`.
      if (Number.isFinite(ev.hostUptimeAtMs)) {
        if (Number.isFinite(hostUptimeNowMs)) {
          if (hostUptimeNowMs < ev.hostUptimeAtMs) {
            // A reboot happened between the write and this read -- uptime resets on boot, so
            // "now" reading LESS than the event's own recorded uptime can only mean a reboot came
            // between them. Nothing survives a reboot: the drain, and the whole process running
            // it, is certainly gone. Read as stopped unconditionally, WITHOUT ever falling into
            // the pid/isAlive logic below -- a pid from a previous boot is not the same process as
            // whatever now holds that pid number (pids are reused across a reboot too), so
            // `isAlive(pid)` could not answer this question even if it were asked, and asking it
            // risks a false "still alive" off a coincidentally-live, unrelated process.
            return { status: 'stopped', event: ev, diedDraining: true, rebooted: true };
          }
          const grace = resolveDrainGrace(ev, killGraceMs);
          if (Number.isFinite(ev.timeoutMs) && ev.timeoutMs >= 0 && grace !== null) {
            if (hostUptimeNowMs - ev.hostUptimeAtMs > ev.timeoutMs + grace) {
              return { status: 'stopped', event: ev, diedDraining: true };
            }
          }
        }
      } else {
        // LEGACY residual (module header): this record predates card #208's `hostUptimeAtMs` field, so
        // the only age reading available is the wall clock -- exactly today's pre-#208 comparison,
        // kept unchanged, with the same wall-clock-vs-monotonic-wait gap the header now names as
        // applying ONLY to this path.
        const tsMs = typeof ev.ts === 'string' ? Date.parse(ev.ts) : NaN;
        const grace = resolveDrainGrace(ev, killGraceMs);
        if (Number.isFinite(now) && Number.isFinite(tsMs) && Number.isFinite(ev.timeoutMs) && ev.timeoutMs >= 0 && grace !== null) {
          if (now - tsMs > ev.timeoutMs + grace) {
            return { status: 'stopped', event: ev, diedDraining: true };
          }
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
