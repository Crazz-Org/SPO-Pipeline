'use strict';
// test-comment-citation-sweep.test.js -- action 11.3, #190: `file:line` citations inside `test/`
// comments decay silently as the cited files grow, and nothing catches it (measured on #187, then
// on #190's own evidence: doc-constant-sweep.test.js's own header once cited a `doc/state-machine-
// spec.md` row by line number to justify CITATION_RE's `bin/spo` alternative -- that citation has
// since been DELETED from the file entirely, not re-pinned to a successor line (verified: no
// citation to that spec row exists in doc-constant-sweep.test.js or doc/state-machine-spec.md
// today) -- and two more `bin/spo` citations in test/intake.test.js, all found by a HUMAN
// re-reading the comment, never by a test).
// This is the guard #190 asks for: the SAME pinned-anchor mechanism 11.1 built for corpus-doc
// citations (test/citation-pins.js's resolvePins), pointed at every `test/<name>.js` file's own
// comments instead of at doc/orchestrator/bin/spo prose.
//
// Extraction is shared with test/doc-constant-sweep.test.js, not reimplemented: CITATION_RE /
// extractCitations / stripFences / normalizeWrap all live in test/citation-pins.js, action 11.3
// moved them there for exactly this reuse -- fix pass 11.3 round 2 (#190 verifier finding B5) also
// wired normalizeWrap into THIS file's own extraction (stripFences is still a no-op here, since
// A test/<name>.js file is never markdown, but is applied anyway so "the SAME extraction functions" is
// literally true, not merely extractCitations alone). The resolver (resolvePins) is the same one
// 11.1/11.2 built and proved with a corpus-wide mutation plant.
//
// blankComments below is an EIGHTH copy of the helper tracked by test/blank-comments-sync.test.js
// (KEEP IN SYNC -- see that file's own header for why the duplication is deliberate and the drift
// is not). This file's OWN source must never write a bare node-test glob in a comment, and must
// never open an unterminated block-comment marker in a comment or string -- see
// doc/accepted-gaps.md and this action's own report for the two real instances of that second
// trap this action found and fixed elsewhere in the corpus.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { gitEnv } = require('./helpers');
const { extractCitations, resolvePins, shiftedCitation, parseCitation, stripFences, normalizeWrap, normalizeWrapWithMap, isVacuousClaim } = require('./citation-pins');

const REPO_ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(__dirname, 'fixtures', 'test-comment-citation-pins.json');

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
// corpusFiles() -- D1 (fix pass 11.3, #190 verifier finding): a bare \`git ls-files\` lists only
// TRACKED files, so this sweep's own new files (untracked until the driver commits them) were
// invisible to their own completeness check -- the sweep would go GREEN before a commit and RED
// the moment \`git add\` tracked them, since the corpus it walked silently grew. \`--others
// --exclude-standard\` adds every untracked-but-not-gitignored file to the walk, so a fresh
// \`test/<new-sweep>.test.js\` is covered from the moment it is written, not from the moment it is
// committed.
function corpusFiles() {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', 'test'], { encoding: 'utf8', env: gitEnv() })
    .split('\n')
    .filter(Boolean)
    .filter((f) => f.endsWith('.js'));
}

// extractFileCitations(rel) -- every citation this sweep cares about in one file's own comments,
// in document order, WITH an occurrence index per distinct `${rel} :: ${raw}` pair (several real
// comments cite the identical fact more than once in the same file -- test/doc-constant-sweep.test.js
// has several such repeats -- and each occurrence needs its own registry entry, keyed by
// citing file + citation text + occurrence index, so a repeating fixture value can never hide
// which specific mention is being checked; test/park-reason-doc-sweep.test.js's own "a repeating
// fixture hides which value is keyed" trap).
function extractFileCitations(rel) {
  const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const cText = commentsOnly(source);
  const fenceStripped = stripFences(cText); // no-op for a test source file (never markdown), applied anyway
  // so "the SAME extraction functions doc-constant-sweep uses" is literally true, not merely
  // extractCitations alone (fix pass 11.3 round 2, #190 verifier finding B5).
  const { text: normalized, map } = normalizeWrapWithMap(fenceStripped);
  const cites = extractCitations(normalized).filter((c) => !c.unanchored);
  const seen = new Map();
  return cites.map((c) => {
    const key = `${rel} :: ${c.raw}`;
    const occurrence = seen.get(key) || 0;
    seen.set(key, occurrence + 1);
    const origIdx = map[c.idx] !== undefined ? map[c.idx] : c.idx;
    const citingLine = fenceStripped.slice(0, origIdx).split('\n').length;
    return { citingFile: rel, citation: c.raw, occurrence, citingLine };
  });
}

// commentLinesOf(rel) -- the SAME commentsOnly text, split into lines, cached -- used by the
// claim-proximity check below to look at the ±3 lines around a citation without re-reading and
// re-blanking the file for every pin.
const _commentLineCache = new Map();
function commentLinesOf(rel) {
  if (!_commentLineCache.has(rel)) {
    _commentLineCache.set(rel, commentsOnly(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')).split('\n'));
  }
  return _commentLineCache.get(rel);
}

function allCorpusCitations() {
  const out = [];
  for (const rel of corpusFiles()) out.push(...extractFileCitations(rel));
  return out;
}

function regKey(c) {
  return `${c.citingFile} :: ${c.citation} #${c.occurrence}`;
}

// ---- the registry ------------------------------------------------------------------------------
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const REGISTRY_PINS = registry.pins; // [{ citingFile, citation, occurrence, at, first, last?, path? }]
const REGISTRY_ALLOWLIST = registry.allowlist; // { "<file> :: <citation> #<n>": "<reason>" }

function pinRegKey(p) {
  return `${p.citingFile} :: ${p.citation} #${p.occurrence}`;
}

// ALLOWLIST_CATEGORIES -- fix pass 11.3 (#190 verifier finding D4): a closed set, so a new
// allowlist entry cannot invent its own excuse. Every entry in the registry's `allowlist` map is
// now `{ category, reason }`, never a bare reason string.
const ALLOWLIST_CATEGORIES = new Set([
  'illustrative',
  'quoted-as-wrong',
  'hypothetical-example',
  'wrong-when-written',
  'deleted-file',
  'extraction-gap',
  'no-claim-in-prose',
  'ambiguous-bare-path',
]);

// D6 (fix pass 11.3, #190 verifier finding): a stray slash-star inside a STRING or a code line
// (never inside a whole-line // comment, which blankComments already blanks first) opens a
// phantom block-comment span that runs to the next unrelated '*/' anywhere later in the file --
// this action found and fixed two live instances (an assert message in doc-constant-sweep.test.js,
// a criterion fixture string in protected-files-guard.test.js) that each blanked hundreds of real
// lines from this sweep's own extraction. Re-measured corpus-wide so a THIRD instance cannot land
// silently: no scanned file may open a block span longer than a small, named tolerance (a real
// '/** ... */' JSDoc comment, or the short fixture strings gh-api-argv.test.js/
// park-reason-doc-sweep.test.js deliberately carry to test this exact trap on ANOTHER file, are
// the only shapes that legitimately exist here today). Fix pass 11.3 round 3 (#190 verifier
// finding 5): the corpus's largest real span today is 6 lines, so a per-file KNOWN_SHORT_PHANTOM_SPANS
// exception list (an earlier draft carried 20 entries here) is never actually consulted at
// tolerance 8 -- removed rather than kept as dead weight; if a future short, legitimate block span
// ever needs an exception, raise PHANTOM_SPAN_TOLERANCE_LINES with a comment naming which file, not
// a silently-unreachable allowlist.
const PHANTOM_SPAN_TOLERANCE_LINES = 8;

test('no scanned test source file opens a phantom block-comment span longer than the known, named tolerance -- the slash-star-in-a-string trap this action found twice', () => {
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

// ---- checking functions (fix pass 11.3 round 2, #190 verifier finding A2) --------------------
// Extracted to module scope, named, and exported so the hermetic mutation tests further below can
// call the REAL production checks against a synthetic bad fixture -- proving each check actually
// fires, not merely that today's real registry happens to have zero violations (Set-semantics
// reimplemented in a fixture test would prove nothing about whether the SWEEP's own code path is
// wired up).

// A pin is either a CLAIM pin (`claim` a non-empty string, no `claimless`) or a CLAIMLESS pin
// (`claimless: true`, no `claim`, `category: 'no-claim-in-prose'`, and a `reason` -- fix pass
// 11.3 round 3, #190 verifier finding 1, driver decision). Exactly one of the two shapes, never
// both, never neither.
function checkDuplicatesClaimsAndCategories(pins, allowlist, allowlistCategories) {
  const offenders = [];
  const seen = new Set();
  for (const p of pins) {
    const k = pinRegKey(p);
    if (seen.has(k)) offenders.push(`duplicate registry pin entry: ${k}`);
    seen.add(k);
    if (p.claimless) {
      if (p.claim !== undefined) {
        offenders.push(`pin ${k} is claimless but also carries a \`claim\` -- a pin is either a claim pin or a claimless pin, never both.`);
      }
      if (p.category !== 'no-claim-in-prose') {
        offenders.push(`claimless pin ${k} has category "${p.category}" -- a claimless pin's category must be "no-claim-in-prose" (that IS what claimless means).`);
      }
      if (!(typeof p.reason === 'string' && p.reason.trim().length > 0)) {
        offenders.push(`claimless pin ${k} carries no \`reason\``);
      }
    } else if (!(typeof p.claim === 'string' && p.claim.length > 0)) {
      offenders.push(`pin ${k} carries no \`claim\` and is not marked \`claimless\` -- every pin in THIS registry must be one shape or the other (fix pass 11.3, #190 verifier finding D2/D3): the pin must tie back to what the citing comment actually says, not merely to whatever text sits at the cited number.`);
    }
  }
  for (const [k, entry] of Object.entries(allowlist)) {
    if (seen.has(k)) offenders.push(`registry key ${k} is both a pin and an allowlist entry`);
    seen.add(k);
    if (!(entry && typeof entry === 'object')) {
      offenders.push(`allowlist entry ${k} is not a { category, reason } object`);
      continue;
    }
    if (!allowlistCategories.has(entry.category)) {
      offenders.push(`allowlist entry ${k} has unknown category "${entry.category}" -- must be one of: ${[...allowlistCategories].join(', ')}`);
    }
    if (!(typeof entry.reason === 'string' && entry.reason.trim().length > 0)) {
      offenders.push(`allowlist entry ${k} has no reason`);
    }
  }
  return offenders;
}

// checkClaimlessReasonsQuoteFirst(pins) -- fix pass 11.3 round 3 (#190 verifier finding 1): a
// claimless pin's `reason` must quote its OWN `first` line's exact (trimmed) text in backticks --
// this forces the text to have actually been read (not just copy-pasted from elsewhere), the same
// spirit as the claim-proximity tie for claim pins, applied to a pin that has no claim to tie.
function checkClaimlessReasonsQuoteFirst(pins) {
  const offenders = [];
  for (const p of pins) {
    if (!p.claimless) continue;
    const quoted = '`' + p.first.trim() + '`';
    if (!p.reason.includes(quoted)) {
      offenders.push(`${pinRegKey(p)} -- reason does not quote the edge line's exact text ${quoted}`);
    }
  }
  return offenders;
}

function checkNoDuplicateReasons(allowlist) {
  const byReason = new Map(); // reason -> Set(citation text)
  for (const k of Object.keys(allowlist)) {
    const reason = allowlist[k].reason;
    const citation = k.split(' :: ')[1].replace(/ #\d+$/, '');
    if (!byReason.has(reason)) byReason.set(reason, new Set());
    byReason.get(reason).add(citation);
  }
  return [...byReason.entries()]
    .filter(([, citations]) => citations.size > 1)
    .map(([reason, citations]) => `"${reason.slice(0, 60)}..." shared by: ${[...citations].join(', ')}`);
}

// checkClaimProximity(pins, deps) -- `deps.getCommentLines`/`deps.getFileCitations` default to the
// real corpus readers (commentLinesOf/extractFileCitations) but are injectable so a hermetic
// fixture test can feed synthetic file content without touching disk (A2(ii)).
function checkClaimProximity(pins, deps = {}) {
  const getCommentLines = deps.getCommentLines || commentLinesOf;
  const getFileCitations = deps.getFileCitations || extractFileCitations;
  const offenders = [];
  for (const p of pins) {
    if (p.claimless) continue; // no claim to tie to the prose -- checkClaimlessReasonsQuoteFirst covers it instead
    const lines = getCommentLines(p.citingFile);
    // p.citingLine is not stored in the registry itself (it is re-derived, the same way the
    // COMPLETENESS check re-derives it) -- look the pin up by its own (citingFile, citation,
    // occurrence) key against a fresh extraction, so this can never drift from what
    // COMPLETENESS itself considers the citing line to be.
    const liveHere = getFileCitations(p.citingFile).find((c) => c.citation === p.citation && c.occurrence === p.occurrence);
    if (!liveHere) continue; // COMPLETENESS already reports a dead entry for this case
    const winFrom = Math.max(0, liveHere.citingLine - 4);
    const winTo = Math.min(lines.length, liveHere.citingLine + 3);
    const window = lines.slice(winFrom, winTo).join('\n');
    if (!window.includes(p.claim)) {
      offenders.push(`${pinRegKey(p)} -- claim "${p.claim}" not found within +/-3 lines of citing line ${liveHere.citingLine} in ${p.citingFile}`);
    }
  }
  return offenders;
}

test('the registry (test/fixtures/test-comment-citation-pins.json) has no duplicate entries, every pin carries a claim, and every allowlist entry has a known category and a non-empty reason', () => {
  const offenders = checkDuplicatesClaimsAndCategories(REGISTRY_PINS, REGISTRY_ALLOWLIST, ALLOWLIST_CATEGORIES);
  assert.deepEqual(offenders, [], `registry shape violation(s):\n  ${offenders.join('\n  ')}`);
});

test('no two allowlist entries share an identical reason string unless their citation text is identical', () => {
  const offenders = checkNoDuplicateReasons(REGISTRY_ALLOWLIST);
  assert.deepEqual(
    offenders,
    [],
    'two allowlist entries with DIFFERENT citation text share the identical reason string -- a copy-pasted reason that does not actually name what is specific about each fact is a bulk allowlist in disguise.'
  );
});

test('every pin\'s claim occurs verbatim in its OWN citing comment text within +/-3 lines of the citation -- that is what ties the pin to the prose, not merely to the cited file', () => {
  const offenders = checkClaimProximity(REGISTRY_PINS);
  assert.deepEqual(offenders, [], `pin(s) whose claim is not actually near the citation it is supposed to justify:\n  ${offenders.join('\n  ')}`);
});

test('every claimless pin\'s reason quotes its own edge line\'s exact text in backticks', () => {
  const offenders = checkClaimlessReasonsQuoteFirst(REGISTRY_PINS);
  assert.deepEqual(offenders, [], `claimless pin(s) whose reason does not quote the edge text:\n  ${offenders.join('\n  ')}`);
});

test('COMPLETENESS: every file-tied comment citation in the test/ corpus (flat test-file modules plus every fixtures subdirectory file) has exactly one registry entry (a pin or a named allowlist reason) -- no more, no fewer, none dead', () => {
  const live = allCorpusCitations();
  const liveKeys = new Set(live.map(regKey));

  const registryKeys = new Set([...REGISTRY_PINS.map(pinRegKey), ...Object.keys(REGISTRY_ALLOWLIST)]);

  const lineByKey = new Map(live.map((c) => [regKey(c), c.citingLine]));
  const missing = live.map(regKey).filter((k) => !registryKeys.has(k));
  const missingWithLines = missing.map((k) => `${k} (line ${lineByKey.get(k)})`);
  assert.deepEqual(
    missingWithLines,
    [],
    `citation(s) found in a test/ comment with NO registry entry -- a new file:line citation was written into a ` +
      `test comment without recording the cited text; add a pin (the exact text) or an allowlist entry (a reason) ` +
      `to test/fixtures/test-comment-citation-pins.json for each:\n  ${missingWithLines.join('\n  ')}`
  );

  const dead = [...registryKeys].filter((k) => !liveKeys.has(k));
  assert.deepEqual(
    dead,
    [],
    `registry entry(ies) with no corresponding citation left in the corpus (the comment was edited, moved, or ` +
      `removed without updating the registry) -- remove them:\n  ${dead.join('\n  ')}`
  );
});

// ---- resolution ----------------------------------------------------------------------------
function toResolvePin(p) {
  return { file: p.citingFile, citation: p.citation, at: p.at, first: p.first, last: p.last, path: p.path, claim: p.claim };
}

test('RESOLUTION: every pinned citation in the registry resolves -- the exact text at the pinned line(s), at HEAD or the frozen commit', () => {
  const results = resolvePins(REGISTRY_PINS.map(toResolvePin));
  const offenders = results.filter((r) => !r.ok).map((r) => r.why);
  assert.deepEqual(
    offenders,
    [],
    `pinned citation(s) failed to resolve -- either the cited file drifted (fix the citing comment AND re-pin the ` +
      `registry entry together) or the registry text itself is stale:\n  ${offenders.join('\n  ')}`
  );
});

// ---- mutation proof: every pin, every drift shape ----------------------------------------------
// Same method as test/doc-constant-sweep.test.js's own corpus-wide mutation proof (11.1): plant a
// start-1/start+1/stop-1/stop+1/whole-range-shift drift for every RANGE pin, and a +/-1 drift for
// every SINGLE-LINE pin, skipping only a shift that would run off either end of the real file (no
// neighbouring line exists there to be confused with). Killed count must equal planted count,
// survivors credited only via EDGE_TEXT_NOT_DISCRIMINATING, by name, with a reason -- reused
// verbatim from doc-constant-sweep.test.js's own classifySurvivors idiom (kept as a small local
// copy here since that function lives inline in a *.test.js file that must not be required, per
// this action's own report on why blankComments is duplicated rather than shared that way).
function classifySurvivors(survivors, allowlist) {
  const allowedKeys = new Set(Object.keys(allowlist));
  const allowed = survivors.filter((s) => allowedKeys.has(s.split(' -- ')[0]));
  const unexpected = survivors.filter((s) => !allowedKeys.has(s.split(' -- ')[0]));
  return { allowed, unexpected };
}

// Measured empirically by this action's own mutation-proof run below: EMPTY is the honest result
// -- every planted drift across this registry's pins is caught. Fix pass 11.3 round 2 (#190
// verifier finding A4) corrected two things that used to make this non-empty: (1) the
// bin-spo-state-write-sweep.test.js range used to end on bin/spo's OWN closing brace (a lone `}`,
// indistinguishable from the NEXT function's closing brace one line below) -- re-pinned to end one
// line earlier, on `setInterval(generateOnce, 30000);` itself, distinctive text a stop+1 drift
// cannot land on and still match; (2) this file's own header used to PIN two adjacent lone braces
// by line number for no reason other than illustrating the shape -- dropped the line numbers
// entirely (named by symbol -- generateOnce's own closing brace, and the enclosing command's,
// right below it -- instead), since a pin on text that cannot discriminate a neighbour proves
// nothing and only invites exactly the "genuine edge" entries this constant exists to avoid
// accumulating. A future pin landing on a real, unavoidable edge is added here BY NAME, with a
// reason, exactly like doc-constant-sweep.test.js's own EDGE_TEXT_NOT_DISCRIMINATING.
const EDGE_TEXT_NOT_DISCRIMINATING = {};

test('EDGE_TEXT_NOT_DISCRIMINATING holds exactly the pins this action measured unable to discriminate a neighbouring line -- no more, no fewer', () => {
  assert.deepEqual(
    Object.keys(EDGE_TEXT_NOT_DISCRIMINATING).sort(),
    [].sort(),
    'EDGE_TEXT_NOT_DISCRIMINATING changed -- read the new entry by hand and justify it here before pinning it.'
  );
});

// Pinned population -- this action's own report has the full breakdown (live-HEAD / frozen-
// history / reused-from-an-existing-pin, and why). 219 pins measured 2026-09-14 (fix pass 11.3 round 3, final -- 148 claim pins + 71 claimless pins) against this
// registry; a resize is caught by NAME here, not merely by the mutation-proof test's own count.
const REGISTRY_PIN_COUNT = 219;
// 637 planted drifts across 219 pins (each RANGE pin plants 6 variants -- start-1/start+1/stop-1/
// stop+1/shift-1/shift+1 -- each SINGLE-LINE pin plants 2 -- line-1/line+1 -- minus the handful
// that would run off either end of their file and are skipped). Measured, not assumed; the test
// below recomputes this from the registry's own pins and fails by NAME if it no longer matches.
const REGISTRY_VARIANT_COUNT = 637;

test('MUTATION PROOF, every pin: a start-1/start+1/stop-1/stop+1/whole-range-shift drift (or a +/-1 drift for a single line) is caught by resolvePins, for EVERY pin in this registry -- not a sample', () => {
  const pins = REGISTRY_PINS.map(toResolvePin);
  const base = resolvePins(pins);
  const offenders = base.filter((r) => !r.ok).map((r) => r.why);
  assert.deepEqual(offenders, [], `a pin used as this mutation proof's own baseline is not itself green -- fix the pin, not the proof:\n  ${offenders.join('\n  ')}`);

  const variants = []; // { pinIndex, kind, shifted }
  pins.forEach((pin, i) => {
    const lineCount = base[i].lineCount;
    const isRange = pin.last !== undefined;
    const { start, stop } = parseCitation(pin.citation);
    const plant = (kind, startDelta, stopDelta) => {
      const newStart = start + startDelta;
      const newStop = stop + stopDelta;
      if (newStart < 1 || newStart > lineCount || newStop < 1 || newStop > lineCount) return;
      variants.push({ pinIndex: i, kind, shifted: { ...pin, citation: shiftedCitation(pin.citation, startDelta, stopDelta) } });
    };
    if (isRange) {
      plant('start-1', -1, 0);
      plant('start+1', 1, 0);
      plant('stop-1', 0, -1);
      plant('stop+1', 0, 1);
      plant('shift-1', -1, -1);
      plant('shift+1', 1, 1);
    } else {
      plant('line-1', -1, -1);
      plant('line+1', 1, 1);
    }
  });

  // Exact, measured totals -- a bare floor stays green even if the registry silently shrank; see
  // this action's own report for how these numbers were produced.
  assert.equal(pins.length, REGISTRY_PIN_COUNT, `expected ${REGISTRY_PIN_COUNT} pins, found ${pins.length} -- the registry changed size; re-measure and update this pin.`);
  assert.equal(variants.length, REGISTRY_VARIANT_COUNT, `expected exactly ${REGISTRY_VARIANT_COUNT} planted drifts across ${REGISTRY_PIN_COUNT} pins, found ${variants.length} -- a pin lost or gained line-count headroom, or the registry changed size; re-measure.`);

  const results = resolvePins(variants.map((v) => v.shifted));
  const survivors = [];
  results.forEach((r, idx) => {
    if (r.ok) survivors.push(`${variants[idx].shifted.file} :: ${pins[variants[idx].pinIndex].citation} -- ${variants[idx].kind} drift (now "${variants[idx].shifted.citation}") still reads as correct`);
  });
  const killed = results.length - survivors.length;

  const { allowed: allowedSurvivors, unexpected: unexpectedSurvivors } = classifySurvivors(survivors, EDGE_TEXT_NOT_DISCRIMINATING);

  assert.deepEqual(
    unexpectedSurvivors,
    [],
    `planted drift(s) NOT caught by resolvePins and not on EDGE_TEXT_NOT_DISCRIMINATING -- either the resolver ` +
      `loosened, or this pin genuinely cannot discriminate a neighbouring line and belongs on that allowlist with ` +
      `a reason:\n  ${unexpectedSurvivors.join('\n  ')}`
  );
  assert.equal(
    killed + allowedSurvivors.length,
    variants.length,
    `expected every planted drift to be either caught (${killed}) or explicitly allowlisted (${allowedSurvivors.length}) -- ${variants.length} planted; see the survivor list above for which and why.`
  );
  const survivorKeysSeen = new Set(survivors.map((s) => s.split(' -- ')[0]));
  const staleAllowlistEntries = Object.keys(EDGE_TEXT_NOT_DISCRIMINATING).filter((k) => !survivorKeysSeen.has(k));
  assert.deepEqual(staleAllowlistEntries, [], `EDGE_TEXT_NOT_DISCRIMINATING entry(ies) that no longer correspond to any actual planted-drift survivor -- remove them:\n  ${staleAllowlistEntries.join('\n  ')}`);
});

// D9 (fix pass 11.3, #190 verifier finding): hermetic proofs that the two primitives
// COMPLETENESS itself depends on are correct, independent of the real corpus currently having no
// gaps to exercise them against -- the same "prove the mechanism, not just today's zero result"
// posture doc-constant-sweep.test.js's own classifySurvivors fixture test already takes.

// M2: a citation present in a synthetic "live" extraction but ABSENT from a synthetic registry
// must be reported missing -- proves the missing-detection arithmetic (Set membership over
// regKey-shaped strings) independent of whatever the real corpus and real registry currently hold.
test('M2 -- COMPLETENESS\'s own missing-citation check: a live citation with no registry entry is reported, one that has an entry is not', () => {
  const fakeLive = [
    { citingFile: 'test/fake-a.test.js', citation: 'real.js:10', occurrence: 0, citingLine: 5 },
    { citingFile: 'test/fake-a.test.js', citation: 'real.js:20', occurrence: 0, citingLine: 9 },
  ];
  const fakeRegistryKeys = new Set(['test/fake-a.test.js :: real.js:10 #0']); // only the FIRST is registered
  const liveKeys = fakeLive.map(regKey);
  const missing = liveKeys.filter((k) => !fakeRegistryKeys.has(k));
  assert.deepEqual(missing, ['test/fake-a.test.js :: real.js:20 #0'], 'the unregistered citation must be the one reported missing');
  assert.ok(!missing.includes('test/fake-a.test.js :: real.js:10 #0'), 'the registered citation must NOT be reported missing');
});

// M3: an allowlist (or pin registry) lookup matches an EXACT key only -- a key that is merely a
// PREFIX or SUBSTRING of a real entry must not be treated as covered. This is the per-fact (never
// per-file, never per-prefix) discipline test/doc-constant-sweep.test.js's own isCitationAllowlisted
// fixture test (M13) already proves for CITATION_ALLOWLIST; this is the same proof for THIS
// registry's own occurrence-suffixed key shape.
test('M3 -- registry key matching is EXACT: a key that is a prefix or substring of a real entry is not treated as present', () => {
  const registryKeys = new Set(['test/fake-a.test.js :: real.js:10 #0']);
  assert.equal(registryKeys.has('test/fake-a.test.js :: real.js:10 #0'), true, 'the exact key must match');
  assert.equal(registryKeys.has('test/fake-a.test.js :: real.js:10'), false, 'a key missing the occurrence suffix must NOT match');
  assert.equal(registryKeys.has('test/fake-a.test.js :: real.js:1'), false, 'a citation-text PREFIX must NOT match');
  assert.equal(registryKeys.has('fake-a.test.js :: real.js:10 #0'), false, 'a citingFile SUBSTRING (missing the test/ prefix) must NOT match');
});

test('registry population is exactly what this action measured: 219 pins (148 claim + 71 claimless) + 67 allowlist entries = 286 registry entries', () => {
  assert.equal(REGISTRY_PINS.length, 219, `expected 219 pins, found ${REGISTRY_PINS.length}`);
  assert.equal(REGISTRY_PINS.filter((p) => p.claimless).length, 71, `expected 71 claimless pins, found ${REGISTRY_PINS.filter((p) => p.claimless).length}`);
  assert.equal(REGISTRY_PINS.filter((p) => !p.claimless).length, 148, `expected 148 claim pins, found ${REGISTRY_PINS.filter((p) => !p.claimless).length}`);
  assert.equal(Object.keys(REGISTRY_ALLOWLIST).length, 67, `expected 67 allowlist entries, found ${Object.keys(REGISTRY_ALLOWLIST).length}`);
});

test('allowlist per-category counts are exactly what this action measured (fix pass 11.3, D4)', () => {
  const EXPECTED_CATEGORY_COUNTS = {
    illustrative: 28,
    'quoted-as-wrong': 30,
    'hypothetical-example': 4,
    'wrong-when-written': 0,
    'deleted-file': 1,
    'extraction-gap': 0,
    'no-claim-in-prose': 4,
    'ambiguous-bare-path': 0,
  };
  const actual = {};
  for (const cat of Object.keys(EXPECTED_CATEGORY_COUNTS)) actual[cat] = 0;
  for (const entry of Object.values(REGISTRY_ALLOWLIST)) actual[entry.category] = (actual[entry.category] || 0) + 1;
  assert.deepEqual(actual, EXPECTED_CATEGORY_COUNTS, 'allowlist category counts changed -- a category grew or shrank; re-measure and update this pin by name.');
});

// ---- A1: vacuous-claim rejection is mechanical (fix pass 11.3 round 2, #190 verifier finding A1) --
// isVacuousClaim lives in citation-pins.js (exported for reuse); these are hermetic fixture tests
// of the REAL function, one per rule, plus a corpus-wide sweep that no CURRENT pin's claim violates
// any of the three rules.

test('isVacuousClaim rule (a): a claim that is only a stopword/generic word, or a bare brace, is rejected', () => {
  assert.equal(isVacuousClaim('own', 'lock.js:276').vacuous, true, '"own" is on CLAIM_STOPWORDS');
  assert.equal(isVacuousClaim('}', 'bin/spo:1294').vacuous, true, 'a bare "}" is on CLAIM_STOPWORDS');
  assert.equal(isVacuousClaim('{', 'bin/spo:10').vacuous, true, 'a bare "{" is on CLAIM_STOPWORDS');
  assert.equal(isVacuousClaim('OWN', 'lock.js:276').vacuous, true, 'the stopword check is case-insensitive');
  assert.equal(isVacuousClaim('purgeDone', 'worker.ts:922').vacuous, false, 'a real identifier is not a stopword');
});

test('isVacuousClaim rule (b): a claim that is a substring of its own citation text is rejected', () => {
  assert.equal(isVacuousClaim('lock.js', 'orchestrator/lock.js:276').vacuous, true, '"lock.js" repeats the cited filename');
  assert.equal(isVacuousClaim('README', 'README.md:34').vacuous, true, '"README" repeats the cited filename');
  assert.equal(isVacuousClaim('lease', 'account-lease.js:156').vacuous, true, '"lease" is contained in the cited filename');
  assert.equal(isVacuousClaim('LEASE', 'account-lease.js:156').vacuous, true, 'the substring check is case-insensitive');
  assert.equal(isVacuousClaim('acquireShortLock', 'account-lease.js:156').vacuous, false, 'a real identifier is not a filename substring');
});

test('isVacuousClaim rule (c): a claim shorter than 4 characters is rejected UNLESS it has a non-word character', () => {
  assert.equal(isVacuousClaim('ref', 'worker.ts:751').vacuous, true, '"ref" is 3 chars with no non-word character');
  assert.equal(isVacuousClaim('LLM', 'bin/spo:1891').vacuous, true, '"LLM" is 3 chars with no non-word character');
  assert.equal(isVacuousClaim("'--base',", 'real-steps.test.js:1827').vacuous, false, 'short but has non-word characters -- allowed');
  assert.equal(isVacuousClaim('board:take', 'scripted.js:1295').vacuous, false, 'has a non-word character (":") -- allowed regardless of length');
  assert.equal(isVacuousClaim('CHECK', 'doc/state-machine-spec.md:159').vacuous, false, '5 plain characters clears the length floor on its own');
});

test('no pin currently in the registry has a vacuous claim under any of the three rules', () => {
  const offenders = [];
  for (const p of REGISTRY_PINS) {
    if (p.claimless) continue; // no claim to check -- claimless pins are exempt by design (item 1)
    const v = isVacuousClaim(p.claim, p.citation);
    if (v.vacuous) offenders.push(`${pinRegKey(p)} -- claim "${p.claim}" -- ${v.reason}`);
  }
  assert.deepEqual(offenders, [], `pin(s) with a vacuous claim -- use a better token from the citing prose, or allowlist no-claim-in-prose:\n  ${offenders.join('\n  ')}`);
});

// ---- A2: hermetic mutation tests on the REAL sweep code (fix pass 11.3 round 2, #190 verifier
// finding A2) -- each fixture plants exactly the bad shape the corresponding check exists to
// catch, and asserts the REAL function (not a reimplementation) reports it.

// ---- shared normalizeWrap (fix pass 11.3 round 3, #190 verifier finding 7) --------------------
// normalizeWrapWithMap now lives in citation-pins.js (this file's own former mirror, plus its
// self-check against citation-pins.js's normalizeWrap, is deleted -- there is exactly one join
// implementation, not two kept in sync by an assertion). One hermetic proof that the offset MAP
// itself is correct, independent of the real corpus: a citation split across a wrapped line must
// report the line the WRAP STARTED on (where the citation's own text begins), not a line invented
// by the collapse.
test('normalizeWrap(s) === normalizeWrapWithMap(s).text for every wrap shape (-, /, //, *, #) -- one implementation, no divergence possible', () => {
  const fixtures = [
    'doc/state-machine-\nspec.md:49 (hyphen wrap)',
    'orchestrator/\nstate-machine.js:216 (slash wrap)',
    '// a line comment continuation\n// on the next line, no citation shape',
    '/* a block comment\n * continued with a star leader */',
    '# a shell-style comment\n# continued with a hash leader',
    'plain prose that wraps\nwith no leader at all',
  ];
  for (const s of fixtures) {
    assert.equal(normalizeWrap(s), normalizeWrapWithMap(s).text, `normalizeWrap and normalizeWrapWithMap.text must agree on: ${JSON.stringify(s)}`);
  }

  // Mutation proof: a DIVERGENT standalone normalizeWrap (here, one that forgets to join on "/")
  // must disagree with normalizeWrapWithMap's text -- proving this consistency check is actually
  // sensitive to the two implementations drifting apart, not vacuously true by construction.
  function divergentNormalizeWrap(src) {
    // Only joins on "-", never on "/" -- the bug this proof must catch.
    let text = src.replace(/(-)\r?\n[ \t]*(?:\/\/|\*(?!\/)|#)?[ \t]*/g, '$1');
    text = text.replace(/[ \t]*\r?\n[ \t]*(?:\/\/|\*(?!\/)|#)?[ \t]*/g, ' ');
    return text;
  }
  const slashFixture = 'orchestrator/\nstate-machine.js:216 (slash wrap)';
  assert.notEqual(divergentNormalizeWrap(slashFixture), normalizeWrapWithMap(slashFixture).text, 'a normalizeWrap that does not join on "/" must be caught disagreeing with normalizeWrapWithMap');
});

test('normalizeWrapWithMap: a citation wrapped across a line break maps to its correct ORIGINAL line', () => {
  const src = [
    'line one',
    '// see orchestrator/state-',
    '// machine.js:216 for detail',
    'line four',
  ].join('\n');
  const { text, map } = normalizeWrapWithMap(src);
  assert.match(text, /orchestrator\/state-machine\.js:216/, 'the wrap must still join into one contiguous citation');
  const idx = text.indexOf('orchestrator/state-machine.js:216');
  const origIdx = map[idx];
  const citingLine = src.slice(0, origIdx).split('\n').length;
  assert.equal(citingLine, 2, 'the citation must map back to line 2 (where "orchestrator/state-" itself starts), not line 3 or some other collapsed position');

  // Mutation proof: a map entry pointing at the WRONG original position (here, deliberately
  // corrupted to point at "line four" instead of the citation's own real line 2) must report a
  // DIFFERENT line -- proving the assertion above is actually reading `map`, not returning a
  // constant that happens to equal 2.
  const corruptedMap = map.slice();
  corruptedMap[idx] = src.indexOf('line four');
  const corruptedLine = src.slice(0, corruptedMap[idx]).split('\n').length;
  assert.notEqual(corruptedLine, citingLine, 'a corrupted map entry must disagree with the correct map -- if this ever passes, the test above is not actually sensitive to the map');
});

test('A2(i): resolvePins\' own claim check -- a claim present in the comment but absent from the cited span is reported', () => {
  // Exercise resolvePins (citation-pins.js's real production function, not a reimplementation)
  // against a REAL file/line whose text is known (this file's own first line), with a claim that
  // does not occur there -- proves the claim check itself, independent of file resolution.
  const results = resolvePins([{ file: 'test/citation-pins.js', citation: 'test/citation-pins.js:1', at: 'HEAD', first: "'use strict';", claim: 'THIS_TOKEN_DOES_NOT_APPEAR_ANYWHERE_NEAR_LINE_1' }]);
  assert.equal(results[0].ok, false, 'a claim absent from the cited span must fail resolvePins');
  assert.match(results[0].why, /claim not found in span/, 'the failure reason must name the claim check specifically');
});

test('A2(ii): the +/-3-line proximity tie -- a claim present in the target span but NOT near the citing comment is reported', () => {
  const fakePin = { citingFile: 'test/fake-b.test.js', citation: 'real.js:50', occurrence: 0, claim: 'FAR_AWAY_TOKEN' };
  // Synthetic corpus: the claim text sits on line 1 of the "comment lines", but the citation
  // itself is reported at line 40 -- 39 lines away, far outside the +/-3 window.
  const fakeLines = ['FAR_AWAY_TOKEN', ...Array(60).fill('')];
  const offenders = checkClaimProximity([fakePin], {
    getCommentLines: () => fakeLines,
    getFileCitations: () => [{ citingFile: 'test/fake-b.test.js', citation: 'real.js:50', occurrence: 0, citingLine: 40 }],
  });
  assert.equal(offenders.length, 1, 'a claim far from its own citing line must be reported');
  assert.match(offenders[0], /not found within \+\/-3 lines/);
});

test('A2(iii): the allowlist reason-uniqueness check -- two entries with DIFFERENT citation text sharing an identical reason are reported', () => {
  const fakeAllowlist = {
    'test/fake-c.test.js :: real.js:1 #0': { category: 'illustrative', reason: 'the exact same copy-pasted reason' },
    'test/fake-c.test.js :: real.js:2 #0': { category: 'illustrative', reason: 'the exact same copy-pasted reason' },
  };
  const offenders = checkNoDuplicateReasons(fakeAllowlist);
  assert.equal(offenders.length, 1, 'two different citations sharing one reason string must be reported');
});

test('A2(iv): category validation -- an allowlist entry with an unknown category is reported', () => {
  const fakePins = [];
  const fakeAllowlist = { 'test/fake-d.test.js :: real.js:1 #0': { category: 'not-a-real-category', reason: 'a real, specific reason' } };
  const offenders = checkDuplicatesClaimsAndCategories(fakePins, fakeAllowlist, ALLOWLIST_CATEGORIES);
  assert.equal(offenders.some((o) => /unknown category/.test(o)), true, 'an unknown category must be reported');
});
// ---- claimless pins (fix pass 11.3 round 3, #190 verifier finding 1, driver decision) ---------
// An allowlist entry catches nothing (a future drift at that citation is invisible). A claimless
// pin -- verified edge text, no claim, `claimless: true` -- still goes red on future drift, the
// same as any other pin; it just has no fact from the prose to additionally tie to.

test('a claimless pin whose reason does not quote its own `first` text is reported', () => {
  const fakePins = [{ citingFile: 'test/fake-e.test.js', citation: 'real.js:1', occurrence: 0, at: 'HEAD', first: 'const x = 1;', claimless: true, category: 'no-claim-in-prose', reason: 'this reason never quotes the edge text at all' }];
  const offenders = checkClaimlessReasonsQuoteFirst(fakePins);
  assert.equal(offenders.length, 1, 'a claimless pin whose reason omits the backtick-quoted edge text must be reported');
});

test('a claimless pin whose reason DOES quote its own `first` text passes', () => {
  const fakePins = [{ citingFile: 'test/fake-e.test.js', citation: 'real.js:1', occurrence: 0, at: 'HEAD', first: 'const x = 1;', claimless: true, category: 'no-claim-in-prose', reason: 'bare cross-reference; edge line is `const x = 1;`' }];
  const offenders = checkClaimlessReasonsQuoteFirst(fakePins);
  assert.deepEqual(offenders, [], 'a claimless pin whose reason quotes the exact trimmed edge text must not be reported');
});

test('a claimless pin is still drift-checked by resolvePins -- a planted +/-1 on it goes red', () => {
  // Exercise the REAL resolvePins against a real file/line, claimless (no `claim` key at all),
  // then shift it by one line -- proving claimless pins are not silently exempted from the
  // mutation-proof mechanism the way an allowlist entry always is.
  const basePin = { file: 'test/citation-pins.js', citation: 'test/citation-pins.js:1', at: 'HEAD', first: "'use strict';" };
  const base = resolvePins([basePin]);
  assert.equal(base[0].ok, true, 'the baseline claimless-shaped pin must itself resolve correctly');
  const shifted = resolvePins([{ ...basePin, citation: shiftedCitation(basePin.citation, 1) }]);
  assert.equal(shifted[0].ok, false, 'a +1 drift on a claimless pin must still be caught by resolvePins');
});

test('a claimless pin carrying a `claim` is rejected -- a pin is either shape, never both', () => {
  const fakePins = [{ citingFile: 'test/fake-f.test.js', citation: 'real.js:1', occurrence: 0, at: 'HEAD', first: 'const x = 1;', claim: 'x', claimless: true, category: 'no-claim-in-prose', reason: 'edge line is `const x = 1;`' }];
  const offenders = checkDuplicatesClaimsAndCategories(fakePins, {}, ALLOWLIST_CATEGORIES);
  assert.equal(offenders.some((o) => /claimless but also carries a `claim`/.test(o)), true, 'a claimless pin that also carries a claim must be rejected');
});



// A2(v): two allowlist entries swapping categories with the aggregate counts unchanged -- a pure
// count-based test (like the one above) cannot catch this by construction (the totals are
// identical before and after the swap). Fix pass 11.3 round 3 (#190 verifier finding 6): a
// per-key snapshot, kept READABLE (a sorted key->category fixture file, diffable in an ordinary
// review) rather than a SHA-256 digest -- a hash changing tells you SOMETHING moved; this tells
// you what.
const CATEGORY_SNAPSHOT_PATH = path.join(__dirname, 'fixtures', 'test-comment-citation-category-snapshot.json');

function categorySnapshotOf(allowlist) {
  const out = {};
  for (const k of Object.keys(allowlist).sort()) out[k] = allowlist[k].category;
  return out;
}

// diffCategorySnapshots(expected, actual) -- returns { added, removed, recategorized }: keys only
// in `actual` (added), keys only in `expected` (removed), and keys in both whose category differs
// (recategorized, "key: from -> to"). A pure equality assert would just say "these two objects
// differ"; this names EXACTLY what changed, the same discipline COMPLETENESS's own missing/dead
// split already uses.
function diffCategorySnapshots(expected, actual) {
  const added = Object.keys(actual).filter((k) => !(k in expected));
  const removed = Object.keys(expected).filter((k) => !(k in actual));
  const recategorized = Object.keys(expected)
    .filter((k) => k in actual && expected[k] !== actual[k])
    .map((k) => `${k}: ${expected[k]} -> ${actual[k]}`);
  return { added, removed, recategorized };
}

const EXPECTED_CATEGORY_SNAPSHOT = JSON.parse(fs.readFileSync(CATEGORY_SNAPSHOT_PATH, 'utf8'));

test('A2(v): the per-key allowlist category snapshot is exactly what this action measured -- a swap between two entries is reported as a RECATEGORIZATION even though the aggregate counts would not change', () => {
  // Hermetic proof the diff itself is swap-sensitive, independent of the real registry's current
  // contents: two synthetic entries, then the same two with their categories swapped, must be
  // reported as two recategorizations even though a per-category COUNT over the two sets is
  // identical either way.
  const before = { a: { category: 'illustrative', reason: 'x' }, b: { category: 'quoted-as-wrong', reason: 'y' } };
  const swapped = { a: { category: 'quoted-as-wrong', reason: 'x' }, b: { category: 'illustrative', reason: 'y' } };
  const swapDiff = diffCategorySnapshots(categorySnapshotOf(before), categorySnapshotOf(swapped));
  assert.deepEqual(swapDiff.added, [], 'a swap adds no keys');
  assert.deepEqual(swapDiff.removed, [], 'a swap removes no keys');
  assert.deepEqual(swapDiff.recategorized.sort(), ['a: illustrative -> quoted-as-wrong', 'b: quoted-as-wrong -> illustrative'].sort(), 'a swap between two keys must be reported as two recategorizations');

  // The real registry's own snapshot, checked against the fixture file by NAME -- a future edit
  // that swaps two entries' categories (leaving the aggregate counts test further up green, since
  // the swap does not change any category's total) is reported HERE, by exactly which keys moved.
  const actual = categorySnapshotOf(REGISTRY_ALLOWLIST);
  const diff = diffCategorySnapshots(EXPECTED_CATEGORY_SNAPSHOT, actual);
  assert.deepEqual(
    diff,
    { added: [], removed: [], recategorized: [] },
    `allowlist category snapshot changed -- update ${CATEGORY_SNAPSHOT_PATH} to match, having first confirmed by eye that each change below is correct, not just copied to make this pass:\n` +
      `  added: ${diff.added.join(', ') || '(none)'}\n` +
      `  removed: ${diff.removed.join(', ') || '(none)'}\n` +
      `  recategorized: ${diff.recategorized.join('; ') || '(none)'}`
  );
});
