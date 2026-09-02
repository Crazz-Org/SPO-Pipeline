# Step prompts

One file per orchestrator LLM step (`state-machine-spec.md` § Step contracts). Each is the text
handed to `claude -p` for that step — domain context (the product worktree's trimmed
`CLAUDE.md`) is supplied separately by the caller; these files carry only the step's own brief.

Every file starts with an HTML-comment header naming its `{{placeholders}}` and the exact JSON
shape expected on stdout — read that before the body. The body is written directly to the
model, in second person, and ends by repeating the output-discipline rule so it survives being
read out of order.

## Step → prompt → model / effort / tools / cwd

| Step | Prompt file | Model | Effort | Tools | Ground |
|---|---|---|---|---|---|
| PLAN | `plan.md` | Fable 5 (Opus 5 fallback only — `step-contracts.js:108`: the wire rule escalates IMPLEMENT and change-validator, deliberately NOT PLAN) | per task `Size` S/M/L → low/medium/high | `Read, Grep, Glob, Bash(ro)` | reads `{{worktree}}`; holds no write tool at all -- returns `plan_markdown`/`invariants_markdown`, the driver writes both under `{{scratch_dir}}`; also returns `files_to_change` (action 3.2 — **absolute** paths under `{{worktree}}`, `plan.md:103`, distinct from paths it merely reads or cites) |
| IMPLEMENT | `implement.md` | Sonnet 5 (Opus 5 on the wire rule — `src/shared/rdo-*`, `src/server/rdo.ts`, `rdo-members.ts`, session phases — or an `L`-sized task) | per `Size` | full edit tools | reads and writes `{{worktree}}` only |
| DIAGNOSE | `diagnose.md` | Fable 5 | high | `Read, Grep, Bash(ro)` | reads `{{diff_path}}`, `{{gate_log_path}}`, `{{ledger_path}}` |
| VALIDATE — citation-verifier | `verify-citations.md` | Fable 5 | high | `Read, Grep` (product + `~/SPO-Original`, read-only) | reads the diff and `{{spo_original_path}}/Rdo/Server/`; runs only when `rdo-members.ts` changed, and always before `validate-change.md` |
| VALIDATE — change-validator | `validate-change.md` | Fable 5 — never Sonnet 5 (the executor may not judge itself); Opus 5 on the wire rule or as fallback | high | `Read, Grep, Glob, Bash(ro)` | reads `{{diff_path}}`, `{{invariants_path}}`, `{{gate_report_path}}` |
| review-card (intake path — findings, hook-hardening candidates, split cards) | `review-card.md` | Fable 5 | high (`intake.js:435`; not yet a state-machine-spec.md row) | `Read, Grep, Glob, Bash(ro)` | reads the product tree and `gh issue list --repo {{repo}}`, read-only |

Every "high"/"low"/"medium" effort and every model choice above is what the *caller* passes as
`--model` / `--effort` on the `claude -p` invocation — nothing in a prompt file selects its own
model. The one exception a prompt states explicitly is the RDO wire escalation, because the
executing step needs to know it may be running as Opus rather than assume Sonnet.

## Placeholder conventions

- **`{{worktree}}`** — always absolute, always rooted in the task's own worktree, never the main
  checkout and never a sibling task's worktree. Only IMPLEMENT ever writes inside it.
- **`{{scratch_dir}}`** — absolute, **outside** `{{worktree}}` — the task's scratch area under
  the pipeline's own `journal/`/scratch tree. `plan.md` and the invariants file always land
  here, never inside the worktree, so a plan can be written without dirtying the tree the gate
  later judges. PLAN itself never writes them (it runs read-only, `permissionMode: 'plan'`) --
  it returns their full text as `plan_markdown`/`invariants_markdown` and the driver
  (`state-machine.js`'s `handlePlan`) writes both files here once the reply validates, the same
  compose/write split `draft-card.md`'s intake path already uses (`draftCard` composes,
  `fileCard` writes).
- **`{{invariants_path}}` / `{{invariant_ids}}`** — the invariant file's path travels with the
  list of ids, **never the quotes themselves**. Every step that consumes an invariant re-reads
  its quote from the file at the cited `file:line`/`file:start-end` — this is the mechanism
  `next-task.md` § 3 documents (id, verbatim quote, citation; `HELD`/`CHANGED` rows; the
  exact-then-normalized substring check) and every prompt here that touches an invariant follows it
  unchanged.
- **`{{diff_path}}` / `{{gate_log_path}}` / `{{gate_report_path}}` / `{{ledger_path}}`** — file
  paths, not inline content. A step reads them with its own tools; nothing is pasted into a
  prompt as a blob, so a large diff or log never inflates the call.
- Every placeholder value is an **absolute path** or a plain scalar/list — never a bare-relative
  path, which resolves against whatever the model believes the repository root is rather than
  the worktree actually named.

## The shared rules baked into every prompt

Each file states these in its own words, tailored to what that step actually touches, but the
substance is the same everywhere:

1. **The reply is machine-read.** Terse, and the JSON contract in the header is respected
   exactly — no preamble, no restatement of the task, no summary of what was read, no closing
   offer, no markdown fence around the JSON unless a field's own value needs one. A missing or
   malformed field reads downstream as a failed step, the same way an unrecognized exit code
   does for a scripted one.
2. **Never invent a file path or a citation.** Re-check with the step's own read tools before
   writing a path, a quote, or a `File.pas:Line` into a reply — a wrong one fails silently, later,
   at the worst point in the pipeline.
3. **Cite `file:line` for claims** — an invariant quote, an RDO citation, a card's supporting
   evidence, a diagnosis's suggested fix. A conclusion with no citation is not usable by the next
   step, which has no chat history to fall back on.
4. **Read-only unless the contract says otherwise.** Only IMPLEMENT holds edit tools, and only
   inside `{{worktree}}`; every other step is `Read`/`Grep`/`Glob`/`Bash(ro)` and reports data,
   it does not act — none of them ever runs `gh issue create`, `gh issue comment`, `git commit`,
   or any other write verb, `review-card` included (it returns the comment text; the driver
   posts it).
5. **Operational traps, only where the step actually meets them:**
   - **Verdicts are exit codes, never printed text** — relevant to PLAN (the check commands it
     emits), IMPLEMENT (running those commands and the verification aliases itself), and
     DIAGNOSE (reading a gate report that prints a banner before the number that actually
     matters). A pipe into `tail`/`head`/`grep`, or a trailing `&`, destroys the code being
     judged — redirect to a file and read the status instead.
   - **`gh` quirks** — relevant only to `review-card`, the one step that shells out to `gh` at
     all: a bare `gh issue view <n>` (no `--json`) is broken on this project's repo and exits 1
     with nothing usable; `gh issue list --repo <repo> --state open|closed` is the form that
     works and is the one named in the payload.

None of these traps are copied into a step that never meets them — PLAN and IMPLEMENT never call
`gh`, and DIAGNOSE and the two VALIDATE steps never write a file, so their prompts state only the
subset of the list above that could actually fire.
