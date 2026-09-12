'use strict';
// scripts/usage-report.js -- the offline analysis tool -- gets real coverage here for the first
// time (SPO-Pipeline#170). Every fixture lives under mkTmp() and is passed explicitly via
// --roots=; the default root (~/.claude/projects) is never reached by any test in this file, since
// run()/collect() only fall back to it when NO --roots is given -- every call below passes one.
//
// This file's actual "done means" (see scripts/usage-report.js's own header) is that this reader
// and console/usage-scan.js's scanFile now agree, to the token, on a shared fixture -- that is
// the anti-drift ratchet the "two readers agree" test below exists to be.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { mkTmp, REPO_ROOT, isolatedEnv } = require('./helpers');
// Killswitch first, textually, before this file's own `require('../console/...')` /
// `require('../scripts/...')` below -- card SPO-Pipeline#205: the sweep used to know only the
// `../orchestrator/` and `../bin/` spellings, so a console module that started spawning would
// have run its child in this very process with live credentials, unguarded. The sweep now
// enforces this line's presence; see test/no-real-spawn.js's header.
require('./no-real-spawn');
const { run, collect, parseArgs } = require('../scripts/usage-report');
const { scanFile, listCandidateFiles, createUsageScanner } = require('../console/usage-scan');

const USAGE_REPORT_JS = path.join(REPO_ROOT, 'scripts', 'usage-report.js');

function usageLine(id, model, usage, extra = {}) {
  return JSON.stringify({ message: { id, model, usage, ...extra }, timestamp: '2026-09-01T10:00:00.000Z' });
}

function writeSession(dir, sessionFile, lines) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionFile), lines.join('\n') + '\n');
}

// ---- (a) fixture-only, never the real corpus --------------------------------------------------

test('run()/collect() default to ~/.claude/projects only when --roots is absent, but every test in this file passes --roots explicitly', () => {
  // Not a filesystem assertion (that would require faking os homedir) -- a pin on parseArgs'
  // OWN default, which is what every other test in this file relies on never being reached.
  const opts = parseArgs(['SPO']);
  assert.ok(opts.roots[0].endsWith(path.join('.claude', 'projects')));
});

// ---- (b) subagent walk ------------------------------------------------------------------------

test('collect() walks a subagent transcript under <projectDir>/<sessionId>/subagents/*.jsonl and counts it in `files`', async () => {
  const root = mkTmp('spo-usage-report-subagent-');
  const projDir = path.join(root, 'projet-SPO-A');
  const parentId = 'sess-parent';
  writeSession(projDir, `${parentId}.jsonl`, [usageLine('m1', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 })]);
  fs.mkdirSync(path.join(projDir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, parentId, 'subagents', 'agent-abc.jsonl'),
    usageLine('sub-m1', 'claude-sonnet-5', { input_tokens: 2000, output_tokens: 200 }) + '\n'
  );

  const raw = await collect(['SPO', `--roots=${root}`]);

  assert.equal(raw.files, 2, 'main transcript + subagent transcript, both read');
  assert.equal(raw.byModel['claude-sonnet-5'].driver.inp, 3000); // 1000 (main) + 2000 (subagent)
  assert.equal(raw.byModel['claude-sonnet-5'].driver.out, 300); // 100 (main) + 200 (subagent)
});

test('a nested subagent transcript (subagents/workflows/<wf_id>/agent-<hash>.jsonl) is also walked and counted', async () => {
  const root = mkTmp('spo-usage-report-subagent-nested-');
  const projDir = path.join(root, 'projet-SPO-A');
  const parentId = 'sess-parent';
  writeSession(projDir, `${parentId}.jsonl`, [usageLine('m1', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 })]);
  const nestedDir = path.join(projDir, parentId, 'subagents', 'workflows', 'wf_x');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(nestedDir, 'agent-y.jsonl'), usageLine('sub-nested-1', 'claude-sonnet-5', { input_tokens: 4000, output_tokens: 400 }) + '\n');

  const raw = await collect(['SPO', `--roots=${root}`]);

  assert.equal(raw.files, 2);
  assert.equal(raw.byModel['claude-sonnet-5'].driver.inp, 5000);
});

test('a symlinked project directory and a symlinked .jsonl file are both silently skipped (matching listCandidateFiles/listJsonlFilesRecursive convention), not read', async () => {
  const root = mkTmp('spo-usage-report-symlink-');
  const realProjDir = path.join(root, 'projet-SPO-real');
  writeSession(realProjDir, 'sess-1.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 })]);

  // A symlinked PROJECT directory: `fs.Dirent.isDirectory()` returns false for a symlink, so
  // listCandidateFiles's own `dirEntries.filter((d) => d.isDirectory() && ...)` must never even
  // descend into this one.
  fs.symlinkSync(realProjDir, path.join(root, 'projet-SPO-symlinked'), 'dir');

  // A symlinked .jsonl FILE inside a REAL project directory: `fs.Dirent.isFile()` also returns
  // false for a symlink, so it must be neither read as a file nor recursed into as a directory.
  const otherProjDir = path.join(root, 'projet-SPO-other');
  fs.mkdirSync(otherProjDir, { recursive: true });
  fs.symlinkSync(path.join(realProjDir, 'sess-1.jsonl'), path.join(otherProjDir, 'sess-1-link.jsonl'), 'file');

  const raw = await collect(['SPO', `--roots=${root}`]);

  // Only the ONE real file (under projet-SPO-real) must have been read -- neither the symlinked
  // project directory's copy nor the symlinked file counts a second (or first, for the
  // symlinked-only project) time.
  assert.equal(raw.files, 1, 'both the symlinked project directory and the symlinked file must be skipped, leaving only the one real file');
  assert.equal(raw.byModel['claude-sonnet-5'].driver.inp, 1000, 'symlinked copies must not double- (or single-, for the symlink-only dir) count the tokens');
});

// ---- (b2) subagent transcripts fold onto their PARENT session, not counted as extra sessions ---

test('a session with a main file plus TWO subagent files counts as ONE session (not three) in `sessions`/`topSessions`; isCard ORs across the group and lastTs takes the MAX', async () => {
  // Mirrors test/dashboard-usage-scan.test.js's "the session-count trap" test for
  // console/usage-scan.js's own `bySession` folding -- this file must fold identically, or a
  // consumer of usage-snapshot.json (console/collect.js) silently sees a session count 3x too
  // high for every card with two subagents.
  const root = mkTmp('spo-usage-report-session-fold-');
  const projDir = path.join(root, 'projet-SPO-A');
  const parentId = 'sess-parent';
  // Parent is EARLIEST and carries no tool_use marker -- on its own it would type 'meta'.
  writeSession(projDir, `${parentId}.jsonl`, [
    JSON.stringify({ message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 1 } }, timestamp: '2026-09-01T09:00:00.000Z' }),
  ]);
  fs.mkdirSync(path.join(projDir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, parentId, 'subagents', 'agent-1.jsonl'),
    JSON.stringify({ sessionId: parentId, timestamp: '2026-09-01T10:00:00.000Z', message: { id: 'sub-1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 1 } } }) + '\n'
  );
  // agent-2 is the LATEST file AND the only one carrying a board:take marker (a subagent
  // running its own board:take is unusual but not impossible -- this is exactly the case the
  // isCard OR and the lastTs MAX both need to survive).
  fs.writeFileSync(
    path.join(projDir, parentId, 'subagents', 'agent-2.jsonl'),
    JSON.stringify({
      sessionId: parentId,
      timestamp: '2026-09-01T11:00:00.000Z',
      message: {
        id: 'sub-2',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 10, output_tokens: 1 },
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run board:take -- 999' } }],
      },
    }) + '\n'
  );

  const raw = await collect(['SPO', `--roots=${root}`]);

  assert.equal(raw.files, 3, 'sanity: three cached files feed this one session');
  assert.equal(raw.perFile.length, 1, 'the fold must produce exactly ONE session entry, not three');
  assert.equal(raw.perFile[0].file, `projet-SPO-A/${parentId}.jsonl`, 'the folded entry must be named after the MAIN transcript, not whichever subagent file discovery happened to visit first');
  assert.equal(raw.perFile[0].msgs, 3, 'main + 2 subagent messages, still summed correctly');
  assert.equal(raw.perFile[0].inp, 30);
  // isCard ORs across the whole group: the MAIN file alone never ran board:take, only its
  // subagent (agent-2) did -- a mutant that typed the session from the main file's own isCard
  // alone (ignoring its subagents') would report 'meta' here instead.
  assert.equal(raw.sessions.card.n, 1, 'a subagent-only board:take must still type the whole SESSION as card');
  assert.equal(raw.sessions.meta.n, 0, 'sessions.meta.n must count DISTINCT sessions, not cached files -- a regression here would report 1 (or, pre-fold, 3)');
  // lastTs takes the MAX across the group (agent-2, 11:00), not the parent's own (09:00) or
  // whichever file the fold happened to visit last -- a mutant that took MIN instead of MAX
  // would report the parent's 09:00 here.
  assert.equal(raw.perFile[0].lastTs, '2026-09-01T11:00:00.000Z', 'lastTs must be the MAX across the folded group');
});

test('sessionId resolution is NOT sticky: a line with no sessionId falls back to the FILE\'s own basename, matching scanFile, rather than keeping a foreign id seen on an earlier line', async () => {
  // console/usage-scan.js's scanFile re-resolves sid on EVERY usage-carrying line
  // (`const sid = o.sessionId || sessionId; if (sid) agg.sessionId = sid;`, where `sessionId` on
  // the right is the file's own basename, a constant) -- it never carries a PREVIOUS line's
  // resolved value forward. doFile must do the same. This fixture forces the two semantics apart:
  // sess-mixed.jsonl's FIRST usage line carries a foreign `sessionId: "sess-real"` (data noise --
  // the exact shape a stray/malformed line could produce), and its SECOND carries none at all. A
  // sticky implementation would keep "sess-real" from the first line and merge this file's own,
  // real session into sess-real.jsonl's genuinely separate session below; a correctly-resetting
  // one falls back to this file's own basename ("sess-mixed") on the second line, which is also
  // the LAST line processed and therefore what f.sessionId ends up as.
  const root = mkTmp('spo-usage-report-sid-not-sticky-');
  const projDir = path.join(root, 'projet-SPO-A');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'sess-mixed.jsonl'),
    [
      JSON.stringify({ sessionId: 'sess-real', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 1 } }, timestamp: '2026-09-01T09:00:00.000Z' }),
      JSON.stringify({ message: { id: 'm2', model: 'claude-sonnet-5', usage: { input_tokens: 20, output_tokens: 2 } }, timestamp: '2026-09-01T09:01:00.000Z' }), // no sessionId
    ].join('\n') + '\n'
  );
  // A genuinely separate, real session named "sess-real".
  writeSession(projDir, 'sess-real.jsonl', [usageLine('m3', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 })]);

  const raw = await collect(['SPO', `--roots=${root}`]);

  assert.equal(raw.perFile.length, 2, 'sess-mixed and sess-real must stay TWO distinct sessions, not merge into one');
  const bySize = [...raw.perFile].sort((a, b) => a.inp - b.inp);
  assert.equal(bySize[0].inp, 30, 'sess-mixed.jsonl\'s own two messages (10 + 20), attributed to ITS OWN session');
  assert.equal(bySize[0].file, 'projet-SPO-A/sess-mixed.jsonl');
  assert.equal(bySize[1].inp, 1000, 'sess-real.jsonl\'s own message, untouched by sess-mixed\'s stray sessionId field');
  assert.equal(bySize[1].file, 'projet-SPO-A/sess-real.jsonl');

  // Cross-check against the reference reader directly: scanFile must resolve sess-mixed.jsonl's
  // OWN sessionId the same way (its own basename, "sess-mixed"), never "sess-real".
  const agg = await scanFile(path.join(projDir, 'sess-mixed.jsonl'), 'local');
  assert.equal(agg.sessionId, 'sess-mixed');
});

test('rootStats credits the MAIN file\'s own root once the fold switches display to it, not the first-seen (non-main) file\'s root', async () => {
  // Needs two roots sharing a session id to observe: rootA's project dir holds a non-main file
  // (basename != sessionId) whose content carries a foreign `sessionId: "sess-X"`; rootB's holds
  // the actual main transcript "sess-X.jsonl". Discovery walks ROOTS in array order, so rootA's
  // file is always processed before rootB's -- the fold's display-switch branch (file/root/
  // rootPath all updating together when the MAIN file is found) only fires on rootB's file, and
  // that is exactly the branch item 2 patched to also update `entry.rootPath`.
  const root = mkTmp('spo-usage-report-rootpath-switch-');
  const rootA = path.join(root, 'rootA');
  const rootB = path.join(root, 'rootB');
  fs.mkdirSync(path.join(rootA, 'projet-SPO-A'), { recursive: true });
  fs.writeFileSync(
    path.join(rootA, 'projet-SPO-A', 'other-name.jsonl'),
    JSON.stringify({ sessionId: 'sess-X', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 1 } }, timestamp: '2026-09-01T09:00:00.000Z' }) + '\n'
  );
  writeSession(path.join(rootB, 'projet-SPO-B'), 'sess-X.jsonl', [usageLine('m2', 'claude-sonnet-5', { input_tokens: 20, output_tokens: 2 })]);

  const raw = await collect(['SPO', `--roots=${rootA},${rootB}`]);

  assert.equal(raw.perFile.length, 1, 'both files share sessionId "sess-X" and must fold into one session');
  assert.equal(raw.perFile[0].root, rootB, 'the folded entry must be displayed under the MAIN file\'s own root');
  assert.equal(raw.rootStats[rootB].sessionsWithUsage, 1, 'sessionsWithUsage must credit the MAIN file\'s root (rootB), matching the displayed root');
  assert.equal(raw.rootStats[rootA].sessionsWithUsage, 0, 'the first-seen, non-main file\'s root must NOT be credited once the group switches display to rootB');
});

// ---- (c) last-wins dedup ------------------------------------------------------------------------

test('collect() keeps the LAST occurrence of a message.id: output_tokens 1 -> 50 -> 300 contributes 300, not 1 or 351; dupes counts 2', async () => {
  const root = mkTmp('spo-usage-report-lastwins-');
  const projDir = path.join(root, 'projet-SPO-A');
  writeSession(projDir, 'sess-1.jsonl', [
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 1 }),
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 50 }),
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 300 }),
  ]);

  const raw = await collect(['SPO', `--roots=${root}`]);

  const agg = raw.byModel['claude-sonnet-5'].driver;
  assert.equal(agg.out, 300, 'must keep the LAST occurrence (300), not the first (1) or the sum (351)');
  assert.equal(agg.inp, 100, 'input_tokens counted once, not three times (300)');
  assert.equal(raw.msgs, 1);
  assert.equal(raw.dupes, 2);
});

test('two id-less usage lines (no message.id, no top-level uuid) are each applied exactly once, never collapsed onto a shared key', async () => {
  // The Symbol('idless') key doFile gives each id-less line is created FRESH per line specifically
  // so two id-less lines never collide -- Symbol() is unique per call even with an identical
  // description. A regression that hoisted one shared symbol (or used a constant string key)
  // instead would silently collapse every id-less usage line in a file onto ONE Map slot, losing
  // every occurrence but the last. This fixture has TWO id-less lines with DIFFERENT usage, so
  // that regression is directly observable: both must be counted, summed, not one overwriting
  // the other.
  const root = mkTmp('spo-usage-report-idless-');
  const projDir = path.join(root, 'projet-SPO-A');
  const line = (out) => JSON.stringify({ message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: out } } }); // no id, no uuid
  writeSession(projDir, 'sess-1.jsonl', [line(7), line(13)]);

  const raw = await collect(['SPO', `--roots=${root}`]);

  assert.equal(raw.msgs, 2, 'both id-less lines must be counted as separate messages');
  assert.equal(raw.dupes, 0, 'id-less lines have nothing to dedup against -- neither counts as a duplicate of the other');
  const agg = raw.byModel['claude-sonnet-5'].driver;
  assert.equal(agg.out, 20, 'both occurrences (7 + 13) must be summed, not one overwriting the other (which would give 7 or 13, never 20)');
  assert.equal(agg.inp, 20, '10 + 10, each counted once');
});

// ---- (e) tool_use markers survive the dedup change ---------------------------------------------

test('a tool_use marker on a DUPLICATE line still sets the phase/card flag used for the deduped message (markers read from every physical line, not deduped)', async () => {
  const root = mkTmp('spo-usage-report-marker-on-dup-');
  const projDir = path.join(root, 'projet-SPO-A');
  writeSession(projDir, 'sess-1.jsonl', [
    // First occurrence of m1: no tool_use block, phase stays 'other'.
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 1 }),
    // Second occurrence of m1 (a dedup duplicate) carries the tool_use block the first line
    // lacked -- a board:take Bash call, which both flips isCard and sets phase 'claim'.
    usageLine('m1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 300 }, {
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run board:take -- 123' } }],
    }),
  ]);

  const raw = await collect(['SPO', `--roots=${root}`]);

  assert.equal(raw.dupes, 1);
  assert.equal(raw.sessions.card.n, 1, 'isCard must be set from the marker on the duplicate line');
  assert.ok(raw.byPhase.claim, 'the deduped message must be bucketed under the phase the duplicate line marked');
  assert.equal(raw.byPhase.claim.n, 1);
  assert.equal(raw.byPhase.claim.out, 300, 'the winning (last) occurrence\'s own usage, not the first');
  assert.equal(raw.byPhase.other, undefined, 'the message must not ALSO land in "other" -- it is counted once, under its final phase');
});

// ---- (d) the two readers agree, to the token, on a shared fixture ------------------------------

test('scripts/usage-report.js and console/usage-scan.js\'s scanFile agree to the token on a shared fixture -- the anti-drift ratchet', async () => {
  const root = mkTmp('spo-usage-report-agreement-');
  const projDir = path.join(root, 'projet-SPO-A');
  const parentId = 'sess-parent';

  // Main transcript: two distinct ids, one of them (m1) rewritten three times with growing
  // output_tokens (the real CLI streaming-rewrite shape both readers must dedup identically).
  writeSession(projDir, `${parentId}.jsonl`, [
    usageLine('m1', 'claude-opus-5', { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 10 }),
    usageLine('m1', 'claude-opus-5', { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 900 }),
    usageLine('m2', 'claude-sonnet-5', { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 7000, output_tokens: 50 }),
  ]);
  // A subagent transcript under the same session.
  fs.mkdirSync(path.join(projDir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, parentId, 'subagents', 'agent-1.jsonl'),
    JSON.stringify({
      sessionId: parentId,
      timestamp: '2026-09-01T10:05:00.000Z',
      message: { id: 'sub-1', model: 'claude-sonnet-5', usage: { input_tokens: 4000, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 77 } },
    }) + '\n'
  );
  // A second, unrelated top-level file.
  writeSession(projDir, 'sess-solo.jsonl', [usageLine('m3', 'claude-sonnet-5', { input_tokens: 55, cache_read_input_tokens: 12, output_tokens: 3 })]);

  // ---- side A: scripts/usage-report.js's own reader, raw (unrounded) totals -------------------
  const raw = await collect(['SPO', `--roots=${root}`]);
  let urInp = 0, urCc = 0, urCr = 0, urOut = 0;
  for (const bySide of Object.values(raw.byModel)) {
    for (const s of Object.values(bySide)) {
      urInp += s.inp;
      urCc += s.cc;
      urCr += s.cr;
      urOut += s.out;
    }
  }
  const urBillable = urInp + urCc + urOut; // orchestrator/steps/llm.js's own definition of billable

  // ---- side B: console/usage-scan.js's scanFile, run directly over the same files --------------
  const projDirName = 'projet-SPO-A';
  const filesToScan = [
    path.join(root, projDirName, `${parentId}.jsonl`),
    path.join(root, projDirName, parentId, 'subagents', 'agent-1.jsonl'),
    path.join(root, projDirName, 'sess-solo.jsonl'),
  ];
  let scanInp = 0, scanCc = 0, scanCr = 0, scanOut = 0;
  for (const fp of filesToScan) {
    const agg = await scanFile(fp, 'local');
    for (const m of Object.values(agg.models)) {
      scanInp += m.inp;
      scanCc += m.cc;
      scanCr += m.cr;
      scanOut += m.out;
    }
  }
  const scanBillable = scanInp + scanCc + scanOut;

  assert.equal(raw.files, 3, 'both readers must see all three files (2 top-level + 1 subagent)');
  // Anti-vacuity: this test's whole point depends on the fixture actually containing a
  // growing-output duplicate id (m1). If a future edit quietly removed that duplicate (e.g.
  // collapsed m1 to a single line), every assertion below would still pass -- first-wins and
  // last-wins agree on a fixture with no duplicates at all, so a real dedup-direction regression
  // could land here unnoticed. Pin that the duplicate still exists: m1 contributes exactly one
  // `dupes` count (its second occurrence).
  assert.equal(raw.dupes, 1, 'sanity: the fixture must still contain a growing-duplicate id (m1), or this whole test could pass vacuously even with a dedup-direction bug');
  assert.equal(urInp, scanInp, 'fresh input tokens must agree to the token');
  assert.equal(urCc, scanCc, 'cache-creation tokens must agree to the token');
  assert.equal(urCr, scanCr, 'cache-read tokens must agree to the token');
  assert.equal(urOut, scanOut, 'output tokens must agree to the token (this is where a dedup-direction mismatch would show up first)');
  assert.equal(urBillable, scanBillable);
  // Sanity: the last-wins dedup on m1 must actually have fired (900, not 10 or 910), or this
  // test would pass vacuously even with a dedup-direction bug, since only OUTPUT differs by id.
  assert.equal(urOut, 900 + 50 + 77 + 3);
});

// ---- (f) discovery-helper parity -----------------------------------------------------------

test('listCandidateFiles and createUsageScanner see the SAME file list for one fixture corpus', async () => {
  const root = mkTmp('spo-usage-report-discovery-parity-');
  const projDir = path.join(root, 'projet-SPO-A');
  const parentId = 'sess-parent';
  writeSession(projDir, `${parentId}.jsonl`, [usageLine('m1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 1 })]);
  fs.mkdirSync(path.join(projDir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(projDir, parentId, 'subagents', 'agent-1.jsonl'), usageLine('sub-1', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }) + '\n');
  writeSession(projDir, 'sess-solo.jsonl', [usageLine('m2', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 })]);

  const direct = listCandidateFiles({ roots: [{ path: root, account: 'local' }], filter: 'SPO' }).map((c) => c.absPath).sort();

  const scanner = createUsageScanner({ roots: [{ path: root, account: 'local' }], filter: 'SPO' });
  await scanner.scan();
  assert.equal(scanner.stats().filesScanned, direct.length, 'createUsageScanner must have scanned exactly the files listCandidateFiles names');
  assert.equal(direct.length, 3);
});

// ---- CLI wrapper smoke test --------------------------------------------------------------------

test('the CLI (node scripts/usage-report.js --roots=<fixture>) prints one JSON document matching run()\'s own return value', async () => {
  const root = mkTmp('spo-usage-report-cli-');
  const projDir = path.join(root, 'projet-SPO-A');
  writeSession(projDir, 'sess-1.jsonl', [usageLine('m1', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 })]);

  // env: isolatedEnv() -- not because this CLI reads any of helpers.js's isolated per-test paths
  // (it doesn't -- usage-report.js is neither daemon.js nor bin/spo, it only reads --roots), but
  // test/spawn-isolation-sweep.test.js's repo-wide guard requires every real-spawn call site in
  // test/ to carry an env: derived from isolatedEnv() or a named, justified allowlist entry;
  // isolatedEnv() is the simpler of the two and costs nothing here (this fixture never touches
  // any of those paths regardless of what they resolve to).
  const stdout = execFileSync(process.execPath, [USAGE_REPORT_JS, 'SPO', `--roots=${root}`], { encoding: 'utf8', env: isolatedEnv() });
  const cliOut = JSON.parse(stdout);
  const directOut = await run(['SPO', `--roots=${root}`]);

  // This pins the WIRING (argv -> run() -> console.log(JSON.stringify(...))), not the JSON shape
  // itself: both sides go through the identical formatReport, so a rounding change or a key
  // rename in formatReport moves cliOut and directOut together and this assertion stays green
  // either way. Shape coverage lives in the other tests in this file, which assert concrete
  // field values.
  assert.deepEqual(cliOut, directOut);
  assert.equal(cliOut.files, 1);
  assert.equal(cliOut.byModel_Mtokens['claude-sonnet-5'].driver.n, 1);
});

// ---- since/until window filtering still applies to the WINNING (last) occurrence's own day -----

test('--since/--until filters by the WINNING occurrence\'s own day, not the first occurrence\'s', async () => {
  // A fixture with a SINGLE occurrence cannot distinguish "filter on the first occurrence" from
  // "filter on the last" -- there is only one day to test either way, so a mutant that filtered on
  // the first occurrence would leave this test green. The id below is rewritten across a midnight
  // boundary specifically so the two semantics disagree: first occurrence is 2026-09-05, the
  // winning (last) occurrence is 2026-09-06.
  const root = mkTmp('spo-usage-report-window-');
  const projDir = path.join(root, 'projet-SPO-A');
  const line = (out, timestamp) => JSON.stringify({ message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: out } }, timestamp });
  writeSession(projDir, 'sess-1.jsonl', [
    line(10, '2026-09-05T23:59:00.000Z'),
    line(900, '2026-09-06T00:00:30.000Z'),
  ]);

  const beforeMidnight = await collect(['SPO', `--roots=${root}`, '--until=2026-09-05']);
  assert.equal(beforeMidnight.msgs, 0, 'the WINNING occurrence is 2026-09-06, so --until=2026-09-05 must exclude it even though the FIRST occurrence was in-window');

  const afterMidnight = await collect(['SPO', `--roots=${root}`, '--since=2026-09-06']);
  assert.equal(afterMidnight.byModel['claude-sonnet-5'].driver.out, 900, 'the WINNING occurrence (900, dated 2026-09-06) must be the one counted');
});
