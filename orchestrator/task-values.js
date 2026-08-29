'use strict';
// task-values.js -- derives the {{placeholder}} -> value object for one LLM step, from a
// `kind: "card"` task's own fields plus what earlier states already journaled.
//
// Two kinds of source, per placeholder:
//   - known at build time: read straight off ctx.task (issue, title, criterion, worktreePath,
//     size, touchesRdoMembers, citations, ...) or computed from ctx.taskDir (scratch_dir,
//     ledger_path -- always the same file journal.js already owns).
//   - unknown at build time: produced by an EARLIER state's own LLM call and only exists once
//     that state has run -- PLAN's plan_path/invariants_path/invariant_ids/check_commands feed
//     IMPLEMENT and VALIDATE. These are read back from journal.jsonl's own 'result' event for
//     that state (state-machine.js's handlePlan already does
//     `appendEvent(ctx.taskDir, 'PLAN', 'result', { payload })` -- this module is the reader
//     side of that same record, never a second source of truth).
//
// diff_path / gate_log_path / gate_report_path are named here as fixed, taskDir-relative
// conventions (journal/<id>/diff.patch, gate.log, gate-report.md) that no scripted step in this
// build yet writes -- CHECK/GATE/PUSH_PR real execution remains "a documented stub" per
// orchestrator/README.md "Running shadow mode". Naming the path now fixes the contract a future
// real implementation of those steps must honour; nothing reads or writes through it today.

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

// The most recent {state, event: 'result', payload} record for `state` in journal.jsonl, or
// null if that state hasn't produced one yet (fresh task, or the state never ran). Reads the
// file fresh every call -- this module is consulted once per LLM step invocation, never in a
// hot loop, so no caching is worth the staleness risk across daemon restarts.
function lastResultPayload(taskDir, state) {
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
    if (event.state === state && event.event === 'result' && event.payload) {
      return event.payload;
    }
  }
  return null;
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
      };
    }

    case 'DIAGNOSE':
      return {
        diff_path: diffPath(taskDir),
        gate_log_path: gateLogPath(taskDir),
        ledger_path: ledgerPath(taskDir),
      };

    case 'CITATION_VERIFIER':
      return {
        diff_path: diffPath(taskDir),
        spo_original_path: task.spoOriginalPath || DEFAULT_SPO_ORIGINAL_PATH,
        citations: task.citations,
      };

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
  scratchDir,
  diffPath,
  gateLogPath,
  gateReportPath,
  ledgerPath,
  DEFAULT_SPO_ORIGINAL_PATH,
};
