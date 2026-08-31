'use strict';
// Append-only journal I/O for one task's runtime directory (journal/<id>/).
//
//   journal.jsonl - one JSON object per line: {ts, state, event, ...detail}. Never rewritten.
//   ledger.md     - one line per DIAGNOSE attempt ("attempt N | root cause | outcome") plus one
//                   line per VALIDATE REJECT ("validate-reject N | <reasons> | outcome") --
//                   action 1.6, see appendLedgerLine's own `kind` parameter.
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

// `kind` defaults to 'attempt' (DIAGNOSE's own lines, unchanged shape) -- action 1.6 passes
// 'validate-reject' for a VALIDATE REJECT so the two are visually distinct in ledger.md while
// keeping the same readable "<kind> N | <text> | <outcome>" one-liner-per-attempt shape, and
// without touching any existing DIAGNOSE call site or the ledger parsing tests already rely on.
function appendLedgerLine(taskDir, attemptN, rootCause, outcome, kind = 'attempt') {
  fs.appendFileSync(path.join(taskDir, 'ledger.md'), `${kind} ${attemptN} | ${rootCause} | ${outcome}\n`);
}

// Atomic within a filesystem: write to a tmp file in the SAME directory as state.json, then
// rename over it. A crash or kill -9 mid-write leaves the tmp file behind (harmless, ignored by
// every reader) but state.json itself is always either the old complete snapshot or the new
// complete snapshot -- never truncated. orphan-scan.js and every daemon restart depend on that.
function writeState(taskDir, snapshot) {
  const target = path.join(taskDir, 'state.json');
  const tmp = path.join(taskDir, `.state.json.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp was never created, or rename already moved it -- nothing to clean up either way.
    }
    throw err;
  }
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
