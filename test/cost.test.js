'use strict';
// Tests for orchestrator/cost.js (the journals-are-the-truth spend reader) and its `spo cost`
// front end. Spend is seeded by writing `llm-call` events into a task journal -- exactly the
// shape a real run leaves behind; shadow tasks cost nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { costReport } = require('../orchestrator/cost');
const { SPO_BIN, REPO_ROOT, mkTmp } = require('./helpers');

const CONFIG_PATH = path.join(REPO_ROOT, 'orchestrator', 'config.js');

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
  assert.equal(costReport(path.join(mkTmp('spo-cost-'), 'nope')).totalUsd, 0);
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

test('autoPullLimit: defaults to 1 (one card off the board at a time); SPO_AUTO_PULL_LIMIT overrides', () => {
  const read = (env) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).autoPullLimit))', CONFIG_PATH],
        { encoding: 'utf8', env }
      )
    );

  assert.equal(read({ ...process.env, SPO_AUTO_PULL_LIMIT: undefined }), 1);
  assert.equal(read({ ...process.env, SPO_AUTO_PULL_LIMIT: '5' }), 5);
});
