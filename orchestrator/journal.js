'use strict';
// Append-only journal I/O for one task's runtime directory (journal/<id>/).
//
//   journal.jsonl - one JSON object per line: {ts, state, event, ...detail}. Never rewritten.
//   ledger.md     - one line per DIAGNOSE attempt: "attempt N | root cause | outcome".
//   state.json    - current state + counters, overwritten on every transition (a snapshot,
//                   not a log -- the console reads it for the "current" columns).
//   report.md     - written once, only when a task is PARKED.
//
// This module never decides anything; it only records what the state machine already decided.

const fs = require('fs');
const path = require('path');

function appendEvent(taskDir, state, event, detail = {}) {
  const record = { ts: new Date().toISOString(), state, event, ...detail };
  fs.appendFileSync(path.join(taskDir, 'journal.jsonl'), JSON.stringify(record) + '\n');
}

// A daemon-level counterpart to appendEvent, for events that belong to no single task -- today
// only auto-pull.js's `auto-pull` cycle summary. Lives at <journalRoot>/daemon.jsonl, sibling to
// the per-task journal/<id>/ directories, same append-only shape minus the `state` field (there
// is no state machine involved).
function appendDaemonEvent(journalRoot, event, detail = {}) {
  fs.mkdirSync(journalRoot, { recursive: true });
  const record = { ts: new Date().toISOString(), event, ...detail };
  fs.appendFileSync(path.join(journalRoot, 'daemon.jsonl'), JSON.stringify(record) + '\n');
}

function appendLedgerLine(taskDir, attemptN, rootCause, outcome) {
  fs.appendFileSync(path.join(taskDir, 'ledger.md'), `attempt ${attemptN} | ${rootCause} | ${outcome}\n`);
}

function writeState(taskDir, snapshot) {
  fs.writeFileSync(path.join(taskDir, 'state.json'), JSON.stringify(snapshot, null, 2) + '\n');
}

function writeReport(taskDir, { id, reason, lastState, ts, detail }) {
  const body = [
    `# Parked: ${id}`,
    '',
    `reason: ${reason}`,
    `lastState: ${lastState}`,
    `timestamp: ${ts}`,
    '',
    '## detail',
    '```json',
    JSON.stringify(detail || {}, null, 2),
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(taskDir, 'report.md'), body);
}

module.exports = { appendEvent, appendDaemonEvent, appendLedgerLine, writeState, writeReport };
