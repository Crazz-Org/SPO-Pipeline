#!/usr/bin/env node
'use strict';
// smoke-llm.js -- the ONE sanctioned real invocation of the `claude` CLI for this build.
// Run by hand only: `node scripts/smoke-llm.js <account-name>`. Never part of `node --test`
// (see orchestrator/README.md "Real mode" / "Tests" for why it deliberately lives outside
// test/, where `node --test test/*.test.js` would otherwise pick it up).
//
// Exercises the real llm.js path end to end (argv construction, spawn, JSON parse, token
// extraction) against a trivial, cheap call: haiku, low effort, a $0.10 budget cap (the CLI's
// own `--max-budget-usd` guardrail, unrelated to this build's token accounting), run from this
// repo's own root (the orchestration-side cwd policy -- see config.js).
//
// The account is a required argument, resolved from the pool (orchestrator/accounts.js) --
// consistent with the maintainer decision (2026-08-29) that the pipeline uses ONLY accounts
// present in the pool directory, never an implicit fallback to whatever `claude` login happens
// to be ambient on this machine. Run `spo accounts` (or this script with no argument) to see
// what's registered.

const assert = require('assert');
const { invokeClaudeReal } = require('../orchestrator/steps/llm');
const accounts = require('../orchestrator/accounts');
const config = require('../orchestrator/config');

async function main() {
  const accountName = process.argv[2];
  const registry = accounts.readRegistry(config.claudeAccountsDir);

  if (!accountName) {
    console.error('usage: node scripts/smoke-llm.js <account-name>');
    if (registry.length === 0) {
      console.error(`no accounts registered in ${config.claudeAccountsDir} -- see doc/setup.md § Accounts.`);
    } else {
      console.error(`registered accounts: ${registry.map((a) => a.name).join(', ')}`);
    }
    process.exitCode = 1;
    return;
  }

  const account = registry.find((a) => a.name === accountName);
  if (!account) {
    console.error(`scripts/smoke-llm.js: no account named "${accountName}" in ${config.claudeAccountsDir}.`);
    console.error(
      registry.length === 0
        ? `no accounts registered -- see doc/setup.md § Accounts.`
        : `registered accounts: ${registry.map((a) => a.name).join(', ')}`
    );
    process.exitCode = 1;
    return;
  }

  const result = await invokeClaudeReal({
    step: 'SMOKE',
    model: 'haiku',
    effort: 'low',
    maxBudgetUsd: 0.1,
    promptText: 'Reply with exactly the single word: ok',
    cwd: '/home/crazz/SPO-Pipeline',
    account,
  });

  console.log(JSON.stringify(result, null, 2));

  assert.equal(result.ok, true, `expected ok === true, got ${result.ok} (kind=${result.kind}, error=${result.error})`);
  assert.equal(result.result.trim(), 'ok', `expected result to trim to "ok", got ${JSON.stringify(result.result)}`);
  assert.ok(result.sessionId, `expected a non-empty sessionId, got ${JSON.stringify(result.sessionId)}`);
  assert.ok(result.billableTokens > 0, `expected billableTokens > 0, got ${result.billableTokens}`);

  console.log('\nsmoke-llm: PASS');
  console.log(
    `  account=${account.name} ok=${result.ok} result=${JSON.stringify(result.result)} sessionId=${result.sessionId} ` +
      `billableTokens=${result.billableTokens} (fresh=${result.freshInputTokens} cacheCreation=${result.cacheCreationTokens} cacheRead=${result.cacheReadTokens} output=${result.outputTokens})`
  );
}

main().catch((err) => {
  console.error('smoke-llm: FAIL');
  console.error(err);
  process.exitCode = 1;
});
