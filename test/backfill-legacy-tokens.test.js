'use strict';
// Tests for scripts/backfill-legacy-tokens.js (card #169). Every fixture is a REAL temp
// directory tree (mkTmp, swept at exit) -- no mocked fs. `recoverSessionTokens` is always
// injected as a fake: no test here reaches a real session transcript or a real account pool, and
// none ever runs against ~/.spo-state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident. Required first, before any
// orchestrator require (this file pulls in orchestrator/task-summary.js, console/collect.js, and
// orchestrator/lock.js below, all indirectly required by scripts/backfill-legacy-tokens.js too).
require('./no-real-spawn');

const { mkTmp } = require('./helpers');
const {
  isTargetEvent,
  findTaskJournalFiles,
  writeFileAtomic: writeFileAtomicExport,
  backfillFile,
  runBackfill,
  printReport,
  parseArgs,
  main,
  liveDaemonLockHolder,
  ConcurrentWriteError,
} = require('../scripts/backfill-legacy-tokens');

// Captures every console.log call made during `fn()` as an array of strings, restoring the real
// console.log afterward even if fn throws.
function captureLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const ret = fn();
    return { lines, ret };
  } finally {
    console.log = real;
  }
}
const { buildRun } = require('../console/collect');
const { summarizeTask } = require('../orchestrator/task-summary');
const { lockPath } = require('../orchestrator/lock');

// Saves/restores process.exitCode around a test that exercises main() and expects it to set a
// non-zero exit code -- main() never calls process.exit() (so it stays testable in-process), but
// that means it sets process.exitCode directly, which would otherwise leak into THIS suite's own
// exit status. Every test below that calls main() with an expected-refusal path uses this.
async function withSavedExitCode(fn) {
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    return await fn();
  } finally {
    process.exitCode = saved;
  }
}

// ---- fixture helpers ---------------------------------------------------------------------------

function mkJournalRoot() {
  return mkTmp('spo-backfill-journal-');
}

function taskDir(journalRoot, taskId) {
  const dir = path.join(journalRoot, taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Writes journal.jsonl for `taskId` from an array of already-JSON-stringifiable objects (or raw
// strings, for a deliberately malformed line). `trailingNewline` defaults to true (appendEvent's
// own convention: every event line ends with '\n').
function writeJournal(journalRoot, taskId, lines, { trailingNewline = true } = {}) {
  const dir = taskDir(journalRoot, taskId);
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (trailingNewline ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), text);
  return path.join(dir, 'journal.jsonl');
}

function readLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const trailingNewline = raw.endsWith('\n');
  const parts = raw.split('\n');
  if (trailingNewline) parts.pop();
  return parts;
}

// One pre-instrumentation target event: ok:true, a real sessionId, no token field of any kind --
// the exact eleven-key shape card #169 measured on the real 92.
function targetEvent(overrides = {}) {
  return {
    ts: '2026-08-29T13:21:55.504Z',
    state: 'PLAN',
    event: 'llm-call',
    step: 'llm.PLAN',
    model: 'claude-sonnet-4-5',
    effort: 'medium',
    account: 'acct-1',
    sessionId: 'sess-target-1',
    costUsd: 0.42,
    numTurns: 5,
    ok: true,
    ...overrides,
  };
}

const RECOVERED_SAMPLE = Object.freeze({
  tokensSource: 'transcript',
  freshInputTokens: 100,
  cacheCreationTokens: 2000,
  cacheReadTokens: 30000,
  outputTokens: 400,
  billableTokens: 2500, // 100 + 2000 + 400
  transcriptFilesRead: 1,
  transcriptFilesSkipped: 0,
});

function fakeRecoverFn(map) {
  // map: sessionId -> result object (or null/undefined for "not recoverable")
  return async ({ sessionId }) => (Object.prototype.hasOwnProperty.call(map, sessionId) ? map[sessionId] : null);
}

// ---- 1. happy path ------------------------------------------------------------------------------

test('happy path: a target event gains all eight token fields plus tokensSource, other fields survive unchanged', async () => {
  const journalRoot = mkJournalRoot();
  const ev = targetEvent();
  const filePath = writeJournal(journalRoot, 'issue-1', [ev]);

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake/accounts',
    recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
  });

  assert.equal(result.totals.targetsFound, 1);
  assert.equal(result.totals.recovered, 1);
  assert.equal(result.totals.skippedNull, 0);
  assert.equal(result.totals.billableAdded, 2500);
  assert.equal(result.totals.cacheReadAdded, 30000);

  const lines = readLines(filePath);
  assert.equal(lines.length, 1);
  const rewritten = JSON.parse(lines[0]);

  // the eight recovery fields
  assert.equal(rewritten.tokensSource, 'transcript');
  assert.equal(rewritten.freshInputTokens, 100);
  assert.equal(rewritten.cacheCreationTokens, 2000);
  assert.equal(rewritten.cacheReadTokens, 30000);
  assert.equal(rewritten.outputTokens, 400);
  assert.equal(rewritten.billableTokens, 2500);
  assert.equal(rewritten.transcriptFilesRead, 1);
  assert.equal(rewritten.transcriptFilesSkipped, 0);

  // every other field survives unchanged
  assert.equal(rewritten.ts, ev.ts);
  assert.equal(rewritten.step, ev.step);
  assert.equal(rewritten.model, ev.model);
  assert.equal(rewritten.account, ev.account);
  assert.equal(rewritten.costUsd, ev.costUsd);
  assert.equal(rewritten.numTurns, ev.numTurns);
  assert.equal(rewritten.ok, ev.ok);

  // field order: original keys first, new ones appended
  assert.deepEqual(Object.keys(rewritten).slice(0, 11), Object.keys(ev));
});

test('happy path: accountConfigDir is derived as path.join(accountsDir, event.account)', async () => {
  const journalRoot = mkJournalRoot();
  writeJournal(journalRoot, 'issue-1', [targetEvent({ account: 'acct-xyz' })]);

  let seenOpts = null;
  await runBackfill({
    journalRoot,
    apply: false,
    accountsDir: '/fake/pool',
    recoverFn: async (opts) => {
      seenOpts = opts;
      return { ...RECOVERED_SAMPLE };
    },
  });

  assert.ok(seenOpts);
  assert.equal(seenOpts.sessionId, 'sess-target-1');
  assert.equal(seenOpts.accountConfigDir, path.join('/fake/pool', 'acct-xyz'));
  // Exactly {sessionId, accountConfigDir} -- mirrors llm.js's maybeRecoverTokens call verbatim,
  // never homeDir/accountsDir/maxFileBytes (see the script's own header for why).
  assert.deepEqual(Object.keys(seenOpts).sort(), ['accountConfigDir', 'sessionId']);
});

// ---- 2. idempotence -------------------------------------------------------------------------

test('idempotence: running twice recovers nothing the second time, and the file is byte-identical after both runs', async () => {
  const journalRoot = mkJournalRoot();
  const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent(), targetEvent({ sessionId: 'sess-target-2', ts: '2026-08-29T14:00:00.000Z' })]);

  const recoverFn = fakeRecoverFn({
    'sess-target-1': { ...RECOVERED_SAMPLE },
    'sess-target-2': { ...RECOVERED_SAMPLE, billableTokens: 999 },
  });

  const first = await runBackfill({ journalRoot, apply: true, accountsDir: '/fake', recoverFn });
  assert.equal(first.totals.recovered, 2);
  const afterFirst = fs.readFileSync(filePath, 'utf8');

  const second = await runBackfill({ journalRoot, apply: true, accountsDir: '/fake', recoverFn });
  assert.equal(second.totals.targetsFound, 0, 'second pass must find zero targets -- tokensSource is now set on both');
  assert.equal(second.totals.recovered, 0);
  const afterSecond = fs.readFileSync(filePath, 'utf8');

  assert.equal(afterSecond, afterFirst, 'file must be byte-identical after the second run');
});

// ---- 3. modelUsage already present -- never overwritten ------------------------------------

test('an event already carrying tokensSource: modelUsage is not overwritten -- original token values survive exactly', async () => {
  const journalRoot = mkJournalRoot();
  const measured = targetEvent({
    sessionId: 'sess-measured-1',
    tokensSource: 'modelUsage',
    freshInputTokens: 11,
    cacheCreationTokens: 22,
    cacheReadTokens: 33,
    outputTokens: 44,
    billableTokens: 77,
  });
  const filePath = writeJournal(journalRoot, 'issue-1', [measured]);

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: async () => {
      throw new Error('recoverFn must never be called for a measured event');
    },
  });

  assert.equal(result.totals.targetsFound, 0);
  assert.equal(fs.readFileSync(filePath, 'utf8'), JSON.stringify(measured) + '\n');
});

// ---- 4. null recovery leaves the event completely untouched --------------------------------

test('recoverSessionTokens returning null leaves the event byte-identical: no tokensSource, no zeros, no new keys', async () => {
  const journalRoot = mkJournalRoot();
  const ev = targetEvent({ sessionId: 'sess-unrecoverable' });
  const filePath = writeJournal(journalRoot, 'issue-1', [ev]);
  const before = fs.readFileSync(filePath, 'utf8');

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({}), // no entry for sess-unrecoverable -> null
  });

  assert.equal(result.totals.targetsFound, 1);
  assert.equal(result.totals.recovered, 0);
  assert.equal(result.totals.skippedNull, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

// ---- 5. three-state contract end to end, through the REAL console/collect.js mapping -------

test('three-state contract end to end: measured / recovered / not-measured come out 1/1/1 through the real buildRun mapping', async () => {
  const journalRoot = mkJournalRoot();
  const lines = [
    { ts: '2026-08-29T10:00:00.000Z', state: 'PLAN', event: 'taken' },
    targetEvent({
      ts: '2026-08-29T10:00:01.000Z',
      sessionId: 'sess-measured',
      tokensSource: 'modelUsage',
      billableTokens: 500,
    }),
    targetEvent({ ts: '2026-08-29T10:00:02.000Z', sessionId: 'sess-recoverable' }),
    targetEvent({ ts: '2026-08-29T10:00:03.000Z', sessionId: 'sess-unrecoverable' }),
    { ts: '2026-08-29T10:00:04.000Z', state: 'PLAN', event: 'done' },
  ];
  const filePath = writeJournal(journalRoot, 'issue-1', lines);

  await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-recoverable': { ...RECOVERED_SAMPLE } }),
  });

  const parsed = readLines(filePath).map((l) => JSON.parse(l));
  const run = buildRun(parsed);
  assert.ok(run, 'expected a run');
  assert.equal(run.splits.length, 1);
  const d = run.splits[0].detail;
  assert.equal(d.measuredCalls, 1);
  assert.equal(d.recoveredCalls, 1);
  assert.equal(d.notMeasuredCalls, 1);
});

// ---- 6. no bare zero -----------------------------------------------------------------------

test('no bare zero: no event the backfill touched or skipped ends up with a numeric 0 billableTokens and no tokensSource', async () => {
  const journalRoot = mkJournalRoot();
  const lines = [
    targetEvent({ sessionId: 'sess-recoverable' }),
    targetEvent({ sessionId: 'sess-unrecoverable' }),
    targetEvent({ sessionId: 'sess-recovers-zero' }),
  ];
  const filePath = writeJournal(journalRoot, 'issue-1', lines);

  await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({
      'sess-recoverable': { ...RECOVERED_SAMPLE },
      // A genuine all-zero recovery (token-recovery.js's own "found rows summing to 0" case) --
      // this one DOES get tokensSource, so it is not a bare zero.
      'sess-recovers-zero': { ...RECOVERED_SAMPLE, freshInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, cacheReadTokens: 0, billableTokens: 0 },
    }),
  });

  const parsed = readLines(filePath).map((l) => JSON.parse(l));
  for (const e of parsed) {
    const bareZero = e.billableTokens === 0 && !e.tokensSource;
    assert.equal(bareZero, false, `event ${e.sessionId} must not be a bare zero: ${JSON.stringify(e)}`);
  }
  // and the genuinely-zero recovery DID get its marker
  const zeroOne = parsed.find((e) => e.sessionId === 'sess-recovers-zero');
  assert.equal(zeroOne.tokensSource, 'transcript');
  assert.equal(zeroOne.billableTokens, 0);
});

// ---- 7. skip rules --------------------------------------------------------------------------

test('ok:false events, events with no sessionId, and events with an empty-string sessionId are all skipped', async () => {
  const journalRoot = mkJournalRoot();
  const lines = [
    targetEvent({ sessionId: 'sess-a', ok: false }),
    targetEvent({ sessionId: undefined }), // JSON.stringify drops an undefined field -> absent
    targetEvent({ sessionId: '' }),
  ];
  const filePath = writeJournal(journalRoot, 'issue-1', lines);
  const before = fs.readFileSync(filePath, 'utf8');

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: async () => {
      throw new Error('recoverFn must never be called for any of these three');
    },
  });

  assert.equal(result.totals.targetsFound, 0);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('isTargetEvent unit checks', () => {
  assert.equal(isTargetEvent(targetEvent()), true);
  assert.equal(isTargetEvent(targetEvent({ ok: false })), false);
  assert.equal(isTargetEvent(targetEvent({ ok: 'true' })), false, 'ok must be a literal boolean true, not a truthy string');
  assert.equal(isTargetEvent(targetEvent({ sessionId: '' })), false);
  assert.equal(isTargetEvent(targetEvent({ sessionId: 42 })), false);
  const { sessionId, ...noSessionId } = targetEvent();
  assert.equal(isTargetEvent(noSessionId), false);
  assert.equal(isTargetEvent(targetEvent({ tokensSource: 'modelUsage' })), false);
  assert.equal(isTargetEvent(targetEvent({ tokensSource: 'transcript' })), false);
  assert.equal(isTargetEvent(targetEvent({ tokensSource: null })), true, 'explicit null is still falsy -- still a target');
  assert.equal(isTargetEvent({ ...targetEvent(), event: 'transition' }), false);
});

// ---- 8. journal/daemon.jsonl is never touched -----------------------------------------------

test('journal/daemon.jsonl is not touched even when it sits at the journal root as a FILE (today\'s real shape)', async () => {
  const journalRoot = mkJournalRoot();
  const daemonEvents = [
    { ts: '2026-08-30T00:00:00.000Z', event: 'llm-call', step: 'REVIEW_CARD', ok: true, sessionId: 'sess-daemon-1', tokensSource: 'modelUsage', billableTokens: 111 },
  ];
  const daemonPath = path.join(journalRoot, 'daemon.jsonl');
  fs.writeFileSync(daemonPath, daemonEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const before = fs.readFileSync(daemonPath, 'utf8');

  // A real target-set task alongside it, to prove the run actually did something.
  writeJournal(journalRoot, 'issue-1', [targetEvent()]);

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
  });

  assert.equal(result.totals.recovered, 1, 'the real task-dir target must still be recovered');
  assert.equal(fs.readFileSync(daemonPath, 'utf8'), before);
  assert.equal(findTaskJournalFiles(journalRoot).some((f) => f.taskId === 'daemon.jsonl'), false);
});

// Opus verification (2026-09-10) caught that the test above proves nothing about the BY-NAME
// guard: `isDirectory()` alone already excludes a FILE named daemon.jsonl, so deleting the
// by-name check left the test above green. This is the mutation-proof version: daemon.jsonl as a
// DIRECTORY (the shape isDirectory() does NOT exclude) containing a journal.jsonl with a real
// target event -- only the by-name guard stands between this and treating it as an 18th task.
test('journal/daemon.jsonl is skipped even as a DIRECTORY holding a target-shaped journal.jsonl (proves the by-name guard, not just isDirectory())', async () => {
  const journalRoot = mkJournalRoot();
  const daemonDir = path.join(journalRoot, 'daemon.jsonl');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(path.join(daemonDir, 'journal.jsonl'), JSON.stringify(targetEvent({ sessionId: 'sess-inside-daemon-dir' })) + '\n');
  const before = fs.readFileSync(path.join(daemonDir, 'journal.jsonl'), 'utf8');

  writeJournal(journalRoot, 'issue-1', [targetEvent()]); // a real task, to prove the run did something

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({
      'sess-target-1': { ...RECOVERED_SAMPLE },
      // If the guard fails and this gets walked, recovering it would prove the leak even louder.
      'sess-inside-daemon-dir': { ...RECOVERED_SAMPLE, billableTokens: 424242 },
    }),
  });

  assert.equal(result.totals.recovered, 1, 'only the real issue-1 target may be recovered');
  assert.equal(fs.readFileSync(path.join(daemonDir, 'journal.jsonl'), 'utf8'), before);
  assert.equal(findTaskJournalFiles(journalRoot).some((f) => f.taskId === 'daemon.jsonl'), false);
});

// ---- 9. non-target lines preserved byte for byte, including a malformed line ----------------

test('non-target lines (spawn/transition/finished/result) and a malformed line are all preserved byte-for-byte', async () => {
  const journalRoot = mkJournalRoot();
  const malformed = '{"ts": "2026-08-29T00:00:00.000Z", "event": "llm-call", this is not valid json';
  const lines = [
    { ts: '2026-08-29T00:00:00.000Z', state: 'INTAKE', event: 'taken' },
    { ts: '2026-08-29T00:00:01.000Z', state: 'WORKTREE', event: 'transition', to: 'WORKTREE' },
    malformed,
    targetEvent({ sessionId: 'sess-real-target' }),
    { ts: '2026-08-29T00:00:02.000Z', event: 'finished', issue: 1, prNumber: 42, billableTokens: 500 },
    { ts: '2026-08-29T00:00:03.000Z', state: 'DIAGNOSE', event: 'result', payload: { rootCause: 'x' } },
  ];
  const filePath = writeJournal(journalRoot, 'issue-1', lines);

  await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-real-target': { ...RECOVERED_SAMPLE } }),
  });

  const outLines = readLines(filePath);
  assert.equal(outLines.length, lines.length);
  assert.equal(outLines[0], JSON.stringify(lines[0]));
  assert.equal(outLines[1], JSON.stringify(lines[1]));
  assert.equal(outLines[2], malformed, 'the malformed line must be left exactly as it was');
  // outLines[3] is the rewritten target -- checked elsewhere
  assert.equal(outLines[4], JSON.stringify(lines[4]));
  assert.equal(outLines[5], JSON.stringify(lines[5]));
});

// ---- 10. dry-run writes nothing ---------------------------------------------------------------

test('dry-run (no --apply) writes nothing, but the report still names what it would do', async () => {
  const journalRoot = mkJournalRoot();
  const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);
  const before = fs.readFileSync(filePath, 'utf8');

  const result = await runBackfill({
    journalRoot,
    apply: false,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
  });

  assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'dry-run must never write');
  assert.equal(result.apply, false);
  assert.equal(result.totals.recovered, 1, 'the report must still say what WOULD be recovered');
  assert.equal(result.totals.billableAdded, 2500);
  assert.equal(result.perTask[0].changed, true, 'perTask must record that this file WOULD change');
});

test('parseArgs: --apply / --force require the literal flag; --journal / --journal=<dir> both set journal', () => {
  assert.deepEqual(parseArgs([]), { apply: false, journal: null, force: false });
  assert.deepEqual(parseArgs(['--apply']), { apply: true, journal: null, force: false });
  assert.deepEqual(parseArgs(['--force']), { apply: false, journal: null, force: true });
  assert.deepEqual(parseArgs(['--journal', '/tmp/x']), { apply: false, journal: '/tmp/x', force: false });
  assert.deepEqual(parseArgs(['--journal=/tmp/y', '--apply', '--force']), { apply: true, journal: '/tmp/y', force: true });
});

// ---- 11. atomicity -------------------------------------------------------------------------

test('atomicity: no temp file is left behind after a successful apply run', async () => {
  const journalRoot = mkJournalRoot();
  writeJournal(journalRoot, 'issue-1', [targetEvent()]);

  await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
  });

  const entries = fs.readdirSync(path.join(journalRoot, 'issue-1'));
  assert.deepEqual(entries, ['journal.jsonl'], 'no stray .tmp file may survive a successful run');
});

test('atomicity: a rename failure mid-write leaves the original journal.jsonl intact', async () => {
  const journalRoot = mkJournalRoot();
  const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);
  const before = fs.readFileSync(filePath, 'utf8');

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === filePath) throw new Error('simulated rename failure');
    return realRename(from, to);
  };
  try {
    await assert.rejects(
      runBackfill({
        journalRoot,
        apply: true,
        accountsDir: '/fake',
        recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
      }),
      /simulated rename failure/
    );
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'the original file must survive a failed rename untouched');
  const entries = fs.readdirSync(path.join(journalRoot, 'issue-1')).filter((f) => f !== 'journal.jsonl');
  assert.deepEqual(entries, [], 'the orphaned tmp file must have been cleaned up by the catch/unlink path');
});

// ---- 12. stale roll-up report -----------------------------------------------------------------

test('stale roll-up report: a task whose frozen finished.billableTokens disagrees with the post-backfill derived sum is named; one that agrees is not', async () => {
  const journalRoot = mkJournalRoot();

  // issue-diverges: frozen roll-up was computed BEFORE these events had any billableTokens at
  // all (the real issue-385 shape) -- after backfill the derived sum grows past the frozen figure.
  writeJournal(journalRoot, 'issue-diverges', [
    targetEvent({ sessionId: 'sess-diverges-1' }),
    { ts: '2026-08-31T00:00:00.000Z', event: 'finished', issue: 1, prNumber: 1, billableTokens: 0 },
  ]);

  // issue-agrees: no target events at all, so the derived sum equals the frozen figure exactly.
  writeJournal(journalRoot, 'issue-agrees', [
    targetEvent({ sessionId: 'sess-agrees-1', tokensSource: 'modelUsage', billableTokens: 900 }),
    { ts: '2026-08-31T00:00:00.000Z', event: 'finished', issue: 2, prNumber: 2, billableTokens: 900 },
  ]);

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-diverges-1': { ...RECOVERED_SAMPLE } }),
  });

  const taskIds = result.staleRollups.map((s) => s.taskId);
  assert.deepEqual(taskIds, ['issue-diverges']);
  assert.equal(result.staleRollups[0].frozen, 0);
  assert.equal(result.staleRollups[0].derived, 2500);
});

test('stale roll-up derivedBillableSum agrees with the REAL summarizeTask after a real --apply run', async () => {
  const journalRoot = mkJournalRoot();
  const dir = taskDir(journalRoot, 'issue-cross-check');
  const lines = [
    targetEvent({ sessionId: 'sess-cc-1' }),
    targetEvent({ sessionId: 'sess-cc-2', tokensSource: 'modelUsage', billableTokens: 321 }),
    // Opus verification (2026-09-10): without this line, a mutant that GATES the reduce on
    // tokensSource (`typeof billableTokens === 'number' && tokensSource`, diverging from
    // task-summary.js:175's own tokensSource-UNGATED sum) still passed this test, because every
    // OTHER llm-call here ends up carrying a tokensSource one way or another. This event never
    // becomes a target (ok:false disqualifies it outright, regardless of tokensSource) and is
    // left completely untouched, yet it DOES carry a numeric billableTokens with no tokensSource
    // at all -- summarizeTask still counts it (event.event === 'llm-call' is its only gate); a
    // reduce that additionally required tokensSource would silently drop it.
    targetEvent({ sessionId: 'sess-cc-3', ok: false, billableTokens: 50 }),
    { ts: '2026-08-31T00:00:00.000Z', event: 'finished', issue: 1, prNumber: 1, billableTokens: 321 },
  ];
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-cc-1': { ...RECOVERED_SAMPLE } }),
  });

  const perTask = result.perTask.find((t) => t.taskId === 'issue-cross-check');
  const real = summarizeTask(dir);
  assert.equal(perTask.derivedBillableSum, real.billableTokens);
  assert.equal(perTask.derivedBillableSum, 2500 + 321 + 50);
});

// ---- misc: findTaskJournalFiles / trailing-newline preservation -----------------------------

test('findTaskJournalFiles finds only journal/<dir>/journal.jsonl, skipping a bare file at the root', () => {
  const journalRoot = mkJournalRoot();
  writeJournal(journalRoot, 'issue-1', [targetEvent()]);
  writeJournal(journalRoot, 'issue-2', [targetEvent({ sessionId: 'sess-x' })]);
  fs.writeFileSync(path.join(journalRoot, 'daemon.jsonl'), '{}\n');
  fs.writeFileSync(path.join(journalRoot, 'live-workers.json'), '{}');

  const found = findTaskJournalFiles(journalRoot).map((f) => f.taskId);
  assert.deepEqual(found.sort(), ['issue-1', 'issue-2']);
});

test('a journal file with no trailing newline keeps that convention after a rewrite', async () => {
  const journalRoot = mkJournalRoot();
  const dir = taskDir(journalRoot, 'issue-1');
  const filePath = path.join(dir, 'journal.jsonl');
  fs.writeFileSync(filePath, JSON.stringify(targetEvent())); // no trailing \n

  await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
  });

  const raw = fs.readFileSync(filePath, 'utf8');
  assert.equal(raw.endsWith('\n'), false, 'the no-trailing-newline convention must survive a rewrite');
  assert.equal(JSON.parse(raw).tokensSource, 'transcript');
});

// backfillFile is exercised directly here too (not just through runBackfill) so a future change
// to runBackfill's own aggregation cannot silently hide a per-file regression.
test('backfillFile in isolation returns the same per-file numbers runBackfill aggregates', async () => {
  const journalRoot = mkJournalRoot();
  const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);

  const stats = await backfillFile(filePath, {
    apply: false,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
  });

  assert.equal(stats.llmCallEventsScanned, 1);
  assert.equal(stats.targetsFound, 1);
  assert.equal(stats.recovered, 1);
  assert.equal(stats.billableAdded, 2500);
  assert.equal(stats.cacheReadAdded, 30000);
  assert.equal(stats.changed, true);
});

// ================================================================================================
// FIX 1(a): live-daemon-lock refusal
// ================================================================================================

test('liveDaemonLockHolder: a lock naming an alive pid on THIS host is returned', () => {
  const journalRoot = mkJournalRoot();
  const holder = { host: 'test-host', pid: 4242, startedAt: '2026-09-10T00:00:00.000Z', mode: 'real' };
  fs.writeFileSync(lockPath(journalRoot), JSON.stringify(holder));

  const found = liveDaemonLockHolder(journalRoot, { isAlive: (pid) => pid === 4242, hostname: 'test-host' });
  assert.deepEqual(found, holder);
});

test('liveDaemonLockHolder: a dead pid is not live', () => {
  const journalRoot = mkJournalRoot();
  fs.writeFileSync(lockPath(journalRoot), JSON.stringify({ host: 'test-host', pid: 4242 }));
  assert.equal(liveDaemonLockHolder(journalRoot, { isAlive: () => false, hostname: 'test-host' }), null);
});

test('liveDaemonLockHolder: a lock from a DIFFERENT host is not treated as live (cannot be confirmed or denied from here)', () => {
  const journalRoot = mkJournalRoot();
  fs.writeFileSync(lockPath(journalRoot), JSON.stringify({ host: 'some-other-host', pid: 4242 }));
  assert.equal(liveDaemonLockHolder(journalRoot, { isAlive: () => true, hostname: 'test-host' }), null);
});

test('liveDaemonLockHolder: no lock file, a torn/unparsable one, or one with no numeric pid is not live', () => {
  const rootA = mkJournalRoot();
  assert.equal(liveDaemonLockHolder(rootA, { isAlive: () => true, hostname: 'test-host' }), null);

  const rootB = mkJournalRoot();
  fs.writeFileSync(lockPath(rootB), 'not valid json{{{');
  assert.equal(liveDaemonLockHolder(rootB, { isAlive: () => true, hostname: 'test-host' }), null);

  const rootC = mkJournalRoot();
  fs.writeFileSync(lockPath(rootC), JSON.stringify({ host: 'test-host' })); // no pid at all
  assert.equal(liveDaemonLockHolder(rootC, { isAlive: () => true, hostname: 'test-host' }), null);
});

test('main(): refuses to --apply when a live daemon lock is held, and never reaches recoverFn or the disk', async () => {
  await withSavedExitCode(async () => {
    const journalRoot = mkJournalRoot();
    const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);
    const before = fs.readFileSync(filePath, 'utf8');

    let recoverCalled = false;
    await main(['--journal', journalRoot, '--apply'], {
      accountsDir: '/fake',
      recoverFn: async () => {
        recoverCalled = true;
        return { ...RECOVERED_SAMPLE };
      },
      liveDaemonLockHolderFn: () => ({ pid: 1, host: 'wherever', startedAt: 'now', mode: 'real' }),
    });

    assert.equal(process.exitCode, 1);
    assert.equal(recoverCalled, false, 'runBackfill/recoverFn must never be reached once refused');
    assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  });
});

test('main(): --force bypasses the live-lock refusal and proceeds to actually write', async () => {
  await withSavedExitCode(async () => {
    const journalRoot = mkJournalRoot();
    const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);

    let recoverCalled = false;
    await main(['--journal', journalRoot, '--apply', '--force'], {
      accountsDir: '/fake',
      recoverFn: async () => {
        recoverCalled = true;
        return { ...RECOVERED_SAMPLE };
      },
      liveDaemonLockHolderFn: () => ({ pid: 1, host: 'wherever', startedAt: 'now', mode: 'real' }),
    });

    assert.equal(process.exitCode, undefined, '--force must not itself trigger a refusal exit code');
    assert.equal(recoverCalled, true);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8').trim()).tokensSource, 'transcript');
  });
});

test('main(): no live lock held -> proceeds normally with no --force needed', async () => {
  await withSavedExitCode(async () => {
    const journalRoot = mkJournalRoot();
    const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);

    await main(['--journal', journalRoot, '--apply'], {
      accountsDir: '/fake',
      recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
      liveDaemonLockHolderFn: () => null,
    });

    assert.equal(process.exitCode, undefined);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8').trim()).tokensSource, 'transcript');
  });
});

test('main(): a dry-run (no --apply) proceeds even with a live lock held -- the refusal only gates a real write', async () => {
  await withSavedExitCode(async () => {
    const journalRoot = mkJournalRoot();
    writeJournal(journalRoot, 'issue-1', [targetEvent()]);

    let recoverCalled = false;
    await main(['--journal', journalRoot], {
      accountsDir: '/fake',
      recoverFn: async () => {
        recoverCalled = true;
        return { ...RECOVERED_SAMPLE };
      },
      liveDaemonLockHolderFn: () => ({ pid: 1, host: 'wherever' }),
    });

    assert.equal(process.exitCode, undefined);
    assert.equal(recoverCalled, true, 'a dry-run must still compute what it would do, lock or no lock');
  });
});

// ================================================================================================
// FIX 1(b): per-file concurrent-writer guard, immediately before rename
// ================================================================================================

test('writeFileAtomic: aborts with ConcurrentWriteError when the target changed since it was stat-ed, and leaves the concurrent content intact', () => {
  const dir = mkTmp('spo-backfill-atomic-');
  const filePath = path.join(dir, 'journal.jsonl');
  fs.writeFileSync(filePath, 'original\n');
  const stat = fs.statSync(filePath);

  // Simulate a concurrent writer: mutate the file AFTER the stat above was taken.
  fs.writeFileSync(filePath, 'concurrently-appended-by-someone-else\n');

  assert.throws(
    () => writeFileAtomicExport(filePath, 'rewritten\n', { expectedMtimeMs: stat.mtimeMs, expectedSize: stat.size }),
    ConcurrentWriteError
  );
  assert.equal(
    fs.readFileSync(filePath, 'utf8'),
    'concurrently-appended-by-someone-else\n',
    "the concurrent writer's content must survive, not be clobbered"
  );
  // no stray tmp file left behind by the aborted attempt
  const entries = fs.readdirSync(dir).filter((f) => f !== 'journal.jsonl');
  assert.deepEqual(entries, []);
});

test('writeFileAtomic: proceeds normally when the target has not changed (no expected* args -> no guard at all)', () => {
  const dir = mkTmp('spo-backfill-atomic-');
  const filePath = path.join(dir, 'journal.jsonl');
  fs.writeFileSync(filePath, 'original\n');

  writeFileAtomicExport(filePath, 'rewritten\n');
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'rewritten\n');
});

test('backfillFile: a concurrent write happening during recovery aborts THAT file (not clobbered) instead of overwriting it', async () => {
  const journalRoot = mkJournalRoot();
  const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);
  const concurrentLine = JSON.stringify({ ts: '2026-09-10T00:00:00.000Z', state: 'PLAN', event: 'llm-call', sessionId: 'sess-appended-concurrently', ok: true });

  const stats = await backfillFile(filePath, {
    apply: true,
    accountsDir: '/fake',
    recoverFn: async () => {
      // The one real await point inside backfillFile's loop -- simulates a concurrent daemon
      // appending to this exact file while this tool's own recovery call is in flight.
      fs.appendFileSync(filePath, concurrentLine + '\n');
      return { ...RECOVERED_SAMPLE };
    },
  });

  assert.equal(stats.recovered, 1, 'the in-memory recovery itself still succeeded (informational)');
  assert.equal(stats.concurrentWriteAborted, true);
  assert.equal(stats.written, false);

  const onDisk = fs.readFileSync(filePath, 'utf8');
  assert.ok(onDisk.includes(concurrentLine), 'the concurrently-appended line must survive on disk');
  assert.ok(!onDisk.includes('"tokensSource"'), 'the original target event must be UNCHANGED on disk -- the recovery was never persisted');
});

test('runBackfill: a concurrent-write abort on one file is reported in totals.filesAborted and does not affect any other file', async () => {
  const journalRoot = mkJournalRoot();
  const contendedPath = writeJournal(journalRoot, 'issue-contended', [targetEvent({ sessionId: 'sess-contended' })]);
  writeJournal(journalRoot, 'issue-clean', [targetEvent({ sessionId: 'sess-clean' })]);

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: async ({ sessionId }) => {
      if (sessionId === 'sess-contended') {
        fs.appendFileSync(contendedPath, JSON.stringify({ event: 'llm-call', ok: true, sessionId: 'sess-injected-concurrently' }) + '\n');
      }
      return { ...RECOVERED_SAMPLE };
    },
  });

  assert.equal(result.totals.filesAborted, 1);
  const contendedTask = result.perTask.find((t) => t.taskId === 'issue-contended');
  assert.equal(contendedTask.concurrentWriteAborted, true);
  const cleanTask = result.perTask.find((t) => t.taskId === 'issue-clean');
  assert.equal(cleanTask.concurrentWriteAborted, false);
  assert.equal(cleanTask.written, true, 'an unrelated, uncontended file must still be written normally');
});

// ================================================================================================
// FIX 4: the rewritten file keeps the ORIGINAL file's permission mode
// ================================================================================================

test("writeFileAtomic preserves the original file's permission mode on the rewritten file (a 0600 journal must not come back looser)", async () => {
  const journalRoot = mkJournalRoot();
  const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);
  fs.chmodSync(filePath, 0o600);

  await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
  });

  const mode = fs.statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600, "the rewritten file must keep the original file's 0600 bits, not the tmp file's default");
});

// ================================================================================================
// D1: the report must never state a write that did not happen
// ================================================================================================

test('D1: under --apply, the printed report says "files written" = what actually landed on disk, not what merely had a rewrite computed', async () => {
  const journalRoot = mkJournalRoot();
  const contendedPath = writeJournal(journalRoot, 'issue-contended', [targetEvent({ sessionId: 'sess-contended' })]);
  writeJournal(journalRoot, 'issue-clean-a', [targetEvent({ sessionId: 'sess-clean-a' })]);
  writeJournal(journalRoot, 'issue-clean-b', [targetEvent({ sessionId: 'sess-clean-b' })]);

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: async ({ sessionId }) => {
      if (sessionId === 'sess-contended') {
        fs.appendFileSync(contendedPath, JSON.stringify({ event: 'llm-call', ok: true, sessionId: 'sess-injected' }) + '\n');
      }
      return { ...RECOVERED_SAMPLE };
    },
  });

  // Ground truth: 3 files had a rewrite computed (filesChanged), only 2 actually landed
  // (filesWritten), 1 aborted.
  assert.equal(result.totals.filesChanged, 3);
  assert.equal(result.totals.filesWritten, 2);
  assert.equal(result.totals.filesAborted, 1);
  assert.equal(result.totals.billableAdded, 2500 * 3, 'computed total -- includes the aborted file\'s in-memory recovery');
  assert.equal(result.totals.billableAddedNotPersisted, 2500, 'exactly the aborted file\'s share');

  const { lines } = captureLog(() => printReport(result));
  const writtenLine = lines.find((l) => l.startsWith('files written'));
  assert.ok(writtenLine, 'expected a "files written" line under --apply');
  // The defect: this used to print totals.filesChanged (3) here. Must be 2.
  assert.match(writtenLine, /:\s*2\s*$/, `"files written" must say 2 (what was persisted), got: ${writtenLine}`);

  const billableLine = lines.find((l) => l.startsWith('billable tokens added'));
  assert.match(billableLine, /2,500 NOT persisted/, `the billable line must name the un-persisted amount, got: ${billableLine}`);
});

test('D1: under dry-run, "files that would be written" still reports filesChanged (no abort possible -- nothing is ever written)', async () => {
  const journalRoot = mkJournalRoot();
  writeJournal(journalRoot, 'issue-1', [targetEvent()]);

  const result = await runBackfill({
    journalRoot,
    apply: false,
    accountsDir: '/fake',
    recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
  });

  const { lines } = captureLog(() => printReport(result));
  const line = lines.find((l) => l.startsWith('files that would be written'));
  assert.match(line, /:\s*1\s*$/);
});

// ================================================================================================
// D2: a concurrent DELETE aborts only that file, not the whole run
// ================================================================================================

test('D2: the target being deleted between read and rename aborts THAT file only -- other files still process', async () => {
  const journalRoot = mkJournalRoot();
  const deletedPath = writeJournal(journalRoot, 'issue-deleted', [targetEvent({ sessionId: 'sess-deleted' })]);
  writeJournal(journalRoot, 'issue-clean', [targetEvent({ sessionId: 'sess-clean' })]);

  const result = await runBackfill({
    journalRoot,
    apply: true,
    accountsDir: '/fake',
    recoverFn: async ({ sessionId }) => {
      if (sessionId === 'sess-deleted') fs.unlinkSync(deletedPath);
      return { ...RECOVERED_SAMPLE };
    },
  });

  const deletedTask = result.perTask.find((t) => t.taskId === 'issue-deleted');
  assert.equal(deletedTask.concurrentWriteAborted, true);
  assert.equal(deletedTask.written, false);
  assert.equal(fs.existsSync(deletedPath), false, 'this tool must not recreate a file someone else deleted');

  const cleanTask = result.perTask.find((t) => t.taskId === 'issue-clean');
  assert.equal(cleanTask.written, true, 'a later file must still be processed after an earlier one aborted on delete');
  assert.equal(result.totals.filesWritten, 1);
  assert.equal(result.totals.filesAborted, 1);
});

test('D2: writeFileAtomic itself converts a delete-before-rename (ENOENT) into ConcurrentWriteError, not a raw fs error', () => {
  const dir = mkTmp('spo-backfill-delete-race-');
  const filePath = path.join(dir, 'journal.jsonl');
  fs.writeFileSync(filePath, 'original\n');
  const stat = fs.statSync(filePath);
  fs.unlinkSync(filePath); // simulate the delete happening between the caller's read and this call

  assert.throws(
    () => writeFileAtomicExport(filePath, 'rewritten\n', { expectedMtimeMs: stat.mtimeMs, expectedSize: stat.size }),
    ConcurrentWriteError
  );
  assert.equal(fs.existsSync(filePath), false, 'must not recreate the deleted file');
});

// ================================================================================================
// D3: a chmod failure must not take down the whole write
// ================================================================================================

test('D3: a chmodSync failure on the tmp file does not abort the write -- the rewrite still lands', () => {
  const dir = mkTmp('spo-backfill-chmod-fail-');
  const filePath = path.join(dir, 'journal.jsonl');
  fs.writeFileSync(filePath, 'original\n');

  const realChmodSync = fs.chmodSync;
  fs.chmodSync = () => {
    throw Object.assign(new Error('simulated ENOSYS'), { code: 'ENOSYS' });
  };
  try {
    writeFileAtomicExport(filePath, 'rewritten\n', { mode: 0o600 });
  } finally {
    fs.chmodSync = realChmodSync;
  }

  assert.equal(fs.readFileSync(filePath, 'utf8'), 'rewritten\n', 'the write must still land even though chmod failed');
  // no stray tmp file left behind
  const entries = fs.readdirSync(dir).filter((f) => f !== 'journal.jsonl');
  assert.deepEqual(entries, []);
});

test('D3: end to end through backfillFile -- a chmod failure still recovers and writes the target event', async () => {
  const journalRoot = mkJournalRoot();
  const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);

  const realChmodSync = fs.chmodSync;
  fs.chmodSync = () => {
    throw Object.assign(new Error('simulated ENOSYS'), { code: 'ENOSYS' });
  };
  let stats;
  try {
    stats = await backfillFile(filePath, {
      apply: true,
      accountsDir: '/fake',
      recoverFn: fakeRecoverFn({ 'sess-target-1': { ...RECOVERED_SAMPLE } }),
    });
  } finally {
    fs.chmodSync = realChmodSync;
  }

  assert.equal(stats.written, true);
  assert.equal(stats.concurrentWriteAborted, false);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8').trim()).tokensSource, 'transcript');
});

// ================================================================================================
// ONE ASSERTION: --force skips ONLY the named-lock refusal, never the per-file concurrency guard
// ================================================================================================

test('main(): --force does NOT skip the per-file concurrent-write guard -- a concurrent append during recovery still survives, unclobbered', async () => {
  await withSavedExitCode(async () => {
    const journalRoot = mkJournalRoot();
    const filePath = writeJournal(journalRoot, 'issue-1', [targetEvent()]);
    const concurrentLine = JSON.stringify({ ts: '2026-09-10T00:00:00.000Z', event: 'llm-call', sessionId: 'sess-appended-during-force-run', ok: true });

    await main(['--journal', journalRoot, '--apply', '--force'], {
      accountsDir: '/fake',
      recoverFn: async () => {
        fs.appendFileSync(filePath, concurrentLine + '\n');
        return { ...RECOVERED_SAMPLE };
      },
      liveDaemonLockHolderFn: () => null, // no lock held -- isolates this from the named-lock refusal entirely
    });

    const onDisk = fs.readFileSync(filePath, 'utf8');
    assert.ok(onDisk.includes(concurrentLine), 'the concurrently-appended line must survive on disk even under --force');
    assert.ok(!onDisk.includes('"tokensSource"'), 'the original target event must be UNCHANGED -- --force must not bypass the per-file guard');
  });
});
