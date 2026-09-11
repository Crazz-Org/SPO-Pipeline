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
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js's own header. Must land before the ../console/ requires
// below (console/collect.js loads orchestrator modules transitively). test/no-real-spawn-sweep.test.js
// does NOT check this file: its patterns match only ../orchestrator/ and ../bin/ requires.
require('./no-real-spawn');

const { mkTmp, runSpo } = require('./helpers');
const { computeDispatcherStatus } = require('../console/dispatcher-status');
const { collectAll } = require('../console/collect');

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
