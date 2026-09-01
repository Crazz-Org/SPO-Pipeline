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
  assert.deepEqual(invariants[0], { id: 'INV-1', file: 'src/foo.js', lineSpec: '10', quote: 'const x = 1;' });
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
