'use strict';

// computeDispatcherStatus(daemonEvents, { isAlive, now, hostUptimeNowMs, killGraceMs, monotonicNowMs, processStartUptimeMs }) --
// dispatcher.js's own `dispatcher-idle-no-
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
// through to the liveness read exactly as before. Residual gap the bound does not close, stated
// rather than left implicit at the time of this follow-up: a drain that is genuinely still within
// its own bound and whose pid has already been reused still read 'draining' (the SAME "no
// isAlive/no pid -> draining" default as before, now merely narrower). Card #219 (2026-09-14)
// later closed this specific gap ON LINUX ONLY -- see that card's own section further down for the
// pid-reuse check that reads such a case as 'stopped'/`pidReused: true` instead; on any other
// platform (`orchestrator/lock.js`'s `processStartUptimeMs` returns `null` there) it is still
// exactly this residual, unchanged.
//
// Card #208: the age reading itself has (as of card #219) THREE paths, tried in precedence order
// PREFERRED-MONOTONIC, then PREFERRED (uptime), then LEGACY (wall clock).
//
// PREFERRED-MONOTONIC (card #219's residual 1 -- "a host suspend during a drain"): `ev.monotonicAtMs`
// (dispatcher.js's write -- the SAME `monotonicNowMsFn()`/`monotonicNowMs()` reading `awaitInFlight`
// itself waits on) compared against the caller's injected `monotonicNowMs`. Node's own docs promise
// only that `hrtime` reads "an arbitrary time in the past" -- cross-PROCESS comparability is not a
// documented guarantee, and orchestrator/monotonic-clock.js's own header used to overclaim the
// opposite ("meaningless outside the ONE process that read it", "cannot be compared to another
// process's own monotonic clock"). Measured, card #219, this host (2026-09-14, Linux/WSL2,
// Node v22): two SEPARATE node processes reading `process.hrtime.bigint()` 56ms apart returned
// readings 56.4ms apart, and both tracked `/proc/uptime` -- i.e. on Linux, libuv's `uv_hrtime()` IS
// `clock_gettime(CLOCK_MONOTONIC)`, the SAME system-wide clock for every process on the box, not a
// per-process origin. That is a measured LINUX IMPLEMENTATION DETAIL, not a cross-platform Node
// guarantee, so this path is trusted only behind the plausibility check below, and it never counts
// suspended time the way `hostUptimeAtMs` does (below) -- unlike boottime, `CLOCK_MONOTONIC` is
// defined to exclude system suspend, which is exactly what lets it close the suspend residual where
// it applies.
//
// The plausibility check exists because this path is USED precisely where it disagrees with the
// uptime reading (that disagreement is what a suspend produces, and what this path exists to
// catch), so it cannot validate itself against uptime the way the pid-reuse check below does. It
// checks internal consistency instead, and ALL of the following must hold or this path is skipped
// (falls through to PREFERRED-uptime with no other effect -- beyond the plausibility tolerance it
// can only suppress a bound firing early, never invent one):
//   - `ev.monotonicAtMs` and the injected `monotonicNowMs` are both finite;
//   - no reboot -- the existing `hostUptimeNowMs >= ev.hostUptimeAtMs` test below, since a reboot
//     resets BOTH clocks and invalidates any comparison between two readings taken across it;
//   - `monotonicNowMs >= ev.monotonicAtMs` -- a process-relative origin (the shape this check
//     guards against on a platform or runtime where the Linux finding above does not hold) would
//     typically violate this on the read side, since it restarts near zero on every process start;
//   - `(monotonicNowMs - ev.monotonicAtMs) <= (hostUptimeNowMs - ev.hostUptimeAtMs) + tolerance` --
//     monotonic elapsed time can never legitimately exceed boottime elapsed time (boottime is a
//     strict superset: it counts everything monotonic does, plus suspend), so a monotonic reading
//     claiming to have advanced FURTHER than boottime did is not the same system-wide clock this
//     path assumes, and the comparison is abandoned rather than trusted. The tolerance
//     (`MONOTONIC_PLAUSIBILITY_TOLERANCE_MS`, defined below) exists only to absorb the two
//     measurements' own granularity (`os.uptime()` was measured at 10ms resolution on this host,
//     and the hrtime cross-process reads above at ~10ms wall-clock jitter under load) -- it must
//     stay small relative to any real drain (minutes) or suspend (the failure mode it exists to
//     catch) it is meant to distinguish from measurement noise.
// When every clause holds, the bound reads `monotonicNowMs - ev.monotonicAtMs > ev.timeoutMs +
// grace`, and a firing bound carries `boundClock: 'monotonic'` on the returned status. This is the
// step that actually closes the suspend residual: during a suspend, `hostUptimeAtMs`'s reading
// keeps advancing (boottime counts the suspend) while `monotonicAtMs`'s does not, so a genuinely
// live, still-waiting drain reads well inside ITS bound even though the uptime-only reading would
// have called it stopped.
//
// PREFERRED (uptime): `ev.hostUptimeAtMs` (dispatcher.js's write, `os.uptime() * 1000` -- seconds
// since boot converted to ms) is used whenever the event carries it and the monotonic path above
// did not apply: `os.uptime()` is monotonic (never steps backward or forward the way `Date.now()`
// has been measured doing on this box -- see the WALL-clock paragraph below) and comparable across
// processes on the same boot on every platform, unlike the monotonic path's Linux-only guarantee --
// exactly what this comparison needs, since the event is written by the daemon and read by a
// DIFFERENT process (`spo status`, the dashboard's collectAll). The bound then reads
// `hostUptimeNowMs - ev.hostUptimeAtMs > ev.timeoutMs + grace`, where `hostUptimeNowMs` is injected
// exactly like `now` (see below) -- a caller that does not inject it skips the uptime bound
// entirely (falls through to the liveness read) rather than silently re-deriving an age from wall
// time, which would defeat the point for exactly the events this path exists to fix. A firing bound
// here carries `boundClock: 'uptime'`. `hostUptimeNowMs` LESS than `ev.hostUptimeAtMs` means a
// reboot happened between the write and this read -- uptime resets on boot, so that ordering can
// only occur across a reboot, and nothing survives a reboot: the drain, and the whole process that
// was running it, is certainly over, so this reads 'stopped'/diedDraining unconditionally
// (`rebooted: true` alongside it), without ever falling into the pid/isAlive logic below (a pid
// from a previous boot is not the same process as whatever now holds that pid number, so
// `isAlive(pid)` could not answer this question even if it were asked) -- and this check runs
// BEFORE the monotonic path is even considered, since a reboot invalidates a monotonic comparison
// too (see the plausibility check above).
//
// LEGACY events -- written before card #208, so carrying no `ev.hostUptimeAtMs` at all -- fall back to
// EXACTLY today's wall-clock comparison (`now - Date.parse(ev.ts) > ev.timeoutMs + grace`,
// `now`/`Date.parse(ev.ts)` each required to be finite). The wait it bounds, `awaitInFlight` in
// dispatcher.js, runs on the MONOTONIC clock (`monotonicNowMsFn()`; that function's own comment:
// "never Date.now(): a bound that a clock step could double or erase is not a bound"), so a
// FORWARD WALL-CLOCK STEP during a live LEGACY drain can put it past this fallback bound before
// the monotonic wait has actually expired, reading a still-running drain as 'stopped'. A record
// with no parseable `ts` has no age to bound at all here either, and falls through to liveness
// exactly as before. A firing bound here carries `boundClock: 'wallclock'`.
//
// Scope of what is actually closed (2026-09-12 fix pass F7, extended by card #219 2026-09-14): the
// forward-WALL-CLOCK-STEP half of the original gap is closed for the PREFERRED (uptime) path --
// `os.uptime()` never gets the NTP-style step corrections this box's own `Date.now()` has been
// measured taking (see the PREFERRED paragraph above), so a record carrying `ev.hostUptimeAtMs`
// cannot be pushed past its bound by one. HOST SUSPEND (residual 1) is now closed BY the
// PREFERRED-MONOTONIC path above, but ONLY where the plausibility check finds hrtime trustworthy --
// measured true on Linux (this host, WSL2, see above), assumed FALSE (path skipped, falls back to
// PREFERRED-uptime, suspend residual remains) on every other platform, since nothing here re-derives
// the libuv/kernel guarantee at runtime beyond the plausibility check's own internal-consistency
// test. A live suspend was NOT reproduced on this host for this action either (same reason card
// #208 could not: WSL2's own `CLOCK_BOOTTIME - CLOCK_MONOTONIC` measured at -1.7 microseconds after
// 63 hours of uptime, consistent with either "never suspended" or "WSL2 collapses the two clocks"),
// so this remains "closed by construction where the clock allows", not "demonstrated live" -- see
// doc/accepted-gaps.md for the platforms and shapes still open.
//
// `now`/`hostUptimeNowMs`/`killGraceMs`/`monotonicNowMs` are INJECTED, exactly like `isAlive` and
// `processStartUptimeMs` (card #219), for the same dependency-free reason: this module must never
// read a clock itself (a caller that cached `daemonEvents` and evaluated them later would get a
// silently different verdict from one call to the next) and must never import config.js directly
// (the callers already have it, and requiring it here would make a pure event-array function
// depend on this process's SPO_* environment, which config.js reads at require time). A caller
// that omits `now` and/or `hostUptimeNowMs` and/or `monotonicNowMs` gets the pre-bound behaviour
// exactly -- see the missing-input list below.
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
//                                              logic). Card #208, extended by card #219: THREE
//                                              paths, PREFERRED-MONOTONIC then PREFERRED then
//                                              LEGACY, any of which can short-circuit straight to
//                                              {status: 'stopped', event: ev, diedDraining: true}
//                                              (or, reboot only, that plus `rebooted: true`)
//                                              regardless of isAlive.
//                                              Reboot check FIRST, whenever `ev.hostUptimeAtMs` is
//                                              a finite number and `hostUptimeNowMs` (injected) is
//                                              too: `hostUptimeNowMs < ev.hostUptimeAtMs` -> a
//                                              reboot happened since the write ->
//                                              stopped/diedDraining/rebooted unconditionally, pid/
//                                              isAlive never consulted (see the header for why a
//                                              pre-reboot pid cannot answer this) -- checked before
//                                              either bound below, since a reboot invalidates a
//                                              monotonic comparison across it too.
//                                              PREFERRED-MONOTONIC, when `ev.monotonicAtMs` and the
//                                              injected `monotonicNowMs` are both finite AND the
//                                              plausibility check holds (no reboot per above,
//                                              `monotonicNowMs >= ev.monotonicAtMs`, and monotonic
//                                              elapsed no more than boottime elapsed plus a small
//                                              tolerance -- see the header for the full reasoning):
//                                              `monotonicNowMs - ev.monotonicAtMs > ev.timeoutMs +
//                                              grace` -> stopped/diedDraining, `boundClock:
//                                              'monotonic'`. Implausible, or either field missing,
//                                              skips straight to PREFERRED (uptime) with no other
//                                              effect -- except within the plausibility tolerance
//                                              it can only suppress an early bound, never invent one.
//                                              PREFERRED (uptime), when `ev.hostUptimeAtMs` is a
//                                              finite number and the monotonic path above did not
//                                              apply: needs `hostUptimeNowMs` (injected) also
//                                              finite, plus a resolvable `ev.timeoutMs` (finite, >=
//                                              0) and grace (`ev.killGraceMs` if finite >= 0, else
//                                              the injected `killGraceMs` if finite >= 0). When
//                                              `ev.timeoutMs`/grace resolve and `hostUptimeNowMs -
//                                              ev.hostUptimeAtMs > ev.timeoutMs + grace` ->
//                                              stopped/diedDraining, `boundClock: 'uptime'`.
//                                              `hostUptimeNowMs` not injected, or `ev.timeoutMs`/
//                                              grace not resolvable, skips this path (does NOT fall
//                                              back to the legacy wall-clock path -- see the
//                                              header) and falls through to liveness.
//                                              LEGACY, only when `ev.hostUptimeAtMs` is NOT a finite
//                                              number (a record from before card #208): applies
//                                              only when `now` (injected), the event's own
//                                              `Date.parse(ev.ts)`, and `ev.timeoutMs` are all
//                                              finite numbers (`ev.timeoutMs` also >= 0), AND a
//                                              grace is resolvable exactly as above. When those
//                                              resolve and `now - Date.parse(ev.ts) > ev.timeoutMs
//                                              + grace` -> stopped/diedDraining, `boundClock:
//                                              'wallclock'` -- past its own wait bound plus the
//                                              reap's own kill grace, a drain that ran as designed
//                                              has already written its conclusion (run() writes
//                                              `dispatcher-stopped` the moment the wait ends,
//                                              before any kill or reap even starts), so an
//                                              unconcluded one is read as stopped; residual gaps in
//                                              the header. Any missing input (no `now` injected, no
//                                              parseable `ts`, a non-finite/absent `timeoutMs`, or
//                                              no resolvable grace) skips this path too and falls
//                                              through to liveness -- a future `ts` (negative age)
//                                              is always INSIDE this bound, never past it, so it
//                                              never short-circuits.
//                                            Otherwise (no path fired, or none could be applied),
//                                              liveness decides exactly as before card #188's
//                                              follow-up: pid known and isAlive(pid) === false ->
//                                              {status: 'stopped', event: ev, diedDraining: true}
//                                              -- a drain-start is written only after requestDrain
//                                              accepted a drain (dispatcher.js's run(), gated on
//                                              `drainRequest`), and this process is provably gone
//                                              with no dispatcher-stopped recorded.
//                                            Otherwise, RESIDUAL 2 (card #219, "in-boot pid
//                                              reuse"): when `isAlive(pid)` says TRUE (not merely
//                                              "not false"), `ev.hostUptimeAtMs` is finite, and
//                                              `processStartUptimeMs` is injected: reading that
//                                              pid's real `/proc/<pid>/stat` starttime and finding
//                                              it measurably (`PID_REUSE_SLACK_MS`) AFTER
//                                              `ev.hostUptimeAtMs` means this pid cannot be the
//                                              process that wrote the event (a real drainer's own
//                                              pid necessarily existed before its own write) ->
//                                              {status: 'stopped', event: ev, diedDraining: true,
//                                              pidReused: true}. `processStartUptimeMs` returning
//                                              `null` (non-Linux, pid gone, unparseable) or not
//                                              being injected leaves the verdict unchanged.
//                                            otherwise: {status: 'draining', event: ev} -- a live
//                                              wait, one whose liveness cannot be checked (no
//                                              isAlive injected, or no pid resolvable), or one
//                                              whose bound cannot be evaluated and whose pid, if
//                                              reused, cannot be proven so (non-Linux, or no
//                                              `processStartUptimeMs` injected) -- the residual gap
//                                              named in the header: a drain still inside its own
//                                              bound whose pid has been reused reads 'draining' here
//                                              wherever the reuse cannot be proven, same as it
//                                              always has for that case.
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

// MONOTONIC_PLAUSIBILITY_TOLERANCE_MS (card #219) -- slack for the PREFERRED-MONOTONIC
// plausibility check's "monotonic elapsed <= boottime elapsed" clause (module header). Sized off
// this action's own measurements: `os.uptime()` was found to have 10ms granularity on this host,
// and two separate node processes' `hrtime.bigint()` reads showed ~10ms of wall-clock jitter
// across an intentional 56ms gap. 1000ms is a generous multiple of both, chosen (as the spec asks)
// to stay far below any real drain (minutes) or suspend (the failure mode this path exists to
// detect), so it cannot mask either.
const MONOTONIC_PLAUSIBILITY_TOLERANCE_MS = 1000;

// PID_REUSE_SLACK_MS (card #219, residual 2) -- slack for comparing a live pid's own
// `/proc/<pid>/stat` starttime against the drain-start event's `hostUptimeAtMs`. Both readings are
// boot-relative but come from different sources at different granularities: `os.uptime()` was
// measured at 10ms resolution, `/proc/<pid>/stat`'s starttime at the kernel's own USER_HZ (100
// ticks/sec = 10ms/tick, orchestrator/lock.js's `LINUX_CLK_TCK`). 1000ms covers both with margin
// for scheduling jitter under load (this box runs multiple concurrent agents -- CLAUDE.md's own
// "the machine is loaded" note) without coming close to masking an actual reuse, which by
// definition happens only after the ORIGINAL process has exited and a NEW one was later assigned
// the same pid -- a gap that is never sub-second on a live system.
const PID_REUSE_SLACK_MS = 1000;

function computeDispatcherStatus(
  daemonEvents,
  { isAlive, now, hostUptimeNowMs, killGraceMs, monotonicNowMs, processStartUptimeMs } = {}
) {
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
      // ACROSS PROCESSES on the same boot -- see the module header for why that beats `ts` (wall
      // clock; steps on this box), and why the PREFERRED-MONOTONIC path (card #219, checked first
      // below, when it applies) beats this one on a suspend. Only a record written before this card
      // has no `ev.hostUptimeAtMs` at all; that is the ONLY case that falls to the LEGACY wall-clock
      // path below -- a record that has `ev.hostUptimeAtMs` but for which the caller did not inject
      // `hostUptimeNowMs` skips straight past both paths to the liveness read, rather than silently
      // re-deriving an age from `ts`.
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
            // risks a false "still alive" off a coincidentally-live, unrelated process. Checked
            // BEFORE the monotonic path below for the same reason: a reboot invalidates a
            // monotonic comparison across it too.
            return { status: 'stopped', event: ev, diedDraining: true, rebooted: true };
          }
          const grace = resolveDrainGrace(ev, killGraceMs);
          const hasTimeoutAndGrace = Number.isFinite(ev.timeoutMs) && ev.timeoutMs >= 0 && grace !== null;

          // PREFERRED-MONOTONIC (card #219) -- see the module header for the full reasoning. Every
          // clause of the plausibility check must hold or this path is skipped in favour of the
          // PREFERRED (uptime) bound just below; it can fire before the uptime path would only by at
          // most MONOTONIC_PLAUSIBILITY_TOLERANCE_MS.
          const monotonicPlausible =
            Number.isFinite(ev.monotonicAtMs) &&
            Number.isFinite(monotonicNowMs) &&
            monotonicNowMs >= ev.monotonicAtMs &&
            monotonicNowMs - ev.monotonicAtMs <= hostUptimeNowMs - ev.hostUptimeAtMs + MONOTONIC_PLAUSIBILITY_TOLERANCE_MS;

          if (monotonicPlausible) {
            if (hasTimeoutAndGrace && monotonicNowMs - ev.monotonicAtMs > ev.timeoutMs + grace) {
              return { status: 'stopped', event: ev, diedDraining: true, boundClock: 'monotonic' };
            }
            // Within the monotonic bound (or no timeout/grace to check it against) -- trust THIS
            // reading over the uptime one, which is exactly the suspend case this path exists to
            // fix, and fall through to liveness/pid-reuse below rather than also consulting the
            // uptime bound.
          } else if (hasTimeoutAndGrace) {
            if (hostUptimeNowMs - ev.hostUptimeAtMs > ev.timeoutMs + grace) {
              return { status: 'stopped', event: ev, diedDraining: true, boundClock: 'uptime' };
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
            return { status: 'stopped', event: ev, diedDraining: true, boundClock: 'wallclock' };
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
      // Residual 2 (card #219, "in-boot pid reuse"): a drain still short of its own bound whose
      // pid has since been reused by an unrelated process, started AFTER the drain began, used to
      // read 'draining' forever -- the same "no positive evidence of death" default the liveness
      // read alone always used. Applies only when `isAlive` explicitly says TRUE (not merely
      // "not false" -- an unresolvable liveness read must stay exactly as unresolved as before) AND
      // `ev.hostUptimeAtMs` is present (both readings must be on the same boot-relative clock) AND
      // a `processStartUptimeMs` probe is injected. `null` from that probe (non-Linux, pid already
      // gone, or unparseable) leaves the verdict unchanged, still 'draining' -- this check can only
      // ever ADD a 'stopped' verdict, never remove the existing liveness-based one.
      if (
        pid !== null &&
        Number.isFinite(ev.hostUptimeAtMs) &&
        typeof isAlive === 'function' &&
        isAlive(pid) === true &&
        typeof processStartUptimeMs === 'function'
      ) {
        const starttimeMs = processStartUptimeMs(pid);
        if (Number.isFinite(starttimeMs) && starttimeMs > ev.hostUptimeAtMs + PID_REUSE_SLACK_MS) {
          // This pid started (in boot-relative terms) measurably AFTER the drain-start event was
          // written -- it cannot be the same process that wrote it. A real drainer is always the
          // daemon process that wrote the drain-start event, so it necessarily started BEFORE that
          // write (dispatcher.js's run() only reaches the write after `process.pid` already exists).
          return { status: 'stopped', event: ev, diedDraining: true, pidReused: true };
        }
      }
      return { status: 'draining', event: ev };
    }
    if (ev.event === 'dispatcher-stopped') return { status: 'stopped', event: ev };
    if (ev.event === 'dispatcher-idle-no-healthy-accounts') return { status: 'idle', event: ev };
  }
  return null;
}

module.exports = { computeDispatcherStatus };
