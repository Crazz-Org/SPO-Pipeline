'use strict';
// Tests for orchestrator/auto-triage.js: shouldAutoTriage's pure timer decision (same
// "injectable clock" convention as test/auto-pull.test.js), listQueuedReports' ordering/filtering,
// and runAutoTriage's triageBugReport -> reviewCard -> fileCard wiring (same deps.spawnSync
// injection convention test/intake.test.js already uses for draftCard/reviewCard/fileCard --
// this file only asserts what is specific to the auto-triage driver: outcome routing, the
// dry-run/real split, "a mechanical failure leaves the report queued", and the daemon.jsonl
// shape).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mkTmp, writePoolDir } = require('./helpers');
const {
  shouldAutoTriage,
  runAutoTriage,
  listQueuedReports,
  DEFAULT_AUTO_TRIAGE_MS,
  DEFAULT_AUTO_TRIAGE_LIMIT,
} = require('../orchestrator/auto-triage');

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

function writeReport(spoReportsDir, filename) {
  fs.mkdirSync(spoReportsDir, { recursive: true });
  fs.writeFileSync(path.join(spoReportsDir, filename), JSON.stringify({ version: 1 }));
  return path.join(spoReportsDir, filename);
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
    'Source: /triage-report queue, 2026-08-29',
  ].join('\n'),
  category: 'defect',
  size: 'S',
  area: 'rdo',
  is_bug_report: true,
  confirmed: true,
};

// Sequenced `claude` replies (one per invokeClaudeReal call, in call order: triageBugReport
// first, then reviewCard for a "draft" outcome) plus a `gh` responder for fileCard/postIssueComment.
function makeDeps({ claudeReplies, ghResponder, accountsDir }) {
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
        if (args[0] === 'issue' && args[1] === 'create') {
          return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/999\n');
        }
        return ok('');
      }
      return ok('');
    },
  };
}

// ---- shouldAutoTriage: pure decision function --------------------------------------------------

test('shouldAutoTriage: disabled at 0 (the default), regardless of lastTriageAt', () => {
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

// ---- listQueuedReports -------------------------------------------------------------------------

test('listQueuedReports: chronological (lexical) order, excludes archive/, ignores non-json, missing dir -> []', () => {
  const dir = mkTmp('spo-autotriage-list-');
  assert.deepEqual(listQueuedReports(path.join(dir, 'nope')), []);

  writeReport(dir, '2026-08-29T10-00-00-000Z_desktop_aaa.json');
  writeReport(dir, '2026-08-29T09-00-00-000Z_mobile_bbb.json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  writeReport(path.join(dir, 'archive'), '2026-08-28T00-00-00-000Z_desktop_zzz.json');

  const got = listQueuedReports(dir).map((p) => path.basename(p));
  assert.deepEqual(got, ['2026-08-29T09-00-00-000Z_mobile_bbb.json', '2026-08-29T10-00-00-000Z_desktop_aaa.json']);
});

// ---- runAutoTriage ------------------------------------------------------------------------------

test('runAutoTriage: draft -> FILE -> filed, archived with a "filed:" sidecar, journals one auto-triage event', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports1-');
  const journalRoot = mkTmp('spo-autotriage-journal1-');
  const reportPath = writeReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_aaa.json');

  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: '### Card review — 2026-08-29\n\n**Verdict:** FILE' },
    ],
  });

  const result = await runAutoTriage(spoReportsDir, journalRoot, {}, deps, { dry: false });

  assert.equal(result.ok, true);
  assert.equal(result.filed, 1);
  assert.equal(result.results[0].outcome, 'filed');
  assert.equal(result.results[0].issueNumber, 999);

  assert.equal(fs.existsSync(reportPath), false);
  const archived = path.join(spoReportsDir, 'archive', path.basename(reportPath));
  assert.equal(fs.existsSync(archived), true);
  const sidecar = fs.readFileSync(`${archived}.disposition.txt`, 'utf8');
  assert.match(sidecar, /^filed: #999 —/);

  const daemonLog = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(daemonLog.length, 1);
  assert.equal(daemonLog[0].event, 'auto-triage');
  assert.equal(daemonLog[0].filed, 1);
});

test('runAutoTriage: draft -> DO_NOT_FILE -> archived, gh issue create never called', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports2-');
  const journalRoot = mkTmp('spo-autotriage-journal2-');
  const reportPath = writeReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_bbb.json');

  let ghCreateCalled = false;
  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'DO_NOT_FILE', corrections: [], first_comment_markdown: 'No reproduction supplied.\nMore detail here.' },
    ],
    ghResponder: (args) => {
      if (args[0] === 'issue' && args[1] === 'create') ghCreateCalled = true;
      return ok('');
    },
  });

  const result = await runAutoTriage(spoReportsDir, journalRoot, {}, deps, { dry: false });

  assert.equal(result.doNotFile, 1);
  assert.equal(ghCreateCalled, false);
  assert.equal(fs.existsSync(reportPath), false);
  const sidecar = fs.readFileSync(path.join(spoReportsDir, 'archive', `${path.basename(reportPath)}.disposition.txt`), 'utf8');
  assert.match(sidecar, /^do-not-file: No reproduction supplied\. —/);
});

test('runAutoTriage: outcome duplicate -> posts a comment on the existing issue, never gh issue create', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports3-');
  const journalRoot = mkTmp('spo-autotriage-journal3-');
  const reportPath = writeReport(spoReportsDir, '2026-08-29T10-00-00-000Z_mobile_ccc.json');

  const seenGhCalls = [];
  const deps = makeDeps({
    claudeReplies: [{ outcome: 'duplicate', issue_number: 42, comment_markdown: 'Also seen 2026-08-29, mobile.' }],
    ghResponder: (args) => {
      seenGhCalls.push(args);
      return ok('');
    },
  });

  const result = await runAutoTriage(spoReportsDir, journalRoot, {}, deps, { dry: false });

  assert.equal(result.duplicates, 1);
  assert.equal(result.results[0].issueNumber, 42);
  assert.ok(seenGhCalls.some((a) => a[0] === 'issue' && a[1] === 'comment' && a[2] === '42'));
  assert.ok(!seenGhCalls.some((a) => a[0] === 'issue' && a[1] === 'create'));
  assert.equal(fs.existsSync(reportPath), false);
});

test('runAutoTriage: not-reproduced / insufficient / schema-version -- archived, no gh call at all', async () => {
  for (const outcome of ['not-reproduced', 'insufficient', 'schema-version']) {
    const spoReportsDir = mkTmp(`spo-autotriage-reports-${outcome}-`);
    const journalRoot = mkTmp(`spo-autotriage-journal-${outcome}-`);
    const reportPath = writeReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_ddd.json');

    let ghCalled = false;
    const reply =
      outcome === 'schema-version'
        ? { outcome, found: 2, expected: 3 }
        : { outcome, reason: 'no journal entries around the flagged click' };
    const deps = makeDeps({
      claudeReplies: [reply],
      ghResponder: () => {
        ghCalled = true;
        return ok('');
      },
    });

    const result = await runAutoTriage(spoReportsDir, journalRoot, {}, deps, { dry: false });

    assert.equal(ghCalled, false);
    assert.equal(fs.existsSync(reportPath), false);
    assert.equal(fs.existsSync(path.join(spoReportsDir, 'archive', `${path.basename(reportPath)}.disposition.txt`)), true);
  }
});

test('runAutoTriage: dry run -- draft+review still happen, but no gh call, report stays queued, no journal', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports4-');
  const journalRoot = mkTmp('spo-autotriage-journal4-');
  const reportPath = writeReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_eee.json');

  let ghCalled = false;
  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'draft', draft: VALID_DRAFT },
      { verdict: 'FILE', corrections: [], first_comment_markdown: 'FILE' },
    ],
    ghResponder: () => {
      ghCalled = true;
      return ok('');
    },
  });

  const result = await runAutoTriage(spoReportsDir, journalRoot, {}, deps, { dry: true });

  assert.equal(ghCalled, false);
  assert.equal(result.results[0].outcome, 'would-file');
  assert.equal(fs.existsSync(reportPath), true); // still queued
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
});

test('runAutoTriage: a mechanical triageBugReport failure leaves the report queued, pushes to errors, no journal', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports5-');
  const journalRoot = mkTmp('spo-autotriage-journal5-');
  const reportPath = writeReport(spoReportsDir, '2026-08-29T10-00-00-000Z_desktop_fff.json');

  const deps = makeDeps({ claudeReplies: ['not json at all'] });

  const result = await runAutoTriage(spoReportsDir, journalRoot, {}, deps, { dry: false });

  assert.equal(result.errors.length, 1);
  assert.equal(fs.existsSync(reportPath), true);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
});

test('runAutoTriage: default limit 3 -- only the top 3 of 5 queued reports are processed', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports6-');
  const journalRoot = mkTmp('spo-autotriage-journal6-');
  for (let i = 0; i < 5; i++) {
    writeReport(spoReportsDir, `2026-08-29T10-0${i}-00-000Z_desktop_r${i}.json`);
  }

  const deps = makeDeps({
    claudeReplies: [
      { outcome: 'not-reproduced', reason: 'r0' },
      { outcome: 'not-reproduced', reason: 'r1' },
      { outcome: 'not-reproduced', reason: 'r2' },
    ],
  });

  const result = await runAutoTriage(spoReportsDir, journalRoot, {}, deps, { dry: false });

  assert.equal(result.processed, 3);
  assert.equal(fs.readdirSync(spoReportsDir).filter((f) => f.endsWith('.json')).length, 2); // 2 left queued
});

test('runAutoTriage: nothing queued -- no claude/gh spawn at all, no journal event', async () => {
  const spoReportsDir = mkTmp('spo-autotriage-reports7-');
  const journalRoot = mkTmp('spo-autotriage-journal7-');

  let spawned = false;
  const deps = { accountsDir: poolDir(), spawnSync: () => { spawned = true; return ok(''); } };

  const result = await runAutoTriage(spoReportsDir, journalRoot, {}, deps, { dry: false });

  assert.equal(result.processed, 0);
  assert.equal(spawned, false);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
});
