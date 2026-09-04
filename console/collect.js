'use strict';
// console/collect.js -- reads the local, on-disk runtime surfaces the dashboard renders, and
// hands back one plain data object. Every read here is defensive: a missing file or directory
// produces an empty/undefined result, never a throw -- console/render.js then renders that as
// an empty section (same philosophy as bin/spo: "the console is a reader, never a second
// source of truth", orchestrator/README.md § Observability). This module does all the
// filesystem work so render.js can stay a pure function of already-parsed data.
//
// This module is 100% synchronous and 100% disk-local -- no network, no os.cpus() sampling, no
// token scanning. Those live in console/system.js, console/prod-version.js and
// console/usage-scan.js respectively, driven by console/serve.js, and are merged into this
// object's `system`/`prod`/`tokens` keys (always null here) only by the live server. That split
// is what lets `spo dashboard` (no --serve) stay instant and network-free. `trend` is the one
// exception -- collectTrend() below only reads an already-computed rollup file
// (console/usage-rollups.js), it never runs the scanner, so it can be populated here too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const accountsModule = require('../orchestrator/accounts');
const { processAlive } = require('../orchestrator/lock');
const { describeLiveWorkers } = require('../orchestrator/worker-status');
const { HEARTBEAT_STALE_MS, heartbeatAgeMs: benchHeartbeatAgeMs } = require('../orchestrator/bench-heartbeat');
const { summarizeUnparkScanTail } = require('../orchestrator/retry-channel');

const QUEUE_PREVIEW_LIMIT = 25;
const VERDICTS_LIMIT = 5;
const DAEMON_EVENTS_MAX_BYTES = 1024 * 1024;
const DAEMON_EVENTS_MAX_LINES = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
// action 5.5, item B: one shared staleness threshold for BOTH bench-produced surfaces (nightly
// and verdicts come from the same ~/.spo-bench worker) -- 36h was already nightly's own
// threshold (a nightly cron that misses one full day plus its own run window); verdicts fire on
// every push to main, more often than nightly, so a 36h-old *last* verdict is an even stronger
// signal something upstream (the worker, or pushes themselves) stopped, not weekend noise.
const STALE_BENCH_AGE_MS = 36 * 60 * 60 * 1000;
// The manually-produced usage snapshot (journal/usage-snapshot.json, collectUsageSnapshot below)
// has no automatic refresh at all -- unlike the tokens trend (usage-scan.js's live scanner
// updates journal/usage-rollups.json every ~5 min), so it is judged stale on a coarser, calendar
// -day clock: one day old already means it missed a full day of daemon activity, which is the
// coarsest freshness question a snapshot table can be asked to answer honestly.
const SNAPSHOT_STALE_MS = DAY_MS;

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function listTaskDirs(dir) {
  if (!dir) return [];
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readJournalLines(taskDir) {
  const p = path.join(taskDir, 'journal.jsonl');
  try {
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// One card's worth of data per journal/<id>/ directory. Reads state.json (current
// state/reason/updatedAt), task.json (title/kind fallback, in case state.json predates a
// field), and journal.jsonl (last event, and every recorded `llm-call` event -- see
// orchestrator/steps/llm.js's appendEvent call for the exact shape: {step, model, effort,
// account, sessionId, tokensSource, freshInputTokens, cacheCreationTokens, cacheReadTokens,
// outputTokens, billableTokens, numTurns, ok}). No dollar figure is ever collected here -- see
// console/render.js's header ("NEVER a dollar figure"); `orchestrator/tokens.js` / `spo tokens`
// own the token-accounting view instead.
function collectJournalTasks(journalRoot) {
  const ids = listTaskDirs(journalRoot);
  return ids.map((id) => {
    const dir = path.join(journalRoot, id);
    const state = readJsonSafe(path.join(dir, 'state.json'), {});
    const task = readJsonSafe(path.join(dir, 'task.json'), {});
    const lines = readJournalLines(dir);
    const last = lines.length ? lines[lines.length - 1] : null;

    const llmSteps = lines
      .filter((e) => e.event === 'llm-call')
      .map((e) => ({
        step: e.step,
        model: e.model,
        account: e.account,
        sessionId: e.sessionId || null,
        // action 6.7: `duration_s` (action 5.4) was collected in journal.jsonl but never carried
        // through this module at all, which is half of why project-2 card #478 called it
        // "rendered nowhere" -- render.js deliberately does not render per-task llmSteps (see
        // this file's own header: per-task detail duplicates the GitHub Projects board), but a
        // future aggregate consumer of this array (or a test measuring against the real corpus)
        // should not have to re-parse journal.jsonl a second time to get at it. `null`, never
        // `0`, when the event predates the field -- same "0 is a lie, absence is the truth" rule
        // task-summary.js's own hasTokenData and bin/spo's cmdTask both already apply.
        durationS: typeof e.duration_s === 'number' ? e.duration_s : null,
      }));

    return {
      id,
      title: state.title || task.title || '',
      kind: state.kind || task.kind || '',
      state: state.state || 'UNKNOWN',
      reason: state.reason || null,
      updatedAt: state.updatedAt || null,
      lastEventTs: last ? last.ts : null,
      lastEventName: last ? last.event : null,
      llmSteps,
      // Project-2 card #476: the health of THIS card's retry (unpark) channel, off the journal
      // lines already read above -- never a second parse. Computed here rather than in
      // collectServices because this is the only place in the module that holds a task's journal
      // lines at all. PARKED only, and null otherwise, because park-loop.js's unparkScan scans
      // PARKED tasks and no others: a summary for a running card would describe a scanner that
      // never looked at it. The aggregate tile is built from these by applyRetryChannelStats.
      retryChannel: (state.state || 'UNKNOWN') === 'PARKED' ? summarizeUnparkScanTail(lines) : null,
    };
  });
}

// Queue depth + a bounded preview of the next task ids, in filename order (= intake order --
// see orchestrator/README.md "Task-file format"). Prefers a task's own `id` field over the
// filename, same fallback intake itself uses.
function collectQueue(queueDir) {
  if (!queueDir) return { depth: 0, nextIds: [] };
  let files;
  try {
    if (!fs.existsSync(queueDir)) return { depth: 0, nextIds: [] };
    files = fs
      .readdirSync(queueDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return { depth: 0, nextIds: [] };
  }
  const nextIds = files.slice(0, QUEUE_PREVIEW_LIMIT).map((f) => {
    const parsed = readJsonSafe(path.join(queueDir, f), null);
    return (parsed && parsed.id) || f.replace(/\.json$/, '');
  });
  return { depth: files.length, nextIds };
}

// Account health, discovered straight from the pool directory (one subdirectory per account --
// see orchestrator/accounts.js, the single source of truth this reads through rather than
// re-implementing) + state.json (runtime cooldowns). An absent or empty pool directory is an
// empty section, not a synthesized row -- same "reader, never a second source of truth" rule
// as the rest of the console.
function collectAccounts(accountsDir) {
  if (!accountsDir) return { rows: [] };

  let registry;
  try {
    registry = accountsModule.readRegistry(accountsDir);
  } catch {
    return { rows: [] };
  }
  if (registry.length === 0) return { rows: [] };

  const state = readJsonSafe(path.join(accountsDir, 'state.json'), {});
  const labels = accountsModule.readLabels(accountsDir);
  const now = Date.now();

  const rows = registry.map((a) => {
    const entry = state[a.name];
    const cooldownUntil = entry && typeof entry.cooldownUntil === 'number' ? entry.cooldownUntil : null;
    const cooling = typeof cooldownUntil === 'number' && cooldownUntil > now;
    const label = labels[a.name] || {};
    return {
      name: a.name,
      email: label.email || null,
      plan: label.plan || null,
      enabled: a.enabled,
      cooldownUntil: cooling ? new Date(cooldownUntil).toISOString() : null,
      cooling,
      hasToken: !!a.oauthTokenFile,
      hasCredentials: accountsModule.hasCredentials(a.configDir),
    };
  });

  return { rows };
}

// ~/.spo-bench/nightly/latest.json -- the main-branch nightly verdict. Read-only, never probed
// live (doc/E2E-POLICY.md / CLAUDE.md "Live server logs" apply to the product repo, not here,
// but the same read-only discipline holds for this shared local surface).
function collectNightly(nightlyPath) {
  return readJsonSafe(nightlyPath, null);
}

// ~/.spo-bench/verdicts/*.json, newest 5 by mtime -- one gate attestation per pushed sha.
function collectVerdicts(verdictsDir, limit = VERDICTS_LIMIT) {
  if (!verdictsDir) return [];
  let files;
  try {
    if (!fs.existsSync(verdictsDir)) return [];
    files = fs.readdirSync(verdictsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const withStat = files.map((f) => {
    const p = path.join(verdictsDir, f);
    let mtime = 0;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      /* file removed between readdir and stat -- sorts last, harmless */
    }
    return { f, p, mtime };
  });
  withStat.sort((a, b) => b.mtime - a.mtime);
  return withStat.slice(0, limit).map(({ f, p }) => ({ file: f, ...readJsonSafe(p, {}) }));
}

// journal/usage-snapshot.json -- an optional, operator-produced snapshot: `node
// scripts/usage-report.js > journal/usage-snapshot.json`. Absent by default; see
// scripts/usage-report.js for the output shape (byPhase_Mtokens, cacheRebuilds, ... -- the
// `estUsd` key that shape once carried was removed with the rest of this build's dollar
// figures, 2026-08-31). Kept as the
// static-mode repl fallback for the tokens section -- see console/usage-scan.js for the live
// equivalent.
function collectUsageSnapshot(journalRoot) {
  if (!journalRoot) return null;
  return readJsonSafe(path.join(journalRoot, 'usage-snapshot.json'), null);
}

// usageSnapshotFreshness(snapshot, filePath, {now}) -- action 5.5, item B. Measured live
// 2026-09-01 against journal/usage-snapshot.json: its own `range` field reads
// ["2026-08-20","2026-08-29"], `since`/`until` both null, mtime 2026-08-29T22:16 local -- three
// days behind "today", rendered under a page header that says `generated <now>` with nothing
// anywhere saying the table below it is old. Every figure in that table (526 Mtok cache-read for
// sonnet, 1749 for opus, ...) read as current when it was not.
//
// The file's OWN `since`/`until`/`range` fields (when present) describe the DATA -- the window
// the numbers were actually computed over -- and are preferred over the file's mtime, which only
// describes the WRITE: for an unfiltered scan the two are close, but a `--since=/--until=` run
// (scripts/usage-report.js's own flags) can be written long after the data's own end date, and
// the mtime would then UNDERSTATE how stale the numbers are. mtime is only the fallback for an
// older snapshot shape that predates those fields; "unknown" is returned, never an invented date,
// when neither is available (an unreadable/missing file, or a range end that fails to parse).
function usageSnapshotFreshness(snapshot, filePath, { now = Date.now() } = {}) {
  if (!snapshot) return null;
  const range = Array.isArray(snapshot.range) ? snapshot.range : [null, null];
  // `range` FIRST, `since`/`until` only as a fallback -- and the order is the whole point.
  // scripts/usage-report.js writes `since`/`until` straight from its CLI flags (the window the
  // operator ASKED for) and `range` from the data's own minTs/maxTs (the window actually
  // OBSERVED). Preferring `until` therefore lets `--until=2026-09-30` mint perpetual freshness:
  // a snapshot whose data really stops on 09-01, read on 09-15, reports `0s old` and no STALE
  // banner. That is precisely the silent-staleness failure this function exists to end, so the
  // observed end always wins.
  const rangeStart = range[0] || snapshot.since || null;
  const rangeEnd = range[1] || snapshot.until || null;

  let asOfMs = null;
  let source = 'unknown';
  if (rangeEnd) {
    // rangeEnd is a calendar day ('YYYY-MM-DD') -- treat it as covering the WHOLE day (its last
    // instant), not its first, so a snapshot whose data ends "today" is not immediately flagged
    // stale at 00:00:00 on that same day.
    const parsed = Date.parse(`${rangeEnd}T23:59:59.999Z`);
    if (Number.isFinite(parsed)) {
      asOfMs = parsed;
      source = 'range';
    }
  }
  if (asOfMs === null) {
    try {
      asOfMs = fs.statSync(filePath).mtimeMs;
      source = 'mtime';
    } catch {
      asOfMs = null;
      source = 'unknown';
    }
  }

  const ageMs = asOfMs !== null ? Math.max(0, now - asOfMs) : null;
  return {
    rangeStart,
    rangeEnd,
    source, // 'range' | 'mtime' | 'unknown'
    ageMs, // null when source is 'unknown'
    stale: ageMs !== null && ageMs > SNAPSHOT_STALE_MS,
  };
}

// journal/usage-rollups.json -- the tokens trend section's durable daily-rollup store, written
// by the live server (console/serve.js) on its usage-scan timer. Unlike tokens itself (always
// null outside --serve, since it needs the live scanner), this file is a small, already-computed
// history a static run can just READ -- one bounded JSON.parse, the same cost class as
// collectUsageSnapshot above, not the "no network, no token scanning" walk usage-scan.js's
// scanner does. Absent file = no trend yet, not an error.
function collectTrend(journalRoot) {
  if (!journalRoot) return null;
  const rollups = require('./usage-rollups').loadRollups(path.join(journalRoot, 'usage-rollups.json'));
  if (!rollups || Object.keys(rollups).length === 0) return null;
  return require('./usage-scan').buildTrendViews(rollups);
}

// Bounded tail-read of <journalRoot>/daemon.jsonl -- never a full readFileSync on an
// unboundedly-growing, append-only log. Reads at most `maxBytes` from the end of the file, then
// discards a possibly-truncated first line, and caps the result at `maxLines` entries.
function readDaemonEventsTail(journalRoot, { maxBytes = DAEMON_EVENTS_MAX_BYTES, maxLines = DAEMON_EVENTS_MAX_LINES } = {}) {
  if (!journalRoot) return [];
  const p = path.join(journalRoot, 'daemon.jsonl');
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    return [];
  }
  let text;
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const truncated = size > maxBytes;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
    text = buf.toString('utf8');
    if (truncated) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
  } catch {
    return [];
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed or never opened -- nothing to clean up */
    }
  }
  const events = text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return events.slice(-maxLines);
}

// LOCAL midnight -- the anchor for the "ONE 'today' rule" console/usage-scan.js's byDay
// bucketing and console/serve.js's rollup `todayDate` now also converge on (action 5.5, item C;
// full rationale lives in usage-scan.js's header, not repeated here). orchestrator/tokens.js's
// `todaySpend` was pinned to this same LOCAL midnight earlier, action 5.4.
function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun..6=Sat
  const back = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - back);
  return d.getTime();
}

// Statuses for the 6 surfaces that compose "the pipeline": no network probe, no spawn -- a lock
// file, a heartbeat file read by CONTENT (see orchestrator/bench-heartbeat.js), and JSON
// timestamps only.
function collectServices({ journalRoot, queueDir, benchRoot, now = Date.now() } = {}) {
  const services = {
    daemon: { status: 'unknown', pid: null, host: null, mode: null, startedAt: null, uptimeMs: null },
    queue: { status: 'ok', depth: 0 },
    benchWorker: { status: 'unknown', pid: null, port: null, startedAt: null, heartbeatAt: null, heartbeatAgeMs: null },
    nightly: { status: 'unknown', verdict: null, sha: null, finishedAt: null, ageMs: null },
    verdicts: { status: 'unknown', lastVerdict: null, lastAt: null, ageMs: null, recentPass: 0, recentTotal: 0 },
    // action 6.7: C6's dispatcher.js/live-workers.json, an AGGREGATE COUNT ONLY -- see this
    // module's own header ("per-task detail duplicates the GitHub Projects board") for why this
    // tile never lists per-task rows the way bin/spo's cmdStatus does. `count` is a SUBSET of
    // daemonStats.active (orchestrator/worker-status.js's describeLiveWorkers classifies every
    // live-workers.json id against its own task's state.json terminal-or-not, exactly like
    // bin/spo does), never a second, independently-derived total -- see that module's header for
    // the double-count hazard this avoids repeating for a second surface.
    workers: { status: 'unknown', present: false, count: 0, staleCount: 0, trailingCount: 0, updatedAt: null, ageMs: null },
    // Project-2 card #476: the maintainer's retry/abandon channel. AGGREGATE ONLY, same rule as
    // `workers` above -- this module's header ("per-task detail duplicates the GitHub Projects
    // board") is why it counts cards instead of listing them, and bin/spo's cmdStatus stays the
    // per-card surface. Filled in by collectAll (applyRetryChannelStats below), not here, for the
    // same reason `workers` is: it needs `journalTasks`, and several tests call collectServices
    // bare. Left honestly 'unknown' until then rather than defaulting to a green 'idle'.
    retryChannel: { status: 'unknown', parkedCards: 0, failingCards: 0, unprovenCards: 0, healthyCards: 0, worstFailures: 0, worstFirstFailedAt: null, lastFailedAt: null, lastFailedAgeMs: null },
  };

  // daemon
  if (journalRoot) {
    const lockFile = path.join(journalRoot, 'daemon.lock');
    if (!fs.existsSync(lockFile)) {
      services.daemon.status = 'down';
    } else {
      const holder = readJsonSafe(lockFile, null);
      if (!holder || typeof holder.pid !== 'number') {
        services.daemon.status = 'unknown';
      } else {
        const alive = holder.host === os.hostname() && processAlive(holder.pid);
        services.daemon.status = alive ? 'up' : 'stale';
        services.daemon.pid = holder.pid;
        services.daemon.host = holder.host || null;
        services.daemon.mode = holder.mode || null;
        services.daemon.startedAt = holder.startedAt || null;
        const startedMs = holder.startedAt ? Date.parse(holder.startedAt) : NaN;
        services.daemon.uptimeMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null;
      }
    }
  }

  // queue
  {
    const q = collectQueue(queueDir);
    services.queue.depth = q.depth;
    services.queue.status = q.depth === 0 ? 'ok' : q.depth < 10 ? 'busy' : 'warn';
  }

  // bench worker -- staleness contract (content, HEARTBEAT_STALE_MS) lives in
  // orchestrator/bench-heartbeat.js, pinned to SPO-WebClient's own copy by
  // test/heartbeat-contract-pin.test.js; see that module's header for why (action B5.3).
  if (benchRoot) {
    const workerFile = path.join(benchRoot, 'worker.json');
    const heartbeatFile = path.join(benchRoot, 'heartbeat');
    const worker = readJsonSafe(workerFile, null);
    const age = benchHeartbeatAgeMs(heartbeatFile, now);
    // heartbeatAt is derived from age (not a second, independent read of the file) so there is
    // only one place that decides whether the content parsed -- benchHeartbeatAgeMs itself.
    const heartbeatMs = age !== null ? now - age : null;
    if (!worker && heartbeatMs === null) {
      services.benchWorker.status = 'down';
    } else {
      services.benchWorker.pid = (worker && worker.pid) || null;
      services.benchWorker.port = (worker && worker.port) || null;
      services.benchWorker.startedAt = (worker && worker.startedAt) || null;
      services.benchWorker.heartbeatAt = heartbeatMs !== null ? new Date(heartbeatMs).toISOString() : null;
      services.benchWorker.heartbeatAgeMs = age;
      if (age === null) services.benchWorker.status = 'unknown';
      else services.benchWorker.status = age < HEARTBEAT_STALE_MS ? 'up' : 'stale';
    }
  }

  // nightly
  if (benchRoot) {
    const nightly = collectNightly(path.join(benchRoot, 'nightly', 'latest.json'));
    if (!nightly) {
      services.nightly.status = 'unknown';
    } else {
      services.nightly.verdict = nightly.verdict || null;
      services.nightly.sha = nightly.sha || null;
      services.nightly.finishedAt = nightly.finishedAt || null;
      const finishedMs = nightly.finishedAt ? Date.parse(nightly.finishedAt) : NaN;
      const ageMs = Number.isFinite(finishedMs) ? now - finishedMs : null;
      services.nightly.ageMs = ageMs;
      // FAIL is checked BEFORE staleness: a failure does not become less true with age. The
      // first cut checked staleness first, so a nightly that failed and then stopped running --
      // the worst state this tile can describe -- was downgraded from RED to ORANGE by the very
      // fact that nobody had run it since. Staleness qualifies a PASS ("this green is old, do not
      // trust it as current"); it does not soften a RED. The caption carries the age either way.
      if (nightly.verdict === 'FAIL') services.nightly.status = 'fail';
      else if (ageMs !== null && ageMs > STALE_BENCH_AGE_MS) services.nightly.status = 'stale';
      else if (nightly.verdict === 'PASS') services.nightly.status = 'pass';
      else services.nightly.status = 'unknown';
    }
  }

  // verdicts -- deliberately NOT stale-flagged, and this reverses a change action 5.5 made.
  //
  // 5.5 gave this tile the same 36h staleness clock as the nightly, reasoning that both come from
  // the one ~/.spo-bench worker. Measured afterwards against the real ~/.spo-bench/verdicts (493
  // files): the gaps between consecutive verdicts in ordinary operation run 0.0h, 0.1h, 1.1h,
  // 2.0h, 6.0h, 10.7h, **15.6h** -- and that is an active weekday sample. The nightly's 36h is
  // meaningful because a nightly is SCHEDULED: 36 hours means it missed a run. Verdicts are
  // PUSH-driven; a quiet weekend clears 36h with nothing wrong at all, and an orange tile that
  // fires every Sunday is a tile a maintainer learns to ignore -- which costs more than the
  // silence it replaced. The age is still reported in the caption, where it informs without
  // asserting a fault nobody measured.
  //
  // `ageMs` and `lastAt` stay populated; only the invented `status: 'stale'` is gone.
  if (benchRoot) {
    const verdicts = collectVerdicts(path.join(benchRoot, 'verdicts'), 20);
    services.verdicts.recentTotal = verdicts.length;
    services.verdicts.recentPass = verdicts.filter((v) => v.verdict === 'PASS').length;
    if (verdicts.length > 0) {
      const last = verdicts[0];
      services.verdicts.lastVerdict = last.verdict || null;
      services.verdicts.lastAt = last.createdAt || last.finishedAt || null;
      const lastMs = services.verdicts.lastAt ? Date.parse(services.verdicts.lastAt) : NaN;
      const ageMs = Number.isFinite(lastMs) ? now - lastMs : null;
      services.verdicts.ageMs = ageMs;
      services.verdicts.status = last.verdict === 'PASS' ? 'pass' : last.verdict === 'FAIL' ? 'fail' : 'unknown';
    }
  }

  // workers is filled in by collectAll (applyWorkerStats below), not here -- see that function's
  // own comment for why: it needs `journalTasks` (specifically `isCardKind`) to exclude a
  // synthetic/demo task from the live count the exact same way collectDaemonStats's own `active`
  // already excludes one, and collectServices is called by several tests with no journalTasks in
  // hand at all (test/dashboard.test.js calls it bare). Left at its zeroed/'unknown' default here
  // so a caller that only ever calls collectServices() still gets an honest, non-crashing shape.
  return services;
}

// applyWorkerStats(services, journalRoot, journalTasks, now) -- action 6.7. Mutates
// `services.workers` in place with the SAME classification bin/spo's cmdStatus renders per row
// (orchestrator/worker-status.js's describeLiveWorkers), filtered to `isCardKind` tasks only --
// the same filter collectDaemonStats already applies to its own `active` count (see that
// function's header on the one real demo/synthetic task in the live corpus). Without this
// filter, a live worker running a `kind: "synthetic"` task (only reachable today via a test
// fixture driving the real dispatcher against a demo card outside `spo recette`'s own isolated
// journal dir -- production traffic never does this) would inflate this tile's count past
// `daemonStats.active`, which is exactly the kind of "two counts of almost-the-same-set silently
// disagree" drift action 5.4 item G already had to close once for the parking-rate denominator.
function applyWorkerStats(services, journalRoot, journalTasks, now) {
  if (!journalRoot) return services;
  const kindById = new Map((journalTasks || []).map((t) => [t.id, t]));
  const worker = describeLiveWorkers(journalRoot, null, now);
  let live = 0;
  let stale = 0;
  for (const [id, info] of worker.perId) {
    if (info.classification === 'trailing') continue; // never counted -- see worker-status.js
    const task = kindById.get(id);
    if (task && !isCardKind(task)) continue; // same exclusion collectDaemonStats applies
    if (info.classification === 'live') live++;
    else if (info.classification === 'stale') stale++;
  }
  services.workers.present = worker.present;
  services.workers.count = live;
  services.workers.staleCount = stale;
  services.workers.trailingCount = worker.counts.trailing;
  services.workers.updatedAt = worker.updatedAt;
  services.workers.ageMs = worker.ageMs;
  services.workers.status = worker.present ? 'ok' : 'unknown';
  return services;
}

// applyRetryChannelStats(services, journalTasks) -- project-2 card #476, and the same
// mutate-in-place shape as applyWorkerStats above, for the same reason: it needs `journalTasks`.
//
// Four states, and the two that are NOT green are the point of the card:
//
//   idle     -- nothing is parked. unparkScan iterates PARKED tasks and no others, so it did not
//               run and there is nothing to be healthy or broken ABOUT. Said out loud, because a
//               tile that simply disappeared when the parked count hit zero would look exactly
//               like a tile whose collector broke.
//   fail     -- at least one parked card has a standing `unpark-scan-failed` streak. This is what
//               was invisible for 33 hours on 2026-08-30 while the retry channel was dead.
//   unknown  -- cards are parked and NOT ONE of them has a recorded scan outcome yet. Before card
//               #476 a successful scan journalled nothing, so this was the permanent state of the
//               whole corpus and it rendered as silence. It is now distinguishable from `ok` and
//               says so: a scan that has never once proven it reached GitHub is not a healthy one.
//   ok       -- every parked card has positive evidence (`unpark-scan-ok` / `-truncated` /
//               `-ignored-author`) sitting on top of its tail, with no failures above it.
//
// `fail` outranks `unknown` outranks `ok`: a real outage is never softened by a sibling card that
// merely has nothing to say, the same precedence rule collectServices' own nightly tile applies
// when it checks FAIL before staleness.
function applyRetryChannelStats(services, journalTasks, now = Date.now()) {
  const rc = services.retryChannel;
  const parked = (journalTasks || []).filter((t) => t && t.retryChannel);
  rc.parkedCards = parked.length;
  if (parked.length === 0) {
    rc.status = 'idle';
    return services;
  }
  for (const t of parked) {
    const s = t.retryChannel;
    if (s.count > 0) {
      rc.failingCards += 1;
      if (s.count > rc.worstFailures) {
        rc.worstFailures = s.count;
        rc.worstFirstFailedAt = s.firstFailedAt || null;
      }
      // The most recent failure anywhere in the corpus -- what "the channel broke N ago" is
      // measured from. String compare is safe and total here: every `ts` this walks is a
      // journal.js ISO-8601 UTC stamp, so lexical order IS chronological order.
      if (s.lastFailedAt && (rc.lastFailedAt === null || s.lastFailedAt > rc.lastFailedAt)) {
        rc.lastFailedAt = s.lastFailedAt;
      }
    } else if (s.healthySince) {
      rc.healthyCards += 1;
    } else {
      rc.unprovenCards += 1;
    }
  }
  // The age is computed HERE, not in console/render.js, for the same reason usageSnapshotMeta is:
  // render.js is a pure function of already-parsed data and owns no clock of its own.
  const lastMs = rc.lastFailedAt ? Date.parse(rc.lastFailedAt) : NaN;
  rc.lastFailedAgeMs = Number.isFinite(lastMs) ? now - lastMs : null;
  rc.status = rc.failingCards > 0 ? 'fail' : rc.healthyCards > 0 ? 'ok' : 'unknown';
  return services;
}

// action 5.5, item A: `kind` (never the id prefix -- a "demo-*" id is nowhere assumed or relied
// on; the field is the only honest discriminator) tells a synthetic/demo task apart from a real
// backlog card. Measured against the live journal 2026-09-01: 19 task directories, ONE of them
// (demo-happy-001, kind: "synthetic", state: DONE) inflating "processed total" / done / parked /
// abandoned / parkingRatePct by one task on every all-time figure -- 5% of the total, silently
// read by a maintainer as 19 pieces of real work. `spo recette`'s own synthetic cards never reach
// this filter at all: they journal to `.recette/<runId>/journal/`, never `journalRoot`, so this
// is the ONLY place a synthetic task can leak into the daemon-stats count -- do not add a second
// filter for recette's synthetics elsewhere, there is nothing there to filter.
//
// A `state.json`/`task.json` with NO `kind` field at all (collectJournalTasks's `t.kind` reads as
// `''` in that case, its own `state.kind || task.kind || ''` fallback) is treated as a real card,
// NOT excluded -- every task in today's corpus already has a `kind`, but a state.json written
// before the field existed would have none, and silently dropping an unknown-kind task from the
// only panel that counts terminal outcomes is a worse failure than counting one demo. Only a
// `kind` that is explicitly present AND not `"card"` is excluded.
function isCardKind(t) {
  // A DENYLIST, not an allowlist. `kind === 'card'` would also delete any future real kind --
  // `kind: 'experiment'`, or a stray `'Card'` -- from the ONLY panel that counts terminal
  // outcomes, which is the same "silently dropping an unknown task" failure the no-`kind` rule
  // above exists to avoid, just one step further out. Only the kind we know is not real work is
  // excluded.
  return t.kind !== 'synthetic';
}

// The 4 headline daemon numbers. Consumes the ALREADY-collected journalTasks array (never a
// second disk pass) plus the queue depth already read by the caller.
function collectDaemonStats(journalTasks, queueDepth = 0, { now = Date.now() } = {}) {
  // A non-array `journalTasks` yields the zero shape rather than throwing on `.filter`. This is
  // the panel a maintainer looks at when something is already wrong; it must render.
  if (!Array.isArray(journalTasks)) journalTasks = [];
  const tasks = (journalTasks || []).filter(isCardKind);
  const dayStart = startOfDay(now);
  const weekStart = startOfWeek(now);

  const stats = {
    total: 0,
    done: 0,
    parked: 0,
    // action 4.5: ABANDONED is the third terminal state (DONE/PARKED were the only two this
    // shape ever knew about) -- issue #443 sat ABANDONED for a full day and the dashboard never
    // stopped counting it as active/in-flight, because `terminal` below didn't know the state
    // existed. `abandoned` gets its own counter, mirrored into week/today below exactly like
    // `done`/`parked` already are, rather than being folded into `parked` (an abandon is not a
    // park still awaiting a reply -- it's already been replied to and closed out).
    abandoned: 0,
    week: { done: 0, parked: 0, abandoned: 0, total: 0 },
    today: { done: 0, parked: 0, abandoned: 0, total: 0 },
    active: 0,
    imported: queueDepth,
    inFlight: 0,
    parkingRatePct: null,
  };

  for (const t of tasks) {
    const terminal = t.state === 'DONE' || t.state === 'PARKED' || t.state === 'ABANDONED';
    if (!terminal) {
      stats.active++;
      continue;
    }
    stats.total++;
    if (t.state === 'DONE') stats.done++;
    else if (t.state === 'ABANDONED') stats.abandoned++;
    else stats.parked++;

    const updatedMs = t.updatedAt ? Date.parse(t.updatedAt) : NaN;
    if (Number.isFinite(updatedMs)) {
      if (updatedMs >= weekStart) {
        stats.week.total++;
        if (t.state === 'DONE') stats.week.done++;
        else if (t.state === 'ABANDONED') stats.week.abandoned++;
        else stats.week.parked++;
      }
      if (updatedMs >= dayStart) {
        stats.today.total++;
        if (t.state === 'DONE') stats.today.done++;
        else if (t.state === 'ABANDONED') stats.today.abandoned++;
        else stats.today.parked++;
      }
    }
  }

  stats.inFlight = stats.active + stats.imported;
  // Denominator is stats.total, i.e. done + parked + abandoned (every terminal task increments
  // it above regardless of which of the three it is) -- the three-way terminal total the spec
  // asks for. Numerator stays `parked` alone: this is "of the cards that finished, what share
  // ended parked", not "what share didn't reach done", so an abandoned card counts toward the
  // total it's measured against without inflating the parked share itself.
  stats.parkingRatePct = stats.total > 0 ? Math.round((stats.parked / stats.total) * 100) : null;

  return stats;
}

const REJECT_REASON_WHITELIST = new Set(['unsafe-filename', 'oversize', 'sha256-mismatch']);

// Bug-report pipeline (webclient intake, orchestrator/report-intake.js + auto-triage.js +
// remote-report-pull.js). Returns ONLY counters and statuses -- never a file path, a URL, a
// token, or any free-text field a human or GitHub wrote (report-held's `reason`,
// remote-report-ack-failed's `error`): those can carry secrets or production URLs, and this
// object is rendered straight into public-ish HTML.
function collectReportPipeline(journalRoot, spoReportsDir, { now = Date.now() } = {}) {
  const result = {
    queuedIntake: 0,
    pendingConfirm: 0,
    confirmedAwaitingTriage: 0,
    lastIntakeCycle: null,
    last24h: {
      intakeCycles: 0,
      filed: 0,
      duplicates: 0,
      schemaVersion: 0,
      errors: 0,
      confirmed: 0,
      discarded: 0,
      triagedFiled: 0,
      triagedDuplicate: 0,
      held: 0,
      promoteFailed: 0,
    },
    pull: {
      configured: false,
      lastPulledAt: null,
      lastAckedAt: null,
      pulled24h: 0,
      acked24h: 0,
      ackFailed24h: 0,
      rejected24h: 0,
      lastRejectReason: null,
    },
  };

  try {
    result.pull.configured = !!require('../orchestrator/config').remoteReportUrl;
  } catch {
    /* config module unavailable in this test context -- leave configured: false */
  }

  if (spoReportsDir) {
    try {
      const autoTriage = require('../orchestrator/auto-triage');
      result.queuedIntake = autoTriage.listQueuedReports(spoReportsDir).length;
    } catch {
      /* leave 0 */
    }
  }

  if (journalRoot) {
    try {
      const reportIntake = require('../orchestrator/report-intake');
      result.pendingConfirm = reportIntake.findPendingIntake(journalRoot).length;
    } catch {
      /* leave 0 */
    }
    try {
      const autoTriage = require('../orchestrator/auto-triage');
      result.confirmedAwaitingTriage = autoTriage.findConfirmedAwaitingTriage(journalRoot, 500).length;
    } catch {
      /* leave 0 */
    }
  }

  const events = readDaemonEventsTail(journalRoot);
  const windowStart = now - DAY_MS;

  for (const e of events) {
    const ts = e.ts ? Date.parse(e.ts) : NaN;
    const inWindow = Number.isFinite(ts) && ts >= windowStart;

    switch (e.event) {
      case 'report-intake-cycle':
        result.lastIntakeCycle = {
          ts: e.ts || null,
          processed: e.processed || 0,
          filed: e.filed || 0,
          duplicates: e.duplicates || 0,
          schemaVersion: e.schemaVersion || 0,
          errors: typeof e.errors === 'number' ? e.errors : 0,
        };
        if (inWindow) {
          result.last24h.intakeCycles++;
          result.last24h.filed += e.filed || 0;
          result.last24h.duplicates += e.duplicates || 0;
          result.last24h.schemaVersion += e.schemaVersion || 0;
          result.last24h.errors += typeof e.errors === 'number' ? e.errors : 0;
        }
        break;
      case 'report-confirmed':
        if (inWindow) result.last24h.confirmed++;
        break;
      case 'report-discarded':
        if (inWindow) result.last24h.discarded++;
        break;
      case 'report-triaged':
        if (inWindow) {
          if (e.outcome === 'filed') result.last24h.triagedFiled++;
          else if (e.outcome === 'duplicate') result.last24h.triagedDuplicate++;
        }
        break;
      case 'report-held':
        if (inWindow) result.last24h.held++;
        break;
      case 'report-promote-failed':
        if (inWindow) result.last24h.promoteFailed++;
        break;
      case 'remote-report-pulled':
        result.pull.lastPulledAt = e.ts || result.pull.lastPulledAt;
        if (inWindow) result.pull.pulled24h++;
        break;
      case 'remote-report-acked':
        result.pull.lastAckedAt = e.ts || result.pull.lastAckedAt;
        if (inWindow) result.pull.acked24h++;
        break;
      case 'remote-report-ack-failed':
        if (inWindow) result.pull.ackFailed24h++;
        break;
      case 'remote-report-rejected':
        if (inWindow) {
          result.pull.rejected24h++;
          if (REJECT_REASON_WHITELIST.has(e.reason)) result.pull.lastRejectReason = e.reason;
        }
        break;
      default:
        break;
    }
  }

  return result;
}

// sessionId -> {taskId, state, title, steps} -- the join used to attribute a token-usage
// transcript file (named <sessionId>.jsonl) back to the SPO task that produced it. Pure, no I/O
// -- consumes the already-collected journalTasks array.
function buildSessionIndex(journalTasks) {
  const index = {};
  for (const t of journalTasks || []) {
    for (const step of t.llmSteps || []) {
      if (!step.sessionId) continue;
      if (!index[step.sessionId]) {
        index[step.sessionId] = { taskId: t.id, state: t.state, title: t.title, steps: [] };
      }
      index[step.sessionId].steps.push({ step: step.step, model: step.model, account: step.account });
    }
  }
  return index;
}

// Gathers every LOCAL, SYNCHRONOUS source into the one data object console/render.js's
// renderDashboard() expects. `benchRoot` defaults to ~/.spo-bench, resolved by the caller
// (bin/spo) so this module never has to import `os` just to find the home directory.
// `system`/`prod`/`tokens` are always null here -- console/serve.js fills them in from live,
// stateful samplers/probes/scanners; `spo dashboard` without --serve leaves them null and
// render.js shows "not monitored" for those sections. `trend` is the one exception: it can be
// populated here too, since collectTrend only reads an already-computed rollup file rather than
// running the scanner itself (see that function's own comment).
function collectAll({ journalRoot, queueDir, accountsDir, benchRoot, spoReportsDir } = {}) {
  const journalTasks = collectJournalTasks(journalRoot);
  const queue = collectQueue(queueDir);
  const reportsDir = spoReportsDir || (() => {
    try {
      return require('../orchestrator/config').spoReportsDir;
    } catch {
      return null;
    }
  })();
  const usageSnapshot = collectUsageSnapshot(journalRoot);
  const now = Date.now();
  // action 6.7: `applyWorkerStats` needs `journalTasks` (for its own `isCardKind` filter) --
  // computed here, once, rather than inside collectServices, which several existing tests call
  // bare (see that function's own comment on `services.workers`).
  const services = applyRetryChannelStats(
    applyWorkerStats(collectServices({ journalRoot, queueDir, benchRoot, now }), journalRoot, journalTasks, now),
    journalTasks,
    now
  );

  return {
    generatedAt: new Date().toISOString(),
    journalTasks,
    queue,
    accounts: collectAccounts(accountsDir),
    nightly: benchRoot ? collectNightly(path.join(benchRoot, 'nightly', 'latest.json')) : null,
    verdicts: benchRoot ? collectVerdicts(path.join(benchRoot, 'verdicts')) : [],
    usageSnapshot,
    // action 5.5, item B -- freshness metadata for the snapshot table above, computed here (this
    // module does the fs/time work) and rendered by console/render.js (which stays pure, no
    // Date.now() of its own). null when there is no snapshot to judge.
    usageSnapshotMeta: journalRoot ? usageSnapshotFreshness(usageSnapshot, path.join(journalRoot, 'usage-snapshot.json')) : null,
    trend: collectTrend(journalRoot),
    services,
    daemonStats: collectDaemonStats(journalTasks, queue.depth),
    reports: collectReportPipeline(journalRoot, reportsDir),
    system: null,
    prod: null,
    tokens: null,
  };
}

module.exports = {
  collectAll,
  collectJournalTasks,
  collectQueue,
  collectAccounts,
  collectNightly,
  collectVerdicts,
  collectUsageSnapshot,
  usageSnapshotFreshness,
  collectTrend,
  collectServices,
  collectDaemonStats,
  isCardKind,
  collectReportPipeline,
  buildSessionIndex,
  readDaemonEventsTail,
  applyWorkerStats,
  applyRetryChannelStats,
};
