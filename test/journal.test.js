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
const { writeState, writeLiveWorkerIds, readLiveWorkerIds, liveWorkersPath } = require('../orchestrator/journal');
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

// ---- action 6.3: writeLiveWorkerIds/readLiveWorkerIds -- the cross-process live-worker table ---
// See journal.js's own header (the taskDir single-writer invariant section) for the full design:
// the dispatcher publishes its live-worker id set here on every spawn/exit, and the scanner reads
// it fresh every cycle to protect a task a worker still owns from a concurrent orphan-scan pass.

test('writeLiveWorkerIds: the rename is atomic -- renameSync\'s target never existed before, and the source is already complete JSON', () => {
  const dir = mkTmp('spo-journal-liveids-atomic-');
  const origRename = fs.renameSync;
  const calls = [];
  fs.renameSync = (src, dest) => {
    calls.push({ src, dest, srcContent: fs.readFileSync(src, 'utf8'), destExisted: fs.existsSync(dest) });
    return origRename(src, dest);
  };
  try {
    writeLiveWorkerIds(dir, new Set(['issue-1', 'issue-2']));
  } finally {
    fs.renameSync = origRename;
  }

  assert.equal(calls.length, 1, 'writeLiveWorkerIds must go through exactly one rename -- a direct writeFileSync to the target would call this 0 times');
  assert.equal(calls[0].dest, liveWorkersPath(dir));
  assert.equal(path.dirname(calls[0].src), dir, 'tmp file must be in the SAME directory as the target -- renameSync is not atomic across filesystems');
  assert.equal(calls[0].destExisted, false, 'the target name did not exist an instant before this call');
  // Complete, parsable JSON already, before the target name is ever visible under it.
  const parsed = JSON.parse(calls[0].srcContent);
  assert.deepEqual(parsed.ids, ['issue-1', 'issue-2']);
});

test('writeLiveWorkerIds: no tmp file left behind after a clean write', () => {
  const dir = mkTmp('spo-journal-liveids-notmp-');
  writeLiveWorkerIds(dir, new Set(['a']));
  assert.deepEqual(fs.readdirSync(dir), ['live-workers.json']);
});

test('writeLiveWorkerIds/readLiveWorkerIds: round trip, sorted, with an updatedAt timestamp', () => {
  const dir = mkTmp('spo-journal-liveids-roundtrip-');
  writeLiveWorkerIds(dir, new Set(['zeta', 'alpha', 'mu']));
  const raw = JSON.parse(fs.readFileSync(liveWorkersPath(dir), 'utf8'));
  assert.deepEqual(raw.ids, ['alpha', 'mu', 'zeta']);
  assert.ok(!Number.isNaN(Date.parse(raw.updatedAt)));
  assert.deepEqual([...readLiveWorkerIds(dir)].sort(), ['alpha', 'mu', 'zeta']);
});

test('writeLiveWorkerIds: an empty set writes an empty (not missing) file -- readLiveWorkerIds gives an empty Set, not "unknown"', () => {
  const dir = mkTmp('spo-journal-liveids-empty-');
  writeLiveWorkerIds(dir, new Set());
  assert.ok(fs.existsSync(liveWorkersPath(dir)));
  assert.deepEqual(readLiveWorkerIds(dir), new Set());
});

test('readLiveWorkerIds: tolerates a missing file (empty Set, never a throw) and an unparsable one', () => {
  const missingDir = mkTmp('spo-journal-liveids-missing-');
  assert.deepEqual(readLiveWorkerIds(missingDir), new Set());

  const garbageDir = mkTmp('spo-journal-liveids-garbage-');
  fs.mkdirSync(garbageDir, { recursive: true });
  fs.writeFileSync(liveWorkersPath(garbageDir), '{ not valid json');
  assert.deepEqual(readLiveWorkerIds(garbageDir), new Set());
});

test('writeLiveWorkerIds: still overwrites on every call (no stale ids survive an update)', () => {
  const dir = mkTmp('spo-journal-liveids-overwrite-');
  writeLiveWorkerIds(dir, new Set(['a', 'b']));
  writeLiveWorkerIds(dir, new Set(['c']));
  assert.deepEqual(readLiveWorkerIds(dir), new Set(['c']));
});
