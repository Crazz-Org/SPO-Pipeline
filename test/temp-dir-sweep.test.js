'use strict';
// The standing guard on test/helpers.js's temp-dir registry: every throwaway directory this suite
// creates must come from mkTmp(), because that is the only path that gets swept at process exit.
//
// This is not style enforcement. The registry was added on 2026-09-07 after measuring one
// `scripts/gate.sh` run leaving 5617 new entries in /tmp; 4174 of those came from THIRTY-SEVEN
// test files that had each re-derived the same three lines --
//
//     function mkTmp(prefix) {
//       return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
//     }
//
// -- shadowing the shared helper with a private copy. Nothing was wrong with any one of them; the
// point is that the class regrows by copy-paste from the file next door, silently, and the only
// symptom is a slowly filling /tmp that no test ever looks at. So the population is checked, by
// file, forever -- the same shape test/no-real-spawn-sweep.test.js uses for its own killswitch.
//
// The escape hatch is deliberate and narrow: helpers.js itself, and the fixture SOURCE STRINGS in
// test/temp-dir-registry.test.js, which must be able to build an unregistered directory -- that is
// the control proving the registry is what does the removing.

require('./no-real-spawn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { REPO_ROOT } = require('./helpers');

const TEST_DIR = path.join(REPO_ROOT, 'test');
const HELPERS = path.join(TEST_DIR, 'helpers.js');

// The two files allowed to name fs.mkdtempSync in executable code, and why. Anything else added
// here needs a reason written next to it, not just a name.
const EXEMPT = new Map([
  ['helpers.js', 'defines mkTmp -- the one wrapper the registry is built around'],
  ['temp-dir-registry.test.js', 'builds an UNREGISTERED directory inside a fixture source string, as the control'],
]);

// Strips block comments, line comments, and the contents of string/template literals, so a
// mkdtempSync mentioned in prose or quoted inside a fixture is not read as a call. Crude by
// design: it never has to reproduce JavaScript, only to stop the three ways this suite writes
// about its own conventions from tripping the check. Regex literals containing quotes would fool
// it; there are none in test/, and a false POSITIVE is the safe direction anyway -- it fails
// loudly and a human looks.
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|[^`\\])*`/g, "''")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, "''");
}

function testFiles() {
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

test('no file under test/ builds its own os.tmpdir() directory -- mkTmp() is the only door', () => {
  const files = testFiles();
  // A readdir that returned nothing, or a rename that emptied test/, would make every assertion
  // below pass by examining zero files. The floor is a tripwire on that, not a pin on the
  // population (scripts/gate.sh's own floor and test/gate-scope.test.js are that).
  assert.ok(files.length >= 50, `found only ${files.length} file(s) under test/ -- this sweep examined almost nothing`);

  const offenders = [];
  for (const name of files) {
    if (EXEMPT.has(name)) continue;
    const code = stripNonCode(fs.readFileSync(path.join(TEST_DIR, name), 'utf8'));
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      if (/mkdtempSync\s*\(/.test(line)) offenders.push(`test/${name}:${i + 1}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'these call fs.mkdtempSync directly, so the directories they create are outside helpers.js\'s ' +
      'registry and survive the run:\n  ' +
      offenders.join('\n  ') +
      "\nUse `const { mkTmp } = require('./helpers');` instead. If a case genuinely needs an " +
      'UNREGISTERED directory, add it to EXEMPT above with the reason.'
  );
});

test('helpers.js still routes its one mkdtempSync through the registry', () => {
  const src = fs.readFileSync(HELPERS, 'utf8');
  // Counted on the STRIPPED source: helpers.js's own comments name fs.mkdtempSync several times
  // while describing the convention, and a comment is not a call.
  const calls = stripNonCode(src).match(/mkdtempSync\s*\(/g) || [];
  assert.equal(
    calls.length,
    1,
    `helpers.js has ${calls.length} mkdtempSync call(s) -- the registry assumes exactly one, inside mkTmp()`
  );
  assert.match(
    src,
    /return registerTempDir\(fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), prefix\)\)\);/,
    "helpers.js's mkTmp no longer wraps mkdtempSync in registerTempDir -- every directory the suite " +
      'creates would go unswept, and test/temp-dir-registry.test.js is where that is proven end to end'
  );
  assert.match(
    src,
    /process\.on\('exit', \(\) => \{/,
    "helpers.js no longer installs the process 'exit' handler that sweeps the registry"
  );
  // fs.rm (async) or a promise inside an 'exit' handler is a no-op: the event loop is already
  // done. The sweep would then register directories and remove none, with nothing failing.
  const hookBody = src.slice(src.indexOf("process.on('exit'"));
  assert.match(hookBody, /fs\.rmSync\(/, "the exit handler must remove SYNCHRONOUSLY -- async work scheduled from 'exit' never runs");
  assert.doesNotMatch(hookBody.slice(0, hookBody.indexOf('\n});')), /await |\.then\(|fs\.rm\(|fs\.promises/, "the exit handler schedules async work, which an 'exit' handler never gets to run");
});

test('every file that uses mkTmp imports it from helpers, rather than defining one', () => {
  // The specific regression this closes: a file that keeps calling `mkTmp(...)` while its own
  // definition has been deleted would be a ReferenceError (loud), but a file that RE-ADDS a local
  // definition is silent -- it just stops being swept. The sweep above catches the mkdtempSync
  // form; this catches the same intent expressed by aliasing something else.
  const offenders = [];
  for (const name of testFiles()) {
    if (name === 'helpers.js') continue;
    const raw = fs.readFileSync(path.join(TEST_DIR, name), 'utf8');
    if (!/\bmkTmp\s*\(/.test(stripNonCode(raw))) continue;
    // The import is looked for in the RAW source on purpose: stripNonCode blanks string literals,
    // which is exactly where the module specifier `'./helpers'` lives.
    // Both spellings the suite actually uses -- a destructured import, and
    // test/comment-scan.test.js's per-test `require('./helpers').mkTmp`. What is being guarded is
    // that the directory came from helpers.mkTmp, not how the binding was spelled.
    const imports =
      /\{[^}]*\bmkTmp\b[^}]*\}\s*=\s*require\('\.\/helpers'\)/.test(raw) ||
      /require\('\.\/helpers'\)\.mkTmp\b/.test(raw);
    if (!imports) offenders.push(`test/${name}`);
  }
  assert.deepEqual(offenders, [], `these call mkTmp() without importing it from ./helpers:\n  ${offenders.join('\n  ')}`);
});
