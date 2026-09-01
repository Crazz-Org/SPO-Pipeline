'use strict';
// Tests for orchestrator/journal.js's writeState -- action 2.5's other half (lock.js's
// write-tmp+link is covered in test/lock.test.js). state.json is the file orphan-scan.js reads
// to decide whether a task is orphaned, and runTask rewrites it on every state transition, so a
// truncated write (crash/kill -9 mid fs.writeFileSync) previously left a real in-flight task
// unparsable on the next daemon start. Fixed via write-tmp (same directory) + rename, which is
// atomic within a filesystem -- a reader only ever sees the old complete file or the new complete
// file, never a partial one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { writeState } = require('../orchestrator/journal');
const { mkTmp } = require('./helpers');

test('writeState: output is byte-identical to the pre-fix shape (pretty JSON + trailing newline)', () => {
  const dir = mkTmp('spo-journal-');
  const snapshot = { id: 'task-1', state: 'DIAGNOSE', attempts: 2, nested: { a: [1, 2, 3] } };
  writeState(dir, snapshot);
  const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  assert.equal(raw, JSON.stringify(snapshot, null, 2) + '\n');
});

test('writeState: no tmp file left behind after a clean write', () => {
  const dir = mkTmp('spo-journal-');
  writeState(dir, { id: 'task-1', state: 'INTAKE' });
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['state.json']);
});

test('writeState: the tmp path differs from the target, and rename is what publishes it', () => {
  const dir = mkTmp('spo-journal-');
  // Spy on fs.renameSync to capture the exact (src, dest) pair without changing behaviour.
  const origRename = fs.renameSync;
  const calls = [];
  fs.renameSync = (src, dest) => {
    calls.push({ src, dest });
    return origRename(src, dest);
  };
  try {
    writeState(dir, { id: 'task-1', state: 'VALIDATE' });
  } finally {
    fs.renameSync = origRename;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dest, path.join(dir, 'state.json'));
  assert.notEqual(calls[0].src, calls[0].dest);
  assert.equal(path.dirname(calls[0].src), dir); // same filesystem -- rename is only atomic there
  // The tmp name must not itself be readable as the published file at any point a caller could
  // observe post-hoc: after the call returns, only state.json exists (previous test), and here
  // we confirm the rename's source was a DIFFERENT, now-gone path.
  assert.equal(fs.existsSync(calls[0].src), false);
});

test('writeState: a reader never observes a partial state.json -- overwriting a large snapshot leaves only the new content', () => {
  const dir = mkTmp('spo-journal-');
  writeState(dir, { state: 'INTAKE', big: 'x'.repeat(50000) });
  writeState(dir, { state: 'DONE', big: 'y'.repeat(10) });
  const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const parsed = JSON.parse(raw); // throws if truncated -- the actual property under test
  assert.equal(parsed.state, 'DONE');
  assert.equal(parsed.big, 'y'.repeat(10));
  assert.deepEqual(fs.readdirSync(dir), ['state.json']); // no tmp survives the second write either
});

test('writeState: tmp file is cleaned up on the failure path (rename fails), error still propagates', () => {
  const dir = mkTmp('spo-journal-');
  // Make the target a directory instead of a file: renameSync(tmp, state.json) then fails EISDIR
  // -- a real fs error unrelated to the atomic-write mechanism, standing in for "rename fails".
  fs.mkdirSync(path.join(dir, 'state.json'));

  assert.throws(() => writeState(dir, { id: 'x' }), (err) => {
    assert.equal(err.code, 'EISDIR');
    return true;
  });

  // Only the pre-existing directory remains -- the tmp file the failed rename left dangling was
  // cleaned up, not left as litter in the task's journal directory.
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['state.json']);
  assert.equal(fs.statSync(path.join(dir, 'state.json')).isDirectory(), true);
});

test('writeState: still overwrites on every call (no stale content ever survives an update)', () => {
  const dir = mkTmp('spo-journal-');
  writeState(dir, { state: 'INTAKE' });
  writeState(dir, { state: 'GATE' });
  writeState(dir, { state: 'DONE' });
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(parsed.state, 'DONE');
});
