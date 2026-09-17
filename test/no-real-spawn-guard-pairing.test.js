'use strict';
// no-real-spawn-guard-pairing.test.js -- F4 (card #239 chantier, action A5b fix pass). Proves
// test/helpers.js's fakeExecDeps() cannot disarm the no-real-spawn killswitch
// (isNoRealSpawnEnabled: () => false) without ALSO supplying a fake spawn. Before this fix,
// nothing enforced that pairing structurally: `isNoRealSpawnEnabled: () => false` disarms BOTH
// killswitch layers (llm.js's invokeClaudeReal, and sdk-call.js's spawnClaudeCodeProcess -- see
// that file's own "Both, not either" header), and with both disarmed,
// makeSpawnClaudeCodeProcess's own `deps.spawn || spawn` falls back to the REAL
// child_process.spawn the moment a call site forgets to override `spawn`. Latent, not live, today
// (every one of this suite's 22+ real call sites happens to also supply its own `spawn`), but not
// theoretical either: a real `claude` executable IS on PATH on this machine (and on every pool
// worker image), so a forgotten override is one missing key away from a real spawned process
// carrying live account credentials, from inside a test run.
//
// See test/helpers.js's own fakeExecDeps header for the fix: a POISON-PILL `spawn` default,
// bundled in the SAME function that does the disarming, so the guard can never be disarmed here
// without also getting a fake spawn -- a real one from an overriding call site, or a loud,
// synchronous throw from the poison pill when nothing overrides it.

const test = require('node:test');
const assert = require('node:assert/strict');

// Repo-wide guard against a real in-process spawnSync reaching git/gh/npm/claude with live
// credentials -- see test/no-real-spawn.js for the incident and why this require has to land
// before the orchestrator require(s) below (same convention every real-mode test file in this
// suite already follows).
require('./no-real-spawn');
const { invokeClaudeReal } = require('../orchestrator/steps/llm');
const { fakeExecDeps, fakeSpawnDeps } = require('./helpers');

function baseOpts(overrides = {}) {
  return {
    promptText: 'hi',
    model: 'haiku',
    effort: 'low',
    cwd: '/tmp',
    account: { name: 'default', configDir: null },
    ...overrides,
  };
}

test('THE DEFECT THIS PAIRS AGAINST: fakeExecDeps() with no spawn override refuses via its own poison pill -- never falls through to the real child_process.spawn', async () => {
  // Deliberately the one call in this whole suite that disarms the killswitch and supplies NO
  // spawn override at all -- exactly the call site F4 exists to make impossible to ship silently.
  const deps = fakeExecDeps();
  assert.equal(typeof deps.isNoRealSpawnEnabled, 'function');
  assert.equal(deps.isNoRealSpawnEnabled(), false, 'both killswitch layers really are disarmed here');

  const result = await invokeClaudeReal(baseOpts(), deps);

  // Refused as an ordinary step failure (invokeClaudeReal's own `query() failed to start` catch,
  // llm.js -- the poison pill throws SYNCHRONOUSLY from inside spawnClaudeCodeProcess, which
  // query() calls during its own synchronous construction, before any child exists), never a hang
  // and never a real OS process.
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.error, /fakeExecDeps\(\) disarmed the no-real-spawn killswitch/);
  assert.match(result.error, /never supplied its own deps\.spawn override/);
  assert.equal(result.sessionId, null, 'claude was never spawned -- the poison pill fired before any message could arrive');
});

test('the mirror case: fakeExecDeps({ spawn }) -- the caller-supplied spawn wins over the poison pill, exactly as every other call site in this suite already depends on', async () => {
  const { spawn, calls } = fakeSpawnDeps([
    { type: 'system', subtype: 'init', session_id: 'pairing-ok', apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'pairing-ok', modelUsage: {}, result: 'ok' },
  ]);

  const result = await invokeClaudeReal(baseOpts(), fakeExecDeps({ spawn }));

  assert.equal(result.ok, true);
  assert.equal(result.result, 'ok');
  assert.equal(calls.length, 1, 'the overriding fake spawn was actually reached, not the poison pill');
});

// The other object-spread idiom every existing call site in this suite (intake.test.js,
// implement-empty-result.test.js, ...) actually uses: `spawn` supplied as a SIBLING key in an
// object literal that spreads `...fakeExecDeps()` first, rather than passed as fakeExecDeps'
// own `extra` argument. Both must resolve to the real fake, not the poison pill.
test('the sibling-spread idiom (`{ ...fakeExecDeps(), spawn }`) also wins over the poison pill', async () => {
  const { spawn, calls } = fakeSpawnDeps([
    { type: 'system', subtype: 'init', session_id: 'pairing-sibling-ok', apiKeySource: 'none', model: 'x', cwd: '/tmp', tools: [], mcp_servers: [] },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'pairing-sibling-ok', modelUsage: {}, result: 'ok' },
  ]);
  const deps = { ...fakeExecDeps(), spawn };

  const result = await invokeClaudeReal(baseOpts(), deps);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});
