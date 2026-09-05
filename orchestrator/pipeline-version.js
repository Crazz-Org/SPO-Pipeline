'use strict';
// pipeline-version.js -- the PIPELINE's own provenance, the thing this repo was rigorous about
// for the product and had no equivalent of for itself.
//
// WORKTREE already records where a card's product code came from: `git fetch origin`, cut from
// `origin/main`, `base-main` journalled with the sha, a red nightly refused. Ask the same question
// about the ORCHESTRATOR -- "which version of the pipeline produced this park?" -- and before this
// module there was no answer anywhere: `dispatcher-start` carried `pid` and `workers` only, and
// every `rev-parse HEAD` in the codebase points at the product worktree. That gap is not academic.
// `dispatcher.js`'s DAEMON_PATH is resolved at every spawn, so a `git pull` alone (no restart)
// already puts NEW workers under an OLD dispatcher; a park written in that window cannot be
// attributed to either version after the fact.
//
// READS .git BY HAND, NEVER SPAWNS `git`. Three reasons, in order of weight:
//   1. test/no-real-spawn.js makes an in-process spawnSync of `git` a suite-wide error (it exists
//      because a test once ran real git/gh with live credentials). A provenance read that runs on
//      every daemon start and every card must not be the one thing that has to be exempted.
//   2. It runs inside a worker whose whole event loop is already blocked by spawnSync for minutes
//      at a time (steps/llm.js). Two file reads cost microseconds; a subprocess is ~5ms and can
//      hang like any other.
//   3. `git` need not be on PATH for the daemon to be correct about anything else.
//
// WHAT IT CANNOT SEE, and this is deliberate rather than an oversight: an UNCOMMITTED edit. A sha
// identifies a commit, not a working tree, so a hand-edited `~/SPO-Pipeline` reports the sha it
// was last on while running something else entirely. Detecting that honestly means `git status
// --porcelain` -- a subprocess, on every card, for a condition that only exists because the
// service runs out of an editable checkout at all. The immutable-release layout in
// doc/deployment.md removes the condition instead of measuring it; until that lands, "the sha is
// the commit, not necessarily the bytes" is the accurate reading of these fields.
//
// EVERY failure returns `{sha: null, ref: null}` rather than throwing. This is called from
// dispatcher startup and from a worker's first moments: a daemon that refuses to run because it
// could not describe itself would be a strictly worse trade than a park whose provenance line
// says `null`.

const fs = require('fs');
const path = require('path');

// The repo this file is part of -- NOT process.cwd(). A worker's cwd is set per step
// (config.js's cwdForStep) and a hand-run daemon can be started from anywhere, so cwd answers
// "where was this invoked" and __dirname answers "which checkout is executing", which is the
// question. Post-pull-no-restart, both processes still resolve this the same way: the sha they
// report differs because the FILES differ, which is exactly the divergence worth seeing.
const REPO_ROOT = path.join(__dirname, '..');

const SHA_RE = /^[0-9a-f]{40}$/;

// `.git` is a DIRECTORY in an ordinary checkout and a FILE (`gitdir: <path>`) in a linked
// worktree -- and this project runs both: production is the main checkout, every agent session is
// a worktree under .claude/worktrees/. The suite therefore exercises the file branch for real on
// every run, which is why it is here rather than treated as an exotic case.
function resolveGitDir(repoRoot) {
  const dotGit = path.join(repoRoot, '.git');
  const st = fs.statSync(dotGit);
  if (st.isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!m) return null;
  return path.resolve(repoRoot, m[1].trim());
}

// A linked worktree's gitdir holds its own HEAD but NOT refs/ -- those live in the common dir it
// points at with a `commondir` file. Resolving a ref against the worktree gitdir alone finds
// nothing and would report `sha: null` for every agent session.
function resolveCommonDir(gitDir) {
  try {
    const raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return raw ? path.resolve(gitDir, raw) : gitDir;
  } catch {
    return gitDir;
  }
}

// Loose ref first, then packed-refs -- the same order git itself resolves in. A branch that has
// not been touched since `git gc` (or since a fresh clone) exists ONLY in packed-refs, so
// skipping that file would report null on exactly the checkouts least likely to have been
// touched by hand: a freshly deployed one.
function readRef(gitDir, commonDir, ref) {
  for (const dir of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
    try {
      const sha = fs.readFileSync(path.join(dir, ref), 'utf8').trim();
      if (SHA_RE.test(sha)) return sha;
    } catch {
      // Not here -- try the common dir, then packed-refs below.
    }
  }
  try {
    for (const line of fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8').split('\n')) {
      // `^<sha>` peeled lines carry NO space, so the `sp === -1` test below already skips them;
      // the explicit `^` check is belt-and-braces on a format guarantee, not the thing that works.
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      if (line.slice(sp + 1).trim() === ref) {
        const sha = line.slice(0, sp).trim();
        if (SHA_RE.test(sha)) return sha;
      }
    }
  } catch {
    // No packed-refs at all is normal in a young repo.
  }
  return null;
}

// -> {sha, ref}. `ref` is null on a detached HEAD (which is what a release checkout of a fixed
// sha looks like, so it is a normal reading here, not an anomaly).
function readPipelineVersion(repoRoot = REPO_ROOT) {
  try {
    const gitDir = resolveGitDir(repoRoot);
    if (!gitDir) return { sha: null, ref: null };
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*(.+)$/.exec(head);
    if (!m) return { sha: SHA_RE.test(head) ? head : null, ref: null };
    const ref = m[1].trim();
    return { sha: readRef(gitDir, resolveCommonDir(gitDir), ref), ref };
  } catch {
    return { sha: null, ref: null };
  }
}

module.exports = { readPipelineVersion, REPO_ROOT };
