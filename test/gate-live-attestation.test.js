'use strict';
// Action B2.3: the pipeline reads the bench's own `live` attestation (verdict.ts's
// `LiveAttestation`, landed on SPO-WebClient main and running live on the bench worker as of
// 2026-09-03) and refuses to treat a routed-but-not-driven PASS as green.
//
//   (a) `realGate` now reads the verdict on `npm run gate` exit 0 too -- previously nothing was
//       read on the green path at all. A verdict whose `live` says routing required flows the
//       live stage never drove is not evidence of a passing gate, exit code notwithstanding.
//   (b) A BLOCKED verdict (exit 1, since cli.ts's wait() collapses every non-PASS/LEASED verdict
//       to the same exit 1) stops falling through to DIAGNOSE -- a judge cannot diagnose a code
//       defect that was never observed; the gate refused because it could not drive the routed
//       flows, not because the code failed.
//   (c) Absence -- no verdict file, a verdict with no `live` key (515 of 517 real files on this
//       machine as of this action), or `live.status === 'unknown'` -- is read as "nothing proven
//       either way", never as "the live stage ran", and never parks the card (that would stall
//       the whole backlog on old data).
//
// (a) and the ROUTED-BUT-UNDRIVEN half of (b) share ONE park reason, `gate-live-not-driven`: the
// underlying fact (routing required a live drive that never happened) is identical whether it
// arrives honestly as BLOCKED/exit-1 or, wrongly, as PASS/exit-0 from a worker/verdict that
// predates the bench-side fix. Fixtures below are copied verbatim from `~/.spo-bench/verdicts/`
// (real shas, real field shapes) wherever a real example exists; the one shape that cannot exist
// in the corpus yet -- BLOCKED with routed-but-undriven flows, since the bench-side fix that
// produces it just landed and no card has hit it live -- is hand-built strictly from
// SPO-WebClient's own src/e2e/bench/verdict.ts (`LiveAttestation`'s `'skipped'` member) and
// worker.ts's `liveAttestationFrom`/verify-gate.js's exact `why` string template, not invented ad
// hoc.
//
// A fix-round finding (adversarial verification T4/T5) narrowed (b) further: `BLOCKED` is not
// only produced by a routed-but-undriven diff. `run.ts:63`'s `runLive` also returns BLOCKED when
// the world lock refuses the run (dirty, or another live run already in flight -- single-flight)
// or, structurally possible but dead today, a rate limit -- and `liveAttestationFrom` maps THAT
// to `live.status: 'unknown'`, the identical value (c) reads as proof of nothing. A bare
// `verdict.verdict === 'BLOCKED'` check was parking that case under `gate-live-not-driven` too, a
// name asserting a fact the attestation explicitly declines to assert. It now parks under its own
// reason, `gate-live-blocked` (`test/transient-retry.test.js` covers its own allowlist
// membership; this file covers only the routing decision).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('./no-real-spawn');
const { realGate } = require('../orchestrator/steps/scripted');
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
    pipelineWorktreesDir: mkTmp('spo-gla-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-gla-bench-'),
    stepDeadlineMs: 30000,
    mainMovedRegateBudget: 1,
    ...overrides,
  };
}

function testCtx({ id = 'gla-card', task, config, taskDir } = {}) {
  return buildCtx(id, task, taskDir || mkTmp('spo-gla-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    ...(config || testConfig()),
  });
}

function gateCtx(overrides = {}) {
  const config = overrides.config || testConfig();
  const worktreePath = overrides.worktreePath || mkTmp('spo-gla-wt-');
  const task = { id: 'gla-card', kind: 'card', issue: 623, worktreePath, ...overrides.task };
  return testCtx({ id: 'gla-card', task, config });
}

// Loads a fixture verdict and installs it into config.spoBenchDir/verdicts/<head>.json under
// its OWN `head` field, exactly where realGate looks for it -- never a path the test invents.
function installFixtureVerdict(config, fixtureName) {
  const fixturePath = path.join(__dirname, 'fixtures', 'verdicts', fixtureName);
  const verdict = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const dest = path.join(config.spoBenchDir, 'verdicts', `${verdict.head}.json`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(fixturePath));
  return verdict;
}

// A deps.spawnSync that answers `npm run gate` with `gateExit` and `git rev-parse HEAD` with the
// fixture's own head sha -- every other command (moveCard's `npm run board:move`, etc.) is a
// harmless no-op ok(''), matching every other realGate test in this suite.
function depsFor(gateExit, headSha) {
  return {
    spawnSync: (command, args) => {
      if (args.includes('run') && args.includes('gate')) {
        return gateExit === 0 ? ok('') : fail(gateExit);
      }
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${headSha}\n`);
      return ok('');
    },
  };
}

// ---- (a)/(b): routed, not driven -- exit 0 (PASS lied) and exit 1 (BLOCKED, honest) ----------
//
// Real bench worker fixture would be impossible to collect today (the bench-side fix that
// produces BLOCKED-with-routed-flows just landed; nothing has hit it live yet in
// ~/.spo-bench/verdicts/), so this is built from source (see file header) rather than copied.

for (const [label, gateExit] of [
  ['exit 0 (the gate itself said PASS -- an old worker or a reused verdict lied about it)', 0],
  ['exit 1, verdict.verdict === BLOCKED (the honest, current-worker shape)', 1],
]) {
  test(`realGate: routed flows not driven, ${label} -> PARKED gate-live-not-driven, never DIAGNOSE`, async () => {
    const config = testConfig();
    const ctx = gateCtx({ config });
    const verdict = installFixtureVerdict(config, 'live-skipped-routed-not-driven.json');
    const deps = depsFor(gateExit, verdict.head);

    await assert.rejects(
      () => realGate(ctx, deps),
      (err) =>
        err instanceof ParkSignal &&
        err.reason === 'gate-live-not-driven' &&
        // Fix-round finding T4: exitFrom must reach the ParkSignal DETAIL, not only the journal
        // event -- the park comment/state.json are built from `detail` (park-loop.js's
        // buildParkComment), so before this fix a maintainer had to open journal.jsonl to tell a
        // dishonest exit-0 PASS apart from an honest exit-1 BLOCKED.
        err.detail.exitFrom === gateExit
    );

    const journal = readJournal(ctx.taskDir);
    const evt = journal.find((e) => e.event === 'gate-live-not-driven');
    assert.ok(evt, 'must be journalled by name');
    assert.deepEqual(evt.required, ['login-spine', 'building-details']);
    assert.equal(evt.exitFrom, gateExit);
    // assert.rejects above already proves this threw rather than returning -- 'DIAGNOSE' (a
    // return value, not a park) is therefore structurally unreachable here; the point this test
    // exists to pin is that the BLOCKED/exit-1 shape parks BY NAME instead of falling through to
    // the bottom-of-block `return 'DIAGNOSE'` a plain "exit 1 -> DIAGNOSE" mapping would take.
  });
}

// ---- BLOCKED, but NOT routed-but-undriven -- fix-round finding T4/T5 --------------------------
//
// `run.ts:63`'s `runLive` is the OTHER producer of a BLOCKED verdict: the world lock refused the
// run (dirty, or another live run already in flight) or, structurally possible but dead today, a
// rate limit. `liveAttestationFrom` maps all three to `live.status: 'unknown'` -- never
// `'skipped'` with a `required` list -- so `liveRoutedButNotDriven` is false and this must NOT
// collapse into `gate-live-not-driven`. No real corpus fixture exists for this shape yet (BLOCKED
// verdicts in `~/.spo-bench/verdicts/` are 0/517 today), so built directly from
// `liveAttestationFrom`'s own documented shape, same convention as the `live.status "unknown"`
// test below.

test('realGate: exit 1, BLOCKED but live.status "unknown" (world lock / rate limit, NOT routed-but-undriven) -> PARKED gate-live-blocked, not gate-live-not-driven', async () => {
  const config = testConfig();
  const ctx = gateCtx({ config });
  const headSha = 'ef58a9c1b3072d6e4a8f5c9b1d3e7a0c2f4b6d80';
  const verdictPath = path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`);
  fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
  fs.writeFileSync(
    verdictPath,
    JSON.stringify({
      head: headSha,
      verdict: 'BLOCKED',
      live: { status: 'unknown', why: 'world lock: a live run is already in flight (pid 12345). Live runs are single-flight.' },
    })
  );
  const deps = depsFor(1, headSha);

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'gate-live-blocked' &&
      err.detail.exitFrom === 1 &&
      err.detail.liveStatus === 'unknown'
  );

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'gate-live-not-driven'), 'must not be misfiled as the routed-undriven reason');
  const evt = journal.find((e) => e.event === 'gate-live-blocked');
  assert.ok(evt, 'must be journalled by its own name');
  assert.equal(evt.exitFrom, 1);
  assert.equal(evt.liveStatus, 'unknown');
});

test('realGate: exit 1, BLOCKED with no `live` key at all -> PARKED gate-live-blocked, defensively (not a throw on undefined.status)', async () => {
  // A BLOCKED verdict with no `live` key is not a shape any known producer writes today, but the
  // exit-1 arm reads `live.status`/`live.why` unconditionally through `live && live.X` -- this
  // pins that it degrades to gate-live-blocked rather than throwing a TypeError.
  const config = testConfig();
  const ctx = gateCtx({ config });
  const headSha = 'fa69b0d2c4183e7f5b9a6c0d2e8f4b1a3c5e7d91';
  const verdictPath = path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`);
  fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
  fs.writeFileSync(verdictPath, JSON.stringify({ head: headSha, verdict: 'BLOCKED' }));
  const deps = depsFor(1, headSha);

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) => err instanceof ParkSignal && err.reason === 'gate-live-blocked' && err.detail.liveStatus === undefined
  );
});

// ---- live ran: unchanged, real fixture (355a55293675e45d7cba5079bcda85cb6afb081e.json) -------

test('realGate: live.status "ran" -> CI_CHECKS, unchanged', async () => {
  const config = testConfig();
  const ctx = gateCtx({ config });
  const verdict = installFixtureVerdict(config, 'live-ran.json');
  const deps = depsFor(0, verdict.head);

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CI_CHECKS');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'gate-live-not-driven'));
});

// ---- skipped, nothing routed: the common case (186/215 corpus skips) -- unchanged -------------
// Real fixture: 373eac71d2b445c22c0f4071b363c16f64ad79c6.json.

test('realGate: live.status "skipped" with required: [] (nothing routed) -> CI_CHECKS, unchanged -- the common case must not regress', async () => {
  const config = testConfig();
  const ctx = gateCtx({ config });
  const verdict = installFixtureVerdict(config, 'live-skipped-nothing-routed.json');
  const deps = depsFor(0, verdict.head);

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CI_CHECKS');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'gate-live-not-driven'));
});

// ---- (c) absence must be safe: legacy verdict, no `live` key at all ---------------------------
// Real fixture: 00f6588185f414c54e9c07fb4369c04d101643d6.json -- one of 515 (of 517) verdicts
// written before the `live` field existed on SPO-WebClient main.

test('realGate: legacy verdict with no `live` key -> CI_CHECKS, does not park, journals the gap (action B2.3(c))', async () => {
  const config = testConfig();
  const ctx = gateCtx({ config });
  const verdict = installFixtureVerdict(config, 'legacy-no-live-key.json');
  assert.equal(verdict.live, undefined, 'fixture sanity: this real file predates the `live` field');
  const deps = depsFor(0, verdict.head);

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CI_CHECKS', 'absence must not stall the backlog on old data');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'gate-live-not-driven'), 'absence is never read as proof either way');
  const evt = journal.find((e) => e.event === 'gate-live-unknown');
  assert.ok(evt, 'the gap must still be visible in the journal even though it is not actionable per card');
  assert.equal(evt.verdictExists, true);
});

// No verdict file at all for this HEAD (a fresh spoBenchDir, or a sha the bench has simply never
// seen) must be exactly as safe as a legacy verdict missing the key -- same event, verdictExists
// flips to false so a misconfigured spoBenchDir stays distinguishable (verdictDirExists-style
// precedent from realGate's own gate-non-attesting park, exit-1 path).

test('realGate: no verdict file on disk at all for HEAD -> CI_CHECKS, does not park, journals gate-live-unknown with verdictExists: false', async () => {
  const config = testConfig();
  const ctx = gateCtx({ config });
  const headSha = 'ab35f9c7e1024d6b8a3f5c9e0d7b2a4f6c8e1d30';
  const deps = depsFor(0, headSha);

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CI_CHECKS');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'gate-live-not-driven'));
  const evt = journal.find((e) => e.event === 'gate-live-unknown');
  assert.ok(evt);
  assert.equal(evt.verdictExists, false);
});

// ---- live.status "unknown" -- also safe, also never proof of a live drive ---------------------

test('realGate: live.status "unknown" -> CI_CHECKS, does not park, journals gate-live-unknown', async () => {
  const config = testConfig();
  const ctx = gateCtx({ config });
  const headSha = 'cd47a8b6e2135f7c9b4a6d0e8f3c5b7a9d1e2f40';
  const verdictPath = path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`);
  fs.mkdirSync(path.dirname(verdictPath), { recursive: true });
  fs.writeFileSync(
    verdictPath,
    JSON.stringify({
      head: headSha,
      verdict: 'FAIL',
      baseMain: 'somemainsha',
      live: { status: 'unknown', why: 'the gate artifact recorded no live stage' },
    })
  );
  const deps = depsFor(0, headSha);

  const next = await realGate(ctx, deps);
  assert.equal(next, 'CI_CHECKS');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'gate-live-not-driven'));
  assert.ok(journal.some((e) => e.event === 'gate-live-unknown'));
});
