# Accepted-gap register (action 7bis.5)

> **Status: a dated record.** True as of its entry's date; never re-verified against present code.

**Added 2026-09-02.** This is Gate C7's third certification — "**Declared**" — made concrete:
a partition of the whole documentation-and-comment corpus this chantier could have audited
into what is mechanically enforced, what was read exhaustively, what is classified as a
historical log (and therefore correctly out of scope rather than un-audited), and what is
an accepted, named gap handed to chantier 9. Every line of every candidate file lands in
exactly one bucket below. This register is itself a dated record, true as of 2026-09-02,
against the tree at commit `c9b8d458353b02a81aee39ec802b40adafba210a` — re-run the commands
in §1 to refresh it; do not hand-edit the numbers.

**Method note, matching this plan's own rule:** every count below is measured with a shown
command, not estimated. Where this register's numbers disagree with the plan's own prior
estimates (`~16,800` total, `~2,290` retired), **the measurement in this register wins** —
see §4.

---

## 1 · The surface, named explicitly

**In scope** — this is exactly action 7bis.6's own sibling-grep list, which is the plan's own
operational definition of "the documents and comments this chantier holds itself accountable
for":

- `doc/*.md` (all files directly under `doc/`)
- `prompts/*.md` (all files directly under `prompts/`)
- `orchestrator/README.md` and every comment line in `orchestrator/**/*.js`
- `bin/spo` (comment lines only — it is a script, not a doc)
- `console/**/*.js` (comment lines only)
- `README.md` (repo root)

**This file itself** is classified-historical, by the same rule as §3b and by its own opening
paragraph. Its line count is deliberately **not** added to the §3 totals: those are pinned to the
tree at `c9b8d458353b02a81aee39ec802b40adafba210a`, which predates this file, and a register that
counted itself would move its own totals on every edit. Stated here so the exclusion is declared
rather than silently assumed — the failure this whole register exists to prevent.

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
  `console/**/*.js`** — only comment lines in these files carry documentation claims; a code
  line's truthfulness is what the test suite already checks, not what this register is for.
  (Markdown files, by contrast, are counted in full — a `.md` file's blank lines and table
  syntax are still part of what a reader reads as the claim.)

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
# `//` or `/*` inside a string literal would misread — spot-checked against every file below,
# zero false positives found in this corpus.
node count-comments.js $(find orchestrator -name "*.js" | sort) bin/spo \
  $(find console -name "*.js" | sort)
```

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

Run 2026-09-02 against `c9b8d458353b02a81aee39ec802b40adafba210a`:

```
23839  9801  1666  12372  TOTAL   (orchestrator/**/*.js + bin/spo + console/**/*.js:
                                   total / comment / blank / code lines)
```

## 3 · The partition

**Bucket definitions.** A bucket is assigned per *file*, not per fragment, because sweeps
(7bis.1, 7bis.3, and 7bis.2 once it lands) check specific named facts inside a file's text —
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

### 3b · Classified-historical (running logs) — 3 files, 2,442 lines

| File | Lines |
|---|---|
| `doc/remediation-progress.md` | 1,821 |
| `doc/improvisation-analysis.md` | 237 |
| `doc/remediation-plan-2026-08.md` | 384 |
| **Subtotal** | **2,442** |

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

### 3d · Accepted gap, handed to chantier 9 — 58 files, 14,162 lines

**Markdown (docs), full line count — 11 files, 4,361 lines:**

| File | Lines | Note |
|---|---|---|
| `doc/state-machine-spec.md` | 535 | Park-reason vocabulary (7bis.1, green today) and documented constants/citations (7bis.3, green today) inside this file are fact-checked; its prose at large is not — see 3c. |
| `doc/board-audit.md` | 218 | |
| `doc/permissions.md` | 209 | |
| `doc/setup.md` | 73 | |
| `doc/environments.md` | 71 | |
| `doc/jewels-inventory.md` | 38 | |
| `doc/bench-audit-2026-09-02.md` | 408 | 8.1's deliverable, explicitly self-described as "Fable's and unverified" except one Opus-checked finding (`doc/remediation-progress.md`, "What C7 hands the next session"). |
| `doc/bench-plan-derived-2026-09-02.md` | 165 | Same provenance as above. |
| `orchestrator/README.md` | 2,451 | Documented constants inside this file are 7bis.3's fact-check target; its narrative is not. |
| `prompts/README.md` | 104 | Its ~10-line table is 7bis.2's target once that sweep lands (not yet present in this tree — see 3c); the narrative around it is not covered by anything. |
| `README.md` (root) | 89 | |
| **Subtotal** | **4,361** | 535+218+209+73+71+38+408+165+2,451+104+89 = 4,361 |

Grouped the same total two ways, so it is checkable without re-adding eleven rows:
`doc/*.md` remainder (8 files, excluding the 3 in 3b) = **1,717**; `orchestrator/README.md`
= **2,451**; `prompts/README.md` = **104**; `README.md` root = **89**. 1,717 + 2,451 + 104 +
89 = **4,361**.

**Code comments — 47 files, 9,801 lines:**

| Location | Files | Comment lines |
|---|---|---|
| `orchestrator/**/*.js` | 39 | 8,577 |
| `bin/spo` | 1 | 683 |
| `console/**/*.js` | 7 | 541 |
| **Subtotal** | **47** | **9,801** |

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
`console/render.js` 157/1,148, `console/usage-scan.js` 95/495, `console/serve.js` 26/169,
`console/usage-rollups.js` 25/81, `console/prod-version.js` 18/163, `console/system.js` 12/102
(subtotal 541/3,014).

**Bucket 3d total: 1,717 + 104 + 2,451 + 89 + 8,577 + 683 + 541 = 14,162 lines, 58 files.**

## 4 · Reconciliation with the plan's prior figures

| Figure | Plan's estimate | This register's measurement | Delta |
|---|---|---|---|
| Total corpus | ~16,800 | **17,750** (Bucket 3a + 3b + 3d = 1,146 + 2,442 + 14,162) | +950 (+5.7%) |
| Retired (classified-historical) | ~2,290 | **2,442** (Bucket 3b) | +152 (+6.6%) |

**These measurements win; the plan's ~16,800 and ~2,290 are superseded by the numbers above.**
A plausible, partial explanation for the total-corpus gap (not asserted as the full account,
since the plan's own figure carries no measurement command to audit against): `doc/bench-audit-2026-09-02.md`
and `doc/bench-plan-derived-2026-09-02.md` (573 lines together) are 8.1's deliverables,
produced the same day chantier 7bis was scoped, "in parallel with C7 bis" per
`doc/remediation-progress.md`'s "What C7 hands the next session" section — if the ~16,800
figure predates them, that alone accounts for roughly 60% of the delta. The remainder is
consistent with ordinary estimate-vs-measurement slack; this register does not need to
resolve which prior artifact produced ~16,800, only to supersede it with a reproducible number.

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

Neither is fixed here — 7bis.5 registers gaps, it does not close them.

## 7 · Sibling-grep result (7bis.6)

This action corrects two figures the plan previously stated as fact: the total-corpus line
count (~16,800) and the retired-lines count (~2,290), both in `doc/remediation-plan-2026-08.md`'s
7bis.5 row (the only place either number appears). Per 7bis.6, both the corrected and the
pre-correction phrasing were grepped across `doc/`, `prompts/`, `orchestrator/`, `bin/spo`,
`console/` and `README.md` before this register was considered done:

```
grep -rn "16,800\|16800" doc/ prompts/ orchestrator/ bin/spo console/ README.md
grep -rn "2,290\|2290" doc/ prompts/ orchestrator/ bin/spo console/ README.md
```

**Result: no other occurrence of either figure exists anywhere in that scope.** Both numbers
appear exactly once each, in the two sentences of the 7bis.5 row quoted above — this register
does not amend `doc/remediation-plan-2026-08.md`'s own row text (out of this action's scope;
only a one-line header was added to that file), so the plan's original ~16,800/~2,290 estimates
remain visible there as the historical estimate this register supersedes, not as a live claim
in need of a second correction elsewhere.
