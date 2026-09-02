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
// SCOPE: bin/spo itself, plus every console/*.js module it actually delegates dashboard rendering
// to (bin/spo:178-179's `require('../console/collect')`/`require('../console/render')`, and
// bin/spo:1070-1074's `--serve`-only `require('../console/serve')`/`.../system`/`.../prod-version`/
// `.../usage-scan`) -- a write one module deeper than bin/spo itself is just as real a violation of
// the invariant above and would otherwise be invisible to a sweep that only ever opened bin/spo.
// console/usage-rollups.js is included one level deeper still, for a different reason: it is
// required by several of the files above (collect/render/serve/usage-scan) and is the ONE place in
// this whole dependency graph that already does real filesystem writes (its own tmp-then-rename
// idiom, saving usage rollups) -- including it is what proves this sweep can walk right past a
// real write to an UNRELATED file without false-flagging it, rather than the "clean" result being
// an artifact of never looking at a file with any writes in it at all.
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
//      state-machine.js's snapshot() and dispatcher.js's reparkCrashedWorker use to write a
//      taskDir's state.json today) and called it, however it was imported: bare (destructured) or
//      through a namespace object (`journal.writeState(...)`) -- bin/spo's OWN dominant import
//      style is namespace objects (`accounts.`, `intake.`, `autoTriage.`, `reportIntake.`,
//      `remoteReportPull.`, `recette.` -- bin/spo:180-189), so a namespaced `journal.writeState`
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
];

// Same convention as both reference sweeps: blank out comments before searching, so this file's
// OWN header above (which names every pattern being swept for, in prose) can never satisfy or
// trip its own scanner when read back as a fixture, and so a future comment in a swept file
// mentioning `writeState` or `state.json` in passing is never mistaken for the real thing.
function blankComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
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

// Named, reasoned exceptions only -- see this file's own header for why the list starts empty.
// Add an entry here only for a call site that genuinely, on inspection, does not write a taskDir's
// state.json under a journal root (the same bar test/no-real-spawn-sweep.test.js's own ALLOWLIST
// documents) -- never to silence a real hit.
const ALLOWLIST = {};

test('bin/spo and the console modules it delegates to never write a taskDir state.json under a journal root', () => {
  const offenders = [];
  let totalBytes = 0;
  let totalWriteCallSites = 0;
  let totalStateJsonMentions = 0;

  for (const rel of SCAN_FILES) {
    if (Object.prototype.hasOwnProperty.call(ALLOWLIST, rel)) continue;
    const abs = path.join(REPO_ROOT, rel);
    const source = fs.readFileSync(abs, 'utf8');
    totalBytes += source.length;
    const { offenders: fileOffenders, writeCallSitesScanned, stateJsonMentions } = checkFile(source);
    totalWriteCallSites += writeCallSitesScanned;
    totalStateJsonMentions += stateJsonMentions;
    for (const o of fileOffenders) offenders.push(`${rel}:${o.line}: ${o.text}`);
  }

  // Sanity floors, same reasoning as both reference sweeps' own siteCount/checked floors: if any
  // of these drop, the sweep has stopped finding real content (a file moved, shrank drastically,
  // or the scanner's own regexes broke) and a green offenders list would mean nothing.
  //   - totalBytes: measured 228,847 bytes across these 8 files; 200,000 tolerates ordinary
  //     growth/shrink but still catches something close to gh-api-argv's own "a refactor renamed
  //     the convention" failure mode.
  //   - totalWriteCallSites: measured 4 today (bin/spo's own 2 writeFileSync calls -- the
  //     dashboard HTML export and the account-disable marker -- plus usage-rollups.js's
  //     writeFileSync+renameSync pair). A drop to 0 would mean the write-callee regex stopped
  //     matching, not that every write vanished.
  //   - totalStateJsonMentions: measured 4 today, all of them READS (bin/spo's two
  //     readJsonSafe(..., 'state.json', ...) call sites, collect.js's own two). A drop to 0 would
  //     mean the literal-detection regex itself stopped matching, which is exactly the failure
  //     mode that would let a real write slip through silently.
  assert.ok(totalBytes > 200000, `expected the swept files to total a substantial size, got ${totalBytes} bytes -- has the file list shrunk or a file gone missing?`);
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
