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
// runs at throwaway directories, and recette.js builds its own run-scoped roots. This module only
// decides the DEFAULT.

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
  UnmigratedStateError,
};
