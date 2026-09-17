'use strict';
// sdk.js -- action A1 (card #239 chantier, "Drive LLM steps through the Claude Agent SDK instead
// of spawning `claude -p`"). The single place this repo reaches the vendored Agent SDK. Everything
// downstream (the real A5 invokeClaudeReal, once it lands) requires THIS file, never
// `vendor/claude-agent-sdk/sdk.mjs` directly, so there is exactly one resolution path to pin.
//
// ---- why vendored, not installed --------------------------------------------------------------
//
// This repo has no `package.json` and no `node_modules` -- that is a deliberate property, not an
// oversight (see `scripts/gate.sh`'s own header and `.github/workflows/gate.yml:9-12`): the same
// commit produces the same verdict on any machine, with no install step and nothing to fetch.
// That gate.yml reference above is true as read by hand, but NOT resolver-checked:
// `test/citation-pins.js`'s `CITATION_RE` only matches `js|md|sh|ts|json` file extensions, never
// `.yml`, so it stays invisible to `test/doc-constant-sweep.test.js` even though this file is in
// `CORPUS_FILES`. MEASURED (2026-09-17, this fix pass, R4): replacing its line range with a range
// past that file's end produces zero new test failures -- a wrong line number here would go
// undetected. Widening `CITATION_RE` to cover `.yml` is out of scope here -- it needs its own
// `EXPECTED_CITATIONS` entry and RANGE pin, and part 2's test #39 fires without them -- and belongs
// to A9, not this action. (This paragraph itself avoids writing a bare `file.ext:N-M`-shaped
// string for that reason: the corpus scanner reads THIS comment too, and a literal example in that
// exact shape would be extracted as a real, unanchored citation -- measured the hard way while
// drafting this note.)
// `CLAUDE.md` § Git states the other half of the same property: `git pull` in the deploy checkout
// IS the entire deploy. An `npm install` dependency would break both -- a lockfile to drift, a
// registry call the gate would have to trust, and a deploy that stops being "pull, done."
//
// So the maintainer chose to VENDOR the SDK: `npm install @anthropic-ai/claude-agent-sdk
// --omit=optional --legacy-peer-deps` was run once in a throwaway directory OUTSIDE this repo (1
// package, 5.0 MB, zero peer dependencies installed), and exactly three files were copied into
// `vendor/claude-agent-sdk/` and committed: `sdk.mjs`, `package.json` (the package's own manifest,
// kept only as the provenance record -- nothing here parses it at runtime except this file's own
// test, which reads it as a text file to check the pin below), and `LICENSE.md`.
//
// ---- what is deliberately NOT vendored, and the measurement that justifies it ------------------
//
// - `manifest.json` / `manifest.zst.json` and every peer package (`zod`,
//   `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`) listed in the package's own
//   `peerDependencies`. MEASURED by the driver: `sdk.mjs` alone, copied into a bare directory with
//   NO `node_modules` at all, loads via `await import('<abs path>')` from CommonJS and drives a
//   full `query()` call against a fake executable -- none of the above is touched on that path.
// - The platform binary package (`@anthropic-ai/claude-agent-sdk-linux-x64`, 219 MB, and its seven
//   siblings for other OS/arch). MEASURED (this action, 2026-09-17, `node -e` against the real
//   vendored `sdk.mjs`): `query({prompt, options:{}})` throws SYNCHRONOUSLY, before any process is
//   spawned, "Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk
//   without --omit=optional, or set options.pathToClaudeCodeExecutable." -- and it throws THE SAME
//   WAY even with a real, working `claude` binary present on PATH. The SDK's only self-contained
//   fallback is the platform npm package this repo deliberately did not install; it never
//   consults PATH on its own. So the platform package would not even be a *correct* substitute for
//   an explicit path -- every future `query()` call site (A3's buildQueryOptions, A5's
//   invokeClaudeReal) MUST resolve and pass `options.pathToClaudeCodeExecutable` itself.
//   `resolveClaudeCodeExecutable` below is the one place that does that resolution, so a future
//   call site cannot omit it by forgetting a PATH walk nobody wrote. See
//   test/sdk-loader.test.js's pin for the exact assertion.
//
// If the peer/manifest exclusion above ever becomes necessary, that is a new measurement and a new
// vendor entry, not a silent assumption -- see `vendor/claude-agent-sdk/README.md`'s own note and
// `doc/accepted-gaps.md` §1's "Vendored or generated files" bucket, which this directory now
// populates.
//
// ---- the loader itself --------------------------------------------------------------------------
//
// `sdk.mjs` is ESM (`"type": "module"` in its own package.json) but this repo's runtime code is
// CommonJS throughout (no other file here uses `import`). A dynamic `import()` bridges the two.
// The path is converted with `url.pathToFileURL(...).href` first, rather than passed as a bare
// string, for a reason that is verified rather than assumed: MEASURED (2026-09-17, `node -e`) that
// `import('/tmp/some-dir#2/probe.mjs')` -- a path containing a literal `#`, which is valid on this
// (and any POSIX) filesystem -- fails with "Cannot find module '/tmp/some-dir'", because Node reads
// everything from the `#` onward as a URL fragment and silently truncates the specifier there.
// `import(pathToFileURL(path).href)` percent-encodes the `#` (and would do the same for a space or
// `?`) and loads correctly -- confirmed by the same measurement. `pathToFileURL` is also simply the
// form `import()`'s own specifier grammar expects for a filesystem path (a bare absolute path is
// not guaranteed to be treated as a valid module specifier by the ECMAScript/WHATWG spec `import()`
// follows), so this is the documented-correct conversion, not a workaround for one platform.
//
// The import is cached as a PROMISE, not as the resolved namespace: caching the resolved value
// would still leave a window, between "loadSdk() was called" and "the import settled," where a
// second concurrent caller starts its own `import()` of the same 1.5 MB file. Caching the promise
// means every caller after the first gets the SAME in-flight (or settled) promise, so the module is
// parsed exactly once per process no matter how many callers race for it. `loadSdk` is
// deliberately NOT declared `async`: an `async function` always wraps its return value in a FRESH
// Promise on every call, even when the returned value is already a Promise -- so two calls would
// never be `===`, defeating the cache's own purpose of letting callers race on ONE promise. A
// plain function that returns the cached promise directly preserves identity across calls; test/
// sdk-loader.test.js pins exactly this (`assert.equal(loadSdk(), loadSdk())`, no `await` on either
// side).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Built from __dirname, never from process.cwd() -- this file can be required from a worktree-side
// step's cwd (see config.js's cwdForStep) or from a test run from anywhere under test/, and the
// vendored file's location is fixed relative to THIS file's position in the repo tree regardless
// of the caller's cwd. test/sdk-loader.test.js pins this by actually chdir()ing to a throwaway
// directory and re-requiring a fresh copy of this module, not merely by re-deriving the same
// __dirname-relative join a second time (which would pass even if VENDOR_SDK_PATH were built from
// process.cwd(), since the test file's own cwd never changes on its own).
const VENDOR_SDK_PATH = path.join(__dirname, '..', 'vendor', 'claude-agent-sdk', 'sdk.mjs');

// The pin. These two literals are the version pair vendored on 2026-09-17 (see
// vendor/claude-agent-sdk/README.md for the exact npm command and the md5 of sdk.mjs).
// test/sdk-loader.test.js checks them against vendor/claude-agent-sdk/package.json's own
// `version` / `claudeCodeVersion` fields, so this file cannot silently drift from what
// is actually on disk: bump BOTH together, in the same change that replaces sdk.mjs, or the
// pin test fails.
const VENDORED_SDK_VERSION = '0.3.273';
const VENDORED_CLAUDE_CODE_VERSION = '2.1.273';

// Cache the PROMISE (see header) so concurrent callers share one in-flight import instead of each
// starting its own parse of the 1.5 MB file.
let sdkModulePromise = null;

// Dynamic import() of the vendored ESM module, converted to a file:// URL first (see header).
// Resolves to the module's namespace object, which is IDENTICAL (===) across every call in this
// process -- Node's own ESM module cache guarantees that for a single import() of the same
// resolved URL, and this function's own promise cache guarantees it is only ever imported once.
// NOT `async` -- see header for why that would break the identity guarantee this cache exists for.
function loadSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import(pathToFileURL(VENDOR_SDK_PATH).href);
  }
  return sdkModulePromise;
}

// The one export this pipeline actually calls. A thin accessor rather than inlining `.query` at
// every call site, so a future re-export rename inside the SDK (unlikely, but the whole point of
// pinning a version) has exactly one place to fix.
async function loadQuery() {
  const sdk = await loadSdk();
  return sdk.query;
}

// resolveClaudeCodeExecutable(pathEnv?) -- walks PATH (or the given colon/semicolon-delimited
// string) for the first executable file literally named `claude`, and returns its absolute path,
// or `null` if none is found. Exists because `query()` has NO fallback of its own to PATH -- see
// the "what is deliberately NOT vendored" section above -- so every future `query()` call site
// needs this (or an equivalent) to supply `options.pathToClaudeCodeExecutable` explicitly. Kept
// here, not duplicated into A5's invokeClaudeReal, so there is exactly one PATH-walk
// implementation for this pipeline's LLM steps to drift against.
//
// Synchronous and side-effect-free: it only stats candidate paths, never spawns or execs anything,
// so requiring this module -- or calling this function -- never depends on `claude` actually being
// runnable, only (optionally) on PATH containing it.
function resolveClaudeCodeExecutable(pathEnv = process.env.PATH || '') {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    // path.resolve, not path.join: a relative PATH entry (legal, and reachable in this repo
    // specifically because config.js's cwdForStep changes cwd per step) must resolve against the
    // CURRENT cwd at call time, the same way a shell's own PATH lookup would, rather than being
    // returned as a relative path that silently means something else once the caller's cwd moves
    // on. MEASURED (2026-09-17, this fix pass): a relative PATH entry `"b"` previously returned
    // the bare string `"b/claude"`.
    const candidate = path.resolve(dir, 'claude');
    try {
      // statSync BEFORE accessSync, and specifically an isFile() check: fs.accessSync(dir, X_OK)
      // succeeds on any SEARCHABLE DIRECTORY, not just a regular file -- `X_OK` on a directory
      // means "can be entered," which every normal directory satisfies. MEASURED (2026-09-17):
      // without this guard, a PATH entry containing a directory literally named `claude` was
      // returned as if it were the executable, and did so even when a REAL executable named
      // `claude` sat in the very next PATH entry -- silently shadowing it. A5 would have handed
      // that directory path to query()'s pathToClaudeCodeExecutable and failed at spawn time,
      // inside a live LLM step, for a cause invisible from this function's return value alone.
      // statSync throws for a missing path -- caught below, same as a missing file always was.
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here, not a file, or not executable -- try the next PATH entry. A permission error, a
      // missing path, and "it's a directory" are all "this isn't the one," never a reason to throw.
    }
  }
  return null;
}

module.exports = {
  VENDOR_SDK_PATH,
  VENDORED_SDK_VERSION,
  VENDORED_CLAUDE_CODE_VERSION,
  loadSdk,
  loadQuery,
  resolveClaudeCodeExecutable,
};
