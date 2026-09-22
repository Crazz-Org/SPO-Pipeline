'use strict';
// Pins two properties of llm.js's dry-run-branch placeholder for an unresolved `claude` that
// survived the fix pass on card #239's dry-run CI fix (CI run 35620555644) unpinned by any
// existing test -- both measured true at HEAD, both surviving mutation of the full suite before
// this file existed:
//
//   M1 -- DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER is deliberately not a real-looking path (no
//     leading `/`), so an artifact reader or a future citation grep can never mistake it for
//     something the pipeline actually resolved. Mutating the constant to a real-looking path
//     (e.g. '/usr/local/bin/claude') left the suite green before this file existed.
//
//   M4 -- the dry-run artifact surfaces a REAL misconfiguration (no `claude` on PATH) rather than
//     masking it: with `claude` resolvable, the artifact shows the real resolved absolute path;
//     with it unresolvable, the artifact shows the placeholder verbatim. Mutating the wrapper to
//     ALWAYS return the placeholder (never the real path) survived on both PATHs before this file
//     existed -- that is the entire justification for the design and it was unpinned.
//
// Both are exercised through the real daemon --dry-run --once path (test/dry-run-demo.test.js's
// own harness), not a hand-built ctx: the property under test is what buildQueryOptions's real,
// non-injected PATH walk (sdk.js's resolveClaudeCodeExecutable, driven by `deps` -- no test here
// injects deps.resolveClaudeCodeExecutable, see llm.js's dry-run branch) actually writes into
// `dryrun-PLAN.md`, and a hand-built ctx calling runLlm directly would have to inject that same
// deps to reach the card path at all, which is exactly the branch these tests must NOT take.
//
// PATH is controlled per-run rather than relying on this machine's ambient PATH, so both tests
// pass identically here and on a CI runner that has no `claude` anywhere (the exact runner class
// card #239's dry-run fix pass was about) -- the "claude present" run is via a FAKE executable
// dropped into a throwaway bin dir prepended to a `claude`-free base PATH, never the real
// installed binary, and the "claude absent" run uses `/usr/bin:/bin` (this repo's own documented
// CI-reproduction PATH: node/npm/git live there, `claude` does not -- see llm.js's own header on
// the dry-run branch and this action's own measurement notes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident this closes, and why this require
// has to land before the orchestrator require(s) below.
require('./no-real-spawn');

const { mkTmp, writeTask, isolatedEnv, DAEMON, readState } = require('./helpers');
const { DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER } = require('../orchestrator/steps/llm');

// `/usr/bin:/bin` is this repo's own documented CI-reproduction PATH (llm.js's dry-run-branch
// header, this fix pass): node/npm/git live there, `claude` never does, on this machine or on
// GitHub's runner.
const CI_LIKE_PATH_NO_CLAUDE = '/usr/bin:/bin';

// Drops a throwaway, deterministic fake `claude` executable into its own bin dir -- never the
// real installed binary, so this test is identical on a laptop with `claude` on PATH and on a CI
// runner with none at all. Only needs to exist and be executable: resolveClaudeCodeExecutable
// (sdk.js) only statSync/accessSync(X_OK)s candidates, it never runs them (see that function's
// own header).
function fakeClaudeBinDir() {
  const bin = mkTmp('spo-dryrun-fakeclaude-bin-');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  return bin;
}

function runDaemonDryRunWithEnv(queueDir, journalDir, envOverrides) {
  const env = { ...isolatedEnv(), ...envOverrides };
  return execFileSync(process.execPath, [DAEMON, '--dry-run', '--once', '--queue', queueDir, '--journal', journalDir], {
    encoding: 'utf8',
    env,
  });
}

function writeMinimalCardTask(queueDir, id) {
  const worktreePath = mkTmp('spo-dryrun-worktree-');
  writeTask(queueDir, '001-card.json', {
    id,
    title: 'Add a status badge to the header',
    kind: 'card',
    issue: 123,
    criterion: 'the header shows a status badge reflecting connection state',
    worktreePath,
    size: 'S',
    touchesRdoMembers: false,
  });
}

function readDryRunArtifactOptions(journalDir, id, stepName) {
  const file = path.join(journalDir, id, `dryrun-${stepName}.md`);
  const body = fs.readFileSync(file, 'utf8');
  const match = body.match(/## query\(\) options\n```json\n([\s\S]*?)\n```/);
  assert.ok(match, `expected a '## query() options' JSON block in ${file}`);
  return JSON.parse(match[1]);
}

test('M1: DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER is never a real-looking path', () => {
  // The property itself, pinned directly against the exported constant -- no PATH/subprocess
  // needed for this half. A real-looking replacement (e.g. '/usr/local/bin/claude') would pass
  // every existing assertion in the suite before this test existed; this is the guard.
  assert.equal(typeof DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER, 'string');
  assert.ok(
    !DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER.startsWith('/'),
    `placeholder must not start with '/' (a real-looking absolute path), got ${JSON.stringify(DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER)}`
  );
});

test('M1: the placeholder actually written into a dry-run artifact (no claude on PATH) is that exact, not-real-looking string', () => {
  const queueDir = mkTmp('spo-queue-dryrun-m1-');
  const journalDir = mkTmp('spo-journal-dryrun-m1-');
  const id = 'card-dryrun-m1';
  writeMinimalCardTask(queueDir, id);

  const out = runDaemonDryRunWithEnv(queueDir, journalDir, { PATH: CI_LIKE_PATH_NO_CLAUDE });
  assert.match(out, new RegExp(`${id}\\s+DONE`));
  assert.equal(readState(journalDir, id).state, 'DONE');

  const options = readDryRunArtifactOptions(journalDir, id, 'PLAN');
  assert.equal(options.pathToClaudeCodeExecutable, DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER);
  assert.ok(!options.pathToClaudeCodeExecutable.startsWith('/'));
});

test('M4: the dry-run artifact shows the real resolved path when claude IS on PATH, and the placeholder verbatim when it is NOT', () => {
  const fakeBin = fakeClaudeBinDir();
  const realClaudePath = path.join(fakeBin, 'claude');

  // ---- claude present ----
  const queueDirPresent = mkTmp('spo-queue-dryrun-m4-present-');
  const journalDirPresent = mkTmp('spo-journal-dryrun-m4-present-');
  const idPresent = 'card-dryrun-m4-present';
  writeMinimalCardTask(queueDirPresent, idPresent);

  const outPresent = runDaemonDryRunWithEnv(queueDirPresent, journalDirPresent, {
    PATH: `${fakeBin}:${CI_LIKE_PATH_NO_CLAUDE}`,
  });
  assert.match(outPresent, new RegExp(`${idPresent}\\s+DONE`));

  const optionsPresent = readDryRunArtifactOptions(journalDirPresent, idPresent, 'PLAN');
  assert.equal(optionsPresent.pathToClaudeCodeExecutable, realClaudePath);
  assert.notEqual(optionsPresent.pathToClaudeCodeExecutable, DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER);

  // ---- claude absent ----
  const queueDirAbsent = mkTmp('spo-queue-dryrun-m4-absent-');
  const journalDirAbsent = mkTmp('spo-journal-dryrun-m4-absent-');
  const idAbsent = 'card-dryrun-m4-absent';
  writeMinimalCardTask(queueDirAbsent, idAbsent);

  const outAbsent = runDaemonDryRunWithEnv(queueDirAbsent, journalDirAbsent, { PATH: CI_LIKE_PATH_NO_CLAUDE });
  assert.match(outAbsent, new RegExp(`${idAbsent}\\s+DONE`));

  const optionsAbsent = readDryRunArtifactOptions(journalDirAbsent, idAbsent, 'PLAN');
  assert.equal(optionsAbsent.pathToClaudeCodeExecutable, DRY_RUN_CLAUDE_UNRESOLVED_PLACEHOLDER);
  assert.notEqual(optionsAbsent.pathToClaudeCodeExecutable, realClaudePath);
});
