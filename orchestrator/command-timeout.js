'use strict';
// command-timeout.js -- shared per-command-class timeout classification (action 2.1) and the
// spawnSync timeout-kill detection idiom, reused by every module in the daemon that spawns a real
// git/gh/npm command: steps/scripted.js's spawnStep (2.1's own choke point) plus the four modules
// 2.1 did not reach because they spawn through their own private runSync instead of spawnStep --
// board.js, park-loop.js, report-intake.js, intake.js (action 2.1b).
//
// Lives in its own file, not steps/scripted.js (where 2.1 first wrote classifyCommand) and not
// config.js (which already owns commandTimeoutsMs): steps/scripted.js requires ../board
// (moveCard), so board.js requiring classifyCommand back out of steps/scripted.js would be
// circular; config.js is required from many places specifically as inert, env-var-driven DATA
// (values in, nothing computed out) and should stay that way -- see its own commandTimeoutsMs
// comment, which still owns the per-class VALUES and their rationale. This module only owns the
// (command, args) -> class mapping and the timeout-kill detection, and has no requires of its own
// beyond child_process's spawnSync (used only as the DEFAULT spawn function -- deps.spawnSync
// always wins, same injection convention every caller already follows).

const { spawnSync } = require('child_process');

// classifyCommand(command, args) -> one of config.js's commandTimeoutsMs keys, or null. See
// config.js's own commandTimeoutsMs comment for the per-class rationale (git/gh/npm-ci/npm-gate/
// npm-run) and the values themselves -- this function only maps a call site's own (command, args)
// onto one of those keys. `npm run gate` gets its own class (the plan's calibration); every other
// `npm run <alias>` (typecheck, lint, coverage:changed, board:take, board:move, pr:wait, report:
// card, ...) shares 'npm-run'. An unrecognized (command, args) pair returns null, meaning "no
// class default" -- the caller arms no timeout unless it was given an explicit opts.timeout.
function classifyCommand(command, args) {
  if (command === 'git') return 'git';
  if (command === 'gh') return 'gh';
  if (command === 'npm') {
    if (args[0] === 'ci') return 'npm-ci';
    if (args[0] === 'run' && args[1] === 'gate') return 'npm-gate';
    if (args[0] === 'run') return 'npm-run';
  }
  // Action B1.4: FINISH's own reinstall of the bench worker (scripts/bench-install.sh, the same
  // script scripts/finish.sh's human-session rule already runs) -- `npm run build:e2e` followed by
  // a `systemctl --user restart`, run as ONE opaque command rather than reimplemented here, so it
  // can never drift from finish.sh's own behaviour. Its OWN class, not folded into 'npm-run':
  // building the worker is not bounded by pr:wait's own budget (npm-run's rationale), and giving it
  // no class at all would make it the first spawnStep call site in this codebase that classifyCommand
  // resolves to null -- the ALLOWLIST entry for 'command-timed-out' in
  // test/park-reason-doc-sweep.test.js explicitly claims that never happens ("every [spawnStep call
  // site] passes 'git', 'gh', or 'npm'... classifyCommand always returns a real class... never
  // null") -- a claim this would silently falsify. Matched on the exact script path, not bare
  // `command === 'bash'`, so any OTHER future use of `bash` in this codebase still falls through to
  // "no class default" rather than being silently absorbed into a budget sized for THIS script.
  if (command === 'bash' && typeof args[0] === 'string' && args[0].endsWith('/scripts/bench-install.sh')) {
    return 'bench-install';
  }
  return null;
}

// classTimeoutMs(config, commandClass) -- the one place a class name becomes a millisecond value.
// Tolerates a missing/older config object (no commandTimeoutsMs field, or no config at all) rather
// than throwing: several call sites in this codebase's own test suite pass a bare `{ghRepo: ...}`
// fixture, or no config argument at all, and "no class default" is the correct, pre-existing
// behaviour for those, not a crash.
//
// The same tolerance has to extend to the VALUE, not just the table: config.js builds every entry
// as `Number(process.env.SPO_TIMEOUT_*_MS)`, so a misconfigured override (`SPO_TIMEOUT_GH_MS=2min`,
// `=10m`, any non-numeric paste) yields NaN -- and Node's spawnSync VALIDATES its `timeout` option,
// THROWING `ERR_OUT_OF_RANGE` ("must be an unsigned integer") before it ever spawns. Handing that
// value straight through would put a synchronous throw inside board.js's moveCard and
// park-loop.js's postParkComment, both of which are documented "never throws" and both of which
// run inside state-machine.js's finalizePark -- i.e. exactly the crash-loop shape (task never
// reaches PARKED -> daemon exits -> orphanScan reparks through the same path) this action exists
// to prevent. A malformed override therefore degrades to "no class default", identical to an
// unconfigured class, instead of crashing the daemon on its first board move.
function classTimeoutMs(config, commandClass) {
  if (!commandClass) return undefined;
  const table = config && config.commandTimeoutsMs;
  const value = table ? table[commandClass] : undefined;
  // `Number.isInteger` (not just isFinite) because spawnSync rejects a fractional timeout with the
  // very same ERR_OUT_OF_RANGE -- `SPO_TIMEOUT_GH_MS=1.5` is as fatal as `=2min`.
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

// isSpawnTimeout(result, deadlineArmed) -- true only when spawnSync's OWN `timeout` option (never
// an operator's kill -9, an OOM kill, or any other external signal) is what ended the child. A
// timeout kill sets BOTH `result.signal` (the kill signal, SIGTERM here) AND `result.error` (an
// Error with `.code === 'ETIMEDOUT'`) -- see steps/scripted.js's spawnOnce for the fuller trap
// explanation (card #449, learned the hard way by steps/llm.js's invokeClaudeReal first).
// `deadlineArmed` (was a numeric `timeout` actually passed to spawnSync for THIS call?) is what
// tells that apart from a bare signalled child with no deadline armed at all.
function isSpawnTimeout(result, deadlineArmed) {
  return !!(deadlineArmed && result && ((result.error && result.error.code === 'ETIMEDOUT') || result.signal));
}

// armTimeout(deps, config, command, args, opts) -- spawns `command` with `args`, arming
// classifyCommand's class default (config.commandTimeoutsMs) as spawnSync's own `timeout` option
// unless the caller's own `opts.timeout` is already a number (explicit always wins) -- and
// attaches `timedOut` / `commandClass` / `timeoutMs` onto the returned result so a caller can
// journal a hang distinguishably from a plain non-zero exit without re-deriving any of this
// itself. `deps.spawnSync` is the test injection point, same convention as every caller's own
// pre-existing runSync -- production code never passes it.
//
// Deliberately does NOT retry and does NOT throw on a timeout (unlike steps/scripted.js's
// spawnStep): that retry-once-then-ParkSignal policy is specific to spawnStep's task-scoped,
// mid-step call sites, where a park is the only way to stop a stuck task. The four callers of
// this function are either best-effort side-effects that must never block their caller
// (board.js's moveCard, park-loop.js's postParkComment) or daemon-loop scans with no task to park
// at all (park-loop.js's unparkScan, report-intake.js, intake.js) -- see each caller's own header
// for why a retry here buys nothing and doubles the exposure instead.
function armTimeout(deps, config, command, args, opts = {}) {
  const spawnSyncFn = (deps && deps.spawnSync) || spawnSync;
  const commandClass = classifyCommand(command, args);
  const timeoutMs = opts.timeout !== undefined ? opts.timeout : classTimeoutMs(config, commandClass);
  const spawnOpts =
    timeoutMs === undefined
      ? { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }
      : { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts, timeout: timeoutMs };
  const deadlineArmed = typeof spawnOpts.timeout === 'number';

  const result = spawnSyncFn(command, args, spawnOpts);
  result.commandClass = commandClass;
  result.timeoutMs = deadlineArmed ? timeoutMs : null;
  result.timedOut = isSpawnTimeout(result, deadlineArmed);
  return result;
}

module.exports = { classifyCommand, classTimeoutMs, isSpawnTimeout, armTimeout };
