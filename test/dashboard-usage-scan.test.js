'use strict';
// console/usage-scan.js -- incremental token scanner + pure view builder. Every fixture lives
// under mkTmp(); never touches ~/.claude/projects or ~/.claude-accounts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp } = require('./helpers');
const { createUsageScanner, buildTokenViews } = require('../console/usage-scan');

function usageLine(id, model, usage) {
  return JSON.stringify({ message: { id, model, usage } });
}

function writeSession(dir, sessionFile, lines) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionFile), lines.join('\n') + '\n');
}

test('scan() dedups by message.id within one file', async () => {
  const root = mkTmp('spo-usage-root-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }),
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }), // duplicate id
    usageLine('m2', 'claude-sonnet-5', { input_tokens: 50, output_tokens: 5 }),
  ]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  assert.equal(index.msgs, 2);
  assert.equal(index.dupes, 1);
});

test('scan() reuses an unchanged file (mtime+size) on a second call', async () => {
  const root = mkTmp('spo-usage-root-reuse-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 })]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const first = await scanner.scan();
  assert.equal(scanner.stats().filesScanned, 1);
  assert.equal(scanner.stats().filesReused, 0);

  const second = await scanner.scan();
  assert.equal(scanner.stats().filesScanned, 0);
  assert.equal(scanner.stats().filesReused, 1);
  assert.deepEqual(second.byModel, first.byModel);
});

test('scan() re-reads a file whose content changed (new mtime/size)', async () => {
  const root = mkTmp('spo-usage-root-change-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 })]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  await scanner.scan();

  // Force a distinguishable mtime and append a line.
  await new Promise((r) => setTimeout(r, 5));
  fs.appendFileSync(path.join(projDir, 'sess-1.jsonl'), usageLine('m2', 'claude-sonnet-5', { input_tokens: 20, output_tokens: 2 }) + '\n');
  fs.utimesSync(path.join(projDir, 'sess-1.jsonl'), new Date(), new Date(Date.now() + 1000));

  const second = await scanner.scan();
  assert.equal(scanner.stats().filesScanned, 1);
  assert.equal(second.msgs, 2);
});

test('scan() drops a file from the index once it is removed', async () => {
  const root = mkTmp('spo-usage-root-remove-');
  const projDir = path.join(root, 'projet-A');
  const filePath = path.join(projDir, 'sess-1.jsonl');
  writeSession(projDir, 'sess-1.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 })]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  await scanner.scan();
  assert.equal(scanner.stats().cachedFiles, 1);

  fs.rmSync(filePath);
  const after = await scanner.scan();
  assert.equal(scanner.stats().cachedFiles, 0);
  assert.deepEqual(after.bySession, {});
});

test('buildTokenViews attributes a session to its task via sessionIndex, and buckets the rest as unattributed', () => {
  const root = mkTmp('spo-usage-root-views-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-mapped.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 1000000, output_tokens: 100000 })]);
  writeSession(projDir, 'sess-unmapped.jsonl', [usageLine('m2', 'claude-sonnet-5', { input_tokens: 200000, output_tokens: 1000 })]);

  return (async () => {
    const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
    const index = await scanner.scan();
    const sessionIndex = { 'sess-mapped': { taskId: 'issue-42', state: 'DONE', title: 'Demo' } };

    const views = buildTokenViews(index, sessionIndex);
    assert.equal(views.byTask.length, 1);
    assert.equal(views.byTask[0].taskId, 'issue-42');
    assert.equal(views.unattributed.sessions, 1);

    // Never a dollar figure or an estUsd key anywhere in the views.
    const dump = JSON.stringify(views);
    assert.doesNotMatch(dump, /\$/);
    assert.doesNotMatch(dump, /estUsd/);
  })();
});

test('buildTokenViews(null, ...) returns null', () => {
  assert.equal(buildTokenViews(null, {}), null);
});
