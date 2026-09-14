'use strict';
// test-comment-citation-sweep.test.js -- registry-free rewrite (chantier "citation-pins
// migration", action 2). Card #190 originally built this as a hand-maintained registry (219
// exact-text pins + 67 allowlist entries, three separately hand-bumped counts) mirroring
// test/citation-pins.js's resolvePins. An Opus research review (2026-09-14, maintainer-approved)
// found that machinery disproportionate for the lowest-stakes citation class in the repo -- a
// stale `file:line` in a `test/` comment costs a reader about a minute of confusion, nothing like
// the safety-critical citations elsewhere -- and asked for a REGISTRY-FREE replacement: no stored
// pin text, no `claim`, no hand-bumped counts.
//
// What ships is ONE check:
//
//   EXISTENCE -- does the cited file resolve (this repo, SPO-WebClient, or SPO-Deploy), and are
//   the line numbers in bounds? Mirrors doc-constant-sweep.test.js's part 2 bounds check
//   (`c.stop > lineCount`), simplified: no EXPECTED_CITATIONS ratchet, no cross-repo pin set, just
//   "does this line exist".
//
// Extraction is shared with test/doc-constant-sweep.test.js, not reimplemented: CITATION_RE /
// extractCitations / stripFences / normalizeWrapWithMap / resolveCitationTarget all live in
// test/citation-pins.js.
//
// ---- why there is no ANCHOR check: the measurement that removed it ----------------------------
// The chantier's brief also asked for a second, looser check -- an "anchor": take the last
// identifier-shaped token in the PROXIMITY_CHARS window of prose before a citation and require it
// to appear somewhere in the cited range. That check WAS built, measured against the real corpus,
// and then deliberately deleted rather than shipped. The measurement (2026-09-14, this action's
// own report has the full table) is the reason, and it is recorded here so the idea is not
// re-proposed from scratch by the next reader:
//
//   - Taking the brief literally (candidate filtered only by CLAIM_STOPWORDS + isVacuousClaim)
//     produced 224 offenders out of 286 citations. `test/*.js` comments are free-form narrative
//     prose, so "the nearest word before the citation" is overwhelmingly an ordinary English or
//     capitalised-emphasis word (`HEAD`, `SAME`, `README`), not an identifier.
//   - Adding a code-shape filter (candidate must contain `_`, a camelCase transition, or a
//     letter/digit adjacency) cut that to 69 offenders -- but pushed `unanchorable` (no candidate
//     at all, so no verification performed) from 48 to 161 of the 247 citations that reached the
//     check. 65% of the corpus would have been waved through unchecked either way.
//   - Of the 86 citations the check actually fired on, 69 FAILED and 17 passed. All 69 were then
//     read by hand against the real target file: every single one was a correct citation whose
//     nearest code-shaped token names the ENCLOSING function/declaration (mentioned once in the
//     surrounding sentence) rather than text repeated on the cited line. ZERO genuine drifts.
//     A gate with a 69-to-0 false-positive-to-true-positive ratio does not find drift; it trains
//     its readers to allowlist, which is precisely how a real drift would get waved through.
//   - The cost of shipping it was 60 hand-written allowlist entries (on top of the 30 EXISTENCE
//     genuinely needs), each a prose paragraph to be maintained forever -- larger than the 67-entry
//     allowlist of the registry this migration exists to retire, i.e. the same tax relocated.
//   - The one principled narrowing available (fire only when the candidate appears ELSEWHERE in
//     the cited file, so it is a plausible anchor rather than prose noise) was also measured: it
//     cuts 69 firings to 32, and all 32 are still false positives, for the same structural reason.
//     Fixing it properly needs a "declaration nearby" concept -- which is exactly
//     doc-constant-sweep.test.js part 2.5's tuned candidate-ranking machinery, deliberately out of
//     scope for this corpus and the very thing the migration was created to stop paying for.
//
// So: EXISTENCE is the whole check. It is cheap, it has no tuning knobs, its 30 allowlist entries
// are all structural and stable (fabricated fixture paths, a deleted product file, genuinely
// ambiguous bare basenames), and what it does NOT catch is stated plainly in
// doc/accepted-gaps.md §10 rather than papered over with a heuristic that looks like coverage.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { gitEnv } = require('./helpers');
const {
  extractCitations, resolveCitationTarget, stripFences, normalizeWrapWithMap,
} = require('./citation-pins');

const REPO_ROOT = path.join(__dirname, '..');

// KEEP IN SYNC -- see test/blank-comments-sync.test.js's own header. Byte-identical to the other
// seven copies; this file is the eighth, registered in that file's EXPECTED_COPIES.
function blankComments(source) {
  const withoutLineComments = source
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
  return withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// commentsOnly(source) -- the exact INVERSE of blankComments: wherever blankComments(source)
// differs from source, that character was comment text (now blanked to a space); wherever it is
// unchanged, it was code (or already-matching whitespace) and is blanked here instead. Built this
// way -- as a diff against blankComments's own output, never as a second comment-detecting regex
// -- so this extraction can never disagree with blankComments (and every other sweep that uses it)
// about what counts as a comment.
function commentsOnly(source) {
  const blanked = blankComments(source);
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const s = source[i];
    out += s === '\n' ? '\n' : blanked[i] !== s ? s : ' ';
  }
  return out;
}

// The corpus this sweep walks: every `test/<name>.js` file (flat -- .test.js files AND the shared
// helper modules that sit directly in test/, e.g. helpers.js, citation-pins.js,
// citation-pins-data.js) plus every `test/fixtures/<dir>/<name>.js` file, via `git ls-files` so this never
// depends on directory-walk ordering or misses a file `.gitignore` would hide from a naive scan.
// `--others --exclude-standard` adds every untracked-but-not-gitignored file too, so a fresh
// `test/<new-sweep>.test.js` is covered from the moment it is written, not from the moment it is
// committed (D1, fix pass 11.3, #190 verifier finding).
function corpusFiles() {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', 'test'], { encoding: 'utf8', env: gitEnv() })
    .split('\n')
    .filter(Boolean)
    .filter((f) => f.endsWith('.js'));
}

// D6 (fix pass 11.3, #190 verifier finding), unchanged from the registry-based version: a stray
// slash-star inside a STRING or a code line (never inside a whole-line // comment, which
// blankComments already blanks first) opens a phantom block-comment span that runs to the next
// unrelated '*/' anywhere later in the file. Corpus-wide, no scanned file may open a block span
// longer than a small, named tolerance -- see doc/accepted-gaps.md §10 for the live instances
// this action's predecessor found and fixed.
const PHANTOM_SPAN_TOLERANCE_LINES = 8;

test('no scanned test source file opens a phantom block-comment span longer than the known, named tolerance -- the slash-star-in-a-string trap this corpus has hit before', () => {
  const BLOCK_RE = /\/\*[\s\S]*?\*\//g;
  const offenders = [];
  for (const rel of corpusFiles()) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const withoutLineComments = source.split('\n').map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line)).join('\n');
    let m;
    BLOCK_RE.lastIndex = 0;
    while ((m = BLOCK_RE.exec(withoutLineComments))) {
      const startLine = withoutLineComments.slice(0, m.index).split('\n').length;
      const endLine = withoutLineComments.slice(0, m.index + m[0].length).split('\n').length;
      if (endLine - startLine > PHANTOM_SPAN_TOLERANCE_LINES) {
        offenders.push(`${rel}:${startLine}-${endLine} (${endLine - startLine} lines) -- a stray slash-star outside a // comment is phantom-blanking real code; rephrase the string/line so it does not contain a literal '/' + '*' adjacency.`);
      }
    }
  }
  assert.deepEqual(offenders, [], `phantom block-comment span(s) found:\n  ${offenders.join('\n  ')}`);
});

// ---- extraction --------------------------------------------------------------------------------

// extractFileCitations(rel) -- every citation this sweep cares about in one file's own comments,
// in document order.
function extractFileCitations(rel) {
  const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const cText = commentsOnly(source);
  const fenceStripped = stripFences(cText); // no-op for a test source file (never markdown), applied anyway
  // so "the SAME extraction functions doc-constant-sweep uses" is literally true, not merely
  // extractCitations alone (fix pass 11.3 round 2, #190 verifier finding B5).
  const { text: normalized } = normalizeWrapWithMap(fenceStripped);
  const all = extractCitations(normalized);
  const live = all.filter((c) => !c.unanchored);
  return { rel, live };
}

function citationKey(rel, raw) {
  return `${rel} :: ${raw}`;
}

// describeResolutionFailure(resolved) -- resolveCitationTarget's own four dangling shapes, turned
// into a human-facing reason. Never a silent pass (E1 posture, same as doc-constant-sweep.test.js's
// own use of this resolver): an absent sibling repo is reported distinctly from a genuinely
// dangling citation, so the two are never confused with each other.
function describeResolutionFailure(resolved) {
  if (resolved.ambiguous) return `ambiguous basename in the ${resolved.root} repo: ${resolved.ambiguous.join(', ')}`;
  if (resolved.root === 'product-absent') return 'cannot verify -- the product repo (SPO-WebClient) is not on disk';
  if (resolved.root === 'deploy-absent') return 'cannot verify -- the deploy repo (SPO-Deploy) is not on disk';
  return 'does not resolve in any known repo (this one, SPO-WebClient, or SPO-Deploy)';
}

// readLines(target) -- text.split('\n') with exactly one trailing-empty-element pop, matching
// citation-pins.js's resolvePins byte-for-byte (D8a, fix pass 11.1): a file ending in a real
// newline (almost every one) produces one phantom empty element after the last line, which would
// otherwise inflate lineCount by one and let a citation one line past EOF read as in-bounds.
function readLines(target) {
  const text = fs.readFileSync(target, 'utf8');
  const lines = text.split('\n');
  if (text.endsWith('\n') && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---- the check, run once over the whole corpus -------------------------------------------------
//
// checkCorpus(allowlist) -> { total, offenders, allowlisted } -- every offender/allowlisted entry
// is `{ key, detail }`.
function checkCorpus(allowlist) {
  let total = 0;
  const offenders = [];
  const allowlisted = [];

  for (const rel of corpusFiles()) {
    const { live } = extractFileCitations(rel);
    for (const c of live) {
      total += 1;
      const key = citationKey(rel, c.raw);

      const resolved = resolveCitationTarget(c.file);
      const dangling = resolved.root === null || resolved.root === 'product-absent' || resolved.root === 'deploy-absent' || Boolean(resolved.ambiguous);
      let detail = null;
      if (dangling) {
        detail = describeResolutionFailure(resolved);
      } else {
        const lineCount = readLines(resolved.target).length;
        if (c.start < 1 || c.start > lineCount || c.stop < 1 || c.stop > lineCount) {
          detail = `out of bounds -- ${c.file} has ${lineCount} line(s), citation targets ${c.start}${c.stop !== c.start ? `-${c.stop}` : ''}`;
        }
      }
      if (!detail) continue;

      const bucket = Object.prototype.hasOwnProperty.call(allowlist, key) ? allowlisted : offenders;
      bucket.push({ key, detail: `${key} -- ${detail}` });
    }
  }

  return { total, offenders, allowlisted };
}

// ---- the allowlist -----------------------------------------------------------------------------
//
// Keyed `${citingFile} :: ${raw citation text}` -- no `#<occurrence>` suffix: every citation text
// that repeats within one file in this corpus needed the SAME treatment both times it was checked
// by hand, so the extra disambiguation the old registry carried was never load-bearing here.
//
// Exactly 30 entries, every one a STRUCTURAL non-resolution rather than a judgement call: a
// fabricated path planted as a fixture, a product file that was deleted, a bare basename this repo
// now has several of, or a dated quote of a value that was already out of bounds when it was
// written. None of them can be "fixed" by editing the citing comment, and none of them needs
// periodic re-reading -- which is what distinguishes this list from the 60 further entries the
// (deleted) anchor heuristic would have demanded. Categories are doc-constant-sweep.test.js's own
// vocabulary, restricted to the five an existence-only check can actually produce.
const ALLOWLIST_CATEGORIES = new Set([
  'illustrative',
  'quoted-as-wrong',
  'hypothetical-example',
  'deleted-file',
  'ambiguous-bare-path',
]);

const CITATION_ALLOWLIST = {
  // ---- deleted-file: the cited product file no longer exists (frozen historical citation) ------
  'test/citation-pins-data.js :: sanctuarize.test.ts:151-156': { category: 'deleted-file', reason: 'sanctuarize.test.ts was deleted from SPO-WebClient; this frozen citation is CITATION_ALLOWLIST-only in doc-constant-sweep.test.js itself for the identical reason' },
  'test/doc-constant-sweep.test.js :: sanctuarize.test.ts:151-156': { category: 'deleted-file', reason: 'same deleted product file as citation-pins-data.js\'s identical mention -- sanctuarize.test.ts no longer exists in SPO-WebClient' },

  // ---- ambiguous-bare-path: this repo now has FOUR README.md files (root, orchestrator/,
  // prompts/, and test/fixtures/plan-span-corpus/ -- the last one did not exist when the old
  // registry's `path` field disambiguated these citations), and the product repo has two paths.ts.
  // resolveCitationTarget correctly reports the bare basename as ambiguous; the registry-free
  // design has no `path`-style disambiguator, so these stay allowlisted rather than silently
  // picking one candidate.
  'test/citation-pins-data.js :: README.md:34': { category: 'ambiguous-bare-path', reason: 'JSDoc prose illustrating the `path` disambiguation feature using this exact bare citation as its own worked example; root README.md:34 is the real target but the bare basename is ambiguous among 4 README.md files today' },
  'test/citation-pins-data.js :: README.md:35': { category: 'ambiguous-bare-path', reason: 'same worked example as :34, one line further into the same illustrative block' },
  'test/citation-pins-data.js :: README.md:37': { category: 'ambiguous-bare-path', reason: 'same worked example as :34/:35, completing the illustrative block' },
  'test/citation-pins.js :: README.md:34': { category: 'ambiguous-bare-path', reason: 'JSDoc prose illustrating why `path` exists ("e.g. `README.md:34`"), using the same real-but-ambiguous bare citation as the worked example' },
  'test/citation-pins.js :: README.md:37': { category: 'ambiguous-bare-path', reason: 'JSDoc prose illustrating a re-pin scenario ("`README.md:37` -> `:38`"), same ambiguous bare basename' },
  'test/citation-pins.js :: README.md:38': { category: 'ambiguous-bare-path', reason: 'the re-pin target named in the same sentence as :37 above, same ambiguous bare basename' },
  'test/doc-constant-sweep.test.js :: README.md:34': { category: 'ambiguous-bare-path', reason: 'header prose describing a real, dated fix to root README.md:34\'s own content; the bare citation is ambiguous among this repo\'s 4 README.md files, same as citation-pins.js/citation-pins-data.js\'s identical mentions' },
  'test/doc-constant-sweep.test.js :: README.md:35': { category: 'ambiguous-bare-path', reason: 'header prose listing CCA_PINS\'s own coverage ("README.md:34/:35/:37"); same ambiguous bare basename as the :34/:37 entries beside it' },
  'test/doc-constant-sweep.test.js :: README.md:37': { category: 'ambiguous-bare-path', reason: 'the third citation in the same CCA_PINS coverage list as :34/:35 beside it, same ambiguous bare basename' },
  'test/doc-constant-sweep.test.js :: paths.ts:52': { category: 'ambiguous-bare-path', reason: 'header prose narrating a historical drift ("paths.ts:52 drifted to a real line 77 unnoticed"); the product repo has two paths.ts files (src/e2e/bench/paths.ts and src/server/paths.ts), so the bare basename is genuinely ambiguous today, independent of the dated drift itself' },

  // ---- illustrative: JSDoc/comment prose quoting a citation-shaped example to describe a
  // mechanism (a format template, a wrap-join example, a regression-test shape), never asserting a
  // live fact about the named file. None of these paths resolves anywhere, by construction.
  'test/citation-pins.js :: relative/path/to/file.ts:123': { category: 'illustrative', reason: 'JSDoc example of a fenced-code-block format TEMPLATE ("File: relative/path/to/file.ts:123"), the same illustrative text doc-constant-sweep.test.js\'s own CITATION_ALLOWLIST already excuses; no such path exists' },
  'test/doc-constant-sweep.test.js :: relative/path/to/file.ts:123': { category: 'illustrative', reason: 'same fenced-code-block format-template illustrative example as citation-pins.js\'s identical mention; no such path exists' },
  'test/citation-pins.js :: foo.js:10': { category: 'illustrative', reason: 'JSDoc example illustrating a degenerate range shape ("a degenerate foo.js:10-10 range"); no foo.js exists in any known repo' },
  'test/citation-pins.js :: spec.md:49': { category: 'illustrative', reason: 'JSDoc example illustrating the hyphen-wrap join ("doc/state-machine- + spec.md:49") and the chain-match-inside-a-full-match exclusion rule; no bare "spec.md" exists' },
  'test/doc-constant-sweep.test.js :: spec.md:49': { category: 'illustrative', reason: 'same wrap-join illustrative example as citation-pins.js\'s identical mention, reused in a hermetic fixture string and its own describing comment; no bare "spec.md" exists' },
  'test/protected-files-guard.test.js :: .claude/settings.json:109-127': { category: 'illustrative', reason: 'test title/comment explicitly says this is "the real shapes from journal/issue-418 and journal/issue-429" reproduced for a regression test -- a frozen shape example, not an assertion about the current settings.json, which is 120 lines long and so genuinely does not have a line 127' },

  // ---- hypothetical-example: fabricated citations planted for a hermetic mutation/fixture test;
  // the named file/range is never meant to exist or resolve.
  'test/doc-constant-sweep.test.js :: foo.js:10': { category: 'hypothetical-example', reason: 'chain-continuation shape example in prose ("foo.js:10, `:20`") describing CHAIN_RE, not a real citation' },
  'test/doc-constant-sweep.test.js :: foo.js:20': { category: 'hypothetical-example', reason: 'the chain-continuation target in the same illustrative example as foo.js:10 beside it' },
  'test/doc-constant-sweep.test.js :: orchestrator/journal.js:999999': { category: 'hypothetical-example', reason: 'a deliberately-planted fabricated OUT-OF-BOUNDS citation (journal.js is 462 lines) used by a hermetic isCitationAllowlisted mutation test, never a real citation' },
  'test/doc-constant-sweep.test.js :: alpha.js:1': { category: 'hypothetical-example', reason: 'fabricated fixture text (`\'alpha.js:1 nearIdentOne beta.js:2 farIdentTwo\'`) for a hermetic candidate-window clip test, not a real citation' },
  'test/doc-constant-sweep.test.js :: beta.js:2': { category: 'hypothetical-example', reason: 'the clip-boundary fixture citation in the same hermetic test as alpha.js:1 beside it' },
  'test/doc-constant-sweep.test.js :: gamma.js:2': { category: 'hypothetical-example', reason: 'fabricated fixture text for the companion "same file, no clip" hermetic test beside the alpha/beta one' },
  'test/plan-writes.test.js :: foo.js:2-6': { category: 'hypothetical-example', reason: 'comment describing this file\'s own fabricated `foo.js` invariant-span fixtures (foo.js does not exist); used to test PLAN\'s invariant-overlap detection, never a real citation' },
  'test/plan-writes.test.js :: foo.js:1-3': { category: 'hypothetical-example', reason: 'same fabricated foo.js fixture family as foo.js:2-6 beside it, the INV-1 baseline span these comments describe' },
  'test/real-steps.test.js :: foo.js:2-6': { category: 'hypothetical-example', reason: 'same fabricated foo.js fixture family as test/plan-writes.test.js\'s identical mentions, reused in this file\'s own real-agent variant of the same scenario' },
  'test/real-steps.test.js :: foo.js:1-3': { category: 'hypothetical-example', reason: 'same fabricated foo.js fixture family as test/plan-writes.test.js\'s identical mentions' },

  // ---- quoted-as-wrong: dated historical narration quoting a bare form that was ALREADY out of
  // bounds when it was written -- never meant to resolve today.
  'test/citation-pins-data.js :: .claude/settings.json:109-127': { category: 'quoted-as-wrong', reason: 'header prose narrating fix pass D2/R1\'s own dated diagnosis history of this exact bare form ("fix pass D2 first found this UNPINNABLE... that was the wrong diagnosis"); THIS repo\'s .claude/settings.json is 120 lines, so the bare form is out of bounds here -- the live, correct citation is the SPO-WebClient/-prefixed form pinned in this file\'s own registry' },
  'test/doc-constant-sweep.test.js :: .claude/settings.json:109-127': { category: 'quoted-as-wrong', reason: 'header prose narrating the identical dated diagnosis history as citation-pins-data.js\'s own mention ("the first completeness check (D2) could not pin ... wrongly diagnosed as unpinnable"); same out-of-bounds bare form against this repo\'s 120-line settings.json' },
};

for (const [key, entry] of Object.entries(CITATION_ALLOWLIST)) {
  if (!ALLOWLIST_CATEGORIES.has(entry.category)) {
    throw new Error(`test-comment-citation-sweep.test.js: CITATION_ALLOWLIST entry ${key} has unknown category "${entry.category}"`);
  }
  if (!(typeof entry.reason === 'string' && entry.reason.trim().length > 0)) {
    throw new Error(`test-comment-citation-sweep.test.js: CITATION_ALLOWLIST entry ${key} has no reason`);
  }
}

// ---- the sweep itself --------------------------------------------------------------------------

test('CITATION_ALLOWLIST holds only known categories and non-empty reasons (mechanical, re-asserted so a fixture mutation is caught by node --test, not merely by the module-load throw above)', () => {
  const offenders = [];
  for (const [key, entry] of Object.entries(CITATION_ALLOWLIST)) {
    if (!ALLOWLIST_CATEGORIES.has(entry.category)) offenders.push(`${key} -- unknown category "${entry.category}"`);
    if (!(typeof entry.reason === 'string' && entry.reason.trim().length > 0)) offenders.push(`${key} -- no reason`);
  }
  assert.deepEqual(offenders, [], `CITATION_ALLOWLIST shape violation(s):\n  ${offenders.join('\n  ')}`);
});

// A JS object literal silently keeps only the LAST of two entries sharing a key, so a duplicated
// allowlist key is a silently-dropped exemption, not a syntax error. The registry-free rewrite
// shipped with exactly that defect on its first draft (91 entries written, 90 effective -- one
// `dispatcher.js:635-648` key written twice), which is why this is asserted against the SOURCE
// text rather than against Object.keys, whose duplicates are already gone by the time it runs.
test('CITATION_ALLOWLIST has no duplicate keys -- a repeated key is silently swallowed by the object literal', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  const body = src.slice(src.indexOf('const CITATION_ALLOWLIST = {'));
  const seen = new Map();
  const dupes = [];
  const KEY_RE = /^ {2}'((?:[^'\\]|\\.)*)':\s*\{ category:/gm;
  let m;
  while ((m = KEY_RE.exec(body))) {
    const key = m[1].replace(/\\'/g, "'");
    if (seen.has(key)) dupes.push(key);
    seen.set(key, true);
  }
  assert.ok(seen.size > 0, 'the duplicate-key scan matched no entries at all -- its KEY_RE no longer matches this file\'s own formatting');
  assert.deepEqual(dupes, [], `duplicate CITATION_ALLOWLIST key(s) -- the later entry silently shadows the earlier one:\n  ${dupes.join('\n  ')}`);
  assert.equal(seen.size, Object.keys(CITATION_ALLOWLIST).length, 'source-text key count and object key count disagree');
});

test('EXISTENCE: every file:line citation in the test/ corpus resolves to a real file (this repo, SPO-WebClient, or SPO-Deploy) with in-bounds line numbers, or is on CITATION_ALLOWLIST', () => {
  const { offenders } = checkCorpus(CITATION_ALLOWLIST);
  const messages = offenders.map((o) => o.detail);
  assert.deepEqual(
    messages,
    [],
    `citation(s) that do not exist -- the cited file is unresolvable/absent, or the line number is out of bounds. Fix the ` +
      `citation if it drifted, or add a CITATION_ALLOWLIST entry with a genuine reason if it is structurally ` +
      `unresolvable:\n  ${messages.join('\n  ')}`
  );
});

test('CITATION_ALLOWLIST has no stale entries -- every entry corresponds to a real EXISTENCE offender this run, or is not needed any more', () => {
  const { allowlisted } = checkCorpus(CITATION_ALLOWLIST);
  const stillFiring = new Set(allowlisted.map((o) => o.key));
  const stale = Object.keys(CITATION_ALLOWLIST).filter((k) => !stillFiring.has(k));
  assert.deepEqual(
    stale,
    [],
    `CITATION_ALLOWLIST entry(ies) that no longer correspond to any EXISTENCE offender -- the citation was fixed, ` +
      `moved, or removed; delete the entry:\n  ${stale.join('\n  ')}`
  );
});

// A sanity floor, not a magic-number ratchet (this design has no exact-count pin -- there is no
// stored registry to keep in sync): the corpus walk and extraction must still be finding citations
// at all. If this ever reports 0, the walk or the extractor broke, not that the corpus emptied out.
test('sanity: the corpus walk finds a non-trivial number of file-tied citations', () => {
  const { total } = checkCorpus(CITATION_ALLOWLIST);
  assert.ok(total > 100, `expected well over 100 file-tied citations across test/**/*.js, found ${total} -- has corpusFiles() or extractCitations() broken?`);
});
