'use strict';
// Tests for orchestrator/report-intake.js -- stages 1 (runReportIntake, mechanical) and 2
// (reportConfirmScan, the confirm/discard comment scan) of the human-first bug-report intake
// pipeline. Every npm/gh call is injected via deps.spawnSync, same convention as
// test/auto-pull.test.js -- no real process is ever spawned.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp } = require('./helpers');
const {
  shouldAutoIntake,
  shouldScanConfirms,
  runReportIntake,
  reportConfirmScan,
  findPendingIntake,
  parseCardOutput,
  buildIntakeComment,
  CONFIRM_DISCARD_LINE,
  DEFAULT_AUTO_INTAKE_MS,
  DEFAULT_AUTO_INTAKE_LIMIT,
} = require('../orchestrator/report-intake');
const { appendDaemonEvent } = require('../orchestrator/journal');

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function writeReport(spoReportsDir, filename) {
  fs.mkdirSync(spoReportsDir, { recursive: true });
  fs.writeFileSync(path.join(spoReportsDir, filename), JSON.stringify({ version: 1 }));
  return path.join(spoReportsDir, filename);
}

const CARD_STDOUT = [
  'anchorKey: a1b2c3d4',
  'profile: mobile',
  'title: [report] mobile · Pay',
  '---',
  'the raw body',
].join('\n');

// ---- pure timer predicates -----------------------------------------------------------------

test('shouldAutoIntake / shouldScanConfirms: disabled at 0, due immediately when never run, respects the interval', () => {
  for (const fn of [shouldAutoIntake, shouldScanConfirms]) {
    assert.equal(fn(null, Date.now(), 0), false);
    assert.equal(fn(null, 1000, 300000), true);
    assert.equal(fn(1_000_000, 1_050_000, 300000), false);
    assert.equal(fn(1_000_000, 1_300_000, 300000), true);
  }
});

test('defaults: 15 min intake / 3 limit / 5 min confirm scan', () => {
  assert.equal(DEFAULT_AUTO_INTAKE_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_AUTO_INTAKE_LIMIT, 3);
});

// ---- parseCardOutput ------------------------------------------------------------------------

test('parseCardOutput: parses the header/body contract, null on a malformed reply', () => {
  const parsed = parseCardOutput(CARD_STDOUT);
  assert.deepEqual(parsed, { anchorKey: 'a1b2c3d4', profile: 'mobile', title: '[report] mobile · Pay', body: 'the raw body' });
  assert.equal(parseCardOutput('garbage, no separator'), null);
});

// ---- buildIntakeComment ---------------------------------------------------------------------

test('buildIntakeComment: contains the CONFIRM_DISCARD_LINE verbatim', () => {
  const text = buildIntakeComment({ reportFile: 'x.json' });
  assert.ok(text.includes(CONFIRM_DISCARD_LINE));
  assert.ok(text.includes('x.json'));
});

// ---- runReportIntake -------------------------------------------------------------------------

function makeIntakeDeps({ cardExit = 0, cardStdout = CARD_STDOUT, searchHits = [], ghResponder, npmResponder }) {
  return {
    spawnSync: (command, args) => {
      if (command === 'npm') {
        if (npmResponder) return npmResponder(args);
        return cardExit === 0 ? ok(cardStdout) : { status: cardExit, stdout: cardStdout, stderr: '', signal: null };
      }
      if (command === 'gh') {
        if (ghResponder) return ghResponder(args);
        if (args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify(searchHits));
        if (args[0] === 'issue' && args[1] === 'create') return ok('https://github.com/x/y/issues/501\n');
        if (args[0] === 'issue' && args[1] === 'comment') return ok('https://github.com/x/y/issues/501#issuecomment-9001\n');
        return ok('');
      }
      return ok('');
    },
  };
}

test('runReportIntake: happy path -- files a raw card, moves the column, comments, moves the file to pending/', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-1-');
  const journalRoot = mkTmp('spo-reportintake-journal1-');
  const reportPath = writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_aaa.json');

  const seenNpm = [];
  const deps = makeIntakeDeps({
    npmResponder: (args) => {
      seenNpm.push(args);
      if (args.includes('report:card')) return ok(CARD_STDOUT);
      return ok(''); // board:move
    },
  });

  const result = await runReportIntake(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y', reportIntakeColumn: 'Intake', reportIntakeLabel: 'report:raw', autoIntakeLimit: 3 },
    deps
  );

  assert.equal(result.filed, 1);
  assert.equal(fs.existsSync(reportPath), false);
  const pendingPath = path.join(spoReportsDir, 'pending', path.basename(reportPath));
  assert.equal(fs.existsSync(pendingPath), true);
  assert.match(fs.readFileSync(`${pendingPath}.disposition.txt`, 'utf8'), /^intake: #501 —/);

  assert.ok(seenNpm.some((a) => a.join(' ') === 'run board:move -- 501 Intake'));

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-intake"/);
  assert.match(daemonLog, /"issue":501/);
});

test('runReportIntake: mechanical anchorKey dedup -- comments on the existing issue, never creates a new one', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-2-');
  const journalRoot = mkTmp('spo-reportintake-journal2-');
  const reportPath = writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_bbb.json');

  let createCalled = false;
  const deps = makeIntakeDeps({
    searchHits: [{ number: 77 }],
    ghResponder: (args) => {
      if (args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify([{ number: 77 }]));
      if (args[0] === 'issue' && args[1] === 'create') { createCalled = true; return ok('https://x/999\n'); }
      if (args[0] === 'issue' && args[1] === 'comment') return ok('https://x/77#issuecomment-1\n');
      return ok('');
    },
  });

  const result = await runReportIntake(journalRoot, { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y' }, deps);

  assert.equal(result.duplicates, 1);
  assert.equal(createCalled, false);
  assert.equal(fs.existsSync(reportPath), false);
  const archived = path.join(spoReportsDir, 'archive', path.basename(reportPath));
  assert.match(fs.readFileSync(`${archived}.disposition.txt`, 'utf8'), /^duplicate: #77 —/);
});

test('runReportIntake: schema version mismatch -- left in place, never archived, journaled', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-3-');
  const journalRoot = mkTmp('spo-reportintake-journal3-');
  const reportPath = writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_ccc.json');

  const deps = makeIntakeDeps({ npmResponder: () => ({ status: 3, stdout: 'found: 2\nexpected: 1\n', stderr: '', signal: null }) });

  const result = await runReportIntake(journalRoot, { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y' }, deps);

  assert.equal(result.schemaVersion, 1);
  assert.equal(fs.existsSync(reportPath), true);
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-intake-schema-version"/);
});

test('runReportIntake: default limit 3 -- only the top 3 of 5 queued reports are processed', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-4-');
  const journalRoot = mkTmp('spo-reportintake-journal4-');
  for (let i = 0; i < 5; i++) writeReport(spoReportsDir, `2026-08-30T10-0${i}-00-000Z_mobile_r${i}.json`);

  const deps = makeIntakeDeps({});
  const result = await runReportIntake(journalRoot, { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y' }, deps);

  assert.equal(result.processed, 3);
});

test('runReportIntake: nothing queued -- no spawn at all', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-5-');
  const journalRoot = mkTmp('spo-reportintake-journal5-');
  let spawned = false;
  const deps = { spawnSync: () => { spawned = true; return ok(''); } };

  const result = await runReportIntake(journalRoot, { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y' }, deps);
  assert.equal(result.processed, 0);
  assert.equal(spawned, false);
});

// ---- reportConfirmScan -----------------------------------------------------------------------

function confirmDeps({ comments = [], closeResponder }) {
  return {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api') return ok(JSON.stringify(comments));
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'close') {
        return closeResponder ? closeResponder(args) : ok('');
      }
      return ok('');
    },
  };
}

test('reportConfirmScan: "confirm" reply -> journals report-confirmed, report stays pending', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-1-');
  const journalRoot = mkTmp('spo-confirmscan-journal1-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'r.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'r.json', pendingPath, issue: 11, commentId: 100 });

  const deps = confirmDeps({ comments: [{ id: 101, body: 'confirm, looks real' }] });
  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  assert.equal(result.confirmed, 1);
  assert.equal(fs.existsSync(pendingPath), true);
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-confirmed"/);
  assert.match(daemonLog, /"issue":11/);
});

test('reportConfirmScan: "discard" reply -> closes the issue, archives the report, journals report-discarded', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-2-');
  const journalRoot = mkTmp('spo-confirmscan-journal2-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'r2.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'r2.json', pendingPath, issue: 22, commentId: 100 });

  let closeCalled = false;
  const deps = confirmDeps({
    comments: [{ id: 101, body: 'discard, not a real issue' }],
    closeResponder: (args) => { closeCalled = true; return ok(''); },
  });
  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  assert.equal(result.discarded, 1);
  assert.equal(closeCalled, true);
  assert.equal(fs.existsSync(pendingPath), false);
  const archived = path.join(spoReportsDir, 'archive', 'r2.json');
  assert.match(fs.readFileSync(`${archived}.disposition.txt`, 'utf8'), /^discarded: #22 —/);
});

test('reportConfirmScan: a comment before the anchor, or matching neither word, is ignored', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-3-');
  const journalRoot = mkTmp('spo-confirmscan-journal3-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'r3.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'r3.json', pendingPath, issue: 33, commentId: 100 });

  const deps = confirmDeps({
    comments: [
      { id: 99, body: 'confirm' }, // before the anchor -- ignored
      { id: 102, body: 'looking into it, will decide later' }, // matches neither
    ],
  });
  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  assert.equal(result.confirmed, 0);
  assert.equal(result.discarded, 0);
  assert.equal(fs.existsSync(pendingPath), true);
  assert.deepEqual(findPendingIntake(journalRoot).map((e) => e.issue), [33]);
});

test('reportConfirmScan: already confirmed -- not re-scanned (findPendingIntake excludes it)', async () => {
  const journalRoot = mkTmp('spo-confirmscan-journal4-');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'r4.json', pendingPath: '/x', issue: 44, commentId: 1 });
  appendDaemonEvent(journalRoot, 'report-confirmed', { issue: 44, pendingPath: '/x', commentId: 2 });

  assert.deepEqual(findPendingIntake(journalRoot), []);
});
