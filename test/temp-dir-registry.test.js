'use strict';
// Proves test/helpers.js's temp-dir registry actually removes what it hands out, and proves it
// against the thing that makes the design work: node:test's DEFAULT process isolation. `node
// --test <files>` (scripts/gate.sh's last line) forks one child per test FILE, so a module-scope
// registry in helpers.js is per-file by construction and a single `process.on('exit')` registered
// at require time fires once per file, after that file's last test.
//
// None of that can be asserted from inside this process -- this process's own exit handler runs
// after the last assertion. So every case here spawns a REAL `node --test` child over a fixture
// test file and inspects os.tmpdir() once that child is dead.
//
// Why it needs a control. "The directory is gone" on its own is satisfied by a dozen boring
// explanations (the fixture removed it, the OS did, it was never created). Each case therefore
// creates TWO directories in the same child: one through helpers.mkTmp (registered) and one
// through a bare fs.mkdtempSync (not), prints both paths, and asserts the first is gone while the
// second SURVIVES. The only difference between them is the registry, so the registry is what the
// assertion is measuring. The surviving control is removed by this file afterwards, through
// mkTmp's own registry, so the test that proves the leak is closed does not itself leak.

require('./no-real-spawn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { mkTmp, REPO_ROOT, gitEnv } = require('./helpers');

const HELPERS = path.join(REPO_ROOT, 'test', 'helpers.js');

// Builds a throwaway directory holding one fixture test file. `helpersPath` is what the fixture
// require()s -- the real helpers.js for the ordinary cases, a mutant copy for the revocation case.
// `body` is appended inside the fixture's single test.
function writeFixture({ helpersPath, body, tag }) {
  const dir = mkTmp(`spo-tdr-fixture-${tag}-`);
  const file = path.join(dir, 'fixture.test.js');
  fs.writeFileSync(
    file,
    [
      "'use strict';",
      "const test = require('node:test');",
      "const fs = require('fs');",
      "const os = require('os');",
      "const path = require('path');",
      `const { mkTmp } = require(${JSON.stringify(helpersPath)});`,
      "test('fixture', () => {",
      "  const registered = mkTmp('spo-tdr-registered-');",
      "  const unregistered = fs.mkdtempSync(path.join(os.tmpdir(), 'spo-tdr-unregistered-'));",
      // Real content, not an empty directory: rmSync's `recursive` is the part that has to work.
      "  fs.mkdirSync(path.join(registered, 'nested', 'deeper'), { recursive: true });",
      "  fs.writeFileSync(path.join(registered, 'nested', 'deeper', 'file.txt'), 'x');",
      "  console.log('REGISTERED=' + registered);",
      "  console.log('UNREGISTERED=' + unregistered);",
      // Both directories are alive DURING the test. This is what makes the later "gone" reading
      // evidence of removal at exit, rather than of a directory that never existed.
      "  if (!fs.existsSync(registered) || !fs.existsSync(unregistered)) throw new Error('fixture setup failed');",
      body || '',
      '});',
    ].join('\n')
  );
  return { dir, file };
}

// A nested `node --test` needs NODE_TEST_CONTEXT stripped. node:test sets it to 'child-v8' in
// every test-file worker it forks; a `node --test` child that INHERITS it switches from TAP to the
// v8-serialized reporter protocol, so the fixture's own console output stops being readable text
// and every match below finds nothing -- a silent empty read, not an error. (test/helpers.js's
// runners never hit this: they spawn daemon.js and bin/spo, not another test runner.) gitEnv() is
// the base for the usual reason -- under the pre-push hook GIT_DIR is inherited, and these
// children run `node`, not `git`, but the fixture files live in throwaway directories and nothing
// good comes of handing them this repository's git environment.
function nestedTestEnv() {
  const env = gitEnv();
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Runs the fixture under a real `node --test` child and returns the two paths it printed plus the
// child's exit status. execFileSync throws on a non-zero exit -- the failing-file case below needs
// exactly that exit, so the throw is caught and its `.stdout`/`.stderr`/`.status` read off the Error, the
// same shape helpers.js's own runDaemonWorkerRun relies on.
function runFixture(file) {
  let out;
  let status;
  try {
    out = execFileSync(process.execPath, ['--test', file], { encoding: 'utf8', env: nestedTestEnv() });
    status = 0;
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}`;
    status = err.status;
  }
  const grab = (key) => {
    // The lookbehind is load-bearing: 'UNREGISTERED' ENDS WITH 'REGISTERED', so a bare
    // /REGISTERED=/ would happily read the control's path if the two lines ever swapped order.
    const m = out.match(new RegExp(`(?<![A-Z])${key}=(\\S+)`));
    assert.ok(m, `fixture never printed ${key} -- it did not run. Child output:\n${out}`);
    return m[1];
  };
  return { registered: grab('REGISTERED'), unregistered: grab('UNREGISTERED'), status, out };
}

// The surviving control has to be cleaned up by hand -- it is, by construction, the one directory
// in this file that the registry did not claim. Handing it to registerTempDir would work too, but
// removing it right where it is asserted keeps the reason local.
function reap(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('a directory handed out by mkTmp is gone once the test file\'s process exits', () => {
  const { file } = writeFixture({ helpersPath: HELPERS, tag: 'green' });
  const { registered, unregistered, status } = runFixture(file);

  assert.equal(status, 0, 'the fixture file was supposed to pass');
  assert.equal(
    fs.existsSync(registered),
    false,
    `mkTmp's directory survived the child's exit (${registered}) -- the registry's exit hook did not sweep it`
  );
  assert.equal(
    fs.existsSync(unregistered),
    true,
    'the UNREGISTERED control was removed too -- then "gone" is not evidence of the registry, and this test proves nothing'
  );
  reap(unregistered);
});

test('the sweep still runs when the test file FAILS -- the leak is worst exactly then', () => {
  // A red suite is when temp dirs pile up fastest (a failing run gets re-run), and it is the case
  // an `after()`-hook design gets wrong. 'exit' fires on a thrown assertion; SIGKILL is the
  // documented gap, and is not this.
  const { file } = writeFixture({
    helpersPath: HELPERS,
    tag: 'red',
    body: "  throw new Error('deliberate failure');",
  });
  const { registered, unregistered, status } = runFixture(file);

  assert.notEqual(status, 0, 'the fixture file was supposed to FAIL -- otherwise this case is the green one again');
  assert.equal(fs.existsSync(registered), false, `mkTmp's directory survived a FAILING test file (${registered})`);
  assert.equal(fs.existsSync(unregistered), true, 'the unregistered control vanished -- see the green case');
  reap(unregistered);
});

test('REVOKED: strip the exit hook from helpers.js and the directory survives', () => {
  // The two cases above are consistent with a registry that removes nothing and a `mkTmp` that
  // happens to hand out short-lived paths. This one severs the single line under test: a copy of
  // helpers.js with its `process.on('exit', ...)` block deleted. The copy is byte-identical
  // otherwise, so what changes between this case and the green one is the hook and nothing else.
  const src = fs.readFileSync(HELPERS, 'utf8');
  const hook = /process\.on\('exit', \(\) => \{[\s\S]*?\n\}\);\n/;
  assert.match(
    src,
    hook,
    'helpers.js no longer contains the `process.on(\'exit\', ...)` block this test revokes -- if it was renamed, repoint this regex; if it was DELETED, the registry is dead and the green cases above are lying'
  );
  const mutantDir = mkTmp('spo-tdr-mutant-');
  const mutant = path.join(mutantDir, 'helpers-no-exit-hook.js');
  fs.writeFileSync(
    mutant,
    // helpers.js reaches into ../orchestrator; the copy does not live next to it, so that one
    // relative require is absolutised. Nothing else in the file is touched.
    src.replace(hook, '').replace(/require\('\.\.\/orchestrator\//g, `require('${path.join(REPO_ROOT, 'orchestrator')}/`)
  );

  const { file } = writeFixture({ helpersPath: mutant, tag: 'revoked' });
  const { registered, unregistered } = runFixture(file);

  assert.equal(
    fs.existsSync(registered),
    true,
    'with the exit hook stripped out, mkTmp\'s directory was STILL removed -- something other than the hook is doing the cleaning, so the green cases above are not testing the registry'
  );
  assert.equal(fs.existsSync(unregistered), true, 'the unregistered control vanished -- see the green case');
  reap(registered);
  reap(unregistered);
});

test('one exit hook per test-file process, not one per require -- node:test forks per FILE', () => {
  // The design rests on node:test's default isolation being 'process'. If a future Node (or a
  // future --experimental-test-isolation=none in scripts/gate.sh) ran every file in ONE process,
  // the registry would still be correct but would sweep only at the very end of the whole run,
  // holding every directory of every file at once. Pin the property the design assumes.
  const dir = mkTmp('spo-tdr-isolation-');
  for (const name of ['a', 'b']) {
    fs.writeFileSync(
      path.join(dir, `${name}.test.js`),
      [
        "'use strict';",
        "const test = require('node:test');",
        `test('${name}', () => { console.log('PID=' + process.pid); });`,
      ].join('\n')
    );
  }
  let out;
  try {
    out = execFileSync(process.execPath, ['--test', path.join(dir, 'a.test.js'), path.join(dir, 'b.test.js')], {
      encoding: 'utf8',
      env: nestedTestEnv(),
    });
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const pids = new Set((out.match(/PID=(\d+)/g) || []).map((m) => m.slice(4)));
  assert.equal(pids.size, 2, `two test files ran in ${pids.size} process(es) -- node:test is no longer isolating per file, and helpers.js's registry no longer sweeps per file`);
  assert.equal(pids.has(String(process.pid)), false, 'a fixture ran in THIS process');
});
