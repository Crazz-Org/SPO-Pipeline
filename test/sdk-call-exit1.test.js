'use strict';
// Card SPO-Pipeline#254 -- the SDK transport dropped the error `result` when the CLI exits 1.
//
// Every failed call on the real CLI ends the same way: it writes an error `result` message
// (`is_error:true`, `api_error_status`, `terminal_reason`) and then EXITS 1. The vendored SDK turns
// that nonzero exit into `Error("Claude Code returned an error result: <text>")`, thrown into the
// stream AFTER the `result` message was yielded. consumeQueryStream's catch used to return
// `kind:'error'` on any throw, discarding the captured `result` -- so a usage limit was never
// `kind:'limit'`, and callLlmStep / callIntakeStepWithRotation never cooled or rotated an account.
//
// Why the existing tests missed it: every fake child in the suite that replied with a 429 `result`
// exited 0 (fakeSpawnedChild's default), and the SDK only throws on a NONZERO exit. So every test
// here replays its stream with a child that exits 1, and asserts -- through a spy wrapped around
// the stream -- that the SDK really threw. That assertion is what keeps these tests meaningful if a
// future harness change stops the throw from happening: they fail rather than pass on the
// clean-exit path.
//
// The streams are RECORDED, not composed: test/fixtures/sdk-cli-exit1-error-results.json is the
// stdout of the real CLI 2.1.280 against a local mock of the Messages API (its `_provenance` field
// says how). The expected classification of each is `classifyFailure` / `limitKindForFailure` on
// its `result` -- the same two functions the pre-cutover `claude -p` transport applied to the same
// fields -- plus an absolute table, so a change to those two functions cannot make both sides move
// together unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmp, writePoolDir, fakeSpawnedChild, fakeExecDeps } = require('./helpers');

// Must land before the orchestrator requires below -- see test/no-real-spawn.js.
require('./no-real-spawn');

const { consumeQueryStream } = require('../orchestrator/steps/sdk-call');
const { classifyFailure, limitKindForFailure, extractTokens, invokeClaudeReal } = require('../orchestrator/steps/llm');
const { loadQuery } = require('../orchestrator/sdk');
const accounts = require('../orchestrator/accounts');
const { callLlmStep, buildCtx } = require('../orchestrator/state-machine');
const intake = require('../orchestrator/intake');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk-cli-exit1-error-results.json'), 'utf8'));

// The absolute expectation per recorded stream. Covers every stream in the fixture (asserted
// below), so a fixture added without an expectation fails instead of being skipped.
const EXPECTED = {
  five_hour: { kind: 'limit', limitKind: 'usage', apiErrorStatus: 429 },
  seven_day: { kind: 'limit', limitKind: 'usage', apiErrorStatus: 429 },
  fable: { kind: 'limit', limitKind: 'usage', apiErrorStatus: 429 },
  overloaded: { kind: 'limit', limitKind: 'overloaded', apiErrorStatus: 529 },
  prompt_too_long: { kind: 'error', limitKind: undefined, apiErrorStatus: 400 },
};

function recordedResult(name) {
  const results = FIXTURE.streams[name].filter((l) => l.type === 'result');
  assert.equal(results.length, 1, `${name}: the recording holds exactly one result message`);
  return results[0];
}

// spyOnStream(stream) -- forwards every message unchanged and records the error the stream threw,
// if any. `spy.threw` is null when the stream ended cleanly.
function spyOnStream(stream) {
  const spy = { threw: null, messages: 0 };
  const wrapped = (async function* () {
    try {
      for await (const message of stream) {
        spy.messages += 1;
        yield message;
      }
    } catch (err) {
      spy.threw = err;
      throw err;
    }
  })();
  return { stream: wrapped, spy };
}

// A REAL spawned `node` child standing in for `claude` (test/sdk-call-stream.test.js's own
// fixture shape): writes `lines` as stream-json, then exits with `exitCode` -- a real OS exit code
// the vendored SDK reads off a real ChildProcess.
function writeFakeClaude(dir, lines, exitCode) {
  const fixturePath = path.join(dir, 'fake-claude.js');
  const body = [
    '#!/usr/bin/env node',
    `const lines = ${JSON.stringify(lines)};`,
    'for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");',
    `process.exit(${exitCode});`,
    '',
  ].join('\n');
  fs.writeFileSync(fixturePath, body, { mode: 0o755 });
  return fixturePath;
}

async function runStream(lines, exitCode) {
  const tmpDir = mkTmp('sdk-call-exit1-');
  const fixturePath = writeFakeClaude(tmpDir, lines, exitCode);
  const query = await loadQuery();
  const { stream, spy } = spyOnStream(
    query({ prompt: 'hello', options: { pathToClaudeCodeExecutable: fixturePath, cwd: tmpDir, env: process.env } })
  );
  const out = await consumeQueryStream(stream);
  return { out, spy };
}

test('#254 fixture: every recorded stream has an expectation, and every one ends in an is_error result', () => {
  assert.deepEqual(Object.keys(FIXTURE.streams).sort(), Object.keys(EXPECTED).sort());
  assert.equal(FIXTURE.exitCode, 1, 'the CLI exited 1 on every recorded run');
  for (const name of Object.keys(FIXTURE.streams)) {
    const r = recordedResult(name);
    assert.equal(r.is_error, true, `${name}: an error result`);
    assert.equal(r.subtype, 'success', `${name}: the success-subtype-with-error shape (sdk-call.js header item 3)`);
    assert.equal(r.api_error_status, EXPECTED[name].apiErrorStatus, `${name}: the mock's status reached the result`);
  }
});

for (const name of Object.keys(EXPECTED)) {
  test(`#254: recorded ${name} stream + CLI exit 1, through the real query() -> classified off the result, same as a clean exit`, async () => {
    const lines = FIXTURE.streams[name];
    const recorded = recordedResult(name);

    const exit1 = await runStream(lines, 1);
    // The premise. Without this throw the test would be exercising the clean-exit path, which was
    // never broken -- the exact blind spot that let #254 ship.
    assert.ok(exit1.spy.threw, `${name}: the SDK must throw on the child's exit 1 -- otherwise this test proves nothing about #254`);
    assert.equal(
      exit1.spy.threw.message,
      `Claude Code returned an error result: ${recorded.result}`,
      `${name}: the SDK's own replacement error, thrown after the result message`
    );
    assert.equal(exit1.spy.messages, lines.length, `${name}: every recorded line, the result included, was yielded before the throw`);

    // The old transport's classification: classifyFailure / limitKindForFailure on the result.
    const kind = classifyFailure(recorded);
    assert.equal(exit1.out.ok, false);
    assert.equal(exit1.out.kind, kind, `${name}: kind is classifyFailure(result)`);
    if (kind === 'limit') {
      assert.equal(exit1.out.limitKind, limitKindForFailure(recorded), `${name}: limitKind is limitKindForFailure(result)`);
    } else {
      assert.equal('limitKind' in exit1.out, false, `${name}: no limitKind key on a non-limit`);
    }
    // ...and the absolute answer, independent of those two functions.
    assert.equal(exit1.out.kind, EXPECTED[name].kind);
    assert.equal(exit1.out.limitKind, EXPECTED[name].limitKind);

    // Nothing of the result was discarded.
    assert.equal(exit1.out.apiErrorStatus, recorded.api_error_status);
    assert.equal(exit1.out.terminalReason, recorded.terminal_reason);
    assert.equal(exit1.out.result, recorded.result, `${name}: the CLI's own diagnostic text is carried, as on the old transport`);
    assert.equal(exit1.out.sessionId, recorded.session_id);
    assert.equal(exit1.out.numTurns, recorded.num_turns);
    assert.equal(exit1.out.durationS, recorded.duration_ms / 1000);
    assert.equal('error' in exit1.out, false, `${name}: no second copy of the result text in 'error' -- same shape as the clean exit`);

    // Parity: the SAME recording with a clean exit (no throw) gives a byte-identical answer.
    const exit0 = await runStream(lines, 0);
    assert.equal(exit0.spy.threw, null, `${name}: exit 0 does not throw (sdk-call.js header item 5's own mechanism)`);
    assert.deepEqual(exit1.out, exit0.out, `${name}: exit 1 and exit 0 must classify the same result identically`);
  });
}

test('#254: an is_error:false result followed by exit 1 is a FAILURE (the old is_error || exit !== 0), with the throw as its error', async () => {
  const lines = [
    FIXTURE.streams.five_hour[0], // the recorded init
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      duration_ms: 1500,
      session_id: FIXTURE.streams.five_hour[0].session_id,
      modelUsage: { 'claude-opus-5-5': { inputTokens: 40, outputTokens: 7 } },
      result: '{"verdict":"PASS"}',
    },
  ];
  const { out, spy } = await runStream(lines, 1);
  assert.ok(spy.threw, 'premise: the SDK threw on exit 1');
  assert.match(spy.threw.message, /exited with code 1/, "no lastErrorResultText to substitute -- the SDK's plain exit error");

  assert.equal(out.ok, false, 'a nonzero exit is a failure even when the result says is_error:false');
  assert.equal(out.kind, 'error');
  assert.equal('limitKind' in out, false);
  assert.match(out.error, /^sdk-call\.js: query\(\) stream threw after a result message with is_error:false arrived: /);
  assert.match(out.error, /exited with code 1/);
  // The result's own fields survive -- the pre-#254 catch zeroed them.
  assert.equal(out.tokensSource !== null && out.tokensSource !== undefined, true, 'tokens read off modelUsage, not discarded');
  assert.equal(out.numTurns, 2);
  assert.equal(out.sessionId, FIXTURE.streams.five_hour[0].session_id);
});

test('#254: a throw with NO result message before it is still kind:error, with the pre-#254 message', async () => {
  const { out, spy } = await runStream([FIXTURE.streams.five_hour[0]], 1);
  assert.ok(spy.threw, 'premise: the SDK threw on exit 1');
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'error');
  assert.equal('limitKind' in out, false);
  assert.match(out.error, /^sdk-call\.js: query\(\) stream threw before a result message arrived: .*exited with code 1/);
  assert.equal(out.sessionId, FIXTURE.streams.five_hour[0].session_id, 'the init message arrived -- its session is reported');
  assert.equal(out.tokensSource, null);
});

// ---- end to end: the limit cools the call's model and rotates to the next account --------------

// A spying `deps.query`: the REAL vendored query(), its stream wrapped by spyOnStream so the test
// can assert the SDK really threw on the in-memory child's exit 1.
async function spyingQuery() {
  const realQuery = await loadQuery();
  const spies = [];
  const query = (args) => {
    const { stream, spy } = spyOnStream(realQuery(args));
    spies.push(spy);
    return stream;
  };
  return { query, spies };
}

function okResultLines(result) {
  return [
    FIXTURE.streams.five_hour[0],
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      duration_ms: 900,
      session_id: FIXTURE.streams.five_hour[0].session_id,
      modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5 } },
      result,
    },
  ];
}

function expectedCooldownMs(name) {
  return EXPECTED[name].limitKind === 'overloaded' ? accounts.OVERLOADED_COOLDOWN_MS : accounts.USAGE_PROBE_COOLDOWN_MS;
}

const LIMIT_STREAMS = Object.keys(EXPECTED).filter((n) => EXPECTED[n].kind === 'limit');

test('#254 e2e callLlmStep: each recorded limit + exit 1 cools the call\'s model on acct-a and leases acct-b', async () => {
  assert.deepEqual(LIMIT_STREAMS.sort(), ['fable', 'five_hour', 'overloaded', 'seven_day']);
  for (const name of LIMIT_STREAMS) {
    const taskDir = mkTmp('spo-254-sm-taskdir-');
    const accountsDir = mkTmp('spo-254-sm-accts-');
    writePoolDir(accountsDir, [{ name: 'acct-a' }, { name: 'acct-b' }]);
    // The legacy override path, naming the model: the fable recording runs on fable, the others on
    // sonnet -- so the cooled key is the one the call's own model resolves to (card #167).
    const model = name === 'fable' ? 'fable' : 'sonnet';
    const ctx = buildCtx('t-254', { id: 't-254', llm: { VALIDATE: { model, effort: 'medium', promptText: 'check it' } } }, taskDir, {
      shadowMode: false,
      stepDeadlineMs: 30000,
      claudeAccountsDir: accountsDir,
      accountLeaseWaitMs: 2000,
      accountLeasePollMs: 25,
    });

    const configDirs = [];
    const spawn = (command, args, spawnOpts) => {
      configDirs.push(spawnOpts.env.CLAUDE_CONFIG_DIR);
      if (configDirs.length === 1) {
        return fakeSpawnedChild(FIXTURE.streams[name], { exitCode: 1, signal: spawnOpts.signal });
      }
      return fakeSpawnedChild(okResultLines('ok'), { signal: spawnOpts.signal });
    };
    const { query, spies } = await spyingQuery();

    const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));

    assert.equal(spies.length, 2, `${name}: two query() calls -- the limited one and the rotated one`);
    assert.ok(spies[0].threw, `${name}: premise -- the SDK threw on the first child's exit 1`);
    assert.match(spies[0].threw.message, /^Claude Code returned an error result: /);
    assert.equal(spies[1].threw, null);

    assert.equal(result.ok, true, `${name}: the rotated call's answer is returned`);
    assert.equal(path.basename(configDirs[0]), 'acct-a');
    assert.equal(path.basename(configDirs[1]), 'acct-b', `${name}: the next account was leased`);
    assert.equal(ctx.account.name, 'acct-b');

    const state = accounts.readState(accountsDir);
    assert.ok(state['acct-a'], `${name}: acct-a is cooling`);
    assert.deepEqual(Object.keys(state['acct-a'].byModel), [model], `${name}: exactly the call's model is cooled (card #167)`);
    const cooled = state['acct-a'].byModel[model];
    const anchor = EXPECTED[name].limitKind === 'usage' ? cooled.lastUsageLimitAt : cooled.cooldownUntil - accounts.OVERLOADED_COOLDOWN_MS;
    assert.equal(cooled.cooldownUntil - anchor, expectedCooldownMs(name), `${name}: the ${EXPECTED[name].limitKind} tier`);
    if (EXPECTED[name].limitKind === 'usage') assert.equal(cooled.usageLimitStreak, 1);
    assert.equal(state['acct-b'], undefined, `${name}: acct-b is not cooling`);

    const events = fs
      .readFileSync(path.join(taskDir, 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const cooldown = events.filter((e) => e.event === 'account-cooldown');
    assert.equal(cooldown.length, 1, `${name}: one account-cooldown event`);
    assert.equal(cooldown[0].account, 'acct-a');
    assert.equal(cooldown[0].limitKind, EXPECTED[name].limitKind);
    assert.equal(cooldown[0].cooldownMs, expectedCooldownMs(name));
  }
});

test('#254 e2e callLlmStep: the non-limit recording (400 prompt_too_long) + exit 1 neither cools nor rotates', async () => {
  const taskDir = mkTmp('spo-254-sm-nolimit-');
  const accountsDir = mkTmp('spo-254-sm-nolimit-accts-');
  writePoolDir(accountsDir, [{ name: 'acct-a' }, { name: 'acct-b' }]);
  const ctx = buildCtx('t-254n', { id: 't-254n', llm: { VALIDATE: { model: 'sonnet', effort: 'medium', promptText: 'x' } } }, taskDir, {
    shadowMode: false,
    stepDeadlineMs: 30000,
    claudeAccountsDir: accountsDir,
    accountLeaseWaitMs: 2000,
    accountLeasePollMs: 25,
  });
  let spawns = 0;
  const spawn = (command, args, spawnOpts) => {
    spawns += 1;
    return fakeSpawnedChild(FIXTURE.streams.prompt_too_long, { exitCode: 1, signal: spawnOpts.signal });
  };
  const { query, spies } = await spyingQuery();

  const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', fakeExecDeps({ spawn, query }));

  assert.ok(spies[0] && spies[0].threw, 'premise: the SDK threw on exit 1');
  assert.equal(spawns, 1, 'a non-limit failure never rotates');
  assert.deepEqual(accounts.readState(accountsDir), {}, 'and never cools');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  // The result's own fields reach the caller -- the pre-#254 catch replaced them with a generic
  // "stream threw" message and no status at all.
  assert.equal(result.apiErrorStatus, 400);
  assert.equal(result.terminalReason, 'prompt_too_long');
  assert.equal(result.result, recordedResult('prompt_too_long').result);
});

const VALID_DRAFT = {
  title: 'Header lacks a connection-state badge',
  body_markdown: ['The header never shows whether the gateway connection is up.', '', '## Done means', 'A badge.'].join('\n'),
  category: 'feature',
  size: 'S',
  area: 'client',
  priority: 'Medium',
  is_bug_report: false,
  confirmed: false,
};

test('#254 e2e callIntakeStepWithRotation (draftCard): a recorded 429 + exit 1 cools the intake model on acct1 and leases acct2', async () => {
  const accountsDir = writePoolDir(mkTmp('spo-254-intake-pool-'), [{ name: 'acct1' }, { name: 'acct2' }]);
  const configDirs = [];
  const { query, spies } = await spyingQuery();
  const deps = {
    ...fakeExecDeps(),
    accountsDir,
    journalRoot: mkTmp('spo-254-intake-journal-'),
    query,
    spawn: (command, args, spawnOpts) => {
      configDirs.push(spawnOpts.env.CLAUDE_CONFIG_DIR);
      if (configDirs.length === 1) {
        return fakeSpawnedChild(FIXTURE.streams.five_hour, { exitCode: 1, signal: spawnOpts.signal });
      }
      return fakeSpawnedChild(okResultLines(JSON.stringify(VALID_DRAFT)), { signal: spawnOpts.signal });
    },
  };

  const result = await intake.draftCard('add a badge', deps);

  assert.equal(spies.length, 2);
  assert.ok(spies[0].threw, 'premise: the SDK threw on the first child\'s exit 1');
  assert.equal(result.ok, true, 'the rotated call succeeded');
  assert.deepEqual(result.draft, VALID_DRAFT);
  assert.equal(path.basename(configDirs[0]), 'acct1');
  assert.equal(path.basename(configDirs[1]), 'acct2', 'the next account was leased');

  const model = intake.INTAKE_MODELS.draftCard;
  assert.equal(result.cooldowns.length, 1);
  assert.equal(result.cooldowns[0].account, 'acct1');
  assert.equal(result.cooldowns[0].limitKind, 'usage');
  assert.equal(result.cooldowns[0].cooldownMs, accounts.USAGE_PROBE_COOLDOWN_MS);
  const state = accounts.readState(accountsDir);
  assert.deepEqual(Object.keys(state.acct1.byModel), [model], 'exactly the intake step\'s model is cooled (card #167)');
  assert.equal(state.acct2, undefined);
});

// ---- #254 review fixes (Opus verifier, 2026-09-24) -------------------------------------------

// invokeClaudeReal opts for the three tests below. `configDir: null` keeps maybeRecoverTokens off
// any real transcript directory.
function realOpts(extra) {
  return { promptText: 'hi', model: 'sonnet', effort: 'low', cwd: '/tmp', account: { name: 'acct-a', configDir: null }, ...extra };
}

// Polls a condition every 10ms, at most `tries` times -- an event-order wait, not a duration.
async function waitForCondition(pred, tries = 500) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return pred();
}

test('#254 review F1: a 429 result, then a hang past the deadline, is a TIMEOUT -- kind error, timedOut, and NO limitKind', async () => {
  const lines = FIXTURE.streams.five_hour;
  const { query, spies } = await spyingQuery();
  const spawn = (command, args, spawnOpts) => fakeSpawnedChild(lines, { hang: true, signal: spawnOpts.signal });

  const out = await invokeClaudeReal(realOpts({ deadlineMs: 1000 }), fakeExecDeps({ spawn, query }));

  // Premise: the result was yielded BEFORE the deadline's abort made the stream throw -- the shape
  // #254 now classifies, and the one that leaked limitKind into the timeout.
  assert.equal(spies[0].messages, lines.length, 'premise: every recorded line, the 429 result included, arrived first');
  assert.ok(spies[0].threw, 'premise: the stream then threw (the abort)');

  assert.equal(out.ok, false);
  assert.equal(out.kind, 'error', 'a timeout is kind:error, whatever the result said');
  assert.equal(out.timedOut, true);
  assert.equal('limitKind' in out, false, 'a timeout must never carry a limitKind');
  // Kept on purpose, as diagnostic detail (llm.js deadline branch comment).
  assert.equal(out.apiErrorStatus, 429);
  assert.equal(out.terminalReason, 'api_error');
});

test('#254 review F2: token fields survive the is_error:true + exit-1 path (synthetic non-empty modelUsage)', async () => {
  const lines = FIXTURE.syntheticStreams.five_hour_with_model_usage;
  const recorded = lines.find((l) => l.type === 'result');
  const expected = extractTokens(recorded.modelUsage);
  assert.ok(expected.billableTokens > 0, 'premise: a non-zero token count that a regression could lose');

  const { out, spy } = await runStream(lines, 1);

  assert.ok(spy.threw, 'premise: the SDK threw on exit 1');
  assert.equal(out.kind, 'limit');
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(out[key], value, key + ': must equal extractTokens(result.modelUsage)');
  }
});

test('#254 review F3 (decided 2026-09-24): an external signal AFTER an error result keeps the limit, plus killedBySignal', async () => {
  const lines = FIXTURE.streams.five_hour;
  const { query, spies } = await spyingQuery();
  const children = [];
  const spawn = (command, args, spawnOpts) => {
    const child = fakeSpawnedChild(lines, { hang: true, signal: spawnOpts.signal });
    children.push(child);
    return child;
  };

  // No deadline armed: the only thing that ends this child is the external kill below.
  const pending = invokeClaudeReal(realOpts({}), fakeExecDeps({ spawn, query }));
  const resultArrived = await waitForCondition(() => spies.length === 1 && spies[0].messages === lines.length);
  assert.ok(resultArrived, 'premise: the 429 result was yielded before the kill');
  children[0].forceExit(null, 'SIGTERM');
  const out = await pending;

  assert.ok(spies[0].threw, 'premise: the kill made the stream throw after the result');
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'limit', 'the 429 genuinely happened -- the account must be cooled, not the call retried as a transport error');
  assert.equal(out.limitKind, 'usage');
  assert.equal(out.killedBySignal, true);
  assert.equal(out.signal, 'SIGTERM');
  assert.equal('timedOut' in out, false, 'an external kill is never a deadline timeout');
});
