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

const { appendEvent, appendDaemonEvent, appendLedgerLine, writeState, writeReport } = require('./journal');
const { scratchDir } = require('./task-values');
const { makeFixtureReader } = require('./fixture');
const { ParkSignal } = require('./park-signal');
const { callWithDeadline } = require('./deadline');
const {
  runScripted,
  sleep,
  realWorktree,
  realCheck,
  realPushPr,
  realGate,
  realCiChecks,
  realMerge,
  realFinish,
} = require('./steps/scripted');
const { runLlm } = require('./steps/llm');
const { classifyCiFailure } = require('./ci-cause-table');
const accounts = require('./accounts');
const { moveCard } = require('./board');
const { postParkComment, unparkScan } = require('./park-loop');
const { alertPark } = require('./park-alert');
const { totalSpentUsd } = require('./cost');
const { shouldAutoPull, runAutoPull } = require('./auto-pull');

// True once neither shadow fixtures nor --dry-run's fixture-free stand-ins apply -- the only
// condition under which a scripted step's handler dispatches to steps/scripted.js's real
// per-state functions (realWorktree, realCheck, ...), which spawn actual git/npm/gh commands.
// Reachable today only via daemon.js's --real flag (see handleIntake's own gate on
// kind: "card" tasks) or a direct unit test constructing ctx by hand.
function isRealMode(ctx) {
  return !ctx.shadowMode && !ctx.dryRun;
}

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
// (AllAccountsCoolingError), the task is PARKED -- the spec's "then PARKED" for this path. An
// empty pool (accounts.pick()'s NoAccountsRegisteredError -- no subdirectories under
// claudeAccountsDir at all) is mapped to PARKED the same way; see also daemon.js, which
// refuses to even START in --real mode on an empty pool.
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
      if (err instanceof accounts.AllAccountsCoolingError || err instanceof accounts.NoAccountsRegisteredError) {
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
  // A kind: "card" task reaching real execution (neither --shadow nor --dry-run) needs the
  // driver to have explicitly opted in with daemon.js's --real flag -- real scripted steps spawn
  // actual git/npm/gh commands against the product repo. Checked here, not just at the CLI, so
  // any caller that builds ctx.config by hand (a future scheduler, a test) gets the same refusal
  // rather than a card silently running for real.
  if (ctx.task.kind === 'card' && isRealMode(ctx) && !(ctx.config && ctx.config.real)) {
    throw new ParkSignal('real-flag-required', { kind: ctx.task.kind });
  }
  appendEvent(ctx.taskDir, 'INTAKE', 'ok', { title: ctx.task.title, kind: ctx.task.kind });
  return 'WORKTREE';
}

async function handleWorktree(ctx) {
  if (ctx.fixture('nightlyMainRed', false)) {
    throw new ParkSignal('main-red-refuse-worktree', {});
  }
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'WORKTREE', () => realWorktree(ctx, ctx.deps));
  }
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'WORKTREE', () =>
    runScripted(ctx, 'worktree', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'WORKTREE', 'result', { exit, stdoutTail });
  if (exit === 0) {
    // --dry-run's generic runScripted() path (unlike realWorktree) never runs a real `git
    // worktree add`, so it never learns a worktreePath/branch. A real kind: "card" task from
    // spo pull/makeTask carries neither (see orchestrator/intake.js's makeTask), so without this
    // the PLAN prompt template's `worktree` placeholder is left unfilled and the task PARKs at
    // PLAN -- defeating --dry-run as a pre-flight check. Synthesize the same names realWorktree
    // would have picked, but only when a fixture/test hasn't already set one.
    if (ctx.dryRun && !ctx.task.worktreePath) {
      ctx.task.worktreePath = path.join(ctx.config.pipelineWorktreesDir, ctx.id);
      ctx.task.branch = `claude-pipe/${ctx.id}`;
    }
    return 'PLAN';
  }
  throw new ParkSignal('worktree-failed', { exit });
}

// PLAN runs permissionMode: 'plan' (step-contracts.js) -- the harness refuses every Write call,
// so the model cannot write plan-<issue>.md / invariants-<issue>.md itself (confirmed by
// today's real run of card issue-247: plan-mode Write refusals, followed by the model reporting
// paths in its structured output anyway -- files that were never created). PLAN's contract
// (prompts/plan.md, step-contracts.js) now has the model RETURN both documents' full text as
// plan_markdown/invariants_markdown; this handler is the one place that writes them, the same
// division of labour intake.js's draftCard (composes) / fileCard (writes) already uses.
//
// `result === null` means no shadow.llm.PLAN fixture was wired for this task at all (fixture.js
// returns the caller's default) -- the pre-existing "trivially ok, nothing to validate"
// convention this file already used before this fix (see handleImplement below, same idiom) is
// kept unchanged for that case: there is no plan content to validate or write, and plenty of
// tests unrelated to PLAN rely on it. Once a payload actually exists -- a real LLM reply, an
// explicit shadow fixture, or --dry-run's own canned payload (steps/llm.js) -- it is held to the
// real contract.
async function handlePlan(ctx) {
  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', ctx.deps);
  const payload = result === null ? { ok: true } : result;
  appendEvent(ctx.taskDir, 'PLAN', 'result', { payload });
  if (!payload || payload.ok === false) {
    throw new ParkSignal('plan-invalid', { payload });
  }
  if (result === null) return 'IMPLEMENT';

  const planMarkdown = payload.plan_markdown;
  const invariantsMarkdown = payload.invariants_markdown;
  const missing = [];
  if (typeof planMarkdown !== 'string' || planMarkdown.trim() === '') missing.push('plan_markdown');
  if (typeof invariantsMarkdown !== 'string' || invariantsMarkdown.trim() === '') missing.push('invariants_markdown');
  if (missing.length > 0) {
    throw new ParkSignal('plan-invalid', { payload, missing });
  }

  const dir = scratchDir(ctx.taskDir);
  fs.mkdirSync(dir, { recursive: true });
  const issue = ctx.task && ctx.task.issue != null ? ctx.task.issue : ctx.id;
  const planPath = path.join(dir, `plan-${issue}.md`);
  const invariantsPath = path.join(dir, `invariants-${issue}.md`);
  fs.writeFileSync(planPath, planMarkdown);
  fs.writeFileSync(invariantsPath, invariantsMarkdown);
  appendEvent(ctx.taskDir, 'PLAN', 'files-written', { planPath, invariantsPath });

  // Re-journal PLAN's 'result' with plan_path/invariants_path added -- task-values.js's
  // lastResultPayload reads the *last* PLAN 'result' event for IMPLEMENT/VALIDATE's own
  // placeholder derivation, and that lookup must keep resolving to these exact paths.
  appendEvent(ctx.taskDir, 'PLAN', 'result', {
    payload: { ...payload, plan_path: planPath, invariants_path: invariantsPath },
  });

  return 'IMPLEMENT';
}

// Parses IMPLEMENT's files_changed value, which arrives as either a real array or (as seen in
// today's card issue-247 run) a JSON-encoded string like "[]". Returns null for anything that
// isn't cleanly one or the other -- missing, unparsable, or the wrong shape are all treated the
// same as "no files changed" by the caller below.
function parseFilesChanged(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function handleImplement(ctx) {
  // Kanban piloting: move to "Implementing" before the LLM call -- IMPLEMENT is an LLM step, not
  // a scripted one, so there is no realX(ctx, deps) function for board.js's moveCard to live
  // inside; it runs here instead, gated the same way every real-mode call in this file is.
  if (isRealMode(ctx)) moveCard(ctx, ctx.deps, 'IMPLEMENT');
  const result = await callLlmStep(ctx, 'IMPLEMENT', 'llm.IMPLEMENT', ctx.deps);
  const payload = result === null ? { ok: true } : result;
  appendEvent(ctx.taskDir, 'IMPLEMENT', 'result', { payload });
  if (!payload || payload.ok === false) return 'DIAGNOSE';

  // Transport-level ok:true is not enough to trust CHECK with the worktree: today's real run of
  // card issue-247 saw IMPLEMENT return {ok: true, filesChanged: "[]", allGreen: "false",
  // summary: "Cannot proceed: the required plan file ... does not exist"} -- the old code sent
  // that straight to CHECK, which passed on the untouched worktree, and PUSH_PR only then parked
  // (push-pr-failed, "nothing to commit") two states and one misleading reason later than the
  // real problem. Route an empty/unparsable files_changed to DIAGNOSE instead, the existing
  // bounded remediation path.
  //
  // Gated on BOTH isRealMode(ctx) AND the payload actually carrying a files_changed/filesChanged
  // key, not on isRealMode alone -- two existing, legitimate shapes would otherwise break:
  //   - --dry-run's own canned IMPLEMENT payload (steps/llm.js's cannedDryRunPayload) reports
  //     files_changed: [] on purpose (nothing really ran); isRealMode(ctx) is already false for
  //     --dry-run, so the key-presence check is redundant there but kept for clarity.
  //   - the legacy ctx.task.llm.IMPLEMENT override path (steps/llm.js's runLlm: "honoured
  //     verbatim, no outputContract validation" -- still real mode, still exercised by
  //     test/board-move.test.js) returns invokeClaudeReal's raw {ok, result, ...} shape, which
  //     never has a files_changed field at all -- that is a different payload shape, not an
  //     empty-implement bug, so it is left alone and still reaches CHECK as before.
  // A legitimate implement with red tests (non-empty filesChanged, allGreen false) is untouched
  // by either condition and still reaches CHECK exactly as today.
  if (isRealMode(ctx)) {
    const hasFilesChangedField =
      Object.prototype.hasOwnProperty.call(payload, 'files_changed') ||
      Object.prototype.hasOwnProperty.call(payload, 'filesChanged');
    if (hasFilesChangedField) {
      const raw = 'files_changed' in payload ? payload.files_changed : payload.filesChanged;
      const filesChanged = parseFilesChanged(raw);
      if (!filesChanged || filesChanged.length === 0) {
        appendEvent(ctx.taskDir, 'IMPLEMENT', 'empty-implement', { filesChanged: raw, summary: payload.summary });
        return 'DIAGNOSE';
      }
    }
  }

  return 'CHECK';
}

async function handleCheck(ctx) {
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'CHECK', () => realCheck(ctx, ctx.deps));
  }
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'CHECK', () =>
    runScripted(ctx, 'check', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'CHECK', 'result', { exit, stdoutTail });
  if (exit === 0) return 'PUSH_PR';
  return 'DIAGNOSE';
}

async function handlePushPr(ctx) {
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'PUSH_PR', () => realPushPr(ctx, ctx.deps));
  }
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'PUSH_PR', () =>
    runScripted(ctx, 'pushPr', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'PUSH_PR', 'result', { exit, stdoutTail });
  if (exit === 0) return 'GATE';
  throw new ParkSignal('push-pr-failed', { exit });
}

async function handleGate(ctx) {
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'GATE', () => realGate(ctx, ctx.deps));
  }
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
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'CI_CHECKS', () => realCiChecks(ctx, ctx.deps));
  }
  const failingCheck = ctx.fixture('ciChecks', null);
  if (failingCheck) {
    appendEvent(ctx.taskDir, 'CI_CHECKS', 'check-failed', { check: failingCheck });
    const outcome = classifyCiFailure(failingCheck);
    if (outcome.kind === 'park') throw new ParkSignal(outcome.reason, { check: failingCheck });
    return outcome.nextState;
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

  const result = await callLlmStep(ctx, 'DIAGNOSE', 'llm.DIAGNOSE', ctx.deps);
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
  // Kanban piloting: move to "Validation" once per VALIDATE entry, before either LLM call --
  // same reasoning as handleImplement's own moveCard (no realX(ctx, deps) split for an LLM step).
  if (isRealMode(ctx)) moveCard(ctx, ctx.deps, 'VALIDATE');

  if (ctx.task.touchesRdoMembers) {
    const cv = await callLlmStep(ctx, 'CITATION_VERIFIER', 'llm.CITATION_VERIFIER', ctx.deps);
    const verdict = (cv && cv.verdict) || 'PASS';
    appendEvent(ctx.taskDir, 'VALIDATE', 'citation-verifier', { verdict });
    if (verdict === 'REJECT') throw new ParkSignal('citation-false', { verdict });
    // PASS or DIVERGES both continue -- DIVERGES is flagged for a human, not blocking.
  }

  const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', ctx.deps);
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
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'MERGE', () => realMerge(ctx, ctx.deps));
  }
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
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'FINISH', () => realFinish(ctx, ctx.deps));
  }
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

// dryRun (daemon.js's --dry-run): real-mode semantics -- config.shadowMode stays false, so
// callLlmStep takes its real branch (step-contracts.js + prompt-template.js, account rotation)
// -- but nothing spawns. steps/llm.js's runLlm and steps/scripted.js's runScripted both check
// ctx.dryRun before their own spawn point and return a fixture-free "assumed success" (scripted)
// or a canned outputContract-satisfying payload (LLM), so a --dry-run run can walk a synthetic
// card task to DONE with zero subprocesses and zero `claude` CLI calls.
function buildCtx(id, task, taskDir, config) {
  return {
    id,
    task,
    taskDir,
    config,
    shadowMode: !!config.shadowMode,
    dryRun: !!config.dryRun,
    fixture: makeFixtureReader(task),
    // The one real-mode injection point every realX(ctx, deps)/callLlmStep(ctx, ..., deps) call
    // site in this file now threads through: production never sets config.deps, so this is {}
    // (real spawnSync/claude) unless a test explicitly builds config with one -- same convention
    // as steps/scripted.js's own deps.spawnSync, one level up so board.js's moveCard and
    // park-loop.js's postParkComment (called from inside this file, with no realX split of
    // their own) share it too.
    deps: (config && config.deps) || {},
    account: null, // set per-attempt by callLlmStep in real mode; unused in shadow mode
    prNumber: null, // set by realPushPr once `gh pr create`'s URL is parsed; unused in shadow mode
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
    prNumber: ctx.prNumber || null,
    worktreePath: (ctx.task && ctx.task.worktreePath) || null,
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

  // The daemon-level feed: one `parked` line in <journalRoot>/daemon.jsonl alongside the
  // per-task event above, so daemon.jsonl reads as the single chronological "needs a human"
  // stream (auto-pull cycles, lock takeovers, parks). All modes -- it is a file append, and
  // taskDir is join(journalRoot, id) by construction (takeNextTask), so dirname recovers the
  // root without threading a new parameter through every ctx.
  appendDaemonEvent(path.dirname(ctx.taskDir), 'parked', { id: ctx.id, reason, lastState });

  // The push half: SPO_PARK_ALERT_CMD, real mode only (an external spawn -- shadow/dry-run
  // tests must see none, same rule as postParkComment below). Never blocks -- park-alert.js
  // carries board.js's failure policy.
  if (isRealMode(ctx)) {
    alertPark(ctx, ctx.deps, { reason, lastState });
  }

  // Kanban piloting, the park half of the round trip: real mode, kind:"card" tasks only -- never
  // for shadow/dry-run (every existing PARKED test in this suite is shadow mode and must see no
  // new spawn) and never for a non-card task (nothing to comment on). park-loop.js's own
  // moveCard('PARKED') call inside postParkComment skips itself, journaled, when the worktree
  // was never created (a pre-WORKTREE park) -- the gh comment still posts either way.
  if (isRealMode(ctx) && ctx.task && ctx.task.kind === 'card') {
    postParkComment(ctx, ctx.deps, { reason, detail, lastState });
  }
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

// The cumulative spend ceiling (config.soakBudgetUsd, unset = no ceiling). Distinct from
// step-contracts.js's PER-STEP caps: this one bounds what the whole pipeline may spend across
// every task in a journal root, which is what an unattended soak actually needs bounded.
//
// It stops the daemon TAKING NEW WORK -- never an in-flight task: a card killed mid-flight
// leaves a worktree, a branch and possibly a PR half-done, which costs more to clean up than
// the overrun it would have saved. Queued tasks stay in queue/ (untaken), and auto-pull stops
// enqueuing (runForever), so raising the ceiling later resumes exactly where it stopped.
//
// Returns the spend when the ceiling is reached, else null. Journals once per stop.
function ceilingReached(journalRoot, config) {
  const ceiling = config && config.soakBudgetUsd;
  if (!(ceiling > 0)) return null;
  const spent = totalSpentUsd(journalRoot);
  return spent >= ceiling ? { spent, ceiling } : null;
}

async function drainQueueOnce(queueDir, journalRoot, config) {
  const results = [];
  let ceilingJournaled = false;
  for (;;) {
    // Checked BEFORE takeNextTask, so a refused task is left in queue/ rather than taken and
    // parked -- nothing to clean up, and it runs untouched once the ceiling is raised.
    const hit = ceilingReached(journalRoot, config);
    if (hit) {
      if (!ceilingJournaled) {
        appendDaemonEvent(journalRoot, 'budget-ceiling-reached', {
          spentUsd: Number(hit.spent.toFixed(4)),
          ceilingUsd: hit.ceiling,
          queued: listQueueFiles(queueDir).length,
        });
        ceilingJournaled = true;
      }
      break;
    }

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
// --shadow --once against a fully-prepared queue), same as before this function grew two more
// real-mode-only calls -- park-loop.js's unparkScan (kanban piloting's retry/abandon
// round trip) and auto-pull.js's timed board pull, both individually unit-tested against
// injected deps elsewhere (test/park-loop.test.js, test/auto-pull.test.js). config.real gates
// both the same way isRealMode(ctx) gates everything else real in this file; config.deps is the
// same injection point buildCtx already threads through HANDLERS.
async function runForever(queueDir, journalRoot, config) {
  let lastAutoPullAt = null;
  for (;;) {
    await drainQueueOnce(queueDir, journalRoot, config);

    if (config.real) {
      const deps = config.deps || {};
      await unparkScan(queueDir, journalRoot, config, deps);

      // Auto-pull respects the same ceiling: past it, stop bringing NEW cards onto the board.
      // drainQueueOnce has already journaled the stop for this pass.
      const now = Date.now();
      if (!ceilingReached(journalRoot, config) && shouldAutoPull(lastAutoPullAt, now, config.autoPullMs)) {
        lastAutoPullAt = now;
        await runAutoPull(queueDir, journalRoot, config, deps);
      }
    }

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
