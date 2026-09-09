'use strict';
// Tests for scripts/lib/deploy-guard.sh, and for the one thing its existence is FOR: that
// scripts/daemon-install.sh now refuses to install (and cut a release, and touch the live
// service) from any tree other than the deploy checkout, on any branch other than the deploy
// branch -- exactly the check scripts/git-hooks/post-merge already had, now shared instead of
// duplicated (see test/post-merge-hook.test.js for the hook's own, pre-existing coverage of the
// same rule).
//
// THE DEFECT THIS CLOSES. scripts/daemon-install.sh derived its `$REPO` from its own script path
// (`cd "$(dirname "$0")/.." && pwd`) and never checked it against anything. Run from any
// `.claude/worktrees/<slug>/` -- an ordinary agent worktree on this very repo -- it would cut a
// release from that worktree's branch and point the live `systemctl --user` service at it. The
// guard's whole value is firing in exactly the tree nobody thought to test the installer from, so
// case 1 below (a fixture tree that is neither named nor located at the real deploy checkout) is
// the load-bearing one: it is the assertion that must fall if the guard block is ever removed.
//
// Hermetic, and proven so rather than assumed: a fixture tree under mkTmp carrying REAL COPIES of
// the shipped installer, guard lib and hooks (copied at test-run time, so an edit to any of them
// propagates into every case here without this file changing), a fake `scripts/release.sh` that
// only records its invocation, and `systemctl`/`loginctl`/`sleep` shadowed on PATH by recorders
// under a sandboxed $HOME -- so a run that reaches the "install" path never touches the real
// ~/.spo-current, ~/.spo-releases or the real user service. The positive-control case (2) is that
// proof in positive form: it runs the installer all the way through and shows the interception
// actually happened (unit file under the sandboxed $HOME, systemctl recorder logging the calls),
// not merely that nothing bad occurred.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { gitEnv, mkTmp, REPO_ROOT } = require('./helpers');

const REAL_INSTALL_SH = path.join(REPO_ROOT, 'scripts', 'daemon-install.sh');
const REAL_GUARD_SH = path.join(REPO_ROOT, 'scripts', 'lib', 'deploy-guard.sh');
const REAL_POST_MERGE = path.join(REPO_ROOT, 'scripts', 'git-hooks', 'post-merge');
const REAL_PRE_PUSH = path.join(REPO_ROOT, 'scripts', 'git-hooks', 'pre-push');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A fixture git repo carrying real copies of the four shipped files the installer touches, plus a
// `scripts/release.sh` REPLACED by a recorder (a real release.sh would try to build a tree under
// ~/.spo-releases). One commit, on `branch`, so the branch axis is testable independently of the
// tree axis.
function mkFixture({ branch = 'main' } = {}) {
  const dir = mkTmp('spo-dg-fixture-');
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: dir, env: gitEnv() });

  fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts', 'git-hooks'), { recursive: true });

  const installCopy = path.join(dir, 'scripts', 'daemon-install.sh');
  const guardCopy = path.join(dir, 'scripts', 'lib', 'deploy-guard.sh');
  const postMergeCopy = path.join(dir, 'scripts', 'git-hooks', 'post-merge');
  const prePushCopy = path.join(dir, 'scripts', 'git-hooks', 'pre-push');

  fs.copyFileSync(REAL_INSTALL_SH, installCopy);
  fs.copyFileSync(REAL_GUARD_SH, guardCopy);
  fs.copyFileSync(REAL_POST_MERGE, postMergeCopy);
  fs.copyFileSync(REAL_PRE_PUSH, prePushCopy);
  fs.chmodSync(installCopy, 0o755);
  fs.chmodSync(postMergeCopy, 0o755);
  fs.chmodSync(prePushCopy, 0o755);

  const releaseMarker = path.join(dir, 'released.log');
  fs.writeFileSync(
    path.join(dir, 'scripts', 'release.sh'),
    `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(releaseMarker)}\nexit 0\n`,
    { mode: 0o755 }
  );

  fs.writeFileSync(path.join(dir, 'marker.txt'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one'], {
    cwd: dir,
    env: gitEnv(),
  });
  if (branch !== 'main') {
    execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: dir, env: gitEnv() });
  }

  return {
    dir,
    installSh: installCopy,
    guardSh: guardCopy,
    releaseMarker,
    released: () => fs.existsSync(releaseMarker),
  };
}

// A directory that is NOT a git repository at all, carrying just enough of the fixture (the
// installer + the guard lib) to reach the branch axis without a release.sh or hooks -- case 5
// must refuse before either would be touched.
function mkNonGitFixture() {
  const dir = mkTmp('spo-dg-nongit-');
  fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  const installCopy = path.join(dir, 'scripts', 'daemon-install.sh');
  fs.copyFileSync(REAL_INSTALL_SH, installCopy);
  fs.copyFileSync(REAL_GUARD_SH, path.join(dir, 'scripts', 'lib', 'deploy-guard.sh'));
  fs.chmodSync(installCopy, 0o755);
  return { dir, installSh: installCopy };
}

// A sandboxed $HOME plus a PATH-shadowed systemctl/loginctl/sleep, each a recorder that logs its
// invocation and exits 0 -- never a real systemd or a real sleep.
function mkSandbox() {
  const home = mkTmp('spo-dg-home-');
  const bin = mkTmp('spo-dg-bin-');
  const log = path.join(home, 'calls.log');
  for (const name of ['systemctl', 'loginctl', 'sleep']) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/usr/bin/env bash\necho "${name} $*" >> ${JSON.stringify(log)}\nexit 0\n`,
      { mode: 0o755 }
    );
  }
  return {
    home,
    bin,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

// Runs the fixture's installer copy the way a maintainer would: `bash <path>`, never `daemon-
// install.sh` itself made executable and exec'd, so no shebang/PATH resolution surprises. stderr
// goes to a FILE, not execFileSync's pipe -- on a NON-ZERO exit execFileSync's thrown error already
// carries stdout/stderr, but capturing to a file keeps the same shape as the other cases and
// matches this suite's existing convention (test/post-merge-hook.test.js, test/release-script.test.js).
function runInstaller(fixture, sandbox, { sourceRepo, branch, extraEnv } = {}) {
  const env = { ...process.env };
  // An ambient SPO_SOURCE_REPO/SPO_DEPLOY_BRANCH in the developer's own shell must not leak into
  // a case that means to leave them UNSET (case 1's whole point is testing the guard's own
  // derived default) -- delete them here, before the per-case overrides below are spread back in,
  // so "left unset" is genuinely unset rather than merely "not set by this call".
  delete env.SPO_SOURCE_REPO;
  delete env.SPO_DEPLOY_BRANCH;
  Object.assign(env, {
    HOME: sandbox.home,
    PATH: `${sandbox.bin}:${process.env.PATH}`,
    SPO_CURRENT_LINK: path.join(sandbox.home, 'current-link'),
    SPO_RELEASES_DIR: path.join(sandbox.home, 'releases'),
    ...(sourceRepo ? { SPO_SOURCE_REPO: sourceRepo } : {}),
    ...(branch ? { SPO_DEPLOY_BRANCH: branch } : {}),
    ...(extraEnv || {}),
  });
  const errPath = path.join(sandbox.home, `stderr.${Date.now()}.${Math.random().toString(36).slice(2)}.log`);
  const errFd = fs.openSync(errPath, 'w');
  const readErr = () => {
    try {
      return fs.readFileSync(errPath, 'utf8');
    } catch {
      return '';
    }
  };
  try {
    const out = execFileSync('bash', [fixture.installSh], {
      encoding: 'utf8',
      env,
      timeout: 30000,
      stdio: ['ignore', 'pipe', errFd],
    });
    return { status: 0, out, err: readErr() };
  } catch (err) {
    return { status: err.status ?? 1, out: String(err.stdout || ''), err: readErr() };
  } finally {
    fs.closeSync(errFd);
  }
}

function unitPath(sandbox) {
  return path.join(sandbox.home, '.config', 'systemd', 'user', 'spo-pipeline-daemon.service');
}

// ---- isolation proof: the real machine state is untouched, before AND after this file's tests ---

const REAL_CURRENT_LINK = path.join(os.homedir(), '.spo-current');
const REAL_RELEASES_DIR = path.join(os.homedir(), '.spo-releases');

function snapshotRealDeployState() {
  let link = null;
  try {
    link = fs.readlinkSync(REAL_CURRENT_LINK);
  } catch {
    link = null;
  }
  return { link, releasesDirExists: fs.existsSync(REAL_RELEASES_DIR) };
}

const REAL_STATE_BEFORE = snapshotRealDeployState();

// ---- the fixture is a real copy, not a rewrite -------------------------------------------------

test('the fixture carries byte-identical copies of the shipped installer and guard lib', () => {
  const f = mkFixture();
  assert.deepEqual(fs.readFileSync(f.installSh), fs.readFileSync(REAL_INSTALL_SH));
  assert.deepEqual(fs.readFileSync(f.guardSh), fs.readFileSync(REAL_GUARD_SH));
});

// ---- case 1: the load-bearing one ---------------------------------------------------------------

test('a foreign tree with SPO_SOURCE_REPO left UNSET is refused, using the guard\'s own derived answer', () => {
  // TRAP (paid before, card #133): do NOT set SPO_SOURCE_REPO here. Handing the guard its own
  // answer would let a dead guard stay green -- this case must derive $HOME/SPO-Pipeline itself
  // and find that the fixture (an mkTmp directory, never named or located as SPO-Pipeline) is not
  // it. Setting HOME is fine and required: it sandboxes the derivation without configuring it.
  const f = mkFixture();
  const sandbox = mkSandbox();
  const r = runInstaller(f, sandbox, {});

  assert.notEqual(r.status, 0, 'the installer must refuse to run from a foreign tree');
  assert.match(r.err, /is not the deploy checkout/);
  assert.match(r.err, new RegExp(`tree seen:\\s+${escapeRegex(f.dir)}`), 'stderr does not name the tree it saw');
  assert.match(
    r.err,
    new RegExp(`tree expected:\\s+${escapeRegex(path.join(sandbox.home, 'SPO-Pipeline'))}`),
    'stderr does not name the tree it expected'
  );
  assert.match(r.err, /nothing was written, no release was cut, no service was touched/);
  assert.match(r.err, /SPO_SOURCE_REPO/);
  assert.match(r.err, /SPO_DEPLOY_BRANCH/);

  assert.equal(f.released(), false, 'release.sh was invoked from a foreign tree');
  assert.equal(fs.existsSync(unitPath(sandbox)), false, 'a unit file was written for a foreign tree');
});

// ---- case 2: the positive control, and the isolation proof --------------------------------------

test('positive control: the deploy checkout on the deploy branch installs -- and proves the sandbox intercepts', () => {
  const f = mkFixture();
  const sandbox = mkSandbox();
  const r = runInstaller(f, sandbox, { sourceRepo: f.dir });

  assert.equal(r.status, 0, r.err);
  assert.equal(f.released(), true, 'release.sh was never invoked');

  // Demonstrated interception, not assumed: the unit landed under the SANDBOXED $HOME, and the
  // systemctl recorder logged the calls a real install would have made against the live service.
  assert.equal(fs.existsSync(unitPath(sandbox)), true, 'no unit file was written under the sandboxed $HOME');
  const calls = sandbox.calls();
  assert.ok(calls.some((l) => l.includes('enable --now spo-pipeline-daemon.service')), 'systemctl enable --now was not recorded');
  assert.ok(calls.some((l) => l.includes('restart spo-pipeline-daemon.service')), 'systemctl restart was not recorded');
});

// ---- case 3: right tree, wrong branch ------------------------------------------------------------

test('the deploy checkout on a NON-deploy branch is refused, and names both branches', () => {
  const f = mkFixture({ branch: 'claude/some-work' });
  const sandbox = mkSandbox();
  const r = runInstaller(f, sandbox, { sourceRepo: f.dir });

  assert.notEqual(r.status, 0);
  assert.match(r.err, /is on 'claude\/some-work', not 'main'/);
  assert.equal(f.released(), false);
  assert.equal(fs.existsSync(unitPath(sandbox)), false);
});

// ---- case 4: SPO_DEPLOY_BRANCH override ----------------------------------------------------------

test('SPO_DEPLOY_BRANCH selects which branch may install', () => {
  const f = mkFixture({ branch: 'claude/some-work' });
  const sandbox = mkSandbox();
  const r = runInstaller(f, sandbox, { sourceRepo: f.dir, branch: 'claude/some-work' });

  assert.equal(r.status, 0, r.err);
  assert.equal(f.released(), true);
});

// ---- case 4b: GIT_DIR/GIT_WORK_TREE pollution must not change the guard's answer ------------------

// Pins the INSTALLER half of a property whose HOOK half test/post-merge-hook.test.js already
// covers: git exports GIT_DIR (and friends) to every hook it runs, so a `pre-push` invocation of
// this same guard runs with GIT_DIR already set in the environment -- exactly what deleting the
// `env -u GIT_DIR ...` prefix on the lib's git call would otherwise leave unguarded. Before this
// case, the whole suite stayed green under `node --test` even with that prefix deleted, because
// nothing here ever exported GIT_DIR into the installer's environment in the first place.
test('GIT_DIR/GIT_WORK_TREE pollution cannot change the guard\'s branch answer', () => {
  // The fixture stays on 'main' (mkFixture's default), matching SPO_DEPLOY_BRANCH's own default --
  // so an installer that reads the FIXTURE's branch must ACCEPT.
  const f = mkFixture();
  const sandbox = mkSandbox();

  // A second, unrelated real repo on a DIFFERENT branch: what the guard's git call would read
  // instead if it ever leaked the exported GIT_DIR/GIT_WORK_TREE rather than reading the tree
  // named by its own `-C` argument. Measured directly (not merely asserted): `git -C "$fixture"
  // rev-parse --abbrev-ref HEAD` with GIT_DIR/GIT_WORK_TREE exported pointing at this repo prints
  // this repo's own branch, "foreign-branch" -- `-C` does not win against an exported GIT_DIR.
  const foreign = mkTmp('spo-dg-foreign-');
  execFileSync('git', ['init', '-q', '-b', 'foreign-branch', '.'], { cwd: foreign, env: gitEnv() });
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one'],
    { cwd: foreign, env: gitEnv() }
  );

  const r = runInstaller(f, sandbox, {
    sourceRepo: f.dir, // only the branch axis is under test -- the tree axis is already pinned by case 1/3
    extraEnv: {
      GIT_DIR: path.join(foreign, '.git'),
      GIT_WORK_TREE: foreign,
    },
  });

  // If the guard's git call ever leaked the exported GIT_DIR, it would read the FOREIGN repo's
  // 'foreign-branch' instead of the fixture's 'main', mismatch SPO_DEPLOY_BRANCH's default 'main',
  // and refuse -- so a correct guard must ACCEPT here, reflecting the fixture's own branch.
  assert.equal(r.status, 0, `installer refused despite GIT_DIR pollution -- guard read the wrong repo's branch: ${r.err}`);
  assert.equal(f.released(), true, "release.sh was not invoked -- GIT_DIR pollution changed the guard's answer");
});

// ---- case 5: a non-git tree must not crash the guard ----------------------------------------------

test('a non-git tree refuses cleanly on the branch axis -- never a raw git fatal', () => {
  const f = mkNonGitFixture();
  const sandbox = mkSandbox();
  const r = runInstaller(f, sandbox, { sourceRepo: f.dir });

  assert.notEqual(r.status, 0, 'a non-git tree must not be treated as installable');
  assert.match(r.err, /is on '\?', not 'main'/);
  assert.doesNotMatch(r.err, /fatal: not a git repository/, "the guard's git call leaked a raw fatal instead of its own message");
  assert.equal(fs.existsSync(path.join(f.dir, 'released.log')), false);
  assert.equal(fs.existsSync(unitPath(sandbox)), false);
});

// ---- the real machine, once more, at the very end of this file ----------------------------------

test('the real ~/.spo-current and ~/.spo-releases are exactly as this file found them', () => {
  assert.deepEqual(
    snapshotRealDeployState(),
    REAL_STATE_BEFORE,
    'a case in this file touched the real deploy state -- every install above must have run inside the sandbox'
  );
});
