'use strict';
// Card #174 -- VALIDATE REJECT's `reasons` contract (validate-change.md: "for REJECT, **exactly
// one** entry: the root cause in one line, exactly as it should appear on the ledger"). Measured:
// of 5 real REJECT verdicts in the corpus, 4 recorded no `reasons` key at all on the
// `change-validator` journal event -- but the Claude transcripts show all 5 validator replies DID
// carry a one-line reason. Of those 4, all predate commit 11bdea0, before which the
// `change-validator` event journalled only `{verdict, findings}` and never `reasons`. For 3 of
// them (issue-492, issue-654, issue-640, all 2026-09-04), the REJECT branch's reader,
// `Array.isArray(result.reasons) ? ... : []` (action 1.6, commit e395912), turned the reply's
// JSON-encoded string, held in memory and never journalled, into the `[]` their VALIDATE `result`
// event records. The 4th, issue-428 (2026-08-29), predates the `result` event itself (e395912,
// 2026-08-31), so the journal holds no trace of its reason at all; only the validator's session
// transcript still has it.
//
// Today, in REAL mode, a reply omitting `reasons` ENTIRELY cannot reach handleValidate's REJECT
// branch at all: step-contracts.js's VALIDATE outputContract requires the key, and llm.js's own
// missing-key check (`key in parsedPayload`) turns that into `llm-transport-failed:VALIDATE`
// before a verdict is ever read (see (f) below). But that check is a PRESENCE check, not a shape
// check -- a real, live validator reply that sends `reasons: null`/`[]`/`"[]"`/a bare non-JSON
// string/an array of non-string entries satisfies it and reaches this branch exactly like a
// shadow-mode fixture would (see (c-1-real) below, which pins this against a real-shaped
// `claude` reply, not just a shadow fixture). A REJECT with the key genuinely absent, however,
// reaches this branch ONLY via a shadow-mode fixture: the legacy `ctx.task.llm.<step>` override
// returns `invokeClaudeReal`'s raw shape with no top-level `verdict` at all (parks
// `validate-unrecognized-verdict` instead of ever reaching here), and `--dry-run`'s canned
// VALIDATE payload is always a `PASS` (a REJECT can never happen under `--dry-run` at all). None
// of the malformed-but-present shapes above (null, [], "[]", an array of non-strings) -- nor two
// reasons -- violates the wire contract as llm.js enforces it, so each is recorded as a journaled
// deviation ('reject-reasons-contract-violation'), never a park; only a real reply with the key
// absent, pinned by (f), parks.
//
// This file exercises state-machine.js's HANDLERS.VALIDATE directly, in shadow mode, with a
// hand-built `result` object per test -- the fixture reader (orchestrator/fixture.js) returns a
// scalar fixture verbatim, in-process, with no JSON round-trip, so a JS object literal that simply
// omits a key produces a genuinely ABSENT key (`'reasons' in result === false`), exactly the shape
// action 1.6's own `Array.isArray` bug and this action's fix both need to be able to construct.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { HANDLERS, buildCtx } = require('../orchestrator/state-machine');
const { mkTmp } = require('./helpers');

function readJournal(taskDir) {
  return fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readLedgerFile(taskDir) {
  return fs.readFileSync(path.join(taskDir, 'ledger.md'), 'utf8');
}

// Minimal shadow-mode ctx: no gh/git spawn is ever reached for a non-RDO REJECT (citation-
// verifier is skipped entirely -- resolveRdoDiffTouched defaults false with no
// task.touchesRdoMembers), so `deps` never needs a spawnSync stub here.
function rejectCtx(id, validateResult, configOverrides = {}) {
  const taskDir = mkTmp('spo-vrc-taskdir-');
  const task = {
    id,
    kind: 'synthetic',
    shadow: { llm: { VALIDATE: validateResult } },
  };
  return buildCtx(
    id,
    task,
    taskDir,
    {
      shadowMode: true,
      dryRun: false,
      validateRejectBudget: 3,
      ghRepo: 'Crazz-Org/SPO-WebClient',
      stepDeadlineMs: 30000,
      ...configOverrides,
    }
  );
}

// ==================================================================================================
// (a) The ABSENT key -- a REJECT payload with NO `reasons` property at all.
// ==================================================================================================

test('(a) REJECT with reasons KEY ABSENT: violation reasonsKeyPresent:false, reasonsShape:"absent", usableCount:0; ledger shows the shape', async () => {
  const ctx = rejectCtx('vrc-absent', { verdict: 'REJECT', findings: [] });
  assert.equal(Object.prototype.hasOwnProperty.call(ctx.task.shadow.llm.VALIDATE, 'reasons'), false, 'sanity: the fixture truly has no reasons key');

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(ctx.taskDir);
  const violation = journal.find((e) => e.event === 'reject-reasons-contract-violation');
  assert.ok(violation, 'expected a contract-violation event');
  assert.equal(violation.reasonsKeyPresent, false);
  assert.equal(violation.reasonsShape, 'absent');
  assert.equal(violation.usableCount, 0);
  assert.equal(violation.attempt, 1);

  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /\(no reason given; reasons shape: absent\)/);
});

// ==================================================================================================
// (b) An EMPTY ARRAY `reasons: []` -- key present, shape distinct from absent (the card's core
// requirement: (a) and (b) must produce DIFFERENT events).
// ==================================================================================================

test('(b) REJECT with reasons: [] (empty array, KEY PRESENT): violation reasonsKeyPresent:true, reasonsShape:"array", usableCount:0 -- DIFFERENT from (a)', async () => {
  const ctx = rejectCtx('vrc-empty-array', { verdict: 'REJECT', reasons: [], findings: [] });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(ctx.taskDir);
  const violation = journal.find((e) => e.event === 'reject-reasons-contract-violation');
  assert.ok(violation);
  assert.equal(violation.reasonsKeyPresent, true);
  assert.equal(violation.reasonsShape, 'array');
  assert.equal(violation.usableCount, 0);

  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /\(no reason given; reasons shape: array\)/);
});

test('(a) vs (b): absent-key and empty-array both land on usableCount 0, but the two violation events are distinguishable by reasonsKeyPresent and reasonsShape', async () => {
  const absentCtx = rejectCtx('vrc-a-vs-b-absent', { verdict: 'REJECT', findings: [] });
  const emptyCtx = rejectCtx('vrc-a-vs-b-empty', { verdict: 'REJECT', reasons: [], findings: [] });

  await HANDLERS.VALIDATE(absentCtx);
  await HANDLERS.VALIDATE(emptyCtx);

  const absentViolation = readJournal(absentCtx.taskDir).find((e) => e.event === 'reject-reasons-contract-violation');
  const emptyViolation = readJournal(emptyCtx.taskDir).find((e) => e.event === 'reject-reasons-contract-violation');

  assert.notDeepEqual(
    { reasonsKeyPresent: absentViolation.reasonsKeyPresent, reasonsShape: absentViolation.reasonsShape },
    { reasonsKeyPresent: emptyViolation.reasonsKeyPresent, reasonsShape: emptyViolation.reasonsShape },
    'the card #174 core requirement: a reader must be able to tell "the validator sent none" from "the key was never sent"'
  );
});

// ==================================================================================================
// (c) null (a synthetic null reply -- NOT --dry-run's own shape, which is always a PASS; see the
// header comment above), "[]" (JSON-encoded empty array string), a bare non-JSON string
// (salvaged, NO violation), and an array of objects (violation, no "[object Object]").
// ==================================================================================================

test('(c-1) REJECT with reasons: null (a synthetic null reply, key present): violation reasonsShape:"null", usableCount:0', async () => {
  const ctx = rejectCtx('vrc-null', { verdict: 'REJECT', reasons: null, findings: [] });
  await HANDLERS.VALIDATE(ctx);

  const violation = readJournal(ctx.taskDir).find((e) => e.event === 'reject-reasons-contract-violation');
  assert.ok(violation, 'a present-but-null reasons is still a shape the ledger did not get a usable reason from, and is recorded as such');
  assert.equal(violation.reasonsKeyPresent, true);
  assert.equal(violation.reasonsShape, 'null');
  assert.equal(violation.usableCount, 0);
});

test('(c-2) REJECT with reasons: "[]" (a JSON-encoded empty array STRING): violation reasonsShape:"json-string", usableCount:0', async () => {
  const ctx = rejectCtx('vrc-json-empty', { verdict: 'REJECT', reasons: '[]', findings: [] });
  await HANDLERS.VALIDATE(ctx);

  const violation = readJournal(ctx.taskDir).find((e) => e.event === 'reject-reasons-contract-violation');
  assert.ok(violation);
  assert.equal(violation.reasonsShape, 'json-string');
  assert.equal(violation.usableCount, 0);
});

test('(c-3) REJECT with a BARE non-JSON string reasons ("The root cause is X"): SALVAGED as the one reason -- NO violation, ledger carries the prose', async () => {
  const ctx = rejectCtx('vrc-bare-string', { verdict: 'REJECT', reasons: 'The root cause is X', findings: [] });
  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'reject-reasons-contract-violation'), 'a salvaged single reason must not be treated as a contract violation');

  const threaded = journal.find((e) => e.state === 'VALIDATE' && e.event === 'result');
  assert.deepEqual(threaded.payload.reasons, ['The root cause is X'], 'the bare string is salvaged, not silently dropped to [] (the card #640 class of bug)');

  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /The root cause is X/);
  assert.doesNotMatch(ledger, /no reason given/);
});

test('(c-4) REJECT with reasons as an ARRAY OF OBJECTS: violation, usableCount:0, and the ledger never prints "[object Object]"', async () => {
  const ctx = rejectCtx('vrc-array-objects', {
    verdict: 'REJECT',
    reasons: [{ note: 'not a string' }, { note: 'also not a string' }],
    findings: [],
  });
  await HANDLERS.VALIDATE(ctx);

  const journal = readJournal(ctx.taskDir);
  const violation = journal.find((e) => e.event === 'reject-reasons-contract-violation');
  assert.ok(violation);
  assert.equal(violation.reasonsShape, 'array');
  assert.equal(violation.usableCount, 0);

  const threaded = journal.find((e) => e.state === 'VALIDATE' && e.event === 'result');
  assert.deepEqual(threaded.payload.reasons, [], 'the result event threaded to IMPLEMENT must not carry the non-string objects either');

  const ledger = readLedgerFile(ctx.taskDir);
  assert.doesNotMatch(ledger, /\[object Object\]/);
  assert.match(ledger, /\(no reason given; reasons shape: array\)/);
});

// ==================================================================================================
// (c-5)-(c-9): collapseToOneLine (shared with handleDiagnose's nested-contract unwrap). "Usable"
// is a non-empty string once internal whitespace -- including an embedded newline -- is collapsed
// to single spaces and the ends are trimmed: a whitespace-only entry is not usable (0 usable
// reasons -> violation), a real reason surrounded by whitespace loses only the padding, and a
// real MULTI-LINE reason is collapsed onto one physical line so appendLedgerLine's "one ledger
// line per attempt" invariant holds for a REJECT reason exactly as it already does for DIAGNOSE's
// root_cause.
// ==================================================================================================

test('(c-5) REJECT with reasons: ["   "] (a whitespace-only STRING inside an array): violation, usableCount:0, shape "array"', async () => {
  const ctx = rejectCtx('vrc-whitespace-array', { verdict: 'REJECT', reasons: ['   '], findings: [] });
  await HANDLERS.VALIDATE(ctx);

  const violation = readJournal(ctx.taskDir).find((e) => e.event === 'reject-reasons-contract-violation');
  assert.ok(violation, 'a whitespace-only entry is not a usable reason');
  assert.equal(violation.reasonsShape, 'array');
  assert.equal(violation.usableCount, 0);
});

test('(c-6) REJECT with a BARE whitespace-only string reasons ("   "): violation, shape "unparsable-string", NOT salvaged', async () => {
  const ctx = rejectCtx('vrc-whitespace-bare', { verdict: 'REJECT', reasons: '   ', findings: [] });
  await HANDLERS.VALIDATE(ctx);

  const journal = readJournal(ctx.taskDir);
  const violation = journal.find((e) => e.event === 'reject-reasons-contract-violation');
  assert.ok(violation, 'a whitespace-only bare string must not be salvaged -- it carries no reason to salvage');
  assert.equal(violation.reasonsShape, 'unparsable-string');
  assert.equal(violation.usableCount, 0);

  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /\(no reason given; reasons shape: unparsable-string\)/);
});

test('(c-7) REJECT with reasons: ["  padded  "]: the result payload and the ledger carry the TRIMMED text, not the padding', async () => {
  const ctx = rejectCtx('vrc-padded', { verdict: 'REJECT', reasons: ['  padded  '], findings: [] });
  await HANDLERS.VALIDATE(ctx);

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'reject-reasons-contract-violation'), 'one usable (trimmed) reason is the happy path');

  const threaded = journal.find((e) => e.state === 'VALIDATE' && e.event === 'result');
  assert.deepEqual(threaded.payload.reasons, ['padded']);

  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /\| padded \|/);
});

test('(c-8) REJECT with a BARE two-line string reasons: salvaged as exactly ONE ledger line, the newline collapsed to a single space', async () => {
  const ctx = rejectCtx('vrc-multiline-bare', { verdict: 'REJECT', reasons: 'line one\nline two', findings: [] });
  await HANDLERS.VALIDATE(ctx);

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'reject-reasons-contract-violation'), 'a salvaged multi-line reason is still exactly one usable reason');

  const threaded = journal.find((e) => e.state === 'VALIDATE' && e.event === 'result');
  assert.deepEqual(threaded.payload.reasons, ['line one line two']);

  const ledgerLines = readLedgerFile(ctx.taskDir).trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1, 'appendLedgerLine writes one line per attempt -- an embedded newline in the reason must not split it into two');
  assert.match(ledgerLines[0], /\| line one line two \|/);
});

test('(c-9) REJECT with a two-line ARRAY entry (reasons: ["line one\\nline two"]): collapsed to ONE ledger line the same way', async () => {
  const ctx = rejectCtx('vrc-multiline-array', { verdict: 'REJECT', reasons: ['line one\nline two'], findings: [] });
  await HANDLERS.VALIDATE(ctx);

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'reject-reasons-contract-violation'));

  const threaded = journal.find((e) => e.state === 'VALIDATE' && e.event === 'result');
  assert.deepEqual(threaded.payload.reasons, ['line one line two']);

  const ledgerLines = readLedgerFile(ctx.taskDir).trim().split('\n').filter(Boolean);
  assert.equal(ledgerLines.length, 1);
  assert.match(ledgerLines[0], /\| line one line two \|/);
});

// ==================================================================================================
// (d) The historical real shape (a JSON-encoded string holding exactly one reason -- card #640's
// own shape) and a plain array with one reason: NO violation, the silent happy path is pinned.
// ==================================================================================================

test('(d-1) REJECT with reasons as a JSON-ENCODED STRING holding exactly one reason (card #640 shape): no violation, the reason on the ledger', async () => {
  const raw = JSON.stringify(['the criterion is not met: two files were never edited']);
  const ctx = rejectCtx('vrc-json-one', { verdict: 'REJECT', reasons: raw, findings: [] });
  await HANDLERS.VALIDATE(ctx);

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'reject-reasons-contract-violation'));

  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /the criterion is not met: two files were never edited/);
});

test('(d-2) REJECT with a plain array holding exactly one reason: the silent happy path -- NO violation event at all', async () => {
  const ctx = rejectCtx('vrc-plain-one', { verdict: 'REJECT', reasons: ['missing edge-case handling'], findings: [] });
  await HANDLERS.VALIDATE(ctx);

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'reject-reasons-contract-violation'), 'exactly one usable reason must journal nothing new -- the happy path stays silent');

  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /missing edge-case handling/);
  assert.doesNotMatch(ledger, /no reason given/);
});

// ==================================================================================================
// (e) Two reasons: violation with usableCount 2, ledger joins both (validate-change.md says
// "exactly one", so two is also a deviation, same as zero).
// ==================================================================================================

test('(e) REJECT with TWO reasons: violation usableCount:2, ledger joins both with "; "', async () => {
  const ctx = rejectCtx('vrc-two-reasons', {
    verdict: 'REJECT',
    reasons: ['criterion A not met', 'criterion B not met'],
    findings: [],
  });
  await HANDLERS.VALIDATE(ctx);

  const violation = readJournal(ctx.taskDir).find((e) => e.event === 'reject-reasons-contract-violation');
  assert.ok(violation);
  assert.equal(violation.reasonsKeyPresent, true);
  assert.equal(violation.reasonsShape, 'array');
  assert.equal(violation.usableCount, 2);

  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /criterion A not met; criterion B not met/);
});

// ==================================================================================================
// The contract-violation check runs on EVERY REJECT attempt independently of the budget decision
// below it -- including the attempt that exhausts config.validateRejectBudget and throws
// ParkSignal('validate-reject-budget-exhausted'). A budget-aware mutation that skips the
// violation check specifically on the last attempt (e.g. moving it below the budget-exhausted
// throw) would not be caught by any other test in this file, since none of them drive the budget
// to exhaustion.
// ==================================================================================================

test('(budget) a violation is journalled on EVERY REJECT attempt, including the one that exhausts the budget, with correct attempt numbers', async () => {
  const ctx = rejectCtx(
    'vrc-budget-absent',
    [
      { verdict: 'REJECT', findings: [] }, // attempt 1 -- reasons key absent
      { verdict: 'REJECT', findings: [] }, // attempt 2 -- reasons key absent, exhausts the budget
    ],
    { validateRejectBudget: 2 }
  );

  const next1 = await HANDLERS.VALIDATE(ctx);
  assert.equal(next1, 'IMPLEMENT', 'attempt 1 is within budget');

  await assert.rejects(
    async () => HANDLERS.VALIDATE(ctx),
    (err) => {
      assert.equal(err.reason, 'validate-reject-budget-exhausted');
      return true;
    },
    'attempt 2 exhausts the budget and parks'
  );

  const violations = readJournal(ctx.taskDir).filter((e) => e.event === 'reject-reasons-contract-violation');
  assert.equal(violations.length, 2, 'a violation is journalled on every REJECT attempt, including the budget-exhausting one');
  assert.deepEqual(violations.map((v) => v.attempt), [1, 2]);
  assert.ok(
    violations.every((v) => v.reasonsKeyPresent === false && v.reasonsShape === 'absent' && v.usableCount === 0),
    'both attempts carry the same absent-key shape'
  );
});

// ==================================================================================================
// (g) A violation-journal write failure must never change the REJECT's own control flow (retry vs.
// budget park). journal.js's appendEvent holds a plain reference to the shared `fs` module (`const
// fs = require('fs')`, called as `fs.appendFileSync(...)` at call time -- not destructured at
// require time the way orchestrator/command-timeout.js's spawnSync is, see test/no-real-spawn.js's
// own header for why THAT distinction matters), so patching `fs.appendFileSync` on the shared
// module object from this test reaches journal.js's call without touching any production file.
// Scoped to ONLY the violation event's own record text, so every other appendEvent/appendLedgerLine
// write in the same handleValidate call (change-validator, the 'result' event, the ledger line
// itself) still hits the real filesystem.
// ==================================================================================================

test('(g) a violation-journal write FAILURE does not change control flow: REJECT still returns IMPLEMENT (or parks on budget) exactly as it would have', async () => {
  const ctx = rejectCtx('vrc-write-failure', { verdict: 'REJECT', findings: [] }); // absent key -> would violate

  const realAppendFileSync = fs.appendFileSync;
  fs.appendFileSync = (filePath, data, ...rest) => {
    if (typeof data === 'string' && data.includes('reject-reasons-contract-violation')) {
      throw new Error('simulated ENOSPC on the violation write');
    }
    return realAppendFileSync.call(fs, filePath, data, ...rest);
  };

  let next;
  try {
    next = await HANDLERS.VALIDATE(ctx);
  } finally {
    fs.appendFileSync = realAppendFileSync;
  }

  assert.equal(next, 'IMPLEMENT', 'a REJECT within budget still returns IMPLEMENT even though the violation write threw');

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'reject-reasons-contract-violation'), 'the failed write left no record -- consistent with the throw, not a partial write');
  // The rest of the REJECT branch (result event, ledger line) still ran normally -- the failure was
  // scoped to exactly one write, not the whole branch.
  assert.ok(journal.some((e) => e.state === 'VALIDATE' && e.event === 'result'), 'the result event still journals -- only the violation write failed');
  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /validate-reject 1 \|/, 'the ledger line still gets written');
});

test('(g-budget) a violation-journal write FAILURE does not change control flow on the attempt that EXHAUSTS the budget either: it still parks validate-reject-budget-exhausted, and the ledger line is still written', async () => {
  const ctx = rejectCtx('vrc-write-failure-budget', { verdict: 'REJECT', findings: [] }, { validateRejectBudget: 1 }); // absent key -> would violate; budget 1 -> attempt 1 exhausts it

  const realAppendFileSync = fs.appendFileSync;
  fs.appendFileSync = (filePath, data, ...rest) => {
    if (typeof data === 'string' && data.includes('reject-reasons-contract-violation')) {
      throw new Error('simulated ENOSPC on the violation write');
    }
    return realAppendFileSync.call(fs, filePath, data, ...rest);
  };

  try {
    await assert.rejects(
      async () => HANDLERS.VALIDATE(ctx),
      (err) => {
        assert.equal(err.reason, 'validate-reject-budget-exhausted');
        return true;
      },
      'the budget-exhausted park still happens even though the violation write threw'
    );
  } finally {
    fs.appendFileSync = realAppendFileSync;
  }

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'reject-reasons-contract-violation'), 'the failed write left no record on the budget-exhausting attempt either');
  const ledger = readLedgerFile(ctx.taskDir);
  assert.match(ledger, /validate-reject 1 \| .*\| parked \(validate-reject-budget-exhausted\)/, 'the ledger line still gets written even though the violation write failed');
});

// ==================================================================================================
// (f) REAL mode: a reply missing the `reasons` key never reaches the REJECT branch at all -- it
// parks llm-transport-failed:VALIDATE via llm.js's own outputContract missing-key check. This is
// what makes the absent-key detection above (reasonsKeyPresent: false) reachable only via a
// shadow-mode fixture -- the legacy override and --dry-run cannot reach the REJECT branch with an
// absent key either, for their own separate reasons (see the file header comment above).
// ==================================================================================================

// Shared real-mode harness for (f) and (c-1-real) below -- a full `kind: "card"` ctx, the only
// way to reach handleValidate through step-contracts.js + prompt-template.js's actual
// outputContract enforcement (same convention test/validate-findings.test.js's own validateCtx/
// makeValidateSpawn use). `claudeReplyPayload` is JSON.stringify'd as the `result` field verbatim
// -- a JS object literal that omits a key produces a real wire reply with that key genuinely
// absent, exactly like the (a)/(f) cases need.
function realVrcCtx(id, claudeReplyPayload) {
  const accountsDir = mkTmp('spo-vrc-accts-');
  fs.mkdirSync(path.join(accountsDir, 'acct1'), { recursive: true });
  const worktreePath = mkTmp('spo-vrc-wt-');
  const taskDir = mkTmp('spo-vrc-real-taskdir-');
  const task = { id, kind: 'card', issue: 999, title: 'x', criterion: 'the thing works', worktreePath, size: 'S' };

  function ok(stdout = '') {
    return { status: 0, stdout, stderr: '', signal: null };
  }
  const spawnSync = (command, args) => {
    if (command === 'npm') return ok('');
    if (command === 'git') {
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok('headsha000000000000000000000000000000\n');
      if (args.includes('rev-parse') && args.includes('origin/main')) return ok('mainsha000000000000000000000000000000\n');
      if (args.includes('status') && args.includes('--porcelain')) return ok('');
      if (args.includes('diff')) return ok('diff --git a/z.ts b/z.ts\n+change\n');
      return ok('');
    }
    if (command === 'claude') {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: JSON.stringify(claudeReplyPayload),
          is_error: false,
          num_turns: 1,
          session_id: 'sess-vrc-1',
          modelUsage: { fable: { costUSD: 0.001 } },
          terminal_reason: 'success',
          api_error_status: null,
        }),
        stderr: '',
        signal: null,
      };
    }
    return ok('');
  };

  const ctx = buildCtx(id, task, taskDir, {
    shadowMode: false,
    dryRun: false,
    real: true,
    stepDeadlineMs: 30000,
    validateRejectBudget: 3, // config.js's own default -- named explicitly, not left undefined
    ghRepo: 'Crazz-Org/SPO-WebClient',
    claudeAccountsDir: accountsDir,
    deps: { spawnSync },
  });
  const { appendEvent } = require('../orchestrator/journal');
  appendEvent(ctx.taskDir, 'PLAN', 'result', {
    payload: { invariants_path: path.join(ctx.taskDir, 'invariants.md'), invariant_ids: ['INV-1'] },
  });
  return ctx;
}

test('(f) REAL mode: a change-validator reply missing the `reasons` key parks llm-transport-failed:VALIDATE, never reaches the REJECT branch / contract-violation check', async () => {
  // A `verdict`/`findings`-only reply -- `reasons` is genuinely never sent, so
  // step-contracts.js's VALIDATE outputContract (required: verdict, reasons, findings) fails the
  // missing-key check (`key in parsedPayload`) in llm.js BEFORE any verdict is ever read.
  const ctx = realVrcCtx('vrc-real-missing-key', { verdict: 'REJECT', findings: [] });

  await assert.rejects(
    async () => HANDLERS.VALIDATE(ctx),
    (err) => {
      assert.equal(err.reason, 'llm-transport-failed:VALIDATE');
      return true;
    }
  );

  const journal = readJournal(ctx.taskDir);
  assert.ok(!journal.some((e) => e.event === 'reject-reasons-contract-violation'), 'a transport failure never reaches the contract-violation check');
  assert.ok(!journal.some((e) => e.state === 'VALIDATE' && e.event === 'result'), 'no REJECT result event either -- no verdict was ever read');
});

test('(c-1-real) REAL mode: a change-validator reply with `reasons: null` (KEY PRESENT, value null) is NOT blocked by the outputContract -- it reaches the REJECT branch and journals a contract violation, same as a shadow fixture', async () => {
  // `key in parsedPayload` (llm.js's missing-key check) is a PRESENCE check, not a shape check --
  // `reasons: null` satisfies `'reasons' in {reasons: null}` (true), so this reply passes the
  // wire contract and reaches handleValidate with a verdict, unlike (f) above.
  const ctx = realVrcCtx('vrc-real-null-reasons', { verdict: 'REJECT', reasons: null, findings: [] });

  const next = await HANDLERS.VALIDATE(ctx);
  assert.equal(next, 'IMPLEMENT');

  const journal = readJournal(ctx.taskDir);
  const violation = journal.find((e) => e.event === 'reject-reasons-contract-violation');
  assert.ok(violation, 'a real, live reply with reasons: null must still be caught, exactly like the shadow-mode case');
  assert.equal(violation.reasonsKeyPresent, true);
  assert.equal(violation.reasonsShape, 'null');
  assert.equal(violation.usableCount, 0);
});

module.exports = { rejectCtx };
