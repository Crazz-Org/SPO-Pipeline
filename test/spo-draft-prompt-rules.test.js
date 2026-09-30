'use strict';
// spo-draft-prompt-rules.test.js -- card SPO-Pipeline#320. /SPO-Draft (.claude/commands/SPO-Draft.md)
// writes the JSON draft `spo ask --draft-file` reads (intake.loadDraftFile), and that draft's
// body_markdown becomes the issue body verbatim. The fast lane's prompts/draft-card.md already
// tells its drafter to open `## Done means` with the Player note (#300) and the Proof/Regression
// flows lines (#312); the brainstorm lane skips that prompt entirely, so the same rules have to live
// in SPO-Draft.md's own draft shape or its cards reach PLAN/IMPLEMENT without them (extractCriterion
// keeps only the section's first paragraph -- test/intake.test.js pins that). Same approach as
// test/player-note-prompts.test.js and test/proof-flows-prompts.test.js: each statement is pinned
// inside the bullet it belongs to, so a sentence elsewhere in the file can never satisfy it. The
// LLM's own output is not replayable here (test/no-real-spawn.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');

const FILE = 'SPO-Draft.md';
const read = () =>
  fs.readFileSync(path.join(__dirname, '..', '.claude', 'commands', FILE), 'utf8');

// slice(text, start, end): text between two markers, throwing when either is missing (see
// test/player-note-prompts.test.js -- a slice with no boundary is a whole-file match by another name).
function slice(text, start, end) {
  const from = text.indexOf(start);
  if (from === -1) throw new Error(`${FILE}: start marker not found: ${start}`);
  const to = text.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`${FILE}: end marker not found: ${end}`);
  return text.slice(from, to);
}

// The draft-shape section: step 1, up to the paragraph that writes the JSON to the scratchpad.
const draftShape = () =>
  slice(read(), '## 1. Synthesize the draft', 'Write the JSON to a file in **the session scratchpad**');

// The one top-level bullet carrying the product's lines, up to the next top-level bullet.
const START = '- **On a SPO-WebClient card, `## Done means` opens with the product\'s lines**';
function rulesBullet() {
  const s = draftShape();
  const from = s.indexOf(START);
  assert.ok(from >= 0, `${FILE}: missing bullet in the draft-shape section: ${START}`);
  const next = s.indexOf('\n- ', from + 1);
  return s.slice(from, next === -1 ? undefined : next);
}

// A nested `  - <lead>` item of the bullet, up to the next nested item or the bullet's end.
function item(lead) {
  const b = rulesBullet();
  const from = b.indexOf(`\n  - ${lead}`);
  assert.ok(from >= 0, `${FILE}: missing item: ${lead}`);
  const next = b.indexOf('\n  - ', from + 1);
  return b.slice(from, next === -1 ? undefined : next);
}

test('SPO-Draft.md: the rules bullet sits in the draft-shape section and points at draft-card.md', () => {
  const b = rulesBullet();
  assert.match(b, /the same rules as\s+`prompts\/draft-card\.md`'s `body_markdown` section/);
});

test('SPO-Draft.md: Player note -- the form, the exact type set, 200 characters, no internal names, no personal data, none for internal work', () => {
  const s = item('a change a player would notice in the game');
  assert.match(s, /`Player note \(<added\|fixed\|changed>\):\s+<sentence>` line/);
  assert.match(s, /The type is exactly one of `added`, `fixed` or `changed`/);
  assert.match(s, /at most 200 characters/);
  assert.match(s, /no internal\s+code names/);
  assert.match(s, /never a player's name, an\s+account or other personal data/);
  assert.match(s, /An internal change \(bench, e2e, ci, docs, tests, a refactor\s+with no visible effect\) carries \*\*no\*\* Player note/);
});

test('SPO-Draft.md: flows lines -- both forms, FLOWS spelling, `new:`, never the whole nightly, the `none — <reason>` form', () => {
  const s = item('an observable change');
  assert.match(s, /`Proof flows: <flow>, new:<flow>` and `Regression flows: <flow>, <flow>`/);
  assert.match(s, /spelled exactly as a `name:` in the `FLOWS` list in the product's `src\/e2e\/flows\.ts`/);
  assert.match(s, /`new:<flow>` is a flow the card must add/);
  assert.match(s, /never the whole nightly/);
  assert.match(s, /writes one line instead of both: `Proof flows: none — <reason>`/);
});

test('SPO-Draft.md: placement -- first in Done means, note then flows, no blank line, because extractCriterion cuts there', () => {
  const s = item('placement:');
  assert.match(s, /these are the \*\*first lines\*\* of `## Done means`, Player note first and then the\s+flows lines/);
  assert.match(s, /with no blank line before or between them/);
  // the JSON-string form of that rule: a single `\n` between these lines, the `\n\n` only before
  // `Source:` -- a bare "no `\n\n` in the JSON string" read literally would drop every paragraph break
  assert.match(s, /a single `\\n` after the heading and after each of these lines; the section's\s+first `\\n\\n` comes after the criterion, before the `Source:` line/);
  assert.match(s, /`extractCriterion` \(`orchestrator\/intake\.js`\) cuts the\s+criterion at the section's first blank line/);
  assert.match(s, /a line placed after a blank line never reaches them/);
  // the example is itself well-formed: heading, note, then the two flows lines, consecutive
  // ([ \t]*, not \s*, between lines: a blank line there would itself break the rule above)
  const ex = s.match(
    /^[ \t]*## Done means\n[ \t]*Player note \((added|fixed|changed)\): (.+)\n[ \t]*Proof flows: ([a-z0-9:, -]+)\n[ \t]*Regression flows: ([a-z0-9, -]+)\n[ \t]*\S/m
  );
  assert.ok(ex, `${FILE}: no well-formed example block`);
  assert.ok(ex[2].length <= 200);
  assert.ok(ex[3].split(', ').some((n) => n.startsWith('new:')));
  assert.ok(ex[4].split(', ').every((n) => !n.startsWith('new:')), 'a regression flow is an existing one');
});

test('SPO-Draft.md: a card for any other repository carries none of these lines', () => {
  assert.match(rulesBullet(), /On a SPO-WebClient card/);
  const s = item('a card for any repository other than SPO-WebClient');
  assert.match(s, /carries none of these lines/);
});

// A vocabulary change in only ONE of the bullet's type-list statements must fail too.
test('SPO-Draft.md: every type-list statement in the bullet is exactly added/fixed/changed', () => {
  const b = rulesBullet();
  const lists = [];
  for (const re of [/<(\w+)\|(\w+)\|(\w+)>/g, /`(\w+)`, `(\w+)`,? or\s+`(\w+)`/g]) {
    for (const m of b.matchAll(re)) lists.push(m.slice(1, 4));
  }
  assert.ok(lists.length >= 2, `expected >= 2 type lists, found ${lists.length}`);
  for (const l of lists) assert.deepEqual(l, ['added', 'fixed', 'changed'], l.join('|'));
});
