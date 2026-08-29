'use strict';
// Tests for orchestrator/cost.js (the journals-are-the-truth spend reader), its `spo cost`
// front end, and state-machine.js's cumulative ceiling (config.soakBudgetUsd).
//
// The ceiling is exercised through a real shadow-mode daemon run against hand-written
// journals: shadow tasks cost nothing, so the spend is seeded by writing `llm-call` events
// into a pre-existing task journal -- which is exactly the shape a real run leaves behind.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { costReport, totalSpentUsd } = require('../orchestrator/cost');
const { DAEMON, SPO_BIN, mkTmp, writeTask, runDaemonOnce, readState } = require('./helpers');

// The shadow fixture that drives a synthetic task all the way to DONE (same shape as
// happy-path.test.js): the ceiling tests care about whether a task is TAKEN, so they need a
// task that completes rather than parks for unrelated reasons.
const DONE_FIXTURE = { gate: [0], prWait: [0], llm: { VALIDATE: { verdict: 'PASS' } } };

// Writes journal/<id>/{journal.jsonl,state.json} the way a finished real task leaves them.
function seedTaskJournal(journalRoot, id, { costs = [], state = 'DONE', parks = [] } = {}) {
  const dir = path.join(journalRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = costs.map((c) => JSON.stringify({ ts: 'x', state: 'PLAN', event: 'llm-call', costUsd: c }));
  for (const reason of parks) {
    lines.push(JSON.stringify({ ts: 'x', state: 'PLAN', event: 'parked', reason }));
  }
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id, state }));
}

test('costReport: sums llm-call costUsd per task and in aggregate', () => {
  const journalRoot = mkTmp('spo-cost-');
  seedTaskJournal(journalRoot, 'issue-1', { costs: [1.5, 2.25], state: 'DONE' });
  seedTaskJournal(journalRoot, 'issue-2', { costs: [3.0], state: 'PARKED', parks: ['plan-invalid'] });

  const report = costReport(journalRoot);
  assert.equal(report.tasks.length, 2);
  assert.equal(report.tasks[0].costUsd, 3.75);
  assert.equal(report.tasks[0].llmCalls, 2);
  assert.equal(report.totalUsd, 6.75);
  assert.equal(report.done, 1);
  assert.equal(report.parked, 1);
  assert.equal(report.parks, 1);
  assert.deepEqual(report.tasks[1].parkReasons, ['plan-invalid']);
});

test('costReport: counts park EVENTS, not parked tasks (a card can park and still be DONE)', () => {
  const journalRoot = mkTmp('spo-cost-');
  seedTaskJournal(journalRoot, 'issue-247', { costs: [6.79], state: 'DONE', parks: ['a', 'b', 'c'] });

  const report = costReport(journalRoot);
  assert.equal(report.done, 1);
  assert.equal(report.parked, 0); // no task ended parked...
  assert.equal(report.parks, 3); // ...but it parked three times on the way
});

test('costReport: a torn final line and a directory with no journal are skipped, not thrown on', () => {
  const journalRoot = mkTmp('spo-cost-');
  seedTaskJournal(journalRoot, 'good', { costs: [1] });
  fs.appendFileSync(path.join(journalRoot, 'good', 'journal.jsonl'), '{"event":"llm-call","costU');
  fs.mkdirSync(path.join(journalRoot, 'not-a-task'), { recursive: true });

  const report = costReport(journalRoot);
  assert.equal(report.tasks.length, 1);
  assert.equal(report.totalUsd, 1);
});

test('costReport: an empty/missing journal root is $0, not a throw', () => {
  assert.equal(totalSpentUsd(path.join(mkTmp('spo-cost-'), 'nope')), 0);
});

test('spo cost: prints per-task rows, the aggregate, cost per DONE and the parking rate', () => {
  const journalRoot = mkTmp('spo-cost-');
  seedTaskJournal(journalRoot, 'issue-1', { costs: [4], state: 'DONE' });
  seedTaskJournal(journalRoot, 'issue-2', { costs: [2], state: 'PARKED', parks: ['budget_exhausted'] });

  const out = execFileSync(process.execPath, [SPO_BIN, 'cost', '--journal', journalRoot], { encoding: 'utf8' });
  assert.match(out, /issue-1\s+DONE/);
  assert.match(out, /budget_exhausted/);
  assert.match(out, /total: \$6\.00 over 2 tasks/);
  assert.match(out, /cost per DONE card: \$6\.00/);
  assert.match(out, /parking rate: 50% \(1\/2 terminal\)/);
});

test('ceiling: at or over budget the daemon takes NO new task -- the queue file stays put', () => {
  const queueDir = mkTmp('spo-ceil-q-');
  const journalDir = mkTmp('spo-ceil-j-');
  seedTaskJournal(journalDir, 'already-spent', { costs: [20.5], state: 'DONE' });
  writeTask(queueDir, '001.json', { id: 'must-not-run', kind: 'synthetic', shadow: DONE_FIXTURE });

  execFileSync(
    process.execPath,
    [DAEMON, '--shadow', '--once', '--queue', queueDir, '--journal', journalDir],
    { encoding: 'utf8', env: { ...process.env, SPO_SOAK_BUDGET_USD: '20' } }
  );

  // Untaken: still in the queue, and no journal directory was created for it.
  assert.equal(fs.existsSync(path.join(queueDir, '001.json')), true);
  assert.equal(fs.existsSync(path.join(journalDir, 'must-not-run')), false);

  const daemonLog = fs
    .readFileSync(path.join(journalDir, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const hit = daemonLog.filter((e) => e.event === 'budget-ceiling-reached');
  assert.equal(hit.length, 1); // journaled exactly once per drain pass, not per queued task
  assert.equal(hit[0].ceilingUsd, 20);
  assert.equal(hit[0].queued, 1);
});

test('ceiling: under budget the daemon runs normally', () => {
  const queueDir = mkTmp('spo-ceil-q-');
  const journalDir = mkTmp('spo-ceil-j-');
  seedTaskJournal(journalDir, 'already-spent', { costs: [5], state: 'DONE' });
  writeTask(queueDir, '001.json', { id: 'must-run', kind: 'synthetic', shadow: DONE_FIXTURE });

  execFileSync(
    process.execPath,
    [DAEMON, '--shadow', '--once', '--queue', queueDir, '--journal', journalDir],
    { encoding: 'utf8', env: { ...process.env, SPO_SOAK_BUDGET_USD: '20' } }
  );

  assert.equal(fs.existsSync(path.join(queueDir, '001.json')), false); // taken
  assert.equal(readState(journalDir, 'must-run').state, 'DONE');
});

test('ceiling: unset (the default) imposes none -- existing behaviour is unchanged', () => {
  const queueDir = mkTmp('spo-ceil-q-');
  const journalDir = mkTmp('spo-ceil-j-');
  seedTaskJournal(journalDir, 'already-spent', { costs: [999], state: 'DONE' });
  writeTask(queueDir, '001.json', { id: 'runs-anyway', kind: 'synthetic', shadow: DONE_FIXTURE });

  runDaemonOnce(queueDir, journalDir); // no SPO_SOAK_BUDGET_USD in env

  assert.equal(readState(journalDir, 'runs-anyway').state, 'DONE');
});
