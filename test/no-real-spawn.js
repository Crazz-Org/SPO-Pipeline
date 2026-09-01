'use strict';
// no-real-spawn.js -- the repo-wide killswitch against a real, in-process child_process.spawnSync
// reaching git/gh/npm/claude with live pool credentials from inside this test suite.
//
// ---- the incident this exists to close --------------------------------------------------------
//
// First written file-locally, in test/transient-retry.test.js, after that file's first cut called
// finalizePark in REAL mode for its ordinary-park cases with no injected deps at all. `deps` then
// defaults to `{}` (state-machine.js's buildCtx), command-timeout.js's armTimeout falls back to
// the real `spawnSync`, and park-loop.js's postParkComment ran an actual `gh issue comment 1
// --repo Crazz-Org/SPO-WebClient --body-file <park-comment.md>` with the pool's live credentials.
// It did not fail closed: issue #1 of the real SPO-WebClient collected 140 fabricated "Pipeline
// parked" comments in one hour of running this suite -- four per `node --test test/*.test.js`,
// times every mutation-testing round. test/helpers.js's isolatedEnv() does not cover this: that
// isolates `spo`/daemon SUBPROCESSES only (execFileSync against throwaway tmp dirs), and this
// class of bug spawns entirely in-process, inside the same node:test worker.
//
// A repo-wide measurement (plan action 5.0) re-ran the whole suite under a probe that logs every
// real in-process spawnSync and blocks git/gh/npm. Result: with those 5 remaining real spawns
// blocked (2 files -- test/command-timeout.test.js, test/real-steps.test.js -- see their own
// fixes), all 1032 tests still passed. Not one of them was load-bearing; this module, plus the
// fixes at those call sites, plus test/no-real-spawn-sweep.test.js's standing guard, close the
// whole class rather than the one file transient-retry.test.js originally closed for itself.
//
// ---- placement: why requiring this module IS installing the guard ------------------------------
//
// Several orchestrator modules -- notably orchestrator/command-timeout.js -- DESTRUCTURE
// spawnSync off child_process at require time:
//     const { spawnSync } = require('child_process');
// Once that destructuring has run, the local `spawnSync` binding inside that module is a fixed
// reference to whatever `child_process.spawnSync` WAS at that moment. Patching
// `child_process.spawnSync` afterwards has no effect on code that already captured the old
// reference. So the patch below has to land on the child_process module object before ANY
// orchestrator module is first required in a test file -- not merely before the vulnerable call
// site is reached at runtime. That is why this module applies the patch as a side effect of being
// required (the same "first executable statement" placement transient-retry.test.js used, just
// shared): `require('./no-real-spawn')` at the top of a test file, before its first
// `require('../orchestrator/...')`, is both necessary and sufficient. This is also exactly what
// test/no-real-spawn-sweep.test.js checks textually across every file in test/.
//
// ---- per-file, not global ------------------------------------------------------------------
//
// node:test runs each test FILE in its own child process, so this patch is applied once per file
// and can never leak into (or be relied on by) any other file's process. A file that never
// requires this module gets no protection at all -- that gap is exactly what
// test/no-real-spawn-sweep.test.js exists to catch, file by file, forever.
//
// ---- scope: spawnSync only --------------------------------------------------------------------
//
// Deliberately does NOT touch execFileSync / execSync / the async spawn(): test/helpers.js
// legitimately uses execFileSync to run the `spo` CLI and orchestrator/daemon.js as real
// SUBPROCESSES against throwaway fs.mkdtempSync(os.tmpdir()) queue/journal/product-repo
// directories (see helpers.js's isolatedEnv() and runDaemonOnce/runDaemonDryRun/runSpo) -- that
// is the suite's one sanctioned real-process boundary, already isolated by construction, and
// patching execFileSync here would break every file that (correctly) uses it. Nothing under
// orchestrator/ spawns via the async spawn() or execSync today; if that ever changes, extend this
// module rather than adding a second, differently-shaped guard elsewhere.

const cp = require('child_process');

function installNoRealSpawn() {
  cp.spawnSync = (command, args) => {
    throw new Error(
      `no-real-spawn: a test reached the REAL child_process.spawnSync -- ${command} ${JSON.stringify(args || [])}. ` +
        "Inject deps.spawnSync at the call site instead (see test/park-loop.test.js's " +
        '`const deps = { spawnSync: (command, args, opts) => {...} }` convention); this suite must ' +
        'never touch a real git/gh/npm/claude process.'
    );
  };
}

// No escape hatch is exported on purpose. Action 5.0's measurement ran the whole suite under a
// probe and found ZERO tests that legitimately need a real spawnSync -- so an `allowRealSpawn`
// would be dead code sitting in a safety guard, and the first version of it was also subtly
// wrong (it captured `cp.spawnSync` AFTER this module had already replaced it, so the "real"
// function it forwarded to was the thrower itself). If a genuine need ever appears, add it then,
// with a test that proves a permitted call actually reaches the real process.

// Installed as a side effect of require() -- see "why requiring this module IS installing the
// guard" above. Also exported so a file can re-arm it explicitly (idempotent), or for a test
// that wants to assert on the installed function directly.
installNoRealSpawn();

module.exports = { installNoRealSpawn };
