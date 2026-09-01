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
// THE FIX, and the ONE THING TO NEVER DO TO IT: measure ELAPSED DURATIONS -- "how long have I
// been retrying" -- with this monotonic clock, in bounded wait loops ONLY. Never use it for a
// WALL-CLOCK TIMESTAMP: anything written to disk or compared ACROSS PROCESSES (a lease's
// `startedAt`, an account's `cooldownUntil`, a queue entry's `notBefore`, orphan-scan.js's grace
// window against `state.json`'s `updatedAt`) must stay Date.now()-based, because
// process.hrtime.bigint() is meaningless outside the ONE process that read it -- it resets to an
// arbitrary origin on every process start and cannot be compared to another process's own
// monotonic clock, let alone written to a file and read back after a reboot. A future edit that
// "finishes the job" by routing one of those wall-clock values through this function would silently
// break every cooldown/lease/retry comparison in the pool -- this file exists partly so that
// temptation has a named, documented place to stop at.
function monotonicNowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

module.exports = { monotonicNowMs };
