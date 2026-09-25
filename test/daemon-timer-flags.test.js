'use strict';
// Card SPO-Pipeline#271: daemon.js's --deadline-ms and --interval-ms each become ONE timer delay
// (deadline.js's withTimeout for CHECK/PUSH_PR, the dispatcher's and scanner's poll sleep). Node
// runs a delay outside [1, 2^31-1] as 1ms. Both flags used to be `parseInt(...) || default`.
//
// Measured on main (6a63444) before the fix, with this file's own preload, which arms deadline.js's
// real withTimeout at the CHECK deadline around a 300ms step:
//   --deadline-ms 3000000000 / 2147483648 -> CHECK deadline stays oversized, DeadlineError after 2ms
//                                            (plus a TimeoutOverflowWarning)
//   --deadline-ms -1                      -> DeadlineError after 0ms, no warning at all
//   --deadline-ms 1.5 / 1e10              -> parseInt gives 1: DeadlineError after 2ms
//   --interval-ms -1 / 1.5 / 1e10 / 3000000000 -> the poll timer fires in 2-4ms, not 5000
//   abc / 0 / Infinity                    -> the default, in silence
// The dispatcher then re-forwards that value to every worker (dispatcher.js's buildWorkerArgv).
//
// WHY A REAL CHILD PER CASE: daemon.js runs main() on require, so the only honest test is the real
// process. Same `--require` preload idiom as test/daemon-deadline-clamp.test.js: state-machine.js's
// drainQueueOnce -- the first thing main() hands its finished config to under --once -- is swapped
// for a stub that prints what the timers would receive and exits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
// Installed before any orchestrator require -- see test/no-real-spawn.js.
require('./no-real-spawn');
const config = require('../orchestrator/config');
const { DAEMON, mkTmp, isolatedEnv, readState } = require('./helpers');
const { lockPath } = require('../orchestrator/lock');

const REPO = path.join(__dirname, '..');
const MAX_TIMER_DELAY_MS = 2147483647; // 2^31 - 1, stated here rather than read from config.js
const FLAGS = [
  { flag: '--deadline-ms', field: 'stepDeadlineMs' },
  { flag: '--interval-ms', field: 'pollIntervalMs' },
];
// The card's five, plus the ceiling +1, the two values `|| default` used to swallow in silence, and
// an empty string.
const BAD = ['abc', '-1', '1.5', 'Infinity', '3000000000', '2147483648', '0', '1e10', ''];
const VALID = ['1', '15', '5000', '120000', String(MAX_TIMER_DELAY_MS)];

let preloadPath = null;
function preload() {
  if (preloadPath) return preloadPath;
  preloadPath = path.join(mkTmp('spo-timer-flags-preload-'), 'capture.js');
  const orchestrator = path.join(REPO, 'orchestrator');
  fs.writeFileSync(
    preloadPath,
    [
      `require(${JSON.stringify(path.join(orchestrator, 'no-real-spawn-guard.js'))}).installGuard();`,
      `const sm = require(${JSON.stringify(path.join(orchestrator, 'state-machine.js'))});`,
      `const { deadlineMsFor } = require(${JSON.stringify(path.join(orchestrator, 'deadline.js'))});`,
      `const { buildWorkerArgv } = require(${JSON.stringify(path.join(orchestrator, 'dispatcher.js'))});`,
      `sm.drainQueueOnce = async (_queueDir, _journalRoot, config) => {`,
      `  const out = {`,
      `    stepDeadlineMs: config.stepDeadlineMs,`,
      `    pollIntervalMs: config.pollIntervalMs,`,
      `    CHECK: deadlineMsFor(config, 'CHECK'),`,
      `    PUSH_PR: deadlineMsFor(config, 'PUSH_PR'),`,
      `    workerArgv: buildWorkerArgv('<taskDir>', '<queue>', '<journal>', config),`,
      `  };`,
      // A non-finite number would serialize as null and hide the value under test; a string must
      // stay distinguishable from the number it spells.
      `  const json = JSON.stringify(out, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? 'NONFINITE:' + v : v));`,
      `  process.stdout.write('TIMER-CAPTURE ' + json + '\\n');`,
      `  process.exit(0);`,
      `};`,
      ``,
    ].join('\n')
  );
  return preloadPath;
}

// The one real child this file spawns. `timeout` is load-bearing: a mutant that stops refusing a
// bad value in continuous mode boots a polling dispatcher that never exits on its own.
function runDaemon(args, { capture = false, timeout = 60000 } = {}) {
  const env = capture ? { ...isolatedEnv(), NODE_OPTIONS: `--require ${preload()}` } : isolatedEnv();
  return new Promise((resolve) => {
    execFile(process.execPath, [DAEMON, ...args], { env, encoding: 'utf8', timeout }, (err, stdout, stderr) => {
      const status = err ? (err.killed ? `timed-out(${err.signal})` : err.code) : 0;
      const line = String(stdout || '')
        .split('\n')
        .find((l) => l.startsWith('TIMER-CAPTURE '));
      resolve({ status, stdout, stderr, captured: line ? JSON.parse(line.slice('TIMER-CAPTURE '.length)) : null });
    });
  });
}

function roots() {
  return { queue: mkTmp('spo-timer-flags-q-'), journal: mkTmp('spo-timer-flags-j-') };
}

// A refusal must come BEFORE the single-instance lock. An absent lock file afterwards proves
// nothing (a daemon that took it releases it on exit -- measured: that mutant stayed green), so
// the journal root is pre-held by a LIVE holder, this test process: a daemon that reached
// acquireLock first would exit 1 with LockHeldError instead of 2.
function seedLiveLock(r) {
  const payload = { host: os.hostname(), pid: process.pid, startedAt: new Date().toISOString(), mode: 'test-271' };
  const text = JSON.stringify(payload, null, 2) + '\n';
  fs.writeFileSync(lockPath(r.journal), text);
  r.lockText = text;
  return r;
}

function onceArgs(r, extra) {
  return ['--dry-run', '--once', '--queue', r.queue, '--journal', r.journal, ...extra];
}

// Bounded concurrency: dozens of short children, never all at once.
async function runAll(jobs) {
  const limit = Math.max(2, Math.min(6, os.cpus().length));
  const results = new Array(jobs.length);
  let next = 0;
  async function lane() {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: limit }, lane));
  return results;
}

function assertRefused(result, flag, raw, label, r) {
  assert.equal(result.status, 2, `${label}: expected exit 2\n${result.stderr}`);
  const got = raw === undefined ? `${flag} is missing its value` : `${flag} "${raw}" is not valid`;
  assert.ok(
    result.stderr.includes(`${got} -- expected an integer from 1 to ${MAX_TIMER_DELAY_MS}`),
    `${label}: stderr must name the flag, the value and the range:\n${result.stderr}`
  );
  assert.equal(result.captured, null, `${label}: main() must not reach drainQueueOnce`);
  assert.equal(fs.readFileSync(lockPath(r.journal), 'utf8'), r.lockText, `${label}: the seeded lock must be untouched`);
}

test('every bad --deadline-ms / --interval-ms value exits 2 naming the flag, the value and the range, before the lock', { timeout: 180000 }, async () => {
  const cases = [];
  for (const { flag } of FLAGS) {
    for (const raw of BAD) cases.push({ flag, raw, args: [flag, raw] });
    // The flag as the very last token: no value at all.
    cases.push({ flag, raw: undefined, args: [flag] });
  }
  const results = await runAll(
    cases.map((c) => () => {
      c.roots = seedLiveLock(roots());
      return runDaemon(onceArgs(c.roots, c.args), { capture: true });
    })
  );
  results.forEach((result, i) => {
    const c = cases[i];
    assertRefused(result, c.flag, c.raw, `${c.flag} ${JSON.stringify(c.raw)}`, c.roots);
  });
});

test('the refusal holds in continuous, worker, scanner and repark mode too, not only under --once', { timeout: 120000 }, async () => {
  const workerDir = mkTmp('spo-timer-flags-worker-');
  fs.writeFileSync(
    path.join(workerDir, 'task.json'),
    JSON.stringify({ id: 'timer-flags-worker', title: 't', kind: 'synthetic', shadow: { forceState: 'DONE' } })
  );
  const reparkDir = mkTmp('spo-timer-flags-repark-');
  fs.writeFileSync(path.join(reparkDir, 'task.json'), JSON.stringify({ id: 'timer-flags-repark', title: 't', kind: 'synthetic' }));
  const cases = [
    // A mutant that only validated under --once would boot a polling dispatcher here: the timeout
    // turns that into a failed assertion instead of a hung suite.
    { flag: '--interval-ms', raw: '-1', mode: ['--shadow'] },
    { flag: '--deadline-ms', raw: '3000000000', mode: ['--shadow'] },
    { flag: '--deadline-ms', raw: '-1', mode: ['--shadow', '--worker', workerDir] },
    { flag: '--interval-ms', raw: '1.5', mode: ['--shadow', '--scanner'] },
    { flag: '--deadline-ms', raw: 'abc', mode: ['--shadow', '--repark-task', reparkDir] },
  ];
  const results = await runAll(
    cases.map((c) => () => {
      c.roots = seedLiveLock(roots());
      return runDaemon([...c.mode, '--queue', c.roots.queue, '--journal', c.roots.journal, c.flag, c.raw], { timeout: 30000 });
    })
  );
  results.forEach((result, i) => {
    const c = cases[i];
    assertRefused(result, c.flag, c.raw, `${c.mode.join(' ')} ${c.flag} ${c.raw}`, c.roots);
  });
  // The worker refused before touching its task.
  assert.equal(fs.existsSync(path.join(workerDir, 'state.json')), false, 'a refused worker must not run its task');
  assert.equal(fs.existsSync(path.join(reparkDir, 'state.json')), false, 'a refused repark must not park its task');
});

test('valid values reach the timers unchanged -- the same effective value main() gave them before card #271', { timeout: 180000 }, async () => {
  const cases = [{ flag: null, raw: null }];
  for (const { flag } of FLAGS) for (const raw of VALID) cases.push({ flag, raw });
  const results = await runAll(cases.map((c) => () => runDaemon(onceArgs(roots(), c.flag ? [c.flag, c.raw] : []), { capture: true })));
  results.forEach((result, i) => {
    const c = cases[i];
    const label = c.flag ? `${c.flag} ${c.raw}` : 'no flag';
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.ok(result.captured, `${label}: no capture`);
    for (const { flag, field } of FLAGS) {
      const defaultMs = config[field];
      // main()'s pre-#271 formula, applied to a value it accepted: must not move.
      const before = c.flag === flag ? parseInt(c.raw, 10) || defaultMs : defaultMs;
      assert.equal(result.captured[field], before, `${label}: ${field}`);
      assert.equal(typeof result.captured[field], 'number', `${label}: ${field} must be a number, not the raw string`);
    }
    // --deadline-ms reaches exactly the states with no entry of their own.
    assert.equal(result.captured.CHECK, result.captured.stepDeadlineMs, `${label}: CHECK`);
    assert.equal(result.captured.PUSH_PR, result.captured.stepDeadlineMs, `${label}: PUSH_PR`);
  });
});

test("the dispatcher's forwarded --deadline-ms always passes the worker's own check, and the worker runs its task", { timeout: 180000 }, async () => {
  // The dispatcher's config.stepDeadlineMs is either a value resolveTimerFlags accepted or
  // config.js's constant default, and buildWorkerArgv forwards it as String(n). Capture the argv
  // the real daemon would build, then run exactly that as a real worker.
  assert.ok(Number.isInteger(config.stepDeadlineMs) && config.stepDeadlineMs >= 1 && config.stepDeadlineMs <= MAX_TIMER_DELAY_MS);
  const deadlines = [null, '1', '120000', String(MAX_TIMER_DELAY_MS)];
  const captures = await runAll(
    deadlines.map((raw) => () => runDaemon(onceArgs(roots(), raw === null ? ['--workers', '2'] : ['--workers', '2', '--deadline-ms', raw]), { capture: true }))
  );
  const jobs = captures.map((cap, i) => {
    const label = deadlines[i] === null ? 'default' : `--deadline-ms ${deadlines[i]}`;
    assert.equal(cap.status, 0, `${label}: ${cap.stderr}`);
    const argv = cap.captured.workerArgv;
    // Never spawn what a broken buildWorkerArgv might hand back: this test runs its output as is.
    assert.equal(argv[1], '--dry-run', `${label}: the worker mode flag must mirror the --dry-run daemon (${JSON.stringify(argv)})`);
    assert.ok(!argv.includes('--real'), `${label}: refusing to spawn a --real worker`);
    const at = argv.indexOf('--deadline-ms');
    assert.ok(at > 0, `${label}: the dispatcher must forward --deadline-ms (${JSON.stringify(argv)})`);
    assert.equal(argv[at + 1], String(cap.captured.stepDeadlineMs), `${label}: forwarded value`);
    const id = `timer-flags-fwd-${i}`;
    const journal = mkTmp('spo-timer-flags-fwd-j-');
    const taskDir = path.join(journal, id);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id, title: 't', kind: 'synthetic', shadow: { forceState: 'DONE' } }));
    // The captured argv with its placeholders swapped for this fixture, and --shadow for --dry-run
    // so the task needs no prompt fixtures. Everything after the mode flag is the dispatcher's own.
    const workerArgs = argv.slice(1).map((a) => ({ '--dry-run': '--shadow', '<taskDir>': taskDir, '<queue>': mkTmp('spo-timer-flags-fwd-q-'), '<journal>': journal })[a] || a);
    return () => runDaemon(workerArgs).then((result) => ({ result, label, journal, id }));
  });
  for (const { result, label, journal, id } of await runAll(jobs)) {
    assert.equal(result.status, 0, `${label}: the worker must accept the forwarded argv and finish its task\n${result.stderr}`);
    assert.equal(readState(journal, id).state, 'DONE', label);
  }
});
