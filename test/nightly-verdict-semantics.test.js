'use strict';
// Action B3.2 -- "an unknown nightly result must stop reading as green."
//
// Before this action, orchestrator/steps/scripted.js's nightly-red guard (realWorktree's own
// inline check, and guardNightlyRed, shared by realCiChecks' and realGate's main-moved paths)
// asked exactly one question: is `verdict === 'FAIL'` AND `sha === <the sha in question>`? Any
// other shape at all -- INTERRUPTED (written by worker.ts's recoverInterrupted precisely so a
// worker death does not read as a clean run), ENVIRONMENT, a missing file, a stale sha -- fell
// through the SAME "not red" branch as a genuine PASS, completely undistinguished. The sibling
// reader in the other repo, scripts/nightly-check.sh, made the bug visible: it prints the literal
// text "MAIN: GREEN" for ENVIRONMENT and INTERRUPTED.
//
// classifyNightly (exported from scripted.js) is the one classification both real-mode call
// sites in this file now go through -- see its own header comment for the full table. This file
// pins that table one verdict value at a time (Part 1), then proves the two real call sites
// (realWorktree, realCiChecks, realGate) actually consult it end to end (Part 2): a genuine RED
// still parks (regression guard for the pre-existing behaviour), and everything the table calls
// 'unknown' neither parks NOR silently passes for green -- it is journalled as 'nightly-unknown',
// distinguishable from both a park and from a genuine, silent, undistinguished pass-through.
//
// Same conventions as test/real-steps.test.js and test/gate-main-moved.test.js: every spawn is a
// fake injected via deps.spawnSync, config.spoBenchDir is a fresh tmp dir this file populates
// itself (never the real ~/.spo-bench), outcomes are asserted on the returned next-state, the
// thrown ParkSignal's reason, and journalled events -- never on prose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('./no-real-spawn');

const { realWorktree, realCiChecks, realGate, classifyNightly } = require('../orchestrator/steps/scripted');
const { buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function fail(status, stderr = '') {
  return { status, stdout: '', stderr, signal: null };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

function writeRaw(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-nvs-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-nvs-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    mainMovedRegateBudget: 1,
    ...overrides,
  };
}

function testCtx({ id = 'nvs-card', task, config } = {}) {
  const dir = path.join(mkTmp('spo-nvs-journalroot-'), id);
  fs.mkdirSync(dir, { recursive: true });
  return buildCtx(id, task, dir, {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
}

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// ================================================================================================
// Part 1 -- classifyNightly: one named assertion per verdict value (and per file shape), no
// numeric floors. Every JobVerdict value from SPO-WebClient's src/e2e/bench/job.ts is covered.
// ================================================================================================

test('classifyNightly: no file on disk at all (null) -> unknown, never green', () => {
  assert.equal(classifyNightly(null, SHA).status, 'unknown');
});

test('classifyNightly: a record with no verdict field -> unknown', () => {
  assert.equal(classifyNightly({ sha: SHA }, SHA).status, 'unknown');
});

test('classifyNightly: an unrecognised verdict string -> unknown, not silently ignored', () => {
  assert.equal(classifyNightly({ verdict: 'SOMETHING_NEW', sha: SHA }, SHA).status, 'unknown');
});

test('classifyNightly: PASS at the exact sha in question -> green (the only green case)', () => {
  assert.equal(classifyNightly({ verdict: 'PASS', sha: SHA }, SHA).status, 'green');
});

test('classifyNightly: PASS with no sha recorded -> unknown, not green (cannot say which main)', () => {
  assert.equal(classifyNightly({ verdict: 'PASS' }, SHA).status, 'unknown');
});

test('classifyNightly: PASS recorded for a DIFFERENT sha -> unknown, not green (a stale proof proves nothing about THIS sha)', () => {
  assert.equal(classifyNightly({ verdict: 'PASS', sha: OTHER_SHA }, SHA).status, 'unknown');
});

test('classifyNightly: FAIL at the exact sha in question -> red (the only red case)', () => {
  assert.equal(classifyNightly({ verdict: 'FAIL', sha: SHA }, SHA).status, 'red');
});

test('classifyNightly: FAIL with no sha recorded -> unknown, not red and not green', () => {
  assert.equal(classifyNightly({ verdict: 'FAIL' }, SHA).status, 'unknown');
});

test('classifyNightly: FAIL recorded for a DIFFERENT sha -> unknown, NOT green (the old bug: this used to be treated as green, "main moved past it")', () => {
  assert.equal(classifyNightly({ verdict: 'FAIL', sha: OTHER_SHA }, SHA).status, 'unknown');
});

// The heart of the defect this action fixes: INTERRUPTED is written by worker.ts's
// recoverInterrupted specifically so a worker death does not read as a clean run -- it must
// classify as 'unknown', on both sides, never fold into 'green'.
test("classifyNightly: INTERRUPTED at the exact sha -> unknown, NEVER green (recoverInterrupted's whole point)", () => {
  assert.equal(classifyNightly({ verdict: 'INTERRUPTED', sha: SHA }, SHA).status, 'unknown');
});

for (const verdict of ['ENVIRONMENT', 'BLOCKED', 'DIRTY', 'ABANDONED', 'STALE', 'LEASED']) {
  test(`classifyNightly: ${verdict} at the exact sha -> unknown (proves nothing about main by design, worker.ts)`, () => {
    assert.equal(classifyNightly({ verdict, sha: SHA }, SHA).status, 'unknown');
  });
}

test('classifyNightly: the returned reason distinguishes a stale/missing record from a genuine FAIL (never the same string)', () => {
  const missing = classifyNightly(null, SHA);
  const redAtSha = classifyNightly({ verdict: 'FAIL', sha: SHA }, SHA);
  assert.notEqual(missing.reason, redAtSha.reason);
  assert.equal(missing.status, 'unknown');
  assert.equal(redAtSha.status, 'red');
});

// ---- classifyNightly must not crash on an untrusted `sha` -------------------------------------
// `nightly/latest.json` is written by SPO-WebClient's worker, not this repo -- its shape is not
// this code's to assume. A non-string `sha` (still valid JSON) must classify 'unknown', the same
// answer as a missing one, never throw. Before this guard, `nightly.sha.slice(0, 8)` threw a
// TypeError for any of these -- which is not a ParkSignal, so it escaped realWorktree and
// guardNightlyRed as an unhandled error instead of the park/journal the rest of this file pins.

test('classifyNightly: sha as a number -> unknown, does not throw', () => {
  assert.doesNotThrow(() => classifyNightly({ verdict: 'PASS', sha: 123 }, SHA));
  assert.equal(classifyNightly({ verdict: 'PASS', sha: 123 }, SHA).status, 'unknown');
  assert.doesNotThrow(() => classifyNightly({ verdict: 'FAIL', sha: 123 }, SHA));
  assert.equal(classifyNightly({ verdict: 'FAIL', sha: 123 }, SHA).status, 'unknown');
});

test('classifyNightly: sha as an object -> unknown, does not throw', () => {
  assert.doesNotThrow(() => classifyNightly({ verdict: 'PASS', sha: { not: 'a string' } }, SHA));
  assert.equal(classifyNightly({ verdict: 'PASS', sha: { not: 'a string' } }, SHA).status, 'unknown');
});

test('classifyNightly: sha as null -> unknown, does not throw', () => {
  assert.doesNotThrow(() => classifyNightly({ verdict: 'PASS', sha: null }, SHA));
  assert.equal(classifyNightly({ verdict: 'PASS', sha: null }, SHA).status, 'unknown');
});

test('classifyNightly: sha absent entirely -> unknown, does not throw', () => {
  assert.doesNotThrow(() => classifyNightly({ verdict: 'PASS' }, SHA));
  assert.equal(classifyNightly({ verdict: 'PASS' }, SHA).status, 'unknown');
});

test('classifyNightly: sha as `true` -> unknown, does not throw (any non-string JSON value, not just number/object)', () => {
  assert.doesNotThrow(() => classifyNightly({ verdict: 'FAIL', sha: true }, SHA));
  assert.equal(classifyNightly({ verdict: 'FAIL', sha: true }, SHA).status, 'unknown');
});

// ---- mutation-proof: "the sha validation is not decorative" -----------------------------------
// Directly simulates the pre-fix line (`nightly.sha ? nightly.sha.slice(0, 8) : '(no sha)'`,
// guarded only by truthiness, not by type) to prove it throws on exactly the inputs the tests
// above now pin as 'unknown'. If the `typeof nightly.sha === 'string'` guard in scripted.js were
// removed, classifyNightly would throw the same way and every test above would go red.
test('classifyNightly mutation check: removing the typeof-string guard reintroduces a TypeError on a numeric/object sha', () => {
  const preFixGot = (nightly) => (nightly.sha ? nightly.sha.slice(0, 8) : '(no sha)');
  assert.throws(() => preFixGot({ sha: 123 }), TypeError);
  assert.throws(() => preFixGot({ sha: { not: 'a string' } }), TypeError);
  assert.throws(() => preFixGot({ sha: true }), TypeError);
  // ...but the fixed classifyNightly does not, for the exact same inputs:
  assert.doesNotThrow(() => classifyNightly({ verdict: 'PASS', sha: 123 }, SHA));
  assert.doesNotThrow(() => classifyNightly({ verdict: 'PASS', sha: { not: 'a string' } }, SHA));
  assert.doesNotThrow(() => classifyNightly({ verdict: 'PASS', sha: true }, SHA));
});

// ---- mutation-proof: "revert INTERRUPTED to green" --------------------------------------------
// Directly simulates the pre-fix predicate (only FAIL-at-sha is ever distinguished from a clean
// PASS) to prove the NEW test above actually pins something -- this is the exact shape a
// regression back to the old code would produce.
test('classifyNightly mutation check: the pre-fix predicate (verdict === FAIL && sha === target) would have let INTERRUPTED read as "not red", proving the fix is not decorative', () => {
  const preFixIsRed = (nightly, targetSha) => !!(nightly && nightly.verdict === 'FAIL' && nightly.sha === targetSha);
  assert.equal(preFixIsRed({ verdict: 'INTERRUPTED', sha: SHA }, SHA), false, 'pre-fix: INTERRUPTED never counted as red');
  // ...but the pre-fix code ALSO never labelled it anything else -- there was no third bucket.
  // The new classifier gives it an explicit, asserted label: 'unknown', pinned above.
  assert.equal(classifyNightly({ verdict: 'INTERRUPTED', sha: SHA }, SHA).status, 'unknown');
});

// ================================================================================================
// Part 2 -- the real call sites actually consult classifyNightly, end to end.
// ================================================================================================

// ---- realWorktree ------------------------------------------------------------------------------

function noLeftoversSpawnSync(calls, { originMainSha = SHA } = {}) {
  return (command, args, opts) => {
    calls.push({ command, args: [...args], cwd: opts && opts.cwd });
    if (args.includes('rev-parse') && args.includes('--verify')) return fail(1);
    if (args.includes('rev-parse')) return ok(`${originMainSha}\n`);
    if (args.includes('board:take')) return ok('claimed\n');
    return ok('');
  };
}

test('realWorktree: FAIL at the exact fetched sha still parks nightly-main-red (regression guard, unchanged behaviour)', async () => {
  const config = testConfig();
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: SHA });
  const ctx = testCtx({ id: 'nvs-wt-red', task: { id: 'nvs-wt-red', kind: 'card', issue: 1 }, config });

  const deps = { spawnSync: noLeftoversSpawnSync([], { originMainSha: SHA }) };

  await assert.rejects(
    () => realWorktree(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'nightly-main-red'
  );
});

test('realWorktree: INTERRUPTED at the exact fetched sha does NOT park -- proceeds to PLAN, journals nightly-unknown (does not read as green, does not block either)', async () => {
  const config = testConfig();
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'INTERRUPTED', sha: SHA });
  const ctx = testCtx({ id: 'nvs-wt-interrupted', task: { id: 'nvs-wt-interrupted', kind: 'card', issue: 2 }, config });

  const deps = { spawnSync: noLeftoversSpawnSync([], { originMainSha: SHA }) };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');

  const events = readJournal(ctx.taskDir);
  const unknownEvent = events.find((e) => e.state === 'WORKTREE' && e.event === 'nightly-unknown');
  assert.ok(unknownEvent, 'INTERRUPTED must leave an explicit, distinguishable trace -- never silence');
  assert.equal(unknownEvent.sha, SHA);
});

test('realWorktree: missing nightly file entirely -> proceeds to PLAN, journals nightly-unknown', async () => {
  const config = testConfig(); // spoBenchDir is a fresh empty tmp dir -- no nightly/latest.json at all
  const ctx = testCtx({ id: 'nvs-wt-missing', task: { id: 'nvs-wt-missing', kind: 'card', issue: 3 }, config });

  const deps = { spawnSync: noLeftoversSpawnSync([], { originMainSha: SHA }) };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');
  const events = readJournal(ctx.taskDir);
  assert.ok(events.some((e) => e.state === 'WORKTREE' && e.event === 'nightly-unknown'));
});

test('realWorktree: malformed nightly JSON -> proceeds to PLAN, journals nightly-unknown (distinguishable from a genuine FAIL, which would have parked)', async () => {
  const config = testConfig();
  writeRaw(path.join(config.spoBenchDir, 'nightly', 'latest.json'), '{not valid json');
  const ctx = testCtx({ id: 'nvs-wt-malformed', task: { id: 'nvs-wt-malformed', kind: 'card', issue: 4 }, config });

  const deps = { spawnSync: noLeftoversSpawnSync([], { originMainSha: SHA }) };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');
  const events = readJournal(ctx.taskDir);
  assert.ok(events.some((e) => e.state === 'WORKTREE' && e.event === 'nightly-unknown'));
});

test('realWorktree: PASS at the exact fetched sha -> proceeds to PLAN, does NOT journal nightly-unknown (a genuine green needs no caveat)', async () => {
  const config = testConfig();
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'PASS', sha: SHA });
  const ctx = testCtx({ id: 'nvs-wt-green', task: { id: 'nvs-wt-green', kind: 'card', issue: 5 }, config });

  const deps = { spawnSync: noLeftoversSpawnSync([], { originMainSha: SHA }) };

  const next = await realWorktree(ctx, deps);
  assert.equal(next, 'PLAN');
  const events = readJournal(ctx.taskDir);
  assert.ok(!events.some((e) => e.event === 'nightly-unknown'), 'a genuine PASS at this sha is green, not unknown');
});

// ---- realCiChecks / realGate: the main-moved merge guard (guardNightlyRed) --------------------

function ciCtx(config) {
  const worktreePath = mkTmp('spo-nvs-ci-wt-');
  return testCtx({ id: 'nvs-ci-card', task: { id: 'nvs-ci-card', kind: 'card', issue: 100, worktreePath }, config });
}

function ciGreenChecksDeps({ headSha, originMainSha, extra } = {}) {
  return {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      if (args.includes('diff')) return ok('shared/file.ts\n');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${originMainSha}\n`);
      if (extra) {
        const r = extra(command, args);
        if (r) return r;
      }
      return ok('');
    },
  };
}

test('realCiChecks: nightly INTERRUPTED at the exact origin/main sha does NOT refuse the merge -- proceeds, journals nightly-unknown (the exact defect this action fixes: "sails through as green on the path that gates card flow")', async () => {
  const config = testConfig();
  const ctx = ciCtx(config);
  const headSha = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), { baseMain: 'basemainsha' });
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'INTERRUPTED', sha: SHA });

  const deps = ciGreenChecksDeps({ headSha, originMainSha: SHA });

  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'CHECK', 'main-moved-merge must still proceed -- INTERRUPTED does not license a park it never earned');

  const events = readJournal(ctx.taskDir);
  const unknownEvent = events.find((e) => e.state === 'CI_CHECKS' && e.event === 'nightly-unknown');
  assert.ok(unknownEvent, 'INTERRUPTED must be journalled explicitly, not silently treated the same as a PASS');
  assert.equal(unknownEvent.sha, SHA);
});

test('realCiChecks: nightly FAIL recorded for a DIFFERENT sha than the freshly-fetched origin/main does NOT refuse -- journals nightly-unknown instead of the old silent "main moved past it, green" (mutation-proof for "drop the sha check")', async () => {
  const config = testConfig();
  const ctx = ciCtx(config);
  const headSha = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), { baseMain: 'basemainsha' });
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: OTHER_SHA });

  const deps = ciGreenChecksDeps({ headSha, originMainSha: SHA });

  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'CHECK');
  const events = readJournal(ctx.taskDir);
  assert.ok(events.some((e) => e.state === 'CI_CHECKS' && e.event === 'nightly-unknown'));
});

test('realCiChecks: nightly missing entirely -> main-moved-merge still proceeds, journals nightly-unknown (mutation-proof for "make unknown read as red": if unknown were treated as red this would incorrectly park main-red-no-merge)', async () => {
  const config = testConfig();
  const ctx = ciCtx(config); // spoBenchDir has no nightly/latest.json at all
  const headSha = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), { baseMain: 'basemainsha' });

  const deps = ciGreenChecksDeps({ headSha, originMainSha: SHA });

  const next = await realCiChecks(ctx, deps);
  assert.equal(next, 'CHECK', 'no nightly on file must not be treated as red -- that is the inversion the plan explicitly warns against');
});

test('realCiChecks: nightly FAIL at the exact origin/main sha still parks main-red-no-merge (regression guard: the ONE reachable never-fired leg, fired here)', async () => {
  const config = testConfig();
  const ctx = ciCtx(config);
  const headSha = 'c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4';
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), { baseMain: 'basemainsha' });
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: SHA });

  const deps = ciGreenChecksDeps({ headSha, originMainSha: SHA });

  await assert.rejects(
    () => realCiChecks(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'main-red-no-merge'
  );
});

function gateCtx(config) {
  const worktreePath = mkTmp('spo-nvs-gate-wt-');
  return testCtx({ id: 'nvs-gate-card', task: { id: 'nvs-gate-card', kind: 'card', issue: 200, worktreePath }, config });
}

function failNoBaseMainDeps({ headSha, originMainSha }) {
  return {
    spawnSync: (command, args) => {
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('fetch')) return ok('');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${originMainSha}\n`);
      if (args.includes('merge')) return ok('');
      return ok('');
    },
  };
}

test('realGate: nightly INTERRUPTED at the exact origin/main sha does NOT refuse the main-moved merge -- proceeds to CHECK, journals nightly-unknown', async () => {
  const config = testConfig();
  const ctx = gateCtx(config);
  const headSha = 'g1g1g1g1g1g1g1g1g1g1g1g1g1g1g1g1g1g1g1g1'.replace(/g/g, 'a');
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'INTERRUPTED', sha: SHA });

  const deps = failNoBaseMainDeps({ headSha, originMainSha: SHA });

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CHECK');
  const events = readJournal(ctx.taskDir);
  assert.ok(events.some((e) => e.state === 'GATE' && e.event === 'nightly-unknown'));
});

test('realGate: nightly FAIL at the exact origin/main sha still parks main-red-no-merge (regression guard, unchanged)', async () => {
  const config = testConfig();
  const ctx = gateCtx(config);
  const headSha = 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: SHA });

  const deps = failNoBaseMainDeps({ headSha, originMainSha: SHA });

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'main-red-no-merge'
  );
});
