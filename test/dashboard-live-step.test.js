'use strict';
// console/live-step.js -- the probe that reads what an LLM step is doing WHILE it runs.
//
// Every case here builds a FAKE account pool under fs.mkdtempSync(os.tmpdir()): a registry, a
// lease file, a projects/<slug>/ directory and a transcript. The real pool at
// ~/.claude-accounts is never read, and no process is ever spawned.
//
// The four "miss" cases matter as much as the happy path. This probe reaches across three
// separate on-disk surfaces owned by three different writers, and the ways that chain breaks in
// production (a dead worker, a released lease, a step whose transcript has not opened yet) must
// each produce a NAMED miss and a deck that falls back to the clock -- never a throw that takes
// the dashboard down, and never a stale transcript reported as live work.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mkTmp } = require('./helpers');
require('./no-real-spawn');

const {
  slugForCwd,
  summarizeTail,
  sessionStartedAtMs,
  pickSessionFile,
  findAccountByPid,
  probeLiveStep,
  probeDeck,
  LLM_STEPS,
  STALE_MTIME_MS,
} = require('../console/live-step');

const { leaseFilePath } = require('../orchestrator/account-lease');

// ---- fake pool ------------------------------------------------------------------------------

// One account, one lease, one project directory -- the exact shape orchestrator/accounts.js and
// account-lease.js write, built through account-lease.js's OWN path function so this fixture
// cannot drift from the writer.
function makePool({ account = 'pool1', pid = 4242, cwd, sessions = [] } = {}) {
  const poolDir = mkTmp('spo-live-pool-');
  fs.mkdirSync(path.join(poolDir, account), { recursive: true });
  fs.writeFileSync(leaseFilePath(poolDir, account), JSON.stringify({ pid, startedAt: new Date().toISOString() }));

  const projectDir = path.join(poolDir, account, 'projects', slugForCwd(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  for (const s of sessions) {
    const p = path.join(projectDir, `${s.id}.jsonl`);
    fs.writeFileSync(p, (s.lines || []).map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (s.mtime) fs.utimesSync(p, new Date(s.mtime), new Date(s.mtime));
  }
  return { poolDir, projectDir, account };
}

function assistant(ts, blocks) {
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: blocks } };
}

function card(over = {}) {
  return {
    id: 'issue-654',
    deckState: 'running',
    state: 'IMPLEMENT',
    workerPid: 4242,
    worktreePath: '/tmp/spo-wt/issue-654',
    run: { current: { state: 'IMPLEMENT', enteredAt: '2026-09-05T00:00:00.000Z', attempt: 1, detail: {} } },
    ...over,
  };
}

const CWD = '/tmp/spo-wt/issue-654';

// ---- the slug --------------------------------------------------------------------------------

test('slugForCwd matches the CLI: every character outside [A-Za-z0-9-] becomes a dash', () => {
  assert.equal(slugForCwd('/home/crazz/SPO-Pipeline'), '-home-crazz-SPO-Pipeline');
  // The dotted case is the one that proves the rule -- `.claude` yields TWO dashes, one for the
  // slash and one for the dot. Read off the real pool directory, not from documentation.
  assert.equal(
    slugForCwd('/home/crazz/SPO-Pipeline/.claude/worktrees/x'),
    '-home-crazz-SPO-Pipeline--claude-worktrees-x'
  );
  assert.equal(slugForCwd('/a/b_c.d'), '-a-b-c-d');
  assert.equal(slugForCwd(null), null);
});

// ---- session selection -------------------------------------------------------------------------

test('sessionStartedAtMs prefers birthtime, and falls back to the first timestamp when a filesystem reports none', () => {
  const dir = mkTmp('spo-live-birth-');
  const p = path.join(dir, 'a.jsonl');
  // The opening records of a real transcript carry NO timestamp -- verified against three live
  // files -- which is exactly why birthtime is the primary signal.
  fs.writeFileSync(
    p,
    [JSON.stringify({ type: 'ai-title', aiTitle: 'x' }), JSON.stringify({ type: 'user', timestamp: '2026-09-05T00:00:05.000Z' })].join('\n')
  );
  const st = fs.statSync(p);
  assert.equal(sessionStartedAtMs(p, st), st.birthtimeMs);

  // With no birthtime the head parse still finds the first real timestamp.
  assert.equal(sessionStartedAtMs(p, { birthtimeMs: 0 }), Date.parse('2026-09-05T00:00:05.000Z'));
});

test('pickSessionFile takes the session created for THIS step, not the previous step\'s bigger transcript in the same directory', () => {
  const dir = mkTmp('spo-live-pick-');
  const stepEnteredAt = Date.parse('2026-09-05T00:10:00.000Z');
  const now = stepEnteredAt + 30000;

  // The previous step's transcript: created well before this step began, and larger.
  const older = path.join(dir, 'older.jsonl');
  fs.writeFileSync(older, JSON.stringify({ type: 'user', timestamp: '2026-09-05T00:00:00.000Z' }) + '\n'.repeat(500));
  fs.utimesSync(older, new Date(now), new Date(now)); // even if it was touched recently

  // ...and this step's, whose first timestamp lands just after the transition.
  const mine = path.join(dir, 'mine.jsonl');
  fs.writeFileSync(mine, JSON.stringify({ type: 'user', timestamp: '2026-09-05T00:10:02.000Z' }));

  // Force the birthtime-less path so the choice is made on recorded timestamps, which is the
  // discriminating rule this test exists to pin (birthtimes in a temp dir are all "now").
  const realStat = fs.statSync;
  fs.statSync = (p, ...rest) => Object.assign(Object.create(Object.getPrototypeOf(realStat(p, ...rest))), realStat(p, ...rest), { birthtimeMs: 0 });
  try {
    assert.equal(pickSessionFile(dir, stepEnteredAt, now), mine);
  } finally {
    fs.statSync = realStat;
  }
});

test('pickSessionFile ignores a transcript nothing has written to for minutes -- a finished step is not a running one', () => {
  const dir = mkTmp('spo-live-stale-');
  const enteredAt = Date.parse('2026-09-05T00:10:00.000Z');
  const now = enteredAt + 60000;
  const p = path.join(dir, 'cold.jsonl');
  fs.writeFileSync(p, JSON.stringify({ type: 'user', timestamp: '2026-09-05T00:10:02.000Z' }));
  const cold = new Date(now - STALE_MTIME_MS - 60000);
  fs.utimesSync(p, cold, cold);

  assert.equal(pickSessionFile(dir, enteredAt, now), null);
});

test('pickSessionFile returns null for a directory that does not exist, rather than throwing', () => {
  assert.equal(pickSessionFile(path.join(os.tmpdir(), 'spo-live-absent-xyz'), Date.now(), Date.now()), null);
});

// ---- the tail summary ---------------------------------------------------------------------------

test('summarizeTail counts tool calls by name and keeps the LAST thing the model said', () => {
  const dir = mkTmp('spo-live-tail-');
  const p = path.join(dir, 's.jsonl');
  fs.writeFileSync(
    p,
    [
      { type: 'user', timestamp: '2026-09-05T00:00:00.000Z' },
      assistant('2026-09-05T00:00:10.000Z', [{ type: 'text', text: 'Reading the failing test first.' }, { type: 'tool_use', name: 'Read' }]),
      assistant('2026-09-05T00:00:20.000Z', [{ type: 'tool_use', name: 'Bash' }]),
      assistant('2026-09-05T00:00:30.000Z', [{ type: 'text', text: 'Now running the mutation table.' }, { type: 'tool_use', name: 'Bash' }]),
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );

  const s = summarizeTail(p);
  assert.equal(s.turns, 3);
  assert.deepEqual(s.toolCounts, { Read: 1, Bash: 2 });
  assert.equal(s.lastText, 'Now running the mutation table.');
  assert.equal(s.lastTurnAt, '2026-09-05T00:00:30.000Z');
});

test('summarizeTail returns null when the tail holds no assistant turn -- silence is not "0 turns of work"', () => {
  const dir = mkTmp('spo-live-quiet-');
  const p = path.join(dir, 's.jsonl');
  fs.writeFileSync(p, JSON.stringify({ type: 'user', timestamp: '2026-09-05T00:00:00.000Z' }) + '\n');
  assert.equal(summarizeTail(p), null);
});

test('summarizeTail survives a torn line at the tail boundary and an unreadable file', () => {
  const dir = mkTmp('spo-live-torn-');
  const p = path.join(dir, 's.jsonl');
  fs.writeFileSync(p, ['{"type":"assist', JSON.stringify(assistant('2026-09-05T00:00:10.000Z', [{ type: 'text', text: 'ok' }]))].join('\n'));
  assert.equal(summarizeTail(p).turns, 1);
  assert.equal(summarizeTail(path.join(dir, 'nope.jsonl')), null);
});

// ---- the identity chain ---------------------------------------------------------------------------

test('findAccountByPid names the account whose lease holds this worker, through account-lease.js own path function', () => {
  const { poolDir } = makePool({ account: 'pool2', pid: 777, cwd: CWD });
  assert.equal(findAccountByPid(poolDir, 777), 'pool2');
  assert.equal(findAccountByPid(poolDir, 778), null);
  assert.equal(findAccountByPid(poolDir, null), null);
  assert.equal(findAccountByPid(null, 777), null);
});

test('probeLiveStep walks pid -> lease -> account -> cwd -> transcript and reports what the step is doing', () => {
  const { poolDir } = makePool({
    pid: 4242,
    cwd: CWD,
    sessions: [
      {
        id: 'sess-a',
        lines: [
          { type: 'user', timestamp: '2026-09-05T00:00:02.000Z' },
          assistant('2026-09-05T00:00:40.000Z', [{ type: 'text', text: 'Editing mail-html-utils.ts.' }, { type: 'tool_use', name: 'Edit' }]),
        ],
      },
    ],
  });

  const r = probeLiveStep(card(), { accountsDir: poolDir, now: Date.parse('2026-09-05T00:01:00.000Z') });
  assert.equal(r.miss, undefined);
  assert.equal(r.account, 'pool1');
  assert.equal(r.turns, 1);
  assert.deepEqual(r.toolCounts, { Edit: 1 });
  assert.equal(r.lastText, 'Editing mail-html-utils.ts.');
});

test('probeLiveStep names which link of the chain broke, so a blind deck is diagnosable without a debugger', () => {
  const { poolDir } = makePool({ pid: 4242, cwd: CWD, sessions: [] });
  const now = Date.parse('2026-09-05T00:01:00.000Z');

  // no worker at all
  assert.equal(probeLiveStep(card({ workerPid: null }), { accountsDir: poolDir, now }).miss, 'no-worker-pid');
  // a worker whose lease has been released (or is held by another account's process)
  assert.equal(probeLiveStep(card({ workerPid: 9999 }), { accountsDir: poolDir, now }).miss, 'no-lease-for-pid');
  // the right account, but this step has not opened a transcript yet
  assert.equal(probeLiveStep(card(), { accountsDir: poolDir, now }).miss, 'no-session-file');
  // a cwd the CLI has never worked in
  assert.equal(
    probeLiveStep(card({ worktreePath: '/tmp/spo-wt/never-used' }), { accountsDir: poolDir, now }).miss,
    'no-project-dir'
  );
});

test('probeLiveStep declines to probe a scripted step -- those journal a spawn per command already', () => {
  const { poolDir } = makePool({ pid: 4242, cwd: CWD });
  for (const state of ['CHECK', 'GATE', 'MERGE', 'PUSH_PR', 'CI_CHECKS', 'FINISH', 'WORKTREE']) {
    const c = card({ state, run: { current: { state, enteredAt: '2026-09-05T00:00:00.000Z', attempt: 1, detail: {} } } });
    assert.equal(probeLiveStep(c, { accountsDir: poolDir }), null, `${state} should not be probed`);
    assert.equal(LLM_STEPS.has(state), false);
  }
  for (const state of ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE']) assert.equal(LLM_STEPS.has(state), true);
});

test('probeLiveStep returns null for a card with no open split at all', () => {
  const { poolDir } = makePool({ pid: 4242, cwd: CWD });
  assert.equal(probeLiveStep(card({ run: { current: null, splits: [] } }), { accountsDir: poolDir }), null);
  assert.equal(probeLiveStep(card({ run: null }), { accountsDir: poolDir }), null);
  assert.equal(probeLiveStep(null, { accountsDir: poolDir }), null);
});

test('probeDeck probes running cards only, and one card throwing never takes the others (or the page) down', () => {
  const { poolDir } = makePool({
    pid: 4242,
    cwd: CWD,
    sessions: [
      {
        id: 'sess-a',
        lines: [
          { type: 'user', timestamp: '2026-09-05T00:00:02.000Z' },
          assistant('2026-09-05T00:00:40.000Z', [{ type: 'text', text: 'working' }]),
        ],
      },
    ],
  });
  const now = Date.parse('2026-09-05T00:01:00.000Z');

  const out = probeDeck(
    [
      card(),
      card({ id: 'issue-finished', deckState: 'finished' }),
      card({ id: 'issue-stale', deckState: 'stale' }),
      // A card whose own shape is broken: `run` is a getter that throws.
      Object.defineProperty({ id: 'issue-bad', deckState: 'running' }, 'run', {
        get() {
          throw new Error('boom');
        },
      }),
    ],
    { accountsDir: poolDir, now }
  );

  assert.deepEqual(Object.keys(out), ['issue-654']);
  assert.equal(out['issue-654'].lastText, 'working');
});
