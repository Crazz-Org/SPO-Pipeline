'use strict';
// Unit tests for action 5.1d: surfacing DIAGNOSE on the card. Measured: 6 tasks entered DIAGNOSE
// in the journal corpus (18 attempts total, 4 ending in a park) with zero card-visible trace --
// a card in DIAGNOSE looks identical, from the board, to a card sitting in "Implementing" doing
// nothing. state-machine.js's handleDiagnose now calls park-loop.js's postDiagnoseSurfaceComment
// exactly once per task, on the FIRST DIAGNOSE entry only (ctx.counters.diagnoseSurfaced), real
// mode only, and it must never block the task -- same policy as board.js's moveCard, for the same
// reason (a maintainer notification is best-effort). Every spawn here is an injected
// deps.spawnSync; nothing touches a real git/gh/npm/claude process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { buildDiagnoseSurfaceComment } = require('../orchestrator/park-loop');
const { timeoutResult } = require('./helpers');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function ok(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null };
}
function fail(status) {
  return { status, stdout: '', stderr: 'boom', signal: null };
}
function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// invokeClaudeReal's own real-shaped reply -- same helper shape test/board-move.test.js's
// realShapedPayload uses for the legacy ctx.task.llm.<step> override path (no root_cause key on
// the raw {ok, result, ...} shape, so handleDiagnose falls back to its own unique
// unspecified-cause-N per attempt -- irrelevant to this action, but it keeps every attempt out of
// the duplicate-root-cause park so the "second entry" case below can actually be reached).
function realShapedPayload(resultString) {
  return JSON.stringify({
    result: resultString,
    is_error: false,
    num_turns: 1,
    session_id: 'sess-diag-surface-1',
    modelUsage: { 'claude-x': { costUSD: 0.001 } },
    terminal_reason: 'success',
    api_error_status: null,
  });
}

// Same convention as test/board-move.test.js's realCtxWithOneAccount: a real (non-shadow, non-
// dry-run) ctx driven through the legacy ctx.task.llm.DIAGNOSE override, which bypasses step-
// contracts.js entirely -- the cheapest way to reach a real handleDiagnose call without the full
// PLAN/prompt-template wiring a `kind: "card"` task would otherwise need.
function diagnoseCtx({ id, issue, spawnSync, configOverrides = {} }) {
  const accountsDir = mkTmp('spo-diagsurf-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  const task = {
    id,
    kind: 'card',
    issue,
    llm: { DIAGNOSE: { model: 'sonnet', effort: 'low', promptText: 'diagnose it' } },
  };
  return buildCtx(id, task, mkTmp('spo-diagsurf-taskdir-'), {
    shadowMode: false,
    dryRun: false,
    real: true,
    stepDeadlineMs: 30000,
    diagnoseBudget: 3,
    ghRepo: 'Crazz-Org/SPO-WebClient',
    claudeAccountsDir: accountsDir,
    deps: { spawnSync },
    ...configOverrides,
  });
}

test('buildDiagnoseSurfaceComment: names the attempt and the budget, says no human action is needed unless parked', () => {
  const body = buildDiagnoseSurfaceComment({ attempt: 1, budget: 3 });
  assert.match(body, /attempt 1 of 3/);
  assert.match(body, /No human action is needed unless this card parks\./);
});

test('handleDiagnose (real mode): first entry posts exactly one "pipeline diagnosing" comment, correct argv, journals diagnose-surfaced; second entry posts none', async () => {
  const ghCalls = [];
  // Every spawn, in order. The ORDER is a load-bearing property, not decoration: a "the pipeline
  // is diagnosing" notice that arrives after the diagnosis has already run tells a maintainer
  // nothing they could act on. Verification caught this -- moving the whole surface block to
  // after callLlmStep left the suite green, so the property was implemented and asserted
  // nowhere.
  const order = [];
  const spawnSync = (command, args) => {
    order.push(command);
    if (command === 'claude') return ok(realShapedPayload('diagnosis text'));
    if (command === 'gh') {
      ghCalls.push([...args]);
      return ok('https://github.com/Crazz-Org/SPO-WebClient/issues/512#issuecomment-777\n');
    }
    return ok('');
  };
  const ctx = diagnoseCtx({ id: 'card-diagsurf-1', issue: 512, spawnSync });

  const next1 = await HANDLERS.DIAGNOSE(ctx);
  assert.equal(next1, 'IMPLEMENT');
  assert.equal(ghCalls.length, 1, 'exactly one gh call after the first DIAGNOSE entry');
  assert.ok(order.includes('claude'), 'sanity: the DIAGNOSE LLM call really did spawn');
  assert.ok(
    order.indexOf('gh') !== -1 && order.indexOf('gh') < order.indexOf('claude'),
    `the surface comment must be posted BEFORE the DIAGNOSE LLM call, got spawn order ${JSON.stringify(order)}`
  );
  assert.deepEqual(ghCalls[0].slice(0, 4), ['issue', 'comment', '512', '--repo']);
  const bodyFile1 = ghCalls[0][ghCalls[0].indexOf('--body-file') + 1];
  const body1 = fs.readFileSync(bodyFile1, 'utf8');
  assert.match(body1, /attempt 1 of 3/);

  let journal = readJournal(ctx.taskDir);
  const surfaced = journal.filter((e) => e.event === 'diagnose-surfaced');
  assert.equal(surfaced.length, 1);
  assert.deepEqual(surfaced[0], { ...surfaced[0], attempt: 1, budget: 3 });

  // Second DIAGNOSE entry, same ctx (exactly how a DIAGNOSE -> IMPLEMENT -> ... -> DIAGNOSE retry
  // re-enters the handler in the real runTask loop) -- no new comment, no new journal line.
  const next2 = await HANDLERS.DIAGNOSE(ctx);
  assert.equal(next2, 'IMPLEMENT');
  assert.equal(ghCalls.length, 1, 'no second gh call on the second DIAGNOSE entry');

  journal = readJournal(ctx.taskDir);
  assert.equal(journal.filter((e) => e.event === 'diagnose-surfaced').length, 1, 'still exactly one, ever');
});

test('handleDiagnose (real mode): a failing gh issue comment never blocks -- journals diagnose-surface-failed, DIAGNOSE still resolves normally', async () => {
  const ghCalls = [];
  const spawnSync = (command, args) => {
    if (command === 'claude') return ok(realShapedPayload('diagnosis text'));
    if (command === 'gh') {
      ghCalls.push([...args]);
      return fail(1);
    }
    return ok('');
  };
  const ctx = diagnoseCtx({ id: 'card-diagsurf-2', issue: 513, spawnSync });

  const next = await HANDLERS.DIAGNOSE(ctx);
  assert.equal(next, 'IMPLEMENT', 'a failed surface comment must never block DIAGNOSE itself');
  assert.equal(ghCalls.length, 1);

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'diagnose-surface-failed');
  assert.ok(failed);
  assert.equal(failed.exit, 1);
  assert.ok(!journal.some((e) => e.event === 'diagnose-surfaced'));
});

test('handleDiagnose (real mode): a timed-out gh issue comment never throws -- journalled as diagnose-surface-failed with timedOut: true, task proceeds regardless', async () => {
  const ghCalls = [];
  const spawnSync = (command, args) => {
    if (command === 'claude') return ok(realShapedPayload('diagnosis text'));
    if (command === 'gh') {
      ghCalls.push([...args]);
      return timeoutResult();
    }
    return ok('');
  };
  const ctx = diagnoseCtx({
    id: 'card-diagsurf-3',
    issue: 514,
    spawnSync,
    configOverrides: { commandTimeoutsMs: { gh: 120000 } },
  });

  // A throw here (instead of the expected resolution) fails this test on its own -- no need for
  // assert.doesNotReject, which would discard the resolved value we still want to check below.
  const next = await HANDLERS.DIAGNOSE(ctx);
  assert.equal(next, 'IMPLEMENT');
  assert.equal(ghCalls.length, 1);

  const journal = readJournal(ctx.taskDir);
  const failed = journal.find((e) => e.event === 'diagnose-surface-failed');
  assert.ok(failed, 'a hung gh issue comment must still be reported, not silently swallowed');
  assert.equal(failed.timedOut, true);
  assert.notEqual(failed.exit, 1, 'a timeout must never be journalled as a plain exit 1');
  assert.ok(!journal.some((e) => e.event === 'diagnose-surfaced'));
});

test('handleDiagnose (shadow mode / --dry-run): never surfaces DIAGNOSE at all -- real mode only', async () => {
  const spawnSync = () => {
    throw new Error('shadow/dry-run must never spawn anything for the diagnose-surface comment');
  };

  const shadowCtx = buildCtx(
    'card-diagsurf-shadow',
    { id: 'card-diagsurf-shadow', kind: 'synthetic', issue: 515, shadow: { llm: { DIAGNOSE: { rootCause: 'shadow-cause' } } } },
    mkTmp('spo-diagsurf-shadow-taskdir-'),
    { shadowMode: true, diagnoseBudget: 3, deps: { spawnSync } }
  );
  const nextShadow = await HANDLERS.DIAGNOSE(shadowCtx);
  assert.equal(nextShadow, 'IMPLEMENT');
  assert.ok(!readJournal(shadowCtx.taskDir).some((e) => e.event === 'diagnose-surfaced' || e.event === 'diagnose-surface-failed'));
});
