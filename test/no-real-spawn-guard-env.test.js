'use strict';
// no-real-spawn-guard-env.test.js -- T4: the propagation is by ENVIRONMENT, not by module state.
//
// In its own file, separate from test/no-real-spawn-guard.test.js's T1-T3, for a concrete,
// unavoidable reason: this file's second half needs to observe test/no-real-spawn.js's
// require-time side effect (does requiring it set the env var?) from BEFORE it has ever been
// required in a process. This file DOES require test/no-real-spawn.js at column 0, same as any
// other file that requires an orchestrator module (test/no-real-spawn-sweep.test.js's placement
// rule, unconditional) -- which means, by the time any test() body below runs, that side effect
// has ALREADY happened once, in THIS process. T4b (below) therefore observes it a SECOND time, in
// a freshly spawned CHILD process that has not yet required the module -- seeing the require's
// effect fresh is the point, and a child process is how this file gets a fresh one without
// skipping its own killswitch requirement. test/no-real-spawn-guard.test.js's T2 needs something
// different again: a genuinely pristine `child_process.execFileSync` for its OWN in-process revoke
// baseline (T1/T2 there probe through `execFileSync`, not `spawnSync`, precisely because
// test/no-real-spawn.js's own patch never touches `execFileSync` -- no save/restore of anything is
// needed or used there; see that file's header for the reasoning). The two files' constraints
// still don't compose into one file: THIS file's own top-of-file killswitch require would make
// T4b's "observe the require fresh" impossible if it lived in the same file as T1/T2/T3, which is
// reason enough on its own for two small files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident and test/no-real-spawn-sweep.test.js
// for why this require has to land, at column 0, before the orchestrator require below. Its
// require-time side effect (setting process.env[SPO_NO_REAL_SPAWN]) has therefore already fired
// in THIS process before T4b runs -- see this file's header for why T4b re-observes it fresh, in a
// spawned child, instead of relying on that.
require('./no-real-spawn');

const { SPO_NO_REAL_SPAWN } = require('../orchestrator/no-real-spawn-guard');
const { isolatedEnv, mkTmp, REPO_ROOT } = require('./helpers');

// Builds a probe script for a FRESH child process (one that has never required
// test/no-real-spawn.js): reads the var, requires the killswitch by its real path, reads the var
// again, then spawns its OWN grandchild -- with NO explicit `env:` override, exactly dispatcher.js's
// own worker/scanner spawn() shape (`child_process.spawn(process.execPath, [...], { detached:
// true, stdio: 'ignore' })`, no `env:` key at all) -- to prove the value crosses a REAL OS process
// boundary by inheritance, not just this child's own in-memory process.env object. All three
// readings come back as one JSON line on stdout.
function buildEnvProbeScript(noRealSpawnPath, envVarName) {
  const varLit = JSON.stringify(envVarName);
  const grandchildCode = `process.stdout.write(process.env[${varLit}] || '')`;
  return [
    "'use strict';",
    "const cp = require('child_process');",
    `const before = process.env[${varLit}] || '';`,
    `require(${JSON.stringify(noRealSpawnPath)});`,
    `const after = process.env[${varLit}] || '';`,
    `const grandchild = cp.execFileSync(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { encoding: 'utf8', timeout: 10000 });`,
    'process.stdout.write(JSON.stringify({ before: before, after: after, grandchild: grandchild }));',
  ].join('\n');
}

test('T4a: isolatedEnv() sets SPO_NO_REAL_SPAWN explicitly, not merely by inheriting process.env', () => {
  // Explicitly clear it on process.env first: proves isolatedEnv()'s return value carries the var
  // on its OWN merits (test/helpers.js's own [SPO_NO_REAL_SPAWN]: '1' line), not because it
  // happened to already be set in this process's environment when isolatedEnv() ran.
  const had = Object.prototype.hasOwnProperty.call(process.env, SPO_NO_REAL_SPAWN);
  const prior = process.env[SPO_NO_REAL_SPAWN];
  delete process.env[SPO_NO_REAL_SPAWN];
  try {
    const env = isolatedEnv();
    assert.equal(env[SPO_NO_REAL_SPAWN], '1');
  } finally {
    if (had) process.env[SPO_NO_REAL_SPAWN] = prior;
  }
});

test('T4b: requiring test/no-real-spawn.js sets SPO_NO_REAL_SPAWN on process.env, observed fresh in a child that has not required it yet, and inherited by ITS OWN grandchild', () => {
  // This file's own top-of-file `require('./no-real-spawn')` already fired before this test ran
  // (see this file's header) -- so re-requiring it HERE would be a cached no-op, not a fresh
  // observation of the side effect. Spawn a genuinely fresh node process instead, one that has
  // never required the module, and have IT do the before/require/after/grandchild sequence.
  const probeDir = mkTmp('spo-norealspawn-env-probe-');
  const probePath = path.join(probeDir, 'probe.js');
  const noRealSpawnPath = path.join(REPO_ROOT, 'test', 'no-real-spawn.js');
  fs.writeFileSync(probePath, buildEnvProbeScript(noRealSpawnPath, SPO_NO_REAL_SPAWN));

  // The probe's own starting env must not already carry the var (otherwise "before" would be a
  // false negative) -- strip it from what this child inherits, independent of whether THIS
  // process's own process.env happens to have it (it does, from the top-of-file require above).
  const env = { ...process.env };
  delete env[SPO_NO_REAL_SPAWN];

  const out = execFileSync(process.execPath, [probePath], { encoding: 'utf8', timeout: 10000, env });
  const { before, after, grandchild } = JSON.parse(out);

  assert.equal(before, '', `expected the fresh child to see no inherited value before requiring the killswitch; got ${JSON.stringify(before)}`);
  assert.equal(after, '1', `expected requiring test/no-real-spawn.js to set the var to '1' in that same process; got ${JSON.stringify(after)}`);
  assert.equal(
    grandchild,
    '1',
    `expected a grandchild spawned with NO explicit env override to inherit '1' too; got ${JSON.stringify(grandchild)}`
  );
});
