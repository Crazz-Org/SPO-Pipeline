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
const { collectAll } = require('../console/collect');
const { renderDashboard } = require('../console/render');

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
  assert.match(html, /Utilisation/);
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
  assert.match(html, /\$0\.1234/); // the recorded llm-call costUsd
  assert.match(html, /claude --resume sess-plan-abc/);
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
