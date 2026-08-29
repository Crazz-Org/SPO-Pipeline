'use strict';
// The engine: the lifecycle table from doc/state-machine-spec.md v1.1, one handler per state,
// a queue drain loop, and the journal/ledger/state.json/report.md bookkeeping around it.
//
// Lifecycle (spec v1.1):
//   INTAKE -> WORKTREE -> PLAN -> IMPLEMENT -> CHECK -> PUSH_PR -> GATE -> CI_CHECKS ->
//   VALIDATE -> MERGE -> FINISH -> DONE
//   IMPLEMENT/CHECK/GATE(1)/CI_CHECKS(unmatched check) -> DIAGNOSE -> IMPLEMENT (retry)
//   any state -> PARKED (catch-all: report + stop; PARKED is terminal for the daemon)
//
// Contract each handler follows: `async (ctx) => nextStateString`, or `throw new
// ParkSignal(reason, detail)` to end the task at PARKED. A handler must never return a state
// name that departs from the table above -- the only place unknown-state routing happens is
// the outer loop's `HANDLERS[state]` lookup, which is also how a fixture-injected bogus state
// (task.shadow.forceState) exercises the catch-all in tests.
//
// A handler-internal JavaScript bug (as opposed to a recognized bad state/exit/verdict, which
// is always an explicit ParkSignal) is deliberately NOT caught here -- it propagates and fails
// the daemon run loudly. The spec's catch-all is about states/exits/outputs the *task* can
// produce, not about hiding programming errors in this engine.

const fs = require('fs');
const path = require('path');

const { appendEvent, appendLedgerLine, writeState, writeReport } = require('./journal');
const { makeFixtureReader } = require('./fixture');
const { ParkSignal } = require('./park-signal');
const { callWithDeadline } = require('./deadline');
const { runScripted, sleep } = require('./steps/scripted');
const { runLlm } = require('./steps/llm');
const accounts = require('./accounts');

// ---- LLM step invocation, with account rotation in real mode --------------------------------
//
// Shadow mode: identical to calling callWithDeadline(ctx, stepName, () => runLlm(...)) directly
// -- every existing shadow-mode test asserts on the exact journal/state.json shape that produces,
// so this branch must stay byte-for-byte what it replaces.
//
// Real mode: one pass over the healthy accounts, per state-machine-spec.md § Account pool ("a
// limit error ... puts the account in cooldown ... and the step retries on the next healthy
// account"). accounts.pick() already skips cooling accounts; when a call comes back
// {kind: 'limit'}, this cools that account down (accounts.markLimit, journaled as
// 'account-cooldown') and asks pick() again for the next one. The loop is bounded to the number
// of enabled accounts in the registry, so a step can never retry the same account twice or spin
// forever: once every account has been tried, or pick() itself finds none healthy
// (AllAccountsCoolingError), the task is PARKED -- the spec's "then PARKED" for this path.
async function callLlmStep(ctx, stepName, fixtureKey, deps = {}) {
  if (ctx.shadowMode) {
    return callWithDeadline(ctx, stepName, () => runLlm(ctx, stepName, fixtureKey, deps));
  }

  const accountsDir = ctx.config.claudeAccountsDir;
  const maxAttempts = Math.max(accounts.readRegistry(accountsDir).filter((a) => a.enabled).length, 1);

  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let account;
    try {
      account = accounts.pick(accountsDir);
    } catch (err) {
      if (err instanceof accounts.AllAccountsCoolingError) {
        throw new ParkSignal(err.reason, err.detail);
      }
      throw err;
    }

    ctx.account = account;
    result = await callWithDeadline(ctx, stepName, () => runLlm(ctx, stepName, fixtureKey, deps));

    if (!(result && result.ok === false && result.kind === 'limit')) {
      return result;
    }

    const event = accounts.markLimit(accountsDir, account.name, result.retryAfterMs);
    appendEvent(ctx.taskDir, stepName, 'account-cooldown', event);
  }

  throw new ParkSignal('all-accounts-cooling-after-retry', { attempts: maxAttempts, lastResult: result });
}

// ---- per-state handlers ----------------------------------------------------------------

async function handleIntake(ctx) {
  if (!ctx.task || ctx.task.__invalid) {
    throw new ParkSignal('invalid-task-json', { rawPreview: ctx.task && ctx.task.rawPreview });
  }
  if (ctx.task.shadow && ctx.task.shadow.forceState) {
    const to = ctx.task.shadow.forceState;
    appendEvent(ctx.taskDir, 'INTAKE', 'force-state', { to });
    return to;
  }
  appendEvent(ctx.taskDir, 'INTAKE', 'ok', { title: ctx.task.title, kind: ctx.task.kind });
  return 'WORKTREE';
}

async function handleWorktree(ctx) {
  if (ctx.fixture('nightlyMainRed', false)) {
    throw new ParkSignal('main-red-refuse-worktree', {});
  }
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'WORKTREE', () =>
    runScripted(ctx, 'worktree', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'WORKTREE', 'result', { exit, stdoutTail });
  if (exit === 0) return 'PLAN';
  throw new ParkSignal('worktree-failed', { exit });
}

async function handlePlan(ctx) {
  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN');
  const payload = result === null ? { ok: true } : result;
  appendEvent(ctx.taskDir, 'PLAN', 'result', { payload });
  if (payload && payload.ok !== false) return 'IMPLEMENT';
  throw new ParkSignal('plan-invalid', { payload });
}

async function handleImplement(ctx) {
  const result = await callLlmStep(ctx, 'IMPLEMENT', 'llm.IMPLEMENT');
  const payload = result === null ? { ok: true } : result;
  appendEvent(ctx.taskDir, 'IMPLEMENT', 'result', { payload });
  if (payload && payload.ok !== false) return 'CHECK';
  return 'DIAGNOSE';
}

async function handleCheck(ctx) {
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'CHECK', () =>
    runScripted(ctx, 'check', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'CHECK', 'result', { exit, stdoutTail });
  if (exit === 0) return 'PUSH_PR';
  return 'DIAGNOSE';
}

async function handlePushPr(ctx) {
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'PUSH_PR', () =>
    runScripted(ctx, 'pushPr', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'PUSH_PR', 'result', { exit, stdoutTail });
  if (exit === 0) return 'GATE';
  throw new ParkSignal('push-pr-failed', { exit });
}

async function handleGate(ctx) {
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'GATE', () =>
    runScripted(ctx, 'gate', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'GATE', 'result', { exit, stdoutTail });
  if (exit === 0) return 'CI_CHECKS';
  if (exit === 1) return 'DIAGNOSE';
  if (exit === 2) throw new ParkSignal('gate-dirty-tree', { exit });
  if (exit === 3) throw new ParkSignal('gate-worker-down', { exit });
  if (exit === 4) throw new ParkSignal('gate-timeout', { exit });
  throw new ParkSignal('gate-unrecognized-exit', { exit });
}

// CI_CHECKS does two things, in order, per state-machine-spec.md's (a)/(b):
//  (a) map the one failing check name (if any) this visit;
//  (b) only if (a) was green: the main-moved test, at most one re-merge-and-regate per task.
async function handleCiChecks(ctx) {
  const failingCheck = ctx.fixture('ciChecks', null);
  if (failingCheck) {
    appendEvent(ctx.taskDir, 'CI_CHECKS', 'check-failed', { check: failingCheck });
    if (failingCheck === 'Coverage of changed lines') return 'IMPLEMENT';
    if (failingCheck === 'Lint') return 'IMPLEMENT';
    if (failingCheck === 'PR rules') throw new ParkSignal('pr-rules-needs-approval', { check: failingCheck });
    return 'DIAGNOSE';
  }
  appendEvent(ctx.taskDir, 'CI_CHECKS', 'checks-green', {});

  const moved = ctx.fixture('mainMoved', false);
  if (!moved) return 'VALIDATE';

  if (ctx.fixture('nightlyMainRed', false)) {
    throw new ParkSignal('main-red-no-merge', {});
  }
  if (ctx.counters.mainMoveUsed) {
    throw new ParkSignal('main-moved-twice', {});
  }
  ctx.counters.mainMoveUsed = true;
  appendEvent(ctx.taskDir, 'CI_CHECKS', 'main-moved-merge', {});
  return 'CHECK';
}

// DIAGNOSE budget: at most config.diagnoseBudget attempts, and any root cause seen before
// (this task only) parks immediately, even under budget. Ledger gets a line for every attempt,
// including the one that trips either rule.
async function handleDiagnose(ctx) {
  if (ctx.counters.diagnoseAttempts >= ctx.config.diagnoseBudget) {
    // Defensive: should be unreachable, since the budget check below always parks on the
    // attempt that reaches it rather than letting a further one be attempted.
    throw new ParkSignal('diagnose-budget-exhausted', { attempts: ctx.counters.diagnoseAttempts });
  }

  const result = await callLlmStep(ctx, 'DIAGNOSE', 'llm.DIAGNOSE');
  const attemptN = ++ctx.counters.diagnoseAttempts;
  const rootCause = (result && result.rootCause) || `unspecified-cause-${attemptN}`;
  appendEvent(ctx.taskDir, 'DIAGNOSE', 'result', { attempt: attemptN, rootCause });

  const duplicate = ctx.counters.seenRootCauses.has(rootCause);
  const budgetExhausted = attemptN >= ctx.config.diagnoseBudget;
  const outcome = duplicate ? 'parked (duplicate root cause)' : budgetExhausted ? 'parked (budget exhausted)' : 'retry';
  appendLedgerLine(ctx.taskDir, attemptN, rootCause, outcome);

  if (duplicate) throw new ParkSignal('diagnose-duplicate-root-cause', { attempt: attemptN, rootCause });
  ctx.counters.seenRootCauses.add(rootCause);
  if (budgetExhausted) throw new ParkSignal('diagnose-budget-exhausted', { attempt: attemptN, rootCause });
  return 'IMPLEMENT';
}

// VALIDATE: citation-verifier only when the task touches rdo-members.ts, then change-validator.
// change-validator REJECT has its own budget (config.validateRejectBudget), separate from
// DIAGNOSE's -- a false citation from citation-verifier parks immediately, no budget.
async function handleValidate(ctx) {
  if (ctx.task.touchesRdoMembers) {
    const cv = await callLlmStep(ctx, 'CITATION_VERIFIER', 'llm.CITATION_VERIFIER');
    const verdict = (cv && cv.verdict) || 'PASS';
    appendEvent(ctx.taskDir, 'VALIDATE', 'citation-verifier', { verdict });
    if (verdict === 'REJECT') throw new ParkSignal('citation-false', { verdict });
    // PASS or DIVERGES both continue -- DIVERGES is flagged for a human, not blocking.
  }

  const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE');
  const verdict = result && result.verdict;
  appendEvent(ctx.taskDir, 'VALIDATE', 'change-validator', { verdict, findings: result && result.findings });

  if (verdict === 'PASS' || verdict === 'PASS_WITH_FINDINGS') return 'MERGE';
  if (verdict === 'REJECT') {
    ctx.counters.validateRejects += 1;
    if (ctx.counters.validateRejects >= ctx.config.validateRejectBudget) {
      throw new ParkSignal('validate-reject-budget-exhausted', { rejects: ctx.counters.validateRejects });
    }
    return 'IMPLEMENT';
  }
  throw new ParkSignal('validate-unrecognized-verdict', { verdict });
}

// MERGE: gh pr merge --merge (enqueue) + pr:wait; pr:wait exit 4 (still open) gets exactly one
// bounded re-wait, never a loop. Exit 0 -> FINISH, anything else -> PARKED.
async function handleMerge(ctx) {
  const enqueue = await callWithDeadline(ctx, 'MERGE', () => runScripted(ctx, 'prMergeEnqueue', { defaultExit: 0 }));
  appendEvent(ctx.taskDir, 'MERGE', 'pr-merge-enqueue', { exit: enqueue.exit });
  if (enqueue.exit !== 0) throw new ParkSignal('pr-merge-enqueue-failed', { exit: enqueue.exit });

  const w1 = await callWithDeadline(ctx, 'MERGE', () => runScripted(ctx, 'prWait', { defaultExit: 0 }));
  appendEvent(ctx.taskDir, 'MERGE', 'pr-wait', { attempt: 1, exit: w1.exit });
  if (w1.exit === 0) return 'FINISH';
  if (w1.exit === 1) throw new ParkSignal('pr-closed-unmerged', { exit: w1.exit });
  if (w1.exit === 4) {
    const w2 = await callWithDeadline(ctx, 'MERGE', () => runScripted(ctx, 'prWait', { defaultExit: 0 }));
    appendEvent(ctx.taskDir, 'MERGE', 'pr-wait', { attempt: 2, exit: w2.exit, bounded: true });
    if (w2.exit === 0) return 'FINISH';
    throw new ParkSignal('merge-queue-not-landing', { lastExit: w2.exit });
  }
  throw new ParkSignal('pr-wait-unrecognized-exit', { exit: w1.exit });
}

async function handleFinish(ctx) {
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'FINISH', () =>
    runScripted(ctx, 'finish', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'FINISH', 'result', { exit, stdoutTail });
  if (exit === 0) return 'DONE';
  throw new ParkSignal('finish-failed', { exit });
}

const HANDLERS = {
  INTAKE: handleIntake,
  WORKTREE: handleWorktree,
  PLAN: handlePlan,
  IMPLEMENT: handleImplement,
  CHECK: handleCheck,
  PUSH_PR: handlePushPr,
  GATE: handleGate,
  CI_CHECKS: handleCiChecks,
  DIAGNOSE: handleDiagnose,
  VALIDATE: handleValidate,
  MERGE: handleMerge,
  FINISH: handleFinish,
};

// ---- task runner ------------------------------------------------------------------------

function buildCtx(id, task, taskDir, config) {
  return {
    id,
    task,
    taskDir,
    config,
    shadowMode: !!config.shadowMode,
    fixture: makeFixtureReader(task),
    account: null, // set per-attempt by callLlmStep in real mode; unused in shadow mode
    counters: {
      diagnoseAttempts: 0,
      seenRootCauses: new Set(),
      validateRejects: 0,
      mainMoveUsed: false,
    },
  };
}

function snapshot(ctx, state) {
  return {
    id: ctx.id,
    title: ctx.task && ctx.task.title,
    kind: ctx.task && ctx.task.kind,
    state,
    diagnoseAttempts: ctx.counters.diagnoseAttempts,
    validateRejects: ctx.counters.validateRejects,
    mainMoveUsed: ctx.counters.mainMoveUsed,
    updatedAt: new Date().toISOString(),
  };
}

function finalizePark(ctx, lastState, reason, detail) {
  appendEvent(ctx.taskDir, lastState, 'parked', { reason, detail });
  const snap = snapshot(ctx, 'PARKED');
  snap.reason = reason;
  snap.lastState = lastState;
  writeState(ctx.taskDir, snap);
  writeReport(ctx.taskDir, { id: ctx.id, reason, lastState, ts: snap.updatedAt, detail });
}

// Runs one task through the state machine to completion (DONE or PARKED). Never throws for a
// recognized outcome -- a ParkSignal anywhere in the handler chain is caught here and turned
// into the PARKED terminal state. An unrecognized state name (HANDLERS[state] undefined,
// including one injected by a shadow fixture for testing) is itself routed through ParkSignal,
// which is the catch-all the spec calls for.
async function runTask(id, task, taskDir, config) {
  const ctx = buildCtx(id, task, taskDir, config);
  let state = 'INTAKE';
  writeState(taskDir, snapshot(ctx, state));

  // Runaway guard: a real handler bug that returns a valid-looking but cyclic path (e.g. an
  // infinite DIAGNOSE<->IMPLEMENT loop from a logic error) still terminates the run instead of
  // hanging the daemon. Every legitimate path above completes in well under this many hops.
  let hops = 0;
  const HOP_LIMIT = 200;

  while (state !== 'DONE' && state !== 'PARKED') {
    if (++hops > HOP_LIMIT) {
      finalizePark(ctx, state, 'state-machine-runaway', { hops });
      return 'PARKED';
    }
    const handler = HANDLERS[state];
    if (!handler) {
      finalizePark(ctx, state, 'unrecognized-state', { state });
      return 'PARKED';
    }
    let next;
    try {
      next = await handler(ctx);
    } catch (err) {
      if (err instanceof ParkSignal) {
        finalizePark(ctx, state, err.reason, err.detail);
        return 'PARKED';
      }
      throw err; // a real bug -- surface it, do not disguise it as a park
    }
    appendEvent(taskDir, state, 'transition', { to: next });
    state = next;
    writeState(taskDir, snapshot(ctx, state));
  }

  if (state === 'DONE') {
    appendEvent(taskDir, 'DONE', 'done', {});
    writeState(taskDir, snapshot(ctx, 'DONE'));
  }
  return state;
}

// ---- queue draining -----------------------------------------------------------------------

function listQueueFiles(queueDir) {
  if (!fs.existsSync(queueDir)) return [];
  return fs
    .readdirSync(queueDir)
    .filter((f) => f.endsWith('.json'))
    .sort(); // processing order = filename sort
}

// Takes the earliest task file (by filename sort) out of queue/ and into its own runtime dir,
// journal/<id>/task.json -- moving it (not copying) is what makes "queue depth" mean "not yet
// taken" for `spo status`, and what keeps a polling daemon from reprocessing it.
function takeNextTask(queueDir, journalRoot) {
  const files = listQueueFiles(queueDir);
  if (files.length === 0) return null;
  const file = files[0];
  const srcPath = path.join(queueDir, file);
  const raw = fs.readFileSync(srcPath, 'utf8');

  let task;
  try {
    task = JSON.parse(raw);
  } catch {
    task = { __invalid: true, rawPreview: raw.slice(0, 200) };
  }
  const id = task && task.id ? String(task.id) : path.basename(file, '.json');
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.renameSync(srcPath, path.join(taskDir, 'task.json'));
  appendEvent(taskDir, 'INTAKE', 'taken', { fromFile: file });

  return { id, task, taskDir };
}

async function drainQueueOnce(queueDir, journalRoot, config) {
  const results = [];
  for (;;) {
    const taken = takeNextTask(queueDir, journalRoot);
    if (!taken) break;
    const { id, task, taskDir } = taken;
    const finalState = await runTask(id, task, taskDir, config);
    results.push({ id, finalState });
  }
  return results;
}

// Polls the queue directory forever, draining whatever has arrived since the last pass. Used
// by `daemon.js` when --once is not given; not exercised by the test suite (which always runs
// --shadow --once against a fully-prepared queue).
async function runForever(queueDir, journalRoot, config) {
  for (;;) {
    await drainQueueOnce(queueDir, journalRoot, config);
    await sleep(config.pollIntervalMs);
  }
}

module.exports = {
  HANDLERS,
  runTask,
  listQueueFiles,
  takeNextTask,
  drainQueueOnce,
  runForever,
  callLlmStep, // exported for direct unit tests of the account-rotation retry loop (real mode)
  buildCtx,
};
