'use strict';
// Cross-repo pin for action B3.4's regression 2 (round 2 fix): the exit-2/3 sub-cause routing in
// steps/scripted.js's realGate matches literal diagnostic TEXT printed by SPO-WebClient's own
// scripts/CLI, a deliberate, documented exception to Principle 1 ("exit codes are the contract")
// -- see that principle's own paragraph in doc/state-machine-spec.md and steps/scripted.js's own
// header comment on the exit-2/3 block for why. The reasoning for the exception is sound, but the
// matched strings live in a DIFFERENT repository: nothing in test/doc-constant-sweep.test.js (or
// anywhere else in this suite) reads SPO-WebClient at all, so a maintainer rewording "NOT PUSHED"
// or "WORKER DOWN" over there reverts routing to the pre-B3.4 collapse (gate-dirty-tree /
// gate-worker-down) silently, with every test in THIS repo staying green. That is exactly the
// defect class this chantier exists to remove, and it has already bitten twice here (a doc
// promise that outlived its check, a citation ratchet resolved against a stale copy) -- this file
// is the fix, modelled directly on test/doc-constant-sweep.test.js's own PINS/offenders shape.
//
// Resolution reads config.productRepo's OWN git index (`git -C <productRepo> ls-files`), which is
// the single production-configured product repo (default `~/SPO-WebClient`, `SPO_PRODUCT_REPO`
// overridable -- orchestrator/config.js) -- never a bare basename search (doc-constant-sweep's
// own `findByBasename` is deliberately not reused here: a basename hit in a 500+-file tree can be
// the wrong file of the same name) and never one of the many OTHER SPO-WebClient checkouts this
// machine keeps for unrelated purposes (`.claude/worktrees/<slug>` card checkouts, FINISH's
// `/tmp/spo-finish-main-*` scratch clones), which can be mid-edit, on the wrong branch, or simply
// stale relative to the tree this pipeline actually gates against. Every pin below cites a FULL
// path (`scripts/bench-gate.sh`, never a bare `bench-gate.sh`); `readTrackedFile` asks
// `git ls-files` for exactly that path and requires exactly one, exact match, so a citation can
// never silently resolve to the wrong file.
//
// If config.productRepo is not present on disk at all, this test FAILS LOUDLY rather than
// skipping -- the one posture that matters here, since a missing product repo is exactly the
// condition under which nobody would otherwise notice these pins going unchecked. Same posture as
// the rest of this suite's product-repo-dependent coverage (test/product-repo-lock.test.js) and
// doc-constant-sweep.test.js's own citation ratchet: silence on an absent target is never allowed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// Strips the inherited GIT_* env from every real `git` spawn below -- see helpers.js's gitEnv
// for the incident that makes this load-bearing rather than tidy.
const { gitEnv } = require('./helpers');

// Repo-wide guard, required before the first orchestrator require -- see test/no-real-spawn.js's
// own header and test/no-real-spawn-sweep.test.js, which checks this ordering textually across
// every file in test/. Only patches spawnSync, so the execFileSync('git', ...) reads below (this
// file's one sanctioned real-process boundary, read-only `git ls-files`/`git -C` against the
// PRODUCT repo, never this pipeline's own orchestrator paths) are unaffected.
require('./no-real-spawn');

const config = require('../orchestrator/config');
const PRODUCT_REPO = config.productRepo;

function productRepoIsAGitCheckout() {
  try {
    const gitPath = path.join(PRODUCT_REPO, '.git');
    fs.statSync(gitPath); // a worktree's `.git` is a FILE, a normal clone's is a DIRECTORY -- either is fine
    return true;
  } catch {
    return false;
  }
}

// Reads exactly one file, tracked under exactly the cited path, off the product repo's own git
// index -- never a recursive/basename search. Throws (fails the test loudly) if `git ls-files`
// does not resolve the path to itself exactly once: renamed, moved, or deleted all fail here, by
// design, the same as a literal no longer being `contains`ed below.
function readTrackedFile(relPath) {
  const out = execFileSync('git', ['-C', PRODUCT_REPO, 'ls-files', '--', relPath], { encoding: 'utf8', env: gitEnv() });
  const tracked = out.split('\n').filter(Boolean);
  assert.equal(
    tracked.length,
    1,
    `expected exactly one file tracked at "${relPath}" in ${PRODUCT_REPO} (a full path, cited ` +
      `verbatim, never a bare basename); git ls-files returned: ${JSON.stringify(tracked)}`
  );
  assert.equal(tracked[0], relPath, `git ls-files resolved "${relPath}" to a different path: ${tracked[0]}`);
  return fs.readFileSync(path.join(PRODUCT_REPO, relPath), 'utf8');
}

// ---- pins: one row per literal steps/scripted.js's realGate matches against SPO-WebClient's own
// printed text, plus the one stdout marker parseGateJobId depends on (same repo, same hazard) ----
//
// Each `contains` was copied from a real read of the cited SPO-WebClient file on 2026-09-03 (repo
// state `0b5b5687` there), independent of the regex in scripted.js -- see
// test/doc-constant-sweep.test.js's own header for why a re-derived expectation pins nothing.
const PINS = [
  {
    name: 'exit 2, NOT PUSHED -> gate-not-pushed (scripted.js: /NOT PUSHED/)',
    file: 'SPO-WebClient/scripts/bench-gate.sh',
    contains: 'NOT PUSHED',
  },
  {
    name: 'exit 2, DIRTY TREE fallback -> gate-dirty-tree, unchanged (scripted.js comment)',
    file: 'SPO-WebClient/scripts/bench-gate.sh',
    contains: 'DIRTY TREE',
  },
  {
    name: 'exit 2, duplicate deposit -> gate-duplicate-job (scripted.js: /already has job/)',
    file: 'SPO-WebClient/src/e2e/bench/job.ts',
    contains: 'already has job',
  },
  {
    name: 'exit 3, bench client not built -> gate-worker-not-built (scripted.js: /bench client not built/)',
    file: 'SPO-WebClient/scripts/bench-submit.sh',
    contains: 'bench client not built',
  },
  {
    name: 'exit 3, WORKER DIED -> gate-worker-died-midjob (scripted.js: /WORKER DIED/)',
    file: 'SPO-WebClient/src/e2e/bench/cli.ts',
    contains: 'WORKER DIED',
  },
  {
    name: 'exit 3, WORKER DOWN fallback -> gate-worker-down, unchanged (scripted.js comment)',
    file: 'SPO-WebClient/src/e2e/bench/cli.ts',
    contains: 'WORKER DOWN',
  },
  {
    name: "exit 1, job-deposited stdout marker -- parseGateJobId's own anchor (/(?:^|\\n)job (\\S+) queued/)",
    file: 'SPO-WebClient/src/e2e/bench/cli.ts',
    contains: 'queued (',
  },
];

test('every stderr/stdout literal realGate matches for GATE exit 2/3/1-job-id routing still exists in the real SPO-WebClient tree', () => {
  assert.ok(
    productRepoIsAGitCheckout(),
    `config.productRepo (${PRODUCT_REPO}) is not present as a git checkout on this machine -- ` +
      `this sweep cannot verify the pinned literals and MUST fail loudly rather than pass ` +
      `silently, since a missing product repo is exactly the condition under which nobody would ` +
      `otherwise notice these pins going unchecked. Set SPO_PRODUCT_REPO or restore the checkout.`
  );

  const offenders = [];
  for (const pin of PINS) {
    const relPath = pin.file.replace(/^SPO-WebClient\//, '');
    const source = readTrackedFile(relPath);
    if (!source.includes(pin.contains)) {
      offenders.push(`${pin.name} -- ${pin.file} no longer contains:\n      ${JSON.stringify(pin.contains)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `A literal realGate's exit-2/3 (and job-id) routing depends on has changed wording in ` +
      `SPO-WebClient -- routing has silently reverted to its collapsed pre-B3.4 fallback for the ` +
      `affected case(s):\n  ${offenders.join('\n  ')}`
  );
});

// Guards the sweep itself going blind the same way doc-constant-sweep.test.js's own PINS.length
// floor does: a mutation that deletes rows from PINS must not leave this file green while
// checking fewer facts than it claims to.
test('PINS covers every literal this sweep exists to pin -- not silently shrunk', () => {
  assert.equal(PINS.length, 7, `expected exactly 7 pinned literals, found ${PINS.length}`);
  assert.deepEqual(
    PINS.map((p) => p.name).sort(),
    [
      "exit 1, job-deposited stdout marker -- parseGateJobId's own anchor (/(?:^|\\n)job (\\S+) queued/)",
      'exit 2, DIRTY TREE fallback -> gate-dirty-tree, unchanged (scripted.js comment)',
      'exit 2, NOT PUSHED -> gate-not-pushed (scripted.js: /NOT PUSHED/)',
      'exit 2, duplicate deposit -> gate-duplicate-job (scripted.js: /already has job/)',
      'exit 3, WORKER DIED -> gate-worker-died-midjob (scripted.js: /WORKER DIED/)',
      'exit 3, WORKER DOWN fallback -> gate-worker-down, unchanged (scripted.js comment)',
      'exit 3, bench client not built -> gate-worker-not-built (scripted.js: /bench client not built/)',
    ].sort(),
    'PINS lost or gained a row -- update this pin in the same change as any deliberate addition/removal.'
  );
});

test('readTrackedFile rejects a cited path that git ls-files does not resolve exactly (renamed/moved/deleted)', () => {
  assert.ok(productRepoIsAGitCheckout(), `config.productRepo (${PRODUCT_REPO}) must be present for this test`);
  assert.throws(() => readTrackedFile('scripts/this-file-does-not-exist-b34.sh'), assert.AssertionError);
});
