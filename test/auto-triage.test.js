'use strict';
// Tests for orchestrator/auto-triage.js -- stage 3+ of the human-first bug-report intake
// pipeline: shouldAutoTriage's pure timer decision, findConfirmedAwaitingTriage's daemon.jsonl
// anchor scan (report-confirmed with no later report-triaged/report-held for the same issue),
// and runAutoTriage/processConfirmedReport's triageBugReport -> reviewCard -> amendCard wiring
// (same deps.spawnSync injection convention test/intake.test.js already uses -- this file only
// asserts what is specific to the auto-triage driver: outcome routing, the dry/real split, the
// "never dispose a confirmed report on a negative outcome" hold rule, and the daemon.jsonl shape).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mkTmp, writePoolDir } = require('./helpers');
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const accounts = require('../orchestrator/accounts');
const {
  shouldAutoTriage,
  shouldSkipForTriageBackoff,
  triageBackoffMs,
  runAutoTriage,
  processConfirmedReport,
  retryHeldReport,
  findConfirmedAwaitingTriage,
  mechanicalFailureHistory,
  buildMechanicalHoldComment,
  reclaimStaleClaims,
  claimReport,
  claimSidecarPath,
  moveReportTo,
  DEFAULT_AUTO_TRIAGE_MS,
  DEFAULT_AUTO_TRIAGE_LIMIT,
  DEFAULT_TRIAGE_CLAIM_GRACE_MS,
  DEFAULT_TRIAGE_BACKOFF_BASE_MS,
  DEFAULT_TRIAGE_BACKOFF_CEILING_MS,
  MECHANICAL_FAILURE_CAP,
  IN_PROGRESS_DIRNAME,
} = require('../orchestrator/auto-triage');
const { appendDaemonEvent } = require('../orchestrator/journal');

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function poolDir() {
  return writePoolDir(mkTmp('spo-autotriage-pool-'), [{ name: 'acct1' }]);
}

// Same shape invokeClaudeReal's real spawn parses (test/intake.test.js's own helper).
function realShapedReply(resultObj) {
  return {
    result: typeof resultObj === 'string' ? resultObj : JSON.stringify(resultObj),
    is_error: false,
    num_turns: 1,
    session_id: 'sess-triage-1',
    modelUsage: { 'claude-x': { costUSD: 0.001 } },
    terminal_reason: 'success',
    api_error_status: null,
  };
}

function writePendingReport(spoReportsDir, filename) {
  const pendingDir = path.join(spoReportsDir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, filename), JSON.stringify({ version: 1 }));
  return path.join(pendingDir, filename);
}

const VALID_DRAFT = {
  title: 'Balance shows stale after a deposit',
  body_markdown: [
    'The header balance does not update after a deposit WS frame lands.',
    '',
    '<!-- anchorKey: a1b2c3d4 -->',
    '',
    '## Done means',
    'The header balance reflects the deposit immediately.',
    '',
    'Source: /triage-report queue, 2026-08-30',
  ].join('\n'),
  category: 'defect',
  size: 'S',
  area: 'rdo',
  is_bug_report: true,
  confirmed: true,
};

// Sequenced `claude` replies (one per invokeClaudeReal call: triageBugReport, then reviewCard for
// a "draft" outcome) plus a `gh` responder for amendCard/postIssueComment/board:move.
function makeDeps({ claudeReplies, claudeRawReplies, ghResponder, npmResponder, accountsDir }) {
  let claudeCallIdx = 0;
  // claudeRawReplies, when given, is a sequence of raw spawnSync-shaped results consumed BEFORE
  // claudeReplies -- {status, stdout, stderr, signal} or {error, ...}, for tests that need to
  // simulate a deadline kill (timeoutSpawnResult-shaped) rather than a parsed JSON reply.
  // Additive: no existing caller passes it, so claudeReplies' own behaviour is untouched.
  const claudeCalls = [...(claudeRawReplies || []), ...(claudeReplies || []).map((r) => ok(JSON.stringify(realShapedReply(r))))];
  return {
    accountsDir: accountsDir || poolDir(),
    spawnSync: (command, args, opts) => {
      if (command === 'claude') {
        return claudeCalls[Math.min(claudeCallIdx++, claudeCalls.length - 1)];
      }
      if (command === 'gh') {
        if (ghResponder) return ghResponder(args);
        if (args[0] === 'api') return ok(JSON.stringify({ body: 'original raw body' }));
        return ok('');
      }
      if (command === 'npm') {
        if (npmResponder) return npmResponder(args, opts); // opts: action 2.1b call-site arming
        return ok('');
      }
      return ok('');
    },
  };
}

function timeoutSpawnResult() {
  const err = new Error('spawnSync claude ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  return { error: err, status: 143, stdout: '', stderr: '', signal: 'SIGTERM' };
}

// A {kind: 'limit'} shaped raw spawn result (api_error_status: 429 -- steps/llm.js's own
// unambiguous classifyFailure rule) for the account-rotation tests below.
function limitSpawnResult() {
  return {
    status: 1,
    stdout: JSON.stringify({
      result: 'rate limited',
      is_error: true,
      num_turns: 1,
      session_id: 'sess-triage-limit',
      modelUsage: {},
      terminal_reason: 'error',
      api_error_status: 429,
    }),
    stderr: '',
    signal: null,
  };
}

function confirmedEntry(journalRoot, { issue, pendingPath, commentId = 1, kind }) {
  appendDaemonEvent(journalRoot, 'report-confirmed', { issue, pendingPath, commentId, kind });
}

// ---- shouldAutoTriage: pure decision function --------------------------------------------------

test('shouldAutoTriage: disabled at 0, regardless of lastTriageAt', () => {
  assert.equal(shouldAutoTriage(null, Date.now(), 0), false);
  assert.equal(shouldAutoTriage(Date.now() - 10_000_000, Date.now(), 0), false);
});

test('shouldAutoTriage: a never-run timer is due immediately once enabled', () => {
  assert.equal(shouldAutoTriage(null, 1_000, 300_000), true);
  assert.equal(shouldAutoTriage(undefined, 1_000, 300_000), true);
});

test('shouldAutoTriage: not yet due before the interval elapses', () => {
  const last = 1_000_000;
  assert.equal(shouldAutoTriage(last, last + 100_000, 300_000), false);
});

test('shouldAutoTriage: due exactly at and past the interval', () => {
  const last = 1_000_000;
  assert.equal(shouldAutoTriage(last, last + 300_000, 300_000), true);
  assert.equal(shouldAutoTriage(last, last + 400_000, 300_000), true);
});

test('defaults: 15 minutes / top 3', () => {
  assert.equal(DEFAULT_AUTO_TRIAGE_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_AUTO_TRIAGE_LIMIT, 3);
});

// ---- findConfirmedAwaitingTriage -----------------------------------------------------------

test('findConfirmedAwaitingTriage: only unhandled report-confirmed events, oldest first, capped at limit', () => {
  const journalRoot = mkTmp('spo-autotriage-find1-');
  appendDaemonEvent(journalRoot, 'report-confirmed', { issue: 101, pendingPath: '/a' });
  appendDaemonEvent(journalRoot, 'report-confirmed', { issue: 102, pendingPath: '/b' });
  appendDaemonEvent(journalRoot, 'report-triaged', { issue: 101, outcome: 'filed' }); // 101 handled
  appendDaemonEvent(journalRoot, 'report-confirmed', { issue: 103, pendingPath: '/c' });

  const found = findConfirmedAwaitingTriage(journalRoot, 10);
  assert.deepEqual(found.map((f) => f.issue), [102, 103]);

  const capped = findConfirmedAwaitingTriage(journalRoot, 1);
  assert.deepEqual(capped.map((f) => f.issue), [102]);
});

test('findConfirmedAwaitingTriage: a report-held event also counts as handled', () => {
  const journalRoot = mkTmp('spo-autotriage-find2-');
  appendDaemonEvent(journalRoot, 'report-confirmed', { issue: 201, pendingPath: '/a' });
  appendDaemonEvent(journalRoot, 'report-held', { issue: 201, outcome: 'not-reproduced' });
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);
});

// ---- processConfirmedReport / runAutoTriage --------------------------------------------------

test('runAutoTriage: action 2.1b -- the promote-to-Todo CALL SITE threads config through, so board:move is bounded too', async () => {
  // reviewAndFile -> board.moveIssueToColumn is the third moveIssueToColumn call site (alongside
  // report-intake.js's moveWithRetry). moveIssueToColumn arms NOTHING without an opts.config, by
  // design, so a call site that forgets to pass it silently leaves this one spawn unbounded while
  // every other spawn in the daemon is bounded -- exactly the gap action 2.1b exists to close.
  const spoReportsDir = mkTmp('spo-autotriage-movearm-');
  const journalRoot = mkTmp('spo-autotriage-movearm-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_marm.json');
  confirmedEntry(journalRoot, { issue: 999, pendingPath });

  let moveOpts = null;
  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review — 2026-08-30\n\n**Verdict:** FILE' },
    ],
    npmResponder: (args, opts) => {
      if (args.join(' ') === 'run board:move -- 999 Todo') moveOpts = opts;
      return ok('');
    },
  });

  await runAutoTriage(
    journalRoot,
    {
      spoReportsDir,
      productRepo: '/fake/repo',
      autoTriagePromoteToTodo: true,
      commandTimeoutsMs: { 'npm-run': 660000, gh: 120000 },
    },
    deps,
    { dry: false }
  );

  assert.equal(moveOpts && moveOpts.timeout, 660000, 'board:move must carry the npm-run class timeout');
});

test('runAutoTriage: draft -> FILE -> amendCard + move to Todo, report archived, journals one auto-triage event', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports1-');
  const journalRoot = mkTmp('spo-autotriage-journal1-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_aaa.json');
  confirmedEntry(journalRoot, { issue: 999, pendingPath });

  const seenGh = [];
  const seenNpm = [];
  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review — 2026-08-30\n\n**Verdict:** FILE' },
    ],
    ghResponder: (args) => {
      seenGh.push(args);
      if (args[0] === 'api') return ok(JSON.stringify({ body: 'original raw body' }));
      return ok('');
    },
    npmResponder: (args) => {
      seenNpm.push(args);
      return ok('');
    },
  });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true }, deps, { dry: false });

  assert.equal(result.ok, true);
  assert.equal(result.filed, 1);
  assert.equal(result.results[0].outcome, 'filed');

  assert.ok(seenGh.some((a) => a[0] === 'issue' && a[1] === 'edit' && a[2] === '999'));
  assert.ok(seenNpm.some((a) => a.join(' ') === 'run board:move -- 999 Todo'));

  assert.equal(fs.existsSync(pendingPath), false);
  const archived = path.join(spoReportsDir, 'archive', path.basename(pendingPath));
  assert.equal(fs.existsSync(archived), true);
  assert.match(fs.readFileSync(`${archived}.disposition.txt`, 'utf8'), /^filed: #999 —/);

  const daemonLog = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(daemonLog.some((e) => e.event === 'report-triaged' && e.issue === 999 && e.outcome === 'filed'));
  assert.ok(daemonLog.some((e) => e.event === 'auto-triage' && e.filed === 1));
});

test('runAutoTriage: draft -> DO_NOT_FILE -> HELD (commented, never archived), gh issue edit never called', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports2-');
  const journalRoot = mkTmp('spo-autotriage-journal2-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_bbb.json');
  confirmedEntry(journalRoot, { issue: 888, pendingPath });

  let editCalled = false;
  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'DO_NOT_FILE', corrections: [], first_comment_markdown: 'Not a real defect.' },
    ],
    ghResponder: (args) => {
      if (args[0] === 'issue' && args[1] === 'edit') editCalled = true;
      return ok('');
    },
  });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.held, 1);
  assert.equal(editCalled, false);
  assert.equal(fs.existsSync(pendingPath), true); // still there -- HELD, never disposed of
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-held"/);
  assert.match(daemonLog, /"outcome":"do-not-file"/);
});

test('runAutoTriage: outcome duplicate -> comments both issues, closes nothing wrong, archives the report', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports3-');
  const journalRoot = mkTmp('spo-autotriage-journal3-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_mobile_ccc.json');
  confirmedEntry(journalRoot, { issue: 777, pendingPath });

  const seenComments = [];
  const deps = makeDeps({
    claudeReplies: [{ outcome: 'duplicate', issue_number: 42, comment_markdown: 'Also seen 2026-08-30, mobile.' }],
    ghResponder: (args) => {
      if (args[0] === 'issue' && args[1] === 'comment') seenComments.push(args[2]);
      return ok('');
    },
  });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.duplicates, 1);
  assert.deepEqual(seenComments.sort(), ['42', '777']); // occurrence note on #42, closure note on #777
  assert.equal(fs.existsSync(pendingPath), false);
  const archived = path.join(spoReportsDir, 'archive', path.basename(pendingPath));
  assert.match(fs.readFileSync(`${archived}.disposition.txt`, 'utf8'), /^duplicate: #42 —/);
});

test('runAutoTriage: not-reproduced / insufficient / schema-version -- HELD, never archived, no gh issue edit', async () => {
  for (const outcome of ['not-reproduced', 'insufficient', 'schema-version']) {
    const spoReportsDir = mkTmp(`spo-autotriage-reports-${outcome}-`);
    const journalRoot = mkTmp(`spo-autotriage-journal-${outcome}-`);
    const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_ddd.json');
    confirmedEntry(journalRoot, { issue: 555, pendingPath });

    let editCalled = false;
    let commentCalled = false;
    const reply =
      outcome === 'schema-version'
        ? { outcome, found: 2, expected: 3 }
        : { outcome, reason: 'no journal entries around the flagged click' };
    const deps = makeDeps({
      claudeReplies: [reply],
      ghResponder: (args) => {
        if (args[0] === 'issue' && args[1] === 'edit') editCalled = true;
        if (args[0] === 'issue' && args[1] === 'comment') commentCalled = true;
        return ok('');
      },
    });

    const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

    assert.equal(result.held, 1);
    assert.equal(editCalled, false);
    assert.equal(commentCalled, true); // held reports are commented, not silently dropped
    assert.equal(fs.existsSync(pendingPath), true);
  }
});

test('runAutoTriage: dry run -- draft+review still happen, but no gh call, report stays pending, no journal', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports4-');
  const journalRoot = mkTmp('spo-autotriage-journal4-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_eee.json');
  confirmedEntry(journalRoot, { issue: 333, pendingPath });

  let ghCalled = false;
  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: 'FILE' },
    ],
    ghResponder: (args) => {
      if (!(args[0] === 'api')) ghCalled = true; // the read-only issue fetch never happens in dry mode either
      return ok('{}');
    },
  });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: true });

  assert.equal(ghCalled, false);
  assert.equal(result.results[0].outcome, 'would-file');
  assert.equal(fs.existsSync(pendingPath), true);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), true); // report-confirmed itself is on it
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.doesNotMatch(daemonLog, /"event":"report-triaged"/);
  assert.doesNotMatch(daemonLog, /"event":"report-held"/);
  assert.doesNotMatch(daemonLog, /"event":"auto-triage"/);
});

test('runAutoTriage: a mechanical triageBugReport failure is journaled as an auto-triage summary, but never as triaged/held (retried next cycle)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports5-');
  const journalRoot = mkTmp('spo-autotriage-journal5-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_fff.json');
  confirmedEntry(journalRoot, { issue: 222, pendingPath });

  const deps = makeDeps({ claudeReplies: ['not json at all'] });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.errors.length, 1);
  assert.equal(fs.existsSync(pendingPath), true);
  const daemonLog = fs.existsSync(path.join(journalRoot, 'daemon.jsonl'))
    ? fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    : '';
  assert.doesNotMatch(daemonLog, /"event":"report-triaged"/);
  assert.doesNotMatch(daemonLog, /"event":"report-held"/);
  // still "awaiting triage" next scan
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue), [222]);

  // An all-errors cycle is no longer invisible (card #449, 2026-08-30).
  const daemonEvents = daemonLog
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const summary = daemonEvents.find((e) => e.event === 'auto-triage');
  assert.ok(summary, 'an all-errors cycle is still journaled');
  assert.equal(summary.errors, 1);
  assert.equal(summary.filed, 0);
  assert.deepEqual(summary.errorIssues, [222]);
  assert.match(summary.firstError, /not valid JSON/);
});

test('runAutoTriage: an all-errors cycle is journaled, but a cycle with nothing confirmed still is not', async () => {
  // Nothing confirmed at all -- top.length === 0, disposed === 0, errors === 0 -- stays silent.
  const emptyJournalRoot = mkTmp('spo-autotriage-journal5b-');
  await runAutoTriage(emptyJournalRoot, { spoReportsDir: mkTmp('spo-autotriage-reports5b-'), productRepo: '/fake/repo' }, makeDeps({}), { dry: false });
  assert.equal(fs.existsSync(path.join(emptyJournalRoot, 'daemon.jsonl')), false);

  // Something confirmed, every attempt errors -- disposed === 0, errors > 0 -- journaled.
  const spoReportsDir = mkTmp('spo-autotriage-reports5c-');
  const journalRoot = mkTmp('spo-autotriage-journal5c-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_ggg.json');
  confirmedEntry(journalRoot, { issue: 333, pendingPath });
  const deps = makeDeps({ claudeReplies: ['not json at all'] });
  await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"auto-triage"/);
});

// ---- report-triage-retry: triageBugReport's own retry, made visible ---------------------------

test('runAutoTriage: a triageBugReport retry after a timeout is journaled as report-triage-retry, and does not count as "handled"', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports7-');
  const journalRoot = mkTmp('spo-autotriage-journal7-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_hhh.json');
  confirmedEntry(journalRoot, { issue: 449, pendingPath });

  const deps = makeDeps({
    claudeRawReplies: [timeoutSpawnResult()],
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review — 2026-08-30\n\n**Verdict:** FILE' },
    ],
    ghResponder: (args) => (args[0] === 'api' ? ok(JSON.stringify({ body: 'original raw body' })) : ok('')),
    npmResponder: () => ok(''),
  });

  const result = await runAutoTriage(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true },
    deps,
    { dry: false }
  );
  assert.equal(result.filed, 1);

  const daemonLog = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const retryEvent = daemonLog.find((e) => e.event === 'report-triage-retry');
  assert.ok(retryEvent, 'expected a report-triage-retry event');
  assert.equal(retryEvent.issue, 449);
  assert.equal(retryEvent.retryOk, true);
  assert.ok(daemonLog.some((e) => e.event === 'report-triaged' && e.issue === 449 && e.outcome === 'filed'));

  // the retry event never blocks the normal "handled" detection
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);
});

test('runAutoTriage: dry run -- a retry still happens but is not journaled', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports8-');
  const journalRoot = mkTmp('spo-autotriage-journal8-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_iii.json');
  confirmedEntry(journalRoot, { issue: 450, pendingPath });

  const deps = makeDeps({
    claudeRawReplies: [timeoutSpawnResult()],
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review — 2026-08-30\n\n**Verdict:** FILE' },
    ],
  });

  await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: true });

  const daemonLog = fs.existsSync(path.join(journalRoot, 'daemon.jsonl'))
    ? fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    : '';
  assert.doesNotMatch(daemonLog, /report-triage-retry/);
});

// ---- report-triage-cooldown: account-rotation made visible (plan action 3.6) -------------------
// intake.js's triageBugReport/reviewCard have no ctx.taskDir to journal a cooldown into
// themselves (see intake.js's callIntakeStepWithRotation header) -- they return `cooldowns` on
// the result instead, and this file is the one place that turns it into a daemon.jsonl event.
// This is the actual fix for the 2026-08-30/31 incident (53 consecutive auto-triage cycles over
// 12.8 hours, all silently re-picking the same limited account): a silent rotation used to be
// invisible; now it is a journal event a maintainer can find.

test('runAutoTriage: a triageBugReport rate-limit rotates accounts and is journaled as report-triage-cooldown', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports9-');
  const journalRoot = mkTmp('spo-autotriage-journal9-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_jjj.json');
  confirmedEntry(journalRoot, { issue: 460, pendingPath });

  const accountsDir = writePoolDir(mkTmp('spo-autotriage-pool2-'), [{ name: 'acct1' }, { name: 'acct2' }]);

  const deps = makeDeps({
    accountsDir,
    claudeRawReplies: [limitSpawnResult()],
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review — 2026-08-30\n\n**Verdict:** FILE' },
    ],
    ghResponder: (args) => (args[0] === 'api' ? ok(JSON.stringify({ body: 'original raw body' })) : ok('')),
    npmResponder: () => ok(''),
  });

  const result = await runAutoTriage(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true },
    deps,
    { dry: false }
  );
  assert.equal(result.filed, 1);

  const daemonLog = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const cooldownEvent = daemonLog.find((e) => e.event === 'report-triage-cooldown');
  assert.ok(cooldownEvent, 'expected a report-triage-cooldown event');
  assert.equal(cooldownEvent.issue, 460);
  assert.equal(cooldownEvent.step, 'TRIAGE_BUG_REPORT');
  assert.equal(cooldownEvent.account, 'acct1');
  assert.ok(daemonLog.some((e) => e.event === 'report-triaged' && e.issue === 460 && e.outcome === 'filed'));

  const state = accounts.readState(accountsDir);
  assert.ok(state.acct1, 'acct1 should be cooling');

  // the cooldown event never blocks the normal "handled" detection, same as report-triage-retry
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);
});

test('runAutoTriage: dry run -- a rate-limit rotation still happens but is not journaled', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports10-');
  const journalRoot = mkTmp('spo-autotriage-journal10-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_kkk.json');
  confirmedEntry(journalRoot, { issue: 461, pendingPath });

  const accountsDir = writePoolDir(mkTmp('spo-autotriage-pool2b-'), [{ name: 'acct1' }, { name: 'acct2' }]);

  const deps = makeDeps({
    accountsDir,
    claudeRawReplies: [limitSpawnResult()],
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: 'FILE' },
    ],
  });

  await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: true });

  const daemonLog = fs.existsSync(path.join(journalRoot, 'daemon.jsonl'))
    ? fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    : '';
  assert.doesNotMatch(daemonLog, /report-triage-cooldown/);
});

// The OTHER call site inside reviewAndFile. The 2026-08-31 incident's last cycle died on
// `reviewCard: claude call failed (limit)`, not on triageBugReport -- so reviewCard's cooldown
// has to reach daemon.jsonl on its own, with its own `step`, or the second half of the incident
// stays exactly as invisible as the first. Driven through kind: 'suggestion', which skips
// triageBugReport entirely, so the only LLM call in the cycle IS reviewCard.
test('runAutoTriage: a reviewCard rate-limit inside reviewAndFile is journaled as report-triage-cooldown with step REVIEW_CARD', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports11-');
  const journalRoot = mkTmp('spo-autotriage-journal11-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-30T10-00-00-000Z_desktop_lll.json');
  confirmedEntry(journalRoot, { issue: 462, pendingPath, kind: 'suggestion' });

  const accountsDir = writePoolDir(mkTmp('spo-autotriage-pool2c-'), [{ name: 'acct1' }, { name: 'acct2' }]);

  const deps = makeDeps({
    accountsDir,
    claudeRawReplies: [limitSpawnResult()], // acct1 -> limit, rotate to acct2
    claudeReplies: [{ verdict: 'FILE', corrections: [], first_comment_markdown: 'FILE' }],
    ghResponder: (args) =>
      args[0] === 'api' ? ok(JSON.stringify({ title: '[suggestion] x', body: 'b' })) : ok(''),
    npmResponder: () => ok(''),
  });

  const result = await runAutoTriage(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true },
    deps,
    { dry: false }
  );
  assert.equal(result.filed, 1);

  const daemonLog = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const cooldownEvent = daemonLog.find((e) => e.event === 'report-triage-cooldown');
  assert.ok(cooldownEvent, 'expected a report-triage-cooldown event for the reviewCard call');
  assert.equal(cooldownEvent.issue, 462);
  assert.equal(cooldownEvent.step, 'REVIEW_CARD');
  assert.equal(cooldownEvent.account, 'acct1');
  assert.ok(cooldownEvent.cooldownUntilIso, 'the event must say when acct1 comes back');

  assert.ok(accounts.readState(accountsDir).acct1, 'acct1 should be cooling');
  assert.equal(findConfirmedAwaitingTriage(journalRoot, 10).length, 0);
});

test('runAutoTriage: default limit 3 -- only the top 3 of 5 confirmed reports are processed', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports6-');
  const journalRoot = mkTmp('spo-autotriage-journal6-');
  for (let i = 0; i < 5; i++) {
    const p = writePendingReport(spoReportsDir, `2026-08-29T10-0${i}-00-000Z_desktop_r${i}.json`);
    confirmedEntry(journalRoot, { issue: 600 + i, pendingPath: p });
  }

  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'not-reproduced', reason: 'r0' },
      { outcome: 'not-reproduced', reason: 'r1' },
      { outcome: 'not-reproduced', reason: 'r2' },
    ],
  });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.processed, 3);
});

test('runAutoTriage: nothing confirmed -- no claude/gh spawn at all, no journal event', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports7-');
  const journalRoot = mkTmp('spo-autotriage-journal7-');

  let spawned = false;
  const deps = { accountsDir: poolDir(), spawnSync: () => { spawned = true; return ok(''); } };

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.processed, 0);
  assert.equal(spawned, false);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
});

// ---- kind: 'suggestion' -- mechanical draft, never a triageBugReport call ----------------------

test('runAutoTriage: kind "suggestion" -- never calls triageBugReport, drafts mechanically from the raw issue, files on FILE', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-sugg1-');
  const journalRoot = mkTmp('spo-autotriage-sugg-journal1-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-30T10-00-00-000Z_desktop_sugg1.json');
  confirmedEntry(journalRoot, { issue: 700, pendingPath, kind: 'suggestion' });

  const seenGh = [];
  const deps = makeDeps({
    // Exactly ONE claude reply: reviewCard. triageBugReport must never be called for a
    // suggestion -- if it were, this single reply would be consumed by the wrong call and the
    // JSON shape (a review verdict, not a triage outcome) would fail differently.
    claudeReplies: [{ verdict: 'FILE', corrections: [], first_comment_markdown: 'FILE' }],
    ghResponder: (args) => {
      seenGh.push(args);
      if (args[0] === 'api') return ok(JSON.stringify({ title: '[suggestion] desktop · Add a slider', body: 'Player asked for a slider instead of typing a number.' }));
      return ok('');
    },
  });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true }, deps, { dry: false });

  assert.equal(result.filed, 1);
  assert.ok(seenGh.some((a) => a[0] === 'issue' && a[1] === 'edit' && a[2] === '700'));
  // The mechanical draft's title strips the "[suggestion] " prefix report-card.js adds.
  const editCall = seenGh.find((a) => a[0] === 'issue' && a[1] === 'edit');
  const titleIdx = editCall.indexOf('--title');
  assert.equal(editCall[titleIdx + 1], 'desktop · Add a slider');
});

test('runAutoTriage: kind "suggestion" -- reviewCard can still DO_NOT_FILE it (HELD, never archived)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-sugg2-');
  const journalRoot = mkTmp('spo-autotriage-sugg-journal2-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-30T10-00-00-000Z_desktop_sugg2.json');
  confirmedEntry(journalRoot, { issue: 701, pendingPath, kind: 'suggestion' });

  const deps = makeDeps({
    claudeReplies: [{ verdict: 'DO_NOT_FILE', corrections: [], first_comment_markdown: 'Already covered by #12.' }],
    ghResponder: (args) => {
      if (args[0] === 'api') return ok(JSON.stringify({ title: '[suggestion] desktop · x', body: 'y' }));
      return ok('');
    },
  });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.held, 1);
  assert.equal(fs.existsSync(pendingPath), true);
});

test('runAutoTriage: kind "suggestion" -- a fetchIssue failure is a mechanical error, retried next cycle', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-sugg3-');
  const journalRoot = mkTmp('spo-autotriage-sugg-journal3-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-30T10-00-00-000Z_desktop_sugg3.json');
  confirmedEntry(journalRoot, { issue: 702, pendingPath, kind: 'suggestion' });

  const deps = makeDeps({
    claudeReplies: [],
    ghResponder: (args) => (args[0] === 'api' ? { status: 1, stdout: '', stderr: 'boom', signal: null } : ok('')),
  });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.errors.length, 1);
  assert.equal(fs.existsSync(pendingPath), true);
});

// ---- action 2.6: the in-progress claim mutex -------------------------------------------------
// Report #443 was filed AND held 20 seconds apart because nothing stopped the daemon's own
// autoTriageMs timer and a hand-run `spo triage` from picking up the SAME confirmed report at
// the same time (PR #447 had to be closed by hand). These tests cover the fix: claimReport's
// atomic rename into in-progress/ BEFORE any LLM call, restoring/archiving it afterward, and
// reclaimStaleClaims' crash recovery.

function inProgressPathFor(spoReportsDir, pendingPath) {
  return path.join(spoReportsDir, IN_PROGRESS_DIRNAME, path.basename(pendingPath));
}

test('processConfirmedReport: claims the report into in-progress/ BEFORE triageBugReport is called', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-claim-order-');
  const journalRoot = mkTmp('spo-autotriage-claim-order-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_ord1.json');
  const claimedPath = inProgressPathFor(spoReportsDir, pendingPath);

  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: 'FILE' },
    ],
    npmResponder: () => ok(''),
  });
  const baseSpawnSync = deps.spawnSync;
  let sawClaimedWhenCalled = null;
  deps.spawnSync = (command, args, opts) => {
    if (command === 'claude' && sawClaimedWhenCalled === null) {
      // The ordering assertion: by the moment triageBugReport spawns `claude`, the file must
      // already be gone from pending/ and sitting in in-progress/ -- not just "eventually", at
      // THIS instant, before the expensive call is even made.
      sawClaimedWhenCalled = fs.existsSync(claimedPath) && !fs.existsSync(pendingPath);
    }
    return baseSpawnSync(command, args, opts);
  };

  const entry = { issue: 900, pendingPath, commentId: 1, kind: null };
  const result = await processConfirmedReport(entry, journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(sawClaimedWhenCalled, true, 'the file must be claimed before triageBugReport is called, not after');
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'filed');

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-triage-claimed"/);
});

test('processConfirmedReport: a second concurrent runner finds the report already claimed and skips it without calling triageBugReport', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-claim-race-');
  const journalRoot = mkTmp('spo-autotriage-claim-race-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_race1.json');

  // Simulate a winner that claimed the report a moment before this call -- the exact race
  // findConfirmedAwaitingTriage cannot see (it only reads daemon.jsonl's terminal events).
  const claimedPath = inProgressPathFor(spoReportsDir, pendingPath);
  fs.mkdirSync(path.dirname(claimedPath), { recursive: true });
  fs.renameSync(pendingPath, claimedPath);

  let spawned = false;
  const deps = { accountsDir: poolDir(), spawnSync: () => { spawned = true; return ok(''); } };

  const entry = { issue: 901, pendingPath, commentId: 1, kind: null };
  const result = await processConfirmedReport(entry, journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'already-claimed');
  assert.equal(spawned, false, 'triageBugReport must never be called for an already-claimed report');
  // The loser must not disturb the winner's claim.
  assert.equal(fs.existsSync(claimedPath), true);
});

test('processConfirmedReport: filed/duplicate/held/do-not-file all move the file OUT of in-progress/ to the right destination', async () => {
  async function runOne(name, claudeReplies) {
    const spoReportsDir = mkTmp(`spo-autotriage-claim-term-${name}-`);
    const journalRoot = mkTmp(`spo-autotriage-claim-term-journal-${name}-`);
    const pendingPath = writePendingReport(spoReportsDir, `2026-08-31T10-00-00-000Z_desktop_${name}.json`);
    const entry = { issue: 910, pendingPath, commentId: 1, kind: null };
    const deps = makeDeps({
      claudeReplies,
      npmResponder: () => ok(''),
      ghResponder: (args) => (args[0] === 'api' ? ok(JSON.stringify({ body: 'original raw body' })) : ok('')),
    });

    const result = await processConfirmedReport(entry, journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

    const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
    assert.deepEqual(
      fs.existsSync(inProgressDir) ? fs.readdirSync(inProgressDir) : [],
      [],
      `${name}: nothing must be left stranded in in-progress/`
    );
    return { result, spoReportsDir, pendingPath };
  }

  {
    const { result, spoReportsDir, pendingPath } = await runOne('filed', [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: 'FILE' },
    ]);
    assert.equal(result.outcome, 'filed');
    assert.equal(fs.existsSync(pendingPath), false);
    assert.equal(fs.existsSync(path.join(spoReportsDir, 'archive', path.basename(pendingPath))), true);
  }

  {
    const { result, spoReportsDir, pendingPath } = await runOne('duplicate', [
      { outcome: 'duplicate', issue_number: 55, comment_markdown: 'Also seen elsewhere.' },
    ]);
    assert.equal(result.outcome, 'duplicate');
    assert.equal(fs.existsSync(pendingPath), false);
    assert.equal(fs.existsSync(path.join(spoReportsDir, 'archive', path.basename(pendingPath))), true);
  }

  {
    const { result, pendingPath } = await runOne('held', [{ outcome: 'not-reproduced', reason: 'no journal entries' }]);
    assert.equal(result.outcome, 'not-reproduced');
    assert.equal(fs.existsSync(pendingPath), true, 'held reports go back to pending/, never archived');
  }

  {
    const { result, pendingPath } = await runOne('donotfile', [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'DO_NOT_FILE', corrections: [], first_comment_markdown: 'Not a real defect.' },
    ]);
    assert.equal(result.outcome, 'do-not-file');
    assert.equal(fs.existsSync(pendingPath), true, 'DO_NOT_FILE goes back to pending/, never archived');
  }
});

test('processConfirmedReport: a mechanical triageBugReport failure leaves the file recoverable in pending/, not stranded in in-progress/', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-claim-mech-');
  const journalRoot = mkTmp('spo-autotriage-claim-mech-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_mech1.json');
  const entry = { issue: 920, pendingPath, commentId: 1, kind: null };
  const deps = makeDeps({ claudeReplies: ['not json at all'] });

  const result = await processConfirmedReport(entry, journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(pendingPath), true);
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  assert.deepEqual(fs.existsSync(inProgressDir) ? fs.readdirSync(inProgressDir) : [], []);
});

test('processConfirmedReport: a dry run claims nothing -- no in-progress/ directory, no rename, no report-triage-claimed event', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-claim-dry-');
  const journalRoot = mkTmp('spo-autotriage-claim-dry-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_dry1.json');
  const entry = { issue: 940, pendingPath, commentId: 1, kind: null };
  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: 'FILE' },
    ],
  });

  const result = await processConfirmedReport(entry, journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: true });

  assert.equal(result.outcome, 'would-file');
  assert.equal(fs.existsSync(pendingPath), true, 'the file must never move for a dry run');
  assert.equal(fs.existsSync(path.join(spoReportsDir, IN_PROGRESS_DIRNAME)), false, 'a dry run must not even create in-progress/');
  const daemonLog = fs.existsSync(path.join(journalRoot, 'daemon.jsonl'))
    ? fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    : '';
  assert.doesNotMatch(daemonLog, /report-triage-claimed/);
});

test('reclaimStaleClaims: defaults to 4 minutes, same value as orphan-scan.js\'s own grace window', () => {
  assert.equal(DEFAULT_TRIAGE_CLAIM_GRACE_MS, 4 * 60 * 1000);
});

test('reclaimStaleClaims: a claim whose owner is still alive is left alone regardless of age', () => {
  const spoReportsDir = mkTmp('spo-autotriage-reclaim-alive-');
  const journalRoot = mkTmp('spo-autotriage-reclaim-alive-journal-');
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  fs.mkdirSync(inProgressDir, { recursive: true });
  const file = '2026-08-31T09-00-00-000Z_desktop_alive.json';
  fs.writeFileSync(path.join(inProgressDir, file), JSON.stringify({ version: 1 }));
  fs.writeFileSync(
    claimSidecarPath(path.join(inProgressDir, file)),
    JSON.stringify({ pid: 123, host: os.hostname(), claimedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
  );

  const reclaimed = reclaimStaleClaims(journalRoot, { spoReportsDir, triageClaimGraceMs: 1000 }, { isAlive: () => true });

  assert.deepEqual(reclaimed, []);
  assert.equal(fs.existsSync(path.join(inProgressDir, file)), true, 'a live owner\'s claim must never be swept, no matter how old');
});

test('reclaimStaleClaims: a claim whose owner is dead but still inside the grace window is left alone', () => {
  const spoReportsDir = mkTmp('spo-autotriage-reclaim-grace-');
  const journalRoot = mkTmp('spo-autotriage-reclaim-grace-journal-');
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  fs.mkdirSync(inProgressDir, { recursive: true });
  const file = '2026-08-31T09-00-00-000Z_desktop_fresh.json';
  fs.writeFileSync(path.join(inProgressDir, file), JSON.stringify({ version: 1 }));
  fs.writeFileSync(
    claimSidecarPath(path.join(inProgressDir, file)),
    JSON.stringify({ pid: 999999, host: os.hostname(), claimedAt: new Date().toISOString() })
  );

  const reclaimed = reclaimStaleClaims(journalRoot, { spoReportsDir, triageClaimGraceMs: 10 * 60 * 1000 }, { isAlive: () => false });

  assert.deepEqual(reclaimed, []);
  assert.equal(fs.existsSync(path.join(inProgressDir, file)), true);
});

test('reclaimStaleClaims: a claim whose owner is dead AND past the grace window is swept back to pending/ (crash recovery)', () => {
  const spoReportsDir = mkTmp('spo-autotriage-claim-reclaim-');
  const journalRoot = mkTmp('spo-autotriage-claim-reclaim-journal-');
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  fs.mkdirSync(inProgressDir, { recursive: true });
  const file = '2026-08-31T09-00-00-000Z_desktop_stranded.json';
  fs.writeFileSync(path.join(inProgressDir, file), JSON.stringify({ version: 1 }));
  fs.writeFileSync(
    claimSidecarPath(path.join(inProgressDir, file)),
    JSON.stringify({ pid: 999999, host: os.hostname(), claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
  );

  const reclaimed = reclaimStaleClaims(journalRoot, { spoReportsDir, triageClaimGraceMs: 4 * 60 * 1000 }, { isAlive: () => false });

  assert.deepEqual(reclaimed, [file]);
  assert.equal(fs.existsSync(path.join(spoReportsDir, 'pending', file)), true);
  assert.equal(fs.existsSync(path.join(inProgressDir, file)), false);
  assert.equal(fs.existsSync(claimSidecarPath(path.join(inProgressDir, file))), false);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-triage-reclaimed"/);
});

test('reclaimStaleClaims: a claim with no readable sidecar falls back to the file\'s own mtime under the same grace window', () => {
  const spoReportsDir = mkTmp('spo-autotriage-reclaim-nosidecar-');
  const journalRoot = mkTmp('spo-autotriage-reclaim-nosidecar-journal-');
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  fs.mkdirSync(inProgressDir, { recursive: true });
  const file = '2026-08-31T09-00-00-000Z_desktop_nosidecar.json';
  const filePath = path.join(inProgressDir, file);
  fs.writeFileSync(filePath, JSON.stringify({ version: 1 }));
  // No sidecar at all -- as if the crash landed between the rename and the sidecar write.
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(filePath, old, old);

  const reclaimed = reclaimStaleClaims(journalRoot, { spoReportsDir, triageClaimGraceMs: 4 * 60 * 1000 }, {});

  assert.deepEqual(reclaimed, [file]);
  assert.equal(fs.existsSync(path.join(spoReportsDir, 'pending', file)), true);
});

test('runAutoTriage: a claim stranded by a crash is reclaimed and successfully re-triaged in the same cycle', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-claim-crash-');
  const journalRoot = mkTmp('spo-autotriage-claim-crash-journal-');
  const file = '2026-08-31T09-00-00-000Z_desktop_crash1.json';
  const pendingPath = path.join(spoReportsDir, 'pending', file);

  // The state a hard-killed daemon (or a killed `spo triage --file`) leaves behind: the
  // report-confirmed event was journaled, a first runner claimed the file and then died before
  // writing any terminal event at all.
  confirmedEntry(journalRoot, { issue: 930, pendingPath });
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  fs.mkdirSync(inProgressDir, { recursive: true });
  fs.writeFileSync(path.join(inProgressDir, file), JSON.stringify({ version: 1 }));
  fs.writeFileSync(
    claimSidecarPath(path.join(inProgressDir, file)),
    JSON.stringify({ pid: 999999, host: os.hostname(), claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
  );

  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: 'FILE' },
    ],
    npmResponder: () => ok(''),
  });
  deps.isAlive = () => false;

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.filed, 1, 'the stranded report must be reclaimed to pending/ and re-triaged within the same cycle');
  assert.equal(fs.existsSync(path.join(spoReportsDir, IN_PROGRESS_DIRNAME, file)), false);
});

test('runAutoTriage: a dry run never sweeps in-progress/, even when a stale claim is sitting there', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-claim-dry2-');
  const journalRoot = mkTmp('spo-autotriage-claim-dry2-journal-');
  const file = '2026-08-31T09-00-00-000Z_desktop_drystale.json';
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  fs.mkdirSync(inProgressDir, { recursive: true });
  fs.writeFileSync(path.join(inProgressDir, file), JSON.stringify({ version: 1 }));
  fs.writeFileSync(
    claimSidecarPath(path.join(inProgressDir, file)),
    JSON.stringify({ pid: 999999, host: os.hostname(), claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
  );

  await runAutoTriage(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo' },
    { accountsDir: poolDir(), isAlive: () => false, spawnSync: () => ok('') },
    { dry: true }
  );

  assert.equal(fs.existsSync(path.join(inProgressDir, file)), true, 'a dry run must not reclaim a stale in-progress file');
});

// D1: fs.renameSync PRESERVES mtime, and a report file is named for when the player filed it,
// then sits in pending/ awaiting a human confirm -- hours or days. So the sidecar-less fallback
// read that original mtime, judged every fresh claim instantly stale, and could reclaim a LIVE
// claim during the window between claimReport's rename and its sidecar write -- re-opening the
// exact double-triage this whole action closes. claimReport now stamps the claim time onto the
// file.
test('claimReport: stamps the claimed file\'s mtime, so an OLD report is not instantly stale to the sidecar-less fallback', () => {
  const spoReportsDir = mkTmp('spo-autotriage-claim-mtime-');
  const journalRoot = mkTmp('spo-autotriage-claim-mtime-journal-');
  const pendingDir = path.join(spoReportsDir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const pendingPath = path.join(pendingDir, '2026-08-01T09-00-00-000Z_desktop_old.json');
  fs.writeFileSync(pendingPath, JSON.stringify({ version: 1 }));

  // The report was filed three days ago and has been waiting for a human ever since.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(pendingPath, threeDaysAgo, threeDaysAgo);

  const claim = claimReport(spoReportsDir, pendingPath);
  assert.equal(claim.claimed, true);

  const ageMs = Date.now() - fs.statSync(claim.path).mtimeMs;
  assert.ok(ageMs < 60 * 1000, `a fresh claim must look fresh, not ${Math.round(ageMs / 1000)}s old`);

  // Now the decisive property: with the sidecar removed (the crash window), a sweep must still
  // leave this brand-new claim alone.
  fs.unlinkSync(claimSidecarPath(claim.path));
  const reclaimed = reclaimStaleClaims(journalRoot, { spoReportsDir, triageClaimGraceMs: 60 * 1000 }, {});
  assert.deepEqual(reclaimed, [], 'a live claim must not be swept just because the report file is old');
  assert.equal(fs.existsSync(claim.path), true);
});

// moveReportTo's own fs.renameSync is guarded the same way claimReport's is, just above: ENOENT
// means a concurrent disposal already won the race and moved reportPath to dest first (a stale
// claim reclaimed back to pending/ mid-archive, or two runners racing the same confirmed report),
// so it is not an error -- moveReportTo returns dest and leaves the winner's disposition sidecar
// alone. Any other rename error (EXDEV across filesystems, EPERM, ...) still propagates: there is
// no "someone else already handled it" story for those, and swallowing them would hide a real
// filesystem problem. Monkey-patching fs.renameSync (same spy idiom test/journal.test.js already
// uses for this exact call) is the only deterministic way to land inside the guard.
test('moveReportTo: an ENOENT rename (already moved by a concurrent disposal) is swallowed -- returns dest, leaves the existing disposition file alone', () => {
  const spoReportsDir = mkTmp('spo-autotriage-movereport-enoent-');
  const targetDir = path.join(spoReportsDir, 'archive');
  fs.mkdirSync(targetDir, { recursive: true });
  const reportPath = path.join(spoReportsDir, 'in-progress', '2026-09-01T00-00-00-000Z_desktop_race.json');
  const dest = path.join(targetDir, path.basename(reportPath));
  // The "winner" already moved the file and wrote its own disposition line.
  fs.writeFileSync(dest, JSON.stringify({ version: 1 }));
  fs.writeFileSync(`${dest}.disposition.txt`, 'filed: #1 — 2026-09-01\n');

  const origRename = fs.renameSync;
  fs.renameSync = (src, d) => {
    if (src === reportPath && d === dest) {
      const err = new Error('simulated: source already gone');
      err.code = 'ENOENT';
      throw err;
    }
    return origRename(src, d);
  };
  try {
    const result = moveReportTo(reportPath, targetDir, 'duplicate: #2 — 2026-09-01');
    assert.equal(result, dest, 'ENOENT must be treated as "already moved", returning dest rather than throwing');
  } finally {
    fs.renameSync = origRename;
  }

  // The loser must not clobber the winner's disposition line.
  assert.equal(fs.readFileSync(`${dest}.disposition.txt`, 'utf8'), 'filed: #1 — 2026-09-01\n');
});

test('moveReportTo: a non-ENOENT rename failure (e.g. EXDEV) still propagates -- never swallowed', () => {
  const spoReportsDir = mkTmp('spo-autotriage-movereport-exdev-');
  const targetDir = path.join(spoReportsDir, 'archive');
  const reportPath = path.join(spoReportsDir, 'in-progress', '2026-09-01T00-00-00-000Z_desktop_exdev.json');

  const origRename = fs.renameSync;
  const simulated = new Error('simulated: cross-device link');
  simulated.code = 'EXDEV';
  fs.renameSync = () => {
    throw simulated;
  };
  try {
    assert.throws(() => moveReportTo(reportPath, targetDir, 'filed: #3 — 2026-09-01'), (err) => err === simulated);
  } finally {
    fs.renameSync = origRename;
  }
});

// REACHABILITY, not unit: the two tests above prove moveReportTo's guard works when called
// directly -- they do not prove the daemon ever benefits. This one drives a whole runAutoTriage
// filed cycle with the archive rename forced to ENOENT and asserts the cycle RETURNS. Without the
// guard it does not: the throw leaves reviewAndFile, passes processConfirmedReport's catch-less
// `finally`, and exits runAutoTriage, which is what kills the scan loop (card #101). Verified both
// ways -- with the guard removed this test throws ENOENT instead of failing an assertion.
test('runAutoTriage: an ENOENT on the archive rename does not escape the cycle -- the scan loop survives', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-archive-enoent-');
  const journalRoot = mkTmp('spo-autotriage-archive-enoent-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-09-01T10-00-00-000Z_desktop_race.json');
  confirmedEntry(journalRoot, { issue: 999, pendingPath });

  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review\n\n**Verdict:** FILE' },
    ],
    ghResponder: (args) => (args[0] === 'api' ? ok(JSON.stringify({ body: 'original raw body' })) : ok('')),
    npmResponder: () => ok(''),
  });

  // ENOENT on the ARCHIVE rename only -- claimReport's pending/ -> in-progress/ move and the
  // `finally`'s restore must both still work, or this would prove nothing about the guard.
  const origRename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (String(dest).includes(`${path.sep}archive${path.sep}`)) {
      const err = new Error('simulated: source already gone');
      err.code = 'ENOENT';
      throw err;
    }
    return origRename(src, dest);
  };
  let result;
  try {
    result = await runAutoTriage(
      journalRoot,
      { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true },
      deps,
      { dry: false }
    );
  } finally {
    fs.renameSync = origRename;
  }

  assert.equal(result.ok, true, 'the cycle must complete, not throw out into runScanCycle');
  assert.equal(result.filed, 1);
  assert.equal(result.results[0].outcome, 'filed');
});

// D3: a claim we can never probe -- a foreign hostname after a WSL/container rebuild -- had no age
// bound at all, so a report a human explicitly confirmed became permanently invisible. Nothing
// surfaces that: the eligibility scan reads daemon.jsonl, `spo reports` reads pending/.
test('reclaimStaleClaims: a foreign-host claim is left alone at first, but reclaimed past the absolute ceiling', () => {
  const mk = (ageMs) => {
    const spoReportsDir = mkTmp('spo-autotriage-foreign-');
    const journalRoot = mkTmp('spo-autotriage-foreign-journal-');
    const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
    fs.mkdirSync(inProgressDir, { recursive: true });
    const file = '2026-08-31T09-00-00-000Z_desktop_foreign.json';
    const claimed = path.join(inProgressDir, file);
    fs.writeFileSync(claimed, JSON.stringify({ version: 1 }));
    fs.writeFileSync(
      claimSidecarPath(claimed),
      JSON.stringify({ pid: 4242, host: 'a-machine-that-no-longer-exists', claimedAt: new Date(Date.now() - ageMs).toISOString() })
    );
    return { spoReportsDir, journalRoot, claimed, file };
  };
  const graceMs = 1000;

  const fresh = mk(5 * graceMs);
  assert.deepEqual(
    reclaimStaleClaims(fresh.journalRoot, { spoReportsDir: fresh.spoReportsDir, triageClaimGraceMs: graceMs }, {}),
    [],
    'not yet at the ceiling -- no evidence either way, so leave it'
  );

  const ancient = mk(500 * graceMs);
  const reclaimed = reclaimStaleClaims(ancient.journalRoot, { spoReportsDir: ancient.spoReportsDir, triageClaimGraceMs: graceMs }, {});
  assert.equal(reclaimed.length, 1, 'past the ceiling it must be reclaimed regardless of host');
  assert.equal(fs.existsSync(path.join(ancient.spoReportsDir, 'pending', ancient.file)), true);
  assert.equal(fs.existsSync(ancient.claimed), false);
});

// D5: an explicit 0 must mean 0, not "fall back to four minutes".
test('reclaimStaleClaims: triageClaimGraceMs of 0 is honoured, not treated as absent', () => {
  const spoReportsDir = mkTmp('spo-autotriage-grace-zero-');
  const journalRoot = mkTmp('spo-autotriage-grace-zero-journal-');
  const inProgressDir = path.join(spoReportsDir, IN_PROGRESS_DIRNAME);
  fs.mkdirSync(inProgressDir, { recursive: true });
  const file = '2026-08-31T09-00-00-000Z_desktop_zero.json';
  const claimed = path.join(inProgressDir, file);
  fs.writeFileSync(claimed, JSON.stringify({ version: 1 }));
  fs.writeFileSync(
    claimSidecarPath(claimed),
    JSON.stringify({ pid: 4243, host: os.hostname(), claimedAt: new Date().toISOString() })
  );

  const reclaimed = reclaimStaleClaims(journalRoot, { spoReportsDir, triageClaimGraceMs: 0 }, { isAlive: () => false });
  assert.equal(reclaimed.length, 1, 'grace 0 + a dead owner reclaims immediately');
});

// M7: the suggestion path spends an LLM call too -- reviewCard, inside reviewAndFile -- so the
// claim has to happen BEFORE the kind branch, not merely before triageBugReport. The code was
// already right, but nothing pinned it: every claim test used kind: null, and the pre-existing
// suggestion tests only assert the file's final resting place, which is identical whether or not
// it ever detoured through in-progress/. Moving the claim after the branch survived the suite.
test('processConfirmedReport: a kind:"suggestion" report is claimed too -- a second runner skips it without spending reviewCard', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-claim-suggestion-');
  const journalRoot = mkTmp('spo-autotriage-claim-suggestion-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_sugg.json');

  const claimedPath = inProgressPathFor(spoReportsDir, pendingPath);
  fs.mkdirSync(path.dirname(claimedPath), { recursive: true });
  fs.renameSync(pendingPath, claimedPath); // a winner got there first

  let spawned = false;
  const deps = { accountsDir: poolDir(), spawnSync: () => { spawned = true; return ok(''); } };

  const entry = { issue: 902, pendingPath, commentId: 1, kind: 'suggestion' };
  const result = await processConfirmedReport(entry, journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(result.outcome, 'already-claimed');
  assert.equal(spawned, false, 'reviewCard must never run for an already-claimed suggestion');
  assert.equal(fs.existsSync(claimedPath), true, "the loser must not disturb the winner's claim");
});

// ---- action 3.3: mechanical-failure cap + backoff -----------------------------------------
// The 12.8-hour stall this action closes (issues 449/455/456, 53 cycles, 128 attempts,
// 2026-08-30/31): a confirmed report whose triage fails MECHANICALLY (a deadline kill, a spawn
// failure, pool exhaustion -- never a reproduction verdict) used to be retried forever, with
// nothing bounding how many times and nothing throttling how often. These tests cover the cap
// (three strikes -> report-held-mechanical, a DEDICATED comment, never buildHoldComment's
// reproduction-verdict wording) and the backoff (doubling wait between retries, always journalled
// so a silent stall like this one can never recur invisibly).

// Bypasses appendDaemonEvent's own `new Date().toISOString()` to fabricate a BACKDATED event --
// same trick reclaimStaleClaims' own tests already use on a claim sidecar's `claimedAt`, applied
// here to daemon.jsonl so a backoff test can assert "enough time has elapsed" without an actual
// sleep.
function appendDaemonEventAt(journalRoot, event, detail, tsIso) {
  fs.mkdirSync(journalRoot, { recursive: true });
  fs.appendFileSync(path.join(journalRoot, 'daemon.jsonl'), JSON.stringify({ ts: tsIso, event, ...detail }) + '\n');
}

// triageBugReport's own JSON parse fails on this -- mechanical (never reaches a reproduction
// verdict), the same shape the pre-existing "a mechanical triageBugReport failure..." test above
// already relies on.
const MECHANICAL_FAIL_REPLIES = ['not json at all'];

const FILE_REPLIES = [
  { outcome: 'draft', draft: VALID_DRAFT },
  { verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review — 2026-08-30\n\n**Verdict:** FILE' },
];

test('defaults: backoff base mirrors DEFAULT_AUTO_TRIAGE_MS (15 min), ceiling 2h, mechanical cap 3', () => {
  assert.equal(DEFAULT_TRIAGE_BACKOFF_BASE_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_TRIAGE_BACKOFF_CEILING_MS, 2 * 60 * 60 * 1000);
  assert.equal(MECHANICAL_FAILURE_CAP, 3);
});

// ---- triageBackoffMs / shouldSkipForTriageBackoff: pure decision functions ----------------

test('triageBackoffMs: doubles per additional failure, never exceeds the configured ceiling', () => {
  const config = { autoTriageBackoffBaseMs: 1000, autoTriageBackoffCeilingMs: 5000 };
  const table = [
    [0, 0],
    [-1, 0],
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 5000], // would be 8000 uncapped
    [10, 5000],
    [50, 5000],
  ];
  for (const [errorCount, expected] of table) {
    assert.equal(triageBackoffMs(errorCount, config), expected, `errorCount=${errorCount}`);
  }
});

test('triageBackoffMs: falls back to DEFAULT_TRIAGE_BACKOFF_BASE_MS/CEILING_MS when config omits them', () => {
  assert.equal(triageBackoffMs(1, {}), DEFAULT_TRIAGE_BACKOFF_BASE_MS);
  assert.equal(triageBackoffMs(1, undefined), DEFAULT_TRIAGE_BACKOFF_BASE_MS);
});

test('shouldSkipForTriageBackoff: pure table across (errorCount, elapsed) pairs, no Date.now() involved', () => {
  const config = { autoTriageBackoffBaseMs: 1000, autoTriageBackoffCeilingMs: 5000 };
  const now = 1_000_000;

  // errorCount 0 (or negative) -- nothing to back off from, never skip.
  assert.equal(shouldSkipForTriageBackoff(now - 1, now, 0, config), false);
  assert.equal(shouldSkipForTriageBackoff(now - 1, now, -1, config), false);
  assert.equal(shouldSkipForTriageBackoff(null, now, 0, config), false);

  // errorCount 1 -- waitMs 1000.
  assert.equal(shouldSkipForTriageBackoff(now - 500, now, 1, config), true, 'still inside the wait');
  assert.equal(shouldSkipForTriageBackoff(now - 1000, now, 1, config), false, 'exactly at the wait -- eligible');
  assert.equal(shouldSkipForTriageBackoff(now - 2000, now, 1, config), false, 'well past the wait');

  // errorCount 3 -- waitMs 4000 (doubled twice from the 1000 base).
  assert.equal(shouldSkipForTriageBackoff(now - 3999, now, 3, config), true);
  assert.equal(shouldSkipForTriageBackoff(now - 4000, now, 3, config), false);

  // No known last-error time -- never skip, whatever errorCount says.
  assert.equal(shouldSkipForTriageBackoff(null, now, 2, config), false);
  assert.equal(shouldSkipForTriageBackoff(undefined, now, 2, config), false);

  // A huge errorCount is still bounded by the ceiling (5000ms here), never "skip forever".
  assert.equal(shouldSkipForTriageBackoff(now - 5001, now, 50, config), false);
  assert.equal(shouldSkipForTriageBackoff(now - 4999, now, 50, config), true);

  // #660: `lastErrorAtMs` AHEAD of `nowMs` -- the shape a backward Date.now() jump produces
  // (monotonic-clock.js's own header: measured -2515ms on this box, twice, independently). Elapsed
  // time cannot really be negative, so this must clamp to "no time has passed" (elapsed 0), not
  // invert the comparison. With a zeroed base (the CAP tests' own isolation config -- waitMs 0 for
  // any errorCount > 0) a negative elapsed used to read as `< 0`, which is true, flipping "never
  // skip" into "skip" on exactly the call after a report-triage-error write raced a clock hiccup.
  const zeroBaseConfig = { autoTriageBackoffBaseMs: 0, autoTriageBackoffCeilingMs: 5000 };
  assert.equal(shouldSkipForTriageBackoff(now + 1, now, 1, zeroBaseConfig), false, 'clock stepped back 1ms since the recorded error, base 0 -- must still never skip');
  assert.equal(shouldSkipForTriageBackoff(now + 5000, now, 1, zeroBaseConfig), false, 'clock stepped back further -- still clamped, not inverted');
  // Same shape with a real (non-zero) base: a small backward jump must not EXTEND the wait beyond
  // its configured bound either -- clamped elapsed is 0, so this behaves exactly like "the error
  // just happened", never like "the error is somehow still in the future".
  assert.equal(shouldSkipForTriageBackoff(now + 1, now, 1, config), true, 'clamped to elapsed 0, still inside the 1000ms wait');
});

// ---- integration: runAutoTriage wiring for the cap ----------------------------------------

test('runAutoTriage: one, then two mechanical failures -- report-triage-error journalled each time, no hold, still eligible', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-mech1-');
  const journalRoot = mkTmp('spo-autotriage-mech1-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_mech-cap1.json');
  confirmedEntry(journalRoot, { issue: 1001, pendingPath });

  // autoTriageBackoffBaseMs: 0 -- these two calls run moments apart in real time, well inside the
  // default 15-minute base; zeroing it isolates the CAP behaviour under test from the (separately
  // tested, below) BACKOFF behaviour.
  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriageBackoffBaseMs: 0 };

  const r1 = await runAutoTriage(journalRoot, config, makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES }), { dry: false });
  assert.equal(r1.errors.length, 1);
  assert.equal(r1.heldMechanical, 0);
  let daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.equal((daemonLog.match(/"event":"report-triage-error"/g) || []).length, 1);
  assert.doesNotMatch(daemonLog, /report-held-mechanical/);
  assert.equal(fs.existsSync(pendingPath), true);
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue), [1001]);
  // N2: pin the journalled `step` itself -- MECHANICAL_FAIL_REPLIES fails inside triageBugReport
  // (bad JSON), so the tag must be TRIAGE_BUG_REPORT specifically, not just "some string".
  const firstErrorEvent = daemonLog
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((e) => e.event === 'report-triage-error');
  assert.equal(firstErrorEvent.step, 'TRIAGE_BUG_REPORT');

  const r2 = await runAutoTriage(journalRoot, config, makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES }), { dry: false });
  assert.equal(r2.errors.length, 1);
  assert.equal(r2.heldMechanical, 0);
  daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.equal((daemonLog.match(/"event":"report-triage-error"/g) || []).length, 2);
  assert.doesNotMatch(daemonLog, /report-held-mechanical/);
  assert.equal(fs.existsSync(pendingPath), true);
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue), [1001]);

  assert.equal(mechanicalFailureHistory(journalRoot, 1001).count, 2);
});

test('runAutoTriage: the THIRD mechanical failure holds the report with a dedicated comment, distinct from buildHoldComment, and never archives it', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-mech2-');
  const journalRoot = mkTmp('spo-autotriage-mech2-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_mech-cap2.json');
  confirmedEntry(journalRoot, { issue: 1002, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriageBackoffBaseMs: 0 };
  let heldCommentBody = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const deps = makeDeps({
      claudeReplies: MECHANICAL_FAIL_REPLIES,
      ghResponder: (args) => {
        if (args[0] === 'issue' && args[1] === 'comment') {
          const bodyFile = args[args.indexOf('--body-file') + 1];
          heldCommentBody = fs.readFileSync(bodyFile, 'utf8');
        }
        return ok('');
      },
    });
    await runAutoTriage(journalRoot, config, deps, { dry: false }); // eslint-disable-line no-await-in-loop
  }

  assert.ok(heldCommentBody, 'expected a dedicated comment posted on the third mechanical failure');
  assert.match(heldCommentBody, /triage failed mechanically, not on a verdict/i);
  // The decisive assertion: this must NOT be buildHoldComment's reproduction-verdict wording --
  // reusing it here would tell a maintainer a reproduction ran and came back negative, which is
  // false (nothing ever reached a verdict).
  assert.doesNotMatch(heldCommentBody, /reproduction did not confirm this report/i);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  const events = daemonLog.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.event === 'report-triage-error').length, 3);
  const heldEvent = events.find((e) => e.event === 'report-held-mechanical');
  assert.ok(heldEvent, 'expected a report-held-mechanical event');
  assert.equal(heldEvent.issue, 1002);
  assert.equal(heldEvent.attempts, 3);
  assert.ok(heldEvent.lastError);

  assert.equal(fs.existsSync(pendingPath), true, 'never archived -- report stays in pending/, per this file\'s "never disposed of unseen" rule');
  assert.equal(fs.existsSync(path.join(spoReportsDir, 'archive')), false);
  assert.equal(fs.existsSync(path.join(spoReportsDir, IN_PROGRESS_DIRNAME, path.basename(pendingPath))), false, 'not stranded in in-progress/ either');

  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), [], 'report-held-mechanical counts as handled');
});

// #660: integration-level regression for the flake -- a report-triage-error whose journalled `ts`
// is slightly AHEAD of "now" (exactly what a backward Date.now() jump produces between the write
// and the very next call's backoff check, see monotonic-clock.js's header) must never cause
// runAutoTriage to back off a report whose autoTriageBackoffBaseMs is 0. Fabricated directly via
// appendDaemonEventAt (same trick the backoff tests below already use to backdate) rather than by
// monkeypatching Date.now, so this test proves the PRODUCTION decision function's own clamp, not a
// test-harness workaround.
test('runAutoTriage: a report-triage-error whose ts is ahead of "now" (a backward clock jump) never triggers a spurious backoff skip', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-mech-clockjump-');
  const journalRoot = mkTmp('spo-autotriage-mech-clockjump-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_mech-clockjump.json');
  confirmedEntry(journalRoot, { issue: 1004, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriageBackoffBaseMs: 0 };

  // A mechanical failure "just recorded" -- but stamped a few seconds into the future relative to
  // the real clock, simulating the box's own documented backward jump landing between this write
  // and the next call's `Date.now()` read.
  const aheadOfNow = new Date(Date.now() + 5000).toISOString();
  appendDaemonEventAt(journalRoot, 'report-triage-error', { issue: 1004, step: 'TRIAGE_BUG_REPORT', error: 'boom' }, aheadOfNow);

  const result = await runAutoTriage(journalRoot, config, makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES }), { dry: false });

  assert.equal(result.backoffSkipped, 0, 'autoTriageBackoffBaseMs: 0 must mean never skip, even with a ts that looks like it is in the future');
  assert.equal(result.errors.length, 1, 'the report was actually processed (and mechanically failed again), not silently skipped');
  assert.equal(mechanicalFailureHistory(journalRoot, 1004).count, 2, 'the fabricated failure plus this real one');
});

test('runAutoTriage: a later report-confirmed for the same issue resets the mechanical-failure count (the hook action 3.4 depends on)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-mech3-');
  const journalRoot = mkTmp('spo-autotriage-mech3-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_mech-cap3.json');
  confirmedEntry(journalRoot, { issue: 1003, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true, autoTriageBackoffBaseMs: 0 };

  for (let attempt = 1; attempt <= 3; attempt++) {
    await runAutoTriage(journalRoot, config, makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES }), { dry: false }); // eslint-disable-line no-await-in-loop
  }
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), [], 'held after three strikes');
  assert.equal(mechanicalFailureHistory(journalRoot, 1003).count, 3);

  // A maintainer's `spo triage --retry <issue>` (action 3.4, out of scope here) journals a fresh
  // report-confirmed event to re-open the report -- fabricated by hand since 3.4 does not exist
  // yet in this codebase.
  confirmedEntry(journalRoot, { issue: 1003, pendingPath });

  assert.equal(mechanicalFailureHistory(journalRoot, 1003).count, 0, 'the anchor moved forward -- prior failures no longer count');
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue), [1003], 'eligible again with a fresh budget');

  const result = await runAutoTriage(journalRoot, config, makeDeps({ claudeReplies: FILE_REPLIES, npmResponder: () => ok('') }), { dry: false });
  assert.equal(result.filed, 1, 'the fresh budget actually works -- a successful triage now goes through');
});

// ---- integration: runAutoTriage wiring for the backoff ------------------------------------

test('runAutoTriage: backoff -- one recent failure and too little elapsed skips the report, claims nothing, spawns nothing, journals report-triage-backoff', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-backoff1-');
  const journalRoot = mkTmp('spo-autotriage-backoff1-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_backoff1.json');
  confirmedEntry(journalRoot, { issue: 1010, pendingPath });
  // A mechanical failure that just happened -- default base is 15 minutes, so "just now" is well
  // inside the wait.
  appendDaemonEvent(journalRoot, 'report-triage-error', { issue: 1010, step: 'TRIAGE_BUG_REPORT', error: 'boom' });

  let spawned = false;
  const deps = {
    accountsDir: poolDir(),
    spawnSync: () => {
      spawned = true;
      return ok('');
    },
  };

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });

  assert.equal(spawned, false, 'no LLM (or gh, or npm) call at all for a backed-off report');
  assert.equal(fs.existsSync(pendingPath), true);
  assert.equal(fs.existsSync(path.join(spoReportsDir, IN_PROGRESS_DIRNAME)), false, 'a backoff skip must not even create in-progress/, let alone claim into it');
  assert.equal(result.backoffSkipped, 1);
  assert.equal(result.results[0].outcome, 'backoff');
  assert.equal(result.errors.length, 0, 'a backoff skip is not an error');

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  const events = daemonLog.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const backoffEvent = events.find((e) => e.event === 'report-triage-backoff');
  assert.ok(backoffEvent, 'a skipped-for-backoff report must be visible, not silent');
  assert.equal(backoffEvent.issue, 1010);
  assert.equal(backoffEvent.attempts, 1);
  assert.ok(backoffEvent.nextEligibleAtIso);

  // The cycle summary itself must show something happened too (the whole point -- an all-skip
  // cycle must never look identical to "nothing confirmed").
  const summary = events.find((e) => e.event === 'auto-triage');
  assert.ok(summary, 'a backoff-only cycle must still be journaled');
  assert.equal(summary.backoffSkipped, 1);
});

test('runAutoTriage: backoff -- once enough time has elapsed since the last failure, the report runs normally', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-backoff2-');
  const journalRoot = mkTmp('spo-autotriage-backoff2-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_backoff2.json');
  confirmedEntry(journalRoot, { issue: 1011, pendingPath });
  // Backdated well past the default 15-minute base for a single (errorCount 1) failure.
  const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  appendDaemonEventAt(journalRoot, 'report-triage-error', { issue: 1011, step: 'TRIAGE_BUG_REPORT', error: 'boom' }, twentyMinAgo);

  const deps = makeDeps({ claudeReplies: FILE_REPLIES, npmResponder: () => ok('') });

  const result = await runAutoTriage(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true },
    deps,
    { dry: false }
  );

  assert.equal(result.backoffSkipped, 0);
  assert.equal(result.filed, 1, 'past the backoff window, the report is processed normally');
});

test('runAutoTriage: a successful triage after one or two mechanical failures still works and is not penalised', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-mech4-');
  const journalRoot = mkTmp('spo-autotriage-mech4-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_mech-notpenalised.json');
  confirmedEntry(journalRoot, { issue: 1030, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true, autoTriageBackoffBaseMs: 0 };

  for (let i = 0; i < 2; i++) {
    await runAutoTriage(journalRoot, config, makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES }), { dry: false }); // eslint-disable-line no-await-in-loop
  }
  assert.equal(mechanicalFailureHistory(journalRoot, 1030).count, 2);

  const result = await runAutoTriage(journalRoot, config, makeDeps({ claudeReplies: FILE_REPLIES, npmResponder: () => ok('') }), { dry: false });

  assert.equal(result.filed, 1);
  assert.equal(result.heldMechanical, 0);
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.doesNotMatch(daemonLog, /report-held-mechanical/);
});

test('runAutoTriage: dry run journals none of the new action-3.3 events (report-triage-error, report-triage-backoff, report-held-mechanical)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-mech-dry-');
  const journalRoot = mkTmp('spo-autotriage-mech-dry-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_mech-dry.json');
  confirmedEntry(journalRoot, { issue: 1020, pendingPath });

  const deps = makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES });
  await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: true });

  const daemonLog = fs.existsSync(path.join(journalRoot, 'daemon.jsonl'))
    ? fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    : '';
  assert.doesNotMatch(daemonLog, /report-triage-error/);
  assert.doesNotMatch(daemonLog, /report-triage-backoff/);
  assert.doesNotMatch(daemonLog, /report-held-mechanical/);
});

test('buildMechanicalHoldComment: text is distinct from buildHoldComment\'s reproduction-verdict wording', () => {
  const text = buildMechanicalHoldComment(449, 3, 'triageBugReport: claude call failed (limit)');
  assert.match(text, /mechanical/i);
  assert.match(text, /triageBugReport: claude call failed \(limit\)/);
  assert.doesNotMatch(text, /reproduction did not confirm this report/i);
  assert.match(text, /spo triage --retry/);
  // N7: the real issue number must be interpolated, never the literal placeholder -- pasted
  // verbatim into bash, `<issue>` is an input redirect.
  assert.match(text, /spo triage --retry 449 --file/);
  assert.doesNotMatch(text, /<issue>/);
});

// ---- round 2 (verifier findings D1/D2/D4/N1/N2/N3/N4) -------------------------------------

// D1: a failed hold comment must never veto the hold itself. Before this fix,
// handleMechanicalFailure returned the ORIGINAL failure when postIssueComment failed, so
// report-held-mechanical was never journaled -- the ONLY event findConfirmedAwaitingTriage treats
// as handled -- and the report stayed eligible forever, spawning a fresh `claude -p` every cycle
// (the exact 12.8-hour incident, issues 449/455/456, this whole action exists to close). The fix:
// journal report-held-mechanical and return `ok: true` regardless of whether the comment posted.
test('D1: the THIRD mechanical failure still journals report-held-mechanical and stops the loop even when postIssueComment always fails', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-d1-');
  const journalRoot = mkTmp('spo-autotriage-d1-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_d1.json');
  confirmedEntry(journalRoot, { issue: 2001, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriageBackoffBaseMs: 0 };
  // Every `gh issue comment` call fails -- the exact "gh outage or rate-limit" shape this repo
  // already has precedent handling for (park-comment-failed).
  const failingCommentGh = (args) => {
    if (args[0] === 'issue' && args[1] === 'comment') return { status: 1, stdout: '', stderr: 'rate limited', signal: null };
    return ok('');
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await runAutoTriage( // eslint-disable-line no-await-in-loop
      journalRoot,
      config,
      makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES, ghResponder: failingCommentGh }),
      { dry: false }
    );
    assert.equal(r.heldMechanical, 0, `attempt ${attempt}: not held yet`);
  }
  assert.deepEqual(
    findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue),
    [2001],
    'still eligible after two failures'
  );

  // Third mechanical failure: the cap trips, the hold comment is attempted and fails.
  const r3 = await runAutoTriage(
    journalRoot,
    config,
    makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES, ghResponder: failingCommentGh }),
    { dry: false }
  );

  // The decisive assertion (mutation `if (false && !commented.ok)` must FAIL against this): the
  // report is held even though the comment never posted.
  assert.equal(r3.heldMechanical, 1, 'the cap trips on the third failure regardless of the comment');

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  const events = daemonLog.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const heldEvent = events.find((e) => e.event === 'report-held-mechanical');
  assert.ok(heldEvent, 'report-held-mechanical must be journaled even when the comment failed to post');
  assert.equal(heldEvent.issue, 2001);
  assert.equal(heldEvent.attempts, 3);
  assert.equal(heldEvent.commentPosted, false, 'the failure must be visible, not hidden');
  assert.ok(heldEvent.commentError, 'the comment error itself must be recorded');

  // The mechanism -- findConfirmedAwaitingTriage no longer surfaces it -- must hold even though
  // the courtesy (the comment) failed. This is the actual behaviour that stops the 12.8h loop.
  assert.deepEqual(
    findConfirmedAwaitingTriage(journalRoot, 10),
    [],
    'D1: a failed hold comment must not keep the report eligible forever'
  );

  // A fourth cycle must NOT spawn another claude -p call -- proof the loop is actually broken,
  // not just that one event got journaled.
  let spawnedFourthCycle = false;
  const r4 = await runAutoTriage(
    journalRoot,
    config,
    {
      accountsDir: poolDir(),
      spawnSync: (command) => {
        if (command === 'claude') spawnedFourthCycle = true;
        return ok('');
      },
    },
    { dry: false }
  );
  assert.equal(spawnedFourthCycle, false, 'a held-mechanical report must never be picked up again');
  assert.equal(r4.processed, 0, 'findConfirmedAwaitingTriage correctly excludes it');
});

// D2: the dedicated comment must not tell the "no verdict was ever reached" lie for a step that
// ran AFTER a real verdict (duplicate/held/DO_NOT_FILE/FILE) was already produced -- only the
// FOLLOW-UP gh call recording it failed. Driven here via POST_HOLD_COMMENT (triageBugReport
// reaches a real 'not-reproduced' verdict; the comment that records the hold then fails 3x).
test('D2: a POST_HOLD_COMMENT mechanical failure names the verdict and its own step, never claims "no verdict was ever reached"', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-d2-');
  const journalRoot = mkTmp('spo-autotriage-d2-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_d2.json');
  confirmedEntry(journalRoot, { issue: 2002, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriageBackoffBaseMs: 0 };
  const failingHoldCommentGh = (args) => {
    if (args[0] === 'issue' && args[1] === 'comment') return { status: 1, stdout: '', stderr: 'boom', signal: null };
    return ok('');
  };
  const deps = () =>
    makeDeps({ claudeReplies: [{ outcome: 'not-reproduced', reason: 'no journal entries found' }], ghResponder: failingHoldCommentGh });

  for (let attempt = 1; attempt <= 3; attempt++) {
    await runAutoTriage(journalRoot, config, deps(), { dry: false }); // eslint-disable-line no-await-in-loop
  }

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  const events = daemonLog.split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // Every report-triage-error for this issue must be tagged with the actual failing step, never
  // the pre-verdict TRIAGE_BUG_REPORT (which DID succeed and produce a real verdict here).
  const errorEvents = events.filter((e) => e.event === 'report-triage-error' && e.issue === 2002);
  assert.equal(errorEvents.length, 3);
  for (const e of errorEvents) assert.equal(e.step, 'POST_HOLD_COMMENT');

  const heldEvent = events.find((e) => e.event === 'report-held-mechanical' && e.issue === 2002);
  assert.ok(heldEvent);

  // buildMechanicalHoldComment(issue, attempts, lastError, step) is what handleMechanicalFailure
  // posts; reconstruct it directly (the comment itself failed to post in this test, by design) to
  // assert its wording.
  const commentText = buildMechanicalHoldComment(heldEvent.issue, heldEvent.attempts, heldEvent.lastError, 'POST_HOLD_COMMENT');
  assert.doesNotMatch(
    commentText,
    /no verdict was ever reached/i,
    'D2: a verdict WAS reached (not-reproduced) -- this text would be a lie'
  );
  assert.match(commentText, /verdict/i);
  assert.match(commentText, /TRIAGE_BUG_REPORT/, 'names the step that actually produced the verdict');
  assert.match(commentText, /POST_HOLD_COMMENT/, 'names the follow-up step that keeps failing');
  // The self-defeating irony: this very comment is posted through the same postIssueComment call
  // that is failing.
  assert.match(commentText, /gh/i);
  // D5: this is the sole discovery path for the entire retry feature -- a bare `/spo triage
  // --retry/` match is satisfied by the OLD, no-op `--retry <issue>` wording just as happily as
  // the new `--retry <issue> --file` wording, so a revert of 3.3's/3.4's comment text would ship
  // green. Pin the `--file` flag specifically, and the real issue number (N7), in this
  // post-verdict branch too.
  assert.match(commentText, /spo triage --retry [^\n]*--file/);
  assert.match(commentText, /spo triage --retry 2002 --file/);
});

test('D2: pre-verdict steps (e.g. TRIAGE_BUG_REPORT) keep the original "no verdict was ever reached" wording', () => {
  const text = buildMechanicalHoldComment(449, 3, 'triageBugReport: reply was not valid JSON', 'TRIAGE_BUG_REPORT');
  assert.match(text, /no verdict was ever reached/i);
  assert.doesNotMatch(text, /reached a verdict but/i);
});

// D4: the mutation `return !result.ok && result.step === 'TRIAGE_BUG_REPORT' ? handleMechanicalFailure(...) : result`
// survives at 845/845 because no test drives a failure at any OTHER step. This exercises
// POST_HOLD_COMMENT (a step reached only after TRIAGE_BUG_REPORT already succeeded) and proves it
// is journaled as report-triage-error and counted toward the cap exactly like a TRIAGE_BUG_REPORT
// failure would be -- processConfirmedReport really is "the one choke point every one of them
// funnels through", not just for the one step every other test happens to exercise.
test('D4: a mechanical failure at a non-TRIAGE_BUG_REPORT step (POST_HOLD_COMMENT) is journaled and counts toward the cap', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-d4-');
  const journalRoot = mkTmp('spo-autotriage-d4-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_d4.json');
  confirmedEntry(journalRoot, { issue: 2003, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriageBackoffBaseMs: 0 };
  const failingHoldCommentGh = (args) => {
    if (args[0] === 'issue' && args[1] === 'comment') return { status: 1, stdout: '', stderr: 'boom', signal: null };
    return ok('');
  };
  const deps = () =>
    makeDeps({ claudeReplies: [{ outcome: 'not-reproduced', reason: 'no journal entries found' }], ghResponder: failingHoldCommentGh });

  const r1 = await runAutoTriage(journalRoot, config, deps(), { dry: false });
  assert.equal(r1.errors.length, 1, 'a POST_HOLD_COMMENT failure must surface as an error, same as any other mechanical failure');
  assert.equal(r1.heldMechanical, 0);

  const afterOne = mechanicalFailureHistory(journalRoot, 2003);
  assert.equal(afterOne.count, 1, 'D4: a non-TRIAGE_BUG_REPORT step must count toward the cap');

  const daemonLog1 = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  const events1 = daemonLog1.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const errEvent = events1.find((e) => e.event === 'report-triage-error' && e.issue === 2003);
  assert.ok(errEvent, 'report-triage-error must be journaled for a POST_HOLD_COMMENT failure');
  assert.equal(errEvent.step, 'POST_HOLD_COMMENT'); // N2: pin the step at a second, distinct site

  // Still eligible -- one failure is below the cap.
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue), [2003]);

  // Two more identical failures trip the cap exactly like TRIAGE_BUG_REPORT failures do elsewhere
  // in this file -- the choke point really is shared, not TRIAGE_BUG_REPORT-specific.
  await runAutoTriage(journalRoot, config, deps(), { dry: false });
  const r3 = await runAutoTriage(journalRoot, config, deps(), { dry: false });
  assert.equal(r3.heldMechanical, 1, 'the cap trips on the third POST_HOLD_COMMENT failure, same as any other step');
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);
});

// N1: the `if (!dry)` guard around the backoff check must actually gate it -- a dry run must show
// the real verdict even for a report with a fresh mechanical failure that WOULD trigger a skip in
// a real cycle. Mutation `if (true)` survives if nothing ever proves the dry branch differs.
test('N1: a dry run does NOT apply the backoff skip, even for a report with a very recent mechanical failure', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-n1-');
  const journalRoot = mkTmp('spo-autotriage-n1-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_n1.json');
  confirmedEntry(journalRoot, { issue: 2004, pendingPath });
  // A mechanical failure that just happened -- default base is 15 minutes, well inside the wait,
  // so a REAL cycle would skip this report for backoff.
  appendDaemonEvent(journalRoot, 'report-triage-error', { issue: 2004, step: 'TRIAGE_BUG_REPORT', error: 'boom' });

  const deps = makeDeps({ claudeReplies: FILE_REPLIES, npmResponder: () => ok('') });

  const result = await runAutoTriage(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true },
    deps,
    { dry: true }
  );

  assert.equal(result.backoffSkipped, 0, 'N1: dry mode must never skip for backoff');
  assert.equal(result.results[0].outcome, 'would-file', 'the report was actually processed, not backed off');
  const daemonLog = fs.existsSync(path.join(journalRoot, 'daemon.jsonl'))
    ? fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    : '';
  assert.doesNotMatch(daemonLog, /report-triage-backoff/);
});

// N3: pin both new config keys' defaults and env overrides -- currently zero coverage means
// base-default->0, deleting both keys, and ceiling->Infinity all survive undetected.
test('config: autoTriageBackoffBaseMs/autoTriageBackoffCeilingMs -- defaults and env overrides', () => {
  const configPath = require.resolve('../orchestrator/config.js');
  const load = (env) => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[configPath];
    try {
      const c = require('../orchestrator/config.js');
      return { autoTriageBackoffBaseMs: c.autoTriageBackoffBaseMs, autoTriageBackoffCeilingMs: c.autoTriageBackoffCeilingMs };
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete require.cache[configPath];
    }
  };

  const ENV_KEYS = {
    SPO_AUTO_TRIAGE_MS: undefined,
    SPO_AUTO_TRIAGE_BACKOFF_BASE_MS: undefined,
    SPO_AUTO_TRIAGE_BACKOFF_CEILING_MS: undefined,
  };

  // Base default: measured -- SPO_AUTO_TRIAGE_MS unset -> base 900000 (15 min, DEFAULT_AUTO_TRIAGE_MS).
  assert.equal(load(ENV_KEYS).autoTriageBackoffBaseMs, 900000);
  // Ceiling default: 2h, always, regardless of autoTriageMs.
  assert.equal(load(ENV_KEYS).autoTriageBackoffCeilingMs, 7200000);

  // SPO_AUTO_TRIAGE_MS=900000 -> base mirrors it (900000, coincidentally the same number here).
  assert.equal(load({ ...ENV_KEYS, SPO_AUTO_TRIAGE_MS: '900000' }).autoTriageBackoffBaseMs, 900000);
  // SPO_AUTO_TRIAGE_MS=0 (explicit disable) -> base falls back to the 15-minute literal, not 0.
  assert.equal(load({ ...ENV_KEYS, SPO_AUTO_TRIAGE_MS: '0' }).autoTriageBackoffBaseMs, 900000);
  // SPO_AUTO_TRIAGE_MS=abc (malformed -> NaN) -> base falls back to the 15-minute literal.
  assert.equal(load({ ...ENV_KEYS, SPO_AUTO_TRIAGE_MS: 'abc' }).autoTriageBackoffBaseMs, 900000);
  // A real autoTriageMs (e.g. 5 min) -> base mirrors it exactly.
  assert.equal(load({ ...ENV_KEYS, SPO_AUTO_TRIAGE_MS: '300000' }).autoTriageBackoffBaseMs, 300000);

  // Explicit overrides win outright.
  assert.equal(load({ ...ENV_KEYS, SPO_AUTO_TRIAGE_BACKOFF_BASE_MS: '30000' }).autoTriageBackoffBaseMs, 30000);
  assert.equal(load({ ...ENV_KEYS, SPO_AUTO_TRIAGE_BACKOFF_CEILING_MS: '5000' }).autoTriageBackoffCeilingMs, 5000);

  // N5: a malformed or non-positive override for EITHER key falls back to its own default rather
  // than silently disabling the backoff (Math.min(NaN, ceiling) -> NaN, and `x < NaN` is always
  // false, meaning shouldSkipForTriageBackoff would never skip anything again).
  for (const bad of ['abc', '-1', '0', '', 'NaN', 'Infinity']) {
    const base = load({ ...ENV_KEYS, SPO_AUTO_TRIAGE_BACKOFF_BASE_MS: bad }).autoTriageBackoffBaseMs;
    assert.equal(base, 900000, `SPO_AUTO_TRIAGE_BACKOFF_BASE_MS="${bad}" must fall back to the default`);
    const ceiling = load({ ...ENV_KEYS, SPO_AUTO_TRIAGE_BACKOFF_CEILING_MS: bad }).autoTriageBackoffCeilingMs;
    assert.equal(ceiling, 7200000, `SPO_AUTO_TRIAGE_BACKOFF_CEILING_MS="${bad}" must fall back to the default`);
  }

  // There is deliberately no environment route to an unbounded ceiling (N4's throw vector) --
  // Infinity is covered in the bad-value loop above.
});

// N4: an operator-misconfigured ceiling (Infinity, bypassing config.js's own env validation via a
// config object assembled directly, e.g. by a future caller or a test) must never throw
// RangeError out of runAutoTriage, which has no try/catch -- that would kill the whole daemon.
test('N4: an Infinity (or astronomically large) backoff ceiling never throws -- runAutoTriage clamps and journals null instead', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-n4-');
  const journalRoot = mkTmp('spo-autotriage-n4-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_n4.json');
  confirmedEntry(journalRoot, { issue: 2005, pendingPath });

  // Fabricate 60 mechanical failures since the anchor -- triageBackoffMs(60, {base: 900000,
  // ceiling: Infinity}) = 900000 * 2^59, a finite-but-astronomical number (~5.19e23) that blows
  // straight through Date's +/-8.64e15 valid range even though it is not itself Infinity or NaN.
  for (let i = 0; i < 60; i++) {
    appendDaemonEvent(journalRoot, 'report-triage-error', { issue: 2005, step: 'TRIAGE_BUG_REPORT', error: `boom${i}` }); // eslint-disable-line no-await-in-loop
  }
  assert.equal(mechanicalFailureHistory(journalRoot, 2005).count, 60);

  const config = {
    spoReportsDir,
    productRepo: '/fake/repo',
    autoTriageBackoffBaseMs: 900000,
    autoTriageBackoffCeilingMs: Infinity,
  };

  let threw = null;
  let result;
  try {
    result = await runAutoTriage(journalRoot, config, { accountsDir: poolDir(), spawnSync: () => ok('') }, { dry: false });
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, 'N4: runAutoTriage must never throw over a misconfigured ceiling');
  assert.equal(result.backoffSkipped, 1, 'still correctly identified as needing a backoff skip');

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  const events = daemonLog.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const backoffEvent = events.find((e) => e.event === 'report-triage-backoff');
  assert.ok(backoffEvent);
  assert.equal(backoffEvent.nextEligibleAtIso, null, 'clamped rather than an unparseable/thrown value');
});

// ---- action 3.4: retryHeldReport / `spo triage --retry <issue>` --------------------------------
//
// The recovery path for a report stuck at HOLD. One fresh report-confirmed event both re-opens
// the report (findConfirmedAwaitingTriage) and resets its mechanical-failure budget
// (mechanicalFailureHistory) -- the same anchor 3.3's own "a later report-confirmed... resets the
// mechanical-failure count" test already proved works; these tests exercise the function that
// fabricates that event for real, plus the three refusals that keep it from firing when it would
// do the wrong thing (already filed, already eligible, or the report file itself is gone).

test('retryHeldReport: re-injects a report-held-mechanical issue -- eligible again, mechanical count back to 0', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-mech-');
  const journalRoot = mkTmp('spo-autotriage-retry-mech-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-mech.json');
  confirmedEntry(journalRoot, { issue: 3001, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriageBackoffBaseMs: 0 };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runAutoTriage(journalRoot, config, makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES }), { dry: false }); // eslint-disable-line no-await-in-loop
  }
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), [], 'held after three strikes');
  assert.equal(mechanicalFailureHistory(journalRoot, 3001).count, 3);

  let commentBody = null;
  let commentIssueArg = null;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        // N1: the courtesy comment must land on THIS issue, not some other one -- postIssueComment
        // puts the target issue at args[2] (`gh issue comment <issue> --repo ... --body-file
        // ...`); reading only --body-file and never checking args[2] would ship green even if the
        // comment posted to anchor.commentId or any other unrelated GitHub issue.
        commentIssueArg = args[2];
        const bodyFile = args[args.indexOf('--body-file') + 1];
        commentBody = fs.readFileSync(bodyFile, 'utf8');
      }
      return ok('');
    },
  };

  const result = await retryHeldReport(journalRoot, 3001, config, deps, { dry: false });
  assert.equal(result.ok, true);
  assert.equal(result.retriedFrom, 'report-held-mechanical');
  assert.equal(result.commentPosted, true);
  assert.ok(commentBody, 'expected a recovery comment to be posted');
  assert.match(commentBody, /re-injected for triage/i);
  assert.equal(commentIssueArg, '3001', 'the recovery comment must be posted to the retried issue, not anchor.commentId or anything else');

  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue), [3001], 'eligible again');
  assert.equal(mechanicalFailureHistory(journalRoot, 3001).count, 0, 'the anchor moved forward -- prior failures no longer count');
});

test('retryHeldReport: re-injects a plain report-held issue (negative reproduction verdict)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-held-');
  const journalRoot = mkTmp('spo-autotriage-retry-held-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-held.json');
  confirmedEntry(journalRoot, { issue: 3002, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo' };
  await runAutoTriage(
    journalRoot,
    config,
    makeDeps({ claudeReplies: [{ outcome: 'not-reproduced', reason: 'could not reproduce on latest build' }] }),
    { dry: false }
  );
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);

  const result = await retryHeldReport(journalRoot, 3002, config, { spawnSync: () => ok('') }, { dry: false });
  assert.equal(result.ok, true);
  assert.equal(result.retriedFrom, 'report-held');
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue), [3002]);
});

test('retryHeldReport: re-injects a report-held do-not-file hold', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-dnf-');
  const journalRoot = mkTmp('spo-autotriage-retry-dnf-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-dnf.json');
  confirmedEntry(journalRoot, { issue: 3016, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo' };
  await runAutoTriage(
    journalRoot,
    config,
    makeDeps({
      claudeReplies: [
        { outcome: 'draft', draft: VALID_DRAFT },
        { verdict: 'DO_NOT_FILE', corrections: [], first_comment_markdown: 'Not a real defect.' },
      ],
    }),
    { dry: false }
  );
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);

  const result = await retryHeldReport(journalRoot, 3016, config, { spawnSync: () => ok('') }, { dry: false });
  assert.equal(result.ok, true);
  assert.equal(result.retriedFrom, 'report-held');
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue), [3016]);
});

test('retryHeldReport: refused for an issue that was already triaged (filed)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-filed-');
  const journalRoot = mkTmp('spo-autotriage-retry-filed-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-filed.json');
  confirmedEntry(journalRoot, { issue: 3010, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo' };
  const filedResult = await runAutoTriage(
    journalRoot,
    config,
    makeDeps({ claudeReplies: FILE_REPLIES, npmResponder: () => ok('') }),
    { dry: false }
  );
  assert.equal(filedResult.filed, 1);

  const result = await retryHeldReport(journalRoot, 3010, config, {}, { dry: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /already triaged/);
});

test('retryHeldReport: refused for an issue with no report-confirmed event at all', async () => {
  const journalRoot = mkTmp('spo-autotriage-retry-none-');
  const result = await retryHeldReport(journalRoot, 9999, {}, {}, { dry: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /has no report-confirmed event on record/);
});

test('retryHeldReport: refused for an issue that is already eligible (no handled event since its confirm)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-eligible-');
  const journalRoot = mkTmp('spo-autotriage-retry-eligible-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-eligible.json');
  confirmedEntry(journalRoot, { issue: 3011, pendingPath });

  const result = await retryHeldReport(journalRoot, 3011, { spoReportsDir }, {}, { dry: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /already eligible for triage/);
});

// N2: the handled-scan at auto-triage.js's `lines[i].issue === issue` guard is what this test
// exercises directly. An ordinary journal shape -- another issue's report-held landing AFTER this
// issue's own report-confirmed, simply because it was routed in the same or a later cycle -- is
// completely unremarkable. Without the guard, the scan would treat that OTHER issue's hold as
// THIS issue's own handled event, precondition 2 would pass, and an already-eligible report would
// get double-queued (the exact hazard precondition 2 exists to prevent -- see this function's own
// header, point 2).
test('retryHeldReport: an unrelated issue\'s report-held after this issue\'s confirm must not be mistaken for this issue\'s own handled event', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-crosstalk-');
  const journalRoot = mkTmp('spo-autotriage-retry-crosstalk-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-crosstalk.json');
  confirmedEntry(journalRoot, { issue: 4001, pendingPath });
  // A different issue's hold, journaled after 4001's confirm -- ordinary, unrelated traffic.
  appendDaemonEvent(journalRoot, 'report-held', { issue: 4002, outcome: 'not-reproduced', reason: 'unrelated report' });

  const result = await retryHeldReport(journalRoot, 4001, { spoReportsDir }, {}, { dry: false });
  assert.equal(result.ok, false, 'issue 4002\'s hold must not be read as issue 4001\'s own handled event');
  assert.match(result.error, /already eligible for triage/);
});

test('retryHeldReport: refused when the report file is missing from pending/', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-missing-');
  const journalRoot = mkTmp('spo-autotriage-retry-missing-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-missing.json');
  confirmedEntry(journalRoot, { issue: 3012, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo' };
  await runAutoTriage(
    journalRoot,
    config,
    makeDeps({ claudeReplies: [{ outcome: 'not-reproduced', reason: 'no journal entries' }] }),
    { dry: false }
  );
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);

  fs.unlinkSync(pendingPath); // simulate the file vanishing from pending/ after the hold

  const result = await retryHeldReport(journalRoot, 3012, config, {}, { dry: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /report file is missing from pending\//);
});

// N5: fs.existsSync alone returns true for a DIRECTORY too -- action 3.1 already fixed the
// identical existsSync-then-open TOCTOU/directory finding elsewhere (state-machine.js's
// isNonEmptyFile); this pins the same fix here. If pendingPath resolves to a directory,
// retryHeldReport must refuse it exactly like a missing file, never try to re-inject it.
test('retryHeldReport: refused when the recorded pendingPath is a directory, not a file (N5)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-dir-');
  const journalRoot = mkTmp('spo-autotriage-retry-dir-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-dir.json');
  confirmedEntry(journalRoot, { issue: 3017, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo' };
  await runAutoTriage(
    journalRoot,
    config,
    makeDeps({ claudeReplies: [{ outcome: 'not-reproduced', reason: 'no journal entries' }] }),
    { dry: false }
  );
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);

  // Replace the file with a same-named directory -- fs.existsSync(pendingPath) would say `true`.
  fs.unlinkSync(pendingPath);
  fs.mkdirSync(pendingPath);

  const result = await retryHeldReport(journalRoot, 3017, config, {}, { dry: false });
  assert.equal(result.ok, false, 'a directory at pendingPath must never be treated as a re-injectable report');
  assert.match(result.error, /report file is missing from pending\//);
});

// N4: a live daemon can claim this exact file into in-progress/ (claimReport) at any time -- an
// ordinary race, not data loss. The old wording ("is missing from pending/ ... cannot re-inject a
// report that no longer exists") reads to a maintainer racing a live daemon as their report having
// been lost. Probe in-progress/ and say it is claimed instead.
test('retryHeldReport: a report claimed into in-progress/ by a live daemon is reported as claimed, not missing/lost (N4)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-claimed-');
  const journalRoot = mkTmp('spo-autotriage-retry-claimed-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-claimed.json');
  confirmedEntry(journalRoot, { issue: 3018, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo' };
  await runAutoTriage(
    journalRoot,
    config,
    makeDeps({ claudeReplies: [{ outcome: 'not-reproduced', reason: 'no journal entries' }] }),
    { dry: false }
  );
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);

  // Simulate a live daemon racing this command: move the restored pending/ file into
  // in-progress/, exactly what claimReport does at the start of a real cycle.
  const inProgressDir = path.join(spoReportsDir, 'in-progress');
  fs.mkdirSync(inProgressDir, { recursive: true });
  fs.renameSync(pendingPath, path.join(inProgressDir, path.basename(pendingPath)));

  const result = await retryHeldReport(journalRoot, 3018, config, {}, { dry: false });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /no longer exists/, 'a claimed report must never read as data loss');
  assert.match(result.error, /claimed by a running triage cycle/);
});

// N4 (config robustness): a missing/partial config must never turn the refusal itself into a
// crash -- retryHeldReport still has to return a legible {ok:false, error} rather than throwing
// on `config.spoReportsDir` of an undefined `config`.
test('retryHeldReport: a missing config does not throw when the report file is absent (N4/N6)', async () => {
  const journalRoot = mkTmp('spo-autotriage-retry-noconfig-journal-');
  confirmedEntry(journalRoot, { issue: 3019, pendingPath: '/nonexistent/pending/path.json' });
  appendDaemonEvent(journalRoot, 'report-held', { issue: 3019, outcome: 'not-reproduced', reason: 'x' });

  await assert.doesNotReject(async () => {
    const result = await retryHeldReport(journalRoot, 3019, undefined, {}, { dry: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /report file is missing from pending\//);
  });
});

test('retryHeldReport: journals the re-confirm even when postIssueComment fails, with commentPosted: false', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-commentfail-');
  const journalRoot = mkTmp('spo-autotriage-retry-commentfail-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-commentfail.json');
  confirmedEntry(journalRoot, { issue: 3013, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo' };
  await runAutoTriage(
    journalRoot,
    config,
    makeDeps({ claudeReplies: [{ outcome: 'insufficient', reason: 'no repro steps' }] }),
    { dry: false }
  );
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);

  // Same D1 lesson 3.3 already learned the hard way: a `gh` outage on the courtesy comment must
  // never veto the mechanism that exists specifically to survive `gh` outages.
  const failingDeps = { spawnSync: () => ({ status: 1, stdout: '', stderr: 'gh: rate limited', signal: null }) };
  const result = await retryHeldReport(journalRoot, 3013, config, failingDeps, { dry: false });

  assert.equal(result.ok, true, 'the event must be journalled regardless of the comment outcome');
  assert.equal(result.commentPosted, false);
  assert.ok(result.commentError);
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10).map((e) => e.issue), [3013], 'eligible again despite the comment failure');
});

test('retryHeldReport: opts.dry previews only -- appends nothing, comments nothing', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-dry-');
  const journalRoot = mkTmp('spo-autotriage-retry-dry-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-dry.json');
  confirmedEntry(journalRoot, { issue: 3014, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo' };
  await runAutoTriage(
    journalRoot,
    config,
    makeDeps({ claudeReplies: [{ outcome: 'not-reproduced', reason: 'x' }] }),
    { dry: false }
  );
  const beforeLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');

  let spawned = false;
  const deps = {
    spawnSync: () => {
      spawned = true;
      return ok('');
    },
  };
  const result = await retryHeldReport(journalRoot, 3014, config, deps, { dry: true });

  assert.equal(result.ok, true);
  assert.equal(result.dry, true);
  assert.equal(result.outcome, 'would-retry');
  // D4: pin retriedFrom on the DRY return specifically -- a mutation dropping it from just this
  // branch (as opposed to the non-dry branch, already pinned by the other retryHeldReport tests)
  // previously survived for want of this assertion.
  assert.equal(result.retriedFrom, 'report-held');
  assert.equal(spawned, false, 'a dry preview must never post a comment');
  const afterLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.equal(afterLog, beforeLog, 'a dry preview must append nothing to the journal');
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), [], 'still held -- the preview changed nothing');
});

test('retryHeldReport end-to-end: hold mechanically at the cap, re-inject, and the next runAutoTriage cycle files it', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-e2e-');
  const journalRoot = mkTmp('spo-autotriage-retry-e2e-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-e2e.json');
  confirmedEntry(journalRoot, { issue: 3015, pendingPath });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true, autoTriageBackoffBaseMs: 0 };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runAutoTriage(journalRoot, config, makeDeps({ claudeReplies: MECHANICAL_FAIL_REPLIES }), { dry: false }); // eslint-disable-line no-await-in-loop
  }
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), [], 'held after three strikes');

  const retryResult = await retryHeldReport(journalRoot, 3015, config, { spawnSync: () => ok('') }, { dry: false });
  assert.equal(retryResult.ok, true);
  assert.equal(retryResult.retriedFrom, 'report-held-mechanical');

  const result = await runAutoTriage(
    journalRoot,
    config,
    makeDeps({ claudeReplies: FILE_REPLIES, npmResponder: () => ok('') }),
    { dry: false }
  );
  assert.equal(result.filed, 1, 'the recovered report reaches filed on the very next cycle');
});

// D4: dropping `kind` from the synthesized report-confirmed event is undetectable by any test
// above -- confirmedEntry defaults `kind` to `undefined`, and every 3.4 test so far omits it, so
// JSON.stringify drops the key entirely and nothing can see whether it survived the round trip.
// The shipped code IS correct (routeConfirmedReport reads entry.kind straight off the
// report-confirmed event, and retryHeldReport already carries anchor.kind forward on both the
// dry and non-dry returns and onto the appended event) -- but the failure this guards against is
// real: a retried `kind: 'suggestion'` report silently routed down triageBugReport's LLM path
// (a reproduction attempt) instead of the free mechanical buildSuggestionDraft, costing an LLM
// call a recovery command should never spend. Pin it end to end: the dry return, the non-dry
// return, the re-injected journal event, AND the actual LLM-call count on the next real cycle.
test('retryHeldReport: carries kind forward for a suggestion report, and the retried report still costs exactly one LLM call, never two (D4)', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-retry-suggestion-');
  const journalRoot = mkTmp('spo-autotriage-retry-suggestion-journal-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-08-31T10-00-00-000Z_desktop_retry-suggestion.json');
  confirmedEntry(journalRoot, { issue: 3020, pendingPath, kind: 'suggestion' });

  const config = { spoReportsDir, productRepo: '/fake/repo', autoTriagePromoteToTodo: true };

  const countClaudeCalls = (baseDeps) => {
    let calls = 0;
    const spawnSync = (command, args, opts) => {
      if (command === 'claude') calls++;
      return baseDeps.spawnSync(command, args, opts);
    };
    return { deps: { ...baseDeps, spawnSync }, count: () => calls };
  };

  // Reach a hold: kind:'suggestion' skips triageBugReport entirely (buildSuggestionDraft is
  // mechanical, no LLM call) -- reviewCard is the ONLY claude call in this path, so a DO_NOT_FILE
  // verdict from it holds the report after exactly one LLM call.
  const holdBase = makeDeps({ claudeReplies: [{ verdict: 'DO_NOT_FILE', corrections: [], first_comment_markdown: 'Not a real defect.' }] });
  const holdCounted = countClaudeCalls(holdBase);
  await runAutoTriage(journalRoot, config, holdCounted.deps, { dry: false });
  assert.equal(holdCounted.count(), 1, 'a suggestion hold must cost exactly one LLM call (reviewCard only)');
  assert.deepEqual(findConfirmedAwaitingTriage(journalRoot, 10), []);

  // Dry return: kind and retriedFrom must both be pinned on the dry branch specifically.
  const dryResult = await retryHeldReport(journalRoot, 3020, config, {}, { dry: true });
  assert.equal(dryResult.ok, true);
  assert.equal(dryResult.dry, true);
  assert.equal(dryResult.kind, 'suggestion', 'kind must be carried on the dry return');
  assert.equal(dryResult.retriedFrom, 'report-held', 'retriedFrom must be pinned on the dry return');

  // Real retry: kind and retriedFrom must both be pinned on the non-dry return AND on the
  // re-injected journal event itself -- routeConfirmedReport reads entry.kind straight off
  // whatever report-confirmed event findConfirmedAwaitingTriage hands it, not off this function's
  // return value, so the journal event is what actually matters for the next cycle's routing.
  const result = await retryHeldReport(journalRoot, 3020, config, { spawnSync: () => ok('') }, { dry: false });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'suggestion', 'kind must be carried on the non-dry return');
  assert.equal(result.retriedFrom, 'report-held', 'retriedFrom must be pinned on the non-dry return');

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  const events = daemonLog.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reinjected = events.filter((e) => e.event === 'report-confirmed' && e.issue === 3020).pop();
  assert.ok(reinjected, 'expected a fresh report-confirmed event for the retried issue');
  assert.equal(reinjected.kind, 'suggestion', 'the re-injected journal event must carry kind forward -- dropping it is the D4 defect');
  assert.equal(reinjected.retriedFrom, 'report-held', 'the re-injected journal event must record what it was retried from');

  // The decisive assertion: the NEXT real cycle must spend exactly ONE LLM call again
  // (reviewCard only). Two calls would mean the retried report got routed through
  // triageBugReport's reproduction path -- proof `kind` was dropped somewhere along the way.
  const fileBase = makeDeps({
    claudeReplies: [{ verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review\n\n**Verdict:** FILE' }],
    npmResponder: () => ok(''),
  });
  const fileCounted = countClaudeCalls(fileBase);
  const cycle = await runAutoTriage(journalRoot, config, fileCounted.deps, { dry: false });
  assert.equal(fileCounted.count(), 1, 'the retried suggestion must cost exactly one LLM call on the next cycle too -- never two');
  assert.equal(cycle.filed, 1, 'the recovered suggestion reaches filed on the very next cycle');
});

// ---- SPO-Pipeline#117: a triage cycle's LLM spend reaches daemon.jsonl ------------------------
//
// The end-to-end half of the fix. intake.js does the writing (test/intake.test.js pins the event
// shape) and tokens.js does the reading (test/tokens.test.js pins the sums), but neither proves
// the ONE thing that was actually broken in production: the wiring between them. Nothing was
// missing from intake's own return value -- `journalRoot` simply never reached it from here, so
// `journal/daemon.jsonl` held zero `llm-call` events against 58 auto-triage cycles. Severing
// that argument again is invisible to every other test in this file.

function daemonLlmCalls(journalRoot) {
  return fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'llm-call');
}

test('runAutoTriage: both LLM calls of a triage cycle leave an `llm-call` record in daemon.jsonl', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports-tokens-');
  const journalRoot = mkTmp('spo-autotriage-journal-tokens-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-09-04T10-00-00-000Z_desktop_ttt.json');
  confirmedEntry(journalRoot, { issue: 991, pendingPath });

  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review' },
    ],
  });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: false });
  assert.equal(result.ok, true);

  // TRIAGE_BUG_REPORT then REVIEW_CARD -- the two calls a "draft" outcome costs, in order.
  assert.deepEqual(daemonLlmCalls(journalRoot).map((e) => e.step), ['TRIAGE_BUG_REPORT', 'REVIEW_CARD']);
});

test('runAutoTriage --dry: the llm-call record is written even though every other daemon event is suppressed', async () => {
  // A dry cycle still spawns `claude` and still spends the tokens (routeConfirmedReport calls
  // triageBugReport before it consults `dry` at all). `dry` suppresses acts on the world and the
  // routing events the scanners read; an accounting record is neither, and omitting it would
  // reintroduce the very defect this closes, at dry-run scale.
  const spoReportsDir = mkTmp('spo-autotriage-reports-dry-tokens-');
  const journalRoot = mkTmp('spo-autotriage-journal-dry-tokens-');
  const pendingPath = writePendingReport(spoReportsDir, '2026-09-04T11-00-00-000Z_desktop_ddd.json');
  confirmedEntry(journalRoot, { issue: 992, pendingPath });

  const deps = makeDeps({ claudeReplies: [{ outcome: 'not-reproduced', reason: 'cannot reproduce' }] });

  const result = await runAutoTriage(journalRoot, { spoReportsDir, productRepo: '/fake/repo' }, deps, { dry: true });
  assert.equal(result.ok, true);

  const calls = daemonLlmCalls(journalRoot);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].step, 'TRIAGE_BUG_REPORT');
  // …and the routing events really are still suppressed, so this test is not just observing a
  // dry run that quietly stopped being dry.
  const events = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).event);
  assert.ok(!events.includes('report-held'), 'a dry cycle still journals no terminal routing event');
});
