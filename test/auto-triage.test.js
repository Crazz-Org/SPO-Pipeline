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
const {
  shouldAutoTriage,
  runAutoTriage,
  processConfirmedReport,
  findConfirmedAwaitingTriage,
  DEFAULT_AUTO_TRIAGE_MS,
  DEFAULT_AUTO_TRIAGE_LIMIT,
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
function makeDeps({ claudeReplies, ghResponder, npmResponder, accountsDir }) {
  let claudeCallIdx = 0;
  return {
    accountsDir: accountsDir || poolDir(),
    spawnSync: (command, args) => {
      if (command === 'claude') {
        const reply = claudeReplies[claudeCallIdx++];
        return ok(JSON.stringify(realShapedReply(reply)));
      }
      if (command === 'gh') {
        if (ghResponder) return ghResponder(args);
        if (args[0] === 'api') return ok(JSON.stringify({ body: 'original raw body' }));
        return ok('');
      }
      if (command === 'npm') {
        if (npmResponder) return npmResponder(args);
        return ok('');
      }
      return ok('');
    },
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

test('runAutoTriage: a mechanical triageBugReport failure is not journaled as triaged/held (retried next cycle)', async () => {
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
