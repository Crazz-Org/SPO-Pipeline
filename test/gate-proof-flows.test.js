'use strict';
// Card #313: the gate is asked for the card's own live flows.
//
// realGate reads PLAN's `proof_flows` / `regression_flows` (card #312) and, only when the card's
// OWN worktree's scripts/verify-gate.js reads an `also-flows` flag (SPO-WebClient#1183), runs
// `npm run gate -- --also-flows=a,b`. acceptPassedGate then parks `live-proof-missing` on a PASS
// verdict whose `live` block does not show every requested flow as driven. An unsupported
// worktree is gated exactly as before (argv unchanged, no new park) and journals
// `gate-flows-unsupported`; a card with nothing declared journals nothing. prepareJudgeInputs
// writes the requested flows into gate-report.md's `Requested flows:` line (card #314) from the
// `gate-flows-requested` event matching the sha the report describes -- never a stale one.
//
// Every command goes through an injected deps.spawnSync; nothing here spawns `npm run gate`,
// `git` or `gh` for real (./no-real-spawn).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');
const {
  realGate,
  prepareJudgeInputs,
  NO_REQUESTED_FLOWS,
  requestedGateFlowSet,
  gateScriptReadsAlsoFlows,
  worktreeGateTakesAlsoFlows,
  gateRequestedFlowsFor,
} = require('../orchestrator/steps/scripted');
const { buildCtx, TERMINAL_PARK_REASONS, TRANSIENT_RETRY_REASONS, isTransientRetryReason } = require('../orchestrator/state-machine');
const { RESUMABLE_PARK_REASONS, buildContinueLine } = require('../orchestrator/park-loop');
const { appendEvent } = require('../orchestrator/journal');
const { gateReportPath } = require('../orchestrator/task-values');
const { ParkSignal } = require('../orchestrator/park-signal');
const { mkTmp } = require('./helpers');

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', signal: null });

const HEAD_A = 'a313a313a313a313a313a313a313a313a313a313';
const HEAD_B = 'b313b313b313b313b313b313b313b313b313b313';
const MAIN_SHA = 'c313c313c313c313c313c313c313c313c313c313';

// A real-shaped excerpt of SPO-WebClient's scripts/verify-gate.js (8f68f031, 2026-09-29): its flag
// reader and the one line that reads `--flows=`. SUPPORTED adds the read #1183 introduces.
const VERIFY_GATE_TODAY = [
  "const argv = process.argv.slice(2);",
  '',
  'function flag(name) {',
  '  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));',
  '  if (!hit) return undefined;',
  "  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';",
  '}',
  '',
  "  const liveRequested = flag('live') === 'true';",
  "  const requested = flag('flows');",
  "  const flows = requested ? requested.split(',').filter(Boolean) : decision.required;",
  '',
].join('\n');
const VERIFY_GATE_SUPPORTED = VERIFY_GATE_TODAY.replace(
  "  const requested = flag('flows');",
  "  const requested = flag('flows');\n  const alsoRequested = flag('also-flows');"
);

function readJournal(taskDir) {
  const file = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function testConfig(overrides = {}) {
  return {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-gpf-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-gpf-bench-'),
    stepDeadlineMs: 30000,
    mainMovedRegateBudget: 1,
    gateDiedRecoveryMaxPolls: 2,
    gateDiedRecoveryPollIntervalMs: 0,
    ...overrides,
  };
}

// A worktree whose scripts/verify-gate.js is `gateSource` (null: no such file at all).
function makeWorktree(gateSource) {
  const worktreePath = mkTmp('spo-gpf-wt-');
  if (gateSource !== null) {
    fs.mkdirSync(path.join(worktreePath, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'scripts', 'verify-gate.js'), gateSource);
  }
  return worktreePath;
}

// A GATE-ready ctx: a worktree carrying `gateSource`, and -- when `plan` is given -- a journaled
// PLAN 'result' record exactly as handlePlan writes one (state-machine.js).
function gateCtx({ gateSource = VERIFY_GATE_SUPPORTED, plan, config = testConfig() } = {}) {
  const worktreePath = makeWorktree(gateSource);
  const taskDir = mkTmp('spo-gpf-taskdir-');
  const task = { id: 'gpf-card', kind: 'card', issue: 313, worktreePath };
  const ctx = buildCtx('gpf-card', task, taskDir, { shadowMode: false, dryRun: false, ...config });
  if (plan !== undefined) appendEvent(taskDir, 'PLAN', 'result', { payload: plan });
  return ctx;
}

function writeVerdict(config, headSha, verdict) {
  const dest = path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ head: headSha, ...verdict }));
}

// Records every spawn; `npm run gate` exits `gateExit`, `git rev-parse HEAD` answers `head()`.
function recordingDeps({ head = () => HEAD_A, gateResult = () => ok('') } = {}) {
  const calls = [];
  return {
    calls,
    gateArgvs: () => calls.filter((c) => c.command === 'npm' && c.args[0] === 'run' && c.args[1] === 'gate').map((c) => c.args),
    sleep: async () => {},
    spawnSync: (command, args) => {
      calls.push({ command, args });
      if (command === 'npm' && args[0] === 'run' && args[1] === 'gate') return gateResult();
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${head()}\n`);
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok(`${MAIN_SHA}\n`);
      if (args.includes('rev-list') && args.includes('--count')) return ok('1\n');
      if (args.includes('diff') && args.includes('origin/main...HEAD')) return ok('diff --git a/g.ts b/g.ts\n+x\n');
      return ok('');
    },
  };
}

// PLAN's reply as #312's plan.md asks for it: `new:` kept, duplicates across the two keys.
const PLAN_WITH_FLOWS = {
  plan_markdown: '# plan',
  proof_flows: ['mail-roundtrip', 'new:mail-delete-refresh', 'mail-roundtrip'],
  regression_flows: ['profile-read', 'new:mail-delete-refresh'],
};
const REQUESTED = ['mail-roundtrip', 'mail-delete-refresh', 'profile-read'];

// ---- the requested set ------------------------------------------------------------------------

test('requestedGateFlowSet: proof then regression, new: dropped, none -- dropped, deduped in first-seen order', () => {
  assert.deepEqual(requestedGateFlowSet(PLAN_WITH_FLOWS), REQUESTED);
  assert.deepEqual(requestedGateFlowSet({ proof_flows: ['none — a pure log-format change'], regression_flows: [] }), []);
  // a bare `none` would pass as a flow name: the none filter drops it, not the name check
  assert.deepEqual(requestedGateFlowSet({ proof_flows: ['none'], regression_flows: ['None', 'none-flow'] }), ['none-flow']);
  // the JSON-string shape planFlows (#314) tolerates is read the same way
  assert.deepEqual(requestedGateFlowSet({ proof_flows: '["login-spine","new:x-y"]' }), ['login-spine', 'x-y']);
  // neither key (every card planned before #312), no payload, or a malformed key: nothing
  for (const payload of [{ plan_markdown: '# plan' }, null, undefined, { proof_flows: 'login-spine' }, { proof_flows: ['a', 3] }]) {
    assert.deepEqual(requestedGateFlowSet(payload), [], JSON.stringify(payload));
  }
  // a name the product could not read as one flow is never passed on
  assert.deepEqual(requestedGateFlowSet({ proof_flows: ['a,b', 'two words', '', 'ok-flow'] }), ['ok-flow']);
});

// ---- the capability probe ---------------------------------------------------------------------

test('probe: true only when the gate script reads the also-flows flag -- today\'s script, a comment that only names the flag, a longer flag name, and a missing file are all unsupported', () => {
  assert.equal(gateScriptReadsAlsoFlows(VERIFY_GATE_TODAY), false);
  assert.equal(gateScriptReadsAlsoFlows(VERIFY_GATE_SUPPORTED), true);
  assert.equal(gateScriptReadsAlsoFlows(VERIFY_GATE_TODAY.replace("flag('flows')", 'flag("also-flows")')), true);
  assert.equal(gateScriptReadsAlsoFlows('// SPO-WebClient#1183 will add --also-flows=a,b\n' + VERIFY_GATE_TODAY), false);
  assert.equal(gateScriptReadsAlsoFlows(undefined), false);
  // verifier: the exact flag name, not a prefix of a longer one
  assert.equal(gateScriptReadsAlsoFlows(VERIFY_GATE_TODAY + "\n  const x = flag('also-flows-x');"), false);

  assert.equal(worktreeGateTakesAlsoFlows(makeWorktree(VERIFY_GATE_SUPPORTED)), true);
  assert.equal(worktreeGateTakesAlsoFlows(makeWorktree(VERIFY_GATE_TODAY)), false);
  assert.equal(worktreeGateTakesAlsoFlows(makeWorktree(null)), false, 'a missing file is unsupported, never a throw');
  assert.equal(worktreeGateTakesAlsoFlows(undefined), false);
  const unreadable = () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  assert.equal(worktreeGateTakesAlsoFlows('/some/worktree', unreadable), false, 'an unreadable file is unsupported');
  // it reads the WORKTREE's own script, nowhere else
  const seen = [];
  worktreeGateTakesAlsoFlows('/wt/issue-1', (p) => {
    seen.push(p);
    return VERIFY_GATE_SUPPORTED;
  });
  assert.deepEqual(seen, [path.join('/wt/issue-1', 'scripts', 'verify-gate.js')]);
});

// ---- realGate: the three probe outcomes -------------------------------------------------------

test('realGate, supported: argv carries --also-flows from the PLAN payload; a PASS that drove them all -> CI_CHECKS', async () => {
  const config = testConfig();
  const ctx = gateCtx({ plan: PLAN_WITH_FLOWS, config });
  writeVerdict(config, HEAD_A, { verdict: 'PASS', live: { status: 'ran', flows: ['login-spine', ...REQUESTED] } });
  const deps = recordingDeps();

  assert.equal(await realGate(ctx, deps), 'CI_CHECKS');
  assert.deepEqual(deps.gateArgvs(), [['run', 'gate', '--', '--also-flows=mail-roundtrip,mail-delete-refresh,profile-read']]);
  // the request path's own rev-parse runs BEFORE the gate (the positive control for the
  // nothing-requested tests' "no git before the gate" assertion)
  const gateAt = deps.calls.findIndex((c) => c.command === 'npm' && c.args[0] === 'run' && c.args[1] === 'gate');
  assert.ok(deps.calls.slice(0, gateAt).some((c) => c.command === 'git' && c.args.includes('rev-parse')));

  const journal = readJournal(ctx.taskDir);
  const requested = journal.filter((e) => e.event === 'gate-flows-requested');
  assert.equal(requested.length, 1);
  assert.deepEqual(requested[0].flows, REQUESTED);
  assert.equal(requested[0].headSha, HEAD_A);
  assert.ok(!journal.some((e) => e.event === 'gate-flows-unsupported'));
  assert.ok(!journal.some((e) => e.event === 'live-proof-missing'));
});

test('realGate, unsupported: argv unchanged, gate-flows-unsupported names the flows, and a PASS that drove none of them is not parked', async () => {
  const config = testConfig();
  const ctx = gateCtx({ gateSource: VERIFY_GATE_TODAY, plan: PLAN_WITH_FLOWS, config });
  writeVerdict(config, HEAD_A, {
    verdict: 'PASS',
    live: { status: 'skipped', why: 'nothing in this diff is observable over the wire', required: [] },
  });
  const deps = recordingDeps();

  assert.equal(await realGate(ctx, deps), 'CI_CHECKS');
  assert.deepEqual(deps.gateArgvs(), [['run', 'gate']]);
  const gateAt = deps.calls.findIndex((c) => c.command === 'npm' && c.args[0] === 'run' && c.args[1] === 'gate');
  assert.ok(!deps.calls.slice(0, gateAt).some((c) => c.command === 'git'), 'an unsupported worktree spawns no git before `npm run gate`');

  const journal = readJournal(ctx.taskDir);
  const unsupported = journal.filter((e) => e.event === 'gate-flows-unsupported');
  assert.equal(unsupported.length, 1);
  assert.deepEqual(unsupported[0].flows, REQUESTED);
  assert.ok(!journal.some((e) => e.event === 'gate-flows-requested'));
  assert.ok(!journal.some((e) => e.event === 'live-proof-missing'));
});

test('realGate, supported: a PASS verdict missing a requested flow parks live-proof-missing naming it', async () => {
  const config = testConfig();
  const ctx = gateCtx({ plan: PLAN_WITH_FLOWS, config });
  writeVerdict(config, HEAD_A, { verdict: 'PASS', live: { status: 'ran', flows: ['login-spine', 'mail-roundtrip', 'profile-read'] } });
  const deps = recordingDeps();

  await assert.rejects(
    () => realGate(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'live-proof-missing' &&
      JSON.stringify(err.detail.missing) === JSON.stringify(['mail-delete-refresh']) &&
      err.detail.headSha === HEAD_A &&
      err.detail.exitFrom === 0
  );
  const event = readJournal(ctx.taskDir).find((e) => e.event === 'live-proof-missing');
  assert.ok(event, 'the park is journalled');
  assert.deepEqual(event.missing, ['mail-delete-refresh']);
  assert.deepEqual(event.requested, REQUESTED);
});

// A skipped (nothing routed), unknown, or absent live block drove none of the requested flows.
for (const [label, verdict] of [
  ['skipped with nothing required', { verdict: 'PASS', live: { status: 'skipped', why: 'nothing routed', required: [] } }],
  ['unknown', { verdict: 'PASS', live: { status: 'unknown', why: 'no gate artifact was recorded for this run' } }],
  ['absent (no live key)', { verdict: 'PASS' }],
  // verifier: only `status: 'ran'` drives anything -- a `flows` list on any other status is not proof
  ['skipped yet carrying a flows list', { verdict: 'PASS', live: { status: 'skipped', required: [], flows: REQUESTED } }],
]) {
  test(`realGate, supported: a PASS whose live block is ${label} parks live-proof-missing naming every requested flow`, async () => {
    const config = testConfig();
    const ctx = gateCtx({ plan: PLAN_WITH_FLOWS, config });
    writeVerdict(config, HEAD_A, verdict);
    await assert.rejects(
      () => realGate(ctx, recordingDeps()),
      (err) => err instanceof ParkSignal && err.reason === 'live-proof-missing' && JSON.stringify(err.detail.missing) === JSON.stringify(REQUESTED)
    );
  });
}

test('realGate, supported: a PASS whose live stage was routed but not driven keeps gate-live-not-driven -- it fires before live-proof-missing', async () => {
  const config = testConfig();
  const ctx = gateCtx({ plan: PLAN_WITH_FLOWS, config });
  writeVerdict(config, HEAD_A, {
    verdict: 'PASS',
    live: { status: 'skipped', why: '--live was never supplied; routed flows: mail-roundtrip', required: ['mail-roundtrip'] },
  });
  await assert.rejects(() => realGate(ctx, recordingDeps()), (err) => err instanceof ParkSignal && err.reason === 'gate-live-not-driven');
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'live-proof-missing'));
});

test('realGate, supported: the exit-3 WORKER DIED recovery applies the same check (exitFrom: 3)', async () => {
  const config = testConfig();
  const ctx = gateCtx({ plan: PLAN_WITH_FLOWS, config });
  const jobId = 'job-00000000000313-aaaaaa';
  fs.mkdirSync(path.join(config.spoBenchDir, 'done'), { recursive: true });
  fs.writeFileSync(path.join(config.spoBenchDir, 'done', `${jobId}.json`), JSON.stringify({ id: jobId, verdict: 'PASS' }));
  writeVerdict(config, HEAD_A, { verdict: 'PASS', jobId, live: { status: 'ran', flows: ['mail-roundtrip'] } });
  const deps = recordingDeps({
    gateResult: () => ({
      status: 3,
      stdout: `job ${jobId} queued (ref, position 1)\n`,
      stderr: `WORKER DIED while job ${jobId} was pending: heartbeat stale\n`,
      signal: null,
    }),
  });
  await assert.rejects(
    () => realGate(ctx, deps),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'live-proof-missing' &&
      err.detail.exitFrom === 3 &&
      JSON.stringify(err.detail.missing) === JSON.stringify(['mail-delete-refresh', 'profile-read'])
  );
});

// ---- cards that request nothing take the unchanged path ---------------------------------------

for (const [label, plan] of [
  ['a `none —` card', { plan_markdown: '# plan', proof_flows: ['none — only a log line changes'], regression_flows: [] }],
  ['a card with neither key', { plan_markdown: '# plan', check_commands: ['npm test'] }],
  ['a card with no PLAN result at all', undefined],
]) {
  test(`realGate: ${label} is gated exactly as before -- argv unchanged, no flow event, a PASS driving nothing -> CI_CHECKS`, async () => {
    const config = testConfig();
    const ctx = gateCtx({ plan, config }); // a SUPPORTED worktree: nothing to ask is still nothing
    writeVerdict(config, HEAD_A, { verdict: 'PASS', live: { status: 'skipped', why: 'nothing routed', required: [] } });
    const deps = recordingDeps();

    assert.equal(await realGate(ctx, deps), 'CI_CHECKS');
    assert.deepEqual(deps.gateArgvs(), [['run', 'gate']]);
    // verifier: nothing to ask spawns nothing new before the gate (the request path's rev-parse)
    const gateAt = deps.calls.findIndex((c) => c.command === 'npm' && c.args[0] === 'run' && c.args[1] === 'gate');
    assert.ok(gateAt >= 0);
    assert.ok(!deps.calls.slice(0, gateAt).some((c) => c.command === 'git'), 'no git spawn precedes `npm run gate`');
    const events = readJournal(ctx.taskDir).map((e) => e.event);
    for (const name of ['gate-flows-requested', 'gate-flows-unsupported', 'live-proof-missing']) {
      assert.ok(!events.includes(name), `${name} must not be journalled`);
    }
  });
}

// ---- gate-report.md's `Requested flows:` line -------------------------------------------------

function reportLine(taskDir) {
  return fs
    .readFileSync(gateReportPath(taskDir), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('Requested flows:'));
}

test('gate-report.md: the requested flows reach it only in the supported case, and only for the sha they were requested for', async () => {
  // supported: realGate at HEAD_A, then VALIDATE's inputs for HEAD_A
  const config = testConfig();
  const ctx = gateCtx({ plan: PLAN_WITH_FLOWS, config });
  writeVerdict(config, HEAD_A, { verdict: 'PASS', live: { status: 'ran', flows: REQUESTED } });
  let head = HEAD_A;
  const deps = recordingDeps({ head: () => head });
  assert.equal(await realGate(ctx, deps), 'CI_CHECKS');
  assert.ok(prepareJudgeInputs(ctx, deps, { forState: 'VALIDATE' }).gateReportProduced);
  assert.deepEqual(reportLine(ctx.taskDir), ['Requested flows: mail-roundtrip, mail-delete-refresh, profile-read']);

  // stale: REJECT -> IMPLEMENT committed HEAD_B, and nothing requested flows for HEAD_B -- the
  // HEAD_A event must not describe HEAD_B's verdict
  head = HEAD_B;
  writeVerdict(config, HEAD_B, { verdict: 'PASS', live: { status: 'ran', flows: REQUESTED } });
  assert.ok(prepareJudgeInputs(ctx, deps, { forState: 'VALIDATE' }).gateReportProduced);
  assert.deepEqual(reportLine(ctx.taskDir), [NO_REQUESTED_FLOWS]);
  assert.equal(gateRequestedFlowsFor(ctx.taskDir, HEAD_B), undefined);
  assert.deepEqual(gateRequestedFlowsFor(ctx.taskDir, HEAD_A), REQUESTED);

  // unsupported: the same flows declared, nothing asked -> the none line
  const config2 = testConfig();
  const ctx2 = gateCtx({ gateSource: VERIFY_GATE_TODAY, plan: PLAN_WITH_FLOWS, config: config2 });
  writeVerdict(config2, HEAD_A, { verdict: 'PASS', live: { status: 'skipped', why: 'nothing routed', required: [] } });
  const deps2 = recordingDeps();
  assert.equal(await realGate(ctx2, deps2), 'CI_CHECKS');
  assert.ok(prepareJudgeInputs(ctx2, deps2, { forState: 'VALIDATE' }).gateReportProduced);
  assert.deepEqual(reportLine(ctx2.taskDir), [NO_REQUESTED_FLOWS]);
});

test('gateRequestedFlowsFor: the LAST event for the sha wins; no sha, no journal, or a malformed event -> undefined', () => {
  const taskDir = mkTmp('spo-gpf-events-');
  assert.equal(gateRequestedFlowsFor(taskDir, HEAD_A), undefined);
  appendEvent(taskDir, 'GATE', 'gate-flows-requested', { flows: ['old-flow'], headSha: HEAD_A });
  appendEvent(taskDir, 'GATE', 'gate-flows-requested', { flows: ['other'], headSha: HEAD_B });
  appendEvent(taskDir, 'GATE', 'gate-flows-requested', { flows: ['new-flow'], headSha: HEAD_A });
  assert.deepEqual(gateRequestedFlowsFor(taskDir, HEAD_A), ['new-flow']);
  assert.equal(gateRequestedFlowsFor(taskDir, null), undefined);
  appendEvent(taskDir, 'GATE', 'gate-flows-requested', { flows: 'new-flow', headSha: HEAD_A });
  assert.equal(gateRequestedFlowsFor(taskDir, HEAD_A), undefined);
});

// ---- the park reason's registration -----------------------------------------------------------

test('live-proof-missing: terminal, off TRANSIENT_RETRY_REASONS, not plan-invalidating, resumable with its own continue line', () => {
  assert.ok(TERMINAL_PARK_REASONS.has('live-proof-missing'));
  assert.ok(!TRANSIENT_RETRY_REASONS.has('live-proof-missing'));
  assert.equal(isTransientRetryReason('live-proof-missing'), false);
  assert.ok(RESUMABLE_PARK_REASONS.has('live-proof-missing'));

  // PLAN_INVALIDATING_PARK_REASONS is module-private: read its literal off the source
  const src = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'state-machine.js'), 'utf8');
  const start = src.indexOf('const PLAN_INVALIDATING_PARK_REASONS = new Set([');
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf(']);', start));
  assert.ok(!body.includes("'live-proof-missing'"), 'a retry must be free to reuse the plan');
  assert.ok(body.includes("'plan-invalid'"), 'sanity: the slice is the set literal');

  const line = buildContinueLine('live-proof-missing', 'issue-1', 42);
  assert.match(line, /did not drive the `missing` flows/);
  assert.match(line, /reply "continue" to re-gate `claude-pipe\/issue-1`/);
  assert.doesNotMatch(line, /merge commit/);
});
