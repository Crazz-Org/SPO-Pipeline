'use strict';
// Unit tests for orchestrator/steps/llm.js's real `kind: "card"` path: step-contracts.js +
// prompt-template.js wired into runLlm's real branch (no ctx.task.llm.<step> override present).
// Every spawn is injected via deps.spawnSync -- no real `claude` CLI call, ever.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident (140 fabricated park comments on a
// live issue) and why this require has to land before the orchestrator require(s) below.
require('./no-real-spawn');
const { runLlm } = require('../orchestrator/steps/llm');
const { ParkSignal } = require('../orchestrator/park-signal');
const { appendEvent } = require('../orchestrator/journal');
const { mkTmp } = require('./helpers');


function fakeSpawnSync(responder) {
  return (command, argv, opts) => responder(command, argv, opts);
}

function realShapedReply(resultObj, overrides = {}) {
  return {
    result: JSON.stringify(resultObj),
    is_error: false,
    num_turns: 1,
    session_id: 'sess-card-1',
    modelUsage: { 'claude-fable-5': { costUSD: 0.002 } },
    terminal_reason: 'success',
    api_error_status: null,
    ...overrides,
  };
}

function cardCtx({ taskDir, task, account }) {
  return {
    shadowMode: false,
    dryRun: false,
    taskDir,
    task,
    account: account || { name: 'default', configDir: null },
    config: { stepDeadlineMs: 30000 },
  };
}

// ---- happy path: contract + template feed a real spawn ------------------------------------

test('PLAN real card path: builds argv from step-contracts + filled template, returns the parsed+validated payload', async () => {
  const taskDir = mkTmp('spo-card-plan-');
  const task = {
    kind: 'card',
    issue: 99,
    title: 'Add a widget',
    criterion: 'the widget renders',
    worktreePath: '/tmp/worktree-99',
    size: 'S',
  };

  let seenArgv = null;
  let seenInput = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv, opts) => {
      seenArgv = argv;
      seenInput = opts.input;
      const reply = realShapedReply({
        plan_markdown: '# Plan\n\nAdd a widget to the header.\n',
        invariants_markdown: '# Invariants\n\nNone -- new ground.\n',
        invariant_ids: [],
        check_commands: ['npm run typecheck'],
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);

  assert.equal(result.ok, true);
  assert.equal(result.plan_markdown, '# Plan\n\nAdd a widget to the header.\n');
  assert.deepEqual(result.check_commands, ['npm run typecheck']);
  assert.equal(result.sessionId, 'sess-card-1');

  assert.ok(seenArgv.includes('--model'));
  assert.ok(seenArgv.includes('fable')); // no escalation flags on this task
  assert.ok(seenArgv.includes('--effort'));
  assert.ok(seenArgv.includes('low')); // S -> low
  assert.ok(seenArgv.includes('--json-schema'));
  const promptArg = seenInput;
  assert.ok(promptArg.includes('/tmp/worktree-99'));
  assert.ok(promptArg.includes('Add a widget'));

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const call = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(call);
  assert.equal(call.model, 'fable');
  // Action 5.4 item E: the field doc/state-machine-spec.md has documented all along. Spelled
  // `duration_s`, in seconds -- renaming the journalled key to `durationS` passed all 1157 tests
  // when nothing asserted the spelling, and the spec would have gone on claiming a field the
  // journals do not have.
  assert.equal(typeof call.duration_s, 'number', 'the llm-call event carries duration_s');
  assert.equal(call.durationS, undefined, 'spelled duration_s, not camelCase -- the spec documents duration_s');
});

// Card #214, acceptance criterion 1: a real card-path call whose CLI reply's `modelUsage` names
// TWO models (the shape PLAN's undeclared subagent delegation produces -- see step-contracts.js's
// own comment on PLAN's `allowedTools`) journals a per-model breakdown on the `llm-call` event,
// alongside the pre-existing single `model` field naming only the CONTRACT's resolved model.
// Acceptance criterion 3 is exercised in the same test: the journalled event carries no
// `numTurns` at all, even though `runLlm`'s own return value (the internal shape, kept on
// purpose) still does.
test('PLAN real card path: a two-model modelUsage payload journals a per-model breakdown on the llm-call event, and the event carries no numTurns', async () => {
  const taskDir = mkTmp('spo-card-plan-modelusage-');
  const task = {
    kind: 'card',
    issue: 526,
    title: 'Add a widget',
    criterion: 'the widget renders',
    worktreePath: '/tmp/worktree-526',
    size: 'S',
  };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply(
        {
          plan_markdown: '# Plan\n\nAdd a widget to the header.\n',
          invariants_markdown: '# Invariants\n\nNone -- new ground.\n',
          invariant_ids: [],
          check_commands: ['npm run typecheck'],
        },
        {
          // The measured shape: the PLAN call itself resolves to fable, but its reply's own
          // modelUsage names an Opus subagent too -- whole-tree accounting, already summed into
          // the flat totals before this card, now also broken out per model.
          modelUsage: {
            'claude-fable-5': { inputTokens: 5000, cacheCreationInputTokens: 1000, cacheReadInputTokens: 200, outputTokens: 800 },
            'claude-opus-5': { inputTokens: 2000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 3000 },
          },
          num_turns: 4,
        }
      );
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);
  assert.equal(result.ok, true);
  // The internal return shape keeps numTurns -- this card only removes it from the JOURNALLED
  // event, not from runLlm's own return value (24 test files and ~12 return sites depend on it).
  assert.equal(result.numTurns, 4);

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const call = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(call);
  assert.equal(call.model, 'fable', 'the CONTRACT-resolved model, unchanged by this card');
  assert.deepEqual(call.modelUsage, {
    'claude-fable-5': { freshInputTokens: 5000, cacheCreationTokens: 1000, cacheReadTokens: 200, outputTokens: 800, billableTokens: 6800 },
    'claude-opus-5': { freshInputTokens: 2000, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 3000, billableTokens: 5000 },
  });
  assert.equal(call.billableTokens, 6800 + 5000, 'flat total still sums across both models, unchanged');
  assert.equal('numTurns' in call, false, 'numTurns must be gone from the journalled llm-call event (acceptance criterion 3)');
});

// Second fix pass (2026-09-13): the F3 test in test/step-contracts.test.js asserts on
// `checkOutputTypes`' own return value, not on what actually reaches `runLlm`'s caller -- an Opus
// verifier made `llm.js` normalize `check_commands` in place AFTER calling `checkOutputTypes`
// (re-parsing and re-attaching the array itself) and that mutation survived, because nothing
// exercised the real `runLlm` path with a comma-bearing command. This closes that gap: the
// consumer-facing assertion, through `runLlm` itself, not through the type-checker in isolation.
test('PLAN real card path: check_commands as a JSON-encoded string containing a comma INSIDE one command reaches runLlm\'s caller BYTE-IDENTICAL (card #153\'s comma-corruption guard, exercised end to end)', async () => {
  const taskDir = mkTmp('spo-card-plan-comma-');
  const task = {
    kind: 'card',
    issue: 153,
    title: 'RDO citation check',
    criterion: 'the citation check passes',
    worktreePath: '/tmp/worktree-153',
    size: 'S',
  };

  // The comma sits INSIDE one command -- exactly the shape stringifyValue's `', '.join` would
  // corrupt if this ever became a real array instead of the JSON string the model actually sent.
  const checkCommandsRaw = JSON.stringify(['grep -Eq "kind, arity, and citation" src/foo.ts']);
  const invariantIdsRaw = JSON.stringify(['INV-1, the comma-bearing id']);

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({
        plan_markdown: '# Plan\n\nAdd the RDO citation check.\n',
        invariants_markdown: '# Invariants\n\nNone -- new ground.\n',
        invariant_ids: invariantIdsRaw,
        check_commands: checkCommandsRaw,
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);
  assert.equal(result.ok, true);
  assert.equal(result.check_commands, checkCommandsRaw, 'must be the exact same JSON-encoded STRING reference/value -- not re-parsed into a real array by anything downstream of checkOutputTypes');
  assert.equal(result.invariant_ids, invariantIdsRaw, 'same guard, same reason, for invariant_ids');
});

// Card #158, 2026-09-08: pins the fix (orchestrator/steps/llm.js now reads
// orchestrator/monotonic-clock.js's monotonicNowMs(), not Date.now(), for durationS) on the
// JOURNALLED field, not just on invokeClaudeReal's return value -- test/llm-real.test.js pins the
// return value directly; this one drives the real journal-append path (runLlm -> appendEvent) end
// to end and reads the llm-call event back out, reusing this file's own journal-reading helpers
// (fs/path, already exercised by the test above) rather than adding a second route through runLlm
// elsewhere. Also pins the journalled format (whole milliseconds, at most 3 decimals) on the
// value's decimal string, since neither arithmetic value nor the existing tests guard that shape.
test('PLAN real card path: duration_s in the journalled llm-call event is never negative, even when Date.now() steps backward during the call (issue-385/#492 shape)', async () => {
  const taskDir = mkTmp('spo-card-plan-duration-');
  const task = {
    kind: 'card',
    issue: 100,
    title: 'Add another widget',
    criterion: 'the widget renders',
    worktreePath: '/tmp/worktree-100',
    size: 'S',
  };

  const realDateNow = Date.now;
  const deps = {
    spawnSync: fakeSpawnSync(() => {
      // Realtime lagging monotonic -- issue-385/#492's shape (see llm-real.test.js's own
      // comment block for the corpus numbers this encodes). Left patched on return -- the code
      // under test reads Date.now() again AFTER spawnSync returns (the old
      // `(Date.now() - startedAt) / 1000` line), so restoring here would undo the jump before
      // that read ever happens. The outer try/finally below is what restores it.
      Date.now = () => realDateNow() - 80000;
      // A short busy-wait on the REAL monotonic clock (untouched by the Date.now patch above),
      // so the call's true elapsed time is a few whole milliseconds, never exactly 0. Needed for
      // the non-negativity assertion below to be load-bearing THROUGH the journal: a
      // sign-flipped duration_s of exactly -0 survives in memory but round-trips through
      // JSON.stringify/JSON.parse (journal.jsonl) as +0 -- JSON has no negative zero -- which
      // would make a sub-millisecond fake spawn's mutant undetectable on the journalled value
      // even with an Object.is(-0) check. A genuinely negative (non-zero) duration_s has no such
      // blind spot: JSON preserves the sign on every value except -0 itself.
      const spinUntil = process.hrtime.bigint() + 3000000n; // ~3ms, real hrtime
      while (process.hrtime.bigint() < spinUntil) {
        // busy-wait
      }
      const reply = realShapedReply({
        plan_markdown: '# Plan\n\nAdd another widget.\n',
        invariants_markdown: '# Invariants\n\nNone -- new ground.\n',
        invariant_ids: [],
        check_commands: ['npm run typecheck'],
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  let result;
  try {
    result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(result.ok, true);

  const journalLines = fs
    .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const call = journalLines.find((e) => e.event === 'llm-call');
  assert.ok(call);
  assert.equal(typeof call.duration_s, 'number');
  // >= 0 alone would also pass for a sign-flipped duration_s on a sub-millisecond fake spawn
  // (-0 >= 0 is true) -- Object.is rejects that mutant too.
  assert.ok(
    call.duration_s >= 0 && !Object.is(call.duration_s, -0),
    `duration_s must never be negative, got ${call.duration_s}`
  );
  // The journalled format is unchanged: integer-milliseconds/1000, at most 3 decimal places
  // (e.g. `920.322`, never `920.3220134567`). Checked on the decimal STRING, not by reasoning
  // about the arithmetic that produced it -- float multiplication is not safe for that.
  assert.match(
    String(call.duration_s),
    /^\d+(\.\d{1,3})?$/,
    `duration_s must stay whole milliseconds, got ${call.duration_s}`
  );
});

test('IMPLEMENT real card path escalates to opus when task.touchesRdoMembers is true', async () => {
  const taskDir = mkTmp('spo-card-implement-rdo-');
  const { appendEvent } = require('../orchestrator/journal');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      ok: true,
      plan_path: '/tmp/plan.md',
      invariants_path: '/tmp/invariants.md',
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    },
  });

  const task = {
    kind: 'card',
    issue: 5,
    criterion: 'rdo-members.ts gets a new entry',
    worktreePath: '/tmp/worktree-5',
    size: 'S',
    touchesRdoMembers: true,
  };

  let seenArgv = null;
  const deps = {
    spawnSync: fakeSpawnSync((command, argv) => {
      seenArgv = argv;
      const reply = realShapedReply({
        summary: 'added ObjectAt',
        files_changed: ['src/shared/rdo-members.ts'],
        invariants: [{ id: 'INV-1', status: 'HELD' }],
        tests_run: ['npm run typecheck'],
        all_green: true,
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'IMPLEMENT', 'llm.IMPLEMENT', deps);

  assert.equal(result.ok, true);
  assert.equal(result.all_green, true);
  const modelIdx = seenArgv.indexOf('--model');
  assert.equal(seenArgv[modelIdx + 1], 'opus');
});

// ---- missing placeholder -> ParkSignal, no partial fill, no spawn --------------------------

test('missing placeholder value (worktreePath absent) parks instead of spawning', async () => {
  const taskDir = mkTmp('spo-card-missing-placeholder-');
  const task = { kind: 'card', issue: 1, title: 't', criterion: 'c', size: 'S' }; // no worktreePath

  let called = false;
  const deps = { spawnSync: fakeSpawnSync(() => { called = true; return { status: 0, stdout: '{}', stderr: '', signal: null }; }) };

  await assert.rejects(
    () => runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps),
    (err) => err instanceof ParkSignal && err.reason === 'prompt-missing-placeholder:worktree'
  );
  assert.equal(called, false, 'must never spawn once the prompt cannot be filled');
});

// ---- output-contract validation failure -> {kind:'error'}, same shape as a spawn failure ---

test('reply missing a required output key -> {ok:false, kind:"error"}, existing failure path', async () => {
  const taskDir = mkTmp('spo-card-missing-outputkey-');
  const task = {
    kind: 'card',
    issue: 2,
    title: 't',
    criterion: 'c',
    worktreePath: '/tmp/worktree-2',
    size: 'S',
  };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      // PLAN's contract requires plan_markdown/invariants_markdown/invariant_ids/check_commands
      // -- this reply is missing check_commands.
      const reply = realShapedReply({
        plan_markdown: '# Plan\n',
        invariants_markdown: '# Invariants\n',
        invariant_ids: [],
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.error, /check_commands/);
});

test('reply whose result field is not JSON at all -> {ok:false, kind:"error"}', async () => {
  const taskDir = mkTmp('spo-card-nonjson-reply-');
  const task = { kind: 'card', issue: 3, title: 't', criterion: 'c', worktreePath: '/tmp/worktree-3', size: 'S' };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({});
      reply.result = 'not json at all';
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
});

// A model can reply with valid JSON that is not an object. Before this guard the required-key
// filter's `key in parsedPayload` threw a TypeError straight out of runLlm, which runTask
// rethrows as "a real bug" -- killing the daemon on what is only a malformed reply, and the one
// transport-shaped failure that escaped state-machine.js's llm-transport-failed guards.
for (const [label, resultField] of [
  ['null', 'null'],
  ['a bare string', '"just a sentence"'],
  ['a number', '42'],
]) {
  test(`reply whose result field is valid JSON but ${label}, not an object -> {ok:false, kind:"error"}, no throw`, async () => {
    const taskDir = mkTmp('spo-card-nonobject-reply-');
    const task = { kind: 'card', issue: 4, title: 't', criterion: 'c', worktreePath: '/tmp/worktree-4', size: 'S' };

    const deps = {
      spawnSync: fakeSpawnSync(() => {
        const reply = realShapedReply({});
        reply.result = resultField;
        return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
      }),
    };

    const result = await runLlm(cardCtx({ taskDir, task }), 'PLAN', 'llm.PLAN', deps);
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'error');
    assert.match(result.error, /not an object/);
  });
}

// ---- DIAGNOSE's snake_case/camelCase bridge -------------------------------------------------

test('DIAGNOSE reply root_cause is also exposed as rootCause (handleDiagnose reads the camelCase name)', async () => {
  const taskDir = mkTmp('spo-card-diagnose-alias-');
  const task = { kind: 'card', issue: 4, worktreePath: '/tmp/worktree-4' };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({
        root_cause: 'coverage regression in foo.ts',
        category: 'coverage',
        suggested_fix: 'add a test for the new branch',
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'DIAGNOSE', 'llm.DIAGNOSE', deps);
  assert.equal(result.ok, true);
  assert.equal(result.root_cause, 'coverage regression in foo.ts');
  assert.equal(result.rootCause, 'coverage regression in foo.ts');
});

// Second fix pass (2026-09-13): `root_cause` IS declared (`'string'` in DIAGNOSE's `types`), and
// `root_cause: null` is not an edge case -- diagnose.md's own documented "no new cause" shape
// (handleDiagnose's `diagnose-no-new-cause` park reads it directly). No real-`runLlm` test
// exercised this before: an Opus verifier mutated `scalarTypeOk`'s 'string' case to reject `null`
// for `root_cause` specifically (leaving every other declared key's null-wildcard behaviour
// intact) and every test in this repo still passed, because nothing on the real path ever sent
// DIAGNOSE a null `root_cause`. This pins it.
test('DIAGNOSE reply with root_cause: null succeeds -- the documented "no new cause" shape, and the null-wildcard rule\'s only real-path exercise of a DECLARED key', async () => {
  const taskDir = mkTmp('spo-card-diagnose-rootcause-null-');
  const task = { kind: 'card', issue: 207, worktreePath: '/tmp/worktree-207' };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({ root_cause: null, reason: 'the plan was already fully implemented' });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'DIAGNOSE', 'llm.DIAGNOSE', deps);
  assert.equal(result.ok, true);
  assert.equal(result.root_cause, null);
  assert.equal(result.rootCause, null);
});

// ---- outputContract types (card #207) -- checkOutputTypes wired into the real reply check ----

function validateTask({ taskDir, issue }) {
  // VALIDATE's own prompt values (task-values.js's buildPromptValues, 'VALIDATE' branch) read
  // invariants_path/invariant_ids off the last journaled PLAN 'result' event -- write one first,
  // exactly as the "IMPLEMENT real card path escalates to opus" test above does for IMPLEMENT.
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      ok: true,
      plan_path: '/tmp/plan.md',
      invariants_path: '/tmp/invariants.md',
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    },
  });
  return { kind: 'card', issue, criterion: 'the widget renders', worktreePath: `/tmp/worktree-${issue}`, size: 'S' };
}

test('VALIDATE reply with reasons as a JSON-encoded string succeeds -- and the returned value stays the RAW STRING, untouched (item 4\'s resolution for this key: reasons carries no declared type, see step-contracts.js\'s own header comment for why -- state-machine.js\'s handleValidate journals this exact value verbatim as "the ONLY record of what the validator actually sent", card #640)', async () => {
  const taskDir = mkTmp('spo-card-validate-reasons-jsonstring-');
  const task = validateTask({ taskDir, issue: 200 });
  const raw = JSON.stringify(['the criterion is not met: the widget never renders']);

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({ verdict: 'REJECT', reasons: raw, findings: [] });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'VALIDATE', 'llm.VALIDATE', deps);
  assert.equal(result.ok, true);
  assert.equal(result.reasons, raw, 'left untouched -- handleValidate does its own normalizeFindingsPayload downstream, on purpose');
});

test('VALIDATE reply with verdict: 42 (a genuinely wrongly-typed required key) fails, naming the key in the error -- {ok:false, kind:"error"}, same shape as a missing key', async () => {
  const taskDir = mkTmp('spo-card-validate-badverdict-');
  const task = validateTask({ taskDir, issue: 201 });

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({ verdict: 42, reasons: [], findings: [] });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'VALIDATE', 'llm.VALIDATE', deps);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.error, /verdict/);
  assert.match(result.error, /string/);
});

// Retitled 2026-09-13 (second fix pass): this test's original title claimed to pin the null-
// wildcard rule, but `reasons` carries NO declared type at all -- so this only shows that an
// UNDECLARED key with a `null` value still succeeds (true, but unrelated to the wildcard rule,
// which only ever runs for a DECLARED key). The real wildcard-rule pin on the real `runLlm` path
// is the new DIAGNOSE `root_cause: null` test further down.
test('VALIDATE reply with reasons: null still succeeds -- reasons carries no declared type at all, so a null value is simply never checked (same real-mode shape test/validate-reject-reasons-contract.test.js\'s (c-1-real) pins)', async () => {
  const taskDir = mkTmp('spo-card-validate-reasons-null-');
  const task = validateTask({ taskDir, issue: 202 });

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({ verdict: 'REJECT', reasons: null, findings: [] });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'VALIDATE', 'llm.VALIDATE', deps);
  assert.equal(result.ok, true);
  assert.equal(result.reasons, null);
});

test('VALIDATE reply with findings as a bare, unparsable, non-JSON string still succeeds -- findings carries no declared type, so it behaves exactly as before this card (matches test/validate-findings.test.js\'s real-mode malformed-findings coverage)', async () => {
  const taskDir = mkTmp('spo-card-validate-findings-malformed-');
  const task = validateTask({ taskDir, issue: 203 });

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({ verdict: 'PASS_WITH_FINDINGS', reasons: [], findings: 'not json at all {{{' });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'VALIDATE', 'llm.VALIDATE', deps);
  assert.equal(result.ok, true);
  assert.equal(result.findings, 'not json at all {{{', 'left completely untouched -- no declared type means no check and no normalization');
});

test('IMPLEMENT reply with all_green as the STRING "false" (the real issue-247 corpus shape) still succeeds -- all_green carries no declared type', async () => {
  const taskDir = mkTmp('spo-card-implement-allgreen-string-');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      ok: true,
      plan_path: '/tmp/plan.md',
      invariants_path: '/tmp/invariants.md',
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    },
  });
  const task = { kind: 'card', issue: 204, criterion: 'c', worktreePath: '/tmp/worktree-204', size: 'S' };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({
        summary: 'Cannot proceed: the required plan file does not exist',
        files_changed: '[]',
        invariants: [],
        tests_run: [],
        all_green: 'false',
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'IMPLEMENT', 'llm.IMPLEMENT', deps);
  assert.equal(result.ok, true);
  assert.equal(result.all_green, 'false', 'left untouched -- a declared boolean type would park this real, already-observed shape');
  assert.equal(result.files_changed, '[]', 'files_changed carries no declared type either -- left untouched for state-machine.js\'s own parseFilesChanged to read');
});

test('IMPLEMENT reply with files_changed as a bare, unparsable, non-JSON string still succeeds -- files_changed carries no declared type (matches test/implement-empty-result.test.js\'s real-mode coverage)', async () => {
  const taskDir = mkTmp('spo-card-implement-fileschanged-unparsable-');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      ok: true,
      plan_path: '/tmp/plan.md',
      invariants_path: '/tmp/invariants.md',
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    },
  });
  const task = { kind: 'card', issue: 206, criterion: 'c', worktreePath: '/tmp/worktree-206', size: 'S' };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({
        summary: 'x',
        files_changed: 'not json',
        invariants: [],
        tests_run: [],
        all_green: false,
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'IMPLEMENT', 'llm.IMPLEMENT', deps);
  assert.equal(result.ok, true);
  assert.equal(result.files_changed, 'not json', 'left completely untouched, for state-machine.js\'s own parseFilesChanged to route to DIAGNOSE');
});

// ---- card #207 fix pass (2026-09-12) -- the regression the first build's `tests_run`/
// `invariants` declarations would have caused. Both fixtures below are byte-exact excerpts of
// real IMPLEMENT `result` payloads for issue-385 (~/.spo-state/journal/issue-385/journal.jsonl,
// read-only, nothing under ~/.spo-state was modified to produce them) -- the "cmd"-keyed
// tests_run and the prose invariants string come from two different real attempts on that card
// (no single attempt happened to combine both shapes), the "command"-keyed tests_run and its
// invariants array come from a single real attempt, verbatim. Both must succeed: `tests_run` and
// `invariants` carry no declared type (see step-contracts.js's own header and per-entry comments
// for why), so neither shape is enforced or normalized -- exactly the "behaves as before this
// card" guarantee item 4 of the original spec requires, and exactly what the first build's now-
// reverted `types: { invariants: 'object[]', tests_run: 'string[]' }` would have violated for
// both of these.

test('IMPLEMENT reply with tests_run as an array of {cmd, exit_code} objects and invariants as a prose string succeeds (real issue-385 shapes)', async () => {
  const taskDir = mkTmp('spo-card-implement-issue385-cmd-prose-');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      ok: true,
      plan_path: '/tmp/plan.md',
      invariants_path: '/tmp/invariants.md',
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    },
  });
  const task = { kind: 'card', issue: 385, criterion: 'favorites folder operations', worktreePath: '/tmp/worktree-385', size: 'L' };

  // Verbatim tests_run (as the JSON-encoded string on the wire) from issue-385's final IMPLEMENT
  // attempt's real reply.
  const testsRunRaw =
    '[{"cmd":"node -e precondition-check.js","exit_code":0},{"cmd":"npm run verdict -- typecheck","exit_code":0},{"cmd":"npm run verdict -- lint","exit_code":0},{"cmd":"npm run verdict -- coverage:changed","exit_code":0},{"cmd":"git grep sweep 1 (skips/links-only/procedure claims)","exit_code":0},{"cmd":"git grep sweep 2 (flow/message identifier names)","exit_code":0}]';
  // Verbatim invariants (prose, not an array) from a DIFFERENT real issue-385 IMPLEMENT attempt.
  const invariantsRaw =
    'All 16 invariants (INV-1 through INV-16) checked against the worktree as it now stands: all HELD (exact substring match for every quote).';

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({
        summary: 'Verified the favorites folder implementation against plan-385.md; all checks green.',
        files_changed: '[]',
        invariants: invariantsRaw,
        tests_run: testsRunRaw,
        all_green: 'true',
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'IMPLEMENT', 'llm.IMPLEMENT', deps);
  assert.equal(result.ok, true);
  assert.equal(result.tests_run, testsRunRaw, 'left as the raw JSON-encoded string -- tests_run carries no declared type');
  assert.equal(result.invariants, invariantsRaw, 'left as the raw prose string -- invariants carries no declared type');
});

test('IMPLEMENT reply with tests_run as an array of {command, exit_code} objects (the "command" spelling variant) also succeeds (real issue-385 shape)', async () => {
  const taskDir = mkTmp('spo-card-implement-issue385-command-');
  appendEvent(taskDir, 'PLAN', 'result', {
    payload: {
      ok: true,
      plan_path: '/tmp/plan.md',
      invariants_path: '/tmp/invariants.md',
      invariant_ids: ['INV-1'],
      check_commands: ['npm run typecheck'],
    },
  });
  const task = { kind: 'card', issue: 385, criterion: 'favorites folder operations', worktreePath: '/tmp/worktree-385', size: 'L' };

  // Verbatim tests_run AND invariants from a single real issue-385 IMPLEMENT attempt (the
  // "command", not "cmd", spelling).
  const testsRunRaw =
    '[{"command": "node -e \\"<precondition check: InterfaceServer.pas:202 declaration, Favorites.pas:247 guard, requestPrompt/requestConfirm, rdoCall>\\"", "exit_code": 0}, {"command": "npm run verdict -- typecheck", "exit_code": 0}, {"command": "npm run verdict -- lint", "exit_code": 0}, {"command": "npm run verdict -- coverage:changed", "exit_code": 0}, {"command": "node -e \\"<git grep sweep: no doc claims folders are skipped / a Favorites member is a procedure>\\"", "exit_code": 0}, {"command": "node -e \\"<git grep sweep: no doc enumerates the flow/message names this change adds>\\"", "exit_code": 0}]';
  const invariantsRaw =
    '[{"id": "INV-1", "status": "HELD"}, {"id": "INV-2", "status": "HELD"}, {"id": "INV-3", "status": "HELD"}, {"id": "INV-4", "status": "HELD"}, {"id": "INV-5", "status": "HELD"}, {"id": "INV-6", "status": "HELD"}, {"id": "INV-7", "status": "HELD"}, {"id": "INV-8", "status": "HELD"}, {"id": "INV-9", "status": "HELD"}, {"id": "INV-10", "status": "HELD"}, {"id": "INV-11", "status": "HELD"}, {"id": "INV-12", "status": "HELD"}, {"id": "INV-13", "status": "HELD"}, {"id": "INV-14", "status": "HELD"}, {"id": "INV-15", "status": "HELD"}, {"id": "INV-16", "status": "HELD"}]';

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({
        summary: 'Verified the favorites folder implementation against plan-385.md; all checks green.',
        files_changed: '[]',
        invariants: invariantsRaw,
        tests_run: testsRunRaw,
        all_green: 'true',
      });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'IMPLEMENT', 'llm.IMPLEMENT', deps);
  assert.equal(result.ok, true);
  assert.equal(result.tests_run, testsRunRaw, 'left as the raw JSON-encoded string -- tests_run carries no declared type');
  assert.equal(result.invariants, invariantsRaw, 'left as the raw JSON-encoded string -- invariants carries no declared type either, so a valid array is left as-is same as a prose string would be');
});

// Retitled 2026-09-13 (second fix pass): CITATION_VERIFIER's outputContract DOES declare a type
// (`verdict: 'string'`) -- the original title's "declares no types at all" was simply wrong. What
// this test actually pins is that its one UNDECLARED key, `entries`, behaves exactly as before
// this card regardless of shape.
test('CITATION_VERIFIER\'s undeclared key (`entries`) behaves exactly as before this card, even though `verdict` -- the step\'s other required key -- IS declared and enforced', async () => {
  const taskDir = mkTmp('spo-card-citation-verifier-entries-');
  const task = { kind: 'card', issue: 205, worktreePath: '/tmp/worktree-205', citations: ['AdmMembersRDO.pas:512'] };

  const deps = {
    spawnSync: fakeSpawnSync(() => {
      const reply = realShapedReply({ verdict: 'PASS', entries: 'not an array, not JSON, not anything checkable' });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '', signal: null };
    }),
  };

  const result = await runLlm(cardCtx({ taskDir, task }), 'CITATION_VERIFIER', 'llm.CITATION_VERIFIER', deps);
  assert.equal(result.ok, true);
  assert.equal(result.entries, 'not an array, not JSON, not anything checkable');
});
