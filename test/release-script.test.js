'use strict';
// Tests for scripts/release.sh -- the immutable-release deploy (doc/deployment.md §5).
//
// WHAT THE LAYOUT IS FOR. ~/SPO-Pipeline was three things at once: the tree the service EXECUTES,
// the tree a human EDITS, and the tree `git pull` MUTATES. dispatcher.js resolves DAEMON_PATH at
// every spawn, so mutating it while the daemon runs splits versions with no restart at all. The
// drain narrows that window; only the layout can close it.
//
// THE LOAD-BEARING TEST IS "a running process keeps its own tree after the symlink moves" -- not
// the symlink mechanics, which are trivial, but Node resolving `__dirname` to the REALPATH. If
// that were ever untrue the whole design would be a slower version of the bug it replaces, so it
// is measured with real processes rather than asserted.
//
// Hermetic: a tiny throwaway source repo (so clones are milliseconds, not a 32 MB copy), throwaway
// releases/symlink paths, and a fake `systemctl` first on PATH. Nothing here touches the real
// repository, the real ~/.spo-releases, or any real unit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

require('./no-real-spawn');

const { gitEnv } = require('./helpers');

const RELEASE_SH = path.join(__dirname, '..', 'scripts', 'release.sh');
const REAL_PIPELINE_VERSION = path.join(__dirname, '..', 'orchestrator', 'pipeline-version.js');

const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();

// A minimal repo that is release-shaped: it carries the REAL pipeline-version.js, because
// release.sh's own self-description probe runs it out of the built tree. Anything less would let
// the probe pass against a stub and prove nothing about the production path.
function mkSourceRepo() {
  const dir = mk('spo-relsrc-');
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: dir, env: gitEnv() });
  fs.mkdirSync(path.join(dir, 'orchestrator'), { recursive: true });
  fs.copyFileSync(REAL_PIPELINE_VERSION, path.join(dir, 'orchestrator', 'pipeline-version.js'));
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'v1\n');
  commit(dir, 'one');
  return dir;
}

function commit(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg], {
    cwd: dir,
    env: gitEnv(),
  });
  return git(dir, 'rev-parse', 'HEAD');
}

// A world for one test: source repo, releases dir, symlink path, and a fake systemctl that logs.
function mkWorld({ units = 'fake.service', active = [], enabled = [], installed = [], restartFails = [] } = {}) {
  const home = mk('spo-relworld-');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(home, 'systemctl.log');
  fs.writeFileSync(
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash
args=(); for a in "$@"; do [ "$a" = "--user" ] || args+=("$a"); done
echo "\${args[*]}" >> ${JSON.stringify(log)}
# The verb is the first arg; the UNIT is the first NON-FLAG arg after it. Reading \${args[1]}
# blindly makes \`restart --no-block <unit>\` look like a call on a unit named "--no-block", which
# is how the restart-failure case first passed for the wrong reason.
verb="\${args[0]:-}"; unit=""
for a in "\${args[@]:1}"; do case "$a" in --*) ;; *) unit="$a"; break ;; esac; done
contains() { case " $1 " in *" $2 "*) return 0;; esac; return 1; }
case "$verb" in
  list-unit-files) contains ${JSON.stringify(installed.join(' '))} "$unit" ;;
  is-active)       if contains ${JSON.stringify(active.join(' '))} "$unit"; then echo active; exit 0; fi; echo inactive; exit 3 ;;
  is-enabled)      contains ${JSON.stringify(enabled.join(' '))} "$unit" ;;
  restart)         contains ${JSON.stringify(restartFails.join(' '))} "$unit" && exit 1; exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 }
  );
  return {
    home,
    source: mkSourceRepo(),
    releases: path.join(home, 'releases'),
    current: path.join(home, 'current'),
    units,
    bin,
    log,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    // The logged line is `restart --no-block <unit>`, so a naive startsWith('restart <unit>')
    // silently never matches -- which is how four of these tests first failed.
    restarted: () =>
      (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])
        .filter((l) => l.startsWith('restart '))
        .map((l) => l.split(/\s+/).filter((t) => !t.startsWith('--')).slice(1).join(' ')),
  };
}

function release(w, args = [], extraEnv = {}) {
  const env = {
    ...gitEnv(),
    PATH: `${w.bin}:${process.env.PATH}`,
    SPO_SOURCE_REPO: w.source,
    SPO_RELEASES_DIR: w.releases,
    SPO_CURRENT_LINK: w.current,
    SPO_RELEASE_UNITS: w.units,
    ...extraEnv,
  };
  // stderr goes to a FILE, not to execFileSync's pipe: on SUCCESS execFileSync returns stdout only,
  // so a warning printed by a deploy that nonetheless exited 0 -- "failed to restart X", exactly
  // the case below -- would be invisible to these tests.
  const errPath = path.join(w.home, `stderr.${Date.now()}.${Math.random().toString(36).slice(2)}.log`);
  const errFd = fs.openSync(errPath, 'w');
  const read = () => {
    try {
      return fs.readFileSync(errPath, 'utf8');
    } catch {
      return '';
    }
  };
  try {
    const out = execFileSync('bash', [RELEASE_SH, ...args], {
      encoding: 'utf8',
      env,
      timeout: 60000,
      stdio: ['ignore', 'pipe', errFd],
    });
    return { status: 0, out, err: read() };
  } catch (err) {
    return { status: err.status ?? 1, out: String(err.stdout || ''), err: read() };
  } finally {
    fs.closeSync(errFd);
  }
}

// ---- building and switching ---------------------------------------------------------------------

test('cuts a release named for the sha, points the symlink at it, and the tree describes itself', () => {
  const w = mkWorld();
  const sha = git(w.source, 'rev-parse', 'HEAD');

  const r = release(w);
  assert.equal(r.status, 0, r.err);
  assert.equal(fs.existsSync(path.join(w.releases, sha, 'marker.txt')), true);
  assert.equal(fs.readlinkSync(w.current), path.join(w.releases, sha));

  // The self-description probe release.sh runs before switching, re-run here against the built
  // tree: a release whose pipeline-version reports a different sha would journal that wrong sha on
  // every card, which is the exact provenance question this layout exists to answer.
  const { readPipelineVersion } = require(path.join(w.releases, sha, 'orchestrator', 'pipeline-version.js'));
  assert.equal(readPipelineVersion(path.join(w.releases, sha)).sha, sha);
});

test('re-running for the same sha reuses the tree instead of rebuilding it', () => {
  const w = mkWorld();
  const sha = git(w.source, 'rev-parse', 'HEAD');
  release(w);
  const built = fs.statSync(path.join(w.releases, sha)).ctimeMs;

  const again = release(w);
  assert.equal(again.status, 0);
  assert.match(again.out, /already built, reusing/);
  assert.equal(fs.statSync(path.join(w.releases, sha)).ctimeMs, built, 'the tree was rebuilt');
  assert.match(again.out, /already current, nothing to switch/);
});

test('refuses a dirty source tree -- a release directory must not claim a sha it does not contain', () => {
  const w = mkWorld();
  fs.writeFileSync(path.join(w.source, 'marker.txt'), 'uncommitted\n');
  const r = release(w);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /uncommitted changes/);
  assert.equal(fs.existsSync(w.current), false, 'it switched anyway');
});

// ---- THE property the design rests on -------------------------------------------------------------

test('a RUNNING process keeps its own release tree after the symlink moves', { timeout: 30000 }, async () => {
  const w = mkWorld();
  const first = git(w.source, 'rev-parse', 'HEAD');
  release(w);

  // Mimics dispatcher.js: DAEMON_PATH = path.join(__dirname, 'daemon.js'), re-derived per spawn.
  const probeLog = path.join(w.home, 'probe.log');
  fs.writeFileSync(
    path.join(w.releases, first, 'orchestrator', 'probe.js'),
    `const path=require('path'),fs=require('fs');
     setInterval(()=>fs.appendFileSync(${JSON.stringify(probeLog)}, path.join(__dirname,'daemon.js')+'\\n'),150);
     setTimeout(()=>process.exit(0),3000);`
  );
  const child = spawn(process.execPath, [path.join(w.current, 'orchestrator', 'probe.js')], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));

  await new Promise((r) => setTimeout(r, 600));
  const second = commit(w.source, 'two');
  assert.notEqual(second, first);
  const r = release(w);
  assert.equal(r.status, 0, r.err);
  assert.equal(fs.readlinkSync(w.current), path.join(w.releases, second), 'the symlink did not move');

  await exited;
  const resolved = [...new Set(fs.readFileSync(probeLog, 'utf8').split('\n').filter(Boolean))];
  // Node resolves `__dirname` to the REALPATH, so the live process never followed the symlink to
  // the new tree. This is what makes version cohesion a property of the layout rather than of
  // timing -- and what makes a card-driven self-update possible at all.
  assert.deepEqual(resolved, [path.join(w.releases, first, 'orchestrator', 'daemon.js')]);
});

// ---- rollback ------------------------------------------------------------------------------------

test('records the previous release, rolls back to it, and a second rollback does not bounce', () => {
  const w = mkWorld();
  const first = git(w.source, 'rev-parse', 'HEAD');
  release(w);
  const second = commit(w.source, 'two');
  release(w);
  assert.equal(fs.readlinkSync(w.current), path.join(w.releases, second));

  const back = release(w, ['--rollback']);
  assert.equal(back.status, 0, back.err);
  assert.equal(fs.readlinkSync(w.current), path.join(w.releases, first));

  // Rolling back again must go FORWARD to what we just left, not bounce between the same two.
  const again = release(w, ['--rollback']);
  assert.equal(again.status, 0, again.err);
  assert.equal(fs.readlinkSync(w.current), path.join(w.releases, second), 'rollback bounced instead of advancing');
});

test('--list marks the current release', () => {
  const w = mkWorld();
  const first = git(w.source, 'rev-parse', 'HEAD');
  release(w);
  const out = release(w, ['--list']).out;
  assert.match(out, new RegExp(`${first}.*<- current`));
});

test('pruning keeps the newest N and NEVER removes the current or previous release', () => {
  const w = mkWorld();
  const shas = [git(w.source, 'rev-parse', 'HEAD')];
  for (let i = 0; i < 3; i++) shas.push(commit(w.source, `c${i}`));
  // Each sha is cut EXPLICITLY. The first cut of this test made all four commits and then called
  // release four times with no ref -- every call cut HEAD, i.e. the same release four times, and
  // the assertion below failed against a "previous" that had never been built. A test that builds
  // one release and checks the retention of four proves nothing about retention.
  for (const s of shas) release(w, [s], { SPO_RELEASE_KEEP: '2' });
  assert.equal(
    fs.readdirSync(w.releases).filter((f) => /^[0-9a-f]{40}$/.test(f)).length >= 2,
    true,
    'fixture precondition: distinct releases were built'
  );

  const kept = fs.readdirSync(w.releases).filter((f) => /^[0-9a-f]{40}$/.test(f));
  // A rollback target that can be garbage-collected is not a rollback target.
  assert.ok(kept.includes(shas[shas.length - 1]), 'the current release was pruned');
  assert.ok(kept.includes(shas[shas.length - 2]), 'the previous release was pruned');
  assert.ok(kept.length <= 3, `kept ${kept.length} releases with KEEP=2 (current + previous + 2 at most)`);
});

test('refuses to switch to a tree that cannot describe itself', () => {
  const w = mkWorld();
  // A release whose pipeline-version reports the WRONG sha is the failure this check exists for:
  // every card's `pipeline-version` journal line would then carry a sha the tree does not contain,
  // and "which version produced this park?" would have a confident wrong answer instead of none.
  // Replacing the module in the SOURCE is how a bad clone, a truncated checkout or a broken .git
  // would present itself to the probe.
  fs.writeFileSync(
    path.join(w.source, 'orchestrator', 'pipeline-version.js'),
    'module.exports = { readPipelineVersion: () => ({ sha: "0000000000000000000000000000000000000000", ref: null }) };'
  );
  const sha = commit(w.source, 'lying version module');

  const r = release(w);
  assert.notEqual(r.status, 0, 'it switched to a tree that misreports its own sha');
  assert.match(r.err, /cannot describe itself/);
  assert.equal(fs.existsSync(w.current), false, 'the symlink was moved anyway');
  // The built tree may remain -- what must not happen is the SWITCH.
  assert.equal(fs.existsSync(path.join(w.releases, sha)), true);
});

test('pruning protects the previous release even when it falls outside the retention count', () => {
  const w = mkWorld();
  const shas = [git(w.source, 'rev-parse', 'HEAD')];
  for (let i = 0; i < 2; i++) shas.push(commit(w.source, `k${i}`));
  // KEEP=1 puts the PREVIOUS release outside the retention window, so only the explicit
  // "never prune the rollback target" guard can save it. With KEEP=2 the previous release is
  // retained by the count alone and the guard is never exercised -- which is how the first cut of
  // these tests let that guard survive mutation.
  for (const s of shas) release(w, [s], { SPO_RELEASE_KEEP: '1' });

  const kept = fs.readdirSync(w.releases).filter((f) => /^[0-9a-f]{40}$/.test(f));
  assert.ok(kept.includes(shas[2]), 'the current release was pruned');
  assert.ok(kept.includes(shas[1]), 'the previous release was pruned -- rollback is now impossible');
  assert.equal(kept.includes(shas[0]), false, 'nothing was pruned at all; KEEP is not being honoured');
});

// ---- the restart half ------------------------------------------------------------------------------

test('restarts an installed+active unit with --no-block, because a stop drains', () => {
  const w = mkWorld({ installed: ['fake.service'], active: ['fake.service'] });
  const r = release(w);
  assert.equal(r.status, 0, r.err);
  const restart = w.calls().find((l) => l.startsWith('restart '));
  assert.ok(restart, 'no restart was issued');
  // Without --no-block the deploy blocks for as long as the in-flight cards take, up to 45 min.
  assert.match(restart, /--no-block/);
});

test('skips an installed-but-stopped unit OUT LOUD, and says nothing when it is not installed', () => {
  const stopped = mkWorld({ installed: ['fake.service'] });
  assert.match(release(stopped).out, /SKIPPING fake\.service/);
  assert.equal(stopped.calls().some((l) => l.startsWith('restart ')), false);

  const absent = mkWorld({ installed: [] });
  const out = release(absent).out;
  assert.doesNotMatch(out, /SKIPPING/);
  assert.equal(absent.calls().some((l) => l.startsWith('restart ')), false);
});

// ---- the trap this script runs into by construction -------------------------------------------------

test('strips the inherited GIT_* env -- post-merge calls this, and a hook exports GIT_DIR', () => {
  const w = mkWorld();
  const foreign = mkSourceRepo(); // stands in for the hook's own repository
  const foreignHeadBefore = git(foreign, 'rev-parse', 'HEAD');
  const foreignRefsBefore = git(foreign, 'show-ref');
  const sha = git(w.source, 'rev-parse', 'HEAD');

  // Exactly what scripts/git-hooks/post-merge will hand it.
  const r = release(w, [], {
    GIT_DIR: path.join(foreign, '.git'),
    GIT_INDEX_FILE: path.join(foreign, '.git', 'index'),
  });

  assert.equal(r.status, 0, r.err);
  // It cut from SPO_SOURCE_REPO, not from the hook's repo...
  assert.equal(fs.existsSync(path.join(w.releases, sha, 'marker.txt')), true);
  // ...and left the hook's repo untouched. Unstripped, `git clone`/`git -C` here would have acted
  // on GIT_DIR: on 2026-09-05 that same inheritance let the test suite write commits onto a live
  // branch and leave refs/heads/main a dangling symref (test/no-git-env-sweep.test.js).
  assert.equal(git(foreign, 'rev-parse', 'HEAD'), foreignHeadBefore, 'the hook repo\'s HEAD moved');
  assert.equal(git(foreign, 'show-ref'), foreignRefsBefore, 'the hook repo\'s refs changed');
});

// ---- the restart properties, inherited from scripts/git-hooks/post-merge ----------------------
//
// These moved here with the logic. post-merge used to own the "which units, and when" decision and
// had its own test file for it; under the release layout it decides only WHICH TREE may deploy and
// delegates the rest. Every property below was already paid for once -- the 2026-09-03 deploy hole
// in particular -- so they are re-homed rather than rewritten, and none is dropped.

test('restarts a unit that is running but DISABLED -- the 2026-09-03 deploy hole', () => {
  // Precisely the state measured on the box: active=active, enabled=disabled. Under an
  // `is-enabled`-only gate this restarted nothing at all, and said nothing about it -- the daemon
  // ran eight-hour-old code for a working day.
  const w = mkWorld({ installed: ['fake.service'], active: ['fake.service'], enabled: [] });
  const r = release(w);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(w.restarted(), ['fake.service']);
});

test('restarts an ENABLED unit that is not running -- restart starts it', () => {
  const w = mkWorld({ installed: ['fake.service'], active: [], enabled: ['fake.service'] });
  assert.equal(release(w).status, 0);
  assert.deepEqual(w.restarted(), ['fake.service']);
});

test('never gates on is-enabled alone -- that is the defect, and it must not come back', () => {
  // Textual, because the behavioural tests above can both pass while the gate is written the wrong
  // way round for some third state. The rule is "active OR enabled", never "enabled" alone.
  const src = fs.readFileSync(RELEASE_SH, 'utf8');
  const restartFn = src.slice(src.indexOf('restart_units()'), src.indexOf('cmd_list()'));
  assert.match(restartFn, /is-active/, 'the restart gate no longer consults is-active at all');
  assert.match(restartFn, /is-enabled/, 'the restart gate no longer consults is-enabled at all');
});

test('a unit still DRAINING is reported as already in flight, not skipped or restarted', () => {
  // A stop legitimately takes up to TimeoutStopSec=2820 while cards finish, and `is-active` exits
  // non-zero for `deactivating` -- so a naive gate reads it as "neither active nor enabled" and
  // skips, during a window that used to be 90s and is now most of an hour.
  const w = mkWorld({ installed: ['fake.service'] });
  fs.writeFileSync(
    path.join(w.bin, 'systemctl'),
    `#!/usr/bin/env bash
args=(); for a in "$@"; do [ "$a" = "--user" ] || args+=("$a"); done
echo "\${args[*]}" >> ${JSON.stringify(w.log)}
case "\${args[0]:-}" in
  list-unit-files) exit 0 ;;
  is-active) echo deactivating; exit 3 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 }
  );
  const r = release(w);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /is deactivating -- a restart is already in flight/);
  assert.equal(w.calls().some((l) => l.startsWith('restart ')), false, 'it restarted a unit mid-stop');
});

test('handles several units independently -- one absent does not skip the others', () => {
  const w = mkWorld({ units: 'absent.service present.service', installed: ['present.service'], active: ['present.service'] });
  assert.equal(release(w).status, 0);
  assert.deepEqual(w.restarted(), ['present.service']);
});

test('a failed restart does not abort the deploy, so the next unit still gets one', () => {
  // `set -euo pipefail` plus an unguarded systemctl would abandon the second unit on the first
  // failure, leaving half a deploy with a zero exit status.
  const w = mkWorld({
    units: 'first.service second.service',
    installed: ['first.service', 'second.service'],
    active: ['first.service', 'second.service'],
    restartFails: ['first.service'],
  });
  const r = release(w);
  assert.equal(r.status, 0, 'a failed restart aborted the deploy');
  assert.ok(w.restarted().includes('second.service'), 'the second unit was abandoned');
  assert.match(r.err || '', /failed to restart first\.service/);
});

test('the default unit list covers both pipeline services -- a third must not be silently undeployed', () => {
  const src = fs.readFileSync(RELEASE_SH, 'utf8');
  const m = /SPO_RELEASE_UNITS:-([^}]*)\}/.exec(src);
  assert.ok(m, 'release.sh no longer declares a default unit list -- update this guard');
  const units = m[1].trim().split(/\s+/).sort();
  assert.deepEqual(units, ['spo-pipeline-dashboard.service', 'spo-pipeline-daemon.service'].sort());
});

test('says which unit it restarted, so a deploy looks different from one that did nothing', () => {
  const w = mkWorld({ installed: ['fake.service'], active: ['fake.service'] });
  assert.match(release(w).out, /restarting fake\.service/);
});
