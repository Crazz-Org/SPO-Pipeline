# Accepted-gap register (action 7bis.5)

> **Status: a dated record.** True as of its entry's date; never re-verified against present code.

**Added 2026-09-02.** This is Gate C7's third certification — "**Declared**" — made concrete:
a partition of the whole documentation-and-comment corpus this chantier could have audited
into what is mechanically enforced, what was read exhaustively, what is classified as a
historical log (and therefore correctly out of scope rather than un-audited), and what is
an accepted, named gap handed to chantier 9. Every line of every candidate file lands in
exactly one bucket below. This register is itself a dated record, true as of 2026-09-02,
against the tree at commit `bb3594225b5ac087c0952c469f38a5f2d0a0951a`, with two later
corrections applied by the driver: `doc/remediation-progress.md` 1,823 → 1,872 and
`doc/remediation-plan-2026-08.md` 402 → 443 (the C7 handoff rewritten at the end of the chantier,
and the plan amended to supersede row 8.5, re-plan chantier 9 as parallel, and widen execution
rule 6's scope list), plus `test/prompt-contract-sweep.test.js`, which is outside this corpus. Nothing else in the corpus changes after that pin except this file, which excludes
itself — so the counts below are true at the branch's merge state, not only at the pin. Re-run the commands
in §1 to refresh it; do not hand-edit the numbers.

**Method note, matching this plan's own rule:** every count below is measured with a shown
command, not estimated. Where this register's numbers disagree with the plan's own prior
estimates (`~16,800` total, `~2,290` retired), **the measurement in this register wins** —
see §4.

---

## 1 · The surface, named explicitly

**In scope** — action 7bis.6's sibling-grep list (execution rule 6 in
`doc/remediation-plan-2026-08.md`) is the plan's own operational definition of "the documents and
comments this chantier holds itself accountable for." As written on 2026-09-02 that list was
`doc/`, `prompts/`, `orchestrator/`, `bin/spo`, `console/`, `README.md` — **not exhaustive** of
the repo's documentation-and-comment surface, because `scripts/` and `accounts/` carry real
comments and were absent from it. **Execution rule 6 has since been amended to add both**, so
this register and that rule now name the same surface. Full list:

- `doc/*.md` (all files directly under `doc/`)
- `prompts/*.md` (all files directly under `prompts/`)
- `orchestrator/README.md` and every comment line in `orchestrator/**/*.js`
- `bin/spo` (comment lines only — it is a script, not a doc)
- `console/**/*.js` (comment lines only)
- `README.md` (repo root)
- `scripts/**` (comment lines only — `scripts/smoke-llm.js` and `scripts/usage-report.js`
  are JS, `scripts/daemon-install.sh`, `scripts/dashboard-install.sh`, `scripts/park-alert.sh`
  and `scripts/git-hooks/post-merge` are shell)
- `accounts/spo-test-accounts.yml` (comment lines only — it is a config file, not a doc)
- `.github/workflows/gate.yml` (comment lines only — a config file, but its 30 comment lines
  state what the gate is and why a self-reported verdict is not one)
- `CLAUDE.md` (repo root) — moved in on 2026-09-05, see below

**Corrected into scope.** `scripts/` and `accounts/` were absent from both lists below in the
prior version of this register — an undeclared, unnamed surface, not a considered exclusion. Root
cause: this corpus definition was inherited from action 7bis.6's sibling-grep scope list, which
itself omitted them, **so execution rule 6 carried the same blind spot and every sibling grep run
under it was blind to these two directories.** The register was the symptom; the rule was the
cause. **Both are now fixed**: execution rule 6 was amended on 2026-09-02 to add `scripts/` and
`accounts/`, and records there why. The §7 grep below was re-run over the widened scope.

**Corrected into scope, again — 2026-09-05.** Two more, by the same failure and one new one.
`.github/` was in **neither** list: not in rule 6's scope, and not in the top-level check at the
end of this section, whose closing sentence ("every top-level entry is now placed in exactly one
bucket, with a reason") was therefore **false as written on 2026-09-02** — it enumerated thirteen
entries and the repo root had fourteen. `CLAUDE.md` is the different case: it was a *declared*
exclusion below, so nothing was hidden, but its reason expired. It was excluded as
"harness-governed operational instructions, not product/process documentation"; on 2026-09-05 it
gained a *Working a chantier* section restating execution rule 6 and the Sonnet-builds /
Opus-verifies-with-mutation-testing loop from `doc/remediation-progress.md`, which is process
documentation by any reading, and duplicated process documentation at that. **The lesson this
register drew in 2026-09-02 needs widening: re-checking a scope list means re-checking each
exclusion's *reason*, not only that every entry appears somewhere.** An entry can be correctly
placed on the day it is placed and wrong a week later without anything moving it. Execution rule
6 records the matching amendment.

**What this amendment does *not* do:** the §3 line counts are **not** re-measured here, so
`.github/workflows/gate.yml`'s 30 comment lines and `CLAUDE.md`'s lines are in scope but absent
from every total below. Those totals stay pinned to `bb35942` and to 2026-09-02, as this file's
header says a dated record must. The scope is corrected today; the arithmetic is stale until
someone re-runs §2's commands over the widened corpus. Said here so the gap is declared rather
than discovered — which is the whole purpose of this register.

**This file itself** is classified-historical, by the same rule as §3b and by its own opening
paragraph. Its line count is deliberately **not** added to the §3 totals: this register does not
count its own text, and a register that counted itself would move its own totals on every edit.
Stated here so the exclusion is declared rather than silently assumed — the failure this whole
register exists to prevent.

**Out of scope, by definition, and why:**

- **`test/**`** — never part of the original Gate C7 clause ("`doc/` and `prompts/` contain no
  claim contradicted by the code," later widened only to "overwhelmingly `orchestrator/`
  comments" — never to tests), and not in 7bis.6's own sibling-grep list either. Test files
  assert against test fixtures and test intent, not product behaviour; a stale test comment is
  a test-maintenance problem, not a truthfulness-of-documentation problem this chantier owns.
- **`.claude/**`** (`settings.json`, `hooks/*.sh`, `commands/`) — absent from 7bis.6's list.
  Harness-governed operational configuration, not product/process documentation, and per
  `CLAUDE.md` itself `.claude/settings.json` and `.claude/hooks/*.sh` cannot even be edited by an
  agent — excluded from this corpus the same way they are excluded from every action's write
  scope. **`CLAUDE.md` was excluded here alongside them until 2026-09-05 and is now in scope**;
  see "Corrected into scope, again" above for why that reason stopped holding. The two are no
  longer one bucket: `CLAUDE.md` is prose a reader trusts, `.claude/**` is configuration an agent
  cannot touch.
- **Vendored or generated files** — no longer empty as of 2026-09-17: card #239's chantier added
  three third-party files, `vendor/claude-agent-sdk/{sdk.mjs,package.json,LICENSE.md}`, copied in
  from `npm install @anthropic-ai/claude-agent-sdk`, never installed inside this repo (see
  `orchestrator/sdk.js`'s header). Excluded here because these three are code this repo did not
  write and make no claim of their own about this pipeline's behavior. (`sdk.mjs` is minified but
  not degenerate — measured: 225 lines, 14 comment lines, 150 of the 225 under 200 characters; an
  earlier draft of this entry mischaracterized it as "one minified line," corrected here. That
  earlier draft is also the reason this bucket is worded the way it now is: see the next
  paragraph.) `vendor/claude-agent-sdk/README.md`, by contrast, is **not** in this exclusion — it
  is prose this repo wrote (byte count, md5, version pair, update ritual) and is in scope for
  `doc/remediation-plan-2026-08.md`'s execution rule 6, which names `vendor/**/README.md`
  explicitly as of the same date.

  **Measured, by planting a symptom, that the three excluded files do not enter any sweep's**
  **corpus** — not merely by re-running the suite unmodified and noting the failure count held,
  which the first draft of this entry did and which a same-day, same-suite regression could
  satisfy by accident without proving absence of anything. The actual check: a synthetic offender
  file — one `action 99.9a` banner id documented nowhere, one possessive symbol citation to a
  file named `zz-nonexistent-file.js` (which does not exist), and one bare `gh api ... -f` call
  with no `--method`/`-X` — was planted as `vendor/claude-agent-sdk/zz-probe.js` and the file
  removed afterward (never committed). Command: `node --test test/gh-api-argv.test.js
  test/doc-constant-sweep.test.js test/park-reason-doc-sweep.test.js test/gate-scope.test.js
  test/test-comment-citation-sweep.test.js`. Result with the file under `vendor/`: 129 tests,
  127 pass, 2 fail — identical to the same command with no probe file present at all (the same
  two pre-existing citation-anchor failures this register's own header does not track). The
  IDENTICAL file content, planted instead at `orchestrator/zz-probe.js` (which every scanner
  here dynamically walks via `fs.readdirSync`, not a fixed list): 129 tests, 124 pass, **5**
  fail — the same 2 pre-existing plus 3 new, named failures: `doc-constant-sweep.test.js`'s
  `"<file>.js's <CodeShapedIdent>"` symbol-citation check, its `"action N.Na"` banner check, and
  `gh-api-argv.test.js`'s `-f`/`--method` check. Same bytes, same filename pattern (`zz-probe.js`),
  different directory, 0 vs. 3 new failures — that is what "does not enter the corpus" means here,
  demonstrated rather than inferred from an unmodified tree's failure count.

  Still no `node_modules/`, no build output, and no other generated file checked into this repo
  (verified: `ls node_modules` fails, no `dist/`/`build/` directory exists) — this bucket's other
  members remain absent; only the three vendored files above populate it. If a future addition
  changes that, name it here too.
- **Blank lines and executable code lines inside `orchestrator/**/*.js`, `bin/spo`,
  `console/**/*.js`, `scripts/**`** — only comment lines in these files carry documentation
  claims; a code line's truthfulness is what the test suite already checks, not what this
  register is for. (Markdown files, by contrast, are counted in full — a `.md` file's blank
  lines and table syntax are still part of what a reader reads as the claim.)
- **`worktrees/`** — confirmed empty of tracked content (`git ls-files worktrees/` returns
  nothing) and listed in `.gitignore`; it holds product checkouts (SPO-WebClient worktrees)
  created and destroyed by the WORKTREE step, never product/process documentation for this repo.
- **`.recette`** — listed in `.gitignore`, and does not exist on disk in this tree at all
  (`ls .recette` fails); untracked runtime state, not documentation.
- **`.gitignore`** (repo root) — a git configuration file; it carries no claim about system
  behaviour for a reader to trust or distrust, so it is not documentation in the sense this
  register partitions.
- **`.gitattributes`** (repo root) — added 2026-09-17 (card #239 A1's fix pass, F12: `vendor/**
  -diff linguist-vendored`, so `git diff`/GitHub's language stats don't treat the vendored SDK as
  this repo's own code). Same reason as `.gitignore` immediately above: a git configuration file,
  not a claim about system behaviour.

**Top-level directory/file check (every entry in the repo root, verified against this tree):**
`.claude` (excluded, harness-governed, above), `.github` (in scope since 2026-09-05 —
`gate.yml`'s comment lines; **it was missing from this check entirely until then**), `accounts`
(in scope, added 2026-09-02), `bin` (in scope, `bin/spo`), `console` (in scope), `doc` (in scope),
`orchestrator` (in scope), `prompts` (in scope), `scripts` (in scope, added 2026-09-02), `test`
(excluded, above), `vendor` (**split, added 2026-09-17** — `vendor/claude-agent-sdk/{sdk.mjs,
package.json,LICENSE.md}` excluded, the "Vendored or generated files" bucket above, which this
entry newly populates; `vendor/claude-agent-sdk/README.md` is in scope, same bucket's second
paragraph), `worktrees` (excluded, untracked, above),
`CLAUDE.md` (**in scope since 2026-09-05**, above), `README.md` (in scope), `.gitignore`
(excluded, above), `.gitattributes` (**excluded, added 2026-09-17**, above), `.recette` (excluded,
untracked and absent from disk, above). Every top-level
entry is now placed in exactly one bucket, with a reason — a sentence this section already made
once, on 2026-09-02, while omitting `.github`, so read it as the current claim and not as a
guarantee that it is checked by anything. Derived with `git ls-files | awk -F/ '{if(NF==1) print
$0; else print $1}' | sort -u`, which is the check that was missing.

## 2 · Measurement commands (reproducible)

```
# Markdown files — full line count, every line is "documentation"
wc -l doc/*.md
wc -l prompts/*.md
wc -l orchestrator/README.md
wc -l README.md

# Code comment lines — a line counts if, after trimming, it opens with `//`, or it lies
# inside/opens/closes a `/* ... */` block (including `/**`). Blank lines and lines that are
# any part code are excluded. Heuristic, not a parser: it does not tokenize strings, so a
# `//` or `/*` inside a string literal would misread.
node count-comments.js $(find orchestrator -name "*.js" | sort) bin/spo \
  $(find console -name "*.js" | sort) scripts/smoke-llm.js scripts/usage-report.js

# scripts/*.sh, scripts/git-hooks/post-merge and accounts/*.yml are not JS —
# count-comments.js's `//`/`/*` heuristic does not apply. Shell and YAML comment lines are
# `#`-prefixed; counted with a trimmed-line-startswith-`#` grep instead (this also counts a
# shebang line as a comment, which is correct — it is not executable documentation but it is
# a `#`-prefixed line, same convention as every other comment in the file):
grep -cE '^[[:space:]]*#' scripts/daemon-install.sh scripts/dashboard-install.sh \
  scripts/park-alert.sh scripts/git-hooks/post-merge accounts/spo-test-accounts.yml
```

**Correction to the false-positive claim (was: "spot-checked against every file below, zero
false positives found in this corpus").** That claim was itself untested prose, not a
measurement, and it was false. The Opus verifier tested the heuristic with a sound oracle —
replace each comment-opener line with an illegal token and compile the result with
`vm.Script`: a real JS comment becomes code and throws a `SyntaxError`; a line that only *looks*
like a comment while sitting inside a string literal still compiles cleanly. That method found
**3 false-positive regions, 8 lines, all in `console/render.js`**, confirmed by the driver:
lines 161-163, 192-194 and 314-315 are CSS block comments (`/* ... */`) written as plain text
*inside* a JS template-literal `<style>` block (`const CSS = \`...\`` opens at line 127 and does
not close before line 320) — real CSS prose, not a real JS comment, but the heuristic cannot
tell the difference because it does not tokenize strings, exactly the limitation the original
sentence claimed (falsely) to have found zero instances of. `console/render.js`'s comment count
is corrected from 157 to 149 (8 fewer), and `console/**/*.js`'s total from 541 to 533 — see §3d.

**A second, declared limitation, honestly recorded.** Trailing comments (`code(); // note`) are
never counted — only a line whose *entire* trimmed content is a comment is. This is declared
behaviour, not a defect, and was already implicit in the heuristic's definition above ("a line
counts if... it opens with `//`"), but it was never *quantified*. Approximate count, run against
this register's own corpus (a line is "not a bare comment" is code and also contains `//` or
`/*` outside an already-open block, excluding occurrences of `://` to avoid flagging URL
literals — an approximation, not a parser, so treat this as a lower bound):

```
node trailing-comment-count.js $(find orchestrator -name "*.js" | sort) bin/spo \
  $(find console -name "*.js" | sort)
# → 143 lines carry a trailing comment not counted anywhere in §3
```

This independently corroborates the Opus verifier's own measurement of "~140 such lines" by a
different method. It means the accepted gap in bucket 3d is **understated** by roughly this many
documentation-bearing fragments — lines with a real prose claim attached to executable code that
this register's line counts do not represent at all, in either direction (they are not "missing"
from any bucket, since the whole line is already counted as a code line in `codeLines`, but the
claim riding on it is invisible to every count in this document).

`count-comments.js` (44 lines, reproduced in full so the method is checkable without a
separate file):

```js
#!/usr/bin/env node
const fs = require('fs');
function countFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n');
  let total = lines.length;
  if (lines.length > 0 && lines[lines.length - 1] === '') total = lines.length - 1;
  let commentLines = 0, inBlock = false;
  for (let i = 0; i < total; i++) {
    const trimmed = lines[i].trim();
    if (inBlock) { commentLines++; if (trimmed.includes('*/')) inBlock = false; continue; }
    if (trimmed === '') continue;
    if (trimmed.startsWith('//')) { commentLines++; continue; }
    if (trimmed.startsWith('/*')) { commentLines++; if (!trimmed.includes('*/')) inBlock = true; continue; }
  }
  let blankLines = 0;
  for (let i = 0; i < total; i++) if (lines[i].trim() === '') blankLines++;
  return { total, commentLines, blankLines, codeLines: total - commentLines - blankLines };
}
const files = process.argv.slice(2);
let gT=0,gC=0,gB=0,gK=0;
for (const f of files) {
  const r = countFile(f);
  console.log(`${r.total}\t${r.commentLines}\t${r.blankLines}\t${r.codeLines}\t${f}`);
  gT+=r.total; gC+=r.commentLines; gB+=r.blankLines; gK+=r.codeLines;
}
console.log(`${gT}\t${gC}\t${gB}\t${gK}\tTOTAL`);
```

`trailing-comment-count.js` (approximates the count of trailing, non-bare comments the heuristic
above never counts — reproduced in full for the same reason):

```js
#!/usr/bin/env node
const fs = require('fs');
function countFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n');
  let total = lines.length;
  if (lines.length > 0 && lines[lines.length - 1] === '') total = lines.length - 1;
  let inBlock = false, trailing = 0;
  for (let i = 0; i < total; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (inBlock) { if (trimmed.includes('*/')) inBlock = false; continue; }
    if (trimmed === '') continue;
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlock = true; continue; }
    const noUrls = raw.replace(/:\/\//g, '');
    if (noUrls.includes('//') || noUrls.includes('/*')) trailing++;
  }
  return trailing;
}
const files = process.argv.slice(2);
let g = 0;
for (const f of files) {
  const n = countFile(f);
  if (n > 0) console.log(`${n}\t${f}`);
  g += n;
}
console.log(`${g}\tTOTAL`);
```

Run 2026-09-02 against `bb3594225b5ac087c0952c469f38a5f2d0a0951a` (re-pinned; see below):

```
24229  9858  1701  12670  TOTAL   (orchestrator/**/*.js + bin/spo + console/**/*.js +
                                   scripts/smoke-llm.js + scripts/usage-report.js:
                                   total / comment / blank / code lines, raw heuristic
                                   output — see the false-positive correction above for
                                   console/render.js's 8-line adjustment, applied in §3d)

# scripts/*.sh + scripts/git-hooks/post-merge + accounts/*.yml (# comment lines, grep method):
53  scripts/daemon-install.sh
21  scripts/dashboard-install.sh
38  scripts/park-alert.sh
 8  scripts/git-hooks/post-merge
 7  accounts/spo-test-accounts.yml
```

## 3 · The partition

**Bucket definitions.** A bucket is assigned per *file*, not per fragment, because sweeps
(7bis.1, 7bis.2, and 7bis.3, all landed at this pin) check specific named facts inside a file's text —
a park-reason literal, a documented constant, a `file:line` citation — never the file's prose
at large. Putting a whole file in "Enforced" when only a handful of facts inside it are
actually checked would be exactly the overclaim this register exists to prevent. See §3d for
what those sweeps do cover, honestly scoped as fact-classes rather than line-ranges.

### 3a · Exhaustively read (7bis.4) — 8 files, 1,146 lines

| File | Lines |
|---|---|
| `prompts/diagnose.md` | 93 |
| `prompts/draft-card.md` | 82 |
| `prompts/implement.md` | 122 |
| `prompts/plan.md` | 149 |
| `prompts/review-card.md` | 192 |
| `prompts/triage-bug-report.md` | 200 |
| `prompts/validate-change.md` | 126 |
| `prompts/verify-citations.md` | 182 |
| **Subtotal** | **1,146** |

Read line by line against `step-contracts.js`, `prompt-template.js`, `task-values.js` and the
state-machine branch reading each verdict, per 7bis.4. `prompts/README.md` is **not** in this
bucket — it is a derived table, not a step's own instructions; see 3c/3d.

### 3b · Classified-historical (running logs) — 3 files, 2,554 lines

| File | Lines |
|---|---|
| `doc/remediation-progress.md` | 1,872 |
| `doc/improvisation-analysis.md` | 239 |
| `doc/remediation-plan-2026-08.md` | 443 |
| **Subtotal** | **2,554** |

(Re-measured against `bb35942`; all three grew since the register's prior `c9b8d458` pin —
`remediation-progress.md` +2, `improvisation-analysis.md` +2, `remediation-plan-2026-08.md` +18
— ordinary log growth in the days between the two pins, not a defect.)

These three gain the one-line status header this action adds (§5). The classification is
what "retires" them: each becomes a *correctly-scoped historical claim* — true as of its own
entry's date — rather than an *un-audited claim* pretending to be current. See §6 for the
found cases where a document's own prose is **not** actually dated, which the header does not
legitimately cover.

### 3c · Enforced by construction (full-file) — 0 files, 0 lines

**None, honestly.** No file in this corpus has its *entire* substantive content mechanically
checked. The three sweeps (7bis.1 park-reason, 7bis.2 prompt-contract, 7bis.3 documented-constant)
each check a bounded set of *facts* embedded in a file's prose — not the prose itself. Even
the file that comes closest, `prompts/README.md`, is mostly narrative (~94 of its 104 lines)
around a ~10-line table that 7bis.2's sweep checks against `step-contracts.js`; the narrative
is not verified by anything. Rather than force a partial-coverage file into this bucket and
overclaim it, every such file is counted below in 3d (accepted gap), with the specific
fact-classes a sweep protects named as an annotation, not as a line-count.

### 3d · Accepted gap, handed to chantier 9 — 65 files, 14,368 lines

**Markdown (docs), full line count — 11 files, 4,391 lines:**

| File | Lines | Note |
|---|---|---|
| `doc/state-machine-spec.md` | 565 | Park-reason vocabulary (7bis.1, green today) and documented constants/citations (7bis.3, green today) inside this file are fact-checked; its prose at large is not — see 3c. Grew from 535 to 565 (four new documented park reasons) between this register's prior `c9b8d458` pin and the current `bb35942` pin. |
| `doc/board-audit.md` | 218 | |
| `doc/permissions.md` | 209 | |
| `doc/setup.md` | 73 | |
| `doc/environments.md` | 71 | |
| `doc/jewels-inventory.md` | 38 | |
| `doc/bench-audit-2026-09-02.md` | 408 | 8.1's deliverable, explicitly self-described as "Fable's and unverified" except one Opus-checked finding (`doc/remediation-progress.md`, "What C7 hands the next session"). |
| `doc/bench-plan-derived-2026-09-02.md` | 165 | Same provenance as above. |
| `orchestrator/README.md` | 2,451 | Documented constants inside this file are 7bis.3's fact-check target; its narrative is not. |
| `prompts/README.md` | 104 | Its ~10-line table is 7bis.2's target — that sweep has since landed (`test/prompt-contract-sweep.test.js`) — the narrative around the table is still not covered by anything. |
| `README.md` (root) | 89 | |
| **Subtotal** | **4,391** | 565+218+209+73+71+38+408+165+2,451+104+89 = 4,391 |

Grouped the same total two ways, so it is checkable without re-adding eleven rows:
`doc/*.md` remainder (8 files, excluding the 3 in 3b) = **1,747**; `orchestrator/README.md`
= **2,451**; `prompts/README.md` = **104**; `README.md` root = **89**. 1,747 + 2,451 + 104 +
89 = **4,391**.

**Code comments — 54 files, 9,977 lines:**

| Location | Files | Comment lines |
|---|---|---|
| `orchestrator/**/*.js` | 39 | 8,577 |
| `bin/spo` | 1 | 683 |
| `console/**/*.js` | 7 | 533 |
| `scripts/*.js` | 2 | 57 |
| `scripts/*.sh` + `scripts/git-hooks/post-merge` | 4 | 120 |
| `accounts/*.yml` | 1 | 7 |
| **Subtotal** | **54** | **9,977** |

`console/**/*.js`'s 541 → 533 and `scripts`/`accounts`'s new 184 lines are both corrections to
the prior version of this register — see the false-positive fix and the new-surface fix above
and in §1. Net change from the prior `9,801`: −8 (console false positives) + 184 (new surface)
= **+176**, landing on 9,977.

Per-file breakdown, `orchestrator/**/*.js` (comment / total lines), the plan's own "overwhelmingly
`orchestrator/` comments" remainder, named per file as required:

| File | Comment lines | Total lines |
|---|---|---|
| `orchestrator/recette.js` | 848 | 2,087 |
| `orchestrator/state-machine.js` | 875 | 1,852 |
| `orchestrator/steps/scripted.js` | 812 | 2,015 |
| `orchestrator/park-loop.js` | 515 | 1,200 |
| `orchestrator/dispatcher.js` | 482 | 844 |
| `orchestrator/intake.js` | 441 | 1,231 |
| `orchestrator/auto-triage.js` | 437 | 1,132 |
| `orchestrator/accounts.js` | 385 | 747 |
| `orchestrator/steps/llm.js` | 305 | 841 |
| `orchestrator/daemon.js` | 301 | 660 |
| `orchestrator/config.js` | 660 | 876 |
| `orchestrator/lock.js` | 180 | 365 |
| `orchestrator/account-lease.js` | 166 | 272 |
| `orchestrator/journal.js` | 165 | 266 |
| `orchestrator/orphan-scan.js` | 145 | 283 |
| `orchestrator/auto-pull.js` | 145 | 249 |
| `orchestrator/step-contracts.js` | 138 | 263 |
| `orchestrator/task-summary.js` | 131 | 233 |
| `orchestrator/board.js` | 121 | 196 |
| `orchestrator/tokens.js` | 136 | 366 |
| `orchestrator/invariants.js` | 113 | 311 |
| `orchestrator/report-intake.js` | 102 | 457 |
| `orchestrator/product-repo-hold.js` | 103 | 153 |
| `orchestrator/product-repo-lock.js` | 103 | 179 |
| `orchestrator/task-values.js` | 95 | 279 |
| `orchestrator/comment-scan.js` | 160 | 383 |
| `orchestrator/worker-status.js` | 79 | 144 |
| `orchestrator/ci-cause-table.js` | 53 | 67 |
| `orchestrator/remote-report-pull.js` | 55 | 282 |
| `orchestrator/command-timeout.js` | 62 | 107 |
| `orchestrator/park-alert.js` | 33 | 71 |
| `orchestrator/prompt-template.js` | 36 | 116 |
| `orchestrator/http.js` | 39 | 112 |
| `orchestrator/monotonic-clock.js` | 28 | 34 |
| `orchestrator/main-moved-budget.js` | 17 | 24 |
| `orchestrator/fixture.js` | 17 | 42 |
| `orchestrator/deadline.js` | 14 | 71 |
| `orchestrator/park-signal.js` | 10 | 30 |
| `orchestrator/bench-queue-wait.js` | 70 | 86 |
| **Subtotal (39 files)** | **8,577** | **18,926** |

`bin/spo` — 683 comment lines / 1,899 total. `console/**/*.js` — `console/collect.js` 208/856,
`console/render.js` **149**/1,148 (corrected from 157 — 8 lines were CSS block comments inside
a JS template-literal `<style>` block, not real JS comments; see the false-positive fix above),
`console/usage-scan.js` 95/495, `console/serve.js` 26/169, `console/usage-rollups.js` 25/81,
`console/prod-version.js` 18/163, `console/system.js` 12/102 (subtotal **533**/3,014).

`scripts/*.js` — `scripts/smoke-llm.js` 15/79, `scripts/usage-report.js` 42/311 (subtotal
57/390). `scripts/*.sh` + `scripts/git-hooks/post-merge` (`#`-prefixed comment lines, shebang
included, per §2's grep method) — `scripts/daemon-install.sh` 53/105, `scripts/dashboard-install.sh`
21/74, `scripts/park-alert.sh` 38/79, `scripts/git-hooks/post-merge` 8/17 (subtotal 120/275).
`accounts/*.yml` — `accounts/spo-test-accounts.yml` 7/57 (same `#`-prefixed method).

**Bucket 3d total: 1,747 + 104 + 2,451 + 89 + 8,577 + 683 + 533 + 57 + 120 + 7 = 14,368 lines,
65 files.**

## 4 · Reconciliation with the plan's prior figures

| Figure | Plan's estimate | This register's measurement | Delta |
|---|---|---|---|
| Total corpus | ~16,800 | **18,068** (Bucket 3a + 3b + 3d = 1,146 + 2,554 + 14,368) | +1,268 (+7.5%) |
| Retired (classified-historical) | ~2,290 | **2,554** (Bucket 3b) | +264 (+11.5%) |

**These measurements win; the plan's ~16,800 and ~2,290 are superseded by the numbers above** —
and so is this register's own prior measurement of 17,750/2,442. The new total corpus, 17,978,
is +228 over the prior register's 17,750, all of it accounted for: +22 in Bucket 3b (re-pinning
from `c9b8d458` to `bb35942` picks up ordinary log growth — `remediation-progress.md` +2,
`improvisation-analysis.md` +2, `remediation-plan-2026-08.md` +18) and +206 in Bucket 3d
(+184 new `scripts`/`accounts` comment lines, Defect 2, plus +30 from `doc/state-machine-spec.md`
growing between the two pins, minus 8 corrected `console/render.js` false-positive lines,
Defect 3). None of this delta is estimate-vs-measurement slack against the plan; it is this
register catching up to its own corpus and its own method.
A plausible, partial explanation for the total-corpus gap against the plan's estimate (not
asserted as the full account, since the plan's own figure carries no measurement command to
audit against): `doc/bench-audit-2026-09-02.md` and `doc/bench-plan-derived-2026-09-02.md`
(573 lines together) are 8.1's deliverables, produced the same day chantier 7bis was scoped,
"in parallel with C7 bis" per `doc/remediation-progress.md`'s "What C7 hands the next session"
section — if the ~16,800 figure predates them, that alone accounts for roughly 49% of the
delta. The remainder is consistent with ordinary estimate-vs-measurement slack plus the
`scripts`/`accounts` correction above; this register does not need to resolve which prior
artifact produced ~16,800, only to supersede it with a reproducible number.

**Where `~16,800` and `~2,290` actually appear — see §7 for the corrected sibling-grep result.**
The prior version of this section, and of §7, claimed both figures appear exactly once each,
in the same 7bis.5 row of `doc/remediation-plan-2026-08.md`. That is true for `~2,290` but false
for `~16,800`, which also appears at `doc/remediation-plan-2026-08.md:273`, in the "Chantier 7
bis — What Gate C7 certifies" preamble, stated in the present tense as a live premise. §7 now
reports the real grep output.

## 5 · The three status headers

Added to the top of each file, immediately after its title, before any claim:

> **Status: a dated record.** True as of its entry's date; never re-verified against present code.

Placed identically (wording and position: first line of body content, before the file's own
first paragraph) in:

- `doc/remediation-progress.md`
- `doc/improvisation-analysis.md`
- `doc/remediation-plan-2026-08.md`

This is the exact declaration `doc/remediation-plan-2026-08.md` already makes of itself in
its 7bis.5 row and, narrower, in its 7bis.3 row ("This document is excluded by name; it
declares its own line numbers historical") and its execution rules ("Line numbers in this
plan date from the audit") — the header makes explicit and uniform what was previously
implicit and file-specific.

## 6 · Present-tense claims the header does not cover

The header classifies an *entry* as historical because it is understood to be dated by the
log convention (a chantier section, a "measured 2026-09-02" note, a sample window). It does
**not** retroactively make a claim true, and it does not cover a claim that is not actually
anchored to a date. Two found cases, not fixed (out of this row's scope):

1. **`doc/improvisation-analysis.md` carries no explicit authorship date anywhere in the
   file.** Its title and opening paragraph describe method and scope but never state when the
   document itself was written; the only date signal is the *sample window* it measures
   ("16 sessions ... spanning 2026-08-26 → 2026-08-29"), which is the data's date, not the
   document's. Line 208 states, in the present tense: *"Classification is against the file
   [`.claude/commands/next-task.md`] as it stands today"* — "today" has no fixed referent in
   this file. The new header supplies "a dated record" but cannot supply *which* date; a
   reader cannot tell whether "today" means 2026-08-29 (end of the sample window) or the
   unknown day the analysis was actually written.
2. **`doc/remediation-progress.md`'s most recent section, "What C7 hands the next session,"
   contains operational-state claims with no date in the subheading itself** — e.g. "The
   daemon is **stopped**," "17 commits on `f7cf9da`. ... **Not yet merged.**" Earlier chantier
   sections in the same file carry their date in the heading text itself (e.g. "Gate C6 — two
   of three parts green, measured 2026-09-02"); this section does not, relying on its position
   at the end of the file and nearby "2026-09-02" mentions in sibling paragraphs for context.
   These are exactly the kind of claim — the daemon's running state, a commit count on a named
   base — that is stale within hours, so the reader benefit of an explicit date on this
   specific subheading is higher than average, not lower.

**Two more, found by re-measuring within that same section rather than trusting the two cases
above as exhaustive** (§6 previously under-enumerated its own named section):

**Cases 3 and 4 below were closed after this register named them.** The driver rewrote that
section at the end of the chantier, dating it in its own heading (*"written 2026-09-02, at commit
`3d7a0b7`"*) and correcting both. They are kept here, not deleted, because the register's job is
to record what the classification did and did not cover — and because the *class* is still open:
nothing prevents the next such section from being written undated again. The remedy that worked
was putting the commit in the heading, which is worth repeating rather than rediscovering.

3. **"Suite 1529 passing, 0 failing, 0 cancelled"** (the section's opening line) was already
   stale: at this register's own `bb35942` pin, `node --test --test-timeout=30000 test/*.test.js`
   reports **1553 pass, 0 fail, 0 cancelled** — the suite grew by 24 tests between the commit
   that sentence describes and this one. It carries no date of its own, only "the branch's HEAD
   at time of writing," which drifts with every commit; this is the same failure mode as case 2,
   inside the same section.
4. **The three-row table immediately below it is flatly wrong today.** It reads "**7bis.2**
   prompt-contract sweep — not started," "**7bis.5** accepted-gap register — not started," and
   "**7bis.6** execution rule — not started." All three are done at `bb35942`:
   `test/prompt-contract-sweep.test.js` exists and is part of the green 1553-test suite;
   `doc/accepted-gaps.md` (this file) exists and is 7bis.5 itself; and 7bis.6's sibling-grep is
   both stated as "execution rule 6" in `doc/remediation-plan-2026-08.md`'s execution rules and
   applied in §7 below. A reader trusting this table today would believe three actions are
   outstanding that have, in fact, already landed.

Not fixed here, same as cases 1 and 2 — **`doc/remediation-progress.md` is not edited by this
action.** The driver rewrites that handoff section at the end of the chantier; §6's job is to
register what is wrong with it today, not to close it.

## 7 · Sibling-grep result (7bis.6)

This action corrects two figures the plan previously stated as fact: the total-corpus line
count (~16,800) and the retired-lines count (~2,290). Per 7bis.6, both the corrected and the
pre-correction phrasing were grepped across `doc/`, `prompts/`, `orchestrator/`, `bin/spo`,
`console/` and `README.md` before this register was considered done. Real output, run against
`bb35942` (this is the corrected version of this section — the prior version claimed a clean,
single-occurrence result for both figures, and that claim was false for `~16,800`; see below):

```
$ grep -rn "16,800\|16800" doc/ prompts/ orchestrator/ bin/spo console/ README.md \
    | grep -v "^doc/accepted-gaps.md"
doc/remediation-plan-2026-08.md:273:Yield was tracking newly-opened surface, not residual defects, and the surface is ~16,800 lines

$ grep -rn "2,290\|2290" doc/ prompts/ orchestrator/ bin/spo console/ README.md \
    | grep -v "^doc/accepted-gaps.md"
doc/remediation-plan-2026-08.md:299:| 7bis.5 | **The accepted-gap register**, and the classification that retires ~2,290 lines without reading them. [...] |
```

(This register's own occurrences of both figures — referring to and superseding them across §0,
§4 and this section — are filtered out above; this file is excluded from its own corpus per §1,
and counting them would only restate that this document discusses the two numbers, which is
already obvious. The ungrepped, raw command is the one in the codeblock heading above and finds
those self-references too — run it without the `grep -v` if you want to see them.)

**Corrected result.** Excluding this register's own self-referential prose (out of its own
corpus, §1), `~2,290` genuinely appears exactly once in that scope — in `doc/remediation-plan-2026-08.md`'s
7bis.5 row, line 285, as the prior version of this section claimed. **`~16,800` does not:** it
appears at `doc/remediation-plan-2026-08.md:273`, inside the "Chantier 7 bis — What Gate C7
certifies" **preamble** — *"the surface is ~16,800 lines against a few thousand per pass"* —
which is a **different sentence, a different paragraph, and a different argument** than the
7bis.5 row 26 lines below it. Line 259 states the figure in the **present tense**, as a live
premise for the claim that follows it ("Three more passes would produce three more piles of the
same size") — a reader landing on line 259 alone, without ever reaching line 285 or this
register, is told a current fact, not a historical estimate. The prior version of this section
(and of §4's parenthetical, "the only place either number appears") asserted both figures
appear exactly once, in the same row — a claim its own quoted grep command, if actually run,
would have contradicted. That is a 7bis.6 violation inside the very document whose job is to
enforce 7bis.6: a claim corrected in the 7bis.5 row (§4 above) and left standing, present-tense,
in its own sibling paragraph 26 lines up — exactly the failure mode 7bis.6 exists to catch, and
the sibling grep that should have caught it was reported clean instead of run truthfully.

This register does not amend `doc/remediation-plan-2026-08.md`'s own text (out of this action's
scope; only a one-line header was added to that file, per §5) — so both line 259 and line 285
remain visible there exactly as before. Line 285 is correctly scoped: it sits inside the
7bis.5 row of a table describing what 7bis.5 *will do*, past tense in effect once this register
exists. **Line 259 is not correctly scoped** — nothing marks it as superseded, and its present
tense actively misleads a reader who has not also read this register. This register's job is to
report that accurately, not to rewrite the plan: a reader of `doc/remediation-plan-2026-08.md`
alone should be warned that line 259's `~16,800` is a superseded premise, not a live fact — this
paragraph is that warning.

## 8 · Two further found gaps (adversarial review, 2026-09-02)

Found while fixing the two sweeps' own survived mutations; neither is closed here, only named.

1. **The citation ratchet (`test/doc-constant-sweep.test.js` part 2) is existence-only.** It
   checks that a cited `file:line` exists and that the file has at least that many lines — it
   does not check that the cited line is actually the one the surrounding prose describes. A
   citation repointed to the *wrong* line inside a file that still happens to be long enough
   passes silently. Not fixable without a much larger mechanism (parsing what each citation
   claims to be true of the line it names); registered instead of attempted.
2. **`prompts/` is outside 7bis.3's constant-pinning scope.** `prompts/diagnose.md` states
   `config.diagnoseBudget = three attempts` in prose — a documented constant, unpinned, one
   directory away from the sweep that would otherwise catch its drift. 7bis.3's own two docs
   (`doc/state-machine-spec.md`, `orchestrator/README.md`) do not include it, and no other
   mechanism does either.

## 9 · A citation class the sweep structurally cannot pin (card #119 lot 1, 2026-09-08)

`console/plain-language.js` cites `test/dashboard-deck.test.js` three times — at its header, at
`PARK_REASONS`, and at `SELF_RETRYING` — naming the guards that enforce each table's completeness.
Those citations were previously pointing at `test/plain-language.test.js`, **a file that does not
exist**, and had rotted unnoticed for as long as they shipped.

They can rot again, and nothing will catch it, for two independent structural reasons:

1. `console/plain-language.js` is not in `test/doc-constant-sweep.test.js`'s `CORPUS_FILES`, so no
   citation in it is checked at all.
2. Even if it were, that sweep deliberately skips citation targets under `test/` — so a citation
   *to* a test file is outside its remit by design.

The three citations are therefore accurate today, verified by hand (each named property was
confirmed genuinely enforced in `test/dashboard-deck.test.js` before the citation was redirected),
and unprotected tomorrow: renaming that test file, or moving one of the three guards out of it,
leaves three false citations and a green suite.

Registered rather than fixed. Closing it means either adding `console/` files to `CORPUS_FILES` —
which pulls a large surface into a pin set sized for `doc/` prose — or teaching the sweep to
resolve test-file targets, which is the same "parse what the citation claims" mechanism §8.1
already registered as too large to attempt. The cheap mitigation is the one taken: the citations
name a file, not a `file:line`, so only a rename or a move breaks them, not an ordinary edit.

## 10 · Known limits of the `test/` comment-citation sweep (card #190; rewritten for the
registry-free redesign, chantier "citation-pins migration" action 2, 2026-09-14)

`test/test-comment-citation-sweep.test.js` guards `file:line` citations inside `test/*.js` and
`test/fixtures/**/*.js` comments. Card #190's original design (action 11.3) mirrored
`doc-constant-sweep.test.js`'s pinned-anchor check exactly: a hand-maintained registry of 219
exact-text pins plus 67 allowlist entries, each pin storing the literal cited text and a `claim`
proven to sit within ±3 lines of the citation, with three separately hand-bumped exact counts. An
Opus research review (2026-09-14, maintainer-approved) judged that machinery disproportionate for
the lowest-stakes citation class in the repo — a stale `file:line` in a `test/` comment costs a
reader about a minute of confusion, nothing like the safety-critical citations elsewhere — and
replaced it with a **registry-free** design: no stored pin text, no `claim`, no hand-bumped counts.

What ships is ONE check:

- **EXISTENCE** — does the cited file resolve (this repo, SPO-WebClient, or SPO-Deploy), and are
  the line numbers in bounds? A bounds/resolution check only, the same shape as
  `doc-constant-sweep.test.js`'s own part 2.

It falls back to a 30-entry `CITATION_ALLOWLIST` (`{ category, reason }`, no `#<occurrence>`
suffix) for citations that cannot resolve for a structural reason. This is a strictly WEAKER
guarantee than the retired registry, and the limits below are the accepted cost of that trade,
stated plainly rather than left implicit.

1. **No exact-text verification at all, by design.** The retired registry compared the cited
   line(s)' literal text byte-for-byte; this design never reads the cited text. Concretely: **a
   citation whose line number drifts to any other in-bounds line is silently accepted.** A stale
   `foo.js:100` that should now read `foo.js:117` passes, because line 117 exists. Only two shapes
   of rot are caught: a citation into a file that was deleted, renamed, or moved, and a line number
   that has run off the end of a file that shrank. The retired registry caught ordinary drift; this
   design structurally cannot, and was not built to.
2. **An ANCHOR check was built, measured, and deliberately NOT shipped.** The redesign's brief also
   asked for a second, looser check: take the nearest identifier-shaped token in the prose before a
   citation and require it to appear somewhere in the cited range. It was implemented and run
   against the real corpus before any allowlist entry was written, and the measurement is the
   reason it was cut rather than tuned:
   - Taken literally (candidate filtered only by `CLAIM_STOPWORDS`) it produced 224 offenders out
     of 286 citations. `test/*.js` comments are free-form narrative prose, so "the nearest word
     before the citation" is overwhelmingly an ordinary English or capitalised-emphasis word
     (`HEAD`, `SAME`, `README`), not an identifier.
   - Adding a code-shape filter (candidate must contain an underscore, a camelCase transition, or a
     letter/digit adjacency) cut that to 69 offenders, but raised `unanchorable` — no candidate at
     all, so no verification performed — from 48 to 161 of the 247 citations that reached the check.
     Roughly two thirds of the corpus would have passed on trust either way.
   - Of the 86 citations it actually fired on, **69 failed and 17 passed**. All 69 were then read
     by hand against the real target file: every one was a correct citation whose nearest
     code-shaped token names the ENCLOSING function or declaration, mentioned once in the
     surrounding sentence rather than repeated on the cited line. **Zero genuine drifts.** A gate
     with a 69-to-0 false-positive-to-true-positive ratio does not find drift; it trains its readers
     to allowlist, which is how a real drift would eventually be waved through.
   - The price of shipping it was 60 hand-written allowlist entries on top of the 30 EXISTENCE
     needs — 90 in total, larger than the 67-entry allowlist of the very registry this migration
     exists to retire. That is the same maintenance tax relocated, not removed.
   - The one principled narrowing available (fire only when the candidate appears elsewhere in the
     cited file, so it is a plausible anchor rather than prose noise) was measured too: 69 firings
     fall to 32, and all 32 remain false positives, for the same structural reason. Fixing it
     properly needs a "declaration nearby" concept — precisely `doc-constant-sweep.test.js` part
     2.5's tuned candidate-ranking machinery, deliberately out of scope for this corpus.

   This entry is recorded as an accepted gap rather than a closed question: the anchor idea is a
   reasonable one that this corpus defeats, and the numbers are here so it is not re-proposed from
   scratch.
3. **The 30 allowlist entries are structural, not judgement calls.** Each is a fabricated path
   planted as a test fixture (`foo.js`, `alpha.js`, `beta.js`, `gamma.js`,
   `relative/path/to/file.ts`), a product file that was deleted (`sanctuarize.test.ts`), a bare
   basename this repo now has several of (four `README.md`, two `paths.ts` in the product repo), or
   a dated quote of a value already out of bounds when written (`.claude/settings.json:109-127`
   against a 120-line file). None can be fixed by editing the citing comment, and none needs
   periodic re-reading. A duplicate-key test guards the list itself: a JS object literal silently
   keeps only the last of two entries sharing a key, and the registry-free rewrite's first draft
   shipped exactly that defect (91 entries written, 90 effective).
4. **Trailing inline comments are not scanned**, unchanged from the retired design. Extraction
   reuses `blankComments`, whose own contract (`test/blank-comments-sync.test.js`) blanks whole-line
   `//` comments only — a `code(); // file.js:10` trailing comment is left as code and never reaches
   the extractor. Invisible to this sweep exactly as it is invisible to `doc-constant-sweep`'s own
   part 2.
5. **A `/*` inside a string can blank a region**, unchanged from the retired design and guarded by
   this sweep's own `PHANTOM_SPAN_TOLERANCE_LINES` test (action 11.3 found and fixed four live
   instances of this trap; re-measured 2026-09-14, still none longer than the named tolerance).
6. **Chains (`` `:N` `` with no path) are not guarded.** `extractCitations`'s chain resolution
   (`CHAIN_RE`) still runs, but an `unanchored` chain — one that could not attach to a preceding real
   citation within `PROXIMITY_CHARS` — is filtered out before the check, the same posture
   `doc-constant-sweep.test.js` already takes for its own unanchored chains.

None of the six widens a check to look complete while checking less — they are named exclusions and
trade-offs, the same discipline this document already applies to `doc-constant-sweep.test.js`
itself. The registry-free design is a deliberate, reviewed choice to accept a strictly weaker
guarantee for this specific, lowest-stakes citation class in exchange for removing an ongoing,
disproportionate maintenance tax — not an accident of implementation.

## 11 · Card #219 residual gaps (dispatcher-status drain bound), 2026-09-14

Card #219 closed #208's two named residuals (`console/dispatcher-status.js`'s own header,
`orchestrator/README.md`'s `dispatcher-drain-start` row) *where the platform and the record allow*.
What is left open, named rather than silently shipped as if closed:

1. **Non-Linux pid-reuse detection.** `orchestrator/lock.js`'s `processStartUptimeMs(pid)` reads
   `/proc/<pid>/stat` — Linux only. On any other platform it returns `null`, and
   `computeDispatcherStatus` leaves the verdict exactly as it was before this card: a drain still
   inside its own bound whose pid has been reused by an unrelated process reads `'draining'`
   forever. Not measurable here (this action's host is Linux/WSL2); not attempted.
2. **Suspend detection off the measured-Linux case.** The PREFERRED-MONOTONIC path
   (`console/dispatcher-status.js`) trusts `monotonicAtMs`/`monotonicNowMs` only when its
   plausibility check holds — internal consistency only (finite, no reboot, `monotonicNowMs >=
   monotonicAtMs`, monotonic elapsed within `hostUptimeNowMs` elapsed plus a small tolerance), not
   an actual platform check. On a platform where `hrtime` is NOT the system-wide `CLOCK_MONOTONIC`
   (measured true here for Linux/WSL2/Node v22; not measured for macOS, other BSDs, or a container
   runtime with its own clock namespace — though in practice macOS's `mach_absolute_time` and
   Windows' `QueryPerformanceCounter`, libuv's macOS and Windows `uv_hrtime` backends, are ALSO system-wide
   monotonic clocks, not per-process ones, so a genuinely process-relative hrtime origin is closer
   to a hypothetical exotic-runtime case than a common one), the plausibility check catches a
   process-relative hrtime origin ONLY for a SHORT-LIVED reader: a freshly-spawned `spo status`
   process's own `monotonicNowMs` starts near zero, so it violates `monotonicNowMs >=
   monotonicAtMs` against a writer that has been up for any real length of time, and the check
   correctly falls back to the PREFERRED (uptime) path. A LONG-LIVED reader (a dashboard service
   process running continuously, `console/collect.js`'s `collectAll`) does NOT get this same
   protection for free: given enough of its OWN uptime, its `monotonicNowMs` can coincidentally
   grow past an unrelated writer's `monotonicAtMs` even though the two values come from different,
   incomparable per-process origins — the plausibility check cannot distinguish that coincidence
   from a genuine same-clock reading. This is reasoned, not measured on any non-Linux platform or
   against a real long-lived reader — a suspend during a live drain on a platform where hrtime is
   genuinely process-relative remains exactly as open as before this card, for a long-lived reader
   in particular.
3. **Legacy (pre-#208) records.** A `dispatcher-drain-start` with no `hostUptimeAtMs` at all
   (written before card #208) has no `monotonicAtMs` either, so it gets neither the suspend fix nor
   the pid-reuse fix — only the pre-#208 wall-clock bound, unchanged. The 38 real records on disk
   noted in the `dispatcher-drain-start` row all predate #208 and age out as new drains are written
   (same note as before this card); the count was not re-measured for this action.
4. **The reboot check's own blind spot, checked and confirmed real -- corrected 2026-09-14
   (fix pass), see below.** `hostUptimeNowMs < ev.hostUptimeAtMs` is the reboot signal (uptime
   resets to near zero on boot, so "now" reading LESS than the event's own recorded uptime can only
   mean a reboot happened between them). It does NOT fire the other way: if the host reboots and
   then stays up long enough that the NEW boot's own uptime climbs back up to or past the OLD
   `hostUptimeAtMs` value before anyone reads the record, the check reads `hostUptimeNowMs >=
   ev.hostUptimeAtMs` and never learns a reboot happened at all.

   **What actually happens next is NOT the doubly-wrong monotonic read this entry first claimed.**
   Simulated directly: at the exact instant `hostUptimeNowMs` first reaches the old
   `ev.hostUptimeAtMs`, the NEW boot's own `monotonicNowMs` (assuming no suspend in the new boot,
   so its own uptime and monotonic clock track together from a shared near-zero start) has ALSO
   grown to roughly that same value — and if the OLD boot likewise had no suspend before it wrote
   the event, `ev.monotonicAtMs` roughly equals `ev.hostUptimeAtMs` too. So `monotonicNowMs >=
   ev.monotonicAtMs` is satisfied (by definition of the blind spot, NOT violated the way this
   entry's first draft assumed), and the elapsed-vs-elapsed tolerance clause passes trivially (both
   differences are near zero right at the crossing) — the PREFERRED-MONOTONIC path is judged
   plausible and IS taken. Its own bound reads `monotonicNowMs - ev.monotonicAtMs`, which is also
   near zero at that instant, so it reads `'draining'` -- the SAME verdict the (blind) uptime path
   would have produced on its own difference, also near zero. The two paths agree, for the wrong
   reason, at the boundary.

   **The blind spot is therefore temporary, not permanent**, and its own duration is boundable: it
   lasts only while `(hostUptimeNowMs - ev.hostUptimeAtMs) <= ev.timeoutMs + grace` -- once the new
   boot's own uptime has grown PAST the old `hostUptimeAtMs` by more than the bound itself, the
   monotonic elapsed reading (tracking the same growth, absent a new-boot suspend) exceeds
   `timeoutMs + grace` too, and the bound fires `'stopped'`/`diedDraining: true` -- correct in
   OUTCOME (the pre-reboot process is certainly gone) but not labelled `rebooted: true` the way an
   actual reboot detection would, since the reboot check itself never fired. Residual 2's pid-reuse
   probe does not rescue the transient window either: a pid alive during it necessarily started
   AFTER the new boot (a small `processStartUptimeMs` reading), which typically reads as BEFORE
   the old, large `ev.hostUptimeAtMs` -- i.e. NOT flagged as reused, the opposite of what pid-reuse
   detection is for. Reasoned and hand-simulated against the actual comparison logic, not measured
   against a real reboot mid-suite (out of scope, same as residual 1's own suspend). This blind spot
   existed unchanged since card #208 and is not new to card #219; it is recorded here because this
   card's own spec asked to check for it, and corrected here because the first draft of this entry
   misdescribed which path fires and what it reads.

5. **A non-100 clock tick rate.** `orchestrator/lock.js` hardcodes `LINUX_CLK_TCK = 100`, measured
   with `getconf CLK_TCK` on this host; it is 100 on every architecture Node supports. Where
   USER_HZ is larger, starttime reads too high, and `processStartUptimeMs`'s future-guard catches that
   only once the inflated value passes the current uptime. While it still falls between the drain's
   `hostUptimeAtMs` and now (at most `timeoutMs` + grace), a live drainer can read `pidReused`.
   Unreachable at 100; recorded, not closed (verifier simulation, 2026-09-14).

None of these five are faked shut. Where the code cannot tell (`processStartUptimeMs` returning
`null`, the plausibility check failing, no `hostUptimeAtMs`/`monotonicAtMs` on the record, or the
reboot check's own blind spot), the verdict is exactly what it would have been without card #219 --
`'draining'` off liveness alone, or the pre-#208 wall-clock bound -- never a guess dressed up as a
measurement.

## 12 · `--deadline-ms` widened gap (action A2, card #239), 2026-09-17

Action A2 gave PLAN/IMPLEMENT/DIAGNOSE/CITATION_VERIFIER/VALIDATE their own
`config.stepDeadlineMsByState` entry (`deadlineMsForStep(step) + stepDeadlineMs`, clamped to
Node's timer ceiling) so the outer `deadline.js` timer would not retroactively kill a still-healthy
LLM call once card #239's own transport swap (action A5b, landed the same day) made that timer
live in real mode -- which it now is, not merely anticipated -- see
`orchestrator/config.js`'s own `LLM_STEP_DEADLINE_ENTRIES` comment for the full hazard. The
`--deadline-ms` CLI flag (`daemon.js`) only ever overrides the GENERIC `config.stepDeadlineMs`
default, never a state's own `stepDeadlineMsByState` entry, and that flag is not new to this
action — `CI_CHECKS`/`WORKTREE`/`FINISH`/`GATE` already had their own entries the flag could not
reach, before card #239 was ever opened. What IS new is how much of the daemon's dispatch surface
that gap now covers.

**Measured.** `orchestrator/state-machine.js`'s `callWithDeadline(ctx, <state>, ...)` call sites
name 12 distinct states: 7 literal (`CHECK`, `CI_CHECKS`, `FINISH`, `GATE`, `MERGE`, `PUSH_PR`,
`WORKTREE`) plus 5 reached through `callLlmStep`'s own `stepName` variable
(`PLAN`/`IMPLEMENT`/`DIAGNOSE`/`CITATION_VERIFIER`/`VALIDATE`) — `grep -oE
"callWithDeadline\(ctx, '[A-Z_]+'" orchestrator/state-machine.js | sort -u` finds the 7; the other
5 are read off `callLlmStep`'s own five call sites (`PLAN`/`IMPLEMENT`/`DIAGNOSE`/
`CITATION_VERIFIER`/`VALIDATE`, each passed as a literal string argument, not a `callWithDeadline`
literal itself). Before A2, 4 of the 12 carried their own `stepDeadlineMsByState` entry
(`CI_CHECKS`/`WORKTREE`/`FINISH`/`GATE`) — `--deadline-ms` reached the other 8 (the three scripted
states plus all five LLM steps). After A2, 9 of the 12 carry their own entry — `--deadline-ms`
reaches only the remaining 3 (`CHECK`, `PUSH_PR`, `MERGE`).

**Why this is a live gap, not a cosmetic one.** `orchestrator/dispatcher.js`'s `buildWorkerArgv`
(:291) forwards `config.stepDeadlineMs` as `--deadline-ms` to every `--worker` subprocess it
spawns — the real, continuous-mode dispatch path a running daemon actually uses, not only the
`--once`/test-harness invocations this repo's own suite drives directly. A maintainer (or a test)
reaching for `--deadline-ms` to shrink every step's deadline for a live debugging session now
shrinks only 3 of 12 states' worth of ceiling; the other 9 keep their derived, multi-minute
figures regardless of the flag. This gap was found, not designed: card #239's own action A2 had to
retarget two tests (`test/deadline-and-catchall.test.js`'s "step deadline expiry" test and
`test/park-alert.test.js`'s "finalizePark: a shadow-mode park" test) off `IMPLEMENT` and onto
`CHECK` specifically because `--deadline-ms` could no longer reach `IMPLEMENT`'s own new entry —
the test comments at both sites state this verbatim.

**Not fixed here**, per this register's own posture (a named, accepted gap, not a silently-shipped
one): making `--deadline-ms` scale every `stepDeadlineMsByState` entry (proportionally, or as a
hard ceiling) is a design decision about what a maintainer debugging a live daemon actually wants
— scale the derived entries down with it, or leave them alone as "these are load-bearing, minimum
safe values, not defaults" — and is left to chantier 9 or a future action to decide, not assumed
here.

## 13 · `settingSources` default-equivalence gap (action A3, card #239), 2026-09-17

Action A3 (`orchestrator/steps/sdk-call.js`'s `buildQueryOptions`) pins the Agent SDK's
`settingSources` option to `['user', 'project', 'local']` on every call, unconditionally — see
that file's own `SETTING_SOURCES` comment for the full reasoning (`.claude/settings.json` is this
pipeline's entire permission policy and must never depend on a CLI default this repo does not
control). This is a genuinely NEW pin, not a preservation of the OLD transport's behaviour: the
transport as of action A3 (`orchestrator/steps/llm.js`'s `buildArgv`, deleted by action A5b's
cutover the same day — this entry predates that deletion and is left in the past tense on
purpose) never emitted `--setting-sources` at all — no flag, no opts field, nothing fed one. No
test in this repo's suite can catch a wrong choice
here, by construction: every assertion that touches `settingSources` (this action's own
`test/sdk-call-options.test.js`) compares against the SAME pinned constant on both sides of the
equals sign. A test cannot discover what it does not independently know.

**Measured (this action, against the real vendored SDK and a real `claude` 2.1.274 binary).**
Half of the equivalence question is SETTLED: the CLI's internal allowed-source list is
`["userSettings", "projectSettings", "localSettings", "flagSettings", "policySettings"]`, and its
own `--setting-sources` flag only ever narrows the first THREE (its own `--help` enum is exactly
`user`, `project`, `local`) — `flagSettings` (the CLI's real `--settings <file-or-json>` flag,
confirmed against `claude --help` on 2.1.274 — there is no separate `--append-settings`) and
`policySettings` (managed/enterprise policy) are added UNCONDITIONALLY, regardless of what
`--setting-sources` names or omits. So pinning all three of the flag's own options can never cause
a managed or enterprise-policy setting to be silently dropped — that failure mode does not exist
for this flag at all, pinned or not.

**Not settled:** whether OMITTING the flag entirely (today's behaviour) reads the same three
sources as explicitly passing all three (this action's pin), or some different subset. That
depends on the CLI's own launch-time
default for the allowed-sources field, which lives inside a ~230 MB compiled binary this repo does
not build from source. The trace so far: an `allowedSettingSources()` / `replaceAllowedSettingSources()`
accessor pair gates both the hooks loader and the permission-rule loader, and a named constant
literally spelled `["userSettings", "projectSettings", "localSettings"]` appears as what looks like
that accessor's default value — strong circumstantial evidence that the flag-omitted default and
this action's explicit pin already agree — but the accessor's actual INITIALIZER (what it is set to
before any caller ever touches it) could not be pinned by static reading alone; only running a live
session and comparing what it actually loads would settle it, and no such session was run for this
gap.

**Why this is a live gap, not a cosmetic one.** If the flag-omitted default ever turns out to
differ from `['user', 'project', 'local']` (for instance, by ALSO reading some source this pin
excludes, or by reading fewer), every LLM step running under this transport (the SDK's `query()`,
current since action A5b, not merely "new" any more) reads a genuinely different permission
surface than the OLD, now-deleted `claude -p`/`buildArgv` transport's calls did, silently, with no
test positioned to notice because the test and the code share one constant.

**Not fixed here, and not fixable by more static reading** — per this register's own posture, a
named gap rather than a silently-assumed one. **Closes at A10's live recette**: that action already
runs one real card through this transport end-to-end at real cost, which is the cheapest point
in this chantier to also diff `claude --setting-sources=user,project,local`'s actual loaded
settings against a flag-omitted invocation's, on a live account, and confirm or correct this pin
from that one comparison rather than from another round of static tracing.

## 14 · Detached grandchild survives a deadline kill (action A5b, card #239), 2026-09-17

Action A5b (`orchestrator/steps/llm.js`'s `invokeClaudeReal`, driving `query()` instead of
`spawnSync`) was built to prove "a call exceeding `opts.deadlineMs` is terminated ... and leaves
no live child" — the brief's own wording, and the property `sdk-call.js`'s `confirmProcessExit`
exists to hold this function's own return open until it can honestly claim. That property holds
for the DIRECT child (the `claude` process itself, or its equivalent in this action's own fake --
see `test/helpers.js`'s `fakeSpawnedChild`), confirmed by an event-driven `'exit'` listener on the
real handle `spawnClaudeCodeProcess` captures, not a guess. It does **not** hold, and cannot be
made to hold from this action alone, for a DETACHED GRANDCHILD -- a tool subprocess `claude` itself
spawns (its own Bash tool, most concretely).

**Measured (this action, live probe against the real vendored SDK -- a fake `claude` that ignores
SIGTERM and spawns a `{ detached: true }` grandchild that also ignores SIGTERM, script deleted
after use, not committed).** After `abortController.abort()` drove the SDK's own kill escalation
through to a confirmed SIGKILL of the direct child (~5.9-7.1s, matching `SDK_ABORT_KILL_DELAY_MS`
+ `SDK_ABORT_SIGKILL_ESCALATION_MS`), the detached grandchild was still alive and still emitting
heartbeats at the end of a 9-second observation window -- it never received any signal at all. This
is not new to this transport: neither the OLD transport's `spawnSync` `killSignal`, nor the abort
path this action wires up, ever signals a process GROUP (a negative-pid `kill`) -- the one place the
vendored SDK's own source does that (`process.kill(-pid, "SIGKILL")`, grepped directly) is the
Bash-tool's OWN subprocess manager, a different class entirely, reachable only when the SDK itself
runs a tool in-process (not this pipeline's usage, which only ever drives `query()` for a single
`claude` child). So "no live child" was never a group guarantee under either transport -- a
detached tool subprocess has always been able to outlive a killed `claude`, on the old transport
and the new one alike.

**Why this is a live gap, not a cosmetic one.** The card's own "leaves no live child" language,
read literally (every process in the call's subtree, not only the one this pipeline directly
spawned), is false the moment `claude`'s own Bash tool detaches a long-running command before a
deadline kills the parent. In practice the blast radius is bounded by what PLAN/IMPLEMENT/DIAGNOSE/
CITATION_VERIFIER/VALIDATE actually run inside the sandboxed worktree each step already operates
in (never a `nohup`-style detach by the STEP's own prompts, as far as this action's own reading of
`prompts/*.md` goes) -- but nothing in this transport, or the old one, structurally prevents a
future tool call (or a future SDK version's own tool implementation) from detaching a process that
then outlives a deadline-killed `claude`.

`interrupt()` (the SDK's own protocol-level graceful-cancel message, distinct from `abort()`'s hard
kill) was checked and is not a substitute: it asks the CLI to stop its current turn cooperatively,
which a hung or misbehaving call is by construction not guaranteed to honour, and it does nothing
for a grandchild that has already detached regardless.

**Not fixed here, and not fixable from this action alone** — per this register's own posture. A
real fix (killing the process GROUP the direct child belongs to, which requires either spawning
`claude` itself with its own session/pgid via a custom `spawnClaudeCodeProcess` that takes over
process management from the SDK's own default — a materially larger, riskier scope than this
action's brief called for — or a future SDK-provided hook for exactly this) is left to a future
action or card, named here rather than silently accepted. Closing condition: either the vendored
SDK ships its own process-group kill for `spawnClaudeCodeProcess`-managed children, or a future
action measures the real blast radius of detached tool subprocesses against the live corpus and
decides the custom-spawn approach is worth its own risk.

## 15 · F3 prose-sweep scope: what "`claude -p`" was left alone, and why (A5b-2 fix pass, card #239), 2026-09-17

Action A5b's cutover (`spawnSync`/`buildArgv` deleted, replaced by the vendored Agent SDK's
`query()`) left a large number of comments across `doc/`, `prompts/`, `orchestrator/`, and `test/`
describing the OLD transport in the present tense. The A5b-2 fix pass corrected every stale
MECHANISM claim it found by repeated, widening greps (`spawnSync`, `claude -p`, `buildArgv`,
`argv`, `blocking`, `synchronously`, `output-format json`, `stdout`, plus targeted
`invokeClaudeReal`+`spawnSync`/`synchronous`/`blocking` combinations) — three separate sweep
rounds, the last prompted by a verifier cross-check that found sites the first two missed. This
entry records the boundary that sweep drew, in the tree, not only in a chat report — so a later
reader can tell "checked and deliberately kept" from "never looked" (the failure mode that let the
scope slip twice: **`prompts/README.md`'s "`--model`/`--effort` on the `claude -p` invocation"
looked like harmless shorthand and was actually a MEASURABLE claim that turned out half-false** —
the flags are real, MEASURED against the vendored SDK argv probe (`sdk-call.js`'s own header), but
`-p`/`--print` is never passed on this transport at all. That one correction is the reason the
categories below are stated as "measured, not assumed" rather than "obviously fine").

**Fixed** (mechanism claims — describing HOW something currently works): every present-tense
"spawns `claude -p`", "the `claude -p` invocation/call/session", "`deps.spawnSync` is the
[injection point / choke point] `invokeClaudeReal` uses", "the argv it builds", "parses stdout",
and "once A5b lands" (or "once card #239's transport swap...", present/future tense for an action
that has landed) — across `orchestrator/config.js`, `account-lease.js`, `step-contracts.js`,
`recette.js`, `daemon.js`, `dispatcher.js`, `journal.js`, `state-machine.js`, `accounts.js`,
`tokens.js`, `steps/llm.js`, `steps/scripted.js`, `steps/sdk-call.js`, `sdk.js`,
`auto-triage.js`, `console/live-step.js`, `scripts/smoke-llm.js`, `orchestrator/README.md`
(multiple independent copies of the same claim, in different sections), `README.md` (repo root),
`doc/state-machine-spec.md`, `doc/permissions.md`, `doc/accepted-gaps.md` §12, `prompts/README.md`,
and `test/account-settings-sync.test.js`.

**Left alone, deliberately, by category — each MEASURED against this HEAD, not assumed true
by pattern-matching the word "`claude -p`":**

1. **Historical/dated records that already disclaim themselves.** `doc/deployment.md`'s
   `killedByDeadline`/`isSpawnTimeout` section ("this section is a record of the finding, not of
   current code"), `doc/remediation-progress.md`/`doc/remediation-plan-2026-08.md`'s dated action
   logs, `doc/improvisation-analysis.md`'s "v1's `claude -p` model" (explicitly the RETIRED
   product driver, not this pipeline), config.js's own "a live measurement (2026-08, this
   machine) of a `claude -p` call" (the measurement genuinely ran on the pre-A5b transport — the
   date predates A5b by weeks, so the claim is true AS WRITTEN, about a specific past event).
2. **Test-file comments describing their OWN migration history**, already correctly framed in
   past tense at the point A5b's own commit and the A5b-2 fix pass touched them (e.g.
   `test/llm-real.test.js`'s "this file used to fake the old `claude -p` transport",
   `test/account-rotation.test.js`, `test/status-5.4.test.js`, `test/llm-real-card.test.js`) — by
   construction these are already correct, since they were written or corrected describing a
   transition that had already happened.
3. **`doc/state-machine-spec.md`'s Step-contracts table** (`| PLAN | `claude -p` | ... |`, four
   rows): a KIND-label naming which rows are LLM steps vs scripted ones, not a claim about argv or
   spawn mechanics — parallel to the `| script |` label the WORKTREE row carries. Left as `claude -p`
   deliberately: renaming it to `query()`/`invokeClaudeReal` would suggest the table is making a
   mechanism claim it never made, and the prose paragraph immediately below the table (fixed in
   this pass, see doc/state-machine-spec.md's own "Whichever figure applies..." paragraph) is
   where the actual mechanism is described.
4. **Cost/count shorthand describing WHAT an LLM call costs, not HOW it runs** — "`spo ask` makes
   about two real `claude -p` calls per request", "every real `claude -p` call already records its
   own token counts", "a real `claude -p` reproduction" (account-pool exhaustion cost), "a wide
   `claude -p` outage" (auto-triage's incident-class name) — none of these assert the `-p` flag,
   `spawnSync`, or argv construction; they use "`claude -p`" as this repo's established informal
   name for "one real LLM invocation," the same way "a claude -p call" and "an LLM call" are used
   interchangeably throughout this very entry. MEASURED risk of leaving these: low — none of them
   would mislead a maintainer about the CURRENT transport's mechanics, only about a naming
   convention that predates this chantier and is unrelated to it.

**Not closed by this entry**: the pre-existing `killedByDeadline` field-name references in
`orchestrator/README.md:1396` and `steps/scripted.js`'s own comment (both cite a field that does
not exist in `steps/llm.js` today — the real field is `timedOut` — a naming drift that predates
card #239 and is not caused by the A5b transport swap). Found during this sweep, out of scope for
it, named here rather than silently carried forward uncorrected.
