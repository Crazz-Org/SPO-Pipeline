'use strict';
// console/usage-scan.js -- incremental token scanner + pure view builder. Every fixture lives
// under mkTmp(); never touches ~/.claude/projects or ~/.claude-accounts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp } = require('./helpers');
// Killswitch first, textually, before this file's own `require('../console/...')` /
// `require('../scripts/...')` below -- card SPO-Pipeline#205: the sweep used to know only the
// `../orchestrator/` and `../bin/` spellings, so a console module that started spawning would
// have run its child in this very process with live credentials, unguarded. The sweep now
// enforces this line's presence; see test/no-real-spawn.js's header.
require('./no-real-spawn');
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

// ---- Lot 4 / action 4.2: subagent transcripts + last-occurrence dedup -------------------------

test("scan() reads a subagent transcript under <project>/<sessionId>/subagents/*.jsonl and attributes it to the PARENT session, merged with the main file", async () => {
  const root = mkTmp('spo-usage-root-subagent-');
  const projDir = path.join(root, 'projet-A');
  const parentId = 'sess-parent';
  writeSession(projDir, `${parentId}.jsonl`, [usageLine('m1', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 })]);
  // A subagent transcript file: its own filename is unrelated to the parent, but every line
  // carries sessionId = the PARENT's id, exactly as the real CLI writes it.
  fs.mkdirSync(path.join(projDir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, parentId, 'subagents', 'agent-abc123.jsonl'),
    JSON.stringify({ sessionId: parentId, message: { id: 'sub-m1', model: 'claude-sonnet-5', usage: { input_tokens: 2000, output_tokens: 200 } } }) + '\n'
  );

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  assert.ok(index.bySession[parentId], 'subagent tokens must land on the parent session id');
  assert.equal(index.bySession['agent-abc123'], undefined, 'must NOT create a separate session for the subagent file');
  const totals = index.bySession[parentId].models['claude-sonnet-5'];
  assert.equal(totals.inp, 3000); // 1000 (main) + 2000 (subagent)
  assert.equal(totals.out, 300); // 100 (main) + 200 (subagent)
});

test("scan() finds a subagent transcript nested deeper than one level under subagents/ (e.g. subagents/workflows/<wf_id>/agent-<hash>.jsonl) and attributes it to the parent session", async () => {
  const root = mkTmp('spo-usage-root-subagent-nested-');
  const projDir = path.join(root, 'projet-A');
  const parentId = 'sess-parent';
  writeSession(projDir, `${parentId}.jsonl`, [usageLine('m1', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 })]);
  // A workflow-spawned subagent's transcript, nested two levels below `subagents/`.
  const nestedDir = path.join(projDir, parentId, 'subagents', 'workflows', 'wf_x');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(
    path.join(nestedDir, 'agent-y.jsonl'),
    JSON.stringify({ sessionId: parentId, message: { id: 'sub-nested-1', model: 'claude-sonnet-5', usage: { input_tokens: 4000, output_tokens: 400 } } }) + '\n'
  );

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  assert.ok(index.bySession[parentId], 'the nested subagent file must be attributed to the parent session');
  const totals = index.bySession[parentId].models['claude-sonnet-5'];
  assert.equal(totals.inp, 5000); // 1000 (main) + 4000 (nested subagent)
  assert.equal(totals.out, 500); // 100 (main) + 400 (nested subagent)
});

test('scanFile keeps the LAST occurrence of a message id, not the first: output_tokens 1 -> 50 -> 300 contributes 300', async () => {
  const root = mkTmp('spo-usage-root-lastwins-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 1 }),
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 50 }),
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 300 }),
  ]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  const agg = index.byModel['claude-sonnet-5'];
  assert.equal(agg.out, 300, 'must keep the LAST occurrence (300), not the first (1) or the sum (351)');
  // input_tokens is constant across the three occurrences -- it must be counted ONCE (100), not
  // three times (300). This pairing is what makes the assertion above meaningful: if the code
  // regressed to summing every occurrence instead of deduping, inp would silently reveal it even
  // though out's value alone could coincidentally still look plausible.
  assert.equal(agg.inp, 100);
  assert.equal(index.msgs, 1);
  assert.equal(index.dupes, 2);
});

test("the session-count trap: a parent session with a main file plus TWO subagent files counts as ONE session in byDay, not three", async () => {
  const root = mkTmp('spo-usage-root-daytrap-');
  const projDir = path.join(root, 'projet-A');
  const parentId = 'sess-parent';
  const ts = '2026-09-01T10:00:00.000Z';
  writeSession(projDir, `${parentId}.jsonl`, [usageLineTs('m1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 1 }, ts)]);
  fs.mkdirSync(path.join(projDir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, parentId, 'subagents', 'agent-1.jsonl'),
    JSON.stringify({ sessionId: parentId, timestamp: ts, message: { id: 'sub-1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 1 } } }) + '\n'
  );
  fs.writeFileSync(
    path.join(projDir, parentId, 'subagents', 'agent-2.jsonl'),
    JSON.stringify({ sessionId: parentId, timestamp: ts, message: { id: 'sub-2', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 1 } } }) + '\n'
  );

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'pool1' }] });
  const index = await scanner.scan();

  // Sanity: three cached files feed this one session.
  assert.equal(scanner.stats().filesScanned, 3);
  assert.equal(Object.keys(index.bySession).length, 1);

  const day = localDateKey(ts);
  assert.equal(index.byDay[day].sessions, 1, 'byDay must count DISTINCT sessions, not cached files -- a file-count regression would report 3 here');
  assert.equal(index.byDay[day].msgs, 3); // main + 2 subagent messages, still summed correctly
});

test('a missing/unreadable subagents directory does not throw and does not lose the main file tokens', async () => {
  const root = mkTmp('spo-usage-root-nosubagents-');
  const projDir = path.join(root, 'projet-A');
  const parentId = 'sess-parent';
  writeSession(projDir, `${parentId}.jsonl`, [usageLine('m1', 'claude-sonnet-5', { input_tokens: 500, output_tokens: 50 })]);
  // A session directory exists (e.g. holding other artifacts) but has NO `subagents` subdir.
  fs.mkdirSync(path.join(projDir, parentId), { recursive: true });

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  assert.equal(index.bySession[parentId].models['claude-sonnet-5'].inp, 500);
});

test('the incremental cache still reuses an unchanged subagent file on a second scan()', async () => {
  const root = mkTmp('spo-usage-root-subagent-reuse-');
  const projDir = path.join(root, 'projet-A');
  const parentId = 'sess-parent';
  writeSession(projDir, `${parentId}.jsonl`, [usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 })]);
  fs.mkdirSync(path.join(projDir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, parentId, 'subagents', 'agent-1.jsonl'),
    JSON.stringify({ sessionId: parentId, message: { id: 'sub-1', model: 'claude-sonnet-5', usage: { input_tokens: 20, output_tokens: 2 } } }) + '\n'
  );

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const first = await scanner.scan();
  assert.equal(scanner.stats().filesScanned, 2); // main + subagent
  assert.equal(scanner.stats().filesReused, 0);

  const second = await scanner.scan();
  assert.equal(scanner.stats().filesScanned, 0);
  assert.equal(scanner.stats().filesReused, 2, 'both the main AND the subagent file must be reused unchanged');
  assert.deepEqual(second.byModel, first.byModel);
});

test('a usage block with output_tokens: 0 present is counted as a real 0, not treated as absent', async () => {
  // Named hazard: `-0 >= 0` is true and `JSON.stringify(-0)` emits "0", so a sign-flip or an
  // accidental `|| defaultValue` fallback can survive truthiness-based assertions. Assert exact
  // equality on the whole total instead.
  const root = mkTmp('spo-usage-root-zero-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 0 }),
    usageLine('m2', 'claude-sonnet-5', { input_tokens: 50, output_tokens: 7 }),
  ]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  const agg = index.byModel['claude-sonnet-5'];
  assert.equal(index.msgs, 2, 'the output_tokens:0 message must still be counted as a message');
  assert.equal(agg.out, 7); // 0 + 7, exactly -- not 7 alone (which a "0 is falsy" bug could also produce by luck)
  // NOTE: no Object.is(agg.out, -0) check here -- with a total of 7, Object.is(7, -0) is already
  // false before any sign-flip mutant is applied, so that assertion could never fail on this
  // fixture. The live version of that check is below, on a fixture whose total is legitimately 0.
});

test('a file whose every output_tokens is 0 sums to a real 0, not -0', async () => {
  // Named hazard for this lot: `-0 >= 0` is true and `JSON.stringify(-0)` emits "0", so a
  // sign-flip mutant is invisible to a truthiness or JSON-based assertion. This fixture is the
  // one place in this file where the total can LEGITIMATELY be 0 -- unlike the out:7 fixture
  // above, Object.is(total, -0) is actually reachable here, so this assertion can fail.
  const root = mkTmp('spo-usage-root-allzero-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 0 }),
    usageLine('m2', 'claude-sonnet-5', { input_tokens: 50, output_tokens: 0 }),
  ]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  const agg = index.byModel['claude-sonnet-5'];
  assert.equal(agg.out, 0);
  assert.equal(Object.is(agg.out, -0), false, 'a sign-flip mutant could legitimately produce -0 on this all-zero fixture');
});

test("scanFile's dedup keeps the LAST occurrence's usage object, not the max of each field taken independently", async () => {
  // A mutant that keeps Math.max(...) per field instead of the last occurrence's usage object
  // survives any fixture where every field happens to move in the same direction (as the
  // existing lastwins test's input_tokens/output_tokens both do, held constant / increasing).
  // This fixture forces the two semantics apart: id m1's fields move UP across occurrences (so
  // last == max for m1, same as a max-mutant would give), while id m2's output_tokens moves
  // DOWN (500 -> 9) -- there last-occurrence and max disagree, and only last-occurrence is
  // correct. Monotonically-increasing output_tokens is a measured property of today's real
  // corpus, not a guarantee this code relies on: keeping the LAST occurrence -- the one the CLI
  // actually finalised -- is the semantic, which is exactly why a value can legitimately go down
  // here (a differently-shaped or hand-edited transcript) without invalidating anything.
  const root = mkTmp('spo-usage-root-lastnotmax-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 7, cache_read_input_tokens: 11 }),
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 900, cache_read_input_tokens: 999 }),
    usageLine('m2', 'claude-sonnet-5', { output_tokens: 500 }),
    usageLine('m2', 'claude-sonnet-5', { output_tokens: 9 }),
  ]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  const agg = index.byModel['claude-sonnet-5'];
  // m1's fields don't distinguish the two semantics (last==max for both, both trending up), but
  // m2's out does: last-wins is 9 (m1 contributes 0 + m2's last 9), a max-of-fields mutant would
  // instead sum max(500,9)=500 here.
  assert.equal(agg.inp, 900); // last(m1) = 900, m2 has no input_tokens
  assert.equal(agg.cr, 999); // last(m1) = 999, m2 has no cache_read_input_tokens
  assert.equal(agg.out, 9, 'must keep the LAST occurrence (9), not the max across occurrences (500)');
});

test('scanFile buffers {model, usage} as one atomic pair per id: a later occurrence under a different model replaces both together', async () => {
  // Nothing else in this suite constructs a message id whose model changes between occurrences.
  // Without this, a mutant could keep the LAST usage object but pair it with the FIRST model seen
  // for that id, silently attributing later usage to an earlier (possibly wrong) model.
  const root = mkTmp('spo-usage-root-atomicity-');
  const projDir = path.join(root, 'projet-A');
  writeSession(projDir, 'sess-1.jsonl', [
    usageLine('m1', 'MODEL-A', { output_tokens: 1 }),
    usageLine('m1', 'MODEL-B', { output_tokens: 300 }),
  ]);

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }] });
  const index = await scanner.scan();

  assert.equal(
    index.byModel['MODEL-A'],
    undefined,
    'the earlier model must get no entry at all -- a "last usage paired with first model" bug would put out:300 here'
  );
  assert.ok(index.byModel['MODEL-B']);
  assert.equal(index.byModel['MODEL-B'].out, 300);
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
