#!/usr/bin/env node
'use strict';
// bench-queue-wait-measure -- re-derives orchestrator/bench-queue-wait.js's four measured
// constants from the two corpora they come from, so the next revision is one command instead of a
// hand re-measurement (card #246: three of the old values had been measured on a sample the
// author believed was a one-day window, and all three understated the real max by 3x or more).
//
// READ-ONLY against both corpora: it lists and reads, never writes, renames or deletes.
//
// Usage:   node scripts/bench-queue-wait-measure.js [--bench-dir=DIR] [--state-dir=DIR]
//                                                   [--since=ISO] [--until=ISO] [--check]
// Sources:
//   bench spool   every `<bench-dir>/done/<id>.json` report (default ~/.spo-bench). Service time
//                 = the report's own finishedAt - startedAt, i.e. how long the job held the one
//                 serial bench worker, whatever its verdict. Grouped by the report's `type`.
//   journal       every `spawn` event whose argv is exactly `npm run gate`, in each task dir's
//                 journal.jsonl under `<state-dir>/journal` (default ~/.spo-state). Its `ms` is
//                 GATE's client-observed duration, submission to verdict, queue wait included.
// Window:  --since/--until (anything Date.parse reads) filter a report on its startedAt and a
//          spawn on its ts. No flag = everything on disk, which is how the pinned values were
//          measured (see bench-queue-wait.js's header for why the whole corpus, not a window).
// Output:  one JSON document on stdout -- per source n/median/p95/max (seconds, nearest-rank
//          p95), the window each source actually covered, the constants derived from them (each
//          max rounded UP to the next whole second), the constants currently pinned, and the
//          bound at K=1..3 under the pinned ones.
// --check: exit 1 when any derived constant exceeds its pinned value -- the corpus has outgrown
//          the pin and the literal (plus test/real-steps.test.js's pin of it) needs revising --
//          or when a constant could not be derived at all (empty or mis-pointed corpus).
//          A MANUAL check: nothing runs it (a suite test against the live spool would not be
//          hermetic). Run it in a bench or model audit and before quoting the margins.
// Exit:    0 ok, 1 --check failed, 2 bad arguments (an unrecognized flag, or a --since/--until
//          Date.parse cannot read) or an unreadable corpus directory.

const fs = require('fs');
const os = require('os');
const path = require('path');

const pinned = require('../orchestrator/bench-queue-wait.js');

// type in the spool -> the constant its max becomes. `lease` is deliberately absent: a lease is a
// human's interactive session on the bench (worker.ts's DEFAULT_LEASE_MINUTES / MAX_LEASE_MINUTES),
// outside the pipeline-burst model -- bench-queue-wait.js's header says why.
const SPOOL_TYPE_TO_CONSTANT = {
  ref: 'SIBLING_REF_JOB_MAX_MS',
  nightly: 'NIGHTLY_JOB_MAX_MS',
  live: 'LIVE_JOB_MAX_MS',
};

function inWindow(ts, opts) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  if (opts.since && t < Date.parse(opts.since)) return false;
  if (opts.until && t > Date.parse(opts.until)) return false;
  return true;
}

// readSpoolReports(benchDir) -> {reports: [{id, type, verdict, startedAt, ms}], skipped};
// unreadable or timestamp-less reports are counted in `skipped`, never silently dropped.
function readSpoolReports(benchDir) {
  const doneDir = path.join(benchDir, 'done');
  const reports = [];
  let skipped = 0;
  for (const name of fs.readdirSync(doneDir).sort()) {
    if (!name.endsWith('.json')) continue;
    let r;
    try {
      r = JSON.parse(fs.readFileSync(path.join(doneDir, name), 'utf8'));
    } catch {
      skipped += 1;
      continue;
    }
    const ms = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
    if (!Number.isFinite(ms) || ms < 0) {
      skipped += 1;
      continue;
    }
    reports.push({ id: r.id, type: r.type, verdict: r.verdict, startedAt: r.startedAt, ms });
  }
  return { reports, skipped };
}

function isGateSpawn(e) {
  return (
    Boolean(e) && e.event === 'spawn' && Array.isArray(e.argv) && e.argv.length === 3 &&
    e.argv[0] === 'npm' && e.argv[1] === 'run' && e.argv[2] === 'gate' && typeof e.ms === 'number'
  );
}

// readGateSpawns(journalDir) -> [{task, ts, ms, exit, timedOut}], one per real `npm run gate`.
function readGateSpawns(journalDir) {
  const spawns = [];
  for (const task of fs.readdirSync(journalDir).sort()) {
    let text;
    try {
      text = fs.readFileSync(path.join(journalDir, task, 'journal.jsonl'), 'utf8');
    } catch {
      continue; // daemon.jsonl, lock files, task dirs without a journal
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"gate"')) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (isGateSpawn(e)) spawns.push({ task, ts: e.ts, ms: e.ms, exit: e.exit, timedOut: e.timedOut === true });
    }
  }
  return spawns;
}

// stats(msValues) -> {n, medianS, p95S, maxS} in seconds (3 decimals); nearest-rank p95.
function stats(msValues) {
  const s = [...msValues].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return { n: 0, medianS: null, p95S: null, maxS: null };
  const sec = (ms) => Number((ms / 1000).toFixed(3));
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { n, medianS: sec(median), p95S: sec(s[Math.ceil(0.95 * n) - 1]), maxS: sec(s[n - 1]) };
}

const ceilToSecondMs = (ms) => Math.ceil(ms / 1000) * 1000;

function span(timestamps) {
  const sorted = timestamps.filter((t) => Number.isFinite(Date.parse(t))).sort();
  return sorted.length ? { from: sorted[0], to: sorted[sorted.length - 1] } : { from: null, to: null };
}

// measure(reports, spawns, opts) -> the whole report, minus I/O. Pure, so the test drives it
// with fixtures instead of the live spool.
function measure(reports, spawns, opts = {}) {
  const rs = reports.filter((r) => inWindow(r.startedAt, opts));
  const gs = spawns.filter((g) => inWindow(g.ts, opts));

  const byType = {};
  for (const r of rs) (byType[r.type] ||= []).push(r);
  const spool = {};
  for (const [type, rows] of Object.entries(byType).sort()) {
    const worst = rows.reduce((a, b) => (b.ms > a.ms ? b : a));
    spool[type] = { ...stats(rows.map((r) => r.ms)), maxJob: `${worst.id} (${worst.verdict})` };
  }

  const derived = {};
  for (const [type, name] of Object.entries(SPOOL_TYPE_TO_CONSTANT)) {
    const rows = byType[type] || [];
    derived[name] = rows.length ? ceilToSecondMs(Math.max(...rows.map((r) => r.ms))) : null;
  }
  derived.OWN_GATE_JOB_MAX_MS = gs.length ? ceilToSecondMs(Math.max(...gs.map((g) => g.ms))) : null;

  return {
    window: {
      since: opts.since || null,
      until: opts.until || null,
      spool: span(rs.map((r) => r.startedAt)),
      journal: span(gs.map((g) => g.ts)),
    },
    spool,
    gate: { ...stats(gs.map((g) => g.ms)), timedOut: gs.filter((g) => g.timedOut).length },
    derived,
  };
}

// exceedances(derived, pinnedConstants) -> names whose measured value is above the pin. A pin that
// is missing or not a number counts as exceeded: a constant the module stopped exporting must
// not read as "still covered".
function exceedances(derived, pinnedConstants) {
  return Object.keys(derived).filter((name) => derived[name] != null && !(pinnedConstants[name] >= derived[name]));
}

function parseArgs(argv) {
  const opts = { benchDir: path.join(os.homedir(), '.spo-bench'), stateDir: path.join(os.homedir(), '.spo-state'), check: false };
  for (const arg of argv) {
    if (arg === '--check') {
      opts.check = true;
      continue;
    }
    const m = /^--(bench-dir|state-dir|since|until)=(.+)$/.exec(arg);
    if (!m) throw new Error(`unrecognized argument ${JSON.stringify(arg)}`);
    if ((m[1] === 'since' || m[1] === 'until') && !Number.isFinite(Date.parse(m[2]))) {
      throw new Error(`--${m[1]} must be a date Date.parse can read (e.g. 2026-09-17 or 2026-09-17T00:00:00Z)`);
    }
    const key = { 'bench-dir': 'benchDir', 'state-dir': 'stateDir' }[m[1]] || m[1];
    opts[key] = m[2];
  }
  return opts;
}

// run(argv, io) -> exit code. 0 = measured (and, with --check, every pin still covers the corpus);
// 1 = --check failed: a derived value exceeds its pin, OR a constant could not be derived at all
// (an empty or mis-pointed corpus, or a window with no job of that type -- "nothing measured"
// must never read as "still covered"); 2 = bad arguments or an unreadable corpus directory.
function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let opts;
  let reports;
  let skipped;
  let spawns;
  try {
    opts = parseArgs(argv);
    ({ reports, skipped } = readSpoolReports(opts.benchDir));
    spawns = readGateSpawns(path.join(opts.stateDir, 'journal'));
  } catch (err) {
    io.stderr.write(`bench-queue-wait-measure: ${err.message}\n`);
    return 2;
  }
  const out = measure(reports, spawns, opts);
  out.spoolSkipped = skipped;
  out.pinned = {};
  for (const name of Object.keys(out.derived)) out.pinned[name] = pinned[name];
  out.boundMsPinned = { 1: pinned.benchQueueWaitBoundMs(1), 2: pinned.benchQueueWaitBoundMs(2), 3: pinned.benchQueueWaitBoundMs(3) };
  out.exceedsPin = exceedances(out.derived, out.pinned);
  out.notMeasured = Object.keys(out.derived).filter((name) => out.derived[name] == null);
  io.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!opts.check) return 0;
  if (out.exceedsPin.length) io.stderr.write(`bench-queue-wait-measure: the corpus has outgrown the pin for ${out.exceedsPin.join(', ')}\n`);
  if (out.notMeasured.length) io.stderr.write(`bench-queue-wait-measure: nothing measured for ${out.notMeasured.join(', ')} -- empty or mis-pointed corpus, or an empty window\n`);
  return out.exceedsPin.length || out.notMeasured.length ? 1 : 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { readSpoolReports, readGateSpawns, isGateSpawn, stats, measure, exceedances, parseArgs, run, ceilToSecondMs, SPOOL_TYPE_TO_CONSTANT };
