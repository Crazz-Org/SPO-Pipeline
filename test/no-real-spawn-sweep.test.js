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

const REPO_ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(REPO_ROOT, 'test');

// Named, reasoned exceptions -- kept as small as the action 5.0 measurement allows. Every
// test/*.test.js file that ACTUALLY requires an orchestrator module already requires
// test/no-real-spawn.js first (37 files, fixed by this same action) and needs no entry here. A
// file belongs here only when it genuinely can never reach a real spawnSync despite requiring an
// orchestrator module -- do not widen this to "most files don't need it": the whole point of the
// sweep is that nobody can be trusted to make that judgment call file by file, including future
// us.
const ALLOWLIST = {
  // This file's OWN fixture tests below build synthetic source strings containing the literal
  // text `require('../orchestrator/...')` and `require('./no-real-spawn')` as inert string
  // content (not blanked by blankComments, which only strips // and /* */ comments, not string
  // literals) so the scanner under test has something real to scan. Scanned against itself, this
  // file's raw source therefore contains both patterns and would flag as an offender -- a
  // self-match on fixture data, not a real gap. The real behaviour this would otherwise catch (a
  // file requiring an orchestrator module with no killswitch, or with one that arrives too late)
  // is exactly what the fixture tests below already prove the scanner catches.
  'no-real-spawn-sweep.test.js': 'self-scan false positive from this file\'s own fixture strings; see comment above',
  // test/bin-spo-state-write-sweep.test.js used to carry an entry here too, for the identical
  // self-scan false positive (its own fixture strings contain the literal text
  // `require('../orchestrator/journal')` as inert text). Action 7.3's verification found that
  // exemption itself was the gap: a REAL `require('../orchestrator/park-loop')` was added to that
  // file with no killswitch, and this sweep stayed green because the whole file was excused, not
  // because the specific line was ever checked. The fix was to give that file the ONE-LINE
  // killswitch itself -- `require('./no-real-spawn')`, which lands (textually) before the fixture
  // strings that would otherwise trip this sweep, so it satisfies the real rule instead of being
  // excused from it -- and delete the entry that used to sit here. Do not re-add it: if that file
  // ever again needs an allowlist entry instead of the one-line fix, something has regressed.
};

// Same convention as gh-api-argv.test.js's blankComments: blank out comments before searching so
// a file that MENTIONS `require('../orchestrator/...')` or `require('./no-real-spawn')` in prose
// (this file does, in the header above) never counts as satisfying or violating the rule.
function blankComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
}

// Earliest index among several alternative textual forms (single- vs double-quoted require
// calls, with or without the .js suffix), or -1 if none appear anywhere in the file.
function firstIndex(source, patterns) {
  let best = -1;
  for (const p of patterns) {
    const idx = source.indexOf(p);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

// `../bin/` is here for the same reason `../orchestrator/` is, and it is not hypothetical:
// `require('../bin/spo')` transitively loads 28 orchestrator modules, `command-timeout.js`
// among them -- so it destructures the real spawnSync at require time exactly like a direct
// orchestrator require does, and a sweep that only knew the `../orchestrator/` spelling waved
// `test/spo-triage.test.js` straight through.
const ORCHESTRATOR_REQUIRE_PATTERNS = [
  "require('../orchestrator/",
  'require("../orchestrator/',
  "require('../bin/",
  'require("../bin/',
];

// Anchored to a line start (the scanner prepends a newline so line 1 matches too). A killswitch
// require that is present textually but INDENTED is inside a function, a conditional or a block
// -- it may never execute, and a guard that may never execute is not a guard. Every real
// insertion in this suite sits at column 0, so the anchor costs nothing and closes the
// "require is there, guard was never installed" hole.
const KILLSWITCH_REQUIRE_PATTERNS = [
  "\nrequire('./no-real-spawn')",
  '\nrequire("./no-real-spawn")',
  "\nrequire('./no-real-spawn.js')",
  '\nrequire("./no-real-spawn.js")',
];

// checkSource(source) -> null (fine, or nothing to guard) or a reason string (offender). Pure
// text in, verdict out -- exactly as testable against a synthetic fixture string as against a
// real file's contents, which is what the fixture tests below rely on.
function checkSource(source) {
  // The leading newline is what lets the line-anchored killswitch patterns above match a require
  // sitting on the file's very first line. Both index lookups below run against the same padded
  // string, so the +1 shift is common to them and their ordering comparison is unaffected.
  const blanked = '\n' + blankComments(source);
  const orchIndex = firstIndex(blanked, ORCHESTRATOR_REQUIRE_PATTERNS);
  if (orchIndex === -1) return null; // never requires an orchestrator module -- nothing to guard
  const killswitchIndex = firstIndex(blanked, KILLSWITCH_REQUIRE_PATTERNS);
  if (killswitchIndex !== -1 && killswitchIndex < orchIndex) return null;
  if (killswitchIndex === -1) {
    return "requires an orchestrator module but never requires test/no-real-spawn";
  }
  return (
    "requires test/no-real-spawn AFTER its first orchestrator require -- too late, " +
    'orchestrator/command-timeout.js already destructured the real spawnSync by then'
  );
}

// Scans one directory's *.test.js files (non-recursive -- test/ is flat). Returns both the
// offenders (name: reason) and how many files were actually checked, so a caller can pin a
// sanity floor the way gh-api-argv.test.js pins `siteCount >= 4`.
function scanDir(dir, allowlist) {
  const offenders = [];
  let checked = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.test.js')) continue;
    if (Object.prototype.hasOwnProperty.call(allowlist, name)) continue;
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    // Counted AFTER the allowlist skip and after the read actually succeeded, so the floor below
    // measures files this sweep genuinely inspected. Counting on enumeration instead would let a
    // scanner that silently drops or swallows files still clear the floor -- which it did: a
    // mutant skipping every other file, and one swallowing a read error on a real offender, both
    // survived the floor when this increment sat above.
    checked += 1;
    const reason = checkSource(source);
    if (reason) offenders.push(`${name}: ${reason}`);
  }
  return { offenders, checked };
}

test('every test/*.test.js file that requires an orchestrator module installs the no-real-spawn killswitch first', () => {
  const { offenders, checked } = scanDir(TEST_DIR, ALLOWLIST);

  // If this drops well below the current count, the sweep has stopped finding anything (a
  // rename, a moved directory) and a green result would mean nothing -- fail loudly instead,
  // same reasoning as gh-api-argv.test.js's own siteCount floor.
  assert.ok(checked >= 40, `expected to read several dozen test/*.test.js files, read ${checked} -- has the layout changed, or is the scanner dropping files?`);

  assert.deepEqual(
    offenders,
    [],
    'A test file requires an orchestrator module without installing test/no-real-spawn.js FIRST. ' +
      'That is exactly the gap that let a real, in-process spawnSync reach `gh`/`npm` with live ' +
      'pool credentials and post 140 fabricated "Pipeline parked" comments onto a live ' +
      "SPO-WebClient issue (see test/no-real-spawn.js's header for the full incident). Fix: add\n" +
      "    require('./no-real-spawn');\n" +
      "before this file's first require('../orchestrator/...') -- or, if the file genuinely can " +
      'never reach a real spawnSync, add it to this file\'s ALLOWLIST with a one-line reason ' +
      `instead:\n  ${offenders.join('\n  ')}`
  );
});

// ---- fixture tests: the sweep itself, exercised against synthetic files in a tmp dir -----------
// Never written into test/ permanently (that would be either a permanently-failing file or a
// second real killswitch require to maintain forever) -- built fresh per test via
// fs.mkdtempSync(os.tmpdir()), same convention every other fixture-building test in this suite
// already follows.

function fixtureDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('sweep fails a synthetic fixture that requires an orchestrator module without the killswitch', () => {
  const dir = fixtureDir('spo-sweep-missing-');
  fs.writeFileSync(
    path.join(dir, 'fixture-missing.test.js'),
    "'use strict';\nconst { armTimeout } = require('../orchestrator/command-timeout');\n"
  );

  const { offenders } = scanDir(dir, {});

  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /^fixture-missing\.test\.js: requires an orchestrator module but never requires test\/no-real-spawn$/);
});

test('sweep fails a synthetic fixture whose killswitch require lands AFTER its orchestrator require', () => {
  const dir = fixtureDir('spo-sweep-order-');
  fs.writeFileSync(
    path.join(dir, 'fixture-order.test.js'),
    "'use strict';\nconst { armTimeout } = require('../orchestrator/command-timeout');\nrequire('./no-real-spawn');\n"
  );

  const { offenders } = scanDir(dir, {});

  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /too late/);
});

test('sweep passes a synthetic fixture that installs the killswitch before its orchestrator require', () => {
  const dir = fixtureDir('spo-sweep-ok-');
  fs.writeFileSync(
    path.join(dir, 'fixture-ok.test.js'),
    "'use strict';\nrequire('./no-real-spawn');\nconst { armTimeout } = require('../orchestrator/command-timeout');\n"
  );

  const { offenders } = scanDir(dir, {});

  assert.deepEqual(offenders, []);
});

test('sweep passes a synthetic fixture that never requires an orchestrator module at all, killswitch or not', () => {
  const dir = fixtureDir('spo-sweep-none-');
  fs.writeFileSync(path.join(dir, 'fixture-none.test.js'), "'use strict';\nconst fs = require('fs');\n");

  const { offenders } = scanDir(dir, {});

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

  const { offenders } = scanDir(dir, {});

  assert.equal(offenders.length, 1, 'a mention inside a comment must not count as installing the killswitch');
});

test("sweep honours a NAMED allowlist entry, even for a file that requires an orchestrator module with no killswitch", () => {
  const dir = fixtureDir('spo-sweep-allow-');
  fs.writeFileSync(
    path.join(dir, 'fixture-allowed.test.js'),
    "'use strict';\nconst { armTimeout } = require('../orchestrator/command-timeout');\n"
  );

  const withoutAllowlist = scanDir(dir, {});
  assert.equal(withoutAllowlist.offenders.length, 1, 'sanity: the same fixture is an offender with no allowlist entry');

  const withAllowlist = scanDir(dir, { 'fixture-allowed.test.js': 'test fixture -- proves the allowlist mechanism itself' });
  assert.deepEqual(withAllowlist.offenders, []);
});
