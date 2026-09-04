'use strict';
// Tests for orchestrator/tokens.js (the journals-are-the-truth TOKEN reader, replacing
// orchestrator/cost.js) and its `spo tokens` front end (plus the deprecated `spo cost` alias).
// Token usage is seeded by writing `llm-call` events into a task journal -- exactly the shape a
// real run leaves behind (steps/llm.js's extractTokens); shadow tasks cost nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { tokenReport, todaySpend, computeLikelyCacheExpiries } = require('../orchestrator/tokens');
const { SPO_BIN, REPO_ROOT, mkTmp } = require('./helpers');

const CONFIG_PATH = path.join(REPO_ROOT, 'orchestrator', 'config.js');

// Writes journal/<id>/{journal.jsonl,state.json} the way a finished real task leaves them.
// `calls` is an array of {fresh, cacheCreation, cacheRead, out, ts} -- ts optional, defaults to
// spaced-out synthetic timestamps so cache-expiry tests can control the gap precisely.
//
// Every seeded call carries `tokensSource: 'modelUsage'` by default, because steps/llm.js's
// appendEvent ALWAYS journals that field on a real call -- a fixture that omitted it would be
// testing a shape production never writes. Two overrides model the two "not reported" cases
// tokens.js has to tell apart from a genuine zero:
//   {tokensSource: null} -- a call that died before a modelUsage block existed (deadline kill,
//                           E2BIG, non-JSON stdout): extractTokens's ZERO_TOKENS shape.
//   {legacy: true}       -- an event written BEFORE token capture shipped (2026-08-31): no
//                           token fields and no tokensSource at all, only the retired costUsd.
function seedTaskJournal(journalRoot, id, { calls = [], state = 'DONE', parks = [] } = {}) {
  const dir = path.join(journalRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = calls.map((c, i) => {
    const ts = c.ts || `2026-08-31T00:0${i}:00.000Z`;
    if (c.legacy) {
      return JSON.stringify({ ts, state: 'PLAN', event: 'llm-call', step: c.step || 'PLAN', costUsd: 1.23 });
    }
    return JSON.stringify({
      ts,
      state: 'PLAN',
      event: 'llm-call',
      step: c.step || 'PLAN',
      tokensSource: c.tokensSource === undefined ? 'modelUsage' : c.tokensSource,
      freshInputTokens: c.fresh || 0,
      cacheCreationTokens: c.cacheCreation || 0,
      cacheReadTokens: c.cacheRead || 0,
      outputTokens: c.out || 0,
    });
  });
  for (const reason of parks) {
    lines.push(JSON.stringify({ ts: 'x', state: 'PLAN', event: 'parked', reason }));
  }
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id, state }));
}

// ---- tokenReport: per-task + aggregate maths -------------------------------------------------

test('tokenReport: sums the four token fields per task and in aggregate, plus billableTokens', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-1', {
    calls: [
      { fresh: 100, cacheCreation: 50, cacheRead: 0, out: 20 },
      { fresh: 200, cacheCreation: 0, cacheRead: 1000, out: 30 },
    ],
    state: 'DONE',
  });
  seedTaskJournal(journalRoot, 'issue-2', {
    calls: [{ fresh: 300, cacheCreation: 0, cacheRead: 0, out: 40 }],
    state: 'PARKED',
    parks: ['plan-invalid'],
  });

  const report = tokenReport(journalRoot);
  assert.equal(report.tasks.length, 2);

  const t1 = report.tasks.find((t) => t.id === 'issue-1');
  assert.equal(t1.freshInputTokens, 300);
  assert.equal(t1.cacheCreationTokens, 50);
  assert.equal(t1.cacheReadTokens, 1000);
  assert.equal(t1.outputTokens, 50);
  assert.equal(t1.billableTokens, 300 + 50 + 50); // fresh + cache-creation + output, NOT cache-read
  assert.equal(t1.llmCalls, 2);

  assert.equal(report.freshInputTokens, 600);
  assert.equal(report.cacheCreationTokens, 50);
  assert.equal(report.cacheReadTokens, 1000);
  assert.equal(report.outputTokens, 90);
  assert.equal(report.billableTokens, 600 + 50 + 90);
  assert.equal(report.done, 1);
  assert.equal(report.parked, 1);
  assert.equal(report.parks, 1);
  assert.deepEqual(report.tasks.find((t) => t.id === 'issue-2').parkReasons, ['plan-invalid']);
});

test('tokenReport: billable-weighted total EXCLUDES cache-read even when cache-read dwarfs everything else', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-huge-cache', {
    calls: [{ fresh: 100, cacheCreation: 50, cacheRead: 50_000_000, out: 20 }],
    state: 'DONE',
  });

  const report = tokenReport(journalRoot);
  const t = report.tasks[0];
  assert.equal(t.cacheReadTokens, 50_000_000);
  // The whole point of the metric: a 50M-token cache-read call still bills as a tiny call.
  assert.equal(t.billableTokens, 100 + 50 + 20);
  assert.equal(report.billableTokens, 100 + 50 + 20);
});

test('tokenReport: counts park EVENTS, not parked tasks (a card can park and still be DONE)', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-247', {
    calls: [{ fresh: 1000, out: 100 }],
    state: 'DONE',
    parks: ['a', 'b', 'c'],
  });

  const report = tokenReport(journalRoot);
  assert.equal(report.done, 1);
  assert.equal(report.parked, 0); // no task ended parked...
  assert.equal(report.parks, 3); // ...but it parked three times on the way
});

test('tokenReport: billableTokensPerDoneCard is the TOTAL billable spend (every task, including parked attempts) over the number of DONE cards -- same "honest cost of the whole run" semantics orchestrator/cost.js used, null with no DONE card', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ fresh: 100, out: 20 }], state: 'DONE' });
  seedTaskJournal(journalRoot, 'issue-2', { calls: [{ fresh: 300, out: 40 }], state: 'DONE' });
  seedTaskJournal(journalRoot, 'issue-3', { calls: [{ fresh: 50, out: 5 }], state: 'PARKED', parks: ['x'] });

  const report = tokenReport(journalRoot);
  assert.equal(report.done, 2);
  assert.equal(report.billableTokens, 120 + 340 + 55); // parked attempts count too -- see header
  assert.equal(report.billableTokensPerDoneCard, (120 + 340 + 55) / 2);

  const emptyJournalRoot = mkTmp('spo-tokens-empty-');
  seedTaskJournal(emptyJournalRoot, 'only-parked', { calls: [{ fresh: 1 }], state: 'PARKED', parks: ['x'] });
  assert.equal(tokenReport(emptyJournalRoot).billableTokensPerDoneCard, null);
});

test('tokenReport: a torn final line and a directory with no journal are skipped, not thrown on', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'good', { calls: [{ fresh: 10 }] });
  fs.appendFileSync(path.join(journalRoot, 'good', 'journal.jsonl'), '{"event":"llm-call","freshIn');
  fs.mkdirSync(path.join(journalRoot, 'not-a-task'), { recursive: true });

  const report = tokenReport(journalRoot);
  assert.equal(report.tasks.length, 1);
  assert.equal(report.freshInputTokens, 10);
});

test('tokenReport: an empty/missing journal root is all-zero, not a throw', () => {
  const report = tokenReport(path.join(mkTmp('spo-tokens-'), 'nope'));
  assert.equal(report.billableTokens, 0);
  assert.equal(report.tasks.length, 0);
});

// ---- computeLikelyCacheExpiries ---------------------------------------------------------------

test('computeLikelyCacheExpiries: a call >TTL after the previous one, with cache-creation dominating cache-read, is flagged', () => {
  const calls = [
    { ts: '2026-08-31T00:00:00.000Z', cacheCreationTokens: 0, cacheReadTokens: 5000 },
    // 90 minutes later -- past a 60-minute TTL -- with heavy cache-creation on this call.
    { ts: '2026-08-31T01:30:00.000Z', cacheCreationTokens: 40000, cacheReadTokens: 0 },
  ];
  const flags = computeLikelyCacheExpiries(calls, 60 * 60 * 1000);
  assert.deepEqual(flags, [false, true]);
});

test('computeLikelyCacheExpiries: the same two calls only 10 minutes apart are NOT flagged', () => {
  const calls = [
    { ts: '2026-08-31T00:00:00.000Z', cacheCreationTokens: 0, cacheReadTokens: 5000 },
    { ts: '2026-08-31T00:10:00.000Z', cacheCreationTokens: 40000, cacheReadTokens: 0 },
  ];
  const flags = computeLikelyCacheExpiries(calls, 60 * 60 * 1000);
  assert.deepEqual(flags, [false, false]);
});

test('computeLikelyCacheExpiries: a large gap with NO cache-creation on the later call is NOT flagged', () => {
  const calls = [
    { ts: '2026-08-31T00:00:00.000Z', cacheCreationTokens: 0, cacheReadTokens: 5000 },
    { ts: '2026-08-31T03:00:00.000Z', cacheCreationTokens: 0, cacheReadTokens: 6000 },
  ];
  const flags = computeLikelyCacheExpiries(calls, 60 * 60 * 1000);
  assert.deepEqual(flags, [false, false]);
});

test('computeLikelyCacheExpiries: a large gap where cache-creation does not dominate cache-read is NOT flagged', () => {
  const calls = [
    { ts: '2026-08-31T00:00:00.000Z', cacheCreationTokens: 0, cacheReadTokens: 5000 },
    { ts: '2026-08-31T03:00:00.000Z', cacheCreationTokens: 100, cacheReadTokens: 40000 },
  ];
  const flags = computeLikelyCacheExpiries(calls, 60 * 60 * 1000);
  assert.deepEqual(flags, [false, false]);
});

test('computeLikelyCacheExpiries: the TTL is a parameter -- a short TTL flags a gap a long TTL would not', () => {
  const calls = [
    { ts: '2026-08-31T00:00:00.000Z', cacheCreationTokens: 0, cacheReadTokens: 0 },
    { ts: '2026-08-31T00:05:00.000Z', cacheCreationTokens: 1000, cacheReadTokens: 0 },
  ];
  assert.deepEqual(computeLikelyCacheExpiries(calls, 60 * 60 * 1000), [false, false]);
  assert.deepEqual(computeLikelyCacheExpiries(calls, 60 * 1000), [false, true]);
});

test('tokenReport: surfaces likelyCacheExpiries per task and in aggregate, using config.cacheTtlMs by default (overridable)', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-expiry', {
    calls: [
      { ts: '2026-08-31T00:00:00.000Z', fresh: 100, out: 10, cacheRead: 5000 },
      { ts: '2026-08-31T01:30:00.000Z', fresh: 100, out: 10, cacheCreation: 40000 },
    ],
    state: 'DONE',
  });

  // A short override TTL (test convenience -- see config.js's own comment on why this is a
  // parameter rather than a fabricated hour-long fixture).
  const reportShortTtl = tokenReport(journalRoot, { cacheTtlMs: 5 * 60 * 1000 });
  assert.equal(reportShortTtl.tasks[0].likelyCacheExpiries.length, 1);
  assert.equal(reportShortTtl.likelyCacheExpiries, 1);

  const reportNoFlag = tokenReport(journalRoot, { cacheTtlMs: 24 * 60 * 60 * 1000 });
  assert.equal(reportNoFlag.tasks[0].likelyCacheExpiries.length, 0);
  assert.equal(reportNoFlag.likelyCacheExpiries, 0);
});

// ---- `spo tokens` / `spo cost` CLI -------------------------------------------------------------

test('spo tokens: prints per-task rows, the aggregate, billable tokens per DONE card, and the parking rate', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ fresh: 100000, out: 5000 }], state: 'DONE' });
  seedTaskJournal(journalRoot, 'issue-2', { calls: [{ fresh: 50000, out: 2000 }], state: 'PARKED', parks: ['budget_exhausted'] });

  const out = execFileSync(process.execPath, [SPO_BIN, 'tokens', '--journal', journalRoot], { encoding: 'utf8' });
  assert.match(out, /issue-1\s+DONE/);
  assert.match(out, /budget_exhausted/);
  assert.match(out, /billable tokens per DONE card:/);
  assert.match(out, /parking rate: 50% \(1\/2 terminal\)/);
  assert.match(out, /cache expiries \(likely, advisory only\):/);
});

// ---- "not reported" must never read as zero ---------------------------------------------------
//
// The report a maintainer runs on day one is over PRE-CHANGE journals, whose llm-call events
// carry only the retired costUsd. If those print 0, the table says "this pipeline used no
// tokens" -- a false measurement, not a missing one. tokensSource is what tells the two apart.

test('tokenReport: counts llm-calls that reported no tokens separately from ones that did', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-legacy', {
    calls: [{ legacy: true }, { legacy: true }],
    state: 'DONE',
  });
  seedTaskJournal(journalRoot, 'issue-mixed', {
    calls: [{ fresh: 100, out: 20 }, { tokensSource: null }],
    state: 'DONE',
  });

  const report = tokenReport(journalRoot);
  const legacy = report.tasks.find((t) => t.id === 'issue-legacy');
  const mixed = report.tasks.find((t) => t.id === 'issue-mixed');

  assert.equal(legacy.llmCalls, 2);
  assert.equal(legacy.llmCallsWithTokens, 0);
  assert.equal(legacy.llmCallsWithoutTokens, 2);

  // a deadline-killed call (tokensSource: null) is "not reported" too, even though its numeric
  // fields are all present and 0 -- exactly the plan's 7.4 distinction.
  assert.equal(mixed.llmCallsWithTokens, 1);
  assert.equal(mixed.llmCallsWithoutTokens, 1);

  assert.equal(report.llmCalls, 4);
  assert.equal(report.llmCallsWithTokens, 1);
  assert.equal(report.llmCallsWithoutTokens, 3);
});

test('tokenReport: billableTokensPerDoneCard is null (not 0) when no call reported tokens at all', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ legacy: true }, { legacy: true }], state: 'DONE' });

  const report = tokenReport(journalRoot);
  assert.equal(report.done, 1);
  assert.equal(report.billableTokens, 0);
  assert.equal(report.billableTokensPerDoneCard, null, 'a per-DONE-card figure computed off journals with no token data is a false measurement');
});

test('spo tokens: a journal with no token data prints "n/a", never 0, plus a footer naming how many calls lacked the fields', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ legacy: true }, { legacy: true }, { legacy: true }], state: 'DONE' });

  const out = execFileSync(process.execPath, [SPO_BIN, 'tokens', '--journal', journalRoot], { encoding: 'utf8' });

  // Assert on the TASK ROW itself, not just the summary lines: the row is where a bare "0"
  // would be read as "this task used no tokens".
  const row = out.split('\n').find((l) => l.startsWith('issue-1 '));
  assert.ok(row, `expected a row for issue-1 in:\n${out}`);
  assert.match(row, /(\s|^)n\/a(\s|$)/, `token columns of the task row must read n/a, not 0 -- got: ${row}`);
  assert.equal(
    (row.match(/n\/a/g) || []).length,
    5,
    `all five token columns of a no-data task must read n/a -- got: ${row}`
  );
  assert.doesNotMatch(row, /(\s)0(\s|$)/, `a no-data task row must contain no bare 0 token cell -- got: ${row}`);
  assert.match(out, /total: n\/a -- no token data/);
  assert.doesNotMatch(out, /billable tokens per DONE card: 0\b/);
  assert.match(out, /billable tokens per DONE card: n\/a/);
  assert.match(out, /3 of 3 llm-call events carry no token data/);
  assert.match(out, /not reported, not zero/);
});

test('spo tokens: a journal WITH token data prints real numbers and no missing-data footer', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ fresh: 1000, cacheCreation: 500, out: 100 }], state: 'DONE' });

  const out = execFileSync(process.execPath, [SPO_BIN, 'tokens', '--journal', journalRoot], { encoding: 'utf8' });
  assert.doesNotMatch(out, /n\/a/);
  assert.doesNotMatch(out, /carry no token data/);
  assert.match(out, /billable tokens per DONE card: 1\.6k/);
  const row = out.split('\n').find((l) => l.startsWith('issue-1 '));
  assert.match(row, /1\.6k/, `a reporting task's row must show its real billable total -- got: ${row}`);
});

test('spo tokens: never prints a dollar figure', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ fresh: 100000, out: 5000 }], state: 'DONE' });

  const out = execFileSync(process.execPath, [SPO_BIN, 'tokens', '--journal', journalRoot], { encoding: 'utf8' });
  assert.doesNotMatch(out, /\$\d/);
});

test('spo tokens: formats large token counts readably (e.g. "k"/"M" suffixes), not raw 9-digit integers', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ fresh: 215400, cacheRead: 3_500_000, out: 1200 }], state: 'DONE' });

  const out = execFileSync(process.execPath, [SPO_BIN, 'tokens', '--journal', journalRoot], { encoding: 'utf8' });
  assert.match(out, /215\.4k/);
  assert.match(out, /3\.5M/);
});

test('spo cost: prints a deprecation notice, then the same table `spo tokens` prints -- and never a dollar figure', () => {
  const journalRoot = mkTmp('spo-tokens-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ fresh: 100000, out: 5000 }], state: 'DONE' });
  seedTaskJournal(journalRoot, 'issue-2', { calls: [{ fresh: 50000, out: 2000 }], state: 'PARKED', parks: ['budget_exhausted'] });

  const costOut = execFileSync(process.execPath, [SPO_BIN, 'cost', '--journal', journalRoot], { encoding: 'utf8' });
  const tokensOut = execFileSync(process.execPath, [SPO_BIN, 'tokens', '--journal', journalRoot], { encoding: 'utf8' });

  assert.match(costOut, /deprecated/i);
  assert.match(costOut, /spo tokens/);
  assert.doesNotMatch(costOut, /\$\d/);
  // Same report content follows the notice.
  assert.equal(costOut.slice(costOut.indexOf('issue-1')), tokensOut.slice(tokensOut.indexOf('issue-1')));
});

test('autoPullLimit: defaults to 1 (one card off the board at a time); SPO_AUTO_PULL_LIMIT overrides', () => {
  const read = (env) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).autoPullLimit))', CONFIG_PATH],
        { encoding: 'utf8', env }
      )
    );

  assert.equal(read({ ...process.env, SPO_AUTO_PULL_LIMIT: undefined }), 1);
  assert.equal(read({ ...process.env, SPO_AUTO_PULL_LIMIT: '5' }), 5);

  // 0 MEANS ZERO. It used to mean 3: config.js passed `Number(...)` straight through to
  // auto-pull.js's `(config && config.autoPullLimit) || DEFAULT_AUTO_PULL_LIMIT`, where 0 is
  // falsy, so the one input an operator would reach for to switch auto-pull off tripled it
  // instead. The trap is baited by the neighbouring autoPullMs, whose own comment in this same
  // file says "0 disables the timer entirely".
  assert.equal(read({ ...process.env, SPO_AUTO_PULL_LIMIT: '0' }), 0);

  // A typo resolves to the DOCUMENTED DEFAULT, never to something larger -- `Number('abc')` is
  // NaN, and the same posture positiveIntFromEnv already applies to SPO_WORKERS. An operator
  // mistake must not be able to raise a rate cap above what this file documents.
  assert.equal(read({ ...process.env, SPO_AUTO_PULL_LIMIT: 'abc' }), 1);
  assert.equal(read({ ...process.env, SPO_AUTO_PULL_LIMIT: '-2' }), 1);
  assert.equal(read({ ...process.env, SPO_AUTO_PULL_LIMIT: '1.5' }), 1);
});

test('cacheTtlMs: defaults to 1 hour; SPO_CACHE_TTL_MS overrides', () => {
  const read = (env) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).cacheTtlMs))', CONFIG_PATH],
        { encoding: 'utf8', env }
      )
    );

  assert.equal(read({ ...process.env, SPO_CACHE_TTL_MS: undefined }), 60 * 60 * 1000);
  assert.equal(read({ ...process.env, SPO_CACHE_TTL_MS: '300000' }), 300000);
});

// ---- SPO-Pipeline#117: the intake half of the ledger ------------------------------------------
//
// DRAFT_CARD / REVIEW_CARD / TRIAGE_BUG_REPORT run before a card has a task directory, so
// orchestrator/intake.js journals their `llm-call` events into <journalRoot>/daemon.jsonl. Until
// 2026-09-04 nothing wrote them and nothing read them: every figure this module produced was the
// task journals alone, short by the whole of intake, and `spo status` shipped a caveat line
// saying so. test/intake.test.js pins the write side; this block pins the read side.

// daemon.jsonl the way intake.js leaves it -- `event: 'llm-call'`, no `state` field (there is no
// state machine at intake time), and interleaved with the other daemon events that share the
// file, because a reader that only works on a file containing nothing else is not the reader
// production needs.
function seedDaemonJournal(journalRoot, calls) {
  fs.mkdirSync(journalRoot, { recursive: true });
  const lines = [JSON.stringify({ ts: '2026-08-31T00:00:00.000Z', event: 'auto-triage', scanned: 3 })];
  calls.forEach((c, i) => {
    lines.push(
      JSON.stringify({
        ts: c.ts || `2026-08-31T00:1${i}:00.000Z`,
        event: 'llm-call',
        step: c.step || 'TRIAGE_BUG_REPORT',
        model: c.model || 'opus',
        tokensSource: c.tokensSource === undefined ? 'modelUsage' : c.tokensSource,
        freshInputTokens: c.fresh || 0,
        cacheCreationTokens: c.cacheCreation || 0,
        cacheReadTokens: c.cacheRead || 0,
        outputTokens: c.out || 0,
        ok: c.ok === undefined ? true : c.ok,
      })
    );
  });
  lines.push(JSON.stringify({ ts: '2026-08-31T00:20:00.000Z', event: 'report-triaged', issue: 501, outcome: 'filed' }));
  fs.writeFileSync(path.join(journalRoot, 'daemon.jsonl'), lines.join('\n') + '\n');
}

test('tokenReport: intake calls in daemon.jsonl are reported separately AND folded into every aggregate', () => {
  const journalRoot = mkTmp('spo-tokens-intake-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ fresh: 100, cacheCreation: 10, cacheRead: 9000, out: 5 }], state: 'DONE' });
  seedDaemonJournal(journalRoot, [
    { step: 'DRAFT_CARD', fresh: 1000, cacheCreation: 100, cacheRead: 50000, out: 50 },
    { step: 'REVIEW_CARD', fresh: 2000, cacheCreation: 200, cacheRead: 60000, out: 60 },
  ]);

  const report = tokenReport(journalRoot);

  // Separately: a caller can still say where the spend went.
  assert.equal(report.intake.llmCalls, 2);
  assert.equal(report.intake.billableTokens, 1000 + 100 + 50 + 2000 + 200 + 60);
  assert.equal(report.intake.cacheReadTokens, 110000);

  // And folded in: "what did this run cost" has always meant the whole run.
  assert.equal(report.llmCalls, 3, 'the task journal contributes 1, daemon.jsonl 2');
  assert.equal(report.billableTokens, 115 + 3410);
  assert.equal(report.cacheReadTokens, 9000 + 110000);
  // Cache-READ is still excluded from billable on BOTH sides -- one definition, one accumulator.
  assert.ok(report.billableTokens < report.cacheReadTokens);

  // The intake row is NOT a task: the parking-rate denominator and the task list are untouched.
  assert.equal(report.tasks.length, 1);
  assert.equal(report.done, 1);
});

test('tokenReport: an intake call that reported no tokens counts as "not reported", never as a zero', () => {
  // The whole erratum in miniature. A deadline-killed TRIAGE_BUG_REPORT journals numeric zeros
  // with `tokensSource: null`; reading those as a genuine zero would let the report claim the
  // day's intake cost nothing.
  const journalRoot = mkTmp('spo-tokens-intake-null-');
  seedDaemonJournal(journalRoot, [{ tokensSource: null, ok: false }, { fresh: 40, out: 2 }]);

  const report = tokenReport(journalRoot);
  assert.equal(report.intake.llmCalls, 2);
  assert.equal(report.intake.llmCallsWithTokens, 1);
  assert.equal(report.intake.llmCallsWithoutTokens, 1);
  assert.equal(report.llmCallsWithoutTokens, 1, 'the aggregate carries it too, so the footer can name it');
});

test('tokenReport: no daemon.jsonl at all -> a zeroed intake row, never a crash or a null the caller has to special-case', () => {
  const journalRoot = mkTmp('spo-tokens-no-daemon-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ fresh: 10, out: 1 }], state: 'DONE' });
  const report = tokenReport(journalRoot);
  assert.equal(report.intake.llmCalls, 0);
  assert.equal(report.intake.billableTokens, 0);
  assert.equal(report.billableTokens, 11);
});

test('todaySpend: counts intake calls made today and excludes yesterday\'s, same LOCAL-midnight rule as the task journals', () => {
  const journalRoot = mkTmp('spo-tokens-today-intake-');
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  seedDaemonJournal(journalRoot, [
    { ts: yesterday.toISOString(), fresh: 999999, out: 999999 },
    { ts: new Date(now.getTime() - 60 * 1000).toISOString(), fresh: 300, cacheCreation: 20, out: 5 },
  ]);

  const spend = todaySpend(journalRoot, { now: now.getTime() });
  assert.equal(spend.llmCalls, 1, "yesterday's intake call is not today's spend");
  assert.equal(spend.billableTokens, 325);
  assert.equal(spend.intake.llmCalls, 1);
  assert.equal(spend.intake.billableTokens, 325);
});

test('spo tokens: renders an `(intake)` row and names the intake calls in the total line', () => {
  const journalRoot = mkTmp('spo-tokens-intake-cli-');
  seedTaskJournal(journalRoot, 'issue-1', { calls: [{ fresh: 100000, out: 5000 }], state: 'DONE' });
  seedDaemonJournal(journalRoot, [{ step: 'TRIAGE_BUG_REPORT', fresh: 20000, out: 1000 }]);

  const out = execFileSync(process.execPath, [SPO_BIN, 'tokens', '--journal', journalRoot], { encoding: 'utf8' });
  assert.match(out, /\(intake\)/);
  assert.match(out, /over 1 tasks \+ 1 intake call\(s\)/);
  // 105k task + 21k intake -- the aggregate, not the task journals alone.
  assert.match(out, /billable 126\.0k/);
});

test('spo tokens: a journal root with ONLY intake calls still prints a report, not "no task journals"', () => {
  // The corpus shape that used to be invisible end to end: a day of intake with no card taken.
  const journalRoot = mkTmp('spo-tokens-intake-only-');
  seedDaemonJournal(journalRoot, [{ step: 'DRAFT_CARD', fresh: 700, out: 30 }]);

  const out = execFileSync(process.execPath, [SPO_BIN, 'tokens', '--journal', journalRoot], { encoding: 'utf8' });
  assert.doesNotMatch(out, /no task journals under/);
  assert.match(out, /\(intake\)/);
  assert.match(out, /billable 730/);
});
