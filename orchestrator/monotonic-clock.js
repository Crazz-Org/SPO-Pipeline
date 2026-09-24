'use strict';
// monotonic-clock.js -- the ONE place this codebase converts process.hrtime.bigint() to a
// millisecond Number, shared by accounts.js's markLimit and account-lease.js's leaseHealthyAccount
// (action 6.3, post-verification correction). See either call site's own comment for the full
// story; the short version:
//
// This WSL2 box's `Date.now()` jumps BACKWARD -- measured independently twice: -2515ms across a
// single 10ms monotonic interval, once in 2331 samples over 25s. Every BOUNDED WAIT LOOP in this
// codebase that measured "how much time has elapsed since I started waiting" by subtracting two
// `Date.now()` reads was therefore silently unreliable on this machine: a backward jump makes
// `remaining`/`elapsed` arithmetic read as "less time has passed than really has", which can only
// ever EXTEND a bounded wait, never shorten it -- the failure is always "waited longer than
// configured", never "gave up too early". That is exactly the shape of test/accounts.test.js's
// own flaky-about-1-in-12 state-lock test, and it silently corrupts mutation testing too: a
// wait that runs long enough can make a genuinely-killed mutant look alive by making its own test
// time out or its own timing-sensitive assertion read wrong, without the suite going red for the
// right reason.
//
// CORRECTION, 2026-09-24 (card SPO-Pipeline#234): not only backward, so a Date.now()-bounded wait
// CAN give up too early. Four recorded reds of test/repark-race-demo.test.js threw from a
// `Date.now() + 8000` deadline after 2281-4480ms of monotonic time -- Date.now() had run ahead of
// the monotonic clock mid-wait (a forward step, or a resync after a paused VM; the kernel runs
// hv_utils.timesync_implicit=1, which steps the clock forward when it reads behind the host).
// The fix above is unchanged; the "always waited longer, never gave up too early" claim is not.
//
// THE FIX, and the ONE THING TO NEVER DO TO IT: measure ELAPSED DURATIONS -- a bounded wait
// loop's "how long have I been retrying", or a single spawn's "how long did this call take"
// (steps/llm.js's duration_s) -- with this monotonic clock. Never use it for a
// WALL-CLOCK TIMESTAMP: anything written to disk or compared ACROSS PROCESSES (a lease's
// `startedAt`, an account's `cooldownUntil`, a queue entry's `notBefore`, orphan-scan.js's grace
// window against `state.json`'s `updatedAt`) must stay Date.now()-based. Node's own docs promise
// only that `hrtime` returns "an arbitrary time in the past" -- cross-PROCESS comparability is
// NOT a documented guarantee, and this file used to overclaim the opposite here ("meaningless
// outside the ONE process that read it... cannot be compared to another process's own monotonic
// clock"). Measured instead, card #219, 2026-09-14, this host (Linux/WSL2, Node v22): two
// SEPARATE node processes reading `process.hrtime.bigint()` 56ms apart returned readings 56.4ms
// apart, and both tracked `/proc/uptime` -- on Linux, libuv's `uv_hrtime()` IS the system-wide
// `CLOCK_MONOTONIC`, comparable across every process on the box. That is a measured LINUX
// IMPLEMENTATION DETAIL, not a cross-platform Node guarantee, and it still resets on every reboot
// (unlike a wall-clock timestamp, which survives one) -- so this function's OWN cross-process use
// (the PREFERRED-MONOTONIC bound in console/dispatcher-status.js, dispatcher.js's `monotonicAtMs`
// drain-start field) gates it behind a runtime plausibility check and a same-platform fallback,
// never assumes it unconditionally. Everything below this line is still correct on its own terms:
// a value written to disk and read back by a DIFFERENT process, or across a reboot, must stay
// Date.now()-based UNLESS the reader has independently verified (as that one call site does) that
// comparability actually holds here. A future edit that "finishes the job" by routing a
// lease/cooldown/queue-notBefore wall-clock value through this function WITHOUT that verification
// would silently break every such comparison in the pool on any platform, or after a reboot, where
// the Linux finding above does not hold -- this file exists partly so that temptation has a named,
// documented place to stop at.
function monotonicNowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

module.exports = { monotonicNowMs };
