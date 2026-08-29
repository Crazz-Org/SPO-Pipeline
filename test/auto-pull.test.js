'use strict';
// Tests for orchestrator/auto-pull.js: shouldAutoPull's pure timer decision (the "injectable
// clock or interval fn" -- no real setInterval/Date.now() call is exercised here, every (now,
// lastPullAt) pair is passed in directly) and runAutoPull's pullBoard+makeTask wiring (same
// deps.spawnSync injection convention as test/intake.test.js, which already covers pullBoard's
// own parsing and makeTask's own dedup/shape in depth -- this file only asserts the parts
// specific to the daemon timer: the top-N cut, the "only journal when something was enqueued"
// rule, and the daemon.jsonl shape).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { shouldAutoPull, runAutoPull, DEFAULT_AUTO_PULL_MS, DEFAULT_AUTO_PULL_LIMIT } = require('../orchestrator/auto-pull');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

// ---- shouldAutoPull: pure decision function ---------------------------------------------------

test('shouldAutoPull: disabled at 0, regardless of lastPullAt', () => {
  assert.equal(shouldAutoPull(null, Date.now(), 0), false);
  assert.equal(shouldAutoPull(Date.now() - 10_000_000, Date.now(), 0), false);
});

test('shouldAutoPull: a never-run timer (lastPullAt null/undefined) is due immediately', () => {
  assert.equal(shouldAutoPull(null, 1_000, 300_000), true);
  assert.equal(shouldAutoPull(undefined, 1_000, 300_000), true);
});

test('shouldAutoPull: not yet due before the interval elapses', () => {
  const last = 1_000_000;
  assert.equal(shouldAutoPull(last, last + 100_000, 300_000), false);
});

test('shouldAutoPull: due exactly at and past the interval', () => {
  const last = 1_000_000;
  assert.equal(shouldAutoPull(last, last + 300_000, 300_000), true);
  assert.equal(shouldAutoPull(last, last + 400_000, 300_000), true);
});

test('defaults: 5 minutes / top 3, matching config.js', () => {
  assert.equal(DEFAULT_AUTO_PULL_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_AUTO_PULL_LIMIT, 3);
});

// ---- runAutoPull: pullBoard + makeTask, top N, journal-only-when-enqueued ----------------------

function boardClaimStdout(candidates) {
  const lines = ['rateLimit cost=2 remaining=4998 resetAt=2026-08-29T12:00:00Z', `candidates: ${candidates.length}`];
  for (const c of candidates) lines.push(`  ${c.rank} #${c.issue} area=${c.area} ${c.title}`);
  return lines.join('\n');
}

function makeDeps({ candidates, issueBodies = {} }) {
  return {
    spawnSync: (command, args, opts) => {
      if (command === 'npm' && args.join(' ') === 'run board:claim') {
        return ok(boardClaimStdout(candidates));
      }
      if (command === 'gh' && args[0] === 'api') {
        const m = args[1].match(/issues\/(\d+)$/);
        const issue = Number(m[1]);
        const body = issueBodies[issue] || { title: `issue ${issue}`, body: 'no special markers', labels: [] };
        return ok(JSON.stringify(body));
      }
      return ok('');
    },
  };
}

test('runAutoPull: default limit 3 -- only the top 3 of 5 candidates are turned into queue files', async () => {
  const queueDir = mkTmp('spo-autopull-queue-');
  const journalRoot = mkTmp('spo-autopull-journal-');
  const candidates = [1, 2, 3, 4, 5].map((n) => ({ rank: n, issue: 500 + n, area: 'client', title: `card ${n}` }));
  const deps = makeDeps({ candidates });

  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo', autoPullLimit: 3 }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.enqueued, 3);
  assert.deepEqual(result.issues, [501, 502, 503]);
  const written = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  assert.equal(written.length, 3);
});

test('runAutoPull: journals exactly one auto-pull event to <journalRoot>/daemon.jsonl when something was enqueued', async () => {
  const queueDir = mkTmp('spo-autopull-queue2-');
  const journalRoot = mkTmp('spo-autopull-journal2-');
  const candidates = [{ rank: 1, issue: 601, area: 'client', title: 'a' }];
  const deps = makeDeps({ candidates });

  await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo' }, deps);

  const daemonLog = fs
    .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(daemonLog.length, 1);
  assert.equal(daemonLog[0].event, 'auto-pull');
  assert.equal(daemonLog[0].enqueued, 1);
  assert.deepEqual(daemonLog[0].issues, [601]);
});

test('runAutoPull: nothing claimable -- no queue file, no daemon.jsonl event at all', async () => {
  const queueDir = mkTmp('spo-autopull-queue3-');
  const journalRoot = mkTmp('spo-autopull-journal3-');
  const deps = makeDeps({ candidates: [] });

  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo' }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.enqueued, 0);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
});

test('runAutoPull: every candidate already queued (dedup) -- makeTask skips all, no daemon.jsonl event', async () => {
  const queueDir = mkTmp('spo-autopull-queue4-');
  const journalRoot = mkTmp('spo-autopull-journal4-');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0001-issue-701.json'), JSON.stringify({ id: 'issue-701', kind: 'card', issue: 701 }));

  const candidates = [{ rank: 1, issue: 701, area: 'client', title: 'a' }];
  const deps = makeDeps({ candidates });

  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo' }, deps);

  assert.equal(result.enqueued, 0);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
  // still exactly the one pre-existing queue file -- nothing new written
  assert.equal(fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length, 1);
});

test('runAutoPull: a failing board:claim is reported, never throws, never journals', async () => {
  const queueDir = mkTmp('spo-autopull-queue5-');
  const journalRoot = mkTmp('spo-autopull-journal5-');
  const deps = { spawnSync: () => ({ status: 3, stdout: '', stderr: 'boom', signal: null }) };

  const result = await runAutoPull(queueDir, journalRoot, { productRepo: '/fake/repo' }, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /exited 3/);
  assert.equal(fs.existsSync(path.join(journalRoot, 'daemon.jsonl')), false);
});
