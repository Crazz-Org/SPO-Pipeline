'use strict';
// SPO-Pipeline card 54 -- IMPLEMENT is asked to show each new test failing. About a quarter of
// ~4,700 SPO-WebClient test cases read in three independent passes could not fail as written,
// and the coverage ratchet rewards any executed line. The instruction lives in prompts/
// implement.md; nothing mechanical enforces it (a mutation tool would be a new SPO-WebClient
// dependency, which is the maintainer's call). This pins the sentences the behaviour hangs on,
// and that the proof lands where a reviewer reads it: the PR body IMPLEMENT writes (card 53).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');
const { STEP_CONTRACTS } = require('../orchestrator/step-contracts');

const text = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'implement.md'), 'utf8');
const step = (n) => {
  const start = text.search(new RegExp(`^${n}\\. \\*\\*`, 'm'));
  assert.ok(start >= 0, `implement.md has no step ${n}`);
  const next = text.slice(start + 1).search(/^\d+\. \*\*|^## /m);
  return text.slice(start, next === -1 ? undefined : start + 1 + next);
};

test('implement.md step 4: break the guarded line, run the one test file, see it fail, restore -- and never keep a test that stays green', () => {
  const s4 = step(4);
  assert.match(s4, /watch each new or rewritten test fail/);
  assert.match(s4, /break the production line it\s+guards/);
  assert.match(s4, /run that test file alone\s+\(`npx jest <file>`\), see the test fail, and restore the line exactly/);
  assert.match(s4, /never the full suite per break/);
  assert.match(s4, /rewrite it until it fails, do not keep it/);
  assert.match(s4, /`git diff` must show only your intended change/);
  assert.match(s4, /`### Proof each test can fail` heading, name each test and the\s+`file:line` you broke/);
  assert.match(s4, /guards no single production line[\s\S]*listed there with that reason/);
});

test('implement.md step 5 runs the test-hygiene ratchet when the worktree has it; step 9 carries the proof into the PR body', () => {
  assert.match(step(5), /when `src\/__tests__\/test-hygiene\.test\.ts` exists in the worktree[\s\S]*`npx jest src\/__tests__\/test-hygiene\.test\.ts`/);
  assert.match(step(9), /`### Proof each test can fail` section from step 4/);
  // the proof has somewhere to go: pr_body_markdown is an IMPLEMENT output key (card 53)
  assert.ok(STEP_CONTRACTS.IMPLEMENT.outputContract.optional.includes('pr_body_markdown'));
});
