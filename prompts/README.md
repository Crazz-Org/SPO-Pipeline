# Step prompts

One file per orchestrator LLM step: the five in `state-machine-spec.md` § Step contracts, plus
the three intake-path steps `orchestrator/intake.js` drives. Each is the text handed to
`claude -p` for that step, and carries only that step's own brief.

Domain context is **not** supplied by the caller. No code here reads or trims a `CLAUDE.md`: the
CLI loads whatever `CLAUDE.md` tree sits at the step's own `cwd` (`steps/llm.js` deliberately
passes neither `--safe-mode` nor `--bare`, "which turn off CLAUDE.md and hooks, which
PLAN/IMPLEMENT need for product context"). So *which* `CLAUDE.md` a step sees is decided
entirely by where it runs — `config.js`'s `cwdForStep` — and only PLAN and IMPLEMENT run inside
the product worktree. DIAGNOSE and both VALIDATE steps run from this repo's root, on purpose:
`cwdForStep`'s own measurement put the product tree's preamble at ~40k input tokens per call.
The three intake steps run with `cwd` = `config.productRepo` (the main `~/SPO-WebClient`
checkout, never a task worktree). The Ground column below records this per step.

Every file starts with an HTML-comment header naming its `{{placeholders}}` and the exact JSON
shape expected on stdout — read that before the body. The body is written directly to the
model, in second person, and ends by repeating the output-discipline rule so it survives being
read out of order.

## Step → prompt → model / effort / tools / cwd

| Step | Prompt file | Model | Effort | Tools | Ground |
|---|---|---|---|---|---|
| PLAN | `plan.md` | Fable 5 (Opus 5 fallback only — `step-contracts.js:99`: the wire rule escalates IMPLEMENT and change-validator, deliberately NOT PLAN) | per task `Size` S/M/L → low/medium/high | `Read, Grep, Glob, Bash(ro)` | reads `{{worktree}}`; holds no write tool at all -- returns `plan_markdown`/`invariants_markdown`, the driver writes both under `{{scratch_dir}}`; also returns `files_to_change` (action 3.2 — **absolute** paths under `{{worktree}}`, `plan.md:103`, distinct from paths it merely reads or cites) |
| IMPLEMENT | `implement.md` | Sonnet 5 (Opus 5 on `task.touchesRdoMembers`, set once at intake from the issue's Area field or a literal `rdo-members.ts` mention in its body — narrower than the full wire rule's `src/shared/rdo-*`/`src/server/rdo.ts`/session-phase set, and never rederived from the plan's actual files — on an `L`-sized task, or on the generic `task.escalate` fallback flag: `step-contracts.js`'s `escalatesOn: ['touchesRdoMembers', 'lSize', 'escalateFlag']`) | per `Size` | full edit tools | reads and writes `{{worktree}}` only |
| DIAGNOSE | `diagnose.md` | Fable 5 | high | `Read, Grep, Bash(ro)` | reads `{{diff_path}}`, `{{gate_log_path}}`, `{{ledger_path}}` |
| VALIDATE — citation-verifier | `verify-citations.md` | Fable 5 | high | `Read, Grep` (product + `~/SPO-Original`, read-only) | reads the diff and the server-side Pascal declarations under `{{spo_original_path}}` (today: `Kernel/`; `Rdo/Server/` is the RDO transport layer — dispatch machinery, not the game-object declarations a catalogue entry cites); runs only when the task carries `touchesRdoMembers`, and always before `validate-change.md` |
| VALIDATE — change-validator | `validate-change.md` | Fable 5 — never Sonnet 5 (the executor may not judge itself); Opus 5 on the wire rule or as fallback | high | `Read, Grep, Glob, Bash(ro)` | reads `{{diff_path}}`, `{{invariants_path}}`, `{{gate_report_path}}` |
| review-card (intake path — its two callers are `spo ask`'s maintainer brainstorm and `auto-triage.js`'s confirmed bug-report queue) | `review-card.md` | Fable 5 | high (`intake.js`'s `reviewCard`, its `callIntakeStepWithRotation` options object; not a state-machine-spec.md row) | `Read, Grep, Glob, Bash(ro)` | `cwd` = `config.productRepo`; reads the product tree and `gh issue list --repo {{repo}}`, read-only |
| draft-card (intake path — one caller, `spo ask`/`/SPO-Draft` via `bin/spo`'s `cmdAsk`) | `draft-card.md` | Sonnet 5 (drafting is execution-shaped work — the drafter is deliberately a different model from `review-card`, its judge) | medium | `Read, Grep, Glob, Bash(ro)` (`permissionMode: 'plan'`) | `cwd` = `config.productRepo`; reads the product tree for `file:line` evidence, read-only (`intake.js`'s `draftCard`) |
| triage-bug-report (intake path — one caller, `auto-triage.js`'s `routeConfirmedReport` (reached from `processConfirmedReport`), behind `spo triage` and the daemon's auto-triage timer) | `triage-bug-report.md` | Opus 5 (maintainer decision, 2026-08-31 — was Fable 5) | medium | `Read, Grep, Glob, Bash(ro)` (`permissionMode: 'plan'` — the same set `draft-card` holds; this step actually uses its `Bash` for the model-server `curl` and the `gh issue list --search` dedup, neither a write) | `cwd` = `config.productRepo`; reads `{{report_file}}` under `~/.spo-reports` and the product tree (`intake.js`'s `triageBugReport`) |

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
  `implement.md` § 6 documents (id, verbatim quote, citation; `HELD`/`CHANGED` rows; the
  exact-then-normalized substring check — `next-task.md` is not a file this repo or
  SPO-WebClient tracks) and every prompt here that touches an invariant follows it unchanged.
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
   inside `{{worktree}}`; every other step reports data, it does not act — none of them ever
   runs `gh issue create`, `gh issue comment`, `git commit`, or any other write verb,
   `review-card` and `triage-bug-report` included (each returns the comment/draft text; the
   driver posts and files it). Their read-only tool sets are not all the same, though:
   `Read`/`Grep`/`Glob`/`Bash(ro)` for PLAN, change-validator, review-card, draft-card and
   triage-bug-report; DIAGNOSE the same minus `Glob`; and citation-verifier alone holds only
   `Read`/`Grep`, with no `Bash` at all — see the table above, the actual per-step source.
5. **Operational traps, only where the step actually meets them:**
   - **Verdicts are exit codes, never printed text** — relevant to PLAN (the check commands it
     emits), IMPLEMENT (running those commands and the verification aliases itself), and
     DIAGNOSE (reading a gate report that prints a banner before the number that actually
     matters). A pipe into `tail`/`head`/`grep`, or a trailing `&`, destroys the code being
     judged — redirect to a file and read the status instead.
   - **`gh` quirks** — relevant to the two steps that shell out to `gh` at all, both on the
     intake path: `review-card` (`gh issue list --repo <repo> --state open|closed`) and
     `triage-bug-report` (`gh issue list --repo <repo> --state all --search`, its § 3 dedup).
     A bare `gh issue view <n>` (no `--json`) is broken on this project's repo and exits 1 with
     nothing usable; the `gh issue list` forms above are what work, and are the ones named in
     those two payloads. None of the five state-machine steps calls `gh` at all.

None of these traps are copied into a step that never meets them — no state-machine step calls
`gh`, and DIAGNOSE and the two VALIDATE steps never write a file, so their prompts state only the
subset of the list above that could actually fire.
