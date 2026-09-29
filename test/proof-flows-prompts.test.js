'use strict';
// proof-flows-prompts.test.js -- card SPO-Pipeline#312. An observable SPO-WebClient card names the
// live E2E flows that prove it and the flows that guard its neighbours, as two lines right after
// the Player note in `## Done means`:
//   Proof flows: <flow>, new:<flow>
//   Regression flows: <flow>, <flow>
// or `Proof flows: none — <reason>` for a change nothing on the wire or screen can see. The two
// drafting prompts produce the lines, review-card.md flags a card that gets them wrong (an advisory,
// never a body edit), and plan.md copies them -- or chooses the flows itself when a card carries
// none -- into PLAN's optional `proof_flows` / `regression_flows` keys (step-contracts.js, pinned in
// test/step-contracts.test.js). Same approach as test/player-note-prompts.test.js (#300): each
// sentence is pinned inside the section it belongs to, so a sentence elsewhere in the file can never
// satisfy it. The LLM's own output is not replayable here (test/no-real-spawn.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');

const { STEP_CONTRACTS } = require('../orchestrator/step-contracts');

const PROMPTS = path.join(__dirname, '..', 'prompts');
const read = (f) => fs.readFileSync(path.join(PROMPTS, f), 'utf8');

// slice(text, start, end): text between two markers, throwing when either is missing (see
// test/player-note-prompts.test.js).
function slice(file, text, start, end) {
  const from = text.indexOf(start);
  if (from === -1) throw new Error(`${file}: start marker not found: ${start}`);
  const to = text.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`${file}: end marker not found: ${end}`);
  return text.slice(from, to);
}

// bullet(section, start): one top-level `- **...**` bullet, up to the next one or the section's end.
function bullet(section, start) {
  const from = section.indexOf(start);
  assert.ok(from >= 0, `missing bullet: ${start}`);
  const next = section.indexOf('\n- **', from + 1);
  return section.slice(from, next === -1 ? undefined : next);
}

const draftShape = () =>
  slice('draft-card.md', read('draft-card.md'), '2. **`body_markdown`**', '3. **`category`**');
const triageShape = () =>
  slice(
    'triage-bug-report.md',
    read('triage-bug-report.md'),
    '`body_markdown`, same shape `draft-card.md` produces',
    '`priority` — the card\'s criticity'
  );
const reviewCheck3 = () =>
  slice('review-card.md', read('review-card.md'), '### 3 · Is it actionable as written?', '### 4 ·');
const planHeader = () => slice('plan.md', read('plan.md'), '<!--', '-->');
const planStep3 = () =>
  slice('plan.md', read('plan.md'), '3. **Runnable check commands**', '4. **`files_to_change`**');

test('all three drafting/review sections name both line forms, the `new:` prefix, the `none — <reason>` form and FLOWS', () => {
  for (const [file, section] of [
    ['draft-card.md', draftShape()],
    ['triage-bug-report.md', triageShape()],
    ['review-card.md', reviewCheck3()],
  ]) {
    assert.match(section, /Proof flows: /, `${file}: no \`Proof flows:\``);
    assert.match(section, /Regression flows: /, `${file}: no \`Regression flows:\``);
    assert.match(section, /new:<flow>/, `${file}: no \`new:<flow>\``);
    assert.match(section, /`Proof flows: none — <reason>`/, `${file}: no \`none — <reason>\` form`);
    assert.match(section, /`FLOWS` list in (?:the product's )?`src\/e2e\/flows\.ts`/, `${file}: FLOWS source not named`);
  }
});

test('draft-card.md: both lines right after the Player note, no blank line, never the whole nightly', () => {
  const s = draftShape();
  const start = s.indexOf('- a **`Proof flows` line and a `Regression flows` line**');
  assert.ok(start >= 0, 'missing bullet: a `Proof flows` line and a `Regression flows` line');
  const b = s.slice(start, s.indexOf('- a final line: `Source:', start));
  assert.match(b, /on every card for SPO-WebClient whose\s+change is observable/);
  assert.match(b, /\*\*right after the `Player note` line\*\*, or first in the\s+`## Done means` section/);
  assert.match(b, /with no blank line before or between them/);
  assert.match(b, /A flow that does not\s+exist yet is written `new:<flow>`: the card must add it/);
  assert.match(b, /Never the whole nightly/);
  assert.match(b, /every name without `new:` is spelled exactly as a `name:` in `FLOWS`/);
  assert.match(b, /a change nothing on the wire or the screen can see writes one line instead of both:\s+`Proof flows: none — <reason>`/);
  assert.match(b, /a card for any repository other than SPO-WebClient carries neither line/);
  assert.match(b, /lines placed anywhere else never reach\s+them and PLAN picks flows of its own instead/);
  // the example is itself well-formed: two consecutive lines, comma-separated names, one `new:`
  // [ \t]*, not \s*, between the two lines: a blank line there would itself break the rule above
  const example = b.match(/^[ \t]*Proof flows: ([a-z0-9:, -]+)\n[ \t]*Regression flows: ([a-z0-9, -]+)$/m);
  assert.ok(example, 'draft-card.md: no well-formed two-line example');
  assert.ok(example[1].split(', ').some((n) => n.startsWith('new:')));
  assert.ok(example[2].split(', ').every((n) => !n.startsWith('new:')), 'a regression flow is an existing one');
});

test('triage-bug-report.md § 4: the two lines follow the note directly and are expected for a confirmed report', () => {
  const s = triageShape();
  assert.match(s, /The next two lines, directly under the note with no blank line before or between them/);
  assert.match(s, /`Proof flows: <flow>, new:<flow>` and `Regression flows: <flow>, <flow>`/);
  assert.match(s, /so the change is observable and both lines are expected here too/);
  assert.match(s, /never the whole nightly/);
  assert.match(s, /every other name is\s+spelled exactly as in `FLOWS`/);
});

test('review-card.md § 3: a sixth property flags missing lines or an unknown non-`new:` flow as FILE_AMENDED, advisory only', () => {
  const s = reviewCheck3();
  assert.match(s, /And six properties of the card as a whole/);
  const b = bullet(s, '- **An observable change names the flows that prove it.**');
  assert.match(b, /`FILE_AMENDED`/);
  assert.doesNotMatch(b, /DO_NOT_FILE/);
  assert.match(b, /an observable change has no `Proof flows` line, or no `Regression flows` line/);
  assert.match(b, /a flow named in either line, without the `new:` prefix, is not a `name:` in `FLOWS`/);
  assert.match(b, /the line reads `Proof flows: none — <reason>` and the reason does not hold/);
  assert.match(b, /`Regression flows` asks for the whole nightly/);
  assert.match(b, /the lines are not directly under the `Player note` \(or first\)/);
  // advisory: applyMechanicalCorrections applies enum lines only, never body_markdown
  assert.match(b, /a flag for a\s+human reader in the first comment, never an edit of the filed body/);
  assert.match(b, /A card filed without the\s+lines is still planned: PLAN picks the flows itself/);
  // reviewCard runs with cwd = productRepo (orchestrator/intake.js reviewCard), the tree check 1 reads
  assert.match(b, /open that file on\s+the tree you read for check 1/);
});

test('plan.md header: the reply shape carries proof_flows and regression_flows as string arrays', () => {
  const h = planHeader();
  assert.match(h, /"proof_flows": \["<flow>", "new:<flow>", \.\.\.\] \| \["none — <reason>"\]/);
  assert.match(h, /"regression_flows": \["<flow>", \.\.\.\]/);
  // and the contract says the same shape, optional -- the prompt and the table cannot drift apart
  const { optional, types } = STEP_CONTRACTS.PLAN.outputContract;
  for (const key of ['proof_flows', 'regression_flows']) {
    assert.ok(optional.includes(key), key);
    assert.equal(types[key], 'string[]', key);
  }
});

test('plan.md step 3: copies the criterion\'s lines, else chooses the flows itself, never the whole nightly', () => {
  const s = planStep3();
  assert.match(s, /two more keys of your reply, `proof_flows` and `regression_flows`,\s+each an array of strings/);
  assert.match(s, /\*\*When the criterion carries them\*\*, as a `Proof flows: \.\.\.` and a `Regression flows: \.\.\.`\s+line, copy them/);
  assert.match(s, /`"proof_flows": \["mail-roundtrip", "new:mail-delete-refresh"\]`/);
  assert.match(s, /\*\*When the criterion carries neither line\*\*, choose them yourself/);
  assert.match(s, /You decide which\. Never the whole nightly/);
  assert.match(s, /\*\*Only for a change nothing on the wire or the screen can see\*\*, `proof_flows` is\s+`\["none — <reason>"\]`/);
  assert.match(s, /`regression_flows` is `\[\]`/);
  assert.match(s, /\*\*For every `new:<flow>`, the plan schedules writing that flow\*\*/);
  assert.match(s, /`files_to_change` lists that file/);
  assert.match(s, /never put a `test:live` run\s+in `check_commands`/);
});
