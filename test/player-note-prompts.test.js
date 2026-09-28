'use strict';
// player-note-prompts.test.js -- card SPO-Pipeline#300. The in-game "What's New" shows only
// SPO-WebClient's src/client/player-notes.json (SPO-WebClient#1069); the implementer fills it from a
// `Player note (<added|fixed|changed>): <text>` line in the card's criterion. PLAN and IMPLEMENT
// see the criterion only, and extractCriterion keeps just the Done-means section's first paragraph
// (test/intake.test.js pins that), so the line has to be the FIRST line of that section. The two
// drafting prompts are the only place the line is produced; review-card.md flags a card that gets
// it wrong. These checks pin the sentences that behaviour hangs on, each sliced to the section it
// lives in so a sentence elsewhere in the file can never satisfy it. The LLM's own output is not
// replayable here (no real `claude` in the suite -- test/no-real-spawn.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');

const PROMPTS = path.join(__dirname, '..', 'prompts');
const read = (f) => fs.readFileSync(path.join(PROMPTS, f), 'utf8');

// slice(text, start, end): text between two markers, throwing when either is missing -- a slice
// with no boundary is a whole-file match by another name (test/intake.test.js's
// sliceReviewCardSection has the history).
function slice(file, text, start, end) {
  const from = text.indexOf(start);
  if (from === -1) throw new Error(`${file}: start marker not found: ${start}`);
  const to = text.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`${file}: end marker not found: ${end}`);
  return text.slice(from, to);
}

// The body_markdown shape each drafting prompt defines -- where the rule has to live.
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

// The line format and type vocabulary SPO-WebClient#1069 shipped (its doc/kanban-workflow.md
// § Player note and src/client/player-notes.ts's PlayerNoteType). Not a prediction: read off
// SPO-WebClient main on 2026-09-28.
const TYPES_RE = /`added`, `fixed` or `changed`|`added`\/`fixed`\/`changed`|<added\|fixed\|changed>/;

test('all three prompts name the literal `Player note (` form, in the section that uses it', () => {
  for (const [file, section] of [
    ['draft-card.md', draftShape()],
    ['triage-bug-report.md', triageShape()],
    ['review-card.md', reviewCheck3()],
  ]) {
    assert.match(section, /Player note \(/, `${file}: no \`Player note (\` in its section`);
    assert.match(section, TYPES_RE, `${file}: the type vocabulary added/fixed/changed is not stated`);
  }
});

test('draft-card.md: the note is the first line of the Done-means section, never a player name', () => {
  const s = draftShape();
  assert.match(s, /\*\*first line\*\* of the\s+`## Done means` section \(or the first words after the inline `Done means:` label\)/);
  assert.match(s, /with no\s+blank line before it/);
  assert.match(s, /never a player's name, an account, or quoted report text/);
  assert.match(s, /at most 200 characters/);
  assert.match(s, /no `feat:`\/`fix:` prefix/);
  // an internal change carries none -- the other half of the rule
  assert.match(s, /an internal change \(bench, e2e, ci, docs, tests, the pipeline, or a refactor with no visible\s+effect\) carries \*\*no\*\* line/);
  // the example line is itself well-formed (one of the three types, <= 200 chars of text)
  const example = s.match(/^\s*Player note \((added|fixed|changed)\): (.+)$/m);
  assert.ok(example, 'draft-card.md: no well-formed example line');
  assert.ok(example[2].length <= 200);
});

test('triage-bug-report.md: the note is the first line of the Done-means section, never a player name', () => {
  const s = triageShape();
  assert.match(s, /a `## Done means` section — the acceptance criterion\. Its \*\*first line\*\*, directly under the\s+heading with no blank line before it, is the player note/);
  assert.match(s, /never quotes the report and never names the player/);
  assert.match(s, /at most 200 characters/);
  // a confirmed report is player-visible by definition, so the line is expected, not optional
  assert.match(s, /so the line is expected here/);
});

test('review-card.md § 3: a fifth property flags a missing, misplaced or mis-worded Player note', () => {
  const s = reviewCheck3();
  assert.match(s, /And five properties of the card as a whole/);
  const start = s.indexOf('- **A player-visible change carries its `Player note`.**');
  assert.ok(start >= 0, 'missing bullet: A player-visible change carries its `Player note`.');
  const bullet = s.slice(start);
  assert.match(bullet, /`FILE_AMENDED`/);
  assert.doesNotMatch(bullet, /DO_NOT_FILE/);
  // the three cases
  assert.match(bullet, /a change a player would notice in the game has no `Player note` line/);
  assert.match(bullet, /an internal change has one/);
  assert.match(bullet, /the line breaks a wording rule/);
  assert.match(bullet, /the line is not the first line of the criterion's first paragraph/);
  // the correction is advisory: applyMechanicalCorrections applies enum lines only
  assert.match(bullet, /The correction gives the rewritten line\. It is a flag for a human reader, not an edit/);
  assert.match(bullet, /reaches the first comment and\s+never the body/);
  assert.match(bullet, /a player's name, an account or quoted report text \(the file is\s+public\)/);
});

test('review-card.md § 3: the Player note line is exempt from "never a formatting literal"', () => {
  const s = reviewCheck3();
  const start = s.indexOf('- **Title and criterion promise the same set.**');
  assert.ok(start >= 0, 'missing bullet: Title and criterion promise the same set.');
  const end = s.indexOf('\n- **', start + 1);
  const bullet = s.slice(start, end === -1 ? undefined : end);
  assert.match(bullet, /never a formatting literal\. The `Player note` line \(next property\) is the one exception/);
});

// A vocabulary change in only ONE of a section's type-list statements must fail too.
const TYPE_LIST_GLOBAL = [
  /<(\w+)\|(\w+)\|(\w+)>/g, // <added|fixed|changed>
  /`(\w+)`, `(\w+)`,? or\s+`(\w+)`/g, // `added`, `fixed` or `changed`
  /`(\w+)`\/`(\w+)`\/`(\w+)`/g, // `added`/`fixed`/`changed`
];
test('every type-list statement in the three sections is exactly added/fixed/changed', () => {
  for (const [file, section, min] of [
    ['draft-card.md', draftShape(), 1],
    ['triage-bug-report.md', triageShape(), 2],
    ['review-card.md', reviewCheck3(), 2],
  ]) {
    const lists = [];
    for (const re of TYPE_LIST_GLOBAL) for (const m of section.matchAll(re)) lists.push(m.slice(1, 4));
    const typeLists = lists.filter((l) => l.includes('added') || l.includes('fixed') || l.includes('changed'));
    assert.ok(typeLists.length >= min, `${file}: expected >= ${min} type lists, found ${typeLists.length}`);
    for (const l of typeLists) assert.deepEqual(l, ['added', 'fixed', 'changed'], `${file}: ${l.join('|')}`);
  }
});
