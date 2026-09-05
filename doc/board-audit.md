# Kanban board audit — Crazz-Org project #1 (v2 pipeline readiness)

Read-only audit. No GitHub state was mutated: no item-edit, no workflow deletion, no
label/issue writes. All reads used the allowlisted forms named in the task (`gh project
field-list`, a hand-written `workflows` GraphQL query with `rateLimit`, the `board:claim`
alias, `gh label list`). `gh project item-list` was never run.

Repo checked: `git -C /home/crazz/SPO-Pipeline rev-parse --show-toplevel` →
`/home/crazz/SPO-Pipeline` (confirmed).

Target pipeline (v2, by-name column moves): **Todo → Planning → Implementing → "Checks & PR"
→ Gate → Validation → Merging → Done**, plus **Parked** (machine waiting on the maintainer).
Old pipeline: Todo, In progress, Gate, Validation, PR, Done, Needs triage.

---

## 1. Status field — current vs target

Read via `gh project field-list 1 --owner Crazz-Org --format json`. The `Status` field
(`PVTSSF_lADOEyAVD84BhYwkzhgUrL0`) currently holds all 12 options — the 7 old-pipeline names
plus the 5 new v2 names appended at the end, in creation order, not pipeline order:

```
Todo, In progress, Gate, PR, Validation, Done, Needs triage, Planning, Implementing,
Checks & PR, Merging, Parked
```

| # | Option name (as stored) | In target set? | Order matches target? | Verdict |
|---|---|---|---|---|
| 1 | `Todo` | yes | yes (position 1 in both) | PASS |
| 2 | `In progress` | no — legacy only | n/a | FIX — retire |
| 3 | `Gate` | yes | no (target position 5, actual 3) | FIX — reorder |
| 4 | `PR` | no — legacy only | n/a | FIX — retire |
| 5 | `Validation` | yes | no (target position 6, actual 5) | FIX — reorder |
| 6 | `Done` | yes | no (target position 8, actual 6) | FIX — reorder |
| 7 | `Needs triage` | no — legacy only | n/a | FIX — retire (see §5) |
| 8 | `Planning` | yes | no (target position 2, actual 8) | FIX — reorder |
| 9 | `Implementing` | yes | no (target position 3, actual 9) | FIX — reorder |
| 10 | `Checks & PR` | yes | no (target position 4, actual 10) | FIX — reorder |
| 11 | `Merging` | yes | no (target position 7, actual 11) | FIX — reorder |
| 12 | `Parked` | yes | trailing/appended, position unspecified by design | PASS (placement not order-critical) |

Spelling/encoding check on `Checks & PR`: stored exactly as `Checks & PR` — no `&amp;`
entity, no truncation to `Check & PR`, no stray whitespace or lookalike character visible in
the raw JSON string. **PASS** — the orchestrator's by-name match on this column is safe.
No duplicate option names found. No other stray-whitespace or emoji contamination found in
`Status` (emoji options exist only on the unrelated `Category` field, which is out of scope
here and untouched).

**Column summary: 5 FIX (reorder), 3 FIX (retire legacy), 4 PASS.** The 5 new names are all
present and correctly spelled, but the field is currently unusable by the orchestrator's
by-name moves in the order that matters for a human reading the board left-to-right — GitHub
Projects boards are read/rendered in option order, so a maintainer or anyone glancing at the
board sees old and new columns interleaved arbitrarily. The by-name move logic itself is
unaffected by order (it matches on name, not position), so this is a display/hygiene FIX,
not a functional blocker for the orchestrator.

---

## 2. Project workflows — current vs target

Read via:
```
gh api graphql -f query='query{organization(login:"Crazz-Org"){projectV2(number:1){workflows(first:20){nodes{name enabled}}}} rateLimit{cost remaining resetAt}}'
```
Cost 1 point (remaining 4774 of hourly quota at read time). 8 workflows are configured
(query asked for up to 20 and returned 8 — no pagination cutoff, so this is the full set;
no other PR-related or archive workflow exists in the project, which trivially satisfies
"stay OFF" for anything not listed).

| Workflow | Enabled | Target (v2) | Verdict |
|---|---|---|---|
| Auto-add to project | true | ON | PASS |
| Item added to project | true | ON, should set Status→Todo | PASS (enabled) — target field not API-readable, see caveats |
| Item closed | true | ON, should set Status→Done | PASS (enabled) — target field not API-readable, see caveats |
| Auto-close issue | true | ON | PASS |
| Auto-add sub-issues to project | true | ON (harmless) | PASS |
| Item reopened | true | should stay ON but retarget Status→Parked, not Needs triage | FIX — retarget (UI-only) |
| Pull request linked to issue | true | should be OFF | FIX — disable |
| Pull request merged | false | OFF | PASS |
| *(no other PR-item or archive workflow configured)* | — | OFF | PASS (absent = off) |

**Workflow summary: 2 FIX (Item reopened retarget, Pull request linked to issue disable), 6 PASS.**

The live FIX that matters most functionally: **"Pull request linked to issue" is currently
ON**, and per the task's framing it jumps a card straight to the legacy `PR` column the
instant a PR references its issue — mid-pipeline, fighting every by-name move the
orchestrator makes afterward (e.g. moving a card into `Checks & PR` or `Gate`). This is the
one workflow FIX with an observable effect today, independent of the Status-field reorder.

---

## 3. Live card distribution

Read via `npm run board:claim` (cwd `$HOME/SPO-WebClient`) → `scripts/claim-read.sh`.
Cost 4 points (remaining 4770). 161 items total.

| Status | Count |
|---|---|
| Done | 139 |
| Todo | 19 (all in the unclaimed "walk" the script lists — none carry a Session) |
| Gate | 1 — `#406`, session `claude/next-task-67637d` @ 2026-08-28 |
| PR | 1 — `#177`, session `claude/next-task-6e9e40` @ 2026-08-28 |
| Needs triage | 1 — `#198`, session `-` (empty) |
| In progress | 0 |
| Validation | 0 |
| Planning | 0 |
| Implementing | 0 |
| Checks & PR | 0 |
| Merging | 0 |
| Parked | 0 |

**Cards in legacy-only columns (`In progress`, `PR`, `Needs triage`): 2** — `#177` (PR) and
`#198` (Needs triage). (`In progress` itself is empty.) `Gate` and `Validation` are shared
between old and new pipelines, so `#406` sitting in `Gate` is not a legacy-column flag by
itself.

**Stale Session marks observed: 2** — `#406` (Gate, session `claude/next-task-67637d`) and
`#177` (PR, session `claude/next-task-6e9e40`), both dated 2026-08-28 (one day before this
audit). The read surfaces the Session field only for the 3 non-hidden (non-Done, non-Todo)
items; Done-card sessions are not visible through this alias. Recency (one day old) means
these could still be a genuinely live old-pipeline session finishing its own card rather than
an abandoned one — see caveats.

---

## 4. Product-repo labels

Read via `gh label list --repo Crazz-Org/SPO-WebClient --limit 100` (REST call, no GraphQL
cost).

| Label | Flag |
|---|---|
| `rdo-approved` | Retirement already owned by a separate product card per the maintainer's RDO decision — noted only, no action here. |
| `dependencies`, `javascript` | Bot-default labels (Dependabot config), likely still auto-applied — no evidence of dead role found; not flagged. |
| `wontfix` | No open issues verified against it in this read (item-list not run); cannot confirm live usage. Not flagged as dead without evidence — noted as unverified. |
| All `cat:*`, `size:*`, area labels (`gateway`, `rdo`, `client`, `renderer`, `bench`, `e2e`, `ci`), `bug`/`documentation`/`enhancement`/`good first issue`/`help wanted`/`invalid`/`question`/`duplicate` | Standard/active taxonomy — no dead-label evidence found. |

No label besides `rdo-approved` was identifiable as having "no current role" from this
read alone — confirming true dead labels would require an item-list-scale query, which is
outside the ~30-point budget and explicitly disallowed for this audit.

---

## 5. Legacy configuration inventory

| Item | What it is | Recommended fate |
|---|---|---|
| `Status` options: `In progress`, `PR`, `Needs triage` | Old-pipeline-only columns, 2 cards currently sitting in them | **Retire now via UI** — after migrating `#177` and `#198` to their v2 equivalents (`#177` → `Checks & PR` or `Merging` per its actual state; `#198` → `Needs triage`'s replacement is `Parked`, but judge from the issue's actual content first), delete the 3 stray options from the Status field. |
| `Status` field ordering | New v2 options appended out of pipeline order | **Retire now via UI** — reorder to the target sequence (see checklist). Not a functional blocker, but leave-it in place misleads any human reading the board. |
| "Item reopened" workflow → `Needs triage` | Old ownership-triage target | **Retire now via UI** — retarget the action to `Parked`, keep enabled. |
| "Pull request linked to issue" workflow | Currently ON, jumps cards to legacy `PR` column | **Retire now via UI** — disable. Highest-impact fix; it actively fights the orchestrator today. |
| `Session` project field | Ownership marker written by `board-take.sh` (`npm run board:take`, spawned live from `orchestrator/steps/scripted.js:1350` at WORKTREE) on every claim, and read back by its own `--release` path | **Keep** — this field is live and load-bearing for the single orchestrator today, not a legacy holdover. Not touched here. |
| `Area` project field | Metadata, orthogonal to pipeline stage | **Keep** — stays useful; not legacy. |
| `.github/workflows/orphan-cards.yml` (confirmed present in `$HOME/SPO-WebClient`) | Old ownership law: comments on orphaned cards, frees nothing (per CLAUDE.md) | **Retire later via product card** — file a card in the product repo; not read in depth or touched here (read-only existence check only, per the task's explicit "do NOT touch it"). |
| `rdo-approved` label | Being retired by a separate maintainer RDO decision | **Out of scope here** — already owned elsewhere, noted only. |

---

## 6. Maintainer UI checklist (shortest path first)

1. **Disable "Pull request linked to issue"** — Project → Workflows → toggle it off.
   (Highest-impact, single click, stops active interference today.)
2. **Retarget "Item reopened"** — Project → Workflows → Item reopened → change "Set Status"
   value from `Needs triage` to `Parked`. Keep the workflow enabled.
3. **Move the 2 cards sitting in legacy columns** — open `#177` (currently `PR`) and decide
   its real v2 stage from its content (likely `Checks & PR` or `Merging`); open `#198`
   (currently `Needs triage`) and move it to `Parked`. Do this before deleting the columns
   below, or the cards lose their status silently.
4. **Reorder the `Status` field options** to the target sequence — open the `Status` field's
   options editor and drag into: `Todo, Planning, Implementing, Checks & PR, Gate, Validation,
   Merging, Done, Parked, Intake`. `Intake` is not part of the pipeline's own stage sequence but
   MUST stay an option: `config.js:786`'s `reportIntakeColumn` defaults to it, and
   `report-intake.js:29` calls a failed move there "NOT safe to ignore" — the one board move in
   this repo that is load-bearing rather than cosmetic. Do not include it among the options step
   5 deletes.
5. **Delete the 3 legacy Status options** — `In progress`, `PR`, `Needs triage` — from the
   `Status` field, only after step 3 has emptied them.
6. *(Later, separate product card — not this session, not now)*: file a card to retire
   `.github/workflows/orphan-cards.yml`. The `Session` field stays — it is written by
   `board-take.sh` on every live claim, not a legacy holdover (see § 5).

---

## 7. GraphQL points spent

| Call | Cost |
|---|---|
| `workflows(first:20)` query | 1 |
| `board:claim` (`scripts/claim-read.sh`) | 4 |
| `gh project field-list` | not surfaced by the CLI wrapper; task-characterized as a cheap generated query, no manual `rateLimit` available to report |
| `gh label list` | REST, not GraphQL — 0 GraphQL points |

**Total measured: 5 GraphQL points** (well under the ~30-point budget). Quota remaining at
last read: 4770 of the hourly allowance, reset `2026-08-29T07:03:47Z`.

## 8. Permission refusals

None encountered. `gh project item-list` was never attempted (explicitly disallowed by the
task). It is not, in fact, blocked by a local hook: this repo has no `.claude/hooks/` at all,
and `Bash(gh project item-list*)` is in `.claude/settings.json`'s `permissions.allow` — the
call is allowed, it was simply out of scope for this audit.

## Caveats

- `gh project field-list` and `gh label list` do not expose a `rateLimit` block, so their
  exact GraphQL/REST cost could not be measured directly (see §7).
- The Projects v2 `ProjectV2Workflow` GraphQL type exposes only `name`/`enabled` — the actual
  "set Status to X" target of "Item added to project" and "Item closed" could not be read via
  API and is assumed correct (Todo / Done respectively) per the task's stated target; verify
  visually in the UI.
- The two non-empty `Session` values (`#406`, `#177`) are dated one day before this audit
  (2026-08-28) and could belong to a still-running old-pipeline session rather than an
  abandoned one — flagged as stale-by-pattern, not confirmed dead. Do not treat as safe to
  clear without checking session liveness.
- Label "dead role" determination (§4) is necessarily incomplete without an item-level scan,
  which the task's budget and `item-list` prohibition rule out; only `rdo-approved` could be
  flagged with confidence, per the task's own framing.
