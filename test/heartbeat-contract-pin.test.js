'use strict';
// Action B5.3: SPO-WebClient's src/e2e/bench/paths.ts and this repo's console/collect.js used to
// read ~/.spo-bench/heartbeat under two DIFFERENT contracts -- the product by mtime with a 20s
// bound, this repo by content with an unrelated, hardcoded 120s bound. See
// orchestrator/bench-heartbeat.js's own header for the chosen contract (content, 20s) and why.
//
// The bound (HEARTBEAT_STALE_MS) is now a single VALUE duplicated across a repo boundary this
// codebase cannot `require()`/`import` across. Modelled directly on test/doc-constant-sweep.
// test.js's house pattern -- a LITERAL string, typed independently of the code it checks, read
// from SOURCE TEXT rather than re-derived from the value under test (see that file's own header
// for the two real incidents that made re-derivation from a live value the mistake to avoid).
//
// The one addition this file makes to that pattern: the "doc" half is a FILE IN ANOTHER
// REPOSITORY, so it is read from the real product tree (SPO_PRODUCT_REPO, defaulting to
// ~/SPO-WebClient -- the exact convention orchestrator/config.js's own productRepo already
// uses) rather than from a doc committed here. `git ls-files --error-unmatch` confirms the path
// is actually tracked before reading it, so a typo'd relative path fails loudly instead of
// silently reading nothing (ENOENT) or, worse, stray untracked content.
//
// What is deliberately NOT pinned here: the mtime-vs-content DECISION itself. That is not a
// duplicated literal -- collect.js has always read the heartbeat by content (this action didn't
// change that side), and the product's own switch from mtime to content is a property of ITS
// OWN function body, proved by paths.test.ts's two divergence cases in that repo, not by a
// cross-repo text match here. Only the NUMBER that both sides restate is this file's job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Killswitch first, textually, before the orchestrator require below -- see test/no-real-spawn.js's
// own header and test/no-real-spawn-sweep.test.js's standing guard over this exact ordering rule.
require('./no-real-spawn');

const bench = require('../orchestrator/bench-heartbeat');

function productRepoRoot() {
  return process.env.SPO_PRODUCT_REPO || path.join(os.homedir(), 'SPO-WebClient');
}

// Reads one file from the product repo's WORKING TREE, after confirming with `git ls-files` that
// the path is actually tracked there. Deliberately the working tree, not `git show HEAD:...`: a
// product worktree with this very action's own change staged (as during development, before the
// product PR merges) is what this pin is meant to catch drift against, not a possibly-stale HEAD.
function readTrackedProductFile(relPath) {
  const root = productRepoRoot();
  let tracked;
  try {
    tracked = execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', relPath], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(
      `${relPath} is not a tracked file in the product repo at ${root} (set SPO_PRODUCT_REPO to point ` +
        `at a different checkout) -- ${err.message}`
    );
  }
  assert.equal(tracked, relPath, 'git ls-files must resolve to exactly the path asked for, not a near match');
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

test('HEARTBEAT_STALE_MS: this repo\'s copy is pinned to SPO-WebClient/src/e2e/bench/paths.ts\'s literal -- diverge and this reds', () => {
  const productSrc = readTrackedProductFile('src/e2e/bench/paths.ts');
  assert.match(
    productSrc,
    /export const HEARTBEAT_STALE_MS = 20_000;/,
    "the product's own HEARTBEAT_STALE_MS literal moved -- update orchestrator/bench-heartbeat.js's " +
      'copy (and this regex) to match, by hand; this test cannot do that for you, on purpose'
  );
  // Not `require`'d back from bench-heartbeat.js's own live value for the comparison above --
  // that would pin nothing (see this file's header). This second assertion is the actual pin:
  // this repo's copy, read from ITS OWN source of truth, must equal the number just confirmed.
  assert.equal(
    bench.HEARTBEAT_STALE_MS,
    20_000,
    "orchestrator/bench-heartbeat.js's HEARTBEAT_STALE_MS must equal the product literal just confirmed above"
  );
});

test('console/collect.js uses the shared HEARTBEAT_STALE_MS bound, not a re-hardcoded literal', () => {
  const collectSrc = fs.readFileSync(path.join(__dirname, '..', 'console', 'collect.js'), 'utf8');
  assert.match(
    collectSrc,
    /require\(['"]\.\.\/orchestrator\/bench-heartbeat['"]\)/,
    'collect.js must import the shared contract module, not restate the bound itself'
  );
  assert.match(collectSrc, /age < HEARTBEAT_STALE_MS/, 'the staleness comparison must use the shared constant');
  assert.doesNotMatch(
    collectSrc,
    /\b120000\b/,
    "the old, wrong 120s bound must be gone -- it was the contract's actual bug, not a harmless leftover"
  );
});

test('console/collect.js still reads the heartbeat by CONTENT, never by mtime -- same-repo check, no product read needed', () => {
  const collectSrc = fs.readFileSync(path.join(__dirname, '..', 'console', 'collect.js'), 'utf8');
  assert.doesNotMatch(
    collectSrc,
    /heartbeatFile\)\s*\.\s*mtimeMs|statSync\(heartbeatFile\)/,
    "collect.js must not switch to reading the heartbeat file's mtime"
  );
  const heartbeatSrc = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'bench-heartbeat.js'), 'utf8');
  assert.doesNotMatch(heartbeatSrc, /mtimeMs/, 'bench-heartbeat.js must not read the heartbeat file by mtime either');
  assert.match(heartbeatSrc, /readFileSync/, "bench-heartbeat.js must read the heartbeat file's content");
});
