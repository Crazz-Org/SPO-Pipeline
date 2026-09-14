'use strict';
// Coverage for resolveAnchor (test/citation-pins.js) -- action 1 of the line-number-as-truth-key
// migration. This function lands DARK in this action: nothing calls it yet (resolvePins is
// untouched), so this file is the only thing proving its behavior. Hermetic: synthetic `lines`
// arrays only, no disk I/O, no git spawns.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAnchor } = require('./citation-pins');

test('resolveAnchor: anchor found on exactly one line -> unique match', () => {
  const lines = ['const a = 1;', 'const b = 2;', 'module.exports = { a, b };'];
  const result = resolveAnchor(lines, 'const b = 2;', 2);
  assert.deepEqual(result, { line: 2, unique: true, absent: false });
});

test('resolveAnchor: anchor found on zero lines -> absent', () => {
  const lines = ['const a = 1;', 'const b = 2;'];
  const result = resolveAnchor(lines, 'const z = 99;', 1);
  assert.deepEqual(result, { line: null, unique: false, absent: true });
});

test('resolveAnchor: anchor found on two lines -> non-unique, not absent', () => {
  const lines = ['}', 'const a = 1;', '}'];
  const result = resolveAnchor(lines, '}', 1);
  assert.deepEqual(result, { line: null, unique: false, absent: false });
});

test('resolveAnchor: anchor found on three+ lines -> same non-unique shape as two lines', () => {
  const lines = ['}', 'const a = 1;', '}', 'const b = 2;', '}'];
  const result = resolveAnchor(lines, '}', 1);
  assert.deepEqual(result, { line: null, unique: false, absent: false });

  // Same shape as the two-line case -- not a distinct "how many" count anywhere in the result.
  const twoLineResult = resolveAnchor(['}', 'x', '}'], '}', 1);
  assert.deepEqual(result, twoLineResult);
});

test('resolveAnchor: matches trim leading/trailing whitespace on the line', () => {
  const lines = ['  const b = 2;  ', 'const a = 1;'];
  const result = resolveAnchor(lines, 'const b = 2;', 1);
  assert.deepEqual(result, { line: 1, unique: true, absent: false });
});

test('resolveAnchor: a line that only CONTAINS the anchor as a substring does not match', () => {
  const lines = ['const b = 2; // trailing comment', 'const a = 1;'];
  const result = resolveAnchor(lines, 'const b = 2;', 1);
  // Not a trimmed-exact match (extra trailing text attached) -- must be absent, never a loose hit.
  assert.deepEqual(result, { line: null, unique: false, absent: true });
});

test('resolveAnchor: anchorText itself is trimmed before comparison too', () => {
  const lines = ['const b = 2;', 'const a = 1;'];
  const result = resolveAnchor(lines, '  const b = 2;  ', 1);
  assert.deepEqual(result, { line: 1, unique: true, absent: false });
});

test('resolveAnchor: hintLine has zero effect on a unique-match result', () => {
  const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
  const withoutHint = resolveAnchor(lines, 'const c = 3;', undefined);
  const hintAt1 = resolveAnchor(lines, 'const c = 3;', 1);
  const hintAtRealLine = resolveAnchor(lines, 'const c = 3;', 3);
  const hintAtWrongLine = resolveAnchor(lines, 'const c = 3;', 2);

  assert.deepEqual(withoutHint, { line: 3, unique: true, absent: false });
  assert.deepEqual(hintAt1, withoutHint);
  assert.deepEqual(hintAtRealLine, withoutHint);
  assert.deepEqual(hintAtWrongLine, withoutHint);
});

test('resolveAnchor: hintLine has zero effect on a non-unique result', () => {
  const lines = ['}', 'const x = 1;', '}', 'const y = 2;', '}'];
  const withoutHint = resolveAnchor(lines, '}', undefined);
  const hintAt1 = resolveAnchor(lines, '}', 1);
  const hintAt3 = resolveAnchor(lines, '}', 3);
  const hintAt5 = resolveAnchor(lines, '}', 5);
  const hintAtUnrelatedLine = resolveAnchor(lines, '}', 2);

  assert.deepEqual(withoutHint, { line: null, unique: false, absent: false });
  assert.deepEqual(hintAt1, withoutHint);
  assert.deepEqual(hintAt3, withoutHint);
  assert.deepEqual(hintAt5, withoutHint);
  assert.deepEqual(hintAtUnrelatedLine, withoutHint);
});

test('resolveAnchor: hintLine has zero effect on an absent result', () => {
  const lines = ['const a = 1;'];
  const withoutHint = resolveAnchor(lines, 'nope', undefined);
  const hintAt1 = resolveAnchor(lines, 'nope', 1);
  const hintAt99 = resolveAnchor(lines, 'nope', 99);

  assert.deepEqual(withoutHint, { line: null, unique: false, absent: true });
  assert.deepEqual(hintAt1, withoutHint);
  assert.deepEqual(hintAt99, withoutHint);
});
