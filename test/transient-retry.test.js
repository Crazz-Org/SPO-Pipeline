'use strict';
// Tests for action 4.4: the bounded auto-retry for a closed, named allowlist of park reasons
// (state-machine.js's TRANSIENT_RETRY_REASONS / finalizePark) and the two things that support it
// -- park-loop.js's reEnqueueTask (now also stripping transientRetries/notBefore) and
// state-machine.js's takeNextTask (now skipping a queue entry whose notBefore is still in the
// future). Same conventions as test/park-loop.test.js and test/orphan-scan.test.js: tmp queue/
// journal dirs, an injected deps.spawnSync recording every call, nothing here touches a real
// git/npm/gh process. finalizePark is exercised directly (buildCtx + finalizePark), the same way
// test/park-loop.test.js's own "dirty worktree" test calls it -- there is no need to walk a full
// handler chain to prove what a park reason does once it reaches finalizePark.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- the network killswitch, and why it is the FIRST require in this file ----------------------
//
// This file is where the 140-fabricated-park-comments incident was first found and first fixed:
// the first cut of this file called finalizePark in REAL mode with no injected deps at all for
// its ordinary-park cases, `deps` defaulted to `{}` (buildCtx), command-timeout.js's armTimeout
// fell back to the real `spawnSync`, and postParkComment ran an actual `gh issue comment 1 --repo
// Crazz-Org/SPO-WebClient --body-file <park-comment.md>` with the pool's live credentials -- 140
// times in one hour of mutation testing. The fix here was later generalised, module and all, into
// test/no-real-spawn.js (its header carries the full incident writeup plus the repo-wide
// measurement that found this class in two more files) once action 5.0 asked "is this file-local
// patch the only one, or the whole class?" -- it was one of two. Every test below still injects
// its own deps.spawnSync (buildParkCtx defaults to one); this require is only the backstop that
// turns "somebody forgot" from a live GitHub write into a red test.
require('./no-real-spawn');

const { buildCtx, finalizePark, takeNextTask, drainQueueOnce } = require('../orchestrator/state-machine');
const { reEnqueueTask, unparkScan } = require('../orchestrator/park-loop');
const { writeState } = require('../orchestrator/journal');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

// transientRetryBudget/transientRetryDelaysMs are hardcoded here rather than imported from
// orchestrator/config.js -- same reasoning test/park-loop.test.js's own testConfig() already
// applies to every other budget/timeout field: a test pinned to the ACTION'S OWN stated numbers
// (2 retries, 1 min then 5 min) catches a regression in config.js's defaults instead of silently
// tracking whatever they drift to.
function testConfig(overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-transient-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-transient-bench-'),
    stepDeadlineMs: 30000,
    claudeAccountsDir: mkTmp('spo-transient-accts-'),
    transientRetryBudget: 2,
    transientRetryDelaysMs: [60000, 300000],
    queueDir: mkTmp('spo-transient-queue-'),
    ...overrides,
  };
}

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function queuedFiles(queueDir) {
  return fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')) : [];
}

// Builds a ctx via the real buildCtx (so it carries every field finalizePark reads: config,
// deps, task, id, taskDir) and makes sure taskDir exists on disk first -- appendEvent only ever
// appends to an existing directory, it never creates one.
//
// taskDir is nested inside a fresh journalRoot rather than sitting directly in os.tmpdir(),
// because finalizePark's daemon-level feed writes to `path.dirname(ctx.taskDir)/daemon.jsonl`
// (its own comment: "taskDir is join(journalRoot, id) by construction"). A flat taskDir would
// both scribble on a shared /tmp/daemon.jsonl and make "the retry path writes no daemon `parked`
// line" untestable -- see daemonEvents() below, which is what pins that.
// `deps` defaults to a stub spawnSync rather than to `{}`. `{}` is what production passes, and
// production means the REAL `gh`/`git`/`npm` -- see the killswitch at the top of this file for
// what that cost. A test that does not care what was spawned still must not spawn anything.
function buildParkCtx({ id = 'card-1', task, config, deps } = {}) {
  const journalRoot = mkTmp('spo-transient-journal-');
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  const effectiveDeps = deps || { spawnSync: () => ok('') };
  return buildCtx(id, { id, kind: 'card', issue: 1, title: 'x', ...task }, taskDir, { ...config, deps: effectiveDeps });
}

// Every daemon.jsonl line finalizePark wrote for this ctx (none at all is the normal case).
function daemonEvents(ctx) {
  const p = path.join(path.dirname(ctx.taskDir), 'daemon.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readState(taskDir) {
  const p = path.join(taskDir, 'state.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// ---- 1 & 2: claim-rate-limited, first and second occurrence -----------------------------------

test('finalizePark: claim-rate-limited, budget unused -> queued for retry (not parked), transientRetries:1, delayMs 60000', () => {
  const calls = [];
  const deps = { spawnSync: (command, args) => (calls.push({ command, args: [...args] }), ok('')) };
  const config = testConfig();
  const ctx = buildParkCtx({ config, deps });

  finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', { exit: 4 });

  // Never parked: no state.json write at all -- finalizePark returns before ever calling
  // writeState/writeReport for this path.
  assert.equal(readState(ctx.taskDir), null);
  assert.ok(!fs.existsSync(path.join(ctx.taskDir, 'report.md')));

  // No board move, no park comment -- nothing below the early return ever spawns anything.
  assert.deepEqual(calls, []);

  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1);
  assert.match(queued[0], /^0000-retry-/);
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.equal(requeued.id, 'card-1');
  assert.equal(requeued.transientRetries, 1);
  assert.ok(Date.parse(requeued.notBefore) > Date.now(), 'notBefore must be in the future');
  assert.ok(Date.parse(requeued.notBefore) <= Date.now() + 60000 + 5000, 'notBefore must reflect the 60s delay, not the 300s one');

  const events = readJournal(ctx.taskDir);
  assert.ok(events.some((e) => e.event === 'parked' && e.reason === 'claim-rate-limited'), 'the parked event still fires first');
  const retryEvt = events.find((e) => e.event === 'transient-retry');
  assert.ok(retryEvt);
  assert.equal(retryEvt.reason, 'claim-rate-limited');
  assert.equal(retryEvt.attempt, 1);
  assert.equal(retryEvt.delayMs, 60000);
  assert.equal(retryEvt.notBefore, requeued.notBefore);
});

test('finalizePark: claim-rate-limited, second occurrence -> transientRetries:2, delayMs 300000', () => {
  const config = testConfig();
  const ctx = buildParkCtx({ config, task: { transientRetries: 1 } });

  finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', { exit: 5 });

  assert.equal(readState(ctx.taskDir), null);
  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.equal(requeued.transientRetries, 2);

  const retryEvt = readJournal(ctx.taskDir).find((e) => e.event === 'transient-retry');
  assert.equal(retryEvt.attempt, 2);
  assert.equal(retryEvt.delayMs, 300000);
});

// ---- 3: third occurrence -- budget exhausted -> ordinary park ---------------------------------

test('finalizePark: claim-rate-limited, third occurrence (budget exhausted) -> ordinary park, no new queue file', () => {
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
        return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/1#issuecomment-42\n');
      }
      return ok('');
    },
  };
  const config = testConfig();
  const ctx = buildParkCtx({ config, deps, task: { transientRetries: 2 } });

  finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', { exit: 4 });

  const state = readState(ctx.taskDir);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'claim-rate-limited');
  assert.ok(fs.existsSync(path.join(ctx.taskDir, 'report.md')));

  // No new queue file -- the budget is spent, this is a real park.
  assert.equal(queuedFiles(config.queueDir).length, 0);

  // The ordinary park machinery DID run: a park comment was posted (no worktree -> board move is
  // journalled-skipped rather than spawned, same as every other pre-worktree park in this suite).
  const commentCall = calls.find((c) => c.command === 'gh');
  assert.ok(commentCall, 'expected the ordinary park comment to be posted');

  const events = readJournal(ctx.taskDir);
  assert.ok(!events.some((e) => e.event === 'transient-retry'), 'budget exhausted -- no transient-retry event');
  assert.ok(events.some((e) => e.event === 'park-comment'));
});

// ---- 4: a reason NOT on the allowlist -> ordinary park, no queue file, at budget 0 ------------

for (const reason of ['push-pr-failed', 'plan-invalid']) {
  test(`finalizePark: ${reason} is not on the allowlist -> ordinary park even at budget 0`, () => {
    const config = testConfig();
    const ctx = buildParkCtx({ config });

    finalizePark(ctx, 'PUSH_PR', reason, { step: 'commit' });

    const state = readState(ctx.taskDir);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, reason);
    assert.equal(queuedFiles(config.queueDir).length, 0);
    assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'transient-retry'));
  });
}

// ---- 5: llm-transport-failed:<STEP> is an EXACT-STRING allowlist, not a prefix match ----------

for (const step of ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE']) {
  test(`finalizePark: llm-transport-failed:${step} is eligible for auto-retry`, () => {
    const config = testConfig();
    const ctx = buildParkCtx({ config });

    finalizePark(ctx, step, `llm-transport-failed:${step}`, { kind: 'error' });

    assert.equal(readState(ctx.taskDir), null);
    assert.equal(queuedFiles(config.queueDir).length, 1);
  });
}

// The exact-match claim is load-bearing (C3 shipped a bug behind a loose match on this exact
// reason family) -- a test that only asserts the positives above is worthless without these two
// negatives.
for (const reason of ['llm-transport-failed', 'llm-transport-failed:NOPE']) {
  test(`finalizePark: "${reason}" is NOT eligible -- no prefix/substring match`, () => {
    const config = testConfig();
    const ctx = buildParkCtx({ config });

    finalizePark(ctx, 'PLAN', reason, { kind: 'error' });

    const state = readState(ctx.taskDir);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, reason);
    assert.equal(queuedFiles(config.queueDir).length, 0);
  });
}

// ---- 6: shadow / dry-run never re-enqueues, whatever the reason -------------------------------

for (const [label, modeOverrides] of [
  ['shadow', { shadowMode: true, dryRun: false, real: false }],
  ['dry-run', { shadowMode: false, dryRun: true, real: false }],
]) {
  test(`finalizePark: ${label} mode never auto-retries claim-rate-limited -- ordinary park instead`, () => {
    const config = testConfig(modeOverrides);
    const ctx = buildParkCtx({ config });

    finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', { exit: 4 });

    const state = readState(ctx.taskDir);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, 'claim-rate-limited');
    assert.equal(queuedFiles(config.queueDir).length, 0);
    assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'transient-retry'));
  });
}

// ---- 7: takeNextTask skips a future notBefore, keeps 0000-retry- priority, handles __invalid --

function writeQueueFile(queueDir, name, obj) {
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, name), JSON.stringify(obj, null, 2) + '\n');
}

test('takeNextTask: skips an entry whose notBefore is in the future, takes a later eligible one', () => {
  const queueDir = mkTmp('spo-transient-takenext-queue-');
  const journalRoot = mkTmp('spo-transient-takenext-journal-');
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  // Filename sort would normally prefer the 0000-retry- file first (park-loop.js's own priority
  // comment) -- this proves the notBefore check overrides that ordering when the retry isn't due
  // yet, without disturbing it when it IS due (the next test).
  writeQueueFile(queueDir, '0000-retry-1-scheduled.json', { id: 'scheduled', notBefore: future });
  writeQueueFile(queueDir, '0002-fresh.json', { id: 'fresh' });

  const taken = takeNextTask(queueDir, journalRoot);
  assert.equal(taken.id, 'fresh');
  // The scheduled retry is untouched -- still sitting in queueDir, not moved into journalRoot.
  assert.deepEqual(queuedFiles(queueDir), ['0000-retry-1-scheduled.json']);
  assert.ok(!fs.existsSync(path.join(journalRoot, 'scheduled')));
});

test('takeNextTask: returns null when every entry is scheduled for later', () => {
  const queueDir = mkTmp('spo-transient-takenext-queue-');
  const journalRoot = mkTmp('spo-transient-takenext-journal-');
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  writeQueueFile(queueDir, '0001-a.json', { id: 'a', notBefore: future });
  writeQueueFile(queueDir, '0002-b.json', { id: 'b', notBefore: future });

  assert.equal(takeNextTask(queueDir, journalRoot), null);
  assert.equal(queuedFiles(queueDir).length, 2, 'nothing should have been taken');
});

test('takeNextTask: takes an entry whose notBefore has already passed', () => {
  const queueDir = mkTmp('spo-transient-takenext-queue-');
  const journalRoot = mkTmp('spo-transient-takenext-journal-');
  const past = new Date(Date.now() - 1000).toISOString();
  writeQueueFile(queueDir, '0001-due.json', { id: 'due', notBefore: past });

  const taken = takeNextTask(queueDir, journalRoot);
  assert.equal(taken.id, 'due');
});

test('takeNextTask: a missing or garbage notBefore is eligible now, never "skip forever"', () => {
  const queueDir = mkTmp('spo-transient-takenext-queue-');
  const journalRoot = mkTmp('spo-transient-takenext-journal-');
  writeQueueFile(queueDir, '0001-missing.json', { id: 'missing' }); // no notBefore field at all
  writeQueueFile(queueDir, '0002-garbage.json', { id: 'garbage', notBefore: 'not-a-real-date' });

  const first = takeNextTask(queueDir, journalRoot);
  assert.equal(first.id, 'missing');
  const second = takeNextTask(queueDir, journalRoot);
  assert.equal(second.id, 'garbage');
  assert.equal(takeNextTask(queueDir, journalRoot), null);
});

test('takeNextTask: an unparsable queue file still produces __invalid, taken exactly as before this action', () => {
  const queueDir = mkTmp('spo-transient-takenext-queue-');
  const journalRoot = mkTmp('spo-transient-takenext-journal-');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, '0001-broken.json'), '{ not valid json');

  const taken = takeNextTask(queueDir, journalRoot);
  assert.ok(taken, 'a garbage file must still be taken, not skipped forever');
  assert.equal(taken.task.__invalid, true);
  assert.match(taken.task.rawPreview, /not valid json/);
  // id falls back to the filename stem, same as before this action.
  assert.equal(taken.id, '0001-broken');
});

test('takeNextTask: 0000-retry- priority is preserved when the retry IS eligible', () => {
  const queueDir = mkTmp('spo-transient-takenext-queue-');
  const journalRoot = mkTmp('spo-transient-takenext-journal-');
  const past = new Date(Date.now() - 1000).toISOString();
  writeQueueFile(queueDir, '0002-fresh.json', { id: 'fresh' });
  writeQueueFile(queueDir, '0000-retry-1-x.json', { id: 'x', notBefore: past });

  const taken = takeNextTask(queueDir, journalRoot);
  assert.equal(taken.id, 'x', 'the 0000-retry- entry must still win when it is actually due');
});

// ---- 8: the maintainer retry path strips transientRetries and notBefore -----------------------

test('reEnqueueTask: strips transientRetries and notBefore, restoring the full budget', () => {
  const taskDir = mkTmp('spo-transient-reenqueue-taskdir-');
  const queueDir = mkTmp('spo-transient-reenqueue-queue-');
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id: 'card-9', kind: 'card', issue: 9, transientRetries: 2, notBefore: new Date().toISOString() })
  );

  const file = reEnqueueTask(queueDir, taskDir, 'card-9');
  const requeued = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(requeued.id, 'card-9');
  assert.equal('transientRetries' in requeued, false);
  assert.equal('notBefore' in requeued, false);
});

test('unparkScan: a maintainer "retry" reply on a task previously auto-retried strips transientRetries/notBefore', async () => {
  const journalRoot = mkTmp('spo-transient-unpark-journal-');
  const queueDir = mkTmp('spo-transient-unpark-queue-');
  const taskDir = path.join(journalRoot, 'issue-9');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id: 'issue-9', kind: 'card', issue: 9, transientRetries: 2, notBefore: new Date().toISOString() })
  );
  writeState(taskDir, {
    id: 'issue-9',
    state: 'PARKED',
    reason: 'claim-rate-limited',
    lastState: 'WORKTREE',
    updatedAt: new Date().toISOString(),
  });
  fs.appendFileSync(
    path.join(taskDir, 'journal.jsonl'),
    JSON.stringify({
      ts: new Date().toISOString(),
      state: 'WORKTREE',
      event: 'park-comment',
      commentId: 500,
      body: 'pipeline: reply "retry" (optionally after fixing) to requeue, or "abandon" to close this attempt.',
    }) + '\n'
  );

  const config = testConfig({ queueDir });
  const deps = {
    spawnSync: (cmd, args) => {
      if (args[0] === 'api' && String(args[1]).endsWith('/collaborators')) return ok(JSON.stringify([{ login: 'Crazz-E' }]));
      if (args[0] === 'api') return ok(JSON.stringify([{ id: 501, user: { login: 'Crazz-E' }, body: 'retry' }]));
      return ok('');
    },
  };

  await unparkScan(queueDir, journalRoot, config, deps);

  const queued = queuedFiles(queueDir);
  assert.equal(queued.length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(queueDir, queued[0]), 'utf8'));
  assert.equal(requeued.id, 'issue-9');
  assert.equal('transientRetries' in requeued, false, 'a human retry always restores the full budget');
  assert.equal('notBefore' in requeued, false, 'a human retry always starts immediately');
});

// ---- 9: gate-non-attesting -- the allowlist entry the original test file never exercised -------
//
// Mutation-tested: deleting `'gate-non-attesting'` from TRANSIENT_RETRY_REASONS left all 1013
// tests green, i.e. a third of the allowlist -- the whole of the action's second bullet -- was
// asserted nowhere at all. Same class of hole as C3's 3.5 (`exact match only`, positives only).

test('finalizePark: gate-non-attesting is on the allowlist -> auto-retried, not parked', () => {
  const config = testConfig();
  const ctx = buildParkCtx({ config });

  finalizePark(ctx, 'GATE', 'gate-non-attesting', { headSha: 'abc1234', verdictDirExists: true });

  assert.equal(readState(ctx.taskDir), null);
  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.equal(requeued.transientRetries, 1);
  const retryEvt = readJournal(ctx.taskDir).find((e) => e.event === 'transient-retry');
  assert.equal(retryEvt.reason, 'gate-non-attesting');
});

test('finalizePark: gate-non-attesting with no verdictDirExists key at all is still auto-retried', () => {
  // Backward compatibility: a park detail written before action 4.2 carries no such key, and
  // "the field is missing" must keep the transient treatment rather than silently opting out.
  const config = testConfig();
  const ctx = buildParkCtx({ config });

  finalizePark(ctx, 'GATE', 'gate-non-attesting', { headSha: 'abc1234' });

  assert.equal(readState(ctx.taskDir), null);
  assert.equal(queuedFiles(config.queueDir).length, 1);
});

test('finalizePark: gate-non-attesting with verdictDirExists:false is a MISCONFIGURATION -> ordinary park, never retried', () => {
  // steps/scripted.js's realGate puts this boolean on the detail precisely to separate "the bench
  // attested nothing" from "config.spoBenchDir points somewhere with no verdicts/ directory at
  // all". The second is permanent, and its comment notes that a misconfigured spoBenchDir makes
  // EVERY failing gate land here -- auto-retrying it would spend two extra WORKTREE/PLAN/
  // IMPLEMENT/GATE runs per card looking in the same wrong place, for as long as it stands.
  const config = testConfig();
  const ctx = buildParkCtx({ config });

  finalizePark(ctx, 'GATE', 'gate-non-attesting', { headSha: 'abc1234', verdictDirExists: false });

  const state = readState(ctx.taskDir);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'gate-non-attesting');
  assert.equal(queuedFiles(config.queueDir).length, 0);
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'transient-retry'));
});

// ---- 9b: gate-live-blocked -- action B2.3 fix round's split of the BLOCKED collapse ------------
//
// Adversarial verification (T4/T5) found `verdict.verdict === 'BLOCKED'` collapsed at least four
// SPO-WebClient producers into one `gate-live-not-driven` park, including `run.ts:63`'s world
// lock / rate-limit refusal -- a fact `liveAttestationFrom` maps to `live.status: 'unknown'`, the
// same value the exit-0 GATE path treats as proof of nothing. The fix splits that case out into
// its own reason, `gate-live-blocked`, and puts it here (unlike `gate-live-not-driven`) because
// the operational case that motivates it -- a maintainer's `gate:local --live` holding the
// single-flight world lock -- clears itself within minutes.

test('finalizePark: gate-live-blocked is on the allowlist -> auto-retried, not parked', () => {
  const config = testConfig();
  const ctx = buildParkCtx({ config });

  finalizePark(ctx, 'GATE', 'gate-live-blocked', { headSha: 'abc1234', exitFrom: 1, liveStatus: 'unknown' });

  assert.equal(readState(ctx.taskDir), null);
  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.equal(requeued.transientRetries, 1);
  const retryEvt = readJournal(ctx.taskDir).find((e) => e.event === 'transient-retry');
  assert.equal(retryEvt.reason, 'gate-live-blocked');
});

test('finalizePark: gate-live-not-driven is NOT on the allowlist -> ordinary park, distinct from gate-live-blocked', () => {
  // The sibling reason: a genuinely routed-but-undriven diff is a property of the worker binary
  // or a reused verdict, not of the moment, so it must NOT get the transient treatment its
  // world-lock/rate-limit sibling does -- pinned here so the two reasons cannot silently merge
  // back into one allowlist entry.
  const config = testConfig();
  const ctx = buildParkCtx({ config });

  finalizePark(ctx, 'GATE', 'gate-live-not-driven', { headSha: 'abc1234', exitFrom: 1, why: 'x', required: ['y'] });

  const state = readState(ctx.taskDir);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'gate-live-not-driven');
  assert.equal(queuedFiles(config.queueDir).length, 0);
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'transient-retry'));
});

// ---- 10: more exact-match negatives -- the two the original negatives could not reach ----------
//
// `llm-transport-failed` / `llm-transport-failed:NOPE` catch a match loosened towards the FAMILY
// (`reason.startsWith('llm-transport-failed')`, C3's actual bug). They do not catch a match
// loosened the other way -- `some((entry) => reason.startsWith(entry))`, or a case-insensitive
// compare -- because neither of those two strings has an allowlist entry as a prefix. Both
// mutations survived the original file; these are the reasons that kill them.

for (const reason of [
  'claim-rate-limited-permanently', // an allowlist entry as a strict PREFIX
  'gate-non-attesting-forever',
  'gate-live-blocked-permanently',
  'llm-transport-failed:PLANNED', // ...including inside the family
  'Claim-Rate-Limited', // case must matter: park reasons are exact literals, not labels
  'llm-transport-failed:plan',
  'llm-transport-failed:CITATION_VERIFIER', // deliberately excluded: that step throws
]) {
  //                                            'citation-verifier-failed' instead (action 1.1)
  test(`finalizePark: "${reason}" is NOT on the allowlist -> ordinary park`, () => {
    const config = testConfig();
    const ctx = buildParkCtx({ config });

    finalizePark(ctx, 'PLAN', reason, { kind: 'error' });

    const state = readState(ctx.taskDir);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, reason);
    assert.equal(queuedFiles(config.queueDir).length, 0);
    assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'transient-retry'));
  });
}

// ---- 11: the retry path is invisible to every "is this card parked?" surface -------------------

test('finalizePark: the auto-retry path moves no board card and writes no daemon "parked" line, even with a live worktree', () => {
  // The first test in this file proves "no spawn" with no worktreePath -- but board.js's moveCard
  // returns early (journalled, unspawned) whenever worktreePath is absent, so that assertion is
  // vacuous for the board specifically. Setting one makes moveCard actually reach its `npm run
  // board:move` spawn, so "no board move" is asserted rather than assumed. Mutation-tested: with
  // no worktreePath, adding moveCard(ctx, ctx.deps, 'PARKED') to the retry path survived.
  const calls = [];
  const deps = { spawnSync: (command, args) => (calls.push({ command, args: [...args] }), ok('')) };
  const config = testConfig();
  const worktreePath = mkTmp('spo-transient-live-worktree-');
  const ctx = buildParkCtx({ config, deps, task: { worktreePath } });

  finalizePark(ctx, 'IMPLEMENT', 'llm-transport-failed:IMPLEMENT', { kind: 'error' });

  assert.deepEqual(calls, [], 'no board move, no park comment, no wip preservation -- nothing spawns');
  assert.equal(readState(ctx.taskDir), null);
  assert.deepEqual(daemonEvents(ctx), [], 'daemon.jsonl must not claim a park that did not happen');
  assert.equal(queuedFiles(config.queueDir).length, 1);
  // worktreePath is stripped from the re-queued entry (reEnqueueTask), so the retry rebuilds it
  // from scratch and WORKTREE's own sweepWorktreeLeftovers is what preserves any dirty work.
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queuedFiles(config.queueDir)[0]), 'utf8'));
  assert.equal('worktreePath' in requeued, false);
});

test('finalizePark: the ordinary park DOES move the board with the same ctx -- the assertion above is not vacuous', () => {
  const calls = [];
  const deps = {
    spawnSync: (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === 'gh') return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/1#issuecomment-42\n');
      return ok('');
    },
  };
  const config = testConfig();
  const worktreePath = mkTmp('spo-transient-live-worktree-');
  const ctx = buildParkCtx({ config, deps, task: { worktreePath, transientRetries: 2 } });

  finalizePark(ctx, 'IMPLEMENT', 'llm-transport-failed:IMPLEMENT', { kind: 'error' });

  assert.ok(
    calls.some((c) => c.command === 'npm' && c.args.includes('board:move')),
    'a real park moves the card'
  );
  assert.ok(daemonEvents(ctx).some((e) => e.event === 'parked'));
});

// ---- 12: the eligibility check never throws and never fires without a real budget/queue --------

test('finalizePark: a config with no transientRetryBudget falls back to no auto-retry, not an unbounded one', () => {
  const { transientRetryBudget, ...noBudget } = testConfig();
  const ctx = buildParkCtx({ config: noBudget });

  finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', { exit: 4 });

  assert.equal(readState(ctx.taskDir).state, 'PARKED');
  assert.equal(queuedFiles(noBudget.queueDir).length, 0);
});

test('finalizePark: a config with no queueDir parks honestly instead of throwing out of runTask', () => {
  // finalizePark runs INSIDE runTask's ParkSignal catch -- anything it throws escapes that catch,
  // out of drainQueueOnce, and kills the daemon (C3 shipped exactly that shape once, via
  // preserveWorktreeWip). orphan-scan.js builds its ctx from a config that has no queueDir on it.
  const { queueDir, ...noQueue } = testConfig();
  const ctx = buildParkCtx({ config: noQueue });

  assert.doesNotThrow(() => finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', { exit: 4 }));
  assert.equal(readState(ctx.taskDir).state, 'PARKED');
  const events = readJournal(ctx.taskDir);
  assert.ok(!events.some((e) => e.event === 'transient-retry'));
  // Not merely "it survived": with no queue configured the retry is never ATTEMPTED, so there is
  // nothing to report as failed either. Letting it throw into the try/catch below and journal
  // `transient-retry-failed` would pass the doesNotThrow assertion above while filing a spurious
  // failure on every orphan-scan repark of an allowlisted reason.
  assert.ok(!events.some((e) => e.event === 'transient-retry-failed'));
});

test('finalizePark: a re-enqueue that actually fails parks honestly and never journals transient-retry', () => {
  // The journal is the single source of truth (Principle 5), so `transient-retry` -- the record
  // that says "this card IS coming back" -- must not outlive the queue entry that makes it true.
  // A queueDir whose parent is a regular file makes reEnqueueTask's own mkdirSync throw ENOTDIR,
  // which stands in for the real cases: a full disk, a queue directory yanked out from under a
  // long-running task, a permission change.
  const blocker = path.join(mkTmp('spo-transient-blocked-'), 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const config = testConfig({ queueDir: path.join(blocker, 'queue') });
  const ctx = buildParkCtx({ config });

  assert.doesNotThrow(() => finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', { exit: 4 }));

  const events = readJournal(ctx.taskDir);
  assert.ok(!events.some((e) => e.event === 'transient-retry'), 'no retry was queued, so none is claimed');
  const failed = events.find((e) => e.event === 'transient-retry-failed');
  assert.ok(failed, 'the attempt and its failure are both on the record');
  assert.equal(failed.reason, 'claim-rate-limited');
  assert.equal(failed.attempt, 1);
  // ...and the card ends up somewhere a human can find it, rather than neither parked nor queued.
  assert.equal(readState(ctx.taskDir).state, 'PARKED');
});

// ---- 13: the queue entry is written ONCE, atomically, never observable half-formed -------------

test('reEnqueueTask: `extra` fields land in the same single write, leaving no temp file behind', () => {
  const taskDir = mkTmp('spo-transient-extra-taskdir-');
  const queueDir = mkTmp('spo-transient-extra-queue-');
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id: 'card-7', kind: 'card', issue: 7 }));

  const file = reEnqueueTask(queueDir, taskDir, 'card-7', { transientRetries: 1, notBefore: '2030-01-01T00:00:00.000Z' });
  const requeued = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(requeued.transientRetries, 1);
  assert.equal(requeued.notBefore, '2030-01-01T00:00:00.000Z');
  assert.deepEqual(fs.readdirSync(queueDir), [path.basename(file)], 'no leftover temp file');
});

test('finalizePark: the queue entry never exists under its real name without transientRetries/notBefore', () => {
  // The defect this pins: writing the base entry and THEN patching the two fields onto it leaves
  // a window in which queue/ holds an entry with neither -- "eligible now, zero retries used".
  // The post-merge hook SIGTERMs this daemon routinely, so a death in that window restarts the
  // card with the budget reset, which is the unbounded retry loop the budget exists to prevent.
  // Asserted structurally rather than by racing a process: every write that lands ON a *.json
  // path inside queue/ must already be the complete entry, so the only way in is the rename.
  const config = testConfig();
  const ctx = buildParkCtx({ config });

  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  const writes = [];
  const renames = [];
  fs.writeFileSync = (p, data, ...rest) => {
    if (String(p).startsWith(config.queueDir)) writes.push({ path: String(p), data: String(data) });
    return realWrite(p, data, ...rest);
  };
  fs.renameSync = (from, to, ...rest) => {
    if (String(to).startsWith(config.queueDir)) renames.push({ from: String(from), to: String(to) });
    return realRename(from, to, ...rest);
  };
  try {
    finalizePark(ctx, 'WORKTREE', 'claim-rate-limited', { exit: 4 });
  } finally {
    fs.writeFileSync = realWrite;
    fs.renameSync = realRename;
  }

  assert.equal(writes.length, 1, 'exactly one write -- never a base write plus a patch write');
  assert.ok(!writes[0].path.endsWith('.json'), 'the visible *.json name is only ever produced by the rename');
  const written = JSON.parse(writes[0].data);
  assert.equal(written.transientRetries, 1);
  assert.ok(written.notBefore, 'the very first bytes written already carry the deadline');
  assert.equal(renames.length, 1);
  assert.ok(renames[0].to.endsWith('.json'));
});

test('takeNextTask: a half-written temp entry is not a queue entry', () => {
  const queueDir = mkTmp('spo-transient-tmp-queue-');
  const journalRoot = mkTmp('spo-transient-tmp-journal-');
  fs.writeFileSync(path.join(queueDir, '.0000-retry-1-x.json.tmp'), '{"id":"x"');

  assert.equal(takeNextTask(queueDir, journalRoot), null);
});

// ---- 14: config.js's own defaults, which the hardcoded numbers above deliberately do not read --

test('config.js: transientRetryBudget/transientRetryDelaysMs hold the values this action specifies', () => {
  const prodConfig = require('../orchestrator/config');
  assert.equal(prodConfig.transientRetryBudget, 2);
  assert.deepEqual(prodConfig.transientRetryDelaysMs, [60000, 300000]);
});

// ---- 15: the liveness claim takeNextTask's `return null` rests on ----------------------------

test('drainQueueOnce: a queue holding nothing but a future notBefore terminates, it does not spin', () => {
  // takeNextTask returning `null` on a NON-EMPTY queue is new with this action, and the whole
  // no-sleep design depends on drainQueueOnce treating that null exactly like an empty queue.
  // `for (;;)` around a call that keeps returning the same not-yet-due entry would peg a core
  // for the length of the backoff and starve every other card -- the precise failure the
  // notBefore-on-the-entry design exists to avoid. Asserted rather than read off the source.
  const queueDir = mkTmp('spo-transient-drain-queue-');
  const journalRoot = mkTmp('spo-transient-drain-journal-');
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  writeQueueFile(queueDir, '0000-retry-1-later.json', { id: 'later', kind: 'card', issue: 1, notBefore: future });

  const results = drainQueueOnce(queueDir, journalRoot, testConfig({ queueDir }));

  return results.then((r) => {
    assert.deepEqual(r, [], 'nothing was drained');
    assert.deepEqual(queuedFiles(queueDir), ['0000-retry-1-later.json'], 'and the entry is still waiting');
  });
});

// ---- 16: action B3.4 round 2 -- the nine reasons the exit-1/2/3 split introduced, pinned one ----
//         by one so a flipped classification (either direction) fails exactly this test ----------
//
// Round 1 split `gate-non-attesting` (which auto-retries) into four exit-1 names plus a new
// `gate-stale` park, and split `gate-dirty-tree`/`gate-worker-down` (neither of which auto-
// retries) into four exit-2/3 names -- and reported the whole split as "naming correctness, not
// retry policy", adding none of the nine to TRANSIENT_RETRY_REASONS. For four of them that is a
// silent regression: DIRTY/ENVIRONMENT/ABANDONED/INTERRUPTED previously retried under the shared
// `gate-non-attesting` name, and `gate-environment` alone is the commonest non-PASS bench outcome
// measured against the live corpus (7 of 29). See state-machine.js's own TRANSIENT_RETRY_REASONS
// comment and doc/state-machine-spec.md's GATE row ("Retry policy, corrected in round 2") for the
// full per-reason justification this test pins.

for (const reason of ['gate-environment', 'gate-interrupted', 'gate-abandoned', 'gate-stale']) {
  test(`finalizePark: ${reason} is on the allowlist -> auto-retried, not parked (restored pre-split gate-non-attesting behaviour)`, () => {
    const config = testConfig();
    const ctx = buildParkCtx({ config });

    finalizePark(ctx, 'GATE', reason, { headSha: 'abc1234', jobId: 'job-1', jobDetail: 'x' });

    assert.equal(readState(ctx.taskDir), null, `${reason} must not park -- it must queue a retry instead`);
    const queued = queuedFiles(config.queueDir);
    assert.equal(queued.length, 1);
    const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
    assert.equal(requeued.transientRetries, 1);
    const retryEvt = readJournal(ctx.taskDir).find((e) => e.event === 'transient-retry');
    assert.ok(retryEvt, `expected a transient-retry event for ${reason}`);
    assert.equal(retryEvt.reason, reason);
  });
}

test('finalizePark: gate-worker-dirty-checkout is NOT on the allowlist -> ordinary park (deliberate narrowing vs. the pre-split gate-non-attesting)', () => {
  // DIRTY used to share gate-non-attesting's blanket auto-retry before this action split it out.
  // Making it terminal now is a considered, documented narrowing (state-machine.js's own comment,
  // and doc/state-machine-spec.md's GATE row) -- not an accident -- so this reason must stay OFF
  // the allowlist, pinned the same way gate-live-not-driven is pinned as a negative just above.
  const config = testConfig();
  const ctx = buildParkCtx({ config });

  finalizePark(ctx, 'GATE', 'gate-worker-dirty-checkout', { headSha: 'abc1234', jobId: 'job-1', jobDetail: 'x' });

  const state = readState(ctx.taskDir);
  assert.equal(state.state, 'PARKED');
  assert.equal(state.reason, 'gate-worker-dirty-checkout');
  assert.equal(queuedFiles(config.queueDir).length, 0);
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'transient-retry'));
});

// The exit-2/3 four: neither gate-dirty-tree nor gate-worker-down (the reasons they refine) was
// ever on TRANSIENT_RETRY_REASONS, so all four staying off it is the status quo continuing, not a
// new decision -- pinned here anyway so a future accidental addition is caught the same way a
// future accidental removal from the four above would be.
for (const reason of ['gate-not-pushed', 'gate-duplicate-job', 'gate-worker-not-built', 'gate-worker-died-midjob']) {
  test(`finalizePark: ${reason} is NOT on the allowlist -> ordinary park (same terminal disposition gate-dirty-tree/gate-worker-down already had)`, () => {
    const config = testConfig();
    const ctx = buildParkCtx({ config });

    finalizePark(ctx, 'GATE', reason, { exit: 2 });

    const state = readState(ctx.taskDir);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, reason);
    assert.equal(queuedFiles(config.queueDir).length, 0);
    assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'transient-retry'));
  });
}
