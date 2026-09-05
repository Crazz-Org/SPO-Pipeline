'use strict';
// Unit tests for orchestrator/command-timeout.js -- action 2.1b's shared classifier/arming
// module, factored out of steps/scripted.js (action 2.1) once board.js/park-loop.js/
// report-intake.js/intake.js needed the identical (command, args) -> timeout-class mapping for
// their own private runSync wrappers. classifyCommand's own per-shape coverage already exists in
// test/real-steps.test.js (re-exported from steps/scripted.js, unaffected by the move) -- this
// file covers classTimeoutMs's tolerance, isSpawnTimeout's three-way split, and armTimeout's
// wiring (the one place every one of the four modules' own runSync now delegates to), so "an
// explicit opts.timeout always wins" and "the class default gets armed" are each proven ONCE at
// the shared choke point rather than re-proven at every call site that merely forwards to it.

const test = require('node:test');
const assert = require('node:assert/strict');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require directly below.
require('./no-real-spawn');

const { classifyCommand, classTimeoutMs, isSpawnTimeout, isSpawnKilled, armTimeout } = require('../orchestrator/command-timeout');
const { timeoutResult, mkTmp } = require('./helpers');

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

// An EXTERNALLY KILLED child (an operator's kill -9, an OOM kill, a deploy restart's SIGTERM):
// no `error`, no ETIMEDOUT code, just a bare signal. The name is historical -- what makes this
// not a timeout is the ABSENT ETIMEDOUT, not the absent deadline, and isSpawnKilled recognises it
// either way (a deadline being armed or not is unrelated to who killed the child).
function killedNoDeadline(signal = 'SIGKILL') {
  return { status: null, stdout: '', stderr: '', signal, error: null };
}

// ---- classTimeoutMs -------------------------------------------------------------------------

test('classTimeoutMs: reads the class value off config.commandTimeoutsMs', () => {
  const config = { commandTimeoutsMs: { git: 120000, 'npm-run': 660000 } };
  assert.equal(classTimeoutMs(config, 'git'), 120000);
  assert.equal(classTimeoutMs(config, 'npm-run'), 660000);
});

test('classTimeoutMs: null commandClass, a config with no commandTimeoutsMs, and no config at all all tolerate to undefined -- never throw', () => {
  assert.equal(classTimeoutMs({ commandTimeoutsMs: { git: 1 } }, null), undefined);
  assert.equal(classTimeoutMs({ ghRepo: 'x/y' }, 'git'), undefined);
  assert.equal(classTimeoutMs(undefined, 'git'), undefined);
});

test('classTimeoutMs: a malformed SPO_TIMEOUT_*_MS override degrades to "no class default" instead of crashing the daemon', () => {
  // config.js builds every entry as `Number(process.env.SPO_TIMEOUT_*_MS)`, so a non-numeric
  // paste ("2min", "10m") lands as NaN and a fractional one as a non-integer. Node's spawnSync
  // VALIDATES its `timeout` option and THROWS ERR_OUT_OF_RANGE ("must be an unsigned integer")
  // before spawning -- which, handed through, would put a synchronous throw inside board.js's
  // moveCard and park-loop.js's postParkComment, both documented "never throws" and both running
  // inside finalizePark. That is the crash-loop shape (task never reaches PARKED -> daemon exits
  // -> orphanScan reparks through the same path) this whole action exists to prevent.
  assert.equal(classTimeoutMs({ commandTimeoutsMs: { gh: NaN } }, 'gh'), undefined);
  assert.equal(classTimeoutMs({ commandTimeoutsMs: { gh: 1.5 } }, 'gh'), undefined);
  assert.equal(classTimeoutMs({ commandTimeoutsMs: { gh: '120000' } }, 'gh'), undefined);
  assert.equal(classTimeoutMs({ commandTimeoutsMs: { gh: -1 } }, 'gh'), undefined);
  assert.equal(classTimeoutMs({ commandTimeoutsMs: { gh: Infinity } }, 'gh'), undefined);
});

test('moveCard/postParkComment: a malformed timeout override never throws', () => {
  // Once classTimeoutMs's own guard is in place (see its "a malformed SPO_TIMEOUT_*_MS override"
  // test above), a NaN/negative/fractional commandTimeoutsMs entry degrades to "no class default"
  // BEFORE it ever reaches spawnSync's opts -- so the real spawnSync's option-validation throw
  // this test originally meant to dodge is never actually reached at all: with no `timeout` key
  // in opts, moveCard/postParkComment fall through to an ordinary, un-timed spawn. That ordinary
  // spawn is still a REAL `npm run board:move` / `gh issue comment`, which is exactly the class
  // test/no-real-spawn.js exists to catch -- so this test injects deps.spawnSync like every other
  // caller in this suite, and asserts doesNotThrow purely over the malformed-config path (the
  // option-validation guarantee itself is already pinned, directly, by classTimeoutMs's own
  // tests above).
  const { moveCard } = require('../orchestrator/board');
  const { postParkComment } = require('../orchestrator/park-loop');
  const badConfig = { ghRepo: 'x/y', commandTimeoutsMs: { gh: NaN, 'npm-run': NaN } };
  // The stub ASSERTS on opts rather than ignoring it, and that assertion is the whole point of
  // the test: with a plain `() => ok('')` stub, a regression where armTimeout reads
  // config.commandTimeoutsMs directly instead of going through classTimeoutMs's guard survives
  // the entire suite green -- and that regression hands `timeout: NaN` to the real spawnSync,
  // which throws ERR_OUT_OF_RANGE synchronously inside moveCard/postParkComment, the two
  // functions this repo documents as "never throws", both reached from finalizePark. Pinning
  // classTimeoutMs's guard in isolation (the test above) does not pin the composition.
  const deps = {
    spawnSync: (command, args, opts) => {
      assert.ok(
        !(opts && 'timeout' in opts),
        `a malformed override reached spawnSync's opts: timeout=${opts && opts.timeout}`
      );
      return ok('');
    },
  };

  const taskDir = mkTmp('ct-move-');
  const worktreePath = mkTmp('ct-wt-');
  assert.doesNotThrow(() =>
    moveCard({ task: { issue: 4321, worktreePath }, taskDir, config: badConfig }, deps, 'GATE')
  );

  const parkDir = mkTmp('ct-park-');
  assert.doesNotThrow(() =>
    postParkComment({ task: { issue: 4321 }, taskDir: parkDir, config: badConfig }, deps, {
      reason: 'x',
      detail: 'y',
      lastState: 'GATE',
    })
  );
});

// ---- isSpawnTimeout --------------------------------------------------------------------------

// The line this test used to carry --
//     isSpawnTimeout(killedNoDeadline(), true) === true, 'a bare signal still counts once a
//     deadline WAS armed'
// -- was the bug written down as an expectation. Measured on node v22, with a deadline armed in
// every case: a GENUINE timeout sets `error.code === 'ETIMEDOUT'` (and a kill signal); an EXTERNAL
// SIGTERM/SIGKILL sets a signal and NO error at all. So "a bare signal" is precisely the case
// isSpawnTimeout's own contract says it must exclude, and asserting the opposite is what let the
// clause survive. All three `timedOut: true` events in the corpus were external deploy kills; not
// one genuine timeout has ever been recorded.
test('isSpawnTimeout: ETIMEDOUT and a deadline, and nothing else', () => {
  assert.equal(isSpawnTimeout(timeoutResult(), true), true);
  assert.equal(
    isSpawnTimeout(killedNoDeadline(), true),
    false,
    'a bare signal is an EXTERNAL kill, not our own deadline -- the contract excludes it in so many words'
  );
  assert.equal(isSpawnTimeout(killedNoDeadline(), false), false, 'no deadline armed -- an operator kill -9/OOM, never our timeout');
  assert.equal(isSpawnTimeout(ok(''), true), false, 'a clean exit is never a timeout even with a deadline armed');
  // killSignal is a caller's choice; ETIMEDOUT is what actually means "our deadline fired".
  assert.equal(isSpawnTimeout(timeoutResult('SIGKILL'), true), true, 'a timeout killed with SIGKILL is still a timeout');
});

test('isSpawnKilled: a signal that is NOT our own deadline', () => {
  assert.equal(isSpawnKilled(killedNoDeadline('SIGTERM')), true, 'a deploy restart SIGTERM');
  assert.equal(isSpawnKilled(killedNoDeadline('SIGKILL')), true, 'an OOM or operator kill -9');
  assert.equal(isSpawnKilled(timeoutResult()), false, 'our own deadline is a timeout, never a kill -- the two are exclusive');
  assert.equal(isSpawnKilled(timeoutResult('SIGKILL')), false, 'still a timeout even though the signal is SIGKILL');
  assert.equal(isSpawnKilled(ok('')), false, 'a clean exit was not killed');
  assert.equal(isSpawnKilled({ status: 3, signal: null }), false, 'an ordinary non-zero exit was not killed');
  assert.equal(isSpawnKilled(undefined), false, 'never throws on a missing result');
});

test('isSpawnTimeout / isSpawnKilled partition the signalled cases -- never both, never neither', () => {
  for (const [label, result] of [
    ['genuine timeout', timeoutResult()],
    ['external kill', killedNoDeadline()],
  ]) {
    const t = isSpawnTimeout(result, true);
    const k = isSpawnKilled(result);
    assert.equal(t && k, false, `${label}: classified as BOTH a timeout and a kill`);
    assert.equal(t || k, true, `${label}: a signalled child was classified as neither`);
  }
});

test('armTimeout carries killedBySignal alongside timedOut', () => {
  const config = { commandTimeoutsMs: { git: 5000 } };
  const killed = armTimeout({ spawnSync: () => killedNoDeadline('SIGTERM') }, config, 'git', ['status'], {});
  assert.equal(killed.timedOut, false);
  assert.equal(killed.killedBySignal, true);

  const timedOut = armTimeout({ spawnSync: () => timeoutResult() }, config, 'git', ['status'], {});
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.killedBySignal, false);
});

// ---- armTimeout ------------------------------------------------------------------------------

test('armTimeout: arms the class default from config.commandTimeoutsMs when no opts.timeout is given', () => {
  const config = { commandTimeoutsMs: { gh: 120000 } };
  let seenOpts = null;
  const deps = { spawnSync: (cmd, args, opts) => { seenOpts = opts; return ok(''); } };

  armTimeout(deps, config, 'gh', ['pr', 'list'], {});

  assert.equal(seenOpts.timeout, 120000);
});

test('armTimeout: an explicit opts.timeout always wins over the class default', () => {
  const config = { commandTimeoutsMs: { gh: 120000 } };
  let seenOpts = null;
  const deps = { spawnSync: (cmd, args, opts) => { seenOpts = opts; return ok(''); } };

  armTimeout(deps, config, 'gh', ['pr', 'list'], { timeout: 5000, cwd: '/x' });

  assert.equal(seenOpts.timeout, 5000);
  assert.equal(seenOpts.cwd, '/x', 'other opts still pass through');
});

test('armTimeout: an unrecognized command classifies to null -- arms no timeout, never crashes', () => {
  const config = { commandTimeoutsMs: { gh: 120000 } };
  let seenOpts = null;
  const deps = { spawnSync: (cmd, args, opts) => { seenOpts = opts; return ok(''); } };

  const result = armTimeout(deps, config, 'curl', ['https://example.com'], {});

  assert.equal(seenOpts.timeout, undefined);
  assert.equal(result.commandClass, null);
  assert.equal(result.timeoutMs, null);
});

test('armTimeout: no config at all -- arms no timeout (pre-2.1b behaviour), never crashes', () => {
  const deps = { spawnSync: (cmd, args, opts) => ({ ...ok(''), sawTimeout: opts.timeout }) };
  const result = armTimeout(deps, undefined, 'gh', ['pr', 'list'], {});
  assert.equal(result.sawTimeout, undefined);
});

test('armTimeout: attaches timedOut/commandClass/timeoutMs onto the returned result', () => {
  const config = { commandTimeoutsMs: { git: 120000 } };
  const deps = { spawnSync: () => timeoutResult() };

  const result = armTimeout(deps, config, 'git', ['status', '--porcelain'], {});

  assert.equal(result.timedOut, true);
  assert.equal(result.commandClass, 'git');
  assert.equal(result.timeoutMs, 120000);
});

test('armTimeout: a clean exit carries timedOut: false, still tagged with its command class', () => {
  const config = { commandTimeoutsMs: { git: 120000 } };
  const deps = { spawnSync: () => ok('clean\n') };

  const result = armTimeout(deps, config, 'git', ['status', '--porcelain'], {});

  assert.equal(result.timedOut, false);
  assert.equal(result.commandClass, 'git');
  assert.equal(result.timeoutMs, 120000);
  assert.equal(result.stdout, 'clean\n');
});

test('armTimeout: deps.spawnSync is the only spawn point -- production never passes it, real code always uses the real spawnSync (smoke: classifyCommand alone, no spawn)', () => {
  // Not a spawn test -- just pins that classifyCommand (re-exported here) is the exact function
  // armTimeout uses internally, so a caller asserting classifyCommand(...) matches
  // armTimeout(...).commandClass is asserting one fact, not two independently-drifting ones.
  assert.equal(classifyCommand('npm', ['run', 'gate']), 'npm-gate');
});

// A malformed SPO_TIMEOUT_*_MS must cost you your override, never the bound itself. `Number("10m")`
// is NaN, and node's spawnSync VALIDATES the timeout option and throws RangeError before
// spawning -- which turned a typo in a systemd drop-in into a synchronous throw out of moveCard
// and postParkComment, both documented "never throws" and both running inside finalizePark.
// command-timeout.js guards against a bad config object; this pins the source of that config.
test('config: a malformed SPO_TIMEOUT_*_MS falls back to the default, never to NaN and never to unbounded', () => {
  const path = require('path');
  const configPath = require.resolve('../orchestrator/config.js');

  const load = (env) => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[configPath];
    try {
      return require('../orchestrator/config.js').commandTimeoutsMs;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete require.cache[configPath];
    }
  };

  const clean = load({ SPO_TIMEOUT_NPM_RUN_MS: undefined, SPO_TIMEOUT_GH_MS: undefined });

  // '' and '0' both yield Number 0, and spawnSync reads timeout:0 as NO TIMEOUT -- so they
  // would silently disarm the bound rather than loudly break it. They belong in this list.
  for (const bad of ['10m', '2min', '', '0', 'abc', '-1', '1.5', 'NaN']) {
    const t = load({ SPO_TIMEOUT_NPM_RUN_MS: bad });
    assert.equal(t['npm-run'], clean['npm-run'], `"${bad}" must fall back to the default`);
    assert.ok(Number.isInteger(t['npm-run']), `"${bad}" must never yield a non-integer`);
  }

  // A well-formed override still wins -- the guard must not swallow legitimate tuning.
  assert.equal(load({ SPO_TIMEOUT_GH_MS: '45000' }).gh, 45000);
  // There is no environment route to "unbounded" -- that is the point of the action.
  assert.equal(load({ SPO_TIMEOUT_GH_MS: '0' }).gh, clean.gh);
});
