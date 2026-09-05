'use strict';
// no-git-env-sweep.test.js -- a standing guard over the class of bug that, on 2026-09-05,
// corrupted this repository from inside its own test suite.
//
// ---- the incident -----------------------------------------------------------------------------
//
// Git exports GIT_DIR (and GIT_INDEX_FILE, GIT_WORK_TREE, GIT_OBJECT_DIRECTORY, ...) to the hooks
// it runs. This repo installs a pre-push hook that runs scripts/gate.sh, i.e. the whole suite. So
// inside `git push`, a test that spawns `git` in a throwaway directory does NOT act on that
// directory -- `-C <tmp>` and `cwd: <tmp>` are both overridden by the inherited GIT_DIR, and the
// command acts on THIS repository instead.
//
// test/pipeline-version.test.js builds real repos to check how `.git` is read. Run under the hook,
// its own fixtures did all of this to the live repo, measured from the reflog afterwards:
//
//   * `git commit --allow-empty -m one` x3  -> three empty commits on the branch being pushed,
//     which then reached `main` through PR #126;
//   * `git checkout --detach HEAD`          -> detached TWO live worktrees;
//   * `git symbolic-ref refs/heads/main refs/heads/other`
//                                           -> left the real `refs/heads/main` a DANGLING SYMREF,
//                                              breaking the main checkout entirely;
//   * `git worktree add -b side`, `git tag -a v1`
//                                           -> a stray branch, tag and worktree in the real repo.
//
// The signature is the nastiest available: the suite is GREEN under `node --test` and RED under
// `git push`, because only the second has GIT_* in the environment. Nobody runs the suite the
// second way except the gate, and the gate is the one place the damage happens.
//
// test/doc-constant-sweep.test.js carried the same exposure independently and had for far longer
// (`git -C <tmp> init` + `git -C <tmp> add -A`), so this was never one file's mistake.
//
// ---- what this file enforces ------------------------------------------------------------------
//
// Every real `git` spawn in test/ must pass an `env:` option. Textual, like
// test/no-real-spawn-sweep.test.js and test/gh-api-argv.test.js: it reads SOURCE, so it cannot be
// fooled by a helper that happens to do the right thing at runtime today, and it fails on the NEW
// call site rather than waiting to observe the corruption.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;

// `execFileSync('git', ...)` / `spawnSync('git', ...)` / `execFile('git', ...)`, however spaced or
// quoted. Deliberately matches the COMMAND, not the function: a future test that reaches git
// through some other spawner is exactly what this should catch, not wave through.
const GIT_SPAWN = /(?:execFileSync|execFile|spawnSync|spawn)\(\s*(['"])git\1\s*,/g;

// Named, reasoned, and small -- the same posture every other sweep in this suite takes toward its
// exceptions. NOT a pattern: a file earns its way in here by argument, one at a time.
const FILE_ALLOWLIST = new Map([
  [
    'no-real-spawn.test.js',
    "its `git` calls are assert.throws(...) probes of the killswitch itself -- they invoke the " +
      'PATCHED spawnSync to prove it refuses, so no real git process is ever created. Giving them ' +
      'an env would test nothing and obscure what they are.',
  ],
]);

function callSites() {
  const out = [];
  for (const file of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.js')).sort()) {
    if (file === path.basename(__filename)) continue; // this file's own regex literals
    if (FILE_ALLOWLIST.has(file)) continue;
    const src = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    const lines = src.split('\n');
    for (const m of src.matchAll(GIT_SPAWN)) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      // A COMMENT that mentions a git spawn is prose, not a call site -- three of the four things
      // this check first reported were comments describing the very rule it enforces.
      const line = lines[lineNo - 1].trimStart();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
      // The options object may wrap onto following lines; read the call through a bounded window so
      // a runaway match cannot swallow the rest of the file.
      const chunk = lines.slice(lineNo - 1, lineNo + 6).join('\n');
      out.push({ file, lineNo, chunk });
    }
  }
  return out;
}

test('every real `git` spawn in test/ strips the inherited GIT_* environment', () => {
  const sites = callSites();
  // A floor, so a refactor that moves every git call behind a helper this regex no longer sees
  // fails here loudly instead of silently checking nothing -- the same posture
  // test/no-real-spawn-sweep.test.js takes.
  assert.ok(sites.length >= 12, `expected the known git call sites, found ${sites.length}`);
  // The allowlist is capped by name too, so "cannot check" can never quietly grow into a way out.
  assert.deepEqual([...FILE_ALLOWLIST.keys()], ['no-real-spawn.test.js']);

  const offenders = sites
    .filter((s) => !/env\s*:/.test(s.chunk))
    .map((s) => `${s.file}:${s.lineNo}`);

  assert.deepEqual(
    offenders,
    [],
    'git spawn(s) in test/ with no `env:` option. Under the pre-push hook GIT_DIR is inherited, so ' +
      'these act on THIS repository rather than on their temp directory -- pass `env: gitEnv()` ' +
      "(test/helpers.js). See this file's header for what that cost once:\n  " +
      offenders.join('\n  ')
  );
});

test('helpers.gitEnv actually removes every GIT_* variable, including ones set right now', () => {
  const { gitEnv } = require('./helpers');
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = '/nonexistent/.git';
  process.env.GIT_INDEX_FILE = '/nonexistent/index';
  try {
    const env = gitEnv();
    assert.deepEqual(
      Object.keys(env).filter((k) => k.startsWith('GIT_')),
      [],
      'gitEnv left a GIT_* variable in place'
    );
    // And it must not mutate the real environment out from under the rest of the suite.
    assert.equal(process.env.GIT_DIR, '/nonexistent/.git');
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
    delete process.env.GIT_INDEX_FILE;
  }
});
