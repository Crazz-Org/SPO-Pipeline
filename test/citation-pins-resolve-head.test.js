'use strict';
// Coverage for resolvePins' `at: 'HEAD'` inverted-model path (test/citation-pins.js) -- action 3
// of the line-number-as-truth-key migration (#206). Action 1 landed resolveAnchor (dark, nothing
// called it); this action wires it into resolvePins for `at: 'HEAD'` pins only. The `at: '<sha>'`
// path is untouched by this action -- see this file's own header note below for why it is not
// re-tested here (citation-verifier.test.js and doc-constant-sweep.test.js already cover it, and
// the diff itself proves the sha branch's source lines were not touched).
//
// Two kinds of coverage:
//   1. Hermetic fixtures (a temp directory, no git spawn) exercising every branch of the new
//      algorithm in isolation: unique match + correction, ambiguous-fallback success (and its
//      "never reports a correction" rule), ambiguous-fallback failure, anchor-absent failure, the
//      ordering guard, and the claim check against the RESOLVED span.
//   2. The concrete thesis of this action, against the REAL corpus: replay five historical drifts
//      this repo's git log already lived through (a pin's line number moved, its text did not) by
//      constructing pins at the OLD, pre-shift citation numbers with the SAME (current) anchor
//      text, and proving resolvePins now resolves them ok: true with a `correction` pointing at
//      today's real line -- plus a real-absence case proving the failure side still works.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolvePins } = require('./citation-pins');
const { mkTmp } = require('./helpers');

// ---- hermetic fixtures ---------------------------------------------------------------------
//
// Every fixture citation includes a "/" in its file path (e.g. "sub/a.js") so resolveCitationTarget
// resolves it via the direct fs.existsSync branch of resolveIn, never the git-ls-files/basename
// search -- no git init needed for a temp fixture dir. mkTmp (test/helpers.js) is the only door
// onto an os.tmpdir() directory in this suite -- it registers the directory for a sweep at exit,
// same as every other temp-dir-using test file.

function mkFixtureRoot() {
  const dir = mkTmp('citation-pins-head-');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  return dir;
}

function writeFixture(root, name, contentLines) {
  fs.writeFileSync(path.join(root, 'sub', name), contentLines.join('\n') + '\n', 'utf8');
}

function roots(root) {
  // product/deploy point at directories that do not exist -- fine, since every fixture citation
  // resolves in `repo` and resolveCitationTarget never reaches the product/deploy branches once
  // the local (repo) resolution already succeeded.
  return { repo: root, product: path.join(root, '__no-product__'), deploy: path.join(root, '__no-deploy__') };
}

test('HEAD pin: unique anchor moved -- resolves ok with a correction pointing at the real line', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'a.js', ['line one', 'line two', 'TARGET TEXT', 'line four']);
  const pin = { file: 'sub/a.js', citation: 'sub/a.js:99', at: 'HEAD', first: 'TARGET TEXT' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, true);
  assert.equal(result.actualFirst, 'TARGET TEXT');
  assert.deepEqual(result.correction, { file: 'sub/a.js', start: 3, stop: 3, citation: 'sub/a.js:3' });
});

test('HEAD pin: unique anchor at the originally-cited position -- resolves ok with NO correction', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'b.js', ['line one', 'TARGET TEXT', 'line three']);
  const pin = { file: 'sub/b.js', citation: 'sub/b.js:2', at: 'HEAD', first: 'TARGET TEXT' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, true);
  assert.equal('correction' in result, false, 'a pin already at its true position must not carry a `correction` key at all');
});

test('HEAD pin: anchor text absent everywhere -- hard fail, absent-style reason', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'c.js', ['line one', 'line two']);
  const pin = { file: 'sub/c.js', citation: 'sub/c.js:1', at: 'HEAD', first: 'THIS TEXT DOES NOT EXIST ANYWHERE' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, false);
  assert.match(result.why, /was not found anywhere/);
  assert.match(result.why, /deleted or rewritten/);
  assert.equal('correction' in result, false);
});

test('HEAD pin: ambiguous anchor, originally-cited line still holds it -- ambiguous-fallback success, no correction', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'd.js', ['}', 'const mid = 1;', '}']);
  // '}' appears on lines 1 and 3 -- ambiguous. Originally cited at line 1, which DOES hold '}'.
  const pin = { file: 'sub/d.js', citation: 'sub/d.js:1', at: 'HEAD', first: '}' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, true);
  assert.equal(result.actualFirst, '}');
  assert.equal('correction' in result, false, 'ambiguous-fallback resolution must never report a correction');
});

test('HEAD pin: ambiguous anchor AND originally-cited line does not hold it -- hard fail, likely-stale reason', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'e.js', ['}', 'const mid = 1;', '}']);
  // '}' is ambiguous; cited at line 2, which holds 'const mid = 1;', not '}'.
  const pin = { file: 'sub/e.js', citation: 'sub/e.js:2', at: 'HEAD', first: '}' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, false);
  assert.match(result.why, /ambiguous/);
  assert.match(result.why, /likely stale/);
});

test('HEAD range pin: one side ambiguous-fallback, the other side unique and moved -- ok, but correction suppressed', () => {
  const root = mkFixtureRoot();
  // '}' ambiguous (lines 1 and 3); 'UNIQUE_LAST' unique at line 4, but the range's originally-cited
  // stop (2) points at 'const middle = 1;', a genuine move for the last anchor alone.
  writeFixture(root, 'f.js', ['}', 'const middle = 1;', '}', 'UNIQUE_LAST']);
  const pin = { file: 'sub/f.js', citation: 'sub/f.js:1-2', at: 'HEAD', first: '}', last: 'UNIQUE_LAST' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, true);
  assert.equal(result.actualFirst, '}');
  assert.equal(result.actualLast, 'UNIQUE_LAST');
  assert.equal(
    'correction' in result,
    false,
    'the last anchor genuinely moved (2 -> 4), but the first anchor resolved via ambiguous-fallback, so no correction may be reported -- the fallback path never knows if the number really moved'
  );
});

test('HEAD range pin: both anchors unique but resolve out of order -- hard fail, ordering-guard reason', () => {
  const root = mkFixtureRoot();
  // 'LAST_TEXT' sits ABOVE 'FIRST_TEXT' in the real file -- resolving each anchor independently
  // therefore yields first > last, which must never be accepted silently.
  writeFixture(root, 'g.js', ['LAST_TEXT', 'middle', 'FIRST_TEXT']);
  const pin = { file: 'sub/g.js', citation: 'sub/g.js:10-20', at: 'HEAD', first: 'FIRST_TEXT', last: 'LAST_TEXT' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, false);
  assert.match(result.why, /resolved out of order/);
  assert.equal('correction' in result, false);
});

test('HEAD range pin: claim check runs against the RESOLVED span, not the originally-cited one', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'h.js', ['padding', 'padding', 'START HERE', 'the important fact lives here', 'END HERE', 'padding']);
  const pin = {
    file: 'sub/h.js',
    citation: 'sub/h.js:1-2', // deliberately wrong -- the real span is 3-5
    at: 'HEAD',
    first: 'START HERE',
    last: 'END HERE',
    claim: 'the important fact lives here',
  };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, true, `expected ok: true (claim is inside the RESOLVED span 3-5): ${result.why}`);
  assert.deepEqual(result.correction, { file: 'sub/h.js', start: 3, stop: 5, citation: 'sub/h.js:3-5' });
});

test('HEAD range pin: claim check fails when the claim text is not in the resolved span', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'i.js', ['padding', 'START HERE', 'unrelated line', 'END HERE', 'padding']);
  const pin = {
    file: 'sub/i.js',
    citation: 'sub/i.js:2-4',
    at: 'HEAD',
    first: 'START HERE',
    last: 'END HERE',
    claim: 'this text is nowhere in the span',
  };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, false);
  assert.match(result.why, /claim not found in span/);
  assert.equal('correction' in result, false);
});

// Verifier finding (action 3): the ambiguous-fallback path reads `lines[start - 1]` and compares the
// result to the anchor. A JS array answers `undefined` both past its end AND at a negative index,
// and `(undefined ?? '').trim()` is `''` -- which COMPARES EQUAL to a blank/whitespace-only anchor.
// Without the sha branch's own `start >= 1 && start <= lineCount` bounds test, a blank-line pin
// cited at a line that does not exist resolved ok: true AT that nonexistent line. These two pin the
// guard from both ends; revoke either half of the bounds test in test/citation-pins.js and one of
// them goes red.
test('HEAD pin: blank ambiguous anchor cited PAST the end of the file -- hard fail, never a silent pass', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'k.js', ['a', '', 'b', '', 'c']); // '' is ambiguous: lines 2 and 4
  const pin = { file: 'sub/k.js', citation: 'sub/k.js:9999', at: 'HEAD', first: '' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, false, 'a citation past the end of the file must never resolve ok, blank anchor or not');
  assert.match(result.why, /does not hold it either/);
});

test('HEAD pin: blank ambiguous anchor cited at line 0 -- hard fail (a negative array index is `undefined`, not the last line)', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'l.js', ['a', '', 'b', '', 'c']);
  const pin = { file: 'sub/l.js', citation: 'sub/l.js:0', at: 'HEAD', first: '' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, false);
  assert.match(result.why, /does not hold it either/);
});

test('HEAD range pin: blank ambiguous `last` anchor cited past the end of the file -- hard fail (the same bounds guard, on the last side)', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'm.js', ['UNIQUE_START', '', 'b', '', 'c']);
  const pin = { file: 'sub/m.js', citation: 'sub/m.js:1-9999', at: 'HEAD', first: 'UNIQUE_START', last: '' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, false);
  assert.match(result.why, /anchor text for the last line is ambiguous/);
  assert.match(result.why, /does not hold it either/);
});

test('HEAD single-line pin: correction citation string uses single-line form, never "N-N"', () => {
  const root = mkFixtureRoot();
  writeFixture(root, 'j.js', ['line one', 'line two', 'MOVED TEXT']);
  const pin = { file: 'sub/j.js', citation: 'sub/j.js:1', at: 'HEAD', first: 'MOVED TEXT' };
  const [result] = resolvePins([pin], { repoRoots: roots(root) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.correction, { file: 'sub/j.js', start: 3, stop: 3, citation: 'sub/j.js:3' });
});

// ---- real corpus: the concrete thesis of this action ----------------------------------------
//
// resolvePins() with no `opts` uses this module's own REPO_ROOT/PRODUCT_REPO/DEPLOY_REPO -- i.e.
// THIS repo's real working tree, read via `git ls-files` for the no-slash citations below (exactly
// what the real registries in test/citation-pins-data.js already do). This is deliberately not
// hermetic: it is proving behavior against the real corpus, the same real files
// test/doc-constant-sweep.test.js's part 2.7/2.8 pins already cite, not synthetic fixtures.

// Text read directly from the real files at HEAD (verified by hand against
// orchestrator/daemon.js, orchestrator/intake.js, orchestrator/lock.js and bin/spo, and matching
// what test/citation-pins-data.js's own BENCH_PINS/LIVE_RANGE_PINS entries already pin).
const REAL_ANCHOR_TEXT = {
  binSpoCollectAll: '    const data = collectAll(sources);',
  daemonExitFirst: "  process.once('exit', () => {",
  daemonExitLast: "    if (dispatcherHandle) dispatcherHandle.killAllChildren('SIGTERM');",
  intakeFableFirst: '// it. First, availability: fable/high wedged the whole report pipeline for 12.8 hours on',
  intakeFableLast: '// every one dying on "You\'ve reached your Fable 5 limit" (api_error_status=429). At the time,',
  lockAtomicFirst: '  // CREATE-AND-PUBLISH MUST BE ATOMIC (verification of action 6.3; the defect this closes was',
  lockAtomicLast: "  // accountStateLockWaitMs bound governs.",
};

test('historical drift replay: bin/spo -- old citation :1273 (was :1273 before card #219, net +10 shift; unchanged text) resolves ok with a correction to the real current line', () => {
  const pin = { file: 'test replay', citation: 'bin/spo:1273', at: 'HEAD', first: REAL_ANCHOR_TEXT.binSpoCollectAll };
  const [result] = resolvePins([pin]);
  assert.equal(result.ok, true, `expected ok: true: ${result.why}`);
  assert.ok(result.correction, 'expected a correction to be reported');
  assert.equal(result.correction.start, 1283, `bin/spo's collectAll call is expected to be at :1283 today (per test/citation-pins-data.js's own BENCH_PINS entry) -- got ${result.correction.start}`);
  assert.equal(result.correction.citation, 'bin/spo:1283');
});

// Provenance of each old citation below was re-derived from `git log` by the action-3 verifier
// (walking the anchor's own line number commit by commit), not assumed: 626-627 moved to 665-666 in
// a483724 ("refuse --dry-run/--shadow against the live state root" -- ~39 lines added ABOVE the
// exit hook, which itself was untouched), 1273 moved to 1283 in df48670 (card #219), 938-940 moved
// to 953-955 and then, in card #240, to today's 963-965 (that card's `bash-policy` require and its
// header comment landed above this anchor -- a pure +10 shift, anchor text untouched; the replay
// below asserts the CURRENT correction, so it re-pins on every such shift),
// and lock.js's span has held exactly three positions in this repo's whole history --
// 257-288, then 278-309, then today's 354-385 -- which is what the two lock.js replays use.
test('historical drift replay: daemon.js -- old citation :626-627 (its real position until a483724 added ~39 lines above the exit hook; unchanged text) resolves ok with a correction to the real current lines', () => {
  const pin = {
    file: 'test replay',
    citation: 'daemon.js:626-627',
    at: 'HEAD',
    first: REAL_ANCHOR_TEXT.daemonExitFirst,
    last: REAL_ANCHOR_TEXT.daemonExitLast,
  };
  const [result] = resolvePins([pin]);
  assert.equal(result.ok, true, `expected ok: true: ${result.why}`);
  assert.ok(result.correction, 'expected a correction to be reported');
  assert.equal(result.correction.start, 665);
  assert.equal(result.correction.stop, 666);
  assert.equal(result.correction.citation, 'orchestrator/daemon.js:665-666');
});

test('historical drift replay: intake.js -- old citation :938-940 (unchanged text) resolves ok with a correction to the real current lines', () => {
  const pin = {
    file: 'test replay',
    citation: 'intake.js:938-940',
    at: 'HEAD',
    first: REAL_ANCHOR_TEXT.intakeFableFirst,
    last: REAL_ANCHOR_TEXT.intakeFableLast,
  };
  const [result] = resolvePins([pin]);
  assert.equal(result.ok, true, `expected ok: true: ${result.why}`);
  assert.ok(result.correction, 'expected a correction to be reported');
  assert.equal(result.correction.start, 964);
  assert.equal(result.correction.stop, 966);
  assert.equal(result.correction.citation, 'orchestrator/intake.js:964-966');
});

test('historical drift replay: lock.js -- old citation :278-309 (one shift back, the position immediately before today\'s; unchanged text) resolves ok with a correction to the real current lines', () => {
  const pin = {
    file: 'test replay',
    citation: 'lock.js:278-309',
    at: 'HEAD',
    first: REAL_ANCHOR_TEXT.lockAtomicFirst,
    last: REAL_ANCHOR_TEXT.lockAtomicLast,
  };
  const [result] = resolvePins([pin]);
  assert.equal(result.ok, true, `expected ok: true: ${result.why}`);
  assert.ok(result.correction, 'expected a correction to be reported');
  assert.equal(result.correction.start, 354);
  assert.equal(result.correction.stop, 385);
  assert.equal(result.correction.citation, 'orchestrator/lock.js:354-385');
});

test('historical drift replay: lock.js -- old citation :257-288 (two shifts back, this span\'s oldest real position; unchanged text) resolves ok with a correction to the real current lines', () => {
  const pin = {
    file: 'test replay',
    citation: 'lock.js:257-288',
    at: 'HEAD',
    first: REAL_ANCHOR_TEXT.lockAtomicFirst,
    last: REAL_ANCHOR_TEXT.lockAtomicLast,
  };
  const [result] = resolvePins([pin]);
  assert.equal(result.ok, true, `expected ok: true: ${result.why}`);
  assert.ok(result.correction, 'expected a correction to be reported');
  assert.equal(result.correction.start, 354);
  assert.equal(result.correction.stop, 385);
  assert.equal(result.correction.citation, 'orchestrator/lock.js:354-385');
});

// ---- failure side, against the real corpus too ------------------------------------------------

test('historical drift replay, failure side: a genuinely deleted/rewritten anchor still fails, absent-style, even at an old citation number', () => {
  const pin = {
    file: 'test replay',
    citation: 'daemon.js:626-627',
    at: 'HEAD',
    first: 'this text was never in daemon.js and never will be, planted for the test',
    last: REAL_ANCHOR_TEXT.daemonExitLast,
  };
  const [result] = resolvePins([pin]);
  assert.equal(result.ok, false);
  assert.match(result.why, /was not found anywhere/);
  assert.match(result.why, /deleted or rewritten/);
});

// ---- real HEAD registry: every entry must still resolve ok, with NO correction ---------------
//
// Every `at: 'HEAD'` pin in test/citation-pins-data.js today is, per this action's own spec,
// already at its true current position -- the citing prose was already fixed up to match. The new
// resolver must agree: ok: true and no correction for every one of them. If any of these goes red,
// or unexpectedly reports a correction, that is a bug in resolvePins, not a stale pin -- this test
// exists to make that distinction sharp for whoever reads a red run next.

const { BENCH_PINS, LIVE_RANGE_PINS, BLUNT_PINS, CCA_PINS } = require('./citation-pins-data');

test('every real at: HEAD pin in the registries resolves ok: true with no correction', () => {
  const allPins = [...BENCH_PINS, ...LIVE_RANGE_PINS, ...BLUNT_PINS, ...CCA_PINS];
  const headPins = allPins.filter((p) => p.at === 'HEAD');
  assert.ok(headPins.length > 0, 'expected at least one at: HEAD pin in the real registries');
  const results = resolvePins(headPins);
  const offenders = [];
  for (const r of results) {
    if (!r.ok) {
      offenders.push(`${r.pin.file} :: ${r.pin.citation} -- FAILED: ${r.why}`);
    } else if (r.correction) {
      offenders.push(`${r.pin.file} :: ${r.pin.citation} -- unexpectedly reported a correction: ${JSON.stringify(r.correction)}`);
    }
  }
  assert.deepEqual(offenders, [], `real at: HEAD pin(s) behaved unexpectedly:\n  ${offenders.join('\n  ')}`);
});
