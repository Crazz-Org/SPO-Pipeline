'use strict';
// Tests for scripts/git-hooks/post-merge -- THE DEPLOY.
//
// `git pull` in the deploy checkout fires this hook, and nothing else deploys: not a merge on
// GitHub, not a pull in any other worktree.
//
// ITS JOB SHRANK, AND THAT IS WHAT THIS FILE NOW COVERS. It used to restart the units itself, and
// owned all the "is-active vs is-enabled, deactivating, --no-block, say the skip out loud" logic.
// Under the immutable-release layout that logic lives in scripts/release.sh -- one copy, exercised
// by both the hook and a hand-run deploy -- and every one of those properties moved to
// test/release-script.test.js rather than being dropped. What is left here is the single decision
// release.sh cannot make: WHICH TREE IS ALLOWED TO DEPLOY.
//
// That decision is new, and it closes a hazard the old hook had. git runs this hook with cwd at
// the top of whichever working tree was updated -- ANY of them. This repo routinely has a dozen
// worktrees under .claude/worktrees/, and `git merge --ff-only` inside one fires the hook exactly
// as a pull in the main checkout does (measured 2026-09-04, when it left the daemon `failed`).
// When the hook only restarted services that was untidy; under the release layout it would deploy
// AN AGENT WORKTREE'S BRANCH.
//
// Hermetic: a fake `release.sh` on a throwaway path that only records that it was called.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

require('./no-real-spawn');

const { gitEnv } = require('./helpers');

const HOOK = process.env.SPO_POST_MERGE_HOOK || path.join(__dirname, '..', 'scripts', 'git-hooks', 'post-merge');

const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();

// A checkout on `branch`, carrying a fake scripts/release.sh that records its invocation.
function mkCheckout({ branch = 'main', withRelease = true, releaseExecutable = true } = {}) {
  const dir = mk('spo-pmh-');
  execFileSync('git', ['init', '-q', '-b', branch, '.'], { cwd: dir, env: gitEnv() });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  const marker = path.join(dir, 'released.log');
  if (withRelease) {
    fs.writeFileSync(
      path.join(dir, 'scripts', 'release.sh'),
      `#!/usr/bin/env bash\necho "released $*" >> ${JSON.stringify(marker)}\n`,
      { mode: releaseExecutable ? 0o755 : 0o644 }
    );
  }
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one'], {
    cwd: dir,
    env: gitEnv(),
  });
  return { dir, marker, deployed: () => fs.existsSync(marker) };
}

// Runs the hook the way git does: cwd at the top of the updated working tree, with GIT_DIR
// exported (which is what makes stripping it inside the hook load-bearing).
function runHook(cwd, { sourceRepo, branch } = {}) {
  const env = {
    ...process.env,
    GIT_DIR: path.join(cwd, '.git'),
    GIT_INDEX_FILE: path.join(cwd, '.git', 'index'),
    ...(sourceRepo ? { SPO_SOURCE_REPO: sourceRepo } : {}),
    ...(branch ? { SPO_DEPLOY_BRANCH: branch } : {}),
  };
  // stderr to a FILE, not to execFileSync's pipe. On SUCCESS execFileSync returns stdout only, and
  // this hook deliberately exits 0 while warning on stderr (a broken deploy script must not abort
  // the pull) -- so the warning would be invisible to any test that only reads the catch branch.
  const errPath = path.join(cwd, `hook-stderr.${Date.now()}.${Math.random().toString(36).slice(2)}.log`);
  const errFd = fs.openSync(errPath, 'w');
  const readErr = () => {
    try {
      return fs.readFileSync(errPath, 'utf8');
    } catch {
      return '';
    }
  };
  try {
    const out = execFileSync('bash', [HOOK], { cwd, encoding: 'utf8', env, timeout: 30000, stdio: ['ignore', 'pipe', errFd] });
    return { status: 0, out, err: readErr() };
  } catch (err) {
    return { status: err.status ?? 1, out: String(err.stdout || ''), err: readErr() };
  } finally {
    fs.closeSync(errFd);
  }
}

test('the deploy checkout, on the deploy branch, deploys', () => {
  const c = mkCheckout();
  const r = runHook(c.dir, { sourceRepo: c.dir });
  assert.equal(r.status, 0, r.err);
  assert.equal(c.deployed(), true, 'release.sh was not invoked');
  assert.match(r.out, /deploying [0-9a-f]{7,}/);
});

test('ANY OTHER worktree is skipped out loud -- it must not publish its own branch', () => {
  // The hazard the release layout introduces and this closes: a `git merge --ff-only` inside
  // .claude/worktrees/<slug>/ fires this hook, and cutting a release there would deploy that
  // agent's branch to the live service.
  const deployCheckout = mkCheckout();
  const other = mkCheckout();
  const r = runHook(other.dir, { sourceRepo: deployCheckout.dir });
  assert.equal(r.status, 0);
  assert.equal(other.deployed(), false, 'a non-deploy worktree deployed');
  assert.match(r.out, /is not the deploy checkout/);
});

test('the deploy checkout on a NON-deploy branch is skipped out loud', () => {
  const c = mkCheckout({ branch: 'main' });
  execFileSync('git', ['checkout', '-q', '-b', 'claude/some-work'], { cwd: c.dir, env: gitEnv() });
  const r = runHook(c.dir, { sourceRepo: c.dir });
  assert.equal(r.status, 0);
  assert.equal(c.deployed(), false, 'it deployed a feature branch');
  assert.match(r.out, /is on 'claude\/some-work', not 'main'/);
});

test('SPO_DEPLOY_BRANCH selects which branch deploys', () => {
  const c = mkCheckout({ branch: 'release' });
  const r = runHook(c.dir, { sourceRepo: c.dir, branch: 'release' });
  assert.equal(r.status, 0, r.err);
  assert.equal(c.deployed(), true);
});

test('a missing or non-executable release.sh is reported, and never silently skipped', () => {
  const absent = mkCheckout({ withRelease: false });
  const r1 = runHook(absent.dir, { sourceRepo: absent.dir });
  assert.equal(r1.status, 0, 'the hook must not abort the pull');
  assert.match(r1.err || '', /missing or not executable/);

  const notExec = mkCheckout({ releaseExecutable: false });
  const r2 = runHook(notExec.dir, { sourceRepo: notExec.dir });
  assert.equal(notExec.deployed(), false);
  assert.match(r2.err || '', /missing or not executable/);
});

test('a symlinked or non-canonical SPO_SOURCE_REPO still matches the checkout it points at', () => {
  // `pwd -P` on both sides, because git may hand the hook a path through a symlink while the
  // operator configured the canonical one (or the reverse). A deploy that silently stops
  // happening because of a symlink would be indistinguishable from a successful one.
  const c = mkCheckout();
  const link = path.join(mk('spo-pmh-link-'), 'via-symlink');
  fs.symlinkSync(c.dir, link);
  const r = runHook(c.dir, { sourceRepo: link });
  assert.equal(r.status, 0, r.err);
  assert.equal(c.deployed(), true, 'a symlinked source repo was treated as a different tree');
});

test('deploys when the checkout is REACHED through a symlink -- logical vs physical pwd', () => {
  // The mirror of the case above, and the one that actually needs `pwd -P`. A shell that cd'd
  // through a symlink exports PWD as the LOGICAL path, and bash's `pwd` honours it -- so a hook
  // invoked that way sees the symlink while SPO_SOURCE_REPO holds the canonical path. Comparing
  // logical to physical would silently stop deploying, which is indistinguishable from a deploy
  // that worked. Measured: with PWD set to a symlink, `pwd` and `pwd -P` genuinely differ.
  const c = mkCheckout();
  const link = path.join(mk('spo-pmh-rev-'), 'via-symlink');
  fs.symlinkSync(c.dir, link);

  const env = {
    ...process.env,
    PWD: link, // what a shell that cd'd through the symlink would export
    GIT_DIR: path.join(c.dir, '.git'),
    SPO_SOURCE_REPO: c.dir, // the canonical path, as configured
  };
  execFileSync('bash', [HOOK], { cwd: link, encoding: 'utf8', env, timeout: 30000 });
  assert.equal(c.deployed(), true, 'a checkout reached through a symlink was treated as a different tree');
});

test('strips the inherited GIT_* env before consulting git -- the hook runs with GIT_DIR set', () => {
  // The branch check is a `git rev-parse --abbrev-ref HEAD`. Unstripped, GIT_DIR would decide
  // which repo answers it, so a pull in a worktree could report the deploy checkout's branch (or
  // vice versa) and the gate above would be reading the wrong tree entirely.
  const c = mkCheckout();
  const foreign = mkCheckout({ branch: 'main' });
  execFileSync('git', ['checkout', '-q', '-b', 'not-main'], { cwd: foreign.dir, env: gitEnv() });

  // cwd is the deploy checkout (on main) but GIT_DIR points at the foreign repo (on not-main).
  const env = {
    ...process.env,
    GIT_DIR: path.join(foreign.dir, '.git'),
    GIT_INDEX_FILE: path.join(foreign.dir, '.git', 'index'),
    SPO_SOURCE_REPO: c.dir,
  };
  const out = execFileSync('bash', [HOOK], { cwd: c.dir, encoding: 'utf8', env, timeout: 30000 });
  assert.equal(c.deployed(), true, 'the branch check consulted GIT_DIR instead of the checkout');
  assert.match(out, /deploying/);
});
