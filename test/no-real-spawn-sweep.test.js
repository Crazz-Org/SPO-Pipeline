'use strict';
// A standing guard over test/no-real-spawn.js's own placement rule, modelled directly on
// test/gh-api-argv.test.js's pattern: read the SOURCE of every test file rather than trust anyone
// to remember a convention by hand. gh-api-argv.test.js sweeps orchestrator/ for a call-site
// shape; this sweeps test/ for a REQUIRE-ORDER shape -- they are deliberately not merged, since
// one is about what argv a `gh api` call builds and this one is about which module gets patched
// before which other module can capture a reference to it.
//
// The rule: any test/*.test.js file that requires an orchestrator module
// (`require('../orchestrator/...')`) must require test/no-real-spawn.js FIRST, textually earlier
// in the file. Action 5.0 measured why this has to be an enforced rule and not a convention people
// remember: test/transient-retry.test.js's first cut called finalizePark in real mode with no
// injected deps, fell through to the REAL child_process.spawnSync, and park-loop.js's
// postParkComment posted 140 fabricated "Pipeline parked" comments onto a live SPO-WebClient issue
// in one hour of mutation testing -- see test/no-real-spawn.js's header for the full incident and
// for why the ORDER matters (orchestrator/command-timeout.js destructures spawnSync off
// child_process at require time, so patching it after that require has already run does nothing).
// A repo-wide probe re-measured the whole suite and found two more files leaking five more real
// spawns despite the "every spawn here is a fake" convention every file's own header already
// claimed -- this sweep is what turns "we measured it once" into "it stays true".
//
// Text-based, like gh-api-argv.test.js, for the same reason: a new test file added tomorrow that
// requires an orchestrator module is covered without anyone remembering to add it to a registry.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mkTmp } = require('./helpers');

const REPO_ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(REPO_ROOT, 'test');

// Named, reasoned exceptions -- kept as small as the action 5.0 measurement allows. Every
// test/*.test.js file that ACTUALLY requires an orchestrator module already requires
// test/no-real-spawn.js first (37 files, fixed by this same action) and needs no entry here. A
// file belongs here only when it genuinely can never reach a real spawnSync despite requiring an
// orchestrator module -- do not widen this to "most files don't need it": the whole point of the
// sweep is that nobody can be trusted to make that judgment call file by file, including future
// us.
//
// Scoped by PATTERN, not by whole file (card Crazz-Org/SPO-Pipeline#82 part 2): an allowlisted
// file is still read and still scanned in full. Only the individual occurrences whose CONTAINING
// LINE includes one of the entry's declared `patterns` are exempt; every other occurrence in the
// same file still fails the sweep. Before this, a whole-file entry here silently covered
// everything in the file forever -- test/bin-spo-state-write-sweep.test.js carried exactly that
// entry, and a REAL `require('../orchestrator/park-loop')` with no killswitch landed in it and
// stayed green, because the sweep never even read the file's other lines (see the historical note
// preserved below the ALLOWLIST for the full account).
//
// Each entry is a Map value `{ reason, patterns }`: `reason` is the human explanation, `patterns`
// a non-empty array of literal substrings. A pattern must be narrow enough that it cannot appear
// on a genuine offending line -- see `validateAllowlist` below for the one hard rule this is
// checked against (a pattern must CONTAIN one of the sweep's own detection patterns and add at
// least one character after it; anything else is rejected outright, which subsumes both "matches
// every line" and "is the bare prefix"), and the comments beside each pattern for why THIS one is
// safe.
//
// Pinned by name a few lines down (`assert.deepEqual([...ALLOWLIST.keys()], [...])`), the same
// convention test/no-git-env-sweep.test.js uses for its own FILE_ALLOWLIST: adding a new
// exemption requires editing that assertion too, not just this map.
//
// A gotcha for whoever adds the next entry: writing another file's offending require-text into
// THIS map (to declare the pattern that exempts it) puts that same text into THIS file's own raw
// source, which can create a brand-new, unexempted hit right here -- the self-scan problem this
// whole ALLOWLIST exists to solve, recursively. That is fail-loud (the sweep will name this file
// and the new line), not a silent gap, so just add a pattern for it the same way the existing
// entries below do -- don't be surprised by it.
const ALLOWLIST = new Map([
  [
    'no-real-spawn-sweep.test.js',
    {
      reason:
        "self-scan false positives from this file's own fixture strings and its own " +
        'ORCHESTRATOR_REQUIRE_PATTERNS/KILLSWITCH_REQUIRE_PATTERNS array literals -- see the ' +
        "fixture tests below and the pattern-definition arrays for where each pattern here " +
        'actually occurs. None of these lines is a real require of an orchestrator module by ' +
        'this file (this file never requires one for real; the fixture tests below already prove ' +
        'the scanner catches the real thing).',
      patterns: [
        // ORCHESTRATOR_REQUIRE_PATTERNS's own four array entries, a few dozen lines down. They
        // unavoidably contain the exact substrings this sweep searches for -- they ARE those
        // substrings. Each pattern here is the FULL array-literal text (the prefix plus its
        // closing quote and comma), never the bare "require('../orchestrator/" prefix alone: the
        // bare prefix is also what a genuine offending call would contain, so allowlisting the
        // bare prefix would silently re-widen this back into a whole-file exemption. No real
        // `require(...)` call ends in `",` or `',` immediately after the directory slash -- that
        // would be requiring the empty path.
        // Written as template literals (not single/double-quoted strings) specifically so THIS
        // line's own raw text is not itself mangled by an escape backslash: the value contains
        // both a `'` and a `"`, and escaping either one with a single/double-quoted string would
        // put a `\` between "require('" and "../orchestrator" on THIS line, which would then no
        // longer contain the plain, unescaped "require('../orchestrator/" substring the sweep
        // searches for -- silently failing to self-exempt. A backtick string needs no escape for
        // either quote character, so the raw line matches its own declared value verbatim.
        `require('../orchestrator/",`,
        `require("../orchestrator/',`,
        `require('../bin/",`,
        `require("../bin/',`,
        // The two spellings added for card #205, anchored to their own array-literal punctuation
        // exactly as the four above are -- never the bare prefix.
        `require('../console/",`,
        `require("../console/',`,
        `require('../scripts/",`,
        `require("../scripts/',`,
        // The main sweep test's own assertion-failure message below, which spells the rule out
        // with a literal "..." placeholder instead of a real module name.
        "require('../orchestrator/...')",
        // The fixture tests' synthetic `fs.writeFileSync` source strings, written to build
        // throwaway files that exercise the scanner -- inert string content here, never executed
        // by this file itself.
        //
        // NOT the bare module calls (`require('../orchestrator/command-timeout')` /
        // `.../config')`) -- that was itself a per-module blanket exemption of the same SHAPE as
        // the old whole-file entry: narrower, but still capable of silently exempting a genuine
        // future `require('../orchestrator/command-timeout')` typed at column 0 in this file for
        // real. Each pattern below is instead anchored to the exact fixture-source-string context
        // it appears in, the same way the four array-literal patterns above are anchored to their
        // own array-literal context. `\n` below is written as `\\n` (an escaped backslash) so the
        // resulting VALUE is the two literal characters backslash-then-n -- what these fixture
        // strings actually contain in this file's raw bytes (a real `\n` ESCAPE SEQUENCE as far as
        // Node is concerned once the array runs, but this sweep never executes this file, only
        // reads its raw source text, where a `\n` escape is still just the two characters `\` `n`).
        "\\nconst { armTimeout } = require('../orchestrator/command-timeout');",
        // This one fixture occurrence is a bare array element (built via `[...].join('\n')`, so
        // the `\n` is added at RUNTIME by `.join`, never present as literal text in this file's
        // own source before it) -- with no leading backslash-n marker like the pattern above, the
        // text alone is byte-for-byte indistinguishable from a real top-level statement. Anchored
        // instead to the array-element's OWN trailing punctuation: `",` immediately after the `;`
        // is the closing quote of the JS string literal plus the array-separator comma -- never
        // present after a real statement's semicolon, which is followed by a real newline.
        `const { armTimeout } = require('../orchestrator/command-timeout');",`,
        `["require('../orchestrator/command-timeout')"]`,
        "\\nconst a = require('../orchestrator/command-timeout');",
        "\\nconst b = require('../orchestrator/command-timeout');",
        "require('../orchestrator/config') for context",
        "\\nconst b = require('../orchestrator/config');",
        // The F1-guard fixture test below deliberately writes the BARE detection prefix (with no
        // trailing module name) as allowlist-pattern fixture data, to prove `patternIsTooBroad`
        // rejects it. That fixture text is inert here too -- it is never passed to a real
        // `require`, only to `scanDir` as a synthetic ALLOWLIST entry inside an `assert.throws`.
        // Scoped to the array-literal's own closing `"]`, which a real call never ends in.
        `require('../orchestrator/"]`,
        // The front-padding test below declares one legitimate, module-naming pattern as fixture
        // data, to prove the check does not simply reject everything. Same anchoring as the line
        // above: scoped to the enclosing array literal's `["` ... `"]`, which no real call has.
        `["require('../orchestrator/park-loop')"]`,
      ],
    },
  ],
]);

test('the ALLOWLIST is pinned by name -- adding or removing an entry requires editing this assertion too', () => {
  assert.deepEqual(
    [...ALLOWLIST.keys()],
    ['no-real-spawn-sweep.test.js'],
    'ALLOWLIST gained or lost an entry without this pin being updated -- edit this assertion ' +
      'alongside the map, the same discipline test/no-git-env-sweep.test.js applies to its own ' +
      'FILE_ALLOWLIST'
  );
});

// Historical note, kept for the next person tempted to add a whole-file entry here again:
// test/bin-spo-state-write-sweep.test.js used to carry an entry in this ALLOWLIST too, for the
// identical self-scan false positive (its own fixture strings contain the literal text
// `require('../orchestrator/journal')` as inert text). Action 7.3's verification found that
// exemption itself was the gap: a REAL `require('../orchestrator/park-loop')` was added to that
// file with no killswitch, and this sweep stayed green because the whole file was excused, not
// because the specific line was ever checked. The fix was to give that file the ONE-LINE
// killswitch itself -- `require('./no-real-spawn')`, which lands (textually) before the fixture
// strings that would otherwise trip this sweep, so it satisfies the real rule instead of being
// excused from it -- and delete the entry that used to sit here. Do not re-add it: if that file
// ever again needs an allowlist entry instead of the one-line fix, something has regressed.

// blankComments: blank out comments before searching, so a file that MENTIONS
// `require('../orchestrator/...')` or `require('./no-real-spawn')` in prose (this file does, in
// the header above) never counts as satisfying or violating the rule.
//
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

// `../bin/` is here for the same reason `../orchestrator/` is, and it is not hypothetical:
// `require('../bin/spo')` transitively loads 28 orchestrator modules, `command-timeout.js`
// among them -- so it destructures the real spawnSync at require time exactly like a direct
// orchestrator require does, and a sweep that only knew the `../orchestrator/` spelling waved
// `test/spo-triage.test.js` straight through.
//
// `../console/` and `../scripts/` joined them for card SPO-Pipeline#205 (2026-09-12). Same
// argument, one indirection further out: this sweep reads each test file's own TEXT and never
// follows a require, so a file that reaches an orchestrator module only THROUGH a console module
// was never asked for the killswitch. Measured at the time: `console/serve` alone already loads
// 11 orchestrator modules, and six test files requiring `../console/` carried no killswitch at
// all (`dashboard-system`, `dashboard-usage-rollups`, `dashboard-serve`, `dashboard-prod-version`,
// `dashboard-usage-scan`, `usage-report`). The card's own probe planted a top-level spawn in
// `console/usage-scan.js` and watched it RUN, in the parent test process, with this sweep green
// at 16 pass / 0 fail. `../scripts/` is included on the same reasoning before it can bite:
// `scripts/usage-report.js` is required by tests the same way.
//
// Widening the patterns is only half of it -- the six files above were given the killswitch in
// the same change, because a pattern nothing satisfies fails the suite instead of guarding it.
const ORCHESTRATOR_REQUIRE_PATTERNS = [
  "require('../orchestrator/",
  'require("../orchestrator/',
  "require('../bin/",
  'require("../bin/',
  "require('../console/",
  'require("../console/',
  "require('../scripts/",
  'require("../scripts/',
];

// Anchored to a line start -- checked by `findOccurrences` below via "index 0, or the previous
// character is a newline". A killswitch require that is present textually but INDENTED is inside
// a function, a conditional or a block -- it may never execute, and a guard that may never
// execute is not a guard. Every real insertion in this suite sits at column 0, so the anchor
// costs nothing and closes the "require is there, guard was never installed" hole.
const KILLSWITCH_REQUIRE_PATTERNS = [
  "require('./no-real-spawn')",
  'require("./no-real-spawn")',
  "require('./no-real-spawn.js')",
  'require("./no-real-spawn.js")',
];

// Every index at which `pattern` occurs in `text` (overlaps excluded, which is fine -- none of
// our patterns can overlap themselves), earliest first.
function findAllIndices(text, pattern) {
  const out = [];
  let idx = text.indexOf(pattern);
  while (idx !== -1) {
    out.push(idx);
    idx = text.indexOf(pattern, idx + 1);
  }
  return out;
}

// 1-based line number of character `index` in `text`.
function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

// Every occurrence of any of `patterns` in `blanked`, as `{ index, line }`, sorted by index. When
// `anchored` is true an occurrence only counts if it sits at column 0 (index 0, or immediately
// preceded by a newline) -- see the KILLSWITCH_REQUIRE_PATTERNS comment above for why that matters
// for a killswitch require and not for an orchestrator require.
function findOccurrences(blanked, patterns, anchored) {
  const hits = [];
  for (const pattern of patterns) {
    for (const index of findAllIndices(blanked, pattern)) {
      if (anchored && index !== 0 && blanked[index - 1] !== '\n') continue;
      hits.push({ index });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((hit) => ({ ...hit, line: lineNumberAt(blanked, hit.index) }));
}

// Every detection pattern the sweep itself searches for -- the set that defines what counts as an
// "occurrence" in the first place. Used below to state, and check, the actual property an
// allowlist pattern must have: not merely "non-empty", but strictly narrower than what makes a
// line a hit at all.
const ALL_DETECTION_PATTERNS = [...ORCHESTRATOR_REQUIRE_PATTERNS, ...KILLSWITCH_REQUIRE_PATTERNS];

// Stated as a REQUIREMENT a pattern must meet, not as a blocklist of bad shapes: a pattern is
// admissible only if it contains one of the sweep's own detection patterns *and adds at least one
// character after it*. Anything else is "too broad".
//
// Why that exact shape, and why the requirement rather than a prohibition. Every "hit" this sweep
// can ever report is, by construction, a line that CONTAINS one of ORCHESTRATOR_REQUIRE_PATTERNS
// or KILLSWITCH_REQUIRE_PATTERNS verbatim -- that containment IS the definition of a hit. A
// detection pattern D always stops immediately after the directory slash
// (`require('../orchestrator/`), so the module name is exactly the text that comes AFTER D on a
// real call line. A pattern that reaches past D therefore has to commit to something specific
// about the particular line it exempts; a pattern that does not reach past D commits to nothing,
// and exempts every occurrence the sweep can find via D in that file.
//
// An earlier cut of this check tested the OPPOSITE containment -- reject P when P is a substring
// of some D -- and was reported as still-open by verification. That rule does catch `''` (a
// substring of every D) and the bare prefix `require('../orchestrator/` (equal to D). But
// substring-of only looks in one direction, and prepending a single character escapes it: neither
// `= require('../orchestrator/` nor `= require('../` is a substring of any D, so both were
// accepted -- and `= require('../` exempted 3 of 3 genuine unguarded requires in a probe fixture,
// a total whole-file disarm, reached by pasting the *most natural* spelling of a require line.
// Requiring forward extension closes that whole class at once: those patterns end at (or before)
// the end of D, so they add nothing after it, so they are rejected -- and so is `''`, which
// contains no D at all. The empty string and the bare prefix are then not special cases to
// enumerate; they simply fail the one requirement.
//
// What this deliberately forbids: exempting a line by a marker that does not touch the require
// text (a trailing `// sweep-fixture`, say). That is a real restriction and it is the point --
// such a marker can be pasted onto a genuine call line later, whereas a pattern anchored to the
// require text plus its own trailing delimiter (`require('../orchestrator/",` -- the array
// literal's closing quote and comma, never present after a real call, which names a module before
// closing) cannot drift onto one. Every pattern in this file's own ALLOWLIST entry above is of
// that anchored shape.
function patternIsTooBroad(pattern) {
  return !ALL_DETECTION_PATTERNS.some((detectionPattern) => {
    const at = pattern.indexOf(detectionPattern);
    return at !== -1 && at + detectionPattern.length < pattern.length;
  });
}

// Throws (rather than returning offenders) on a malformed ALLOWLIST, because a bad entry here is
// an authoring mistake in the sweep itself, not a finding about test/ -- the same posture
// test/no-git-env-sweep.test.js takes with its own `assert.deepEqual([...FILE_ALLOWLIST.keys()])`
// pin. In particular this is what stands between "quieting one false positive" and "silently
// re-disabling the whole file for it": an entry whose pattern matches every line is exactly a
// whole-file exemption wearing a `patterns` array.
function validateAllowlist(allowlist) {
  for (const [file, entry] of allowlist) {
    if (!entry || typeof entry.reason !== 'string' || entry.reason.length === 0) {
      throw new Error(`ALLOWLIST entry for "${file}" must carry a non-empty reason string`);
    }
    if (!Array.isArray(entry.patterns) || entry.patterns.length === 0) {
      throw new Error(`ALLOWLIST entry for "${file}" must declare at least one pattern`);
    }
    for (const pattern of entry.patterns) {
      if (typeof pattern !== 'string') {
        throw new Error(`ALLOWLIST entry for "${file}" has a non-string pattern`);
      }
      if (patternIsTooBroad(pattern)) {
        throw new Error(
          `ALLOWLIST entry for "${file}" has a pattern ("${pattern}") that does not extend one ` +
            "of the sweep's own detection patterns -- it must contain a detection pattern AND " +
            'add at least one character after it. As written it matches every line this sweep ' +
            'could flag in that file, which is a whole-file exemption wearing a narrower mask. ' +
            'Narrow it by reaching PAST the directory slash, into text that appears in the ' +
            'specific fixture/comment line you mean to exempt but never in a genuine call (a ' +
            'closing delimiter, a module name, ...). Adding context in FRONT of the require ' +
            '(`= require(\'../orchestrator/`) does not count -- it exempts every call line.'
        );
      }
    }
  }
}

// checkSource(source, exemptPatterns) -> array of `{ line, reason }` offenses (empty when fine).
// Pure text in, verdict out -- exactly as testable against a synthetic fixture string as against
// a real file's contents, which is what the fixture tests below rely on. `exemptPatterns` is the
// file's own ALLOWLIST patterns (or `[]` for a file with no entry): an occurrence whose containing
// line includes one of them is dropped before the order check runs, so it counts neither as an
// offending orchestrator require nor as a protecting killswitch require.
function checkSource(source, exemptPatterns) {
  const blanked = blankComments(source);
  const lines = blanked.split('\n');
  const isExempt = (line) => exemptPatterns.some((pattern) => line.includes(pattern));

  const orchestratorHits = findOccurrences(blanked, ORCHESTRATOR_REQUIRE_PATTERNS, false).filter(
    (hit) => !isExempt(lines[hit.line - 1])
  );
  if (orchestratorHits.length === 0) return []; // never requires an orchestrator module (for real)

  const killswitchHits = findOccurrences(blanked, KILLSWITCH_REQUIRE_PATTERNS, true).filter(
    (hit) => !isExempt(lines[hit.line - 1])
  );
  const firstKillswitchIndex = killswitchHits.length ? killswitchHits[0].index : -1;

  const offenses = [];
  for (const hit of orchestratorHits) {
    if (firstKillswitchIndex !== -1 && firstKillswitchIndex < hit.index) continue; // protected
    const reason =
      firstKillswitchIndex === -1
        ? 'requires an orchestrator module but never requires test/no-real-spawn'
        : 'requires test/no-real-spawn AFTER its first orchestrator require -- too late, ' +
          'orchestrator/command-timeout.js already destructured the real spawnSync by then';
    offenses.push({ line: hit.line, reason });
  }
  return offenses;
}

// Scans one directory's *.test.js files (non-recursive -- test/ is flat). Returns both the
// offenders (`file:line: reason`) and how many files were actually checked, so a caller can pin a
// sanity floor the way gh-api-argv.test.js pins `siteCount >= 4`. An allowlisted file is still
// read and scanned in full -- see the ALLOWLIST comment above for why that is the whole point.
function scanDir(dir, allowlist) {
  validateAllowlist(allowlist);
  const offenders = [];
  let checked = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.test.js')) continue;
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    // Counted after the read actually succeeded, so `checked` measures files this sweep
    // genuinely inspected rather than merely enumerated. That is NECESSARY for the floor below
    // to be able to notice a scanner that silently drops or swallows files -- but it is not
    // SUFFICIENT on its own: whether it actually catches such a mutant depends entirely on how
    // tight the floor is. Measured directly (see that assertion's comment): with a floor of 40
    // against ~93-95 real files, a scanner mutated to skip every other file still passed, because
    // `checked` merely halved to ~47, which still cleared 40. The floor has to sit close to the
    // real count for this increment's placement to matter at all.
    checked += 1;
    const entry = allowlist.get(name);
    const exemptPatterns = entry ? entry.patterns : [];
    for (const offense of checkSource(source, exemptPatterns)) {
      offenders.push(`${name}:${offense.line}: ${offense.reason}`);
    }
  }
  return { offenders, checked };
}

test('every test/*.test.js file that requires an orchestrator module installs the no-real-spawn killswitch first', () => {
  const { offenders, checked } = scanDir(TEST_DIR, ALLOWLIST);

  // Measured at 96 real test/*.test.js files when this floor was last set (93 pre-existing, plus 3
  // added by concurrent actions in this same worktree while it was being set -- so treat the exact
  // figure as a floor-setting snapshot, not a live invariant). 85 leaves an 11-file margin for
  // ordinary additions/removals without false-tripping, while still being tight enough to fail on
  // a mutant that skips a large fraction of files: a scanner mutated to skip every other file
  // drops `checked` to ~48, below 85 (confirmed by experiment -- the OLD floor of 40 did NOT catch
  // that same mutation, since ~48 still cleared 40; that gap is exactly what raising the floor
  // closes. See the `checked += 1` comment above for why the increment's placement alone was never
  // sufficient).
  //
  // The margin's honest cost, also measured: a mutant that silently drops up to 11 files still
  // clears this floor. The floor counts, it does not identify -- it is a "has the layout changed /
  // is the scanner dropping files wholesale" tripwire, not a per-file guarantee. The per-file
  // guarantee is the offender assertion below, which names any file it can still read.
  assert.ok(checked >= 85, `expected to read close to the real test/*.test.js file count, read ${checked} -- has the layout changed, or is the scanner dropping files?`);

  assert.deepEqual(
    offenders,
    [],
    'A test file requires an orchestrator module without installing test/no-real-spawn.js FIRST. ' +
      'That is exactly the gap that let a real, in-process spawnSync reach `gh`/`npm` with live ' +
      'pool credentials and post 140 fabricated "Pipeline parked" comments onto a live ' +
      "SPO-WebClient issue (see test/no-real-spawn.js's header for the full incident). Fix: add\n" +
      "    require('./no-real-spawn');\n" +
      "before this file's first require('../orchestrator/...') -- or, if the file genuinely can " +
      'never reach a real spawnSync, add it to this file\'s ALLOWLIST with a reason and the ' +
      `specific pattern(s) that cover it instead:\n  ${offenders.join('\n  ')}`
  );
});

// ---- fixture tests: the sweep itself, exercised against synthetic files in a tmp dir -----------
// Never written into test/ permanently (that would be either a permanently-failing file or a
// second real killswitch require to maintain forever) -- built fresh per test via
// fs.mkdtempSync(os.tmpdir()), same convention every other fixture-building test in this suite
// already follows.

function fixtureDir(prefix) {
  return mkTmp(prefix);
}

test('sweep fails a synthetic fixture that requires an orchestrator module without the killswitch', () => {
  const dir = fixtureDir('spo-sweep-missing-');
  fs.writeFileSync(
    path.join(dir, 'fixture-missing.test.js'),
    "'use strict';\nconst { armTimeout } = require('../orchestrator/command-timeout');\n"
  );

  const { offenders } = scanDir(dir, new Map());

  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /^fixture-missing\.test\.js:2: requires an orchestrator module but never requires test\/no-real-spawn$/);
});

test('sweep fails a synthetic fixture whose killswitch require lands AFTER its orchestrator require', () => {
  const dir = fixtureDir('spo-sweep-order-');
  fs.writeFileSync(
    path.join(dir, 'fixture-order.test.js'),
    "'use strict';\nconst { armTimeout } = require('../orchestrator/command-timeout');\nrequire('./no-real-spawn');\n"
  );

  const { offenders } = scanDir(dir, new Map());

  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /^fixture-order\.test\.js:2: .*too late/);
});

test('sweep passes a synthetic fixture that installs the killswitch before its orchestrator require', () => {
  const dir = fixtureDir('spo-sweep-ok-');
  fs.writeFileSync(
    path.join(dir, 'fixture-ok.test.js'),
    "'use strict';\nrequire('./no-real-spawn');\nconst { armTimeout } = require('../orchestrator/command-timeout');\n"
  );

  const { offenders } = scanDir(dir, new Map());

  assert.deepEqual(offenders, []);
});

test('sweep passes a synthetic fixture that never requires an orchestrator module at all, killswitch or not', () => {
  const dir = fixtureDir('spo-sweep-none-');
  fs.writeFileSync(path.join(dir, 'fixture-none.test.js'), "'use strict';\nconst fs = require('fs');\n");

  const { offenders } = scanDir(dir, new Map());

  assert.deepEqual(offenders, []);
});

test('sweep ignores mentions of the require calls inside comments, on both sides of the rule', () => {
  const dir = fixtureDir('spo-sweep-comment-');
  fs.writeFileSync(
    path.join(dir, 'fixture-comment.test.js'),
    [
      "'use strict';",
      "// see require('./no-real-spawn') and require('../orchestrator/config') for context",
      "const { armTimeout } = require('../orchestrator/command-timeout');",
      '',
    ].join('\n')
  );

  const { offenders } = scanDir(dir, new Map());

  assert.equal(offenders.length, 1, 'a mention inside a comment must not count as installing the killswitch');
});

test('sweep honours a NAMED allowlist entry, even for a file that requires an orchestrator module with no killswitch', () => {
  const dir = fixtureDir('spo-sweep-allow-');
  fs.writeFileSync(
    path.join(dir, 'fixture-allowed.test.js'),
    "'use strict';\nconst { armTimeout } = require('../orchestrator/command-timeout');\n"
  );

  const withoutAllowlist = scanDir(dir, new Map());
  assert.equal(withoutAllowlist.offenders.length, 1, 'sanity: the same fixture is an offender with no allowlist entry');

  const withAllowlist = scanDir(
    dir,
    new Map([
      [
        'fixture-allowed.test.js',
        { reason: 'test fixture -- proves the allowlist mechanism itself', patterns: ["require('../orchestrator/command-timeout')"] },
      ],
    ])
  );
  assert.deepEqual(withAllowlist.offenders, []);
});

test('an allowlist entry narrows to its declared pattern(s) -- it does NOT disable the rest of the file', () => {
  const dir = fixtureDir('spo-sweep-scoped-');
  fs.writeFileSync(
    path.join(dir, 'fixture-two-sites.test.js'),
    "'use strict';\nconst a = require('../orchestrator/command-timeout');\nconst b = require('../orchestrator/config');\n"
  );

  // Sanity: with no allowlist at all, both lines are genuine offenders.
  const withoutAllowlist = scanDir(dir, new Map());
  assert.equal(withoutAllowlist.offenders.length, 2, 'sanity: both orchestrator requires are offenders with no allowlist entry');

  // The entry's pattern covers ONLY the command-timeout call (line 2) -- the config call on line
  // 3 uses a different module name and is not covered by that pattern.
  const withAllowlist = scanDir(
    dir,
    new Map([
      [
        'fixture-two-sites.test.js',
        { reason: 'covers only the command-timeout fixture line', patterns: ["require('../orchestrator/command-timeout')"] },
      ],
    ])
  );

  assert.deepEqual(
    withAllowlist.offenders,
    ['fixture-two-sites.test.js:3: requires an orchestrator module but never requires test/no-real-spawn'],
    'the allowlisted pattern should exempt only line 2 -- line 3 must still be reported, by file:line'
  );
});

test('scanDir rejects an allowlist entry whose pattern would match every line', () => {
  const dir = fixtureDir('spo-sweep-wildcard-');
  fs.writeFileSync(
    path.join(dir, 'fixture-wild.test.js'),
    "'use strict';\nconst { armTimeout } = require('../orchestrator/command-timeout');\n"
  );

  assert.throws(
    () => {
      scanDir(
        dir,
        new Map([['fixture-wild.test.js', { reason: 'an empty pattern would exempt every line', patterns: [''] }]])
      );
    },
    /does not extend one of the sweep's own detection patterns/,
    'an empty-string pattern contains no detection pattern at all, so it extends none -- it must be rejected, not silently accepted as a whole-file exemption in disguise'
  );
});

test('scanDir rejects an allowlist pattern that is merely a bare detection prefix, not just a literally empty one', () => {
  // This is the card's own incident, restored through a different door: `require('../orchestrator/`
  // is exactly ORCHESTRATOR_REQUIRE_PATTERNS[0] -- not an empty string, but every bit as capable
  // of exempting every orchestrator-require line in the file, because it IS the substring that
  // makes a line a hit in the first place.
  const dir = fixtureDir('spo-sweep-bare-prefix-');
  fs.writeFileSync(
    path.join(dir, 'fixture-bare.test.js'),
    "'use strict';\nconst a = require('../orchestrator/park-loop');\nconst b = require('../orchestrator/config');\n"
  );

  assert.throws(
    () => {
      scanDir(
        dir,
        new Map([['fixture-bare.test.js', { reason: 'quieting one false positive', patterns: ["require('../orchestrator/"] }]])
      );
    },
    /does not extend one of the sweep's own detection patterns/,
    'a pattern equal to the bare detection prefix must be rejected exactly like an empty pattern -- ' +
      'both let one allowlist entry silently exempt every orchestrator-require line in the file'
  );
});

test('scanDir rejects a pattern that pads a detection prefix in FRONT instead of extending it', () => {
  // The bare-prefix rejection above is not enough on its own. An earlier cut of this check asked
  // "is the pattern a substring of a detection pattern?", which looks in one direction only:
  // prepending a single character escapes it, because `= require('../orchestrator/` is not a
  // substring of anything. It still exempts every conventional `const x = require(...)` line --
  // and `= require('../` (short enough to miss the directory name too) exempted 3 of 3 genuine
  // unguarded requires in the probe that found this. Both must be rejected: leading context is
  // free to add and commits to nothing, so only text AFTER the directory slash counts.
  const dir = fixtureDir('spo-sweep-front-padded-');
  fs.writeFileSync(
    path.join(dir, 'fixture-front.test.js'),
    "'use strict';\nconst a = require('../orchestrator/park-loop');\nconst b = require('../orchestrator/config');\nconst c = require('../bin/spo');\n"
  );

  // Sanity: all three really are offenders, so a pattern that silences them is silencing
  // something real -- not passing vacuously against a fixture with nothing to find.
  assert.equal(scanDir(dir, new Map()).offenders.length, 3, 'sanity: three unguarded requires');

  for (const pattern of ["= require('../orchestrator/", " require('../orchestrator/", "= require('../"]) {
    assert.throws(
      () => {
        scanDir(dir, new Map([['fixture-front.test.js', { reason: 'looks specific, is not', patterns: [pattern] }]]));
      },
      /does not extend one of the sweep's own detection patterns/,
      `pattern ${JSON.stringify(pattern)} adds context only in front of the detection prefix, so it ` +
        'still matches every real call line -- it must be rejected'
    );
  }

  // The converse, so this test cannot pass by rejecting everything: a pattern that genuinely
  // reaches past the directory slash names one module and is accepted, exempting only its own
  // line. Line 3 (`config`) and line 4 (`../bin/spo`) must still be reported.
  const { offenders } = scanDir(
    dir,
    new Map([
      ['fixture-front.test.js', { reason: 'covers only the park-loop line', patterns: ["require('../orchestrator/park-loop')"] }],
    ])
  );
  assert.deepEqual(offenders, [
    'fixture-front.test.js:3: requires an orchestrator module but never requires test/no-real-spawn',
    'fixture-front.test.js:4: requires an orchestrator module but never requires test/no-real-spawn',
  ]);
});

test("an allowlist entry's patterns apply only to its own named file -- a second file matching the same text is still reported", () => {
  const dir = fixtureDir('spo-sweep-crossfile-');
  fs.writeFileSync(
    path.join(dir, 'fixture-a.test.js'),
    "'use strict';\nconst a = require('../orchestrator/command-timeout');\n"
  );
  fs.writeFileSync(
    path.join(dir, 'fixture-b.test.js'),
    "'use strict';\nconst b = require('../orchestrator/command-timeout');\n"
  );

  const { offenders } = scanDir(
    dir,
    new Map([
      [
        'fixture-a.test.js',
        { reason: 'exempts only fixture-a', patterns: ["require('../orchestrator/command-timeout')"] },
      ],
    ])
  );

  assert.deepEqual(
    offenders,
    ['fixture-b.test.js:2: requires an orchestrator module but never requires test/no-real-spawn'],
    "fixture-a's allowlist entry must not leak its pattern onto fixture-b: a scanDir that looked " +
      'up patterns across every entry instead of just the current file\'s own entry would exempt ' +
      "this too, and applying the real ALLOWLIST's patterns file-wide would today silently exempt " +
      '14 genuine orchestrator-require lines across 14 other test files'
  );
});

test('an indented killswitch require does not count as protection -- it may sit inside a function/conditional that never runs', () => {
  const dir = fixtureDir('spo-sweep-indented-');
  fs.writeFileSync(
    path.join(dir, 'fixture-indented.test.js'),
    "'use strict';\n  require('./no-real-spawn');\nconst { armTimeout } = require('../orchestrator/command-timeout');\n"
  );

  const { offenders } = scanDir(dir, new Map());

  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /^fixture-indented\.test\.js:3: requires an orchestrator module but never requires test\/no-real-spawn$/);
});

test('an allowlisted pattern that covers a killswitch occurrence exempts it too -- an exempted killswitch require must not count as protection', () => {
  const dir = fixtureDir('spo-sweep-inert-killswitch-');
  fs.writeFileSync(
    path.join(dir, 'fixture-inert-killswitch.test.js'),
    "'use strict';\nrequire('./no-real-spawn');\nconst { armTimeout } = require('../orchestrator/command-timeout');\n"
  );

  const { offenders } = scanDir(
    dir,
    new Map([
      [
        'fixture-inert-killswitch.test.js',
        {
          // Includes the trailing `;` so this pattern is a proper SUPERSET of
          // KILLSWITCH_REQUIRE_PATTERNS[0] rather than equal to (or a substring of) it -- the
          // narrower, valid shape `patternIsTooBroad` requires. A pattern equal to the bare
          // `require('./no-real-spawn')` detection string would itself be rejected as too broad.
          reason: "fixture: this file's killswitch require is declared inert for this test",
          patterns: ["require('./no-real-spawn');"],
        },
      ],
    ])
  );

  assert.equal(offenders.length, 1, 'the exempted killswitch occurrence must not protect the real orchestrator require');
  assert.match(offenders[0], /^fixture-inert-killswitch\.test\.js:3: requires an orchestrator module but never requires test\/no-real-spawn$/);
});

test('scanDir rejects an allowlist entry with no patterns or no reason', () => {
  assert.throws(
    () => scanDir(fixtureDir('spo-sweep-malformed-a-'), new Map([['x.test.js', { reason: 'ok', patterns: [] }]])),
    /must declare at least one pattern/
  );
  assert.throws(
    () => scanDir(fixtureDir('spo-sweep-malformed-b-'), new Map([['x.test.js', { reason: '', patterns: ['whatever'] }]])),
    /must carry a non-empty reason string/
  );
});
