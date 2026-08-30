'use strict';
// console/collect.js + console/render.js + `bin/spo dashboard` -- exercised both as pure
// functions (fast, no subprocess) and as the real CLI (proves --out and the printed path).
// Same fs.mkdtempSync(os.tmpdir()) discipline as the rest of the suite -- never the repo's own
// journal/, queue/ or the real account pool (~/.claude-accounts).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp, runSpo, writePoolDir } = require('./helpers');
const {
  collectAll,
  collectServices,
  collectDaemonStats,
  collectReportPipeline,
  buildSessionIndex,
  readDaemonEventsTail,
} = require('../console/collect');
const { renderDashboard, renderDataFragments } = require('../console/render');

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}

function writeJournalTask(journalRoot, id, { state, jsonlLines }) {
  const dir = path.join(journalRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'state.json'), state);
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), jsonlLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('renderDashboard with zero sources renders an empty-state document without throwing', () => {
  const html = renderDashboard(collectAll({}));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /SPO Pipeline/);
  assert.match(html, /<meta http-equiv="refresh" content="30">/);
  assert.match(html, /Tâches/);
  assert.match(html, /File d'attente/);
  assert.match(html, /Comptes Claude/);
  assert.match(html, /Verdicts de gate récents/);
  assert.match(html, /Tokens/);
  // empty-section markers -- no source anywhere means every section says so, not a crash
  assert.match(html, /aucune tâche dans le journal/);
  assert.match(html, /aucun compte enregistré dans le pool/);
  assert.match(html, /aucun verdict local/);
});

test('renderDashboard also survives a completely undefined input', () => {
  assert.doesNotThrow(() => renderDashboard(undefined));
  const html = renderDashboard(undefined);
  assert.match(html, /<!doctype html>/);
});

test('a DONE task and a PARKED task render with their ids, states, reason and a costUsd figure', () => {
  const journalRoot = mkTmp('spo-dash-journal-');

  writeJournalTask(journalRoot, 'done-task-01', {
    state: {
      id: 'done-task-01',
      title: 'Demo done task',
      kind: 'card',
      state: 'DONE',
      diagnoseAttempts: 0,
      validateRejects: 0,
      mainMoveUsed: false,
      updatedAt: '2026-08-29T00:00:00.000Z',
    },
    jsonlLines: [
      { ts: '2026-08-29T00:00:00.100Z', state: 'PLAN', event: 'llm-call', step: 'PLAN', model: 'claude-sonnet-5', effort: 'medium', account: 'default', sessionId: 'sess-plan-abc', costUsd: 0.1234, numTurns: 4, ok: true },
      { ts: '2026-08-29T00:00:00.200Z', state: 'DONE', event: 'done' },
    ],
  });

  writeJournalTask(journalRoot, 'parked-task-02', {
    state: {
      id: 'parked-task-02',
      title: 'Demo parked task',
      kind: 'synthetic',
      state: 'PARKED',
      reason: 'gate-dirty-tree',
      lastState: 'GATE',
      diagnoseAttempts: 1,
      validateRejects: 0,
      mainMoveUsed: false,
      updatedAt: '2026-08-29T00:05:00.000Z',
    },
    jsonlLines: [{ ts: '2026-08-29T00:05:00.000Z', state: 'GATE', event: 'parked', reason: 'gate-dirty-tree', detail: {} }],
  });

  const html = renderDashboard(collectAll({ journalRoot }));

  assert.match(html, /done-task-01/);
  assert.match(html, /parked-task-02/);
  assert.match(html, /class="badge state-done">DONE/);
  assert.match(html, /class="badge state-parked">PARKED/);
  assert.match(html, /gate-dirty-tree/);
  assert.match(html, /claude --resume sess-plan-abc/);
  // no dollar figures anywhere -- see console/render.js's header ("NEVER a dollar figure")
  assert.doesNotMatch(html, /\$\d/);
  assert.doesNotMatch(html, /estUsd|totalCostUsd|coût total/);
});

test('a cooling account renders in the accounts table with its cooldown timestamp, token and credentials columns', () => {
  const accountsDir = mkTmp('spo-dash-accounts-');
  writePoolDir(accountsDir, [
    { name: 'acct-cooling', oauthToken: 'tok' }, // token=yes, no other credentials file
    { name: 'acct-healthy', extraFile: '.credentials.json' }, // no token, but real credentials present
  ]);
  const cooldownUntil = Date.now() + 60 * 60 * 1000;
  writeJson(path.join(accountsDir, 'state.json'), { 'acct-cooling': { cooldownUntil } });

  const html = renderDashboard(collectAll({ accountsDir }));

  assert.match(html, /acct-cooling/);
  assert.match(html, /acct-healthy/);
  assert.match(html, /class="cooling"/);
  assert.match(html, new RegExp(new Date(cooldownUntil).toISOString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('bin/spo dashboard honors --out, writes the file there, and prints the absolute path', () => {
  const journalRoot = mkTmp('spo-dash-cli-journal-');
  const queueDir = mkTmp('spo-dash-cli-queue-');
  const outDir = mkTmp('spo-dash-cli-out-');
  const outPath = path.join(outDir, 'nested', 'dash.html');

  const printed = runSpo(['dashboard', '--journal', journalRoot, '--queue', queueDir, '--out', outPath]);

  assert.equal(printed.trim(), outPath);
  assert.ok(fs.existsSync(outPath));
  const html = fs.readFileSync(outPath, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /SPO Pipeline/);
});

test('bin/spo dashboard with no --out writes to console/dashboard.html under the repo root', () => {
  const { REPO_ROOT } = require('./helpers');
  const journalRoot = mkTmp('spo-dash-default-journal-');
  const queueDir = mkTmp('spo-dash-default-queue-');
  const defaultOut = path.join(REPO_ROOT, 'console', 'dashboard.html');

  const printed = runSpo(['dashboard', '--journal', journalRoot, '--queue', queueDir]);

  assert.equal(printed.trim(), defaultOut);
  assert.ok(fs.existsSync(defaultOut));
  fs.rmSync(defaultOut, { force: true });
});

// ---- readDaemonEventsTail --------------------------------------------------------------------

test('readDaemonEventsTail reads valid lines, skips a corrupted one, and returns [] when absent', () => {
  const journalRoot = mkTmp('spo-dash-daemon-events-');
  const lines = [
    JSON.stringify({ ts: '2026-08-30T00:00:00.000Z', event: 'a' }),
    'not json',
    JSON.stringify({ ts: '2026-08-30T00:00:01.000Z', event: 'b' }),
  ];
  fs.writeFileSync(path.join(journalRoot, 'daemon.jsonl'), lines.join('\n') + '\n');

  const events = readDaemonEventsTail(journalRoot);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'a');
  assert.equal(events[1].event, 'b');

  assert.deepEqual(readDaemonEventsTail(mkTmp('spo-dash-daemon-events-empty-')), []);
});

test('readDaemonEventsTail bounds a large daemon.jsonl to the tail and never returns a torn first line', () => {
  const journalRoot = mkTmp('spo-dash-daemon-events-big-');
  const filler = 'x'.repeat(200);
  const lineCount = 20000;
  const stream = [];
  for (let i = 0; i < lineCount; i++) {
    stream.push(JSON.stringify({ ts: `2026-08-30T00:00:${String(i % 60).padStart(2, '0')}.000Z`, event: 'e', i, filler }));
  }
  fs.writeFileSync(path.join(journalRoot, 'daemon.jsonl'), stream.join('\n') + '\n');

  const events = readDaemonEventsTail(journalRoot, { maxBytes: 64 * 1024, maxLines: 100 });
  assert.ok(events.length > 0 && events.length <= 100);
  assert.ok(events[events.length - 1].i === lineCount - 1);
  for (const e of events) assert.equal(typeof e.i, 'number');
});

// ---- collectServices --------------------------------------------------------------------------

test('collectServices with no sources returns down/unknown statuses without throwing', () => {
  const services = collectServices({});
  assert.equal(services.daemon.status, 'unknown'); // no journalRoot at all -- nothing to check
  assert.equal(services.queue.status, 'ok');
  assert.equal(services.benchWorker.status, 'unknown'); // no benchRoot at all

  const withJournalOnly = collectServices({ journalRoot: mkTmp('spo-dash-services-empty-') });
  assert.equal(withJournalOnly.daemon.status, 'down'); // journalRoot present, lock file absent
});

test('collectServices marks the daemon up when its lock names this live process on this host', () => {
  const journalRoot = mkTmp('spo-dash-services-daemon-');
  const os = require('os');
  writeJson(path.join(journalRoot, 'daemon.lock'), {
    host: os.hostname(),
    pid: process.pid,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    mode: 'shadow',
  });

  const services = collectServices({ journalRoot });
  assert.equal(services.daemon.status, 'up');
  assert.equal(services.daemon.pid, process.pid);
});

test('collectServices marks the daemon stale when its lock names a dead pid', () => {
  const journalRoot = mkTmp('spo-dash-services-stale-');
  const os = require('os');
  writeJson(path.join(journalRoot, 'daemon.lock'), {
    host: os.hostname(),
    pid: 999999999,
    startedAt: new Date().toISOString(),
    mode: 'shadow',
  });

  const services = collectServices({ journalRoot });
  assert.equal(services.daemon.status, 'stale');
});

test('collectServices reads a fresh bench heartbeat as up and an old one as stale', () => {
  const benchRootFresh = mkTmp('spo-dash-bench-fresh-');
  fs.mkdirSync(benchRootFresh, { recursive: true });
  writeJson(path.join(benchRootFresh, 'worker.json'), { pid: 1, startedAt: new Date().toISOString(), port: 8080 });
  fs.writeFileSync(path.join(benchRootFresh, 'heartbeat'), String(Date.now()));

  const freshServices = collectServices({ benchRoot: benchRootFresh });
  assert.equal(freshServices.benchWorker.status, 'up');

  const benchRootStale = mkTmp('spo-dash-bench-stale-');
  fs.mkdirSync(benchRootStale, { recursive: true });
  writeJson(path.join(benchRootStale, 'worker.json'), { pid: 1, startedAt: new Date().toISOString(), port: 8080 });
  fs.writeFileSync(path.join(benchRootStale, 'heartbeat'), String(Date.now() - 600000));

  const staleServices = collectServices({ benchRoot: benchRootStale });
  assert.equal(staleServices.benchWorker.status, 'stale');
});

test('collectServices never leaks the product repo path', () => {
  const benchRoot = mkTmp('spo-dash-services-leak-');
  fs.mkdirSync(benchRoot, { recursive: true });
  writeJson(path.join(benchRoot, 'worker.json'), { pid: 1, startedAt: new Date().toISOString(), port: 8080, repo: '/home/x/SPO-WebClient' });
  fs.writeFileSync(path.join(benchRoot, 'heartbeat'), String(Date.now()));

  const services = collectServices({ benchRoot });
  assert.doesNotMatch(JSON.stringify(services), /SPO-WebClient/);
});

// ---- collectDaemonStats -----------------------------------------------------------------------

test('collectDaemonStats buckets tasks by day/week and computes the parking rate', () => {
  const now = Date.parse('2026-08-30T12:00:00.000Z'); // a Sunday
  const journalTasks = [
    { state: 'DONE', updatedAt: '2026-08-30T08:00:00.000Z' }, // today
    { state: 'PARKED', updatedAt: '2026-08-27T08:00:00.000Z' }, // this week, not today
    { state: 'DONE', updatedAt: '2026-07-01T08:00:00.000Z' }, // long ago
    { state: 'IMPLEMENT', updatedAt: '2026-08-30T08:00:00.000Z' }, // active, non-terminal
  ];

  const stats = collectDaemonStats(journalTasks, 2, { now });
  assert.equal(stats.total, 3);
  assert.equal(stats.done, 2);
  assert.equal(stats.parked, 1);
  assert.equal(stats.today.total, 1);
  assert.equal(stats.week.total, 2);
  assert.equal(stats.active, 1);
  assert.equal(stats.imported, 2);
  assert.equal(stats.inFlight, 3);
  assert.equal(stats.parkingRatePct, 33);
});

test('collectDaemonStats with no tasks returns zeros and a null parking rate', () => {
  const stats = collectDaemonStats([], 0);
  assert.equal(stats.total, 0);
  assert.equal(stats.parkingRatePct, null);
});

// ---- collectReportPipeline --------------------------------------------------------------------

test('collectReportPipeline counts 24h events and never leaks secrets or free-text reasons', () => {
  const journalRoot = mkTmp('spo-dash-reports-');
  const now = Date.parse('2026-08-30T12:00:00.000Z');
  const events = [
    { ts: '2026-08-30T10:00:00.000Z', event: 'report-intake-cycle', processed: 3, filed: 2, duplicates: 1, schemaVersion: 0, errors: 0 },
    { ts: '2026-08-30T10:01:00.000Z', event: 'report-confirmed', issue: 1, pendingPath: '/home/x/.spo-reports/pending/a.json', commentId: 1, kind: 'wrong-data' },
    {
      ts: '2026-08-30T10:02:00.000Z',
      event: 'report-held',
      issue: 1,
      outcome: 'not-reproduced',
      reason: '### Card review — secret internal detail https://prod.example/leak',
    },
    { ts: '2026-08-30T10:03:00.000Z', event: 'report-triaged', issue: 2, outcome: 'filed' },
    {
      ts: '2026-08-30T10:04:00.000Z',
      event: 'remote-report-ack-failed',
      file: 'x.json',
      error: 'connect ECONNREFUSED https://starpeace.zz.works/ack',
    },
    { ts: '2026-08-30T10:05:00.000Z', event: 'remote-report-rejected', file: 'y.json', reason: 'sha256-mismatch' },
    { ts: '2026-01-01T00:00:00.000Z', event: 'report-triaged', issue: 3, outcome: 'filed' }, // outside the 24h window
  ];
  fs.writeFileSync(path.join(journalRoot, 'daemon.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const result = collectReportPipeline(journalRoot, path.join(journalRoot, 'reports'), { now });

  assert.equal(result.lastIntakeCycle.filed, 2);
  assert.equal(result.last24h.held, 1);
  assert.equal(result.last24h.triagedFiled, 1);
  assert.equal(result.pull.ackFailed24h, 1);
  assert.equal(result.pull.rejected24h, 1);
  assert.equal(result.pull.lastRejectReason, 'sha256-mismatch');

  const dump = JSON.stringify(result);
  assert.doesNotMatch(dump, /https/);
  assert.doesNotMatch(dump, /\/home\//);
  assert.doesNotMatch(dump, /secret/);
});

test('collectReportPipeline with nothing configured returns zeros and configured: false', () => {
  const result = collectReportPipeline(mkTmp('spo-dash-reports-empty-'), mkTmp('spo-dash-reports-dir-'));
  assert.equal(result.queuedIntake, 0);
  assert.equal(result.pull.configured, false);
});

// ---- buildSessionIndex -------------------------------------------------------------------------

test('buildSessionIndex joins sessionId to the owning task, accumulating multiple steps', () => {
  const journalTasks = [
    { id: 'task-1', state: 'DONE', title: 'A', llmSteps: [{ step: 'PLAN', model: 'm1', account: 'a', sessionId: 'sess-1' }, { step: 'IMPLEMENT', model: 'm2', account: 'a', sessionId: 'sess-1' }] },
    { id: 'task-2', state: 'PARKED', title: 'B', llmSteps: [{ step: 'PLAN', model: 'm1', account: 'a', sessionId: 'sess-2' }] },
  ];
  const index = buildSessionIndex(journalTasks);
  assert.equal(Object.keys(index).length, 2);
  assert.equal(index['sess-1'].taskId, 'task-1');
  assert.equal(index['sess-1'].steps.length, 2);
  assert.equal(index['sess-2'].taskId, 'task-2');
});

// ---- collectAll extension ------------------------------------------------------------------

test('collectAll returns the 3 new additive keys without throwing, and system/prod/tokens stay null', () => {
  const data = collectAll({});
  assert.ok('services' in data);
  assert.ok('daemonStats' in data);
  assert.ok('reports' in data);
  assert.equal(data.system, null);
  assert.equal(data.prod, null);
  assert.equal(data.tokens, null);
});

// ---- renderDashboard live mode + fragments --------------------------------------------------

test('renderDashboard(data, {live:true}) drops the meta refresh and references /api/system', () => {
  const html = renderDashboard(collectAll({}), { live: true });
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.match(html, /\/api\/system/);
});

test('renderDataFragments returns the 8 fragment keys as un-nested HTML strings', () => {
  const fragments = renderDataFragments(collectAll({}));
  const ids = ['services', 'accounts', 'daemon', 'reports', 'prod', 'tokens', 'secondary', 'stamp'];
  assert.deepEqual(Object.keys(fragments).sort(), ids.slice().sort());
  for (const id of ids) {
    assert.equal(typeof fragments[id], 'string');
    assert.ok(!fragments[id].startsWith('<section id="frag-'));
  }
});

test('renderDashboard prints "non surveillé" for the three live-only sections when they are null', () => {
  const data = collectAll({});
  data.system = null;
  data.prod = null;
  data.tokens = null;
  const html = renderDashboard(data);
  const count = (html.match(/non surveillé/g) || []).length;
  assert.equal(count, 2); // system + prod; tokens has its own distinct empty message
  assert.doesNotThrow(() => renderDashboard(data));
});
