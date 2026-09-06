'use strict';
// no-real-spawn-guard.js -- action 1 of the lot11-82 chantier: arms the no-real-spawn killswitch
// for CHILD PROCESSES, which test/no-real-spawn.js cannot reach.
//
// ---- the gap this closes --------------------------------------------------------------------
//
// test/no-real-spawn.js patches `child_process.spawnSync` IN-PROCESS, as a side effect of being
// required by a test file. That is exactly right for the test suite itself (every test runs in
// its own node:test worker process, and this repo's tests never spawn a real daemon/worker child
// that then spawns ANOTHER real command). It does nothing at all for a REAL daemon: dispatcher.js
// spawns worker/scanner children with `child_process.spawn(process.execPath, [DAEMON_PATH, ...],
// { detached: true, stdio: 'ignore' })` -- no `env:` option, so the child inherits
// `process.env` by Node's own default, but it is a SEPARATE PROCESS with its own, fresh
// `child_process` module object. A patched function in the parent means nothing to it. Measured:
// `grep -rn "NO_REAL_SPAWN|noRealSpawn"` over the whole repo returned zero before this file --
// no env var existed and no production code honoured one (orchestrator/README.md's own admission
// of the gap).
//
// A mutated/regressed `isRealMode`/`config.real` gate inside a spawned worker or scanner child
// would therefore reach the REAL `spawnSync` with no guard at all -- exactly the class of incident
// test/no-real-spawn.js exists to close, just one process hop further out. Five production call
// sites reach it this way (verified by `grep -n "spawnSync" orchestrator/*.js orchestrator/steps/*.js`,
// not by counting from memory): command-timeout.js's armTimeout, park-alert.js's runSync,
// steps/scripted.js's runSync/runScripted, steps/llm.js's invokeClaudeReal (the real `claude`
// invocation itself, at :418 -- arguably the most consequential of the five), and recette.js's
// wrapSpawnSync fallback (:1004, a live `require('child_process').spawnSync` property read rather
// than a module-load-time destructure, so it is immune to require ORDER but not to this guard,
// which patches the same shared property either way).
//
// ---- design: propagated by the ENVIRONMENT, not by module state --------------------------------
//
// A child process cannot see a patched function object in its parent; it CAN see an inherited
// environment variable, since dispatcher.js's spawn() (and bin/spo/daemon.js spawned directly by
// a human or a test) pass no `env:` override, so `process.env` crosses the fork verbatim by Node's
// own default. SPO_NO_REAL_SPAWN is that variable. Two producers set it in the PARENT's spawn
// environment (test/no-real-spawn.js's installer, and test/helpers.js's isolatedEnv() explicitly,
// for the call sites that DO pass an explicit `env:` object and would otherwise silently drop an
// inherited one); this module is the single CONSUMER, read fresh out of `env` every call so it
// never depends on when in the require order it itself was loaded relative to those producers.
//
// ---- scope: every command-execution entry point EXCEPT `spawn` itself --------------------------
//
// test/no-real-spawn.js patches `spawnSync` only, because every test call site can inject
// `deps.spawnSync` instead of ever touching the real binding, and the suite's own sanctioned
// real-process boundary (test/helpers.js's execFileSync launches of daemon.js/bin/spo) legitimately
// needs `execFileSync` left alone. Neither exception applies here in the same shape: a spawned
// worker/scanner child is `orchestrator/daemon.js` re-executed from scratch, `deps` is always `{}`
// in it (no test harness reaches into a live child to inject anything), and all FIVE actual
// production call sites this guard defends -- command-timeout.js's armTimeout, park-alert.js's
// runSync, steps/scripted.js's runSync/runScripted, steps/llm.js's invokeClaudeReal, and
// recette.js's wrapSpawnSync fallback (see this file's own header for the line numbers and the
// grep that found them) -- are all `spawnSync`. So this module patches every OTHER function
// `child_process` exposes for running a named program, in two groups:
//
//   - SYNCHRONOUS, like `spawnSync` itself: `execSync`, `execFileSync`.
//   - ASYNCHRONOUS, callback-based: `exec`, `execFile`. These are NOT synchronous -- a normal
//     call passes a `callback` and gets a `ChildProcess` back immediately; this guard's thrower
//     throws SYNCHRONOUSLY instead, at the call site, before any callback is ever invoked and
//     before a `ChildProcess` is ever returned. A caller written the normal way for these two
//     (no `try/catch` around the call itself, error handling done in the callback or on the
//     returned object's `'error'` event) will see this exception propagate as an UNCAUGHT
//     exception instead -- which crashes the child process outright rather than reaching any
//     error-handling code the caller wrote. For THIS guard's purpose that outcome is acceptable
//     (a tripped killswitch should stop the child hard, and dispatcher.js's crash-repark path
//     handles a crashed worker/scanner under `worker-crashed` either way -- see the reason-
//     classification note in this chantier's own report), but it is a real behavioural
//     difference from the async contract these two functions normally offer, not merely a
//     cosmetic one, and is recorded here so nobody has to rediscover it from a stack trace.
//     A repo-wide grep found ZERO production call sites using `exec`/`execFile` today --
//     `grep -rn "\bexec(\|\bexecFile(" orchestrator/ bin/spo` -- so this mismatch has no live
//     caller to break; every hit that command DOES return is a RegExp.exec() (pipeline-version.js,
//     intake.js, prompt-template.js, steps/scripted.js, plan-span-guard.js), never
//     child_process.exec/execFile. If a real one is ever added, re-read this paragraph first.
//
// `spawn` (the async, non-callback one) is DELIBERATELY EXCLUDED, and this is not an oversight:
// dispatcher.js itself is the one and only call site that uses it (`const { spawn: realSpawn } =
// require('child_process')`, dispatcher.js:101), to launch its OWN worker/scanner children
// (`spawn(process.execPath, [DAEMON_PATH, ...], {...})`, :729/:745) -- a re-exec of THIS SAME
// daemon.js, not a git/gh/npm/claude command. That is legitimate, load-bearing infrastructure
// needed in EVERY mode, including --shadow, and it runs in the PARENT (the continuous-mode
// daemon itself), not only in an already-spawned child -- so patching it would not add defense in
// depth against a mutated isRealMode gate, it would break the daemon's own ability to spawn
// workers at all the moment this var is set (measured: it did, hanging test/dispatcher.test.js's
// continuous-mode tests, before this exclusion was added). If a future call site ever starts
// reaching git/gh/npm/claude through the async spawn(), extend this module then -- the same
// precedent test/no-real-spawn.js's own header sets for its own, narrower scope.
//
// Since the whole module is a no-op unless the env var is set (see isEnabled below), this scope
// carries no production risk either way: the live daemon never sets it, so none of this ever
// executes there.
//
// ---- inert unless armed -------------------------------------------------------------------------
//
// installGuard() does nothing at all -- does not even touch `child_process` -- unless the var is
// set to something truthy. `''` and `'0'` are both treated as unset/false (a blank value, or an
// explicit "off" some caller constructs programmatically, must not arm a killswitch that then
// kills the very daemon it was trying to leave alone); every other non-empty string (`'1'`,
// `'true'`, ...) arms it. This ships in production code paths (daemon.js, bin/spo) and must stay
// inert for the live daemon, which never sets this var.
//
// ---- idempotent -----------------------------------------------------------------------------
//
// installGuard() REPLACES `cp[name]` with a freshly created thrower every time it runs -- it never
// wraps whatever was there before, so "double-wrapping" was never actually possible by
// construction, armed or not. What the `ALREADY_INSTALLED` marker on the `child_process` module
// object actually does is make a second call a no-op instead of a harmless-but-pointless
// re-assignment: without it, calling installGuard() twice (daemon.js's own top-of-file call, plus
// a test that also wants to call it directly to assert on the installed function) would replace
// each `cp[name]` with a DIFFERENT, functionally-identical closure -- not wrong, but it means any
// caller holding a reference to the previously-installed function (e.g. comparing it by `===`, as
// this module's own test suite does) would see it change out from under them for no behavioural
// reason. The marker keeps the SAME five function objects installed across repeated calls.

const cp = require('child_process');

// The env var name AND its own value -- one source of truth shared by the two producers
// (test/no-real-spawn.js, test/helpers.js's isolatedEnv()) and this consumer, rather than three
// independent string literals that could drift.
const SPO_NO_REAL_SPAWN = 'SPO_NO_REAL_SPAWN';

// Every child_process entry point that can run a named program EXCEPT `spawn` -- see "scope"
// above for the synchronous/asynchronous split (`spawnSync`/`execSync`/`execFileSync` are
// synchronous; `exec`/`execFile` are asynchronous, callback-based, and this guard's thrower fires
// synchronously for those two instead) and for why `spawn` itself is deliberately excluded
// (dispatcher.js's own worker/scanner launch mechanism, not a git/gh/npm/claude boundary).
const PATCHED_FUNCTIONS = ['spawnSync', 'execFileSync', 'execSync', 'execFile', 'exec'];

const ALREADY_INSTALLED = Symbol.for('spo.no-real-spawn-guard.installed');

// isEnabled(env) -- true only for a non-empty, non-'0' value. Reads whatever `env` object is
// handed in (defaulting to `process.env`) rather than caching a value at require time, so a test
// can flip the var and re-check without needing to reload this module.
function isEnabled(env) {
  const raw = (env || process.env)[SPO_NO_REAL_SPAWN];
  return !!raw && raw !== '0';
}

function describeArgs(args) {
  try {
    return JSON.stringify(args || []);
  } catch (_err) {
    return String(args);
  }
}

// makeThrower(name) -- one thrower per patched function name, so the error message always names
// the ACTUAL entry point a caller reached (armTimeout's spawnSync vs. some future execFile caller)
// instead of a generic "a spawn happened" that would leave the next debugger re-deriving which
// function it was.
function makeThrower(name) {
  return function noRealSpawnThrower(command, args) {
    const err = new Error(
      `no-real-spawn-guard: a child process reached the REAL child_process.${name} -- ` +
        `${command} ${describeArgs(Array.isArray(args) ? args : [])}. SPO_NO_REAL_SPAWN is set, ` +
        'so this child refuses to run a real command instead of silently reaching git/gh/npm/' +
        'claude with live credentials. This means a mutated or regressed isRealMode/config.real ' +
        'gate let a spawned worker or scanner child reach a real call site -- see ' +
        'orchestrator/no-real-spawn-guard.js.'
    );
    err.code = 'ENOREALSPAWN';
    throw err;
  };
}

// installGuard(env = process.env) -- the installer. Returns true iff the guard is armed (either
// just now, or already, by an earlier call) so a caller can tell "armed" from "inert" without a
// separate isEnabled() call of its own.
function installGuard(env = process.env) {
  if (!isEnabled(env)) return false;
  if (cp[ALREADY_INSTALLED]) return true;
  for (const name of PATCHED_FUNCTIONS) {
    cp[name] = makeThrower(name);
  }
  cp[ALREADY_INSTALLED] = true;
  return true;
}

module.exports = { SPO_NO_REAL_SPAWN, installGuard, isEnabled };
