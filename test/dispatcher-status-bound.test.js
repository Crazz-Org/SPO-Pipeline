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
const { collectAll, collectServices, applyWorkerStats } = require('../console/collect');
const { renderServicesInner, renderReportsInner } = require('../console/render');

// Fixed clock for every unit test below -- never Date.now(), so every assertion is an exact,
// reproducible number rather than a moving target.
const NOW = Date.parse('2026-09-11T00:00:00.000Z');

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
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
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
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
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
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
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
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
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
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
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
// still running. (A host suspend is the card's other named trigger, and it is NOT closed by this
// change: `/proc/uptime` is `ktime_get_boottime`, which counts suspended time, while the wait's
// `hrtime` is CLOCK_MONOTONIC, which does not. Measured on this box: CLOCK_BOOTTIME minus
// CLOCK_MONOTONIC is -1.7 us after 63 h of uptime, which cannot distinguish "this host never
// suspended" from "WSL2 collapses the two" -- so suspend stays a named residual, neither closed
// nor demonstrated.) dispatcher.js now stamps `dispatcher-drain-start` with `hostUptimeAtMs`
// (`os.uptime() * 1000`, seconds-since-boot converted to ms) alongside `ts`: unlike
// `monotonicNowMs()` (meaningless outside the writing process, orchestrator/monotonic-clock.js's
// own header), boot-relative uptime is comparable ACROSS PROCESSES on the same boot, and unlike
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
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
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
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
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
  assert.deepStrictEqual(result, { status: 'stopped', event: ev, diedDraining: true });
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
  const hostUptimeNowMs = os.uptime() * 1000;
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
      // Recent UPTIME reading -- a few seconds "old" in uptime terms, comfortably inside the bound
      // above. Read from the real os.uptime() at test-write time; the `spo status` subprocess
      // below reads its own fresh os.uptime() a moment later, so this margin must survive normal
      // process-spawn latency.
      hostUptimeAtMs: hostUptimeNowMs - 5000,
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
