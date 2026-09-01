'use strict';
// Tests for orchestrator/report-intake.js -- stages 1 (runReportIntake, mechanical) and 2
// (reportConfirmScan, the confirm/discard comment scan) of the human-first bug-report intake
// pipeline. Every npm/gh call is injected via deps.spawnSync, same convention as
// test/auto-pull.test.js -- no real process is ever spawned.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp, timeoutResult } = require('./helpers');
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
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
const { createScanState } = require('../orchestrator/comment-scan');

// `gh api` pagination rides in the path's query string, not in `-f page=N` argv elements -- a `-f`
// field would flip the call from GET to POST against the create-comment endpoint (see
// orchestrator/comment-scan.js's header and test/gh-api-argv.test.js). These fakes therefore read
// the page number out of the URL, the same place the real `gh` would.
function pageParamOf(args) {
  for (const a of args) {
    if (typeof a !== 'string') continue;
    const m = a.match(/[?&]page=(\d+)/);
    if (m) return m[1];
  }
  return undefined;
}


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
  assert.deepEqual(parsed, { anchorKey: 'a1b2c3d4', profile: 'mobile', kind: null, title: '[report] mobile · Pay', body: 'the raw body' });
  assert.equal(parseCardOutput('garbage, no separator'), null);
});

test('parseCardOutput: reads kind when report-card.js\'s header includes it', () => {
  const stdout = [
    'anchorKey: cb1e2f30',
    'profile: desktop',
    'kind: suggestion',
    'title: [suggestion] desktop · Add a slider',
    '---',
    'body',
  ].join('\n');
  assert.equal(parseCardOutput(stdout).kind, 'suggestion');
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
    sleep: async () => {}, // never actually wait in a test -- moveWithRetry's own injection point
    spawnSync: (command, args, opts) => {
      if (command === 'npm') {
        if (npmResponder) return npmResponder(args, opts); // opts: action 2.1b call-site arming
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

test('runReportIntake: threads kind through into the report-intake journal event', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-1b-');
  const journalRoot = mkTmp('spo-reportintake-journal1b-');
  writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_desktop_sugg.json');

  const suggestionCard = [
    'anchorKey: cb1e2f30',
    'profile: desktop',
    'kind: suggestion',
    'title: [suggestion] desktop · Add a slider',
    '---',
    'body',
  ].join('\n');
  const deps = makeIntakeDeps({
    npmResponder: (args) => (args.includes('report:card') ? ok(suggestionCard) : ok('')),
  });

  await runReportIntake(journalRoot, { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y' }, deps);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-intake"/);
  assert.match(daemonLog, /"kind":"suggestion"/);
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

test('runReportIntake: board move fails once (the GitHub auto-add race) then succeeds on retry -- no move-failed event', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-6-');
  const journalRoot = mkTmp('spo-reportintake-journal6-');
  writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_ddd.json');

  let moveAttempts = 0;
  const deps = makeIntakeDeps({
    npmResponder: (args) => {
      if (args.includes('report:card')) return ok(CARD_STDOUT);
      if (args.includes('board:move')) {
        moveAttempts++;
        return moveAttempts === 1 ? { status: 2, stdout: '', stderr: 'not on the board yet', signal: null } : ok('');
      }
      return ok('');
    },
  });

  const result = await runReportIntake(journalRoot, { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y' }, deps);

  assert.equal(result.filed, 1);
  assert.equal(moveAttempts, 2);
  const daemonLog = fs.existsSync(path.join(journalRoot, 'daemon.jsonl')) ? fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8') : '';
  assert.doesNotMatch(daemonLog, /"event":"report-intake-move-failed"/);
});

test('runReportIntake: board move exhausts every retry -- journals report-intake-move-failed, alerts, but still files/comments/moves the report', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-7-');
  const journalRoot = mkTmp('spo-reportintake-journal7-');
  const reportPath = writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_eee.json');

  const deps = makeIntakeDeps({
    npmResponder: (args) => {
      if (args.includes('report:card')) return ok(CARD_STDOUT);
      if (args.includes('board:move')) return { status: 2, stdout: '', stderr: 'not on the board yet', signal: null };
      return ok('');
    },
  });

  const result = await runReportIntake(journalRoot, { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y' }, deps);

  assert.equal(result.filed, 1); // still filed -- the label guard covers the rest, see this file's header
  assert.equal(fs.existsSync(reportPath), false); // still moved to pending/
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-intake-move-failed"/);
  assert.match(daemonLog, /"exit":2/);
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

// ---- action 2.1b: report-intake.js's own spawns are now bounded too ---------------------------
//
// runReportIntake's `npm run report:card` / `gh issue list` (dedup search) / `gh issue create`
// and reportConfirmScan's `gh api .../comments` / `gh issue close` used to spawn with no timeout
// at all -- a daemon-loop timer with no per-task lock, but every bit as capable of wedging the
// whole single-threaded daemon as any call action 2.1 already bounded. Never retried, never
// thrown: this is a daemon-loop scan, not a task step, so a timeout is converted into the same
// error-array/results-array shape each call site already returns on a plain non-zero exit, tagged
// `timedOut: true` so a hang is not silently indistinguishable from a normal gh/npm failure.

test('runReportIntake: action 2.1b -- arms the npm-run class timeout for report:card', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-timeout-arm-');
  const journalRoot = mkTmp('spo-reportintake-timeout-arm-journal-');
  writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_arm.json');

  let seenOpts = null;
  const deps = {
    sleep: async () => {},
    spawnSync: (command, args, opts) => {
      if (command === 'npm') seenOpts = opts;
      return ok(CARD_STDOUT);
    },
  };

  await runReportIntake(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y', commandTimeoutsMs: { 'npm-run': 660000, gh: 120000 } },
    deps
  );

  assert.equal(seenOpts.timeout, 660000);
});

test('runReportIntake: action 2.1b -- the board:move CALL SITE threads config through, so the move is bounded too', async () => {
  // The arming itself is proven once in test/command-timeout.test.js; what this pins is the
  // call site -- runReportIntake -> moveWithRetry -> board.moveIssueToColumn must forward
  // `config`, or that spawn silently reverts to unbounded while every other spawn stays bounded
  // (moveIssueToColumn arms nothing without it, by design). Same hazard, same test, as
  // auto-triage.js's own moveIssueToColumn call site.
  const spoReportsDir = mkTmp('spo-reportintake-movearm-');
  const journalRoot = mkTmp('spo-reportintake-movearm-journal-');
  writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_marm.json');

  let moveOpts = null;
  const deps = makeIntakeDeps({
    npmResponder: (args, opts) => {
      if (args.includes('report:card')) return ok(CARD_STDOUT);
      moveOpts = opts;
      return ok('');
    },
  });

  await runReportIntake(
    journalRoot,
    {
      spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y',
      reportIntakeColumn: 'Intake', reportIntakeLabel: 'report:raw', autoIntakeLimit: 3,
      commandTimeoutsMs: { 'npm-run': 660000, gh: 120000 },
    },
    deps
  );

  assert.equal(moveOpts && moveOpts.timeout, 660000, 'board:move must carry the npm-run class timeout');
});

test('runReportIntake: a timed-out report:card never throws -- stays queued, reported as an error with timedOut: true', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-timeout-1-');
  const journalRoot = mkTmp('spo-reportintake-timeout-journal1-');
  const reportPath = writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_to1.json');

  const deps = { sleep: async () => {}, spawnSync: () => timeoutResult() };

  // Awaited directly, no try/catch: if runReportIntake ever threw on a timeout instead of
  // reporting it, this `await` would reject and fail the test on its own -- the "never throws"
  // property doesn't need a separate assertion to be enforced here.
  const result = await runReportIntake(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y', commandTimeoutsMs: { 'npm-run': 660000 } },
    deps
  );

  assert.equal(result.filed, 0);
  assert.equal(fs.existsSync(reportPath), true, 'never archived on a timeout -- retried next cycle');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].timedOut, true);
  assert.ok(result.results.some((r) => r.outcome === 'error' && r.timedOut === true));
});

test('runReportIntake: a timed-out gh issue create never throws -- reported as an error with timedOut: true, report left in place', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-timeout-2-');
  const journalRoot = mkTmp('spo-reportintake-timeout-journal2-');
  const reportPath = writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_to2.json');

  const deps = {
    sleep: async () => {},
    spawnSync: (command, args) => {
      if (command === 'npm') return ok(CARD_STDOUT);
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return ok('[]');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') return timeoutResult();
      return ok('');
    },
  };

  const result = await runReportIntake(
    journalRoot,
    { spoReportsDir, productRepo: '/fake/repo', ghRepo: 'x/y', commandTimeoutsMs: { 'npm-run': 660000, gh: 120000 } },
    deps
  );

  assert.equal(result.filed, 0);
  assert.equal(fs.existsSync(reportPath), true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].timedOut, true);
});

// ---- reportConfirmScan -----------------------------------------------------------------------

function confirmDeps({ comments = [], closeResponder }) {
  return {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators'))
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
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

  const deps = confirmDeps({ comments: [{ id: 101, user: { login: 'Crazz-E' }, body: 'confirm, looks real' }] });
  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  assert.equal(result.confirmed, 1);
  assert.equal(fs.existsSync(pendingPath), true);
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-confirmed"/);
  assert.match(daemonLog, /"issue":11/);
});

test('reportConfirmScan: copies kind from the report-intake entry into report-confirmed', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-1c-');
  const journalRoot = mkTmp('spo-confirmscan-journal1c-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'r-sugg.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'r-sugg.json', pendingPath, issue: 12, commentId: 100, kind: 'suggestion' });

  const deps = confirmDeps({ comments: [{ id: 101, user: { login: 'Crazz-E' }, body: 'confirm' }] });
  await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-confirmed"[^\n]*"kind":"suggestion"/);
});

test('reportConfirmScan: "discard" reply -> closes the issue, archives the report, journals report-discarded', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-2-');
  const journalRoot = mkTmp('spo-confirmscan-journal2-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'r2.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'r2.json', pendingPath, issue: 22, commentId: 100 });

  let closeCalled = false;
  const deps = confirmDeps({
    comments: [{ id: 101, user: { login: 'Crazz-E' }, body: 'discard, not a real issue' }],
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
      { id: 99, user: { login: 'Crazz-E' }, body: 'confirm' }, // before the anchor -- ignored
      { id: 102, user: { login: 'Crazz-E' }, body: 'looking into it, will decide later' }, // matches neither
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

// ---- action 2.1b: reportConfirmScan's own spawns are now bounded too --------------------------

test('reportConfirmScan: action 2.1b -- arms the gh class timeout for the comments fetch', async () => {
  const journalRoot = mkTmp('spo-confirmscan-timeout-arm-');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'arm.json', pendingPath: '/x', issue: 50, commentId: 1 });

  let seenOpts = null;
  const deps = { spawnSync: (command, args, opts) => { seenOpts = opts; return ok('[]'); } };

  await reportConfirmScan(journalRoot, { ghRepo: 'x/y', commandTimeoutsMs: { gh: 120000 } }, deps);

  assert.equal(seenOpts.timeout, 120000);
});

test('reportConfirmScan: a timed-out gh api comments fetch never throws -- reported as an error with timedOut: true, report stays pending', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-timeout-1-');
  const journalRoot = mkTmp('spo-confirmscan-timeout-journal1-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'to1.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'to1.json', pendingPath, issue: 55, commentId: 100 });

  const deps = { spawnSync: () => timeoutResult() };

  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y', commandTimeoutsMs: { gh: 120000 } }, deps);

  assert.equal(result.confirmed, 0);
  assert.equal(result.discarded, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].timedOut, true);
  assert.equal(fs.existsSync(pendingPath), true, 'still pending -- retried next scan');
});

test('reportConfirmScan: a timed-out gh issue close (discard path) never throws -- reported as an error with timedOut: true, report stays pending', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-timeout-2-');
  const journalRoot = mkTmp('spo-confirmscan-timeout-journal2-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'to2.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'to2.json', pendingPath, issue: 66, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators'))
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      if (command === 'gh' && args[0] === 'api') return ok(JSON.stringify([{ id: 101, user: { login: 'Crazz-E' }, body: 'discard, duplicate of an old one' }]));
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'close') return timeoutResult();
      return ok('');
    },
  };

  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y', commandTimeoutsMs: { gh: 120000 } }, deps);

  assert.equal(result.discarded, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].timedOut, true);
  assert.equal(fs.existsSync(pendingPath), true, 'never archived on a timeout -- retried next scan');
});

// ---- action 2.7: unified comment-scan rewrite (pagination, allowlist, backoff) -----------------

function daemonEvents(journalRoot) {
  const p = path.join(journalRoot, 'daemon.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('reportConfirmScan: a "confirm" reply from a COLLABORATOR works exactly as before', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan27-collab-');
  const journalRoot = mkTmp('spo-confirmscan27-collab-journal-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'c1.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'c1.json', pendingPath, issue: 70, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'maintainer' }]));
      }
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 101, body: 'confirm, looks real', user: { login: 'maintainer' } }]));
      }
      return ok('');
    },
  };

  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  assert.equal(result.confirmed, 1);
  assert.ok(daemonEvents(journalRoot).some((e) => e.event === 'report-confirmed' && e.issue === 70));
});

test('reportConfirmScan: a "confirm" reply from a NON-collaborator is ignored, journalled, and never confirms', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan27-noncollab-');
  const journalRoot = mkTmp('spo-confirmscan27-noncollab-journal-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'c2.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'c2.json', pendingPath, issue: 71, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'maintainer' }]));
      }
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify([{ id: 102, body: 'confirm, I am nobody', user: { login: 'rando' } }]));
      }
      return ok('');
    },
  };

  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  assert.equal(result.confirmed, 0);
  assert.equal(fs.existsSync(pendingPath), true);
  const events = daemonEvents(journalRoot);
  assert.ok(!events.some((e) => e.event === 'report-confirmed'));
  const ignored = events.find((e) => e.event === 'report-confirm-scan-ignored-author');
  assert.ok(ignored, 'the ignored attempt must still be journalled, not silently dropped');
  assert.equal(ignored.issue, 71);
  assert.equal(ignored.author, 'rando');
});

test('reportConfirmScan: a reply on page 2 of 3 is found -- the one-page bug this action fixes', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan27-page2-');
  const journalRoot = mkTmp('spo-confirmscan27-page2-journal-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'c3.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'c3.json', pendingPath, issue: 72, commentId: 500 });

  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'old chatter' }));
  const page2 = Array.from({ length: 100 }, (_, i) => ({ id: 501 + i, body: 'old-ish chatter' }));
  page2[49] = { id: 550, body: 'confirm, reproduced it', user: { login: 'maintainer' } };
  const page3 = Array.from({ length: 20 }, (_, i) => ({ id: 601 + i, body: 'more chatter' }));

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'maintainer' }]));
      }
      const pageArg = pageParamOf(args);
      const page = pageArg ? Number(pageArg) : 1;
      if (page === 1) return ok(JSON.stringify(page1));
      if (page === 2) return ok(JSON.stringify(page2));
      return ok(JSON.stringify(page3));
    },
  };

  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  assert.equal(result.confirmed, 1, 'a reply on page 2 must be found, not silently missed the way it used to be');
  const confirmedEvent = daemonEvents(journalRoot).find((e) => e.event === 'report-confirmed');
  assert.equal(confirmedEvent.commentId, 550);
});

test('reportConfirmScan: the collaborator list is fetched once per repo and reused across multiple pending reports in the same pass', async () => {
  const journalRoot = mkTmp('spo-confirmscan27-cache-journal-');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'a.json', pendingPath: '/x/a', issue: 80, commentId: 1 });
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'b.json', pendingPath: '/x/b', issue: 81, commentId: 1 });

  let collabCalls = 0;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        collabCalls++;
        return ok(JSON.stringify([{ login: 'maintainer' }]));
      }
      return ok(JSON.stringify([]));
    },
  };

  await reportConfirmScan(journalRoot, { ghRepo: 'x/y' }, deps);

  assert.equal(collabCalls, 1, 'two pending reports sharing a repo must not each pay for their own collaborators fetch');
});

test('reportConfirmScan: consecutive gh failures on the SAME issue back off, and a subsequent success resets it, and it is journalled', async () => {
  const journalRoot = mkTmp('spo-confirmscan27-backoff-journal-');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'z.json', pendingPath: '/x/z', issue: 90, commentId: 1 });

  let ghApiCalls = 0;
  let shouldFail = true;
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && !String(args[1]).endsWith('/collaborators')) {
        ghApiCalls++;
        if (shouldFail) return { status: 1, stdout: '', stderr: 'boom', signal: null };
      }
      return ok('[]');
    },
  };

  const scanState = createScanState();
  await reportConfirmScan(journalRoot, { ghRepo: 'x/y' }, { ...deps, now: 1000 }, scanState); // failure 1
  await reportConfirmScan(journalRoot, { ghRepo: 'x/y' }, { ...deps, now: 2000 }, scanState); // failure 2 -- now backs off

  const callsBeforeBackoffCheck = ghApiCalls;
  const backedOffResult = await reportConfirmScan(journalRoot, { ghRepo: 'x/y' }, { ...deps, now: 2500 }, scanState); // still backed off
  assert.equal(ghApiCalls, callsBeforeBackoffCheck, 'a backed-off cycle must not call gh again');
  assert.equal(backedOffResult.skipped, 1);
  assert.ok(daemonEvents(journalRoot).some((e) => e.event === 'report-confirm-scan-backoff-skip'));

  shouldFail = false;
  await reportConfirmScan(journalRoot, { ghRepo: 'x/y' }, { ...deps, now: 2400000 }, scanState); // well past the backoff window
  assert.ok(ghApiCalls > callsBeforeBackoffCheck, 'once the backoff window elapses, the scan tries gh again');
});

test('reportConfirmScan: the page bound being hit is journalled distinguishably from "no reply"', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan27-truncated-');
  const journalRoot = mkTmp('spo-confirmscan27-truncated-journal-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'c4.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'c4.json', pendingPath, issue: 91, commentId: 0 });

  const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'chatter' }));
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok('[]');
      return ok(JSON.stringify(fullPage)); // always full -- never a natural end
    },
  };

  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y', commentScanMaxPages: 1 }, deps);

  assert.equal(result.confirmed, 0);
  const events = daemonEvents(journalRoot);
  assert.ok(events.some((e) => e.event === 'report-confirm-scan-truncated' && e.issue === 91));
  assert.ok(!events.some((e) => e.event === 'report-confirmed'));
});
