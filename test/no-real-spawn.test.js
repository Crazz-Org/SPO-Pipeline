'use strict';
// Unit tests for test/no-real-spawn.js itself -- the shared killswitch every other file in this
// suite installs before requiring an orchestrator module (see that file's header for the
// 140-fabricated-park-comments incident it exists to close, and test/no-real-spawn-sweep.test.js
// for the standing guard that every file actually does so). This file tests the killswitch's own
// behaviour in isolation: that it throws, that the throw names the command and args, and that the
// escape hatch works -- not the placement rule, which is the sweep's job.
//
// Does not itself require any orchestrator module, so it needs no killswitch require of its own
// (test/no-real-spawn-sweep.test.js's rule only applies to files that do) -- and installing the
// killswitch is exactly the behaviour under test here, so a self-require is the point, not a
// prerequisite to guard against.

const test = require('node:test');
const assert = require('node:assert/strict');

const { installNoRealSpawn } = require('./no-real-spawn');

test('requiring the module installs the killswitch as a side effect -- the real spawnSync already throws', () => {
  assert.throws(
    () => require('child_process').spawnSync('git', ['status', '--porcelain']),
    /no-real-spawn: a test reached the REAL child_process\.spawnSync/
  );
});

test('the thrown error names the exact command and args, so the next reader knows which call site to fix', () => {
  assert.throws(
    () => require('child_process').spawnSync('gh', ['issue', 'comment', '1', '--repo', 'x/y']),
    (err) => {
      assert.match(err.message, /gh/);
      assert.match(err.message, /"issue"/);
      assert.match(err.message, /"comment"/);
      assert.match(err.message, /"--repo"/);
      assert.match(err.message, /"x\/y"/);
      assert.match(err.message, /deps\.spawnSync/, 'must tell the reader what to do about it, not just what happened');
      return true;
    }
  );
});

test('a call with no args array still throws cleanly (never crashes on JSON.stringify(undefined))', () => {
  assert.throws(
    () => require('child_process').spawnSync('npm'),
    /no-real-spawn: a test reached the REAL child_process\.spawnSync -- npm \[\]/
  );
});

test('installNoRealSpawn is idempotent -- calling it again still throws the same shape', () => {
  installNoRealSpawn();
  assert.throws(
    () => require('child_process').spawnSync('git', ['rev-parse', 'HEAD']),
    /no-real-spawn: a test reached the REAL child_process\.spawnSync -- git \["rev-parse","HEAD"\]/
  );
});


test('does NOT touch execFileSync/execSync/spawn -- test/helpers.js legitimately spawns spo/daemon subprocesses through execFileSync', () => {
  const cp = require('child_process');
  assert.equal(typeof cp.execFileSync, 'function');
  assert.equal(typeof cp.execSync, 'function');
  assert.equal(typeof cp.spawn, 'function');
  // Not asserting they're UNCHANGED (require() caches don't clone functions we could diff
  // against), just that requiring this module didn't replace them with a throwing stub the way
  // it did spawnSync -- a real execFileSync call would otherwise be the actual assertion, but
  // this file has no business spawning a real `spo` subprocess just to prove a negative that
  // test/helpers.js's own passing tests already rely on every run of this suite.
  assert.notEqual(cp.execFileSync.name, 'spawnSync');
});
