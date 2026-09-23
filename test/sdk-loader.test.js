'use strict';
// sdk-loader.test.js -- pins for orchestrator/sdk.js (card #239 chantier, action A1). The loader
// is the single place this repo reaches the vendored Agent SDK, so what has to hold is narrower
// than "the SDK works": (1) the vendored file is really on disk where the loader says it is, and
// that location does not depend on the caller's cwd; (2) the version pin in orchestrator/sdk.js
// matches what vendor/claude-agent-sdk/package.json actually ships (the test a dropped-in newer
// sdk.mjs and a forgotten pin bump is designed to fail); (3) loading it parses the 1.5 MB file
// exactly once no matter how many callers race for it, which requires `loadSdk` to return the
// SAME promise object, not merely an equivalent one; (4) loading it never reaches `node_modules`,
// never needs `npm install` to have run, and never needs `claude` on PATH; and (5) `query()` has
// NO PATH fallback of its own -- every future call site MUST supply `pathToClaudeCodeExecutable`
// explicitly, which is why orchestrator/sdk.js exports a PATH-walking helper for that and this
// file pins it. See orchestrator/sdk.js's own header for the measurements behind each of these.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { REPO_ROOT, mkTmp } = require('./helpers');
const SDK_MODULE_PATH = require.resolve('../orchestrator/sdk');
// Repo-wide killswitch, required before any orchestrator/* module -- see test/no-real-spawn.js's
// own header for the incident (140 fabricated comments on a live SPO-WebClient issue) and
// test/no-real-spawn-sweep.test.js, which fails any test file that gets this order wrong.
// orchestrator/sdk.js itself never spawns anything (it does a plain import() of a local file), but
// the sweep's rule is unconditional by design: it protects every orchestrator require, not only
// the ones that spawn TODAY.
require('./no-real-spawn');
const sdkLoader = require('../orchestrator/sdk');

// FIRST test, deliberately: the one assertion that separates a promise CACHE from a value cache.
// `loadSdk` is not `async` precisely so that two calls return the identical Promise object with
// no `await` on either side -- an `async function` always wraps its return in a fresh Promise on
// every call, so if this regressed back to `async function loadSdk()`, `first === second` would
// be false here even though both promises resolve to the same thing. Placed before any other test
// touches `loadSdk`, so there is no warm cache from a prior call to hide behind.
test('loadSdk() returns the identical Promise object on back-to-back calls, with no await', () => {
  const first = sdkLoader.loadSdk();
  const second = sdkLoader.loadSdk();
  assert.equal(first, second, 'loadSdk() must return the SAME promise, not merely an equivalent one');
});

test('VENDOR_SDK_PATH points at the real vendored file, built from __dirname', () => {
  assert.equal(
    sdkLoader.VENDOR_SDK_PATH,
    path.join(REPO_ROOT, 'vendor', 'claude-agent-sdk', 'sdk.mjs'),
  );
  assert.ok(fs.existsSync(sdkLoader.VENDOR_SDK_PATH), 'vendored sdk.mjs must exist on disk');
  assert.ok(
    fs.statSync(sdkLoader.VENDOR_SDK_PATH).size > 0,
    'vendored sdk.mjs must be non-empty',
  );
});

// cwd-independence, pinned for real: the previous version of this test only re-derived
// `path.join(REPO_ROOT, ...)` a second time in THIS file, which is trivially equal regardless of
// where VENDOR_SDK_PATH's own `__dirname` join happens to point -- it would pass identically even
// if orchestrator/sdk.js built the path from `process.cwd()` instead, since this test file's own
// cwd never changes on its own. The actual pin: chdir to a throwaway directory, bust the require
// cache so orchestrator/sdk.js re-evaluates its top-level `path.join(__dirname, ...)` from that
// new cwd, and check the fresh module still resolves to the SAME absolute path.
test('VENDOR_SDK_PATH is independent of process.cwd() -- rebuilt fresh from a different cwd', () => {
  const originalCwd = process.cwd();
  const tmpDir = mkTmp('sdk-cwd-probe-');
  delete require.cache[SDK_MODULE_PATH];
  try {
    process.chdir(tmpDir);
    const freshSdkLoader = require('../orchestrator/sdk');
    assert.equal(
      freshSdkLoader.VENDOR_SDK_PATH,
      path.join(REPO_ROOT, 'vendor', 'claude-agent-sdk', 'sdk.mjs'),
      'VENDOR_SDK_PATH must resolve the same way regardless of process.cwd() at require time',
    );
  } finally {
    process.chdir(originalCwd);
    delete require.cache[SDK_MODULE_PATH];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// The pin itself: orchestrator/sdk.js's two literal constants must equal what the vendored
// package's OWN manifest says, read as a text file (never re-derived from the constants under
// test -- see test/test-comment-citation-sweep.test.js's sibling files for why a pin that
// recomputes its expectation from the code it is pinning proves nothing).
test('VENDORED_SDK_VERSION / VENDORED_CLAUDE_CODE_VERSION match vendor/claude-agent-sdk/package.json', () => {
  const manifestPath = path.join(REPO_ROOT, 'vendor', 'claude-agent-sdk', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(
    sdkLoader.VENDORED_SDK_VERSION,
    manifest.version,
    'orchestrator/sdk.js VENDORED_SDK_VERSION is out of sync with the vendored package.json ' +
      '"version" -- bump both in the same change that replaces sdk.mjs',
  );
  assert.equal(
    sdkLoader.VENDORED_CLAUDE_CODE_VERSION,
    manifest.claudeCodeVersion,
    'orchestrator/sdk.js VENDORED_CLAUDE_CODE_VERSION is out of sync with the vendored ' +
      'package.json "claudeCodeVersion" -- bump both in the same change that replaces sdk.mjs',
  );
});

test('loadQuery() resolves to a function', async () => {
  const query = await sdkLoader.loadQuery();
  assert.equal(typeof query, 'function');
});

// Node's own ESM module cache would already guarantee this for two import()s of the identical
// resolved URL, but the point of caching the PROMISE in orchestrator/sdk.js (see its header) is
// that the guarantee holds even when two callers race before the first import() has settled --
// which is the case this identity check, on its own, cannot distinguish from "Node did it for
// free." Promise.all below is what actually exercises the race.
test('loadSdk() returns the identical namespace object across concurrent and sequential calls', async () => {
  const [first, second] = await Promise.all([sdkLoader.loadSdk(), sdkLoader.loadSdk()]);
  assert.equal(first, second, 'concurrent loadSdk() calls must share one in-flight import');

  const third = await sdkLoader.loadSdk();
  assert.equal(first, third, 'a later loadSdk() call must return the same cached namespace');
});

// Dependency-freedom pin: loading the SDK must not have installed, required, or otherwise
// materialized anything under node_modules/, and must not have created a package.json or
// package-lock.json at the repo root -- this repo's whole determinism story
// (scripts/gate.sh's header, .github/workflows/gate.yml:9-12) is that none of those exist. Placed
// AFTER the loadSdk()/loadQuery() calls above, deliberately, so it also proves those calls
// themselves cannot have created any of this.
test('loading the SDK creates no package.json, no package-lock.json, and no node_modules anywhere in the repo', async () => {
  await sdkLoader.loadSdk();

  for (const name of ['package.json', 'package-lock.json', 'node_modules']) {
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, name)),
      false,
      `repo root must not contain ${name}`,
    );
  }
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, 'vendor', 'claude-agent-sdk', 'node_modules')),
    false,
    'vendor/claude-agent-sdk/ must not contain node_modules -- only the three committed files',
  );
});

// PATH-independence, pinned for real: a load that only calls loadQuery() again on the ALREADY
// PRIMED module-level cache (sdkLoader.loadSdk's sdkModulePromise, set by earlier tests in this
// file) never re-imports anything -- it would read green even if a fresh import DID probe PATH,
// because no fresh import happens on that path. The actual pin: bust the require cache for
// orchestrator/sdk.js itself (which resets its module-level `sdkModulePromise` to null), THEN
// empty PATH, THEN require a fresh copy and call loadQuery() -- so this is the first time that
// fresh instance's import() runs, and it runs with PATH empty.
test('loading the SDK spawns nothing and does not require `claude` on PATH', async () => {
  const realPath = process.env.PATH;
  delete require.cache[SDK_MODULE_PATH];
  try {
    process.env.PATH = '';
    const freshSdkLoader = require('../orchestrator/sdk');
    const query = await freshSdkLoader.loadQuery();
    assert.equal(typeof query, 'function');
  } finally {
    process.env.PATH = realPath;
    delete require.cache[SDK_MODULE_PATH];
  }
});

// F7: query() has NO fallback to PATH -- MEASURED (2026-09-17, see orchestrator/sdk.js's header):
// it throws SYNCHRONOUSLY, before any process is spawned, even when a real, working `claude`
// binary is present on PATH, because its only self-contained fallback is the platform npm package
// this repo deliberately did not install (--omit=optional). This is exactly why
// resolveClaudeCodeExecutable exists: every future query() call site must supply
// options.pathToClaudeCodeExecutable itself. If this ever stops throwing (a future SDK version
// grows a real PATH fallback), that is a behavior change significant enough to warrant revisiting
// resolveClaudeCodeExecutable's own reason for existing -- so this pin is deliberately strict
// about the message, not just "it throws something."
test('query() throws synchronously, before any spawn, when options.pathToClaudeCodeExecutable is not supplied', async () => {
  const query = await sdkLoader.loadQuery();
  assert.throws(
    () => query({ prompt: 'x', options: {} }),
    /pathToClaudeCodeExecutable/,
    'query() must fail loudly (naming the option to set) rather than silently probing PATH on its own',
  );
});

// resolveClaudeCodeExecutable: a pure PATH walk, tested against a SYNTHETIC PATH (never the real
// host PATH, which would make this test's pass/fail depend on what happens to be installed on the
// machine running it) pointing at throwaway fixture directories this test creates and removes.
//
// A "first" claim needs an executable `claude` in BOTH dirs (not just one) to actually pin
// ordering -- with `claude` in only one dir, reversing the walk's iteration order would still
// return the sole candidate and this test would stay green either way (the repeating-fixture trap
// flagged in this action's own fix pass, R2: a fixture that cannot distinguish the property under
// test from its negation). Distinct content in each so a wrong-directory return is visibly wrong,
// not just differently-pathed.
test('resolveClaudeCodeExecutable finds the FIRST executable literally named "claude" on a synthetic PATH', () => {
  const dirA = mkTmp('sdk-path-a-');
  const dirB = mkTmp('sdk-path-b-');
  const claudeInA = path.join(dirA, 'claude');
  const claudeInB = path.join(dirB, 'claude');
  fs.writeFileSync(claudeInA, '#!/bin/sh\nexit 0 # A\n', { mode: 0o755 });
  fs.writeFileSync(claudeInB, '#!/bin/sh\nexit 0 # B\n', { mode: 0o755 });
  try {
    const found = sdkLoader.resolveClaudeCodeExecutable([dirA, dirB].join(path.delimiter));
    assert.equal(found, claudeInA, 'must return dirA\'s claude (the first PATH entry), not dirB\'s');

    // Same two dirs, order reversed -- pins that the function walks PATH order, not (say)
    // alphabetical or mtime order, which a same-result-either-way fixture could never catch.
    const foundReversed = sdkLoader.resolveClaudeCodeExecutable([dirB, dirA].join(path.delimiter));
    assert.equal(foundReversed, claudeInB, 'reversing the PATH order must reverse which one wins');
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

// R1: a PATH entry can contain a DIRECTORY literally named `claude` -- fs.accessSync(dir, X_OK)
// succeeds on any searchable directory, so a naive access-only check would return that directory
// as if it were the executable, and would keep returning it even when a REAL executable `claude`
// sits in the very next PATH entry, silently shadowing it. MEASURED as part of this fix pass: this
// test fails (returns the directory) against the pre-fix implementation and passes against the
// current one (statSync().isFile() gate before the access check).
test('resolveClaudeCodeExecutable skips a directory literally named "claude" and finds the real executable in the next PATH entry', () => {
  const dirWithClaudeSubdir = mkTmp('sdk-path-shadow-a-');
  const dirWithRealClaude = mkTmp('sdk-path-shadow-b-');
  const shadowingDir = path.join(dirWithClaudeSubdir, 'claude');
  fs.mkdirSync(shadowingDir);
  const realClaude = path.join(dirWithRealClaude, 'claude');
  fs.writeFileSync(realClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const found = sdkLoader.resolveClaudeCodeExecutable(
      [dirWithClaudeSubdir, dirWithRealClaude].join(path.delimiter),
    );
    assert.equal(
      found,
      realClaude,
      'a directory named "claude" must never be returned as the executable, and must not stop ' +
        'the walk from reaching a real executable later in PATH',
    );
  } finally {
    fs.rmSync(dirWithClaudeSubdir, { recursive: true, force: true });
    fs.rmSync(dirWithRealClaude, { recursive: true, force: true });
  }
});

// R1's other half: a relative PATH entry must resolve against the CURRENT cwd, not be returned as
// a bare relative path -- this repo's own config.js:cwdForStep changes cwd per LLM step, so a
// relative-path leak here is reachable in production, not just a hypothetical. Uses process.chdir
// (restored in finally) so the relative entry "." has a known, fixed meaning for the assertion.
test('resolveClaudeCodeExecutable resolves a relative PATH entry against the current cwd, never returns a relative path', () => {
  const dir = mkTmp('sdk-path-relative-');
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    const found = sdkLoader.resolveClaudeCodeExecutable('.');
    assert.equal(found, path.join(dir, 'claude'));
    assert.ok(path.isAbsolute(found), 'must never return a bare relative path like "./claude"');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveClaudeCodeExecutable returns null when no PATH entry has a "claude" executable', () => {
  const emptyDir = mkTmp('sdk-path-empty-');
  try {
    assert.equal(sdkLoader.resolveClaudeCodeExecutable(emptyDir), null);
    assert.equal(sdkLoader.resolveClaudeCodeExecutable(''), null);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('resolveClaudeCodeExecutable skips a same-named file that is not executable', () => {
  const dir = mkTmp('sdk-path-noexec-');
  fs.writeFileSync(path.join(dir, 'claude'), 'not executable', { mode: 0o644 });
  try {
    assert.equal(sdkLoader.resolveClaudeCodeExecutable(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
