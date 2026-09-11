'use strict';
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident and test/no-real-spawn-sweep.js's own
// enforcement of "this require comes first". This file requires no orchestrator module today (its
// checkFile/checkSource machinery below is plain string processing over source read with plain
// fs.readFileSync), so nothing here could reach a real spawnSync as written -- but action 7.3's
// own verification is exactly why this line stays anyway: a real `require('../orchestrator/park-
// loop')` (which transitively loads command-timeout.js, destructuring the real spawnSync at
// require time) was added here with no killswitch and no test caught it, because the whole-file
// exemption this file used to carry in no-real-spawn-sweep.test.js's own ALLOWLIST made that sweep
// blind to this file entirely. Putting the require here instead -- ahead of the fixture strings
// below that (as inert text) happen to satisfy the sweep's own pattern-match too -- means this
// file earns a clean pass the same way every other file in test/ does, with no standing exemption
// for anyone to widen later.
require('./no-real-spawn');

// A standing guard over one half of the taskDir single-writer invariant orchestrator/journal.js
// documents (see that file's own header, "THE taskDir SINGLE-WRITER INVARIANT"): a scanner-or-
// maintainer-facing process may only WRITE into a taskDir under a journal root when the task is
// terminal or its owner is dead. `spo status` / `task` / `parked` / `tokens` / `resume` /
// `reports` are read-only over taskDirs today -- that is precisely what keeps a maintainer running
// `spo status` (or a `--serve` dashboard polling every 30s) from ever becoming a SECOND writer
// racing a live worker's own state-machine transitions. Nothing in the type system or the CLI
// framework enforces that; it is true only because nobody has written the code that would break
// it. This test is that enforcement.
//
// SCOPE: bin/spo itself, plus every console/*.js module it reaches through require(), directly or
// transitively -- a write any number of requires deeper than bin/spo itself is just as real a
// violation of the invariant above and would otherwise be invisible to a sweep that only ever
// opened bin/spo. CARD #189 CORRECTION: this sentence used to say "one module deeper", and
// SCAN_FILES was a hand list built to match -- bin/spo:210-211's eager `require('../console/
// collect')`/`require('../console/render')`, and bin/spo:1174-1177's `--serve`-only
// `require('../console/serve')`/`.../system`/`.../prod-version`/`.../usage-scan`. That list missed
// bin/spo:1199-1215's static-mode generateOnce() -- run once unconditionally, and again every 30s
// under `spo dashboard --watch` (bin/spo:1217-1220); NOT gated behind `--serve`, which returns
// earlier at :1190 -- and its own lazy `require('../console/par-times')` at :1204-1205, whose
// byte-identical plant went undetected there while the same plant in console/collect.js was
// caught. SCAN_FILES below is still a literal list, readable at a glance without running
// deriveConsoleModules() to see what it scans, but deriveConsoleModules() further down walks
// bin/spo's own require('../console/X') call sites and, from there, every console module's own
// require('./X') (or, equivalently, require('../console/X')) call sites on other console modules --
// covering TOP-LEVEL console/*.js files only (a require into a SUBDIRECTORY of console/,
// a SYMLINKED DIRECTORY there, or one naming a .cjs/.mjs file, would evade both this walk and the
// on-disk listing the tests below compare it against; a THIRD test guards that specific gap by
// asserting console/ contains none of those shapes). Three tests check this machinery's output:
// one that SCAN_FILES scans everything the walk reaches, one that the walk reaches exactly the
// top-level console/*.js files that exist on disk (neither more nor fewer), and one that console/
// never grows a subdirectory, a symlink, or a .cjs/.mjs file in the first place. So a future
// require this list forgets to list, a require spelling the walk's own regex cannot parse, or a
// file shape none of this machinery was built to see, fails one of those
// tests instead of silently going unscanned. Measured today, that walk's closure is all 11 files in
// console/, including three reached only two or three requires deep (console/live-step.js via
// serve.js, console/render-deck.js via render.js, and console/plain-language.js via render.js ->
// render-deck.js). console/usage-rollups.js and console/par-times.js are the two console modules in
// this graph that already make DIRECT fs write calls to paths unrelated to state.json today
// (usage-rollups.js's own tmp-then-rename idiom, saving usage rollups; par-times.js:87's
// writeFileSync in saveParTimes, saving par-times.json) -- "direct" because console/serve.js also
// TRIGGERS real writes (refreshParTimes at :207, saveRollups at :238, appendDaemonEvent at :249)
// without any fs.* WRITE call of its own (serve.js does call fs.readdirSync and fs.existsSync in
// its own source, at :55/:61/:65 -- reads, not writes), which is a different thing from what this
// sweep's write-callee regex looks for. Keeping usage-rollups.js and par-times.js in the scanned set
// is what proves this sweep can walk right past a real write to an UNRELATED file without
// false-flagging it, rather than the "clean" result being an artifact of never looking at a file
// with any writes in it at all.
//
// Modelled directly on test/gh-api-argv.test.js and test/no-real-spawn-sweep.test.js: read the
// SOURCE rather than mock anything, for the same reason both of those give -- a future subcommand
// added to bin/spo (or a future write added to one of these console modules) tomorrow is covered
// without anyone remembering to add it to a registry. Two shapes are swept for, both of which
// would put a taskDir's state.json under a second writer:
//   1. A write-shaped fs call (writeFileSync/writeFile/appendFileSync/appendFile, sync or
//      fs.promises, AND renameSync/rename/cpSync/cp/copyFileSync/copyFile -- see below for why the
//      rename family matters) whose own argument list either names `state.json` literally, or
//      passes a variable this file can trace back to an assignment that itself named
//      `state.json` literally.
//   2. A `writeState(...)` call not prefixed by `accounts.` -- the shape a new subcommand would
//      use if it imported orchestrator/journal.js's own writeState (the exact function
//      state-machine.js's snapshot() uses to write a taskDir's state.json today, on every ordinary
//      transition AND on a crash repark's own finalizePark call -- CARD #78 CORRECTION: this used
//      to also name dispatcher.js's reparkCrashedWorker as a writeState caller; it no longer is.
//      reparkCrashedWorker now only SPAWNS a one-shot `daemon.js --repark-task` child and returns
//      -- the write itself happens inside THAT child's process, via state-machine.js's
//      reparkCrashedTask -> finalizePark -> snapshot() -> writeState, never on dispatcher.js's own
//      thread) and called it, however it was imported: bare (destructured) or
//      through a namespace object (`journal.writeState(...)`) -- bin/spo's OWN dominant import
//      style is namespace objects (`accounts.`, `intake.`, `autoTriage.`, `reportIntake.`,
//      `remoteReportPull.`, `recette.` -- bin/spo:212-223), so a namespaced `journal.writeState`
//      is if anything the MORE likely future spelling, not an edge case to special-case away.
//      `accounts.writeState(...)` is the one deliberate exclusion: it writes the claude-accounts
//      POOL's own state.json (cooldowns/disabled markers), a completely different file under a
//      completely different directory, governed by no live-worker invariant at all -- bin/spo
//      already reads the pool (accounts.readState) with no corresponding restriction, and
//      treating that call as an offender would be a false positive with no protection behind it.
//
// WHY THE RENAME FAMILY MATTERS, not just writeFileSync: journal.js's own writeState is itself a
// tmp-then-rename write --
//   const target = path.join(taskDir, 'state.json');
//   const tmp = path.join(taskDir, `.state.json.${process.pid}.${Date.now()}.tmp`);
//   fs.writeFileSync(tmp, ...);
//   fs.renameSync(tmp, target);
// -- and the literal `state.json` never appears inside the fs.renameSync(...) call's OWN argument
// list; it is one statement earlier, in the `target` assignment. A sweep that only checked each
// write call's own argument text for the literal would walk straight past this, which is exactly
// the real function this test exists to guard against a REIMPLEMENTATION of. The taint-tracking
// below (findStateJsonTaintedVars) is what closes that gap: it records `target` (and `tmp`, whose
// OWN initializer also names `state.json` inside the template literal) as tainted, then flags any
// write-shaped call that references either tainted name -- matching this exact idiom.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_FILES = [
  'bin/spo',
  'console/collect.js',
  'console/render.js',
  'console/serve.js',
  'console/system.js',
  'console/prod-version.js',
  'console/usage-scan.js',
  'console/usage-rollups.js',
  'console/par-times.js',
  'console/live-step.js',
  'console/render-deck.js',
  'console/plain-language.js',
];

// blankComments: blank out comments before searching, so this file's OWN header above (which
// names every pattern being swept for, in prose) can never satisfy or trip its own scanner when
// read back as a fixture, and so a future comment in a swept file mentioning `writeState` or
// `state.json` in passing is never mistaken for the real thing.
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

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

// Generalized balanced-paren call-span finder, same technique as gh-api-argv.test.js's own
// apiArgvSpans (which balances brackets around an array literal) -- here it balances PARENS
// around a call's own argument list, starting from wherever `calleeRe` matches the callee name.
// `calleeRe` must carry the 'g' flag (every caller below does) -- without it `exec` would return
// the same match forever and this loop would never terminate.
function callSpans(source, calleeRe) {
  const spans = [];
  let m;
  while ((m = calleeRe.exec(source))) {
    const openIdx = source.indexOf('(', m.index);
    if (openIdx === -1) continue;
    let depth = 0;
    let close = -1;
    for (let i = openIdx; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    spans.push({ index: m.index, text: source.slice(m.index, close + 1) });
  }
  return spans;
}

// Every write-shaped fs call this sweep treats as capable of putting bytes on disk at a path it is
// handed -- the ordinary write family AND the rename family (see this file's own header on why
// renameSync/rename matter: journal.js's own writeState is a tmp-then-rename write, and the
// literal `state.json` sits on the RENAME target, not inside a writeFileSync call at all).
function writeCalleeRe() {
  return /\bfs(?:\.promises)?\.(?:writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|cpSync|cp|copyFileSync|copyFile)\s*(?=\()/g;
}

// findStateJsonTaintedVars(source) -> Set<string> of variable names whose OWN initializer names
// `state.json` literally -- e.g. `const target = path.join(taskDir, 'state.json');` yields
// `target`. Deliberately crude (no real scope analysis, matches gh-api-argv.test.js's own
// documented posture: "a false positive here is a test failure a human reads, not a silent
// production POST/write") -- a variable named identically in two unrelated functions would taint
// both, which is an acceptable false-positive risk in a file this size and not one that has
// occurred in practice against the files actually swept here (see the fixture tests below, which
// prove the mechanism against journal.js's own exact idiom).
function findStateJsonTaintedVars(source) {
  const names = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*state\.json[^;\n]*/g;
  let m;
  while ((m = re.exec(source))) names.add(m[1]);
  return names;
}

// checkFile(source) -> {offenders: [{line, text}], writeCallSitesScanned, stateJsonMentions}.
// `writeCallSitesScanned` and `stateJsonMentions` exist so the real-file test below can pin a
// floor on how much this scanner actually inspected -- proving it engaged with real content,
// not just that a byte-count didn't shrink (see the real-file test's own comment).
function checkFile(source) {
  const blanked = blankComments(source);
  const offenders = [];
  const tainted = findStateJsonTaintedVars(blanked);
  const taintedRe = tainted.size
    ? new RegExp(`(^|[^.\\w$])(${[...tainted].join('|')})(?![\\w$])`)
    : null;

  let writeCallSitesScanned = 0;

  // Shape 1: a write-shaped fs call naming state.json directly, or referencing a tainted var.
  for (const span of callSpans(blanked, writeCalleeRe())) {
    writeCallSitesScanned += 1;
    const hasLiteral = /state\.json/.test(span.text);
    const hasTainted = taintedRe && taintedRe.test(span.text);
    if (hasLiteral || hasTainted) {
      offenders.push({ line: lineOf(blanked, span.index), text: span.text.replace(/\s+/g, ' ').slice(0, 160) });
    }
  }

  // Shape 2: a writeState(...) call not prefixed by `accounts.` -- bare OR namespaced
  // (`journal.writeState(...)`) both match; only the literal `accounts.` prefix is excluded. The
  // fixed-length lookbehind is safe here (`accounts.` is a literal 9-character string, not a
  // variable-length pattern).
  const bareWriteStateRe = /(?<!accounts\.)\bwriteState\s*(?=\()/g;
  let m;
  while ((m = bareWriteStateRe.exec(blanked))) {
    writeCallSitesScanned += 1;
    const spanArr = callSpans(blanked.slice(m.index), /^writeState\s*(?=\()/g);
    const span = spanArr[0];
    offenders.push({
      line: lineOf(blanked, m.index),
      text: (span ? span.text : 'writeState(...)').replace(/\s+/g, ' ').slice(0, 160),
    });
  }

  const stateJsonMentions = (blanked.match(/state\.json/g) || []).length;
  return { offenders, writeCallSitesScanned, stateJsonMentions };
}

// checkSource(source) -> array of offender strings, for the fixture tests below (single-file,
// no path prefix needed).
function checkSource(source) {
  return checkFile(source).offenders.map((o) => `${o.line}: ${o.text}`);
}

// scanFiles(files, {overrides}) -> {offenders, totalBytes, totalWriteCallSites,
// totalStateJsonMentions}. Runs checkFile() -- the exact scanner both the real-file test and the
// fixture tests above already trust -- over each path in `files`, reading its source from disk
// under REPO_ROOT UNLESS `overrides` supplies an in-memory replacement keyed by that same relative
// path. The override path is what lets the regression tests below plant a tainted write inside a
// console module's source, or add a fake require to bin/spo's, and drive the real scanner (and the
// real deriveConsoleModules() walk) over the planted text without ever writing into the tree.
function scanFiles(files, { overrides = {} } = {}) {
  const offenders = [];
  let totalBytes = 0;
  let totalWriteCallSites = 0;
  let totalStateJsonMentions = 0;
  for (const rel of files) {
    const source = Object.prototype.hasOwnProperty.call(overrides, rel)
      ? overrides[rel]
      : fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    totalBytes += source.length;
    const { offenders: fileOffenders, writeCallSitesScanned, stateJsonMentions } = checkFile(source);
    totalWriteCallSites += writeCallSitesScanned;
    totalStateJsonMentions += stateJsonMentions;
    for (const o of fileOffenders) offenders.push(`${rel}:${o.line}: ${o.text}`);
  }
  return { offenders, totalBytes, totalWriteCallSites, totalStateJsonMentions };
}

// readForDerive(rel, overrides) -- same override-or-disk read scanFiles uses, factored out so
// deriveConsoleModules can share it without scanFiles and deriveConsoleModules needing to agree on
// anything beyond this one helper's signature.
function readForDerive(rel, overrides) {
  return Object.prototype.hasOwnProperty.call(overrides, rel)
    ? overrides[rel]
    : fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// consoleRequireRe(): matches require('./<name>'), require('../console/<name>'), and both spelled
// with an explicit trailing .js. Only the './name' form (no .js suffix) is actually used inside
// console/*.js today, in all four files that require a sibling console module -- measured counts:
// serve.js 7, collect.js 4, render-deck.js 3, render.js 1 -- but the regex also accepts the longer
// '../console/name' spelling and an explicit '.js' on either, since nothing in the language stops a
// future require from using them and this BFS should not need editing the day one does.
// Deliberately does NOT match a computed require, a template-literal path, or a require built via
// path.join()/require.resolve() -- those spellings, when they name a TOP-LEVEL console/*.js file,
// are caught by a DIFFERENT test below (the on-disk equality check): a module reached only through
// one of those spellings still exists on disk, so it shows up there as "on disk but not derived"
// instead of silently passing. A require into a SUBDIRECTORY of console/, into a SYMLINKED
// DIRECTORY there, or one naming a .cjs/.mjs file, is a separate blind spot this regex shares with
// the disk-equality check's own listing -- guarded instead by the structural assertion further
// down that console/ contains none of those shapes. Comments
// are NOT blanked before this regex runs (unlike checkFile's own scan) -- a require merely
// mentioned in a comment would be a false positive here, which is harmless: it only ever ADDS an
// extra module to the derived set, which a completeness assertion treats as "cover it", never as
// "skip it".
function consoleRequireRe() {
  return /require\(\s*['"](?:\.\/|\.\.\/console\/)([\w-]+)(?:\.js)?['"]\s*\)/g;
}

// deriveConsoleModules(overrides) -> Set<string> of 'console/<name>.js' relative paths that
// bin/spo reaches through require(), directly or transitively. A BFS over plain string regexes,
// same posture as this file's own checkFile: a require('../console/<name>') match against bin/spo's
// own source seeds the queue (bin/spo lives in bin/, a SIBLING of console/ under the repo root, not
// inside console/ itself -- a same-directory './' require there would resolve within bin/ and could
// never name a console file, which is why bin/spo's OWN scan uses only the '../console/' form, not
// the combined consoleRequireRe() defined above -- see the seed loop). From each console module
// reached that way, consoleRequireRe() against THAT module's own source (a require('./<name>') OR
// the equivalent require('../console/<name>')) queues the modules it delegates to in turn.
// `overrides` (rel path -> source string) lets a caller feed in-memory source for bin/spo or any
// console module without touching the tree -- the fake-require test below uses it to prove this BFS
// picks up a require that does not exist on disk yet. A module name queued this way is recorded in
// `visited` (and therefore in the returned set) even if reading its own source later fails -- the
// require site is what proves bin/spo reaches it; a missing file at the far end is a different
// problem for a different test to catch.
function deriveConsoleModules(overrides = {}) {
  const spoSource = readForDerive('bin/spo', overrides);
  const rootRe = /require\(\s*['"]\.\.\/console\/([\w-]+)(?:\.js)?['"]\s*\)/g;
  const queue = [];
  let m;
  while ((m = rootRe.exec(spoSource))) queue.push(m[1]);

  const visited = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    let source;
    try {
      source = readForDerive(`console/${name}.js`, overrides);
    } catch {
      continue; // named by a require site, but unreadable -- not this BFS's problem to solve
    }
    const siblingRe = consoleRequireRe();
    let mm;
    while ((mm = siblingRe.exec(source))) queue.push(mm[1]);
  }
  return new Set([...visited].map((name) => `console/${name}.js`));
}

// Named, reasoned exceptions only -- see this file's own header for why the list starts empty.
// Add an entry here only for a call site that genuinely, on inspection, does not write a taskDir's
// state.json under a journal root (the same bar test/no-real-spawn-sweep.test.js's own ALLOWLIST
// documents) -- never to silence a real hit.
const ALLOWLIST = {};

test('bin/spo and the console modules it delegates to never write a taskDir state.json under a journal root', () => {
  const scannedFiles = SCAN_FILES.filter((rel) => !Object.prototype.hasOwnProperty.call(ALLOWLIST, rel));
  const { offenders, totalBytes, totalWriteCallSites, totalStateJsonMentions } = scanFiles(scannedFiles);

  // Sanity floors, same reasoning as both reference sweeps' own siteCount/checked floors: if any
  // of these drop, the sweep has stopped finding real content (a file moved, shrank drastically,
  // or the scanner's own regexes broke) and a green offenders list would mean nothing.
  //   - totalBytes: measured 414,689 characters (source.length -- the code sums character count,
  //     not on-disk byte count, which is 414,811 for these files once multibyte characters are
  //     counted) across these 12 files; 200,000 tolerates ordinary growth/shrink but still catches
  //     something close to gh-api-argv's own "a refactor renamed the convention" failure mode.
  //   - totalWriteCallSites: measured 6 today (bin/spo's own 3 writeFileSync calls -- both of
  //     static-mode generateOnce()'s writes, the flight deck at bin/spo:1210 and its health-view
  //     sibling at bin/spo:1212, plus the account-disable marker -- usage-rollups.js's
  //     writeFileSync+renameSync pair, and par-times.js's own writeFileSync in saveParTimes). A
  //     drop to 0 would mean the write-callee regex stopped matching, not that every write
  //     vanished.
  //   - totalStateJsonMentions: measured 4 today, all of them READS (bin/spo's two
  //     readJsonSafe(..., 'state.json', ...) call sites, collect.js's own two). A drop to 0 would
  //     mean the literal-detection regex itself stopped matching, which is exactly the failure
  //     mode that would let a real write slip through silently.
  assert.ok(totalBytes > 200000, `expected the swept files to total a substantial size, got ${totalBytes} characters -- has the file list shrunk or a file gone missing?`);
  assert.ok(totalWriteCallSites >= 4, `expected several real write-shaped call sites across ${SCAN_FILES.join(', ')}, found ${totalWriteCallSites} -- has the write-callee regex stopped matching?`);
  assert.ok(totalStateJsonMentions >= 4, `expected several 'state.json' mentions (bin/spo's and collect.js's own read call sites), found ${totalStateJsonMentions} -- is the literal-detection regex broken?`);

  assert.deepEqual(
    offenders,
    [],
    'A swept file writes (or renames onto) a path naming state.json: a maintainer running `spo status`/`spo --serve` ' +
      'must never become a second writer racing a live worker\'s own state-machine transitions (see ' +
      "orchestrator/journal.js's taskDir single-writer invariant). If this is genuinely a terminal-only or " +
      `dead-owner-only write, add a justified entry to this file's ALLOWLIST instead:\n  ${offenders.join('\n  ')}`
  );
});

// ---- fixture tests: the sweep itself, exercised against synthetic source strings --------------
// Same reasoning as no-real-spawn-sweep.test.js's own fixture tests: proves the scanner actually
// catches what it claims to, rather than the real-file test above passing vacuously because the
// scanner never matches anything.

test('sweep flags a direct fs.writeFileSync(..., "state.json", ...) call', () => {
  const src = "fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify(snap));\n";
  const offenders = checkSource(src);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /^1:/);
});

test('sweep flags a bare writeState(...) call', () => {
  const src = "const { writeState } = require('../orchestrator/journal');\nwriteState(taskDir, snap);\n";
  const offenders = checkSource(src);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /writeState/);
});

test('sweep flags a NAMESPACED journal.writeState(...) call, not just the bare/destructured form', () => {
  const src = "const journal = require('../orchestrator/journal');\njournal.writeState(taskDir, snap);\n";
  const offenders = checkSource(src);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /writeState/);
});

test('sweep does NOT flag accounts.writeState(...) -- a different file, a different invariant', () => {
  const src = "accounts.writeState(accountsDir, { acct0: { cooldownUntil: null } });\n";
  const offenders = checkSource(src);
  assert.deepEqual(offenders, []);
});

test('sweep flags journal.js\'s own tmp-then-rename idiom, even though the literal never appears inside the rename call itself', () => {
  const src = [
    "const target = path.join(taskDir, 'state.json');",
    "const tmp = path.join(taskDir, `.state.json.${process.pid}.${Date.now()}.tmp`);",
    'fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + \'\\n\');',
    'fs.renameSync(tmp, target);',
    '',
  ].join('\n');
  const offenders = checkSource(src);
  // Both writes are flagged: fs.writeFileSync(tmp, ...) because `tmp`'s own initializer names
  // state.json (inside the template literal), and fs.renameSync(tmp, target) because BOTH of its
  // arguments trace back to a state.json-naming initializer.
  assert.equal(offenders.length, 2);
  assert.ok(offenders.some((o) => o.includes('writeFileSync')));
  assert.ok(offenders.some((o) => o.includes('renameSync')));
});

test('sweep ignores state.json / writeState mentioned only inside comments', () => {
  const src = [
    '// do not fs.writeFileSync(x, "state.json") here, and never call writeState(taskDir, snap) either',
    "console.log('read-only');",
    '',
  ].join('\n');
  const offenders = checkSource(src);
  assert.deepEqual(offenders, []);
});

test('sweep passes source with no write calls and no writeState at all', () => {
  const src = "const state = readJsonSafe(path.join(dir, 'state.json'), {});\nconsole.log(state.state);\n";
  const offenders = checkSource(src);
  assert.deepEqual(offenders, []);
});

test('sweep flags fs.promises.writeFile targeting state.json too, not just the sync form', () => {
  const src = "await fs.promises.writeFile(path.join(taskDir, 'state.json'), body);\n";
  const offenders = checkSource(src);
  assert.equal(offenders.length, 1);
});

test('sweep does NOT flag an fs write with no state.json anywhere nearby -- e.g. usage-rollups.js\'s own real write', () => {
  const src = [
    'function saveRollups(filePath, rollups) {',
    '  fs.mkdirSync(path.dirname(filePath), { recursive: true });',
    '  const tmp = `${filePath}.tmp`;',
    '  fs.writeFileSync(tmp, JSON.stringify(rollups, null, 2) + \'\\n\');',
    '  fs.renameSync(tmp, filePath);',
    '}',
    '',
  ].join('\n');
  const offenders = checkSource(src);
  assert.deepEqual(offenders, [], 'a tmp+rename write with no state.json in scope must never be flagged -- proves the sweep is not just "any rename is suspect"');
});

// ---- card #189 regression: coverage, not just the scanner's own pattern-matching -------------
//
// The fixture tests above prove checkFile() catches every write shape it claims to. None of them
// prove SCAN_FILES actually hands checkFile() every file it needs to see -- and card #189's own
// bug was exactly that gap: the same tainted write, planted temporarily (never a real write either
// file carries) in console/par-times.js, went undetected while the byte-identical plant in
// console/collect.js was caught -- because par-times.js itself was never in SCAN_FILES. The tests
// below turn that probe into a permanent check, run against every console module bin/spo actually
// reaches -- not just par-times.js -- and against deriveConsoleModules()'s own completeness claim.

test('deriveConsoleModules finds every console module bin/spo reaches, directly or transitively, and SCAN_FILES scans all of them', () => {
  const derived = [...deriveConsoleModules()].sort();

  const missing = derived.filter((rel) => !SCAN_FILES.includes(rel));
  assert.deepEqual(
    missing,
    [],
    `bin/spo reaches these console modules through require(), directly or transitively, but SCAN_FILES does not scan them -- this is exactly card #189's bug shape: ${missing.join(', ')}`
  );
});

// CONSOLE_MODULE_EXCLUSIONS: reasoned exceptions to the on-disk-vs-derived equality test below -- a
// console/*.js file that genuinely is NOT reached by bin/spo's own require graph (e.g. a standalone
// script nothing delegates dashboard rendering to). Starts empty: every file physically in console/
// today IS reached by deriveConsoleModules() -- see that test's own failure message for what a
// future addition to this list needs to say. An entry's WRITTEN REASON is the only guard against
// excluding a module that actually IS reached, just through a require() spelling this BFS's regex
// cannot parse (a computed require, a template literal): the validation test further down can check
// that an entry names a real file the BFS does not currently reach, but it has no way to check
// WHETHER that's because the module is genuinely unreached or because the regex merely missed it --
// a reason a human reader would reject on sight is the only thing standing in the way of that.
const CONSOLE_MODULE_EXCLUSIONS = {};

test('deriveConsoleModules() reaches exactly the top-level console/*.js files that exist on disk -- neither more nor fewer', () => {
  // This is the real floor on deriveConsoleModules()'s completeness -- the test above (derived
  // subset of SCAN_FILES) cannot catch an UNDER-reaching BFS on its own: a shallower walk or a
  // narrower regex still returns a set that is (vacuously) a subset of SCAN_FILES, however small. A
  // numeric floor would be too weak too: measured, a one-hop-only walk already finds 7 of these 11,
  // so a floor would have to sit within a few files of today's count to catch even that, and would
  // need re-tuning as the module graph changes. Comparing against fs.readdirSync('console/') --
  // ground truth, not a number chosen to tolerate drift -- is what actually catches an under-reaching
  // BFS at any depth.
  const onDisk = fs
    .readdirSync(path.join(REPO_ROOT, 'console'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `console/${name}`)
    .sort();
  const onDiskSet = new Set(onDisk);

  const derived = deriveConsoleModules();

  // Direction 1: every file physically on disk is reached (or explicitly, reasonedly excluded).
  const unreached = onDisk.filter(
    (rel) => !derived.has(rel) && !Object.prototype.hasOwnProperty.call(CONSOLE_MODULE_EXCLUSIONS, rel)
  );
  assert.deepEqual(
    unreached,
    [],
    'these console/*.js files exist on disk but deriveConsoleModules() -- a require()-following BFS ' +
      "rooted at bin/spo -- does not reach them. Either bin/spo's dashboard code genuinely never " +
      'delegates to them (add a reasoned entry to CONSOLE_MODULE_EXCLUSIONS instead of ignoring ' +
      'this), or they are reached only through a require() spelling consoleRequireRe() does not ' +
      `parse (a computed require, a template literal, a path.join()-built path) -- in which case the regex needs to widen: ${unreached.join(', ')}`
  );

  // Direction 2: every module the BFS claims to have reached actually exists on disk. Without this,
  // a stale or mistyped require -- naming a console module that was renamed or deleted -- would sit
  // silently inside `derived` forever: deriveConsoleModules() records a name in `visited` (and
  // therefore in its returned set) from the require SITE alone, before it ever tries to read that
  // module's own source (see that function's own comment on why).
  const phantom = [...derived].filter((rel) => !onDiskSet.has(rel));
  assert.deepEqual(
    phantom,
    [],
    'deriveConsoleModules() reached these names through a require() call site somewhere in the ' +
      `graph, but no such file exists on disk under console/ -- a stale or mistyped require: ${phantom.join(', ')}`
  );
});

test('console/ holds no subdirectory, symlink, or .cjs/.mjs file -- regular files only', () => {
  // consoleRequireRe()'s own [\w-]+ cannot match a "/", so a require reaching into a SUBDIRECTORY of
  // console/ is invisible to deriveConsoleModules() entirely -- not merely unparsed the way a
  // computed require or a template literal is (those still land on a real console/*.js file, which
  // is what lets the on-disk equality test above catch them; a subdirectory file evades THAT test
  // too, since the disk listing is top-level only, so a file inside a subdirectory is never listed).
  // Separately, the on-disk side of that same test only keeps names ending in ".js"
  // (`.filter((name) => name.endsWith('.js'))`), so a .cjs or .mjs file sitting right next to the
  // others would not even appear in the comparison as something to reach.
  //
  // A SYMLINKED DIRECTORY evades both the walk and the listing exactly as a real subdirectory does,
  // and an `e.isDirectory()`-only check would not catch it: fs.Dirent's isDirectory()/isFile()
  // describe the entry ITSELF, not what a symlink points at, so a symlink -- to a directory, to a
  // file, or dangling -- is neither isDirectory() NOR isFile(), regardless of its target. Likewise
  // an extension check gated on isFile() would miss a symlink whose own name ends in .cjs. NOTE: a
  // symlink to an ordinary .js FILE does NOT actually evade deriveConsoleModules() or the on-disk
  // listing -- deriveConsoleModules()'s regex still matches its require() call site by name, the
  // on-disk listing still lists its name (readdirSync returns the link's own name like any other
  // entry), and fs.readFileSync follows the link when the real sweep later reads its content. The
  // fix below rejects it anyway, along with every other symlink, as a DELIBERATE CONSERVATIVE
  // choice: flagging every entry that is not a regular file at all (`!e.isFile()`) is simpler and
  // safer than special-casing "a symlink to a regular .js file is fine, every other symlink is
  // not". The .cjs/.mjs extension is checked on the name alone, with no isFile() precondition, so a
  // symlink whose OWN name ends in .cjs is flagged by both rules rather than slipping through a
  // gate the other rule already tripped.
  //
  // Both this sweep and deriveConsoleModules() would need extending -- not just this test loosening
  // -- before a subdirectory (real or symlinked) or a .cjs/.mjs file could be added under console/
  // safely.
  const entries = fs.readdirSync(path.join(REPO_ROOT, 'console'), { withFileTypes: true });
  const badNonFile = entries.filter((e) => !e.isFile()).map((e) => `console/${e.name}`);
  const badExt = entries
    .filter((e) => e.name.endsWith('.cjs') || e.name.endsWith('.mjs'))
    .map((e) => `console/${e.name}`);
  const offenders = [...new Set([...badNonFile, ...badExt])].sort();
  assert.deepEqual(
    offenders,
    [],
    'deriveConsoleModules() and the on-disk equality test above only cover TOP-LEVEL ' +
      "console/*.js files -- a subdirectory (real or symlinked) or a .cjs/.mjs file physically " +
      "exists here but neither the require-following BFS nor the disk listing it's checked against " +
      'would ever notice it (every OTHER symlink is rejected here too, conservatively, even though ' +
      `a symlink to an ordinary .js file would not actually evade either check): ${offenders.join(', ')}`
  );
});

test('every CONSOLE_MODULE_EXCLUSIONS entry names a real console/*.js file that deriveConsoleModules() genuinely does not reach -- never a stale or redundant one', () => {
  const onDisk = new Set(
    fs
      .readdirSync(path.join(REPO_ROOT, 'console'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `console/${name}`)
  );
  const derived = deriveConsoleModules();

  for (const rel of Object.keys(CONSOLE_MODULE_EXCLUSIONS)) {
    assert.ok(
      onDisk.has(rel),
      `CONSOLE_MODULE_EXCLUSIONS names ${rel}, which does not exist on disk under console/ -- a stale entry left behind after the file itself was removed or renamed`
    );
    assert.ok(
      !derived.has(rel),
      `CONSOLE_MODULE_EXCLUSIONS names ${rel}, but deriveConsoleModules() DOES reach it -- a redundant exclusion that hides nothing today, and would silently hide a real gap if the BFS ever stopped reaching it for a genuine reason`
    );
  }
});

test('deriveConsoleModules picks up a brand-new require(\'../console/X\') added to bin/spo, even one naming a module that does not exist on disk', () => {
  const realSpo = fs.readFileSync(path.join(REPO_ROOT, 'bin/spo'), 'utf8');
  const fakeSpo = `${realSpo}\nfunction __probeNewDelegate() {\n  require('../console/__card-189-fake-module').go();\n}\n`;
  const derived = deriveConsoleModules({ 'bin/spo': fakeSpo });
  assert.ok(
    derived.has('console/__card-189-fake-module.js'),
    "expected a new require('../console/...') shape added to bin/spo to be picked up immediately, even for a module that does not exist on disk yet -- the require SITE is what proves bin/spo reaches it"
  );
});

test('a planted tainted state.json write is caught in every console module bin/spo delegates to, and goes undetected the moment that module is dropped from the scanned set', () => {
  const modules = [...deriveConsoleModules()].sort();
  assert.ok(modules.includes('console/collect.js'), 'expected collect.js -- the positive control -- among the derived modules');
  assert.ok(modules.includes('console/par-times.js'), 'expected par-times.js -- card #189\'s own finding -- among the derived modules');

  // Byte-identical across every module probed: a direct fs.writeFileSync onto a variable whose own
  // initializer names state.json literally -- no tmp file, no rename, the simplest shape checkFile's
  // own taint-tracking (Shape 1, findStateJsonTaintedVars) is built to catch. The two statements
  // here are the same ones card #189's own investigation planted by hand in collect.js and
  // par-times.js (only the wrapping function's name and layout differ). Appended to the module's own
  // real source so the rest of that module's real content (including its own real writes, if any) is
  // still exercised alongside the plant.
  const PLANT = "\nfunction __card189ProbeStateWrite(d) {\n  const target = path.join(d, 'state.json');\n  fs.writeFileSync(target, JSON.stringify({ probe: true }));\n}\n";

  for (const rel of modules) {
    const realSource = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const taintedSource = realSource + PLANT;

    const withModuleScanned = scanFiles(SCAN_FILES, { overrides: { [rel]: taintedSource } });
    assert.ok(
      withModuleScanned.offenders.some((o) => o.startsWith(`${rel}:`)),
      `planting a tainted state.json write in ${rel} was not caught while ${rel} is in SCAN_FILES -- the scanner regressed`
    );

    // The assertion above is what proves SCAN_FILES membership matters: the plant IS caught while
    // the module is actually in the scanned set. This second half checks a narrower thing --
    // that scanFiles(files, {overrides}) only ever scans the paths named in `files`, and never
    // leaks in an `overrides` entry for a path that was not asked for. Without that property,
    // dropping a module from `files` (as this half does, without touching SCAN_FILES itself) would
    // not actually be equivalent to dropping it from SCAN_FILES, and this whole test would prove
    // nothing regardless of what `files` contains.
    const withModuleDropped = scanFiles(
      SCAN_FILES.filter((f) => f !== rel),
      { overrides: { [rel]: taintedSource } }
    );
    assert.ok(
      !withModuleDropped.offenders.some((o) => o.startsWith(`${rel}:`)),
      `expected dropping ${rel} from the scanned set to hide its planted write (proving this regression test bites), but it was still caught`
    );
  }
});
