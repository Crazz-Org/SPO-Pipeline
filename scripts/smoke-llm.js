#!/usr/bin/env node
'use strict';
// smoke-llm.js -- the ONE sanctioned real invocation of the `claude` CLI for this build.
// Run by hand only: `node scripts/smoke-llm.js`. Never part of `node --test` (see
// orchestrator/README.md "Real mode" / "Tests" for why it deliberately lives outside test/,
// where bare `node --test` auto-discovers any .js file).
//
// Exercises the real llm.js path end to end (argv construction, spawn, JSON parse, cost
// summing) against a trivial, cheap call: haiku, low effort, a $0.10 budget cap, run from this
// repo's own root (the orchestration-side cwd policy -- see config.js), the default account
// (no CLAUDE_CONFIG_DIR override -- whatever `claude` is already logged into on this machine).

const assert = require('assert');
const { invokeClaudeReal } = require('../orchestrator/steps/llm');
const { DEFAULT_ACCOUNT } = require('../orchestrator/accounts');

async function main() {
  const result = await invokeClaudeReal({
    step: 'SMOKE',
    model: 'haiku',
    effort: 'low',
    maxBudgetUsd: 0.1,
    promptText: 'Reply with exactly the single word: ok',
    cwd: '/home/crazz/SPO-Pipeline',
    account: DEFAULT_ACCOUNT,
  });

  console.log(JSON.stringify(result, null, 2));

  assert.equal(result.ok, true, `expected ok === true, got ${result.ok} (kind=${result.kind}, error=${result.error})`);
  assert.equal(result.result.trim(), 'ok', `expected result to trim to "ok", got ${JSON.stringify(result.result)}`);
  assert.ok(result.sessionId, `expected a non-empty sessionId, got ${JSON.stringify(result.sessionId)}`);
  assert.ok(result.costUsd > 0, `expected costUsd > 0, got ${result.costUsd}`);

  console.log('\nsmoke-llm: PASS');
  console.log(
    `  ok=${result.ok} result=${JSON.stringify(result.result)} sessionId=${result.sessionId} costUsd=${result.costUsd}`
  );
}

main().catch((err) => {
  console.error('smoke-llm: FAIL');
  console.error(err);
  process.exitCode = 1;
});
