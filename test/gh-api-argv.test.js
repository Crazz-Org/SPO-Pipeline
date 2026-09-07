'use strict';
// A standing guard over the shape of every `gh api` call site in the repo.
//
// `gh api <path>` is a GET. Passing ANY `-f`/`-F`/`--field`/`--raw-field` flips it to POST unless
// `--method`/`-X` says otherwise. That is not a lint-level nicety here: the first cut of
// comment-scan.js's pagination passed `-f per_page=100 -f page=1` to
// `repos/<repo>/issues/<n>/comments`, which is the *create an issue comment* endpoint under POST.
// Every unpark scan therefore POSTed, got `422 "body" wasn't supplied`, and journalled
// `unpark-scan-failed` -- 1164 times, indistinguishable from the transient `gh` flakiness the
// audit had already written off as journal spam. The maintainer's `retry` channel never worked
// once while that shipped, and it failed closed only because no `body` field happened to be
// supplied: adding one would have had the daemon writing real comments onto live issues.
//
// The rest of the suite is hermetic by design (`runSync` is stubbed everywhere), so it can assert
// what argv a module builds but never what `gh` would do with it. That is exactly the blind spot
// this class of bug lives in, and it is why this test reads the SOURCE rather than mocking: a new
// call site added tomorrow, in a module that does not exist yet, is covered without anyone
// remembering to cover it.
//
// Query-string parameters (`...comments?per_page=100&page=1`) are the correct form for a GET and
// are what comment-scan.js uses now.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['orchestrator', 'console', 'scripts'];
const SCAN_FILES = ['bin/spo'];

const FIELD_FLAGS = ["'-f'", '"-f"', "'-F'", '"-F"', "'--field'", '"--field"', "'--raw-field'", '"--raw-field"'];
const METHOD_FLAGS = ["'--method'", '"--method"', "'-X'", '"-X"'];

// Comments are blanked (not deleted) before scanning, so every byte offset — and therefore every
// reported line number — still matches the real file. Without this the sweep reports itself: this
// file's own header quotes the broken `-f` form as the example of what not to write, and
// comment-scan.js's does too. Whole-line `//` comments and `/* */` blocks only; a trailing comment
// on the same line as code has never appeared inside an argv array in this repo.
//
// Card #152: line comments are blanked FIRST, block comments SECOND -- not the reverse. A `/*`
// that appears inside a `//` comment (e.g. a prose mention of `journal/*/journal.jsonl`) must
// never be read as opening a real block comment: blanking blocks first, on the RAW source, lets
// exactly that happen -- the phantom opener then runs to the next `*/` anywhere later in the
// file, silently blanking everything between them out of the sweep's view (`journal/*/` is its
// own worst case: simultaneously an opener and a closer). Blanking whole-line `//` comments first
// removes the `/*` before the block regex ever sees it, so no phantom span can open. This does
// NOT change behaviour for real code: only lines that START with `//` (after trimStart) are
// blanked here, so a trailing `https://` or similar inside actual code is untouched either way.
// KEEP IN SYNC. This helper is not a pair, it is a family: SEVEN byte-identical copies live in
// this suite -- test/bin-spo-state-write-sweep.test.js, test/doc-constant-sweep.test.js,
// test/gh-api-argv.test.js, test/no-real-spawn-sweep.test.js, test/park-reason-doc-sweep.test.js,
// test/park-reason-partition.test.js and test/prompt-contract-sweep.test.js. The duplication is
// deliberate (each sweep file stands alone and requires nothing from another test file); the
// drift is not. test/blank-comments-sync.test.js is the authority: it pins that roster, asserts
// the copies are byte-identical, and runs the helper's behavioural contract against every one of
// them. Fixing one copy and not the rest is the trap card #152 sets. The card names two files to
// fix -- test/park-reason-doc-sweep.test.js and test/gh-api-argv.test.js -- but at 41e8d91 all
// SEVEN carried the same block-first ordering (measured: 7 block-first, 0 line-first, and no
// line-first copy anywhere in this repo's history). Following the card literally would have left
// five copies under-detecting without going red.
function blankComments(source) {
  const withoutLineComments = source
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
  return withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function jsFilesUnder(dir) {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// One "call site" is the argv array literal a `gh` invocation is built from. We find the `'api'`
// element and take the balanced bracket span around it -- crude, but it is reading a convention
// this repo follows uniformly (every gh call is `runSync/spawnStep(deps, 'gh', [ ...argv ])`), and
// a false positive here is a test failure a human reads, not a silent production POST.
function apiArgvSpans(source) {
  const spans = [];
  const re = /'api'|"api"/g;
  let m;
  while ((m = re.exec(source))) {
    let open = source.lastIndexOf('[', m.index);
    if (open === -1) continue;
    let depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '[') depth++;
      else if (source[i] === ']') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    spans.push({ index: m.index, text: source.slice(open, close + 1) });
  }
  return spans;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

test('every `gh api` call site is GET-shaped: no -f/-F without an explicit --method/-X', () => {
  const files = [...SCAN_DIRS.flatMap(jsFilesUnder), ...SCAN_FILES];
  const offenders = [];
  let siteCount = 0;

  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const source = blankComments(fs.readFileSync(abs, 'utf8'));
    if (!source.includes("'gh'") && !source.includes('"gh"')) continue;

    for (const span of apiArgvSpans(source)) {
      siteCount += 1;
      // `gh api graphql` is POST by definition, and `-f query=...` is how the query is sent, so
      // the rule this test enforces does not apply to it. Exempted ahead of need: CLAUDE.md names
      // `gh api graphql` as the only way to move a board card, and plan action 5.1 puts one
      // directly in orchestrator/board.js -- without this, that lands as a mystery red test on a
      // call site that is perfectly correct.
      if (span.text.includes("'graphql'") || span.text.includes('"graphql"')) continue;
      const hasField = FIELD_FLAGS.some((f) => span.text.includes(f));
      const hasMethod = METHOD_FLAGS.some((f) => span.text.includes(f));
      if (hasField && !hasMethod) {
        offenders.push(`${rel}:${lineOf(source, span.index)} -- ${span.text.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }

  // If this drops to zero the sweep has stopped finding anything at all (a refactor renamed the
  // convention), and a green result would mean nothing. Fail loudly instead.
  assert.ok(siteCount >= 4, `expected to find several \`gh api\` call sites, found ${siteCount} -- has the argv convention changed?`);
  assert.deepEqual(
    offenders,
    [],
    `\`gh api\` with -f/-F and no --method is a POST, not a GET:\n  ${offenders.join('\n  ')}`
  );
});

// ---- Card #152: blankComments' ordering bug (block-strip before line-strip let a `/*` inside a
// `//` comment open a phantom block comment reaching to some unrelated, later `*/`, silently
// blanking every real call site in between) -- see blankComments' own header above for the full
// mechanism. Fixed by blanking whole-line `//` comments FIRST. The THREE tests below exercise
// that fix against fixture strings only, never against a mutated repo file: the first covers the
// closed case (a later block comment supplies the closer) and pins the helper's width, position
// and laziness properties as well; the second proves the sweep still goes RED on a genuine
// violation, so the fix cannot be passing by making everything look clean; the third covers the
// UNCLOSED shape the repo actually carries today. All three run the fixture through this file's
// own scanner; test/blank-comments-sync.test.js checks the helper itself, across all seven copies.
test('blankComments: an opener inside a `//` comment does not swallow the gh api call sites around it', () => {
  // One fixture, four properties, all of them measured through this file's OWN apiArgvSpans
  // rather than against blankComments in isolation (test/blank-comments-sync.test.js does that
  // part, for all seven copies at once). Each property has been revert-proofed by mutating the
  // helper and watching THIS test go red:
  //   - line comments blanked BEFORE blocks: reverting the order loses call site 1.
  //   - `.trimStart()` in the whole-line test: without it the INDENTED comment on line 3 is left
  //     alone, its opener reaches the block's closer on line 9, and call site 1 disappears.
  //     Indented comments carrying an opener are the repo's real shape, not a contrivance --
  //     orchestrator/state-machine.js:210 and orchestrator/config.js:764 are two of them.
  //   - blanking to spaces rather than '': every line keeps its width, so the offsets this file
  //     turns into `file:line` still address the real source.
  //   - the block regex staying LAZY: greedy runs from line 7's opener to line 15's closer and
  //     eats call site 2 -- the same under-detection-without-red this card is about.
  const rawSource = [
    "'use strict';",
    'function run() {',
    '  // events land under journal/*/journal.jsonl, one directory per task',
    "  return spawnStep(deps, 'gh', ['api', 'repos/x/y/pulls/1', '-X', 'PATCH']);",
    '}',
    '',
    '/* an ordinary, unrelated block comment',
    '   that happens to span',
    '   three whole lines */',
    '',
    'function again() {',
    "  return spawnStep(deps, 'gh', ['api', 'repos/x/y/pulls/2', '-X', 'PATCH']);",
    '}',
    '',
    '/* a second block comment, later still */',
    '',
  ].join('\n');

  const blanked = blankComments(rawSource);
  const spans = apiArgvSpans(blanked);
  assert.equal(spans.length, 2, 'both real call sites must survive: the one after the opener, and the one between the two blocks');
  assert.ok(spans[0].text.includes('pulls/1'), 'the call site below the indented, opener-bearing comment must survive intact');
  assert.ok(spans[1].text.includes('pulls/2'), 'the call site between the two block comments must survive intact');

  // Width preservation -- the stated reason the helper blanks instead of deleting. Line count
  // alone does not pin it: replacing a comment line with '' keeps the count and destroys every
  // column offset.
  assert.equal(blanked.length, rawSource.length, 'blankComments must blank to spaces, never delete');
  const rawLines = rawSource.split('\n');
  const blankedLines = blanked.split('\n');
  assert.equal(blankedLines.length, rawLines.length, 'blankComments must not change the number of lines');
  for (let i = 0; i < rawLines.length; i++) {
    assert.equal(blankedLines[i].length, rawLines[i].length, `line ${i + 1} changed width -- reported line/column would drift`);
  }

  // The comments really were blanked, so this test cannot pass by doing nothing at all.
  assert.equal(blankedLines[2].trim(), '', 'the indented comment must be blanked');
  for (const i of [6, 7, 8]) {
    assert.equal(blankedLines[i].trim(), '', `line ${i + 1} of the multi-line block comment must be blanked`);
  }

  // Position preservation, which only a MULTI-line block can detect: deleting the block instead
  // of blanking it would slide call site 2 up three lines, and this file reports that number.
  assert.equal(lineOf(blanked, spans[1].index), 12, 'call site 2 must still be reported on its real line');
});

test('the -f/--method sweep still catches a genuine violation even in the presence of a /* inside a // comment', () => {
  // Same fixture shape as above, but the real call site actually violates the -f-without-method
  // rule -- proving the sweep still goes red on a genuine violation rather than the fix merely
  // making everything look clean.
  const rawSource = [
    "'use strict';",
    "// events land under journal/*/journal.jsonl, one directory per task",
    "function run() {",
    "  return spawnStep(deps, 'gh', ['api', 'repos/x/y/issues/1/comments', '-f', 'per_page=100']);",
    "}",
    '',
    '/* a real, unrelated trailing block comment, far below the comment above */',
    '',
  ].join('\n');

  const blanked = blankComments(rawSource);
  const spans = apiArgvSpans(blanked);
  assert.equal(spans.length, 1, 'expected to find the one genuine call site in the fixture');

  const span = spans[0];
  const hasField = FIELD_FLAGS.some((f) => span.text.includes(f));
  const hasMethod = METHOD_FLAGS.some((f) => span.text.includes(f));
  assert.ok(hasField && !hasMethod, 'fixture must actually violate the -f-without-method rule, or this test proves nothing');
});

test('blankComments: an UNCLOSED opener in a `//` comment, closed only by a later `//` comment -- the shape the repo carries today', () => {
  // The closed case above is the easy one. The occurrences actually present at HEAD are
  // UNCLOSED openers sitting in prose -- orchestrator/state-machine.js:210 and :397 and
  // orchestrator/steps/scripted.js:1889 -- dormant purely because those files contain no
  // closer below them. The danger is one future `*/` away, and this fixture is that future:
  // the second comment's `journal/*/` supplies a closer, and `journal/*/` is the family's
  // worst case, being an opener and a closer in the same four characters. The old
  // block-first order joined the two comments into one phantom span and blanked the call
  // site between them; a census of orchestrator/, console/, scripts/ and bin/spo at 41e8d91
  // found 13 such occurrences, of which 2 opened a span that reached real source (20 lines
  // in all, in orchestrator/intake.js and console/collect.js) and happened to contain no
  // swept call site -- lost by luck, not by design.
  const rawSource = [
    "'use strict';",
    '// protected paths are quoted as .claude/hooks/*.sh -- an opener, with no closer on this line',
    'function run() {',
    "  return spawnStep(deps, 'gh', ['api', 'repos/x/y/pulls/1', '-X', 'PATCH']);",
    '}',
    '// events land under journal/*/journal.jsonl, one directory per task',
    '',
  ].join('\n');

  const blanked = blankComments(rawSource);
  const spans = apiArgvSpans(blanked);
  assert.equal(spans.length, 1, 'the call site between an unclosed opener and a later closer must survive');
  assert.ok(spans[0].text.includes("'-X'"), 'the call site text must survive intact, not be blanked to spaces');
  assert.equal(blanked.split('\n')[1].trim(), '', 'the opener-bearing comment must itself be blanked');
  assert.equal(blanked.split('\n')[5].trim(), '', 'the closer-bearing comment must itself be blanked');
});

test('comment-scan pages through the comments endpoint with a query string, not -f fields', () => {
  const source = blankComments(fs.readFileSync(path.join(REPO_ROOT, 'orchestrator', 'comment-scan.js'), 'utf8'));
  const spans = apiArgvSpans(source).filter((s) => s.text.includes('/comments'));

  assert.equal(spans.length, 1, 'expected exactly one gh api call against the comments endpoint');
  const argv = spans[0].text;
  // `includes('page=')` would be satisfied by `per_page=` alone, so the page parameter has to be
  // matched where it actually sits -- immediately after a `?` or `&`.
  assert.ok(argv.includes('per_page='), 'the per-page parameter is still passed');
  assert.ok(/[?&]page=/.test(argv), 'the page parameter is still passed, distinct from per_page');
  assert.ok(argv.includes('?'), 'pagination parameters must ride in the path as a query string');
  assert.ok(!argv.includes("'-f'"), "must not use -f: it flips `gh api` from GET to POST against the create-comment endpoint");
});
