'use strict';
// Tests for orchestrator/live-progress.js -- card #239 chantier, action A6. The worker-side write
// path (writeLiveProgress/clearLiveProgress/createProgressCallback) and the tolerant read path
// (readLiveProgress) that replaces the five-link transcript-chain probe console/live-step.js used
// to walk. See that module's own header for the full design; this file pins the properties it
// depends on: atomic writes (never a torn read), a finished call leaves nothing behind, the
// throttle actually throttles, and a callback never mixes up two different calls' own tallies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mkTmp } = require('./helpers');
// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident and why this require has to land
// before the orchestrator require(s) below.
require('./no-real-spawn');

const {
  LIVE_PROGRESS_STALE_MS,
  LIVE_PROGRESS_THROTTLE_MS,
  liveProgressPath,
  writeLiveProgress,
  clearLiveProgress,
  readLiveProgress,
  createProgressCallback,
} = require('../orchestrator/live-progress');

function assistantMessage(text, toolName, ts) {
  const content = [];
  if (toolName) content.push({ type: 'tool_use', name: toolName });
  if (text) content.push({ type: 'text', text });
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content } };
}

// ---- the plain I/O -------------------------------------------------------------------------

test('writeLiveProgress then readLiveProgress round-trips the record', () => {
  const dir = mkTmp('spo-live-progress-');
  writeLiveProgress(dir, { step: 'IMPLEMENT', turns: 2, toolCounts: { Bash: 1 }, lastText: 'hi', lastTurnAt: null, updatedAt: 'x' });
  assert.deepEqual(readLiveProgress(dir), {
    step: 'IMPLEMENT',
    turns: 2,
    toolCounts: { Bash: 1 },
    lastText: 'hi',
    lastTurnAt: null,
    updatedAt: 'x',
  });
});

test('readLiveProgress is tolerant of a missing file -- no call has ever written here', () => {
  const dir = mkTmp('spo-live-progress-');
  assert.equal(readLiveProgress(dir), null);
});

test('readLiveProgress is tolerant of an unparsable file rather than throwing', () => {
  const dir = mkTmp('spo-live-progress-');
  fs.writeFileSync(liveProgressPath(dir), '{not json');
  assert.equal(readLiveProgress(dir), null);
});

test('writeLiveProgress writes via a tmp file in the SAME directory, then renames over the target -- a reader never observes a partial write', () => {
  const dir = mkTmp('spo-live-progress-');
  writeLiveProgress(dir, { step: 'PLAN', turns: 1, toolCounts: {}, lastText: null, lastTurnAt: null, updatedAt: 'x' });
  const entries = fs.readdirSync(dir);
  // Exactly one file after the write settles: the target itself. Any leftover .tmp entry would
  // mean the rename never happened (or happened twice, leaving an orphan) -- the same failure
  // mode journal.js's own writeState/writeLiveWorkerIds guard against with the identical idiom.
  assert.deepEqual(entries, ['live-progress.json']);
  // MUTATION CHECK (recorded here, not a live mutation run): swap `fs.renameSync(tmp, target)`
  // for `fs.writeFileSync(target, ...)` directly and this test still passes (a direct write also
  // leaves one file behind) -- the atomicity property itself is not observable from the outside
  // in a single-threaded test the way a torn-read race would need concurrent processes to
  // demonstrate. What this test actually pins is the WEAKER, still real property: no tmp file is
  // ever left on disk after a write completes normally.
});

test('rapid repeated writes to the same taskDir never leave a torn or unparsable file behind', () => {
  const dir = mkTmp('spo-live-progress-');
  // Every write is a fresh tmp-then-rename, so 200 writes in a tight loop is the closest a
  // single-threaded test can get to exercising the same "many small overwrites of one file" shape
  // journal-concurrent-append.test.js proves for the append-only case -- here every one of them
  // must leave the file fully parsable, never mid-write, since each iteration only inspects the
  // result of the PREVIOUS rename (this process's own last write), which is exactly what a second
  // process reading this file mid-stream would also see.
  for (let i = 0; i < 200; i++) {
    writeLiveProgress(dir, { step: 'IMPLEMENT', turns: i, toolCounts: {}, lastText: `turn ${i}`, lastTurnAt: null, updatedAt: String(i) });
    const record = readLiveProgress(dir);
    assert.equal(record.turns, i);
    assert.equal(record.lastText, `turn ${i}`);
  }
});

test('clearLiveProgress removes the record; a card that finished must not read as live', () => {
  const dir = mkTmp('spo-live-progress-');
  writeLiveProgress(dir, { step: 'IMPLEMENT', turns: 1, toolCounts: {}, lastText: 'x', lastTurnAt: null, updatedAt: 'x' });
  assert.notEqual(readLiveProgress(dir), null);
  clearLiveProgress(dir);
  assert.equal(readLiveProgress(dir), null);
});

test('clearLiveProgress is idempotent -- clearing a taskDir with no record is not an error', () => {
  const dir = mkTmp('spo-live-progress-');
  assert.doesNotThrow(() => clearLiveProgress(dir));
  assert.doesNotThrow(() => clearLiveProgress(dir));
});

// ---- the per-message callback -----------------------------------------------------------------

test('createProgressCallback: the first message writes immediately, before any throttle window elapses', () => {
  const dir = mkTmp('spo-live-progress-');
  const onMessage = createProgressCallback({ taskDir: dir, step: 'IMPLEMENT', now: () => 1000 });
  onMessage(assistantMessage('reading the failing test', 'Read', '2026-09-17T00:00:01.000Z'));
  const record = readLiveProgress(dir);
  assert.equal(record.step, 'IMPLEMENT');
  assert.equal(record.turns, 1);
  assert.deepEqual(record.toolCounts, { Read: 1 });
  assert.equal(record.lastText, 'reading the failing test');
  assert.equal(record.lastTurnAt, '2026-09-17T00:00:01.000Z');
  assert.equal(record.updatedAt, new Date(1000).toISOString());
});

test('createProgressCallback: accumulates tool counts and keeps the LAST narrated sentence, across the WHOLE call, not a bounded tail', () => {
  const dir = mkTmp('spo-live-progress-');
  let clock = 0;
  const onMessage = createProgressCallback({ taskDir: dir, step: 'IMPLEMENT', now: () => clock });
  onMessage(assistantMessage('first', 'Read', '2026-09-17T00:00:01.000Z'));
  clock += LIVE_PROGRESS_THROTTLE_MS; // past the throttle window every time, so every call below writes
  onMessage(assistantMessage(null, 'Bash', '2026-09-17T00:00:02.000Z'));
  clock += LIVE_PROGRESS_THROTTLE_MS;
  onMessage(assistantMessage('second', 'Bash', '2026-09-17T00:00:03.000Z'));

  const record = readLiveProgress(dir);
  assert.equal(record.turns, 3);
  assert.deepEqual(record.toolCounts, { Read: 1, Bash: 2 });
  assert.equal(record.lastText, 'second'); // the middle turn had no text block -- lastText survives it
  assert.equal(record.lastTurnAt, '2026-09-17T00:00:03.000Z');
});

test('createProgressCallback: throttles -- messages inside the same window collapse into ONE write, not one per message', () => {
  const dir = mkTmp('spo-live-progress-');
  let clock = 0;
  let writes = 0;
  const realWrite = fs.writeFileSync;
  // Count writes to THIS taskDir's tmp files, the only observable proxy for "did writeLiveProgress
  // actually run" from outside the module (assert the COUNT, per this action's own instruction --
  // not the wall-clock, which a fake clock already sidesteps).
  fs.writeFileSync = (p, ...rest) => {
    if (typeof p === 'string' && p.includes(dir) && p.includes('.live-progress.json.')) writes += 1;
    return realWrite.call(fs, p, ...rest);
  };
  try {
    const onMessage = createProgressCallback({ taskDir: dir, step: 'IMPLEMENT', now: () => clock });
    onMessage(assistantMessage('a', 'Bash', 't1')); // cold start -- writes immediately (write #1)
    for (let i = 0; i < 50; i++) {
      clock += 10; // 50 * 10ms = 500ms, well inside a 2s throttle window
      onMessage(assistantMessage(`turn ${i}`, 'Bash', `t${i}`));
    }
    assert.equal(writes, 1, 'fifty messages inside one throttle window must produce exactly one write');

    clock += LIVE_PROGRESS_THROTTLE_MS; // now past the window
    onMessage(assistantMessage('after the window', 'Bash', 'tN'));
    assert.equal(writes, 2, 'a message past the throttle window writes again');

    const record = readLiveProgress(dir);
    assert.equal(record.lastText, 'after the window');
    // MUTATION CHECK: delete the throttle gate entirely (always write) and this test goes red at
    // `writes === 1` (52 writes instead); delete the "always write the FIRST message" branch
    // instead (gate on the throttle from message 1) and the cold-start property above goes red
    // (writes stays 0 until the window first elapses) -- both mutations caught by this one test.
  } finally {
    fs.writeFileSync = realWrite;
  }
});

test('createProgressCallback: a `result` message is never written -- the terminal message leaves no stale-looking snapshot', () => {
  const dir = mkTmp('spo-live-progress-');
  // F4 fix pass (Opus verifier, two rounds). ROUND 1's bug: the clock MUST advance past the
  // throttle window before the result message arrives. A fixed `now` left the throttle gate
  // itself blocking every write after the first, which meant this test passed even with the
  // `message.type === 'result'` guard deleted entirely -- the throttle, not the guard, was
  // silencing the second write, so the assertion proved nothing about the guard it was written to
  // pin.
  //
  // ROUND 2's bug: this test cleared the record BEFORE sending the result message -- the REVERSE
  // of production order. In production (steps/llm.js's invokeClaudeReal, driving sdk-call.js's
  // consumeQueryStream), a `result` message arrives INSIDE the stream loop, while the call is
  // still in flight; the clear only happens AFTER, from invokeClaudeReal's own `finally`, once
  // the whole call has settled. Clearing first and THEN sending `result` only proved "a result
  // message cannot un-clear an already-cleared record" -- a real but much weaker property that a
  // mutated (guard-deleted) callback could still satisfy under the OLD test's structure only by
  // accident of clock timing, not because the guard's own job (no write AT ALL on a result
  // message) was exercised in the order it actually happens.
  //
  // Fixed: assistant write, THEN the result message (asserted to change nothing, matching
  // production's own in-flight timing), THEN the simulated `finally` clear.
  let clock = 0;
  const onMessage = createProgressCallback({ taskDir: dir, step: 'IMPLEMENT', now: () => clock });
  onMessage(assistantMessage('working', 'Bash', 't1'));
  const afterAssistant = readLiveProgress(dir);
  assert.notEqual(afterAssistant, null);

  clock += LIVE_PROGRESS_THROTTLE_MS; // past the window -- a write WOULD happen here if the
  // result-message guard did not exist, since nothing else would gate it out.
  onMessage({ type: 'result', subtype: 'success', is_error: false, result: '{}' });
  assert.deepEqual(
    readLiveProgress(dir),
    afterAssistant,
    'a result message must not write at all -- the record right after it arrives must be byte-identical to the record right before'
  );

  clearLiveProgress(dir); // simulate invokeClaudeReal's own finally, which runs AFTER the stream
  // (and therefore after any result message) has already been fully consumed.
  assert.equal(readLiveProgress(dir), null, 'the finally-driven clear, once it runs, removes the record');
});

test('createProgressCallback: the first ASSISTANT turn bypasses the throttle even when an earlier heartbeat already used up the cold-start write', () => {
  const dir = mkTmp('spo-live-progress-');
  let clock = 0;
  let writes = 0;
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (typeof p === 'string' && p.includes(dir) && p.includes('.live-progress.json.')) writes += 1;
    return realWrite.call(fs, p, ...rest);
  };
  try {
    const onMessage = createProgressCallback({ taskDir: dir, step: 'IMPLEMENT', now: () => clock });
    // A `system`/init message arrives first (as it does on every real call) and claims the
    // cold-start write -- turns: 0, nothing to narrate yet.
    onMessage({ type: 'system', subtype: 'init', session_id: 'x' });
    assert.equal(writes, 1);
    assert.equal(readLiveProgress(dir).turns, 0);

    // The real first assistant turn lands 5ms later -- well inside the 2s throttle window a naive
    // "only the very first MESSAGE bypasses the throttle" rule would have suppressed.
    clock += 5;
    onMessage(assistantMessage('reading the failing test', 'Read', '2026-09-17T00:00:00.005Z'));
    assert.equal(writes, 2, 'the first assistant turn must write immediately, not wait out the window');
    const record = readLiveProgress(dir);
    assert.equal(record.turns, 1);
    assert.equal(record.lastText, 'reading the failing test');

    // A SECOND assistant turn, still inside the window, is throttled normally -- the bypass fires
    // exactly once per call.
    clock += 5;
    onMessage(assistantMessage('a second thought', 'Bash', '2026-09-17T00:00:00.010Z'));
    assert.equal(writes, 2, 'a second assistant turn inside the window must NOT get its own bypass');
    // MUTATION CHECK: drop `isFirstAssistantTurn` from the write gate entirely and this test's
    // `writes === 2` assertion after the real first turn goes red (stays 1, the stale/empty
    // heartbeat never gets replaced until the window elapses); make the bypass fire on every
    // assistant turn instead of only the first and the THIRD assertion above goes red (writes
    // becomes 3).
  } finally {
    fs.writeFileSync = realWrite;
  }
});

test('createProgressCallback: a non-object or unrecognised message is ignored, never throws', () => {
  const dir = mkTmp('spo-live-progress-');
  const onMessage = createProgressCallback({ taskDir: dir, step: 'IMPLEMENT', now: () => 1000 });
  assert.doesNotThrow(() => onMessage(null));
  assert.doesNotThrow(() => onMessage(undefined));
  assert.doesNotThrow(() => onMessage('a string'));
  assert.equal(readLiveProgress(dir), null);
});

test('createProgressCallback: a non-assistant, non-result message (e.g. a system/init) still triggers the heartbeat write, with no narration', () => {
  const dir = mkTmp('spo-live-progress-');
  const onMessage = createProgressCallback({ taskDir: dir, step: 'PLAN', now: () => 5000 });
  onMessage({ type: 'system', subtype: 'init', session_id: 'x' });
  const record = readLiveProgress(dir);
  assert.equal(record.turns, 0);
  assert.equal(record.lastText, null);
  assert.equal(record.updatedAt, new Date(5000).toISOString());
});

test('createProgressCallback: the account is stamped once, from the caller, and carried on every write', () => {
  const dir = mkTmp('spo-live-progress-');
  const onMessage = createProgressCallback({ taskDir: dir, step: 'IMPLEMENT', account: 'pool2', now: () => 1000 });
  onMessage(assistantMessage('x', null, 't1'));
  assert.equal(readLiveProgress(dir).account, 'pool2');
});

test('createProgressCallback: no account supplied writes `account: null`, never `undefined` (which JSON would drop silently)', () => {
  const dir = mkTmp('spo-live-progress-');
  const onMessage = createProgressCallback({ taskDir: dir, step: 'IMPLEMENT', now: () => 1000 });
  onMessage(assistantMessage('x', null, 't1'));
  const raw = JSON.parse(fs.readFileSync(liveProgressPath(dir), 'utf8'));
  assert.equal('account' in raw, true);
  assert.equal(raw.account, null);
});

test('two DIFFERENT taskDirs never interleave -- two independent callbacks writing "concurrently" (interleaved calls, one process) keep separate state', () => {
  const dirA = mkTmp('spo-live-progress-a-');
  const dirB = mkTmp('spo-live-progress-b-');
  let clock = 0;
  const onA = createProgressCallback({ taskDir: dirA, step: 'IMPLEMENT', now: () => clock });
  const onB = createProgressCallback({ taskDir: dirB, step: 'PLAN', now: () => clock });
  onA(assistantMessage('card A turn 1', 'Bash', 't1'));
  onB(assistantMessage('card B turn 1', 'Read', 't1'));
  clock += LIVE_PROGRESS_THROTTLE_MS;
  onA(assistantMessage('card A turn 2', 'Bash', 't2'));

  assert.equal(readLiveProgress(dirA).lastText, 'card A turn 2');
  assert.equal(readLiveProgress(dirA).step, 'IMPLEMENT');
  assert.equal(readLiveProgress(dirB).lastText, 'card B turn 1');
  assert.equal(readLiveProgress(dirB).step, 'PLAN');
});

// ---- the staleness bound itself (not console/live-step.js's use of it -- see
// test/dashboard-live-step.test.js for the read-side gate) -----------------------------------

test('LIVE_PROGRESS_STALE_MS is comfortably larger than LIVE_PROGRESS_THROTTLE_MS -- otherwise every ordinary write would already read as stale by the time the NEXT one lands', () => {
  assert.ok(LIVE_PROGRESS_STALE_MS > LIVE_PROGRESS_THROTTLE_MS * 10);
});

// F2 fix pass (Opus verifier), REVISED by the same verifier's F1 reconciliation: the test above
// alone passes for ANY value above 20s -- mutating LIVE_PROGRESS_STALE_MS down to 25s (or back to
// the rejected 2-minute value) survived it, and the whole suite, silently. Two fixes: pin the
// exact value LITERALLY (not by re-deriving it from the same `require('../orchestrator/step-
// contracts')` the constant itself uses -- that would pin nothing, the same "recomputing the
// expectation from the constant under test" mistake test/doc-constant-sweep.test.js's own header
// warns this project has already shipped twice), and separately assert the PROPERTY the value
// exists to guarantee -- a record refreshed at a realistic worst-case gap must still read as live
// -- so a future change to the constant is checked against the measurement, not just against an
// arbitrary ratio.
test('LIVE_PROGRESS_STALE_MS is pinned to 15 minutes (half of step-contracts.js\'s MAX_LLM_STEP_DEADLINE_MS) -- see this constant\'s own header for the corpus measurement (current-layout PLAN/IMPLEMENT max gap 278.4s, zero false-stale) and the pid-liveness argument for why this is now the constant\'s real job', () => {
  assert.equal(LIVE_PROGRESS_STALE_MS, 15 * 60 * 1000);
});

// The actual "does a realistic worst-case gap still read as live" property is exercised end to
// end, through the real reader (console/live-step.js's probeLiveStep), in
// test/dashboard-live-step.test.js -- see the test named for the corpus's own p99.9 figure there.
// This file only owns the constant and the write/throttle mechanics; that file owns what a reader
// does with them.
