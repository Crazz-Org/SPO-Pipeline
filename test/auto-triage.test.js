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
const accounts = require('../orchestrator/accounts');
const {
  shouldAutoTriage,
  runAutoTriage,
  processConfirmedReport,
  findConfirmedAwaitingTriage,
  reclaimStaleClaims,
  claimReport,
  claimSidecarPath,
  DEFAULT_AUTO_TRIAGE_MS,
  DEFAULT_AUTO_TRIAGE_LIMIT,
  DEFAULT_TRIAGE_CLAIM_GRACE_MS,
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
