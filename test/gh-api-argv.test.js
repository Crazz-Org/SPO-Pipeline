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
function blankComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
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
