'use strict';
// console/usage-scan.js -- incremental token scanner + pure view builder. Every fixture lives
// under mkTmp(); never touches ~/.claude/projects or ~/.claude-accounts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp } = require('./helpers');
const { createUsageScanner, buildTokenViews, buildTrendViews, localDateKey } = require('../console/usage-scan');

function usageLine(id, model, usage) {
  return JSON.stringify({ message: { id, model, usage } });
}

function writeSession(dir, sessionFile, lines) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionFile), lines.join('\n') + '\n');
}

test('scan() dedups by message.id within one file', async () => {
  const root = mkTmp('spo-usage-root-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }),
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }), // duplicate id
    usageLine('m2', 'claude-sonnet-5', { input_tokens: 50, output_tokens: 5 }),
  ]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  assert.equal(index.msgs, 2);
  assert.equal(index.dupes, 1);
});

test('scan() reuses an unchanged file (mtime+size) on a second call', async () => {
  const root = mkTmp('spo-usage-root-reuse-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 })]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const first = await scanner.scan();
  assert.equal(scanner.stats().filesScanned, 1);
  assert.equal(scanner.stats().filesReused, 0);

  const second = await scanner.scan();
  assert.equal(scanner.stats().filesScanned, 0);
  assert.equal(scanner.stats().filesReused, 1);
  assert.deepEqual(second.byModel, first.byModel);
});

test('scan() re-reads a file whose content changed (new mtime/size)', async () => {
  const root = mkTmp('spo-usage-root-change-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 })]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  await scanner.scan();

  // Force a distinguishable mtime and append a line.
  await new Promise((r) => setTimeout(r, 5));
  fs.appendFileSync(path.join(projDir, 'sess-1.jsonl'), usageLine('m2', 'claude-sonnet-5', { input_tokens: 20, output_tokens: 2 }) + '\n');
  fs.utimesSync(path.join(projDir, 'sess-1.jsonl'), new Date(), new Date(Date.now() + 1000));

  const second = await scanner.scan();
  assert.equal(scanner.stats().filesScanned, 1);
  assert.equal(second.msgs, 2);
});

test('scan() drops a file from the index once it is removed', async () => {
  const root = mkTmp('spo-usage-root-remove-');
  const projDir = path.join(root, 'projet-A');
  const filePath = path.join(projDir, 'sess-1.jsonl');
  writeSession(projDir, 'sess-1.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 })]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  await scanner.scan();
  assert.equal(scanner.stats().cachedFiles, 1);

  fs.rmSync(filePath);
  const after = await scanner.scan();
  assert.equal(scanner.stats().cachedFiles, 0);
  assert.deepEqual(after.bySession, {});
});

test('buildTokenViews attributes a session to its task via sessionIndex, and buckets the rest as unattributed', () => {
  const root = mkTmp('spo-usage-root-views-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-mapped.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 1000000, output_tokens: 100000 })]);
  writeSession(projDir, 'sess-unmapped.jsonl', [usageLine('m2', 'claude-sonnet-5', { input_tokens: 200000, output_tokens: 1000 })]);

  return (async () => {
    const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
    const index = await scanner.scan();
    const sessionIndex = { 'sess-mapped': { taskId: 'issue-42', state: 'DONE', title: 'Demo' } };

    const views = buildTokenViews(index, sessionIndex);
    assert.equal(views.byTask.length, 1);
    assert.equal(views.byTask[0].taskId, 'issue-42');
    assert.equal(views.unattributed.sessions, 1);

    // Never a dollar figure or an estUsd key anywhere in the views.
    const dump = JSON.stringify(views);
    assert.doesNotMatch(dump, /\$/);
    assert.doesNotMatch(dump, /estUsd/);
  })();
});

test('buildTokenViews(null, ...) returns null', () => {
  assert.equal(buildTokenViews(null, {}), null);
});

// ---- byDay (scan()) --------------------------------------------------------------------------

function usageLineTs(id, model, usage, timestamp) {
  return JSON.stringify({ message: { id, model, usage }, timestamp });
}

test("scan()'s byDay buckets a session by the LOCAL calendar day of its last message, and excludes the 'local' account", async () => {
  // Both sessions carry the SAME instant, so they land on the same local calendar day at every
  // host offset without exception. The earlier fixture used 10:00Z and 15:00Z with the comment
  // "the SAME local calendar day for any realistic host offset" -- which is not true, and this
  // test failed under TZ=Pacific/Niue (UTC-11), where 10:00Z is Aug 28 local and 15:00Z is
  // Aug 29 local, producing two byDay buckets instead of one. No pair of DISTINCT instants can
  // satisfy that claim: the realistic offset range (UTC-12..UTC+14) is 26 hours wide, so some
  // offset always puts a midnight between them. Identical timestamps is the only offset-proof
  // fixture, and it costs the test nothing -- what it asserts is "two sessions, one day, and the
  // 'local' account excluded", none of which needed the two messages to be at different times.
  // The near-midnight boundary case (where LOCAL and UTC deliberately disagree) is exercised on
  // its own below, action 5.5 item C.
  const root = mkTmp('spo-usage-root-byday-');
  const pooledRoot = path.join(root, 'pool1');
  const ambientRoot = path.join(root, 'ambient');
  writeSession(path.join(pooledRoot, 'proj'), 'sess-a.jsonl', [usageLineTs('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }, '2026-08-29T10:00:00.000Z')]);
  writeSession(path.join(pooledRoot, 'proj'), 'sess-b.jsonl', [usageLineTs('m2', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }, '2026-08-29T10:00:00.000Z')]);
  writeSession(path.join(ambientRoot, 'proj'), 'sess-c.jsonl', [usageLineTs('m3', 'claude-sonnet-5', { input_tokens: 999, output_tokens: 999 }, '2026-08-29T10:00:00.000Z')]);

  const scanner = createUsageScanner({ roots: [{ path: pooledRoot, account: 'pool1' }, { path: ambientRoot, account: 'local' }] });
  const index = await scanner.scan();

  const expectedDay = localDateKey('2026-08-29T10:00:00.000Z');
  assert.deepEqual(Object.keys(index.byDay), [expectedDay]);
  assert.equal(index.byDay[expectedDay].sessions, 2); // sess-a + sess-b, NOT the 'local' sess-c
  assert.equal(index.byDay[expectedDay].models['claude-sonnet-5'].inp, 200);
});

// ---- item C: the LOCAL/UTC "today" boundary -----------------------------------------------

test("scan()'s byDay and collect.js's collectDaemonStats agree on which day an event near local midnight belongs to (action 5.5, item C)", async () => {
  // Action 5.4 pinned orchestrator/tokens.js's todaySpend to LOCAL midnight to match
  // console/collect.js's startOfDay/startOfWeek; this module's byDay used to key by
  // `lastTs.slice(0, 10)` (the UTC date), disagreeing with both for the two hours between
  // 22:00 UTC and local midnight on a UTC+2 host. Construct an instant at 23:30 in THIS
  // process's own local time (not a hard-coded offset, so the test proves the fix on any host,
  // including a UTC one where there is no disagreement window to exercise) and check both
  // panels bucket it into the SAME day.
  const { collectDaemonStats } = require('../console/collect');

  // BOTH sides of midnight, and that pair is the whole test. Verification found the 23:30 probe
  // alone is INERT on the very machine the bug was measured on: at UTC+2, 23:30 local is 21:30Z,
  // the same UTC calendar date, so the broken `lastTs.slice(0, 10)` and the fix agree and
  // reverting the fix passed all 1175 tests under TZ=Europe/Paris AND under TZ=UTC. The two-hour
  // disagreement is on the OTHER side of midnight:
  //
  //   TZ=Europe/Paris  23:30 local -> utc=08-29 local=08-29  differ=false
  //   TZ=Europe/Paris  00:30 local -> utc=08-28 local=08-29  differ=true
  //
  // A positive-offset host is caught by the 00:30 probe, a negative-offset host by the 23:30 one,
  // and on a UTC host neither differs because there is genuinely nothing to catch.
  for (const [label, hours, minutes] of [
    ['23:30 local (bites at negative offsets)', 23, 30],
    ['00:30 local (bites at positive offsets -- the maintainer\'s own host)', 0, 30],
  ]) {
    const probe = new Date();
    probe.setHours(hours, minutes, 0, 0);
    const ts = probe.toISOString();
    const expectedLocalDay = localDateKey(probe);

    const root = mkTmp('spo-usage-root-localday-');
    const pooledRoot = path.join(root, 'pool1');
    writeSession(path.join(pooledRoot, 'proj'), 'sess-a.jsonl', [usageLineTs('m1', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }, ts)]);
    const scanner = createUsageScanner({ roots: [{ path: pooledRoot, account: 'pool1' }] });
    const index = await scanner.scan();

    assert.deepEqual(Object.keys(index.byDay), [expectedLocalDay], `byDay must key by LOCAL day -- ${label}`);

    const journalTasks = [{ state: 'DONE', updatedAt: ts }];
    const stats = collectDaemonStats(journalTasks, 0, { now: probe.getTime() });
    assert.equal(stats.today.total, 1, `collect.js's LOCAL startOfDay must agree -- ${label}`);
  }
});

// ---- item C's standing guard: no UTC day keys anywhere on the dashboard path -----------------

test('no dashboard module derives a day key with toISOString().slice(0, 10) -- that is the UTC date', () => {
  // A source sweep, in the repo's established style (test/gh-api-argv.test.js,
  // test/no-real-spawn-sweep.test.js), because the value that matters is computed inline from
  // Date.now() and cannot be reached from a unit test on a host where the local and UTC dates
  // happen to agree -- which is most of the day, on most hosts. Reverting console/serve.js's
  // `todayDate` to `new Date().toISOString().slice(0, 10)` passed all 1175 tests under
  // TZ=Europe/Paris AND TZ=Pacific/Kiritimati for exactly that reason.
  //
  // The rule this pins is item C's: ONE "today" on the page. collect.js buckets by LOCAL
  // midnight, orchestrator/tokens.js's todaySpend was pinned to local midnight by action 5.4,
  // and usage-scan.js/serve.js key by localDateKey. A `toISOString().slice(0, 10)` anywhere on
  // this path silently reintroduces the two-hour window where the same page showed two different
  // "today"s under the same word.
  const files = ['console/serve.js', 'console/usage-scan.js', 'console/collect.js', 'console/render.js'];
  const offenders = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const blanked = src
      .split('\n')
      .map((line) => (line.trimStart().startsWith('//') ? '' : line))
      .join('\n');
    if (/toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/.test(blanked)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `these derive a UTC day key; use localDateKey(...) from console/usage-scan.js instead: ${offenders.join(', ')}`
  );
});

// ---- buildTrendViews --------------------------------------------------------------------------

function rollupDay({ sessions, Minp = 0, Mcc = 0, Mcr = 0, Mout = 0, partial = false }) {
  return { sessions, msgs: sessions, partial, Minp, Mcc, Mcr, Mout, byModel: {} };
}

test('buildTrendViews computes a per-session weighted average and flags a cache-write-ratio spike', () => {
  const rollups = {
    '2026-08-28': rollupDay({ sessions: 20, Minp: 1, Mcc: 0.2, Mcr: 10, Mout: 2 }),
    '2026-08-29': rollupDay({ sessions: 20, Mcc: 5, Mcr: 5, Mout: 1 }), // cache-write ratio 0.5 > 0.25
  };
  const trend = buildTrendViews(rollups, { minSessionsForCompare: 5 });

  assert.deepEqual(trend.series.map((d) => d.date), ['2026-08-28', '2026-08-29']);
  assert.equal(trend.lastRecordedDate, '2026-08-29');
  assert.equal(trend.series[0].cacheChangeFlag, false);
  assert.equal(trend.series[1].cacheChangeFlag, true); // Mcc/(Mcc+Mcr) = 0.5 > 0.25, sessions >= 5
  assert.ok(trend.series[0].avgWeightPerSession > 0);
});

test('buildTrendViews returns null KPI comparisons when a window has too few sessions', () => {
  const rollups = { '2026-08-30': rollupDay({ sessions: 3, Mout: 1 }) };
  const trend = buildTrendViews(rollups, { minSessionsForCompare: 20 });
  assert.equal(trend.kpis.last7AvgWeightPerSession, null);
  assert.equal(trend.kpis.todayVsLast7Pct, null);
  assert.equal(trend.kpis.todayAvgWeightPerSession, trend.series[0].avgWeightPerSession);
});

// ---- action 5.5, item B: the rollups store's own staleness -------------------------------------

test('buildTrendViews marks itself stale when the last recorded rollup day is not "now"\'s local day', () => {
  // Both the rollup key and the expected gap are derived from `now` through localDateKey, never
  // hard-coded. A fixed pair like ('2026-08-20', now='2026-08-23T12:00Z') reads as "3 days, any
  // host offset" and is not: at UTC+14 that instant is already 08-24 locally, so the gap is 4 and
  // the test failed. The comment claiming otherwise was the bug.
  const now = Date.parse('2026-08-23T12:00:00.000Z');
  const threeDaysBefore = localDateKey(now - 3 * 24 * 60 * 60 * 1000);
  const rollups = { [threeDaysBefore]: rollupDay({ sessions: 10, Mout: 1 }) };
  const trend = buildTrendViews(rollups, { now });
  assert.equal(trend.lastRecordedDate, threeDaysBefore);
  assert.equal(trend.stale, true);
  assert.equal(trend.staleDays, 3);
});

test('buildTrendViews is NOT stale when the last recorded rollup day IS "now"\'s local day', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const today = localDateKey(now);
  const rollups = { [today]: rollupDay({ sessions: 10, Mout: 1 }) };
  const trend = buildTrendViews(rollups, { now });
  assert.equal(trend.stale, false);
  assert.equal(trend.staleDays, 0);
  assert.equal(trend.todayLocalDate, today);
});

test('buildTrendViews({}) returns an empty, non-throwing shape', () => {
  const trend = buildTrendViews({});
  assert.deepEqual(trend.series, []);
  assert.equal(trend.lastRecordedDate, null);
  assert.equal(trend.kpis.todayAvgWeightPerSession, null);
});
