'use strict';
// Tests for action 1.2 (card #119): the pool-exhaustion WAIT -- a cooling account-pool park
// (state-machine.js's ACCOUNT_POOL_PARK_REASON_FAMILY) is re-enqueued with `notBefore` set to the
// cooldown's own deadline instead of parking outright, when that deadline is recoverable. This is
// a SEPARATE mechanism from action 4.4's transient-retry budget (test/transient-retry.test.js) --
// its own cap (`config.poolExhaustionWaitCapMs`), its own accumulator (`poolWaitMs`/
// `poolWaitAttempts`, not `transientRetries`), its own journal event (`pool-wait`, not
// `transient-retry`). Same conventions as test/transient-retry.test.js and test/park-loop.test.js:
// tmp queue/journal dirs, an injected deps.spawnSync recording every call, nothing here touches a
// real git/npm/gh process.
//
// The banked corpus measurement this action's spec carries (do not re-derive): seven real park
// events, five cards, all 2026-09-04 -- every one of them should have been a wait. No event
// carries both `earliestCooldownUntil` (epoch-ms number, pick()'s own shape) and
// `cooldownUntilIso` (ISO string, callLlmStep's own shape) -- a resolver reading only one silently
// fails on 5 of 7, or on 2 of 7, depending which. Both are pinned here, separately, per the
// finding this action exists to close.
require('./no-real-spawn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  buildCtx,
  finalizePark,
  poolCooldownDeadlineMs,
  ACCOUNT_POOL_PARK_REASON_FAMILY,
  TRANSIENT_RETRY_REASONS,
} = require('../orchestrator/state-machine');
const { reEnqueueTask, countRepeatedParks } = require('../orchestrator/park-loop');
const { mkTmp } = require('./helpers');

function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}

// poolExhaustionWaitCapMs is hardcoded here rather than imported from orchestrator/config.js --
// same reasoning test/transient-retry.test.js's own testConfig() applies to every other budget:
// a test pinned to the ACTION'S OWN stated number (12h) catches a regression in config.js's
// default instead of silently tracking whatever it drifts to.
function testConfig(overrides = {}) {
  return {
    shadowMode: false,
    dryRun: false,
    real: true,
    productRepo: '/fake/home/SPO-WebClient',
    pipelineWorktreesDir: mkTmp('spo-poolwait-worktrees-'),
    ghRepo: 'Crazz-Org/SPO-WebClient',
    spoBenchDir: mkTmp('spo-poolwait-bench-'),
    stepDeadlineMs: 30000,
    claudeAccountsDir: mkTmp('spo-poolwait-accts-'),
    transientRetryBudget: 2,
    transientRetryDelaysMs: [60000, 300000],
    poolExhaustionWaitCapMs: 12 * 60 * 60 * 1000,
    queueDir: mkTmp('spo-poolwait-queue-'),
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

// Same construction as test/transient-retry.test.js's buildParkCtx: a fresh journalRoot per
// call (finalizePark's daemon-level feed writes to `path.dirname(ctx.taskDir)/daemon.jsonl`), a
// real buildCtx so ctx carries every field finalizePark reads, and a stub spawnSync by default so
// a test that does not care what was spawned still cannot spawn anything real.
function buildParkCtx({ id = 'card-1', task, config, deps } = {}) {
  const journalRoot = mkTmp('spo-poolwait-journal-');
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  const effectiveDeps = deps || { spawnSync: () => ok('') };
  return buildCtx(id, { id, kind: 'card', issue: 1, title: 'x', ...task }, taskDir, { ...config, deps: effectiveDeps });
}

function readState(taskDir) {
  const p = path.join(taskDir, 'state.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// readReportDetail(taskDir) -- state.json carries only {reason, lastState, state}, never `detail`
// (journal.js's writeState); the full park detail lives in report.md's fenced ```json block
// (journal.js's writeReport), which is also what postParkComment reads to build the gh comment a
// maintainer actually sees. Parsed back out here rather than re-deriving it from the journal,
// since the journal's own `pool-wait-cap-exceeded` event only carries the SUBSET this action
// journals explicitly, not the full merged evidence detail.
function readReportDetail(taskDir) {
  const body = fs.readFileSync(path.join(taskDir, 'report.md'), 'utf8');
  const m = /```json\n([\s\S]*?)\n```/.exec(body);
  assert.ok(m, 'report.md must carry a fenced ```json detail block');
  return JSON.parse(m[1]);
}

// ==== part 1: poolCooldownDeadlineMs, exercised directly -- both keys, both types, pinned =======

test('poolCooldownDeadlineMs: earliestCooldownUntil (epoch-ms number) is used directly -- issue-486 shape', () => {
  // 1788532328909 is the corpus's own recorded deadline for issue-486's 14:25:49.803Z park.
  const deadline = 1788532328909;
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-until-2026-07-03T18:32:08.909Z', { earliestCooldownUntil: deadline }), deadline);
});

test('poolCooldownDeadlineMs: cooldownUntilIso (ISO string) is parsed -- issue-496 shape', () => {
  // The corpus's own recorded deadline for issue-496's 03:55:08.393Z park.
  const iso = '2026-09-04T04:55:08.391Z';
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-after-retry', { cooldownUntilIso: iso }), Date.parse(iso));
});

test('poolCooldownDeadlineMs: a detail carrying ONLY earliestCooldownUntil must not need cooldownUntilIso too', () => {
  const deadline = Date.now() + 60000;
  const detail = { earliestCooldownUntil: deadline, checkedAccounts: ['a1'] };
  assert.equal('cooldownUntilIso' in detail, false, 'sanity: this detail really has only one key');
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-until-x', detail), deadline);
});

test('poolCooldownDeadlineMs: a detail carrying ONLY cooldownUntilIso must not need earliestCooldownUntil too', () => {
  const iso = new Date(Date.now() + 60000).toISOString();
  const detail = { cooldownUntilIso: iso, attempts: 2 };
  assert.equal('earliestCooldownUntil' in detail, false, 'sanity: this detail really has only one key');
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-after-retry', detail), Date.parse(iso));
});

test('poolCooldownDeadlineMs: last resort -- neither detail key present, parses the ISO suffix out of the reason string itself', () => {
  // The exact literal this action's spec names: a detail with NEITHER key still resolves.
  const reason = 'all-accounts-cooling-until-2026-09-04T20:33:05.932Z';
  assert.equal(poolCooldownDeadlineMs(reason, {}), Date.parse('2026-09-04T20:33:05.932Z'));
  assert.equal(poolCooldownDeadlineMs(reason, undefined), Date.parse('2026-09-04T20:33:05.932Z'));
});

test('poolCooldownDeadlineMs: all-accounts-cooling-unknown always resolves to null -- no deadline exists', () => {
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-unknown', {}), null);
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-unknown', { earliestCooldownUntil: Date.now() }), null, 'even a stray key must not be honoured for this reason');
});

test('poolCooldownDeadlineMs: all-accounts-leased always resolves to null -- a lease, not a cooldown', () => {
  assert.equal(poolCooldownDeadlineMs('all-accounts-leased', {}), null);
  assert.equal(poolCooldownDeadlineMs('all-accounts-leased', { cooldownUntilIso: new Date().toISOString() }), null, 'even a stray key must not be honoured for this reason');
});

test('poolCooldownDeadlineMs: a non-finite earliestCooldownUntil falls through to cooldownUntilIso, not straight to null', () => {
  const iso = new Date(Date.now() + 60000).toISOString();
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-after-retry', { earliestCooldownUntil: null, cooldownUntilIso: iso }), Date.parse(iso));
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-after-retry', { earliestCooldownUntil: NaN, cooldownUntilIso: iso }), Date.parse(iso));
});

test('poolCooldownDeadlineMs: an unparsable cooldownUntilIso falls through to the reason-suffix last resort', () => {
  const reason = 'all-accounts-cooling-until-2026-09-04T20:33:05.932Z';
  assert.equal(poolCooldownDeadlineMs(reason, { cooldownUntilIso: 'not-a-real-date' }), Date.parse('2026-09-04T20:33:05.932Z'));
});

test('poolCooldownDeadlineMs: no key, no matching prefix -> null (an undeclared reason, or after-retry with nothing recoverable)', () => {
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-after-retry', {}), null);
  assert.equal(poolCooldownDeadlineMs('some-unrelated-reason', {}), null);
});

// ==== part 2: finalizePark integration -- the full re-enqueue, both key families =================

test('finalizePark: all-accounts-cooling-until-<ISO> with earliestCooldownUntil (epoch ms) -> pool-wait, not parked', () => {
  const config = testConfig();
  const ctx = buildParkCtx({ config });
  const deadlineMs = Date.now() + 6.3 * 60 * 1000; // issue-486's own observed wait: 6.3 min
  const reason = `all-accounts-cooling-until-${new Date(deadlineMs).toISOString()}`;

  finalizePark(ctx, 'PLAN', reason, { earliestCooldownUntil: deadlineMs, checkedAccounts: ['acct-a', 'acct-b'] });

  assert.equal(readState(ctx.taskDir), null, 'not parked -- re-enqueued instead');
  assert.ok(!fs.existsSync(path.join(ctx.taskDir, 'report.md')));

  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1);
  // Priority CLASS, not merely the `0000-retry-` prefix. The branch's own comment asserts this
  // wait is "never allowed to sort ahead of a maintainer's explicit 'h'-classed retry", and
  // nothing pinned it: flipping the pool branch's priorityClass from 't' to 'h' survived the whole
  // suite during action 1.2's verification, while the identical mutation on the transient branch
  // was killed. A machine wait sorting ahead of a human's retry is the one thing the class exists
  // to prevent.
  assert.match(queued[0], /^0000-retry-t-/, "the machine's own wait must be class 't', never the human 'h'");
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.equal(requeued.id, 'card-1');
  assert.equal(requeued.notBefore, new Date(deadlineMs).toISOString(), 'notBefore must equal the deadline exactly, not now + a fixed delay');
  assert.equal(requeued.poolWaitAttempts, 1);
  assert.ok(requeued.poolWaitMs > 0 && requeued.poolWaitMs <= 6.3 * 60 * 1000 + 1000);

  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'pool-wait');
  assert.ok(evt, 'pool-wait event must be journalled');
  assert.equal(evt.reason, reason);
  assert.equal(evt.attempt, 1);
  assert.equal(evt.notBefore, requeued.notBefore);
  assert.equal(evt.deadlineSource, 'earliestCooldownUntil');
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'transient-retry'), 'the transient mechanism must not also fire');
});

test('finalizePark: all-accounts-cooling-after-retry with cooldownUntilIso (ISO string) -> pool-wait, not parked', () => {
  const config = testConfig();
  const ctx = buildParkCtx({ config });
  const deadlineIso = new Date(Date.now() + 300 * 60 * 1000).toISOString(); // issue-497's own observed wait: 300.0 min

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { attempts: 2, lastResult: { kind: 'limit' }, cooldownUntilIso: deadlineIso });

  assert.equal(readState(ctx.taskDir), null);
  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.equal(requeued.notBefore, deadlineIso, 'notBefore must equal the deadline exactly');
  assert.equal(requeued.poolWaitAttempts, 1);

  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'pool-wait');
  assert.ok(evt);
  assert.equal(evt.deadlineSource, 'cooldownUntilIso');
});

// ==== part 3: no deadline -> honest park, exactly as today =======================================

for (const [reason, detail] of [
  ['all-accounts-cooling-unknown', { checkedAccounts: ['a1'] }],
  ['all-accounts-leased', { checkedAccounts: ['a1'], excludedAccounts: ['a1'] }],
]) {
  test(`finalizePark: ${reason} carries no recoverable deadline -> ordinary park, no re-enqueue`, () => {
    const config = testConfig();
    const ctx = buildParkCtx({ config });

    finalizePark(ctx, 'PLAN', reason, detail);

    const state = readState(ctx.taskDir);
    assert.equal(state.state, 'PARKED');
    assert.equal(state.reason, reason);
    assert.equal(queuedFiles(config.queueDir).length, 0);
    assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'pool-wait'));
  });
}

// ==== part 4: the cap binds, and binds BEFORE the wait; card #119 action 1.3: exceeding it is its
// OWN reason, carrying the evidence, and is never re-enqueued (the loop guard) =====================

test('finalizePark: accumulated wait over the cap -> parks under the NEW cap-exceeded reason, never the original, and does NOT re-enqueue', () => {
  const config = testConfig(); // poolExhaustionWaitCapMs: 12h
  const ctx = buildParkCtx({ config, task: { poolWaitMs: 12 * 60 * 60 * 1000, poolWaitAttempts: 3 } });
  const deadlineMs = Date.now() + 60 * 60 * 1000; // a fresh, ordinary 1h cooldown -- accumulated = 13h, 1h over the 12h cap
  const originalDetail = { cooldownUntilIso: new Date(deadlineMs).toISOString() };

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', originalDetail);

  const state = readState(ctx.taskDir);
  assert.equal(state.state, 'PARKED', 'the cap binds -- this must be an ordinary park');
  assert.equal(
    state.reason,
    'all-accounts-cooling-wait-cap-exceeded',
    'action 1.3: cap-exceeded gets its OWN reason -- never falls through under the original one'
  );
  assert.equal(queuedFiles(config.queueDir).length, 0);
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'pool-wait'), 'no wait was taken');

  // The evidence (this action's spec, item 2): accumulated wait, the number of waits already
  // TAKEN (this blocked one does not count), the cap that was exceeded, the deadline that would
  // have been waited for, and the ORIGINAL family reason -- plus the original detail's own fields,
  // preserved alongside the new ones. state.json itself never carries `detail` (journal.js's
  // writeState) -- report.md is where the full merged detail lands (readReportDetail's own header).
  const reportDetail = readReportDetail(ctx.taskDir);
  assert.equal(reportDetail.originalReason, 'all-accounts-cooling-after-retry');
  assert.equal(reportDetail.capMs, config.poolExhaustionWaitCapMs);
  assert.ok(Math.abs(reportDetail.accumulatedWaitMs - 13 * 60 * 60 * 1000) < 5000);
  assert.equal(reportDetail.poolWaitAttempts, 3);
  assert.equal(reportDetail.deadlineMs, deadlineMs);
  assert.equal(reportDetail.cooldownUntilIso, originalDetail.cooldownUntilIso, "the ORIGINAL detail's own fields survive alongside the new evidence fields");

  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'pool-wait-cap-exceeded');
  assert.ok(evt, 'pool-wait-cap-exceeded must be journalled');
  assert.equal(evt.reason, 'all-accounts-cooling-after-retry', 'the journal event names the ORIGINAL reason, not the new one');
  assert.equal(evt.capMs, config.poolExhaustionWaitCapMs);
  assert.equal(evt.accumulatedWaitMs, reportDetail.accumulatedWaitMs);
});

// "Make it loud" (this action's spec, item 3): a cap-exceeded park must reach the SAME park-alert
// path as any other park, carrying the NEW reason, not the original one. Verified by actually
// configuring `parkAlertCmd` and inspecting the spawnSync call finalizePark's own alertPark makes
// -- not assumed from reading park-alert.js's source. park-alert.js's alertPark is reason-agnostic
// (it forwards whatever `reason` finalizePark hands it, with no allowlist anywhere in the path), so
// this also stands as the proof that claim is true for this specific reason, not just in general.
test('finalizePark: a cap-exceeded park reaches the park-alert path, carrying the NEW reason', () => {
  const spawnCalls = [];
  const config = testConfig({ parkAlertCmd: 'fake-park-alert-cmd' });
  const ctx = buildParkCtx({
    config,
    task: { poolWaitMs: 12 * 60 * 60 * 1000, poolWaitAttempts: 3 },
    deps: {
      spawnSync: (cmd, args) => {
        spawnCalls.push({ cmd, args });
        return ok('');
      },
    },
  });
  const deadlineMs = Date.now() + 60 * 60 * 1000;

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(deadlineMs).toISOString() });

  assert.equal(readState(ctx.taskDir).reason, 'all-accounts-cooling-wait-cap-exceeded', 'sanity: this really is the cap-exceeded park');
  const alertCall = spawnCalls.find((c) => c.cmd === 'fake-park-alert-cmd');
  assert.ok(alertCall, 'park-alert.js\'s alertDaemon must have spawned parkAlertCmd for this park -- no reason-based filter exists in that path');
  assert.equal(alertCall.args[1], 'all-accounts-cooling-wait-cap-exceeded', 'the alert must carry the NEW reason, not the original one that triggered the wait');
  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'park-alert');
  assert.ok(evt, 'park-alert must be journalled for this park, same as any other');
  assert.equal(evt.reason, 'all-accounts-cooling-wait-cap-exceeded');
});

// THE LOOP GUARD -- this action's spec calls this "the single most important test in this
// action": if poolCooldownDeadlineMs ever stopped excluding this reason BY NAME, a cap-exceeded
// park carrying the original deadline in its own evidence detail (deliberately kept, see the test
// above) would be re-enqueued forever the next time it is parked through finalizePark -- the exact
// unbounded hang the cap exists to prevent, reintroduced by the cap's own park.
test('LOOP GUARD: finalizePark called with the cap-exceeded reason itself, and a detail carrying a valid future deadline, still parks -- never re-enqueues', () => {
  const config = testConfig();
  const ctx = buildParkCtx({ config });
  const futureDeadline = Date.now() + 60 * 60 * 1000;

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-wait-cap-exceeded', {
    earliestCooldownUntil: futureDeadline,
    accumulatedWaitMs: 13 * 60 * 60 * 1000,
    poolWaitAttempts: 3,
    capMs: config.poolExhaustionWaitCapMs,
    deadlineMs: futureDeadline,
    originalReason: 'all-accounts-cooling-after-retry',
  });

  const state = readState(ctx.taskDir);
  assert.equal(state.state, 'PARKED', 'must park -- never re-enqueue a reason that carries no recoverable deadline by construction');
  assert.equal(state.reason, 'all-accounts-cooling-wait-cap-exceeded');
  assert.equal(queuedFiles(config.queueDir).length, 0, 'no queue entry must ever be written for this reason');
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'pool-wait'), 'the wait branch must never fire for this reason');
  assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'pool-wait-cap-exceeded'), 'the cap check itself must never re-run for a reason that is already the cap sink');
  // Card #178 sibling check: this reason never reaches the :2420 re-enqueue emit that was deleted
  // (poolCooldownDeadlineMs returns null for it BEFORE either detail key is read, gating the whole
  // pool branch at :2333-2335), so it must be entirely unaffected by that fix -- exactly one real
  // `parked` line, same as always.
  assert.equal(readJournal(ctx.taskDir).filter((e) => e.event === 'parked').length, 1, 'a real park -- exactly one parked line, unaffected by the re-enqueue emit removal');
});

test('poolCooldownDeadlineMs: all-accounts-cooling-wait-cap-exceeded always resolves to null, explicitly, even with a valid deadline in its detail', () => {
  const futureDeadline = Date.now() + 60000;
  assert.equal(poolCooldownDeadlineMs('all-accounts-cooling-wait-cap-exceeded', {}), null);
  assert.equal(
    poolCooldownDeadlineMs('all-accounts-cooling-wait-cap-exceeded', { earliestCooldownUntil: futureDeadline }),
    null,
    'a deadline sitting right there in the detail must not be honoured -- this is the loop guard'
  );
  assert.equal(
    poolCooldownDeadlineMs('all-accounts-cooling-wait-cap-exceeded', { cooldownUntilIso: new Date(futureDeadline).toISOString() }),
    null,
    'the ISO-string key must not be honoured either'
  );
});

// The boundary: accumulated exactly AT the cap still waits (`<=`, not `<`); one millisecond over
// it does not. `waitMs` is pinned to 0 (deadlineMs == "now" at call time, and time only moves
// forward) so the boundary is exact and not at the mercy of wall-clock scheduling jitter between
// the test computing `deadlineMs` and finalizePark computing its own `now`.
test('finalizePark: accumulated wait exactly AT the cap still waits -- the cap is inclusive', () => {
  const config = testConfig();
  const cap = config.poolExhaustionWaitCapMs;
  const ctx = buildParkCtx({ config, task: { poolWaitMs: cap } });

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date().toISOString() });

  assert.equal(readState(ctx.taskDir), null, 'accumulated === cap must still wait, not park');
  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.equal(requeued.poolWaitMs, cap, 'accumulated must land exactly on the cap for this boundary to mean anything');
});

test('finalizePark: accumulated wait one millisecond OVER the cap does not wait -- parks under the cap-exceeded reason', () => {
  const config = testConfig();
  const cap = config.poolExhaustionWaitCapMs;
  const ctx = buildParkCtx({ config, task: { poolWaitMs: cap + 1 } });

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date().toISOString() });

  const state = readState(ctx.taskDir);
  assert.equal(state.state, 'PARKED', 'accumulated === cap + 1ms must not wait');
  assert.equal(state.reason, 'all-accounts-cooling-wait-cap-exceeded');
  assert.equal(queuedFiles(config.queueDir).length, 0);
  assert.equal(readReportDetail(ctx.taskDir).accumulatedWaitMs, cap + 1);
});

test('finalizePark: accumulated wait one millisecond under the cap still waits', () => {
  const config = testConfig();
  const cap = config.poolExhaustionWaitCapMs;
  const priorWaitMs = cap - 60000; // 1 minute of headroom
  const ctx = buildParkCtx({ config, task: { poolWaitMs: priorWaitMs } });
  const deadlineMs = Date.now() + 30000; // a 30s wait keeps accumulated under the cap

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(deadlineMs).toISOString() });

  assert.equal(readState(ctx.taskDir), null, 'still under the cap -- must still wait');
  assert.equal(queuedFiles(config.queueDir).length, 1);
});

// ==== part 5: the accumulator accumulates across successive waits ================================

test('finalizePark: poolWaitMs accumulates across two successive waits and is carried on the queue entry', () => {
  const config = testConfig();
  const firstDeadline = Date.now() + 10 * 60 * 1000; // 10 min
  const ctx1 = buildParkCtx({ config });

  finalizePark(ctx1, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(firstDeadline).toISOString() });

  const firstQueued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queuedFiles(config.queueDir)[0]), 'utf8'));
  assert.equal(firstQueued.poolWaitAttempts, 1);
  const firstAccumulated = firstQueued.poolWaitMs;
  assert.ok(firstAccumulated > 0);

  // Second park for the SAME logical task, now carrying the first wait's own poolWaitMs/
  // poolWaitAttempts forward -- exactly what a re-enqueued task.json would hold when this task is
  // taken again and parks a second time.
  fs.rmSync(config.queueDir, { recursive: true, force: true });
  const secondDeadline = Date.now() + 20 * 60 * 1000; // 20 min
  const ctx2 = buildParkCtx({ config, task: { poolWaitMs: firstAccumulated, poolWaitAttempts: 1 } });

  finalizePark(ctx2, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(secondDeadline).toISOString() });

  const secondQueued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queuedFiles(config.queueDir)[0]), 'utf8'));
  assert.equal(secondQueued.poolWaitAttempts, 2);
  assert.ok(secondQueued.poolWaitMs > firstAccumulated, 'the second wait must be added on top of the first, not replace it');
  assert.ok(Math.abs(secondQueued.poolWaitMs - (firstAccumulated + 20 * 60 * 1000)) < 5000);
});

// ==== part 6: a human retry resets the accumulator, exactly as it already resets transientRetries =

test('reEnqueueTask: strips poolWaitMs and poolWaitAttempts, restoring the full wait allowance', () => {
  const taskDir = mkTmp('spo-poolwait-reenqueue-taskdir-');
  const queueDir = mkTmp('spo-poolwait-reenqueue-queue-');
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id: 'card-9', kind: 'card', issue: 9, poolWaitMs: 11 * 60 * 60 * 1000, poolWaitAttempts: 4, notBefore: new Date().toISOString() })
  );

  const file = reEnqueueTask(queueDir, taskDir, 'card-9');
  const requeued = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(requeued.id, 'card-9');
  assert.equal('poolWaitMs' in requeued, false);
  assert.equal('poolWaitAttempts' in requeued, false);
  assert.equal('notBefore' in requeued, false);
});

// ==== part 7: dry-run / shadow mode never re-enqueues into a real queue ==========================

for (const [label, modeOverrides] of [
  ['shadow', { shadowMode: true, dryRun: false, real: false }],
  ['dry-run', { shadowMode: false, dryRun: true, real: false }],
]) {
  test(`finalizePark: ${label} mode never pool-waits a cooling park -- ordinary park instead`, () => {
    const config = testConfig(modeOverrides);
    const ctx = buildParkCtx({ config });

    finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(Date.now() + 60000).toISOString() });

    const state = readState(ctx.taskDir);
    assert.equal(state.state, 'PARKED');
    assert.equal(queuedFiles(config.queueDir).length, 0, 'a synthetic task must never land in the real queue dir');
    assert.ok(!readJournal(ctx.taskDir).some((e) => e.event === 'pool-wait'));
  });
}

// ==== part 8: the wait is NOT the transient-retry budget -- pins the proof in this action's spec ===

test('none of the account-pool park reasons (five, since action 1.3) is on TRANSIENT_RETRY_REASONS', () => {
  for (const { match } of ACCOUNT_POOL_PARK_REASON_FAMILY) {
    assert.equal(TRANSIENT_RETRY_REASONS.has(match), false, `${match} must not be on the transient-retry allowlist -- see this action's spec for why a naive add fails 7 of 7`);
  }
});

test('finalizePark: a cooling wait happens even when transientRetries is already at transientRetryBudget', () => {
  const config = testConfig(); // transientRetryBudget: 2
  const ctx = buildParkCtx({ config, task: { transientRetries: 2 } });

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(Date.now() + 60000).toISOString() });

  assert.equal(readState(ctx.taskDir), null, 'the pool-wait mechanism has its own, separate budget');
  assert.equal(queuedFiles(config.queueDir).length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queuedFiles(config.queueDir)[0]), 'utf8'));
  // CORRECTED by action 1.2's adversarial verification. This assertion originally required the
  // OPPOSITE -- that the pool path drop `transientRetries` -- and that is a defect, not a
  // property: dropping it means a pool wait silently RESTORES the exhausted transient budget, so a
  // task alternating pool-wait and transient-retry retries unattended forever. reEnqueueTask's own
  // header names that exact shape ("an unbounded retry loop, which is the one thing the budget
  // exists to prevent"). The two mechanisms are independent in their BUDGETS -- which is what this
  // test's name is about, and it still holds: the wait fires with the transient budget exhausted --
  // but neither machine mechanism may reset the other's counter. Only a human `retry` does that.
  assert.equal(requeued.transientRetries, 2, 'an exhausted transient budget stays exhausted across a pool wait');
});

// ==== part 9: the eligibility check never throws and never fires without a real budget/queue ======

test('finalizePark: a config with no poolExhaustionWaitCapMs falls back to no wait, not an unbounded one', () => {
  const { poolExhaustionWaitCapMs, ...noCap } = testConfig();
  const ctx = buildParkCtx({ config: noCap });

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(Date.now() + 60000).toISOString() });

  assert.equal(readState(ctx.taskDir).state, 'PARKED');
  assert.equal(queuedFiles(noCap.queueDir).length, 0);
});

test('finalizePark: a config with no queueDir parks honestly instead of throwing out of runTask', () => {
  const { queueDir, ...noQueue } = testConfig();
  const ctx = buildParkCtx({ config: noQueue });

  assert.doesNotThrow(() =>
    finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(Date.now() + 60000).toISOString() })
  );
  assert.equal(readState(ctx.taskDir).state, 'PARKED');
  const events = readJournal(ctx.taskDir);
  assert.ok(!events.some((e) => e.event === 'pool-wait'));
  assert.ok(!events.some((e) => e.event === 'pool-wait-failed'), 'no wait was attempted, so none can be reported failed');
});

test('finalizePark: a re-enqueue that actually fails parks honestly and journals pool-wait-failed, never pool-wait', () => {
  const blocker = path.join(mkTmp('spo-poolwait-blocked-'), 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const config = testConfig({ queueDir: path.join(blocker, 'queue') });
  const ctx = buildParkCtx({ config });

  assert.doesNotThrow(() =>
    finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(Date.now() + 60000).toISOString() })
  );

  const events = readJournal(ctx.taskDir);
  assert.ok(!events.some((e) => e.event === 'pool-wait'), 'no wait was queued, so none is claimed');
  const failed = events.find((e) => e.event === 'pool-wait-failed');
  assert.ok(failed, 'the attempt and its failure are both on the record');
  assert.equal(failed.reason, 'all-accounts-cooling-after-retry');
  assert.equal(failed.attempt, 1);
  assert.equal(readState(ctx.taskDir).state, 'PARKED');
});

// ==== part 10: config.js's own defaults, which the hardcoded numbers above deliberately do not read

test('config.js: poolExhaustionWaitCapMs holds the value this action specifies (12h)', () => {
  const prodConfig = require('../orchestrator/config');
  assert.equal(prodConfig.poolExhaustionWaitCapMs, 12 * 60 * 60 * 1000);
});

// ==== part 11: regressions from action 1.2's adversarial verification ===========================
//
// Two properties the original build got RIGHT in code and left unpinned, plus one it got wrong.
// Each mutation below survived the full suite when it was introduced during verification.

test('finalizePark: a deadline already in the past clamps to a zero wait -- it must never DECREMENT the accumulator', () => {
  // `Math.max(0, deadlineMs - now)` was unpinned. Dropping the clamp lets a past deadline produce
  // a NEGATIVE waitMs, which subtracts from poolWaitMs -- so repeated stale deadlines drive the
  // accumulator below zero and the 12h cap never binds again. A past deadline is realistic, not
  // contrived: the cooldown can expire between pick()'s check and finalizePark being reached.
  const config = testConfig();
  const ctx = buildParkCtx({ config, task: { id: 'card-1', poolWaitMs: 60 * 60 * 1000, poolWaitAttempts: 1 } });
  const pastDeadline = Date.now() - 5 * 60 * 1000;

  finalizePark(ctx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(pastDeadline).toISOString() });

  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1, 'an expired cooldown is still a wait -- of zero -- not a park');
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.ok(
    requeued.poolWaitMs >= 60 * 60 * 1000,
    `the accumulator must never go backwards: was 3600000, now ${requeued.poolWaitMs}`
  );
  const evt = readJournal(ctx.taskDir).find((e) => e.event === 'pool-wait');
  assert.equal(evt.waitMs, 0, 'a past deadline is a zero wait, never a negative one');
  assert.ok(Date.parse(requeued.notBefore) <= Date.now() + 1000, 'notBefore is now, so the card is eligible immediately');
});

test("a transient retry must NOT reset the pool-wait allowance -- the cap is across the task's whole life", () => {
  // The bug this pins: reEnqueueTask strips poolWaitMs/poolWaitAttempts from EVERY caller, so
  // before the fix an unrelated transient retry silently wiped an 11h accumulated pool wait and
  // the cap started over. Measured on a real `gate-stale` park during verification.
  const config = testConfig();
  const elevenHours = 11 * 60 * 60 * 1000;
  const ctx = buildParkCtx({ config, task: { id: 'card-1', poolWaitMs: elevenHours, poolWaitAttempts: 3 } });

  finalizePark(ctx, 'GATE', 'gate-stale', {});

  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.ok(readJournal(ctx.taskDir).some((e) => e.event === 'transient-retry'), 'this is the transient mechanism firing');
  assert.equal(requeued.transientRetries, 1);
  assert.equal(requeued.poolWaitMs, elevenHours, 'the pool-wait accumulator survives an unrelated transient retry');
  assert.equal(requeued.poolWaitAttempts, 3, 'and so does its attempt count');
});

test('a pool wait must NOT reset the transient-retry budget -- the leak is symmetric', () => {
  const config = testConfig();
  const ctx = buildParkCtx({ config, task: { id: 'card-1', transientRetries: 2 } });
  const deadlineMs = Date.now() + 30 * 60 * 1000;

  finalizePark(ctx, 'PLAN', `all-accounts-cooling-until-${new Date(deadlineMs).toISOString()}`, {
    earliestCooldownUntil: deadlineMs,
  });

  const queued = queuedFiles(config.queueDir);
  assert.equal(queued.length, 1);
  const requeued = JSON.parse(fs.readFileSync(path.join(config.queueDir, queued[0]), 'utf8'));
  assert.ok(readJournal(ctx.taskDir).some((e) => e.event === 'pool-wait'), 'this is the pool mechanism firing');
  assert.equal(requeued.transientRetries, 2, 'an exhausted transient budget stays exhausted across a pool wait');
});

test('only a HUMAN retry resets either allowance: reEnqueueTask called without extra strips both', () => {
  // The other half of the property: the strip in reEnqueueTask is correct, it is just not for the
  // machine's own branches. unparkScan calls it with no counters in `extra`, and that is what
  // makes a maintainer's `retry` always able to make progress.
  const journalRoot = mkTmp('spo-poolwait-human-');
  const taskDir = path.join(journalRoot, 'card-1');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({ id: 'card-1', poolWaitMs: 11 * 60 * 60 * 1000, poolWaitAttempts: 3, transientRetries: 2, notBefore: '2099-01-01T00:00:00.000Z' })
  );
  const queueDir = mkTmp('spo-poolwait-human-queue-');

  const file = reEnqueueTask(queueDir, taskDir, 'card-1', {}, 7, 'h');

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.poolWaitMs, undefined, 'a human retry restores the full wait allowance');
  assert.equal(written.poolWaitAttempts, undefined);
  assert.equal(written.transientRetries, undefined, 'and the full transient budget');
  assert.equal(written.notBefore, undefined, 'and starts immediately');
  assert.match(path.basename(file), /^0000-retry-h-/, "a human's retry is class 'h'");
});

// ==== part 12: card #173 -- the journal must name the reason a park ACTUALLY parks under =========
//
// finalizePark used to journal `parked` as its FIRST statement, before the cap-exceeded branch's
// `reason`/`detail` reassignment further down had run. Every other reader of a capped park
// (state.json, report.md, daemon.jsonl, alertPark, postParkComment) read the REASSIGNED reason;
// the per-task journal alone kept naming the ORIGINAL pool reason. MEASURED: two successive
// byte-identical capped parks both journalled the ORIGINAL pool reason, while countRepeatedParks
// (whose own header documents "the park just journaled by the caller is itself included and
// always matches itself, so the result is never less than 1") was CALLED, at the bottom of
// finalizePark, with the reassigned cap reason -- so neither journalled line matched the query
// and the streak counted 0 instead of 2. The fix moves the single `parked` emit for the
// ordinary/cap-exceeded paths to after the cap branch closes, so it observes the reassignment and
// journals the same string the query is made with. Both tests below are built to FAIL if that
// emit is ever moved back to the top of finalizePark -- see each test's own comment for the exact
// failure shape under that mutation.

test('T1 (card #173, under-count): two successive byte-identical capped parks are counted by countRepeatedParks, and fire park-repeat', () => {
  const config = testConfig(); // poolExhaustionWaitCapMs: 12h
  const cap = config.poolExhaustionWaitCapMs;
  // priorWaitMs already over the cap, and a PAST deadline (waitMs clamps to 0 via
  // `Math.max(0, deadlineMs - now)`) -- so `accumulated === priorWaitMs` exactly, on both calls,
  // with no millisecond drift from wall-clock timing between the two finalizePark calls. Same
  // ctx/ctx.task for both calls: finalizePark never mutates ctx.task, so priorWaitMs/priorAttempts
  // read identically both times.
  const ctx = buildParkCtx({ config, task: { poolWaitMs: cap + 1, poolWaitAttempts: 3 } });
  const pastDeadline = Date.now() - 5 * 60 * 1000;
  const reason = 'all-accounts-cooling-after-retry';
  const detail = { cooldownUntilIso: new Date(pastDeadline).toISOString() };

  finalizePark(ctx, 'PLAN', reason, detail);
  finalizePark(ctx, 'PLAN', reason, detail);

  const journal = readJournal(ctx.taskDir);
  const parkedEvents = journal.filter((e) => e.event === 'parked');
  assert.equal(parkedEvents.length, 2, 'exactly one parked line per finalizePark call');
  for (const evt of parkedEvents) {
    assert.equal(
      evt.reason,
      'all-accounts-cooling-wait-cap-exceeded',
      'the journal must name the REASSIGNED cap reason -- under the pre-fix mutation this reads the original pool reason instead'
    );
  }
  assert.deepEqual(parkedEvents[0].detail, parkedEvents[1].detail, 'same task, same input, same clamped-to-zero wait -- the reassigned detail must be byte-identical across both runs');

  // Query with the LITERAL cap reason and a detail object CONSTRUCTED HERE, independent of the
  // journal -- exactly what finalizePark's own countRepeatedParks call is made with, after the
  // cap-exceeded reassignment (accumulated = priorWaitMs + 0, since the deadline is in the past;
  // deadlineMs is this test's own `pastDeadline`, byte-identical to what
  // `poolCooldownDeadlineMs` recovers from `cooldownUntilIso`). Reading reason/detail back OUT OF
  // THE JOURNAL instead (as an earlier version of this test did) is tautological: under the
  // mutation the journal is self-consistent too (both lines carry the ORIGINAL reason), so a
  // query built from the journal's own lines still returns 2 and the assertion cannot fail.
  const expectedReason = 'all-accounts-cooling-wait-cap-exceeded';
  const expectedDetail = {
    cooldownUntilIso: detail.cooldownUntilIso,
    accumulatedWaitMs: cap + 1,
    poolWaitAttempts: 3,
    capMs: cap,
    deadlineMs: pastDeadline,
    originalReason: reason,
  };
  const count = countRepeatedParks(journal, expectedReason, expectedDetail);
  assert.equal(
    count,
    2,
    "countRepeatedParks' own documented invariant: the park just journaled is itself included, so it is never less than 1 -- two identical capped parks in a row must count as 2"
  );

  const repeatEvents = journal.filter((e) => e.event === 'park-repeat');
  assert.equal(repeatEvents.length, 1, 'a park-repeat event must fire once the streak reaches 2');
  assert.equal(repeatEvents[0].reason, 'all-accounts-cooling-wait-cap-exceeded');
  assert.equal(repeatEvents[0].repeat, 2);
});

test('T2 (card #173, over-count): a capped park followed by a DIFFERENT (ordinary) park under the original reason must not be counted as a repeat', () => {
  // Same taskDir for both calls (so the journal accumulates across them), two different ctx
  // objects (buildParkCtx always mints a fresh taskDir, so this one is built by hand).
  const journalRoot = mkTmp('spo-poolwait-journal-');
  const taskDir = path.join(journalRoot, 'card-1');
  fs.mkdirSync(taskDir, { recursive: true });

  const cap = testConfig().poolExhaustionWaitCapMs;
  const pastDeadline = Date.now() - 5 * 60 * 1000;
  // The `-until-` family member: its deadline is recoverable from the REASON SUFFIX itself
  // (poolCooldownDeadlineMs's last-resort parse), so `detail` carries NO deadline keys at all and
  // can be byte-identical between the capped park and the ordinary park that follows it.
  const reason = `all-accounts-cooling-until-${new Date(pastDeadline).toISOString()}`;
  const detail = { checkedAccounts: ['a'] };

  // park 1: queueDir present, poolWaitMs already over the cap -> enters the pool branch, CAPPED,
  // reason/detail reassigned.
  const config1 = testConfig();
  const ctx1 = buildCtx(
    'card-1',
    { id: 'card-1', kind: 'card', issue: 1, title: 'x', poolWaitMs: cap + 1, poolWaitAttempts: 3 },
    taskDir,
    { ...config1, deps: { spawnSync: () => ok('') } }
  );
  finalizePark(ctx1, 'PLAN', reason, detail);

  const parked1 = readJournal(taskDir).filter((e) => e.event === 'parked');
  assert.equal(parked1.length, 1);
  assert.equal(parked1[0].reason, 'all-accounts-cooling-wait-cap-exceeded', 'sanity: park 1 really is the capped park');

  // park 2: the SAME reason string and SAME detail as the call above, but no queueDir configured
  // -- the pool branch's own inner guard (`typeof poolQueueDir === 'string' && poolQueueDir !== ''`,
  // the same guard test/pool-exhaustion-wait.test.js's own "a config with no queueDir parks
  // honestly" test exercises) fails before the cap is even checked, so this call never enters the
  // pool branch at all and falls straight through to the ordinary park under the ORIGINAL reason
  // and detail it was called with -- unreassigned.
  const { queueDir, ...config2 } = testConfig();
  const ctx2 = buildCtx('card-1', { id: 'card-1', kind: 'card', issue: 1, title: 'x' }, taskDir, {
    ...config2,
    deps: { spawnSync: () => ok('') },
  });
  finalizePark(ctx2, 'PLAN', reason, detail);

  const journal2 = readJournal(taskDir);
  const parked2 = journal2.filter((e) => e.event === 'parked');
  assert.equal(parked2.length, 2, 'exactly one parked line per finalizePark call');
  assert.equal(parked2[1].reason, reason, 'park 2 must journal the ORIGINAL until-reason -- it never entered the cap branch');
  assert.deepEqual(parked2[1].detail, detail, 'and the exact detail it was called with, with no deadline keys added');
  assert.notEqual(parked2[1].reason, parked1[0].reason, 'sanity: the two parks really do carry different reasons');

  // Under the pre-fix mutation (journal at the top of finalizePark), park 1 would journal the
  // ORIGINAL until-reason with this same detail (the reassignment had not happened yet when the
  // journal line was written), and park 2 journals the identical until-reason/detail again --
  // count 2, park-repeat fires, and this assertion fails.
  const count = countRepeatedParks(journal2, parked2[1].reason, parked2[1].detail);
  assert.equal(count, 1, 'park 2 is not a repeat of park 1 -- they park under different reasons and must not be conflated');
  assert.ok(!journal2.some((e) => e.event === 'park-repeat'), 'no park-repeat event for a streak of 1');
});

test('T3 (card #178, phantom park): ZERO `parked` lines on either re-enqueue-SUCCESS path, exactly one on cap-exceeded, re-enqueue-failure, and ordinary', () => {
  // (a) transient-retry re-enqueued (early return): this path never reaches PARKED at all -- it
  // comes back around through takeNextTask -- so it must journal NO `parked` line, only its own
  // `transient-retry` event. An earlier version of finalizePark journalled a `parked` line here
  // too (immediately before `transient-retry`), which is exactly the card #178 defect: two bounded
  // auto-retries followed by one genuine park under the same reason+detail made countRepeatedParks
  // (park-loop.js) return 3 instead of 1, firing `park-repeat` on a card's first-ever real park.
  const transConfig = testConfig();
  const transCtx = buildParkCtx({ config: transConfig });
  finalizePark(transCtx, 'WORKTREE', 'claim-rate-limited', { exit: 4 });
  const transJournal = readJournal(transCtx.taskDir);
  assert.ok(transJournal.some((e) => e.event === 'transient-retry'), 'sanity: this really is the transient-retry re-enqueue-success path');
  assert.equal(transJournal.filter((e) => e.event === 'parked').length, 0, 'transient-retry re-enqueue-success path must journal no parked line -- the card was not parked');

  // (b) pool-wait re-enqueued (early return): same shape as (a), for the sibling branch -- must
  // also journal no `parked` line, only its own `pool-wait` event.
  const poolConfig = testConfig();
  const poolCtx = buildParkCtx({ config: poolConfig });
  finalizePark(poolCtx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(Date.now() + 60000).toISOString() });
  const poolJournal = readJournal(poolCtx.taskDir);
  assert.ok(poolJournal.some((e) => e.event === 'pool-wait'), 'sanity: this really is the pool-wait re-enqueue-success path');
  assert.equal(poolJournal.filter((e) => e.event === 'parked').length, 0, 'pool-wait re-enqueue-success path must journal no parked line -- the card was not parked');

  // (c) cap-exceeded
  const capConfig = testConfig();
  const capCtx = buildParkCtx({ config: capConfig, task: { poolWaitMs: capConfig.poolExhaustionWaitCapMs + 1, poolWaitAttempts: 1 } });
  finalizePark(capCtx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(Date.now() + 60000).toISOString() });
  assert.equal(readJournal(capCtx.taskDir).filter((e) => e.event === 'parked').length, 1, 'cap-exceeded path');

  // (d) re-enqueue-failure (pool-wait-failed): a blocked queueDir makes reEnqueueTask throw.
  const blocker = path.join(mkTmp('spo-poolwait-blocked-'), 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const failConfig = testConfig({ queueDir: path.join(blocker, 'queue') });
  const failCtx = buildParkCtx({ config: failConfig });
  finalizePark(failCtx, 'PLAN', 'all-accounts-cooling-after-retry', { cooldownUntilIso: new Date(Date.now() + 60000).toISOString() });
  const failJournal = readJournal(failCtx.taskDir);
  assert.equal(failJournal.filter((e) => e.event === 'parked').length, 1, 're-enqueue-failure path');
  assert.ok(failJournal.some((e) => e.event === 'pool-wait-failed'), 'sanity: this really is the failure path');

  // (e) ordinary park -- no branch taken at all (an unrelated, non-pool, non-transient reason).
  const ordConfig = testConfig();
  const ordCtx = buildParkCtx({ config: ordConfig });
  finalizePark(ordCtx, 'PLAN', 'plan-invalid', {});
  assert.equal(readJournal(ordCtx.taskDir).filter((e) => e.event === 'parked').length, 1, 'ordinary park path');
});
