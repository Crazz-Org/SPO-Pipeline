'use strict';
// task-values.js -- derives the {{placeholder}} -> value object for one LLM step, from a
// `kind: "card"` task's own fields plus what earlier states already journaled.
//
// Two kinds of source, per placeholder:
//   - known at build time: read straight off ctx.task (issue, title, criterion, worktreePath,
//     size, touchesRdoMembers, ...) or computed from ctx.taskDir (scratch_dir, ledger_path --
//     always the same file journal.js already owns).
//   - unknown at build time: produced by an EARLIER state's own call and only exists once that
//     state has run. PLAN's plan_path/invariants_path/invariant_ids/check_commands feed IMPLEMENT
//     and VALIDATE, read back from journal.jsonl's own 'result' event for that state
//     (state-machine.js's handlePlan already does
//     `appendEvent(ctx.taskDir, 'PLAN', 'result', { payload })` -- this module is the reader
//     side of that same record, never a second source of truth). CITATION_VERIFIER's `citations`
//     is the same idea one state earlier: PUSH_PR's own scripted step (realPushPr, not an LLM
//     call) journals a `{state: 'PUSH_PR', event: 'rdo-citation', citations}` record and also
//     sets ctx.task.citations in memory for same-process reuse -- this module prefers the
//     in-memory value and falls back to the journal record so a daemon restart between PUSH_PR
//     and VALIDATE doesn't silently drop it.
//
// diff_path / gate_log_path / gate_report_path are fixed, taskDir-relative conventions
// (journal/<id>/diff.patch, gate.log, gate-report.md). Action 1.3 made these real: on entry to
// DIAGNOSE/VALIDATE in real mode, state-machine.js's handleDiagnose/handleValidate call
// steps/scripted.js's prepareJudgeInputs (before the LLM call) to generate diff.patch (from
// `git diff origin/main...HEAD` once committed, plain `git diff` beforehand) and, when the bench
// has recorded a verdict for this HEAD sha, gate-report.md. gate.log is written by realGate
// (overwriting on every real gate run, unlike logs/GATE.log's own accumulating append) and is
// only ever read back here -- prepareJudgeInputs never runs the gate itself. VALIDATE requires
// diff.patch (parks 'judge-inputs-missing' if it cannot be produced); DIAGNOSE requires gate.log
// only when it was entered from GATE (ctx.cameFrom === 'GATE'), never otherwise -- see
// state-machine.js's runTask and steps/scripted.js's prepareJudgeInputs for the full contract.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_SPO_ORIGINAL_PATH = path.join(os.homedir(), 'SPO-Original');

function scratchDir(taskDir) {
  return path.join(taskDir, 'scratch');
}

function diffPath(taskDir) {
  return path.join(taskDir, 'diff.patch');
}

function gateLogPath(taskDir) {
  return path.join(taskDir, 'gate.log');
}

function gateReportPath(taskDir) {
  return path.join(taskDir, 'gate-report.md');
}

function ledgerPath(taskDir) {
  return path.join(taskDir, 'ledger.md');
}

// The most recent journal.jsonl record matching `predicate`, scanned backwards, or null if none
// matches (fresh task, that state/event never ran, or the file doesn't exist yet). Reads the
// file fresh every call -- this module is consulted once per LLM step invocation, never in a
// hot loop, so no caching is worth the staleness risk across daemon restarts. Shared by every
// "reader side of a record another module owns" lookup below -- one parse loop, several
// predicates, never a second source of truth.
function lastMatchingEvent(taskDir, predicate) {
  const journalFile = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(journalFile)) return null;

  const lines = fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (predicate(event)) return event;
  }
  return null;
}

// The most recent {ts, state, event: 'result', payload} record for `state` in journal.jsonl, or
// null if that state hasn't produced one yet (fresh task, or the state never ran). Kept as its
// own function (rather than folded into lastResultPayload) because diagnosisSummary below needs
// the record's `ts` too, to decide which of a DIAGNOSE and a VALIDATE-reject record is more
// recent -- lastResultPayload's callers never needed anything but the payload itself.
function lastResultEvent(taskDir, state) {
  return lastMatchingEvent(taskDir, (e) => e.state === state && e.event === 'result' && e.payload);
}

// The most recent {state, event: 'result', payload} record for `state` in journal.jsonl, or
// null if that state hasn't produced one yet (fresh task, or the state never ran).
function lastResultPayload(taskDir, state) {
  const event = lastResultEvent(taskDir, state);
  return event ? event.payload : null;
}

// The citations array from the most recent {state: 'PUSH_PR', event: 'rdo-citation', citations}
// record journaled by realPushPr (orchestrator/steps/scripted.js), or null if none exists yet.
// The length check matches the task-side non-empty test in buildPromptValues, and is what keeps
// this fallback fail-closed: prompt-template.js's missing-placeholder test is `=== undefined ||
// === null`, so an EMPTY array is not "missing" -- returning [] here would fill the prompt with
// an empty citation list and let CITATION_VERIFIER run on nothing instead of parking. realPushPr
// never journals an empty array (it parks rdo-citation-missing first), so this is defensive
// only, but the fail-open it forecloses is exactly the one action 1.1 closed at VALIDATE.
// This is the restart-durable fallback for CITATION_VERIFIER's `citations` placeholder: realPushPr
// also sets ctx.task.citations in memory for the SAME process's VALIDATE pass to read directly,
// but ctx.task is rebuilt from the task file on a daemon restart, so a restart between PUSH_PR
// and VALIDATE would otherwise lose it silently.
function lastJournaledCitations(taskDir) {
  const event = lastMatchingEvent(
    taskDir,
    (e) =>
      e.state === 'PUSH_PR' && e.event === 'rdo-citation' && Array.isArray(e.citations) && e.citations.length > 0
  );
  return event ? event.citations : null;
}

// The most recent DIAGNOSE finding and/or VALIDATE REJECT, as an IMPLEMENT-facing summary, or a
// fixed "none yet" string when neither has ever happened for this task (never undefined --
// fillPromptTemplate treats undefined as a missing placeholder, and IMPLEMENT's very first
// invocation for a task has no such event to read).
//
// Two independent sources feed this, each journaled by its own state as a 'result' event nested
// under `payload` (state-machine.js's handleDiagnose / handleValidate; see either one's own
// comment on why -- lastResultPayload only ever looks at `event.payload`):
//   - DIAGNOSE: an earlier CHECK/GATE/CI_CHECKS failure, root cause + category + suggestedFix.
//   - VALIDATE: the change was actually built, pushed, gated green, and the change-validator
//     REJECTed it -- reasons (+ findings, though validate-change.md documents REJECT as always
//     carrying an empty findings list).
// These name two different failures ("the gate/check failed and DIAGNOSE says X" vs. "the
// change was built and the validator rejected it because Y") that call for different work from
// IMPLEMENT, so both are rendered distinctly, never merged into one undifferentiated line. When
// both exist, the one journaled MOST RECENTLY (by `ts`) is presented first/primary -- it is the
// finding that actually explains why THIS IMPLEMENT attempt is happening -- but the older one
// stays visible too, since a still-live earlier diagnosis can remain relevant.
function diagnosisSummary(taskDir) {
  const diagEvent = lastResultEvent(taskDir, 'DIAGNOSE');
  const validateEvent = lastResultEvent(taskDir, 'VALIDATE');
  const diag = diagEvent && diagEvent.payload;
  const val = validateEvent && validateEvent.payload;

  let diagText = null;
  if (diag && diag.rootCause) {
    const parts = [`DIAGNOSE (a check/gate/CI failure): root cause: ${diag.rootCause}`];
    if (diag.category) parts.push(`category: ${diag.category}`);
    if (diag.suggestedFix) parts.push(`suggested fix: ${diag.suggestedFix}`);
    diagText = parts.join(' | ');
  }

  // A REJECT is threaded whenever one was journalled at all -- reasons and findings are BOTH
  // optional on the wire. Guarding the whole block on non-empty `reasons` (as this first did)
  // meant a rejection carrying only `findings` threaded nothing, and if an older DIAGNOSE
  // existed, its stale cause was presented to IMPLEMENT as the current one, with no hint that a
  // rejection had just happened -- the precise failure 1.6 exists to prevent. handleValidate
  // already writes '(no reason given)' on the ledger side for this case; match it here.
  let valText = null;
  if (val) {
    const hasReasons = Array.isArray(val.reasons) && val.reasons.length > 0;
    const findingTitles = Array.isArray(val.findings)
      ? val.findings.map((f) => f && f.title).filter(Boolean)
      : [];
    const summary = hasReasons ? val.reasons.join('; ') : '(no reason given)';
    const parts = [`VALIDATE REJECT (the change was built and the validator rejected it): ${summary}`];
    if (findingTitles.length > 0) parts.push(`findings: ${findingTitles.join('; ')}`);
    valText = parts.join(' | ');
  }

  if (!diagText && !valText) return '(none yet -- this is the first IMPLEMENT attempt for this task)';
  if (diagText && !valText) return diagText;
  if (valText && !diagText) return valText;

  const diagIsMoreRecent = diagEvent.ts > validateEvent.ts;
  const primary = diagIsMoreRecent ? diagText : valText;
  const earlier = diagIsMoreRecent ? valText : diagText;
  return `${primary} || also, from an earlier attempt: ${earlier}`;
}

function commonValues(ctx) {
  const task = ctx.task || {};
  return {
    issue_number: task.issue,
    task_title: task.title,
    task_criterion: task.criterion,
    worktree: task.worktreePath,
    scratch_dir: scratchDir(ctx.taskDir),
    task_size: task.size,
  };
}

// Builds the {{placeholder}}: value object for `stepName`, ready to hand to
// prompt-template.js's fillPromptTemplate(). A value left `undefined` here (e.g. PLAN never ran
// yet, so plan_path is unavailable to IMPLEMENT) surfaces as fillPromptTemplate's own
// MissingPlaceholderError -- this function never itself decides "missing", it only looks.
function buildPromptValues(ctx, stepName) {
  const task = ctx.task || {};
  const taskDir = ctx.taskDir;
  const common = commonValues(ctx);

  switch (stepName) {
    case 'PLAN':
      return common;

    case 'IMPLEMENT': {
      const plan = lastResultPayload(taskDir, 'PLAN') || {};
      return {
        issue_number: common.issue_number,
        worktree: common.worktree,
        task_criterion: common.task_criterion,
        plan_path: plan.plan_path,
        invariants_path: plan.invariants_path,
        invariant_ids: plan.invariant_ids,
        check_commands: plan.check_commands,
        diagnosis: diagnosisSummary(taskDir),
      };
    }

    case 'DIAGNOSE':
      return {
        diff_path: diffPath(taskDir),
        gate_log_path: gateLogPath(taskDir),
        ledger_path: ledgerPath(taskDir),
      };

    case 'CITATION_VERIFIER': {
      // Only a NON-EMPTY array counts as citations, from either source. Anything else -- absent,
      // an empty array, or some other shape a hand-written task file supplied -- resolves to
      // undefined on purpose, which is prompt-template.js's missing-placeholder condition
      // (`=== undefined || === null`) and parks the card. An empty array would NOT be "missing"
      // there: it stringifies to '', the prompt fills, and CITATION_VERIFIER runs with nothing to
      // verify -- the same fail-open action 1.1 closed one step later at VALIDATE.
      const taskCitations = Array.isArray(task.citations) && task.citations.length > 0 ? task.citations : null;
      const citations = taskCitations || lastJournaledCitations(taskDir) || undefined;
      return {
        diff_path: diffPath(taskDir),
        spo_original_path: task.spoOriginalPath || DEFAULT_SPO_ORIGINAL_PATH,
        citations,
      };
    }

    case 'VALIDATE': {
      const plan = lastResultPayload(taskDir, 'PLAN') || {};
      return {
        diff_path: diffPath(taskDir),
        task_criterion: common.task_criterion,
        invariants_path: plan.invariants_path,
        invariant_ids: plan.invariant_ids,
        gate_report_path: gateReportPath(taskDir),
      };
    }

    default:
      return common;
  }
}

module.exports = {
  buildPromptValues,
  lastResultPayload,
  lastResultEvent,
  lastJournaledCitations,
  scratchDir,
  diffPath,
  gateLogPath,
  gateReportPath,
  ledgerPath,
  DEFAULT_SPO_ORIGINAL_PATH,
};
