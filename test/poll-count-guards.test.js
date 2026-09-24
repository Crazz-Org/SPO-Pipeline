'use strict';
// Card #225: SPO_CI_CHECKS_MAX_POLLS and SPO_BENCH_IDLE_WAIT_MAX_POLLS -- the two poll counts that
// orchestrator/config.js folds into a `stepDeadlineMsByState` entry (CI_CHECKS directly, FINISH
// through benchIdleWaitMaxMs) -- used to be parsed with a bare `Number(process.env.X)`. `abc` gave
// NaN (realCiChecks' poll loop never ran and the empty check list read as green; waitForBenchIdle
// never waited), and `Infinity`/`1e10` pushed the derived deadline past 2^31-1 ms, which Node
// clamps to 1ms -- re-running the step while the first run is still going. Both now go through
// the SAME guard card #211 gave SPO_GATE_DIED_RECOVERY_MAX_POLLS (`boundedPositiveIntFromEnv`
// plus an outer re-clamp to a derived ceiling); that one's own tests live in
// test/real-steps.test.js, next to the GATE entry.
//
// config.js reads process.env at REQUIRE time, so `loadConfigWith` below re-requires it with the
// env mutated first and restores the env (and the require cache) afterwards, the same idiom
// test/env-timer-guards.test.js and test/real-steps.test.js already use.

const test = require('node:test');
const assert = require('node:assert/strict');
// Installed before any orchestrator require -- see test/no-real-spawn.js (config.js spawns nothing,
// but the sweep that enforces this ordering does not special-case it).
require('./no-real-spawn');
const productRepoHold = require('../orchestrator/product-repo-hold.js');

const CONFIG_PATH = require.resolve('../orchestrator/config.js');
const MAX_TIMER_DELAY_MS = 2147483647; // 2^31 - 1, the signed-32-bit timer ceiling of Node

// The five values the card names, plus the two shapes a positive-integer guard has to reject on
// its own: a fraction, and the empty string (`Number('')` is 0).
const MALFORMED = ['abc', 'Infinity', '1e10', '0', '-5', '2.5', ''];

const VARS = [
  { env: `SPO_CI_CHECKS_MAX_POLLS`, field: `ciChecksMaxPolls`, defaultN: 30 },
  { env: `SPO_BENCH_IDLE_WAIT_MAX_POLLS`, field: `benchIdleWaitMaxPolls`, defaultN: 180 },
];

function loadConfigWith(envMap) {
  const previous = new Map();
  for (const key of Object.keys(envMap)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (envMap[key] === undefined) delete process.env[key];
    else process.env[key] = envMap[key];
  }
  delete require.cache[CONFIG_PATH];
  try {
    return require(CONFIG_PATH);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[CONFIG_PATH];
  }
}

// deadline.js hands every entry to a real setTimeout, so each must be a delay Node honours as
// written: a finite positive integer at or under the 2^31-1 ceiling.
function assertEveryDeadlineIsAnHonouredTimerDelay(config, label) {
  const entries = Object.entries(config.stepDeadlineMsByState);
  assert.ok(entries.length > 0, `${label}: stepDeadlineMsByState is empty`);
  for (const [state, ms] of entries) {
    assert.ok(Number.isInteger(ms), `${label}: stepDeadlineMsByState.${state} = ${ms} is not a finite integer`);
    assert.ok(ms > 0, `${label}: stepDeadlineMsByState.${state} = ${ms} is not positive`);
    assert.ok(ms <= MAX_TIMER_DELAY_MS, `${label}: stepDeadlineMsByState.${state} = ${ms} is past 2^31-1`);
  }
}

test(`poll counts: unset resolves to the documented default, a valid override passes through`, () => {
  for (const { env, field, defaultN } of VARS) {
    assert.equal(loadConfigWith({ [env]: undefined })[field], defaultN, `${env} unset`);
    assert.equal(loadConfigWith({ [env]: `7` })[field], 7, `${env}=7 must be honoured, the guard rejects only bad values`);
  }
});

test(`SPO_CI_CHECKS_MAX_POLLS: every malformed or oversized override falls back to 30, and the CI_CHECKS deadline is the default one`, () => {
  const baseline = loadConfigWith({ SPO_CI_CHECKS_MAX_POLLS: undefined });
  for (const value of MALFORMED) {
    const config = loadConfigWith({ SPO_CI_CHECKS_MAX_POLLS: value });
    assert.equal(config.ciChecksMaxPolls, 30, `SPO_CI_CHECKS_MAX_POLLS=${JSON.stringify(value)} must fall back to 30`);
    assert.equal(
      config.stepDeadlineMsByState.CI_CHECKS,
      baseline.stepDeadlineMsByState.CI_CHECKS,
      `SPO_CI_CHECKS_MAX_POLLS=${JSON.stringify(value)} must leave the CI_CHECKS deadline at its default`
    );
  }
  assert.equal(baseline.stepDeadlineMsByState.CI_CHECKS, 30 * 20000 + 120000, `documented default: 30 x 20s + 120s margin`);
});

test(`SPO_BENCH_IDLE_WAIT_MAX_POLLS: every malformed or oversized override falls back to 180, and benchIdleWaitMaxMs and the FINISH deadline are the default ones`, () => {
  const baseline = loadConfigWith({ SPO_BENCH_IDLE_WAIT_MAX_POLLS: undefined });
  for (const value of MALFORMED) {
    const config = loadConfigWith({ SPO_BENCH_IDLE_WAIT_MAX_POLLS: value });
    assert.equal(config.benchIdleWaitMaxPolls, 180, `SPO_BENCH_IDLE_WAIT_MAX_POLLS=${JSON.stringify(value)} must fall back to 180`);
    assert.equal(config.benchIdleWaitMaxMs, 900000, `SPO_BENCH_IDLE_WAIT_MAX_POLLS=${JSON.stringify(value)} must leave the wait at 180 x 5s`);
    assert.equal(
      config.stepDeadlineMsByState.FINISH,
      baseline.stepDeadlineMsByState.FINISH,
      `SPO_BENCH_IDLE_WAIT_MAX_POLLS=${JSON.stringify(value)} must leave the FINISH deadline at its default`
    );
  }
});

test(`sweep: under every malformed value of either poll count (alone and both at once), every stepDeadlineMsByState entry is a finite integer in (0, 2^31-1]`, () => {
  assertEveryDeadlineIsAnHonouredTimerDelay(loadConfigWith({}), `defaults`);
  for (const value of MALFORMED) {
    for (const { env } of VARS) {
      assertEveryDeadlineIsAnHonouredTimerDelay(loadConfigWith({ [env]: value }), `${env}=${JSON.stringify(value)}`);
    }
    const both = Object.fromEntries(VARS.map(({ env }) => [env, value]));
    assertEveryDeadlineIsAnHonouredTimerDelay(loadConfigWith(both), `both=${JSON.stringify(value)}`);
  }
});

// Where the boundary sits, computed from the resolved config values through the SAME formula each
// deadline entry uses -- never a bare floor(2^31-1 / interval). The ceiling itself must be
// ACCEPTED (a `>=` where `>` belongs fails here) and ceiling + 1 must fall back (a ceiling formula
// that drops a term, and so computes something larger than the real one, fails here).
test(`SPO_CI_CHECKS_MAX_POLLS: the exact computed ceiling is accepted and keeps CI_CHECKS <= 2^31-1, ceiling + 1 falls back to 30`, () => {
  const defaults = loadConfigWith({});
  const ceiling = Math.floor((MAX_TIMER_DELAY_MS - defaults.stepDeadlineMs) / defaults.ciChecksPollIntervalMs);

  const atCeiling = loadConfigWith({ SPO_CI_CHECKS_MAX_POLLS: String(ceiling) });
  assert.equal(atCeiling.ciChecksMaxPolls, ceiling);
  assert.equal(atCeiling.stepDeadlineMsByState.CI_CHECKS, ceiling * defaults.ciChecksPollIntervalMs + defaults.stepDeadlineMs);
  assertEveryDeadlineIsAnHonouredTimerDelay(atCeiling, `CI_CHECKS at ceiling`);

  const pastCeiling = loadConfigWith({ SPO_CI_CHECKS_MAX_POLLS: String(ceiling + 1) });
  assert.equal(pastCeiling.ciChecksMaxPolls, 30);
});

test(`SPO_BENCH_IDLE_WAIT_MAX_POLLS: the exact computed ceiling is accepted and keeps FINISH <= 2^31-1, ceiling + 1 falls back to 180`, () => {
  const defaults = loadConfigWith({});
  const finishWithoutWait = productRepoHold.finishStepDeadlineMs(defaults.commandTimeoutsMs, defaults.workers, defaults.stepDeadlineMs, 0);
  const ceiling = Math.floor((MAX_TIMER_DELAY_MS - finishWithoutWait) / defaults.benchIdleWaitPollIntervalMs);

  const atCeiling = loadConfigWith({ SPO_BENCH_IDLE_WAIT_MAX_POLLS: String(ceiling) });
  assert.equal(atCeiling.benchIdleWaitMaxPolls, ceiling);
  assert.equal(atCeiling.stepDeadlineMsByState.FINISH, finishWithoutWait + ceiling * defaults.benchIdleWaitPollIntervalMs);
  assertEveryDeadlineIsAnHonouredTimerDelay(atCeiling, `FINISH at ceiling`);

  const pastCeiling = loadConfigWith({ SPO_BENCH_IDLE_WAIT_MAX_POLLS: String(ceiling + 1) });
  assert.equal(pastCeiling.benchIdleWaitMaxPolls, 180);
});

// The ceiling check inside boundedPositiveIntFromEnv only fires on an explicit poll-count override;
// an oversized poll INTERVAL, or an SPO_TIMEOUT_*_MS, can overflow the same deadline with the
// count untouched. The outer re-clamp absorbs that into the count, and the final clamp on the
// entry covers what the count alone cannot.
test(`residual overflow: an oversized poll interval or command timeout alone still yields an honoured CI_CHECKS/FINISH deadline`, () => {
  const ciInterval = loadConfigWith({ SPO_CI_CHECKS_POLL_INTERVAL_MS: `1e8` });
  assert.ok(ciInterval.ciChecksMaxPolls < 30 && ciInterval.ciChecksMaxPolls >= 1, `the count absorbs a 1e8ms interval: ${ciInterval.ciChecksMaxPolls}`);
  assertEveryDeadlineIsAnHonouredTimerDelay(ciInterval, `SPO_CI_CHECKS_POLL_INTERVAL_MS=1e8`);

  // Past the ceiling by itself: the count floors at 1, never 0 (0 polls never fetches and reads
  // as green), and the CI_CHECKS entry is clamped to exactly the ceiling.
  const ciHuge = loadConfigWith({ SPO_CI_CHECKS_POLL_INTERVAL_MS: `1e12` });
  assert.equal(ciHuge.ciChecksMaxPolls, 1);
  assert.equal(ciHuge.stepDeadlineMsByState.CI_CHECKS, MAX_TIMER_DELAY_MS);
  assertEveryDeadlineIsAnHonouredTimerDelay(ciHuge, `SPO_CI_CHECKS_POLL_INTERVAL_MS=1e12`);

  const benchInterval = loadConfigWith({ SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS: `1e8` });
  assert.ok(benchInterval.benchIdleWaitMaxPolls < 180, `the count absorbs a 1e8ms interval: ${benchInterval.benchIdleWaitMaxPolls}`);
  assertEveryDeadlineIsAnHonouredTimerDelay(benchInterval, `SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS=1e8`);

  const benchHuge = loadConfigWith({ SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS: `1e12` });
  assert.equal(benchHuge.benchIdleWaitMaxPolls, 0, `zero polls, never negative, when not even one fits`);
  assertEveryDeadlineIsAnHonouredTimerDelay(benchHuge, `SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS=1e12`);

  // A command timeout that overflows FINISH by itself: nothing upstream can shrink, so the final
  // clamp on the entry is what holds.
  const benchInstallHuge = loadConfigWith({ SPO_TIMEOUT_BENCH_INSTALL_MS: `3000000000` });
  assert.equal(benchInstallHuge.benchIdleWaitMaxPolls, 0);
  assert.equal(benchInstallHuge.stepDeadlineMsByState.FINISH, MAX_TIMER_DELAY_MS);
});

// Production runs K=2 (SPO_WORKERS=2 on the live systemd drop-in), and daemon.js re-derives FINISH
// through productRepoHold.finishStepDeadlineMs with NO final clamp (daemon.js, the FINISH entry of
// its stepDeadlineMsByState recompute: commandTimeoutsMs, effectiveWorkers, stepDeadlineMs,
// benchIdleWaitMaxMs -- effectiveWorkers is config.workers when no --workers flag is passed). So
// the bench ceiling must be sized at the resolved K, not at K=1: a ceiling computed at K=1 is
// hidden from every config-level test above by the FINISH entry clamp in config.js, yet lets the
// daemon FINISH deadline past 2^31-1 at K=2. This mirrors the daemon call exactly, unclamped.
test(`SPO_BENCH_IDLE_WAIT_MAX_POLLS under SPO_WORKERS=2: at the K=2 ceiling the daemon-side (unclamped) FINISH stays <= 2^31-1, ceiling + 1 falls back to 180`, () => {
  const daemonFinish = (config) =>
    productRepoHold.finishStepDeadlineMs(config.commandTimeoutsMs, config.workers, config.stepDeadlineMs, config.benchIdleWaitMaxMs);

  const defaults = loadConfigWith({ SPO_WORKERS: `2`, SPO_BENCH_IDLE_WAIT_MAX_POLLS: undefined });
  assert.equal(defaults.workers, 2);
  const finishWithoutWait = productRepoHold.finishStepDeadlineMs(defaults.commandTimeoutsMs, 2, defaults.stepDeadlineMs, 0);
  const ceiling = Math.floor((MAX_TIMER_DELAY_MS - finishWithoutWait) / defaults.benchIdleWaitPollIntervalMs);

  const atCeiling = loadConfigWith({ SPO_WORKERS: `2`, SPO_BENCH_IDLE_WAIT_MAX_POLLS: String(ceiling) });
  assert.equal(atCeiling.benchIdleWaitMaxPolls, ceiling, `the K=2 ceiling itself must be accepted`);
  const unclamped = daemonFinish(atCeiling);
  assert.ok(Number.isInteger(unclamped) && unclamped <= MAX_TIMER_DELAY_MS, `daemon-side FINISH at the K=2 ceiling is ${unclamped}, past 2^31-1`);
  assert.equal(atCeiling.stepDeadlineMsByState.FINISH, unclamped, `config FINISH must equal the daemon recompute, the clamp never engaged`);

  const pastCeiling = loadConfigWith({ SPO_WORKERS: `2`, SPO_BENCH_IDLE_WAIT_MAX_POLLS: String(ceiling + 1) });
  assert.equal(pastCeiling.benchIdleWaitMaxPolls, 180, `the K=2 ceiling + 1 must fall back to 180`);
  assert.ok(daemonFinish(pastCeiling) <= MAX_TIMER_DELAY_MS);
});
