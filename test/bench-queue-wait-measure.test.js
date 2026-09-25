'use strict';
// Unit tests for scripts/bench-queue-wait-measure.js -- the read-only tool card #246 re-derived
// orchestrator/bench-queue-wait.js's four constants with. Pure: throwaway spool/journal dirs, no
// spawn, never the live ~/.spo-bench or ~/.spo-state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');
const {
  readSpoolReports,
  readGateSpawns,
  isGateSpawn,
  stats,
  measure,
  exceedances,
  parseArgs,
  ceilToSecondMs,
  run,
} = require('../scripts/bench-queue-wait-measure');
const { mkTmp } = require('./helpers');

const T0 = Date.parse('2026-09-10T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function writeReport(benchDir, id, type, startMs, durationMs, verdict = 'PASS') {
  const doneDir = path.join(benchDir, 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  const report = { id, type, verdict, startedAt: iso(startMs), finishedAt: iso(startMs + durationMs) };
  fs.writeFileSync(path.join(doneDir, `${id}.json`), JSON.stringify(report));
}

function writeJournal(stateDir, task, events) {
  const dir = path.join(stateDir, 'journal', task);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

const gateSpawn = (ts, ms, extra = {}) => ({
  ts, state: 'GATE', event: 'spawn', argv: ['npm', 'run', 'gate'], exit: 0, ms, commandClass: 'npm-gate', timedOut: false, ...extra,
});

test('stats: nearest-rank p95, true median for odd and even n, nulls for an empty set', () => {
  assert.deepEqual(stats([]), { n: 0, medianS: null, p95S: null, maxS: null });
  assert.deepEqual(stats([3000, 1000, 2000]), { n: 3, medianS: 2, p95S: 3, maxS: 3 });
  assert.deepEqual(stats([1000, 2000, 3000, 4000]), { n: 4, medianS: 2.5, p95S: 4, maxS: 4 });
  // 20 values 1..20 s: nearest-rank p95 is the 19th, not the max.
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 1000);
  assert.equal(stats(twenty).p95S, 19);
});

test('ceilToSecondMs: rounds a max UP to the next whole second, leaves a whole second alone', () => {
  assert.equal(ceilToSecondMs(676891), 677000);
  assert.equal(ceilToSecondMs(712677), 713000);
  assert.equal(ceilToSecondMs(316000), 316000);
  assert.equal(ceilToSecondMs(1), 1000);
});

test('isGateSpawn: only a spawn event whose argv is exactly npm run gate, with a numeric ms', () => {
  assert.equal(isGateSpawn(gateSpawn('2026-09-10T00:00:00Z', 1000)), true);
  assert.equal(isGateSpawn(gateSpawn('2026-09-10T00:00:00Z', 1000, { argv: ['npm', 'run', 'gate:e2e'] })), false);
  assert.equal(isGateSpawn(gateSpawn('2026-09-10T00:00:00Z', 1000, { argv: ['npm', 'run', 'gate', '--', 'x'] })), false);
  assert.equal(isGateSpawn(gateSpawn('2026-09-10T00:00:00Z', 1000, { event: 'board-move' })), false);
  assert.equal(isGateSpawn(gateSpawn('2026-09-10T00:00:00Z', undefined)), false);
  assert.equal(isGateSpawn(null), false);
});

test('measure: each type\'s max becomes its constant (rounded up), lease is never mapped, the gate term comes from the journal', () => {
  const bench = mkTmp('bqw-bench-');
  const state = mkTmp('bqw-state-');
  writeReport(bench, 'r1', 'ref', T0, 200000);
  writeReport(bench, 'r2', 'ref', T0 + 1000000, 676891, 'FAIL');
  writeReport(bench, 'n1', 'nightly', T0, 775626, 'FAIL');
  writeReport(bench, 'n2', 'nightly', T0 + 2000000, 215000);
  writeReport(bench, 'l1', 'live', T0, 316000);
  writeReport(bench, 'x1', 'lease', T0, 7200000);
  fs.writeFileSync(path.join(bench, 'done', 'broken.json'), 'not json');
  fs.writeFileSync(path.join(bench, 'done', 'r1.log'), 'a log, not a report');
  writeJournal(state, 'issue-1', [
    gateSpawn(iso(T0 + 100), 251843),
    { ts: iso(T0 + 200), state: 'GATE', event: 'spawn', argv: ['git', 'rev-parse', 'HEAD'], ms: 9999999 },
  ]);
  writeJournal(state, 'issue-2', [gateSpawn(iso(T0 + 300), 712677), gateSpawn(iso(T0 + 400), 5000, { timedOut: true })]);
  fs.writeFileSync(path.join(state, 'journal', 'daemon.jsonl'), JSON.stringify(gateSpawn(iso(T0), 99999999)) + '\n');

  const { reports, skipped } = readSpoolReports(bench);
  assert.equal(skipped, 1, 'the unparsable report is counted, not silently dropped');
  assert.equal(reports.length, 6, 'the .log file is not a report');
  const spawns = readGateSpawns(path.join(state, 'journal'));
  assert.equal(spawns.length, 3, 'only npm run gate spawns, and only from task journals (daemon.jsonl is not one)');

  const out = measure(reports, spawns);
  assert.deepEqual(out.derived, {
    SIBLING_REF_JOB_MAX_MS: 677000,
    NIGHTLY_JOB_MAX_MS: 776000,
    LIVE_JOB_MAX_MS: 316000,
    OWN_GATE_JOB_MAX_MS: 713000,
  });
  assert.equal(out.spool.ref.n, 2);
  assert.equal(out.spool.ref.maxJob, 'r2 (FAIL)', 'a FAIL holds the worker as long as a PASS -- its duration counts');
  assert.equal(out.spool.lease.n, 1, 'a lease is reported but never becomes a constant');
  assert.equal(out.gate.n, 3);
  assert.equal(out.gate.timedOut, 1);
  assert.equal(out.window.spool.from, iso(T0));
  assert.equal(out.window.journal.to, iso(T0 + 400));
});

test('measure: --since/--until narrow both sources by their own timestamps', () => {
  const reports = [
    { id: 'old', type: 'nightly', verdict: 'FAIL', startedAt: iso(T0), ms: 775626 },
    { id: 'new', type: 'nightly', verdict: 'PASS', startedAt: iso(T0 + 86400000), ms: 224878 },
  ];
  const spawns = [
    { task: 'a', ts: iso(T0), ms: 712677 },
    { task: 'b', ts: iso(T0 + 86400000), ms: 321274 },
  ];
  const windowed = measure(reports, spawns, { since: iso(T0 + 1000) });
  assert.equal(windowed.derived.NIGHTLY_JOB_MAX_MS, 225000);
  assert.equal(windowed.derived.OWN_GATE_JOB_MAX_MS, 322000);
  assert.equal(windowed.derived.SIBLING_REF_JOB_MAX_MS, null, 'a type with no report in the window derives nothing, never 0');
  const early = measure(reports, spawns, { until: iso(T0 + 1000) });
  assert.equal(early.derived.NIGHTLY_JOB_MAX_MS, 776000);
});

test('exceedances: a measured value above its pin, or a pin that is missing, is reported; an equal one is not', () => {
  const pinnedConstants = { A: 1000, B: 2000 };
  assert.deepEqual(exceedances({ A: 1000, B: 3000 }, pinnedConstants), ['B']);
  assert.deepEqual(exceedances({ A: 1000, C: 1 }, pinnedConstants), ['C']);
  assert.deepEqual(exceedances({ A: null }, pinnedConstants), [], 'no measurement is not an exceedance');
});

test('exceedances against the real module: every constant the script derives is exported and pinned', () => {
  const pinned = require('../orchestrator/bench-queue-wait.js');
  const derivedAtPin = {
    SIBLING_REF_JOB_MAX_MS: pinned.SIBLING_REF_JOB_MAX_MS,
    NIGHTLY_JOB_MAX_MS: pinned.NIGHTLY_JOB_MAX_MS,
    LIVE_JOB_MAX_MS: pinned.LIVE_JOB_MAX_MS,
    OWN_GATE_JOB_MAX_MS: pinned.OWN_GATE_JOB_MAX_MS,
  };
  const derivedNames = Object.keys(measure([], []).derived).sort();
  assert.deepEqual(derivedNames, Object.keys(derivedAtPin).sort(), 'the script derives exactly the module\'s four constants');
  assert.deepEqual(exceedances(derivedAtPin, pinned), []);
});

test('parseArgs: defaults to the live dirs, accepts the documented flags, refuses anything else', () => {
  const d = parseArgs([]);
  assert.match(d.benchDir, /\.spo-bench$/);
  assert.match(d.stateDir, /\.spo-state$/);
  assert.equal(d.check, false);
  const o = parseArgs(['--bench-dir=/b', '--state-dir=/s', '--since=2026-09-01', '--until=2026-09-20', '--check']);
  assert.deepEqual(o, { benchDir: '/b', stateDir: '/s', since: '2026-09-01', until: '2026-09-20', check: true });
  assert.throws(() => parseArgs(['--bogus']), /unrecognized argument/);
});

test('parseArgs: an unparseable --since/--until is refused, never passed through as a window', () => {
  assert.throws(() => parseArgs(['--since=last-tuesday']), /--since must be a date/);
  assert.throws(() => parseArgs(['--until=2026-13-45']), /--until must be a date/);
});

test('measure: the own-gate max INCLUDES a timed-out run -- a gate that hit its limit waited longest of all', () => {
  const spawns = [
    { task: 'a', ts: iso(T0), ms: 200000, timedOut: false },
    { task: 'b', ts: iso(T0 + 1), ms: 7800000, timedOut: true },
  ];
  const out = measure([], spawns);
  assert.equal(out.derived.OWN_GATE_JOB_MAX_MS, 7800000);
  assert.equal(out.gate.timedOut, 1);
});

function capture() {
  const io = { out: '', err: '' };
  io.stdout = { write: (s) => { io.out += s; } };
  io.stderr = { write: (s) => { io.err += s; } };
  return io;
}

// A corpus whose every type sits at or under the module's real pins.
function coveredCorpus() {
  const bench = mkTmp('bqw-run-bench-');
  const state = mkTmp('bqw-run-state-');
  writeReport(bench, 'r', 'ref', T0, 600000);
  writeReport(bench, 'n', 'nightly', T0, 700000);
  writeReport(bench, 'l', 'live', T0, 300000);
  writeJournal(state, 'issue-1', [gateSpawn(iso(T0), 700000)]);
  return { bench, state };
}

test('run --check: 0 when every pin covers the corpus, 1 when one is outgrown -- the exit path itself', () => {
  const { bench, state } = coveredCorpus();
  const ok = capture();
  assert.equal(run([`--bench-dir=${bench}`, `--state-dir=${state}`, '--check'], ok), 0, ok.err);
  assert.deepEqual(JSON.parse(ok.out).exceedsPin, []);

  writeReport(bench, 'r-long', 'ref', T0 + 1000, 9000000, 'FAIL');
  const over = capture();
  assert.equal(run([`--bench-dir=${bench}`, `--state-dir=${state}`, '--check'], over), 1);
  assert.match(over.err, /outgrown the pin for SIBLING_REF_JOB_MAX_MS/);
  // Without --check the same corpus only reports: measuring is not a verdict.
  assert.equal(run([`--bench-dir=${bench}`, `--state-dir=${state}`], capture()), 0);
});

test('run --check: an empty corpus, or a window with nothing in it, exits 1 -- "nothing measured" is never "still covered"', () => {
  const bench = mkTmp('bqw-empty-bench-');
  const state = mkTmp('bqw-empty-state-');
  fs.mkdirSync(path.join(bench, 'done'));
  fs.mkdirSync(path.join(state, 'journal'));
  const empty = capture();
  assert.equal(run([`--bench-dir=${bench}`, `--state-dir=${state}`, '--check'], empty), 1);
  assert.match(empty.err, /nothing measured for .*OWN_GATE_JOB_MAX_MS/);

  const covered = coveredCorpus();
  const future = capture();
  assert.equal(run([`--bench-dir=${covered.bench}`, `--state-dir=${covered.state}`, '--since=2099-01-01', '--check'], future), 1);
});

test('run: a mis-pointed corpus directory or a bad argument exits 2 with a message and no report', () => {
  const missing = capture();
  assert.equal(run(['--bench-dir=/nonexistent/spo-bench', '--check'], missing), 2);
  assert.equal(missing.out, '');
  assert.match(missing.err, /ENOENT/);

  const badDate = capture();
  assert.equal(run(['--since=garbage'], badDate), 2);
  assert.equal(badDate.out, '', 'an unreadable window must not print a report filtered by it');
  assert.match(badDate.err, /--since must be a date/);

  const badFlag = capture();
  assert.equal(run(['--bogus'], badFlag), 2);
  assert.match(badFlag.err, /unrecognized argument/);
});
