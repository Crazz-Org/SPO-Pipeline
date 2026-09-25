'use strict';
// SPO-Pipeline card 49 -- a gate-fix loop must not commit an unrelated fix onto a card's branch
// (887 merged a handler change the change-validator asked to drop). The mechanical half is a
// report (test/real-steps.test.js, filesOutsidePlan); the rule itself lives where the fix
// starts, in implement.md and diagnose.md. This pins both prompts' scope sentences.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'prompts', f), 'utf8');

test('implement.md: a diagnosis reaches unplanned files only for failures this change caused; an outside cause is reported as out_of_scope_fix, never fixed on the branch', () => {
  const text = read('implement.md');
  const rule = text.slice(text.indexOf("- **Stay inside the plan's scope"), text.indexOf('- **The RDO wire rule'));
  assert.match(rule, /only for failures \*\*this card's own change caused\*\*/);
  assert.match(rule, /a check that fails on\s+`origin\/main` too, a flaky\s+test, an unrelated defect/);
  assert.match(rule, /Do not edit it, and do\s+not fold its fix into this branch/);
  assert.match(rule, /`stop_reason: "out_of_scope_fix: <path> — <one line>"`/);
  // the old blanket licence is gone
  assert.doesNotMatch(rule, /it only ever describes something already blocking this same card/);
});

test('diagnose.md: an out-of-scope cause is named as such and never sent back to IMPLEMENT as a fix', () => {
  const text = read('diagnose.md');
  assert.match(text, /start\s+`root_cause` with `out-of-scope:` and name the file, use the category `out-of-scope`/);
  assert.match(text, /Never send IMPLEMENT to repair\s+an unrelated file on this card's branch/);
  assert.match(text, /this change itself broke \(a missing export, a\s+test the change invalidated\) is in scope as usual/);
});
