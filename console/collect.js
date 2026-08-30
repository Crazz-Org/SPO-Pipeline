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
// is what lets `spo dashboard` (no --serve) stay instant and network-free.

const fs = require('fs');
const os = require('os');
const path = require('path');
const accountsModule = require('../orchestrator/accounts');
const { processAlive } = require('../orchestrator/lock');

const QUEUE_PREVIEW_LIMIT = 25;
const VERDICTS_LIMIT = 5;
const DAEMON_EVENTS_MAX_BYTES = 1024 * 1024;
const DAEMON_EVENTS_MAX_LINES = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
// account, sessionId, costUsd, numTurns, ok}).
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
        costUsd: typeof e.costUsd === 'number' ? e.costUsd : null,
        sessionId: e.sessionId || null,
      }));

    const totalCostUsd = llmSteps.reduce((sum, s) => sum + (typeof s.costUsd === 'number' ? s.costUsd : 0), 0);

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
      totalCostUsd,
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
  const now = Date.now();

  const rows = registry.map((a) => {
    const entry = state[a.name];
    const cooldownUntil = entry && typeof entry.cooldownUntil === 'number' ? entry.cooldownUntil : null;
    const cooling = typeof cooldownUntil === 'number' && cooldownUntil > now;
    return {
      name: a.name,
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
// scripts/usage-report.js for the output shape (estUsd, byPhase_Mtokens, ...). Kept as the
// static-mode repl fallback for the tokens section -- see console/usage-scan.js for the live
// equivalent.
function collectUsageSnapshot(journalRoot) {
  if (!journalRoot) return null;
  return readJsonSafe(path.join(journalRoot, 'usage-snapshot.json'), null);
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

// Statuses for the 5 surfaces that compose "the pipeline": no network probe, no spawn --
// lock file + heartbeat file + mtime only.
function collectServices({ journalRoot, queueDir, benchRoot, now = Date.now() } = {}) {
  const services = {
    daemon: { status: 'unknown', pid: null, host: null, mode: null, startedAt: null, uptimeMs: null },
    queue: { status: 'ok', depth: 0 },
    benchWorker: { status: 'unknown', pid: null, port: null, startedAt: null, heartbeatAt: null, heartbeatAgeMs: null },
    nightly: { status: 'unknown', verdict: null, sha: null, finishedAt: null, ageMs: null },
    verdicts: { status: 'unknown', lastVerdict: null, lastAt: null, ageMs: null, recentPass: 0, recentTotal: 0 },
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

  // bench worker
  if (benchRoot) {
    const workerFile = path.join(benchRoot, 'worker.json');
    const heartbeatFile = path.join(benchRoot, 'heartbeat');
    const worker = readJsonSafe(workerFile, null);
    let heartbeatMs = null;
    try {
      const raw = fs.readFileSync(heartbeatFile, 'utf8').trim();
      const n = Number(raw);
      if (Number.isFinite(n)) heartbeatMs = n;
    } catch {
      /* absent -- down below */
    }
    if (!worker && heartbeatMs === null) {
      services.benchWorker.status = 'down';
    } else {
      services.benchWorker.pid = (worker && worker.pid) || null;
      services.benchWorker.port = (worker && worker.port) || null;
      services.benchWorker.startedAt = (worker && worker.startedAt) || null;
      services.benchWorker.heartbeatAt = heartbeatMs !== null ? new Date(heartbeatMs).toISOString() : null;
      const age = heartbeatMs !== null ? now - heartbeatMs : null;
      services.benchWorker.heartbeatAgeMs = age;
      if (age === null) services.benchWorker.status = 'unknown';
      else services.benchWorker.status = age < 120000 ? 'up' : 'stale';
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
      if (ageMs !== null && ageMs > 36 * 60 * 60 * 1000) services.nightly.status = 'stale';
      else if (nightly.verdict === 'PASS') services.nightly.status = 'pass';
      else if (nightly.verdict === 'FAIL') services.nightly.status = 'fail';
      else services.nightly.status = 'unknown';
    }
  }

  // verdicts
  if (benchRoot) {
    const verdicts = collectVerdicts(path.join(benchRoot, 'verdicts'), 20);
    services.verdicts.recentTotal = verdicts.length;
    services.verdicts.recentPass = verdicts.filter((v) => v.verdict === 'PASS').length;
    if (verdicts.length > 0) {
      const last = verdicts[0];
      services.verdicts.lastVerdict = last.verdict || null;
      services.verdicts.lastAt = last.createdAt || last.finishedAt || null;
      const lastMs = services.verdicts.lastAt ? Date.parse(services.verdicts.lastAt) : NaN;
      services.verdicts.ageMs = Number.isFinite(lastMs) ? now - lastMs : null;
      services.verdicts.status = last.verdict === 'PASS' ? 'pass' : last.verdict === 'FAIL' ? 'fail' : 'unknown';
    }
  }

  return services;
}

// The 4 headline daemon numbers. Consumes the ALREADY-collected journalTasks array (never a
// second disk pass) plus the queue depth already read by the caller.
function collectDaemonStats(journalTasks, queueDepth = 0, { now = Date.now() } = {}) {
  const tasks = journalTasks || [];
  const dayStart = startOfDay(now);
  const weekStart = startOfWeek(now);

  const stats = {
    total: 0,
    done: 0,
    parked: 0,
    week: { done: 0, parked: 0, total: 0 },
    today: { done: 0, parked: 0, total: 0 },
    active: 0,
    imported: queueDepth,
    inFlight: 0,
    parkingRatePct: null,
  };

  for (const t of tasks) {
    const terminal = t.state === 'DONE' || t.state === 'PARKED';
    if (!terminal) {
      stats.active++;
      continue;
    }
    stats.total++;
    if (t.state === 'DONE') stats.done++;
    else stats.parked++;

    const updatedMs = t.updatedAt ? Date.parse(t.updatedAt) : NaN;
    if (Number.isFinite(updatedMs)) {
      if (updatedMs >= weekStart) {
        stats.week.total++;
        if (t.state === 'DONE') stats.week.done++;
        else stats.week.parked++;
      }
      if (updatedMs >= dayStart) {
        stats.today.total++;
        if (t.state === 'DONE') stats.today.done++;
        else stats.today.parked++;
      }
    }
  }

  stats.inFlight = stats.active + stats.imported;
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
// render.js shows "not monitored" for those sections.
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

  return {
    generatedAt: new Date().toISOString(),
    journalTasks,
    queue,
    accounts: collectAccounts(accountsDir),
    nightly: benchRoot ? collectNightly(path.join(benchRoot, 'nightly', 'latest.json')) : null,
    verdicts: benchRoot ? collectVerdicts(path.join(benchRoot, 'verdicts')) : [],
    usageSnapshot: collectUsageSnapshot(journalRoot),
    services: collectServices({ journalRoot, queueDir, benchRoot }),
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
  collectServices,
  collectDaemonStats,
  collectReportPipeline,
  buildSessionIndex,
  readDaemonEventsTail,
};
