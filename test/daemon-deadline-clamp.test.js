'use strict';
// Card SPO-Pipeline#259: the daemon's EFFECTIVE stepDeadlineMsByState -- the one deadline.js
// actually races, after daemon.js's main() recomputes WORKTREE/FINISH for `--workers` -- must be a
// delay Node's setTimeout honours as written, under any SPO_TIMEOUT_*, poll-count or poll-interval
// override and at any K. Past 2^31-1 ms Node clamps the delay to 1ms, so the deadline fires on the
// step's first `await` and re-runs the step while the first run continues.
//
// Measured on main before the fix, through this file's own harness:
//   SPO_TIMEOUT_GIT_MS=200000000                          -> daemon FINISH 2801260000, WORKTREE 10802700000
//   SPO_BENCH_IDLE_WAIT_MAX_POLLS=428908 + --workers 2    -> daemon FINISH 2165600000 (config's 2147480000)
//   SPO_TIMEOUT_NPM_CI_MS=2000000000                      -> WORKTREE 4007980000 (config's too)
// and five per-cycle limits passed `-5` / `Infinity` / `1.5` straight through.
//
// WHY A REAL CHILD PER CASE: daemon.js runs main() unconditionally, so it cannot be required, and
// config.js reads process.env at require time. A copy of the recompute would pass even if main()
// stopped calling it. So every case below spawns the real `node orchestrator/daemon.js --dry-run
// --once --workers K` with a `--require` preload that swaps state-machine.js's drainQueueOnce --
// the first thing main() hands its finished config to -- for a stub that prints that config and
// exits. Same preload idiom as test/worker-mode.test.js's runCrashingWorker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
// Installed before any orchestrator require -- see test/no-real-spawn.js.
require('./no-real-spawn');
const productRepoHold = require('../orchestrator/product-repo-hold.js');
const { DAEMON, mkTmp, isolatedEnv } = require('./helpers');

const REPO = path.join(__dirname, '..');
const CONFIG_PATH = require.resolve('../orchestrator/config.js');
const MAX_TIMER_DELAY_MS = 2147483647; // 2^31 - 1, Node's signed-32-bit timer ceiling
const WORKER_COUNTS = [1, 2, 3];

// The five values the card names, plus each variable's own ceiling -1 / exact / +1 (added per row).
const BAD = ['abc', '0', '-5', '1.5', 'Infinity', '1e10'];

// Every env var that feeds a stepDeadlineMsByState entry. A timeout has no ceiling of its own
// (timeoutFromEnv), so its "ceiling" is the timer ceiling itself: an override at, just under and
// just over 2^31-1 must still leave every derived entry honoured.
const TIMEOUT_VARS = [
  'SPO_TIMEOUT_GIT_MS',
  'SPO_TIMEOUT_GH_MS',
  'SPO_TIMEOUT_NPM_CI_MS',
  'SPO_TIMEOUT_NPM_GATE_MS',
  'SPO_TIMEOUT_NPM_RUN_MS',
  'SPO_TIMEOUT_BENCH_INSTALL_MS',
];
const INTERVAL_VARS = [
  'SPO_CI_CHECKS_POLL_INTERVAL_MS',
  'SPO_BENCH_IDLE_WAIT_POLL_INTERVAL_MS',
  'SPO_GATE_DIED_RECOVERY_POLL_INTERVAL_MS',
];
const POLL_COUNT_VARS = ['SPO_CI_CHECKS_MAX_POLLS', 'SPO_BENCH_IDLE_WAIT_MAX_POLLS', 'SPO_GATE_DIED_RECOVERY_MAX_POLLS'];

// The five limits card #259 put through boundedPositiveIntFromEnv, with the ceiling config.js
// states at each field. Every value outside [1, ceiling] must resolve to the default.
const LIMITS = [
  { env: 'SPO_AUTO_INTAKE_LIMIT', field: 'autoIntakeLimit', defaultN: 3, ceiling: 100 },
  { env: 'SPO_AUTO_TRIAGE_LIMIT', field: 'autoTriageLimit', defaultN: 3, ceiling: 100 },
  { env: 'SPO_REMOTE_REPORT_PULL_LIMIT', field: 'remoteReportPullLimit', defaultN: 5, ceiling: 100 },
  { env: 'SPO_REMOTE_REPORT_MAX_BYTES', field: 'remoteReportMaxBytes', defaultN: 4 * 1024 * 1024, ceiling: 64 * 1024 * 1024 },
  { env: 'SPO_REMOTE_REPORT_QUEUE_CEILING', field: 'remoteReportQueueCeiling', defaultN: 50, ceiling: 1000 },
];

// Every variable this file sets, plus SPO_WORKERS: stripped from the inherited environment so a
// maintainer shell or CI runner that exports one cannot move a baseline.
const SWEPT_VARS = [...TIMEOUT_VARS, ...INTERVAL_VARS, ...POLL_COUNT_VARS, ...LIMITS.map((l) => l.env), 'SPO_WORKERS'];

// config.js at the default environment, loaded in-process only to derive each poll count's own
// ceiling (the SAME formulas config.js uses -- see test/poll-count-guards.test.js for the ceiling
// tests themselves). Never used as an expected deadline value: those come from the daemon.
function loadDefaultConfig() {
  const saved = new Map(SWEPT_VARS.map((k) => [k, process.env[k]]));
  for (const k of SWEPT_VARS) delete process.env[k];
  delete require.cache[CONFIG_PATH];
  try {
    return require(CONFIG_PATH);
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    delete require.cache[CONFIG_PATH];
  }
}

function pollCountCeilings(d) {
  const finishWithoutWait = productRepoHold.finishStepDeadlineMs(d.commandTimeoutsMs, d.workers, d.stepDeadlineMs, 0);
  return {
    SPO_CI_CHECKS_MAX_POLLS: Math.floor((MAX_TIMER_DELAY_MS - d.stepDeadlineMs) / d.ciChecksPollIntervalMs),
    SPO_BENCH_IDLE_WAIT_MAX_POLLS: Math.floor((MAX_TIMER_DELAY_MS - finishWithoutWait) / d.benchIdleWaitPollIntervalMs),
    SPO_GATE_DIED_RECOVERY_MAX_POLLS: Math.floor(
      (MAX_TIMER_DELAY_MS - d.commandTimeoutsMs['npm-gate'] - d.stepDeadlineMs) / d.gateDiedRecoveryPollIntervalMs
    ),
  };
}

function aroundCeiling(ceiling) {
  return [String(ceiling - 1), String(ceiling), String(ceiling + 1)];
}

let preloadPath = null;
function preload() {
  if (preloadPath) return preloadPath;
  preloadPath = path.join(mkTmp('spo-deadline-clamp-preload-'), 'capture.js');
  const orchestrator = path.join(REPO, 'orchestrator');
  const fields = ['workers', ...LIMITS.map((l) => l.field)];
  fs.writeFileSync(
    preloadPath,
    [
      // daemon.js's own first line, run first here too: the preload requires state-machine.js
      // (and so command-timeout.js) ahead of daemon.js, and must not load it unguarded.
      `require(${JSON.stringify(path.join(orchestrator, 'no-real-spawn-guard.js'))}).installGuard();`,
      `const sm = require(${JSON.stringify(path.join(orchestrator, 'state-machine.js'))});`,
      `sm.drainQueueOnce = async (_queueDir, _journalRoot, config) => {`,
      `  const out = { stepDeadlineMsByState: config.stepDeadlineMsByState };`,
      `  for (const f of ${JSON.stringify(fields)}) out[f] = config[f];`,
      // Non-finite numbers would serialize as null and hide the very value under test.
      `  const json = JSON.stringify(out, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? 'NONFINITE:' + v : v));`,
      `  process.stdout.write('DEADLINE-CAPTURE ' + json + '\\n');`,
      `  process.exit(0);`,
      `};`,
      ``,
    ].join('\n')
  );
  return preloadPath;
}

// Runs the real daemon once at `--workers <workers>` under `overrides` and returns the config
// main() handed to drainQueueOnce.
function captureDaemonConfig(workers, overrides) {
  const captureEnv = { ...isolatedEnv(), NODE_OPTIONS: `--require ${preload()}` };
  for (const k of SWEPT_VARS) delete captureEnv[k];
  Object.assign(captureEnv, overrides);
  const argv = [DAEMON, '--dry-run', '--once', '--workers', String(workers)];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, argv, { env: captureEnv, encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => {
      const line = String(stdout || '')
        .split('\n')
        .find((l) => l.startsWith('DEADLINE-CAPTURE '));
      if (!line) {
        reject(new Error(`no capture from daemon.js (--workers ${workers}, ${JSON.stringify(overrides)}): ${err ? err.message : ''}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line.slice('DEADLINE-CAPTURE '.length)));
    });
  });
}

// Bounded concurrency: hundreds of short children, never all at once.
async function captureAll(cases) {
  const limit = Math.max(2, Math.min(6, os.cpus().length));
  const results = new Array(cases.length);
  let next = 0;
  async function lane() {
    while (next < cases.length) {
      const i = next++;
      results[i] = await captureDaemonConfig(cases[i].workers, cases[i].overrides);
    }
  }
  await Promise.all(Array.from({ length: limit }, lane));
  return results;
}

function describe(c) {
  return `--workers ${c.workers} ${JSON.stringify(c.overrides)}`;
}

function assertHonouredDeadlines(captured, label, expectedStates) {
  const byState = captured.stepDeadlineMsByState;
  assert.deepEqual(Object.keys(byState).sort(), expectedStates, `${label}: unexpected stepDeadlineMsByState keys`);
  for (const [state, ms] of Object.entries(byState)) {
    assert.ok(Number.isInteger(ms), `${label}: ${state} = ${ms} is not a finite integer`);
    assert.ok(ms > 0, `${label}: ${state} = ${ms} is not positive`);
    assert.ok(ms <= MAX_TIMER_DELAY_MS, `${label}: ${state} = ${ms} is past 2^31-1, which Node runs as 1ms`);
  }
}

const DEFAULTS = loadDefaultConfig();
const EXPECTED_STATES = Object.keys(DEFAULTS.stepDeadlineMsByState).sort();

test('defaults: the daemon at K = 1, 2, 3 keeps the documented WORKTREE/FINISH deadlines and every other entry exactly as config.js derives it', { timeout: 120000 }, async () => {
  // Pinned by value (measured on main, 3666821, before card #259): the fix must not move a single
  // default. K=1 is config.js's own derivation; K=2/3 are the --workers recompute.
  const EXPECTED = {
    1: { WORKTREE: 9180000, FINISH: 3840000 },
    2: { WORKTREE: 18240000, FINISH: 21960000 },
    3: { WORKTREE: 27300000, FINISH: 40080000 },
  };
  const cases = WORKER_COUNTS.map((workers) => ({ workers, overrides: {} }));
  const results = await captureAll(cases);
  results.forEach((captured, i) => {
    const k = cases[i].workers;
    assert.equal(captured.workers, k);
    assert.deepEqual(
      captured.stepDeadlineMsByState,
      { ...DEFAULTS.stepDeadlineMsByState, ...EXPECTED[k] },
      `--workers ${k}: only WORKTREE/FINISH may move with K, and only to their documented values`
    );
  });
});

test("the issue's three reproducers now hold at exactly 2^31-1 in the daemon's effective deadlines", { timeout: 120000 }, async () => {
  const cases = [
    { workers: 1, overrides: { SPO_TIMEOUT_GIT_MS: '200000000' }, clamped: ['WORKTREE', 'FINISH'] },
    // 428908 is the bench-idle ceiling sized at the env-time K=1; --workers 2 pushes the unclamped
    // FINISH to 2165600000.
    { workers: 2, overrides: { SPO_BENCH_IDLE_WAIT_MAX_POLLS: '428908' }, clamped: ['FINISH'] },
    { workers: 1, overrides: { SPO_TIMEOUT_NPM_CI_MS: '2000000000' }, clamped: ['WORKTREE'] },
  ];
  assert.equal(pollCountCeilings(DEFAULTS).SPO_BENCH_IDLE_WAIT_MAX_POLLS, 428908, 'the reproducer must sit exactly at the K=1 ceiling');
  const results = await captureAll(cases);
  results.forEach((captured, i) => {
    const label = describe(cases[i]);
    assertHonouredDeadlines(captured, label, EXPECTED_STATES);
    for (const state of cases[i].clamped) {
      assert.equal(captured.stepDeadlineMsByState[state], MAX_TIMER_DELAY_MS, `${label}: ${state} must be clamped to 2^31-1`);
    }
  });
});

test('sweep: under every bad, boundary or oversized SPO_TIMEOUT_*, poll-interval and poll-count override, the daemon effective stepDeadlineMsByState is a finite integer in (0, 2^31-1] at K = 1, 2, 3', { timeout: 600000 }, async () => {
  const ceilings = pollCountCeilings(DEFAULTS);
  const rows = [
    ...TIMEOUT_VARS.map((env) => ({ env, values: [...BAD, ...aroundCeiling(MAX_TIMER_DELAY_MS)] })),
    ...INTERVAL_VARS.map((env) => ({ env, values: [...BAD, ...aroundCeiling(MAX_TIMER_DELAY_MS)] })),
    ...POLL_COUNT_VARS.map((env) => ({ env, values: [...BAD, ...aroundCeiling(ceilings[env])] })),
  ];
  const cases = [];
  for (const { env, values } of rows) {
    for (const value of values) {
      for (const workers of WORKER_COUNTS) cases.push({ workers, overrides: { [env]: value } });
    }
  }
  assert.equal(cases.length, (TIMEOUT_VARS.length + INTERVAL_VARS.length + POLL_COUNT_VARS.length) * 9 * 3);
  const results = await captureAll(cases);
  results.forEach((captured, i) => {
    assertHonouredDeadlines(captured, describe(cases[i]), EXPECTED_STATES);
    assert.equal(captured.workers, cases[i].workers, `${describe(cases[i])}: --workers must be the effective K`);
  });
});

test('limits: every bad or oversized override of the five per-cycle limits falls back to its default, and [1, ceiling] passes through', { timeout: 300000 }, async () => {
  const cases = [];
  for (const limit of LIMITS) {
    for (const value of [...BAD, '', ...aroundCeiling(limit.ceiling)]) {
      const n = Number(value);
      const accepted = value !== '' && Number.isInteger(n) && n >= 1 && n <= limit.ceiling;
      cases.push({ workers: 1, overrides: { [limit.env]: value }, limit, expected: accepted ? n : limit.defaultN });
    }
    cases.push({ workers: 1, overrides: { [limit.env]: '1' }, limit, expected: 1 });
  }
  const results = await captureAll(cases);
  results.forEach((captured, i) => {
    const { limit, expected } = cases[i];
    assert.equal(captured[limit.field], expected, `${describe(cases[i])}: ${limit.field}`);
  });
  // Unset: the documented default, for each.
  const unset = await captureDaemonConfig(1, {});
  for (const limit of LIMITS) assert.equal(unset[limit.field], limit.defaultN, `${limit.env} unset`);
});
