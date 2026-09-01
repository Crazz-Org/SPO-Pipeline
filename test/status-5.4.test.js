'use strict';
// Action 5.4 -- `spo status` per spec, plus the four things measurement added to it:
//   A. the reason column reads state.json's OWN `reason`, never the last journal event's name
//   B. a card in action 4.4's bounded auto-retry backoff gets its own bucket, sourced from its
//      queue entry, and stops being double-counted as `active`
//   C. bench queue depth (~/.spo-bench/spool, running) and account health/cooldowns are folded
//      into `spo status`
//   D. today's spend, with the "n/a means not reported" honesty rule and the C4 caveat
//   E. `llm-call` gains `duration_s` (orchestrator/steps/llm.js)
//   F. the unpark scan's own consecutive-failure streak is surfaced per parked task
//   G. `spo tokens`'s parking rate denominator agrees with console/collect.js's
//
// Every fixture here is hand-written journal.jsonl/state.json/queue-entry JSON -- the same
// convention test/tokens.test.js's seedTaskJournal and test/abandoned-visibility.test.js use --
// never a real daemon run, since these tests are about how `spo status`/tokens.js/collect.js
// RENDER an already-produced journal, not about producing one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident this exists to prevent, and why this
// require has to land before the orchestrator require(s) below.
require('./no-real-spawn');

const { mkTmp, writeTask, writePoolDir, runSpo } = require('./helpers');
const { tokenReport, todaySpend } = require('../orchestrator/tokens');
const { collectDaemonStats, collectJournalTasks } = require('../console/collect');
const { invokeClaudeReal } = require('../orchestrator/steps/llm');

function writeJournalLines(taskDir, lines) {
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeStateJson(taskDir, state) {
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

// ---- A: reason column reads state.json's own `reason` -----------------------------------------

test('spo status: a PARKED row shows state.json\'s reason, not the last journal event name (issue-213 shape)', () => {
  const journalDir = mkTmp('spo-status-reason-');
  const id = 'issue-213';
  const dir = path.join(journalDir, id);

  // Reproduces the real corpus shape: a genuine park for diagnose-duplicate-root-cause, followed
  // by the unpark scan's own retry noise (`unpark-scan-failed`) as the journal's LAST event.
  writeJournalLines(dir, [
    { ts: '2026-08-30T09:00:00.000Z', state: 'DIAGNOSE', event: 'parked', reason: 'diagnose-duplicate-root-cause' },
    { ts: '2026-08-30T10:11:23.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
    { ts: '2026-08-30T10:12:23.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
  ]);
  writeStateJson(dir, { id, state: 'PARKED', reason: 'diagnose-duplicate-root-cause' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', mkTmp('spo-status-reason-queue-')]);
  assert.match(out, /issue-213\s+PARKED\s+reason=diagnose-duplicate-root-cause/);
  assert.doesNotMatch(out, /reason=unpark-scan-failed/);
});

test('spo status: a DONE row prints "done", not state.json\'s (absent) reason', () => {
  const journalDir = mkTmp('spo-status-reason-done-');
  const id = 'issue-500';
  const dir = path.join(journalDir, id);
  writeJournalLines(dir, [{ ts: '2026-09-01T00:00:00.000Z', state: 'DONE', event: 'done' }]);
  // FINISH's own snapshot() never writes a `reason` field -- see state-machine.js.
  writeStateJson(dir, { id, state: 'DONE' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', mkTmp('spo-status-reason-done-queue-')]);
  assert.match(out, /issue-500\s+DONE\s+done/);
});

test('spo status: an ABANDONED row shows state.json\'s reason (abandoned-by-maintainer)', () => {
  const journalDir = mkTmp('spo-status-reason-abandoned-');
  const id = 'issue-443';
  const dir = path.join(journalDir, id);
  writeJournalLines(dir, [{ ts: '2026-08-30T13:53:00.000Z', state: 'PARKED', event: 'abandoned-by-maintainer' }]);
  writeStateJson(dir, { id, state: 'ABANDONED', reason: 'abandoned-by-maintainer' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', mkTmp('spo-status-reason-abandoned-queue-')]);
  assert.match(out, /issue-443\s+ABANDONED\s+reason=abandoned-by-maintainer/);
});

// ---- B: a card in transient-retry backoff gets its own bucket, and is not double-counted ------

test('spo status: a card in action 4.4 backoff gets a BACKOFF row (attempt + next-run) and is not counted as active', () => {
  const journalDir = mkTmp('spo-status-backoff-journal-');
  const queueDir = mkTmp('spo-status-backoff-queue-');
  const id = 'issue-449';
  const dir = path.join(journalDir, id);

  // finalizePark's auto-retry path never marks state.json PARKED -- the task stays wherever it
  // last snapshotted (IMPLEMENT here), which is exactly why it used to fall into `active`.
  writeJournalLines(dir, [
    { ts: '2026-09-01T12:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call', step: 'IMPLEMENT' },
    { ts: '2026-09-01T12:05:00.000Z', state: 'GATE', event: 'transient-retry', reason: 'gate-non-attesting', attempt: 1, delayMs: 60000, notBefore: '2026-09-01T12:06:00.000Z' },
  ]);
  writeStateJson(dir, { id, state: 'IMPLEMENT' });

  // The queue entry park-loop.js's reEnqueueTask actually writes -- this is what governs the
  // next pickup, and what `spo status` is told to read from (item B's own instruction).
  writeTask(queueDir, '0000-retry-1-issue-449.json', { id, transientRetries: 1, notBefore: '2026-09-01T13:00:00.000Z' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /issue-449\s+BACKOFF\s+attempt=1\s+next-run=2026-09-01T13:00:00\.000Z/);
  // Not active, not parked -- its own bucket, and the summary line's `active` count must be 0,
  // not 1 (the double-count this item exists to close).
  assert.match(out, /active: 0\s+backoff: 1\s+parked: 0\s+abandoned: 0\s+done: 0/);
});

test('spo status: a backoff entry is NOT folded into `queue depth` -- it is counted once, in its own bucket', () => {
  // The other half of item B's double-count. A card waiting out a backoff is not queued WORK:
  // nothing will pick it up until its notBefore passes, so counting it as queue depth makes the
  // queue look busier than it is at exactly the moment a maintainer is asking why nothing moves.
  const journalDir = mkTmp('spo-status-backoff-depth-journal-');
  const queueDir = mkTmp('spo-status-backoff-depth-queue-');

  const backoffDir = path.join(journalDir, 'issue-449');
  writeJournalLines(backoffDir, [{ ts: '2026-09-01T09:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(backoffDir, { id: 'issue-449', state: 'IMPLEMENT' });
  writeTask(queueDir, '0000-retry-1-issue-449.json', { id: 'issue-449', transientRetries: 1, notBefore: '2099-01-01T00:00:00.000Z' });

  const readyDir = path.join(journalDir, 'issue-500');
  writeJournalLines(readyDir, [{ ts: '2026-09-01T09:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(readyDir, { id: 'issue-500', state: 'IMPLEMENT' });
  writeTask(queueDir, '001-fresh.json', { id: 'issue-500', title: 'fresh task' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /queue depth: 1\s+\(\+1 in backoff, counted below\)/, 'two files on disk, one of them queued work');
  assert.match(out, /backoff: 1/);
});

test('spo status: a backoff entry whose notBefore has already passed reads "due now", not a future next-run', () => {
  // An eligible entry is waiting for a DRAIN, not backing off. With the daemon stopped, a queue
  // of long-past notBefore entries reading "all backing off" instead of "nothing is draining
  // this queue" is wrong in the direction that costs a maintainer the most time.
  const journalDir = mkTmp('spo-status-backoff-past-journal-');
  const queueDir = mkTmp('spo-status-backoff-past-queue-');
  const dir = path.join(journalDir, 'issue-77');
  writeJournalLines(dir, [{ ts: '2026-08-01T00:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(dir, { id: 'issue-77', state: 'IMPLEMENT' });
  writeTask(queueDir, '0000-retry-2-issue-77.json', {
    id: 'issue-77',
    transientRetries: 2,
    notBefore: '2026-08-01T00:00:00.000Z',
  });

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /issue-77\s+BACKOFF\s+attempt=2\s+due now \(since 2026-08-01T00:00:00\.000Z\)/);
  assert.doesNotMatch(out, /next-run=2026-08-01/);
});

test('spo status: an ordinary queued task (no notBefore) is never mistaken for a backoff entry', () => {
  const journalDir = mkTmp('spo-status-nobackoff-journal-');
  const queueDir = mkTmp('spo-status-nobackoff-queue-');
  // The journal directory is what makes this test able to fail at all. Without it the task has no
  // row -- `listTaskDirs(journalRoot)` is what produces rows -- so `doesNotMatch(/BACKOFF/)` held
  // for EVERY implementation, and dropping the `notBefore` guard entirely (making every queue
  // entry a backoff entry) passed the whole suite.
  const dir = path.join(journalDir, 'issue-999');
  writeJournalLines(dir, [{ ts: '2026-09-01T09:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(dir, { id: 'issue-999', state: 'IMPLEMENT' });
  writeTask(queueDir, '001-fresh.json', { id: 'issue-999', title: 'fresh task' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /queue depth: 1/);
  assert.doesNotMatch(out, /BACKOFF/);
  assert.match(out, /active: 1\s+backoff: 0/, 'a plain queue entry is active, never backing off');
});

// ---- C: bench queue depth + account health/cooldowns -------------------------------------------

test('spo status: bench queue depth counts ~/.spo-bench/spool and running, and a missing bench dir does not crash', () => {
  const journalDir = mkTmp('spo-status-bench-journal-');
  const queueDir = mkTmp('spo-status-bench-queue-');
  const benchDir = mkTmp('spo-status-bench-');
  fs.mkdirSync(path.join(benchDir, 'spool'), { recursive: true });
  fs.mkdirSync(path.join(benchDir, 'running'), { recursive: true });
  fs.writeFileSync(path.join(benchDir, 'spool', 'job-1.json'), '{}');
  fs.writeFileSync(path.join(benchDir, 'spool', 'job-2.json'), '{}');
  fs.writeFileSync(path.join(benchDir, 'running', 'job-3.json'), '{}');

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir, '--bench-dir', benchDir]);
  assert.match(out, /bench: spool=2\s+running=1/);

  // A bench dir that does not exist at all (a dev box with no bench) must not crash -- exit 0.
  const missingBenchDir = path.join(mkTmp('spo-status-nobench-'), 'does-not-exist');
  const out2 = runSpo(['status', '--journal', journalDir, '--queue', queueDir, '--bench-dir', missingBenchDir]);
  assert.match(out2, /bench: spool=0\s+running=0/);
});

test('spo status: an expired cooldown renders as none, a live one renders with time remaining', () => {
  const journalDir = mkTmp('spo-status-accounts-journal-');
  const queueDir = mkTmp('spo-status-accounts-queue-');
  const accountsDir = mkTmp('spo-status-accounts-');
  writePoolDir(accountsDir, [{ name: 'pool1' }, { name: 'pool2' }]);

  const now = Date.now();
  fs.writeFileSync(
    path.join(accountsDir, 'state.json'),
    JSON.stringify({
      pool1: { cooldownUntil: now - 60 * 60 * 1000, lastUsageLimitAt: now - 2 * 60 * 60 * 1000, usageLimitStreak: 1 }, // expired
      pool2: { cooldownUntil: now + 2 * 60 * 60 * 1000 + 30 * 1000 }, // live, ~2h remaining
    })
  );

  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir, '--accounts-dir', accountsDir]);
  assert.match(out, /account pool1\s+enabled=true\s+cooldown=none/);
  assert.match(out, /account pool2\s+enabled=true\s+cooldown=cooling, 2h0\dm remaining/);
});

// ---- D: today's spend ---------------------------------------------------------------------------

test('todaySpend: counts only today\'s llm-call events, excludes tokensSource:null from "reported"', () => {
  const journalRoot = mkTmp('spo-status-spend-');
  const now = Date.now();
  const todayIso = new Date(now - 60 * 1000).toISOString(); // a minute ago, definitely today
  const yesterdayIso = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // >24h ago

  const dir = path.join(journalRoot, 'issue-700');
  writeJournalLines(dir, [
    { ts: yesterdayIso, state: 'PLAN', event: 'llm-call', tokensSource: 'modelUsage', freshInputTokens: 999999, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    // cacheReadTokens is NON-ZERO on purpose and must NOT reach the billable total. Every header
    // in orchestrator/tokens.js forbids folding it in, and with a zeroed fixture the mutant that
    // does fold it in passed the whole suite -- on the live corpus it turns issue-471's 194.4k
    // into 1.68M, an 8.7x inflation of the headline number `spo status` prints.
    { ts: todayIso, state: 'PLAN', event: 'llm-call', tokensSource: 'modelUsage', freshInputTokens: 100, cacheCreationTokens: 50, cacheReadTokens: 900000, outputTokens: 20 },
    // A killed/E2BIG call: numeric billableTokens-shaped fields all 0, tokensSource: null --
    // must be excluded from "reported", never counted as a genuine zero.
    { ts: todayIso, state: 'PLAN', event: 'llm-call', tokensSource: null, freshInputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
  ]);
  writeStateJson(dir, { id: 'issue-700', state: 'DONE' });

  const spend = todaySpend(journalRoot, { now });
  assert.equal(spend.llmCalls, 2); // yesterday's call is excluded entirely (out of window)
  assert.equal(spend.llmCallsWithTokens, 1);
  assert.equal(spend.llmCallsWithoutTokens, 1);
  assert.equal(spend.billableTokens, 100 + 50 + 20, 'cache-read is reported separately, never summed in');
  assert.equal(spend.cacheReadTokens, 900000, 'and it is still reported, just not as billable');
});

test('todaySpend: the day boundary is LOCAL midnight -- the same one console/collect.js buckets by', () => {
  // Both sides use local midnight today, so they agree -- but nothing pinned it, and flipping
  // todaySpend to setUTCHours passed the whole suite because the fixture (now-60s vs now-25h) is
  // boundary-insensitive by construction. `spo status`'s "today" and the dashboard's "today"
  // disagreeing by up to a day is exactly the CLI-vs-dashboard divergence item G just closed.
  const journalRoot = mkTmp('spo-todayspend-boundary-');
  const dir = path.join(journalRoot, 'issue-701');

  // A moment a few minutes after LOCAL midnight, and an event a few minutes BEFORE it.
  const now = new Date();
  now.setHours(0, 5, 0, 0);
  const justBefore = new Date(now.getTime() - 10 * 60 * 1000); // 23:55 local, yesterday
  const justAfter = new Date(now.getTime() - 60 * 1000); // 00:04 local, today

  writeJournalLines(dir, [
    { ts: justBefore.toISOString(), state: 'PLAN', event: 'llm-call', tokensSource: 'modelUsage', freshInputTokens: 700, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    { ts: justAfter.toISOString(), state: 'PLAN', event: 'llm-call', tokensSource: 'modelUsage', freshInputTokens: 11, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
  ]);
  writeStateJson(dir, { id: 'issue-701', state: 'DONE' });

  const spend = todaySpend(journalRoot, { now: now.getTime() });
  assert.equal(spend.llmCalls, 1, 'only the call after LOCAL midnight counts');
  assert.equal(spend.billableTokens, 11);
});

test('spo status: prints today\'s spend with the "not journalled at all" caveat, always', () => {
  const journalDir = mkTmp('spo-status-spend-cli-');
  const queueDir = mkTmp('spo-status-spend-cli-queue-');
  const out = runSpo(['status', '--journal', journalDir, '--queue', queueDir]);
  assert.match(out, /today: n\/a -- no token data reported for any call today/);
  assert.match(out, /intake\/triage steps are not journalled with token data at all/);
});

// ---- E: llm-call gains duration_s ----------------------------------------------------------------

test('invokeClaudeReal: a successful call reports durationS in SECONDS, measured around the spawn', async () => {
  // The fake spawn burns real time, and the assertion is a RANGE. `typeof === number` and `>= 0`
  // were the original assertions, and deleting the `/ 1000` passed the whole suite -- a field
  // named `_s` silently carrying milliseconds is a 1000x lie in the one journal field this
  // action exists to add.
  const BURN_MS = 200;
  const fakeSpawnSync = () => {
    const until = Date.now() + BURN_MS;
    while (Date.now() < until) {
      /* busy-wait: spawnSync is synchronous, so this is the only way to make it cost time */
    }
    return {
      status: 0,
      stdout: JSON.stringify({ result: '{"ok":true}', session_id: 's1', is_error: false }),
      stderr: '',
    };
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', cwd: '/tmp', model: 'sonnet', effort: 'low' },
    { spawnSync: fakeSpawnSync }
  );
  assert.equal(result.ok, true);
  assert.equal(typeof result.durationS, 'number');
  assert.ok(
    result.durationS >= 0.15 && result.durationS < 5,
    `durationS must be SECONDS (~0.2 for a ${BURN_MS}ms spawn), got ${result.durationS}`
  );
});

test('invokeClaudeReal: a deadline-killed call still reports the durationS it burned', async () => {
  const fakeSpawnSync = () => {
    const error = new Error('spawnSync SIGTERM ETIMEDOUT');
    error.code = 'ETIMEDOUT';
    return { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error };
  };
  const result = await invokeClaudeReal(
    { promptText: 'hi', cwd: '/tmp', model: 'sonnet', effort: 'low', deadlineMs: 1000 },
    { spawnSync: fakeSpawnSync }
  );
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(typeof result.durationS, 'number');
  assert.ok(result.durationS >= 0);
});

test('invokeClaudeReal: a failed (is_error) call also reports a numeric durationS', async () => {
  const fakeSpawnSync = () => ({
    status: 1,
    stdout: JSON.stringify({ result: 'boom', is_error: true, session_id: 's2' }),
    stderr: '',
  });
  const result = await invokeClaudeReal(
    { promptText: 'hi', cwd: '/tmp', model: 'sonnet', effort: 'low' },
    { spawnSync: fakeSpawnSync }
  );
  assert.equal(result.ok, false);
  assert.equal(typeof result.durationS, 'number');
});

// ---- F: the unpark scan's own failure streak ----------------------------------------------------

test('spo status: a parked task whose unpark scan has been failing shows the streak count and last timestamp', () => {
  const journalDir = mkTmp('spo-status-scan-fail-');
  const id = 'issue-213';
  const dir = path.join(journalDir, id);
  writeJournalLines(dir, [
    { ts: '2026-08-30T09:00:00.000Z', state: 'DIAGNOSE', event: 'parked', reason: 'diagnose-duplicate-root-cause' },
    { ts: '2026-08-30T10:11:23.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
    { ts: '2026-08-30T10:12:23.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
    // The real interleaving, taken verbatim from journal/issue-213's tail: comment-scan.js backs
    // a failing issue off and journals the skips, so the stream is failure, skip, skip, ...,
    // failure. A streak that breaks on a skip reported that 33-hour, 238-failure outage as
    // "x1 since 19:52:07" -- one minute instead of a day and a half. The skips are a CONSEQUENCE
    // of the failures; they are not a recovery.
    { ts: '2026-08-31T19:50:01.000Z', state: 'PARKED', event: 'unpark-scan-backoff-skip' },
    { ts: '2026-08-31T19:51:02.000Z', state: 'PARKED', event: 'unpark-scan-backoff-skip' },
    { ts: '2026-08-31T19:52:07.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
  ]);
  writeStateJson(dir, { id, state: 'PARKED', reason: 'diagnose-duplicate-root-cause' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', mkTmp('spo-status-scan-fail-queue-')]);
  assert.match(out, /retry-channel: 3 failure\(s\), last .+ ago \(first 2026-08-30T10:11:23\.000Z\)/);
});

test('spo status: a parked task with a successful scan since its failures shows none', () => {
  const journalDir = mkTmp('spo-status-scan-ok-');
  const id = 'issue-385';
  const dir = path.join(journalDir, id);
  writeJournalLines(dir, [
    { ts: '2026-08-30T09:00:00.000Z', state: 'WORKTREE', event: 'parked', reason: 'branch-unmerged-leftover' },
    { ts: '2026-08-30T10:00:00.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
    { ts: '2026-08-30T10:01:00.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
    // Something OTHER than a scan failure landed after the streak -- e.g. a truncation notice
    // from a scan that actually succeeded. The streak must reset to none.
    { ts: '2026-08-30T11:00:00.000Z', state: 'PARKED', event: 'unpark-scan-truncated', pagesScanned: 3 },
  ]);
  writeStateJson(dir, { id, state: 'PARKED', reason: 'branch-unmerged-leftover' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', mkTmp('spo-status-scan-ok-queue-')]);
  assert.match(out, /issue-385\s+PARKED\s+reason=branch-unmerged-leftover\s+retry-channel: no failures recorded/);
});

test('spo status: an unrelated event after the failures does NOT clear the streak -- only a park ending, or proof the scan worked', () => {
  // Measured LIVE, an hour after 5.4 shipped. Action 5.1b's reconciler appended one
  // `reconciled-externally` line to issue-213 and issue-428 on the daemon's first cycle on C5
  // code, and this line went from "238 failure(s), last 14h50m ago" to "no failures recorded".
  // The 238 failures had not gone anywhere. The fixture below is that exact journal shape.
  const journalDir = mkTmp('spo-status-scan-unrelated-');
  const id = 'issue-213';
  const dir = path.join(journalDir, id);
  writeJournalLines(dir, [
    { ts: '2026-08-29T21:08:09.000Z', state: 'PARKED', event: 'park-comment', commentId: 1 },
    { ts: '2026-08-30T10:11:23.997Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
    { ts: '2026-08-31T19:50:01.000Z', state: 'PARKED', event: 'unpark-scan-backoff-skip' },
    { ts: '2026-08-31T19:52:07.585Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
    // The reconciler's own line -- newer than the failures, and evidence of nothing about the scan.
    {
      ts: '2026-09-01T11:37:59.785Z',
      state: 'PARKED',
      event: 'reconciled-externally',
      via: 'pr-merged',
      closedAt: '2026-08-30T01:50:23Z',
    },
  ]);
  writeStateJson(dir, { id, state: 'PARKED', reason: 'diagnose-duplicate-root-cause' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', mkTmp('spo-status-scan-unrelated-queue-')]);
  assert.match(out, /retry-channel: 2 failure\(s\), last .+ ago \(first 2026-08-30T10:11:23\.997Z\)/);
  assert.doesNotMatch(out, /no failures recorded/);
});

test('spo status: an `unpark-scan-ignored-author` after the failures DOES clear the streak -- it proves gh answered', () => {
  // The other half of the rule. A successful scan that matches nothing journals no event at all,
  // so `unpark-scan-truncated` and `unpark-scan-ignored-author` are the only lines a WORKING scan
  // ever leaves. Both must end the streak, or a channel that recovered would report an outage
  // forever.
  const journalDir = mkTmp('spo-status-scan-recovered-');
  const id = 'issue-900';
  const dir = path.join(journalDir, id);
  writeJournalLines(dir, [
    { ts: '2026-08-30T09:00:00.000Z', state: 'WORKTREE', event: 'parked', reason: 'x' },
    { ts: '2026-08-30T10:00:00.000Z', state: 'PARKED', event: 'unpark-scan-failed', exit: 1, timedOut: false },
    { ts: '2026-08-30T11:00:00.000Z', state: 'PARKED', event: 'unpark-scan-ignored-author', login: 'someone' },
  ]);
  writeStateJson(dir, { id, state: 'PARKED', reason: 'x' });

  const out = runSpo(['status', '--journal', journalDir, '--queue', mkTmp('spo-status-scan-recovered-queue-')]);
  assert.match(out, /retry-channel: no failures recorded/);
});

// ---- G: the parking rate matches console/collect.js's denominator, same fixture -----------------

test('parking rate: tokenReport/cmdTokens and collect.js\'s collectDaemonStats agree on the terminal denominator, a kind: "synthetic" task included in the fixture but excluded from BOTH sides (action 5.5, item A)', () => {
  const journalRoot = mkTmp('spo-status-parking-rate-');

  writeJournalLines(path.join(journalRoot, 'issue-1'), [{ ts: '2026-09-01T00:00:00.000Z', state: 'DONE', event: 'done' }]);
  writeStateJson(path.join(journalRoot, 'issue-1'), { id: 'issue-1', state: 'DONE', updatedAt: '2026-09-01T00:00:00.000Z' });

  writeJournalLines(path.join(journalRoot, 'issue-2'), [{ ts: '2026-09-01T00:00:00.000Z', state: 'PARKED', event: 'parked', reason: 'x' }]);
  writeStateJson(path.join(journalRoot, 'issue-2'), { id: 'issue-2', state: 'PARKED', reason: 'x', updatedAt: '2026-09-01T00:00:00.000Z' });

  writeJournalLines(path.join(journalRoot, 'issue-3'), [{ ts: '2026-09-01T00:00:00.000Z', state: 'PARKED', event: 'abandoned-by-maintainer' }]);
  writeStateJson(path.join(journalRoot, 'issue-3'), { id: 'issue-3', state: 'ABANDONED', reason: 'abandoned-by-maintainer', updatedAt: '2026-09-01T00:00:00.000Z' });

  writeJournalLines(path.join(journalRoot, 'issue-4'), [{ ts: '2026-09-01T00:00:00.000Z', state: 'IMPLEMENT', event: 'llm-call' }]);
  writeStateJson(path.join(journalRoot, 'issue-4'), { id: 'issue-4', state: 'IMPLEMENT', updatedAt: '2026-09-01T00:00:00.000Z' });

  // action 5.5, item A: a demo-happy-001-shaped synthetic task, terminal (DONE) -- must NOT
  // enter EITHER side's denominator, or the two would disagree again (exactly the item G
  // regression this test already exists to guard against, this time from the other direction:
  // excluding it on only one side).
  writeJournalLines(path.join(journalRoot, 'demo-happy-001'), [{ ts: '2026-08-29T00:10:10.750Z', state: 'DONE', event: 'done' }]);
  writeStateJson(path.join(journalRoot, 'demo-happy-001'), { id: 'demo-happy-001', kind: 'synthetic', state: 'DONE', updatedAt: '2026-08-29T00:10:10.750Z' });

  // console/collect.js's own denominator: done + parked + abandoned (action 4.5), synthetics
  // excluded (action 5.5, item A).
  const journalTasks = collectJournalTasks(journalRoot);
  const daemonStats = collectDaemonStats(journalTasks, 0);
  assert.equal(daemonStats.total, 3); // issue-1 (done) + issue-2 (parked) + issue-3 (abandoned) -- NOT 4
  assert.equal(daemonStats.parkingRatePct, Math.round((1 / 3) * 100));

  // orchestrator/tokens.js / bin/spo's cmdTokens: same three tasks, same denominator now that
  // item G folds `abandoned` into `finished`, and item A excludes the same synthetic task.
  const report = tokenReport(journalRoot);
  const finished = report.done + report.parked + report.abandoned;
  assert.equal(finished, daemonStats.total);
  assert.equal(report.parked / finished, 1 / 3);

  const out = runSpo(['tokens', '--journal', journalRoot]);
  assert.match(out, /parking rate: 33% \(1\/3 terminal\)/);
});
