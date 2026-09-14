'use strict';
// Tests for orchestrator/state-root.js -- where the pipeline's own mutable state lives once the
// service runs from an immutable release tree.
//
// The failure this is really defending against is not "cannot find the journal", which is loud.
// It is finding an EMPTY one: orphanScan recovers nothing, unparkScan sees no parked cards, so the
// `retry` channel is silently dead while the board still shows cards parked and a human waits on a
// machine that stopped listening. A release-per-deploy layout makes that the DEFAULT outcome
// unless state is moved out of the tree first, which is why the refusal exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mkTmp } = require('./helpers');

require('./no-real-spawn');

const {
  DEFAULT_STATE_ROOT,
  resolveStateRoot,
  stateQueueDir,
  stateJournalRoot,
  legacyStateEvidence,
  assertStateMigrated,
  isLiveStateRoot,
  UnmigratedStateError,
} = require('../orchestrator/state-root');

const mk = mkTmp;

// A repo-shaped directory with real daemon-written state in it.
function withLegacyState(root, { daemonLog = true, card = true, queued = false } = {}) {
  fs.mkdirSync(path.join(root, 'journal'), { recursive: true });
  if (daemonLog) fs.writeFileSync(path.join(root, 'journal', 'daemon.jsonl'), '{"event":"dispatcher-start"}\n');
  if (card) {
    fs.mkdirSync(path.join(root, 'journal', 'issue-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'journal', 'issue-1', 'state.json'), '{"state":"PARKED"}');
  }
  if (queued) {
    fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(root, 'queue', '0001-x.json'), '{}');
  }
  return root;
}

// ---- resolution --------------------------------------------------------------------------------

test('the default state root is outside the repo, beside the pipeline\'s other state', () => {
  assert.equal(resolveStateRoot({}), path.join(os.homedir(), '.spo-state'));
  assert.equal(DEFAULT_STATE_ROOT, path.join(os.homedir(), '.spo-state'));
  // The point of the whole change: it must not be under any checkout. A release tree is replaced
  // on every deploy, so anything inside one is abandoned by the next.
  assert.equal(resolveStateRoot({}).startsWith(path.join(__dirname, '..')), false);
});

test('SPO_STATE_DIR overrides, and blank/whitespace falls back rather than yielding ""', () => {
  assert.equal(resolveStateRoot({ SPO_STATE_DIR: '/tmp/elsewhere' }), '/tmp/elsewhere');
  assert.equal(resolveStateRoot({ SPO_STATE_DIR: '   ' }), DEFAULT_STATE_ROOT, 'whitespace must not become the root');
  assert.equal(resolveStateRoot({ SPO_STATE_DIR: '' }), DEFAULT_STATE_ROOT);
});

test('queue and journal hang off the state root', () => {
  assert.equal(stateQueueDir('/s'), path.join('/s', 'queue'));
  assert.equal(stateJournalRoot('/s'), path.join('/s', 'journal'));
});

// ---- evidence ----------------------------------------------------------------------------------

test('legacyStateEvidence: an absent or EMPTY journal is not evidence of anything', () => {
  assert.deepEqual(legacyStateEvidence(mk('spo-sr-none-')), []);
  const bare = mk('spo-sr-bare-');
  fs.mkdirSync(path.join(bare, 'journal'));
  fs.mkdirSync(path.join(bare, 'queue'));
  // A stale mkdir, or a fresh clone's gitignored leftover. Blocking a start on this would make the
  // guard fire for people who have nothing to migrate.
  assert.deepEqual(legacyStateEvidence(bare), []);
});

test('legacyStateEvidence: a daemon.jsonl, a card state.json, or a queued task each count', () => {
  const a = withLegacyState(mk('spo-sr-log-'), { daemonLog: true, card: false });
  assert.deepEqual(legacyStateEvidence(a), ['journal/daemon.jsonl']);

  const b = withLegacyState(mk('spo-sr-card-'), { daemonLog: false, card: true });
  assert.deepEqual(legacyStateEvidence(b), ['journal/issue-1/state.json']);

  const c = mk('spo-sr-queue-');
  fs.mkdirSync(path.join(c, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(c, 'queue', '0001-x.json'), '{}');
  assert.deepEqual(legacyStateEvidence(c), ['queue/*.json']);
});

// ---- the refusal -------------------------------------------------------------------------------

test('assertStateMigrated: refuses when real state is in the repo and the new root has none', () => {
  const repo = withLegacyState(mk('spo-sr-repo-'), { queued: true });
  const state = mk('spo-sr-state-');
  assert.throws(
    () => assertStateMigrated(repo, state),
    (err) => {
      assert.ok(err instanceof UnmigratedStateError);
      // The message has to be actionable at 3am: the exact mv commands, not a description of them.
      assert.match(err.message, new RegExp(`mv ${repo}/journal ${state}/journal`));
      assert.match(err.message, new RegExp(`mv ${repo}/queue ${state}/queue`));
      assert.match(err.message, /Refusing to start on an empty journal/);
      assert.deepEqual(err.detail.legacy.length > 0, true);
      return true;
    }
  );
});

test('assertStateMigrated: silent once the state has been moved -- leftovers do not re-trigger it', () => {
  const repo = withLegacyState(mk('spo-sr-repo2-'));
  const state = withLegacyState(mk('spo-sr-state2-'));
  // Both have state: the migration happened and something (a stale copy, an un-deleted directory)
  // was left behind. Blocking here would make the guard un-clearable without deleting history.
  assert.doesNotThrow(() => assertStateMigrated(repo, state));
});

test('assertStateMigrated: silent for a release tree / agent worktree, which never had state', () => {
  // The common case by far, and the one that must never pay for this guard.
  assert.doesNotThrow(() => assertStateMigrated(mk('spo-sr-release-'), mk('spo-sr-state3-')));
});

test('assertStateMigrated: a nonexistent state root is still "has none", not a crash', () => {
  const repo = withLegacyState(mk('spo-sr-repo3-'));
  assert.throws(
    () => assertStateMigrated(repo, path.join(os.tmpdir(), 'spo-sr-does-not-exist-' + Date.now())),
    UnmigratedStateError
  );
});

// ---- isLiveStateRoot ---------------------------------------------------------------------------
//
// 2026-09-13 incident: a bare `daemon.js --dry-run` (no --queue/--journal, no SPO_STATE_DIR) on
// the production box resolved the SAME live queue/journal the real daemon owns, took the lock,
// and drained all 30 real queue entries into a fake DONE in ~150ms. isLiveStateRoot is the pure
// predicate daemon.js now checks before touching anything -- these tests pin it directly, with an
// injected `home` so none of them can accidentally read this machine's own real ~/.spo-state.

test('isLiveStateRoot: the DEFAULT resolution (no override at all) is live', () => {
  const home = mk('spo-sr-home-default-');
  const stateRoot = path.join(home, '.spo-state');
  assert.equal(
    isLiveStateRoot({ queueDir: stateQueueDir(stateRoot), journalRoot: stateJournalRoot(stateRoot), home }),
    true
  );
});

test('isLiveStateRoot: SPO_STATE_DIR pointed elsewhere is safe', () => {
  const home = mk('spo-sr-home-safe-');
  const elsewhere = mk('spo-sr-elsewhere-');
  assert.equal(
    isLiveStateRoot({
      queueDir: stateQueueDir(elsewhere),
      journalRoot: stateJournalRoot(elsewhere),
      home,
    }),
    false
  );
});

test('isLiveStateRoot: an explicit --queue/--journal that just RESPELLS the live default is still live -- presence of a flag is not the question', () => {
  const home = mk('spo-sr-home-respell-');
  const stateRoot = path.join(home, '.spo-state');
  const elsewhere = mk('spo-sr-respell-elsewhere-');
  // Same QUEUE path, spelled with a trailing slash -- a plain string compare would miss this.
  // journalRoot is deliberately NOT the live path (an unrelated safe dir) -- otherwise this case
  // passes even for a mutant `realOrResolvedPath` that never normalises at all (e.g. returns the
  // raw candidate unchanged): journalRoot alone, compared by plain equality, would already make
  // the whole call true, and the trailing-slash queueDir spelling would never actually be
  // exercised. Isolating it here is what makes THIS test the one that catches that mutant.
  assert.equal(
    isLiveStateRoot({
      queueDir: stateQueueDir(stateRoot) + path.sep,
      journalRoot: elsewhere,
      home,
    }),
    true
  );
});

test('isLiveStateRoot: only ONE of queueDir/journalRoot matching the live default is enough to refuse', () => {
  const home = mk('spo-sr-home-onematch-');
  const stateRoot = path.join(home, '.spo-state');
  const elsewhere = mk('spo-sr-elsewhere2-');
  assert.equal(
    isLiveStateRoot({ queueDir: stateQueueDir(elsewhere), journalRoot: stateJournalRoot(stateRoot), home }),
    true,
    'journalRoot alone matching the live default must still refuse'
  );
  assert.equal(
    isLiveStateRoot({ queueDir: stateQueueDir(stateRoot), journalRoot: stateJournalRoot(elsewhere), home }),
    true,
    'queueDir alone matching the live default must still refuse'
  );
});

test('isLiveStateRoot: a SYMLINK to the live default is caught (fs.realpathSync, not a plain string compare)', () => {
  const home = mk('spo-sr-home-symlink-');
  const liveStateRoot = path.join(home, '.spo-state');
  fs.mkdirSync(stateQueueDir(liveStateRoot), { recursive: true });
  fs.mkdirSync(stateJournalRoot(liveStateRoot), { recursive: true });

  const alias = mk('spo-sr-alias-');
  fs.rmdirSync(alias); // symlinkSync refuses to create the link if the target path already exists
  fs.symlinkSync(liveStateRoot, alias, 'dir');

  assert.equal(
    isLiveStateRoot({ queueDir: stateQueueDir(alias), journalRoot: stateJournalRoot(alias), home }),
    true
  );
});

test('isLiveStateRoot: a queue/journal dir that does not exist YET still resolves correctly (mkdirSync runs AFTER this check, not before)', () => {
  const home = mk('spo-sr-home-notyet-');
  const stateRoot = path.join(home, '.spo-state');
  // Neither stateQueueDir(stateRoot) nor stateJournalRoot(stateRoot) has been created -- confirm
  // realOrResolvedPath's fs.realpathSync-fails-so-fall-back-to-path.resolve branch still lands on
  // the live verdict, not a false "safe" from an ENOENT.
  assert.equal(
    fs.existsSync(stateQueueDir(stateRoot)),
    false,
    'test setup: the directory must not exist yet for this case to mean anything'
  );
  assert.equal(
    isLiveStateRoot({ queueDir: stateQueueDir(stateRoot), journalRoot: stateJournalRoot(stateRoot), home }),
    true
  );
});
