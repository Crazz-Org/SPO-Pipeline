'use strict';
// Card #186: the dashboard's Workers tile could not tell a STOPPED dispatcher from a genuinely
// IDLE one -- console/collect.js used to derive services.workers.status from live-workers.json's
// mere presence alone (`present ? 'ok' : 'unknown'`), and a dispatcher that published that file
// and then stopped reads identically (present:true, count:0) to one that is up and has simply
// gone idle. console/dispatcher-status.js's computeDispatcherStatus -- moved out of bin/spo, the
// SAME backward-walk `spo status`'s own STOPPED/IDLE lines already used -- now drives both
// readers, so this file pins that they can never disagree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js's own header; must land before the ../orchestrator/*
// and ../console/* requires below (test/no-real-spawn-sweep.test.js enforces this ordering).
require('./no-real-spawn');

const { spawn: realSpawn } = require('child_process');
const { mkTmp, runSpo, isolatedEnv } = require('./helpers');
const { collectAll, collectReportPipeline } = require('../console/collect');
const { renderDashboard, renderServicesInner, renderReportsInner } = require('../console/render');
const { computeDispatcherStatus } = require('../console/dispatcher-status');
const { processAlive, pidExists } = require('../orchestrator/lock');

// Card #188: a genuinely dead-but-real pid, for the 'diedDraining' unit cases below -- spawnSync
// is the real one this file's own no-real-spawn guard (required above) always throws on, so a
// dead pid is obtained the sanctioned way instead: a real ASYNC spawn() (never patched -- see that
// module's own "scope: spawnSync only" header), awaited to exit, its pid then provably free.
function deadPid() {
  return new Promise((resolve, reject) => {
    const child = realSpawn(process.execPath, ['-e', ''], { stdio: 'ignore', env: isolatedEnv() });
    child.on('exit', () => resolve(child.pid));
    child.on('error', reject);
  });
}

const REPO_ROOT = path.join(__dirname, '..');

function writeLiveWorkers(journalRoot, ids, updatedAt) {
  fs.mkdirSync(journalRoot, { recursive: true });
  fs.writeFileSync(
    path.join(journalRoot, 'live-workers.json'),
    JSON.stringify({ ids, updatedAt: updatedAt || new Date().toISOString() })
  );
}

function writeDaemonEvents(journalRoot, events) {
  fs.mkdirSync(journalRoot, { recursive: true });
  fs.writeFileSync(path.join(journalRoot, 'daemon.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// Isolates one svcTile's own rendered markup by name -- svcTile (console/render.js) never nests a
// second <div> inside its own, so the first </div> after the name span is genuinely this tile's
// close, whichever position it renders at.
function extractSvcTile(html, name) {
  const re = new RegExp(`<div class="svc-tile ([^"]+)">\\s*<span class="svc-name">${name}</span>[\\s\\S]*?</div>`);
  const m = html.match(re);
  assert.ok(m, `expected an svc-tile named "${name}" in the rendered HTML`);
  return m[0];
}

// ---- unit: computeDispatcherStatus's backward-walk table -------------------------------------

test('computeDispatcherStatus: [] -> null', () => {
  assert.equal(computeDispatcherStatus([]), null);
});

test('computeDispatcherStatus: [dispatcher-start, dispatcher-stopped] -> stopped', () => {
  const result = computeDispatcherStatus([
    { event: 'dispatcher-start' },
    { event: 'dispatcher-stopped', reason: 'drain-requested' },
  ]);
  assert.equal(result.status, 'stopped');
});

test('computeDispatcherStatus: [dispatcher-stopped, dispatcher-start] -> null (a fresher start outranks an older stop)', () => {
  const result = computeDispatcherStatus([
    { event: 'dispatcher-stopped', reason: 'drain-requested' },
    { event: 'dispatcher-start' },
  ]);
  assert.equal(result, null);
});

test('computeDispatcherStatus: [dispatcher-idle-no-healthy-accounts] -> idle', () => {
  const result = computeDispatcherStatus([{ event: 'dispatcher-idle-no-healthy-accounts', queued: 2 }]);
  assert.equal(result.status, 'idle');
});

test('computeDispatcherStatus: [dispatcher-stopped, dispatcher-idle-no-healthy-accounts] -> idle (newest wins)', () => {
  const result = computeDispatcherStatus([
    { event: 'dispatcher-stopped', reason: 'drain-requested' },
    { event: 'dispatcher-idle-no-healthy-accounts', queued: 1 },
  ]);
  assert.equal(result.status, 'idle');
});

test('computeDispatcherStatus: [dispatcher-idle-no-healthy-accounts, dispatcher-stopped] -> stopped (newest wins)', () => {
  const result = computeDispatcherStatus([
    { event: 'dispatcher-idle-no-healthy-accounts', queued: 1 },
    { event: 'dispatcher-stopped', reason: 'drain-requested' },
  ]);
  assert.equal(result.status, 'stopped');
});

test('computeDispatcherStatus: [dispatcher-idle-no-healthy-accounts, dispatcher-healthy-accounts-returned] -> null', () => {
  const result = computeDispatcherStatus([
    { event: 'dispatcher-idle-no-healthy-accounts', queued: 1 },
    { event: 'dispatcher-healthy-accounts-returned' },
  ]);
  assert.equal(result, null);
});

test('computeDispatcherStatus: a null entry in the array is skipped, not thrown on', () => {
  const result = computeDispatcherStatus([null, { event: 'dispatcher-idle-no-healthy-accounts', queued: 1 }, null]);
  assert.equal(result.status, 'idle');
});

// ---- unit: card #188's `dispatcher-drain-start` branch ----------------------------------------
// A drain-start with no later dispatcher-stopped/dispatcher-drain-end must never read as null
// (the pre-#188 bug: a region nothing could read) and must never read 'stopped' without positive
// liveness evidence (card #164's own inversion, reapplied here).

test('computeDispatcherStatus: [dispatcher-start(pid alive), dispatcher-drain-start(same pid)] -> draining, never stopped', () => {
  const result = computeDispatcherStatus(
    [
      { event: 'dispatcher-start', pid: 111 },
      { event: 'dispatcher-drain-start', pid: 111, signal: 'SIGTERM', inFlight: ['a'] },
    ],
    { isAlive: (pid) => pid === 111 }
  );
  assert.equal(result.status, 'draining');
  assert.notEqual(result.status, 'stopped');
});

test('computeDispatcherStatus: [dispatcher-start(pid dead), dispatcher-drain-start(same pid)] -> stopped, diedDraining true', async () => {
  const pid = await deadPid();
  const result = computeDispatcherStatus(
    [
      { event: 'dispatcher-start', pid },
      { event: 'dispatcher-drain-start', pid, signal: 'SIGTERM', inFlight: ['a'] },
    ],
    { isAlive: processAlive }
  );
  assert.equal(result.status, 'stopped');
  assert.equal(result.diedDraining, true);
});

test('computeDispatcherStatus: a drain-start with no isAlive injected -> draining (never stopped without evidence)', () => {
  const result = computeDispatcherStatus([{ event: 'dispatcher-start', pid: 222 }, { event: 'dispatcher-drain-start', pid: 222 }]);
  assert.equal(result.status, 'draining');
});

test("computeDispatcherStatus: a LEGACY pid-less drain-start resolves the pid off the nearest earlier dispatcher-start, and reads stopped when that process is dead", async () => {
  const pid = await deadPid();
  const result = computeDispatcherStatus(
    [
      { event: 'dispatcher-start', pid },
      // no `pid` field -- as a pre-#188 record on disk would look
      { event: 'dispatcher-drain-start', signal: 'SIGTERM', inFlight: ['a'] },
    ],
    { isAlive: processAlive }
  );
  assert.equal(result.status, 'stopped');
  assert.equal(result.diedDraining, true);
});

test('computeDispatcherStatus: a pid-less drain-start with NO earlier dispatcher-start in the array -> draining (pid unresolvable, never a false stopped)', () => {
  const result = computeDispatcherStatus([{ event: 'dispatcher-drain-start', signal: 'SIGTERM', inFlight: ['a'] }], {
    isAlive: () => false,
  });
  assert.equal(result.status, 'draining');
});

test('computeDispatcherStatus: [drain-start, dispatcher-stopped] -> stopped, diedDraining NOT set (an ordinary concluded stop)', () => {
  const result = computeDispatcherStatus(
    [
      { event: 'dispatcher-start', pid: 333 },
      { event: 'dispatcher-drain-start', pid: 333, signal: 'SIGTERM', inFlight: ['a'] },
      { event: 'dispatcher-stopped', reason: 'drain-requested', drained: true },
    ],
    { isAlive: () => true }
  );
  assert.equal(result.status, 'stopped');
  assert.equal(result.diedDraining, undefined);
});

test('computeDispatcherStatus: [drain-start, dispatcher-start] -> null (a fresh start outranks an old drain, same as an old stop)', () => {
  const result = computeDispatcherStatus([
    { event: 'dispatcher-start', pid: 444 },
    { event: 'dispatcher-drain-start', pid: 444, signal: 'SIGTERM', inFlight: ['a'] },
    { event: 'dispatcher-start', pid: 555 },
  ]);
  assert.equal(result, null);
});

test('computeDispatcherStatus: [dispatcher-idle-no-healthy-accounts, drain-start] -> draining (the idle edge does not outrank a fresher drain)', () => {
  const result = computeDispatcherStatus(
    [
      { event: 'dispatcher-idle-no-healthy-accounts', queued: 1 },
      { event: 'dispatcher-drain-start', pid: 666, signal: 'SIGTERM', inFlight: ['a'] },
    ],
    { isAlive: () => true }
  );
  assert.equal(result.status, 'draining');
});

// `pid 1` (init/systemd) is ALIVE but, on any non-root run, not
// signalable by this process -- `process.kill(1, 0)` throws EPERM, and the plain `processAlive`
// (orchestrator/lock.js) reads that identically to ESRCH ("gone"), which would have made this
// read `stopped`+`diedDraining: true` for a dispatcher pid that is very much alive: exactly the
// false-STOPPED-while-alive inversion card #164/#188 exist to prevent. `pidExists`
// (orchestrator/lock.js) is the fix -- it reads EPERM as "still there" -- and this pins the
// result holds the SAME both ways: as root (`process.kill(1, 0)` itself succeeds, no EPERM at
// all) and as a normal user (EPERM, caught and read as alive).
test('computeDispatcherStatus: pidExists(1) reads EPERM as alive, so a drain-start on pid 1 (init/systemd) reads draining, never diedDraining, root or not', () => {
  const result = computeDispatcherStatus([{ event: 'dispatcher-drain-start', pid: 1, signal: 'SIGTERM', inFlight: ['a'] }], {
    isAlive: pidExists,
  });
  assert.equal(result.status, 'draining');
  assert.notEqual(result.diedDraining, true);
});

// The unit test above proves computeDispatcherStatus itself, but the REAL call sites (bin/spo's
// cmdStatus, console/collect.js's applyWorkerStats) each still had to be edited by hand to inject
// pidExists instead of processAlive -- a mutant reverting either call site's `pidExists` injection
// back to `processAlive` would go uncaught by that unit test alone: pid 1 is EPERM for a non-root
// user, so `processAlive(1)` reads false ("gone"), misreporting the drain as diedDraining/STOPPED.
// This drives the real journal file through the REAL `spo status` binary and the REAL collectAll,
// never calling computeDispatcherStatus directly. On a non-root run (CI's case) it can only pass
// if BOTH production injection sites are still `pidExists`; as root, pid 1 is alive to
// `processAlive` too, so the test still passes but cannot tell the two apart. Holds root or not:
// `pid 1` (init/systemd) is always alive, EPERM or no EPERM.
test('a real daemon.jsonl with a drain-start on pid 1 reads DRAINING on both spo status and the deck, root or not', () => {
  const journalRoot = mkTmp('spo-188-pid1-j-');
  const queueDir = mkTmp('spo-188-pid1-q-');
  writeDaemonEvents(journalRoot, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 1, workers: 1 },
    {
      ts: '2026-09-10T00:01:00.000Z',
      event: 'dispatcher-drain-start',
      pid: 1,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'drain-requested',
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(out, /dispatcher: DRAINING/, `expected a DRAINING line: ${out}`);
  assert.doesNotMatch(out, /STOPPED/, `must not read pid 1 as dead: ${out}`);

  const data = collectAll({ journalRoot, queueDir, spoReportsDir: mkTmp('spo-188-pid1-reports-') });
  assert.equal(data.services.workers.status, 'draining');
});

// A `spo status` that ignored a drain-start's own `reason` and always printed 'drain-requested'
// went undetected: no test read the rendered STOPPED line for a died-inside-the-drain event
// carrying a non-default reason. These two read the real CLI output. (A write site that hardcodes
// 'drain-requested' is caught separately, by drain.test.js's section 1c.)

test("spo status on a died-inside-the-drain fixture prints the event's OWN reason, not a hardcoded 'drain-requested'", async () => {
  const journalRoot = mkTmp('spo-188-reason-dead-j-');
  const queueDir = mkTmp('spo-188-reason-dead-q-');
  const pid = await deadPid();
  writeDaemonEvents(journalRoot, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid, workers: 1 },
    {
      ts: '2026-09-10T00:01:00.000Z',
      event: 'dispatcher-drain-start',
      pid,
      signal: 'SIGTERM',
      inFlight: ['a'],
      reason: 'wall-clock-cap-exceeded',
    },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(out, /dispatcher: STOPPED/, `expected a STOPPED line for a dead pid: ${out}`);
  assert.match(out, /reason: wall-clock-cap-exceeded/, `expected the event's OWN reason, not a hardcoded one: ${out}`);
});

test("a LEGACY pid-less, reason-less drain-start (written before card #188) still falls back to 'drain-requested' -- the one case that IS a guess", async () => {
  const journalRoot = mkTmp('spo-188-reason-legacy-j-');
  const queueDir = mkTmp('spo-188-reason-legacy-q-');
  const pid = await deadPid();
  writeDaemonEvents(journalRoot, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid, workers: 1 },
    // No `pid`, no `reason` -- exactly the shape a pre-#188 record on disk has.
    { ts: '2026-09-10T00:01:00.000Z', event: 'dispatcher-drain-start', signal: 'SIGTERM', inFlight: ['a'] },
  ]);

  const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);
  assert.match(out, /dispatcher: STOPPED/, `expected a STOPPED line (legacy pid resolves off dispatcher-start, which is dead): ${out}`);
  assert.match(out, /reason: drain-requested/, `expected the inferred fallback for a legacy record with no reason field: ${out}`);
});

// ---- THE DISCRIMINATOR: card #186's own reason for existing -----------------------------------

test('THE DISCRIMINATOR: the SAME live-workers.json (present, 0 live) reads STOPPED after a dispatcher-stopped event, and an up dispatcher with no stop record still reads OK, never STOPPED', () => {
  const journalA = mkTmp('spo-186-discriminator-a-');
  const journalB = mkTmp('spo-186-discriminator-b-');
  const queueA = mkTmp('spo-186-discriminator-a-queue-');
  const queueB = mkTmp('spo-186-discriminator-b-queue-');

  // The SAME live-workers.json fixture, byte-identical, in both: present, 0 live workers, one
  // fixed `updatedAt` -- exactly the shape a stopped dispatcher leaves behind on disk, and exactly
  // the shape a genuinely up-but-idle one shows too. If the deck could tell these apart from
  // live-workers.json alone, this card would not exist.
  const fixedUpdatedAt = '2026-09-10T00:30:00.000Z';
  writeLiveWorkers(journalA, [], fixedUpdatedAt);
  writeLiveWorkers(journalB, [], fixedUpdatedAt);
  assert.deepEqual(
    fs.readFileSync(path.join(journalA, 'live-workers.json')),
    fs.readFileSync(path.join(journalB, 'live-workers.json')),
    'the two live-workers.json fixtures must be byte-identical -- the discriminator is that the DAEMON EVENTS differ, not this file'
  );

  // The dispatcher-stopped event's own age is pinned to a real, deterministic "1h ago" (computed
  // here, not hardcoded, so it stays true regardless of when this test runs) so the caption
  // assertions below can check an EXACT string, not just a shape.
  const stoppedTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Journal A: a dispatcher-start followed by a dispatcher-stopped, using a REAL stop reason
  // dispatcher.js actually writes (its own drain path, run()'s drain merge into stopReason).
  writeDaemonEvents(journalA, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 111, workers: 2 },
    { ts: stoppedTs, event: 'dispatcher-stopped', reason: 'drain-requested', signal: 'SIGTERM', drained: true, waitedMs: 0, survivors: [] },
  ]);
  // Journal B: the same dispatcher-start, and no stop.
  writeDaemonEvents(journalB, [{ ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 222, workers: 2 }]);

  const dataA = collectAll({ journalRoot: journalA, queueDir: queueA });
  const dataB = collectAll({ journalRoot: journalB, queueDir: queueB });

  assert.equal(dataA.services.workers.status, 'stopped', 'journal A ends on a dispatcher-stopped event -- the tile must read stopped');
  assert.equal(dataB.services.workers.status, 'ok', 'journal B has no stop at all -- present live-workers.json with 0 workers is a genuinely running, up dispatcher, and must still read ok');

  const htmlA = renderDashboard(dataA, { view: 'health' });
  const htmlB = renderDashboard(dataB, { view: 'health' });

  const workersTileA = extractSvcTile(htmlA, 'Workers');
  const workersTileB = extractSvcTile(htmlB, 'Workers');

  assert.match(workersTileA, /tile-red/, 'journal A must render the Workers tile red');
  assert.match(workersTileA, />STOPPED</, 'journal A must render the Workers tile as STOPPED');
  assert.doesNotMatch(workersTileA, />OK</);
  // The big number must not read like a reassuring live count: always the empty dash when
  // stopped, never the honest-but-misleading "0" a dead dispatcher's own live-workers.json can
  // still carry.
  assert.match(workersTileA, /<span class="svc-big">—<\/span>/, "journal A's Workers tile big number must be the empty dash, never a live count");
  // The exact caption, not just its shape -- pins the age wording, the reason, and the
  // drained-clean note together.
  assert.match(workersTileA, /<span class="svc-caption">stopped 1h ago — reason: drain-requested \(drained clean\)<\/span>/);

  assert.match(workersTileB, />OK</, 'journal B must render the Workers tile as OK, not STOPPED');
  assert.doesNotMatch(workersTileB, />STOPPED</);

  assert.notEqual(workersTileA, workersTileB, 'the two rendered Workers tiles must differ');
});

test('STOPPED with an incomplete drain: the survivors count is pinned in the caption, not just "drained clean"', () => {
  const journalRoot = mkTmp('spo-186-stopped-incomplete-drain-');
  const queueDir = mkTmp('spo-186-stopped-incomplete-drain-queue-');
  const stoppedTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeDaemonEvents(journalRoot, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 333, workers: 2 },
    {
      ts: stoppedTs,
      event: 'dispatcher-stopped',
      reason: 'drain-requested',
      signal: 'SIGTERM',
      drained: false,
      waitedMs: 2700000,
      survivors: ['issue-1', 'issue-2'],
    },
  ]);
  const data = collectAll({ journalRoot, queueDir });
  assert.equal(data.services.workers.status, 'stopped');
  assert.equal(data.services.workers.dispatcher.survivors, 2, 'services.workers.dispatcher.survivors must count the actual survivor ids');

  const html = renderDashboard(data, { view: 'health' });
  const workersTile = extractSvcTile(html, 'Workers');
  assert.match(
    workersTile,
    /<span class="svc-caption">stopped 1h ago — reason: drain-requested \(drained incomplete \(2 survivor\(s\)\)\)<\/span>/
  );
});

// A minimal base workers.services shape -- the tests below call renderServicesInner directly
// (exported by console/render.js) rather than the full page, since render.js is pure and takes no
// journal at all: a directly-constructed `services` object is the deterministic way to pin an
// exact caption, with no dependence on collectAll's own Date.now() read.
function baseServices(workers) {
  return { daemon: {}, queue: {}, benchWorker: {}, nightly: {}, verdicts: {}, retryChannel: {}, workers };
}

test('IDLE tile: exact color and caption, pinned directly', () => {
  const services = baseServices({
    status: 'idle',
    present: true,
    count: 0,
    staleCount: 0,
    trailingCount: 0,
    updatedAt: null,
    ageMs: null,
    dispatcher: {
      status: 'idle',
      since: '2026-09-10T00:00:00.000Z',
      sinceAgeMs: 60 * 60 * 1000,
      reason: null,
      drained: null,
      survivors: null,
      queued: 3,
      earliestCooldownUntil: null,
    },
  });
  const html = renderServicesInner(services, { rows: [] }, null);
  const workersTile = extractSvcTile(html, 'Workers');
  assert.match(workersTile, /tile-orange/, 'the IDLE tile must be orange');
  assert.match(workersTile, />IDLE</);
  assert.match(workersTile, /<span class="svc-caption">no healthy accounts — since 1h ago<\/span>/);
});

test('a stop record with no parseable ts (sinceAgeMs null) drops the age clause instead of rendering a dangling "stopped ... ago"', () => {
  const services = baseServices({
    status: 'stopped',
    present: true,
    count: 0,
    staleCount: 0,
    trailingCount: 0,
    updatedAt: null,
    ageMs: null,
    dispatcher: { status: 'stopped', since: null, sinceAgeMs: null, reason: 'drain-requested', drained: true, survivors: 0, queued: null, earliestCooldownUntil: null },
  });
  const html = renderServicesInner(services, { rows: [] }, null);
  const workersTile = extractSvcTile(html, 'Workers');
  assert.match(workersTile, /<span class="svc-caption">stopped — reason: drain-requested \(drained clean\)<\/span>/);
  assert.doesNotMatch(workersTile, /— ago/, 'no ts means no age to report -- a dangling age suffix must never appear');
});

test('an idle record with no parseable ts drops the since/ago clause the same way', () => {
  const services = baseServices({
    status: 'idle',
    present: false,
    count: 0,
    staleCount: 0,
    trailingCount: 0,
    updatedAt: null,
    ageMs: null,
    dispatcher: { status: 'idle', since: null, sinceAgeMs: null, reason: null, drained: null, survivors: null, queued: 2, earliestCooldownUntil: null },
  });
  const html = renderServicesInner(services, { rows: [] }, null);
  const workersTile = extractSvcTile(html, 'Workers');
  assert.match(workersTile, /<span class="svc-caption">no healthy accounts<\/span>/);
});

// ---- drainLine must never pair a start with a STALE end from an earlier drain -----------------

test('dispatcher drain in progress: an older, ALREADY-PAIRED end must not be shown as if it belonged to the newer start', () => {
  // Repro from verification: drain 1 finished cleanly two days ago (start + end); the dispatcher
  // restarted; drain 2 started 1 minute ago with 2 cards still in flight, no end recorded yet.
  // `result.dispatcher.lastDrainEnd` is still drain 1's end (the most recent DRAIN-END EVENT, an
  // independent field -- collect.js's own header on why these are never paired at write time), so
  // rendering start+end unconditionally described the IN-PROGRESS drain as long since finished.
  const reports = {
    last24h: {},
    pull: {},
    dispatcher: {
      lastDrainStart: { ts: '2026-09-10T00:01:00.000Z', signal: 'SIGTERM', inFlight: 2 },
      lastDrainEnd: { ts: '2026-09-08T00:00:00.000Z', drained: true, waitedMs: 500, survivors: 0 },
    },
  };
  const html = renderReportsInner(reports);
  assert.match(html, /dispatcher drain: started 2026-09-10T00:01:00\.000Z, in progress \(2 in flight\)/);
  assert.doesNotMatch(html, /ended 2026-09-08/, 'the stale end from the PREVIOUS drain must never be shown against the current start');
});

test('the ordinary case: an end that is NOT older than the latest start is shown paired with it', () => {
  const reports = {
    last24h: {},
    pull: {},
    dispatcher: {
      lastDrainStart: { ts: '2026-09-10T00:00:00.000Z', signal: 'SIGTERM', inFlight: 1 },
      lastDrainEnd: { ts: '2026-09-10T00:05:00.000Z', drained: true, waitedMs: 300000, survivors: 0 },
    },
  };
  const html = renderReportsInner(reports);
  assert.match(html, /dispatcher drain: started 2026-09-10T00:00:00\.000Z, ended 2026-09-10T00:05:00\.000Z \(drained clean\)/);
  assert.doesNotMatch(html, /in progress/);
});

test('the boundary case: an end whose ts EQUALS the start ts is still treated as paired with it, never as stale', () => {
  const reports = {
    last24h: {},
    pull: {},
    dispatcher: {
      lastDrainStart: { ts: '2026-09-10T00:00:00.000Z', signal: 'SIGTERM', inFlight: 1 },
      lastDrainEnd: { ts: '2026-09-10T00:00:00.000Z', drained: true, waitedMs: 0, survivors: 0 },
    },
  };
  const html = renderReportsInner(reports);
  assert.match(html, /dispatcher drain: started 2026-09-10T00:00:00\.000Z, ended 2026-09-10T00:00:00\.000Z \(drained clean\)/);
  assert.doesNotMatch(html, /in progress/);
  assert.doesNotMatch(html, /no drain-end recorded/);
});

// ---- an OPEN drain whose end was never written (a crash, an OOM, or a SIGKILL landing during
// dispatcher.js's own post-stop reap -- see that reap's own comment on the exact hazard) must
// never render "in progress" once a LATER event proves the process that opened it is gone --------

test('a full repro: drain-start 3h ago with 2 in flight, dispatcher-stopped 2h ago with no matching drain-end, then a restart 1h ago -- renders "no drain-end recorded", never "in progress", while the Workers tile still correctly reads OK for the NEW process', () => {
  const journalRoot = mkTmp('spo-186-open-drain-lost-end-');
  const queueDir = mkTmp('spo-186-open-drain-lost-end-queue-');
  writeLiveWorkers(journalRoot, []);
  writeDaemonEvents(journalRoot, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 1, workers: 2 },
    { ts: '2026-09-10T01:00:00.000Z', event: 'dispatcher-drain-start', signal: 'SIGTERM', inFlight: ['issue-1', 'issue-2'] },
    { ts: '2026-09-10T02:00:00.000Z', event: 'dispatcher-stopped', reason: 'drain-requested', drained: false, survivors: ['issue-1', 'issue-2'] },
    // No dispatcher-drain-end -- the process was killed (or crashed) before it could write one.
    { ts: '2026-09-10T03:00:00.000Z', event: 'dispatcher-start', pid: 2, workers: 2 },
  ]);
  const data = collectAll({ journalRoot, queueDir });
  assert.equal(
    data.services.workers.status,
    'ok',
    'the newest daemon.jsonl event is the restart -- the CURRENT process is up and live-workers.json is present, so the tile correctly reads ok'
  );
  const html = renderDashboard(data, { view: 'health' });
  assert.doesNotMatch(
    html,
    /in progress/,
    'the drain that opened at 01:00 is provably gone -- a later dispatcher-stopped AND a later dispatcher-start both postdate it -- so it must never still read as running'
  );
  assert.match(html, /dispatcher drain: started 2026-09-10T01:00:00\.000Z, no drain-end recorded/);
});

test('the same open drain with a stop recorded but NO restart afterward also renders "no drain-end recorded"', () => {
  const reports = {
    last24h: {},
    pull: {},
    dispatcher: {
      lastDrainStart: { ts: '2026-09-10T01:00:00.000Z', signal: 'SIGTERM', inFlight: 2 },
      lastDrainEnd: null,
      lastStopped: { ts: '2026-09-10T02:00:00.000Z', reason: 'drain-requested', drained: false, survivors: 2 },
      lastStart: null,
    },
  };
  const html = renderReportsInner(reports);
  assert.doesNotMatch(html, /in progress/);
  assert.match(html, /dispatcher drain: started 2026-09-10T01:00:00\.000Z, no drain-end recorded/);
});

test('an open drain where even the dispatcher-stopped write was lost, but a later restart exists on its own, still renders "no drain-end recorded"', () => {
  // Two ways a drain-start can end up with no dispatcher-stopped: that write is best-effort
  // (ENOSPC/EPERM/EROFS failures are swallowed), and a crash, OOM or SIGKILL during the drain's
  // own wait never reaches it at all -- so a drain-start can be followed by no dispatcher-stopped
  // while the process is still, eventually, replaced. `lastStart` alone must still prove the drain
  // is not running.
  const reports = {
    last24h: {},
    pull: {},
    dispatcher: {
      lastDrainStart: { ts: '2026-09-10T01:00:00.000Z', signal: 'SIGTERM', inFlight: 1 },
      lastDrainEnd: null,
      lastStopped: null,
      lastStart: { ts: '2026-09-10T02:00:00.000Z' },
    },
  };
  const html = renderReportsInner(reports);
  assert.doesNotMatch(html, /in progress/);
  assert.match(html, /dispatcher drain: started 2026-09-10T01:00:00\.000Z, no drain-end recorded/);
});

test('collectAll-level: a real journal with drain-start then a later dispatcher-start, no dispatcher-stopped and no drain-end at all, still renders "no drain-end recorded"', () => {
  // Exercises the real console/collect.js switch (not a hand-built `reports` object): proves the
  // `dispatcher-start` case actually populates `result.dispatcher.lastStart` end to end, and that
  // console/render.js reads it correctly, for the crash variant where even the dispatcher-stopped
  // write never happened.
  const journalRoot = mkTmp('spo-186-open-drain-no-stop-at-all-');
  const queueDir = mkTmp('spo-186-open-drain-no-stop-at-all-queue-');
  writeDaemonEvents(journalRoot, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 1, workers: 2 },
    { ts: '2026-09-10T01:00:00.000Z', event: 'dispatcher-drain-start', signal: 'SIGTERM', inFlight: ['issue-1'] },
    // No dispatcher-stopped and no dispatcher-drain-end at all -- the process vanished mid-drain.
    { ts: '2026-09-10T02:00:00.000Z', event: 'dispatcher-start', pid: 2, workers: 2 },
  ]);
  const data = collectAll({ journalRoot, queueDir });
  const html = renderDashboard(data, { view: 'health' });
  assert.doesNotMatch(html, /in progress/);
  assert.match(html, /dispatcher drain: started 2026-09-10T01:00:00\.000Z, no drain-end recorded/);
});

test('the boundary case for a lost drain-end: a dispatcher-stopped whose ts EQUALS the drain-start ts still proves the drain is not running', () => {
  // Realistic, not just a formal edge: with nothing in flight, dispatcher-stopped can share the
  // drain-start's own millisecond.
  const reports = {
    last24h: {},
    pull: {},
    dispatcher: {
      lastDrainStart: { ts: '2026-09-10T01:00:00.000Z', signal: 'SIGTERM', inFlight: 0 },
      lastDrainEnd: null,
      lastStopped: { ts: '2026-09-10T01:00:00.000Z', reason: 'drain-requested', drained: true, survivors: 0 },
      lastStart: null,
    },
  };
  const html = renderReportsInner(reports);
  assert.doesNotMatch(html, /in progress/);
  assert.match(html, /dispatcher drain: started 2026-09-10T01:00:00\.000Z, no drain-end recorded/);
});

test('the boundary case for a lost drain-end: a dispatcher-start whose ts EQUALS the drain-start ts still proves the drain is not running', () => {
  const reports = {
    last24h: {},
    pull: {},
    dispatcher: {
      lastDrainStart: { ts: '2026-09-10T01:00:00.000Z', signal: 'SIGTERM', inFlight: 1 },
      lastDrainEnd: null,
      lastStopped: null,
      lastStart: { ts: '2026-09-10T01:00:00.000Z' },
    },
  };
  const html = renderReportsInner(reports);
  assert.doesNotMatch(html, /in progress/);
  assert.match(html, /dispatcher drain: started 2026-09-10T01:00:00\.000Z, no drain-end recorded/);
});

// ---- precedence through the deck ---------------------------------------------------------------

test('precedence through the deck: [dispatcher-stopped, dispatcher-start] -> not stopped', () => {
  const journalRoot = mkTmp('spo-186-prec-start-after-stop-');
  const queueDir = mkTmp('spo-186-prec-start-after-stop-queue-');
  writeLiveWorkers(journalRoot, []);
  writeDaemonEvents(journalRoot, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-stopped', reason: 'drain-requested' },
    { ts: '2026-09-10T01:00:00.000Z', event: 'dispatcher-start', pid: 1, workers: 1 },
  ]);
  const data = collectAll({ journalRoot, queueDir });
  assert.notEqual(data.services.workers.status, 'stopped');
  assert.equal(data.services.workers.status, 'ok');
});

test("precedence through the deck: [dispatcher-start, dispatcher-idle-no-healthy-accounts] -> 'idle'", () => {
  const journalRoot = mkTmp('spo-186-prec-idle-');
  const queueDir = mkTmp('spo-186-prec-idle-queue-');
  writeDaemonEvents(journalRoot, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 1, workers: 1 },
    { ts: '2026-09-10T01:00:00.000Z', event: 'dispatcher-idle-no-healthy-accounts', queued: 3 },
  ]);
  const data = collectAll({ journalRoot, queueDir });
  assert.equal(data.services.workers.status, 'idle');
});

test("precedence through the deck: [dispatcher-start, dispatcher-stopped] with NO live-workers.json -> 'stopped' (not 'unknown')", () => {
  const journalRoot = mkTmp('spo-186-prec-stopped-no-live-');
  const queueDir = mkTmp('spo-186-prec-stopped-no-live-queue-');
  // Deliberately no writeLiveWorkers call -- present:false.
  writeDaemonEvents(journalRoot, [
    { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 1, workers: 1 },
    { ts: '2026-09-10T01:00:00.000Z', event: 'dispatcher-stopped', reason: 'worker-crash-circuit-breaker', consecutiveCrashes: 5, crashLimit: 5, lastId: 'issue-9' },
  ]);
  const data = collectAll({ journalRoot, queueDir });
  assert.equal(data.services.workers.status, 'stopped');
  assert.notEqual(data.services.workers.status, 'unknown');
});

test("precedence through the deck: no dispatcher events and no live-workers.json -> 'unknown' (unchanged)", () => {
  const journalRoot = mkTmp('spo-186-prec-unknown-');
  const queueDir = mkTmp('spo-186-prec-unknown-queue-');
  const data = collectAll({ journalRoot, queueDir });
  assert.equal(data.services.workers.status, 'unknown');
});

// ---- ONE SHARED FUNCTION, pinned ---------------------------------------------------------------

test('ONE SHARED FUNCTION: computeDispatcherStatus is defined exactly once across bin/spo, console/*.js and orchestrator/*.js, and both bin/spo and console/collect.js require the shared module', () => {
  const files = [
    'bin/spo',
    ...fs.readdirSync(path.join(REPO_ROOT, 'console')).filter((n) => n.endsWith('.js')).map((n) => `console/${n}`),
    ...fs.readdirSync(path.join(REPO_ROOT, 'orchestrator')).filter((n) => n.endsWith('.js')).map((n) => `orchestrator/${n}`),
  ];
  // Widened past the `function computeDispatcherStatus(` shape alone -- a copy written as an
  // arrow function assigned to a variable (`computeDispatcherStatus = (...) => ...`) or as an
  // object-literal method (`computeDispatcherStatus: (...) => ...`) is just as real a second
  // definition and must not evade this scan. The negative lookahead on `=` excludes an ordinary
  // equality comparison (`computeDispatcherStatus === 'x'`), which is never a definition.
  const defRe = /function\s+computeDispatcherStatus\s*\(|computeDispatcherStatus\s*=(?!=)|computeDispatcherStatus\s*:/g;
  const definedIn = [];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const count = (source.match(defRe) || []).length;
    if (count > 0) definedIn.push({ rel, count });
  }
  assert.deepEqual(
    definedIn,
    [{ rel: 'console/dispatcher-status.js', count: 1 }],
    'computeDispatcherStatus must be defined exactly once, in console/dispatcher-status.js -- a second copy anywhere is exactly the drift this card exists to close'
  );

  const spoSource = fs.readFileSync(path.join(REPO_ROOT, 'bin/spo'), 'utf8');
  assert.match(spoSource, /require\(\s*['"]\.\.\/console\/dispatcher-status['"]\s*\)/, "bin/spo must require '../console/dispatcher-status'");

  const collectSource = fs.readFileSync(path.join(REPO_ROOT, 'console/collect.js'), 'utf8');
  assert.match(collectSource, /require\(\s*['"]\.\/dispatcher-status['"]\s*\)/, "console/collect.js must require './dispatcher-status'");
});

test('MUTATION PROOF: an arrow-function copy of computeDispatcherStatus (a shape the plain `function computeDispatcherStatus(` regex alone could not see) is caught as a second definition', () => {
  const defRe = /function\s+computeDispatcherStatus\s*\(|computeDispatcherStatus\s*=(?!=)|computeDispatcherStatus\s*:/g;
  const realSpoSource = fs.readFileSync(path.join(REPO_ROOT, 'bin/spo'), 'utf8');
  const plantedSpoSource = `${realSpoSource}\nconst computeDispatcherStatus = (events) => (events.length ? events[0] : null);\n`;
  assert.equal((realSpoSource.match(defRe) || []).length, 0, 'fixture precondition: bin/spo must not define computeDispatcherStatus today');
  assert.equal(
    (plantedSpoSource.match(defRe) || []).length,
    1,
    'a planted arrow-function copy (`computeDispatcherStatus = (...) => ...`) must be caught as a definition -- if this is 0, the widened regex missed it'
  );
});

// ---- AGREEMENT: `spo status` and the deck read the same journals the same way ------------------

test("AGREEMENT: for the same journals, `spo status` prints STOPPED/IDLE exactly when the deck (collectAll) reports 'stopped'/'idle'", () => {
  const cases = [
    {
      label: 'stopped',
      events: [
        { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 1, workers: 1 },
        { ts: '2026-09-10T01:00:00.000Z', event: 'dispatcher-stopped', reason: 'drain-requested', drained: true, waitedMs: 0, survivors: [] },
      ],
      liveWorkers: true,
    },
    {
      label: 'idle',
      events: [
        { ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 2, workers: 1 },
        { ts: '2026-09-10T01:00:00.000Z', event: 'dispatcher-idle-no-healthy-accounts', healthy: 0, queued: 1 },
      ],
      liveWorkers: false,
    },
    {
      label: 'running',
      events: [{ ts: '2026-09-10T00:00:00.000Z', event: 'dispatcher-start', pid: 3, workers: 1 }],
      liveWorkers: true,
    },
  ];

  for (const c of cases) {
    const journalRoot = mkTmp(`spo-186-agree-${c.label}-`);
    const queueDir = mkTmp(`spo-186-agree-${c.label}-queue-`);
    writeDaemonEvents(journalRoot, c.events);
    if (c.liveWorkers) writeLiveWorkers(journalRoot, []);

    const data = collectAll({ journalRoot, queueDir });
    const out = runSpo(['status', '--journal', journalRoot, '--queue', queueDir]);

    assert.equal(
      /dispatcher: STOPPED/.test(out),
      data.services.workers.status === 'stopped',
      `case "${c.label}": spo status's STOPPED line must agree with the deck`
    );
    assert.equal(
      /dispatcher: IDLE/.test(out),
      data.services.workers.status === 'idle',
      `case "${c.label}": spo status's IDLE line must agree with the deck`
    );
  }
});

// ---- the switch: one of each of the 7 new event kinds ------------------------------------------

test('collectReportPipeline: one of each of the 7 new event kinds populates its own field, and report-held-mechanical/unclaimable never inflate the generic held count', () => {
  const journalRoot = mkTmp('spo-186-switch-');
  const fixedNow = Date.now();
  const now = new Date(fixedNow).toISOString();
  // One of each held kind OUTSIDE the 24h window too (30h before `fixedNow`), pinning that
  // the window check applies to `heldMechanical`/`heldUnclaimable` exactly the way it already did
  // to the generic `held` -- without this, a mutation that dropped the `inWindow` guard on just
  // the two new cases would still pass every other assertion here.
  const outOfWindow = new Date(fixedNow - 30 * 60 * 60 * 1000).toISOString();
  writeDaemonEvents(journalRoot, [
    { ts: now, event: 'report-held', issue: 900 },
    { ts: outOfWindow, event: 'report-held', issue: 903 },
    { ts: now, event: 'report-held-mechanical', issue: 901, attempts: 3, lastError: 'boom' },
    { ts: outOfWindow, event: 'report-held-mechanical', issue: 904, attempts: 1 },
    { ts: now, event: 'report-held-unclaimable', issue: 902, reason: 'no-repo-labels' },
    { ts: outOfWindow, event: 'report-held-unclaimable', issue: 905, reason: 'no-repo-labels' },
    { ts: now, event: 'dispatcher-idle-no-healthy-accounts', queued: 4, earliestCooldownUntil: '2026-09-11T00:00:00.000Z' },
    { ts: now, event: 'dispatcher-drain-start', signal: 'SIGTERM', inFlight: ['a', 'b'] },
    { ts: now, event: 'dispatcher-stopped', reason: 'drain-requested', drained: false, survivors: ['a'] },
    { ts: now, event: 'dispatcher-drain-end', drained: false, waitedMs: 1500, survivors: ['a'] },
    { ts: now, event: 'dispatcher-start', pid: 9, workers: 2 },
  ]);

  const reports = collectReportPipeline(journalRoot, null, { now: fixedNow });

  assert.equal(reports.last24h.held, 1, 'the generic held count must only see the in-window report-held, not the 30h-old one');
  assert.equal(reports.last24h.heldMechanical, 1, 'the 30h-old report-held-mechanical must not be counted');
  assert.equal(reports.last24h.heldUnclaimable, 1, 'the 30h-old report-held-unclaimable must not be counted');

  assert.ok(reports.dispatcher.lastIdle);
  assert.equal(reports.dispatcher.lastIdle.queued, 4);
  assert.equal(reports.dispatcher.lastIdle.earliestCooldownUntil, '2026-09-11T00:00:00.000Z');

  assert.ok(reports.dispatcher.lastDrainStart);
  assert.equal(reports.dispatcher.lastDrainStart.signal, 'SIGTERM');
  assert.equal(reports.dispatcher.lastDrainStart.inFlight, 2);

  assert.ok(reports.dispatcher.lastStopped);
  assert.equal(reports.dispatcher.lastStopped.reason, 'drain-requested');
  assert.equal(reports.dispatcher.lastStopped.drained, false);
  assert.equal(reports.dispatcher.lastStopped.survivors, 1);

  assert.ok(reports.dispatcher.lastDrainEnd);
  assert.equal(reports.dispatcher.lastDrainEnd.waitedMs, 1500);
  assert.equal(reports.dispatcher.lastDrainEnd.survivors, 1);

  assert.ok(reports.dispatcher.lastStart);
  assert.equal(reports.dispatcher.lastStart.ts, now);
});

test('the rendered "24h holds" line shows the mechanical/unclaimable counts, and is absent entirely when both are zero', () => {
  const withHolds = renderReportsInner({ last24h: { heldMechanical: 2, heldUnclaimable: 3 }, pull: {}, dispatcher: {} });
  assert.match(withHolds, /<p class="meta">24h holds: 2 mechanical &middot; 3 unclaimable<\/p>/);

  const withoutHolds = renderReportsInner({ last24h: { heldMechanical: 0, heldUnclaimable: 0 }, pull: {}, dispatcher: {} });
  assert.doesNotMatch(withoutHolds, /24h holds/);
});
