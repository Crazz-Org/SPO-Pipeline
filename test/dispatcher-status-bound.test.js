'use strict';
// Card #188 follow-up (2026-09-11): a `dispatcher-drain-start` with no later conclusion used to
// read DRAINING forever off liveness alone (console/dispatcher-status.js's computeDispatcherStatus,
// `isAlive(pid)`) -- which is wrong once the writing process is dead AND its pid has since been
// reused by any other process on the box (a false "still alive" forever), or when no pid resolves
// at all. The REAL journal is in exactly this state: a `dispatcher-drain-start` at
// 2026-09-10T07:17:00.765Z, `timeoutMs` 2700000, no `pid` (a legacy record); the matching
// `dispatcher-start` carries pid 17927.
//
// THE FIX: computeDispatcherStatus now takes an age bound on the drain-start's OWN `timeoutMs`
// plus the kill grace the reap that follows it actually uses (`killGraceMs` -- carried on the
// event itself as of this follow-up, dispatcher.js's `resolveDrainKillGraceMs`; a legacy record
// with none uses the caller's own injected `killGraceMs`). Past that bound a drain that ran as
// designed has already written `dispatcher-stopped` (run() writes it the instant the wait
// resolves, before any kill or reap), so the bound reads 'stopped'/`diedDraining: true`
// UNCONDITIONALLY, without ever consulting `isAlive`. This file pins the bound itself (unit tests
// against computeDispatcherStatus directly) and that it actually reaches the two real callers
// (`spo status`, the dashboard deck) through a real journal on disk -- see PRODUCTION REACH below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js's own header. Must land before the ../console/ requires
// below (console/collect.js loads orchestrator modules transitively). test/no-real-spawn-sweep.test.js
// does NOT check this file: its patterns match only ../orchestrator/ and ../bin/ requires.
require('./no-real-spawn');

const { mkTmp, runSpo } = require('./helpers');
const { computeDispatcherStatus } = require('../console/dispatcher-status');
const { collectAll, collectServices, applyWorkerStats, readDaemonEventsTail } = require('../console/collect');
const { renderServicesInner, renderReportsInner } = require('../console/render');
const { processStartUptimeMs } = require('../orchestrator/lock');

// Fixed clock for every unit test below -- never Date.now(), so every assertion is an exact,
// reproducible number rather than a moving target.
const NOW = Date.parse('2026-09-11T00:00:00.000Z');

// waitMsSync(ms) -- a real, synchronous, blocking delay: some production-reach tests below need a
// GUARANTEED minimum amount of real wall-clock time to have passed on the uptime clock before they
// check anything, and "however long this test file's own prior tests happened to take" is not a
// guarantee. Atomics.wait on a throwaway SharedArrayBuffer blocks the calling thread for exactly
// `ms`, synchronously, with no subprocess and no dependency on the event loop.
function waitMsSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeDaemonEvents(journalRoot, events) {
  fs.mkdirSync(journalRoot, { recursive: true });
  fs.writeFileSync(path.join(journalRoot, 'daemon.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ---- unit: the bound itself --------------------------------------------------------------------

test('bound: drain-start OLDER than timeoutMs+killGraceMs reads stopped/diedDraining even when isAlive says TRUE (simulated pid reuse) -- and isAlive is never even called (the bound short-circuits before liveness)', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 5000).toISOString(), // 5s old
    timeoutMs: 1000,
    killGraceMs: 1000, // bound = 2000ms; 5000 > 2000
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  let isAliveCalls = 0;
  const result = computeDispatcherStatus([ev], {
    isAlive: () => {
      isAliveCalls++;
      return true;
    },
    now: NOW,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'wallclock' });
  assert.equal(isAliveCalls, 0, 'the bound must decide before isAlive is ever consulted');
});

test('bound: drain-start INSIDE the bound, isAlive TRUE, reads draining', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 500).toISOString(), // 500ms old, well under the 2000ms bound
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('bound: inside the bound, isAlive FALSE, reads stopped/diedDraining -- existing (pre-bound) behaviour kept', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 500).toISOString(),
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => false, now: NOW });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
});

test('bound: no resolvable pid at all, older than the bound, reads stopped/diedDraining -- NOT draining', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    // no `pid`, and no earlier `dispatcher-start` in the array either -- pid is unresolvable.
    ts: new Date(NOW - 5000).toISOString(),
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  // isAlive would never even be reachable here (no pid to hand it), but supplied anyway, and
  // TRUE, to prove the bound alone decides -- pid-unresolvable used to mean 'draining' by
  // default; past the bound it must not any more.
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'wallclock' });
});

test('bound: exact boundary -- age === timeoutMs + killGraceMs reads draining (the bound has not been EXCEEDED yet)', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 2000).toISOString(), // age exactly 2000ms
    timeoutMs: 1000,
    killGraceMs: 1000, // bound = 2000ms, age === bound
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('bound: one millisecond past the boundary reads stopped/diedDraining', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 2001).toISOString(), // age 2001ms, 1ms past the 2000ms bound
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'wallclock' });
});

test("bound: the event's OWN killGraceMs wins over the injected one", () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 1500).toISOString(), // age 1500ms
    timeoutMs: 1000,
    killGraceMs: 100, // event's own grace -- bound = 1100ms, 1500 > 1100 -> stopped
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  // The injected grace is huge -- if IT won instead of the event's own, the bound would be
  // 1000 + 100000 = 101000ms and 1500ms would read comfortably inside it (draining). Reading
  // stopped here proves the event's own `killGraceMs` is the one actually used.
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW, killGraceMs: 100000 });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'wallclock' });
});

test('bound: a LEGACY record with no killGraceMs of its own uses the injected (caller config) grace', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 5000).toISOString(),
    timeoutMs: 1000,
    // no `killGraceMs` field -- exactly the shape a pre-follow-up record on disk has.
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  // isAlive TRUE: if the injected grace were NOT applied, there would be no bound to check at
  // all, and this would fall through to liveness and read 'draining'. Reading stopped proves the
  // caller's injected killGraceMs reached the bound.
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW, killGraceMs: 1000 });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'wallclock' });
});

test('bound: missing `ts` -- no bound applies, falls through to liveness (isAlive TRUE -> draining)', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    // no `ts` at all.
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('bound: missing `timeoutMs` -- no bound applies, falls through to liveness (isAlive TRUE -> draining)', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 999999999).toISOString(), // ancient, would fire the bound if it applied
    // no `timeoutMs`.
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('bound: no killGraceMs anywhere (neither the event nor injected) -- no grace resolvable, no bound applies, falls through to liveness (isAlive TRUE -> draining)', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 999999999).toISOString(), // ancient -- would fire the bound if any grace resolved
    timeoutMs: 1000,
    // no `killGraceMs` field on the event.
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  // No `killGraceMs` injected either -- grace stays unresolvable (`null`), so `grace !== null`
  // is false and the bound is skipped entirely, exactly like a missing `ts` or `timeoutMs`.
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('bound: no `now` injected -- pre-bound behaviour exactly (isAlive TRUE -> draining)', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 999999999).toISOString(),
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  // `now` is simply absent from the options object -- exactly what every caller that predates
  // this follow-up (and this repo's own pre-existing tests, e.g. test/dispatcher-status-deck.test.js)
  // still does.
  const result = computeDispatcherStatus([ev], { isAlive: () => true });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('bound: a future `ts` (negative age) is inside the bound -- reads draining, never stopped', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW + 100000).toISOString(), // 100s in the future
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('bound: a NEGATIVE timeoutMs never fires the bound, even against a future ts (where timeoutMs + grace would otherwise sum to a huge negative "exceeded" threshold)', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW + 100000).toISOString(), // future -- age is negative (-100000ms)
    timeoutMs: -1e9, // malformed/negative -- without the `>= 0` guard, -100000 > -1e9 + grace is TRUE
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('bound: a CONCLUDED drain (drain-start then dispatcher-stopped) is unaffected by the bound, however old the drain-start is', () => {
  const start = { event: 'dispatcher-start', pid: 111, ts: new Date(NOW - 999999999).toISOString() };
  const drainStart = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 999999999).toISOString(), // ancient -- would fire the bound on its own
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const stopped = { event: 'dispatcher-stopped', reason: 'drain-requested', drained: true, ts: new Date(NOW - 1000).toISOString() };
  const result = computeDispatcherStatus([start, drainStart, stopped], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'stopped', event: stopped });
});

// ---- PRODUCTION REACH: a real journal, the real `spo status` binary, and the real collectAll ---
//
// The unit tests above prove computeDispatcherStatus itself; they say nothing about whether the
// two real call sites (bin/spo's cmdStatus, console/collect.js's applyWorkerStats) actually inject
// `now`/`killGraceMs` -- a call site that forgot `now` would pass every unit test above and still
// read DRAINING forever in production; one that forgot `killGraceMs` would do the same for any
// record without its own `killGraceMs` (the real journal's legacy drain-start is one). These three
// drive the real binary and the real collectAll against a hand-written daemon.jsonl on a tmp
// journal (never ~/.spo-state).

test('production: a died-inside-the-drain fixture (pid reused, 2h past its bound) reads STOPPED on both spo status and collectAll, never DRAINING', () => {
  const journalRoot = mkTmp('spo-188-bound-dead-j-');
  const queueDir = mkTmp('spo-188-bound-dead-q-');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: twoHoursAgo,
      event: 'dispatcher-drain-start',
      // `process.pid`: a REAL, currently-alive pid -- standing in for the pid-reuse case
      // (`isAlive` would read this as "still there" if the bound did not override it).
      pid: process.pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 1000,
      killGraceMs: 1000,
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(
    out,
    /dispatcher: STOPPED -- drain never concluded \(drain started .* ago; no dispatcher-stopped recorded; process gone or past its drain bound;/,
    `expected the drain-never-concluded STOPPED line: ${out}`
  );
  assert.doesNotMatch(out, /dispatcher: DRAINING/, `must not read a pid-reused, past-bound drain as still draining: ${out}`);

  const data = collectAll({ journalRoot, queueDir, spoReportsDir: mkTmp('spo-188-bound-dead-reports-') });
  assert.equal(data.services.workers.status, 'stopped');
  assert.equal(data.services.workers.dispatcher.diedDraining, true);
});

test('production CONTROL: the same shape, freshly started and inside a generous bound, reads DRAINING, never STOPPED', () => {
  const journalRoot = mkTmp('spo-188-bound-live-j-');
  const queueDir = mkTmp('spo-188-bound-live-q-');
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: new Date().toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 3600000, // 1h -- comfortably ahead of "just now"
      killGraceMs: 1000,
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(out, /dispatcher: DRAINING/, `expected a DRAINING line for a fresh, in-bound drain: ${out}`);
  assert.doesNotMatch(out, /dispatcher: STOPPED/, `must not read a fresh drain as stopped: ${out}`);

  const data = collectAll({ journalRoot, queueDir, spoReportsDir: mkTmp('spo-188-bound-live-reports-') });
  assert.equal(data.services.workers.status, 'draining');
});

test('production LEGACY: a pid-less, killGraceMs-less drain-start (2h old) reads STOPPED on both -- proves the injected CONFIG grace reaches production', () => {
  const journalRoot = mkTmp('spo-188-bound-legacy-j-');
  const queueDir = mkTmp('spo-188-bound-legacy-q-');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  writeDaemonEvents(journalRoot, [
    // The pid this legacy drain-start would resolve to (via the nearest earlier dispatcher-start)
    // if the bound did not fire first -- a REAL, alive pid, so a caller that forgot to inject
    // `killGraceMs` (no bound ever applies -> falls through to liveness -> pid resolves here ->
    // alive -> DRAINING) would be caught by this test, not silently pass it.
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: twoHoursAgo,
      event: 'dispatcher-drain-start',
      // No `pid`, no `killGraceMs` -- exactly the shape a record written before this follow-up
      // (and before card #188 itself, for `pid`) has on disk.
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 1000,
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(
    out,
    /dispatcher: STOPPED -- drain never concluded \(drain started .* ago; no dispatcher-stopped recorded; process gone or past its drain bound;/,
    `expected STOPPED for a 2h-old legacy drain-start: ${out}`
  );
  assert.doesNotMatch(out, /dispatcher: DRAINING/, `the injected config grace must have reached the bound: ${out}`);

  const data = collectAll({ journalRoot, queueDir, spoReportsDir: mkTmp('spo-188-bound-legacy-reports-') });
  assert.equal(data.services.workers.status, 'stopped');
  assert.equal(data.services.workers.dispatcher.diedDraining, true);
});

// ---- card #208: the PREFERRED age reading is boot-relative uptime, not wall clock -------------
//
// The bound above (card #188 follow-up) is measured on the WALL clock at both ends (`now` minus
// `Date.parse(ev.ts)`), but the wait it bounds (dispatcher.js's awaitInFlight) runs on the
// MONOTONIC clock. A forward wall-clock step during a live drain pushes the wall age past the
// bound before the monotonic wait has actually expired -- a false STOPPED for a drain that is
// still running. (A host suspend is the card's other named trigger; card #208 itself did NOT
// close it: `/proc/uptime` is `ktime_get_boottime`, which counts suspended time, while the wait's
// `hrtime` is CLOCK_MONOTONIC, which does not. Measured on this box: CLOCK_BOOTTIME minus
// CLOCK_MONOTONIC is -1.7 us after 63 h of uptime, which cannot distinguish "this host never
// suspended" from "WSL2 collapses the two" -- so suspend stayed a named residual after card #208,
// neither closed nor demonstrated. Card #219, below, closes it where the clock allows -- see its
// own section further down.) dispatcher.js now stamps `dispatcher-drain-start` with
// `hostUptimeAtMs` (`os.uptime() * 1000`, seconds-since-boot converted to ms) alongside `ts`:
// boot-relative uptime is comparable ACROSS PROCESSES on the same boot on every platform (unlike
// `monotonicNowMs()`, whose cross-process comparability is a measured Linux implementation detail,
// not a documented Node guarantee -- orchestrator/monotonic-clock.js's own header), and unlike
// `ts` it never steps. computeDispatcherStatus now prefers this reading whenever the event carries
// it, falling back to the wall-clock comparison only for a record with no `hostUptimeAtMs` at all.

// A synthetic "seconds since boot" baseline for these tests -- unrelated to this box's real
// os.uptime(), exactly like NOW above is unrelated to this box's real Date.now(). Keeps every
// assertion below an exact, reproducible number rather than a moving target.
const UPTIME_NOW = 1_000_000; // ms

test('card #208: a live drain whose WALL age has passed the bound but whose UPTIME age has not must NOT read as stopped (the false-STOPPED case this card fixes)', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    // Wall clock: 10s old -- alone, against a 2000ms bound (timeoutMs 1000 + killGraceMs 1000),
    // this is 8s PAST the bound -- exactly the false-STOPPED shape a forward wall-clock step or a
    // host suspend produces (see this module's own header, and dispatcher-status.js's).
    ts: new Date(NOW - 10000).toISOString(),
    // Uptime: 500ms old -- well INSIDE the same 2000ms bound. The uptime reading, not the wall
    // one, is what the fix must trust.
    hostUptimeAtMs: UPTIME_NOW - 500,
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW, hostUptimeNowMs: UPTIME_NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('card #208: an UPTIME age genuinely past the bound reads stopped/diedDraining exactly as today, even with a fresh (non-stale) wall ts', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    // Wall clock: 100ms old -- comfortably INSIDE the bound if wall clock were consulted, proving
    // the uptime reading, not the wall one, is what decides here.
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 5000, // 5s uptime-old, past the 2000ms bound
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW, hostUptimeNowMs: UPTIME_NOW });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'uptime' });
});

// F3 (2026-09-12 fix pass): the LEGACY wall-clock path has an exact-boundary pin (card #188,
// above: "bound: exact boundary -- age === timeoutMs + killGraceMs reads draining"), proving `>`
// rather than `>=` decides it. Card #208's PREFERRED (uptime) path uses the exact same `>`
// comparison (`hostUptimeNowMs - ev.hostUptimeAtMs > ev.timeoutMs + grace`) but had no equivalent pin --
// a `>=` mutation on that line left the whole suite green. Mirrors the LEGACY test above one-for-
// one, on the uptime reading instead of the wall one.
test('card #208: PREFERRED-path exact boundary -- uptime age === timeoutMs + killGraceMs reads draining (the bound has not been EXCEEDED yet)', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(), // fresh wall ts -- proves the uptime reading decides
    hostUptimeAtMs: UPTIME_NOW - 2000, // uptime age exactly 2000ms
    timeoutMs: 1000,
    killGraceMs: 1000, // bound = 2000ms, age === bound
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW, hostUptimeNowMs: UPTIME_NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('card #208: PREFERRED-path one millisecond past the boundary reads stopped/diedDraining', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 2001, // uptime age 2001ms, 1ms past the 2000ms bound
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW, hostUptimeNowMs: UPTIME_NOW });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'uptime' });
});

test("card #208: hostUptimeNowMs LESS than the event's own hostUptimeAtMs means a reboot happened since the write -- reads stopped/diedDraining/rebooted, isAlive never consulted", () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    // The event's own uptime reading is AHEAD of "now"'s -- only possible across a reboot (uptime
    // resets to near zero on boot).
    hostUptimeAtMs: UPTIME_NOW + 5000,
    timeoutMs: 3600000, // generous -- would read draining if the reboot check did not fire first
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  let isAliveCalls = 0;
  const result = computeDispatcherStatus([ev], {
    isAlive: () => {
      isAliveCalls++;
      return true;
    },
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, rebooted: true });
  assert.equal(
    isAliveCalls,
    0,
    'a pre-reboot pid cannot answer whether the CURRENT process is alive -- isAlive must never be consulted'
  );
});

// F4 (2026-09-12 fix pass): the shipped `<` on the reboot check (`hostUptimeNowMs < ev.hostUptimeAtMs`) is
// correct -- a live drain can never read `rebooted` under `<`, because both ends read the same
// monotonic-since-boot source and the reader is always later -- but flipping it to `<=` survives
// the whole suite because no test pins `hostUptimeNowMs === ev.hostUptimeAtMs` (the two readings equal,
// i.e. no reboot at all). `/proc/uptime` has been measured at 10ms granularity on this box, so
// that equality is genuinely reachable within one tick of a live process reading its own uptime
// twice. Under `<=` a live, still-draining process would misread itself as rebooted/stopped.
test("card #208: hostUptimeNowMs EQUAL to the event's own hostUptimeAtMs is NOT a reboot -- reads draining (isAlive TRUE), proving `<` rather than `<=` decides the reboot check", () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW, // exactly equal to "now"'s own uptime reading -- one tick's worth of
    // /proc/uptime granularity, not a reboot.
    timeoutMs: 3600000, // generous -- comfortably inside the bound once past the reboot check
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW, hostUptimeNowMs: UPTIME_NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('card #208: a LEGACY event with no hostUptimeAtMs at all still uses the wall-clock fallback exactly as before -- unaffected by hostUptimeNowMs being injected', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 5000).toISOString(), // 5s wall-old, past the 2000ms bound
    // no `hostUptimeAtMs` -- exactly the shape every record on disk before this card has.
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  // hostUptimeNowMs IS injected (as every real caller now does) but must be ignored for a record with
  // no hostUptimeAtMs of its own -- the legacy wall-clock path is the only one it can use.
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW, hostUptimeNowMs: UPTIME_NOW });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'wallclock' });
});

test('card #208: an event carrying hostUptimeAtMs but no hostUptimeNowMs injected skips the bound entirely (falls through to liveness) rather than silently using the wall-clock fallback', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 999999999).toISOString(), // ancient -- would fire the LEGACY bound if it applied
    hostUptimeAtMs: UPTIME_NOW - 5000, // would also fire the PREFERRED bound if hostUptimeNowMs were injected
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  // No `hostUptimeNowMs` in the options object at all.
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

// ---- PRODUCTION REACH: real os.uptime(), the real `spo status` binary, and the real collectAll -

test('production: real os.uptime() reaches both callers -- an ANCIENT wall ts with a RECENT hostUptimeAtMs reads DRAINING, never the false STOPPED the wall clock alone would produce', () => {
  const journalRoot = mkTmp('spo-208-uptime-j-');
  const queueDir = mkTmp('spo-208-uptime-q-');
  // process.pid, with hostUptimeAtMs built from its OWN measured real starttime -- not pid 1 with
  // an offset from "now" (a fixture bug found investigating CI run 34807448013, PR #233: pid 1's
  // own real starttime has no relationship to an arbitrary offset, and can read LATER than it on
  // an ephemeral runner, tripping card #219's pid-reuse check independently of what this test
  // actually means to exercise -- see the #219 F-production test further below for the full
  // account). `measuredStart` is always comfortably inside the 3660000ms bound below by the time
  // the `spo status` subprocess reads its own fresh os.uptime() a moment later.
  const measuredStart = processStartUptimeMs(process.pid);
  assert.ok(Number.isFinite(measuredStart), 'processStartUptimeMs(process.pid) must resolve on Linux for this test to mean anything');
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      // Ancient WALL ts -- past even this generous bound. If the reader fell back to wall clock
      // here (instead of preferring `hostUptimeAtMs`) it would misread this as STOPPED -- exactly the
      // false-STOPPED bug this card fixes.
      ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 3600000, // 1h
      killGraceMs: 60000, // 1min -- bound = 3660000ms
      hostUptimeAtMs: measuredStart,
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(out, /dispatcher: DRAINING/, `expected DRAINING -- the uptime bound must win over the ancient wall ts: ${out}`);
  assert.doesNotMatch(out, /dispatcher: STOPPED/, `an ancient wall ts must not fool the reader when hostUptimeAtMs is present: ${out}`);

  const data = collectAll({ journalRoot, queueDir, spoReportsDir: mkTmp('spo-208-uptime-reports-') });
  assert.equal(data.services.workers.status, 'draining');
});

// ---- F2 (2026-09-12 fix pass): the injection ITSELF is load-bearing, and until now nothing
// proved either production call site still makes it. Both `bin/spo:cmdStatus`'s
// `hostUptimeNowMs: os.uptime() * 1000` and `console/collect.js:applyWorkerStats`'s
// `Number.isFinite(hostUptimeNowMs) ? hostUptimeNowMs : os.uptime() * 1000` default fallback can be
// deleted with the ENTIRE suite (including the "production: real os.uptime()" test just above)
// still green -- that test's fixture keeps `hostUptimeAtMs` INSIDE the bound, so with no injection at
// all the PREFERRED path is merely skipped (falls through to liveness), `process.pid` is alive,
// and the result is DRAINING either way. These two tests instead push `hostUptimeAtMs` PAST the bound
// with a LIVE pid, so only a real, live `hostUptimeNowMs` reaching computeDispatcherStatus can produce
// the correct STOPPED verdict -- an accidentally-deleted injection reads DRAINING instead, and
// fails loudly.

test("F2: real os.uptime() reaching bin/spo's cmdStatus injection -- an hostUptimeAtMs PAST the bound with a LIVE pid reads STOPPED, never DRAINING", () => {
  const journalRoot = mkTmp('spo-208-f2-cmdstatus-j-');
  const queueDir = mkTmp('spo-208-f2-cmdstatus-q-');
  const hostUptimeNowMs = os.uptime() * 1000;
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      // Fresh WALL ts -- if the reader fell back to wall clock (or skipped the bound entirely for
      // lack of an injected hostUptimeNowMs) this would read DRAINING off liveness alone, since `pid`
      // below is a REAL, currently-alive process. Only a live hostUptimeNowMs reaching the PREFERRED
      // path can produce STOPPED here.
      ts: new Date(Date.now() - 100).toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 1000,
      killGraceMs: 1000,
      // PAST the 2000ms bound, in uptime terms -- comfortably clear of normal process-spawn
      // latency between this write and the `spo status` subprocess's own os.uptime() read below.
      hostUptimeAtMs: hostUptimeNowMs - 60000,
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(
    out,
    /dispatcher: STOPPED/,
    `expected STOPPED -- a LIVE pid must not save a drain-start whose real hostUptimeAtMs is past its own bound: ${out}`
  );
  assert.doesNotMatch(
    out,
    /dispatcher: DRAINING/,
    `bin/spo's cmdStatus must actually inject a live hostUptimeNowMs for this to read STOPPED rather than falling through to liveness: ${out}`
  );
});

test("F2: real os.uptime() reaching console/collect.js's applyWorkerStats DEFAULT fallback (no hostUptimeNowMs argument at all) -- an hostUptimeAtMs PAST the bound with a LIVE pid reads stopped, never draining", () => {
  const journalRoot = mkTmp('spo-208-f2-collect-j-');
  const hostUptimeNowMs = os.uptime() * 1000;
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: new Date(Date.now() - 100).toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 1000,
      killGraceMs: 1000,
      hostUptimeAtMs: hostUptimeNowMs - 60000,
    },
  ]);

  // Called with ONLY 4 arguments -- no `daemonEvents`, no `hostUptimeNowMs` -- exactly the shape a
  // caller that predates card #208 (every existing status-6.7.test.js call site) has. `daemonEvents`
  // then falls back to a fresh `readDaemonEventsTail(journalRoot)` (an existing, already-tested
  // default); `hostUptimeNowMs` must fall back to a fresh, LIVE `os.uptime() * 1000` -- not `undefined`
  // -- for this to read `stopped` rather than skipping the PREFERRED path entirely.
  const services = applyWorkerStats(collectServices({ journalRoot }), journalRoot, [], Date.now());
  assert.equal(
    services.workers.status,
    'stopped',
    "applyWorkerStats's default hostUptimeNowMs must be a live os.uptime() reading, not undefined -- otherwise a live pid past its uptime bound reads draining forever"
  );
});

// ---- F8 (2026-09-12 fix pass): `rebooted` now reaches the `spo status` caption, the dashboard's
// Workers tile, and the Bug Reports drain-history line -- rather than being computed
// (computeDispatcherStatus, and threaded through applyWorkerStats's whitelist) and then read by
// NOTHING, which is what the verifier found before this fix. Each caption trades the hedged
// "process gone or past its drain bound" for an unhedged "host rebooted ... certainly gone" only
// when `rebooted` is true -- see bin/spo's cmdStatus and console/render.js's own comments for why
// a reboot is the one diedDraining case that is a MEASURED death, not an inferred one.

test('F8: `spo status` and collectAll both report a certain death, not a hedge, when the drain-start reads rebooted', () => {
  const journalRoot = mkTmp('spo-208-f8-reboot-j-');
  const queueDir = mkTmp('spo-208-f8-reboot-q-');
  const hostUptimeNowMs = os.uptime() * 1000;
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: new Date(Date.now() - 100).toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid, // a REAL, alive pid -- proves the reboot check, not liveness, decides this
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 3600000, // generous -- would read draining if the reboot check did not fire first
      killGraceMs: 60000,
      // AHEAD of "now"'s own uptime reading -- only possible across a reboot.
      hostUptimeAtMs: hostUptimeNowMs + 60000,
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(
    out,
    /dispatcher: STOPPED -- drain never concluded \(.*host rebooted since drain start -- process is certainly gone/,
    `expected the certain-death reboot wording, not the hedged one: ${out}`
  );
  assert.doesNotMatch(out, /process gone or past its drain bound/, `a rebooted drain must not ALSO print the hedged wording: ${out}`);

  const data = collectAll({ journalRoot, queueDir, spoReportsDir: mkTmp('spo-208-f8-reboot-reports-') });
  assert.equal(data.services.workers.status, 'stopped');
  assert.equal(data.services.workers.dispatcher.diedDraining, true);
  assert.equal(data.services.workers.dispatcher.rebooted, true, 'collectAll must thread rebooted through applyWorkerStats\'s whitelist');
});

test('F8: the dashboard Workers tile prints the certain-death reboot wording, not the hedged one, when workersDispatcher.rebooted is true', () => {
  const services = {
    workers: {
      status: 'stopped',
      dispatcher: { diedDraining: true, rebooted: true, sinceAgeMs: 60000, inFlight: 2 },
    },
  };
  const html = renderServicesInner(services, {}, {});
  assert.ok(html.includes('host rebooted since drain start'), 'Workers tile must print the certain-death wording when rebooted is true');
  assert.ok(!html.includes('process gone or past its drain bound'), 'Workers tile must not ALSO print the hedged wording when rebooted is true');
});

test('F8: the dashboard Workers tile still prints the hedged wording when diedDraining is true but rebooted is NOT (the far more common case)', () => {
  const services = {
    workers: {
      status: 'stopped',
      dispatcher: { diedDraining: true, rebooted: false, sinceAgeMs: 60000, inFlight: 2 },
    },
  };
  const html = renderServicesInner(services, {}, {});
  assert.ok(html.includes('process gone or past its drain bound'), 'a non-rebooted diedDraining must keep the existing hedged wording');
  assert.ok(!html.includes('host rebooted since drain start'), 'a non-rebooted diedDraining must not print the reboot wording');
});

test('F8: the Bug Reports drain-history line prints the certain-death reboot wording when the passed-in workersDispatcher carries rebooted', () => {
  const reports = {
    dispatcher: {
      lastDrainStart: { ts: '2026-09-11T00:00:00.000Z', inFlight: 2 },
      lastDrainEnd: null,
      lastStopped: null,
      lastStart: null,
    },
  };
  const workersDispatcher = { diedDraining: true, rebooted: true };
  const html = renderReportsInner(reports, workersDispatcher);
  assert.ok(html.includes('host rebooted since drain start'), 'Bug Reports drain-history line must print the certain-death wording when rebooted is true');
  assert.ok(!html.includes('process gone or past its drain bound'), 'Bug Reports drain-history line must not ALSO print the hedged wording when rebooted is true');
});

// ---- card #219: residual 2, "in-boot pid reuse" ---------------------------------------
//
// A drain still genuinely inside its own bound (uptime path: `hostUptimeNowMs - hostUptimeAtMs`
// well under `timeoutMs + grace`) whose pid `isAlive` reports TRUE can still be a DIFFERENT
// process than the one that wrote the drain-start, if that pid was reused by something else
// started after the drain began. `processStartUptimeMs(pid)` (orchestrator/lock.js, `/proc/<pid>
// /stat` field 22) resolves that: a starttime measurably AFTER `ev.hostUptimeAtMs` cannot be the
// drainer, since a real drainer's own pid necessarily existed BEFORE it wrote the event.

test('#219 residual 2: pid reuse -- starttime past hostUptimeAtMs + slack reads stopped/diedDraining/pidReused', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 500, // well inside the bound
    timeoutMs: 3600000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    // Reused pid: started 2000ms AFTER the drain-start's own hostUptimeAtMs -- comfortably past
    // any tick-granularity slack.
    processStartUptimeMs: () => ev.hostUptimeAtMs + 2000,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, pidReused: true });
});

test('#219 residual 2: starttime BEFORE hostUptimeAtMs (the real drainer, not a reuse) reads draining', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 500,
    timeoutMs: 3600000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    // Started well BEFORE the drain-start write -- exactly what a real drainer's own pid must do.
    processStartUptimeMs: () => ev.hostUptimeAtMs - 10000,
  });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('#219 residual 2: processStartUptimeMs returning null (non-Linux, pid gone, unparseable) leaves the verdict unchanged -- draining', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 500,
    timeoutMs: 3600000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    processStartUptimeMs: () => null,
  });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('#219 residual 2: exact boundary -- starttime === hostUptimeAtMs + PID_REUSE_SLACK_MS (1000) reads draining, not yet EXCEEDED', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 500,
    timeoutMs: 3600000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    processStartUptimeMs: () => ev.hostUptimeAtMs + 1000, // exactly at the slack boundary
  });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('#219 residual 2: one millisecond past the slack boundary reads stopped/diedDraining/pidReused', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 500,
    timeoutMs: 3600000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    processStartUptimeMs: () => ev.hostUptimeAtMs + 1001,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, pidReused: true });
});

test('#219 residual 2: no ev.hostUptimeAtMs (LEGACY record) never consults processStartUptimeMs -- still draining off liveness alone', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    // no hostUptimeAtMs at all.
    timeoutMs: 3600000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  let calls = 0;
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    processStartUptimeMs: () => {
      calls++;
      return 999999999;
    },
  });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
  assert.equal(calls, 0, 'a LEGACY record has no boot-relative hostUptimeAtMs to compare against -- the probe must never be consulted');
});

test('#219 residual 2: isAlive FALSE already returns stopped without ever consulting processStartUptimeMs', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 500,
    timeoutMs: 3600000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  let calls = 0;
  const result = computeDispatcherStatus([ev], {
    isAlive: () => false,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    processStartUptimeMs: () => {
      calls++;
      return ev.hostUptimeAtMs + 999999;
    },
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
  assert.equal(calls, 0, 'isAlive already decided this -- the reuse probe is only for the TRUE case');
});

// ---- card #219: residual 1, "a host suspend during a drain" ---------------------------
//
// A synthetic monotonic baseline, unrelated to this box's real process.hrtime.bigint(), exactly
// like UPTIME_NOW is unrelated to this box's real os.uptime() -- every assertion below is an
// exact, reproducible number.
const MONOTONIC_NOW = 500_000; // ms

test('#219 residual 1: simulated suspend -- uptime elapsed far exceeds monotonic elapsed, monotonic within bound -- reads draining where the uptime path alone would have said stopped', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    // Uptime age: 10 minutes -- past a 2000ms bound (the "suspend" -- boottime kept advancing).
    hostUptimeAtMs: UPTIME_NOW - 10 * 60 * 1000,
    // Monotonic age: 500ms -- comfortably inside the same bound (the wait itself did not advance).
    monotonicAtMs: MONOTONIC_NOW - 500,
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    monotonicNowMs: MONOTONIC_NOW,
  });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('#219 residual 1: monotonic elapsed past its own bound reads stopped/diedDraining/boundClock:monotonic', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 5000, // also past the uptime bound -- both paths agree here
    monotonicAtMs: MONOTONIC_NOW - 5000,
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    monotonicNowMs: MONOTONIC_NOW,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'monotonic' });
});

test('#219 residual 1: implausible monotonic (monotonicNowMs < monotonicAtMs) falls back to the uptime path', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 5000, // past the uptime bound -- must decide this, since monotonic is implausible
    monotonicAtMs: MONOTONIC_NOW + 999999, // AHEAD of "now"'s own monotonic reading -- impossible for the same clock
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    monotonicNowMs: MONOTONIC_NOW,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'uptime' });
});

test('#219 residual 1: implausible monotonic (monotonic elapsed exceeds uptime elapsed + tolerance) falls back to the uptime path', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 100, // uptime elapsed 100ms -- inside the bound
    // monotonic elapsed 100000ms -- far more than uptime elapsed could ever legitimately allow,
    // well past the 1000ms tolerance -- not the same system-wide clock this path assumes.
    monotonicAtMs: MONOTONIC_NOW - 100000,
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    monotonicNowMs: MONOTONIC_NOW,
  });
  // Uptime path: 100ms elapsed, well under the 2000ms bound -- draining, decided by the FALLBACK
  // path (proves the implausible monotonic reading was actually skipped, not merely coincidentally
  // agreeing).
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('#219 residual 1: reboot check fires regardless of monotonic values -- rebooted verdict wins', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW + 5000, // ahead of "now" -- a reboot happened
    monotonicAtMs: MONOTONIC_NOW - 100, // would otherwise read comfortably inside the bound
    timeoutMs: 3600000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  let isAliveCalls = 0;
  const result = computeDispatcherStatus([ev], {
    isAlive: () => {
      isAliveCalls++;
      return true;
    },
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    monotonicNowMs: MONOTONIC_NOW,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, rebooted: true });
  assert.equal(isAliveCalls, 0);
});

test('#219 residual 1: no monotonicAtMs on the event -- monotonic path skipped, uptime path decides, boundClock:uptime', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 5000, // past the bound
    // no monotonicAtMs field at all -- exactly a record written before this action.
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    monotonicNowMs: MONOTONIC_NOW,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'uptime' });
});

test('#219 residual 1: no monotonicNowMs injected -- monotonic path skipped even though the event carries monotonicAtMs', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 100, // inside the uptime bound
    monotonicAtMs: MONOTONIC_NOW - 5000, // would fire the monotonic bound if it were consulted
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    // no monotonicNowMs.
  });
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('#219 residual 1: uptime bound (boundClock: uptime) still fires exactly as card #208 shipped when neither monotonic field is present', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: UPTIME_NOW - 2001,
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW, hostUptimeNowMs: UPTIME_NOW });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'uptime' });
});

test('#219 residual 1: LEGACY bound (no hostUptimeAtMs at all) carries boundClock: wallclock when it fires', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 5000).toISOString(),
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], { isAlive: () => true, now: NOW });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'wallclock' });
});

// ---- PRODUCTION REACH (card #219): both real callers wire processStartUptimeMs and -----
// monotonicNowMs, not merely computeDispatcherStatus in isolation.

test('#219 F-production: a LIVE pid (this test process) whose real processStartUptimeMs is measurably AFTER a drain-start\'s hostUptimeAtMs reads STOPPED via spo status and collectAll (pid-reuse, real /proc)', () => {
  const journalRoot = mkTmp('spo-219-pidreuse-j-');
  const queueDir = mkTmp('spo-219-pidreuse-q-');
  const hostUptimeNowMs = os.uptime() * 1000;
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: new Date(Date.now() - 100).toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid, // this test process -- REAL, alive, and its REAL starttime is being read
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 3600000, // generous -- neither the uptime nor the monotonic bound fires first
      killGraceMs: 60000,
      // Recorded as having started an hour BEFORE this test process actually did -- so THIS
      // process's own real starttime necessarily reads well past hostUptimeAtMs + slack, exactly
      // the pid-reuse shape (a real drainer's pid could never legitimately postdate its own event).
      hostUptimeAtMs: hostUptimeNowMs - 60 * 60 * 1000,
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(out, /dispatcher: STOPPED/, `expected STOPPED -- real processStartUptimeMs must catch the pid-reuse shape: ${out}`);
  assert.doesNotMatch(out, /dispatcher: DRAINING/, `bin/spo's cmdStatus must inject a real processStartUptimeMs: ${out}`);

  const data = collectAll({ journalRoot, queueDir, spoReportsDir: mkTmp('spo-219-pidreuse-reports-') });
  assert.equal(data.services.workers.status, 'stopped');
  assert.equal(data.services.workers.dispatcher.diedDraining, true);
});

test('#219 F-production: real monotonicNowMs reaches both callers -- an hostUptimeAtMs PAST its bound but a FRESH monotonicAtMs reads DRAINING (the suspend case), never the false STOPPED the uptime reading alone would produce', () => {
  const journalRoot = mkTmp('spo-219-monotonic-j-');
  const queueDir = mkTmp('spo-219-monotonic-q-');
  // Fixture note (CI run 34807448013, PR #233): this fixture used to pair `pid: 1` with an
  // arbitrary `hostUptimeAtMs` offset from "now" -- pid 1's own real starttime has no relationship
  // to that offset, and on an ephemeral CI runner it can read LATER than it, tripping card #219's
  // pid-reuse check independently of the monotonic-vs-uptime logic this test means to exercise.
  // Fixed by building `hostUptimeAtMs` from THIS process's own MEASURED real starttime instead.
  //
  // Neither the `spo status` subprocess below nor `collectAll` takes an injected uptime, so this
  // test (unlike pin (c) below) cannot substitute a real wait with an injected `hostUptimeNowMs` --
  // it has to make the uptime clock actually advance. `waitMsSync` guarantees that advance
  // deterministically, independent of subprocess-spawn cost or how long this file's prior tests
  // took; `timeoutMs` below is sized as the MONOTONIC side's own cost budget instead (the real work
  // this test still has to do afterward -- spawning `spo status`, running `collectAll` -- which
  // must finish well inside it for the monotonic path to still read draining).
  const measuredStart = processStartUptimeMs(process.pid);
  assert.ok(Number.isFinite(measuredStart), 'processStartUptimeMs(process.pid) must resolve on Linux for this test to mean anything');
  waitMsSync(4000); // guarantees >= 4000ms of real uptime-clock elapsed since measuredStart
  const hostUptimeNowMs = os.uptime() * 1000;
  const monotonicNow = Number(process.hrtime.bigint() / 1000000n);
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: new Date(Date.now() - 100).toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      // timeoutMs is the MONOTONIC-COST BUDGET: how long ONE real check below (`spo status`, or
      // `collectAll` after the refresh) may take and still read draining. Verification measured the
      // monotonic side at 170-440ms under the full loaded local suite; 2000ms leaves headroom for a
      // slower 2-core CI runner. The uptime side only has to EXCEED this bound: waitMsSync(4000)
      // above guarantees that, independent of load. The two numbers are separate on purpose --
      // the wait is the uptime guarantee, this bound is the monotonic budget.
      timeoutMs: 2000,
      killGraceMs: 0,
      // Uptime age: >=4000ms, PAST the bound -- what the uptime-only path alone would read as
      // stopped. Built from this process's OWN real start, so it can never trip the pid-reuse
      // check for this pid.
      hostUptimeAtMs: measuredStart,
      // Monotonic age: ~0 -- fresh, well INSIDE the bound. `waitMsSync` above blocks real time on
      // BOTH clocks equally (it is a real pause, not a simulated suspend), so capturing
      // `monotonicNow` AFTER the wait -- not before it -- is what keeps this side honestly
      // near-zero-elapsed, matching "the drain-start write happened just now".
      monotonicAtMs: monotonicNow,
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(out, /dispatcher: DRAINING/, `expected DRAINING -- the real monotonic reading must win over the stale uptime one: ${out}`);
  assert.doesNotMatch(out, /dispatcher: STOPPED/, `bin/spo's cmdStatus must inject a real monotonicNowMs: ${out}`);

  // Refresh `monotonicAtMs` before the SECOND real check below: the `runSpo` subprocess above
  // already spent part of the 2000ms monotonic-cost budget, and re-using the same event unchanged
  // would make `collectAll`'s own check spend against whatever budget `runSpo` left rather than
  // its own fresh one. `hostUptimeAtMs` is left as `measuredStart` -- more real time only widens
  // its own gap past the bound, which never hurts the "uptime path alone would say stopped" side.
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: new Date(Date.now() - 100).toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 2000,
      killGraceMs: 0,
      hostUptimeAtMs: measuredStart,
      monotonicAtMs: Number(process.hrtime.bigint() / 1000000n),
    },
  ]);

  const data = collectAll({ journalRoot, queueDir, spoReportsDir: mkTmp('spo-219-monotonic-reports-') });
  assert.equal(
    data.services.workers.status,
    'draining',
    `expected draining, full dispatcher status: ${JSON.stringify(data.services.workers.dispatcher)}`
  );
});

test("#219 F-production: console/collect.js's applyWorkerStats DEFAULT fallbacks (no processStartUptimeMs/monotonicNowMs arguments at all) still reach the real production probes", () => {
  const journalRoot = mkTmp('spo-219-collect-defaults-j-');
  const hostUptimeNowMs = os.uptime() * 1000;
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: new Date(Date.now() - 100).toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      timeoutMs: 3600000,
      killGraceMs: 60000,
      hostUptimeAtMs: hostUptimeNowMs - 60 * 60 * 1000, // pid-reuse shape, as above
    },
  ]);

  // Called with only 4 arguments -- no daemonEvents, hostUptimeNowMs, or monotonicNowMsAtRead --
  // exactly the shape every pre-card-#219 call site has. Both applyWorkerStats's own default
  // (a fresh os.uptime()*1000) AND its default processStartUptimeMs/monotonicNowMs must reach the
  // real production probes for this to read stopped rather than skipping the reuse check.
  const services = applyWorkerStats(collectServices({ journalRoot }), journalRoot, [], Date.now());
  assert.equal(
    services.workers.status,
    'stopped',
    'applyWorkerStats must reach the real processStartUptimeMs even when called with no seventh argument'
  );
});

// ---- fix pass, card #219 verification round: pinning tests ------------------------------------

test('#219 pin (a): tolerance kills a mutant that zeroes MONOTONIC_PLAUSIBILITY_TOLERANCE_MS -- monotonic elapsed 501ms beyond uptime elapsed is still plausible, and the bound fires via monotonic', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    // Uptime elapsed: 119500ms -- just SHORT of the 120000ms bound on its own.
    hostUptimeAtMs: UPTIME_NOW - 119500,
    // Monotonic elapsed: 120001ms -- 501ms MORE than uptime elapsed. With tolerance=0 this would
    // fail the plausibility check's own elapsed-vs-elapsed clause (120001 > 119500 + 0) and fall
    // back to the uptime path (119500, NOT past the 120000ms bound -> draining). With the real
    // 1000ms tolerance, 120001 <= 119500 + 1000 holds -- plausible -- and the monotonic path's OWN
    // bound (120001 > 120000) fires instead. A mutant that zeroes the tolerance constant reads
    // 'draining' here; the real code reads 'stopped'/boundClock:'monotonic'.
    monotonicAtMs: MONOTONIC_NOW - 120001,
    timeoutMs: 120000,
    killGraceMs: 0,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    monotonicNowMs: MONOTONIC_NOW,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'monotonic' });
});

test('#219 pin (b): the reboot check fires BEFORE the monotonic path is even considered -- kills a mutant that only checks reboot when monotonic is implausible', () => {
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    // A sub-second regression: hostUptimeAtMs is 100ms AHEAD of hostUptimeNowMs -- the reboot
    // signal (uptime resets on boot, so "now" reading LESS than the event's own recorded uptime
    // can only mean a reboot happened between them).
    hostUptimeAtMs: UPTIME_NOW + 100,
    // Monotonic elapsed: 500ms -- by the bare arithmetic this READS plausible (500 <= -100 + 1000
    // tolerance = 900) and comfortably inside any real bound, so a mutant that only consults the
    // reboot check inside an "else" branch (i.e. only when the monotonic path did NOT already
    // apply) would read this as a live, fresh 'draining' drain instead. The real code checks
    // reboot FIRST, unconditionally, so it must read rebooted regardless.
    monotonicAtMs: MONOTONIC_NOW - 500,
    timeoutMs: 3600000,
    killGraceMs: 0,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  let isAliveCalls = 0;
  const result = computeDispatcherStatus([ev], {
    isAlive: () => {
      isAliveCalls++;
      return true;
    },
    now: NOW,
    hostUptimeNowMs: UPTIME_NOW,
    monotonicNowMs: MONOTONIC_NOW,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, rebooted: true });
  assert.equal(isAliveCalls, 0, 'a pre-reboot pid cannot answer whether the CURRENT process is alive');
});

test("#219 pin (c): applyWorkerStats' own monotonicNowMsAtRead DEFAULT (argument omitted entirely) still reaches the PREFERRED-MONOTONIC path, not just the hostUptimeNowMs default", () => {
  const journalRoot = mkTmp('spo-219-pin-c-j-');
  // Fixture note: see the F-production test above for the CI-fixture story (a `pid: 1` /
  // arbitrary-`hostUptimeAtMs` pairing). Unlike that test, `applyWorkerStats` takes
  // `hostUptimeNowMs` as its own 6th argument -- this test only needs the 7th
  // (`monotonicNowMsAtRead`) to be omitted, so `hostUptimeNowMs` can be INJECTED directly instead
  // of waited-for, and no real delay is needed at all.
  const measuredStart = processStartUptimeMs(process.pid);
  assert.ok(Number.isFinite(measuredStart), 'processStartUptimeMs(process.pid) must resolve on Linux for this test to mean anything');
  const hostUptimeNowMs = measuredStart + 60000; // injected "now" -- 60000ms after this pid's own real start
  const monotonicNow = Number(process.hrtime.bigint() / 1000000n);
  writeDaemonEvents(journalRoot, [
    { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), event: 'dispatcher-start', pid: process.pid, workers: 1 },
    {
      ts: new Date(Date.now() - 100).toISOString(),
      event: 'dispatcher-drain-start',
      pid: process.pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
      // bound = 30000ms: comfortably under the 60000ms uptime-elapsed built into the injected
      // hostUptimeNowMs above (what the uptime-only path alone would read as stopped),
      // comfortably over the monotonic side's own real cost (a few synchronous fs calls -- no
      // subprocess, no wait).
      timeoutMs: 30000,
      killGraceMs: 0,
      // This pid's OWN real start -- can never trip the pid-reuse check for this pid.
      hostUptimeAtMs: measuredStart,
      // Monotonic age: ~0 -- fresh. If applyWorkerStats's own default for its 7th parameter
      // (monotonicNowMsAtRead) is anything other than a live monotonicNowMs() reading --
      // undefined, stale, or simply never reaching computeDispatcherStatus -- this reads
      // 'stopped' off the injected uptime path instead of 'draining' off the monotonic one.
      monotonicAtMs: monotonicNow,
    },
  ]);

  const events = readDaemonEventsTail(journalRoot);
  // Six arguments -- daemonEvents (5th) and hostUptimeNowMs (6th) both supplied, but the 7th
  // (monotonicNowMsAtRead) is OMITTED entirely, isolating this test to that one default.
  const services = applyWorkerStats(collectServices({ journalRoot }), journalRoot, [], Date.now(), events, hostUptimeNowMs);
  assert.equal(
    services.workers.status,
    'draining',
    `applyWorkerStats's default monotonicNowMsAtRead must be a live monotonicNowMs() reading reaching the PREFERRED-MONOTONIC path, not undefined -- full dispatcher status: ${JSON.stringify(services.workers.dispatcher)}`
  );
});

// #219 pin (d), noted rather than tested: computeDispatcherStatus's residual-2 branch requires
// `isAlive(pid) === true` (strict equality), not merely "not false" -- but every real production
// caller injects `pidExists` (orchestrator/lock.js), which only ever returns the boolean `true` or
// `false` (never `undefined`/a truthy non-boolean), so `=== true` and `!== false` are equivalent
// for every actual call site; the distinction only matters for a synthetic test `isAlive` that
// returns some other truthy value, which is why the unit tests above use `() => true` throughout
// rather than pinning this specific operator.

// ---- a persistent BOOTTIME-MONOTONIC gap must never leak into an ABSOLUTE comparison -----------
//
// computeDispatcherStatus's plausibility check and both its monotonic and uptime bounds compare
// same-clock DELTAS only (`monotonicNowMs - ev.monotonicAtMs` vs `hostUptimeNowMs -
// ev.hostUptimeAtMs`), never one clock's absolute reading against the other's. This section pins
// that invariant directly, with pure unit tests against computeDispatcherStatus: no filesystem
// I/O, no subprocess, no real clock read, so nothing about the host or its load can ever make
// these flake. A regression that starts comparing an ABSOLUTE monotonic reading against an
// ABSOLUTE uptime reading (instead of each against its own prior reading) would fail these on ANY
// host, deterministically, whether or not that host has ever suspended -- proven here by injecting
// a huge, arbitrary, FIXED gap between the two clocks' absolute values (as a real host with a
// historical suspend/checkpoint would have) and checking a normal drain, a genuinely-exceeded
// bound, and an independent mid-drain suspend all still read correctly despite it.
//
// (These were added investigating CI run 34807448013, PR #233 -- the eventual root cause of that
// failure was unrelated to this invariant: see the F-production/pin (c) tests above for it.)

const HUGE_CONSTANT_GAP_MS = 3 * 24 * 60 * 60 * 1000; // +3 days -- an arbitrary, large, FIXED gap

test('#219 CI-investigation pin: a huge CONSTANT gap between the two clocks\' absolute values does not affect a NORMAL (non-suspended) drain -- only the deltas are ever compared', () => {
  // Simulates a host whose os.uptime() has read a persistent +3 days ahead of process.hrtime.bigint()
  // for its entire life (e.g. a VM resumed once, long ago, from a snapshot/checkpoint) -- both
  // absolute values are enormous relative to any drain's own timeoutMs, but the drain itself
  // progresses normally: uptime elapsed and monotonic elapsed both real-track together (no NEW
  // suspend during THIS wait), so they must read equal ELAPSED values despite the absolute gap.
  const hugeUptimeBase = 10_000_000_000; // an arbitrary, large absolute uptime reading
  const hugeMonotonicBase = hugeUptimeBase - HUGE_CONSTANT_GAP_MS; // same host, persistent gap
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: hugeUptimeBase - 500, // 500ms uptime-elapsed since write
    monotonicAtMs: hugeMonotonicBase - 500, // ALSO 500ms monotonic-elapsed -- consistent per-clock
    timeoutMs: 1000,
    killGraceMs: 1000, // bound = 2000ms
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: hugeUptimeBase, // "now" on the uptime clock -- also huge, same persistent gap
    monotonicNowMs: hugeMonotonicBase, // "now" on the monotonic clock -- same persistent gap
  });
  // 500ms elapsed on both clocks, well under the 2000ms bound -- draining, decided by the
  // monotonic path (it is plausible: 500 <= 500 + tolerance), regardless of the 3-day absolute gap.
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});

test('#219 CI-investigation pin: a huge CONSTANT gap PLUS a bound genuinely exceeded on BOTH clocks still reads stopped/boundClock:monotonic -- the gap never masks a real timeout', () => {
  const hugeUptimeBase = 10_000_000_000;
  const hugeMonotonicBase = hugeUptimeBase - HUGE_CONSTANT_GAP_MS;
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    hostUptimeAtMs: hugeUptimeBase - 5000, // 5000ms elapsed on both clocks -- past the 2000ms bound
    monotonicAtMs: hugeMonotonicBase - 5000,
    timeoutMs: 1000,
    killGraceMs: 1000,
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: hugeUptimeBase,
    monotonicNowMs: hugeMonotonicBase,
  });
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true, boundClock: 'monotonic' });
});

test('#219 CI-investigation pin: a huge constant gap PLUS a genuine suspend growing mid-drain (uptime elapsed far exceeds monotonic elapsed) still reads draining via monotonic -- the persistent gap and the NEW suspend are independent', () => {
  const hugeUptimeBase = 10_000_000_000;
  const hugeMonotonicBase = hugeUptimeBase - HUGE_CONSTANT_GAP_MS;
  const ev = {
    event: 'dispatcher-drain-start',
    pid: 111,
    ts: new Date(NOW - 100).toISOString(),
    // At write time, both clocks were 0ms old (fresh write) relative to their OWN absolute base.
    hostUptimeAtMs: hugeUptimeBase,
    monotonicAtMs: hugeMonotonicBase,
    timeoutMs: 1000,
    killGraceMs: 1000, // bound = 2000ms
    signal: 'SIGTERM',
    inFlight: ['a'],
  };
  // NOW: a genuine 10-minute suspend has occurred since the write (uptime/BOOTTIME counts it,
  // monotonic does not) -- on TOP of the pre-existing 3-day persistent gap between the two clocks'
  // own absolute origins. The two effects must not interact: the persistent gap is already priced
  // into both bases above; only the NEW suspend should move the deltas apart.
  const suspendMs = 10 * 60 * 1000;
  const result = computeDispatcherStatus([ev], {
    isAlive: () => true,
    now: NOW,
    hostUptimeNowMs: hugeUptimeBase + suspendMs, // boottime advanced through the suspend
    monotonicNowMs: hugeMonotonicBase + 100, // monotonic barely advanced -- the wait itself, not the suspend
  });
  // Uptime path alone would read this as 10 minutes old, past the 2000ms bound -- STOPPED. The
  // monotonic path, unaffected by either the persistent gap or the suspend it doesn't count,
  // correctly reads 100ms elapsed -- draining.
  assert.deepStrictEqual(result, { status: 'draining', event: ev });
});
