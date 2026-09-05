'use strict';
// Project-2 card #476 -- "The unpark scan failed 238 times over 33 hours and left no evidence of
// why, and no evidence of recovering either."
//
// The card's two halves, and one gap its own re-verification added, each with a test that fails
// on the pre-#476 behaviour:
//
//   1. A FAILURE RECORDED NO REASON. `unpark-scan-failed` carried `{exit, timedOut}` and nothing
//      else, because comment-scan.js dropped `gh`'s stderr on the floor. 238 events, every one of
//      them "a gh process exited non-zero", and which process and why is unrecoverable.
//   2. A SUCCESS RECORDED NOTHING AT ALL. A clean scan just `continue`d, so a healthy channel and
//      a dead one both leave the same trace (an old failure streak, or silence) and "is the retry
//      channel alive" was only ever answerable from an ABSENCE of failures.
//   3. NO SURFACE WITH NOTHING PARKED, AND NONE ON THE DASHBOARD. The per-card health line renders
//      inside `spo status`'s PARKED branch only, and console/collect.js had no unpark reader at all.
//
// The bound that makes half 2 legitimate rather than a re-litigation of the removed heartbeat
// (SPO-WebClient PR #444) is tested here too: a healthy scan that has already said so must write
// NOTHING on every subsequent cycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('./no-real-spawn');
const { unparkScan } = require('../orchestrator/park-loop');
const commentScan = require('../orchestrator/comment-scan');
const retryChannel = require('../orchestrator/retry-channel');
const { writeState, appendEvent } = require('../orchestrator/journal');
const { collectJournalTasks, collectServices, applyRetryChannelStats } = require('../console/collect');
const { renderDashboard } = require('../console/render');
const { runSpo } = require('./helpers');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function parkedTaskDir(journalRoot, id, { issue, commentId }) {
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id, kind: 'card', issue, title: 'x', criterion: 'y', size: 'S' })
  );
  writeState(taskDir, { id, state: 'PARKED', reason: 'worktree-npm-ci-failed' });
  appendEvent(taskDir, 'WORKTREE', 'parked', { reason: 'worktree-npm-ci-failed' });
  appendEvent(taskDir, 'PARKED', 'park-comment', { commentId, reason: 'worktree-npm-ci-failed' });
  return taskDir;
}

// A scan whose comments fetch answers cleanly and matches nothing -- the ordinary, healthy cycle
// that used to journal absolutely nothing.
function healthyDeps() {
  return {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      if (command === 'gh' && args[0] === 'api') return ok(JSON.stringify([]));
      return ok('');
    },
  };
}

const CONFIG = { ghRepo: 'Crazz-Org/SPO-WebClient', commandTimeoutsMs: { gh: 120000 } };

// ---- half 1: a failure names its cause -------------------------------------------------------

test('half 1: unpark-scan-failed carries gh\'s own first stderr line, not just {exit, timedOut}', async () => {
  const queueDir = mkTmp('spo-476-q-stderr-');
  const journalRoot = mkTmp('spo-476-j-stderr-');
  const taskDir = parkedTaskDir(journalRoot, 'card-476', { issue: 476, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      return {
        status: 1,
        stdout: '',
        // The real shape: a diagnosis on line 1, a documentation URL after it.
        stderr: 'gh: HTTP 401: Bad credentials (https://api.github.com/repos/x/issues/476/comments)\nTry authenticating with: gh auth login\n',
        signal: null,
      };
    },
  };

  await unparkScan(queueDir, journalRoot, CONFIG, deps);

  const failed = readJournal(taskDir).find((e) => e.event === 'unpark-scan-failed');
  assert.ok(failed, 'the failure is still journalled');
  assert.equal(failed.exit, 1, 'the pre-#476 fields are unchanged');
  assert.equal(failed.timedOut, false);
  assert.equal(
    failed.stderr,
    'gh: HTTP 401: Bad credentials (https://api.github.com/repos/x/issues/476/comments)',
    'the FIRST line only -- enough to name the cause, without spooling the whole of gh\'s output into an append-only journal once per failing cycle'
  );
});

test('half 1: a very long stderr line is capped and marked, never written whole', () => {
  const long = `x${'y'.repeat(5000)}`;
  const capped = commentScan.firstStderrLine({ stderr: long });
  assert.ok(capped.length < 400, `expected a capped line, got ${capped.length} chars`);
  assert.ok(capped.endsWith('... (truncated)'), 'a cut line must never read as a complete one');
});

test('half 1: firstStderrLine skips leading blank lines, and reports absence as null rather than an empty string', () => {
  assert.equal(commentScan.firstStderrLine({ stderr: '\n\n  warning: something\nmore\n' }), 'warning: something');
  assert.equal(commentScan.firstStderrLine({ stderr: '' }), null);
  assert.equal(commentScan.firstStderrLine({}), null);
  assert.equal(commentScan.firstStderrLine(null), null);
  // A stubbed spawnSync that forgot `encoding: 'utf8'` hands back a Buffer. A helper whose whole
  // job is reporting a failure must not itself throw on one.
  assert.equal(commentScan.firstStderrLine({ stderr: Buffer.from('boom: nope\n') }), 'boom: nope');
});

test('half 1: an unparsable (exit 0) reply reports no stderr at all -- an honest absence, not a missing capture', async () => {
  const queueDir = mkTmp('spo-476-q-unparsable-');
  const journalRoot = mkTmp('spo-476-j-unparsable-');
  const taskDir = parkedTaskDir(journalRoot, 'card-477', { issue: 477, commentId: 100 });

  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      return { status: 0, stdout: '<html>not json</html>', stderr: '', signal: null };
    },
  };

  await unparkScan(queueDir, journalRoot, CONFIG, deps);

  const failed = readJournal(taskDir).find((e) => e.event === 'unpark-scan-failed');
  assert.equal(failed.reason, 'unparsable-comments');
  assert.ok(!('stderr' in failed), 'no stderr key at all -- gh exited 0 and said nothing');
});

// ---- half 2: a success is recorded, once, when it changes ------------------------------------

test('half 2: the first successful scan of a park cycle journals unpark-scan-ok', async () => {
  const queueDir = mkTmp('spo-476-q-ok-');
  const journalRoot = mkTmp('spo-476-j-ok-');
  const taskDir = parkedTaskDir(journalRoot, 'card-478', { issue: 478, commentId: 100 });

  await unparkScan(queueDir, journalRoot, CONFIG, healthyDeps());

  const events = readJournal(taskDir).filter((e) => e.event === 'unpark-scan-ok');
  assert.equal(events.length, 1, 'a clean scan used to journal nothing at all -- this is card #476 half 2');
  assert.equal(events[0].afterFailures, 0, 'nothing to recover from: this is the cycle\'s first proof of life');
});

test('half 2: it is EDGE-triggered -- five more healthy cycles journal nothing, so this never becomes the heartbeat PR #444 removed', async () => {
  const queueDir = mkTmp('spo-476-q-edge-');
  const journalRoot = mkTmp('spo-476-j-edge-');
  const taskDir = parkedTaskDir(journalRoot, 'card-479', { issue: 479, commentId: 100 });

  for (let i = 0; i < 6; i++) {
    // A fresh scanState per cycle: the daemon keeps ONE across cycles, but a restart resets it,
    // and the whole point of reading the journal rather than in-memory state is that the answer
    // must survive that. This fixture is the harsher of the two.
    await unparkScan(queueDir, journalRoot, CONFIG, healthyDeps(), commentScan.createScanState());
  }

  const journal = readJournal(taskDir);
  assert.equal(
    journal.filter((e) => e.event === 'unpark-scan-ok').length,
    1,
    'six healthy cycles, one line -- a per-cycle event is exactly what the card forbids'
  );
  // And the guard is not "we only ever append one thing": the park fixture's own lines are still
  // there, so an assertion that passed by writing nothing at all would be visible here.
  assert.ok(journal.some((e) => e.event === 'park-comment'), 'fixture precondition');
});

test('half 2: a scan that succeeds AFTER a failure streak journals the recovery, and names the streak it ends', async () => {
  const queueDir = mkTmp('spo-476-q-recover-');
  const journalRoot = mkTmp('spo-476-j-recover-');
  const taskDir = parkedTaskDir(journalRoot, 'card-480', { issue: 480, commentId: 100 });
  // The live shape: failures, interleaved with the backoff skips they cause.
  appendEvent(taskDir, 'PARKED', 'unpark-scan-failed', { exit: 1, timedOut: false });
  appendEvent(taskDir, 'PARKED', 'unpark-scan-backoff-skip', { failures: 1 });
  appendEvent(taskDir, 'PARKED', 'unpark-scan-failed', { exit: 1, timedOut: false });

  await unparkScan(queueDir, journalRoot, CONFIG, healthyDeps());

  const okEvents = readJournal(taskDir).filter((e) => e.event === 'unpark-scan-ok');
  assert.equal(okEvents.length, 1);
  assert.equal(okEvents[0].afterFailures, 2, 'the recovery carries the size of the outage it ends');
  assert.ok(okEvents[0].firstFailedAt, 'and dates it, so "broken for 33 hours" is recoverable from this one line');
});

test('half 2: a scan that already journalled its own positive evidence does NOT also write unpark-scan-ok', async () => {
  // `unpark-scan-truncated` and `unpark-scan-ignored-author` already prove gh answered. Writing a
  // second line saying the same thing, every cycle, for as long as the condition holds, is the
  // per-cycle heartbeat by another name.
  const queueDir = mkTmp('spo-476-q-trunc-');
  const journalRoot = mkTmp('spo-476-j-trunc-');
  const taskDir = parkedTaskDir(journalRoot, 'card-481', { issue: 481, commentId: 100 });

  const full = JSON.stringify(
    Array.from({ length: commentScan.PER_PAGE }, (_, i) => ({
      id: 1000 + i,
      user: { login: 'nobody' },
      created_at: '2026-08-29T00:00:00Z',
      body: 'chatter',
    }))
  );
  const deps = {
    spawnSync: (command, args) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/collaborators')) {
        return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      }
      return ok(full); // every page comes back full -> the scan hits maxPages and truncates
    },
  };

  await unparkScan(queueDir, journalRoot, { ...CONFIG, commentScanMaxPages: 2 }, deps);

  const journal = readJournal(taskDir);
  assert.ok(journal.some((e) => e.event === 'unpark-scan-truncated'), 'fixture precondition: the scan truncated');
  assert.equal(journal.filter((e) => e.event === 'unpark-scan-ok').length, 0, 'the outcome is already on record');
});

test('half 2: a fresh park after a recovery starts over -- the previous cycle\'s unpark-scan-ok does not silence the new one', async () => {
  const queueDir = mkTmp('spo-476-q-repark-');
  const journalRoot = mkTmp('spo-476-j-repark-');
  const taskDir = parkedTaskDir(journalRoot, 'card-482', { issue: 482, commentId: 100 });

  await unparkScan(queueDir, journalRoot, CONFIG, healthyDeps());
  // The card was retried, ran, and parked again -- a new park cycle, whose channel nothing has
  // proven anything about yet.
  appendEvent(taskDir, 'PARKED', 'unparked-by-maintainer', { retryCommentId: 200 });
  appendEvent(taskDir, 'WORKTREE', 'parked', { reason: 'gate-failed' });
  appendEvent(taskDir, 'PARKED', 'park-comment', { commentId: 300, reason: 'gate-failed' });

  await unparkScan(queueDir, journalRoot, CONFIG, healthyDeps());

  assert.equal(
    readJournal(taskDir).filter((e) => e.event === 'unpark-scan-ok').length,
    2,
    'one per park cycle -- a park that ends the walk must also end the "already said so" silence'
  );
});

// ---- the rule itself, and writer/reader agreement --------------------------------------------

test('the writer\'s event name is in the readers\' break set -- a drift makes the event repeat every cycle', () => {
  // park-loop.js writes the name as a literal (test/park-reason-doc-sweep.test.js resolves event
  // names out of the source), so this pins the two halves together. The behavioural half is the
  // edge-triggered test above; this one names the failure mode when it breaks.
  assert.ok(
    retryChannel.UNPARK_SCAN_SUCCESS_EVENTS.has(retryChannel.UNPARK_SCAN_OK_EVENT),
    'retry-channel.js must break on the very event park-loop.js writes'
  );
  const parkLoopSrc = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'park-loop.js'), 'utf8');
  assert.ok(
    parkLoopSrc.includes(`appendEvent(taskDir, 'PARKED', '${retryChannel.UNPARK_SCAN_OK_EVENT}'`),
    `park-loop.js no longer writes '${retryChannel.UNPARK_SCAN_OK_EVENT}' -- writer and reader have drifted apart`
  );
});

test('summarizeUnparkScanTail: healthySince is withheld while failures stand on top of it', () => {
  const withFailuresAfter = retryChannel.summarizeUnparkScanTail([
    { ts: '2026-08-30T09:00:00.000Z', event: 'parked' },
    { ts: '2026-08-30T10:00:00.000Z', event: 'unpark-scan-ok' },
    { ts: '2026-08-30T11:00:00.000Z', event: 'unpark-scan-failed' },
  ]);
  assert.equal(withFailuresAfter.count, 1);
  assert.equal(
    withFailuresAfter.healthySince,
    null,
    'a channel that was healthy and has since broken must not report the old all-clear'
  );

  const healthy = retryChannel.summarizeUnparkScanTail([
    { ts: '2026-08-30T09:00:00.000Z', event: 'parked' },
    { ts: '2026-08-30T10:00:00.000Z', event: 'unpark-scan-failed' },
    { ts: '2026-08-30T11:00:00.000Z', event: 'unpark-scan-ok' },
  ]);
  assert.equal(healthy.count, 0);
  assert.equal(healthy.healthySince, '2026-08-30T11:00:00.000Z');
});

test('summarizeUnparkScanTail: the two measured traps stay closed -- a backoff-skip and an unrelated event neither break nor clear the streak', () => {
  // The real tail of journal/issue-213, in miniature. Breaking on either of these reported a
  // 33-hour outage as one minute of trouble, or as an all-clear.
  const s = retryChannel.summarizeUnparkScanTail([
    { ts: '2026-08-29T21:08:09.000Z', event: 'park-comment' },
    { ts: '2026-08-30T10:11:23.997Z', event: 'unpark-scan-failed' },
    { ts: '2026-08-31T19:50:01.000Z', event: 'unpark-scan-backoff-skip' },
    { ts: '2026-08-31T19:52:07.585Z', event: 'unpark-scan-failed' },
    { ts: '2026-09-01T11:37:59.785Z', event: 'reconciled-externally' },
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.firstFailedAt, '2026-08-30T10:11:23.997Z');
  assert.equal(s.lastFailedAt, '2026-08-31T19:52:07.585Z');
  assert.equal(s.healthySince, null);
});

test('shouldJournalScanOk: true on a standing streak and on a cycle with nothing recorded, false once healthy is on record', () => {
  assert.equal(retryChannel.shouldJournalScanOk({ count: 2, healthySince: null }), true);
  assert.equal(retryChannel.shouldJournalScanOk({ count: 0, healthySince: null }), true);
  assert.equal(retryChannel.shouldJournalScanOk({ count: 0, healthySince: '2026-08-30T11:00:00.000Z' }), false);
});

// ---- gap 3: the surfaces ---------------------------------------------------------------------

function journalTaskFixture(journalRoot, id, { state = 'PARKED', events }) {
  const dir = path.join(journalRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id, kind: 'card', issue: 1, title: 'x' }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id, state, reason: 'gate-failed' }));
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

function tileFor(journalRoot, now) {
  const tasks = collectJournalTasks(journalRoot);
  return applyRetryChannelStats(collectServices({ journalRoot }), tasks, now).retryChannel;
}

test('dashboard: with nothing parked the tile says IDLE -- a tile that vanished would look like a broken collector', () => {
  const journalRoot = mkTmp('spo-476-dash-idle-');
  journalTaskFixture(journalRoot, 'issue-1', { state: 'DONE', events: [{ ts: '2026-09-01T00:00:00.000Z', event: 'done' }] });

  const rc = tileFor(journalRoot, Date.parse('2026-09-01T12:00:00.000Z'));
  assert.equal(rc.status, 'idle');
  assert.equal(rc.parkedCards, 0);
  assert.match(renderDashboard({ services: { retryChannel: rc } }, { view: 'health' }), /Retry channel/);
  assert.match(renderDashboard({ services: { retryChannel: rc } }, { view: 'health' }), /IDLE/);
});

test('dashboard: parked cards with no recorded scan outcome read UNPROVEN, never a reassuring green', () => {
  const journalRoot = mkTmp('spo-476-dash-unproven-');
  journalTaskFixture(journalRoot, 'issue-2', {
    events: [{ ts: '2026-09-01T00:00:00.000Z', event: 'parked' }, { ts: '2026-09-01T00:01:00.000Z', event: 'park-comment' }],
  });

  const rc = tileFor(journalRoot, Date.parse('2026-09-01T12:00:00.000Z'));
  assert.equal(rc.status, 'unknown');
  assert.equal(rc.unprovenCards, 1);
  const html = renderDashboard({ services: { retryChannel: rc } }, { view: 'health' });
  assert.match(html, /UNPROVEN/);
  assert.doesNotMatch(html, /ALIVE/);
});

test('dashboard: a standing failure streak reads FAILING and outranks a healthy sibling card', () => {
  const journalRoot = mkTmp('spo-476-dash-fail-');
  journalTaskFixture(journalRoot, 'issue-213', {
    events: [
      { ts: '2026-08-30T09:00:00.000Z', event: 'parked' },
      { ts: '2026-08-30T10:11:23.000Z', event: 'unpark-scan-failed', exit: 1 },
      { ts: '2026-08-31T19:52:07.000Z', event: 'unpark-scan-failed', exit: 1 },
    ],
  });
  journalTaskFixture(journalRoot, 'issue-385', {
    events: [
      { ts: '2026-08-30T09:00:00.000Z', event: 'parked' },
      { ts: '2026-09-01T08:00:00.000Z', event: 'unpark-scan-ok', afterFailures: 0 },
    ],
  });

  const rc = tileFor(journalRoot, Date.parse('2026-09-01T12:00:00.000Z'));
  assert.equal(rc.status, 'fail', 'a real outage is never softened by a sibling card that is fine');
  assert.equal(rc.parkedCards, 2);
  assert.equal(rc.failingCards, 1);
  assert.equal(rc.healthyCards, 1);
  assert.equal(rc.worstFailures, 2);
  assert.equal(rc.lastFailedAt, '2026-08-31T19:52:07.000Z');
  assert.equal(rc.lastFailedAgeMs, Date.parse('2026-09-01T12:00:00.000Z') - Date.parse('2026-08-31T19:52:07.000Z'));
  assert.match(renderDashboard({ services: { retryChannel: rc } }, { view: 'health' }), /FAILING/);
});

test('dashboard: every parked card confirmed reaching GitHub reads ALIVE', () => {
  const journalRoot = mkTmp('spo-476-dash-ok-');
  journalTaskFixture(journalRoot, 'issue-3', {
    events: [
      { ts: '2026-08-30T09:00:00.000Z', event: 'parked' },
      { ts: '2026-09-01T08:00:00.000Z', event: 'unpark-scan-ok', afterFailures: 3 },
    ],
  });

  const rc = tileFor(journalRoot, Date.parse('2026-09-01T12:00:00.000Z'));
  assert.equal(rc.status, 'ok');
  assert.equal(rc.healthyCards, 1);
  assert.equal(rc.failingCards, 0);
  assert.match(renderDashboard({ services: { retryChannel: rc } }, { view: 'health' }), /ALIVE/);
});

test('dashboard: a non-PARKED task contributes nothing -- the scan never looked at it', () => {
  const journalRoot = mkTmp('spo-476-dash-active-');
  journalTaskFixture(journalRoot, 'issue-4', {
    state: 'IMPLEMENT',
    // Failures from a PREVIOUS park, still in the journal after a retry. The card is running now;
    // describing its retry channel as broken would be a claim about a scanner that is not scanning it.
    events: [
      { ts: '2026-08-30T09:00:00.000Z', event: 'parked' },
      { ts: '2026-08-30T10:00:00.000Z', event: 'unpark-scan-failed', exit: 1 },
    ],
  });

  const tasks = collectJournalTasks(journalRoot);
  assert.equal(tasks[0].retryChannel, null);
  const rc = tileFor(journalRoot, Date.parse('2026-09-01T12:00:00.000Z'));
  assert.equal(rc.status, 'idle');
});

// ---- gap 3, the other half: `spo status` when nothing is parked ------------------------------

test('spo status: with nothing parked, the retry channel says IDLE instead of disappearing', () => {
  const journalRoot = mkTmp('spo-476-status-idle-');
  journalTaskFixture(journalRoot, 'issue-5', { state: 'DONE', events: [{ ts: '2026-09-01T00:00:00.000Z', event: 'done' }] });

  const out = runSpo(['status', '--journal', journalRoot, '--queue', mkTmp('spo-476-status-idle-q-')]);
  assert.match(out, /retry-channel: idle -- nothing parked/);
});

test('spo status: with a card parked, the idle line is gone and the per-card line is the surface', () => {
  const journalRoot = mkTmp('spo-476-status-parked-');
  journalTaskFixture(journalRoot, 'issue-6', {
    events: [
      { ts: '2026-08-30T09:00:00.000Z', event: 'parked' },
      { ts: '2026-09-01T08:00:00.000Z', event: 'unpark-scan-ok', afterFailures: 0 },
    ],
  });

  const out = runSpo(['status', '--journal', journalRoot, '--queue', mkTmp('spo-476-status-parked-q-')]);
  assert.doesNotMatch(out, /retry-channel: idle/, 'the summary line is only for the no-parked-cards case');
  assert.match(out, /issue-6\s+PARKED\s+reason=gate-failed\s+retry-channel: healthy, last confirmed .+ ago \(2026-09-01T08:00:00\.000Z\)/);
});
