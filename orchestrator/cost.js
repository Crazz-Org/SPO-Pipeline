'use strict';
// cost.js -- what the pipeline has spent, read back out of the journals.
//
// The journals are the truth (same principle as the console and `spo status`): every real
// `claude -p` call already records its own `costUsd` in an `llm-call` event (steps/llm.js,
// summed across models by its sumCost). This module only adds them up -- it never records
// anything, and there is no second ledger to keep in sync.
//
// Two callers, one computation:
//   - `spo cost`                        the soak's read-out (per task, and the aggregate)
//   - state-machine.js's runForever     the cumulative spend ceiling (config.soakBudgetUsd)
//
// A task that parked and was retried keeps every attempt's cost, because every attempt is in
// its journal -- which is the honest number for "what did this card cost", not the cost of
// the successful pass alone.

const fs = require('fs');
const path = require('path');

// One task's journal, reduced. Missing/unreadable lines are skipped rather than thrown on: a
// journal being appended to while we read it must never crash the daemon that is writing it.
function readTaskCost(journalRoot, id) {
  const file = path.join(journalRoot, id, 'journal.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // not a task directory (no journal) -- caller filters it out
  }

  let costUsd = 0;
  let llmCalls = 0;
  const parkReasons = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a torn final line while the daemon writes -- skip, do not throw
    }
    if (event.event === 'llm-call') {
      llmCalls += 1;
      if (typeof event.costUsd === 'number') costUsd += event.costUsd;
    } else if (event.event === 'parked') {
      parkReasons.push(event.reason);
    }
  }

  let state = 'UNKNOWN';
  try {
    state = JSON.parse(fs.readFileSync(path.join(journalRoot, id, 'state.json'), 'utf8')).state || 'UNKNOWN';
  } catch {
    // a task taken but not yet snapshotted -- UNKNOWN is the honest answer
  }

  return { id, state, costUsd, llmCalls, parkReasons };
}

function listTaskIds(journalRoot) {
  try {
    return fs
      .readdirSync(journalRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// costReport(journalRoot) -> {tasks: [...], totalUsd, done, parked, parks}
//
// `parks` counts park EVENTS, not parked tasks: a card can park several times and still reach
// DONE (issue-247 parked 6 times), and the two numbers answer different questions -- which is
// exactly the distinction the soak needs to report.
function costReport(journalRoot) {
  const tasks = [];
  for (const id of listTaskIds(journalRoot)) {
    const row = readTaskCost(journalRoot, id);
    if (row) tasks.push(row);
  }
  return {
    tasks,
    totalUsd: tasks.reduce((sum, t) => sum + t.costUsd, 0),
    done: tasks.filter((t) => t.state === 'DONE').length,
    parked: tasks.filter((t) => t.state === 'PARKED').length,
    parks: tasks.reduce((n, t) => n + t.parkReasons.length, 0),
  };
}

// totalSpentUsd(journalRoot) -- the ceiling's hot path; same sum, without building the rows.
function totalSpentUsd(journalRoot) {
  return costReport(journalRoot).totalUsd;
}

module.exports = { costReport, totalSpentUsd, readTaskCost };
