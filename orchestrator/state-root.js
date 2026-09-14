'use strict';
// state-root.js -- where the pipeline's own mutable state lives, and why it is not in the repo.
//
// `queue/` and `journal/` used to default to `<repoRoot>/queue` and `<repoRoot>/journal`, which
// was fine for exactly as long as there was one checkout and the service ran out of it. The
// immutable-release layout (doc/deployment.md) ends both of those assumptions at once: the daemon
// runs from `~/.spo-releases/<sha>`, a NEW tree per deploy, so state kept inside the tree would be
// abandoned on every release -- 20 MB of journal history, every parked card's anchor, the whole
// unpark channel, silently starting empty.
//
// So state moves beside the pipeline's other state, all of which is already outside the repo:
// `~/.claude-accounts`, `~/.spo-worktrees`, `~/.spo-bench`. `~/.spo-state` is the fourth, and the
// only one that had to be moved rather than born there.
//
// EXPLICIT FLAGS STILL WIN, UNCONDITIONALLY. `--journal` / `--queue` (daemon.js, bin/spo) and the
// deps overrides (intake.js) bypass everything here -- the whole test suite is built on pointing
// runs at throwaway directories, and recette.js builds its own run-scoped roots (journalRoot/
// queueDir, under `.recette/<runId>/`). The exception is recette.js's `productJournalRoot` -- the
// target of its live-daemon lock check, not one of its own run-scoped roots -- which defaults
// THROUGH this module (`stateJournalRoot(resolveStateRoot())`) exactly like every other caller,
// precisely so the check looks at the same place the real daemon's lock actually is. This module
// only decides the DEFAULT.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_STATE_ROOT = path.join(os.homedir(), '.spo-state');

// SPO_STATE_DIR overrides, same convention as SPO_PRODUCT_REPO / SPO_WORKTREES_DIR / SPO_BENCH_DIR.
function resolveStateRoot(env = process.env) {
  const raw = env.SPO_STATE_DIR;
  return raw && raw.trim() ? raw.trim() : DEFAULT_STATE_ROOT;
}

function stateQueueDir(stateRoot) {
  return path.join(stateRoot, 'queue');
}

function stateJournalRoot(stateRoot) {
  return path.join(stateRoot, 'journal');
}

// Is there real, un-migrated state still sitting inside the repo? "Real" means a daemon has
// actually written there -- a bare empty `journal/` directory (a stale mkdir, a fresh clone's
// gitignored leftover) is not evidence of anything and must not block a start.
function legacyStateEvidence(repoRoot) {
  const journal = path.join(repoRoot, 'journal');
  const found = [];
  try {
    if (fs.existsSync(path.join(journal, 'daemon.jsonl'))) found.push('journal/daemon.jsonl');
    for (const entry of fs.readdirSync(journal, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(journal, entry.name, 'state.json'))) {
        found.push(`journal/${entry.name}/state.json`);
        break; // one card is proof enough; this is a guard, not an inventory
      }
    }
  } catch {
    // No journal/ at all -- the normal case for a release tree and for every agent worktree.
  }
  try {
    const queue = path.join(repoRoot, 'queue');
    if (fs.readdirSync(queue).some((f) => f.endsWith('.json'))) found.push('queue/*.json');
  } catch {
    // ditto
  }
  return found;
}

// 2026-09-13 incident: a bare `daemon.js --dry-run` (no --queue/--journal, no SPO_STATE_DIR) on
// the production box resolved the SAME live queue/journal the real daemon owns, took the lock,
// and drained all 30 real queue entries into a fake DONE in ~150ms -- overwriting 30 state.json,
// appending fake journal runs, and clobbering real scratch/plan-*.md, all recovered by hand
// afterwards. `--shadow` reads the identical queue/journal roots (only the STEP execution is
// faked -- see daemon.js's own header on `--shadow`/`--dry-run`), so it carries the same
// exposure. isLiveStateRoot is the one place that answers "would THIS queueDir/journalRoot
// actually touch the live default", so daemon.js can refuse before doing anything else.
//
// Deliberately NOT "was --queue/--journal/SPO_STATE_DIR given" (assertStateMigrated's own
// question, right above) -- that would let `--queue ~/.spo-state/queue` right past the guard it
// exists to be. Instead it compares the RESOLVED paths the caller ended up with against the
// live default, however they got there. `fs.realpathSync` when the candidate exists, so a
// symlink or a `~/.spo-state/` trailing-slash spelling cannot slip past a plain string compare;
// a path that does not exist yet falls back to `path.resolve` -- callers create queue/journal
// AFTER this check runs (daemon.js's own mkdirSync), so "not there yet" must not read as "safe".
// `home` is injectable so this stays pure under test, matching resolveStateRoot's own `env` param.
function realOrResolvedPath(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isSameResolvedPath(a, b) {
  return realOrResolvedPath(a) === realOrResolvedPath(b);
}

// True iff `candidate` resolves to `ancestor` itself, or to something nested under it. Used for
// `taskDir` below: `--worker <taskDir>`/`--repark-task <taskDir>` name a single task directory,
// not the queue/journal root -- a live one is shaped `<liveJournalRoot>/<id>`, never equal to the
// root itself, so an equality check (isSameResolvedPath) would never catch it.
function isInsideOrSame(candidate, ancestor) {
  const resolvedCandidate = realOrResolvedPath(candidate);
  const resolvedAncestor = realOrResolvedPath(ancestor);
  return resolvedCandidate === resolvedAncestor || resolvedCandidate.startsWith(resolvedAncestor + path.sep);
}

// `taskDir` (optional): verification finding -- `--worker <taskDir>`/`--repark-task <taskDir>`
// bypassed the guard entirely, because it only ever checked queueDir/journalRoot. Both modes are
// commonly invoked with an explicit --queue/--journal (a dispatcher-spawned child always is --
// dispatcher.js's buildWorkerArgv/buildReparkArgv), which made queueDir/journalRoot look safe
// while `--worker $HOME/.spo-state/journal/issue-5 --queue /tmp/q --journal /tmp/j` still walked
// a real, live-shaped task to a fake terminal state and rewrote its real state.json. A live
// taskDir is a directory NESTED under the live queue or journal root (`<liveRoot>/journal/<id>`
// for a worker/repark target -- queue is checked too since nothing stops a caller from pointing
// `--worker`/`--repark-task` at a queue-rooted path), so this checks containment, not equality.
function isLiveStateRoot({ queueDir, journalRoot, taskDir, home = os.homedir() } = {}) {
  const liveRoot = path.join(home, '.spo-state');
  const liveQueue = stateQueueDir(liveRoot);
  const liveJournal = stateJournalRoot(liveRoot);
  if (isSameResolvedPath(queueDir, liveQueue) || isSameResolvedPath(journalRoot, liveJournal)) return true;
  if (taskDir && (isInsideOrSame(taskDir, liveQueue) || isInsideOrSame(taskDir, liveJournal))) return true;
  return false;
}

class UnmigratedStateError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'UnmigratedStateError';
    this.detail = detail;
  }
}

// REFUSES rather than guesses, and the refusal is the whole point of this module existing as
// something other than two path.join calls.
//
// The dangerous outcome is not "the daemon cannot find its journal" -- that is loud. It is the
// daemon finding an EMPTY one: orphanScan sees nothing to recover, unparkScan sees no parked
// cards, so the retry channel is silently dead and every card a human is waiting on is invisible.
// The board would still say Parked while nothing on this machine was listening. That is the
// failure this refuses to have.
//
// Only fires when there is real in-repo state AND the new root has none -- i.e. exactly the
// pre-migration box, and nothing else. After `mv`, both tests fail and it never fires again.
function assertStateMigrated(repoRoot, stateRoot) {
  const legacy = legacyStateEvidence(repoRoot);
  if (legacy.length === 0) return;
  if (legacyStateEvidence(stateRoot).length > 0) return; // already migrated; the leftovers are stale

  throw new UnmigratedStateError(
    `state still lives in the repo (${legacy.join(', ')}) and ${stateRoot} has none. ` +
      'Refusing to start on an empty journal: orphan recovery and the `retry` channel would both ' +
      'silently see nothing, while the board still showed cards parked. Migrate first:\n' +
      `  mkdir -p ${stateRoot}\n` +
      `  mv ${path.join(repoRoot, 'journal')} ${stateJournalRoot(stateRoot)}\n` +
      `  mv ${path.join(repoRoot, 'queue')} ${stateQueueDir(stateRoot)}\n` +
      'See doc/deployment.md.',
    { repoRoot, stateRoot, legacy }
  );
}

module.exports = {
  DEFAULT_STATE_ROOT,
  resolveStateRoot,
  stateQueueDir,
  stateJournalRoot,
  legacyStateEvidence,
  assertStateMigrated,
  isLiveStateRoot,
  UnmigratedStateError,
};
