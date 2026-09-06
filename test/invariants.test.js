'use strict';
// Unit tests for orchestrator/invariants.js -- action 1.8's "invariant substring check"
// (doc/state-machine-spec.md:49), the module both handlePlan (PLAN-time baseline) and realCheck
// (CHECK-time verification) import rather than re-implement. Pure fs -- every test here uses
// fs.mkdtempSync(os.tmpdir()) as its "worktree", never a real git checkout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const {
  parseInvariantsMarkdown,
  parseLineSpec,
  isInsideWorktree,
  resolveInvariant,
  buildBaseline,
  checkRegressions,
} = require('../orchestrator/invariants');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function block(id, fileSpec, quoteLines) {
  return [`## ${id}`, `File: ${fileSpec}`, '>>> QUOTE', ...quoteLines, '>>> END QUOTE', ''].join('\n');
}

// ---- parseInvariantsMarkdown ------------------------------------------------------------------

test('parseInvariantsMarkdown: parses a single-line quote block', () => {
  const md = block('INV-1', 'src/foo.js:10', ['const x = 1;']);
  const { invariants, issues } = parseInvariantsMarkdown(md);
  assert.equal(issues.length, 0);
  assert.equal(invariants.length, 1);
  assert.deepEqual(invariants[0], {
    id: 'INV-1',
    file: 'src/foo.js',
    lineSpec: '10',
    quote: 'const x = 1;',
    declaredSpan: { start: 10, end: 10 },
  });
});

test('parseInvariantsMarkdown: parses a multi-line quote and a quote containing backticks', () => {
  const quoteLines = [
    'function foo() {',
    '  // a comment with ``` triple backticks ``` inside it',
    '  return 42;',
    '}',
  ];
  const md = ['# Invariants', '', block('INV-1', 'src/foo.js:10-14', quoteLines), '', 'Some trailing prose.', ''].join(
    '\n'
  );
  const { invariants, issues } = parseInvariantsMarkdown(md);
  assert.equal(issues.length, 0);
  assert.equal(invariants.length, 1);
  assert.equal(invariants[0].file, 'src/foo.js');
  assert.equal(invariants[0].lineSpec, '10-14');
  assert.equal(invariants[0].quote, quoteLines.join('\n'));
});

test('parseInvariantsMarkdown: parses several invariants surrounded by free prose', () => {
  const md = [
    '# Invariants',
    '',
    'Some intro text explaining the approach.',
    '',
    block('INV-1', 'a.js:1', ['alpha']),
    '',
    'A sentence between blocks.',
    '',
    block('INV-2', 'b.js:2-3', ['beta', 'gamma']),
    '',
  ].join('\n');
  const { invariants, issues } = parseInvariantsMarkdown(md);
  assert.equal(issues.length, 0);
  assert.deepEqual(
    invariants.map((i) => i.id),
    ['INV-1', 'INV-2']
  );
});

test('parseInvariantsMarkdown: zero recognized blocks is valid -- not a parse error', () => {
  const { invariants, issues } = parseInvariantsMarkdown('# Invariants\n\nNone -- new ground.\n');
  assert.deepEqual(invariants, []);
  assert.deepEqual(issues, []);
});

test('parseInvariantsMarkdown: a block missing its File: line is skipped and reported, later blocks still parse', () => {
  const md = ['## INV-1', '>>> QUOTE', 'oops no file line', '>>> END QUOTE', '', block('INV-2', 'b.js:2', ['ok'])].join(
    '\n'
  );
  const { invariants, issues } = parseInvariantsMarkdown(md);
  assert.deepEqual(
    invariants.map((i) => i.id),
    ['INV-2']
  );
  assert.ok(issues.some((i) => i.id === 'INV-1' && i.reason === 'missing-file-line'));
});

test('parseInvariantsMarkdown: a block missing its END QUOTE marker is skipped and reported', () => {
  const md = ['## INV-1', 'File: a.js:1', '>>> QUOTE', 'unterminated...', ''].join('\n');
  const { invariants, issues } = parseInvariantsMarkdown(md);
  assert.deepEqual(invariants, []);
  assert.ok(issues.some((i) => i.id === 'INV-1' && i.reason === 'missing-quote-end'));
});

test('parseInvariantsMarkdown: a CRLF invariants file parses exactly like an LF one -- every invariant, not zero', () => {
  const lf = block('INV-1', 'src/foo.js:10', ['const x = 1;']) + block('INV-2', 'src/bar.js:3', ['const y = 2;']);
  const crlf = lf.replace(/\n/g, '\r\n');
  const { invariants, issues } = parseInvariantsMarkdown(crlf);
  assert.deepEqual(issues, []);
  assert.deepEqual(
    invariants.map((i) => ({ id: i.id, file: i.file, lineSpec: i.lineSpec })),
    [
      { id: 'INV-1', file: 'src/foo.js', lineSpec: '10' },
      { id: 'INV-2', file: 'src/bar.js', lineSpec: '3' },
    ]
  );
});

test('resolveInvariant: a CRLF-quoted invariant still resolves against an LF file (normalized fallback)', () => {
  const root = mkTmp('spo-inv-crlf-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n  return 42;\n}\n');
  const r = resolveInvariant(root, { file: 'foo.js', quote: 'function foo() {\r\n  return 42;\r\n}' });
  assert.equal(r.resolved, true);
  assert.equal(r.mode, 'normalized');
});

test('parseInvariantsMarkdown: a repeated id is reported as duplicate-id and only the first is kept', () => {
  const md = [block('INV-1', 'a.js:1', ['first']), block('INV-1', 'b.js:2', ['second'])].join('\n');
  const { invariants, issues } = parseInvariantsMarkdown(md);
  assert.equal(invariants.length, 1);
  assert.equal(invariants[0].quote, 'first');
  assert.ok(issues.some((i) => i.id === 'INV-1' && i.reason === 'duplicate-id'));
});

// ---- parseLineSpec -------------------------------------------------------------------------

test('parseLineSpec: a single line number', () => {
  assert.deepEqual(parseLineSpec('123'), { start: 123, end: 123 });
});

test('parseLineSpec: a plain range', () => {
  assert.deepEqual(parseLineSpec('120-135'), { start: 120, end: 135 });
});

test('parseLineSpec: tolerates surrounding whitespace and whitespace around the dash', () => {
  assert.deepEqual(parseLineSpec(' 120 - 135 '), { start: 120, end: 135 });
  assert.deepEqual(parseLineSpec('  42  '), { start: 42, end: 42 });
});

test('parseLineSpec: tolerates an en dash or an em dash as the separator', () => {
  assert.deepEqual(parseLineSpec('120–135'), { start: 120, end: 135 });
  assert.deepEqual(parseLineSpec('120—135'), { start: 120, end: 135 });
});

test('parseLineSpec: null, empty, and non-numeric input all return null', () => {
  assert.equal(parseLineSpec(null), null);
  assert.equal(parseLineSpec(''), null);
  assert.equal(parseLineSpec('   '), null);
  assert.equal(parseLineSpec('abc'), null);
  assert.equal(parseLineSpec('12-abc'), null);
});

test('parseLineSpec: zero and negative are rejected', () => {
  assert.equal(parseLineSpec('0'), null);
  assert.equal(parseLineSpec('-5'), null);
  assert.equal(parseLineSpec('0-10'), null);
});

test('parseLineSpec: a reversed range is malformed, not silently swapped', () => {
  assert.equal(parseLineSpec('135-120'), null);
});

test('parseLineSpec: never throws on non-string input', () => {
  assert.equal(parseLineSpec(undefined), null);
  assert.equal(parseLineSpec(123), null);
  assert.equal(parseLineSpec({}), null);
  assert.equal(parseLineSpec(['120-135']), null);
});

test('parseLineSpec: a 309-digit spec overflows to Infinity on parseInt and must be rejected, not returned', () => {
  assert.equal(parseLineSpec('9'.repeat(309)), null);
});

test('parseLineSpec: a 17-digit spec past Number.MAX_SAFE_INTEGER is rejected', () => {
  assert.equal(parseLineSpec('99999999999999999'), null); // 17 nines > Number.MAX_SAFE_INTEGER
});

test('parseLineSpec: Number.MAX_SAFE_INTEGER itself is still accepted -- the fix must not over-reject', () => {
  const n = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(parseLineSpec(String(n)), { start: n, end: n });
  assert.deepEqual(parseLineSpec(`${n}-${n}`), { start: n, end: n });
});

// ---- declaredSpan on parseInvariantsMarkdown ------------------------------------------------

test('parseInvariantsMarkdown: declaredSpan is present and correct on a parsed block', () => {
  const md = block('INV-1', 'src/foo.js:120-135', ['const x = 1;']);
  const { invariants } = parseInvariantsMarkdown(md);
  assert.deepEqual(invariants[0].declaredSpan, { start: 120, end: 135 });
});

test('parseInvariantsMarkdown: declaredSpan is null when the File: line has no :line part at all', () => {
  const md = block('INV-1', 'src/foo.js', ['const x = 1;']);
  const { invariants } = parseInvariantsMarkdown(md);
  assert.equal(invariants[0].lineSpec, null);
  assert.equal(invariants[0].declaredSpan, null);
});

test('parseInvariantsMarkdown: declaredSpan is null for a garbage line spec', () => {
  const md = block('INV-1', 'src/foo.js:not-a-line', ['const x = 1;']);
  const { invariants } = parseInvariantsMarkdown(md);
  assert.equal(invariants[0].lineSpec, 'not-a-line');
  assert.equal(invariants[0].declaredSpan, null);
});

// ---- isInsideWorktree / resolveInvariant path safety -------------------------------------------

test('isInsideWorktree: rejects an absolute path and a `../`-escaping path, accepts a normal relative path', () => {
  const root = mkTmp('spo-inv-root-');
  assert.equal(isInsideWorktree(root, 'src/foo.js'), true);
  assert.equal(isInsideWorktree(root, '/etc/passwd'), false);
  assert.equal(isInsideWorktree(root, '../outside.js'), false);
  assert.equal(isInsideWorktree(root, '../../outside.js'), false);
});

test('resolveInvariant: a citation outside the worktree is never read -- unresolved, reason outside-worktree', () => {
  const root = mkTmp('spo-inv-outside-');
  // /etc/passwd certainly exists and certainly is readable -- if resolveInvariant actually read
  // it, this would not reliably report 'outside-worktree'; it must refuse before ever opening it.
  const r = resolveInvariant(root, { file: '/etc/passwd', quote: 'root' });
  assert.equal(r.resolved, false);
  assert.equal(r.reason, 'outside-worktree');
});

test('isInsideWorktree: a symlink inside the worktree pointing outside it is NOT inside -- path.resolve is lexical and does not follow links', () => {
  const root = mkTmp('spo-inv-symroot-');
  const outside = mkTmp('spo-inv-symoutside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SUPER-SECRET-TOKEN\n');
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linkfile.txt'));

  assert.equal(isInsideWorktree(root, 'link/secret.txt'), false);
  assert.equal(isInsideWorktree(root, 'linkfile.txt'), false);

  // ... and the read is actually refused, not merely mis-labelled.
  const viaDir = resolveInvariant(root, { file: 'link/secret.txt', quote: 'SUPER-SECRET-TOKEN' });
  assert.equal(viaDir.resolved, false);
  assert.equal(viaDir.reason, 'outside-worktree');
  const viaFile = resolveInvariant(root, { file: 'linkfile.txt', quote: 'SUPER-SECRET-TOKEN' });
  assert.equal(viaFile.resolved, false);
  assert.equal(viaFile.reason, 'outside-worktree');
});

test('isInsideWorktree: a path that normalizes back inside is allowed, and a sibling directory sharing the root prefix is not', () => {
  const root = mkTmp('spo-inv-normback-');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'file.ts'), 'INSIDE-QUOTE\n');
  assert.equal(isInsideWorktree(root, 'sub/../file.ts'), true);
  assert.equal(isInsideWorktree(root, './file.ts'), true);
  assert.equal(isInsideWorktree(root, '../' + path.basename(root) + '-evil/x'), false);

  const r = resolveInvariant(root, { file: 'sub/../file.ts', quote: 'INSIDE-QUOTE' });
  assert.equal(r.resolved, true);
  assert.equal(r.mode, 'exact');
});

test('resolveInvariant: a path containing a NUL byte is unreadable, never a throw out of the module', () => {
  const root = mkTmp('spo-inv-nul-');
  fs.writeFileSync(path.join(root, 'file.ts'), 'INSIDE-QUOTE\n');
  const r = resolveInvariant(root, { file: 'file.ts' + String.fromCharCode(0) + '.png', quote: 'INSIDE-QUOTE' });
  assert.equal(r.resolved, false);
  assert.equal(r.reason, 'file-unreadable');
});

test('resolveInvariant: a FIFO at the cited path returns at once instead of blocking the event loop forever', () => {
  const root = mkTmp('spo-inv-fifo-');
  try {
    require('child_process').execFileSync('mkfifo', [path.join(root, 'pipe')]);
  } catch {
    return; // no mkfifo on this platform -- nothing to assert
  }
  // A plain fs.openSync(fifo, 'r') blocks until a writer appears. This call is synchronous, so
  // that would freeze the event loop and callWithDeadline's own timer with it -- the daemon
  // would hang in CHECK with no park. It must come back, unresolved, immediately.
  const started = Date.now();
  const r = resolveInvariant(root, { file: 'pipe', quote: 'anything' });
  assert.ok(Date.now() - started < 2000, 'resolveInvariant blocked on a FIFO');
  assert.equal(r.resolved, false);
  assert.equal(r.reason, 'file-unreadable');
});

// ---- resolveInvariant matching -----------------------------------------------------------------

test('resolveInvariant: exact substring match', () => {
  const root = mkTmp('spo-inv-exact-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n  return 42;\n}\n');
  const r = resolveInvariant(root, { file: 'foo.js', quote: 'function foo() {\n  return 42;\n}' });
  assert.equal(r.resolved, true);
  assert.equal(r.mode, 'exact');
});

test('resolveInvariant: whitespace-normalized fallback matches when reflow/indentation drifted', () => {
  const root = mkTmp('spo-inv-normalized-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n    return    42;\n}\n');
  const r = resolveInvariant(root, { file: 'foo.js', quote: 'function foo() {\n  return 42;\n}' });
  assert.equal(r.resolved, true);
  assert.equal(r.mode, 'normalized');
});

test('resolveInvariant: quote genuinely absent -> unresolved, reason not-found', () => {
  const root = mkTmp('spo-inv-notfound-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n  return 42;\n}\n');
  const r = resolveInvariant(root, { file: 'foo.js', quote: 'this text is nowhere in the file' });
  assert.equal(r.resolved, false);
  assert.equal(r.reason, 'not-found');
});

test('resolveInvariant: cited file does not exist -> unresolved, reason file-unreadable', () => {
  const root = mkTmp('spo-inv-missingfile-');
  const r = resolveInvariant(root, { file: 'nope.js', quote: 'anything' });
  assert.equal(r.resolved, false);
  assert.equal(r.reason, 'file-unreadable');
});

test('resolveInvariant: empty quote is never resolved', () => {
  const root = mkTmp('spo-inv-emptyquote-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'content');
  const r = resolveInvariant(root, { file: 'foo.js', quote: '   ' });
  assert.equal(r.resolved, false);
  assert.equal(r.reason, 'empty-quote');
});

test('resolveInvariant: a cited file larger than the read cap is not fully loaded -- a quote placed past the cap is reported not-found, never a crash', () => {
  const root = mkTmp('spo-inv-cap-');
  const twoMiB = 2 * 1024 * 1024;
  const padding = Buffer.alloc(twoMiB + 4096, 'x'.charCodeAt(0));
  const quote = 'THE-QUOTE-PLACED-PAST-THE-CAP';
  const content = Buffer.concat([padding, Buffer.from('\n' + quote + '\n')]);
  fs.writeFileSync(path.join(root, 'big.js'), content);

  const r = resolveInvariant(root, { file: 'big.js', quote });
  assert.equal(r.resolved, false);
  assert.equal(r.reason, 'not-found');
});

test('resolveInvariant: the same cap does not prevent resolving a quote that sits within the capped prefix', () => {
  const root = mkTmp('spo-inv-cap-ok-');
  const quote = 'THE-QUOTE-NEAR-THE-START';
  const padding = Buffer.alloc(1024, 'y'.charCodeAt(0));
  const content = Buffer.concat([Buffer.from(quote + '\n'), padding]);
  fs.writeFileSync(path.join(root, 'small.js'), content);

  const r = resolveInvariant(root, { file: 'small.js', quote });
  assert.equal(r.resolved, true);
  assert.equal(r.mode, 'exact');
});

// ---- resolveInvariant: resolved span -------------------------------------------------------

test('resolveInvariant: span for a single-line quote at the very start of the file (line 1)', () => {
  const root = mkTmp('spo-inv-span-line1-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
  const r = resolveInvariant(root, { file: 'foo.js', quote: 'const x = 1;' });
  assert.equal(r.resolved, true);
  assert.deepEqual(r.span, { start: 1, end: 1 });
});

test('resolveInvariant: span for a single-line quote in the middle of the file', () => {
  const root = mkTmp('spo-inv-span-middle-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
  const r = resolveInvariant(root, { file: 'foo.js', quote: 'const y = 2;' });
  assert.equal(r.resolved, true);
  assert.deepEqual(r.span, { start: 2, end: 2 });
});

test('resolveInvariant: span for a multi-line quote covers every line it occupies', () => {
  const root = mkTmp('spo-inv-span-multiline-');
  fs.writeFileSync(
    path.join(root, 'foo.js'),
    'function foo() {\n  const a = 1;\n  return a;\n}\nconst tail = 1;\n'
  );
  const r = resolveInvariant(root, { file: 'foo.js', quote: '  const a = 1;\n  return a;' });
  assert.equal(r.resolved, true);
  assert.deepEqual(r.span, { start: 2, end: 3 });
});

test('resolveInvariant: a quote appearing twice in the file resolves against the FIRST occurrence', () => {
  const root = mkTmp('spo-inv-span-dup-');
  fs.writeFileSync(
    path.join(root, 'foo.js'),
    'const dup = 1;\nconst filler = 2;\nconst dup = 1;\nconst tail = 3;\n'
  );
  const r = resolveInvariant(root, { file: 'foo.js', quote: 'const dup = 1;' });
  assert.equal(r.resolved, true);
  assert.deepEqual(r.span, { start: 1, end: 1 });
});

test('resolveInvariant: span is null when only the whitespace-normalized fallback matches', () => {
  const root = mkTmp('spo-inv-span-normalized-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n    return    42;\n}\n');
  const r = resolveInvariant(root, { file: 'foo.js', quote: 'function foo() {\n  return 42;\n}' });
  assert.equal(r.resolved, true);
  assert.equal(r.mode, 'normalized');
  assert.equal(r.span, null);
});

test('resolveInvariant: span is null on every unresolved outcome', () => {
  const root = mkTmp('spo-inv-span-unresolved-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n  return 42;\n}\n');

  assert.equal(resolveInvariant(root, { file: 'foo.js', quote: 'nowhere to be found' }).span, null);
  assert.equal(resolveInvariant(root, { file: 'nope.js', quote: 'anything' }).span, null);
  assert.equal(resolveInvariant(root, { file: '/etc/passwd', quote: 'root' }).span, null);
  assert.equal(resolveInvariant(root, { file: 'foo.js', quote: '   ' }).span, null);
});

test('resolveInvariant: a quote that BEGINS with a newline starts on the line that newline ends', () => {
  const root = mkTmp('spo-inv-span-leading-nl-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
  // The quote's first character is the '\n' that terminates line 1, so the match lands at an
  // offset that is itself a line break. The span starts at the line that break ENDS (1), not at
  // the line the first visible character sits on (2) -- counting the character at the match
  // offset would silently shift every such span down by one.
  const r = resolveInvariant(root, { file: 'foo.js', quote: '\nconst y = 2;' });
  assert.equal(r.mode, 'exact');
  assert.deepEqual(r.span, { start: 1, end: 2 });
});

test("resolveInvariant: span is right in a CRLF file -- '\\r' is not itself a line break", () => {
  const root = mkTmp('spo-inv-span-crlf-');
  // A worktree checked out with CRLF endings. parseInvariantsMarkdown splits on '\n' and keeps
  // the '\r' on every line (see its own CRLF note), so a quote taken from a CRLF invariants file
  // carries CRLF too and matches exactly -- which is precisely when the line arithmetic has to
  // count '\n' only. This module has already paid once for treating '\r' as ordinary text.
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\r\nconst y = 2;\r\nconst z = 3;\r\n');
  const r = resolveInvariant(root, { file: 'foo.js', quote: 'const y = 2;\r\nconst z = 3;' });
  assert.equal(r.mode, 'exact');
  // Lines 2-3. Counting '\r' as a break too would report {start: 3, end: 5} -- past the end of a
  // 3-line file, and a span the freeze detector would then intersect against the wrong lines.
  assert.deepEqual(r.span, { start: 2, end: 3 });
});

test('resolveInvariant: a quote with a single trailing newline spans only the line it actually occupies', () => {
  const root = mkTmp('spo-inv-span-trailing-nl-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\nconst y = 2;\n');
  const invariantsPath = path.join(mkTmp('spo-inv-span-trailing-nl-scratch-'), 'invariants-1.md');
  // block() with a trailing empty quote line puts a literal blank line before '>>> END QUOTE',
  // so the parsed quote is 'const x = 1;\n' -- one trailing newline, built from real markdown,
  // never hand-constructed.
  fs.writeFileSync(invariantsPath, block('INV-1', 'foo.js:1', ['const x = 1;', '']));

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.invariants[0].resolved, true);
  assert.equal(baseline.invariants[0].mode, 'exact');
  // The quote's text lives only on line 1 -- the trailing newline terminates it, it does not
  // reach onto a second line. Before the fix this reported {start: 1, end: 2}.
  assert.deepEqual(baseline.invariants[0].span, { start: 1, end: 1 });
});

test('resolveInvariant: a quote with TWO trailing newlines spans through the blank line the second newline terminates', () => {
  const root = mkTmp('spo-inv-span-double-trailing-nl-');
  // Line 1: 'const x = 1;', line 2: blank, line 3: 'const y = 2;'.
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\n\nconst y = 2;\n');
  const invariantsPath = path.join(mkTmp('spo-inv-span-double-trailing-nl-scratch-'), 'invariants-1.md');
  // Two trailing blank quote lines -> parsed quote is 'const x = 1;\n\n' (two trailing newlines).
  fs.writeFileSync(invariantsPath, block('INV-1', 'foo.js:1-2', ['const x = 1;', '', '']));

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.invariants[0].resolved, true);
  assert.equal(baseline.invariants[0].mode, 'exact');
  // Reasoning: "a newline belongs to the line it terminates" only excuses the FINAL trailing
  // newline from extending the span (mirroring the single-trailing-newline case above). Every
  // OTHER newline in the quote, trailing or not, still terminates a real line the quote's own
  // characters occupy. Here the quote's first '\n' terminates line 1 (ordinary), and its second
  // '\n' terminates line 2 -- the blank line -- which the quote's own text reaches into (its
  // characters include that blank line's (empty) content and the newline that ends it). Only the
  // quote's OWN trailing newline, i.e. the last one, is excluded, so the span is {start: 1, end:
  // 2}, not {start: 1, end: 1} (which would silently drop the blank line the quote actually
  // spans) and not {start: 1, end: 3} (which would count the final newline as reaching a line
  // whose content the quote never touches).
  assert.deepEqual(baseline.invariants[0].span, { start: 1, end: 2 });
});

test('resolveInvariant: existing multi-line and single-line (no trailing newline) spans are unaffected by the trailing-newline fix', () => {
  const root = mkTmp('spo-inv-span-regress-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
  const single = resolveInvariant(root, { file: 'foo.js', quote: 'const y = 2;' });
  assert.deepEqual(single.span, { start: 2, end: 2 });
  const multi = resolveInvariant(root, { file: 'foo.js', quote: 'const x = 1;\nconst y = 2;' });
  assert.deepEqual(multi.span, { start: 1, end: 2 });
});

// ---- buildBaseline (PLAN time) ------------------------------------------------------------------

test('buildBaseline: resolves each invariant against the worktree and reports parseError: null', () => {
  const root = mkTmp('spo-inv-baseline-wt-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n  return 42;\n}\n');
  const invariantsPath = path.join(mkTmp('spo-inv-baseline-scratch-'), 'invariants-1.md');
  fs.writeFileSync(
    invariantsPath,
    [
      block('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}']),
      block('INV-2', 'foo.js:99', ['not actually in the file']),
    ].join('\n')
  );

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.parseError, null);
  const byId = Object.fromEntries(baseline.invariants.map((i) => [i.id, i]));
  assert.equal(byId['INV-1'].resolved, true);
  assert.equal(byId['INV-1'].mode, 'exact');
  assert.equal(byId['INV-2'].resolved, false);
});

test('buildBaseline: zero invariants -> empty array, not an error', () => {
  const root = mkTmp('spo-inv-baseline-zero-wt-');
  const invariantsPath = path.join(mkTmp('spo-inv-baseline-zero-scratch-'), 'invariants-1.md');
  fs.writeFileSync(invariantsPath, '# Invariants\n\nNone -- new ground.\n');

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.parseError, null);
  assert.deepEqual(baseline.invariants, []);
});

test('buildBaseline: a missing invariants file reports parseError, never throws', () => {
  const root = mkTmp('spo-inv-baseline-missing-wt-');
  const invariantsPath = path.join(root, 'does-not-exist.md');

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.parseError, 'invariants-file-unreadable');
  assert.deepEqual(baseline.invariants, []);
});

// The rows below are the `invariants-baseline` journal event's payload, verbatim -- handlePlan
// journals buildBaseline's return value as-is, and CHECK (and, from #112 on, the span freeze
// detector) reads it back from there. Asserting each row WHOLE, not just that the new keys are
// present, is what makes shipping `span: null` for a quote that really did resolve -- or a
// `declaredSpan` that quietly ignores the File: line -- a failure instead of a silent loss of the
// only values these rows exist to carry.
test('buildBaseline: each journalled row carries the raw lineSpec, the DECLARED span, and the RESOLVED span', () => {
  const root = mkTmp('spo-inv-baseline-rowshape-wt-');
  fs.writeFileSync(
    path.join(root, 'foo.js'),
    'const head = 0;\nfunction foo() {\n  return 42;\n}\nconst tail = 1;\n'
  );
  const invariantsPath = path.join(mkTmp('spo-inv-baseline-rowshape-scratch-'), 'invariants-1.md');
  fs.writeFileSync(
    invariantsPath,
    [
      // INV-1's File: line cites 10-12, which is NOT where the quote actually sits (2-4). The two
      // fields must not collapse into each other: `declaredSpan` is what PLAN wrote down,
      // `span` is where the quote really is in the worktree now.
      block('INV-1', 'foo.js:10-12', ['function foo() {', '  return 42;', '}']),
      block('INV-2', 'foo.js:99', ['not actually in the file']),
      block('INV-3', 'foo.js', ['const tail = 1;']),
    ].join('\n')
  );

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.parseError, null);
  assert.deepEqual(baseline.invariants, [
    {
      id: 'INV-1',
      file: 'foo.js',
      resolved: true,
      mode: 'exact',
      lineSpec: '10-12',
      declaredSpan: { start: 10, end: 12 },
      span: { start: 2, end: 4 },
    },
    {
      id: 'INV-2',
      file: 'foo.js',
      resolved: false,
      mode: null,
      lineSpec: '99',
      declaredSpan: { start: 99, end: 99 },
      span: null,
      reason: 'not-found',
    },
    {
      // No `:line` part at all on the File: line -- both span fields are null, and nothing is
      // invented from the file the quote happens to resolve in.
      id: 'INV-3',
      file: 'foo.js',
      resolved: true,
      mode: 'exact',
      lineSpec: null,
      declaredSpan: null,
      span: { start: 5, end: 5 },
    },
  ]);
});

test('buildBaseline: a normal declaredSpan survives a real JSON.parse(JSON.stringify(row)) round-trip unchanged', () => {
  const root = mkTmp('spo-inv-baseline-roundtrip-ok-wt-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\n');
  const invariantsPath = path.join(mkTmp('spo-inv-baseline-roundtrip-ok-scratch-'), 'invariants-1.md');
  fs.writeFileSync(invariantsPath, block('INV-1', 'foo.js:120-135', ['const x = 1;']));

  const baseline = buildBaseline(root, invariantsPath);
  const row = baseline.invariants[0];
  assert.deepEqual(row.declaredSpan, { start: 120, end: 135 });
  const roundTripped = JSON.parse(JSON.stringify(row));
  assert.deepEqual(roundTripped.declaredSpan, row.declaredSpan);
});

test('buildBaseline: a declaredSpan from an absurdly long line spec is null, not an object JSON silently corrupts', () => {
  // The journal is the real consumer: JSON.stringify({start: Infinity, end: Infinity}) produces
  // {"start":null,"end":null} -- a caller reading `row.declaredSpan` BEFORE the journal round-trip
  // would see a truthy object, and only AFTER re-reading it back from the journal would its fields
  // silently become null. The fix must make declaredSpan null up front, so there is nothing for
  // the round-trip to change.
  const root = mkTmp('spo-inv-baseline-roundtrip-huge-wt-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\n');
  const invariantsPath = path.join(mkTmp('spo-inv-baseline-roundtrip-huge-scratch-'), 'invariants-1.md');
  fs.writeFileSync(invariantsPath, block('INV-1', 'foo.js:' + '9'.repeat(309), ['const x = 1;']));

  const baseline = buildBaseline(root, invariantsPath);
  const row = baseline.invariants[0];
  assert.equal(row.declaredSpan, null);
  const roundTripped = JSON.parse(JSON.stringify(row));
  assert.equal(roundTripped.declaredSpan, null);
});

test('buildBaseline: an absurdly long lineSpec is bounded on the journalled row; a normal lineSpec is untouched', () => {
  const root = mkTmp('spo-inv-baseline-linespec-cap-wt-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'const x = 1;\nconst y = 2;\n');
  const invariantsPath = path.join(mkTmp('spo-inv-baseline-linespec-cap-scratch-'), 'invariants-1.md');
  const hugeSpec = '9'.repeat(200000);
  fs.writeFileSync(
    invariantsPath,
    [block('INV-1', 'foo.js:' + hugeSpec, ['const x = 1;']), block('INV-2', 'foo.js:2', ['const y = 2;'])].join('\n')
  );

  const baseline = buildBaseline(root, invariantsPath);
  const byId = Object.fromEntries(baseline.invariants.map((i) => [i.id, i]));

  // Bounded -- nowhere near the 200,000-character raw spec, regardless of the exact cap chosen.
  assert.ok(byId['INV-1'].lineSpec.length < 200, `lineSpec was not bounded: ${byId['INV-1'].lineSpec.length} chars`);
  assert.equal(byId['INV-1'].lineSpec, hugeSpec.slice(0, byId['INV-1'].lineSpec.length));
  // Too large to be a safe integer either way -- excluded from declaredSpan, never Infinity.
  assert.equal(byId['INV-1'].declaredSpan, null);

  // A normal lineSpec is not truncated or altered.
  assert.equal(byId['INV-2'].lineSpec, '2');
  assert.deepEqual(byId['INV-2'].declaredSpan, { start: 2, end: 2 });
});

// ---- checkRegressions (CHECK time) --------------------------------------------------------------

function writeInvariantsFile(dir, name, contents) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

test('checkRegressions: zero invariants in the baseline -> broken is always empty', () => {
  const root = mkTmp('spo-inv-check-zero-wt-');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-zero-scratch-'),
    'invariants-1.md',
    '# Invariants\n\nNone -- new ground.\n'
  );

  const result = checkRegressions(root, invariantsPath, []);
  assert.equal(result.parseError, null);
  assert.deepEqual(result.broken, []);
  assert.deepEqual(result.checkedIds, []);
});

test('checkRegressions: an invariant resolving at PLAN and still resolving at CHECK -> not broken', () => {
  const root = mkTmp('spo-inv-check-ok-wt-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n  return 42;\n}\n');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-ok-scratch-'),
    'invariants-1.md',
    block('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}'])
  );

  const baseline = buildBaseline(root, invariantsPath);
  const result = checkRegressions(root, invariantsPath, baseline.invariants);
  assert.equal(result.parseError, null);
  assert.deepEqual(result.broken, []);
  assert.deepEqual(result.checkedIds, ['INV-1']);
});

test('checkRegressions: the quote removed from the file between PLAN and CHECK -> broken, names the id', () => {
  const root = mkTmp('spo-inv-check-broken-wt-');
  const filePath = path.join(root, 'foo.js');
  fs.writeFileSync(filePath, 'function foo() {\n  return 42;\n}\n');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-broken-scratch-'),
    'invariants-1.md',
    block('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}'])
  );

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.invariants[0].resolved, true);

  fs.writeFileSync(filePath, 'function foo() {\n  return 99;\n}\n'); // IMPLEMENT rewrote it

  const result = checkRegressions(root, invariantsPath, baseline.invariants);
  assert.equal(result.parseError, null);
  assert.deepEqual(result.broken, [{ id: 'INV-1', file: 'foo.js' }]);
});

test('checkRegressions: the cited file deleted between PLAN and CHECK -> broken, same as a removed quote', () => {
  const root = mkTmp('spo-inv-check-deleted-wt-');
  const filePath = path.join(root, 'foo.js');
  fs.writeFileSync(filePath, 'function foo() {\n  return 42;\n}\n');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-deleted-scratch-'),
    'invariants-1.md',
    block('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}'])
  );

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.invariants[0].resolved, true);

  fs.unlinkSync(filePath);

  const result = checkRegressions(root, invariantsPath, baseline.invariants);
  assert.equal(result.parseError, null);
  assert.deepEqual(result.broken, [{ id: 'INV-1', file: 'foo.js' }]);
});

test('checkRegressions: an invariant that did NOT resolve at PLAN is excluded from the baseline -- CHECK passes even though it still does not resolve', () => {
  const root = mkTmp('spo-inv-check-excluded-wt-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n  return 42;\n}\n');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-excluded-scratch-'),
    'invariants-1.md',
    block('INV-1', 'foo.js:99', ['this text was never in foo.js'])
  );

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.invariants[0].resolved, false);

  // Still does not resolve now either -- but it was never part of the baseline, so this must
  // never be reported as broken (the false-DIAGNOSE guard this whole design exists for).
  const result = checkRegressions(root, invariantsPath, baseline.invariants);
  assert.equal(result.parseError, null);
  assert.deepEqual(result.broken, []);
  assert.deepEqual(result.checkedIds, []);
});

test('checkRegressions: exact match at PLAN, whitespace-drifted (still normalized-matching) at CHECK -> NOT a regression', () => {
  const root = mkTmp('spo-inv-check-drift-wt-');
  const filePath = path.join(root, 'foo.js');
  fs.writeFileSync(filePath, 'function foo() {\n  return 42;\n}\n');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-drift-scratch-'),
    'invariants-1.md',
    block('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}'])
  );

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.invariants[0].mode, 'exact');

  // Reflow the whitespace but keep the same tokens -- IMPLEMENT reindented around it.
  fs.writeFileSync(filePath, 'function foo() {\n    return    42;\n}\n');

  const result = checkRegressions(root, invariantsPath, baseline.invariants);
  assert.equal(result.parseError, null);
  assert.deepEqual(result.broken, []);
});

test('checkRegressions: a missing/unparsable invariants file at CHECK time -> parseError set, never a manufactured regression', () => {
  const root = mkTmp('spo-inv-check-missingfile-wt-');
  const invariantsPath = path.join(mkTmp('spo-inv-check-missingfile-scratch-'), 'invariants-1.md');
  // Never written -- simulates the file having vanished (or PLAN's baseline predating this file
  // existing at all) by CHECK time.
  const baseline = { invariants: [{ id: 'INV-1', file: 'foo.js', resolved: true, mode: 'exact' }] };

  const result = checkRegressions(root, invariantsPath, baseline.invariants);
  assert.equal(result.parseError, 'invariants-file-unreadable');
  assert.deepEqual(result.broken, []);
});

test('checkRegressions: a baseline citing a path outside the worktree stays unresolved and excluded, never read', () => {
  const root = mkTmp('spo-inv-check-outside-wt-');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-outside-scratch-'),
    'invariants-1.md',
    block('INV-1', '/etc/passwd:1', ['root'])
  );

  const baseline = buildBaseline(root, invariantsPath);
  assert.equal(baseline.invariants[0].resolved, false);
  assert.equal(baseline.invariants[0].reason, 'outside-worktree');

  const result = checkRegressions(root, invariantsPath, baseline.invariants);
  assert.deepEqual(result.broken, []);
  assert.deepEqual(result.checkedIds, []);
});

// ---- checkRegressions is unaffected by the new lineSpec/declaredSpan/span fields ------------

// checkRegressions only ever reads base.resolved, base.id, and base.file (see the module's own
// comment above it) -- the new fields buildBaseline now also writes onto each row must change
// nothing about its verdict, and a baseline journalled by an OLDER version of this module (no
// lineSpec/declaredSpan/span keys at all) must still be accepted without throwing.
function stripNewFields(rows) {
  return rows.map((row) => {
    const { lineSpec, declaredSpan, span, ...old } = row;
    return old;
  });
}

test('checkRegressions: same verdict (not-broken case) whether baseline rows carry the new fields or are old-shaped', () => {
  const root = mkTmp('spo-inv-check-shape-ok-wt-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n  return 42;\n}\n');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-shape-ok-scratch-'),
    'invariants-1.md',
    block('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}'])
  );

  const baseline = buildBaseline(root, invariantsPath);
  // The real, new-shaped rows do carry the new keys.
  assert.ok('span' in baseline.invariants[0]);
  assert.ok('declaredSpan' in baseline.invariants[0]);
  assert.ok('lineSpec' in baseline.invariants[0]);

  const newShapeResult = checkRegressions(root, invariantsPath, baseline.invariants);
  const oldShapeResult = checkRegressions(root, invariantsPath, stripNewFields(baseline.invariants));

  assert.deepEqual(newShapeResult, oldShapeResult);
  assert.deepEqual(newShapeResult.broken, []);
  assert.deepEqual(newShapeResult.checkedIds, ['INV-1']);
});

test('checkRegressions: same verdict (broken case) whether baseline rows carry the new fields or are old-shaped', () => {
  const root = mkTmp('spo-inv-check-shape-broken-wt-');
  const filePath = path.join(root, 'foo.js');
  fs.writeFileSync(filePath, 'function foo() {\n  return 42;\n}\n');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-shape-broken-scratch-'),
    'invariants-1.md',
    block('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}'])
  );

  const baseline = buildBaseline(root, invariantsPath);
  fs.writeFileSync(filePath, 'function foo() {\n  return 99;\n}\n'); // IMPLEMENT rewrote it

  const newShapeResult = checkRegressions(root, invariantsPath, baseline.invariants);
  const oldShapeResult = checkRegressions(root, invariantsPath, stripNewFields(baseline.invariants));

  assert.deepEqual(newShapeResult, oldShapeResult);
  assert.deepEqual(newShapeResult.broken, [{ id: 'INV-1', file: 'foo.js' }]);
});

test('checkRegressions: an old-shaped baseline row (no lineSpec/declaredSpan/span keys at all) is accepted without throwing', () => {
  const root = mkTmp('spo-inv-check-oldshape-wt-');
  fs.writeFileSync(path.join(root, 'foo.js'), 'function foo() {\n  return 42;\n}\n');
  const invariantsPath = writeInvariantsFile(
    mkTmp('spo-inv-check-oldshape-scratch-'),
    'invariants-1.md',
    block('INV-1', 'foo.js:1-3', ['function foo() {\n  return 42;\n}'])
  );

  // Hand-shaped exactly like a row journalled by the pre-span version of buildBaseline -- a real
  // in-flight card's PLAN-time journal entry looks like this today.
  const oldBaseline = [{ id: 'INV-1', file: 'foo.js', resolved: true, mode: 'exact' }];

  const result = checkRegressions(root, invariantsPath, oldBaseline);
  assert.equal(result.parseError, null);
  assert.deepEqual(result.broken, []);
  assert.deepEqual(result.checkedIds, ['INV-1']);
});
