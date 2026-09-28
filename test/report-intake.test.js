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
  checkReportIntakeRepo,
  moveWithRetry,
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

// Card #299: stage 1 files only on a PRIVATE repository that `gh api repos/<it>` confirms. The
// fixtures below name a private repo distinct from ghRepo; the fake gh answers that GET with
// visibilityReply (a private repository unless a test says otherwise).
const PRIVATE_REPO = 'x/private-reports';
const PUBLIC_REPO = 'x/y';

function intakeConfig(spoReportsDir, extra = {}) {
  return { spoReportsDir, productRepo: '/fake/repo', ghRepo: PUBLIC_REPO, reportIntakeRepo: PRIVATE_REPO, ...extra };
}

function isVisibilityCall(command, args) {
  return command === 'gh' && args[0] === 'api' && args.length === 2 && /^repos\/[^/]+\/[^/]+$/.test(String(args[1]));
}

function visibilityReply(repo = PRIVATE_REPO, isPrivate = true) {
  return ok(JSON.stringify({ full_name: repo, private: isPrivate }));
}

// Wraps any spawnSync fake so the visibility GET answers "private" -- for the tests below whose
// subject is not the gate.
function withPrivateVisibility(spawnSync) {
  return (command, args, opts) =>
    isVisibilityCall(command, args) ? visibilityReply(String(args[1]).slice('repos/'.length)) : spawnSync(command, args, opts);
}

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

function makeIntakeDeps({ cardExit = 0, cardStdout = CARD_STDOUT, searchHits = [], ghResponder, npmResponder, visibility }) {
  return {
    sleep: async () => {}, // never actually wait in a test -- moveWithRetry's own injection point
    spawnSync: (command, args, opts) => {
      if (isVisibilityCall(command, args)) {
        if (visibility) return visibility(args);
        return visibilityReply(String(args[1]).slice('repos/'.length));
      }
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

test('runReportIntake: happy path -- files a raw card on the private repo, comments, moves the file to pending/, no board move', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-1-');
  const journalRoot = mkTmp('spo-reportintake-journal1-');
  const reportPath = writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_aaa.json');

  const seenNpm = [];
  const deps = makeIntakeDeps({
    npmResponder: (args) => {
      seenNpm.push(args);
      if (args.includes('report:card')) return ok(CARD_STDOUT);
      return ok('');
    },
  });

  const result = await runReportIntake(
    journalRoot,
    intakeConfig(spoReportsDir, { reportIntakeColumn: 'Intake', reportIntakeLabel: 'report:raw', autoIntakeLimit: 3 }),
    deps
  );

  assert.equal(result.filed, 1);
  assert.equal(fs.existsSync(reportPath), false);
  const pendingPath = path.join(spoReportsDir, 'pending', path.basename(reportPath));
  assert.equal(fs.existsSync(pendingPath), true);
  assert.match(fs.readFileSync(`${pendingPath}.disposition.txt`, 'utf8'), /^intake: x\/private-reports#501 —/);

  assert.ok(!seenNpm.some((a) => a.includes('board:move')), 'card #299: a raw card is never moved on project 1');

  const intakeEvent = daemonEvents(journalRoot).find((e) => e.event === 'report-intake');
  assert.ok(intakeEvent);
  assert.equal(intakeEvent.issue, 501);
  assert.equal(intakeEvent.repo, PRIVATE_REPO);
});

// Action 3.1 (Lot 3): report-intake.js:473 binds moveReportTo's return value into the
// report-intake event's own `pendingPath` field. Before this action that value was ALWAYS a
// string (even on the swallowed-ENOENT race, moveReportTo used to return a fabricated `dest` that
// was never actually there) -- now it can be `null`, and this is the one place in the whole
// pipeline that binding is observable: the journal event itself. Forces ENOENT on the SAME rename
// runReportIntake's happy-path test above exercises (moveReportTo's move into pending/), so this
// is a reachability test for report-intake.js's own call site, not a re-test of moveReportTo's
// unit behaviour (that lives in test/auto-triage.test.js).
test('runReportIntake: the pending/ move racing another disposal (ENOENT) records pendingPath: null on the report-intake event -- never a fabricated path -- and journals report-move-source-missing', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-move-missing-');
  const journalRoot = mkTmp('spo-reportintake-move-missing-journal-');
  const reportPath = writeReport(spoReportsDir, '2026-09-01T10-00-00-000Z_mobile_vanish.json');

  const deps = makeIntakeDeps({});

  const origRename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (src === reportPath) {
      const err = new Error('simulated: source already gone');
      err.code = 'ENOENT';
      throw err;
    }
    return origRename(src, dest);
  };
  let result;
  try {
    result = await runReportIntake(
      journalRoot,
      intakeConfig(spoReportsDir, { reportIntakeColumn: 'Intake', reportIntakeLabel: 'report:raw', autoIntakeLimit: 3 }),
      deps
    );
  } finally {
    fs.renameSync = origRename;
  }

  assert.equal(result.filed, 1, 'the card is still filed -- only the pending/ move raced another disposal');

  const daemonLog = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const intakeEvent = daemonLog.find((e) => e.event === 'report-intake' && e.issue === 501);
  assert.ok(intakeEvent, 'expected a report-intake event for issue 501');
  assert.equal(intakeEvent.pendingPath, null, 'must record null -- the source vanished, so there is no path to vouch for');
  assert.ok('pendingPath' in intakeEvent, 'the field must be present (as null), not silently omitted -- see report-intake.js:456\'s own comment for why');

  const missingEvent = daemonLog.find((e) => e.event === 'report-move-source-missing');
  assert.ok(missingEvent, 'expected a report-move-source-missing event');
  assert.equal(missingEvent.from, reportPath);
  assert.match(missingEvent.to, /pending/);
  assert.match(missingEvent.disposition, /^intake: x\/private-reports#501 —/);
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

  await runReportIntake(journalRoot, intakeConfig(spoReportsDir), deps);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-intake"/);
  assert.match(daemonLog, /"kind":"suggestion"/);
  // card #299: the profile rides along for stage 3's fixed public occurrence line
  assert.match(daemonLog, /"event":"report-intake"[^\n]*"profile":"desktop"/);
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

  const result = await runReportIntake(journalRoot, intakeConfig(spoReportsDir), deps);

  assert.equal(result.duplicates, 1);
  assert.equal(createCalled, false);
  assert.equal(fs.existsSync(reportPath), false);
  const archived = path.join(spoReportsDir, 'archive', path.basename(reportPath));
  assert.match(fs.readFileSync(`${archived}.disposition.txt`, 'utf8'), /^duplicate: x\/private-reports#77 —/);
});

// moveWithRetry has no stage-1 caller since card #299 (the private repository is not on project
// 1); it is kept and exported for stage 3's new public card. Its retry contract, driven directly:
test('moveWithRetry: a move that fails once (the GitHub auto-add race) then succeeds is retried', async () => {
  let moveAttempts = 0;
  const deps = {
    sleep: async () => {},
    spawnSync: (command, args) => {
      if (command === 'npm' && args.includes('board:move')) {
        moveAttempts++;
        return moveAttempts === 1 ? { status: 2, stdout: '', stderr: 'not on the board yet', signal: null } : ok('');
      }
      return ok('');
    },
  };
  const moved = await moveWithRetry(501, 'Intake', deps, { cwd: '/fake/repo' });
  assert.equal(moved.ok, true);
  assert.equal(moveAttempts, 2);
});

test('moveWithRetry: exhausting every retry returns the last failure, never throws', async () => {
  let moveAttempts = 0;
  const deps = {
    sleep: async () => {},
    spawnSync: () => {
      moveAttempts++;
      return { status: 2, stdout: '', stderr: 'not on the board yet', signal: null };
    },
  };
  const moved = await moveWithRetry(501, 'Intake', deps, { cwd: '/fake/repo' });
  assert.equal(moved.ok, false);
  assert.equal(moved.exit, 2);
  assert.equal(moveAttempts, 3);
});

test('runReportIntake: schema version mismatch -- left in place, never archived, journaled', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-3-');
  const journalRoot = mkTmp('spo-reportintake-journal3-');
  const reportPath = writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_ccc.json');

  const deps = makeIntakeDeps({ npmResponder: () => ({ status: 3, stdout: 'found: 2\nexpected: 1\n', stderr: '', signal: null }) });

  const result = await runReportIntake(journalRoot, intakeConfig(spoReportsDir), deps);

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
  const result = await runReportIntake(journalRoot, intakeConfig(spoReportsDir), deps);

  assert.equal(result.processed, 3);
});

test('runReportIntake: nothing queued -- no spawn at all', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-5-');
  const journalRoot = mkTmp('spo-reportintake-journal5-');
  let spawned = false;
  const deps = { spawnSync: () => { spawned = true; return ok(''); } };

  const result = await runReportIntake(journalRoot, intakeConfig(spoReportsDir), deps);
  assert.equal(result.processed, 0);
  assert.equal(spawned, false, 'an empty queue spends nothing -- not even the visibility GET');
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false, 'and journals nothing');
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
  let visibilityOpts = null;
  const deps = {
    sleep: async () => {},
    spawnSync: (command, args, opts) => {
      if (isVisibilityCall(command, args)) {
        visibilityOpts = opts;
        return visibilityReply();
      }
      if (command === 'npm') seenOpts = opts;
      return ok(CARD_STDOUT);
    },
  };

  await runReportIntake(
    journalRoot,
    intakeConfig(spoReportsDir, { commandTimeoutsMs: { 'npm-run': 660000, gh: 120000 } }),
    deps
  );

  assert.equal(seenOpts.timeout, 660000);
  assert.equal(visibilityOpts && visibilityOpts.timeout, 120000, 'card #299: the visibility GET is bounded by the gh class timeout too');
});

test('runReportIntake: a timed-out report:card never throws -- stays queued, reported as an error with timedOut: true', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-timeout-1-');
  const journalRoot = mkTmp('spo-reportintake-timeout-journal1-');
  const reportPath = writeReport(spoReportsDir, '2026-08-30T10-00-00-000Z_mobile_to1.json');

  const deps = { sleep: async () => {}, spawnSync: withPrivateVisibility(() => timeoutResult()) };

  // Awaited directly, no try/catch: if runReportIntake ever threw on a timeout instead of
  // reporting it, this `await` would reject and fail the test on its own -- the "never throws"
  // property doesn't need a separate assertion to be enforced here.
  const result = await runReportIntake(
    journalRoot,
    intakeConfig(spoReportsDir, { commandTimeoutsMs: { 'npm-run': 660000 } }),
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
    spawnSync: withPrivateVisibility((command, args) => {
      if (command === 'npm') return ok(CARD_STDOUT);
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return ok('[]');
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') return timeoutResult();
      return ok('');
    }),
  };

  const result = await runReportIntake(
    journalRoot,
    intakeConfig(spoReportsDir, { commandTimeoutsMs: { 'npm-run': 660000, gh: 120000 } }),
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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'r.json', pendingPath, issue: 11, commentId: 100 });

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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'r-sugg.json', pendingPath, issue: 12, commentId: 100, kind: 'suggestion', profile: 'mobile' });

  const deps = confirmDeps({ comments: [{ id: 101, user: { login: 'Crazz-E' }, body: 'confirm' }] });
  await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"report-confirmed"[^\n]*"kind":"suggestion"/);
  assert.match(daemonLog, /"event":"report-confirmed"[^\n]*"profile":"mobile"/, 'card #299: profile carried to stage 3');
});

test('reportConfirmScan: "discard" reply -> closes the issue, archives the report, journals report-discarded', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-2-');
  const journalRoot = mkTmp('spo-confirmscan-journal2-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'r2.json');
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'r2.json', pendingPath, issue: 22, commentId: 100 });

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
  assert.match(fs.readFileSync(`${archived}.disposition.txt`, 'utf8'), /^discarded: x\/private-reports#22 —/);
});

// Action 3.1 (Lot 3): reportConfirmScan's discard branch calls `moveReportTo(entry.pendingPath,
// ...)` directly -- entry.pendingPath here is a report-intake event's own `pendingPath` field,
// read straight off daemon.jsonl, with NO claim step in between (unlike auto-triage.js's
// claimReport/routeConfirmedReport flow, which auto-triage.js's own tests cover separately). That
// field can now BE `null` (moveReportTo's own swallowed-ENOENT branch, if stage 1's pending-move
// itself raced another disposal) -- and `moveReportTo`'s first move is `path.basename(reportPath)`,
// which throws a TypeError, uncaught, on a bare `null`. `gh issue close` still succeeds in this
// scenario (the raw card itself is real and closeable even though its report file is gone), so
// this path is reachable on a genuine production sequence: intake binds `pendingPath: null` ->
// a maintainer later replies "discard" -> `gh issue close` succeeds -> the discard branch hands
// the null straight to moveReportTo.
test('reportConfirmScan: "discard" on a report-intake entry with pendingPath: null does not throw -- discards cleanly and journals report-move-source-missing with from/to both null', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-2b-nullpending-');
  const journalRoot = mkTmp('spo-confirmscan-journal2b-nullpending-');
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'r2b.json', pendingPath: null, issue: 23, commentId: 100 });

  let closeCalled = false;
  const deps = confirmDeps({
    comments: [{ id: 101, user: { login: 'Crazz-E' }, body: 'discard, duplicate report' }],
    closeResponder: () => { closeCalled = true; return ok(''); },
  });
  const result = await reportConfirmScan(journalRoot, { spoReportsDir, ghRepo: 'x/y' }, deps);

  assert.equal(result.discarded, 1, 'the discard must still complete -- there is no throw to abort it');
  assert.equal(closeCalled, true);

  const events = daemonEvents(journalRoot);
  const discardedEvent = events.find((e) => e.event === 'report-discarded' && e.issue === 23);
  assert.ok(discardedEvent, 'expected a report-discarded event even though the report file was already gone');

  const missingEvent = events.find((e) => e.event === 'report-move-source-missing');
  assert.ok(missingEvent, 'expected a report-move-source-missing event');
  // Strictly null and PRESENT -- not merely falsy, and not silently omitted by the JSONL
  // round-trip (JSON.stringify keeps an explicit `null` value; only `undefined` would vanish).
  assert.ok('from' in missingEvent, '`from` must be present on the event, not omitted');
  assert.ok('to' in missingEvent, '`to` must be present on the event, not omitted');
  assert.equal(missingEvent.from, null);
  assert.equal(missingEvent.to, null, 'there is no source path to derive a destination basename from');
});

test('reportConfirmScan: a comment before the anchor, or matching neither word, is ignored', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-3-');
  const journalRoot = mkTmp('spo-confirmscan-journal3-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'r3.json');
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'r3.json', pendingPath, issue: 33, commentId: 100 });

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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'r4.json', pendingPath: '/x', issue: 44, commentId: 1 });
  appendDaemonEvent(journalRoot, 'report-confirmed', { repo: PRIVATE_REPO, issue: 44, pendingPath: '/x', commentId: 2 });

  assert.deepEqual(findPendingIntake(journalRoot), []);
});

// ---- action 2.1b: reportConfirmScan's own spawns are now bounded too --------------------------

test('reportConfirmScan: action 2.1b -- arms the gh class timeout for the comments fetch', async () => {
  const journalRoot = mkTmp('spo-confirmscan-timeout-arm-');
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'arm.json', pendingPath: '/x', issue: 50, commentId: 1 });

  let seenOpts = null;
  const deps = { spawnSync: (command, args, opts) => { seenOpts = opts; return ok('[]'); } };

  await reportConfirmScan(journalRoot, { ghRepo: 'x/y', commandTimeoutsMs: { gh: 120000 } }, deps);

  assert.equal(seenOpts.timeout, 120000);
});

test('reportConfirmScan: a timed-out gh api comments fetch never throws -- reported as an error with timedOut: true, report stays pending', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-timeout-1-');
  const journalRoot = mkTmp('spo-confirmscan-timeout-journal1-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'to1.json');
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'to1.json', pendingPath, issue: 55, commentId: 100 });

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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'to2.json', pendingPath, issue: 66, commentId: 100 });

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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'c1.json', pendingPath, issue: 70, commentId: 100 });

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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'c2.json', pendingPath, issue: 71, commentId: 100 });

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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'c3.json', pendingPath, issue: 72, commentId: 500 });

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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'a.json', pendingPath: '/x/a', issue: 80, commentId: 1 });
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'b.json', pendingPath: '/x/b', issue: 81, commentId: 1 });

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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'z.json', pendingPath: '/x/z', issue: 90, commentId: 1 });

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
  appendDaemonEvent(journalRoot, 'report-intake', { repo: PRIVATE_REPO, reportFile: 'c4.json', pendingPath, issue: 91, commentId: 0 });

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

// ---- card SPO-Pipeline#299: raw reports go to a PRIVATE repository, fail closed ------------------
//
// The raw render carries the reporter's username, their free text and the whole client journal.
// Before #299 stage 1 filed it on ghRepo (SPO-WebClient, public) and moved it onto project 1
// (public). These tests pin the replacement: every stage-1/2 `gh` call names the private
// reportIntakeRepo (or the repo a pending event recorded), and a cycle whose private repository
// cannot be PROVEN private files nothing at all. The names below are the production ones on
// purpose, so an assertion "no spawn names Crazz-Org/SPO-WebClient" reads literally.
const REAL_PUBLIC = 'Crazz-Org/SPO-WebClient';
const REAL_PRIVATE = 'Crazz-Org/SPO-Reports';
const RENDER_BODY = '| username | SPO_player_x |\n\nobserved: the price is wrong, my free text\n\n<details>journal payload</details>';
const RENDER_STDOUT = ['anchorKey: feedf00d', 'profile: desktop', 'title: [report] desktop · Shop', '---', RENDER_BODY].join('\n');

// Records every spawn as {command, args, bodyFiles}, where bodyFiles holds the CONTENT of every
// `--body-file` argument read at spawn time (the files are temp files a later step may reuse).
function recordingDeps({ visibility, searchHits = [], alertCmd, onSpawn } = {}) {
  const spawns = [];
  const deps = {
    sleep: async () => {},
    spawnSync: (command, args, opts) => {
      const bodyFiles = [];
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '--body-file') {
          try {
            bodyFiles.push(fs.readFileSync(args[i + 1], 'utf8'));
          } catch {
            bodyFiles.push(null);
          }
        }
      }
      spawns.push({ command, args: args.slice(), bodyFiles });
      if (onSpawn) {
        const r = onSpawn(command, args, opts);
        if (r) return r;
      }
      if (alertCmd && command === alertCmd) return ok('');
      if (isVisibilityCall(command, args)) {
        return visibility ? visibility(args) : visibilityReply(String(args[1]).slice('repos/'.length));
      }
      if (command === 'npm') return ok(RENDER_STDOUT);
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify(searchHits));
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') return ok(`https://github.com/${REAL_PRIVATE}/issues/7\n`);
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') return ok(`https://github.com/${REAL_PRIVATE}/issues/7#issuecomment-9001\n`);
      return ok('');
    },
  };
  return { deps, spawns };
}

function namesRepo(spawn, repo) {
  const lower = repo.toLowerCase();
  return spawn.args.some((a) => {
    const v = String(a).toLowerCase();
    return v === lower || v.startsWith(`repos/${lower}/`) || v === `repos/${lower}`;
  });
}

function realConfig(spoReportsDir, extra = {}) {
  return { spoReportsDir, productRepo: '/fake/repo', ghRepo: REAL_PUBLIC, reportIntakeRepo: REAL_PRIVATE, ...extra };
}

// ---- checkReportIntakeRepo: every refusal reason, and the one pass --------------------------

test('checkReportIntakeRepo: refuses unset, malformed and ghRepo-equal settings WITHOUT spending a gh call', () => {
  const cases = [
    [{ reportIntakeRepo: '' }, 'unset'],
    [{ reportIntakeRepo: undefined }, 'unset'],
    [{ reportIntakeRepo: 'no-slash' }, 'malformed'],
    [{ reportIntakeRepo: 'Crazz-Org/../users' }, 'malformed'],
    [{ reportIntakeRepo: 'a/b/c' }, 'malformed'],
    [{ reportIntakeRepo: REAL_PUBLIC }, 'same-as-public-repo'],
    [{ reportIntakeRepo: 'crazz-org/spo-webclient' }, 'same-as-public-repo'],
  ];
  for (const [extra, reason] of cases) {
    let spawned = 0;
    const gate = checkReportIntakeRepo({ ghRepo: REAL_PUBLIC, ...extra }, { spawnSync: () => { spawned++; return ok(''); } });
    assert.equal(gate.ok, false, JSON.stringify(extra));
    assert.equal(gate.reason, reason, JSON.stringify(extra));
    assert.equal(spawned, 0, `${reason}: decided without asking gh`);
  }
});

test('checkReportIntakeRepo: only a repository gh reports as "private": true passes -- anything else refuses', () => {
  const replies = [
    [{ status: 1, stdout: '', stderr: 'HTTP 404: Not Found\nmore', signal: null }, 'visibility-check-failed'],
    [timeoutResult(), 'visibility-check-failed'],
    [ok('not json'), 'visibility-unparsable'],
    [ok('[]'), 'visibility-unparsable'],
    [ok('null'), 'visibility-unparsable'],
    [ok(JSON.stringify({ full_name: REAL_PRIVATE, private: false })), 'not-private'],
    [ok(JSON.stringify({ full_name: REAL_PRIVATE })), 'not-private'],
    [ok(JSON.stringify({ full_name: REAL_PRIVATE, private: 'true' })), 'not-private'],
    // a renamed/transferred repository redirects -- the one gh actually answered for is ghRepo
    [ok(JSON.stringify({ full_name: REAL_PUBLIC, private: true })), 'same-as-public-repo'],
  ];
  for (const [reply, reason] of replies) {
    const seen = [];
    const gate = checkReportIntakeRepo(
      { ghRepo: REAL_PUBLIC, reportIntakeRepo: REAL_PRIVATE },
      { spawnSync: (command, args) => { seen.push([command, ...args]); return reply; } }
    );
    assert.equal(gate.ok, false, reason);
    assert.equal(gate.reason, reason);
    assert.deepEqual(seen, [['gh', 'api', `repos/${REAL_PRIVATE}`]], 'one plain GET, no -f');
  }
  const failed = checkReportIntakeRepo(
    { ghRepo: REAL_PUBLIC, reportIntakeRepo: REAL_PRIVATE },
    { spawnSync: () => ({ status: 1, stdout: '', stderr: 'HTTP 404: Not Found\nmore', signal: null }) }
  );
  assert.equal(failed.exit, 1);
  assert.equal(failed.stderr, 'HTTP 404: Not Found');

  const passed = checkReportIntakeRepo(
    { ghRepo: REAL_PUBLIC, reportIntakeRepo: REAL_PRIVATE },
    { spawnSync: () => ok(JSON.stringify({ full_name: REAL_PRIVATE, private: true })) }
  );
  assert.deepEqual(passed, { ok: true, repo: REAL_PRIVATE });
});

// ---- runReportIntake: the gate refuses the whole cycle (Done when 1) --------------------------

const REFUSAL_SCENARIOS = [
  { name: 'unset', extra: { reportIntakeRepo: '' }, reason: 'unset' },
  { name: 'equal to ghRepo', extra: { reportIntakeRepo: REAL_PUBLIC }, reason: 'same-as-public-repo' },
  { name: 'answering "private": false', visibility: () => visibilityReply(REAL_PRIVATE, false), reason: 'not-private' },
  { name: 'visibility call failing', visibility: () => ({ status: 1, stdout: '', stderr: 'HTTP 502', signal: null }), reason: 'visibility-check-failed' },
  { name: 'visibility call timing out', visibility: () => timeoutResult(), reason: 'visibility-check-failed' },
];

for (const scenario of REFUSAL_SCENARIOS) {
  test(`runReportIntake: reportIntakeRepo ${scenario.name} -- nothing rendered or filed, the report stays queued, report-intake-refused-not-private journalled and alerted`, async () => {
    const spoReportsDir = mkTmp('spo-reportintake-299-refuse-');
    const journalRoot = mkTmp('spo-reportintake-299-refuse-journal-');
    const reportPath = writeReport(spoReportsDir, '2026-09-28T10-00-00-000Z_desktop_refuse.json');
    const { deps, spawns } = recordingDeps({ visibility: scenario.visibility, alertCmd: 'fake-alert' });

    const result = await runReportIntake(journalRoot, realConfig(spoReportsDir, { parkAlertCmd: 'fake-alert', ...scenario.extra }), deps);

    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
    assert.equal(result.reason, scenario.reason);
    assert.equal(result.filed, 0);
    assert.ok(!spawns.some((sp) => sp.command === 'gh' && sp.args[0] === 'issue'), 'no gh issue call of any kind');
    assert.ok(!spawns.some((sp) => sp.command === 'npm'), 'refused BEFORE rendering: the raw render never even exists');
    assert.equal(fs.existsSync(reportPath), true, 'the report is still in the queue');
    assert.equal(fs.existsSync(path.join(spoReportsDir, 'pending')), false);

    const refused = daemonEvents(journalRoot).filter((e) => e.event === 'report-intake-refused-not-private');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason, scenario.reason);
    assert.equal(refused[0].repo, (scenario.extra && scenario.extra.reportIntakeRepo !== undefined) ? scenario.extra.reportIntakeRepo : REAL_PRIVATE);
    assert.equal(refused[0].queued, 1);
    assert.ok(!daemonEvents(journalRoot).some((e) => e.event === 'report-intake'), 'nothing filed');

    const alerts = spawns.filter((sp) => sp.command === 'fake-alert');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].args[2], 'INTAKE');
    assert.match(alerts[0].args[1], new RegExp(scenario.reason));
  });
}

test('runReportIntake: the refusal is throttled -- an identical second cycle writes no second event and no second alert; a changed reason does; recovery journals report-intake-repo-accepted and re-arms', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-299-throttle-');
  const journalRoot = mkTmp('spo-reportintake-299-throttle-journal-');
  const reportPath = writeReport(spoReportsDir, '2026-09-28T10-00-00-000Z_desktop_throttle.json');
  const alertsOf = (spawns) => spawns.filter((sp) => sp.command === 'fake-alert').length;
  const gateEvents = () =>
    daemonEvents(journalRoot).filter((e) => e.event === 'report-intake-refused-not-private' || e.event === 'report-intake-repo-accepted');

  // cycle 1 + 2: unset, twice
  let run = recordingDeps({ alertCmd: 'fake-alert' });
  await runReportIntake(journalRoot, realConfig(spoReportsDir, { parkAlertCmd: 'fake-alert', reportIntakeRepo: '' }), run.deps);
  assert.equal(alertsOf(run.spawns), 1);
  run = recordingDeps({ alertCmd: 'fake-alert' });
  const second = await runReportIntake(journalRoot, realConfig(spoReportsDir, { parkAlertCmd: 'fake-alert', reportIntakeRepo: '' }), run.deps);
  assert.equal(second.refused, true, 'still refused -- only the journal/alert is throttled, never the refusal');
  assert.equal(alertsOf(run.spawns), 0, 'no second alert for the same refusal');
  assert.equal(gateEvents().length, 1, 'no second event for the same refusal');

  // cycle 3: the setting now names a PUBLIC repository -- a new reason is news
  run = recordingDeps({ alertCmd: 'fake-alert', visibility: () => visibilityReply(REAL_PRIVATE, false) });
  await runReportIntake(journalRoot, realConfig(spoReportsDir, { parkAlertCmd: 'fake-alert' }), run.deps);
  assert.equal(alertsOf(run.spawns), 1);
  assert.deepEqual(gateEvents().map((e) => e.reason), ['unset', 'not-private']);

  // cycle 3b: the SAME repo, a DIFFERENT reason (the visibility GET now fails) -- the reason alone
  // is news. Cycle 3 changed repo AND reason together, so it could not tell which one the throttle keys on.
  run = recordingDeps({ alertCmd: 'fake-alert', visibility: () => ({ status: 1, stdout: '', stderr: 'HTTP 502', signal: null }) });
  await runReportIntake(journalRoot, realConfig(spoReportsDir, { parkAlertCmd: 'fake-alert' }), run.deps);
  assert.equal(alertsOf(run.spawns), 1, 'same repo, new reason: alerted again');
  assert.deepEqual(gateEvents().map((e) => e.reason), ['unset', 'not-private', 'visibility-check-failed']);
  assert.equal(gateEvents()[2].repo, gateEvents()[1].repo, 'the repo did not change between the two refusals');

  // cycle 4: private now -- files, and closes the episode
  run = recordingDeps({ alertCmd: 'fake-alert' });
  const filedRun = await runReportIntake(journalRoot, realConfig(spoReportsDir, { parkAlertCmd: 'fake-alert' }), run.deps);
  assert.equal(filedRun.filed, 1);
  assert.equal(fs.existsSync(reportPath), false);
  assert.equal(alertsOf(run.spawns), 0, 'recovery journals, it does not alert');
  assert.deepEqual(gateEvents().map((e) => e.event), ['report-intake-refused-not-private', 'report-intake-refused-not-private', 'report-intake-refused-not-private', 'report-intake-repo-accepted']);
  assert.equal(gateEvents()[3].repo, REAL_PRIVATE);

  // cycle 5: another passing cycle writes no second acceptance
  writeReport(spoReportsDir, '2026-09-28T11-00-00-000Z_desktop_throttle2.json');
  run = recordingDeps({ alertCmd: 'fake-alert' });
  await runReportIntake(journalRoot, realConfig(spoReportsDir, { parkAlertCmd: 'fake-alert' }), run.deps);
  assert.equal(gateEvents().length, 4);

  // cycle 6: unset again -- the SAME reason as cycle 1, but a new episode, so journalled and alerted afresh
  writeReport(spoReportsDir, '2026-09-28T12-00-00-000Z_desktop_throttle3.json');
  run = recordingDeps({ alertCmd: 'fake-alert' });
  await runReportIntake(journalRoot, realConfig(spoReportsDir, { parkAlertCmd: 'fake-alert', reportIntakeRepo: '' }), run.deps);
  assert.equal(alertsOf(run.spawns), 1);
  assert.equal(gateEvents().length, 5);
  assert.equal(gateEvents()[4].reason, 'unset');
});

// ---- runReportIntake: a private repository -- stage 1 never touches the public one -----------

test('runReportIntake: with a private repo every stage-1 gh spawn names it, none names Crazz-Org/SPO-WebClient, no board:move, and the events carry repo', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-299-private-');
  const journalRoot = mkTmp('spo-reportintake-299-private-journal-');
  writeReport(spoReportsDir, '2026-09-28T10-00-00-000Z_desktop_new.json');
  const { deps, spawns } = recordingDeps();

  const result = await runReportIntake(journalRoot, realConfig(spoReportsDir), deps);

  assert.equal(result.filed, 1);
  const ghSpawns = spawns.filter((sp) => sp.command === 'gh');
  // the gate's GET, the dedup search, the create, the instruction comment
  assert.deepEqual(ghSpawns.map((sp) => sp.args.slice(0, 2).join(' ')), ['api repos/Crazz-Org/SPO-Reports', 'issue list', 'issue create', 'issue comment']);
  for (const sp of ghSpawns) assert.ok(namesRepo(sp, REAL_PRIVATE), `names the private repo: ${sp.args.join(' ')}`);
  for (const sp of spawns) assert.ok(!namesRepo(sp, REAL_PUBLIC), `never names the public repo: ${sp.command} ${sp.args.join(' ')}`);
  assert.ok(!spawns.some((sp) => sp.args.includes('board:move')), 'no board move');
  const create = ghSpawns.find((sp) => sp.args[1] === 'create');
  assert.equal(create.args[create.args.indexOf('--label') + 1], 'report:raw');

  const events = daemonEvents(journalRoot);
  assert.equal(events.find((e) => e.event === 'report-intake').repo, REAL_PRIVATE);
  assert.equal(events.find((e) => e.event === 'report-intake-cycle').repo, REAL_PRIVATE);
  assert.ok(!events.some((e) => e.event === 'report-intake-move-failed'));
  assert.equal(result.results[0].repo, REAL_PRIVATE);
});

test('runReportIntake: a mechanical duplicate comments on the PRIVATE issue and journals repo -- never the public repo', async () => {
  const spoReportsDir = mkTmp('spo-reportintake-299-dup-');
  const journalRoot = mkTmp('spo-reportintake-299-dup-journal-');
  writeReport(spoReportsDir, '2026-09-28T10-00-00-000Z_desktop_dup.json');
  const { deps, spawns } = recordingDeps({ searchHits: [{ number: 3 }] });

  const result = await runReportIntake(journalRoot, realConfig(spoReportsDir), deps);

  assert.equal(result.duplicates, 1);
  const comment = spawns.find((sp) => sp.command === 'gh' && sp.args[1] === 'comment');
  assert.deepEqual(comment.args.slice(0, 5), ['issue', 'comment', '3', '--repo', REAL_PRIVATE]);
  for (const sp of spawns) assert.ok(!namesRepo(sp, REAL_PUBLIC), `${sp.command} ${sp.args.join(' ')}`);
  const dup = daemonEvents(journalRoot).find((e) => e.event === 'report-intake-duplicate');
  assert.equal(dup.repo, REAL_PRIVATE);
  assert.equal(dup.issue, 3);
});

// Done when 8, stage-1/2 half: no code path in report-intake.js hands the raw render to a spawn
// aimed at ghRepo. Behavioural first -- every path a full cycle can take (new card, duplicate,
// create failure, comment failure) plus the confirm scan, with every spawn's argv AND the content
// of every --body-file it names inspected at spawn time -- then a static read of the source as a
// second net for a path no fixture reaches.
test('the raw render never reaches a spawn aimed at ghRepo -- behavioural, over every stage-1 path and the stage-2 scan', async () => {
  const variants = [
    { name: 'new card', opts: {} },
    { name: 'duplicate', opts: { searchHits: [{ number: 3 }] } },
    {
      name: 'create fails',
      opts: { onSpawn: (c, a) => (c === 'gh' && a[1] === 'create' ? { status: 1, stdout: '', stderr: 'boom', signal: null } : null) },
    },
    {
      name: 'comment fails',
      opts: { onSpawn: (c, a) => (c === 'gh' && a[1] === 'comment' ? { status: 1, stdout: '', stderr: 'boom', signal: null } : null) },
    },
  ];
  const renderMarkers = ['SPO_player_x', 'my free text', 'journal payload'];
  const carriesRender = (sp) =>
    sp.args.some((a) => renderMarkers.some((m) => String(a).includes(m))) ||
    sp.bodyFiles.some((b) => b !== null && renderMarkers.some((m) => b.includes(m)));

  let sawRenderOnPrivate = false;
  for (const variant of variants) {
    const spoReportsDir = mkTmp('spo-reportintake-299-leak-');
    const journalRoot = mkTmp('spo-reportintake-299-leak-journal-');
    writeReport(spoReportsDir, '2026-09-28T10-00-00-000Z_desktop_leak.json');
    const { deps, spawns } = recordingDeps(variant.opts);
    await runReportIntake(journalRoot, realConfig(spoReportsDir), deps);

    // then the confirm scan over whatever stage 1 journalled, replying "discard"
    const scanRec = recordingDeps({
      onSpawn: (c, a) => {
        if (c === 'gh' && a[0] === 'api' && String(a[1]).endsWith('/collaborators')) return ok(JSON.stringify([{ login: 'Crazz-E' }]));
        if (c === 'gh' && a[0] === 'api') return ok(JSON.stringify([{ id: 99999, user: { login: 'Crazz-E' }, body: 'discard' }]));
        return null;
      },
    });
    await reportConfirmScan(journalRoot, realConfig(spoReportsDir), scanRec.deps);

    for (const sp of [...spawns, ...scanRec.spawns]) {
      if (namesRepo(sp, REAL_PUBLIC)) {
        assert.ok(!carriesRender(sp), `${variant.name}: a spawn aimed at ${REAL_PUBLIC} carries the raw render: ${sp.args.join(' ')}`);
      }
      if (carriesRender(sp) && namesRepo(sp, REAL_PRIVATE)) sawRenderOnPrivate = true;
    }
  }
  assert.ok(sawRenderOnPrivate, 'the fixture must actually put the render somewhere, or the check above proves nothing');
});

test('the raw render never reaches a spawn aimed at ghRepo -- static: report-intake.js names no ghRepo as a --repo or comment target', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'report-intake.js'), 'utf8')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
  const repoArgs = [...src.matchAll(/'--repo',\s*([A-Za-z_$][\w$.]*)/g)].map((m) => m[1]);
  assert.ok(repoArgs.length >= 3, `expected the search/create/close --repo sites, found ${repoArgs.length}`);
  for (const id of repoArgs) assert.ok(['reportIntakeRepo', 'repo'].includes(id), `a --repo argument is \`${id}\`, not the private repository`);
  assert.ok(!/repos\/\$\{ghRepo\}/.test(src), 'no gh api path built from ghRepo');

  // every intake.postIssueComment call's deps argument is repoDeps (the one with ghRepo overridden)
  const calls = [];
  const re = /intake\.postIssueComment\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const inner = src.slice(m.index + m[0].length, end);
    calls.push(inner.split(',').pop().trim());
  }
  assert.ok(calls.length >= 2, `expected the occurrence and instruction comment sites, found ${calls.length}`);
  for (const last of calls) assert.equal(last, 'repoDeps');
  // and scanForMatch is handed the entry's own repository, never ghRepo
  assert.match(src, /scanForMatch\(\{[\s\S]*?ghRepo: repo,/);
});

// ---- reportConfirmScan: the private repository, and legacy public entries (Done when 2) ------

function scanDeps({ comments = [] } = {}) {
  const spawns = [];
  return {
    spawns,
    deps: {
      spawnSync: (command, args) => {
        spawns.push({ command, args: args.slice(), bodyFiles: [] });
        if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok(JSON.stringify([{ login: 'Crazz-E' }]));
        if (command === 'gh' && args[0] === 'api') return ok(JSON.stringify(comments));
        return ok('');
      },
    },
  };
}

test('reportConfirmScan: comments and collaborators are read from the private repo, confirm carries repo, and nothing touches the public repo', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-299-private-');
  const journalRoot = mkTmp('spo-confirmscan-299-private-journal-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'p.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'p.json', pendingPath, issue: 7, repo: REAL_PRIVATE, commentId: 100 });

  const { deps, spawns } = scanDeps({ comments: [{ id: 101, user: { login: 'Crazz-E' }, body: 'confirm' }] });
  const result = await reportConfirmScan(journalRoot, realConfig(spoReportsDir), deps);

  assert.equal(result.confirmed, 1);
  const paths = spawns.filter((sp) => sp.command === 'gh').map((sp) => String(sp.args[1]));
  assert.ok(paths.some((p) => p === `repos/${REAL_PRIVATE}/collaborators`), paths.join(', '));
  assert.ok(paths.some((p) => p.startsWith(`repos/${REAL_PRIVATE}/issues/7/comments`)), paths.join(', '));
  for (const sp of spawns) assert.ok(!namesRepo(sp, REAL_PUBLIC), sp.args.join(' '));
  const confirmedEvent = daemonEvents(journalRoot).find((e) => e.event === 'report-confirmed');
  assert.equal(confirmedEvent.repo, REAL_PRIVATE);
  assert.equal(confirmedEvent.issue, 7);
});

test('reportConfirmScan: "discard" closes the issue on the private repo and journals repo', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-299-discard-');
  const journalRoot = mkTmp('spo-confirmscan-299-discard-journal-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'd.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'd.json', pendingPath, issue: 8, repo: REAL_PRIVATE, commentId: 100 });

  const { deps, spawns } = scanDeps({ comments: [{ id: 101, user: { login: 'Crazz-E' }, body: 'discard' }] });
  const result = await reportConfirmScan(journalRoot, realConfig(spoReportsDir), deps);

  assert.equal(result.discarded, 1);
  const close = spawns.find((sp) => sp.command === 'gh' && sp.args[0] === 'issue' && sp.args[1] === 'close');
  assert.deepEqual(close.args, ['issue', 'close', '8', '--repo', REAL_PRIVATE, '--reason', 'not planned']);
  for (const sp of spawns) assert.ok(!namesRepo(sp, REAL_PUBLIC), sp.args.join(' '));
  assert.equal(daemonEvents(journalRoot).find((e) => e.event === 'report-discarded').repo, REAL_PRIVATE);
  assert.match(fs.readFileSync(path.join(spoReportsDir, 'archive', 'd.json.disposition.txt'), 'utf8'), /^discarded: Crazz-Org\/SPO-Reports#8 —/);
});

test('reportConfirmScan: a legacy pending event (no repo -- filed publicly before #299) is never scanned, and journalled report-intake-legacy-public exactly once', async () => {
  const spoReportsDir = mkTmp('spo-confirmscan-299-legacy-');
  const journalRoot = mkTmp('spo-confirmscan-299-legacy-journal-');
  const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'l.json');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'l.json', pendingPath, issue: 449, commentId: 100 });

  for (let pass = 0; pass < 2; pass++) {
    const { deps, spawns } = scanDeps({ comments: [{ id: 101, user: { login: 'Crazz-E' }, body: 'confirm' }] });
    const result = await reportConfirmScan(journalRoot, realConfig(spoReportsDir), deps);
    assert.equal(spawns.length, 0, `pass ${pass}: not one gh call for a legacy entry`);
    assert.equal(result.legacy, 1);
    assert.equal(result.confirmed, 0);
  }
  const events = daemonEvents(journalRoot);
  const legacy = events.filter((e) => e.event === 'report-intake-legacy-public');
  assert.equal(legacy.length, 1, 'once per issue, not once per scan');
  assert.equal(legacy[0].issue, 449);
  assert.equal(legacy[0].repo, null);
  assert.equal(legacy[0].reportFile, 'l.json');
  assert.ok(!events.some((e) => e.event === 'report-confirmed'));
  assert.equal(fs.existsSync(pendingPath), true, 'left for the manual cleanup, never archived by the scan');
});

test('reportConfirmScan: a pending event whose repo IS ghRepo (any case) is treated as legacy too, never scanned', async () => {
  const journalRoot = mkTmp('spo-confirmscan-299-legacy-ghrepo-');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'g.json', pendingPath: '/x/g', issue: 12, repo: 'crazz-org/spo-webclient', commentId: 1 });
  const { deps, spawns } = scanDeps();
  const result = await reportConfirmScan(journalRoot, realConfig(mkTmp('spo-confirmscan-299-lg-')), deps);
  assert.equal(spawns.length, 0);
  assert.equal(result.legacy, 1);
  assert.equal(daemonEvents(journalRoot).filter((e) => e.event === 'report-intake-legacy-public').length, 1);
});

test('reportConfirmScan: an entry filed on a previous reportIntakeRepo is scanned where it was filed, not on the current setting -- and still scanned while the current setting is unset', async () => {
  for (const current of ['Crazz-Org/SPO-Reports-2', '']) {
    const spoReportsDir = mkTmp('spo-confirmscan-299-moved-');
    const journalRoot = mkTmp('spo-confirmscan-299-moved-journal-');
    const pendingPath = writeReport(path.join(spoReportsDir, 'pending'), 'm.json');
    appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'm.json', pendingPath, issue: 5, repo: REAL_PRIVATE, commentId: 100 });

    const { deps, spawns } = scanDeps({ comments: [{ id: 101, user: { login: 'Crazz-E' }, body: 'discard' }] });
    const result = await reportConfirmScan(journalRoot, realConfig(spoReportsDir, { reportIntakeRepo: current }), deps);

    assert.equal(result.discarded, 1, `current setting ${JSON.stringify(current)}`);
    for (const sp of spawns) {
      assert.ok(namesRepo(sp, REAL_PRIVATE), `every call follows the event's own repo: ${sp.args.join(' ')}`);
      if (current) assert.ok(!namesRepo(sp, current), sp.args.join(' '));
    }
  }
});

test('findPendingIntake: an issue number is matched with its repository -- a confirm on another repo, or a legacy one, does not resolve it', () => {
  const journalRoot = mkTmp('spo-confirmscan-299-find-');
  appendDaemonEvent(journalRoot, 'report-intake', { reportFile: 'a.json', pendingPath: '/x/a', issue: 12, repo: REAL_PRIVATE, commentId: 1 });
  appendDaemonEvent(journalRoot, 'report-confirmed', { issue: 12, pendingPath: '/x/other', commentId: 2 }); // legacy public #12
  appendDaemonEvent(journalRoot, 'report-discarded', { issue: 12, repo: 'Crazz-Org/Elsewhere', discardCommentId: 3 });
  assert.deepEqual(findPendingIntake(journalRoot).map((e) => [e.repo, e.issue]), [[REAL_PRIVATE, 12]]);

  appendDaemonEvent(journalRoot, 'report-confirmed', { issue: 12, repo: 'crazz-org/spo-reports', pendingPath: '/x/a', commentId: 4 });
  assert.deepEqual(findPendingIntake(journalRoot), [], 'the same repository, any case, resolves it');
});
