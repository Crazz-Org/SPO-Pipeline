'use strict';
// Pins the property action 6.1 measured and journal.js's own header now documents at length:
// concurrent fs.appendFileSync calls from SEPARATE PROCESSES against the same daemon.jsonl file
// produce every line, and every line parses -- never a torn/interleaved one -- because each call
// is exactly one O_APPEND write(2) syscall, and POSIX guarantees a single write(2) to an
// O_APPEND-opened regular file on a local filesystem is atomic with respect to other writers.
//
// Real child PROCESSES, not worker_threads or in-process concurrency: the property under test is
// specifically about SEPARATE PROCESSES racing the same fd-less O_APPEND open (each process opens
// its own fd via appendFileSync), which is exactly the shape action 6.3 introduces (the dispatcher
// and every worker it spawns all call appendDaemonEvent against the same <journalRoot>/daemon.jsonl).
// A smaller N and fewer iterations than action 6.1's own original measurement (8 procs x 400
// calls) on purpose -- this suite's own wall-time budget (CLAUDE.md: "keep it in that
// neighbourhood") does not allow re-running the full original measurement on every `node --test`;
// this pins the PROPERTY, the full measurement lives in this action's own verification notes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

require('./no-real-spawn');
const { mkTmp } = require('./helpers');

const JOURNAL_MODULE = path.join(__dirname, '..', 'orchestrator', 'journal.js');

// One real child process, appending `count` lines of a `size`-byte-ish detail field each, as fast
// as it can in a tight loop -- no artificial delay between calls, so this is the WORST case for
// interleaving (calls landing as close together in wall time as this machine allows).
function spawnAppender(journalRoot, procIndex, count, size) {
  const script = `
    const { appendDaemonEvent } = require(${JSON.stringify(JOURNAL_MODULE)});
    const journalRoot = ${JSON.stringify(journalRoot)};
    const proc = ${procIndex};
    const pad = 'x'.repeat(${size});
    for (let i = 0; i < ${count}; i++) {
      appendDaemonEvent(journalRoot, 'probe', { proc, i, pad });
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`appender ${procIndex} exited ${code}: ${stderr}`));
    });
    child.once('error', reject);
  });
}

test('daemon.jsonl: concurrent appends from real child processes produce N parsable lines, none torn or lost', async () => {
  const journalRoot = mkTmp('spo-journal-concurrent-');
  const NUM_PROCS = 6;
  const CALLS_PER_PROC = 60;
  const DETAIL_SIZE = 2000; // ~2 KB per line, the middle of action 6.1's own 100 B / 2 KB / 40 KB sweep

  await Promise.all(
    Array.from({ length: NUM_PROCS }, (_, p) => spawnAppender(journalRoot, p, CALLS_PER_PROC, DETAIL_SIZE))
  );

  const raw = fs.readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, NUM_PROCS * CALLS_PER_PROC, 'line count does not match -- a write was lost or two writes merged into one line');

  const seen = new Set();
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      assert.fail(`unparsable line (torn write): ${err.message} -- raw: ${line.slice(0, 200)}`);
    }
    assert.equal(parsed.event, 'probe');
    assert.equal(typeof parsed.proc, 'number');
    assert.equal(typeof parsed.i, 'number');
    assert.equal(parsed.pad.length, DETAIL_SIZE);
    seen.add(`${parsed.proc}:${parsed.i}`);
  }
  // Every (proc, i) pair appears EXACTLY once -- no torn line silently merged two records into a
  // still-parsable-but-wrong one, and no record was dropped.
  assert.equal(seen.size, NUM_PROCS * CALLS_PER_PROC);
});
