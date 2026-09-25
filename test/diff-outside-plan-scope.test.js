'use strict';
// SPO-Pipeline card 49 -- a gate-fix loop must not commit an unrelated fix onto a card's branch
// (887 committed a mail-handler.ts fix the change-validator then asked to drop; it was dropped
// before merge, at the cost of a REJECT round). The mechanical half is a
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
  assert.match(rule, /for failures \*\*this card's own change caused\*\*/);
  assert.match(rule, /\*\*what the criterion still\s+needs that the plan missed\*\*/);
  assert.match(rule, /Those may reach files the plan's `files_to_change` did not name/);
  assert.match(rule, /If the outside cause is\s+intermittent and your own change is still uncommitted, list your files as usual/);
  assert.match(rule, /the card goes back to DIAGNOSE, which\s+parks it for the maintainer — the outside fix never merges on this card/);
  assert.match(rule, /a\s+check\s+that\s+fails\s+on\s+`origin\/main`\s+too,\s+a\s+flaky\s+test,\s+an\s+unrelated\s+defect/);
  assert.match(rule, /Do\s+not\s+edit\s+it,\s+and\s+do\s+not\s+fold\s+its\s+fix\s+into\s+this\s+branch/);
  assert.match(rule, /`stop_reason: "out_of_scope_fix: <path> — <one line>"`/);
  // the old blanket licence is gone
  assert.doesNotMatch(rule, /it only ever describes something already blocking this same card/);
});

test('diagnose.md: an out-of-scope cause is named as such and never sent back to IMPLEMENT as a fix', () => {
  const text = read('diagnose.md');
  assert.match(text, /start\s+`root_cause` with `out-of-scope:` and name the file, use the category `out-of-scope`/);
  assert.match(text, /it fails on\s+`origin\/main` too, or sits in code the diff neither touched nor depends on/);
  assert.match(text, /make `suggested_fix` say that it is not this card's to fix/);
  assert.match(text, /Never send IMPLEMENT to repair\s+an unrelated file on this card's branch/);
  assert.match(text, /this change itself broke \(a missing export, a\s+test the change invalidated\) is in scope as usual/);
});
