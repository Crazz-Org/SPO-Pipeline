'use strict';
// scripted.js -- the "spawn a command, return {exit, stdoutTail}" step interface.
//
// Shadow mode (ctx.shadowMode === true): never spawns anything. Reads the next value for
// `fixtureKey` from the task's shadow fixture (see fixture.js) as the exit code, optionally
// preceded by an artificial delay read from `delays.<fixtureKey>` (ms) -- used by the step-
// deadline test to simulate a slow step without a real subprocess.
//
// ctx.dryRun (daemon.js's --dry-run flag, real-mode semantics without spawning): every scripted
// step is "fixture-free assumed success" -- exit 0, no command run -- so a synthetic card can
// walk the whole lifecycle to DONE with zero subprocesses. This is the scripted-step half of
// --dry-run; the LLM half (building the filled prompt + argv without spawning `claude`) lives in
// steps/llm.js's runLlm.
//
// Real mode (ctx.shadowMode === false && ctx.dryRun === false, daemon.js's --real flag or a
// direct unit test): one function per orchestrator state that has scripted work (realWorktree,
// realCheck, realPushPr, realGate, realCiChecks, realMerge, realFinish below), each building the
// exact product npm-alias / git / gh argv the state needs, spawning it through the same
// injectable-runner pattern steps/llm.js already uses (`deps.spawnSync`, production code never
// passing it -- see invokeClaudeReal), and judging the result on its exit code alone (principle
// 1, doc/state-machine-spec.md). Every spawn journals a compact {state, argv (first 6 tokens),
// exit, ms} event via appendEvent and appends its stdout (falling back to stderr) tail to
// journal/<id>/logs/<STATE>.log -- see spawnStep. state-machine.js's handlers dispatch to these
// functions instead of the generic runScripted()+fixture path once neither shadow nor dry-run
// applies; runScripted() itself is otherwise unchanged from the shadow-mode skeleton.
//
// orchestrator/README.md "Real scripted steps" is the narrative walkthrough (ordering, cwd
// policy, the WORKTREE claim-after-worktree-creation rule, --real).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { appendEvent } = require('../journal');
const { ParkSignal } = require('../park-signal');
const { classifyCiFailure } = require('../ci-cause-table');
const { moveCard } = require('../board');

function lastLines(text, n = 20) {
  if (!text) return '';
  return text.split('\n').slice(-n).join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScripted(ctx, fixtureKey, opts = {}) {
  const { defaultExit = 0, command = null, args = [] } = opts;

  if (ctx.shadowMode) {
    const exit = ctx.fixture(fixtureKey, defaultExit);
    const delay = ctx.fixture(`delays.${fixtureKey}`, 0);
    if (delay > 0) await sleep(delay);
    return { exit, stdoutTail: `[shadow] ${fixtureKey} -> exit ${exit}` };
  }

  if (ctx.dryRun) {
    return { exit: 0, stdoutTail: `[dry-run] ${fixtureKey} -> assumed success` };
  }

  if (!command) {
    throw new Error(
      `scripted.js: no real command configured for "${fixtureKey}" -- non-shadow execution ` +
        `is not implemented in this skeleton (shadow mode only for now).`
    );
  }
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const exit = result.status === null || result.status === undefined ? 1 : result.status;
  return { exit, stdoutTail: lastLines(result.stdout || result.stderr || '') };
}

// ---- real mode: shared spawn primitive --------------------------------------------------

// `deps.spawnSync` is the test injection point (same convention as steps/llm.js's
// invokeClaudeReal) -- production code never passes it, so a real call always spawns the real
// binary on PATH.
function runSync(deps, command, args, opts = {}) {
  const spawnSyncFn = (deps && deps.spawnSync) || spawnSync;
  return spawnSyncFn(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function appendSpawnLog(taskDir, state, header, text) {
  const dir = path.join(taskDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${state}.log`);
  fs.appendFileSync(file, `----- ${header} -----\n${text || ''}\n\n`);
}

// Spawns one real command for `state`, journals {state, argv (first 6 tokens), exit, ms} as a
// 'spawn' event, appends its stdout (falling back to stderr) to journal/<id>/logs/<STATE>.log,
// and returns the full result for the caller to interpret. The one place every real command in
// this file actually runs.
function spawnStep(ctx, deps, state, command, args, opts = {}) {
  const start = Date.now();
  const result = runSync(deps, command, args, opts);
  const ms = Date.now() - start;

  let exit;
  if (result && result.error) exit = -1;
  else exit = result.status === null || result.status === undefined ? 1 : result.status;

  const stdout = (result && result.stdout) || '';
  const stderr = (result && result.stderr) || '';
  const tail = lastLines(stdout || stderr);

  appendEvent(ctx.taskDir, state, 'spawn', { argv: [command, ...args].slice(0, 6), exit, ms });
  appendSpawnLog(ctx.taskDir, state, [command, ...args].join(' '), stdout || stderr);

  return { exit, stdout, stderr, stdoutTail: tail, ms };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function splitLines(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---- WORKTREE ------------------------------------------------------------------------------
//
// fetch origin -> refuse if the nightly says main is red -> `git worktree add` off origin/main
// -> `npm ci` (a product worktree carries no node_modules) -> THEN claim the card
// (`npm run board:take`). Claim runs last, from inside the fresh worktree, because the npm
// aliases need a product cwd and the human's main SPO-WebClient checkout must never run them --
// see orchestrator/README.md "Real scripted steps" for the rationale in full.

// git worktree list --porcelain prints one `worktree <path>` line per registered worktree
// (plus HEAD/branch/bare lines this caller doesn't need). Paths are compared resolved -- git
// prints an absolute, symlink-resolved path, and `worktreePath` here is built from config, so
// normalize both sides before comparing rather than assume they're already byte-identical.
function worktreeListPaths(porcelainOutput) {
  return (porcelainOutput || '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length).trim()));
}

// card #424 -- "retry always restarts at INTAKE" bit us three times today: runTask always
// restarts a task at INTAKE (state-machine.js), so retrying anything parked past WORKTREE
// collided with the previous attempt's own worktree/branch and failed worktree-add-failed. The
// pipeline owns the namespace worktrees/<taskId> + branch claude-pipe/<taskId> exclusively (no
// human or other process ever creates either), so within that namespace it may clean its own
// leftovers before trying again -- runTask's restart-at-INTAKE behaviour is otherwise untouched.
// Order matters -- each rule guards the one after it:
//   1. Worktree path leftover (registered in `git worktree list` OR present on disk at the
//      exact task path): a dirty working tree (`git status --porcelain` non-empty) is NEVER
//      destroyed -- it might be uncommitted human-or-unknown work -- and parks
//      worktree-dirty-leftover so a maintainer can look. Clean -> `git worktree remove`, then
//      `git worktree prune` to also clear a stale registration whose directory is already gone
//      (nothing on disk to be dirty in that case, so the status check is skipped for it).
//   2. Local branch leftover (claude-pipe/<id>): deleted with `branch -D` ONLY when its tip is
//      an ancestor of origin/main (merged, or the previous attempt never advanced past it) OR
//      equals origin/claude-pipe/<id>'s own tip (fully pushed, nothing local-only). Any other
//      tip means local-only commits exist that this run never produced and cannot vouch for --
//      parks branch-unmerged-leftover rather than guess.
//   3. Remote branch leftover (origin/claude-pipe/<id>, checked against the fetch this step
//      already ran): deleted with `push origin --delete`. This is always a prior, superseded
//      attempt in the pipeline's own namespace, regenerated fresh every pass -- leaving it makes
//      this attempt's own `push -u origin <branch>` (PUSH_PR) non-fast-forward. If a PR was open
//      from it, deleting the branch closes that PR; PUSH_PR opens a fresh one on the retry. This
//      step is independent of step 2 (it also runs when there was no local branch left to clean,
//      or when step 2's own remote-tip lookup already answered the same question -- one call is
//      redone here rather than threaded through, so each of the three rules stays independently
//      readable and testable).
//   4. Nothing found at any of the three checks -> no cleanup call is ever issued; the add below
//      runs exactly as it did before this fix.
function sweepWorktreeLeftovers(ctx, deps, { productRepo, worktreePath, branch }) {
  // -- 1. worktree path -----------------------------------------------------------------------
  const list = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'worktree', 'list', '--porcelain']);
  const registered = list.exit === 0 && worktreeListPaths(list.stdout).includes(path.resolve(worktreePath));
  const existsOnDisk = fs.existsSync(worktreePath);

  if (registered || existsOnDisk) {
    if (existsOnDisk) {
      const status = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', worktreePath, 'status', '--porcelain']);
      if (status.exit !== 0 || status.stdout.trim() !== '') {
        // A dirty leftover is, by construction, a previous attempt's own uncommitted work (this
        // namespace is pipeline-exclusive -- see the header above): push it to a durable wip/
        // ref before ever destroying the worktree, rather than parking and leaving the diff to
        // depend on this local directory surviving. Only fall back to the old park-and-wait
        // behaviour if that preservation itself fails (no network, origin refuses, ...) -- never
        // destroy what wasn't first saved somewhere durable.
        const preserved = preserveWorktreeWip(ctx, deps, { worktreePath, reason: 'leftover', state: 'WORKTREE' });
        if (!preserved) {
          throw new ParkSignal('worktree-dirty-leftover', { worktreePath, statusExit: status.exit, statusTail: status.stdoutTail });
        }
        appendEvent(ctx.taskDir, 'WORKTREE', 'leftover-wip-preserved', preserved);
      }
      const remove = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'worktree', 'remove', '--force', worktreePath]);
      if (remove.exit !== 0) {
        throw new ParkSignal('worktree-cleanup-failed', { step: 'worktree-remove', exit: remove.exit });
      }
    }
    // Registered-only (directory already gone by some other means) or just-removed above --
    // either way, prune clears the administrative leftover git worktree list would otherwise
    // keep reporting.
    spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'worktree', 'prune']);
    appendEvent(ctx.taskDir, 'WORKTREE', 'leftover-worktree-removed', { worktreePath, wasOnDisk: existsOnDisk });
  }

  // -- 2. local branch --------------------------------------------------------------------------
  const localRef = `refs/heads/${branch}`;
  const localRevParse = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'rev-parse', '--verify', '--quiet', localRef]);
  if (localRevParse.exit === 0) {
    const localSha = localRevParse.stdout.trim();
    const ancestor = spawnStep(ctx, deps, 'WORKTREE', 'git', [
      '-C',
      productRepo,
      'merge-base',
      '--is-ancestor',
      localRef,
      'origin/main',
    ]);
    let safe = ancestor.exit === 0;
    let remoteSha = null;
    if (!safe) {
      const remoteRevParse = spawnStep(ctx, deps, 'WORKTREE', 'git', [
        '-C',
        productRepo,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${branch}`,
      ]);
      remoteSha = remoteRevParse.exit === 0 ? remoteRevParse.stdout.trim() : null;
      safe = remoteSha !== null && remoteSha === localSha;
    }
    if (!safe) {
      throw new ParkSignal('branch-unmerged-leftover', { branch, localSha, remoteSha });
    }
    const del = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'branch', '-D', branch]);
    if (del.exit !== 0) throw new ParkSignal('worktree-cleanup-failed', { step: 'branch-delete', exit: del.exit });
    appendEvent(ctx.taskDir, 'WORKTREE', 'leftover-branch-deleted', { branch, sha: localSha });
  }

  // -- 3. remote branch -------------------------------------------------------------------------
  const remoteCheck = spawnStep(ctx, deps, 'WORKTREE', 'git', [
    '-C',
    productRepo,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);
  if (remoteCheck.exit === 0) {
    const remoteSha = remoteCheck.stdout.trim();
    const del = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'push', 'origin', '--delete', branch]);
    if (del.exit !== 0) throw new ParkSignal('worktree-cleanup-failed', { step: 'remote-branch-delete', exit: del.exit });
    appendEvent(ctx.taskDir, 'WORKTREE', 'remote-branch-cleaned', { branch, sha: remoteSha });
  }
}

// preserveWorktreeWip(ctx, deps, {worktreePath, reason, state}) -> {ref, sha} | null
//
// Real mode only. If `worktreePath` has uncommitted changes, commits them (`git add -A` + a
// wip(<id>) commit) and pushes to a throwaway `wip/<id>-<ts>` branch on origin, so the diff
// survives independently of the local worktree directory -- see the module header and
// doc/state-machine-spec.md's note on card #385, where 620 lines of IMPLEMENT work were stranded
// in a worktree with no durable copy anywhere else. `wip/` is a deliberately different namespace
// from `claude-pipe/<id>` (the pipeline's own regenerate-and-delete branch): sweepWorktreeLeftovers'
// rules 2/3 assume claude-pipe/<id> is disposable and safe to force-delete on the next attempt --
// pushing a WIP there would make THIS branch look like an unmerged leftover on the very next
// retry and park branch-unmerged-leftover instead of cleaning up.
//
// Never blocks or throws: a park is already terminal by the time finalizePark calls this, and the
// dirty-leftover sweep call site treats a failed preservation as "fall back to the old
// park-and-wait behaviour", not as a harder failure. Returns null (no event beyond the failure
// one, if any) when there is nothing to preserve (no worktree, already clean) or a step failed.
function preserveWorktreeWip(ctx, deps, { worktreePath, reason, state = 'PARKED' } = {}) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;

  const status = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'status', '--porcelain']);
  if (status.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'wip-preserve-failed', { step: 'status', exit: status.exit });
    return null;
  }
  if (status.stdout.trim() === '') return null; // clean tree -- nothing to preserve

  const add = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'add', '-A']);
  if (add.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'wip-preserve-failed', { step: 'add', exit: add.exit });
    return null;
  }

  const messageFile = path.join(ctx.taskDir, 'wip-message.txt');
  fs.writeFileSync(messageFile, `wip(${ctx.id}): parked${reason ? ` -- ${reason}` : ''}\n`);
  const commit = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'commit', '-F', messageFile]);
  if (commit.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'wip-preserve-failed', { step: 'commit', exit: commit.exit });
    return null;
  }

  const revParse = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
  const wipRef = `wip/${ctx.id}-${Date.now()}`;
  const push = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'push', 'origin', `HEAD:refs/heads/${wipRef}`]);
  if (push.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'wip-preserve-failed', { step: 'push', exit: push.exit });
    return null;
  }

  const preserved = { ref: wipRef, sha: revParse.exit === 0 ? revParse.stdout.trim() : null };
  appendEvent(ctx.taskDir, state, 'wip-preserved', preserved);
  return preserved;
}

async function realWorktree(ctx, deps = {}) {
  const config = ctx.config;
  const productRepo = config.productRepo;
  const worktreesDir = config.pipelineWorktreesDir;
  const taskId = ctx.id;
  const issue = ctx.task && ctx.task.issue;
  const branch = `claude-pipe/${taskId}`;
  const worktreePath = path.join(worktreesDir, taskId);

  const fetch = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'fetch', 'origin']);
  if (fetch.exit !== 0) throw new ParkSignal('worktree-fetch-failed', { exit: fetch.exit });

  const revParse = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'rev-parse', 'origin/main']);
  if (revParse.exit !== 0) throw new ParkSignal('worktree-rev-parse-failed', { exit: revParse.exit });
  const originMainSha = revParse.stdout.trim();

  const nightly = readJsonSafe(path.join(config.spoBenchDir, 'nightly', 'latest.json'));
  if (nightly && nightly.verdict === 'FAIL' && nightly.sha === originMainSha) {
    throw new ParkSignal('nightly-main-red', { sha: originMainSha });
  }

  sweepWorktreeLeftovers(ctx, deps, { productRepo, worktreePath, branch });

  fs.mkdirSync(worktreesDir, { recursive: true });
  const add = spawnStep(ctx, deps, 'WORKTREE', 'git', [
    '-C',
    productRepo,
    'worktree',
    'add',
    worktreePath,
    '-b',
    branch,
    'origin/main',
  ]);
  if (add.exit !== 0) throw new ParkSignal('worktree-add-failed', { exit: add.exit });

  // Every later real step (CHECK/PUSH_PR/GATE/... and PLAN/IMPLEMENT via config.cwdForStep)
  // reads this back off ctx.task -- the one place a fresh worktree's path becomes known.
  ctx.task.worktreePath = worktreePath;
  ctx.task.branch = branch;

  const ci = spawnStep(ctx, deps, 'WORKTREE', 'npm', ['ci'], { cwd: worktreePath });
  if (ci.exit !== 0) throw new ParkSignal('worktree-npm-ci-failed', { exit: ci.exit });

  const claim = spawnStep(ctx, deps, 'WORKTREE', 'npm', ['run', 'board:take', '--', String(issue)], {
    cwd: worktreePath,
  });
  if (claim.exit === 0) {
    // Kanban piloting: the worktree now exists and cwd for board:move -- move the card to
    // "Planning" (the state PLAN, next, belongs to). Never blocks (board.js's own rule).
    moveCard(ctx, deps, 'WORKTREE');
    return 'PLAN';
  }
  if (claim.exit === 3) throw new ParkSignal('claim-lost', { exit: claim.exit });
  if (claim.exit === 4 || claim.exit === 5) throw new ParkSignal('claim-rate-limited', { exit: claim.exit });
  if (claim.exit === 6) throw new ParkSignal('claim-finished-worktree', { exit: claim.exit });
  throw new ParkSignal('claim-unrecognized-exit', { exit: claim.exit });
}

// ---- CHECK ---------------------------------------------------------------------------------
//
// typecheck, lint, coverage:changed, in that order, in the worktree; the first non-zero exit
// names its own alias and goes to DIAGNOSE (never PARKED -- matches the shadow-mode contract).
const CHECK_ALIASES = ['typecheck', 'lint', 'coverage:changed'];

async function realCheck(ctx, deps = {}) {
  const worktreePath = ctx.task.worktreePath;
  moveCard(ctx, deps, 'CHECK'); // kanban piloting: "Checks & PR" -- covers PUSH_PR too, no separate move there
  for (const alias of CHECK_ALIASES) {
    const r = spawnStep(ctx, deps, 'CHECK', 'npm', ['run', alias], { cwd: worktreePath });
    if (r.exit !== 0) {
      appendEvent(ctx.taskDir, 'CHECK', 'check-failed', { alias, exit: r.exit });
      return 'DIAGNOSE';
    }
  }
  return 'PUSH_PR';
}

// ---- PUSH_PR --------------------------------------------------------------------------------

function commitMessage(ctx) {
  const title = (ctx.task && ctx.task.title) || `Card #${ctx.task && ctx.task.issue}`;
  const issue = ctx.task && ctx.task.issue;
  return `${title}\n\nCloses #${issue}\n`;
}

function prBody(ctx) {
  const issue = ctx.task && ctx.task.issue;
  return [`Closes #${issue}`, '', `_pipeline: claude-pipe/${ctx.id}_`, ''].join('\n');
}

function parsePrNumber(stdout) {
  const m = (stdout || '').match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function realPushPr(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;
  const title = (ctx.task && ctx.task.title) || `Card #${ctx.task && ctx.task.issue}`;
  const branch = (ctx.task && ctx.task.branch) || `claude-pipe/${ctx.id}`;

  const messageFile = path.join(ctx.taskDir, 'commit-message.txt');
  fs.writeFileSync(messageFile, commitMessage(ctx));

  const add = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'add', '-A']);
  if (add.exit !== 0) throw new ParkSignal('push-pr-failed', { step: 'add', exit: add.exit });

  const commit = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'commit', '-F', messageFile]);
  if (commit.exit !== 0) throw new ParkSignal('push-pr-failed', { step: 'commit', exit: commit.exit });

  const push = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'push', '-u', 'origin', branch]);
  if (push.exit !== 0) throw new ParkSignal('push-pr-failed', { step: 'push', exit: push.exit });

  const bodyFile = path.join(ctx.taskDir, 'pr-body.md');
  fs.writeFileSync(bodyFile, prBody(ctx));

  // --head/--base are required here, not optional: every other command in this function targets
  // the worktree explicitly via `git -C worktreePath`, but `gh pr create` has no `-C`/cwd of its
  // own -- it infers the head branch from the process's own cwd, which is the daemon's cwd
  // (~/SPO-Pipeline, itself a git repo on `main`), not `worktreePath`. Without an explicit
  // --head, gh resolved head == base == main and refused with "No commits between main and main
  // (createPullRequest)" -- reproduced on card issue-247's 4th real pass: CHECK green, branch
  // `claude-pipe/issue-247` pushed and waiting, yet pr-create still parked push-pr-failed.
  const create = spawnStep(ctx, deps, 'PUSH_PR', 'gh', [
    'pr',
    'create',
    '--repo',
    config.ghRepo,
    '--title',
    title,
    '--body-file',
    bodyFile,
    '--head',
    branch,
    '--base',
    'main',
  ]);
  if (create.exit !== 0) throw new ParkSignal('push-pr-failed', { step: 'pr-create', exit: create.exit });

  const prNumber = parsePrNumber(create.stdout);
  if (!prNumber) {
    throw new ParkSignal('push-pr-failed', { step: 'pr-number-unparsed', stdoutTail: create.stdoutTail });
  }
  ctx.prNumber = prNumber;
  appendEvent(ctx.taskDir, 'PUSH_PR', 'pr-created', { prNumber });

  return 'GATE';
}

// ---- GATE -----------------------------------------------------------------------------------
//
// `npm run gate`: 0 PASS -> CI_CHECKS, 1 fail -> DIAGNOSE, 2 dirty / 3 worker down / 4 timeout
// -> PARKED. Mirrors handleGate's own shadow-mode cause table exactly.
async function realGate(ctx, deps = {}) {
  const worktreePath = ctx.task.worktreePath;
  moveCard(ctx, deps, 'GATE'); // kanban piloting
  const r = spawnStep(ctx, deps, 'GATE', 'npm', ['run', 'gate'], { cwd: worktreePath });
  if (r.exit === 0) return 'CI_CHECKS';
  if (r.exit === 1) return 'DIAGNOSE';
  if (r.exit === 2) throw new ParkSignal('gate-dirty-tree', { exit: r.exit });
  if (r.exit === 3) throw new ParkSignal('gate-worker-down', { exit: r.exit });
  if (r.exit === 4) throw new ParkSignal('gate-timeout', { exit: r.exit });
  throw new ParkSignal('gate-unrecognized-exit', { exit: r.exit });
}

// ---- CI_CHECKS ------------------------------------------------------------------------------
//
// (a) read the check-runs for HEAD via `gh api`, map the one failing name through the shared
//     ci-cause-table.js (the same table handleCiChecks' shadow-fixture path uses).
// (b) only if (a) was green: the main-moved test -- baseMain from the bench's own verdict for
//     this HEAD sha, intersect what origin/main touched since baseMain with what the branch
//     itself touched; non-empty -> merge origin/main and re-CHECK (once; the nightly-red and
//     "already used" guards mirror handleCiChecks' shadow-mode ones exactly).
async function gitRevParse(ctx, deps, worktreePath, ref) {
  const r = spawnStep(ctx, deps, 'CI_CHECKS', 'git', ['-C', worktreePath, 'rev-parse', ref]);
  if (r.exit !== 0) throw new ParkSignal('ci-checks-rev-parse-failed', { ref, exit: r.exit });
  return r.stdout.trim();
}

const CI_GREEN_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

async function realCiChecks(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;

  const headSha = await gitRevParse(ctx, deps, worktreePath, 'HEAD');

  const checkRuns = spawnStep(ctx, deps, 'CI_CHECKS', 'gh', [
    'api',
    `repos/${config.ghRepo}/commits/${headSha}/check-runs`,
  ]);
  if (checkRuns.exit !== 0) throw new ParkSignal('ci-checks-read-failed', { exit: checkRuns.exit });

  const parsed = (() => {
    try {
      return JSON.parse(checkRuns.stdout);
    } catch {
      return null;
    }
  })();
  const runs = parsed && Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
  const checks = runs.map((r) => ({ name: r.name, conclusion: r.conclusion }));
  const failing = checks.find((c) => c.conclusion && !CI_GREEN_CONCLUSIONS.has(c.conclusion));

  if (failing) {
    appendEvent(ctx.taskDir, 'CI_CHECKS', 'check-failed', { check: failing.name });
    const outcome = classifyCiFailure(failing.name);
    if (outcome.kind === 'park') throw new ParkSignal(outcome.reason, { check: failing.name });
    return outcome.nextState;
  }
  appendEvent(ctx.taskDir, 'CI_CHECKS', 'checks-green', { headSha, checks });

  const verdict = readJsonSafe(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`));
  const baseMain = verdict && verdict.baseMain;
  if (!baseMain) return 'VALIDATE'; // nothing recorded to compare against -- treat as not moved

  const diffMain = spawnStep(ctx, deps, 'CI_CHECKS', 'git', [
    '-C',
    worktreePath,
    'diff',
    '--name-only',
    `${baseMain}..origin/main`,
  ]);
  const diffBranch = spawnStep(ctx, deps, 'CI_CHECKS', 'git', [
    '-C',
    worktreePath,
    'diff',
    '--name-only',
    'origin/main...HEAD',
  ]);

  const filesMain = new Set(splitLines(diffMain.stdout));
  const filesBranch = splitLines(diffBranch.stdout);
  const moved = filesBranch.some((f) => filesMain.has(f));

  if (!moved) return 'VALIDATE';

  const nightly = readJsonSafe(path.join(config.spoBenchDir, 'nightly', 'latest.json'));
  const originMainSha = await gitRevParse(ctx, deps, worktreePath, 'origin/main');
  if (nightly && nightly.verdict === 'FAIL' && nightly.sha === originMainSha) {
    throw new ParkSignal('main-red-no-merge', {});
  }
  if (ctx.counters.mainMoveUsed) {
    throw new ParkSignal('main-moved-twice', {});
  }
  ctx.counters.mainMoveUsed = true;

  const merge = spawnStep(ctx, deps, 'CI_CHECKS', 'git', ['-C', worktreePath, 'merge', 'origin/main']);
  if (merge.exit !== 0) throw new ParkSignal('main-moved-merge-failed', { exit: merge.exit });

  appendEvent(ctx.taskDir, 'CI_CHECKS', 'main-moved-merge', {});
  return 'CHECK';
}

// ---- MERGE ----------------------------------------------------------------------------------
//
// `gh pr merge --merge` enqueues (never --delete-branch -- see orchestrator/README.md); then
// `npm run pr:wait`, with exactly one bounded re-wait on "still open" (exit 4), matching
// handleMerge's own shadow-mode logic.
async function realMerge(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;
  const prNumber = ctx.prNumber;

  moveCard(ctx, deps, 'MERGE'); // kanban piloting

  const enqueue = spawnStep(ctx, deps, 'MERGE', 'gh', [
    'pr',
    'merge',
    String(prNumber),
    '--repo',
    config.ghRepo,
    '--merge',
  ]);
  appendEvent(ctx.taskDir, 'MERGE', 'pr-merge-enqueue', { exit: enqueue.exit });
  if (enqueue.exit !== 0) throw new ParkSignal('pr-merge-enqueue-failed', { exit: enqueue.exit });

  const w1 = spawnStep(ctx, deps, 'MERGE', 'npm', ['run', 'pr:wait', '--', String(prNumber)], { cwd: worktreePath });
  appendEvent(ctx.taskDir, 'MERGE', 'pr-wait', { attempt: 1, exit: w1.exit });
  if (w1.exit === 0) return 'FINISH';
  if (w1.exit === 1) throw new ParkSignal('pr-closed-unmerged', { exit: w1.exit });
  if (w1.exit === 4) {
    const w2 = spawnStep(ctx, deps, 'MERGE', 'npm', ['run', 'pr:wait', '--', String(prNumber)], { cwd: worktreePath });
    appendEvent(ctx.taskDir, 'MERGE', 'pr-wait', { attempt: 2, exit: w2.exit, bounded: true });
    if (w2.exit === 0) return 'FINISH';
    throw new ParkSignal('merge-queue-not-landing', { lastExit: w2.exit });
  }
  throw new ParkSignal('pr-wait-unrecognized-exit', { exit: w1.exit });
}

// ---- FINISH ---------------------------------------------------------------------------------
//
// Board sync (Done + a short comment) runs from the worktree cwd, exactly like WORKTREE's claim
// -- the same "npm aliases need a product cwd" rule -- and BEFORE the worktree is removed.
function finalComment(ctx) {
  const lines = [`Merged via claude-pipe/${ctx.id}.`];
  if (ctx.prNumber) lines.push(`PR #${ctx.prNumber}.`);
  lines.push('Pipeline run complete.');
  return lines.join('\n') + '\n';
}

function sumJournalCost(taskDir) {
  const file = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(file)) return 0;
  let total = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.event === 'llm-call' && typeof event.costUsd === 'number') total += event.costUsd;
    } catch {
      // malformed line -- skip, never fail FINISH over a journal read
    }
  }
  return total;
}

async function realFinish(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;
  const issue = ctx.task && ctx.task.issue;

  const move = spawnStep(ctx, deps, 'FINISH', 'npm', ['run', 'board:move', '--', String(issue), 'Done'], {
    cwd: worktreePath,
  });
  if (move.exit !== 0) throw new ParkSignal('finish-failed', { step: 'board-move', exit: move.exit });

  const commentFile = path.join(ctx.taskDir, 'final-comment.md');
  fs.writeFileSync(commentFile, finalComment(ctx));
  const comment = spawnStep(ctx, deps, 'FINISH', 'gh', [
    'issue',
    'comment',
    String(issue),
    '--repo',
    config.ghRepo,
    '--body-file',
    commentFile,
  ]);
  if (comment.exit !== 0) throw new ParkSignal('finish-failed', { step: 'issue-comment', exit: comment.exit });

  const remove = spawnStep(ctx, deps, 'FINISH', 'git', [
    '-C',
    config.productRepo,
    'worktree',
    'remove',
    '--force',
    worktreePath,
  ]);
  if (remove.exit !== 0) throw new ParkSignal('finish-failed', { step: 'worktree-remove', exit: remove.exit });

  const costUsd = sumJournalCost(ctx.taskDir);
  appendEvent(ctx.taskDir, 'FINISH', 'finished', { issue, prNumber: ctx.prNumber || null, costUsd });

  return 'DONE';
}

module.exports = {
  runScripted,
  sleep,
  lastLines,
  spawnStep,
  realWorktree,
  realCheck,
  realPushPr,
  realGate,
  realCiChecks,
  realMerge,
  realFinish,
  preserveWorktreeWip,
};
