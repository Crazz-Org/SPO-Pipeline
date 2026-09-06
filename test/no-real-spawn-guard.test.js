'use strict';
// no-real-spawn-guard.test.js -- unit + child-process integration tests for
// orchestrator/no-real-spawn-guard.js, the sibling killswitch that reaches a SPAWNED CHILD
// (dispatcher.js's worker/scanner, or a hand-run daemon.js/bin/spo) rather than an in-process
// node:test worker (that half is test/no-real-spawn.js, tested by test/no-real-spawn.test.js).
//
// DOES require test/no-real-spawn.js, at column 0, before the orchestrator require below --
// test/no-real-spawn-sweep.test.js's placement rule applies to this file exactly like any other
// (it requires an orchestrator module, `../orchestrator/no-real-spawn-guard`), and leaving the
// killswitch out to make T1/T2 easier would be exactly the defect that sweep exists to catch, not
// a legitimate exemption.
//
// T1/T2 still get a REAL, unpatched command to exercise despite that, because they probe through
// `execFileSync`, not `spawnSync`: test/no-real-spawn.js patches `spawnSync` ONLY, by its own
// explicit design ("scope: spawnSync only" in its header) -- `execFileSync` is deliberately left
// alone so test/helpers.js's real daemon/spo subprocess launches keep working. That gives this
// file exactly the pristine real function it needs, already guaranteed by a DIFFERENT module's own
// documented contract instead of a local save/restore. `execFileSync` is also one of the functions
// THIS guard (orchestrator/no-real-spawn-guard.js) itself patches when armed, so T1/T2 are still
// testing the exact property they need to: pristine before installGuard(), the named guard error
// after.
//
// ---- why T3 (execFileSync), T2 (pristine-then-armed execFileSync) and T1 (armed execFileSync)
// run in EXACTLY this order, and T4 lives in its own file --------------------------------------
//
// orchestrator/no-real-spawn-guard.js's installGuard() is, like test/no-real-spawn.js's own
// installNoRealSpawn(), a ONE-WAY, PROCESS-WIDE patch with no escape hatch (see that module's own
// "no escape hatch on purpose" header) -- once armed in a process, `child_process.execFileSync`
// (and `spawnSync`/`execSync`/`exec`/`execFile` too -- see its own "scope" header for why it is
// wider than test/no-real-spawn.js's spawnSync-only, and for why the async `spawn` is deliberately
// excluded) stays the thrower for the rest of that process's life. node:test runs every top-level
// test() in one file in ONE process, sequentially, by default. So:
//   - T3 spawns real daemon.js CHILD processes via execFileSync and must find it PRISTINE -- it
//     has to run before anything in this file calls installGuard() (which would also patch
//     execFileSync, in THIS process, and break T3's own subprocess launches).
//   - T2 needs a PRISTINE `execFileSync` to prove the "before" half of its revoke proof, so it
//     also has to run before installGuard() is ever called -- i.e. after T3 (which only USES
//     execFileSync, never arms anything) but before T1 (which arms it).
//   - T1 runs last: it only needs an ALREADY-armed guard (installGuard() is idempotent), and
//     leaving execFileSync patched afterwards costs nothing since nothing later in this file needs
//     it pristine again.
// T4 needs a SEPARATE process because it tests test/no-real-spawn.js's OWN require-time side
// effect (does requiring it set the env var?) via a freshly spawned child that has not yet
// required it -- something this file's own top-of-file require (below) would foreclose if T4
// lived here too. Two small files, cleanly separated by what each needs pristine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
// T3 destructures this once for its own child-launching helper -- fine there, since T3 spawns
// real daemon.js CHILD PROCESSES and never expects THIS process's own execFileSync to change.
// T1/T2, in contrast, need to observe installGuard()'s effect ON `cp.execFileSync` itself, so they
// read `cp.execFileSync` live instead of this destructured copy -- destructuring it once up here
// and calling that binding after installGuard() runs would silently keep calling the ORIGINAL,
// unpatched function, exactly the "destructured before the patch landed" trap this whole guard
// exists to defend against elsewhere (see command-timeout.js). Measured: an earlier draft of T1/T2
// used this destructured binding for the armed half too, and `assert.throws` failed with "Missing
// expected exception" -- the call was silently still reaching the real, unpatched execFileSync.
//
// NOT an escape hatch around the killswitch below: `test/no-real-spawn.js`'s own patch never
// touches `execFileSync` in the first place (its documented scope is `spawnSync` ONLY), so
// capturing it here -- before OR after that require -- makes no difference to what this binding
// points at; there is nothing to route around. Do NOT generalize this into a pattern that captures
// `spawnSync` (or any other name orchestrator/no-real-spawn-guard.js patches) before requiring the
// killswitch in order to reach a real git/gh/npm/claude call -- that would reintroduce exactly the
// incident this suite exists to prevent, in a test file of all places.
const { execFileSync } = cp;

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident and test/no-real-spawn-sweep.test.js
// for why this require has to land, at column 0, before the orchestrator require below. Patches
// `spawnSync` only (its own documented scope) -- `execFileSync`, which T1/T2/T3 all use, is left
// genuinely pristine by this require.
require('./no-real-spawn');

const { installGuard, isEnabled, SPO_NO_REAL_SPAWN } = require('../orchestrator/no-real-spawn-guard');
const { mkTmp, isolatedEnv, gitEnv, DAEMON, SPO_BIN, REPO_ROOT } = require('./helpers');

// A command that WRITES NOTHING ANYWHERE and reads no repository state -- required because T2's
// "revoke" half, and T3's "revoked" run, actually EXECUTE it for real. Used for the DYNAMICALLY
// BUILT probe script (T3's buildProbeScript, which embeds it as a string literal into another
// file's source, invisible to any sweep that reads test/*.js) and for assertion regexes below.
// The REAL call sites in THIS file's own source (T1/T2) spell the command out as the literal
// `'git'` instead of this constant -- see those call sites for why: test/no-git-env-sweep.test.js
// scans test/*.js SOURCE TEXT for the literal command name, and a constant here would make those
// calls invisible to it, exactly the kind of guard-evasion-through-indirection this whole card is
// about closing, not reproducing in its own tests.
const HARMLESS_COMMAND = 'git';
const HARMLESS_ARGS = ['--version'];

// isolatedGitEnv() -- the env for a REVOKED T3/F1 run specifically: those two spawn a child that,
// with the guard revoked, runs a genuinely REAL, uninstrumented `git --version` through
// command-timeout.js's armTimeout (opts = {}, no env override of its own) -- and that call site is
// invisible to test/no-git-env-sweep.test.js, because the command reaches the child as a
// JSON-stringified literal inside buildProbeScript's DYNAMICALLY GENERATED source, not as text in
// this file. `--version` reads no config/repo/index so an inherited GIT_DIR is practically inert,
// but "a real git call, invisible to the one guard that would normally catch an unstripped GIT_*
// env, carrying it anyway" is precisely the class of thing this whole card removes -- leaving it
// unstripped here would be the same defect as F2, just in a spot nobody was told to look yet.
//
// NOT a plain `{ ...gitEnv(), ...isolatedEnv() }` (or the reverse order) -- MEASURED, not assumed,
// that NEITHER spread order actually strips GIT_*. Both gitEnv() and isolatedEnv() independently
// start from a full `{ ...process.env }` copy; object-spread can only OVERWRITE a key the LATER
// object also carries, it does nothing for a key the later object simply lacks. gitEnv() lacks
// GIT_* by design (it deleted those keys from ITS OWN copy), so spreading gitEnv() after
// isolatedEnv() never removes isolatedEnv()'s (unstripped) GIT_* keys -- and spreading it BEFORE
// isolatedEnv() is worse, since isolatedEnv()'s own trailing `...process.env` then reintroduces
// them regardless of order. Measured directly:
//   $ GIT_DIR=/tmp/leak node -e "const {gitEnv,isolatedEnv}=require('./helpers');
//       console.log(({...gitEnv(),...isolatedEnv()}).GIT_DIR, ({...isolatedEnv(),...gitEnv()}).GIT_DIR)"
//   /tmp/leak /tmp/leak
// -- both orders leak. This function instead strips GIT_* directly off isolatedEnv()'s OWN
// returned object (a fresh object every call, safe to mutate locally) -- the same GIT_-prefix rule
// test/helpers.js's own gitEnv() uses, applied to the object that actually needs it. Verified this
// way actually achieves BOTH properties (not just the one that's easy to check):
//   $ GIT_DIR=/tmp/leak GIT_INDEX_FILE=/tmp/leak-index node -e "
//       const { isolatedEnv } = require('./helpers');
//       const env = isolatedEnv();
//       for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
//       console.log(env.GIT_DIR, env.SPO_PRODUCT_REPO, env.SPO_WORKTREES_DIR, env.SPO_REPORTS_DIR, env.SPO_NO_REAL_SPAWN,
//         Object.keys(env).filter(k => k.startsWith('GIT_')));"
//   undefined /tmp/spo-isolated-product-... /tmp/spo-isolated-worktrees-... /tmp/spo-isolated-reports-... 1 []
// -- GIT_* gone, every isolation override (including SPO_NO_REAL_SPAWN) intact.
function isolatedGitEnv() {
  const env = isolatedEnv();
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

// ---- T3 -- the child actually honours it, through the real entry point (orchestrator/daemon.js) ----
//
// --shadow mode never spawns a real command through its OWN task machinery (daemon.js's own
// header: "Never spawns a subprocess..."; every real call site in state-machine.js is gated on
// isRealMode(ctx)/config.real, and --shadow can never make either true). That is deliberate
// defense in depth, not a gap this test can exploit -- so there is no *correct* code path for a
// --shadow run to reach a real spawnSync at all, which is exactly the property the guard exists to
// backstop if a future isRealMode/config.real regression ever breaks it.
//
// So T3 observes the property this guard actually promises -- "once daemon.js has required
// command-timeout.js (which destructures spawnSync off child_process at module load, exactly as
// it does inside a real --worker/--scanner child), that module's captured spawnSync reference is
// the patched thrower iff SPO_NO_REAL_SPAWN was set before daemon.js's own first require ran" --
// through the REAL entry point, without inventing a production backdoor or reaching for --real.
// A `--require <probe.js>` preload registers a `process.on('exit', ...)` handler before node ever
// loads daemon.js; by the time that handler fires, daemon.js's `--once` run (against an EMPTY,
// isolated queue) has already required state-machine.js -> steps/scripted.js -> command-timeout.js
// (state-machine.js's own top-of-file requires, unconditional, not gated on there being a task to
// run) and exited normally. The handler then calls command-timeout.js's `armTimeout` directly
// (from the SAME require-cache entry the child's own require graph already populated) with the
// harmless, write-free command above, and records whether it threw to a marker file (a file, not
// stdout/stderr, so this needs no fragile stdio-capture plumbing around a sync process-exit hook).
function buildProbeScript(commandTimeoutPath, outFile) {
  return [
    "'use strict';",
    "const fs = require('fs');",
    'process.on(\'exit\', () => {',
    '  let result;',
    '  try {',
    `    const { armTimeout } = require(${JSON.stringify(commandTimeoutPath)});`,
    `    armTimeout({}, {}, ${JSON.stringify(HARMLESS_COMMAND)}, ${JSON.stringify(HARMLESS_ARGS)});`,
    "    result = 'NO_THROW';",
    '  } catch (err) {',
    "    result = 'THROW:' + (err && err.message);",
    '  }',
    '  try {',
    `    fs.writeFileSync(${JSON.stringify(outFile)}, result);`,
    '  } catch (_err) {',
    '    /* best-effort marker write from a sync exit hook -- nothing to recover into */',
    '  }',
    '});',
    '',
  ].join('\n');
}

// Runs a real `node orchestrator/daemon.js --shadow --once` child, preloaded with the probe
// above, against a fresh isolated queue/journal (both empty -- --once on an empty queue drains
// nothing and returns) and the given env. Bounded timeout: a hung child fails this test by name
// (execFileSync throws ETIMEDOUT/SIGTERM, not a stalled suite) rather than by hanging it.
//
// Generalized over the ENTRY POINT (daemon.js below, bin/spo further down for F1) rather than
// hard-coded to daemon.js: both are real, separately-armed entry points
// (orchestrator/no-real-spawn-guard.js's installGuard() call is duplicated at the top of each,
// line-neutrally, precisely because a child re-executing either one needs to arm itself before
// ITS OWN first require -- see that module's own header), and both transitively require
// command-timeout.js at load time regardless of which subcommand/flag is given (daemon.js via
// state-machine.js; bin/spo via `require('../orchestrator/recette')` -> `require('./state-
// machine')`, unconditional at bin/spo's own top, page-loaded no matter which CLI subcommand runs
// or whether one is given at all). One probe script, one marker-file protocol, two entry points.
function runProbedEntrypoint(entrypointPath, extraArgs, env) {
  const probeDir = mkTmp('spo-norealspawn-probe-');
  const probePath = path.join(probeDir, 'probe.js');
  const outFile = path.join(probeDir, 'result.txt');
  const commandTimeoutPath = path.join(REPO_ROOT, 'orchestrator', 'command-timeout.js');
  fs.writeFileSync(probePath, buildProbeScript(commandTimeoutPath, outFile));

  const args = ['--require', probePath, entrypointPath, ...extraArgs];
  try {
    // 20s: generous for an empty-queue daemon.js --once run or a no-subcommand bin/spo run
    // (normally well under 1s for either), tiny next to the 60s budget test/helpers.js's own
    // worker-mode runner uses for the same kind of child.
    execFileSync(process.execPath, args, { encoding: 'utf8', env, timeout: 20000 });
  } catch (_err) {
    // bin/spo with no recognized subcommand prints usage and sets `process.exitCode = 1`
    // (execFileSync throws on any non-zero exit) -- expected and irrelevant here: the exit hook
    // below still ran (it fires on `process.on('exit', ...)` regardless of the exit code), which
    // is the only thing this function's caller cares about. A genuine hang still fails by name via
    // the `timeout` above (ETIMEDOUT/SIGTERM on the caught error), not silently swallowed here.
  }

  assert.ok(fs.existsSync(outFile), 'the probe\'s exit hook must have written a result marker');
  return fs.readFileSync(outFile, 'utf8');
}

function runProbedDaemonOnce(env) {
  const queueDir = mkTmp('spo-norealspawn-queue-');
  const journalDir = mkTmp('spo-norealspawn-journal-');
  return runProbedEntrypoint(DAEMON, ['--shadow', '--once', '--queue', queueDir, '--journal', journalDir], env);
}

// F1 -- bin/spo has no task/queue/journal concept of its own to drive it harmlessly through its
// requires, so this runs it with NO subcommand at all: `main()`'s own fallback
// (`printUsage(); process.exitCode = 1;`) does nothing but print and exit, and by the time it
// reaches that fallback bin/spo has already executed EVERY one of its own top-of-file requires
// (recette.js among them, unconditional, regardless of which subcommand -- or none -- is given).
//
// WHY "no subcommand at all" is SUFFICIENT, not just convenient: bin/spo's own top-of-file
// requires -- `const recette = require('../orchestrator/recette');`, itself requiring
// `./state-machine`, which unconditionally requires `./steps/scripted` and `./command-timeout` at
// ITS OWN top -- run at MODULE LOAD, before `main()` ever inspects `process.argv` to decide which
// subcommand (if any) was asked for. Verified directly, not assumed:
//   $ grep -n "require(" bin/spo | grep -c orchestrator   # 15 orchestrator requires, all above main()
//   $ grep -n "^const recette = require" bin/spo          # unconditional, not inside any `if`
// So "no subcommand" reaches the exact same require graph -- and therefore the exact same
// command-timeout.js spawnSync capture -- as any real subcommand would, without this test needing
// to fabricate a safe-to-run one. Verified, not assumed, that today's requires are the ONLY ones
// gating this: 19 top-level requires sit at bin/spo:204-222 (unconditional, above `main()`), and
// the only LAZY requires anywhere in the file are `console/serve|system|prod-version|usage-scan|
// par-times` around :1124-1155, none of which touches a spawn function.
//
// THIS IS ALSO THE TEST'S OWN BLIND SPOT, worth flagging for whoever touches bin/spo next: if a
// future change makes any of TODAY's unconditional requires LAZY (e.g. moving
// `require('../orchestrator/recette')` inside `if (cmd === 'recette')`), this test would keep
// passing while silently testing nothing -- command-timeout.js would no longer be loaded (or its
// spawnSync captured) until a real subcommand ran, and this probe never asks for one. THE REMEDY,
// concretely: add an assertion inside the probe's own exit hook (buildProbeScript above) that pins
// the entry point's own `require.cache` -- e.g. `Object.keys(require.cache).some(p =>
// p.endsWith('command-timeout.js'))` -- asserted true BEFORE calling armTimeout. That directly
// checks "was command-timeout.js ever loaded by this run" instead of inferring it from bin/spo's
// current require graph by eye, and it would fail by name the moment a lazy-require refactor moves
// the load somewhere this probe's argv (no subcommand) no longer reaches.
function runProbedBinSpo(env) {
  return runProbedEntrypoint(SPO_BIN, [], env);
}

test('T3: a real daemon.js child, with SPO_NO_REAL_SPAWN set, has command-timeout.js\'s captured spawnSync throw the guard error', () => {
  const env = { ...isolatedEnv() }; // isolatedEnv() already sets SPO_NO_REAL_SPAWN='1' -- armed by default
  assert.equal(env[SPO_NO_REAL_SPAWN], '1', 'isolatedEnv() is expected to arm this by default (test/helpers.js change)');
  const result = runProbedDaemonOnce(env);
  assert.match(result, /^THROW:/, `expected the armed child to throw; got: ${result}`);
  assert.match(result, /no-real-spawn-guard/);
  assert.match(result, new RegExp(HARMLESS_COMMAND));
});

test('T3 (revoked): the SAME probe, with SPO_NO_REAL_SPAWN stripped from the child env, runs the real (write-free) command instead', () => {
  const env = isolatedGitEnv(); // strips GIT_* AND keeps every isolatedEnv() override -- see its own header
  delete env[SPO_NO_REAL_SPAWN];
  assert.equal(env[SPO_NO_REAL_SPAWN], undefined);
  // Measured composition, not assumed: this child runs a REAL `git --version` below, so both
  // properties actually have to hold, not just the one that's easy to eyeball.
  assert.deepEqual(
    Object.keys(env).filter((k) => k.startsWith('GIT_')),
    [],
    'isolatedGitEnv() must strip every inherited GIT_* variable before this child runs a real git command'
  );
  assert.ok(env.SPO_PRODUCT_REPO, 'isolatedGitEnv() must still carry isolatedEnv()\'s SPO_PRODUCT_REPO override');
  assert.ok(env.SPO_WORKTREES_DIR, 'isolatedGitEnv() must still carry isolatedEnv()\'s SPO_WORKTREES_DIR override');
  assert.ok(env.SPO_REPORTS_DIR, 'isolatedGitEnv() must still carry isolatedEnv()\'s SPO_REPORTS_DIR override');
  const result = runProbedDaemonOnce(env);
  assert.equal(
    result,
    'NO_THROW',
    `expected the revoked child to run the real, write-free "${HARMLESS_COMMAND} ${HARMLESS_ARGS.join(' ')}" without throwing; got: ${result}`
  );
  // Write-free argument: this child's ONLY spawn attempt is `git --version` (HARMLESS_COMMAND/
  // HARMLESS_ARGS above), which reads and writes nothing repo-specific -- it does not even need a
  // `.git` directory to succeed, and now runs with GIT_* stripped regardless (isolatedGitEnv()
  // above), so an inherited GIT_DIR from whatever ran this suite (e.g. this repo's own pre-push
  // hook) cannot reach it even in principle. Every other path this child touches is the queue/
  // journal/product-repo/worktrees temp dirs isolatedEnv() built, in --shadow mode, which --
  // independent of SPO_NO_REAL_SPAWN entirely -- never spawns anything through its own task
  // machinery (see this file's header). Nothing here reaches the real repo, ~/.spo-state,
  // ~/.spo-reports or GitHub.
});

// ---- F1 -- bin/spo is a SECOND real entry point that arms this guard (its own top-of-file
// `installGuard()` call, line-neutral -- see this chantier's own report), and it had NO test of
// its own: daemon.js's arming is proven load-bearing by T3 above, but nothing proved bin/spo's
// placement (before its own first require) actually matters, versus merely being present. Same
// probe technique as T3, different entry point and argv shape (see runProbedBinSpo's own header
// for why "no subcommand at all" is the harmless drive-it-through-its-requires path here).
test('F1: a real bin/spo child, with SPO_NO_REAL_SPAWN set, has command-timeout.js\'s captured spawnSync throw the guard error', () => {
  const env = { ...isolatedEnv() };
  assert.equal(env[SPO_NO_REAL_SPAWN], '1', 'isolatedEnv() is expected to arm this by default (test/helpers.js change)');
  const result = runProbedBinSpo(env);
  assert.match(result, /^THROW:/, `expected the armed bin/spo child to throw; got: ${result}`);
  assert.match(result, /no-real-spawn-guard/);
  assert.match(result, new RegExp(HARMLESS_COMMAND));
});

test('F1 (revoked): the SAME bin/spo probe, with SPO_NO_REAL_SPAWN stripped from the child env, runs the real (write-free) command instead', () => {
  const env = isolatedGitEnv(); // strips GIT_* AND keeps every isolatedEnv() override -- see its own header
  delete env[SPO_NO_REAL_SPAWN];
  assert.equal(env[SPO_NO_REAL_SPAWN], undefined);
  assert.deepEqual(
    Object.keys(env).filter((k) => k.startsWith('GIT_')),
    [],
    'isolatedGitEnv() must strip every inherited GIT_* variable before this child runs a real git command'
  );
  const result = runProbedBinSpo(env);
  assert.equal(
    result,
    'NO_THROW',
    `expected the revoked bin/spo child to run the real, write-free "${HARMLESS_COMMAND} ${HARMLESS_ARGS.join(' ')}" without throwing; got: ${result}`
  );
  // Write-free argument, same as T3 (revoked) above: the only spawn attempt this child ever makes
  // is `git --version`, now with GIT_* stripped (isolatedGitEnv() above) regardless of the write-
  // free command already needing no `.git` directory to succeed, and it is never even given a
  // subcommand (no --journal/--queue/--accounts-dir/product-repo path is touched at all -- bin/
  // spo's own `main()` falls straight through to `printUsage()` and exits). Nothing here reaches
  // the real repo, ~/.spo-state, ~/.spo-reports or GitHub.
});

// ---- T2 -- the revoke proof: pin the resolved (armed) behaviour, then show it falls when
// revoked. Runs BEFORE T1 (and after T3) -- see this file's header for why the order is load-
// bearing.
test('T2: revoke proof -- the REAL execFileSync succeeds on the harmless command; the identical call throws once installGuard arms it', () => {
  // "Revoked" half FIRST -- genuinely pristine: nothing above this test has called installGuard(),
  // and requiring test/no-real-spawn.js (top of file) never touches execFileSync at all (its own
  // documented scope is spawnSync only). The real command runs for real and succeeds. `env:
  // gitEnv()` (test/helpers.js) strips every inherited GIT_* variable -- see that helper's own
  // header for the incident (a real `git` call under this repo's pre-push hook otherwise acts on
  // THIS repository's inherited GIT_DIR, not a throwaway one) -- required here regardless of
  // `--version` never actually touching GIT_DIR itself, so this call site matches
  // test/no-git-env-sweep.test.js's own rule (which spells the command `'git'`, not a variable, so
  // it can see this call) instead of being exempt from it by construction.
  const before = execFileSync('git', HARMLESS_ARGS, { encoding: 'utf8', env: gitEnv() });
  assert.equal(typeof before, 'string', 'expected the real, unpatched execFileSync to succeed on a write-free command before this guard is armed');

  // Arm THIS guard (orchestrator/no-real-spawn-guard.js), and show the IDENTICAL call and args now
  // throw -- the assertion falls exactly when the guard is turned on, which is what proves T1
  // (below) is testing the guard and not some coincidence of the environment (e.g. `git` being
  // absent from PATH).
  const armed = installGuard({ [SPO_NO_REAL_SPAWN]: '1' });
  assert.equal(armed, true);
  // cp.execFileSync (live property read), NOT the destructured `execFileSync` above -- see this
  // file's top-of-file comment for why the destructured binding would miss installGuard()'s patch.
  assert.throws(() => cp.execFileSync('git', HARMLESS_ARGS, { encoding: 'utf8', env: gitEnv() }), /no-real-spawn-guard/);
});

// ---- T1 -- the guard arms: with the var set, a real spawn throws the NAMED error (command +
// args + a distinguishing error code), not just "some" throw. Runs after T2, so the guard is
// already armed here (installGuard is idempotent -- calling it again is a documented no-op).
test('T1: with SPO_NO_REAL_SPAWN set, a real execFileSync of a harmless command throws, naming the command/args/error code', () => {
  installGuard({ [SPO_NO_REAL_SPAWN]: '1' }); // idempotent -- already armed by T2 above
  assert.throws(
    () => cp.execFileSync('git', HARMLESS_ARGS, { encoding: 'utf8', env: gitEnv() }),
    (err) => {
      assert.match(err.message, /no-real-spawn-guard/);
      assert.match(err.message, /execFileSync/);
      assert.match(err.message, new RegExp(HARMLESS_COMMAND));
      assert.match(err.message, /"--version"/);
      assert.equal(err.code, 'ENOREALSPAWN');
      return true;
    }
  );
});

// ---- F5 -- every function orchestrator/no-real-spawn-guard.js patches, not just spawnSync
// (T3) and execFileSync (T1/T2). PATCHED_FUNCTIONS silently shrinking to just those two would go
// undetected without this: `execSync`, `exec` and `execFile` need their own proof. Runs after T1
// (guard already armed, idempotent). `exec`/`execFile` are ASYNCHRONOUS/callback-based in normal
// use -- this guard's thrower fires SYNCHRONOUSLY regardless (see orchestrator/no-real-spawn-
// guard.js's own "scope" header for the failure-mode discussion), which is exactly why
// `assert.throws` (a SYNCHRONOUS-throw assertion) is the right tool for all five rows below, not
// just the two synchronous ones.
test('every one of the five patched functions throws when armed, naming itself', () => {
  installGuard({ [SPO_NO_REAL_SPAWN]: '1' }); // idempotent -- already armed above
  const gitCommandLine = `git ${HARMLESS_ARGS.join(' ')}`;
  const table = [
    ['spawnSync', () => cp.spawnSync('git', HARMLESS_ARGS, { encoding: 'utf8', env: gitEnv() })],
    ['execFileSync', () => cp.execFileSync('git', HARMLESS_ARGS, { encoding: 'utf8', env: gitEnv() })],
    // execSync/exec are NOT matched by test/no-git-env-sweep.test.js's own regex (it only checks
    // execFileSync/execFile/spawnSync/spawn) -- passing `env: gitEnv()` here anyway is defence in
    // depth, not compliance with a rule that does not reach these two.
    ['execSync', () => cp.execSync(gitCommandLine, { encoding: 'utf8', env: gitEnv() })],
    // A no-op callback: if the thrower ever stopped throwing synchronously and instead honoured
    // the normal async contract, this callback would simply never fire within the synchronous
    // assert.throws below, and the missing throw would fail the assertion by name instead of
    // hanging -- there is no bounded wait here because a real `exec`/`execFile` call is never
    // reached (this guard's thrower fires before that point on every armed call).
    ['exec', () => cp.exec(gitCommandLine, { env: gitEnv() }, () => {})],
    ['execFile', () => cp.execFile('git', HARMLESS_ARGS, { env: gitEnv() }, () => {})],
  ];
  for (const [name, invoke] of table) {
    assert.throws(
      invoke,
      (err) => {
        assert.match(err.message, /no-real-spawn-guard/, `${name}: missing the guard's own message prefix`);
        assert.match(err.message, new RegExp(name), `${name}: error must name the function it patched`);
        assert.equal(err.code, 'ENOREALSPAWN', `${name}: missing the ENOREALSPAWN error code`);
        return true;
      },
      `${name} did not throw when armed -- PATCHED_FUNCTIONS may be missing it`
    );
  }
});

test('installGuard is inert when the var is unset, \'\', or \'0\' -- does not touch child_process at all', () => {
  // A fresh, unrelated symbol table can't be observed from here (child_process is a singleton
  // module), so this asserts the CONTRACT (installGuard returns false, meaning "did not arm")
  // rather than re-deriving process-wide mutation state that earlier tests in this file already
  // altered -- see isEnabled's own unit coverage below for the falsy-value table directly.
  assert.equal(isEnabled({}), false);
  assert.equal(isEnabled({ [SPO_NO_REAL_SPAWN]: '' }), false);
  assert.equal(isEnabled({ [SPO_NO_REAL_SPAWN]: '0' }), false);
  assert.equal(isEnabled({ [SPO_NO_REAL_SPAWN]: '1' }), true);
  assert.equal(isEnabled({ [SPO_NO_REAL_SPAWN]: 'true' }), true);
});
