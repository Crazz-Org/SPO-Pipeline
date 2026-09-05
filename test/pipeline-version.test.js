'use strict';
// Tests for orchestrator/pipeline-version.js and the two places it is journalled.
//
// WHAT THIS FILE IS DEFENDING. The pipeline was rigorous about the PRODUCT's provenance and had
// no equivalent for itself: WORKTREE fetches, cuts from `origin/main`, journals `base-main` and
// refuses a red nightly, while `dispatcher-start` carried `pid` and `workers` only. So "which
// version of the pipeline produced this park?" was unanswerable after the fact -- and it is a
// live question, not a hypothetical one: dispatcher.js resolves DAEMON_PATH at every spawn, so a
// `git pull` with NO restart already puts new workers under an old dispatcher.
//
// REAL GIT REPOS, NOT FIXTURES. Every layout below is built by running real `git` through
// execFileSync (the suite's sanctioned real-process boundary -- test/no-real-spawn.js patches
// spawnSync only, and says so) and every expectation is `git rev-parse HEAD`'s own answer, not a
// value this file computed. A hand-built .git fixture would pin this module against my reading of
// git's on-disk format rather than against git.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn: realSpawn } = require('child_process');

require('./no-real-spawn');

const { readPipelineVersion, REPO_ROOT } = require('../orchestrator/pipeline-version');
const { createDispatcher } = require('../orchestrator/dispatcher');
const defaultConfig = require('../orchestrator/config');
const { gitEnv, mkTmp, writePoolDir, runDaemonWorker, readJournal } = require('./helpers');

// See test/dispatcher.test.js's own copy for the orphan-exit reasoning this repeats.
function neverExitsSpawn(cmd, args, opts) {
  return realSpawn(
    process.execPath,
    ['-e', 'const p = process.ppid; setInterval(() => { if (process.ppid !== p) process.exit(0); }, 50);'],
    { ...opts, stdio: 'ignore' }
  );
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();

// A throwaway repo with one commit. `-c` overrides rather than a config write so the box's own
// user.name/user.email (and any commit.gpgsign) can neither be required nor disturbed.
function mkRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: dir, env: gitEnv() });
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one'],
    { cwd: dir, env: gitEnv() }
  );
  return dir;
}

// ---- the module, against real git ------------------------------------------------------------

test('ordinary checkout (.git directory, loose ref): sha and ref match git rev-parse', () => {
  const dir = mkRepo('spo-pv-plain-');
  assert.deepEqual(readPipelineVersion(dir), { sha: git(dir, 'rev-parse', 'HEAD'), ref: 'refs/heads/main' });
});

test('packed-refs-only checkout: still resolves (a fresh clone has no loose ref for its branch)', () => {
  const dir = mkRepo('spo-pv-packed-');
  execFileSync('git', ['pack-refs', '--all'], { cwd: dir, env: gitEnv() });
  // Guards the test itself: if git ever stops removing the loose ref, this case silently stops
  // exercising the packed-refs branch and would pass for the wrong reason.
  assert.equal(fs.existsSync(path.join(dir, '.git', 'refs', 'heads', 'main')), false, 'pack-refs left the loose ref');
  assert.equal(readPipelineVersion(dir).sha, git(dir, 'rev-parse', 'HEAD'));
});

test('detached HEAD: sha resolves, ref is null (this is what a release checkout looks like)', () => {
  const dir = mkRepo('spo-pv-detached-');
  execFileSync('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: dir, env: gitEnv() });
  assert.deepEqual(readPipelineVersion(dir), { sha: git(dir, 'rev-parse', 'HEAD'), ref: null });
});

test('linked worktree (.git FILE + commondir): refs live in the common dir, and are found there', () => {
  const dir = mkRepo('spo-pv-wt-');
  const wt = path.join(dir, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: dir, env: gitEnv() });
  assert.equal(fs.statSync(path.join(wt, '.git')).isFile(), true, 'expected a .git FILE in a linked worktree');
  assert.deepEqual(readPipelineVersion(wt), { sha: git(wt, 'rev-parse', 'HEAD'), ref: 'refs/heads/side' });
});

test('not a repo at all: {sha: null, ref: null}, never a throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-pv-none-'));
  assert.deepEqual(readPipelineVersion(dir), { sha: null, ref: null });
});

test('unreadable HEAD: {sha: null, ref: null}, never a throw', () => {
  const dir = mkRepo('spo-pv-broken-');
  fs.rmSync(path.join(dir, '.git', 'HEAD'));
  assert.deepEqual(readPipelineVersion(dir), { sha: null, ref: null });
});

// THE PRODUCTION PATH. Every case above passes a repoRoot; the daemon calls it with none, and the
// default (__dirname/..) is the only thing that makes the journalled sha this checkout's own.
// A default resolved from process.cwd() would pass every test above and report the PRODUCT
// worktree's sha in production, where cwdForStep points there.
test('default repoRoot is THIS checkout -- matches git rev-parse HEAD in the repo root', () => {
  assert.equal(readPipelineVersion().sha, git(REPO_ROOT, 'rev-parse', 'HEAD'));
  assert.equal(REPO_ROOT, git(REPO_ROOT, 'rev-parse', '--show-toplevel'));
});

// ---- journalled at dispatcher-start ------------------------------------------------------------

test('dispatcher-start records the pipeline sha and ref', { timeout: 20000 }, async () => {
  const queueDir = mkTmp('spo-pv-q-');
  const journalDir = mkTmp('spo-pv-j-');
  const poolDir = mkTmp('spo-pv-pool-');
  writePoolDir(poolDir, [{ name: 'pool1', state: 'healthy' }]);

  const dispatcher = createDispatcher(queueDir, journalDir, {
    ...defaultConfig,
    dryRun: true,
    workers: 1,
    pollIntervalMs: 50,
    claudeAccountsDir: poolDir,
    // A real stand-in process for the scanner, self-terminating if orphaned -- the same
    // technique test/dispatcher.test.js's neverExitsSpawn uses, and for the same measured reason
    // (a `detached: true` stand-in survives a SIGKILL of the test runner's own group). No worker
    // ever spawns here: the queue is empty and this test is about the START line only.
    deps: { spawnScanner: neverExitsSpawn },
  });
  const runPromise = dispatcher.run();
  dispatcher.stop({ reason: 'test-done' });
  await runPromise;

  const events = fs
    .readFileSync(path.join(journalDir, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const start = events.find((e) => e.event === 'dispatcher-start');
  assert.ok(start, 'no dispatcher-start event');
  assert.equal(start.pipelineSha, git(REPO_ROOT, 'rev-parse', 'HEAD'));
  assert.equal(start.pipelineRef, readPipelineVersion().ref);
});

// ---- journalled per card, by the WORKER itself --------------------------------------------------

test('a worker writes its own pipeline-version line, before anything it could park on', { timeout: 60000 }, () => {
  const journalDir = mkTmp('spo-pv-wj-');
  const taskDir = path.join(journalDir, 'pv-card');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id: 'pv-card', kind: 'synthetic', shadow: { forceState: 'DONE' } })
  );

  const res = runDaemonWorker(taskDir, journalDir);
  assert.equal(res.status, 0, `worker did not finish DONE: ${res.stderr}`);

  const journal = readJournal(journalDir, 'pv-card');
  const idx = journal.findIndex((e) => e.event === 'pipeline-version');
  assert.ok(idx !== -1, 'worker wrote no pipeline-version line');
  // FIRST, not merely present: a card that parks in its very first step must still carry the
  // provenance of the code that parked it.
  assert.equal(idx, 0, `pipeline-version was not the worker's first line: ${JSON.stringify(journal[0])}`);
  assert.equal(journal[idx].sha, git(REPO_ROOT, 'rev-parse', 'HEAD'));
  assert.equal(typeof journal[idx].pid, 'number');
  // The worker resolves its OWN sha from its own __dirname -- it is not handed one by the
  // dispatcher. That is what makes an old-dispatcher/new-worker pull visible rather than hidden.
  assert.equal(journal[idx].ref, readPipelineVersion().ref);
});

// ---- the loose-ref-BEFORE-packed-refs order, which is reachable on any box that has run gc ------

test('loose ref wins over a stale packed-refs entry -- the order is the whole point', () => {
  const dir = mkRepo('spo-pv-both-');
  // `git pack-refs` writes packed-refs and drops the loose ref; the NEXT commit writes a fresh
  // loose ref and leaves the packed entry behind, now stale. `git gc --auto` packs refs and runs
  // on ordinary pulls and commits, so this is the steady state of any long-lived checkout --
  // including ~/SPO-Pipeline itself, which is the one this module reports on in production.
  execFileSync('git', ['pack-refs', '--all'], { cwd: dir, env: gitEnv() });
  const stale = git(dir, 'rev-parse', 'HEAD');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'two'], { cwd: dir, env: gitEnv() });
  const current = git(dir, 'rev-parse', 'HEAD');

  assert.notEqual(stale, current, 'the second commit did not move HEAD -- this test proves nothing');
  assert.equal(fs.existsSync(path.join(dir, '.git', 'refs', 'heads', 'main')), true, 'no loose ref was written');
  assert.match(fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8'), new RegExp(stale), 'packed-refs is not stale');

  // Reading packed-refs first would report `stale` here: a silently WRONG provenance sha, which is
  // the one failure this module exists to prevent.
  assert.equal(readPipelineVersion(dir).sha, current);
});

test('a ref file that is not a sha is refused rather than reported as one', () => {
  const dir = mkRepo('spo-pv-symref-');
  // `git symbolic-ref` writes a `ref: ...` line where readRef expects 40 hex. Without SHA_RE the
  // literal string "ref: refs/heads/other" would be journalled as this pipeline's commit.
  execFileSync('git', ['symbolic-ref', 'refs/heads/main', 'refs/heads/other'], { cwd: dir, env: gitEnv() });
  assert.equal(readPipelineVersion(dir).sha, null);
});

test('an empty HEAD is refused rather than reported as an empty sha', () => {
  const dir = mkRepo('spo-pv-emptyhead-');
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), '\n');
  assert.deepEqual(readPipelineVersion(dir), { sha: null, ref: null });
});

test('a ref file with trailing whitespace/CRLF still resolves', () => {
  const dir = mkRepo('spo-pv-crlf-');
  const sha = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), `${sha}\r\n`);
  assert.equal(readPipelineVersion(dir).sha, sha);
});

test('an annotated tag in packed-refs (a ^peeled line) does not derail the scan', () => {
  const dir = mkRepo('spo-pv-peeled-');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', 'v1', '-m', 'v1'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['pack-refs', '--all'], { cwd: dir, env: gitEnv() });
  const packed = fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8');
  assert.match(packed, /^\^/m, 'git wrote no peeled line -- this test is not exercising that path');
  assert.equal(readPipelineVersion(dir).sha, git(dir, 'rev-parse', 'HEAD'));
});
