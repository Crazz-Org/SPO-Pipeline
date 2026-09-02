'use strict';
// Action 6.7 -- worker observability. `spo status` lists C6's live workers (task, state,
// account, duration) cross-referenced against live-workers.json (orchestrator/worker-status.js),
// `spo task` gains an explicit `duration_s` render (closing project-2 card #478), and three C6
// journal signals that had no reader at all before this action (`account-cooldown`'s `degraded`
// flag, the dispatcher's idle/recovered edge, and the three new PARKED reasons) now surface.
//
// THE HAZARD THIS FILE EXISTS TO PIN, BY NAME: `cmdStatus` already counts a task as `active` when
// its state.json is non-terminal, and under C6 those tasks ARE the workers -- so a worker section
// that counts independently would double-count every running card, exactly the bug action 5.4
// item B already shipped once (a backoff card counted both as `active` and in `queue depth`).
// "Workers and `active:` agree" below asserts the SAME number, from ONE fixture, specifically so
// that regression cannot land quietly again.
//
// Every fixture here is hand-written journal.jsonl/state.json/live-workers.json -- the same
// convention test/status-5.4.test.js and test/tokens.test.js use -- never a real dispatcher run,
// since these tests are about how `spo status`/`spo task`/console/collect.js RENDER an
// already-produced journal + live-workers.json, not about producing either.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident this exists to prevent, and why this
// require has to land before the orchestrator require(s) below.
require('./no-real-spawn');

const { mkTmp, runSpo } = require('./helpers');
const { describeLiveWorkers } = require('../orchestrator/worker-status');
const { collectDaemonStats, collectJournalTasks, applyWorkerStats, collectServices } = require('../console/collect');
const { tokenReport } = require('../orchestrator/tokens');

function writeJournalLines(taskDir, lines) {
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeStateJson(taskDir, state) {
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

function writeLiveWorkers(journalRoot, ids, updatedAt) {
  fs.mkdirSync(journalRoot, { recursive: true });
  fs.writeFileSync(
    path.join(journalRoot, 'live-workers.json'),
    JSON.stringify({ ids, updatedAt: updatedAt || new Date().toISOString() })
  );
}

// A pid GUARANTEED dead: spawnSync is synchronous, so by the time it returns the child has
// already exited -- its pid is real (was briefly a real process) but will never answer
// process.kill(pid, 0) again for the rest of this test run (pid reuse on a real OS is possible
// in theory but not within a single test process's lifetime in practice, the same assumption
// every other liveness test in this suite already makes).
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return result.pid;
}

// ---- 1: a live worker row (task, state, account, duration) --------------------------------

test('spo status: a live worker row shows task, state, account, and a running duration', () => {
  const journalDir = mkTmp('spo-worker-live-');
  const queueDir = mkTmp('spo-worker-live-queue-');
  const id = 'issue-900';
  const dir = path.join(journalDir, id);
  const startedAt = new Date(Date.now() - 90 * 1000).toISOString(); // 90s ago

  writeJournalLines(dir, [
    { ts: startedAt, state: 'IMPLEMENT', event: 'llm-call', step: 'IMPLEMENT', account: 'pool1', duration_s: 12.3 },
  ]);
  writeStateJson(dir, {
    id,
    state: 'IMPLEMENT',
    owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: startedAt },
  });
  writeLiveWorkers(journalDir, [id]);

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /issue-900\s+IMPLEMENT\s+llm-call\s+worker: account=pool1\s+running \d+m\d\ds/);
  assert.match(out, /workers: 1 live \(subset of active: above\)/);
});

test('describeLiveWorkers: elapsedMs grows as `now` advances, for the SAME started-at -- the "duration that grows" property, tested deterministically rather than by racing the real clock', () => {
  const journalRoot = mkTmp('spo-worker-duration-grows-');
  const id = 'issue-901';
  const startedAt = '2026-09-01T12:00:00.000Z';
  writeLiveWorkers(journalRoot, [id]);
  const state = new Map([[id, { state: 'IMPLEMENT', owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: startedAt } }]]);

  const t1 = describeLiveWorkers(journalRoot, state, Date.parse(startedAt) + 1000);
  const t2 = describeLiveWorkers(journalRoot, state, Date.parse(startedAt) + 5000);
  assert.equal(t1.perId.get(id).elapsedMs, 1000);
  assert.equal(t2.perId.get(id).elapsedMs, 5000);
  assert.ok(t2.perId.get(id).elapsedMs > t1.perId.get(id).elapsedMs, 'duration must grow as time passes');
});

// ---- 2: workers and `active:` agree, from ONE fixture --------------------------------------

test('spo status: `workers:` and `active:` report the SAME number for a fixture with exactly one live worker on one active task', () => {
  const journalDir = mkTmp('spo-worker-agree-');
  const queueDir = mkTmp('spo-worker-agree-queue-');
  const id = 'issue-902';
  const dir = path.join(journalDir, id);
  const startedAt = new Date(Date.now() - 5000).toISOString();

  writeJournalLines(dir, [{ ts: startedAt, state: 'PLAN', event: 'llm-call', step: 'PLAN', account: 'pool2' }]);
  writeStateJson(dir, { id, state: 'PLAN', owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: startedAt } });
  writeLiveWorkers(journalDir, [id]);

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  const activeMatch = out.match(/active: (\d+)/);
  const workersMatch = out.match(/workers: (\d+) live/);
  assert.ok(activeMatch && workersMatch, 'both summary lines must be present');
  assert.equal(activeMatch[1], '1');
  assert.equal(workersMatch[1], '1');
  assert.equal(activeMatch[1], workersMatch[1], 'a double-count would make these disagree');
});

test('spo status: a stray live-workers.json entry naming a BACKOFF-bucketed id does NOT inflate `workers:` -- the exact hazard this action names by name', () => {
  // Not reachable under normal dispatcher operation (dispatcher.js's handleExit always calls
  // `live.delete(id)` before a task can re-enter the queue as a backoff entry) -- but a stale
  // read of live-workers.json mid-race is exactly the shape journal.js's own staleness reasoning
  // says to expect, and the summary line must not silently agree with it.
  const journalDir = mkTmp('spo-worker-backoff-stray-');
  const queueDir = mkTmp('spo-worker-backoff-stray-queue-');
  const id = 'issue-903';
  const dir = path.join(journalDir, id);

  writeJournalLines(dir, [{ ts: '2026-09-01T09:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(dir, { id, state: 'IMPLEMENT', owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: '2026-09-01T09:00:00.000Z' } });
  const notBefore = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0000-retry-1-issue-903.json'), JSON.stringify({ id, transientRetries: 1, notBefore }));
  // The stray entry: live-workers.json still names this id even though it is now BACKOFF.
  writeLiveWorkers(journalDir, [id]);

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /active: 0\s+backoff: 1/);
  assert.match(out, /workers: 0 live \(subset of active: above\)/, 'the backoff id must not be counted as a live worker');
  assert.doesNotMatch(out, /issue-903[^\n]*worker: account=/, 'the BACKOFF row itself must never grow a worker suffix');
});

// ---- 3: a missing live-workers.json renders honestly, not as zero --------------------------

test('spo status: a missing live-workers.json renders "workers: unknown", never "workers: 0 live"', () => {
  const journalDir = mkTmp('spo-worker-missing-');
  const queueDir = mkTmp('spo-worker-missing-queue-');
  const id = 'issue-904';
  writeJournalLines(path.join(journalDir, id), [{ ts: '2026-09-01T09:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(path.join(journalDir, id), { id, state: 'IMPLEMENT' });
  // No live-workers.json written at all -- no dispatcher has ever run against this journal root.

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /workers: unknown -- no live-workers\.json under/);
  assert.doesNotMatch(out, /workers: 0 live/, '"0 workers" is indistinguishable from "no dispatcher" -- must never be printed for an absent file');
});

// ---- 4: a stale entry (worker pid dead) is not reported as live ----------------------------

test('spo status: a live-workers.json entry whose owner pid is dead renders as a stale entry, not a live worker', () => {
  const journalDir = mkTmp('spo-worker-stale-');
  const queueDir = mkTmp('spo-worker-stale-queue-');
  const id = 'issue-905';
  const dir = path.join(journalDir, id);
  const pid = deadPid();

  writeJournalLines(dir, [{ ts: '2026-09-01T09:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call', account: 'pool1' }]);
  writeStateJson(dir, { id, state: 'IMPLEMENT', owner: { host: os.hostname(), workerPid: pid, workerStartedAt: '2026-09-01T09:00:00.000Z' } });
  writeLiveWorkers(journalDir, [id]);

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, new RegExp(`issue-905\\s+IMPLEMENT\\s+llm-call\\s+worker: stale live-workers\\.json entry \\(pid ${pid} not alive on this host\\)`));
  assert.doesNotMatch(out, /issue-905[^\n]*worker: account=/, 'a stale entry must never be rendered as a live/running worker');
  assert.match(out, /active: 1\s+backoff: 0/, 'the task itself is still active -- only the WORKER is stale');
  assert.match(out, /workers: 0 live \(subset of active: above\), 1 stale entry \(not counted live\)/);
});

test('describeLiveWorkers: a task already DONE with a trailing live-workers.json entry classifies as "trailing", never "live" or "stale"', () => {
  // The other side of "decide which side wins": state.json's terminal state wins over a
  // live-workers.json entry that has not caught up to the worker's own exit yet.
  const journalRoot = mkTmp('spo-worker-trailing-');
  const id = 'issue-906';
  writeLiveWorkers(journalRoot, [id]);
  const state = new Map([[id, { state: 'DONE', owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: '2026-09-01T09:00:00.000Z' } }]]);
  const result = describeLiveWorkers(journalRoot, state, Date.now());
  assert.equal(result.perId.get(id).classification, 'trailing');
  assert.equal(result.counts.live, 0);
  assert.equal(result.counts.stale, 0);
  assert.equal(result.counts.trailing, 1);
});

// ---- 5: duration_s renders per step, never as 0 for a missing measurement ------------------

test('spo task: an llm-call with duration_s renders it explicitly; one predating the field renders "not recorded", never "0s"', () => {
  const journalDir = mkTmp('spo-task-duration-');
  const id = 'issue-907';
  const dir = path.join(journalDir, id);
  writeJournalLines(dir, [
    { ts: '2026-09-01T10:00:00.000Z', state: 'PLAN', event: 'llm-call', step: 'PLAN', duration_s: 45.6 },
    // A legacy event: no duration_s at all (journal predates action 5.4). Must render as "not
    // recorded", never "0s" -- a 0 there would read as a real, fast call, not a missing
    // measurement (task-summary.js's own hasTokenData header names the identical bug for tokens).
    { ts: '2026-09-01T10:05:00.000Z', state: 'IMPLEMENT', event: 'llm-call', step: 'IMPLEMENT', costUsd: 1.2 },
    // A genuinely fast call: duration_s IS a real, tiny positive number -- must still render its
    // own value, not be confused with "not recorded" just for being small.
    { ts: '2026-09-01T10:06:00.000Z', state: 'VALIDATE', event: 'llm-call', step: 'VALIDATE', duration_s: 0.4 },
  ]);
  writeStateJson(dir, { id, state: 'DONE' });

  const out = runSpo(['task', id, '--journal', journalDir]);
  assert.match(out, /PLAN\s+llm-call duration=45\.6s/);
  assert.match(out, /IMPLEMENT\s+llm-call duration=not recorded/);
  assert.match(out, /VALIDATE\s+llm-call duration=0\.4s/);
  assert.doesNotMatch(out, /IMPLEMENT\s+llm-call duration=0(\.0)?s/, 'a missing measurement must never render as 0');
  assert.match(out, /step durations: PLAN 45\.6s, VALIDATE 0\.4s \(total 46\.0s, 2\/3 llm-call\(s\) recorded\)/);
  // The raw JSON detail no longer duplicates duration_s now that it has its own explicit field --
  // proves the field was actually pulled out, not merely echoed twice.
  assert.doesNotMatch(out, /"duration_s":45\.6/);
});

test('spo task: a journal with llm-call events but NO duration_s anywhere says so explicitly', () => {
  const journalDir = mkTmp('spo-task-duration-none-');
  const id = 'issue-908';
  writeJournalLines(path.join(journalDir, id), [
    { ts: '2026-08-01T00:00:00.000Z', state: 'PLAN', event: 'llm-call', costUsd: 0.5 },
  ]);
  writeStateJson(path.join(journalDir, id), { id, state: 'DONE' });

  const out = runSpo(['task', id, '--journal', journalDir]);
  assert.match(out, /step durations: not recorded for any of 1 llm-call event\(s\) \(journal predates action 5\.4\)/);
});

// ---- 6: C5's two agreements still hold, extended with C6/6.7 fixtures ----------------------

test('spo status: a worker row and a PARKED retry-channel row coexist correctly -- C5\'s reason/streak agreement (action 5.4 item A/F) is unaffected by 6.7\'s worker annotation', () => {
  const journalDir = mkTmp('spo-6.7-agreement-parked-');
  const queueDir = mkTmp('spo-6.7-agreement-parked-queue-');

  // An ACTIVE task with a live worker (6.7's own new behaviour) alongside a PARKED task whose
  // reason and retry-channel streak (5.4's pinned behaviour) must render exactly as before.
  const activeId = 'issue-909';
  const activeDir = path.join(journalDir, activeId);
  const startedAt = new Date(Date.now() - 30000).toISOString();
  writeJournalLines(activeDir, [{ ts: startedAt, state: 'IMPLEMENT', event: 'llm-call', account: 'pool1' }]);
  writeStateJson(activeDir, { id: activeId, state: 'IMPLEMENT', owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: startedAt } });

  const parkedId = 'issue-213';
  const parkedDir = path.join(journalDir, parkedId);
  writeJournalLines(parkedDir, [
    { ts: '2026-08-30T09:00:00.000Z', state: 'DIAGNOSE', event: 'parked', reason: 'diagnose-duplicate-root-cause' },
    { ts: '2026-08-30T10:11:23.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
    { ts: '2026-08-30T10:12:23.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
  ]);
  writeStateJson(parkedDir, { id: parkedId, state: 'PARKED', reason: 'diagnose-duplicate-root-cause' });

  writeLiveWorkers(journalDir, [activeId]);

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /issue-213\s+PARKED\s+reason=diagnose-duplicate-root-cause\s+retry-channel: 2 failure\(s\)/);
  assert.match(out, /issue-909\s+IMPLEMENT\s+llm-call\s+worker: account=pool1\s+running/);
  assert.match(out, /active: 1\s+backoff: 0\s+parked: 1\s+abandoned: 0\s+done: 0/);
});

test('spo status: the three new C6 PARKED reasons (worker-crashed, all-accounts-leased, product-repo-lock-timeout) render through the existing reason column, unchanged', () => {
  const journalDir = mkTmp('spo-6.7-park-reasons-');
  const queueDir = mkTmp('spo-6.7-park-reasons-queue-');
  const reasons = ['worker-crashed', 'all-accounts-leased', 'product-repo-lock-timeout'];
  reasons.forEach((reason, i) => {
    const id = `issue-91${i}`;
    writeJournalLines(path.join(journalDir, id), [{ ts: '2026-09-01T00:00:00.000Z', state: 'PARKED', event: 'parked', reason }]);
    writeStateJson(path.join(journalDir, id), { id, state: 'PARKED', reason });
  });

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  for (let i = 0; i < reasons.length; i++) {
    assert.match(out, new RegExp(`issue-91${i}\\s+PARKED\\s+reason=${reasons[i]}`));
  }
});

test('parking rate: collectDaemonStats/tokenReport denominator agreement (action 5.4 item G) still holds with an ACTIVE task carrying a live worker in the same fixture', () => {
  const journalRoot = mkTmp('spo-6.7-parking-rate-');

  writeJournalLines(path.join(journalRoot, 'issue-1'), [{ ts: '2026-09-01T00:00:00.000Z', state: 'DONE', event: 'done' }]);
  writeStateJson(path.join(journalRoot, 'issue-1'), { id: 'issue-1', state: 'DONE', updatedAt: '2026-09-01T00:00:00.000Z' });

  writeJournalLines(path.join(journalRoot, 'issue-2'), [{ ts: '2026-09-01T00:00:00.000Z', state: 'PARKED', event: 'parked', reason: 'x' }]);
  writeStateJson(path.join(journalRoot, 'issue-2'), { id: 'issue-2', state: 'PARKED', reason: 'x', updatedAt: '2026-09-01T00:00:00.000Z' });

  // The new element: an ACTIVE task with a live worker. Neither side's denominator counts
  // non-terminal tasks at all, so this must not perturb either total.
  const startedAt = new Date(Date.now() - 1000).toISOString();
  writeJournalLines(path.join(journalRoot, 'issue-3'), [{ ts: startedAt, state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(path.join(journalRoot, 'issue-3'), {
    id: 'issue-3',
    state: 'IMPLEMENT',
    owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: startedAt },
  });
  writeLiveWorkers(journalRoot, ['issue-3']);

  const journalTasks = collectJournalTasks(journalRoot);
  const daemonStats = collectDaemonStats(journalTasks, 0);
  assert.equal(daemonStats.total, 2); // issue-1 (done) + issue-2 (parked) -- issue-3 is active, not terminal
  assert.equal(daemonStats.active, 1);

  const report = tokenReport(journalRoot);
  const finished = report.done + report.parked + report.abandoned;
  assert.equal(finished, daemonStats.total);
  assert.equal(report.parked / finished, 1 / 2);
});

// ---- dispatcher-idle and account-cooldown degraded, both new surfaces in this action -------

test('spo status: a dispatcher stuck idle (no healthy accounts, never recovered) prints a `dispatcher: IDLE` line', () => {
  const journalDir = mkTmp('spo-6.7-dispatcher-idle-');
  const queueDir = mkTmp('spo-6.7-dispatcher-idle-queue-');
  const idleTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(
    path.join(journalDir, 'daemon.jsonl'),
    JSON.stringify({ ts: idleTs, event: 'dispatcher-idle-no-healthy-accounts', healthy: 0, configuredWorkers: 2, queued: 3, enabledAccounts: ['pool1'], earliestCooldownUntil: '2026-09-01T12:00:00.000Z' }) + '\n'
  );

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /dispatcher: IDLE since .+ ago -- no healthy accounts \(queue depth 3, earliest cooldown 2026-09-01T12:00:00\.000Z\)/);
});

test('spo status: a dispatcher idle event followed by a recovery event prints NOTHING -- edge-triggered, not level-triggered', () => {
  const journalDir = mkTmp('spo-6.7-dispatcher-recovered-');
  const queueDir = mkTmp('spo-6.7-dispatcher-recovered-queue-');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(
    path.join(journalDir, 'daemon.jsonl'),
    [
      JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', event: 'dispatcher-idle-no-healthy-accounts', healthy: 0, queued: 1 }),
      JSON.stringify({ ts: '2026-09-01T00:05:00.000Z', event: 'dispatcher-healthy-accounts-returned', healthy: 2, queued: 1 }),
    ].join('\n') + '\n'
  );

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.doesNotMatch(out, /dispatcher: IDLE/);
});

test('spo status: no daemon.jsonl at all prints no dispatcher line, and does not crash', () => {
  const journalDir = mkTmp('spo-6.7-no-daemon-jsonl-');
  const queueDir = mkTmp('spo-6.7-no-daemon-jsonl-queue-');
  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.doesNotMatch(out, /dispatcher: IDLE/);
});

test('spo status: a degraded account-cooldown write is aggregated and named by account; absent when none occurred', () => {
  const journalDir = mkTmp('spo-6.7-degraded-cooldown-');
  const queueDir = mkTmp('spo-6.7-degraded-cooldown-queue-');
  const id = 'issue-920';
  writeJournalLines(path.join(journalDir, id), [
    { ts: '2026-09-01T00:00:00.000Z', state: 'PLAN', event: 'account-cooldown', account: 'pool1', limitKind: 'usage', degraded: true },
    { ts: '2026-09-01T00:01:00.000Z', state: 'PLAN', event: 'account-cooldown', account: 'pool1', limitKind: 'usage', degraded: true },
    // A NON-degraded cooldown must not be counted.
    { ts: '2026-09-01T00:02:00.000Z', state: 'PLAN', event: 'account-cooldown', account: 'pool2', limitKind: 'overloaded', degraded: false },
  ]);
  writeStateJson(path.join(journalDir, id), { id, state: 'DONE' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /account-cooldown: 2 degraded write\(s\) .+ -- pool1 x2/);
  assert.doesNotMatch(out, /pool2 x/, 'a non-degraded cooldown on pool2 must not be counted');
});

test('spo status: no degraded account-cooldown writes anywhere prints no account-cooldown line at all', () => {
  const journalDir = mkTmp('spo-6.7-no-degraded-');
  const queueDir = mkTmp('spo-6.7-no-degraded-queue-');
  const id = 'issue-921';
  writeJournalLines(path.join(journalDir, id), [{ ts: '2026-09-01T00:00:00.000Z', state: 'DONE', event: 'done' }]);
  writeStateJson(path.join(journalDir, id), { id, state: 'DONE' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.doesNotMatch(out, /account-cooldown:/);
});

// ---- dashboard: services.workers is an AGGREGATE, and agrees with daemonStats.active -------

test('console/collect.js: services.workers.count is a subset of daemonStats.active for a fixture with one live worker (applyWorkerStats, not a second tally)', () => {
  const journalRoot = mkTmp('spo-6.7-dashboard-workers-');
  const id = 'issue-930';
  const startedAt = new Date(Date.now() - 2000).toISOString();
  writeJournalLines(path.join(journalRoot, id), [{ ts: startedAt, state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(path.join(journalRoot, id), { id, state: 'IMPLEMENT', owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: startedAt } });
  writeLiveWorkers(journalRoot, [id]);

  const journalTasks = collectJournalTasks(journalRoot);
  const daemonStats = collectDaemonStats(journalTasks, 0);
  const services = applyWorkerStats(collectServices({ journalRoot }), journalRoot, journalTasks, Date.now());

  assert.equal(services.workers.present, true);
  assert.equal(services.workers.count, 1);
  assert.equal(daemonStats.active, 1);
  assert.ok(services.workers.count <= daemonStats.active, 'workers tile must never exceed daemonStats.active');
});

test('console/collect.js: a live worker on a kind:"synthetic" task is excluded from services.workers.count, the same exclusion collectDaemonStats.active already applies', () => {
  const journalRoot = mkTmp('spo-6.7-dashboard-workers-synthetic-');
  const id = 'demo-live-001';
  const startedAt = new Date(Date.now() - 2000).toISOString();
  writeJournalLines(path.join(journalRoot, id), [{ ts: startedAt, state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(path.join(journalRoot, id), {
    id,
    kind: 'synthetic',
    state: 'IMPLEMENT',
    owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: startedAt },
  });
  writeLiveWorkers(journalRoot, [id]);

  const journalTasks = collectJournalTasks(journalRoot);
  const daemonStats = collectDaemonStats(journalTasks, 0);
  const services = applyWorkerStats(collectServices({ journalRoot }), journalRoot, journalTasks, Date.now());

  assert.equal(daemonStats.active, 0, 'collectDaemonStats already excludes kind:synthetic from active');
  assert.equal(services.workers.count, 0, 'the workers tile must apply the same exclusion, or it would exceed daemonStats.active');
});

test('console/collect.js: services.workers reports "unknown" status (not a healthy-looking 0) when live-workers.json is absent', () => {
  const journalRoot = mkTmp('spo-6.7-dashboard-workers-missing-');
  const services = applyWorkerStats(collectServices({ journalRoot }), journalRoot, [], Date.now());
  assert.equal(services.workers.present, false);
  assert.equal(services.workers.status, 'unknown');
  assert.equal(services.workers.count, 0);
});

// ---- 7: verification pass -- the survivors of the mutation campaign ------------------------
// Everything below was added by 6.7's VERIFIER. Each test corresponds to one mutation that
// passed the entire 1370-test suite unnoticed, or to one defect that pass found. The four
// defects are noted at their own tests; the rest close pins that were merely absent.

test('spo status: the `stale` half of the workers summary comes from the ROWS too -- a stale live-workers entry on a BACKOFF-bucketed id must not appear in it either', () => {
  // The action pinned only the LIVE half of "the summary is built from row counters, never from
  // describeLiveWorkers's aggregate": its backoff-stray fixture used a LIVE pid, so swapping
  // `staleWorkerRows` for `workerStatus.counts.stale` passed the whole suite. Same fixture shape,
  // stale pid -- now both halves of the line are anchored to rows that actually printed.
  const journalDir = mkTmp('spo-6.7v-backoff-stale-');
  const queueDir = mkTmp('spo-6.7v-backoff-stale-queue-');
  const id = 'issue-940';
  const dir = path.join(journalDir, id);
  const pid = deadPid();

  writeJournalLines(dir, [{ ts: '2026-09-01T09:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(dir, { id, state: 'IMPLEMENT', owner: { host: os.hostname(), workerPid: pid, workerStartedAt: '2026-09-01T09:00:00.000Z' } });
  const notBefore = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0000-retry-1-issue-940.json'), JSON.stringify({ id, transientRetries: 1, notBefore }));
  writeLiveWorkers(journalDir, [id]);

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /active: 0\s+backoff: 1/);
  assert.match(out, /workers: 0 live \(subset of active: above\)/);
  assert.doesNotMatch(out, /stale entr/, 'no ROW reported a stale worker, so the summary must not invent one either');
});

test('spo status: a DONE task with a trailing live-workers entry renders the note AND the summary counter -- the rendered trailing path, not just describeLiveWorkers', () => {
  // The action tested `classification === "trailing"` through describeLiveWorkers directly, so
  // deleting the row note and its counter from cmdStatus entirely passed the whole suite.
  const journalDir = mkTmp('spo-6.7v-trailing-render-');
  const queueDir = mkTmp('spo-6.7v-trailing-render-queue-');
  const id = 'issue-941';
  const dir = path.join(journalDir, id);
  writeJournalLines(dir, [{ ts: '2026-09-01T09:00:00.000Z', state: 'DONE', event: 'done' }]);
  writeStateJson(dir, { id, state: 'DONE', owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: '2026-09-01T09:00:00.000Z' } });
  writeLiveWorkers(journalDir, [id]);

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /issue-941\s+DONE\s+done\s+\(worker still exiting\)/);
  assert.match(out, /workers: 0 live \(subset of active: above\), 1 still exiting \(task already terminal\)/);
  assert.doesNotMatch(out, /workers: 1 live/, 'a trailing worker is counted by the DONE bucket, never a second time as live');
});

test('spo status: a worker whose owner is on ANOTHER host counts as live and says the pid was never probed', () => {
  // `unverifiable` had no test at all: flipping the remote-host branch from 'live' to 'stale'
  // passed the whole suite, and the "(pid unverifiable -- owner host X)" render was dead text.
  const journalDir = mkTmp('spo-6.7v-remote-');
  const queueDir = mkTmp('spo-6.7v-remote-queue-');
  const id = 'issue-942';
  const startedAt = new Date(Date.now() - 45000).toISOString();
  writeJournalLines(path.join(journalDir, id), [{ ts: startedAt, state: 'IMPLEMENT', event: 'llm-call', account: 'pool1' }]);
  writeStateJson(path.join(journalDir, id), { id, state: 'IMPLEMENT', owner: { host: 'some-other-box', workerPid: 999999, workerStartedAt: startedAt } });
  writeLiveWorkers(journalDir, [id]);

  const info = describeLiveWorkers(journalDir, null, Date.now()).perId.get(id);
  assert.equal(info.classification, 'live', 'a pid on another host cannot be probed -- orphan-scan.js\'s posture is to leave it alone, not to call it dead');
  assert.equal(info.unverifiable, true);

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /issue-942[^\n]*worker: account=pool1\s+running [^\n]*\(pid unverifiable -- owner host some-other-box\)/);
  assert.match(out, /workers: 1 live/);
});

test('spo task: a duration_s of EXACTLY 0 renders 0.0s -- the other direction of the 0-vs-missing rule', () => {
  // The action's own fixture used 0.4 ("small but nonzero"), so narrowing the guard from
  // `typeof ev.duration_s === 'number'` to a truthiness test -- which turns a real, measured 0
  // into "not recorded" -- passed the whole suite. Both directions are now pinned.
  const journalDir = mkTmp('spo-6.7v-zero-duration-');
  const id = 'issue-943';
  writeJournalLines(path.join(journalDir, id), [
    { ts: '2026-09-01T10:00:00.000Z', state: 'PLAN', event: 'llm-call', step: 'PLAN', duration_s: 0 },
    { ts: '2026-09-01T10:01:00.000Z', state: 'IMPLEMENT', event: 'llm-call', step: 'IMPLEMENT' },
  ]);
  writeStateJson(path.join(journalDir, id), { id, state: 'DONE' });

  const out = runSpo(['task', id, '--journal', journalDir]);
  assert.match(out, /PLAN\s+llm-call duration=0\.0s/, 'a measured 0 is a measurement, not an absence');
  assert.match(out, /IMPLEMENT\s+llm-call duration=not recorded/);
  assert.match(out, /step durations: PLAN 0\.0s \(total 0\.0s, 1\/2 llm-call\(s\) recorded\)/);
});

test('collectJournalTasks: a missing duration_s is carried as null, never 0 -- same rule one layer down', () => {
  const journalRoot = mkTmp('spo-6.7v-durationS-null-');
  const id = 'issue-944';
  writeJournalLines(path.join(journalRoot, id), [
    { ts: '2026-09-01T10:00:00.000Z', state: 'PLAN', event: 'llm-call', step: 'PLAN', duration_s: 0 },
    { ts: '2026-09-01T10:01:00.000Z', state: 'IMPLEMENT', event: 'llm-call', step: 'IMPLEMENT' },
  ]);
  writeStateJson(path.join(journalRoot, id), { id, state: 'DONE' });

  const steps = collectJournalTasks(journalRoot)[0].llmSteps;
  assert.equal(steps[0].durationS, 0, 'a measured 0 survives as 0');
  assert.equal(steps[1].durationS, null, 'an absent measurement is null, never 0 -- the two must stay distinguishable');
});

test('console/collect.js: a trailing live-workers entry is excluded from BOTH services.workers.count and staleCount', () => {
  // Deleting applyWorkerStats's `trailing` skip passed the whole suite: nothing measured the
  // dashboard tile against a terminal task that still had a worker listed.
  const journalRoot = mkTmp('spo-6.7v-tile-trailing-');
  const id = 'issue-945';
  writeJournalLines(path.join(journalRoot, id), [{ ts: '2026-09-01T09:00:00.000Z', state: 'DONE', event: 'done' }]);
  writeStateJson(path.join(journalRoot, id), {
    id,
    state: 'DONE',
    updatedAt: '2026-09-01T09:00:00.000Z',
    owner: { host: os.hostname(), workerPid: process.pid, workerStartedAt: '2026-09-01T09:00:00.000Z' },
  });
  writeLiveWorkers(journalRoot, [id]);

  const journalTasks = collectJournalTasks(journalRoot);
  const daemonStats = collectDaemonStats(journalTasks, 0);
  const services = applyWorkerStats(collectServices({ journalRoot }), journalRoot, journalTasks, Date.now());

  assert.equal(daemonStats.active, 0, 'the task is DONE -- it is in the terminal bucket, not active');
  assert.equal(services.workers.count, 0, 'a trailing worker must never be counted live');
  assert.equal(services.workers.staleCount, 0, 'nor stale -- the task\'s own terminal state wins');
  assert.equal(services.workers.trailingCount, 1, 'it is reported, separately, as still exiting');
  assert.ok(services.workers.count <= daemonStats.active, 'the tile must never exceed daemonStats.active');
});

// ---- 8: the four defects this verification pass found and fixed ---------------------------

test('DEFECT: a live-workers.json stamped in the FUTURE (backward clock jump) must not print "published null ago"', () => {
  // formatDuration returns NULL for a negative duration, by its own documented contract, and
  // `ageMs` IS negative whenever updatedAt is in the future. C6's errata record that this box's
  // clock jumps backward, so this is a measured hazard, not a hypothetical one. The unguarded
  // template interpolated the literal string "null".
  const journalDir = mkTmp('spo-6.7v-clock-skew-');
  const queueDir = mkTmp('spo-6.7v-clock-skew-queue-');
  const id = 'issue-946';
  writeJournalLines(path.join(journalDir, id), [{ ts: '2026-09-01T09:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(path.join(journalDir, id), { id, state: 'IMPLEMENT' });
  writeLiveWorkers(journalDir, [id], new Date(Date.now() + 60 * 60 * 1000).toISOString());

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.doesNotMatch(out, /null/, 'no rendered line may contain the literal string "null"');
  assert.match(out, /stamped .+ in the FUTURE -- clock skew, age unknown/);
});

test('DEFECT: a worker that has not written its owner snapshot yet must not be reported as a dead pid', () => {
  // dispatcher.js publishes live-workers.json synchronously inside spawnOne, before the worker
  // process has booted node at all -- so on EVERY spawn there is a window where a healthy worker
  // has no owner.workerPid to probe. cmdStatus rendered that as "(pid ? not alive on this host)":
  // a liveness check that never ran, reported as one that failed.
  const journalDir = mkTmp('spo-6.7v-no-owner-');
  const queueDir = mkTmp('spo-6.7v-no-owner-queue-');
  const id = 'issue-947';
  writeJournalLines(path.join(journalDir, id), [{ ts: '2026-09-01T09:00:00.000Z', state: 'INTAKE', event: 'claimed' }]);
  writeStateJson(path.join(journalDir, id), { id, state: 'INTAKE' }); // no owner yet
  writeLiveWorkers(journalDir, [id]);

  const info = describeLiveWorkers(journalDir, null, Date.now()).perId.get(id);
  assert.equal(info.classification, 'stale', 'still not counted live -- it is not provably running');
  assert.equal(info.staleReason, 'no-owner-recorded');
  assert.equal(info.unverifiable, true, 'no liveness check ran, and the shape must say so');

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /issue-947[^\n]*worker: no owner recorded yet/);
  assert.doesNotMatch(out, /not alive on this host/, 'must not assert a probe that never ran');
  assert.match(out, /workers: 0 live/, 'and it still must not be counted as a live worker');
});

test('DEFECT: a dead owner pid still says so explicitly -- the OTHER stale cause keeps its own wording', () => {
  const journalDir = mkTmp('spo-6.7v-pid-dead-');
  const queueDir = mkTmp('spo-6.7v-pid-dead-queue-');
  const id = 'issue-948';
  const pid = deadPid();
  writeJournalLines(path.join(journalDir, id), [{ ts: '2026-09-01T09:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(path.join(journalDir, id), { id, state: 'IMPLEMENT', owner: { host: os.hostname(), workerPid: pid, workerStartedAt: '2026-09-01T09:00:00.000Z' } });
  writeLiveWorkers(journalDir, [id]);

  const info = describeLiveWorkers(journalDir, null, Date.now()).perId.get(id);
  assert.equal(info.staleReason, 'pid-dead');
  assert.equal(info.unverifiable, false, 'this one WAS probed');

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, new RegExp(`issue-948[^\\n]*worker: stale live-workers\\.json entry \\(pid ${pid} not alive on this host\\)`));
  assert.doesNotMatch(out, /no owner recorded yet/);
});

test('DEFECT: an idle edge older than the newest dispatcher-start is not the CURRENT dispatcher\'s state', () => {
  // `idleNoHealthyAccounts` is in-memory, and the idle/returned pair is edge-triggered -- so a
  // restart between the two (this project restarts the daemon on every merge) means the
  // `returned` edge is never written at all, and a backwards walk to the newest edge claims IDLE
  // forever. Measured before the fix: "dispatcher: IDLE since 191h06m ago" on a fixture whose
  // daemon was demonstrably busy afterwards.
  const journalDir = mkTmp('spo-6.7v-idle-restart-');
  const queueDir = mkTmp('spo-6.7v-idle-restart-queue-');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(
    path.join(journalDir, 'daemon.jsonl'),
    [
      JSON.stringify({ ts: '2026-08-25T00:00:00.000Z', event: 'dispatcher-idle-no-healthy-accounts', healthy: 0, queued: 3 }),
      JSON.stringify({ ts: '2026-08-25T02:00:00.000Z', event: 'dispatcher-start', pid: 1234, workers: 2 }),
      JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', event: 'auto-pull', pulled: 2 }),
    ].join('\n') + '\n'
  );

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.doesNotMatch(out, /dispatcher: IDLE/, 'the idle edge predates the running dispatcher -- it says nothing about now');
});

test('a genuine idle edge AFTER the newest dispatcher-start still reports -- the fix suppresses staleness, not the signal', () => {
  const journalDir = mkTmp('spo-6.7v-idle-fresh-');
  const queueDir = mkTmp('spo-6.7v-idle-fresh-queue-');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(
    path.join(journalDir, 'daemon.jsonl'),
    [
      JSON.stringify({ ts: '2026-08-25T00:00:00.000Z', event: 'dispatcher-idle-no-healthy-accounts', healthy: 0, queued: 3 }),
      JSON.stringify({ ts: '2026-08-25T02:00:00.000Z', event: 'dispatcher-start', pid: 1234, workers: 2 }),
      JSON.stringify({ ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), event: 'dispatcher-idle-no-healthy-accounts', healthy: 0, queued: 5, earliestCooldownUntil: '2026-09-02T03:00:00.000Z' }),
    ].join('\n') + '\n'
  );

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /dispatcher: IDLE since 10m ago -- no healthy accounts \(queue depth 5, earliest cooldown 2026-09-02T03:00:00\.000Z\)/);
});
