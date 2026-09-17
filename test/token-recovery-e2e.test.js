'use strict';
// End-to-end proof for the A7 ruling (card #239 chantier, "token ledger on the SDK stream"):
// `maybeRecoverTokens`'s transcript-recovery path stays, because it is still load-bearing on
// THIS transport, not merely on the retired `claude -p` one.
//
// Every other test touching this machinery mocks one layer of the chain: test/llm-real.test.js
// exercises invokeClaudeReal's WIRING to maybeRecoverTokens with an INJECTED
// `deps.recoverSessionTokens` fake (proves the decision of WHEN to call it), and
// test/token-recovery.test.js exercises recoverSessionTokens's own file-finding/summing logic
// against real temp directories but never through a real `query()` call. Neither, on its own,
// proves the thing the card's own "usage arrives on the stream, so recovery is dead code" premise
// needs to be false: that a call which ends with no usable `result` message genuinely has no
// other way to learn what it spent, and that the transcript `claude` itself writes to disk is
// still there to recover it from.
//
// This file closes that gap: a REAL `query({prompt, options})` call from this repo's vendored
// Agent SDK, driving a real spawned `node` fixture (never `claude`, no network, no live
// credentials -- the same posture test/sdk-call-options.test.js's own test 3 and
// test/token-recovery.test.js's own "real temp directory tree, no mocked fs" rule both already
// take) through invokeClaudeReal with recoverSessionTokens NOT injected -- the real module runs.
// The fixture writes ONE real usage row to a real session-transcript JSONL file on disk (exactly
// the side effect `claude` itself has always had, independent of whatever wire protocol drives
// it -- stream-json here, `-p`'s single JSON reply before this chantier) BEFORE the end-state
// under test (a deadline kill, an external signal kill, a no-result exit) is reached, so a
// passing test proves the full chain -- kill happens, transcript already holds real data, the
// real reader finds it -- not just that each half individually can be made to.
//
// MEASURED (this action, one-off probe against this exact harness, deleted after use, not
// committed): all four "the CLI never got to send a usable `result` message" end states below
// come back `tokensSource: 'transcript'` with the fixture's real usage numbers; the fifth
// (killed before the CLI ever started, no session ever created) correctly stays
// `tokensSource: null` -- recovery is not fabricating a number where none exists. This proves the
// WIRING against a real `query()` call and a real spawned fixture -- it does not prove the real
// `claude` binary still writes a transcript under this wire protocol (no SDK-driven call has run
// against the real CLI yet; that half is a structural inference, settled by the first real
// SDK-driven kill -- see llm.js's own `maybeRecoverTokens` comment, fix pass F2). See this action's
// own report for the full table and the corrected real corpus counts (810 live-era `llm-call`
// events, 25 recovered via 'transcript', 3.09%, all `ok: false` -- an earlier pass wrongly counted
// 92 pre-instrumentation events `scripts/backfill-legacy-tokens.js` wrote retroactively as live
// recoveries) that back the "how often does this matter" half of the ruling.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn: realSpawn } = require('child_process');

const { mkTmp } = require('./helpers');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js's own header. Patches spawnSync only, never the async
// `spawn()` query() itself (and this file's own fixture) use -- see sdk-call-options.test.js's
// own top-of-file comment for why that leaves this file's real subprocess untouched.
require('./no-real-spawn');

const { invokeClaudeReal } = require('../orchestrator/steps/llm');

// One usage row's worth of tokens the fixture writes to its own transcript file before hitting
// whichever end state a test asks for -- distinct, non-round numbers so a test can tell "the real
// recovered figure" apart from a zeroed/defaulted one by inspection.
const FIXTURE_USAGE = { input_tokens: 111, cache_creation_input_tokens: 222, cache_read_input_tokens: 333, output_tokens: 44 };
const FIXTURE_BILLABLE = FIXTURE_USAGE.input_tokens + FIXTURE_USAGE.cache_creation_input_tokens + FIXTURE_USAGE.output_tokens;

// Asserts all four raw fields individually, not only `billableTokens` -- MUTATION-MEASURED (this
// action): `billableTokens` alone (fresh + cache-creation + output) is BLIND to a fresh/output
// swap, since FIXTURE_USAGE's own input_tokens/output_tokens happen to be the two smallest
// distinct values and a swap between any two summed fields leaves the total unchanged. A mutation
// that swapped `freshInputTokens`/`outputTokens` in token-recovery.js's own return object passed
// this suite's `billableTokens`-only assertions on three of four end-state tests before this
// helper existed -- caught only by the fourth (the deadline test, which already asserted every
// field). Every end-state test below uses this same helper now, so none of them can regress to
// that gap silently.
function assertFixtureUsageRecovered(result) {
  assert.equal(result.freshInputTokens, FIXTURE_USAGE.input_tokens);
  assert.equal(result.cacheCreationTokens, FIXTURE_USAGE.cache_creation_input_tokens);
  assert.equal(result.cacheReadTokens, FIXTURE_USAGE.cache_read_input_tokens);
  assert.equal(result.outputTokens, FIXTURE_USAGE.output_tokens);
  assert.equal(result.billableTokens, FIXTURE_BILLABLE);
}

// Writes the throwaway `node` fixture that plays the two independent real-`claude` side effects
// this test cares about: (1) the stream-json `init` line on stdout (so a session genuinely
// "exists" as far as this transport can tell), and (2) its own session-transcript JSONL file on
// disk, appended to directly -- never surfaced on the stream at all, exactly like the real CLI's
// own `--resume` bookkeeping isn't. `mode` picks what happens after that:
//   'clean-exit'  -- exit(0), no `result` line ever written (header item 5, sdk-call.js).
//   'throw-exit'  -- exit(7), no `result` line ever written (header item 4, sdk-call.js).
//   'hang'        -- never exits on its own; the test either lets invokeClaudeReal's own deadline
//                    kill it, or kills it itself (the external-signal scenario).
//   'never-started' -- exits immediately, before writing EITHER the init line or the transcript
//                    file -- the one case recovery must NOT fabricate a number for.
function writeFixture(fixturePath, sessionId, transcriptFile, mode) {
  const lines = [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    `const SESSION_ID = ${JSON.stringify(sessionId)};`,
    `const TRANSCRIPT_FILE = ${JSON.stringify(transcriptFile)};`,
    `const MODE = ${JSON.stringify(mode)};`,
    'if (MODE === "never-started") { process.exit(9); }',
    'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:SESSION_ID,apiKeySource:"none",model:"x",cwd:"/tmp",tools:[],mcp_servers:[]}) + "\\n");',
    `fs.appendFileSync(TRANSCRIPT_FILE, JSON.stringify({sessionId: SESSION_ID, timestamp: new Date().toISOString(), message: {id: 'msg-1', model: 'claude-sonnet-4-5', usage: ${JSON.stringify(FIXTURE_USAGE)}}}) + "\\n");`,
    'if (MODE === "clean-exit") { process.exit(0); }',
    'else if (MODE === "throw-exit") { process.exit(7); }',
    'else { setInterval(() => {}, 1000); }', // 'hang'
    '',
  ].join('\n');
  fs.writeFileSync(fixturePath, lines, { mode: 0o755 });
}

// Builds one throwaway {sessionId, tmpDir, accountConfigDir, transcriptFile, fixturePath, opts,
// deps} rig -- a fresh account-shaped directory tree per test (recoverSessionTokens's root 1,
// `accountConfigDir/projects`, is the one this rig always populates, so a real call always finds
// the fixture's transcript on the FIRST root it checks, before ever touching this machine's own
// real accountsDir/homeDir -- see token-recovery.js's own buildRoots for that ordering).
function makeRig(mode, extraOpts = {}) {
  const sessionId = crypto.randomUUID();
  const tmpDir = mkTmp('token-recovery-e2e-');
  const accountConfigDir = path.join(tmpDir, 'account1');
  const projectDir = path.join(accountConfigDir, 'projects', 'proj1');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
  const fixturePath = path.join(tmpDir, 'fake-claude.js');
  writeFixture(fixturePath, sessionId, transcriptFile, mode);

  const opts = {
    promptText: 'e2e probe',
    model: 'sonnet',
    effort: 'low',
    cwd: '/tmp',
    account: { name: 'e2e-account', configDir: accountConfigDir },
    sessionId,
    ...extraOpts,
  };
  const deps = {
    resolveClaudeCodeExecutable: () => fixturePath,
    isNoRealSpawnEnabled: () => false,
    spawn: realSpawn,
  };
  return { sessionId, tmpDir, transcriptFile, opts, deps };
}

// ---- the four end states where the stream itself never carries usable usage --------------------

test('e2e: a deadline-killed real call recovers its real transcript tokens, not zero', async () => {
  const { transcriptFile, opts, deps } = makeRig('hang', { deadlineMs: 200 });
  const result = await invokeClaudeReal(opts, deps);

  assert.equal(fs.existsSync(transcriptFile), true, 'the fixture must have written its transcript before being killed');
  assert.equal(result.timedOut, true);
  assert.equal(result.tokensSource, 'transcript');
  assertFixtureUsageRecovered(result);
  assert.equal(result.transcriptFilesRead, 1);
  assert.equal(result.transcriptFilesSkipped, 0);
});

test('e2e: an externally-signalled (non-deadline) kill recovers its real transcript tokens', async () => {
  const { transcriptFile, opts, deps } = makeRig('hang');
  // No deadlineMs on opts -- this is not this transport's own abort/deadline path at all. An
  // operator/OOM-shaped kill, sent directly at the real child, independent of invokeClaudeReal's
  // own timers -- deps.spawn wraps the real spawn() so the test can reach the real handle.
  const wrappedSpawn = (command, args, spawnOpts) => {
    const child = realSpawn(command, args, spawnOpts);
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 300);
    return child;
  };
  const result = await invokeClaudeReal(opts, { ...deps, spawn: wrappedSpawn });

  assert.equal(fs.existsSync(transcriptFile), true);
  assert.equal(result.ok, false);
  assert.equal(result.killedBySignal, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.tokensSource, 'transcript');
  assertFixtureUsageRecovered(result);
  assert.equal(result.transcriptFilesRead, 1);
});

// F4 (Opus verifier, fix pass): the clean-exit and throw-exit tests below exercise two DIFFERENT
// branches of sdk-call.js's consumeQueryStream (item 5's "stream ended, no throw, no result
// message" vs. item 4's "stream threw mid-iteration") that both land on invokeClaudeReal's SAME
// final `return maybeRecoverTokens(...)` line -- before this fix pass, both tests asserted only
// `ok`/`tokensSource`/the recovered numbers, none of which differ between the two branches, so a
// mutation that broke one always broke the other identically: zero discriminating power between
// them. Each now also pins its own branch's distinct `error` text (sdk-call.js's own literal
// strings for items 4 and 5), so a mutation that merged or swapped the two branches is caught by
// these tests specifically, not only by whatever exercises consumeQueryStream directly.
test('e2e: a clean (exit 0) stream end with no result message recovers its real transcript tokens', async () => {
  const { transcriptFile, opts, deps } = makeRig('clean-exit');
  const result = await invokeClaudeReal(opts, deps);

  assert.equal(fs.existsSync(transcriptFile), true);
  assert.equal(result.ok, false); // sdk-call.js header item 5: no result message is still a failure
  assert.equal(result.error, 'sdk-call.js: query() stream ended with no result message');
  assert.equal(result.tokensSource, 'transcript');
  assertFixtureUsageRecovered(result);
});

test('e2e: a nonzero-exit stream throw with no result message recovers its real transcript tokens', async () => {
  const { transcriptFile, opts, deps } = makeRig('throw-exit');
  const result = await invokeClaudeReal(opts, deps);

  assert.equal(fs.existsSync(transcriptFile), true);
  assert.equal(result.ok, false); // sdk-call.js header item 4: stream threw mid-iteration
  assert.match(result.error, /^sdk-call\.js: query\(\) stream threw before a result message arrived:/);
  assert.equal(result.tokensSource, 'transcript');
  assertFixtureUsageRecovered(result);
});

// ---- the null-vs-zero distinction must survive the real chain too -------------------------------

test('e2e: a call killed before the CLI ever started leaves no transcript, and recovery honestly returns null, never a fabricated zero-as-found', async () => {
  const { transcriptFile, opts, deps } = makeRig('never-started');
  const result = await invokeClaudeReal(opts, deps);

  assert.equal(fs.existsSync(transcriptFile), false, 'the fixture must not have had a chance to write anything');
  assert.equal(result.tokensSource, null);
  // Every raw field individually, not only the sum -- same "a sum can hide a swap or a stray
  // nonzero" discipline `assertFixtureUsageRecovered` documents above; ZERO_TOKENS is a frozen
  // literal today so this is currently redundant with the billableTokens check, but a sum-only
  // assertion here would not notice a future change that left `billableTokens` correct by
  // cancellation while one of its inputs stopped being an honest zero.
  assert.equal(result.freshInputTokens, 0);
  assert.equal(result.cacheCreationTokens, 0);
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.outputTokens, 0);
  assert.equal(result.billableTokens, 0);
  // Recovery was attempted (a real sessionId existed -- Job 2's restored mint) and found nothing,
  // which is a DIFFERENT outcome from "recovery was never attempted at all": the former still
  // leaves transcriptFilesRead/Skipped undefined because maybeRecoverTokens only ever merges
  // recoverSessionTokens's own extra fields when recoverSessionTokens returns non-null (see that
  // function's own comment) -- recovery returning null is exactly the "nothing recoverable" shape
  // token-recovery.js's own header distinguishes from "found rows summing to 0".
  assert.equal(result.transcriptFilesRead, undefined);
  assert.equal(result.transcriptFilesSkipped, undefined);
});

// ---- the field-name contract: recovery must never rename, drop, or otherwise touch a non-token
// field, proven by an actual diff against a real pre-recovery run of the SAME call, not by
// asserting a fixed list of key names is merely present (Opus verifier, fix pass F3: the original
// version of this test only checked 8 key names existed on ONE result and never compared against
// a pre-recovery baseline at all -- a mutation that had recovery also clobber `ok: true`, or that
// deleted `maybeRecoverTokens` entirely, both survived it).
test('e2e: recovery changes only the token-ledger fields -- diffed against a real pre-recovery run of the same call, not merely a list of key names', async () => {
  const { opts, deps } = makeRig('clean-exit');

  // Same opts (same sessionId, same fixture) run twice: once with recovery forced to report
  // "nothing found" (the same shape a call with no session-transcript match would produce, and
  // the one this test needs as its pre-recovery baseline), once with the real, non-injected
  // `recoverSessionTokens`. The fixture is spawned fresh each time (a real subprocess per call),
  // and appends a second usage row to the shared transcript file on the second run -- irrelevant
  // here since every TOKEN field is deliberately excluded from the comparison below; this test's
  // claim is about the fields recovery must leave alone, not the ones it's supposed to change.
  const withoutRecovery = await invokeClaudeReal(opts, { ...deps, recoverSessionTokens: async () => null });
  const withRecovery = await invokeClaudeReal(opts, deps);

  // Same convention as test/llm-real.test.js's own "A5 (informational only)" test, which pins this
  // exact property against a hand-built fixture rather than a real chain -- this is its real-chain
  // sibling. `durationS` is deliberately excluded: two separate real subprocess invocations have
  // no reason to take the same wall-clock time, and that is not a property recovery could affect
  // either way.
  for (const field of ['kind', 'ok', 'error', 'timedOut', 'sessionId', 'numTurns', 'raw']) {
    assert.deepEqual(withRecovery[field], withoutRecovery[field], `field "${field}" must not depend on whether recovery ran`);
  }

  // The sanity half: prove the two runs actually WENT DOWN DIFFERENT PATHS on the token side, or
  // the loop above would pass just as well with maybeRecoverTokens deleted outright.
  assert.equal(withoutRecovery.tokensSource, null);
  assert.equal(withoutRecovery.freshInputTokens, 0);
  assert.equal(withoutRecovery.cacheCreationTokens, 0);
  assert.equal(withoutRecovery.cacheReadTokens, 0);
  assert.equal(withoutRecovery.outputTokens, 0);
  assert.equal(withoutRecovery.billableTokens, 0);
  assert.equal(withRecovery.tokensSource, 'transcript');
  assertFixtureUsageRecovered(withRecovery);

  // Eight of the nine ledger field NAMES this action's brief requires are present on both runs
  // (never dropped, never renamed); the ninth, `modelUsage`, is checked separately right below --
  // it stays absent on both, since this end state never produced a `result` message at all, so
  // extractTokens was never even called with a real modelUsage block to derive one from.
  for (const key of [
    'tokensSource',
    'freshInputTokens',
    'cacheCreationTokens',
    'cacheReadTokens',
    'outputTokens',
    'billableTokens',
    'cacheCreationEphemeral1h',
    'cacheCreationEphemeral5m',
  ]) {
    assert.ok(key in withoutRecovery, `missing ledger field pre-recovery: ${key}`);
    assert.ok(key in withRecovery, `missing ledger field post-recovery: ${key}`);
  }
  assert.equal(withoutRecovery.modelUsage, undefined);
  assert.equal(withRecovery.modelUsage, undefined);
});
