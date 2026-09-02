'use strict';
// Action 4.2: GATE exit 1 is no longer an unconditional route to DIAGNOSE. See
// orchestrator/steps/scripted.js's own header comment on the exit-1 branch inside realGate for
// the full measurement (375 ref-type bench verdicts: 359/359 PASS carry baseMain, 14/16 FAIL do
// -- the missing 2 are exactly the main-moved conflicts) and the #439 / 379ada60 cross-check.
//
// Same conventions as test/real-steps.test.js: every spawn is a fake injected via
// deps.spawnSync, config.spoBenchDir is always a fresh tmp dir this file populates itself (never
// the real ~/.spo-bench), and outcomes are asserted on recorded argv arrays and journalled
// events, never on prose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { realGate, realCiChecks } = require('../orchestrator/steps/scripted');
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

// A distinct, VALID 40-char lowercase-hex object name per test, seeded by a readable label.
// realGate shape-checks `git rev-parse HEAD`'s stdout before using it as a verdict-file key --
// action 4.1's measurement is that a FAILING rev-parse prints the literal ref name on stdout, so
// "exit 0" alone is not enough to trust the string. A fake sha that is not hex would therefore
// exercise that guard instead of the branch the test is actually about; the label survives in the
// source so each fixture is still readable at the call site.
function fakeSha(label) {
  let out = '';
  for (const ch of label) out += (ch.charCodeAt(0) % 16).toString(16);
  return (out + 'f'.repeat(40)).slice(0, 40);
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
    pipelineWorktreesDir: mkTmp('spo-gmm-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-gmm-bench-'),
    stepDeadlineMs: 30000,
    ciChecksMaxPolls: 3,
    ciChecksPollIntervalMs: 1000,
    // Action 6.5: real config.js's default (1) -- baked in here, not left to
    // main-moved-budget.js's own fallback, so a test that overrides it (see the "raised budget"
    // tests below) is visibly opting OUT of the default rather than relying on an implicit one.
    mainMovedRegateBudget: 1,
    ...overrides,
  };
}

function testCtx({ id = 'gmm-card', task, config, taskDir } = {}) {
  return buildCtx(id, task, taskDir || mkTmp('spo-gmm-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
}

function gateCtx(overrides = {}) {
  const config = overrides.config || testConfig();
  const worktreePath = overrides.worktreePath || mkTmp('spo-gmm-wt-');
  const task = { id: 'gmm-card', kind: 'card', issue: 439, worktreePath, ...overrides.task };
  return testCtx({ id: 'gmm-card', task, config });
}

// ---- 1. exit 0 / 2 / 3 / 4 unchanged; exit 0 makes no rev-parse, no verdict read -------------

test('realGate: exit 0 -> CI_CHECKS with no extra call at all (no rev-parse, no verdict read)', async () => {
  const ctx = gateCtx();
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      return ok('');
    },
  };

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CI_CHECKS');

  // Only moveCard's `npm run board:move` and the gate run itself -- never a `git rev-parse`.
  assert.ok(!calls.some((c) => c.command === 'git'), 'the green path must spawn no git command at all');
  assert.ok(calls.some((c) => c.command === 'npm' && c.args[0] === 'run' && c.args[1] === 'gate'));
});

for (const [exit, reason] of [
  [2, 'gate-dirty-tree'],
  [3, 'gate-worker-down'],
  [4, 'gate-timeout'],
]) {
  test(`realGate: exit ${exit} unchanged -> PARKED (${reason}), no verdict lookup`, async () => {
    const ctx = gateCtx();
    const calls = [];
    const deps = {
      spawnSync: (command, args) => {
        calls.push({ command, args: [...args] });
        return fail(exit);
      },
    };

    await assert.rejects(
      () => realGate(ctx, deps),
      (err) => err instanceof ParkSignal && err.reason === reason
    );
    assert.ok(!calls.some((c) => c.command === 'git'), 'exit 2/3/4 never reach the exit-1 verdict logic');
  });
}

// ---- 2. exit 1, no verdict file -> gate-non-attesting, no merge/fetch argv -------------------

test('realGate: exit 1, no verdict file for HEAD -> PARKED gate-non-attesting, no merge/fetch argv, path journalled', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('nonattestinghead');
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      return ok('');
    },
  };

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'gate-non-attesting' && err.detail.headSha === headSha
  );

  assert.ok(!calls.some((c) => c.args.includes('fetch')), 'a non-attesting run must never spend a fetch');
  assert.ok(!calls.some((c) => c.args.includes('merge')), 'a non-attesting run must never spend a merge');

  const journal = readJournal(ctx.taskDir);
  const evt = journal.find((e) => e.event === 'gate-non-attesting');
  assert.ok(evt, 'gate-non-attesting must be journalled explicitly, not just thrown');
  assert.equal(evt.headSha, headSha);
  assert.equal(evt.verdictPath, path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`));
});

// ---- shared fake for the FAIL-without-baseMain family (tests 3-6) ----------------------------

function failNoBaseMainDeps({ headSha, calls, mergeExit = 0, nightly = null }) {
  return {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('fetch')) return ok('');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('freshoriginmainsha\n');
      if (args.includes('merge') && args.includes('--abort')) return ok('');
      if (args.includes('merge')) return mergeExit === 0 ? ok('') : fail(mergeExit, 'CONFLICT');
      return ok('');
    },
  };
}

// ---- 3. FAIL without baseMain, merge exits 0 -> CHECK -----------------------------------------

test('realGate: exit 1, FAIL without baseMain, merge clean -> CHECK, main-moved-merge journalled, mainMoveUsed set, fetch before merge', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('mainmovedcleanhead');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });

  const calls = [];
  const deps = failNoBaseMainDeps({ headSha, calls });

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CHECK');
  assert.equal(ctx.counters.mainMoveUsed, 1); // action 6.5: a count now, not a boolean

  const fetchIdx = calls.findIndex((c) => c.args.includes('fetch'));
  const mergeIdx = calls.findIndex((c) => c.args.includes('merge') && !c.args.includes('--abort'));
  assert.ok(fetchIdx !== -1, 'a fetch must be issued');
  assert.ok(mergeIdx !== -1, 'a merge must be issued');
  assert.ok(fetchIdx < mergeIdx, 'fetch must happen before merge');
  assert.ok(!calls.some((c) => c.args.includes('--abort')), 'a clean merge must never abort');

  const journal = readJournal(ctx.taskDir);
  const merged = journal.find((e) => e.event === 'main-moved-merge');
  assert.ok(merged, 'main-moved-merge must be journalled');
  assert.equal(merged.from, 'GATE');
});

// ---- 4. FAIL without baseMain, merge conflicts -> abort + PARKED main-moved-conflict ----------

test('realGate: exit 1, FAIL without baseMain, merge conflicts -> merge --abort issued, PARKED main-moved-conflict', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('mainmovedconflicthead');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });

  const calls = [];
  const deps = failNoBaseMainDeps({ headSha, calls, mergeExit: 1 });

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'main-moved-conflict' &&
      err.detail.headSha === headSha &&
      err.detail.mergeExit === 1
  );

  assert.ok(
    calls.some((c) => c.args.includes('merge') && c.args.includes('--abort')),
    'a conflicting merge must be aborted so the worktree is left clean'
  );

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'main-moved-merge'), 'a conflicted merge must never journal success');
});

// ---- 5. main already moved once this task -> main-moved-twice, no merge argv ------------------

test('realGate: exit 1, FAIL without baseMain, mainMoveUsed already true -> PARKED main-moved-twice, no merge argv', async () => {
  const ctx = gateCtx();
  ctx.counters.mainMoveUsed = 1; // action 6.5: at the default budget of 1, this task's move is already spent
  const headSha = fakeSha('mainmovedtwicehead');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });

  const calls = [];
  const deps = failNoBaseMainDeps({ headSha, calls });

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'main-moved-twice'
  );

  assert.ok(!calls.some((c) => c.args.includes('merge')), 'a second move must never even attempt a merge');
});

// ---- 5b. action 6.5: a raised mainMovedRegateBudget allows N re-gates before parking ----------
//
// See config.js's mainMovedRegateBudget comment: the default stays at 1 (test 5 above already
// covers "no behaviour change at the default"), and this is the codebase's convention for
// exercising a raised budget directly (ci-cause-step.test.js's own ciRetryBudget tests do the
// same) rather than through a CLI flag or env var -- none of diagnoseBudget/validateRejectBudget/
// ciRetryBudget have one either.
test('realGate: mainMovedRegateBudget raised to 2 -> two re-gates succeed, a third parks main-moved-twice', async () => {
  const config = testConfig({ mainMovedRegateBudget: 2 });
  const ctx = gateCtx({ config });
  const headSha = fakeSha('mainmovedbudget2head');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });

  const calls = [];
  const deps = failNoBaseMainDeps({ headSha, calls });

  assert.equal(await realGate(ctx, deps), 'CHECK', 'first move: under budget 2');
  assert.equal(ctx.counters.mainMoveUsed, 1);

  assert.equal(await realGate(ctx, deps), 'CHECK', 'second move: still under budget 2');
  assert.equal(ctx.counters.mainMoveUsed, 2);

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'main-moved-twice' &&
      err.detail.mainMoveUsed === 2 &&
      err.detail.mainMovedRegateBudget === 2,
    'third move: budget of 2 is spent'
  );
});

// ---- 5c. action 6.5: the module's own guard, and the SHIPPED default ------------------------
//
// Both of these pin things every OTHER test in this suite structurally cannot: each test file's
// testConfig() bakes in `mainMovedRegateBudget: 1` of its own, so no test above ever reads
// orchestrator/config.js's real value, and none ever reaches main-moved-budget.js's fallback
// branch. Verified by mutation: with only the tests above, `mainMovedRegateBudget: 1` -> 0 or ->
// 2 in the real config, and deleting the module's guard outright, ALL passed the full suite.
test('resolveMainMovedRegateBudget: a config missing the field falls back to 1, never to the infinite budget a bare >= comparison would give', () => {
  const { resolveMainMovedRegateBudget } = require('../orchestrator/main-moved-budget.js');

  // The hazard the module exists to close, stated as an executable fact rather than a comment:
  // `n >= undefined` is false for EVERY n, so a call site comparing straight against a missing
  // config field would allow main-moved re-gates forever.
  assert.equal(0 >= undefined, false);
  assert.equal(999 >= undefined, false);

  // ...and the module refuses to produce that. Every shape that is not a positive integer must
  // land on today's behaviour (1), not on undefined/NaN/0/negative.
  for (const bad of [undefined, null, 0, -1, -5, 1.5, NaN, Infinity, '2', true, false, {}]) {
    assert.equal(
      resolveMainMovedRegateBudget({ mainMovedRegateBudget: bad }),
      1,
      `a ${JSON.stringify(String(bad))} budget must fall back to 1, not grant an unbounded one`
    );
  }
  assert.equal(resolveMainMovedRegateBudget({}), 1, 'a config with no such field at all');
  assert.equal(resolveMainMovedRegateBudget(undefined), 1, 'no config object at all');
  assert.equal(resolveMainMovedRegateBudget(null), 1);

  // A genuine positive integer is honoured verbatim -- otherwise the field is decorative.
  assert.equal(resolveMainMovedRegateBudget({ mainMovedRegateBudget: 2 }), 2);
  assert.equal(resolveMainMovedRegateBudget({ mainMovedRegateBudget: 7 }), 7);
});

test('the SHIPPED mainMovedRegateBudget default is 1 -- action 6.5 changed the mechanism, not the behaviour', () => {
  const realConfig = require('../orchestrator/config.js');
  const { resolveMainMovedRegateBudget } = require('../orchestrator/main-moved-budget.js');

  // The settled decision (config.js's own comment, doc/state-machine-spec.md's CI_CHECKS row):
  // default 1 == today's hard "second move parks". Raising or lowering it is a real behaviour
  // change to the live daemon and must break a test, not slip through green. 0 in particular
  // would park the FIRST main-moved re-gate -- a path 4 of 16 measured sessions needed.
  assert.strictEqual(realConfig.mainMovedRegateBudget, 1);
  assert.strictEqual(resolveMainMovedRegateBudget(realConfig), 1);
});

// ---- 6. nightly red at the fetched origin/main sha -> main-red-no-merge, no merge argv --------
//         + a regression test that the extracted helper still behaves identically from
//           realCiChecks (the call site it was factored out of).

test('realGate: exit 1, FAIL without baseMain, nightly red at the fetched origin/main sha -> PARKED main-red-no-merge, no merge argv', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('mainredheadgate');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });
  writeJson(path.join(ctx.config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: 'freshoriginmainsha' });

  const calls = [];
  const deps = failNoBaseMainDeps({ headSha, calls });

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'main-red-no-merge'
  );

  assert.ok(!calls.some((c) => c.args.includes('merge')), 'a known-red main must never be merged');
});

test('realCiChecks: nightly-red guard (extracted into the shared helper) still parks main-red-no-merge -- regression test for the action 4.2 extraction', async () => {
  const config = testConfig();
  const worktreePath = mkTmp('spo-gmm-ci-wt-');
  const ctx = testCtx({ id: 'gmm-ci-card', task: { id: 'gmm-ci-card', kind: 'card', issue: 440, worktreePath }, config });
  const headSha = fakeSha('ciregressionhead');

  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), { baseMain: 'basemainsha' });
  writeJson(path.join(config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: 'redsha' });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('redsha\n');
      if (command === 'gh' && args[0] === 'api') {
        return ok(JSON.stringify({ check_runs: [{ name: 'typecheck + tests', conclusion: 'success' }] }));
      }
      if (args.includes('diff')) return ok('shared/file.ts\n');
      return ok('');
    },
  };

  await assert.rejects(
    () => realCiChecks(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'main-red-no-merge'
  );
});

// ---- 7. FAIL with baseMain -> DIAGNOSE, no merge argv, gate-verdict carries baseMain -----------

test('realGate: exit 1, FAIL WITH baseMain -> DIAGNOSE unchanged, no merge argv, gate-verdict journalled with baseMain', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('failwithbasemainhead');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL', baseMain: 'somemainsha' });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      return ok('');
    },
  };

  const next = await realGate(ctx, deps);
  assert.equal(next, 'DIAGNOSE');
  assert.ok(!calls.some((c) => c.args.includes('fetch') || c.args.includes('merge')), 'a real failure must never attempt a merge');

  const journal = readJournal(ctx.taskDir);
  const evt = journal.find((e) => e.event === 'gate-verdict');
  assert.ok(evt, 'gate-verdict must be journalled');
  assert.equal(evt.headSha, headSha);
  assert.equal(evt.baseMain, 'somemainsha');
  assert.equal(evt.verdict.verdict, 'FAIL');
});

// ---- 8. rev-parse HEAD itself fails -> DIAGNOSE, nothing parks --------------------------------

test('realGate: exit 1, rev-parse HEAD itself fails -> DIAGNOSE, nothing parks, gate-verdict-unreadable journalled', async () => {
  const ctx = gateCtx();
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return fail(128, 'fatal: not a git repository');
      return ok('');
    },
  };

  const next = await realGate(ctx, deps);
  assert.equal(next, 'DIAGNOSE');

  const journal = readJournal(ctx.taskDir);
  const evt = journal.find((e) => e.event === 'gate-verdict-unreadable');
  assert.ok(evt, 'the failure must be journalled, never silently swallowed');
  assert.equal(evt.step, 'rev-parse');
  assert.equal(evt.exit, 128);
  assert.ok(!journal.some((e) => e.event === 'gate-non-attesting' || e.event === 'gate-verdict'));
});

// ---- 9. gate.log is still written on every exit-1 path -----------------------------------------

const { gateLogPath } = require('../orchestrator/task-values');

for (const [label, headSha, verdictFile, extraJson] of [
  ['no verdict file (non-attesting)', 'gatelogA0000000000000000000000000000000', false, null],
  ['FAIL without baseMain', 'gatelogB0000000000000000000000000000000', true, { verdict: 'FAIL' }],
  ['FAIL with baseMain', 'gatelogC0000000000000000000000000000000', true, { verdict: 'FAIL', baseMain: 'x' }],
]) {
  test(`realGate: gate.log is still written on the exit-1 path -- ${label}`, async () => {
    const ctx = gateCtx();
    if (verdictFile) {
      writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), extraJson);
    }
    const deps = {
      spawnSync: (command, args) => {
        if (args.includes('gate')) return fail(1, 'GATE FAIL OUTPUT FOR ' + label);
        if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
        return ok('');
      },
    };

    // exit-1 paths either return DIAGNOSE/CHECK or throw a ParkSignal -- either way, gate.log
    // must already be on disk, since it is written unconditionally right after the gate spawn,
    // before any of the exit-1 branching below it (DIAGNOSE declares it as a required input).
    try {
      await realGate(ctx, deps);
    } catch (err) {
      if (!(err instanceof ParkSignal)) throw err;
    }

    // Plain substring check, not assert.match -- `label` carries parentheses (e.g. "(non-
    // attesting)") that would otherwise be read as regex grouping metacharacters.
    assert.ok(
      fs.readFileSync(gateLogPath(ctx.taskDir), 'utf8').includes(`GATE FAIL OUTPUT FOR ${label}`),
      'gate.log must hold this run\'s output'
    );
  });
}

// ---- 10. verification pass (action 4.2 adversarial review + mutation testing) -----------------
//
// Every test below was written because a mutation of the production code SURVIVED the suite as
// the builder left it -- i.e. the suite asserted the behaviour's happy shape without pinning the
// decision that produces it. Each one names the mutant it kills.

// Mutant killed: `!baseMain` -> `baseMain === undefined`. The main-moved branch keys on
// TRUTHINESS, exactly as realCiChecks' own `const baseMain = verdict && verdict.baseMain; if
// (!baseMain)` does a few dozen lines below it -- a verdict carrying `baseMain: null` or `""` has
// no base to compare against any more than one omitting the field, and both must take the same
// branch. Nothing in the suite distinguished the two.
test('realGate: exit 1, FAIL with a FALSY-but-present baseMain -> still the main-moved branch (truthiness, not presence)', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('falsybasemainhead');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL', baseMain: null });

  const calls = [];
  const next = await realGate(ctx, failNoBaseMainDeps({ headSha, calls }));
  assert.equal(next, 'CHECK');
  assert.ok(calls.some((c) => c.args.includes('merge')), 'a null baseMain is no baseMain -- it must merge');

  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'gate-verdict');
  assert.equal(evt.baseMain, null);
});

// Mutant killed: dropping the `verdict.verdict === 'FAIL'` conjunct entirely, so ANY verdict
// without a baseMain took the merge branch. Spec 4.2 step 6 is explicit that a PASS verdict
// recorded against an exit-1 gate is "any other shape" and routes to DIAGNOSE untouched -- the
// merge path is reserved for the one shape prepareRef actually produces (FAIL, no baseMain).
test('realGate: exit 1, PASS verdict without baseMain -> DIAGNOSE, never the main-moved merge', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('passverdictnobasemain');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'PASS' });

  const calls = [];
  const next = await realGate(ctx, failNoBaseMainDeps({ headSha, calls }));
  assert.equal(next, 'DIAGNOSE');
  assert.ok(
    !calls.some((c) => c.args.includes('merge') || c.args.includes('fetch')),
    'only a FAIL without baseMain is a main-moved conflict; every other shape belongs to a judge'
  );
  assert.equal(ctx.counters.mainMoveUsed, 0, 'a non-FAIL verdict must not spend the one main move'); // action 6.5: a count now, not a boolean
});

// Mutant killed: deleting the `gate-main-moved-fetch-failed` appendEvent. The fetch being
// non-fatal is a real decision (merge against what is local rather than park on a flaky network)
// and the journal line is the only trace that the merge below was decided on stale information.
test('realGate: exit 1, FAIL without baseMain, fetch fails -> journalled non-fatally and the merge still happens', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('fetchfailedhead');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('fetch')) return fail(128, 'could not read from remote');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('staleoriginmainsha\n');
      return ok('');
    },
  };

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CHECK');
  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'gate-main-moved-fetch-failed');
  assert.ok(evt, 'a failed fetch must be journalled, never silently swallowed');
  assert.equal(evt.exit, 128);
  assert.ok(calls.some((c) => c.args.includes('merge')), 'a failed fetch is not fatal -- the merge still runs');
});

// Mutant killed: deleting the `gate-main-moved-rev-parse-failed` appendEvent. This is the
// builder's own flagged judgment call, and the asymmetry it creates with realCiChecks (which
// PARKS ci-checks-rev-parse-failed on the same failure) is exactly why it needs a test that
// states it out loud: without a sha the nightly-red guard cannot fire, so a nightly that IS red
// is skipped rather than parked on. Safe because `git merge origin/main` resolves the same ref
// -- see the production comment for the measurement.
test('realGate: exit 1, FAIL without baseMain, rev-parse origin/main fails -> journalled, nightly guard skipped, merge still attempted', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('originmainrevparsefail');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });
  // A nightly that WOULD park if the sha could be resolved -- proving the guard is skipped, not
  // silently passing for some other reason.
  writeJson(path.join(ctx.config.spoBenchDir, 'nightly', 'latest.json'), { verdict: 'FAIL', sha: 'freshoriginmainsha' });

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('fetch')) return ok('');
      if (args.includes('rev-parse') && args.includes('origin/main')) return fail(128, 'unknown revision');
      return ok('');
    },
  };

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CHECK');
  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'gate-main-moved-rev-parse-failed');
  assert.ok(evt, 'an unresolvable origin/main must be journalled');
  assert.equal(evt.exit, 128);
  assert.ok(calls.some((c) => c.args.includes('merge')), 'the merge decision is not the rev-parse lookup');
});

// Mutants killed: dropping `nightly.verdict === 'FAIL'` from guardNightlyRed (a GREEN nightly at
// the current tip would then block every merge), and dropping `nightly.sha === originMainSha` (a
// STALE red nightly, from a main that has since been fixed, would then block every merge forever).
// Both survived a suite that only ever asserted the one red-at-this-sha case.
for (const [label, nightly] of [
  ['nightly is PASS at the current tip', { verdict: 'PASS', sha: 'freshoriginmainsha' }],
  ['nightly is FAIL but at an OLDER sha', { verdict: 'FAIL', sha: 'someoldermainsha' }],
]) {
  test(`realGate: exit 1, FAIL without baseMain, ${label} -> the merge proceeds, nothing parks`, async () => {
    const ctx = gateCtx();
    const headSha = fakeSha('nightlynotred');
    writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });
    writeJson(path.join(ctx.config.spoBenchDir, 'nightly', 'latest.json'), nightly);

    const calls = [];
    const next = await realGate(ctx, failNoBaseMainDeps({ headSha, calls }));
    assert.equal(next, 'CHECK');
    assert.ok(calls.some((c) => c.args.includes('merge')), 'only a red nightly AT THIS SHA refuses the merge');
  });
}

// Adversarial review finding (a): `git rev-parse HEAD` can exit 0-ish and still not hand back a
// sha -- action 4.1's own measurement is that a FAILING rev-parse prints the literal ref name
// `HEAD` on stdout. The exit check catches the measured case; the shape check catches the class.
// Without it a garbage sha makes `verdicts/<garbage>.json` miss and the card PARKS
// gate-non-attesting -- told "the bench attested nothing" when the machine never asked the bench
// the right question. Must degrade to DIAGNOSE, exactly like a non-zero exit.
for (const [label, stdout] of [
  ['the literal ref name `HEAD` (action 4.1 measurement)', 'HEAD\n'],
  ['an empty string', '\n'],
  ['git error prose', "fatal: ambiguous argument 'HEAD'\n"],
]) {
  test(`realGate: exit 1, rev-parse HEAD exits 0 but prints ${label} -> DIAGNOSE, never a gate-non-attesting park`, async () => {
    const ctx = gateCtx();
    const calls = [];
    const deps = {
      spawnSync: (command, args) => {
        calls.push({ command, args: [...args] });
        if (args.includes('gate')) return fail(1);
        if (args.includes('rev-parse') && args.includes('HEAD')) return ok(stdout);
        return ok('');
      },
    };

    const next = await realGate(ctx, deps);
    assert.equal(next, 'DIAGNOSE');

    const journal = readJournal(ctx.taskDir);
    assert.ok(
      !journal.some((e) => e.event === 'gate-non-attesting'),
      'a sha the machine could not read is never evidence about what the bench attested'
    );
    const evt = journal.find((e) => e.event === 'gate-verdict-unreadable');
    assert.ok(evt, 'the unreadable sha must be journalled');
    assert.equal(evt.step, 'rev-parse');
    assert.equal(evt.headSha, stdout.trim());
    assert.ok(!calls.some((c) => c.args.includes('merge') || c.args.includes('fetch')));
  });
}

// Adversarial review finding (b), first half: readJsonSafe returns null for "no such file" AND
// for "the file is there and did not parse". Only the first means non-attesting. A truncated
// verdict write is a real race (379ada60's landed 1.2s before the CLI exited), and parking a card
// on a failed READ is the same mistake as parking it on a failed rev-parse.
test('realGate: exit 1, verdict file present but unparsable -> DIAGNOSE, never gate-non-attesting', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('corruptverdictfile');
  const verdictPath = path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`);
  fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
  fs.writeFileSync(verdictPath, '{"verdict":"FA'); // truncated mid-write

  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      return ok('');
    },
  };

  const next = await realGate(ctx, deps);
  assert.equal(next, 'DIAGNOSE');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'gate-non-attesting'), 'a file that exists attested something');
  const evt = journal.find((e) => e.event === 'gate-verdict-unreadable');
  assert.ok(evt);
  assert.equal(evt.step, 'verdict-parse');
  assert.equal(evt.verdictPath, verdictPath);
});

// Adversarial review finding (b), second half: a misconfigured or unmounted config.spoBenchDir
// sends EVERY failing gate down the non-attesting park. `verdictDirExists` is what lets a
// maintainer tell "the bench genuinely attested nothing" from "the machine looked in the wrong
// place" without leaving the park comment.
for (const [label, populate, expected] of [
  ['a real bench dir with no verdict for this sha', true, true],
  ['a spoBenchDir that does not exist at all', false, false],
]) {
  test(`realGate: gate-non-attesting reports whether the verdicts dir itself exists -- ${label}`, async () => {
    const config = testConfig(populate ? {} : { spoBenchDir: path.join(os.tmpdir(), 'spo-gmm-nonexistent-bench-dir') });
    const ctx = gateCtx({ config });
    if (populate) fs.mkdirSync(path.join(config.spoBenchDir, 'verdicts'), { recursive: true });
    const headSha = fakeSha('benchdirprobehead');

    const deps = {
      spawnSync: (command, args) => {
        if (args.includes('gate')) return fail(1);
        if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
        return ok('');
      },
    };

    await assert.rejects(
      () => realGate(ctx, deps),
      (err) =>
        err instanceof ParkSignal && err.reason === 'gate-non-attesting' && err.detail.verdictDirExists === expected
    );
    const evt = readJournal(ctx.taskDir).find((e) => e.event === 'gate-non-attesting');
    assert.equal(evt.verdictDirExists, expected);
  });
}

// Adversarial review finding (c): `merge --abort` is best-effort cleanup, but it goes through
// spawnStep -- and since action 2.1 a twice-timed-out spawnStep THROWS ParkSignal('git-timed-out')
// rather than returning. Unguarded, that throw unwinds past the main-moved-conflict park, so the
// card parks under a reason naming the cleanup instead of the cause and loses {headSha, mergeExit}
// with it. Same shape as action 4.3's own verification finding.
test('realGate: a merge --abort that TIMES OUT still parks main-moved-conflict, not git-timed-out', async () => {
  const config = testConfig({ commandTimeoutsMs: { git: 5000 } });
  const ctx = gateCtx({ config });
  const headSha = fakeSha('abortTimeoutHead');
  writeJson(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });

  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('fetch')) return ok('');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('freshoriginmainsha\n');
      // The kill signature spawnOnce/isSpawnTimeout recognise: a signalled child with a deadline
      // armed. spawnStep retries once and then throws.
      if (args.includes('merge') && args.includes('--abort')) {
        return { status: null, stdout: '', stderr: '', signal: 'SIGTERM' };
      }
      if (args.includes('merge')) return fail(1, 'CONFLICT');
      return ok('');
    },
  };

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'main-moved-conflict' &&
      err.detail.headSha === headSha &&
      err.detail.mergeExit === 1
  );

  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'gate-main-moved-abort-failed');
  assert.ok(evt, 'the swallowed timeout must still be journalled');
  assert.equal(evt.reason, 'git-timed-out');
});

// The other half of that guard, and the reason it is `if (!(err instanceof ParkSignal)) throw err`
// rather than a bare catch (the same line preserveWorktreeWip uses, for the same reason): the
// catch exists to swallow ONE specific control-flow throw. A genuine programming error thrown
// from inside spawnStep must still escape -- a catch that eats everything would turn a TypeError
// into a silent main-moved-conflict park and hide the bug behind a plausible reason.
test('realGate: a NON-ParkSignal error from merge --abort still escapes -- the catch swallows control flow, not bugs', async () => {
  const ctx = gateCtx();
  const headSha = fakeSha('abortThrowsHead');
  writeJson(path.join(ctx.config.spoBenchDir, 'verdicts', `${headSha}.json`), { verdict: 'FAIL' });

  const boom = new TypeError('spawnSync blew up for a reason that is not a park');
  const deps = {
    spawnSync: (command, args) => {
      if (args.includes('gate')) return fail(1);
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      if (args.includes('fetch')) return ok('');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('freshoriginmainsha\n');
      if (args.includes('merge') && args.includes('--abort')) throw boom;
      if (args.includes('merge')) return fail(1, 'CONFLICT');
      return ok('');
    },
  };

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => err === boom && !(err instanceof ParkSignal)
  );
});
