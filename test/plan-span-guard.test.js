'use strict';
// Unit tests for orchestrator/plan-span-guard.js -- issue #112's "PLAN freezes a span its own
// plan orders changed" detector. Every extractPlanSpans/detectSpanConflicts case here is built
// from real markdown TEXT and put through the module, never a hand-constructed {start,end} fed
// straight to the code under test -- the derivation from prose to a span is the thing this suite
// exists to prove. Invariant baseline ROWS are the one exception: they are the module's declared
// INPUT shape (mirroring orchestrator/invariants.js's resolveAll output), not something this
// module derives, so they are built directly, exactly like test/invariants.test.js does.

const test = require('node:test');
const assert = require('node:assert/strict');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live pool
// credentials from inside this test suite -- see test/no-real-spawn.js. Must land before the
// orchestrator require below even though this module itself never spawns.
require('./no-real-spawn');
const { normalizePath, extractPlanSpans, detectSpanConflicts } = require('../orchestrator/plan-span-guard');

// ---- normalizePath ------------------------------------------------------------------------------

test('normalizePath: strips a given worktreeRoot prefix (plus separator)', () => {
  const root = '/home/crazz/.spo-worktrees/issue-900';
  assert.equal(normalizePath(root + '/src/foo.js', root), 'src/foo.js');
});

test('normalizePath: worktreeRoot with a trailing slash is tolerated', () => {
  const root = '/home/crazz/.spo-worktrees/issue-900/';
  assert.equal(normalizePath('/home/crazz/.spo-worktrees/issue-900/src/foo.js', root), 'src/foo.js');
});

test('normalizePath: falls back to stripping the legacy in-repo worktree prefix when no worktreeRoot is given', () => {
  assert.equal(
    normalizePath('/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/foo.tsx', undefined),
    'src/client/foo.tsx'
  );
});

test('normalizePath: falls back to stripping the legacy ~/.spo-worktrees prefix when no worktreeRoot is given', () => {
  assert.equal(
    normalizePath('/home/crazz/.spo-worktrees/issue-487/src/client/foo.tsx', null),
    'src/client/foo.tsx'
  );
});

test('normalizePath: worktreeRoot takes priority over the legacy prefix when both could apply', () => {
  const p = '/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/foo.tsx';
  assert.equal(normalizePath(p, '/home/crazz/SPO-Pipeline/worktrees/issue-488'), 'src/client/foo.tsx');
});

test('normalizePath: strips a leading "./" when neither worktreeRoot nor a legacy prefix applies', () => {
  assert.equal(normalizePath('./src/foo.js', undefined), 'src/foo.js');
});

test('normalizePath: a plain relative path with no prefix at all passes through unchanged', () => {
  assert.equal(normalizePath('src/foo.js', undefined), 'src/foo.js');
});

test('normalizePath: trims surrounding whitespace and a pair of surrounding backticks', () => {
  assert.equal(normalizePath('  `src/foo.js`  ', undefined), 'src/foo.js');
});

test('normalizePath: a non-string input returns null, never throws', () => {
  assert.equal(normalizePath(undefined, undefined), null);
  assert.equal(normalizePath(null, undefined), null);
  assert.equal(normalizePath(123, undefined), null);
  assert.equal(normalizePath({}, undefined), null);
  assert.equal(normalizePath(['a.js'], undefined), null);
});

// ---- extractPlanSpans: the three required syntaxes ----------------------------------------------

test('extractPlanSpans: path-attached citation (#488 shape)', () => {
  const md =
    "The Curriculum section's current-level card " +
    '(`/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/components/empire/ProfilePanel.tsx:293-311`) ' +
    'renders only the header';
  const spans = extractPlanSpans(md, undefined);
  assert.deepEqual(spans, [
    {
      file: 'src/client/components/empire/ProfilePanel.tsx',
      start: 293,
      end: 311,
      line: 1,
      syntax: 'path',
    },
  ]);
});

test('extractPlanSpans: bare-colon citation under a path-bearing heading (#487 shape)', () => {
  const md = [
    '### 4. `/home/crazz/SPO-Pipeline/worktrees/issue-487/src/client/components/empire/ProfilePanel.tsx`',
    '',
    'In `CurriculumTab` (Section 1, the `statGrid` at `:223-228`), when `data.tournamentOn`:',
  ].join('\n');
  const spans = extractPlanSpans(md, undefined);
  assert.deepEqual(spans, [
    {
      file: 'src/client/components/empire/ProfilePanel.tsx',
      start: 223,
      end: 228,
      line: 3,
      syntax: 'bare',
    },
  ]);
});

test('extractPlanSpans: prose citation with a same-line path and no heading at all (#508 shape)', () => {
  const md =
    'The read view of `/home/crazz/SPO-Pipeline/worktrees/issue-508/src/client/components/mail/MailPanel.tsx` ' +
    '(lines 236-245) chooses between two buttons';
  const spans = extractPlanSpans(md, undefined);
  assert.deepEqual(spans, [
    {
      file: 'src/client/components/mail/MailPanel.tsx',
      start: 236,
      end: 245,
      line: 1,
      syntax: 'prose',
    },
  ]);
});

test('extractPlanSpans: a malformed heading naming TWO paths attributes to the SECOND (correct) one, not just the first', () => {
  // #488 shape: the heading's first path is a typo'd directory ("worktrides"), its second path
  // (after the em dash correction) is the real file. "First path wins" would attribute the bare
  // span below to the typo'd directory and miss the real file entirely.
  const md = [
    '### 3. `/home/crazz/SPO-Pipeline/worktrides/issue-488` — correction: the client file is ' +
      '`/home/crazz/SPO-Pipeline/worktrees/issue-488/src/client/components/empire/ProfilePanel.tsx`',
    '',
    'Update the effect so it reads `data.currentLevel` (`:301-309`) before rendering.',
  ].join('\n');
  const spans = extractPlanSpans(md, undefined);
  const files = spans.filter((s) => s.start === 301 && s.end === 309).map((s) => s.file);
  assert.ok(
    files.includes('src/client/components/empire/ProfilePanel.tsx'),
    `expected the real (second) path among ${JSON.stringify(files)}`
  );
});

test('extractPlanSpans: a heading that carries its own bare-colon span (#491 shape)', () => {
  const md =
    '### 1. `/home/crazz/SPO-Pipeline/worktrees/issue-491/src/shared/types/domain-types.ts` — ' +
    '`ProfitLossNode` (:906-913)';
  const spans = extractPlanSpans(md, undefined);
  assert.deepEqual(spans, [
    { file: 'src/shared/types/domain-types.ts', start: 906, end: 913, line: 1, syntax: 'bare' },
  ]);
});

// ---- dashes and bold ------------------------------------------------------------------------

test('extractPlanSpans: an en dash and an em dash both work as the path-attached colon-range separator', () => {
  const enDash = extractPlanSpans('See `src/foo.js:120–135` for the change.', undefined);
  const emDash = extractPlanSpans('See `src/bar.js:100—115` for the change.', undefined);
  assert.deepEqual(enDash, [{ file: 'src/foo.js', start: 120, end: 135, line: 1, syntax: 'path' }]);
  assert.deepEqual(emDash, [{ file: 'src/bar.js', start: 100, end: 115, line: 1, syntax: 'path' }]);
});

test('extractPlanSpans: an en dash and an em dash both work as the prose "lines N-M" separator', () => {
  const enDash = extractPlanSpans('In `src/foo.js`, see lines 51–52 for context.', undefined);
  const emDash = extractPlanSpans('In `src/foo.js`, see lines 60—65 for context.', undefined);
  assert.deepEqual(enDash, [{ file: 'src/foo.js', start: 51, end: 52, line: 1, syntax: 'prose' }]);
  assert.deepEqual(emDash, [{ file: 'src/foo.js', start: 60, end: 65, line: 1, syntax: 'prose' }]);
});

test('extractPlanSpans: a bolded, capitalized "**Lines N-M**" citation is still recognized', () => {
  const md = 'In `src/baz.js`, **Lines 51-52** must stay intact.';
  const spans = extractPlanSpans(md, undefined);
  assert.deepEqual(spans, [{ file: 'src/baz.js', start: 51, end: 52, line: 1, syntax: 'prose' }]);
});

// ---- negatives: things that must NEVER be captured as a span -----------------------------------

test('extractPlanSpans: a clock time, a CSS declaration, an IPv4:port, and a coverage ratio never produce a span', () => {
  const lines = [
    '`cron.js` fires the job at 07:44 daily.',
    'Update the CSS: color: 15px for emphasis.',
    'Latency measured at 158.69.153.134:6379 remains high.',
    'Branch coverage sits at 0:1 for this module.',
  ];
  for (const line of lines) {
    assert.deepEqual(extractPlanSpans(line, undefined), [], `expected no span from: ${line}`);
  }
});

test('extractPlanSpans: a bare span with no ancestor path heading and no same-line path is dropped, not mis-attributed', () => {
  const md = 'Also confirm the fix (:10-20) still applies.';
  assert.deepEqual(extractPlanSpans(md, undefined), []);
});

test('extractPlanSpans: a plan with no headings still attributes via a same-line path (restates the #508 case explicitly)', () => {
  const md = 'The read view of `src/x.js` (lines 5-9) is affected.';
  const spans = extractPlanSpans(md, undefined);
  assert.deepEqual(spans, [{ file: 'src/x.js', start: 5, end: 9, line: 1, syntax: 'prose' }]);
});

// ---- single-number citations ------------------------------------------------------------------

test('extractPlanSpans: a single-number citation means start === end, for every syntax', () => {
  const pathForm = extractPlanSpans('See `src/a.js:42` now.', undefined);
  assert.deepEqual(pathForm, [{ file: 'src/a.js', start: 42, end: 42, line: 1, syntax: 'path' }]);

  const proseForm = extractPlanSpans('In `src/b.js`, line 7 changed.', undefined);
  assert.deepEqual(proseForm, [{ file: 'src/b.js', start: 7, end: 7, line: 1, syntax: 'prose' }]);
});

// ---- malformed ranges -----------------------------------------------------------------------

test('extractPlanSpans: a reversed range (end < start) is rejected, not silently swapped', () => {
  assert.deepEqual(extractPlanSpans('See `src/a.js:135-120` now.', undefined), []);
});

// ---- overlap arithmetic (via detectSpanConflicts) -----------------------------------------------

function pathCitation(file, start, end) {
  return `See \`${file}:${start}-${end}\` for the change.`;
}

function invariantRow(id, file, span) {
  return { id, file, resolved: true, mode: 'exact', lineSpec: null, declaredSpan: null, span };
}

test('detectSpanConflicts: exact equality overlaps', () => {
  const md = pathCitation('src/a.js', 100, 120);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 100, end: 120 })],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'INV-1');
});

test('detectSpanConflicts: plan span strictly contains the invariant span -- overlaps', () => {
  const md = pathCitation('src/a.js', 100, 120);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 105, end: 110 })],
  });
  assert.equal(findings.length, 1);
});

test('detectSpanConflicts: invariant span strictly contains the plan span -- overlaps', () => {
  const md = pathCitation('src/a.js', 100, 120);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 90, end: 130 })],
  });
  assert.equal(findings.length, 1);
});

test('detectSpanConflicts: partial overlap on one side -- overlaps', () => {
  const md = pathCitation('src/a.js', 105, 120);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 100, end: 110 })],
  });
  assert.equal(findings.length, 1);
});

test('detectSpanConflicts: adjacent-but-disjoint ranges (223-228 vs 229-233) do NOT overlap', () => {
  const md = pathCitation('src/a.js', 229, 233);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 223, end: 228 })],
  });
  assert.deepEqual(findings, []);
});

test('detectSpanConflicts: off-by-one -- sharing exactly one boundary line overlaps, one line further apart does not', () => {
  const touching = detectSpanConflicts({
    planMarkdown: pathCitation('src/a.js', 121, 130),
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 100, end: 121 })],
  });
  assert.equal(touching.length, 1, 'sharing line 121 must overlap');

  const disjointByOne = detectSpanConflicts({
    planMarkdown: pathCitation('src/a.js', 122, 130),
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 100, end: 121 })],
  });
  assert.deepEqual(disjointByOne, [], 'one line further apart must not overlap');
});

test('detectSpanConflicts: no plan span at all on the invariant\'s file -- no finding', () => {
  const md = pathCitation('src/other.js', 100, 120);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 100, end: 120 })],
  });
  assert.deepEqual(findings, []);
});

test('detectSpanConflicts: file comparison is strict equality after normalization -- no basename fallback', () => {
  const md = pathCitation('other/dir/a.js', 100, 120);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 100, end: 120 })],
  });
  assert.deepEqual(findings, []);
});

// ---- resolved span vs declaredSpan: the resolved one wins ---------------------------------------

test('detectSpanConflicts: the RESOLVED span wins over declaredSpan when they disagree', () => {
  const md = pathCitation('src/a.js', 200, 210);
  // The resolved span (where the quote now actually sits) does NOT overlap the plan's change --
  // only the stale declaredSpan (what PLAN originally wrote in the File: line) would. Using
  // declaredSpan here would wrongly produce a finding.
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [
      { id: 'INV-1', file: 'src/a.js', resolved: true, mode: 'exact', lineSpec: '200-210', declaredSpan: { start: 200, end: 210 }, span: { start: 50, end: 60 } },
    ],
  });
  assert.deepEqual(findings, []);
});

test('detectSpanConflicts: falls back to declaredSpan only when span is null', () => {
  const md = pathCitation('src/a.js', 200, 210);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [
      { id: 'INV-1', file: 'src/a.js', resolved: false, mode: null, lineSpec: '200-210', declaredSpan: { start: 200, end: 210 }, span: null },
    ],
  });
  assert.equal(findings.length, 1);
});

// ---- old-shaped baseline rows ------------------------------------------------------------------

test('detectSpanConflicts: an old-shaped row (no span/declaredSpan keys at all) produces no finding and never throws', () => {
  const md = pathCitation('src/a.js', 100, 120);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [{ id: 'INV-1', file: 'src/a.js', resolved: true, mode: 'exact' }],
  });
  assert.deepEqual(findings, []);
});

// ---- first-by-line, no duplicates ----------------------------------------------------------------

test('detectSpanConflicts: several overlapping plan spans on the same file -- keeps the FIRST by plan line, one finding per invariant', () => {
  const md = [pathCitation('src/a.js', 100, 120), pathCitation('src/a.js', 105, 125)].join('\n');
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [invariantRow('INV-1', 'src/a.js', { start: 110, end: 115 })],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].planLine, 1);
  assert.deepEqual(findings[0].planSpan, { start: 100, end: 120 });
});

// ---- bounded output -------------------------------------------------------------------------

test('extractPlanSpans: a pathological plan cannot produce an unbounded span list', () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) {
    lines.push(`In `.concat('`src/f', String(i), '.js`, line ', String(i + 1), ' changed.'));
  }
  const spans = extractPlanSpans(lines.join('\n'), undefined);
  assert.ok(spans.length < 5000, `expected a capped span count, got ${spans.length}`);
  assert.equal(spans.length, 2000, 'cap should be hit exactly at the documented MAX_PLAN_SPANS');
});

test('detectSpanConflicts: a pathological number of overlapping invariants cannot produce an unbounded finding list', () => {
  const md = pathCitation('src/a.js', 1, 1000000);
  const invariants = [];
  for (let i = 0; i < 500; i++) {
    invariants.push(invariantRow(`INV-${i}`, 'src/a.js', { start: 10, end: 20 }));
  }
  const findings = detectSpanConflicts({ planMarkdown: md, invariants });
  assert.ok(findings.length < 500, `expected a capped finding count, got ${findings.length}`);
  assert.equal(findings.length, 200, 'cap should be hit exactly at the documented MAX_FINDINGS');
});

// ---- the two caps that had no test of their own --------------------------------------------------

test('extractPlanSpans: MAX_SCAN_LINE_LENGTH is enforced -- a citation past the cap on one huge line is dropped', () => {
  // Kills "scan the whole raw line". The single-line-plan test below cannot catch this on its own:
  // truncation the colon scanner backtracks over megabytes and the suite HANGS rather than failing
  // its timing assertion. This pins the cap directly, in milliseconds, from both sides.
  const withinCap = 'x'.repeat(19000) + ' see `src/a.js:10-20` here';
  assert.deepEqual(extractPlanSpans(withinCap, undefined), [
    { file: 'src/a.js', start: 10, end: 20, line: 1, syntax: 'path' },
  ]);
  const pastCap = 'x'.repeat(20050) + ' see `src/a.js:10-20` here';
  assert.deepEqual(extractPlanSpans(pastCap, undefined), []);
});

test('detectSpanConflicts: MAX_FIELD_LENGTH truncates an absurd invariant id in the finding', () => {
  // Kills "copy inv.id through untruncated". A finding is destined for a 65536-char GitHub comment;
  // the cap exists so one malformed baseline row cannot consume it.
  const findings = detectSpanConflicts({
    planMarkdown: pathCitation('src/a.js', 10, 20),
    invariants: [invariantRow('I'.repeat(900), 'src/a.js', { start: 10, end: 20 })],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id.length, 500);
});

// ---- robustness: never throws, for any input ----------------------------------------------------

test('extractPlanSpans: never throws on null, undefined, or a non-string markdown', () => {
  assert.deepEqual(extractPlanSpans(null, undefined), []);
  assert.deepEqual(extractPlanSpans(undefined, undefined), []);
  assert.deepEqual(extractPlanSpans(12345, undefined), []);
  assert.deepEqual(extractPlanSpans({}, undefined), []);
  assert.deepEqual(extractPlanSpans([], undefined), []);
  assert.deepEqual(extractPlanSpans('', undefined), []);
});

test('detectSpanConflicts: never throws on null, undefined, or a malformed options object', () => {
  assert.deepEqual(detectSpanConflicts(null), []);
  assert.deepEqual(detectSpanConflicts(undefined), []);
  assert.deepEqual(detectSpanConflicts({}), []);
  assert.deepEqual(detectSpanConflicts({ planMarkdown: 42, invariants: 'nope' }), []);
});

test('detectSpanConflicts: an invariants array full of non-object entries is skipped entry-by-entry, never throws', () => {
  const md = pathCitation('src/a.js', 100, 120);
  const findings = detectSpanConflicts({
    planMarkdown: md,
    invariants: [null, undefined, 42, 'a string', [], invariantRow('INV-1', 'src/a.js', { start: 100, end: 120 })],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'INV-1');
});

test('extractPlanSpans: a 200 KB single-line plan does not hang and does not throw', () => {
  // 200 KB is 10x MAX_SCAN_LINE_LENGTH -- far enough past the cap to prove it is the cap that
  // keeps a pathological single-line plan cheap, and small enough that a REGRESSION here FAILS
  // this test instead of stalling it. This was 5 MB, which could only ever pass or hang: the
  // timing assertion is evaluated after extractPlanSpans returns, and with the truncation removed
  // the colon scanner backtracks over megabytes and never returns -- so a MAX_SCAN_LINE_LENGTH
  // regression stalled `node --test test/*.test.js` rather than failing it. A gate that hangs is
  // not a gate. The cap itself is asserted directly, from both sides, in the cap test above.
  const filler = 'x'.repeat(200 * 1024);
  const md = filler + ' see `src/a.js:10-20` at the very end';
  const started = Date.now();
  const spans = extractPlanSpans(md, undefined);
  assert.ok(Date.now() - started < 5000, 'a 200 KB single-line plan must not hang');
  assert.ok(Array.isArray(spans));
});

test('extractPlanSpans: a 100k-line plan finishes quickly and still finds real spans anywhere in it', () => {
  const lines = [];
  for (let i = 0; i < 100000; i++) {
    if (i === 50000) {
      lines.push('See `src/mid.js:10-20` for the change.');
    } else {
      lines.push(`Filler prose line number ${i} with nothing special in it.`);
    }
  }
  const started = Date.now();
  const spans = extractPlanSpans(lines.join('\n'), undefined);
  assert.ok(Date.now() - started < 5000, 'a 100k-line plan must not be quadratic');
  assert.deepEqual(
    spans.filter((s) => s.file === 'src/mid.js'),
    [{ file: 'src/mid.js', start: 10, end: 20, line: 50001, syntax: 'path' }]
  );
});

test('detectSpanConflicts: many invariants against a large plan on the same file stays fast -- not O(invariants x lines)', () => {
  const lines = [];
  for (let i = 0; i < 1500; i++) {
    lines.push(pathCitation('src/a.js', i * 100, i * 100 + 10));
  }
  const invariants = [];
  for (let i = 0; i < 300; i++) {
    invariants.push(invariantRow(`INV-${i}`, 'src/a.js', { start: i * 100 + 5, end: i * 100 + 6 }));
  }
  const started = Date.now();
  const findings = detectSpanConflicts({ planMarkdown: lines.join('\n'), invariants });
  assert.ok(Date.now() - started < 5000, 'must not be quadratic in invariants x plan spans');
  assert.equal(findings.length, 200); // capped, but proves the scan actually ran and matched
});

// ---- attribution: every path in the heading, nearest path on the line ----------------------------
// Added by adversarial verification of #112. Each test below kills a mutation that the suite above
// left alive; the mutation it kills is named in its own comment. Same discipline as the rest of the
// file: real plan markdown goes in, spans and findings come out -- nothing hand-derives a span.

test('extractPlanSpans: a heading naming TWO real files attributes a bare span to BOTH, not just one end of the list', () => {
  // Kills "attribute to the LAST heading path only" (and the mirror, "the FIRST only"). The #488
  // test above only pins that the SECOND path is reachable, which a last-one-wins bug satisfies by
  // accident; a heading that names a file and its mirror is the shape that tells them apart.
  const md = [
    '### 2. `src/client/store/mail-store.ts` and its mirror `src/shared/types/index.ts`',
    '',
    'Both gain the `composeFocusTo` field at `:10-20`.',
  ].join('\n');
  const files = extractPlanSpans(md, undefined)
    .filter((s) => s.start === 10 && s.end === 20)
    .map((s) => s.file)
    .sort();
  assert.deepEqual(files, ['src/client/store/mail-store.ts', 'src/shared/types/index.ts']);
});

test('extractPlanSpans: two paths on one line -- the span attributes to the NEAREST one earlier on the line, not the first', () => {
  // Kills "take before[0] instead of before[before.length - 1]". "Move X out of A and into B at
  // lines N-M" is the ordinary way a plan describes a move, and it is A that must NOT be flagged.
  const md =
    'Move the guard out of `src/server/old-handler.ts` and into `src/server/new-handler.ts` at lines 40-52.';
  assert.deepEqual(extractPlanSpans(md, undefined), [
    { file: 'src/server/new-handler.ts', start: 40, end: 52, line: 1, syntax: 'prose' },
  ]);
});

test('extractPlanSpans: a path-less SUBSECTION heading still inherits the enclosing section\'s file', () => {
  // Kills "clear headingPaths on any path-less heading". A deeper heading is a true ancestor chain:
  // `#### Change A` under `### 1. <file>` is still talking about that file, and clearing there would
  // silently drop every bare-colon span in a plan that uses subsections.
  const md = [
    '### 1. `src/client/store/mail-store.ts`',
    '',
    '#### Change A — the reducer',
    '',
    'Rewrite the branch at `:10-20` so it clears the draft.',
  ].join('\n');
  assert.deepEqual(extractPlanSpans(md, undefined), [
    { file: 'src/client/store/mail-store.ts', start: 10, end: 20, line: 5, syntax: 'bare' },
  ]);
});

test('extractPlanSpans: a URL earlier on the line does not steal attribution from the heading\'s file', () => {
  // A URL is path-shaped (it contains "/") but is never a repo path. Attribution rule 2 takes the
  // NEAREST path-looking token earlier on the line, so before the '://' exclusion this span was
  // attributed to `https://github.com/x/y` and `src/foo.ts` -- the file the plan is actually about
  // -- never received it. A false negative costs a whole DIAGNOSE/IMPLEMENT cycle, so this is the
  // expensive direction of the two.
  const md = [
    '### 4. `src/foo.ts`',
    '',
    'Per https://github.com/x/y the block at lines 223-228 changes.',
  ].join('\n');
  assert.deepEqual(extractPlanSpans(md, undefined), [
    { file: 'src/foo.ts', start: 223, end: 228, line: 3, syntax: 'prose' },
  ]);
});

test('extractPlanSpans: a SIBLING path-less heading ENDS the previous section\'s file context (the #509 shape)', () => {
  // The real card-509 shape, verbatim in structure: `### 3. Tests` is a sibling of
  // `### 2. <file>`, not a subsection of it, and the `:258-280` under it belongs to the test file
  // named two lines above -- NOT to the MailPanel.tsx of section 2. Carrying the context across a
  // sibling heading attributes that span to the wrong file, and a wrong-file flag is the one error
  // this design cannot absorb: it is consulted only when its invariant breaks at CHECK, so it can
  // relieve a break the plan never ordered. Together with the subsection test above, this pins
  // both halves of "nearest ANCESTOR heading": deeper inherits, same-or-shallower clears.
  const md = [
    '### 2. `src/client/components/mail/MailPanel.tsx`',
    '',
    'Add the `Forward` button beside `Reply`.',
    '',
    '### 3. Tests',
    '',
    '`src/client/components/__tests__/mail-compose-integration.test.tsx` (component, jsdom):',
    '- Draft folder: `Forward` absent (extend the existing draft test at `:258-280` with one',
    '  `queryByRole` assertion).',
  ].join('\n');
  const spans = extractPlanSpans(md, undefined);
  assert.deepEqual(
    spans.filter((s) => s.start === 258 && s.end === 280).map((s) => s.file),
    [],
    'the `:258-280` under `### 3. Tests` must not be attributed to section 2\'s MailPanel.tsx'
  );
  assert.deepEqual(
    detectSpanConflicts({
      planMarkdown: md,
      invariants: [invariantRow('INV-3', 'src/client/components/mail/MailPanel.tsx', { start: 272, end: 276 })],
    }),
    [],
    'INV-3 sits at 272-276, inside 258-280 -- it must not be flagged off another file\'s span'
  );
});

test('extractPlanSpans: a heading whose only "path-shaped" tokens are numbers sets no attribution context', () => {
  // Kills "drop the letter requirement from looksLikePath". "### 1." and a decimal like "2.5" both
  // match the filename-with-extension shape on digits alone; if either counted as a path, every
  // numbered section heading in every plan would start attributing bare spans to a file named "1".
  const md = ['### 1. Raise the cap to 2.5 for every tier', '', 'Change the block at `:10-20`.'].join('\n');
  assert.deepEqual(extractPlanSpans(md, undefined), []);
});

// ---- the bare-colon prev-char guard --------------------------------------------------------------

test('extractPlanSpans: a space before the colon is NOT a bare-colon citation ("at :30" is prose, not a line range)', () => {
  // Kills "remove the prev-char guard". This is the guard's whole purpose and nothing above pinned
  // it: the CSS/clock negatives pass either way because they are unattributed and dropped anyway.
  // Here the heading DOES supply attribution, so without the guard "at :30" becomes a real span and
  // a real finding against an invariant frozen a couple of lines away.
  const md = [
    '### 1. `src/cron/schedule.ts`',
    '',
    'The sweep already fires on the hour and again at :30 past it; keep that cadence.',
  ].join('\n');
  assert.deepEqual(extractPlanSpans(md, undefined), []);
  assert.deepEqual(
    detectSpanConflicts({
      planMarkdown: md,
      invariants: [invariantRow('INV-1', 'src/cron/schedule.ts', { start: 28, end: 32 })],
    }),
    []
  );
});
