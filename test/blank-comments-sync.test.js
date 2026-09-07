'use strict';
// blank-comments-sync.test.js -- the guard behind the `KEEP IN SYNC` note on `blankComments`.
//
// Seven test files in this suite each carry their own copy of a helper called `blankComments`.
// The duplication is deliberate -- every sweep file is self-contained, requires nothing from
// another test file, and can be read on its own -- but until this file existed the only thing
// holding the seven together was a prose note, and prose does not fail a build. Card #152 is
// exactly what that costs. The card names two files to fix -- test/park-reason-doc-sweep.test.js
// and test/gh-api-argv.test.js -- because those are the two its author happened to read; at
// 41e8d91 all SEVEN carried the same block-first ordering. Measured, not assumed: 7 block-first,
// 0 line-first at 41e8d91, and `git log -S` finds no line-first copy anywhere in this repo's
// history. Fixing the two the card names would have left five under-detecting without going red.
//
// This file therefore does two things:
//
//   1. SYNC. It extracts every `blankComments` definition in the suite (every `.test.js` file
//      under test/) and asserts they are byte-identical, against a pinned roster of the files
//      expected to carry one. An eighth copy has to join the pin deliberately; it cannot drift
//      in silently.
//   2. PROPERTIES. It runs the helper's stated behavioural contract against every extracted
//      copy, not against one favoured copy. A mutation applied uniformly to all seven -- which
//      the byte-identity check alone would happily accept -- still goes red here.
//
// This file necessarily contains the literal text its own scan searches for -- in ANCHOR,
// below -- so the scan must not count it as an eighth copy. Two things stop that: extraction is
// anchored at LINE START, and this file's own basename is excluded by name in scanCopies(). What
// each one actually buys was MEASURED, by disabling it in ANCHOR / scanCopies() themselves --
// the code production runs, not a copy of it -- and running
// `node --test test/blank-comments-sync.test.js`:
//
//   - Loosen the anchor alone (drop ANCHOR's leading newline): 8 pass, 1 fail. The failure is
//     inside 'the sync guard does not count itself', on `the line-start anchor let this file
//     match its own source` (1 !== 0). The roster and byte-identity tests stay GREEN: with the
//     anchor loose, the basename exclusion still holds the production roster correct.
//   - Delete the basename exclusion alone (`if (excludeSelf && file === SELF) continue;`): 8
//     pass, 1 fail. Same test, this time on `with the anchor loosened, the name exclusion alone
//     must still keep this file out of the roster`. Roster and byte-identity stay GREEN again:
//     with the exclusion gone, the anchor still holds the roster correct.
//   - Disable both: 0 pass, 9 fail. This file joins its own roster as a bogus eighth copy and
//     every assertion in the file falls with it.
//
// So neither axis is load bearing for the roster on its own. That is what redundancy means, and
// it is exactly why deleting either one reads as harmless. What this file buys is not that one
// of them is indispensable -- it is that deleting either one is now DETECTED, by a named
// assertion, in the world where the other is absent. That works only because there is exactly
// ONE walk: scanCopies() is what production uses AND what the probes call, with the two axes as
// parameters. An earlier draft probed a second, test-only copy of the walk instead; deleting the
// exclusion from the real path left all 9 green. That is the same defect one level up -- a guard
// measuring a double of the thing it guards -- as the ordering bug card #152 is about.
//
// What this extraction does and does not parse: it reads test files as RAW source and never
// strips their comments. It cannot, and does not need to -- it matches only a `function
// blankComments(source) {` line at column 0, a shape no comment in this suite has. It follows
// that a block-comment opener sitting inside a line comment somewhere else in a test file is
// invisible to this scan, which is fortunate, because several of the fixtures below contain
// exactly that byte sequence on purpose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

// The pinned roster. Adding an eighth copy means adding it here, on purpose, with the reviewer
// seeing the line. Order is irrelevant -- the assertion sorts.
const EXPECTED_COPIES = [
  'bin-spo-state-write-sweep.test.js',
  'doc-constant-sweep.test.js',
  'gh-api-argv.test.js',
  'no-real-spawn-sweep.test.js',
  'park-reason-doc-sweep.test.js',
  'park-reason-partition.test.js',
  'prompt-contract-sweep.test.js',
];

// Anchored at line start. A definition indented inside another function would not be found --
// none is, and one would be a different animal anyway (a closure over its enclosing scope, not
// a member of this family).
const ANCHOR = '\nfunction blankComments(source) {';

// The same needle without the leading newline -- the unanchored shape a careless future edit
// would produce, used only by the self-exclusion probes below.
const UNANCHORED = ANCHOR.slice(1);

// Extracts every `blankComments` definition matching `needle` from one file's raw source, as
// text: from the `function` keyword through the closing brace at column 0 that ends it. The
// needle is a parameter, not a constant, for one reason only: the axis-2 probe has to run this
// same extraction with the anchor loosened, and a second extractor would be a second thing to
// keep in sync -- which is the failure this whole file exists to prevent.
function extractDefinitions(source, needle = ANCHOR) {
  const skip = needle.startsWith('\n') ? 1 : 0;
  const out = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return out;
    const start = at + skip;
    const end = source.indexOf('\n}\n', start);
    assert.notEqual(end, -1, 'a blankComments definition is not terminated by a `}` at column 0');
    out.push(source.slice(start, end + 2));
    from = end;
  }
}

function testFiles() {
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
}

// THE walk. There is exactly one, and both self-exclusion axes are parameters of it: the
// line-start anchor (`anchored`) and this file's own basename (`excludeSelf`). Production is
// this function with both defaults -- allCopies() below adds nothing but the compile step -- and
// the probes in 'the sync guard does not count itself' call THIS function with the axes turned
// off explicitly. So disabling either axis in the real path is visible to the suite by
// construction: there is no second walk for a probe to be measuring instead.
function scanCopies({ anchored = true, excludeSelf = true } = {}) {
  const needle = anchored ? ANCHOR : UNANCHORED;
  const out = [];
  for (const file of testFiles()) {
    if (excludeSelf && file === SELF) continue;
    const source = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    for (const text of extractDefinitions(source, needle)) out.push({ file, text });
  }
  return out;
}

// [{ file, text, fn }] for every copy in the suite, this file excluded: the production roster,
// and the only caller that compiles an extracted definition into a callable.
function allCopies() {
  return scanCopies().map((copy) => ({
    ...copy,
    fn: new Function(`${copy.text}\nreturn blankComments;`)(),
  }));
}

// A projection of scanCopies, not a second implementation of it: which FILES the one walk finds
// a definition in, under a given pair of axes.
function filesWithDefinition(axes) {
  return [...new Set(scanCopies(axes).map((c) => c.file))];
}

// ---- 1. sync ---------------------------------------------------------------------------------

test('blankComments: the suite carries exactly the pinned roster of copies, no more and no fewer', () => {
  const files = allCopies().map((c) => c.file);
  assert.deepEqual(
    [...new Set(files)].sort(),
    [...EXPECTED_COPIES].sort(),
    'a blankComments copy appeared or vanished -- update EXPECTED_COPIES deliberately, and make ' +
      'the new copy byte-identical to the others before you do'
  );
  assert.equal(
    files.length,
    EXPECTED_COPIES.length,
    'one file defines blankComments more than once -- the roster counts definitions, not files'
  );
});

test('blankComments: all seven copies are byte-identical', () => {
  const copies = allCopies();
  const reference = copies[0];
  for (const copy of copies.slice(1)) {
    assert.equal(
      copy.text,
      reference.text,
      `test/${copy.file}'s blankComments has drifted from test/${reference.file}'s. These copies ` +
        'are duplicated on purpose but must stay identical: fix every copy, or none.'
    );
  }
});

test('the sync guard does not count itself, and each self-exclusion axis is probed in the production walk', () => {
  // Every assertion below goes through scanCopies() -- the same function allCopies() and every
  // other test in this file run. That is the point of the shape: disabling `excludeSelf` or
  // loosening ANCHOR in the real path makes one of these go red, with no second walk in between
  // to absorb the change. Both were run, in that order, before this test was written down.
  const self = fs.readFileSync(__filename, 'utf8');
  assert.ok(self.includes(UNANCHORED), 'precondition: this file does contain the text the scan searches for');
  assert.ok(testFiles().includes(SELF), 'precondition: this file is itself a *.test.js the scan walks');

  // Production configuration: this file is not a copy, by either route.
  assert.equal(extractDefinitions(self).length, 0, 'the line-start anchor let this file match its own source');
  assert.ok(!filesWithDefinition().includes(SELF), 'the guard counted itself as a copy');

  // Axis 1: drop the name exclusion, keep the anchor. The anchor has to hold the line alone.
  // Measured -- loosening ANCHOR turns this test red (at the assertion above, which reaches the
  // same loosened anchor first).
  assert.ok(
    !filesWithDefinition({ excludeSelf: false }).includes(SELF),
    'the line-start anchor alone must keep this file out of the roster'
  );

  // Axis 2: loosen the anchor to the shape a careless edit would produce, keep the name
  // exclusion, which now has to hold the line alone. Measured -- deleting `if (excludeSelf &&
  // file === SELF) continue;` from scanCopies() turns exactly this assertion red, and nothing
  // else in the file. Before the walk was unified this deletion left all 9 tests green.
  assert.ok(
    !filesWithDefinition({ anchored: false }).includes(SELF),
    'with the anchor loosened, the name exclusion alone must still keep this file out of the roster'
  );

  // ...and this is the assertion that stops that claim being vacuous: with BOTH axes off, the
  // self-match really does appear. If this ever goes red, the previous assertion has quietly
  // become a tautology and the name exclusion is guarding nothing.
  assert.ok(
    filesWithDefinition({ anchored: false, excludeSelf: false }).includes(SELF),
    'with both self-exclusions off this file must self-match -- otherwise the axis-2 assertion above proves nothing'
  );
});

// ---- 2. properties, asserted against every copy -----------------------------------------------
//
// Fixtures are arrays of source lines. Every block-comment opener and closer below lives inside
// a string literal, never inside a comment in this file: writing one into a comment here would
// be committing the very defect card #152 exists to remove.

const OPEN = '/' + '*';
const CLOSE = '*' + '/';

function forEachCopy(assertion) {
  const copies = allCopies();
  assert.ok(copies.length > 0, 'no blankComments copy found at all -- the extraction has broken');
  for (const copy of copies) assertion(copy.fn, `test/${copy.file}`);
}

test('blankComments blanks to spaces, never deletes: every line keeps its exact width (kills the empty-string mutant)', () => {
  // The width-preservation property is the entire reason the helper is shaped this way: the
  // sweeps report `file:line` positions computed from offsets into the BLANKED text, so a
  // blanked comment must occupy exactly as many columns as the comment it replaced. Line count
  // alone does not pin this -- replacing a comment line with the empty string keeps the count.
  const raw = [
    "'use strict';",
    '// a whole-line comment of some considerable and quite specific length',
    "  // an indented one, also specific",
    "const call = go('api', ['-X', 'PATCH']);",
    `${OPEN} a block comment ${CLOSE}`,
    '',
  ].join('\n');

  forEachCopy((blankComments, where) => {
    const blanked = blankComments(raw);
    assert.equal(blanked.length, raw.length, `${where}: total byte length must be preserved exactly`);
    const rawLines = raw.split('\n');
    const blankedLines = blanked.split('\n');
    assert.equal(blankedLines.length, rawLines.length, `${where}: line count must be preserved`);
    for (let i = 0; i < rawLines.length; i++) {
      assert.equal(
        blankedLines[i].length,
        rawLines[i].length,
        `${where}: line ${i + 1} changed width -- offsets and reported line numbers no longer match the real file`
      );
    }
    assert.equal(blankedLines[1].trim(), '', `${where}: the comment must actually be blanked, not merely preserved`);
    assert.ok(blankedLines[3].includes("'-X'"), `${where}: real code must be untouched`);
  });
});

test('blankComments blanks a MULTI-LINE block comment to spaces, preserving its newlines (kills the block-strip empty-string mutant)', () => {
  // A single-line block comment cannot detect this: deleting it outright and blanking it both
  // leave the following code on the same line. A multi-line one can -- deleting it collapses
  // every line below by the block's height, so a call site's reported line number silently
  // shifts. That is the same class of failure as the ordering bug itself: wrong positions, no
  // red.
  const raw = [
    "'use strict';",
    `${OPEN} a block comment`,
    '   that spans',
    `   several lines ${CLOSE}`,
    "const call = go('api', ['-X', 'PATCH']);",
    '',
  ].join('\n');

  forEachCopy((blankComments, where) => {
    const blanked = blankComments(raw);
    const lines = blanked.split('\n');
    assert.equal(lines.length, raw.split('\n').length, `${where}: the block comment's newlines must survive`);
    assert.equal(blanked.length, raw.length, `${where}: the block comment must be blanked to spaces, not deleted`);
    for (const i of [1, 2, 3]) {
      assert.equal(lines[i].trim(), '', `${where}: line ${i + 1} of the block comment must be blanked`);
    }
    assert.ok(
      lines[4].includes("'-X'"),
      `${where}: the call site must still be on line 5 -- it is line 5 in the real file, and that is the ` +
        'number the sweep will report'
    );
  });
});

test('blankComments matches block comments lazily: two blocks do not swallow the code between them (kills the greedy mutant)', () => {
  // Greedy `[\s\S]*` runs from the FIRST opener to the LAST closer in the file, blanking every
  // call site in between -- the identical under-detection-without-red failure this card is
  // about, arriving by a different route.
  const raw = [
    "'use strict';",
    `${OPEN} first block ${CLOSE}`,
    "const call = go('api', ['-X', 'PATCH']);",
    `${OPEN} second block ${CLOSE}`,
    '',
  ].join('\n');

  forEachCopy((blankComments, where) => {
    const lines = blankComments(raw).split('\n');
    assert.ok(
      lines[2].includes("'-X'"),
      `${where}: the call site between two block comments was blanked -- the block regex is matching greedily`
    );
    assert.equal(lines[1].trim(), '', `${where}: the first block comment must still be blanked`);
    assert.equal(lines[3].trim(), '', `${where}: the second block comment must still be blanked`);
  });
});

test('blankComments blanks INDENTED whole-line comments, so a block opener inside one cannot open a phantom span (kills the trimStart mutant)', () => {
  // The repo carries indented line comments containing a block opener today -- among them
  // orchestrator/state-machine.js:210 and orchestrator/config.js:764, both of which mention
  // `.claude/hooks/` with a glob in indented prose. Dropping `.trimStart()` leaves those lines
  // unblanked, and the opener inside them then reaches the next closer anywhere below.
  const raw = [
    "'use strict';",
    'function detect() {',
    `    // .claude/hooks/${CLOSE.slice(0, 1)}.sh is quoted here in indented prose, glob and all`,
    "    return go('api', ['-X', 'PATCH']);",
    '}',
    `${OPEN} an ordinary, unrelated block comment far below ${CLOSE}`,
    '',
  ].join('\n');

  forEachCopy((blankComments, where) => {
    const lines = blankComments(raw).split('\n');
    assert.equal(
      lines[2].trim(),
      '',
      `${where}: an indented whole-line comment was not blanked -- .trimStart() has been dropped`
    );
    assert.ok(
      lines[3].includes("'-X'"),
      `${where}: the call site below an indented comment was swallowed by a phantom span opened inside it`
    );
  });
});

test('blankComments survives the shape the repo actually carries: an UNCLOSED opener in a line comment, closed only by a later line comment', () => {
  // This is the live shape at HEAD, not a hypothetical: orchestrator/state-machine.js:210 and
  // :397 and orchestrator/steps/scripted.js:1889 each hold an unclosed block opener inside a
  // line comment, dormant today only because those files happen to contain no closer below.
  // `journal/` with a glob segment is the worst case of the family, being opener and closer at
  // once. The old block-first order read the first line comment as opening a real block that
  // ran to the second, blanking every call site between them.
  const raw = [
    "'use strict';",
    `// settings live under .claude/hooks/${CLOSE.slice(0, 1)}.sh -- an opener with no closer on this line`,
    'function handle() {',
    "  return go('api', ['-X', 'PATCH']);",
    '}',
    '// events land under journal/' + CLOSE + 'journal.jsonl, one directory per task',
    '',
  ].join('\n');

  forEachCopy((blankComments, where) => {
    const lines = blankComments(raw).split('\n');
    assert.ok(
      lines[3].includes("'-X'"),
      `${where}: the call site between an unclosed opener and a later closer was blanked -- block ` +
        'comments are being stripped before line comments again'
    );
    assert.equal(lines[1].trim(), '', `${where}: the opening line comment must be blanked`);
    assert.equal(lines[5].trim(), '', `${where}: the closing line comment must be blanked`);
  });
});

test('blankComments leaves a trailing comment on a code line alone -- whole-line comments only', () => {
  // The stated contract, and the reason the line-first order is safe: only lines that START
  // with `//` after trimStart are blanked, so a URL or a division in real code is never
  // touched. Pinned here so a future "improvement" to trailing comments has to argue with a
  // test rather than with a paragraph.
  const raw = [
    "const url = 'https://example.invalid/x'; // a trailing note",
    '',
  ].join('\n');

  forEachCopy((blankComments, where) => {
    assert.equal(blankComments(raw), raw, `${where}: a code line with a trailing comment must be returned unchanged`);
  });
});
