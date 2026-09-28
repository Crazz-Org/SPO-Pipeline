'use strict';
// SPO-Pipeline#307 -- an exit-1 gate trusts `verdicts/<headSha>.json` only when THIS job wrote it.
//
// That file is keyed by sha, not by job, and the bench rewrites it only for an attesting verdict
// (PASS/FAIL/BLOCKED/STALE). A same-sha re-gate that ends ENVIRONMENT/DIRTY/ABANDONED/INTERRUPTED
// writes nothing there, so the file still holds the EARLIER job's FAIL -- and before #307 the
// exit-1 path read it as this run's answer, routed to DIAGNOSE, and never asked
// `done/<jobId>.json` what actually happened. #305 made same-sha re-gates routine (an out-of-scope
// DIAGNOSE answer from GATE re-gates the same head once), and the re-gate that most needs the
// non-attesting route -- the environment is still down -- is exactly the one that was misrouted.
//
// The rule is `isGateVerdictFreshForJob` (orchestrator/steps/scripted.js), shared with the exit-3
// recovery's pre-existing `verdict.jobId === jobId` check. A stale verdict is routed exactly like
// "no verdict file" and journalled `gate-verdict-stale`.
//
// Same conventions as test/gate-main-moved.test.js: every spawn is a fake injected via
// deps.spawnSync, config.spoBenchDir is a fresh tmp dir, outcomes are asserted on ParkSignals,
// return values and journalled events.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Must land before the orchestrator requires below -- see test/no-real-spawn.js.
require('./no-real-spawn');
const { realGate } = require('../orchestrator/steps/scripted');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { ParkSignal } = require('../orchestrator/park-signal');
const { mkTmp, fakeExecDeps } = require('./helpers');

const HEAD = '307a307a307a307a307a307a307a307a307a307a';
const JOB_A = 'job-01790000000001-aaaaaa'; // the EARLIER job, whose FAIL is still on file
const JOB_B = 'job-01790000000002-bbbbbb'; // THIS run's job

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// `cli.ts`'s own deposit line and report line -- what `parseGateJobId` reads.
function gateStdout(jobId) {
  return `job ${jobId} queued (ref, position 1)\nreport will land in <spoBenchDir>/done/${jobId}.json\n`;
}

function gateCtx() {
  const config = {
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-gvf-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-gvf-bench-'),
    stepDeadlineMs: 30000,
    mainMovedRegateBudget: 1,
    // config.js's own defaults for the late-verdict re-read (card #307's write-order race).
    gateLateVerdictMaxPolls: 3,
    gateLateVerdictPollIntervalMs: 1000,
  };
  const worktreePath = mkTmp('spo-gvf-wt-');
  const task = { id: 'gvf-card', kind: 'card', issue: 307, worktreePath };
  return buildCtx('gvf-card', task, mkTmp('spo-gvf-taskdir-'), { shadowMode: false, dryRun: false, ...config });
}

function verdictPath(ctx) {
  return path.join(ctx.config.spoBenchDir, 'verdicts', `${HEAD}.json`);
}

// An earlier job's real FAIL (with baseMain: the shape that routes straight to DIAGNOSE).
function writeFailVerdict(ctx, extra = { jobId: JOB_A }) {
  writeJson(verdictPath(ctx), { head: HEAD, verdict: 'FAIL', baseMain: 'b0b0b0b0', ...extra });
}

function writeDone(ctx, jobId, verdict, detail = null) {
  writeJson(path.join(ctx.config.spoBenchDir, 'done', `${jobId}.json`), { id: jobId, verdict, detail });
}

function depsFor({ stdout, calls = [] }) {
  return {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.includes('run') && args.includes('gate')) return { status: 1, stdout, stderr: '', signal: null };
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(`${HEAD}\n`);
      return ok('');
    },
  };
}

// ---- the card's Done-when pair ------------------------------------------------------------------

test('#307: FAIL verdict from job A on file, this run is job B and done/B.json says ENVIRONMENT -> PARKED gate-environment, never DIAGNOSE', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx);
  writeDone(ctx, JOB_B, 'ENVIRONMENT', 'git fetch failed while fetching ' + HEAD);

  await assert.rejects(
    () => realGate(ctx, depsFor({ stdout: gateStdout(JOB_B) })),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'gate-environment' &&
      err.detail.jobId === JOB_B &&
      err.detail.headSha === HEAD &&
      err.detail.exitFrom === 1
  );

  const journal = readJournal(ctx.taskDir);
  const stale = journal.filter((e) => e.event === 'gate-verdict-stale');
  assert.equal(stale.length, 1, 'the skipped verdict is journalled, once');
  assert.deepEqual(
    { headSha: stale[0].headSha, verdictJobId: stale[0].verdictJobId, jobId: stale[0].jobId },
    { headSha: HEAD, verdictJobId: JOB_A, jobId: JOB_B }
  );
  assert.ok(!journal.some((e) => e.event === 'gate-verdict'), 'the stale FAIL must never be routed as a verdict');
  assert.ok(!journal.some((e) => e.event === 'gate-verdict-unreadable'), 'a stale verdict parsed fine -- it is not an unreadable one');
  const read = journal.find((e) => e.event === 'gate-job-report-read');
  assert.equal(read.jobId, JOB_B);
  assert.equal(read.verdict, 'ENVIRONMENT');
});

test('#307 control: the same FAIL verdict naming job B (this run) -> DIAGNOSE, as before', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx, { jobId: JOB_B });
  // Present but irrelevant: a fresh verdict is the answer; done/ is never consulted for routing.
  writeDone(ctx, JOB_B, 'FAIL', 'verify-gate exited 1 (FAIL)');

  const next = await realGate(ctx, depsFor({ stdout: gateStdout(JOB_B) }));
  assert.equal(next, 'DIAGNOSE');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'gate-verdict-stale'));
  assert.ok(!journal.some((e) => e.event === 'gate-job-report-read'), 'a fresh verdict never falls through to done/');
  const evt = journal.find((e) => e.event === 'gate-verdict');
  assert.equal(evt.verdict.jobId, JOB_B);
});

// ---- the other non-attesting verdicts reach their own reasons through the same fall-through ---

for (const [doneVerdict, reason] of [
  ['DIRTY', 'gate-worker-dirty-checkout'],
  ['ABANDONED', 'gate-abandoned'],
  ['INTERRUPTED', 'gate-interrupted'],
]) {
  test(`#307: stale FAIL on file, done/B.json says ${doneVerdict} -> PARKED ${reason}`, async () => {
    const ctx = gateCtx();
    writeFailVerdict(ctx);
    writeDone(ctx, JOB_B, doneVerdict);

    await assert.rejects(
      () => realGate(ctx, depsFor({ stdout: gateStdout(JOB_B) })),
      (err) => err instanceof ParkSignal && err.reason === reason && err.detail.jobId === JOB_B && err.detail.exitFrom === 1
    );
    assert.ok(readJournal(ctx.taskDir).some((e) => e.event === 'gate-verdict-stale'));
  });
}

test('#307: stale FAIL on file and no done/B.json yet -> gate-non-attesting, exactly like "no verdict file" (verdictDirExists true)', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx);

  await assert.rejects(
    () => realGate(ctx, depsFor({ stdout: gateStdout(JOB_B) })),
    (err) =>
      err instanceof ParkSignal &&
      err.reason === 'gate-non-attesting' &&
      err.detail.headSha === HEAD &&
      err.detail.verdictDirExists === true
  );
  const read = readJournal(ctx.taskDir).find((e) => e.event === 'gate-job-report-read');
  assert.equal(read.skipped, 'missing');
});

// ---- a missing job id, on either side, is "not fresh" (see isGateVerdictFreshForJob's header for
//      the measurement: 1214/1214 bench verdicts carry jobId, 37/37 real exit-1 logs name a job) --

test('#307: a verdict with NO jobId field is not fresh -> falls through to done/B.json (ENVIRONMENT -> gate-environment), journalled with verdictJobId null', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx, {});
  writeDone(ctx, JOB_B, 'ENVIRONMENT');

  await assert.rejects(
    () => realGate(ctx, depsFor({ stdout: gateStdout(JOB_B) })),
    (err) => err instanceof ParkSignal && err.reason === 'gate-environment'
  );
  const stale = readJournal(ctx.taskDir).find((e) => e.event === 'gate-verdict-stale');
  assert.equal(stale.verdictJobId, null);
  assert.equal(stale.jobId, JOB_B);
});

test('#307: a non-string jobId (malformed file) is not fresh either -- journalled as null, never echoed', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx, { jobId: 42 });
  writeDone(ctx, JOB_B, 'ENVIRONMENT');

  await assert.rejects(
    () => realGate(ctx, depsFor({ stdout: gateStdout(JOB_B) })),
    (err) => err instanceof ParkSignal && err.reason === 'gate-environment'
  );
  assert.equal(readJournal(ctx.taskDir).find((e) => e.event === 'gate-verdict-stale').verdictJobId, null);
});

test('#307: exit 1 with NO job id on stdout (no deposit happened) does not trust the verdict on file -> gate-non-attesting', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx);

  await assert.rejects(
    () => realGate(ctx, depsFor({ stdout: 'not inside a git worktree\n' })),
    (err) => err instanceof ParkSignal && err.reason === 'gate-non-attesting'
  );
  const journal = readJournal(ctx.taskDir);
  const stale = journal.find((e) => e.event === 'gate-verdict-stale');
  assert.equal(stale.jobId, null);
  assert.equal(stale.verdictJobId, JOB_A);
  assert.equal(journal.find((e) => e.event === 'gate-job-report-read').skipped, 'no-job-id');
});

test('#307: a verdict whose jobId is null and a stdout with no job id are NOT "equal" -- null === null never proves freshness', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx, { jobId: null });

  await assert.rejects(
    () => realGate(ctx, depsFor({ stdout: '' })),
    (err) => err instanceof ParkSignal && err.reason === 'gate-non-attesting'
  );
});

// Strict equality, not loose: `42 == '42'` is true, and parseGateJobId always returns a string.
test('#307: freshness is STRICT equality -- a numeric jobId 42 on file is not the job "42" this run printed', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx, { jobId: 42 });

  await assert.rejects(
    () => realGate(ctx, depsFor({ stdout: 'job 42 queued (ref, position 1)\n' })),
    (err) => err instanceof ParkSignal && err.reason === 'gate-non-attesting'
  );
  assert.equal(readJournal(ctx.taskDir).find((e) => e.event === 'gate-verdict-stale').jobId, '42');
});

// ---- the write-order race: worker.ts writes done/<jobId>.json BEFORE verdicts/<sha>.json, and
//      cli.ts's wait() returns on done/ alone -- an attesting job's own verdict can land after exit
//      1 is read. awaitFreshGateVerdict re-reads it, bounded (config.gateLateVerdictMaxPolls). ------

// Counts sleeps, runs `onSleep` on each, and refuses to go past a hard ceiling so an unbounded
// loop fails fast instead of hanging the suite.
function countingSleep(onSleep = () => {}) {
  const box = { slept: 0, ms: [] };
  box.sleep = async (ms) => {
    box.slept += 1;
    box.ms.push(ms);
    if (box.slept > 10) throw new Error('awaitFreshGateVerdict is not bounded');
    onSleep(box.slept);
  };
  return box;
}

test('#307 race: stale FAIL (job A) on file, done/B.json = FAIL, B\'s own verdict lands on the first re-read -> DIAGNOSE on B\'s verdict', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx);
  writeDone(ctx, JOB_B, 'FAIL', 'verify-gate exited 1 (FAIL)');
  const deps = depsFor({ stdout: gateStdout(JOB_B) });
  const s = countingSleep(() => writeFailVerdict(ctx, { jobId: JOB_B }));
  deps.sleep = s.sleep;

  assert.equal(await realGate(ctx, deps), 'DIAGNOSE');
  assert.equal(s.slept, 1);
  assert.deepEqual(s.ms, [1000], 'sleeps config.gateLateVerdictPollIntervalMs');

  const journal = readJournal(ctx.taskDir);
  const late = journal.find((e) => e.event === 'gate-verdict-late');
  assert.deepEqual(
    { headSha: late.headSha, jobId: late.jobId, doneVerdict: late.doneVerdict, polls: late.polls, found: late.found },
    { headSha: HEAD, jobId: JOB_B, doneVerdict: 'FAIL', polls: 1, found: true }
  );
  assert.equal(journal.find((e) => e.event === 'gate-verdict').verdict.jobId, JOB_B, "routed on B's verdict, never A's");
});

test('#307 race: the same with no verdict file at all before the re-read (the fresh-sha case) -> DIAGNOSE', async () => {
  const ctx = gateCtx();
  writeDone(ctx, JOB_B, 'FAIL');
  const deps = depsFor({ stdout: gateStdout(JOB_B) });
  const s = countingSleep((n) => {
    if (n === 2) writeFailVerdict(ctx, { jobId: JOB_B });
  });
  deps.sleep = s.sleep;

  assert.equal(await realGate(ctx, deps), 'DIAGNOSE');
  assert.equal(s.slept, 2);
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'gate-verdict-stale'), 'no file on disk is not a stale file');
});

test('#307 race: done/B.json = FAIL but B\'s verdict never lands (A\'s stale FAIL stays) -> exactly gateLateVerdictMaxPolls sleeps, then gate-non-attesting', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx);
  writeDone(ctx, JOB_B, 'FAIL');
  const deps = depsFor({ stdout: gateStdout(JOB_B) });
  const s = countingSleep();
  deps.sleep = s.sleep;

  await assert.rejects(() => realGate(ctx, deps), (err) => err instanceof ParkSignal && err.reason === 'gate-non-attesting');
  assert.equal(s.slept, 3);
  const late = readJournal(ctx.taskDir).find((e) => e.event === 'gate-verdict-late');
  assert.equal(late.found, false);
  assert.equal(late.polls, 3);
});

test('#307 race: the bound is config.gateLateVerdictMaxPolls, not a literal -- 1 poll sleeps once', async () => {
  const ctx = gateCtx();
  ctx.config.gateLateVerdictMaxPolls = 1;
  writeDone(ctx, JOB_B, 'FAIL');
  const deps = depsFor({ stdout: gateStdout(JOB_B) });
  const s = countingSleep();
  deps.sleep = s.sleep;

  await assert.rejects(() => realGate(ctx, deps), (err) => err instanceof ParkSignal && err.reason === 'gate-non-attesting');
  assert.equal(s.slept, 1);
});

test('#307 race: done/B.json = ENVIRONMENT never waits -- the bench never writes a verdict for it', async () => {
  const ctx = gateCtx();
  writeFailVerdict(ctx);
  writeDone(ctx, JOB_B, 'ENVIRONMENT');
  const deps = depsFor({ stdout: gateStdout(JOB_B) });
  const s = countingSleep();
  deps.sleep = s.sleep;

  await assert.rejects(() => realGate(ctx, deps), (err) => err instanceof ParkSignal && err.reason === 'gate-environment');
  assert.equal(s.slept, 0);
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'gate-verdict-late'));
});

test('#307 race: a done report naming a verdict that is neither attesting nor one of the four (LEASED) never waits', async () => {
  const ctx = gateCtx();
  writeDone(ctx, JOB_B, 'LEASED');
  const deps = depsFor({ stdout: gateStdout(JOB_B) });
  const s = countingSleep();
  deps.sleep = s.sleep;

  await assert.rejects(() => realGate(ctx, deps), (err) => err instanceof ParkSignal && err.reason === 'gate-non-attesting');
  assert.equal(s.slept, 0);
});

// An unparsable verdict file is still a failed LOOKUP (-> DIAGNOSE), unchanged by #307: the stale
// branch only ever applies to a verdict that parsed.
test('#307 regression: an unparsable verdict file still routes DIAGNOSE via gate-verdict-unreadable, never gate-verdict-stale', async () => {
  const ctx = gateCtx();
  fs.mkdirSync(path.dirname(verdictPath(ctx)), { recursive: true });
  fs.writeFileSync(verdictPath(ctx), '{"verdict":"FA');

  const next = await realGate(ctx, depsFor({ stdout: gateStdout(JOB_B) }));
  assert.equal(next, 'DIAGNOSE');
  const journal = readJournal(ctx.taskDir);
  assert.ok(journal.some((e) => e.event === 'gate-verdict-unreadable'));
  assert.ok(!journal.some((e) => e.event === 'gate-verdict-stale'));
});

// ---- the #305 interaction: GATE -> out-of-scope DIAGNOSE -> re-gate on the same sha -------------
//
// Driven through the real-mode handlers the dispatch calls (HANDLERS.GATE is handleGate ->
// settleOutOfScopeRecheck(realGate), HANDLERS.DIAGNOSE is the #305 re-check route), with
// `ctx.cameFrom` set the way runTask's loop sets it. Not through runTask itself: a real-mode run can
// only be resumed at CHECK/IMPLEMENT/MERGE (resumeValidationError), so reaching GATE twice through
// runTask would mean faking CHECK and PUSH_PR's whole git/gh surface for nothing this card touches.

const OOS = {
  ok: true,
  rootCause: "out-of-scope: the bench gate failed on a live-server timeout, not on this card's code",
  category: null,
  suggestedFix: null,
};

test('#305 x #307: FAIL (job A) -> out-of-scope DIAGNOSE -> re-gate on the same sha ends ENVIRONMENT (job B) with A\'s FAIL still on file -> gate-environment, not DIAGNOSE', async () => {
  const accountsDir = mkTmp('spo-gvf-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  const worktreePath = mkTmp('spo-gvf-oos-wt-');
  const spoBenchDir = mkTmp('spo-gvf-oos-bench-');
  const run = { gateStdout: gateStdout(JOB_A) };
  const spawnSync = (command, args) => {
    if (command === 'npm' && args.includes('run') && args.includes('gate')) {
      return { status: 1, stdout: run.gateStdout, stderr: '', signal: null };
    }
    if (command === 'git' && args.includes('rev-parse') && args.includes('HEAD')) return ok(`${HEAD}\n`);
    if (command === 'gh') return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/307#issuecomment-1\n');
    return ok('');
  };
  const task = {
    id: 'gvf-oos',
    kind: 'card',
    issue: 1033,
    worktreePath,
    llm: { DIAGNOSE: { model: 'sonnet', effort: 'low', promptText: 'diagnose it' } },
  };
  const ctx = buildCtx('gvf-oos', task, mkTmp('spo-gvf-oos-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    real: true,
    stepDeadlineMs: 30000,
    diagnoseBudget: 3,
    mainMovedRegateBudget: 1,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-gvf-oos-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir,
    claudeAccountsDir: accountsDir,
    deps: { spawnSync, ...fakeExecDeps(), runLlm: async () => OOS },
  });
  ctx.task.worktreePath = worktreePath;

  // Run 1: job A attests FAIL for HEAD.
  writeJson(path.join(spoBenchDir, 'verdicts', `${HEAD}.json`), { head: HEAD, verdict: 'FAIL', baseMain: 'b0b0b0b0', jobId: JOB_A });
  writeJson(path.join(spoBenchDir, 'done', `${JOB_A}.json`), { id: JOB_A, verdict: 'FAIL', detail: 'REQ_SEARCH_MENU_TOWNS FAIL Request timeout' });
  assert.equal(await HANDLERS.GATE(ctx), 'DIAGNOSE');

  // DIAGNOSE answers out-of-scope: back to GATE on the same head.
  ctx.cameFrom = 'GATE';
  assert.equal(await HANDLERS.DIAGNOSE(ctx), 'GATE');
  assert.equal(ctx.counters.outOfScopeRecheckPending.from, 'GATE');

  // Run 2 on the SAME sha: job B ends ENVIRONMENT, so the bench writes no verdicts/ entry and A's
  // FAIL is still what the file says.
  run.gateStdout = gateStdout(JOB_B);
  writeJson(path.join(spoBenchDir, 'done', `${JOB_B}.json`), { id: JOB_B, verdict: 'ENVIRONMENT', detail: 'planitia DA service did not answer' });
  ctx.cameFrom = 'DIAGNOSE';
  await assert.rejects(
    () => HANDLERS.GATE(ctx),
    (err) => err instanceof ParkSignal && err.reason === 'gate-environment' && err.detail.jobId === JOB_B && err.detail.headSha === HEAD
  );

  const journal = readJournal(ctx.taskDir);
  assert.equal(journal.filter((e) => e.event === 'gate-verdict').length, 1, 'only run 1 routed a verdict');
  const stale = journal.find((e) => e.event === 'gate-verdict-stale');
  assert.deepEqual({ verdictJobId: stale.verdictJobId, jobId: stale.jobId }, { verdictJobId: JOB_A, jobId: JOB_B });
});
