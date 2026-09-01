'use strict';
// Tests for orchestrator/comment-scan.js -- action 2.7's shared core behind park-loop.js's
// unparkScan and report-intake.js's reportConfirmScan. Exercises the three primitives directly
// (pagination/bound, collaborator allowlist/cache/fail-open, per-issue backoff) plus the
// composed scanForMatch entry point. Integration-level regression coverage (both callers keep
// their pre-2.7 behaviour, a page-2-of-3 reply is found end to end) lives in
// test/park-loop.test.js and test/report-intake.test.js instead, next to each caller's own
// existing fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const {
  createScanState,
  scanForMatch,
  fetchCommentsAfterAnchor,
  getCollaborators,
  isAuthorized,
  checkBackoff,
  recordFailure,
  recordSuccess,
  PER_PAGE,
} = require('../orchestrator/comment-scan');
const { timeoutResult } = require('./helpers');

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

function comment(id, overrides = {}) {
  return { id, body: 'chatter', created_at: '2026-08-29T00:00:00Z', ...overrides };
}

function fullPage(startId, count = PER_PAGE) {
  return Array.from({ length: count }, (_, i) => comment(startId + i));
}

// ---- fetchCommentsAfterAnchor: pagination + bound ---------------------------------------------

test('fetchCommentsAfterAnchor: a single short page is the common case -- one gh call, not truncated', () => {
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push(args);
      return ok(JSON.stringify([comment(10), comment(20, { body: 'retry' })]));
    },
  };

  const result = fetchCommentsAfterAnchor({ deps, config: {}, ghRepo: 'x/y', issue: 1, anchorId: 5 });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    result.comments.map((c) => c.id),
    [10, 20]
  );
});

test('fetchCommentsAfterAnchor: a reply on page 2 of 3 is found -- the bug this action fixes', () => {
  // Page 1: 100 old comments, all at/under the anchor -- none qualify. Page 2: a full page
  // straddling the anchor, including the maintainer's reply. Page 3: a short (< 100) page,
  // ending the scan naturally.
  const anchorId = 500;
  const page1 = fullPage(1, 100); // ids 1..100
  const page2 = fullPage(501, 100); // ids 501..600, includes the reply
  page2[49].body = 'retry -- fixed the lockfile'; // id 550
  const page3 = fullPage(601, 50); // ids 601..650, short page -> natural end

  const pagesSeen = [];
  const deps = {
    spawnSync: (command, args) => {
      const pageArg = pageParamOf(args);
      const page = Number(pageArg);
      pagesSeen.push(page);
      if (page === 1) return ok(JSON.stringify(page1));
      if (page === 2) return ok(JSON.stringify(page2));
      return ok(JSON.stringify(page3));
    },
  };

  const result = fetchCommentsAfterAnchor({ deps, config: {}, ghRepo: 'x/y', issue: 1, anchorId });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(pagesSeen, [1, 2, 3]);
  const reply = result.comments.find((c) => c.id === 550);
  assert.ok(reply, 'the page-2 reply must be present in the collected comments');
  assert.equal(result.comments.length, 150); // 100 (page2, all > 500) + 50 (page3)
});

test('fetchCommentsAfterAnchor: the page bound is respected, and hitting it is distinguishable from "no reply"', () => {
  // Two full pages exist; maxPages caps the scan at 1, before the page-2 reply is ever fetched.
  const page1 = fullPage(1, 100);
  const page2 = fullPage(101, 100);
  page2[0].body = 'retry'; // id 101 -- never reached

  const deps = {
    spawnSync: (command, args) => {
      const page = Number(pageParamOf(args));
      return ok(JSON.stringify(page === 1 ? page1 : page2));
    },
  };

  const result = fetchCommentsAfterAnchor({ deps, config: {}, ghRepo: 'x/y', issue: 1, anchorId: 0, maxPages: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true, 'hitting the bound must set truncated, not look like "no reply"');
  assert.equal(result.pagesScanned, 1);
  assert.ok(
    !result.comments.some((c) => c.body === 'retry'),
    'the reply sits on the page never fetched -- it must not appear as if it were seen and rejected'
  );
});

test('fetchCommentsAfterAnchor: a failing gh call is reported, not silently empty', () => {
  const deps = { spawnSync: () => ({ status: 1, stdout: '', stderr: 'boom', signal: null }) };
  const result = fetchCommentsAfterAnchor({ deps, config: {}, ghRepo: 'x/y', issue: 1, anchorId: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gh-failed');
  assert.equal(result.exit, 1);
});

test('fetchCommentsAfterAnchor: a timed-out gh call carries timedOut through', () => {
  const deps = { spawnSync: () => timeoutResult() };
  const result = fetchCommentsAfterAnchor({ deps, config: { commandTimeoutsMs: { gh: 1000 } }, ghRepo: 'x/y', issue: 1, anchorId: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gh-failed');
  assert.equal(result.timedOut, true);
});

test('fetchCommentsAfterAnchor: unparsable JSON is its own distinct reason', () => {
  const deps = { spawnSync: () => ok('not json') };
  const result = fetchCommentsAfterAnchor({ deps, config: {}, ghRepo: 'x/y', issue: 1, anchorId: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unparsable');
});

// ---- collaborators: cache, fail-open, stale ----------------------------------------------------

test('getCollaborators: a successful read is cached -- a second call for the same repo makes no new gh call', () => {
  let calls = 0;
  const deps = { spawnSync: () => { calls++; return ok(JSON.stringify([{ login: 'Crazz' }, { login: 'bot-account' }])); } };
  const scanState = createScanState();

  const first = getCollaborators(deps, {}, 'x/y', scanState, '/tmp/does-not-matter', 'unpark', 1000);
  const second = getCollaborators(deps, {}, 'x/y', scanState, '/tmp/does-not-matter', 'unpark', 2000);

  assert.equal(calls, 1);
  assert.equal(first.ok, true);
  assert.equal(first.failOpen, false);
  assert.ok(first.logins.has('crazz'), 'logins are lowercased for case-insensitive comparison');
  assert.strictEqual(first, second, 'the cached entry object is reused, not re-fetched');
});

test('getCollaborators: never-successfully-read fails OPEN and journals it', () => {
  const mkTmp = require('./helpers').mkTmp;
  const journalRoot = mkTmp('spo-commentscan-collab-open-');
  const deps = { spawnSync: () => ({ status: 1, stdout: '', stderr: '', signal: null }) };
  const scanState = createScanState();

  const entry = getCollaborators(deps, {}, 'x/y', scanState, journalRoot, 'unpark', 1000);

  assert.equal(entry.failOpen, true);
  assert.equal(entry.logins, null);
  const fs = require('fs');
  const path = require('path');
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"comment-scan-collaborators-unreadable"/);
  assert.match(daemonLog, /"scanner":"unpark"/);
});

test('getCollaborators: a stale-but-previously-good list is reused (not fail-open) when a refresh fails, and journalled as stale', () => {
  const mkTmp = require('./helpers').mkTmp;
  const journalRoot = mkTmp('spo-commentscan-collab-stale-');
  let succeed = true;
  const deps = {
    spawnSync: () => (succeed ? ok(JSON.stringify([{ login: 'maintainer' }])) : { status: 1, stdout: '', stderr: '', signal: null }),
  };
  const scanState = createScanState();

  const good = getCollaborators(deps, {}, 'x/y', scanState, journalRoot, 'unpark', 1000);
  assert.equal(good.ok, true);

  succeed = false; // simulate the refresh window failing
  const stale = getCollaborators(deps, {}, 'x/y', scanState, journalRoot, 'unpark', 1000 + 61 * 60 * 1000); // past the 1h OK TTL, so a refresh is attempted

  assert.equal(stale.failOpen, false, 'a known-good list must not suddenly open the gate on a transient failure');
  assert.ok(stale.logins.has('maintainer'));
  const fs = require('fs');
  const path = require('path');
  const daemonLog = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  assert.match(daemonLog, /"event":"comment-scan-collaborators-stale"/);
});

test('isAuthorized: a collaborator is authorized, a non-collaborator is not, and an AUTHORLESS comment is not', () => {
  const collab = { ok: true, failOpen: false, logins: new Set(['maintainer']) };
  assert.equal(isAuthorized(collab, comment(1, { user: { login: 'maintainer' } })), true);
  assert.equal(isAuthorized(collab, comment(2, { user: { login: 'Maintainer' } })), true, 'case-insensitive');
  assert.equal(isAuthorized(collab, comment(3, { user: { login: 'rando' } })), false);

  // The distinction that makes the allowlist worth having: we fail open on our OWN inability to
  // check (below), never on the input failing to identify itself. GitHub emits a null user for a
  // deleted account, and an allowlist any payload can bypass by omitting a field is decorative.
  assert.equal(isAuthorized(collab, comment(4)), false, 'no user at all');
  assert.equal(isAuthorized(collab, comment(5, { user: null })), false, 'ghost (deleted) account');
  assert.equal(isAuthorized(collab, comment(6, { user: {} })), false, 'user object with no login');
  assert.equal(isAuthorized(collab, comment(7, { user: { login: 42 } })), false, 'login not a string');
});

test('isAuthorized: fail-open authorizes a known login, but still not an authorless comment', () => {
  const collab = { ok: false, failOpen: true, logins: null };
  assert.equal(isAuthorized(collab, comment(1, { user: { login: 'rando' } })), true);
  assert.equal(isAuthorized(collab, comment(2)), false, 'fail-open covers our blindness, not anonymity');
});

// ---- backoff -----------------------------------------------------------------------------------

test('checkBackoff/recordFailure/recordSuccess: the first failure never backs off, the second does, and a success resets it', () => {
  const scanState = createScanState();

  assert.equal(checkBackoff(scanState, 'x/y', 1, 1000).skip, false);
  recordFailure(scanState, 'x/y', 1, 1000);
  assert.equal(checkBackoff(scanState, 'x/y', 1, 1000).skip, false, 'one failure alone must not skip the very next cycle');

  recordFailure(scanState, 'x/y', 1, 1000);
  const afterSecond = checkBackoff(scanState, 'x/y', 1, 1000);
  assert.equal(afterSecond.skip, true, 'a second consecutive failure backs off');

  const past = checkBackoff(scanState, 'x/y', 1, afterSecond.nextAttemptAt + 1);
  assert.equal(past.skip, false, 'once the backoff window elapses, it is no longer skipped');

  recordSuccess(scanState, 'x/y', 1);
  recordFailure(scanState, 'x/y', 1, 5000);
  assert.equal(checkBackoff(scanState, 'x/y', 1, 5000).skip, false, 'a success resets the failure count back to zero');
});

test('backoff is keyed per (repo, issue) -- one issue backing off never affects another', () => {
  const scanState = createScanState();
  recordFailure(scanState, 'x/y', 1, 1000);
  recordFailure(scanState, 'x/y', 1, 1000);
  assert.equal(checkBackoff(scanState, 'x/y', 1, 1000).skip, true);
  assert.equal(checkBackoff(scanState, 'x/y', 2, 1000).skip, false, 'a different issue in the same repo is unaffected');
});

// ---- scanForMatch: the composed entry point ----------------------------------------------------

test('scanForMatch: an authorized match wins; an unauthorized match earlier in the thread is skipped AND journalled as ignored', async () => {
  const comments = [
    comment(101, { body: 'retry', user: { login: 'rando' } }), // unauthorized -- must be ignored
    comment(102, { body: 'retry -- fixed it', user: { login: 'maintainer' } }), // authorized -- wins
  ];
  const deps = {
    spawnSync: (command, args) => {
      if (args[0] === 'api' && args[1].endsWith('/collaborators')) return ok(JSON.stringify([{ login: 'maintainer' }]));
      return ok(JSON.stringify(comments));
    },
  };
  const journalled = [];
  const scanState = createScanState();

  const result = await scanForMatch({
    deps,
    config: {},
    ghRepo: 'x/y',
    issue: 9,
    anchorId: 0,
    patterns: [{ name: 'retry', re: /^retry\b/i }],
    scanState,
    journalRoot: '/tmp/does-not-matter',
    journal: (event, detail) => journalled.push({ event, detail }),
    events: { truncated: 'x-truncated', ignoredAuthor: 'x-ignored', backoffSkip: 'x-backoff' },
    scannerKey: 'unpark',
    now: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.match.comment.id, 102, 'the unauthorized match must not win even though it comes first');
  assert.ok(journalled.some((j) => j.event === 'x-ignored' && j.detail.commentId === 101 && j.detail.author === 'rando'));
});

test('scanForMatch: a backed-off issue is skipped without any gh call, and the skip is journalled', async () => {
  let calls = 0;
  const deps = { spawnSync: () => { calls++; return { status: 1, stdout: '', stderr: '', signal: null }; } };
  const scanState = createScanState();
  const journalled = [];
  const common = {
    deps,
    config: {},
    ghRepo: 'x/y',
    issue: 9,
    anchorId: 0,
    patterns: [{ name: 'retry', re: /^retry\b/i }],
    scanState,
    journalRoot: '/tmp/does-not-matter',
    journal: (event, detail) => journalled.push({ event, detail }),
    events: { truncated: 'x-truncated', ignoredAuthor: 'x-ignored', backoffSkip: 'x-backoff' },
    scannerKey: 'unpark',
  };

  await scanForMatch({ ...common, now: 1000 }); // failure 1 -- no backoff yet
  await scanForMatch({ ...common, now: 2000 }); // failure 2 -- now backs off

  const before = calls;
  const skipped = await scanForMatch({ ...common, now: 2500 }); // still inside the backoff window
  assert.equal(calls, before, 'a backed-off scan must not spawn gh at all');
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'backoff');
  assert.ok(journalled.some((j) => j.event === 'x-backoff'));
});

test('scanForMatch: hitting the page bound is journalled under the caller-supplied truncated event', async () => {
  const page1 = fullPage(1, 100);
  const deps = { spawnSync: () => ok(JSON.stringify(page1)) }; // always a full page -- never a natural end
  const journalled = [];

  const result = await scanForMatch({
    deps,
    config: {},
    ghRepo: 'x/y',
    issue: 9,
    anchorId: 0,
    maxPages: 1,
    patterns: [{ name: 'retry', re: /^retry\b/i }],
    scanState: createScanState(),
    journalRoot: '/tmp/does-not-matter',
    journal: (event, detail) => journalled.push({ event, detail }),
    events: { truncated: 'x-truncated', ignoredAuthor: 'x-ignored', backoffSkip: 'x-backoff' },
    scannerKey: 'unpark',
    now: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.match, null);
  assert.ok(journalled.some((j) => j.event === 'x-truncated' && j.detail.maxPages === 1));
});
