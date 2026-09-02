# Accepted-gap register (action 7bis.5)

> **Status: a dated record.** True as of its entry's date; never re-verified against present code.

**Added 2026-09-02.** This is Gate C7's third certification — "**Declared**" — made concrete:
a partition of the whole documentation-and-comment corpus this chantier could have audited
into what is mechanically enforced, what was read exhaustively, what is classified as a
historical log (and therefore correctly out of scope rather than un-audited), and what is
an accepted, named gap handed to chantier 9. Every line of every candidate file lands in
exactly one bucket below. This register is itself a dated record, true as of 2026-09-02,
against the tree at commit `bb3594225b5ac087c0952c469f38a5f2d0a0951a`, with two later
corrections applied by the driver: `doc/remediation-progress.md` 1,823 → 1,865 (the C7 handoff
rewritten at the end of the chantier), and `test/prompt-contract-sweep.test.js`, which is outside
this corpus. Nothing else in the corpus changes after that pin except this file, which excludes
itself — so the counts below are true at the branch's merge state, not only at the pin. Re-run the commands
in §1 to refresh it; do not hand-edit the numbers.

**Method note, matching this plan's own rule:** every count below is measured with a shown
command, not estimated. Where this register's numbers disagree with the plan's own prior
estimates (`~16,800` total, `~2,290` retired), **the measurement in this register wins** —
see §4.

---

## 1 · The surface, named explicitly

**In scope** — action 7bis.6's own sibling-grep list (`doc/`, `prompts/`, `orchestrator/`,
`bin/spo`, `console/`, `README.md`) is the plan's own operational definition of "the documents
and comments this chantier holds itself accountable for," but it is **not exhaustive** of the
repo's own documentation-and-comment surface — `scripts/` and `accounts/` carry real comments
and were missing from it (see below). Corrected list:

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

**Corrected into scope by this edit.** `scripts/` and `accounts/` were absent from both lists
below in the prior version of this register — an undeclared, unnamed surface, not a considered
exclusion. Root cause: this corpus definition was inherited from action 7bis.6's own sibling-grep
scope list (`doc/`, `prompts/`, `orchestrator/`, `bin/spo`, `console/`, `README.md` — see
execution rule 6 in `doc/remediation-plan-2026-08.md`), which itself omits `scripts/` and
`accounts/`. That inheritance is the root cause, and it means execution rule 6 carries the same
blind spot — the sibling-grep in §7 below does not actually cover these two directories either.

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
- **`CLAUDE.md`** (repo root) and **`.claude/**`** (`settings.json`, `hooks/*.sh`, `commands/`)
  — also absent from 7bis.6's list. These are harness-governed operational instructions, not
  product/process documentation, and per `CLAUDE.md` itself `.claude/settings.json` and
  `.claude/hooks/*.sh` cannot even be edited by an agent — they are excluded from this corpus
  the same way they are excluded from every action's write scope.
- **Vendored or generated files** — this exclusion class is currently **empty**: there is no
  `node_modules/`, no build output, and no generated file checked into this repo (verified:
  `ls node_modules` fails, no `dist/`/`build/` directory exists). Named so the exclusion is
  not silently assumed; if one is ever added, it belongs here.
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

**Top-level directory/file check (every entry in the repo root, verified against this tree):**
`.claude` (excluded, harness-governed, above), `accounts` (in scope, new), `bin` (in scope,
`bin/spo`), `console` (in scope), `doc` (in scope), `orchestrator` (in scope), `prompts` (in
scope), `scripts` (in scope, new), `test` (excluded, above), `worktrees` (excluded, untracked,
above), `CLAUDE.md` (excluded, above), `README.md` (in scope), `.gitignore` (excluded, above),
`.recette` (excluded, untracked and absent from disk, above). Every top-level entry is now
placed in exactly one bucket, with a reason.

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

### 3b · Classified-historical (running logs) — 3 files, 2,506 lines

| File | Lines |
|---|---|
| `doc/remediation-progress.md` | 1,865 |
| `doc/improvisation-analysis.md` | 239 |
| `doc/remediation-plan-2026-08.md` | 402 |
| **Subtotal** | **2,506** |

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
| Total corpus | ~16,800 | **18,020** (Bucket 3a + 3b + 3d = 1,146 + 2,506 + 14,368) | +1,220 (+7.3%) |
| Retired (classified-historical) | ~2,290 | **2,506** (Bucket 3b) | +216 (+9.4%) |

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
for `~16,800`, which also appears at `doc/remediation-plan-2026-08.md:259`, in the "Chantier 7
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
doc/remediation-plan-2026-08.md:259:Yield was tracking newly-opened surface, not residual defects, and the surface is ~16,800 lines

$ grep -rn "2,290\|2290" doc/ prompts/ orchestrator/ bin/spo console/ README.md \
    | grep -v "^doc/accepted-gaps.md"
doc/remediation-plan-2026-08.md:285:| 7bis.5 | **The accepted-gap register**, and the classification that retires ~2,290 lines without reading them. [...] |
```

(This register's own occurrences of both figures — referring to and superseding them across §0,
§4 and this section — are filtered out above; this file is excluded from its own corpus per §1,
and counting them would only restate that this document discusses the two numbers, which is
already obvious. The ungrepped, raw command is the one in the codeblock heading above and finds
those self-references too — run it without the `grep -v` if you want to see them.)

**Corrected result.** Excluding this register's own self-referential prose (out of its own
corpus, §1), `~2,290` genuinely appears exactly once in that scope — in `doc/remediation-plan-2026-08.md`'s
7bis.5 row, line 285, as the prior version of this section claimed. **`~16,800` does not:** it
appears at `doc/remediation-plan-2026-08.md:259`, inside the "Chantier 7 bis — What Gate C7
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
