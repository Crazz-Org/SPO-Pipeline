'use strict';
// SPO-Pipeline card 52 -- card review and validation read the scope a card lives in.
//   - review-card.md's check 3 carries the four whole-card properties (right repo, satisfiable by
//     a diff, not against a scoped CLAUDE.md, title and criterion promise the same set), and
//     draft-card.md asks the drafter for the title/criterion one up front.
//   - VALIDATE is handed the scoped CLAUDE.md files that govern the directories the diff changes
//     (task-values.js's scopedClaudeMdPaths), and told that a criterion a scoped rule forbids is
//     PASS_WITH_FINDINGS naming the conflict, not REJECT (card 888 was REJECTed for following
//     src/client/CLAUDE.md).
// The prompt checks pin the sentences the behaviour hangs on; the LLM's own verdict on real card
// bodies is not replayable here (no real `claude` in the suite -- test/no-real-spawn.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('./no-real-spawn');
const { scopedClaudeMdPaths, NO_SCOPED_CLAUDE_MD, buildPromptValues, diffPath } = require('../orchestrator/task-values');
const { mkTmp } = require('./helpers');

const PROMPTS = path.join(__dirname, '..', 'prompts');
const read = (f) => fs.readFileSync(path.join(PROMPTS, f), 'utf8');

function worktreeWith(files) {
  const wt = mkTmp('spo-scoped-wt-');
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.writeFileSync(path.join(wt, f), '# rules\n');
  }
  return wt;
}

function taskDirWithDiff(diffText) {
  const taskDir = mkTmp('spo-scoped-task-');
  fs.mkdirSync(path.dirname(diffPath(taskDir)), { recursive: true });
  if (diffText !== null) fs.writeFileSync(diffPath(taskDir), diffText);
  return taskDir;
}

const diffOf = (...files) => files.map(([a, b = a]) => `diff --git a/${a} b/${b}\nindex 1..2 100644\n--- a/${a}\n+++ b/${b}\n@@ -1 +1 @@\n-x\n+y\n`).join('');

test('scopedClaudeMdPaths: every scoped CLAUDE.md above a changed file, nearest and outer alike, sorted and de-duplicated; the root one is left out', () => {
  const wt = worktreeWith(['CLAUDE.md', 'src/client/CLAUDE.md', 'src/client/renderer/CLAUDE.md', 'src/server/CLAUDE.md', 'src/shared/CLAUDE.md']);
  const taskDir = taskDirWithDiff(diffOf(['src/client/renderer/draw.ts'], ['src/client/ui/panel.tsx'], ['src/server/ws.ts']));
  assert.equal(
    scopedClaudeMdPaths(taskDir, wt),
    [
      path.join(wt, 'src/client/CLAUDE.md'),
      path.join(wt, 'src/client/renderer/CLAUDE.md'),
      path.join(wt, 'src/server/CLAUDE.md'),
    ].join(', ')
  );
});

test('scopedClaudeMdPaths: one deep file finds the nearest AND every outer scoped CLAUDE.md, a first-level one included', () => {
  const wt = worktreeWith(['CLAUDE.md', 'src/CLAUDE.md', 'src/client/CLAUDE.md', 'src/client/renderer/CLAUDE.md']);
  const taskDir = taskDirWithDiff(diffOf(['src/client/renderer/deep/draw.ts']));
  assert.equal(
    scopedClaudeMdPaths(taskDir, wt),
    [path.join(wt, 'src/CLAUDE.md'), path.join(wt, 'src/client/CLAUDE.md'), path.join(wt, 'src/client/renderer/CLAUDE.md')].join(', ')
  );
});

test('scopedClaudeMdPaths: a rename counts both its old and its new directory', () => {
  const wt = worktreeWith(['src/client/CLAUDE.md', 'src/shared/CLAUDE.md']);
  const taskDir = taskDirWithDiff(diffOf(['src/client/a.ts', 'src/shared/a.ts']));
  assert.equal(scopedClaudeMdPaths(taskDir, wt), [path.join(wt, 'src/client/CLAUDE.md'), path.join(wt, 'src/shared/CLAUDE.md')].join(', '));
});

test('scopedClaudeMdPaths: the fixed "none" text -- never undefined -- when nothing governs the diff, the diff is missing, or there is no worktree', () => {
  const wt = worktreeWith(['CLAUDE.md', 'src/client/CLAUDE.md']);
  assert.equal(scopedClaudeMdPaths(taskDirWithDiff(diffOf(['scripts/x.js'], ['README.md'])), wt), NO_SCOPED_CLAUDE_MD);
  assert.equal(scopedClaudeMdPaths(taskDirWithDiff(''), wt), NO_SCOPED_CLAUDE_MD);
  assert.equal(scopedClaudeMdPaths(taskDirWithDiff(null), wt), NO_SCOPED_CLAUDE_MD);
  assert.equal(scopedClaudeMdPaths(taskDirWithDiff(diffOf(['src/client/a.ts'])), undefined), NO_SCOPED_CLAUDE_MD);
  assert.equal(scopedClaudeMdPaths(undefined, wt), NO_SCOPED_CLAUDE_MD);
});

test('buildPromptValues(VALIDATE) hands the scoped CLAUDE.md list to the prompt', () => {
  const wt = worktreeWith(['src/client/CLAUDE.md']);
  const taskDir = taskDirWithDiff(diffOf(['src/client/a.ts']));
  const values = buildPromptValues({ task: { issue: 888, criterion: 'c', worktreePath: wt }, taskDir }, 'VALIDATE');
  assert.equal(values.scoped_claude_md_paths, path.join(wt, 'src/client/CLAUDE.md'));
  assert.equal(values.pr_body_path, path.join(taskDir, 'pr-body.md'));
});

test('validate-change.md: reads the scoped rules, and a criterion a scoped CLAUDE.md forbids is PASS_WITH_FINDINGS, not REJECT', () => {
  const text = read('validate-change.md');
  assert.match(text, /scoped_rules: \{\{scoped_claude_md_paths\}\}/);
  assert.match(text, /read each one listed in\s+`scoped_rules`/);
  assert.match(text, /A criterion that a scoped `CLAUDE\.md` forbids is `PASS_WITH_FINDINGS` naming the conflict, not\s+`REJECT`/);
  assert.match(text, /Name the\s+rule \(`file:line`\) and the clause of the criterion it contradicts/);
  // the verdict table and the REJECT sentence carry the exception too, so the prompt does not contradict itself
  assert.match(text, /\| `PASS_WITH_FINDINGS` \| Criterion met — or unmet only because a scoped `CLAUDE\.md` forbids it/);
  assert.match(text, /reserved for \*the goal is not reached\* \(with the one exception below\)/);
  assert.match(text, /pr_body: {6}\{\{pr_body_path\}\}/);
});

test('review-card.md: check 3 carries the four whole-card properties, each with its verdict', () => {
  const text = read('review-card.md');
  const check3 = text.slice(text.indexOf('### 3 · Is it actionable as written?'), text.indexOf('### 4 ·'));
  // each bullet on its own, so a verdict in one bullet can never satisfy another's assertion
  const bullet = (heading) => {
    const start = check3.indexOf(`- **${heading}**`);
    assert.ok(start >= 0, `missing bullet: ${heading}`);
    const next = check3.indexOf('\n- **', start + 1);
    return check3.slice(start, next === -1 ? undefined : next);
  };
  const repo = bullet('Ground truth in this repo.');
  assert.match(repo, /`DO_NOT_FILE`/);
  assert.match(repo, /names the tracker to refile on/);
  const diff = bullet('Satisfiable by a diff.');
  assert.match(diff, /issue comment[\s\S]*live measurement[\s\S]*maintainer's reply/);
  assert.match(diff, /`FILE_AMENDED`/);
  assert.doesNotMatch(diff, /DO_NOT_FILE/);
  const rule = bullet('Not against a scoped rule.');
  assert.match(rule, /src\/client\/CLAUDE\.md/);
  assert.match(rule, /on the same tree you read for check 1, and search it for the\s+criterion's verb and object/);
  assert.match(rule, /`FILE_AMENDED`,\s+naming the rule \(`file:line`\)/);
  assert.doesNotMatch(rule, /DO_NOT_FILE/);
  const same = bullet('Title and criterion promise the same set.');
  assert.match(same, /say whether it is in scope or out/);
  // § 0's human_confirmed rule, the size paragraph and the verdict table all allow the wrong-repo DO_NOT_FILE
  assert.match(text, /only for checks 1–2 below[\s\S]{0,120}and for check 3's wrong-repository property/);
  assert.match(text, /checks 1–2 keep their own\s+`DO_NOT_FILE`, and so does check 3's wrong-repository property/);
  assert.match(text, /\| `DO_NOT_FILE` \|[^\n]*another repository's tracker/);
  // no fourth verdict was added
  const verdicts = new Set(text.match(/\b(FILE_AMENDED|DO_NOT_FILE|PASS_WITH_FINDINGS|FILE)\b/g));
  assert.deepEqual([...verdicts].sort(), ['DO_NOT_FILE', 'FILE', 'FILE_AMENDED']);
});

test('draft-card.md: the Done-means section must cover every case the title names', () => {
  assert.match(read('draft-card.md'), /It must cover everything the `title` promises/);
});
