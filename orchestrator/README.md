# orchestrator — v2, real mode shipped

Implements the lifecycle table in [../doc/state-machine-spec.md](../doc/state-machine-spec.md)
(v1.1): INTAKE → WORKTREE → PLAN → IMPLEMENT → CHECK → PUSH_PR → GATE → CI_CHECKS → VALIDATE →
MERGE → FINISH → DONE, with DIAGNOSE as the retry hub and PARKED as the catch-all terminal
state. Node 22 built-ins only, zero dependencies.

## Running shadow mode

```bash
node orchestrator/daemon.js --shadow --once [--queue <dir>] [--journal <dir>] [--deadline-ms <n>]
```

- `--once` drains the whole `queue/` directory serially (filename sort = processing order) and
  exits, printing `<id>  <finalState>` per task. Without `--once` the daemon polls the queue
  directory forever (`--interval-ms`, default 5000).
- One of `--shadow`, `--dry-run` or `--real` is required. `--shadow` drives shadow-mode task
  files only (`task.shadow.*` fixtures, no real code path reached). `--dry-run` drives a *real*
  `kind: "card"` task file through real-mode semantics — step-contracts.js resolution,
  prompt-template.js fill, account rotation — with the one spawn point in each step (a `claude`
  CLI call, a scripted command) replaced by a fixture-free "assumed success" — see "Real mode" →
  "--dry-run" below. `--real` is the one mode that actually spawns: both the LLM steps
  (`steps/llm.js`) and the scripted steps (`steps/scripted.js`'s `realWorktree`/`realCheck`/
  `realPushPr`/`realGate`/`realCiChecks`/`realMerge`/`realFinish`) run for real — see "Real
  scripted steps" below. `--real` and `--shadow` are mutually exclusive (daemon.js refuses to
  start); if `--dry-run` is also given, `--dry-run` wins, same precedence as `--shadow` winning
  over `--dry-run`. No test that runs the real-mode functions in-process spawns a real
  `git`/`npm`/`gh`/`claude` process — every real-mode test (`test/llm-real*.test.js`,
  `test/account-rotation.test.js`, `test/real-steps.test.js`) injects `deps.spawnSync` and calls
  the real-mode functions directly, never through `daemon.js`'s own child-process dispatch. That
  guarantee stops at a process boundary, though: a test that spawns a real `daemon.js
  --worker`/`--scanner` child reaches the real, unpatched `spawnSync` inside that child — see
  "The hermeticity guarantee stops at a process boundary" below.
- Defaults: `--queue` = `<repo>/queue`, `--journal` = `<repo>/journal` (both created if
  missing). Point both at a temp dir to run an isolated batch — this is how the test suite
  works.

## Task-file format

One JSON file per task in `queue/`:

```json
{
  "id": "happy-001",
  "title": "Synthetic happy path",
  "kind": "synthetic",
  "shadow": { "...": "see below" }
}
```

`id` is also the journal directory name; if omitted, the queue filename (minus `.json`) is
used. `kind` is informational (`"synthetic"` or `"card"`) — nothing in the state machine
branches on it. On intake the file is *moved* (not copied) into `journal/<id>/task.json`, which
is both how a polling daemon avoids reprocessing it and what `queue depth` in `spo status`
counts.

## Fixture format

Every scripted or LLM step consults `task.shadow` instead of spawning or calling out. Two
value shapes, per key:

- **scalar** (number / string / boolean / object) — returned unchanged on every call to that
  key, for the life of the task.
- **array** — consumed one element per *call* to that key (a per-key cursor, not a per-state-
  visit one: e.g. `prWait` is read up to twice within a single MERGE visit — the initial wait
  and its one bounded re-wait — while `gate` is read once per GATE-state visit across the whole
  task, however many retries that takes). Once exhausted, the last element repeats — fixtures
  should be sized to the exact number of calls a scenario needs; the repeat is a defensive
  default, not something to rely on.

A missing key or an explicit `null` falls back to a per-step default (usually "pass" / no
fixture-triggered branch — see `orchestrator/state-machine.js` for the exact default per
state).

Recognized keys:

| key | meaning | shape |
|---|---|---|
| `nightlyMainRed` | refuse WORKTREE / refuse a main-moved merge | boolean |
| `worktree`, `check`, `pushPr`, `finish`, `prMergeEnqueue` | exit code for that scripted step | number (0 = success) |
| `gate` | `npm run gate` exit code: 0 PASS · 1 fail · 2 dirty · 3 worker down · 4 timeout | number |
| `ciChecks` | the one failing CI check name this CI_CHECKS visit, or falsy for green. Two shapes, both live: a bare string (legacy; routes EVERY check name to DIAGNOSE, since it carries no step info) or `{check, step}` (action 4.3, `state-machine.js`'s `resolveShadowCiChecks`; the step is what actually lets routing reach `IMPLEMENT` or `pr-rules-needs-approval` at all) | string \| null \| `{check, step}` |
| `mainMoved` | whether `origin/main` touched the branch's files this CI_CHECKS visit | boolean |
| `prWait` | `pr:wait` exit code: 0 merged · 1 closed unmerged · 4 still open (bounded re-wait) | number |
| `llm.PLAN`, `llm.IMPLEMENT` | step payload; any object with `ok !== false` succeeds | object |
| `llm.DIAGNOSE` | `{ "rootCause": "…" }` | object |
| `llm.CITATION_VERIFIER` | `{ "verdict": "PASS" \| "REJECT" \| "DIVERGES" }` (only consulted when `task.touchesRdoMembers` is true) | object |
| `llm.VALIDATE` | `{ "verdict": "PASS" \| "PASS_WITH_FINDINGS" \| "REJECT" }` | object |
| `delays.<STATE>` | artificial ms delay before an LLM step returns (`delays.PLAN`, `delays.IMPLEMENT`, `delays.DIAGNOSE`, `delays.CITATION_VERIFIER`, `delays.VALIDATE`), for the deadline test | number |
| `delays.<fixtureKey>` | same mechanism for a **scripted** step, but keyed on its fixture key, not its state name: `delays.worktree`, `delays.check`, `delays.pushPr`, `delays.gate`, `delays.prMergeEnqueue`, `delays.prWait`, `delays.finish` — `delays.WORKTREE`/`delays.CHECK`/`delays.PUSH_PR`/etc. are silently ignored (`steps/scripted.js` reads `delays.${fixtureKey}`, never the state name) | number |
| `forceState` | INTAKE returns this state name instead of `WORKTREE` — a test-only hook for exercising the unrecognized-state catch-all | string |

Example (from the spec):

```json
"shadow": {
  "gate": [1, 0],
  "prWait": [4, 4],
  "ciChecks": ["Coverage of changed lines"],
  "mainMoved": false,
  "llm": {
    "PLAN": { "ok": true },
    "DIAGNOSE": { "rootCause": "flaky-timeout" },
    "VALIDATE": { "verdict": "PASS" }
  }
}
```

## Budgets

`config.js` ships five budget counters in total (`diagnoseBudget`, `validateRejectBudget`,
`transientRetryBudget`, `ciRetryBudget`, `mainMovedRegateBudget`); the two below are the
per-task retry budgets this section is about, both journaled and both visible in `state.json`:

- **DIAGNOSE → IMPLEMENT retries**: `diagnoseBudget` (default 3) attempts total; any root
  cause seen twice for the same task parks immediately, even under budget. One line per
  attempt in `ledger.md`: `attempt N | root cause | outcome`.
- **VALIDATE REJECT**: `validateRejectBudget` (default 3), separate from the above — a REJECT
  verdict from `change-validator` retries straight to IMPLEMENT, no DIAGNOSE call. Its own
  ledger line uses a distinct `kind` so it's never confused with a DIAGNOSE attempt:
  `validate-reject N | <reasons> | outcome`. A REJECT's `reasons`/`findings` are also threaded
  into the next IMPLEMENT's `{{diagnosis}}` placeholder (action 1.6) — `task-values.js`'s
  `diagnosisSummary` reads back whichever of a DIAGNOSE finding and a VALIDATE reject was
  journaled most recently as the primary line, and still shows the other (if any) for context,
  clearly attributed to its own state so IMPLEMENT can tell "a check/gate/CI failed" apart from
  "the change was built and the validator rejected it".

**The bounds this pipeline actually enforces**, beyond the two retry budgets above, are three
wall-clock ceilings and (outside the daemon) a supervised harness's own caps:

- `config.js`'s `commandTimeoutsMs` (git 120000ms, gh 120000ms, npm-ci 600000ms,
  npm-gate 7800000ms, npm-run 660000ms, bench-install 900000ms) — `spawnSync`'s own `timeout` option, armed per call by
  `steps/scripted.js`'s `spawnStep`. This is the bound that actually fires against a hung
  `git`/`gh`/`npm` child; see `doc/state-machine-spec.md`'s design consequence #3 for why two
  mechanisms exist and how they interact.
- `config.js`'s `stepDeadlineMs` (default 120000ms / 2min) — `deadline.js`'s `callWithDeadline`,
  the outer retry-once-then-park bookkeeping race wrapped around every step, scripted or LLM. It
  is a JS timer, not a process kill, so it cannot preempt a blocking `spawnSync`: it is a no-op
  against a scripted step's commands (`commandTimeoutsMs` above is what actually fires there)
  and, in real mode, equally inert around an LLM step (bounded instead by
  `LLM_STEP_DEADLINE_MS` below). The generic 120000ms default is live only in shadow mode, where
  an LLM step has no blocking `spawnSync` underneath it and a fixture delay races this 120s timer
  instead of the 900000ms figure below (`doc/state-machine-spec.md` § Step contracts) — but
  `deadline.js`'s `deadlineMsFor` consults `config.stepDeadlineMsByState[state]` before falling
  back to this default, and that override IS live in real mode: `config.js` gives `CI_CHECKS`,
  `WORKTREE` and `FINISH` their own, much larger entries (derived from the in-flight poll budget
  and the product-repo mutex's own worst-case wait). `WORKTREE`/`FINISH`'s overrides were sized
  "large enough never to fire" against a purely-synchronous `spawnSync` body, but 6.4's
  product-repo mutex added the first `await` in that path (its poll loop's `await sleep(pollMs)`)
  — which armed a timer that had never been live before. Measured during 6.4's own verification:
  with a holder still inside the critical section, the timer fired for real, parking
  `step-deadline-exceeded-twice` and leaving an orphan worktree behind (`deadline.js`'s
  `withTimeout` abandons the loser rather than cancelling it, so the abandoned invocation kept
  running alongside its own retry). See `config.js`'s own comment on `stepDeadlineMsByState` for
  the full incident and the derivation.
- `step-contracts.js`'s `LLM_STEP_DEADLINE_MS` (900000ms / 15min) — the `spawnSync` timeout
  `invokeClaudeReal` arms for every LLM step call (PLAN, IMPLEMENT, DIAGNOSE,
  CITATION_VERIFIER, VALIDATE), uniformly regardless of task size or model, in real mode.
- `orchestrator/recette.js`'s supervised live harness carries its own two caps, independent of
  the daemon's: `--cap-ms` (default 45 minutes wall clock) and `--cap-llm-steps` (default 12),
  either of which aborts the run rather than let a synthetic card run unbounded.

**A per-call USD cap is deliberately not one of these bounds.** `maxBudgetUsd` exists in the
plumbing (`step-contracts.js`, `orchestrator/intake.js`, `steps/llm.js`'s conditional
`--max-budget-usd`), but no daemon or intake path sets it — the only caller that does is the
hand-run `scripts/smoke-llm.js` (§ Manual smoke test below). Dollars were retired as a spend
metric on 2026-08-31 in favour of `spo tokens`'s billable-weighted token counts. The runaway that
motivated the question — `journal/issue-385/journal.jsonl`'s IMPLEMENT step at 134 turns
(2026-08-29T19:56:12.256Z–20:09:48.785Z, 816s elapsed) — was **not** stopped by
`LLM_STEP_DEADLINE_MS`: it was stopped by the per-call `--max-budget-usd` cap still in force that
day (`costUsd: 5.0621632`, `terminalReason: "budget_exhausted"`). `LLM_STEP_DEADLINE_MS` (900s)
was already armed at the time (commit `3e8104b`, same day) and did not fire — the cap ended the
call about 84s before the deadline would have taken over. That does not reopen the decision: a
cap only ever produces `terminalReason: "budget_exhausted"` because `--max-budget-usd` was
passed, and since no production path sets it any more (the caps were removed the next day,
commit `2621aad`), that terminal reason cannot recur.

## Real mode

`orchestrator/steps/llm.js` has a real implementation behind the same interface shadow mode
uses (`runLlm(ctx, stepName, fixtureKey)`), plus a lower-level primitive,
`invokeClaudeReal(opts, deps)`, that does the actual spawn + parse:

```js
const { invokeClaudeReal } = require('./orchestrator/steps/llm');

const result = await invokeClaudeReal({
  step: 'PLAN',
  model: 'haiku',                 // or a full model name; anything `claude --model` accepts
  effort: 'low',                  // low | medium | high | xhigh | max
  maxBudgetUsd: 0.10,             // hand-written caller only -- no production path sets this, see § Budgets
  promptText: 'Reply with exactly the single word: ok',
  cwd: '/home/crazz/SPO-Pipeline',
  account: { name: 'default', configDir: null },
  allowedTools: 'Read Grep',      // optional
  permissionMode: 'plan',         // optional
  jsonSchema: { type: 'object' }, // optional
  deadlineMs: 120000,             // optional -- see "deadline handling" below
});
// -> { ok: true, result: 'ok', sessionId: '...', tokensSource: 'modelUsage', freshInputTokens: 120,
//      cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 8, billableTokens: 128,
//      cacheCreationEphemeral1h: 0, cacheCreationEphemeral5m: 0, numTurns: 1, raw: 0 }
```

> **The `cacheCreationEphemeral1h` / `cacheCreationEphemeral5m` split is not available from this
> source.** It is read best-effort from a nested `cache_creation` object on `modelUsage`, and
> `modelUsage` has never been observed to carry one — a real smoke run against the live CLI came
> back `0`/`0` while the flat counts were correct (fresh 910, cache-creation 8904, cache-read
> 21478, output 50). The **only** place this repo has seen the split is the session JSONL's own
> `message.usage.cache_creation` block, which would need a join by `sessionId` to reach. Read
> these two fields as **structurally 0**, not as "no ephemeral cache was written" — nothing in
> the pipeline consumes them today (`spo tokens` never prints them, `orchestrator/tokens.js`
> never reads them), and the `likelyCacheExpiry` signal below deliberately does **not** depend on
> them: it uses the inter-call gap plus the flat cache-creation-vs-cache-read counts, which are
> real.

It spawns `claude -p --model <model> --effort <effort> --output-format json` (plus
`--allowedTools`/`--permission-mode`/`--json-schema`/`--max-budget-usd` when given — no daemon
or intake path supplies `maxBudgetUsd`; the only caller that does is the hand-run
`scripts/smoke-llm.js`, see § Budgets) with
the resolved prompt written to the child's stdin — never as an argv entry, since Linux caps each
individual argv string at `MAX_ARG_STRLEN` (128KB) and a large filled prompt (a big plan/diff/
criterion) would fail the spawn with `E2BIG` before `claude` ever started (reproduced on card
#452's ~200KB IMPLEMENT prompt). It parses the JSON on stdout, extracts token counts (fresh
input, cache-creation, cache-read, output -- `extractTokens`, defensive across both snake_case
and camelCase `modelUsage` key spellings, since that field is produced by the `claude` CLI and
never appears in the session JSONL to verify against) summed across every entry of `modelUsage`
-- no dollar figure is computed anywhere (maintainer decision, 2026-08-31: the pool is a Claude
Max quota, never metered API billing) -- and classifies a
failure as `{kind: 'limit'}` or `{kind: 'error'}` via `classifyFailure` (action 3.5, 2026-08-31 —
replacing a `/limit|overloaded|rate/i` scan over the free text of `result`/`terminal_reason` that
misclassified any message merely containing "rate" — "invalid rate parameter", "could not
generate", "accurate output required" — as a rate limit; expensive, because `callLlmStep`'s
response to `'limit'` is to rotate to the next account, re-paying the whole step, and once the
pool is exhausted cool *every* account for hours). `'limit'` now requires a **structured**
signal, never a substring test:

- `api_error_status === 429` (the definitive rate-limit status, **observed**: the only recorded
  real limit in this repo, `intake.js:797-799`'s 12.8-hour Fable incident — "You've reached your
  Fable 5 limit", `api_error_status=429`, 53 consecutive auto-triage cycles / 128 attempts) or
  `api_error_status === 529` (Anthropic's documented "overloaded" status, **anticipated**: never
  observed as a real reply in this repo), or
- `terminal_reason`, exact match (lowercased + trimmed) against an allowlist: `overloaded_error`
  (**anticipated** — pinned only by a pre-existing test, not a recorded reply), `rate_limit_error`
  (**anticipated** — the API's documented error type name for a 429, but that string itself has
  never been observed here; the Fable incident only ever recorded the numeric status), and
  `usage_limit_reached` (a plain **guess** — neither observed here nor a documented Anthropic
  error type, kept because an exact-match entry that never fires costs nothing).

Everything else is `'error'` — including an unrecognised limit-shaped message, which now PARKS
the task instead of rotating. That trade is deliberate: an unrecognised shape parking is one card
a maintainer retries, versus a false positive re-paying the step on every account and cooling the
whole pool. The failure result carries `terminalReason`/`apiErrorStatus` (and, on a `'limit'`
classification, `limitKind` — see below) and both are journalled with the step's `result`
payload, so an unrecognised limit shape leaves exactly the evidence needed to extend the
allowlist above as entries move from anticipated/guessed to actually observed — extend it from
that journal evidence, never from further guesswork about what a message might say. `deps.spawnSync`
is the test injection point — production code never passes it, so a real call always spawns the
real `claude` binary on `PATH`.

A `'limit'` result also carries `limitKind`, splitting *which* kind of limit it was so the
cooldown can match: `'usage'` (429 / `rate_limit_error` / `usage_limit_reached` — this
account's own quota is spent) vs. `'overloaded'` (529 / `overloaded_error` — the *server* is
busy, this account's quota is fine). The 429/529 half of that split is a single table
(`LIMIT_STATUSES`) consumed by both `classifyFailure` and `limitKindForFailure`, not two
separately-maintained checks — adding a status to one and not the other used to be possible and
would silently produce `kind:'limit'` with `limitKind: undefined` (the fail-safe long cooldown,
indistinguishable in the journal from a genuine limit). See "Account registry" below for what
each tier costs.

**Deadline handling**: the wall-clock budget is enforced by `spawnSync`'s own `timeout` option
(set from `deadlineMs`), not by `orchestrator/deadline.js`'s promise-race. That race can't
preempt a blocking `spawnSync` call — the single JS thread is inside it — and would otherwise
leave a killed step's `claude` process running unsupervised in the background. `deadline.js`
still wraps the whole call at the state-machine level (`callLlmStep`, see below) for its
existing "retry once, then PARK" bookkeeping; it just isn't what kills the child process.

**Account rotation**: `orchestrator/state-machine.js` exports `callLlmStep(ctx, stepName,
fixtureKey)`, used by every state that calls an LLM step (PLAN, IMPLEMENT, DIAGNOSE,
VALIDATE's citation-verifier and change-validator). In shadow mode it is identical to calling
`runLlm` directly. In real mode it picks a healthy account (`orchestrator/accounts.js`), and if
that call comes back `{kind: 'limit'}`, cools the account down (journaled as
`account-cooldown`) and tries the next one — one pass over the enabled accounts in the
registry, never a second lap. If `accounts.pick()` finds nothing healthy to begin with, or the
whole pass is exhausted, the task is PARKED (`all-accounts-cooling-until-<iso>` /
`all-accounts-cooling-after-retry`).

`orchestrator/intake.js`'s three LLM steps (draftCard, reviewCard, triageBugReport) play by the
same rule, via their own `callIntakeStepWithRotation` helper (plan action 3.6, 2026-08-31; fixes
the 2026-08-30/31 incident where a bare `accounts.pick()` re-picked the same rate-limited account
for 53 consecutive auto-triage cycles). Same pick/call/cool/rotate mechanics, bounded to one pass
over the pool — but intake never throws: exhausting the pool becomes `{ok: false, error}`, never
a `ParkSignal`, since every intake function's contract is "report a mechanical failure, never
crash." And since intake has no `ctx.taskDir` to journal into, a cooldown is returned on the
result's `cooldowns` array instead, for the CALLER to journal — `auto-triage.js` appends one
`report-triage-cooldown` event per cooled account (see its own header comment). The existing
one-retry-on-timeout discipline (same account, same deadline — a hang says nothing about account
health) is unchanged and composes cleanly: rotation only ever looks at the result *after* that
timeout retry has run its course on the current account. The two can chain in one direction — an
account times out, its same-account retry comes back `{kind: 'limit'}`, and *that* cools it and
rotates — so the hard bound on a single intake step is `enabled accounts × 2` `claude` spawns,
never more. A retry that ends in a rotation still carries its `retriedAfterTimeout` record out
(named by account), so the most expensive shape is not the one shape without a journal trace.

### Step contracts + prompt fill (the real `kind: "card"` path)

`runLlm`'s real branch has two sub-paths. If the task supplies `ctx.task.llm.<stepName>`
directly (model/effort/promptText/... — the shape the "Real mode" code sample above builds by
hand), that config is honoured verbatim: no template fill, no output-contract validation. This
is the legacy interim path, kept only so a hand-authored real-mode task file, or a raw
`invokeClaudeReal`-style call, still works; it is what `test/llm-real.test.js` and
`test/account-rotation.test.js` exercise.

A real **`kind: "card"`** task should *not* set `ctx.task.llm.<step>` — instead each LLM step's
model, effort, tools, permission mode, `$` budget and `--json-schema` come from
`orchestrator/step-contracts.js`'s table (one entry per orchestrator LLM step: PLAN, IMPLEMENT,
DIAGNOSE, CITATION_VERIFIER, VALIDATE — sourced from `doc/state-machine-spec.md` § Step
contracts, with `prompts/README.md`'s own per-step table consulted only where the spec is
silent; every place the two disagreed is a comment on the field it affects), and the prompt
itself is `prompts/<file>.md` with its declared `{{placeholders}}` filled by
`orchestrator/task-values.js` + `orchestrator/prompt-template.js`.

A card task's own fields:

```json
{
  "id": "card-123",
  "kind": "card",
  "issue": 123,
  "title": "Add a status badge to the header",
  "criterion": "the header shows a status badge reflecting connection state",
  "worktreePath": "/home/crazz/.spo-worktrees/card-123",
  "size": "S",
  "touchesRdoMembers": false,
  "escalate": false,
  "citations": ["ObjectAt — RDOObjectServer.pas:118 — function, 2 args"],
  "spoOriginalPath": "/home/crazz/SPO-Original"
}
```

`size` (`S`/`M`/`L`) drives effort for PLAN/IMPLEMENT (`step-contracts.js`'s
`EFFORT_BY_SIZE`; there is no per-size budget table — see § Budgets); `touchesRdoMembers` is the RDO wire-rule escalation flag
for IMPLEMENT and VALIDATE (never PLAN — see the comment on `step-contracts.js`'s
PLAN entry); `escalate` is the generic "Opus 5 fallback" override every step but DIAGNOSE and
CITATION_VERIFIER can read; `citations`/`spoOriginalPath` only matter to CITATION_VERIFIER, and
only when `touchesRdoMembers` is true. `citations` in the JSON above is shown as a hand-set task
field for illustration, and a maintainer-supplied value there does still win, but in practice
nothing sets it at intake: `steps/scripted.js`'s `realPushPr` is what actually populates it, from
the real `git diff` against `origin/main` on `src/shared/rdo-members.ts` (falling back to the
task's own `criterion` text), the moment PUSH_PR runs — see the placeholder-derivation bullets
below.

Each prompt's `{{placeholder}}` values come from one of two places
(`orchestrator/task-values.js`):

- **known at build time** — read straight off the task or `ctx.taskDir`:
  `{{issue_number}}`/`{{task_title}}`/`{{task_criterion}}`/`{{worktree}}`/`{{task_size}}` from
  the task fields above; `{{scratch_dir}}` = `journal/<id>/scratch`; `{{ledger_path}}` =
  `journal/<id>/ledger.md` (the file `journal.js` already owns); `{{spo_original_path}}`
  defaults to `~/SPO-Original`.
- **unknown at build time** — produced by an *earlier* state and read back from that state's own
  journaled event (`handlePlan` already does
  `appendEvent(ctx.taskDir, 'PLAN', 'result', { payload })` — `task-values.js` is the reader
  side of that same record): `{{plan_path}}`/`{{invariants_path}}`/`{{invariant_ids}}`/
  `{{check_commands}}` feed IMPLEMENT, and `{{invariants_path}}`/`{{invariant_ids}}` feed
  VALIDATE, both from PLAN's own LLM output. `{{citations}}` is the same idea one state earlier,
  from a *scripted* step instead of an LLM call: `realPushPr` journals
  `{state: 'PUSH_PR', event: 'rdo-citation', citations}` and also sets `ctx.task.citations` in
  memory for the same run's VALIDATE to read directly; `task-values.js` prefers the in-memory
  value and falls back to the journaled record so a daemon restart between PUSH_PR and VALIDATE
  (`ctx.task` rebuilt from the task file, the in-memory field gone) doesn't silently drop it.
- `handlePlan` also journals a `{state: 'PLAN', event: 'invariants-baseline', ...}` record right
  after writing `invariants-<issue>.md` (action 1.8 — see "Invariant substring check" under "Real
  scripted steps" below for the full contract); it feeds no prompt placeholder, only
  `steps/scripted.js`'s `realCheck`, which reads it back via `task-values.js`'s
  `lastInvariantsBaseline`.
- `{{diff_path}}` / `{{gate_log_path}}` / `{{gate_report_path}}` are fixed
  `journal/<id>/{diff.patch,gate.log,gate-report.md}` conventions. Action 1.3 made these real:
  `steps/scripted.js`'s `prepareJudgeInputs` generates `diff.patch` (and, when the bench has a
  verdict for the current HEAD sha, `gate-report.md`) on entry to DIAGNOSE/VALIDATE in real
  mode, before the LLM call; `realGate` writes `gate.log` itself, overwriting it on every real
  gate run so it always holds the LAST run only (unlike `logs/GATE.log`'s own accumulating
  append). VALIDATE requires `diff.patch` and parks `judge-inputs-missing` if it cannot be
  produced; DIAGNOSE requires `gate.log` only when it was entered from GATE, never otherwise —
  see `doc/state-machine-spec.md`'s DIAGNOSE row.

**Action 3.1 — PLAN reuse on retry.** `handlePlan` is the one LLM step that can skip its own
`claude -p` call entirely. On a maintainer's `retry` after a park, INTAKE restarts the task from
scratch and WORKTREE creates a fresh worktree off the current `origin/main` — but the plan and
invariants files a *previous* run's PLAN wrote under `journal/<id>/scratch/` are still sitting on
disk, keyed by task id, never cleaned between runs. `decidePlanReuse` (`state-machine.js`) decides
whether that plan is still safe to reuse instead of paying for PLAN again, checking, in order:
(0) `isRealMode(ctx)` — shadow mode and `--dry-run` are excluded by an explicit, first check, not
merely as a side effect of condition 1 never passing without a real `realWorktree` run; (1)
`ctx.task.baseMainSha` is set — only real mode's `realWorktree` sets it (see "Real scripted steps"
below); (2)/(3) the journal's last PLAN `files-written` event carries a `baseMainSha` that matches
this run's — `origin/main` hasn't moved since the plan was written; (4) `planPath`/`invariantsPath`
from that event still exist on disk, are regular files, and are non-empty — the existence check is
wrapped so a file vanishing between the check and the stat can never throw out of `decidePlanReuse`
and kill the daemon; (5) a PLAN `result` event with a payload exists *and that payload is not
itself a failure* (`payload.ok !== false`) — a transport-failure payload (action 1.4) carries none
of `plan_path`/`invariants_path`/`invariant_ids`/`check_commands`, so IMPLEMENT/VALIDATE would have
nothing safe to read even though "a payload exists"; (6) the most recent `parked` event, if any, is
not one of the seven reasons that indict the plan itself (`plan-invalid`,
`plan-requires-protected-files`, `diagnose-duplicate-root-cause`, `diagnose-no-new-cause`,
`diagnose-budget-exhausted`, `validate-reject-budget-exhausted`, `ci-retry-budget-exhausted`) —
every other park reason (a
transport failure, a gate/CI failure, a lost claim, a merge conflict) is orthogonal to whether the
plan was right, and does not block reuse. On reuse, PLAN journals `plan-reused`, re-journals
`files-written` and `result` (the previous payload with `plan_path`/`invariants_path` stamped
explicitly from what condition 4 just verified on disk — not merely trusted to already be on
`previousPayload` — plus `reused: true`, so `lastResultPayload`'s "last PLAN result wins"
convention still resolves to the right paths even after a mid-run daemon restart left an earlier,
markdown-only `result` event as the one on disk), still rebuilds the action-1.8 invariants baseline
fresh against the retried worktree (reuse is a bet on the plan *text*, not on which invariants
currently resolve in a tree nobody has re-checked), and returns `IMPLEMENT` — `callLlmStep` is
never reached.

**Action 3.2 — protected-files guard.** CLAUDE.md documents a hard wall: `.claude/settings.json`
and anything under `.claude/hooks/` are refused by the harness as sensitive files no matter what
this repo's own permission rules say, so a plan that requires editing either of them cannot
succeed. Card #428 proved that the expensive way — a plan whose own text required a hook edit,
discovered only when IMPLEMENT paid full price attempting it, $12.01 burned before it parked
anyway. `orchestrator/intake.js`'s `detectProtectedFiles(text)` is the detector: a pure,
deliberately blunt, case-insensitive, POSIX-only substring scan for `.claude/settings.json`,
`.claude/settings.local.json`, and any path under `.claude/hooks/`, returning up to 5 matches
(each `{ path, line }`, both capped at 200 chars — the `path` cap exists because an uncapped match
goes verbatim into a GitHub comment body via `park-loop.js`'s `JSON.stringify(detail, null, 2)`,
and GitHub's 65536-char cap would otherwise make `gh issue comment` fail and the card park
uncommented) rather than throwing or growing unbounded. Every hit parks the single reason
`plan-requires-protected-files` (already listed among action 3.1's `PLAN_INVALIDATING_PARK_REASONS`
above, so a plan that trips this guard is never eligible for reuse), distinguished by a `source`
field in the detail, from **two** call sites, both of them in `handlePlan` and both going through
the one function `guardDeclaredFiles`:

- **`handlePlan`, normal path**, `source: 'files_to_change'` — scans PLAN's structured declaration
  of which files it intends to change (`prompts/plan.md`). This is the site the guard exists for:
  it stops the spend before IMPLEMENT is ever paid for. Since **#118** (2026-09-05) it runs
  *after* `plan-<issue>.md` and `invariants-<issue>.md` are written and `files-written` is
  journalled, and still *before* the action-1.8 invariants baseline — so a parked card leaves the
  plan on disk for a human to pick up (SPO-Pipeline#31's own criterion, unmet until then; the park
  detail carries `planPath`/`invariantsPath`) while never paying for the baseline. Writing first
  does not make the plan reusable: `plan-requires-protected-files` is plan-invalidating, so
  `decidePlanReuse`'s condition 6 refuses it.
- **`handlePlan`, reuse path**, `source: 'files_to_change'` with `reused: true` — the same scan
  over the carried-forward `previousPayload.files_to_change`, before the baseline rebuild. See the
  end of this section for why it exists again.

**`handleIntake`'s prose scan (`source: 'criterion'`/`'title'`) was REMOVED by #118.** For a
`kind: "card"` task it used to scan the card's own criterion and title before anything else in
INTAKE ran, parking at zero cost. Measured across the whole journal corpus, that site fired
exactly once — on Crazz-Org/SPO-WebClient#482, the card written to report that the PLAN-side guard
had never run, whose acceptance criterion *quotes* `.claude/settings.json` and `.claude/hooks/*.sh`
as the examples a working guard must catch. One firing, one false positive, zero true positives:
the guard refused the card that repairs it. Prose cannot distinguish "EDITS this file" from "CITES
this file" — the identical argument, and the identical measurement, that had already retired the
`plan_markdown` scan below. What it costs: the rare card whose human-written criterion genuinely
names a protected path now pays one PLAN call before parking instead of parking free at INTAKE.

**Why not scan `plan_markdown` (the original design).** The first cut of this guard scanned the
model's free-prose `plan_markdown` at this same site. Measured against all 17 real plans in
`journal/*/scratch/plan-*.md`, that scan fired 3 times — 1 true positive (#428) and 2 false
positives, both already-`DONE` cards: issue-418's plan text *asserts* a hook is **absent**
(`` `.claude/hooks/context-router.sh:117`. That file does not exist ``, with a check command
`! test -e .../.claude/hooks/context-router.sh`), and issue-429's *cites*
`` `.claude/settings.json:109-127` `` as evidence, never proposing to touch it. 33% precision, and
not bad luck — structural: `prompts/plan.md` instructs PLAN to emit "a falsification sweep: one
search command per claim in `doc/`, `.claude/`, or `CLAUDE.md`", and SPO-WebClient's `CLAUDE.md` —
fed to every PLAN call as domain context — itself contains matches, including the heading
``## Automation (`.claude/hooks/`)``. Prose can never distinguish "my plan EDITS this file" from
"my plan CITES this file", and the pipeline's own prompt demands citations. `files_to_change` is
the fix: `prompts/plan.md`'s own "which files" statement, lifted out of the prose into a form the
driver can check mechanically, documented there as files the plan will *change* — never files it
merely reads, cites as evidence, or asserts the absence of.

`files_to_change` is deliberately declared but **not** `required` in `step-contracts.js` (see that
file's own comment) — promoting it would park every card whose PLAN reply omits the new key, on a
live pipeline, before a single real card has exercised it. **#118 (2026-09-05): the wire shape is
a JSON-encoded string, and for a year the guard did not know it.** The shape test was
`Array.isArray(files_to_change)`, and 93 of the 93 real PLAN replies that carry the field deliver
it as `"[\"/abs/path\", ...]"` — a string — so the scan sat in an unreachable `else if` and
action 3.2 had never once run on a live card (44 journalled `plan-files-undeclared
{receivedType: "string"}` events are the fail-open record; nothing was lost only because 0 of the
809 declared paths in that corpus name a protected file). `guardDeclaredFiles` now normalizes
through `park-loop.js`'s `normalizeFindingsPayload` — the parser VALIDATE's identically-shaped
`findings` already needed — so an array and a JSON string holding one are both declarations. When
the field is absent, `null`, an object, a bare unparsable string, or a list containing a
non-string entry, `handlePlan` does **not** park and does **not** fall back to scanning
`plan_markdown` — that would reinstate the 33%-precision behaviour
this revision exists to remove. It journals a `PLAN`/`plan-files-undeclared` event instead, with
what was actually received (`receivedType` unchanged from before #118 so the events already on
the record stay comparable, plus `shape` — the normalizer's own verdict, which is the only thing
that tells `unparsable-string` from `json-string-object`, both of them `typeof 'string'` — and a
capped sample) — the evidence promotion to `required` will eventually be made from. An empty array is treated as a real declaration ("this plan changes
nothing already on record"), not as undeclared: no park, no event.

**What this guard is actually worth — stated honestly.** Nothing cross-checks `files_to_change`
against reality: a model that declares `[]`, omits the key, or emits a malformed value walks
straight past the guard with no park and no scrutiny of what it actually intends to touch, and
`files_to_change` is load-bearing nowhere else in the pipeline — IMPLEMENT's own `files_changed`
is never compared against it. So this guard does **not** prevent protected-file work; a model that
wants to touch `.claude/hooks/` and simply doesn't declare it gets straight through. Its real worth
is narrower: it makes the *honest* case cheap. #428 was honest — its plan's own section headings
named the two hook paths outright — and a guard scanning the structured declaration catches that
case before IMPLEMENT spends a cent, which is exactly the $12.01 it would otherwise have cost. Two
changes would make the guard real rather than best-effort: promoting `files_to_change` to
`required` once the journal shows PLAN reliably emitting it (see the `plan-files-undeclared`
evidence-gathering above), and cross-checking IMPLEMENT's own `files_changed` against the plan's
declaration after the fact. Neither is implemented. Do not oversell this guard's coverage
elsewhere in these docs either.

**The reuse-path site, removed once and restored by #118.** It was deleted on a measurement (every
`files-written` event then in the corpus carried `baseMainSha: undefined`, so `decidePlanReuse`'s
condition 2 filtered them all out) *and* an argument: any plan written from then on that tripped a
site would park `plan-requires-protected-files`, itself plan-invalidating, so a dirty plan could
never reach reuse. The measurement aged out — plans written since action 3.1 do carry
`baseMainSha` — and the argument assumed a guard that worked. It did not: every plan written
between action 3.2 and #118 passed through an `Array.isArray` test that rejected its own wire
shape, so the corpus holds 93 plans whose declarations were never judged, each one `retry` away
from being reused straight into IMPLEMENT. The site is back, sharing `guardDeclaredFiles` with the
normal path, and the invariant it restores is worth stating plainly: **no plan reaches IMPLEMENT
without its declared file list having been read at least once.**

A missing value for any placeholder a prompt's header declares — PLAN called before
`worktreePath` is set, IMPLEMENT called before PLAN has run, or any other gap — throws
`prompt-template.js`'s `MissingPlaceholderError`, caught in `runLlm` and re-thrown as
`ParkSignal('prompt-missing-placeholder:<name>', { promptFile, placeholder, missing })`: the
task parks, it never sends a prompt with a bare `{{...}}` still in it. Fill is all-or-nothing —
one missing placeholder blocks the whole call, never a partial substitution.

A successful reply's `result` string is `JSON.parse`d and checked against the step's
`outputContract.required` (`in` check, so a legitimately-`null` field like DIAGNOSE's
`root_cause` still counts as present); a missing key returns the same `{ok: false, kind:
'error'}` shape `invokeClaudeReal` itself uses for a spawn/parse failure. Action 1.4
(`state-machine.js`) routes every such transport-shaped failure (`kind: 'error'`, or
`timedOut: true` from a deadline kill) to its own `ParkSignal('llm-transport-failed:<STEP>',
...)` — PLAN, IMPLEMENT, DIAGNOSE, and VALIDATE's change-validator each get a distinct reason
naming the step, so a call that never reached the model is never mistaken for one the model
answered badly (see `doc/state-machine-spec.md`'s per-step rows). `kind: 'limit'` is excluded —
that is the account-rotation retry path, unrelated. The validated payload is also given a
snake_case→camelCase alias of every key (`root_cause` → `rootCause` too, additively — this is
the one step whose contract key differs from what `state-machine.js`'s handlers already read;
every other step's key names matched by coincidence). Action 1.5 makes `handleDiagnose` honour
the `root_cause: null` half of that contract explicitly: a present-but-null `root_cause` means
"no cause beyond what the ledger already has" and parks `diagnose-no-new-cause` (ledger line
still written), instead of the old behaviour of silently fabricating a unique
`unspecified-cause-N` and burning another IMPLEMENT retry on it.

### --dry-run

`node orchestrator/daemon.js --dry-run --once [--queue <dir>] [--journal <dir>]` runs real-mode
semantics — step-contracts.js resolution, prompt-template.js fill, account rotation — **without
spawning anything**. `runLlm` (steps/llm.js) and `runScripted` (steps/scripted.js) both check
`ctx.dryRun` immediately before their own spawn point:

- an **LLM step** builds the real prompt and the real argv (via the same `buildArgv` real mode
  uses), writes both to `journal/<id>/dryrun-<STATE>.md` (the argv — just the flag line, since
  the prompt itself travels on stdin, not argv — then the filled prompt in full underneath),
  journals a `dry-run` event (never `llm-call`), and returns a minimal
  `outputContract`-satisfying payload marked `{dryRun: true}` — enough to walk the state machine
  forward, never a stand-in for a real judgement. PLAN's canned `plan_path`/`invariants_path`
  use the same `{{scratch_dir}}/plan-<issue>.md` convention a real PLAN call would have produced
  (not `null`) — IMPLEMENT and VALIDATE's own dry-run calls, later in the same walk, read those
  paths back out of the journal exactly like a real run would, and a `null` would incorrectly
  park them as "missing".
- a **scripted step** (WORKTREE, CHECK, PUSH_PR, GATE, MERGE, FINISH) returns a fixture-free
  `{exit: 0, stdoutTail: '[dry-run] <key> -> assumed success'}` — no fixture consulted, no
  command run. This is `--dry-run`'s own branch inside `runScripted`; it is separate from (and
  checked before) the real per-state functions in "Real scripted steps" below, which is what
  `--real` dispatches to instead.

`--dry-run` is ignored if `--shadow` is also passed (shadow wins). `test/dry-run-demo.test.js`
walks a synthetic `kind: "card"` task through the full lifecycle this way and asserts on the
final `DONE` state, the three `dryrun-{PLAN,IMPLEMENT,VALIDATE}.md` files (DIAGNOSE and
CITATION_VERIFIER are never reached on a happy path), and that `dryrun-PLAN.md` shows the real
argv flags and the filled prompt.

### Account registry

**One place holds account information (maintainer decision, 2026-08-29): the pool directory
itself.** `orchestrator/accounts.js` discovers accounts by listing the pool directory's
subdirectories — there is no `accounts.json` to keep in sync, and no implicit fallback to
whatever `claude` login happens to be ambient on this machine. Default pool directory:
`~/.claude-accounts` (machine-level, deliberately outside this repo), overridable with the
`SPO_ACCOUNTS_DIR` env var (`orchestrator/config.js`'s `claudeAccountsDir`) or, as every
`accounts.js` function already does, an explicit first argument (tests point this at a temp
dir). Full guided procedure: `doc/setup.md` § Accounts.

```
<poolDir>/<name>/          one directory per account — this IS the account's CLAUDE_CONFIG_DIR
  oauth-token               optional: the long-lived token `claude setup-token` prints, pasted
                             here by the operator
  disabled                  optional marker file (content ignored) — its presence disables the
                             account
<poolDir>/state.json        machine-written, runtime cooldowns: {accountName: {cooldownUntil:
                             epochMs, lastUsageLimitAt?: epochMs, usageLimitStreak?: int}}.
                             Disposable — deleting it clears every cooldown (and escalation
                             streak with it).
```

A pool directory with zero subdirectories registers zero accounts: `accounts.pick()` throws a
typed `NoAccountsRegisteredError` (`state-machine.js` maps it to PARKED, same as
`AllAccountsCoolingError`), and `daemon.js --real` refuses to even start.

**Cooldown duration — an escalating probe, not a flat number (action 3.5, 2026-08-31 redesign).**
This action's own first cut used a flat 5-hour cooldown for every usage limit. A verifier caught
why that was wrong before it shipped: the real pool has **2 accounts**
(`~/.claude-accounts/pool1`, `pool2`), and at the time `daemon.js` had no pool-health gate
anywhere — with `maxAttempts` equal to the pool size, two usage limits landing inside one window
took the *whole pool* down for up to 5 hours, parking every card the daemon pulled during that
window at its first LLM step, each needing a manual `retry` comment. (Chantier 6 action 6.3 later
closed that gap — see "How much the daemon takes on at once" below for the dispatcher's own
healthy-accounts clamp, which this cooldown redesign does not depend on and is unaffected by.) And the figure itself over-waits by
construction: the Claude Max session window resets 5h after the *session's first message*, not
after the limit hit, so `now + 5h` sleeps for (5h − the true remaining wait) longer than
necessary — often 4h+. The problem a long cooldown was solving is real but small: at a 1-hour
cooldown, an account that comes back gets picked, immediately re-limits (the window hasn't
actually rolled), and pays one wasted call. That is not worth a 5-hour outage across the whole
pool to avoid.

So `accounts.markLimit(poolDir, name, limitKind, now)` runs an escalating **probe** instead of
picking one flat number, and — because the decision now needs the account's own history, which
only a read of `state.json` can supply — the policy lives entirely inside `markLimit` itself
(there is no more separate `cooldownMsForLimitKind(limitKind)` pure function; both real call sites
simplified to `accounts.markLimit(accountsDir, account.name, result.limitKind)`):

- **`'usage'`, first hit (or one outside the escalation window of the account's last usage hit) →
  1 hour** (`accounts.USAGE_PROBE_COOLDOWN_MS`). A probe, not a claim that the window is over: if
  it comes back too early, the cost is one wasted call — the same cost the old flat 1-hour default
  always had.
- **`'usage'`, landing again within `accounts.ESCALATION_WINDOW_MS` (2 hours) of the account's
  last usage hit → 5 hours** (`accounts.USAGE_ESCALATED_COOLDOWN_MS`). The probe just proved the
  session window really is still open, so wait out the real observed Claude Max session window
  instead of probing hourly into a wall. Two hours, not one, because the earliest a probe can
  possibly come back and re-limit is right at its own 1-hour expiry (`daemon.js`'s default
  `pollIntervalMs` is 5s, negligible on its own) — the extra hour absorbs scheduling slack from a
  busy pool (other queued cards ahead of it, step deadlines, timeout retries) without becoming so
  wide that a hit on a genuinely fresh session (the same account limiting again the next day, say)
  gets mistaken for a continuation of the same exhausted one.
- **`'overloaded'` → 5 minutes** (`accounts.OVERLOADED_COOLDOWN_MS`), flat, **never escalates**,
  and never touches the usage-escalation fields above. A busy *server* (529 / `overloaded_error`)
  says nothing about this account's own quota, so nothing about it should compound the way
  repeated usage hits do.
- **An absent/unrecognised `limitKind`** (anything that isn't exactly `'usage'` or `'overloaded'`)
  falls back to the usage flow above (probe or escalated, by the same history check) — fail-safe:
  cool at least as long as a real usage hit would, rather than risk immediately re-hammering a
  still-limited account. `state.json` written by pre-3.5 code (bare `{cooldownUntil}`, no
  `lastUsageLimitAt`/`usageLimitStreak`) reads back the same way: no history on record, so it
  probes fresh at 1h — never throws, never misbehaves.

The CLI never actually supplies a retry-after hint on any path — `invokeClaudeReal` doesn't set
one — so there is no "use the server's hint, else default" branch here; it's always the escalation
decision above. `markLimit`'s returned event payload (journalled as `account-cooldown` by
`callLlmStep`, or returned on `cooldowns` by `callIntakeStepWithRotation`) is `{account, limitKind,
cooldownMs, cooldownUntil, cooldownUntilIso, escalated, defaulted}` — `limitKind` is the value
`markLimit` was called with (`null` when absent, never swallowed), `escalated` is true exactly
when the 5-hour tier fired, and `defaulted: true` means the value passed as `limitKind` wasn't
`'usage'` or `'overloaded'` and the usage-tier fail-safe applied. Before this action's R2 fix,
`cooldownMsForLimitKind` returned a positive number for *every* JS value (`null`, `{}`, `NaN` all
verified → the long tier), so `defaulted` was structurally always false in production and the
journalled event carried no `limitKind` at all — the one case the fallback exists for (a limit
shape `classifyFailure` recognizes that isn't in a `limitKind` bucket) was indistinguishable from
a genuine 429/529 in the journal. Both are fixed now.

Exhausting the whole pool inside one rotation loop (`callLlmStep`, or `intake.js`'s
`callIntakeStepWithRotation`) never re-calls `accounts.pick()`, so neither ever sees `pick()`'s own
`all-accounts-cooling-until-<ISO>` reason on the resulting park/error — both instead carry the
*last* cooldown event's own `cooldownUntilIso` through explicitly (`callLlmStep`'s `ParkSignal`
detail; `callIntakeStepWithRotation`'s exhaustion error string), so a maintainer always sees a
wall-clock retry time, never just an attempt count against a duration that's no longer flat.

**Adding a Claude Max account** — guided, via `bin/spo`, never by hand-editing a registry file:

```bash
spo account add acct-2
```

prints the exact next steps (`CLAUDE_CONFIG_DIR=... claude setup-token`, where to paste the
token, the `chmod 600`, then `spo accounts` to verify) — it never runs `claude` itself.
`spo account enable <name>` / `spo account disable <name>` toggle the `disabled` marker.
`spo account clear-cooldown <name>` clears a *cooldown*, which the marker has nothing to do with:
it deletes the account's whole `state.json` entry under the same short lock `markLimit` takes.
Clearing `cooldownUntil` by hand is not equivalent -- `computeLimitUpdate` also stores
`lastUsageLimitAt`, and leaving it behind means the next limit inside `ESCALATION_WINDOW_MS`
escalates straight to the 5h tier as though nothing had been cleared. It exists because the
cooldown is invented locally and never reconciled against the server (issue #483): 4 of the 7
cooldowns in the live journal carry `defaulted: true`, i.e. the server supplied no retry-after
and the code guessed.
`K` parallel workers scales with `K` healthy accounts — the gate itself stays serialized (one
live world), so adding an account adds implementation capacity, not gate throughput
(state-machine-spec.md § Account pool).

**Per-step account leases (chantier 6 action 6.2, `orchestrator/account-lease.js`).**
`accounts.pick()` is deterministic first-fit — two concurrent callers get handed the *same*
account every time, invisible under the pre-C6 single-threaded daemon and a real bug once a
worker and the scanner process (§ "How much the daemon takes on at once") can both be calling an
LLM step at once. A lease is acquired around one LLM call, per-step rather than per-task
(deliberate: the real pool is 2 accounts, a card's models already rotate fable → sonnet → fable
with no cross-step cache to protect, and 15% of cards already rotate mid-run in ~6s at zero cost —
a per-task lease on a 2-account pool would turn that routine rotation into a park class that has
never fired), and released the instant that call finishes. Lease files live at
`<poolDir>/.lease-<name>.json` (`{pid, startedAt}`), acquired/released via `lock.js`'s
`acquireShortLock`/`releaseShortLock` — the same pid-liveness stale-sweep idiom `daemon.lock`
uses, and, since the measured 39%-torn-read defect (`lock.js:257-288`: 119 of 800 cooldown
entries lost), the same write-tmp-then-`linkSync` `tryCreate` daemon.lock uses too
(`account-lease.js:156` → `lock.js:255` `acquireShortLock` → `:289` `tryCreate`) — a bare `'wx'`
create is exactly the defect that idiom replaced, not a shortcut this path still takes.

A healthy account currently leased by another live process is `AllAccountsLeasedError`, worth a
**bounded wait** (`config.accountLeaseWaitMs`) before parking `all-accounts-leased` — distinct
from `AllAccountsCoolingError` (a cooldown, never worth waiting on; that still parks immediately).
The wait bound defaults to `MAX_LEASE_AGE_MS` (`step-contracts.js`, **63 minutes**: 2 ×
`LLM_STEP_DEADLINE_MS` plus 10% slack) — the age at which a lease is presumed dead and swept
regardless of pid liveness, not the ~90–265s a sibling's step typically takes. That distinction
was a real C6-verification bug: the original default (5 min, reasoned from the typical duration)
gave up while a legitimately-held lease could still be alive and un-sweepable for up to another
26.5 minutes, parking a perfectly healthy card. A waiter willing to outlast `MAX_LEASE_AGE_MS`
always terminates one of two honest ways — it gets a lease, or the holder ages out and it takes
that one — instead of parking early. `countHealthyAccounts` (the `K ≤ healthy accounts` clamp
above) is deliberately blind to lease state, only to cooldowns: a lease frees every 90–265s, and
clamping `K` on that churn would make it flap on every single LLM call.

### cwd policy

Real-mode LLM calls run from one of two places, chosen by `orchestrator/config.js`'s
`cwdForStep(stepName, { worktreePath, repoRoot })`:

- **orchestration-side** (DIAGNOSE, VALIDATE, CITATION_VERIFIER) — this repo's own root. These
  steps judge artifacts the orchestrator already produced (diff, gate log, ledger, PR); they
  don't need the product's own `CLAUDE.md` tree.
- **worktree-side** (PLAN, IMPLEMENT) — the task's product worktree. These steps read and write
  the product itself.

This split exists because a live measurement (2026-08, this machine) of a `claude -p` call
issued from the product worktree showed **~40k input tokens of preamble** (root + directory-
scoped `CLAUDE.md` files, doc auto-discovery) before the model does any work, while the same
call from a lean directory with no such tree was far smaller — multiplied across every
PLAN/IMPLEMENT/DIAGNOSE/VALIDATE call in a task, that is real, avoidable spend.

### Manual smoke test

`scripts/smoke-llm.js` makes exactly one real `claude` CLI call, through `invokeClaudeReal`,
with a trivial haiku/low-effort/$0.10-budget prompt. It is **not** part of `node --test` —
deliberately kept out of `test/` (any `.js` file directly under a directory literally named
`test/` is auto-discovered by `node --test` on this Node version, even without a `.test.js`
suffix, so the only way to keep it out of the automatic suite is to keep it out of that
directory). It takes a required account-name argument, resolved from the pool (no ambient
fallback, consistent with the account-pool decision above) — with none given, or an unknown
name, it errors and lists what's registered instead of guessing. Run it by hand:

```bash
node scripts/smoke-llm.js pool1
```

## Real scripted steps

`orchestrator/steps/scripted.js` has one real-mode function per orchestrator state that spawns a
product-repo command: `realWorktree`, `realCheck`, `realPushPr`, `realGate`, `realCiChecks`,
`realMerge`, `realFinish`. `state-machine.js`'s handlers dispatch to these the same way they
already dispatch `steps/llm.js`'s `runLlm` — only once neither `--shadow` nor `--dry-run`
applies (`isRealMode(ctx)`, i.e. `daemon.js --real`) — and `runScripted`'s shadow/dry-run
branches are otherwise unchanged from the shadow-mode skeleton. Every real function takes
`(ctx, deps = {})`; `deps.spawnSync` is the same test-injection point `steps/llm.js`'s
`invokeClaudeReal` already uses (production never passes it, so a real call always spawns the
real binary on `PATH`). Each function is judged on exit codes only (principle 1,
doc/state-machine-spec.md) and throws `ParkSignal` itself for a terminal failure, or returns the
next state name — the handler just wraps the call in the existing `callWithDeadline`.

**Where the commands run.** `config.productRepo` defaults to `path.join(os.homedir(),
'SPO-WebClient')` (`SPO_PRODUCT_REPO` overrides it, `config.js:701`) — the product checkout,
never a relative `../SPO-WebClient` (a session worktree's `..` does not resolve there). `config.pipelineWorktreesDir` (default
`<repo>/worktrees`, git-ignored) is where WORKTREE creates one `git worktree add` per task,
`<pipelineWorktreesDir>/<taskId>`; every later real step (and PLAN/IMPLEMENT via
`config.cwdForStep`) reads that path back off `ctx.task.worktreePath`, set once WORKTREE
succeeds. `config.ghRepo` (`Crazz-Org/SPO-WebClient`) is the `--repo` / API path every `gh`
call uses. `config.spoBenchDir` (default `~/.spo-bench`) is where the nightly-red refusal and
the main-moved `baseMain` lookup read local JSON instead of polling GitHub or the bench.

**WORKTREE, in order — and why claim is last.** Action B1.4 round 4: BEFORE any of the below,
inside the SAME product-repo-lock span (phase `worktree`), `payBenchReinstallDebtIfOwed` pays back
a bench-worker reinstall an EARLIER card's FINISH deferred, if one is owed -- see the FINISH
section below ("Round 4: the debt is paid back by the NEXT card's own WORKTREE") for the full
mechanism. It never blocks or parks this card: a no-op when nothing is owed (the common case, no
journal line at all), and every failure mode on the way to paying an owed debt leaves the record
owed and lets WORKTREE continue exactly as if nothing were owed. Then `git -C <productRepo> fetch
origin`, then `git -C <productRepo> rev-parse origin/main` to get the sha the nightly check
compares against
`~/.spo-bench/nightly/latest.json`'s `{verdict, sha}` (a `FAIL` at that exact sha parks
`nightly-main-red` before anything is created). Action 3.1: the rev-parsed sha is journalled
(`{state: 'WORKTREE', event: 'base-main', sha}`) and set onto `ctx.task.baseMainSha` immediately,
*before* the nightly check. The `base-main` event itself is a diagnostic record only — "what
`origin/main` sha did this run cut its worktree from" — journalled ahead of the nightly-red check
so it exists even on a run that parks right there and never reaches PLAN; nothing ever reads it
back. `handlePlan`'s `decidePlanReuse` (see "Step contracts + prompt fill" above) does not consult
it: its actual input is the `baseMainSha` field on PLAN's own `files-written` event (only written
once PLAN succeeds), compared against `ctx.task.baseMainSha` as set on this same line. A run that
parks before ever reaching PLAN leaves no PLAN `files-written` event, so there is nothing for a
later retry to compare against regardless of what `base-main` recorded. Then `git -C <productRepo> worktree add
<worktreesDir>/<taskId> -b claude-pipe/<taskId> origin/main`; then `npm ci` in the fresh
worktree (a product worktree carries no `node_modules`); **only then** `npm run board:take --
<issue>`, also from the fresh worktree. The claim runs last, after the worktree exists, because
the npm aliases need a product cwd to run at all, and the one checkout that must never run them
is the human's own main `SPO-WebClient` — there is no product cwd available before WORKTREE has
created one. `board:take`'s exit code: 0 claims and returns `'PLAN'`; 3 → PARKED `claim-lost`; 4
or 5 → PARKED `claim-rate-limited`; 6 → PARKED `claim-finished-worktree`; anything else → PARKED
`claim-unrecognized-exit`. A fetch, rev-parse or `worktree add` failure parks
`worktree-fetch-failed` / `worktree-rev-parse-failed` / `worktree-add-failed`; an `npm ci`
failure parks `worktree-npm-ci-failed` — none of these leave a claimed card behind, since the
claim is always the last spawn.

**CHECK** runs the invariant substring check FIRST, then `npm run typecheck`, `npm run lint`,
`npm run coverage:changed` in that order in the worktree; the first non-zero exit (or, for the
invariant check, the first non-empty `broken` list) journals `{event: 'check-failed', alias}`
naming which one and returns `'DIAGNOSE'` (never PARKED) — the later aliases never run once one
has failed. See "Invariant substring check (action 1.8)" below for the invariant check itself,
run by `steps/scripted.js`'s `runInvariantCheck` before the `CHECK_ALIASES` loop.

### Invariant substring check (action 1.8)

`doc/state-machine-spec.md:140` has always promised CHECK runs an "invariant substring check", and
`prompts/plan.md` has always told PLAN its invariant quotes face "a substring test" downstream —
until this action, neither was true. `orchestrator/invariants.js` is the whole of it now: pure
`fs`, no spawning, imported by both `handlePlan` (state-machine.js) and `realCheck`
(steps/scripted.js) rather than duplicated between them.

- **Format.** PLAN's `invariants_markdown` (prompts/plan.md's own "Invariant block format"
  section) is now a precise, parseable per-invariant block:

  ```
  ## INV-1
  File: relative/path/to/file.ts:123
  >>> QUOTE
  the exact text, byte-for-byte, any length, any number of lines
  >>> END QUOTE
  ```

  `parseInvariantsMarkdown` extracts `{id, file, lineSpec, quote}` per block; a block missing its
  `File:` line or its `>>> END QUOTE` marker is skipped and named in `issues`, never thrown — the
  rest of the file still parses. Zero recognized blocks is valid (no invariants), not an error.
  The `>>> QUOTE` / `>>> END QUOTE` delimiter (rather than a triple-backtick fence) is deliberate:
  a quote is free to contain its own ``` backtick sequences ``` without truncating early.
- **Matching (`resolveInvariant`).** Two modes, in order: (1) an exact substring of the cited
  file's contents; (2) a whitespace-normalized fallback (collapse whitespace runs on both sides)
  so indentation/reflow drift alone never produces a false regression. A cited path outside the
  worktree (absolute, `../`-escaping, or reached through a symlink that lives inside the worktree
  but points outside it) is never read — `isInsideWorktree` rejects it before the file is opened,
  lexically first and then against both sides' `realpathSync` so a symlink escape cannot slip
  past `path.resolve`'s purely lexical view, and the invariant is reported `unresolved, reason:
  'outside-worktree'`. The open itself is `O_NONBLOCK`: a FIFO at a cited path would otherwise
  block `fs.openSync` forever, freezing the event loop and `callWithDeadline`'s own timer with
  it — a daemon hang in CHECK with no park. The cited
  file itself is read through a bounded fd read (`readCapped`, capped at 2 MiB) rather than
  `fs.readFileSync` + slice, so a large file cannot blow up memory regardless of its real size.
- **PLAN-time baseline (`buildBaseline`).** `handlePlan`, in real mode only, calls this
  immediately after writing `invariants-<issue>.md`, resolves every invariant against the
  freshly created worktree, and journals the return value verbatim as `{state: 'PLAN', event:
  'invariants-baseline', parseError, invariants: [{id, file, resolved, mode}], issues}` —
  `task-values.js`'s `lastInvariantsBaseline` is the reader side. An invariant that does not
  resolve here is **never a park and never a reason to re-run PLAN** — it is simply excluded
  from what CHECK will later verify (only `resolved: true` entries are ever checked again), which
  is the entire point: a PLAN-time misquote or an uncitable line must not cost a real
  DIAGNOSE/IMPLEMENT remediation cycle. Zero invariants journals an empty array, not an error.
  Shadow mode and `--dry-run` never call this at all (`isRealMode(ctx)` gates it, same as every
  other real-only branch in `handlePlan`/`handleImplement`).
- **CHECK-time verification (`checkRegressions`, via `realCheck`'s own `runInvariantCheck`).**
  Re-reads the SAME `invariants-<issue>.md` file (never rewritten after PLAN — no need to
  duplicate quote text into the journal a second time) and re-resolves every id the baseline
  marked `resolved: true`, against the worktree as CHECK now finds it. An id that resolved at
  PLAN and does not resolve now — cited file deleted, or the quote no longer present, in either
  match mode — is the one and only regression this reports; whitespace drift alone (exact at
  PLAN, only normalized-matching at CHECK) is explicitly NOT one. Every visit journals `{state:
  'CHECK', event: 'invariants-checked', parseError, checkedIds, broken}`; a non-empty `broken`
  journals `{event: 'check-failed', alias: 'invariants', broken}` and returns `'DIAGNOSE'` — never
  PARKED, same as every other CHECK failure. A missing/unparsable invariants file, or no baseline
  event at all (PLAN never ran one — a task older than this action, or one whose PLAN pass had no
  worktree yet), is fail-open: journalled, `broken` stays `[]`, CHECK is never failed over it.
- **Ordering.** The invariant check runs BEFORE `CHECK_ALIASES` (typecheck/lint/coverage:changed)
  — deliberately: it is pure `fs` (this module never spawns anything), while every alias below it
  spawns an `npm run` subprocess, so there is no reason to pay for three spawns before a check
  that is effectively free. It is also the most surgical signal DIAGNOSE can receive: it names
  the exact id and file a specific fact regressed in, where a bare typecheck/lint failure is
  usually already self-explanatory from the tool's own output and gains nothing from going first.

**PUSH_PR** writes the commit message to `journal/<id>/commit-message.txt` (`git commit -F
<file>`, never the message inline on argv) and the PR body — `Closes #<issue>` plus a
`claude-pipe/<taskId>` pipeline stamp — to `journal/<id>/pr-body.md` (`gh pr create --body-file
<file>`), then `git add -A` / `git commit -F <file>` / `git push -u origin claude-pipe/<taskId>`
/ `gh pr create --repo <ghRepo> --title <title> --body-file <file>`, all `git -C <worktree>`. The
PR number is parsed off the `/pull/<n>` URL in `gh pr create`'s stdout and stored on `ctx.prNumber`
(and from there into every `state.json` snapshot) for MERGE and FINISH to read back; an
unparsable URL parks `push-pr-failed` (`step: 'pr-number-unparsed'`) rather than guessing.

**GATE** runs `npm run gate` in the worktree. 2/3/4 → PARKED
`gate-dirty-tree`/`gate-worker-down`/`gate-timeout` are still exactly the shadow-mode table
(`handleGate`, state-machine.js). **Neither exit 0 nor exit 1 is, since actions 4.2 and B2.3** —
the real path reads the bench's own verdict for HEAD (`<spoBenchDir>/verdicts/<sha>.json`) on
EVERY exit, not only exit 1, and splits what the exit code alone conflates.

Exit 1: no verdict file at all → PARKED `gate-non-attesting` (a `NON_ATTESTING` bench verdict is
never written to `verdicts/`, so nothing was learned about the code and a DIAGNOSE call would be
spent on nothing); a `FAIL` with no `baseMain` → the branch no longer merges with `origin/main`
(the bench merges it itself, before assigning `baseMain`), so fetch + merge `origin/main` →
`'CHECK'`, or `merge --abort` and PARKED `main-moved-conflict`; a `FAIL` that DOES carry
`baseMain` → `'DIAGNOSE'`, unchanged.

Exit 0 (action B2.3): no longer read as proof on its own. `verdicts/<sha>.json` now carries
`live` (`LiveAttestation` — `{status:'ran', flows}` · `{status:'skipped', why, required}` ·
`{status:'unknown', why}`); no verdict file, no `live` key, or `live.status === 'unknown'` are all
read as "nothing proven either way" and journalled `gate-live-unknown` → `'CI_CHECKS'` unchanged
(parking on old data would stall the whole backlog).

Both exits, `BLOCKED`/exit 1 or a routed-but-undriven `live.status === 'skipped'`/exit 0 → PARKED
`gate-live-not-driven` — the SAME reason on both, because the underlying fact (routing required a
live drive that never happened) is identical either way. `BLOCKED` has other producers too (a
world-lock refusal or a dead-today rate limit, `run.ts`'s `runLive` in SPO-WebClient) whose
`live.status` is `'unknown'`, not routed-but-undriven — those get their own reason,
`gate-live-blocked`, on `TRANSIENT_RETRY_REASONS` (the world lock clears itself in minutes; see
`orchestrator/state-machine.js`'s own comment on that entry).

`main-moved-twice` and `main-red-no-merge` are reachable from GATE too, sharing
`ctx.counters.mainMoveUsed` and the `guardNightlyRed` helper with CI_CHECKS. The shadow-fixture
path keeps the old flat table. See `doc/state-machine-spec.md`'s GATE row and realGate's own
header comment for the measurement.

**CI_CHECKS** does the same two things the shadow-fixture path does, for real: (a) `git -C
<worktree> rev-parse HEAD`, then `gh api repos/<ghRepo>/commits/<headSha>/check-runs`, mapped to
`{name, conclusion}` pairs. Before anything is judged green or failing, a bounded **in-flight
wait** (action 1.7) treats a check-run with `conclusion: null` (still running) or a completely
empty `check_runs` array (CI hasn't registered anything yet) as neither: it re-fetches
(re-running the same `gh api` call through `spawnStep`, so every poll is journalled exactly like
any other real command) up to `ciChecksMaxPolls` times total (default 30), sleeping
`ciChecksPollIntervalMs` between polls (default 20000ms, ~10 min total — deliberately generous
and uncalibrated, since the pipeline has never once waited for CI to conclude; see the note in
`config.js`) — the sleep itself goes through
`deps.sleep` (the test injection seam; production always sleeps for real). Each in-flight
observation is journalled as a `checks-in-flight` event (`attempt`, `totalRuns`, `pendingRuns`).
Still in flight after the last poll → `PARKED` `ci-checks-still-running`, never advancing toward
MERGE. Only once nothing is in flight does the pre-existing decision run: the first check whose
conclusion isn't `success`/`neutral`/`skipped`
goes through `orchestrator/ci-cause-table.js` — the same lookup table `state-machine.js`'s
shadow-fixture branch uses, factored out so the two can never drift apart. (b) only if (a) was
green: `~/.spo-bench/verdicts/<headSha>.json`'s `baseMain` field (no file → treated as "not
moved", straight to `'VALIDATE'`), then `git -C <worktree> diff --name-only
<baseMain>..origin/main` intersected with `git -C <worktree> diff --name-only
origin/main...HEAD` — a non-empty intersection means the branch touches a file `main` also
moved since `baseMain`. The nightly-red guard and the one-shot `ctx.counters.mainMoveUsed` guard
are checked exactly like the shadow path before merging; the merge itself is `git -C <worktree>
merge origin/main`, and success returns `'CHECK'` to re-run CHECK and re-gate.

**MERGE** runs `gh pr merge <n> --repo <ghRepo> --merge` (enqueues; **never** `--delete-branch`
— see CLAUDE.md and `test/real-steps.test.js`'s explicit assertion of its absence), then `npm
run pr:wait -- <n>` in the worktree, with exactly one bounded re-wait on exit 4 ("still open"),
identical to the shadow-mode bounded-wait logic.

**FINISH** (action B1.4 gave it a new preamble, ahead of the pre-existing board-sync/teardown
below) first fast-forwards `config.productRepo`'s own checkout to `origin/main` and, only when
this card's merge touched the bench worker's own sources, reinstalls it — the rule
`SPO-WebClient/scripts/finish.sh` already runs for a human session, now finally on the pipeline's
own path too (see `doc/state-machine-spec.md`'s FINISH row for the full account, including why
the root cause of the bench worker running a stale binary for 3.5 days was that this pipeline had
never run it at all). Inside its own product-repo-lock critical section (phase `finish-sync`,
ahead of the pre-existing teardown phase `finish` below): `git fetch origin`; this card's own
merge commit by PR number (`gh pr view <prNumber> --json mergeCommit` — ctx carries no merge sha
directly); `git diff --name-only <mergeSha>^ <mergeSha>` to learn whether the merge touched
`src/e2e/bench/` or `scripts/bench-`; then the fast-forward itself, refusing (never forcing)
unless the checkout is on `main`, clean of TRACKED changes (`git status --porcelain
--untracked-files=no` -- post-verification hazard fix: narrowed from bare `--porcelain`, which also
counted untracked files and so refused in cases the human rule it mirrors, `git pull --ff-only`,
would not; R3, post-verification third pass: a FAILED branch/status probe is `check-failed`,
`detail.check`/`detail.exit` naming which and why, never misreported as `wrong-branch`/`dirty`),
and `git merge --ff-only origin/main` itself succeeds; then, only once that succeeded and the
merge did touch the bench worker, a second post-verification hazard fix: wait for the bench
worker to go IDLE (`waitForBenchIdle` -- `~/.spo-bench/spool` and `~/.spo-bench/running`, read off
`config.spoBenchDir` itself, both empty, bounded by `benchIdleWaitMaxPolls` x
`benchIdleWaitPollIntervalMs`, default 15 minutes -- `bash scripts/bench-install.sh`'s own
unconditional `systemctl restart` can otherwise cut a SIBLING card's in-flight GATE under this
daemon's real K=2 deployment; R2/W2, post-verification third pass: an UNREADABLE `spool`/`running`
-- anything other than "simply not there" -- PARKS immediately, `finish-failed`/`bench-idle-wait`/
`bench-dir-unreadable`, never silently read as idle), THEN `bash scripts/bench-install.sh`
(never retried on a timeout -- R2, post-verification third pass, the same exemption `npm-gate`
already has and for the identical reason: a killed `bash` can leave `npm run build:e2e`/
`systemctl restart` still running underneath it). R1 (post-verification third pass): a bench
that stays BUSY for the whole bound no longer PARKS -- it DEFERS. The old park was terminal
(`finish-failed` is not on `TRANSIENT_RETRY_REASONS`), fired BEFORE the board move (stranding an
already-merged card in `Merging`), and its 15-minute bound omitted SPO-WebClient's own bench
leases (`worker.ts`'s `DEFAULT_LEASE_MINUTES = 30` / `MAX_LEASE_MINUTES = 120` -- an ordinary
human lease is 2x-8x the bound). So FINISH now journals `bench-reinstall-deferred`, records the
debt durably (`journal.js`'s `writeBenchReinstallOwed`, `<journalRoot>/bench-reinstall-owed.json`
-- a SECOND defer during the same busy window overwrites this ONE record with its newer
`mergeSha` rather than accumulating a duplicate), and completes the card normally -- board move,
comment, worktree remove, `DONE` -- exactly as if nothing were owed.

**Round 4: the debt is paid back by the NEXT card's own WORKTREE**, not a separate daemon timer.
Round 3 shipped `orchestrator/bench-reconcile.js`, a dedicated scan timer wired into
`state-machine.js`'s `runScanCycle` that took the SAME product-repo lock from the scanner's own
process to pay the debt back once the bench went idle -- since deleted: it held that lock from a
THIRD process `product-repo-lock.js`'s `waitBoundMs` derivation explicitly assumes cannot exist
(at K=1 a worker reaching the lock while the scanner held it parked
`product-repo-lock-timeout` after 0ms, terminal and human-only), ran `bash
scripts/bench-install.sh` with none of `realFinish`'s own preconditions, and had no backoff on a
failing install. Three rounds of adding to that separate reconciler produced a new must-fix each
round -- more machinery than the problem needs.

Instead, `realWorktree`'s own product-repo-lock span (phase `worktree`) opens with
`payBenchReinstallDebtIfOwed`, BEFORE anything else -- WORKTREE runs before GATE, so a card that
starts while a reinstall is owed pays it back before it can gate against a stale worker, the exact
failure this debt exists to prevent; paying only at FINISH would leave a one-card window where a
card gates stale and only then settles the debt. It calls the SAME `fastForwardMainAndInstall`
function `realFinish` calls below (one implementation of "fetch, refuse unless clean and
fast-forwardable, `git merge --ff-only origin/main`, conditionally reinstall" -- not two copies
that could drift), reusing `realFinish`'s own preconditions in full. The "conditionally" is
resolved by a SINGLE, non-blocking `benchQueueDepth` read (never a poll -- this must never hold up
the card): busy or an unreadable bench dir leaves the record owed and journals
`bench-debt-still-busy`/`bench-debt-dir-unreadable`, retried by the next card's own WORKTREE. Once
idle, a `git merge-base --is-ancestor <owed mergeSha> HEAD` confirms the debt's own record is
still an ancestor of the freshly fast-forwarded checkout (defense in depth against a stale or
corrupted record) before the reinstall runs; a failure there journals
`bench-debt-ancestry-check-failed`. A fast-forward failure or a failed install use the SAME
`main-fast-forward-failed`/`bench-reinstall-failed` vocabulary `realFinish` uses, `detail.state:
'WORKTREE'` telling the two apart. **Every one of these leaves the record owed and NEVER parks or
blocks the card** -- payBenchReinstallDebtIfOwed never throws a `ParkSignal`, on any failure mode,
by construction. Only a successful install clears the record (`clearBenchReinstallOwed`) and
journals `bench-debt-paid`. Only THEN does it run `npm run board:move -- <issue> Done` and `gh
issue comment <n> --repo <ghRepo> --body-file <file>` (the comment in
`journal/<id>/final-comment.md` — since action 5.2 it also carries billable-weighted tokens,
elapsed time with the parked share broken out, and any attempt counters) **before** removing the
worktree — the same "npm aliases need a product cwd" rule as WORKTREE's claim ordering, so the
board sync must happen while the worktree still exists. Only then `git -C <productRepo> worktree
remove --force <worktreePath>` (its own, separate product-repo-lock critical section, phase
`finish` — board-move and the issue comment stay deliberately outside both locked spans, neither
touches `config.productRepo`). A final `finished` journal event carries the task's summed
`billableTokens` (every `llm-call` event's `billableTokens` in `journal.jsonl` -- fresh input +
cache-creation + output, cache-read excluded) and the PR number.

**Every spawn**, across all seven functions, journals one compact `{state, argv (first 6
tokens), exit, ms, attempt, commandClass, timeoutMs, timedOut, killedBySignal, signal}` `'spawn'` event via
`appendEvent`, and appends its stdout (falling back to stderr) to `journal/<id>/logs/<STATE>.log`
— several spawns share one state's log file, in call order, each under its own `-----
<command> -----` header.

**Per-command-class timeouts + retry-once-then-park (action 2.1).** `spawnStep` is the single
choke point every real `git`/`gh`/`npm` command **this file** spawns passes through, and it is
the ONLY real defence against a hung child: `deadline.js`'s `callWithDeadline` races a JS timer
against the handler's promise, but `spawnStep` calls `spawnSync`, which **blocks the event
loop** — that timer cannot fire while a `git`/`gh`/`npm` process is stuck, so a hung command used to freeze the
single-threaded daemon forever, holding the task lock (GATE was measured running 129–240s past
its supposedly-enforced 120s deadline before this action). `spawnStep` now classifies each call
by command + leading args (`classifyCommand`, `orchestrator/command-timeout.js`) and arms
`spawnSync`'s own `timeout` option from `config.commandTimeoutsMs`:

| Class | Default | `SPO_TIMEOUT_*_MS` override |
|---|---|---|
| `git` | 120000 | `SPO_TIMEOUT_GIT_MS` |
| `gh` | 120000 | `SPO_TIMEOUT_GH_MS` |
| `npm-ci` | 600000 | `SPO_TIMEOUT_NPM_CI_MS` |
| `npm-gate` | 7800000 | `SPO_TIMEOUT_NPM_GATE_MS` |
| `npm-run` (every other `npm run <alias>`: `typecheck`, `lint`, `coverage:changed`, `board:take`, `board:move`, `pr:wait`, `report:card`) | 660000 | `SPO_TIMEOUT_NPM_RUN_MS` |
| `bench-install` (action B1.4's conditional bench-worker reinstall, `bash scripts/bench-install.sh` -- never retried, see spawnStep's own comment) | 900000 | `SPO_TIMEOUT_BENCH_INSTALL_MS` |

**Action 2.1b closed the remaining gap.** The real commands spawned OUTSIDE `spawnStep` by their
own private `runSync` helpers — `board.js`'s `moveCard` (`npm run board:move`, called from inside
`realWorktree`/`realCheck`/`realGate`/`realMerge` and from `postParkComment`), `park-loop.js`'s
`gh issue comment`/`gh api` (the park comment, the abandon ack, the unpark scan),
`report-intake.js`'s `npm run report:card`/`gh issue list`/`gh issue create`/`gh api`/`gh issue
close` (the two daemon-loop timers), and `intake.js`'s own `gh`/`npm` calls (the maintainer-facing
`spo ask`/`spo pull` path — its three LLM steps already carry their own `deadlineMs`) — used to
carry no timeout at all. All four now arm the identical class default above via
`orchestrator/command-timeout.js`'s `armTimeout`, the same module `spawnStep` itself now delegates
its own classification to (moved out of this file so `board.js` — required *by* this file — does
not have to require its classifier back out of it, which would be circular). `park-alert.js` was
the only pre-existing exception, with its own fixed 10s timeout for the same reason.

Unlike `spawnStep`'s retry-then-`ParkSignal` policy, none of these four retries or throws on a
timeout: `moveCard` is explicitly best-effort and runs mid-step (a throw would break every
caller); `park-loop.js`'s park comment/abandon ack run once the task is already terminal (nothing
left to park); `report-intake.js` and `intake.js` run in the daemon loop or the CLI path, outside
any task (`ParkSignal` has nothing to attach to). A timeout is instead converted into the failure
each call site already models (`board-move-failed`, `park-comment-failed`, `unpark-scan-failed`,
`abandon-ack-failed`, `report-intake`'s and `reportConfirmScan`'s own per-item error entries, and
every `{ok: false, ...}` `intake.js` already returns), tagged `timedOut: true` so a hang stays
visibly distinct from a plain non-zero exit. None of the four retries, either: each gets another
chance on its own next cycle regardless, so a retry here would only double the exposure for no
gain. Every real spawn in the daemon is bounded as of this action.

One caveat on the `SPO_TIMEOUT_*_MS` overrides: `config.js` parses each with `Number(...)`, so a
non-numeric or fractional value (`2min`, `10m`, `1.5`) lands as `NaN`/a non-integer — and Node's
`spawnSync` *validates* its `timeout` option, throwing `ERR_OUT_OF_RANGE` **before** it spawns.
Handed through, that would be a synchronous throw inside `moveCard`/`postParkComment`, both
documented "never throws" and both running inside `finalizePark` — the crash-loop shape this
action exists to prevent. `classTimeoutMs` therefore treats a malformed value as "no class
default" (that one class runs unbounded, as it did pre-2.1, rather than killing the daemon).
Check `SPO_TIMEOUT_*_MS` is plain milliseconds before an unattended soak.

An explicit `opts.timeout` on a call site always wins over the class default. See `config.js`'s
own comment on `commandTimeoutsMs` for why each value is what it is — in particular, `npm-run`'s
660s is bounded below by `scripts/pr-wait.sh`'s own internal 600s poll budget, not chosen freely.

The trap this closes: `spawnSync` on a `timeout` kill sets BOTH `signal` (e.g. `SIGTERM`) and
`error.code === 'ETIMEDOUT'`, same as a bare `status: null` from a genuine "unknown" failure —
the pre-existing code mapped both to exit 1 indistinguishably, so a timeout-killed GATE (exit 1
→ DIAGNOSE) used to pay a real LLM call diagnosing a hang the daemon itself caused. `spawnStep`
now branches on `signal`/`error` **before** the exit-code mapping (mirroring `steps/llm.js`'s
own `killedByDeadline` idiom for `claude -p` calls, not a third convention), and never returns a
`timedOut` result to a caller at all — a caller's exit-code routing (`realGate`'s 0/1/2/3/4,
`realCheck`, `realCiChecks`, `realWorktree`'s claim codes, `realMerge`, `realPushPr`) is
therefore completely unchanged; it simply never runs on a timeout.

A timed-out command is retried once with the same timeout (both attempts journalled as `spawn`
events, `attempt: 1`/`2`, `timedOut: true`); if the retry also times out, `spawnStep` itself
throws `ParkSignal('<class>-timed-out', {state, argv, commandClass, timeoutMs})` — a dedicated
reason naming the command class, never the calling state's own failure reason (a timed-out GATE
parks `npm-gate-timed-out`, never `gate-timeout` — that string is the *domain* exit-4 reason
`npm run gate` itself can return — and never reaches DIAGNOSE). The retry lives inside
`spawnStep`, not at each of its 63 call sites (`grep -c 'spawnStep(ctx'` finds 64 matches across
`orchestrator/`; one is the function's own definition), so the policy cannot drift between them. Retrying
after a timeout is not obviously safe for every command — a first attempt that actually
succeeded server-side before the local process hung could in principle be repeated — but every
call site was audited: `git push`/`git commit`/`git worktree add`/etc. are all naturally
idempotent or fail cleanly on a real retry rather than duplicating anything; `gh pr create`
(PUSH_PR) is protected by GitHub itself refusing a second PR for the same head branch;
`npm run board:take` (WORKTREE) is explicitly documented idempotent by `scripts/board-take.sh`
("already held" on a re-run). The one call this audit does not fully close is `gh issue comment`
(FINISH) — issue comments have no server-side dedup, so a retried timeout whose first attempt's
network call actually landed could in principle post a duplicate comment. This is cosmetic
(never a duplicate PR, branch, or merge) and journalled like every other attempt if it happens.

**`--real`** (`daemon.js`) is required for any `kind: "card"` task to leave `INTAKE` once neither
`--shadow` nor `--dry-run` applies — `state-machine.js`'s `handleIntake` parks a card task with
reason `real-flag-required` if `ctx.config.real` isn't set, as a defense-in-depth check
independent of the CLI flag (so a caller that builds `ctx.config` by hand gets the same
refusal). `--real` and `--shadow` are mutually exclusive at the CLI (`daemon.js` refuses to
start with both); a non-`"card"` (e.g. `"synthetic"`) task is never gated by `--real` at all.

**First live run is maintainer-supervised.** No in-process test spawns a real `git`/`npm`/`gh`
process — every test in `test/real-steps.test.js` injects `deps.spawnSync` and calls
`realWorktree`/`realCheck`/... directly; that guarantee does not extend to tests that spawn a
real `daemon.js --worker`/`--scanner` child (see "The hermeticity guarantee stops at a process
boundary" below). The first time `daemon.js --real` actually drives
a `kind: "card"` task against the real product repo and a real GitHub PR, a maintainer should be
watching: it worktree-adds off `origin/main`, runs `npm ci`, claims a real board card, pushes a
real branch, opens a real PR, and — on the happy path — merges it and removes its own worktree.

## Kanban piloting

Real mode (`daemon.js --real`) drives the product board, not just the pipeline's own journals --
column moves at (most) states, and a park/retry/abandon round trip through the issue's own
comments, both maintainer-approved (2026-08-29, "lot B").

### Column mapping

The maintainer created five kanban columns for this (`Planning`, `Implementing`, `Checks & PR`,
`Merging`, `Parked`) alongside the existing `Todo` / `Gate` / `Validation` / `Done`.
`orchestrator/board.js`'s `COLUMN_BY_STATE` is the one table every mover reads:

| State | Column | Where the move happens |
|---|---|---|
| WORKTREE (once the claimed worktree exists) | `Planning` | `steps/scripted.js`'s `realWorktree`, right after `board:take` succeeds |
| IMPLEMENT | `Implementing` | `state-machine.js`'s `handleImplement` (an LLM step, no `realX` split) |
| CHECK | `Checks & PR` | `steps/scripted.js`'s `realCheck`, before the alias loop -- covers PUSH_PR too, no separate move there |
| GATE | `Gate` | `steps/scripted.js`'s `realGate` |
| VALIDATE | `Validation` | `state-machine.js`'s `handleValidate`, once per entry regardless of `touchesRdoMembers` |
| MERGE | `Merging` | `steps/scripted.js`'s `realMerge` |
| FINISH | `Done` | `steps/scripted.js`'s `realFinish` -- unchanged, pre-existing, and still the one move that **blocks** the task on failure |
| PARKED | `Parked` | `park-loop.js`'s `postParkComment`, called from `finalizePark` |

`CI_CHECKS` is deliberately absent -- it stays under `Gate`, no move. **Action 5.1e weighed a
sixth column for it and refused**: the columns are deliberately coarser than the states (`Checks
& PR` already covers CHECK+PUSH_PR), adding a single-select option needs a GraphQL schema
mutation with no CLI equivalent, and the one live card measured (#471, 2026-09-01) spent 41
seconds in CI_CHECKS. The window is bounded by the in-flight poll at ~10 minutes, so the board
can read `Gate` while CI is what runs -- known, and cheaper than a column.

Every move above except FINISH's own goes through `board.js`'s `moveCard(ctx, deps, state)`:
`npm run board:move -- <issue> "<Column>"`, cwd = the task's worktree. **A failed move is
journaled (`board-move-failed`) and never blocks the task** -- board display is best-effort, the
journal is the truth.

Three things action 5.1 changed here, each measured against the 18-task journal corpus:

- **FINISH's move to `Done` is now journalled** (`board-move`, `column: "Done"`, and
  `board-move-failed` before the `finish-failed` park on a non-zero exit). It was not, and that
  single missing event is why **14 of 18 tasks' journals stop at `Merging` while the board reads
  `Done`** -- anything reconciling journal against board read 14 healthy cards as divergent.
  `Done` still does NOT appear in `COLUMN_BY_STATE`: everything in that table goes through
  `moveCard`, which never blocks, and FINISH's move is the one move that must.
- **Before the worktree exists** (a pre-WORKTREE park, e.g. `nightly-main-red`) the move is no
  longer skipped. `moveCard` falls back to `cwd = config.productRepo` -- the same worktree-free
  call `report-intake.js` and `auto-triage.js` already make in production -- and journals an
  ordinary `board-move` carrying `via: "product-repo"` so the fallback stays visible. **6 real
  `board-move-skipped { reason: "no worktree" }` occurrences** in the corpus (issue-385 x5,
  issue-247 x1) are what this closes. `board-move-skipped` now means only "neither a worktree nor
  a product repo", which the shipped config never produces. The plan asked for a direct
  `gh api graphql updateProjectV2ItemFieldValue` mutation here; it is unnecessary, `board.js`
  already had the worktree-free mover.
- **A move to the column the card is already in spawns nothing**, and journals
  `board-move-skipped` with `reason: "already-in-column"`. **12 redundant consecutive
  `Implementing -> Implementing` moves across 7 tasks** in the corpus, one per IMPLEMENT retry --
  each a real GraphQL mutation against the shared hourly budget. The memo is in-memory and
  per-run (a `WeakMap` keyed on the run's `ctx`), updated only by a move that actually succeeded:
  a failed move retries, and a restart or a hand-moved card re-asserts the column. Persisting it
  would let the board drift permanently, which is the failure this whole action exists to prevent.

The issue comment (gh needs no cwd) still posts either way.

### Action 4.4: bounded auto-retry never reaches the board at all

Everything below this heading describes what happens when a task actually parks. `finalizePark`
(`state-machine.js`) checks one thing FIRST, before any of it: whether `ctx.config.real` is set
and the reason is one of a closed allowlist -- `claim-rate-limited`, `gate-non-attesting` (unless
its detail says the bench's verdicts directory itself is missing, which is a permanent
misconfiguration, not a transient fault) and the four `llm-transport-failed:*` reasons -- with
the per-task `transientRetries` counter still under `config.transientRetryBudget` (default **2**).
If so, the task is silently re-enqueued instead of parked: no board move, no `Parked` comment, no
`state.json` PARKED write -- nothing the rest of this section describes happens. It waits
`config.transientRetryDelaysMs` (default `[60s, 5min]`, indexed by attempt) before it is eligible
to run again, journalled as `transient-retry` (or `transient-retry-failed` if the re-enqueue
write itself fails, which falls through to an ordinary park). Only once the budget is exhausted
does the SAME reason fall through to the ordinary park machinery below. The comment in
`finalizePark` itself is explicit about why this matters: a card taking this branch "must not
look parked to `spo parked`, the dashboard, or a maintainer reading the issue thread" -- none of
those three surfaces has anything to show for it while the retry budget still has room.

### Park <-> kanban round trip

When a real, `kind: "card"` task actually parks -- the action 4.4 branch above did not apply, or
its budget is exhausted -- `state-machine.js`'s `finalizePark` calls
`park-loop.js`'s `postParkComment`: moves the card to `Parked` (never blocks, see above) and
posts a structured comment on the issue -- the reason, what the machine expects from the
maintainer, and this literal line:

```
pipeline: reply "retry" (optionally after fixing) to requeue, or "abandon" to close this attempt.
```

`gh issue comment`'s own stdout carries the created comment's URL
(`.../issues/<n>#issuecomment-<id>`); the numeric id is journaled (`park-comment`, `commentId`)
as the anchor for what comes next -- GitHub comment ids are monotonically increasing site-wide,
so "posted after the park comment" is exactly "id greater than the anchor", no clock needed.

**`unparkScan`** (`park-loop.js`) runs on its own dedicated timer, real mode only
(`state-machine.js`'s `runForever`, gated on `config.real` the same way everything else real in
that file is, then further gated on `config.unparkScanMs` -- 60s by default, `shouldScanUnpark`).
Action 2.7 added that timer: before it, `unparkScan` ran unconditionally on every drain cycle
(`config.pollIntervalMs`, 5s by default) in real mode -- a `gh api` call per parked task every 5
seconds, uncapped. For every journaled task still `PARKED` with a park-comment anchor not yet
acted on, `comment-scan.js`'s `scanForMatch` (shared with `reportConfirmScan` below -- see that
module's own header for the full design) fetches the issue's comments after the anchor, paginated
(`per_page=100`, a page loop, a sane bound so a pathological issue can't scan forever -- hitting
the bound is journalled `unpark-scan-truncated`, distinguishable from "scanned everything, nothing
matched"), filtered to an AUTHORIZED author (a repo collaborator, per `gh api .../collaborators`,
cached and re-checked hourly; a non-collaborator's `retry`/`abandon` is ignored and journalled
`unpark-scan-ignored-author`, never silently dropped), with per-issue backoff on consecutive `gh`
failures. The first authorized comment whose **first line** is `retry` (optionally followed by
more text) or `abandon`, case-insensitive, decides the outcome; anything else on the issue -- a
`retry` posted *before* the park comment, one from a non-collaborator, or a comment matching
neither word -- is left alone, since a human conversation on the issue is allowed:

- **`retry`** -- re-enqueues the task (`reEnqueueTask`: a fresh `queue/0000-retry-<ts>-<id>.json`
  with the original `task.json` fields, `worktreePath`/`branch`/`baseMainSha` dropped so WORKTREE
  derives the first two fresh, same as a first attempt, and `realWorktree` re-measures the third
  against whatever `origin/main` is *now*. Action 3.1: `baseMainSha` is stripped here for the same
  reason as `worktreePath`/`branch` -- defence-in-depth, not the closing of a live hole.
  `park-loop.js`'s own header comment on `reEnqueueTask` already establishes why: `task.json` is
  the original queue file and is never rewritten with runtime fields, so a stale `baseMainSha`
  (set only in memory, on `ctx.task`, by `realWorktree`) can never actually be sitting in it to
  strip in the first place -- exactly as true of `worktreePath`/`branch` today. Kept anyway,
  alongside its two siblings, as a guard against that invariant ever quietly breaking: if some
  future change did start persisting runtime fields onto `task.json`, a stale `baseMainSha`
  surviving into a retried task would let `handlePlan`'s `decidePlanReuse` (see "Step contracts +
  prompt fill" above) mistake "nobody re-measured it this run" for "`origin/main` hasn't moved")
  and journals `unparked-by-maintainer`. This does NOT by itself cost PLAN's LLM call again: if
  the plan `reEnqueueTask` left on disk (`journal/<id>/scratch/`, never touched by a retry) is
  still valid against the freshly-measured `baseMainSha` and the park wasn't one of the seven
  plan-invalidating reasons, PLAN reuses it instead of re-deriving it -- action 3.1's whole point,
  since a retry restarting at INTAKE would otherwise re-run PLAN from scratch on a plan that was
  already correct. Action 2.8: the `0000-`
  prefix makes a retry sort BEFORE every fresh `NNNN-issue-...` card in `listQueueFiles`'s
  filename-sort processing order (`intake.js`'s `nextQueueSeq` never hands out a sequence below
  `0001`) -- before this fix the file was named `retry-<ts>-<id>.json`, which sorted BEHIND every
  fresh card (`'r' > '0'`-`'9'`), the opposite of a maintainer's explicit retry taking priority
  over newly auto-pulled work. `buildCtx`'s fresh `ctx.counters` on the next `runTask` naturally
  resets the transient DIAGNOSE/VALIDATE-reject counters; the ledger (`journal/<id>/ledger.md`) is
  untouched, since the retry reuses the same `journal/<id>` directory the ledger already lives in.
- **`abandon`** -- terminal: `state.json`'s `state` is rewritten to `ABANDONED` directly (this
  task never re-enters `runTask`'s loop), journaled `abandoned-by-maintainer`, and a one-line ack
  comment ("Understood -- closing this attempt.") is posted on the issue. The card's *column* is
  deliberately left alone here -- where it lands next is the maintainer's own board gesture, not
  this build's to make.

Idempotent across scans: a task already acted on for its current park cycle (an
`unparked-by-maintainer`/`abandoned-by-maintainer` event already follows the anchor
`park-comment` in the journal) is skipped, whether or not the re-enqueued task has been drained
back out of `PARKED` yet.

**Is the channel alive? (project-2 card #476).** This scan is the maintainer's ONLY way back into
a parked card, and it went down for 33 hours on 2026-08-30 with nothing anywhere reporting it: 238
consecutive `unpark-scan-failed` events on `journal/issue-213` alone, every one of them
`{exit: 1, timedOut: false}` and nothing more. Two holes, both closed:

- **A failure names its cause.** `unpark-scan-failed` now carries `gh`'s own first stderr line
  (`comment-scan.js`'s `firstStderrLine`, capped and marked when truncated), so a repeat of that
  outage is diagnosable after the fact instead of only while the process is still alive. The same
  field rides on `comment-scan-collaborators-stale`/`-unreadable` and on `reportConfirmScan`'s own
  error entries -- the blindness was the shared scanner's, not `park-loop.js`'s.
- **A success is recorded when it CHANGES.** A clean scan used to journal nothing at all, so an
  old streak in a journal's tail could not be told apart from a channel that had recovered
  silently, and "the retry channel is alive" was only ever inferrable from an *absence* of
  failures -- which is exactly what a dead scanner also looks like. `unpark-scan-ok` is written on
  the first proven-live scan of a park cycle and once more after each outage it recovers from:
  1 + (number of outages) lines per park cycle, never per cycle. This is deliberately NOT the
  heartbeat that was removed in SPO-WebClient PR #444, and re-adding one would undo that decision.

`retry-channel.js` owns the one rule that reads those lines back (`summarizeUnparkScanTail`) and
the one that decides whether to write `unpark-scan-ok` (`shouldJournalScanOk`) -- writer and the
two readers (`bin/spo`'s `cmdStatus`, `console/collect.js`'s retry-channel tile) share it rather
than each re-deriving it. See that module's header for what breaks the walk and why each of those
rules was measured against the real outage rather than reasoned about.

**Reconciling against the issue (action 5.1b).** `unparkScan`'s per-task loop, above, runs one
more thing BEFORE the retry/abandon comment scan: for every journaled task whose `state.json`
reads `PARKED` or `ABANDONED`, `reconcileExternalClosure` checks whether the issue it owns has
since closed *outside* the pipeline. This is not a hypothetical — C5's own re-measurement
(2026-09-01, from scratch, not carried over from the plan) found the journal is the stale side on
3 of 18 tasks, and in all three the issue was already closed:

| task | journal said | issue closed | board |
|---|---|---|---|
| issue-213 | `PARKED` (`diagnose-duplicate-root-cause`) | 2026-08-30 01:50 | `Done` |
| issue-428 | `PARKED` (`diagnose-duplicate-root-cause`) | 2026-08-30 07:20 | `Done` |
| issue-443 | `ABANDONED` (`abandoned-by-maintainer`) | 2026-08-30 13:18 | `Done` |

The board already reads `Done` on all three — not because a human dragged a card, but because the
project has the built-in **"Item closed"** workflow enabled (`Status → Done`, re-measured live):
closing the issue moves the card by itself. Issue closure is therefore already the signal the
board itself trusts; `reconcileExternalClosure` invents no new source of truth, it makes the
journal catch up to what the board already knows.

213 and 428 are the same shape: a human fixed the work by hand and closed the issue, hours after
the park, with nothing ever telling the pipeline. 443 is a different and sharper shape — a FALSE
park. `pr:wait` read `closed false` at 13:17:57 and parked `pr-closed-unmerged`; PR #447 actually
**merged** 30 seconds later, at 13:18:27, with no close or reopen anywhere in its own timeline
before that. The maintainer then read the park comment and replied `abandon` at 13:53 — abandoning
a change that had already merged 35 minutes earlier. A reconciler would have caught that within
one scan interval instead of never; the MERGE-step defect that produced the false park in the
first place (a single unconfirmed `closed` read treated as terminal) is filed separately and is
**not** this action's to fix.

**Record, never overwrite** is the rule that makes this safe to build at all: `state.state` is
never rewritten. The task really did park, or really was abandoned — the pipeline's own verdict
was correct given what it knew at the time, and writing a `DONE` it never actually produced would
make the journal lie in the opposite direction from today's staleness. Instead both facts sit on
the record side by side — `state.json` gains `externallyResolved: {via, closedAt, prNumber,
mergedAt, at}`, and `journal.jsonl` gains one `reconciled-externally` event carrying the same
detail. `via` is what tells 213/428 apart from 443: `'pr-merged'` (carrying the PR's own
`merged_at`, so 443's 30-second gap is legible from the journal alone, no cross-referencing
GitHub by hand) only when `state.prNumber` is set *and* that PR's own `merged_at` is non-null;
`'issue-closed'` otherwise — a PR that exists but never merged is still the 213/428 shape. The PR
read only happens once the issue read has already come back closed, never speculatively.

Idempotent by construction, the same way `state.externallyResolved` guards a re-check as
`unparked-by-maintainer`/`abandoned-by-maintainer` guards a re-enqueue above: once written, this
function is a no-op for that task forever, with no separate flag to keep in sync. That bounds the
whole feature to **at most 2 extra `gh api` reads per parked task, ever** (issue + PR). The other
side of that bound is deliberate: a task whose issue is still OPEN is re-read every cycle — that
is how a close ever gets noticed — 1 REST read per open-parked task per `unparkScanMs` (60s by
default). Measured today: 3 parked/abandoned tasks, so at most 3 extra reads per cycle, falling to
0 once each is either reconciled or freshly retried. Same never-blocks-never-throws contract as
every other real spawn in this file (`command-timeout.js`'s own header): a failed read — non-zero
exit, a `spawnSync` timeout, unparsable JSON, at either the issue or the PR step — journals
`reconcile-scan-failed {step, exit, timedOut}` and leaves `externallyResolved` unwritten, so the
same task is simply re-attempted next cycle; the call is wrapped in `try/catch` inside
`unparkScan`'s loop on top of that internal contract, so one task's reconciliation misbehaving can
never abort the scan for every other task in the same pass or kill the daemon
(`state-machine.js`'s `runForever` has nothing to catch a throw from `unparkScan` itself).

Reconciling does **not** short-circuit the retry/abandon comment scan above for a still-`PARKED`
task — it runs first, unconditionally, and its own guard (already reconciled? issue still open? no
`prNumber`?) is what decides whether it spends an API call, not any branch in `unparkScan`'s own
loop. A maintainer can still reply `retry` on an issue that has been reconciled (closed by hand,
or closed via a merged PR) and get another attempt — closing the issue is not the same decision as
telling the pipeline to stop, and nothing about reconciliation forecloses it. An `ABANDONED` task
was never part of the retry/abandon comment scan (that loop's own filter has always been
`state.state === 'PARKED'`) and reconciling it does not change that — `reconcileExternalClosure`
is the only thing that runs for it.

`spo parked` (`bin/spo`'s `cmdParked`) prints a reconciled row under its own
"resolved externally" heading, pulled out of both the still-`PARKED` and still-`ABANDONED`
sections — the point being a maintainer's actionable list goes from 3 items (213, 428, 443, none
of which will ever get a human reply) down to 1 (issue-385, genuinely open and genuinely waiting).

Deliberately out of scope, left for a different action if it's ever wanted: a non-terminal task
(still `PLAN`/`IMPLEMENT`/...) whose issue closes mid-flight — a stronger "stop working now"
signal than this function's "the outcome is already settled" — and a `DONE` task whose issue is
later reopened. Neither is this action's to handle, and moving anything on the board is out of
scope entirely: the board is already correct in all three measured cases.

### Auto-pull

`daemon.js --real`, when not `--once`, also runs `auto-pull.js`'s `runAutoPull` on a timer
between drain passes (`state-machine.js`'s `runForever`) -- the exact same `pullBoard` +
`makeTask` `spo pull` already runs by hand (same dedup: `makeTask` skips an issue already in
`queue/` or `journal/`), for the top `config.autoPullLimit` (default 1) claimable candidates.
`config.autoPullMs` (default 5 minutes, `SPO_AUTO_PULL_MS` env override, `0` disables the timer
entirely) gates it via `shouldAutoPull(lastPullAt, nowMs, autoPullMs)` -- a pure function with no
`Date.now()`/`setInterval` baked in, so a test drives it with any clock pair directly. Journals
exactly one `auto-pull` event (`{enqueued, issues}`) to `journal/daemon.jsonl` -- a daemon-level
counterpart to `journal.js`'s per-task `appendEvent`, since a pull cycle belongs to no single
task -- and only when at least one candidate was actually written, never for a cycle that found
nothing new.

**Cost**: `npm run board:claim` is the same ~2-4 point cheap pool read
`doc/kanban-workflow.md` § GitHub API discipline already documents for `spo pull` (see below) --
this timer does not add a new *kind* of GitHub read, it just runs the existing one on a schedule
instead of only on request. At the default 5-minute interval that is at most ~12 reads/hour,
well inside the shared 5000-point/hour budget.

### Report intake (human-first bug-report pipeline)

The webclient has its own bug-report feature (`SPO-WebClient`'s `doc/bug-reporting.md`): a test
session flags what looks wrong, and a JSON report lands in that repo's `~/.spo-reports` queue.
`SPO-WebClient`'s `/triage-report` command reads that queue by hand -- reproduces each report,
routes it (desktop → data-correctness, mobile → ergonomics), dedups by `anchorKey`, drafts a
card, runs it through review, files it. This pipeline automates that same reasoning, but **no
LLM ever looks at a report until a maintainer has read it in raw form and asked for it to be
pursued** -- design history below explains why.

**Design history, 2026-08-30.** The first version of this automation ran the whole thing
unattended: an LLM (`intake.triageBugReport`) reproduced and judged each report, and a
successful judgement filed a GitHub issue with nobody watching. That was replaced by the current
design after the risk was named explicitly: unlike auto-pull (which only ever reads a board a
human already curated), reproduction is a genuine LLM judgement call -- log correlation,
geometry-predicate reasoning -- and a downstream review gate that checks *citations* cannot catch
a *wrong inference drawn from a real citation*. The fix was not a second review gate (which
suffers the same limitation) but moving the human decision **upstream**, to the one point where a
maintainer has the most information for the least effort: reading the report exactly as
captured, before any classification has had a chance to misjudge it -- including misjudging a
mobile/visual ergonomics report as "not really a bug" (a mistake `prompts/review-card.md` § 0 and
`prompts/triage-bug-report.md` § 1 now both call out explicitly and guard against).

**The pipeline, four stages, four independent daemon timers:**

```
Production deployment's own ~/.spo-reports (SPO-Deploy-managed durable volume)
   │  STAGE 0 -- orchestrator/remote-report-pull.js's runRemoteReportPull. The dev box has the
   │  initiative (doc/environments.md: it is not reachable from outside) and pulls over HTTPS --
   │  GET /list, GET /fetch?file=, POST /ack against SPO-WebClient's report-pull-endpoint.ts,
   │  bearer-token gated. A byte mover: never parses report content, only a transport envelope
   │  (filename/bytes/sha256). Inert until BOTH config.remoteReportUrl and a readable token file
   │  are set -- unset by default. See remote-report-pull.js's own header for the untrusted-input
   │  handling (size caps, no redirects, atomic writes, sha256 verification) and the fetch ->
   │  land -> ack idempotency argument.
   ▼
~/.spo-reports/<file>.json (now local, same as a report captured on this machine)
   │  STAGE 1 -- orchestrator/report-intake.js's runReportIntake, MECHANICAL, zero LLM calls.
   │  `npm run report:card` (SPO-WebClient, reads src/shared/bug-report-schema.ts) renders the
   │  report RAW -- no reproduction, no category/size/area. Mechanical anchorKey dedup (a grep,
   │  not a judgement). Files a card labeled report:raw, moves it to the "Intake" board column,
   │  posts confirm/discard instructions. config.autoIntakeMs (nonzero by default -- SAME risk
   │  class as auto-pull, since nothing here judges anything).
   ▼
GitHub issue, column "Intake", label report:raw, body = the report exactly as captured
   │  STAGE 2 -- reportConfirmScan, built on the SAME comment-scan.js's scanForMatch park-loop.js's
   │  unparkScan uses (action 2.7: paginated, allowlisted to repo collaborators, backed off on
   │  consecutive `gh` failures -- see "Park <-> kanban round trip" above for the full mechanics).
   │  A collaborator replies "confirm" or "discard" on the issue; a non-collaborator's reply is
   │  ignored and journalled, never acted on. config.reportConfirmScanMs (nonzero by default).
   ▼  "confirm"
   │  STAGE 3 -- orchestrator/auto-triage.js's runAutoTriage, ONLY for a confirmed report. Claims
   │  the report FIRST (an atomic rename into `~/.spo-reports/in-progress/`, same primitive
   │  state-machine.js's takeNextTask uses for queue/) so the daemon's own timer and a hand-run
   │  `spo triage` can never both pay for and act on the SAME report -- see "The claim mutex"
   │  below. Routes on `kind` (threaded through from report-card.js's own header via the
   │  report-intake/report-confirmed journal events):
   │    kind !== 'suggestion' -- intake.triageBugReport (reproduce/route/dedup/draft)
   │    kind === 'suggestion' -- buildSuggestionDraft: NO reproduction, no drafting LLM call at
   │       all -- "this works, but could be better" is not a defect to reproduce, and a
   │       maintainer's own "confirm" IS the judgement. Mechanically wraps the raw-intake issue's
   │       own title/body (already fully rendered by report-card.js at stage 1) as
   │       category:'feature', size:'S', area:'client' (a fixed default -- reviewCard corrects a
   │       wrong guess the same way it corrects any other card's area).
   │  Both paths converge on reviewAndFile: the SAME reviewCard gate every other card here gets
   │  (deps.humanConfirmed: true -- review-card.md § 0 no longer re-opens desirability, since a
   │  human already settled it) -> intake.amendCard (EDITS the raw-intake issue in place -- never
   │  files a second one, see amendCard's own header for why that is load-bearing for anchorKey
   │  dedup) -> moves the card to Todo. config.autoTriageMs -- kept its pre-redesign name/env var
   │  (SPO_AUTO_TRIAGE_MS) on purpose, see below.
   ▼
Todo  →  auto-pull  →  PLAN/IMPLEMENT   (unchanged)
```

**`kind: 'suggestion'`** is the one report kind that is never inferred -- only the reporter's own
explicit pick (desktop's kind button, mobile's `could-be-better` quick pick) sets it. It is what
lets "the thing I'm pointing at works, but could be better" reach the board through this channel
at all, without reopening the 2026-08-29 rule that suggestions never arrive through the
bug-report channel unjudged: a human still has to reply "confirm" before anything is filed, same
as any other report.

**A negative outcome after "confirm" is never silently dropped.** `not-reproduced` /
`insufficient` / `schema-version` / a `DO_NOT_FILE` review verdict all comment the reason on the
issue and leave the card HELD in "Intake", never archived -- overturning a report a human already
asked for is not this pipeline's call to make silently. Only `duplicate` and a successful
`draft` → `FILE`/`FILE_AMENDED` dispose of the report file (`~/.spo-reports/pending/` →
`.../archive/`, the same one-line disposition sidecar `/triage-report` itself writes). A
mechanical failure at any stage (bad account, bad JSON, a failed `gh`/`npm` call) leaves the
report queued/pending, retried next eligible cycle -- never journaled as `report-triaged` or
`report-held` (so `findConfirmedAwaitingTriage` still treats it as unhandled), though action 3.3
now journals it as `report-triage-error` and counts it toward a per-report cap and backoff -- see
"The mechanical-failure cap + backoff" below for what happens once that cap is hit.

**The claim mutex (action 2.6).** Before this, nothing stopped the daemon's own `autoTriageMs`
timer and a hand-run `spo triage` from finding the SAME confirmed report at the same time: both
would spend a full `triageBugReport` reproduction and both would act on the result --
`findConfirmedAwaitingTriage`'s "confirmed, no later triaged/held" journal scan only sees the
TERMINAL events, which land after the LLM call returns, so for the whole duration of that call
(minutes, for a real reproduction) the report still looked eligible to a second scanner.
Measured: report #443 was filed AND held 20 seconds apart, and the resulting PR #447 had to be
closed by hand.

The fix is `auto-triage.js`'s `processConfirmedReport`: it claims `entry.pendingPath` with one
atomic `fs.renameSync` into `~/.spo-reports/in-progress/` -- the identical primitive
`state-machine.js`'s `takeNextTask` already uses to claim a `queue/` entry -- BEFORE
`routeConfirmedReport` gets anywhere near an LLM call. `rename()` is atomic: exactly one caller's
rename succeeds, every other caller racing the same `pendingPath` gets `ENOENT` (its source
vanished under it) and returns `{ok: true, outcome: 'already-claimed'}` -- no `triageBugReport`
call, no journal write, no crash. A dry run (`opts.dry`) claims nothing at all, by design: a
preview must never block the real run. Whatever the routed outcome does NOT archive itself
(`filed`/`duplicate` move the file to `archive/`; everything else -- `held`, `DO_NOT_FILE`, any
mechanical failure -- leaves it exactly where it was) is restored to its original `pending/` path
once `processConfirmedReport` returns, so the "recoverable, not stranded" behaviour the table
above describes is unchanged; the file is just routed through `in-progress/` on the way.

Every claim is journaled as `report-triage-claimed` (`{issue, path}`) -- a trace in
`daemon.jsonl` for anyone reading it, though note **no CLI or dashboard surfaces it yet**:
`spo reports` scans only `pending/`, and `console/collect.js` ignores both new events, so a
report sitting in `in-progress/` is visible only via `ls ~/.spo-reports/in-progress/`. Surfacing
it belongs with the `spo status` work in chantier 5. `findConfirmedAwaitingTriage`'s own
"handled" rule is unchanged (it still only checks `report-triaged`/`report-held`); the claim
event is purely informational, the rename itself is the real gate.

**Crash recovery.** A process that dies mid-triage (a killed daemon, a killed `spo triage
--file`) strands its claim in `in-progress/` forever unless something sweeps it back --
`reclaimStaleClaims` does, once at the top of every REAL `runAutoTriage` cycle (tied to the same
timer that would otherwise process it, rather than only at daemon startup the way
`orphan-scan.js` sweeps a crashed task's `state.json` -- this daemon can run for days between
restarts, so waiting for the next one would leave a confirmed report's claim stuck far longer
than acceptable). It reuses that exact precedent rather than inventing a third "is this stuck"
pattern: a `<file>.claim.json` sidecar records `{pid, host, claimedAt}`; a claim is reclaimed
only once its owner's pid is dead on this host (`lock.js`'s own `processAlive` liveness probe --
same idiom `orphan-scan.js` already uses) AND `claimedAt` is older than
`config.triageClaimGraceMs` (default 4 minutes, same value and same purpose as `orphanGraceMs`)
-- a claim whose owner is merely slow (a real Opus reproduction) is never touched. A sidecar that
can't be read at all (a crash inside the tiny window between the rename and the sidecar write)
falls back to the claimed file's own mtime under the identical grace window -- which works only
because `claimReport` stamps that mtime at claim time. `fs.renameSync` preserves mtime, and a
report file is named for when the player filed it and then waits in `pending/` for a human
confirm, so without the stamp every fresh claim would read as instantly stale and a sweep could
reclaim a LIVE claim out from under its owner, re-opening the double-triage this whole mechanism
prevents. Above all of that sits an absolute ceiling (15x the grace window): a claim whose pid
cannot be probed at all -- a foreign hostname after a WSL/container rebuild -- is reclaimed
regardless, because a report a human explicitly confirmed becoming permanently invisible is a
worse failure than one duplicated triage. Positive liveness evidence still wins at any age: a
live pid on this host is never swept. A reclaim is
journaled as `report-triage-reclaimed` (`{file, owner}`); the report then looks exactly as it did
before the crash -- still `report-confirmed`, never `report-triaged`/`report-held` -- so the next
cycle picks it up and retries it normally.

**The mechanical-failure cap + backoff (action 3.3).** A confirmed report whose triage fails
*mechanically* -- a deadline kill, a spawn failure, account-pool exhaustion, anything that never
reached a reproduction verdict at all -- used to be retried on every single stage-3 cycle,
forever: `routeConfirmedReport` returned `{ok: false, error}` with the comment "mechanical
failure -- retried next cycle, no terminal journal", and `findConfirmedAwaitingTriage` treated
only `report-triaged`/`report-held` as handled. Nothing bounded it and nothing throttled it. The
audit sized this from a 2.5-hour incident; the live evidence gathered since was worse -- a
**12.8-hour** stall (issues 449/455/456, 2026-08-30/31: 53 auto-triage cycles, 128 attempts,
running the account pool down to exhaustion, every attempt a real `claude -p` reproduction).

*The cap.* Every `{ok: false, error}` return in `routeConfirmedReport`/`reviewAndFile` now also
carries a `step` tag (`TRIAGE_BUG_REPORT`, `REVIEW_CARD`, `AMEND_CARD`, `POST_HOLD_COMMENT`, …).
`processConfirmedReport` is the one choke point every one of them funnels through: on `!result.ok`
it journals `report-triage-error` (`{issue, step, error}`, error capped to 300 chars like
`firstError` already is), then re-reads how many `report-triage-error` events exist for that issue
**since its own most recent `report-confirmed` event** -- the identical "anchor + events since"
idiom `findConfirmedAwaitingTriage` already uses, transposed from "handled at all" to "how many
mechanical failures since the last time a human confirmed this" (`mechanicalFailureHistory`).
Counting since the anchor, not since the beginning of the journal, is deliberate and
forward-looking: it is what lets a maintainer's `spo triage --retry <issue>` (action 3.4 -- see
"The recovery path" below) reset the budget later, simply by re-confirming the report and moving
the anchor forward -- every earlier failure stops counting the moment a fresh `report-confirmed`
lands.

On the **third** mechanical failure (`MECHANICAL_FAILURE_CAP`, three strikes: enough that one
flaky cycle never holds a report a maintainer is still waiting to see filed, few enough that a
genuinely broken pool or a wide outage stops spending real reproductions within about **45 to 75
minutes** with the live defaults -- NOT "minutes rather than hours" as an earlier draft of this
doc claimed. The real arithmetic, `autoTriageMs`/`autoTriageBackoffBaseMs` at their live 15-minute
default: the 2nd attempt waits 15 min after the 1st failure, the 3rd waits 30 more after the 2nd
(the cap trips on the 3rd failure itself, with no further wait), and each retry is additionally
gated by the next auto-triage cycle boundary -- worst case adding up to one more 15-minute cycle's
scheduling slack at each step, hence the 45-75 min spread rather than a single number) the report
is held: a **dedicated** comment (`buildMechanicalHoldComment`) plus a
`report-held-mechanical` journal event (`{issue, attempts, lastError, commentPosted,
commentError}`), which `findConfirmedAwaitingTriage` now also treats as handled. That comment is
deliberately NOT `buildHoldComment`'s text. `buildHoldComment` says "Pipeline: reproduction did
not confirm this report" -- a *verdict*: a human's `/triage-report`-shaped reasoning ran to
completion and came back negative. Reusing it here would be a lie for four of `handleMechanicalFailure`'s
nine possible `step` tags (`TRIAGE_BUG_REPORT`/`REVIEW_CARD`/`FETCH_ISSUE`/`BUILD_SUGGESTION_DRAFT`
-- the calls that PRODUCE a verdict), since nothing ever reproduced anything there -- the machinery
failed before a verdict was ever reached. For those, `buildMechanicalHoldComment` says plainly that
triage failed mechanically N times, names the last error, states the report is still confirmed and
still in "Intake" with nothing discarded, and points at `spo triage --retry <issue>` to reset the
count and try again. For the other five step tags -- `POST_HOLD_COMMENT`/`POST_DUPLICATE_COMMENT`/
`POST_DUPLICATE_CLOSE_COMMENT`/`POST_DO_NOT_FILE_COMMENT`/`AMEND_CARD`, which run AFTER
`TRIAGE_BUG_REPORT`/`REVIEW_CARD` already produced a real verdict and fail only on the FOLLOW-UP
`gh`/`npm` call that tries to record it -- the pre-verdict wording would tell the exact same lie
from the other direction ("no verdict was ever reached" when one plainly was), so
`buildMechanicalHoldComment` branches on `step` (`VERDICT_STEP_FOR`) and instead names which
earlier step reached the verdict and which follow-up call is the one that keeps failing.

Posting this comment can itself fail -- for a `POST_*` step this is a real irony worth naming
explicitly (`buildMechanicalHoldComment` does): the hold comment is posted through the exact same
`postIssueComment` that just failed three times in a row as that report's own mechanical failure,
so it will often fail too. `handleMechanicalFailure` journals `report-held-mechanical` and returns
the held disposition **regardless of whether the comment posted** (`commentPosted: false`,
`commentError` set, when it did not) -- the hold is the mechanism that stops the loop, the comment
is only the courtesy of telling a human about it, and an earlier version of this fix let a failed
courtesy silently veto the mechanism: the comment's own `postIssueComment` call failing meant
`report-held-mechanical` was never journaled, `findConfirmedAwaitingTriage` never stopped
surfacing the report, and the exact 12.8-hour incident this action exists to close would recur
through the one gh outage most likely to trigger it -- the same outage already failing the
`POST_*` step in the first place. `commentPosted`/`commentError` exist so a maintainer reading
`daemon.jsonl` can still tell "held, comment landed" from "held, comment silently failed" without
that distinction being load-bearing for the hold itself.

*The backoff.* The cap alone was not enough: even bounded at three attempts, hammering a broken
pool or a wide outage once every single stage-3 cycle until the cap trips is still real spend for
zero chance of success, once the first failure has already shown the cause is mechanical rather
than reproduction-shaped. Before `runAutoTriage` ever calls `processConfirmedReport` (the function
that actually calls `claimReport` -- `runAutoTriage` itself never calls `claimReport` directly)
for a report with N ≥ 1 mechanical failures since its confirm anchor, it checks a pure decision
helper --
`shouldSkipForTriageBackoff(lastErrorAtMs, nowMs, errorCount, config)`, same shape as
`shouldAutoTriage` (no `Date.now()` baked in, driven entirely by its arguments so a test can drive
it without sleeping) -- against `triageBackoffMs(errorCount, config)`: the wait doubles per
additional failure (`autoTriageBackoffBaseMs * 2^(errorCount-1)`), capped at
`autoTriageBackoffCeilingMs`. The check runs **before** `claimReport`, so a skip never renames the
report into `in-progress/` and never spends an LLM call -- and it is journaled
(`report-triage-backoff`, `{issue, attempts, nextEligibleAtIso}`) and folded into the `auto-triage`
summary (`backoffSkipped`) precisely because the 12.8-hour stall stayed invisible partly because an
all-quiet cycle looked identical to "nothing confirmed" in `daemon.jsonl`; a silent backoff would
recreate that exact blind spot for the one mechanism built to prevent the incident repeating.

`autoTriageBackoffBaseMs` defaults to `autoTriageMs` itself when that is configured (> 0): the
first retry then waits exactly one ordinary auto-triage cycle -- the cadence the daemon already
runs at -- rather than a second hand-picked number that could drift out of sync with it. It falls
back to 15 minutes (mirroring `DEFAULT_AUTO_TRIAGE_MS`) when `autoTriageMs` is unset/disabled,
e.g. a hand-run `spo triage --file` with no daemon timer configured at all. `autoTriageBackoffCeilingMs`
defaults to 2 hours: long enough that a genuinely broken account pool or a wide `claude-code`
outage is not hammered every cycle while a maintainer is away, short enough that fixing the
mechanical cause during a normal working day still gets the report retried again that same day
without needing `spo triage --retry` by hand.

**"The one rule", worked through concretely.** None of `report-intake.js`/`auto-triage.js` ever
reads report *content* (no `profile`/`anchor`/`journal`/`geometry` field is parsed in this repo).
Rendering the RAW card -- the one step that necessarily needs that content -- lives beside the
schema it reads: `SPO-WebClient/scripts/report-card.js`, spawned via `npm run report:card` and
relayed as opaque stdout, the exact same relationship `pullBoard` already has with
`npm run board:claim`. `intake.triageBugReport`'s own reproduction reasoning still runs entirely
inside a `claude -p` session with `cwd = config.productRepo`, same as before.

**Config** (`orchestrator/config.js`):

| key | default | why |
|---|---|---|
| `spoReportsDir` | `~/.spo-reports` (`SPO_REPORTS_DIR`) | outside any git tree by design (`npm run finish` retires worktrees) |
| `remoteReportUrl` | unset (`SPO_REMOTE_REPORT_URL`) | stage 0, e.g. `https://starpeace.zz.works/api/report-pull` -- must be `https://`, refused otherwise |
| `remoteReportTokenFile` | `~/.spo-reports/.pull-token` (`SPO_REPORT_PULL_TOKEN_FILE`) | must match `SPO_REPORT_PULL_TOKEN` pasted into production's `.env` by hand |
| `remoteReportPullMs` | 5 min (`SPO_REMOTE_REPORT_PULL_MS`) | safe nonzero default -- inert without both the URL and a readable token |
| `remoteReportPullLimit` | 5 (`SPO_REMOTE_REPORT_PULL_LIMIT`) | production-listed reports fetched per stage-0 cycle |
| `remoteReportMaxBytes` | 4 MB (`SPO_REMOTE_REPORT_MAX_BYTES`) | transport-level cap on one fetched report, untrusted input |
| `remoteReportQueueCeiling` | 50 (`SPO_REMOTE_REPORT_QUEUE_CEILING`) | stage 0 skips the cycle once the local queue is already this deep |
| `autoIntakeMs` | 15 min (`SPO_AUTO_INTAKE_MS`) | stage 1, zero LLM judgement -- same risk class as `autoPullMs` |
| `autoIntakeLimit` | 3 (`SPO_AUTO_INTAKE_LIMIT`) | reports filed per stage-1 cycle |
| `reportIntakeColumn` | `"Intake"` (`SPO_REPORT_INTAKE_COLUMN`) | a new Status option on the product's project board -- deliberately its own column so a raw report is never confused with a parked pipeline card (the old reason given here, a driver-scope disarm inside `board-move.sh`, is stale -- see `config.js`'s note) |
| `reportIntakeLabel` | `"report:raw"` (`SPO_REPORT_INTAKE_LABEL`) | gates nothing on its own (`claim-read.sh` never reads labels) -- `intake.makeTask`'s own second, independent guard skips any issue still carrying it |
| `reportConfirmScanMs` | 5 min (`SPO_REPORT_CONFIRM_SCAN_MS`) | stage 2's own timer, deliberately not `pollIntervalMs` |
| `unparkScanMs` | 60s (`SPO_UNPARK_SCAN_MS`) | action 2.7 -- park-loop.js's unparkScan's own dedicated timer (see "Park <-> kanban round trip" above); NOT stage-2-specific, listed here because it shares `commentScanMaxPages` below with `reportConfirmScanMs` |
| `commentScanMaxPages` | 20 (`SPO_COMMENT_SCAN_MAX_PAGES`) | action 2.7 -- the sane bound on `comment-scan.js`'s pagination (20 * 100/page = 2000 comments) shared by BOTH `unparkScan` and `reportConfirmScan`; hitting it is journalled distinguishably from "no reply" (`unpark-scan-truncated` / `report-confirm-scan-truncated`) |
| `autoTriageMs` | 0, disabled (`SPO_AUTO_TRIAGE_MS`) | stage 3 -- kept the pre-redesign name/env var so the live systemd drop-in needs no change; the risk this used to gate (unattended filing on a hallucinated verdict) is now gated upstream by the human "confirm", so this default is no longer the load-bearing safety control it once was, but it stays the maintainer's own explicit call regardless |
| `autoTriageLimit` | 3 (`SPO_AUTO_TRIAGE_LIMIT`) | confirmed reports processed per stage-3 cycle |
| `autoTriagePromoteToTodo` | `true` (`SPO_AUTO_TRIAGE_PROMOTE_TO_TODO=0` disables) | a filed card moves straight to Todo; disable to leave it in `reportIntakeColumn` for a second human look |
| `triageClaimGraceMs` | 4 min (`SPO_TRIAGE_CLAIM_GRACE_MS`) | action 2.6 -- how stale an `in-progress/` claim must be, on top of a dead owner pid, before `reclaimStaleClaims` treats it as abandoned rather than mid-write; same role and same default as `orphanGraceMs` |
| `autoTriageBackoffBaseMs` | `autoTriageMs` if > 0, else 15 min (`SPO_AUTO_TRIAGE_BACKOFF_BASE_MS`) | action 3.3 -- wait before the first retry after a mechanical failure, doubled per additional failure since the report's confirm anchor; see "The mechanical-failure cap + backoff" above |
| `autoTriageBackoffCeilingMs` | 2h (`SPO_AUTO_TRIAGE_BACKOFF_CEILING_MS`) | action 3.3 -- absolute ceiling on the doubling above |

Journals: `remote-report-pulled` / `remote-report-acked` / `remote-report-ack-failed` /
`remote-report-rejected` (stage 0), `report-intake` / `report-intake-duplicate` /
`report-intake-schema-version` / `report-intake-move-failed` (stage 1), `report-confirmed` (also
reused by action 3.4's `spo triage --retry <issue>` to re-open a held report -- see "The recovery
path" below; a retried one carries `retriedFrom`/`retriedAt` alongside the usual
`issue`/`pendingPath`/`kind`/`commentId`, fields no scan anywhere matches on) /
`report-discarded` (stage 2 outcomes) / `report-confirm-scan-truncated` / `report-confirm-scan-
ignored-author` / `report-confirm-scan-backoff-skip` (stage 2's own comment-scan.js facts, action
2.7 -- `comment-scan-collaborators-unreadable` / `comment-scan-collaborators-stale` are shared
with `unparkScan` and carry a `scanner` field instead), `report-triaged` / `report-held` / `auto-triage` /
`report-triage-retry` / `report-triage-cooldown` / `report-triage-claimed` /
`report-triage-reclaimed` / `report-triage-error` / `report-held-mechanical` /
`report-triage-backoff` (stage 3) -- all to `journal/daemon.jsonl`, the
same append-only surface `auto-pull` already uses. `auto-triage` is journaled for a cycle that
disposed of at least one report, hit at least one mechanical error (with
`errorIssues`/`firstError`, truncated to 300 chars), or (action 3.3) backed off at least one report
(`backoffSkipped`); a cycle with nothing confirmed journals nothing. `report-triage-retry` is
informational only -- `intake.js`'s `triageBugReport` retries once, same account and deadline,
when `steps/llm.js` reports a deadline kill (`timedOut: true`); it is never treated as "handled" by
`findConfirmedAwaitingTriage`. `report-triage-cooldown` (plan action 3.6) is the same kind of
informational event for the OTHER retry path: one per account `triageBugReport`/`reviewCard`
cooled down while rotating past a `{kind: 'limit'}` result (`{issue, step, account, cooldownUntil,
...}`, `step` is `TRIAGE_BUG_REPORT` or `REVIEW_CARD`) -- also never treated as "handled", and
never journaled in a dry run. `report-triage-error` / `report-held-mechanical` /
`report-triage-backoff` (action 3.3, see "The mechanical-failure cap + backoff" above) are all
skipped in a dry run too. Only `report-triage-error` is actually COUNTED since the report's own
`report-confirmed` anchor (`mechanicalFailureHistory` scans for that event specifically, per
issue); `report-held-mechanical` is the terminal disposition the count feeds INTO once it reaches
`MECHANICAL_FAILURE_CAP`, not itself a thing anything counts -- once one is journaled,
`findConfirmedAwaitingTriage` stops surfacing the report at all, so there is nothing left to count
it against until a fresh `report-confirmed` moves the anchor forward regardless.

A hard process kill mid-triage is recovered by `reclaimStaleClaims` (action 2.6, above) and
journals `report-triage-reclaimed`, NOT `report-triage-error` -- so a daemon crash-loop is
NEITHER capped NOR backed off by this mechanism. This is a real, reachable path: merging a PR
restarts the daemon, which since the drain landed (doc/deployment.md) lets an in-flight card
finish before exiting -- but a card still running past `config.drainTimeoutMs`, and a triage in
progress (which the drain does not wait for: it lives in the SCANNER, killed first), are still cut. The
gap is deliberate, not an oversight: counting a reclaim toward the mechanical-failure cap would
hold a report after an ordinary daemon restart, punishing it for something that had nothing to do
with the report itself or with the mechanical health of triage. If daemon restarts during triage
ever become frequent enough to matter, the fix belongs in a SEPARATE counter keyed off
`report-triage-reclaimed`, not in silently folding it into this one.
`remote-report-pull.js`'s `ackedFilenames`, `orchestrator/auto-triage.js`'s
`findConfirmedAwaitingTriage`, and `report-intake.js`'s `findPendingIntake` all use the same
anchor+"handled later" idiom `park-loop.js`'s `findParkAnchor` already established, transposed
from a per-task `journal.jsonl` to this flat daemon-level log.

**The recovery path (action 3.4): `spo triage --retry <issue>`.** Before this action, a report
that reached HOLD was a confirmed dead end -- `findConfirmedAwaitingTriage` treats all three hold
shapes as handled, the report file sits in `pending/` (restored there by
`processConfirmedReport`'s own `finally`) forever, and nothing short of hand-editing
`daemon.jsonl` brought it back. The three shapes this recovers: `report-held` with a real negative
reproduction verdict (`not-reproduced`/`insufficient`/`schema-version`), `report-held` with
`outcome: 'do-not-file'` (`reviewCard` said no), and `report-held-mechanical` (action 3.3's three
mechanical strikes). `buildMechanicalHoldComment` already promised `spo triage --retry <issue>` as
the way out before this action existed to make that promise true.

*The mechanism* (`retryHeldReport` in `auto-triage.js`) is deliberately not a new event type: it
appends a FRESH `report-confirmed` event for the issue, carrying the same shape
`findConfirmedAwaitingTriage`/`routeConfirmedReport`/`processConfirmedReport` already read off one
(`issue`, `pendingPath`, `kind`, `commentId`), plus two marker fields a maintainer reading the
journal can use to tell a re-injection from the original confirm: `retriedFrom` (the hold outcome
it recovered -- `report-held` or `report-held-mechanical`) and `retriedAt`. Neither
`findConfirmedAwaitingTriage`'s matching (`event`/`issue` only) nor `mechanicalFailureHistory`'s
own anchor scan look at any other field, so the extra markers cannot break either. One event does
BOTH jobs, and this is exactly why action 3.3 anchored `mechanicalFailureHistory` on
`report-confirmed` in the first place rather than scanning the whole journal: a later
`report-confirmed` makes the issue eligible again (no LATER handled event for it) AND resets the
mechanical-failure budget to zero in the same move (only `report-triage-error` events AFTER the
most recent anchor count). No second mechanism -- action 3.3's own test already proved this exact
shape works before 3.4 existed to fabricate the event for real.

*The four refusals*, checked in order before anything is appended:
1. **No `report-confirmed` event at all** for the issue -- there is nothing to re-confirm.
2. **The issue is already eligible** (a `report-confirmed` with no handled-event after it) --
   refused even though nothing is technically broken by it, because appending a second
   `report-confirmed` would put the issue in `top` TWICE in the same `runAutoTriage` cycle,
   burning two of three `autoTriageLimit` slots on one report.
   `processConfirmedReport`'s claim mutex degrades that shape safely to `already-claimed` rather
   than crashing, but a command whose whole *purpose* is recovery must never manufacture that
   waste on its own.
3. **The issue's latest handled-event is `report-triaged`**, not a hold -- it was already filed or
   dispositioned as a duplicate, and re-running would re-file or re-comment on something already
   settled.
4. **The report file recorded on the confirm anchor is missing from `pending/`** -- re-confirming
   anyway would loop straight back into a fresh mechanical failure (nothing for `claimReport` to
   rename) instead of the honest, actionable refusal a maintainer can do something about.

Each refusal returns a distinct, legible `error` string naming the issue and the reason -- see the
body of `retryHeldReport` in `auto-triage.js` (the four `return { ok: false, error: ... }` sites)
for the exact wording.

*The courtesy comment* records the re-injection on the issue thread so it stays a truthful record,
but follows action 3.3's D1 lesson exactly: the re-confirm event is journalled **regardless of
whether the comment posts** (`commentPosted`/`commentError` record the truth without gating on it)
-- a `gh` outage must never be able to make `--retry` silently do nothing, the same failure mode
3.3 already had to close once for `report-held-mechanical` itself.

*`bin/spo`'s wiring* (`cmdTriageRetry`): `--retry <issue>` accepts a `#`-prefixed issue (`--retry
#449`, what a maintainer will actually paste from a GitHub thread) and rejects anything else --
missing value, non-numeric -- with a legible message and `process.exitCode = 1`, before
`retryHeldReport` is ever called. Like every other `spo triage` invocation this defaults to
`--dry`, which previews (`retryHeldReport`'s own `opts.dry`: reports what WOULD be re-injected,
appends nothing, comments nothing) rather than mutating by default -- `--file` is required to
actually act, matching this whole CLI's "no maintainer surprise" convention rather than making
`--retry` the one command that mutates on the bare flag. A refusal from `retryHeldReport` (any of
the four preconditions above) prints `result.error` and exits non-zero without ever reaching a
normal triage cycle; a successful re-injection prints the issue, what it was recovered from, and
whether the courtesy comment posted, and exits 0 (CLAUDE.md: verdict by exit code, never by
reading text). The bare `--dry` preview is success too, not just the `--file` path: it also exits
0, having appended and posted nothing -- exit 1 is reserved for a refusal or a bad argument, never
for "this was only a preview."

**Production-side setup** (SPO-Deploy's scope, not this repo's): a durable volume for the report
queue (a container-local path does not survive a rebuild), the `SPO_REPORT_PULL_TOKEN` env var
(generated by hand, `openssl rand -hex 32`, pasted into `.env` and into
`~/.spo-reports/.pull-token` on THIS machine), and an nginx location for `/api/report-pull/`. See
SPO-Deploy's `DEPLOY.md` § 5.5 and SPO-WebClient's `src/server/report-pull-endpoint.ts`.

**One-time GitHub setup** (this repo's product board, done once, 2026-08-30): neither of these
is created automatically by `runReportIntake` -- `gh issue create --label report:raw` and
`npm run board:move -- <n> Intake` both fail (the first hard, the second retried then given up
on -- see `moveWithRetry`) if the label or the Status option do not already exist.

```bash
gh label create "report:raw" --repo Crazz-Org/SPO-WebClient \
  --description "Raw bug-report card, awaiting a maintainer confirm/discard reply -- not yet judged" \
  --color "5319E7"
```

The `"Intake"` Status option on project 1 was added via one `updateProjectV2Field` GraphQL
mutation (no `gh project field-create` equivalent exists for adding a single option to an
existing single-select field) -- see this repo's own session history for the exact mutation if
the option is ever lost and needs recreating.

## Intake

`orchestrator/intake.js` is the maintainer-facing path from a free-text request to a filed
GitHub issue, and from the product board to a local `queue/` task file -- behind `bin/spo`'s
`ask` and `pull` commands, and (for the brainstorm lane) the `.claude/commands/SPO-Draft.md`
interactive-session command. Neither `bin/spo` command runs `daemon.js` or drives a task through
the lifecycle above; `spo ask` only files an issue (the board's own auto-add workflow puts it in
Todo), and `spo pull` only writes `queue/` files for a later `daemon.js --real` run to drain.

**The maintainer flow, end to end:**

```
spo ask "<request>"     -- file a card from a request (or /SPO-Draft, see below)
   |
   v  (the board's auto-add workflow moves the new issue to Todo)
npm run board:claim      -- (in the product repo) the priority order `spo pull` reads
   |
   v
spo pull [--limit N]     -- write queue/<seq>-issue-<n>.json for the top N claimable cards
   |
   v
daemon.js --real          -- drains queue/, drives each task PLAN -> ... -> DONE/PARKED for real
```

A second, parallel entry lane files cards from the webclient's own bug-report queue instead of a
maintainer's request -- see "Report intake (human-first bug-report pipeline)" above for the full
three-stage design; the maintainer-facing shape is:

```
spo intake [--limit N]   -- STAGE 1: files a RAW card, zero LLM judgement, per queued report
   |
   v  a maintainer replies "confirm" or "discard" on the issue (`spo reports` lists what's waiting)
   |                        STAGE 2: reportConfirmScan reads that reply (daemon timer, or wait)
   v
spo triage [--limit N]   -- STAGE 3: reproduce/route/dedup/draft the CONFIRMED reports, then the
                             SAME reviewCard gate `spo ask` uses, then amendCard (edits the raw
                             card in place) and a move to Todo
   |
   v  (same board auto-add -> Todo as spo ask)
npm run board:claim  ->  spo pull  ->  daemon.js --real     -- (as above)
```

**Two entry lanes into `spo ask`:**

- **Fast lane** -- `spo ask "<request text>"` -- joins the remaining argv as one free-text
  request (any language) and runs it through DRAFT_CARD (`prompts/draft-card.md`) itself.
- **Brainstorm lane** -- `spo ask --draft-file <path>` -- for a request that came out of an
  interactive session instead: that session writes its own draft JSON (the same
  `{title, body_markdown, category, size, area, is_bug_report, confirmed}` shape DRAFT_CARD
  produces) to `<path>`, and this skips the DRAFT_CARD LLM call entirely
  (`intake.loadDraftFile`) -- straight to review. The file is checked against the identical
  contract DRAFT_CARD's own reply is validated against; a missing key or an unrecognized
  `category`/`size`/`area` is reported clearly and exits non-zero, never silently guessed at.
  **`/SPO-Draft`** (`.claude/commands/SPO-Draft.md`) is this lane's human-facing front end: it
  drives an interactive Claude Code session to synthesize the brainstorm into that same contract,
  write it to the session scratchpad, run `bin/spo ask --draft-file <that file> --dry` and show
  the maintainer the draft plus the review verdict verbatim, then ask an explicit yes/no
  confirmation (never files without it) before re-running the same command without `--dry`. It
  replaces the raw `--draft-file` gymnastics above for a human at the keyboard; the flag itself
  is unchanged and still the thing `/SPO-Draft` ultimately calls.

Both lanes converge on the same two steps:

1. **DRAFT_CARD** (`prompts/draft-card.md`, Sonnet 5, effort medium; fast lane only) -- turns the
   request into a draft card: title, body (what's wrong/missing, `file:line` refs or the
   explicit reason there are none, a "Done means" criterion, a `Source: maintainer request,
   <date>` line), `category`/`size`/`area`, and `is_bug_report`/`confirmed`. Sonnet, not Fable --
   drafting is execution-shaped work, the same tier IMPLEMENT runs on.
2. **review-card** (`prompts/review-card.md`, Fable 5, effort high -- the existing step, not new
   here) -- the neutral second reader every other backlog card already gets
   (`.claude/agents/card-reviewer.md`'s pipeline-side twin). Its own **§ 0** is the confirmation
   gate for a bug report: `DO_NOT_FILE` unless the request supplies a reproduction the body can
   replay, or the code confirms it -- see `is_bug_report`/`confirmed` above, which DRAFT_CARD (or
   the brainstorm session) is expected to have set honestly going in. `FILE`/`FILE_AMENDED` both
   file; `DO_NOT_FILE` files nothing and prints the reason.

`intake.fileCard` applies only the *mechanical* part of a `FILE_AMENDED` verdict --
a `category:`/`size:`/`area:` correction naming one of the valid enum values -- and leaves
everything else (a missing citation, a rewritten "Done means" sentence) as the draft wrote it;
the full correction text still reaches the maintainer, since `review-card`'s own
`first_comment_markdown` is posted verbatim as the filed issue's first comment (`gh issue
create` + `gh issue comment`, `orchestrator/intake.js`).

**Cost**: `spo ask` makes about two real `claude -p` calls per request -- one DRAFT_CARD (skipped
entirely in the brainstorm lane) and one review-card -- both with `maxBudgetUsd: undefined`
(no cap; `step-contracts.js` -- no `SMALL_BUDGET_USD` constant exists in this build), an order
of magnitude cheaper in practice than a single PLAN/IMPLEMENT call by task shape alone.

**`spo pull`** never claims a card and never writes the board -- it only spawns
`npm run board:claim` (cwd = the product repo, the cheap ~2-point GraphQL read
`doc/kanban-workflow.md` § GitHub API discipline describes) and parses its claimable-candidate
lines, in the priority order they were printed. For each of the top `--limit` (default 5) it
fetches the issue body (`gh api repos/<repo>/issues/<n>`) and writes
`queue/<zero-padded-seq>-issue-<n>.json` in the `kind: "card"` shape `takeNextTask()` already
consumes (see "Task-file format" above) -- skipping, never overwriting, an issue already present
in `queue/` or `journal/`.

Every LLM call above goes through the exact same `invokeClaudeReal` primitive real mode's five
step contracts already use (never a second spawn path), and every account comes from the same
pool (`accounts.pick`); every `gh`/`npm` call is injected the same way `steps/scripted.js`'s
`spawnStep` already is (`deps.spawnSync`) -- production code never passes it, so a real run
always spawns the real binaries on `PATH`.

## Single-instance lock

The daemon refuses to start if another daemon already holds the same journal root
(`orchestrator/lock.js`): one JSON file at `<journalRoot>/daemon.lock` — `{host, pid,
startedAt, mode}`, created atomically via write-tmp (same directory) + `link` (exclusive-create:
`link` fails if the target already exists, the same semantics a bare `open(..., 'wx')` gave
before action 2.5 — that version created an empty file first and wrote its content in a second
syscall, so a reader in that window could see an existing-but-unparsable lock and wrongly treat
a just-created live lock as stale) — acquired in `daemon.js` right after the directories exist,
released on exit and on SIGINT/SIGTERM. A second daemon on the same root exits 1 naming the
holder; the likely collision is a hand-run `node orchestrator/daemon.js --real` while the
systemd unit is up.

Why it exists: `takeNextTask`'s rename is atomic, so a contended task never runs twice — but
the losing daemon's `fs.renameSync` throws ENOENT, which (per `park-signal.js`'s catch-all
doctrine) crashes it; and two daemons also clobber the account pool's `state.json`
read-modify-write and double-run the auto-pull timer.

The lock is scoped to the journal root, not the process, so the test suite's temp-dir daemons
never contend with a live one. A holder whose pid is dead (hard kill, power loss) is swept and
taken over on the next start, journaled as a `lock-stale-taken` event in
`<journalRoot>/daemon.jsonl`.

Acquisition only checks liveness once, at startup — `orchestrator/lock.js`'s `watchLock` keeps
checking for the life of the run, re-reading `daemon.lock` every `config.lockWatchMs` (default
15s, `SPO_LOCK_WATCH_MS` overrides). If it reads back a holder that isn't this process (two
consecutive mismatched reads, to absorb the stale-sweep unlink+recreate race), the daemon stops:
`state-machine.js`'s `runTask` polls `config.lockLost()` between every state transition (a
handler can be mid-`spawnSync`, so the timer alone can't interrupt one) and lets a `LockLostError`
propagate uncaught — deliberately **not** a park, since losing the lock means this process may no
longer be the legitimate writer of a park's own `state.json`/`report.md`/board-move/gh-comment.
`daemon.js` journals a `lock-lost` event and exits 75 (`EX_TEMPFAIL`); under the systemd unit
below, `Restart=always` brings it back, and the new start either resolves cleanly or refuses
normally against the winner's now-live lock.

## Orphan recovery

A task whose owning daemon process dies mid-run (crash, hard kill, a losing race against
`watchLock` above) leaves `journal/<id>/state.json` frozen on a non-terminal state with no
`queue/` entry — invisible to a drain pass and to `unparkScan`'s own PARKED-only scan alike.

This section covers the **fallback** path only. The **primary** cover, since chantier 6 split the
daemon into dispatcher/worker/scanner processes, is `dispatcher.js`'s `handleExit` →
`reparkCrashedWorker`: the dispatcher notices a worker child exit abnormally and reparks it
immediately, in-process, reason `worker-crashed` — no wait for a scan at all (see
doc/state-machine-spec.md § Principles, Principle 2). The scanner-based mechanism below exists for
what the dispatcher itself cannot cover: a worker killed during the dispatcher's OWN shutdown
(deliberately not reparked in-process, since a park half-written by a process already being
SIGKILLed can never be recovered later — `dispatcher.js:485-499`) and any owning daemon process
that simply never comes back to run `handleExit` at all (a hard kill of the whole process tree).
The shutdown case is this project's most common one in practice: a merge's `git pull` SIGTERMing
an in-flight card.

`orchestrator/orphan-scan.js` closes that remaining gap: every `state.json` snapshot now carries an
`owner: {host, pid, lockStartedAt}` (set once, from `daemon.js`'s own lock holder), and a task
whose owner pid is no longer alive on this host — past a grace window
(`config.orphanGraceMs`, default 4 min, to avoid racing a transition's own last write) — is
reparked automatically with reason `task-orphaned-daemon-restart`, through the same
`finalizePark` path a normal `ParkSignal` uses. That includes posting the retry/abandon park
comment, so `unparkScan`'s existing round trip picks the task straight back up — no manual
`state.json`/`journal.jsonl` edit, no fabricated comment, the way recovering card #385 required
by hand on 2026-08-30.

The scan runs unconditionally once at every daemon startup, in every mode (the case that
actually matters — crash, then a systemd restart), and again on its own timer inside
`runForever`'s real-mode loop (`config.orphanScanMs`, default 60s), ahead of `unparkScan` so a
reparked task is retryable the very next cycle. What the scan *does* is mode-gated, though:
`isRealMode(ctx)` (the same check `finalizePark`'s other real-only side effects use) decides
whether a detected orphan is actually reparked. `--real` reparks for real, exactly as described
above. `--shadow`/`--dry-run` never spawn a real command, so a park they wrote would carry no
board move, no gh park comment and no unpark anchor — invisible to both the maintainer and
`unparkScan` forever, silently burying a real card under a developer's local experiment. They
instead only detect the orphan and journal one `orphan-scan-would-repark` line to
`daemon.jsonl` (nothing under the task's own `journal/<id>/` is touched, so the task is exactly
where a `--real` start would still find it) — enough for a `--dry-run` start to report what a
real start would have recovered, without the risk. An owner-less or foreign-host `state.json`
(an older build, or a task genuinely owned by another machine) is left alone and logged, never
guessed at — a false-positive reparking would put two writers on the same task directory, worse
than the status quo.

A park produced this way also runs through `steps/scripted.js`'s `preserveWorktreeWip` if the
task's worktree is still on disk and dirty: it commits the tree (`wip(<id>): parked -- <reason>`)
and pushes it to a throwaway `wip/<id>-<ts>` ref on origin, named in the park comment — the same
#385 incident stranded 620 lines of uncommitted `IMPLEMENT` work in the worktree with no other
copy anywhere, which this closes independently of the lock/orphan fix above. The dirty-leftover
check `sweepWorktreeLeftovers` (WORKTREE's own retry-time cleanup) runs the same preservation
before removing a dirty leftover, falling back to its original `worktree-dirty-leftover` park
only if the preservation itself fails (no network, origin refuses).

`preserveWorktreeWip` detaches HEAD before committing the WIP, so that commit lands on no branch
at all instead of silently advancing `claude-pipe/<id>` — the worktree's own checked-out branch —
underneath `sweepWorktreeLeftovers`. Its rule 2 (the local-branch leftover check) has a third
safety case to match: a `claude-pipe/<id>` tip it otherwise can't vouch for is still deleted when
it's an ancestor of one of this task's own `refs/remotes/origin/wip/<id>-*` refs, since that's a
commit the pipeline made and saved durably itself, not a mystery local one. Together these two
changes close the loop card #385 hit: four identical `branch-unmerged-leftover` parks, each one
parking on the WIP commit the previous park's own preservation had just made.

## Recette

`spo recette [--scenario <name>] [--keep] [--dry] [--force] [--recette-dir <dir>] [--cap-ms <n>]
[--cap-llm-steps <n>]` — ACTION 2.9, `orchestrator/recette.js` — the supervised **live** harness:
drives one trivial, synthetic `kind: "card"` task through the real pipeline (`config.real = true`,
the same code path a live `daemon.js --real` uses) against a dedicated GitHub issue in the product
repo, under a cap, asserted against its own journal, cleaned up unconditionally. **This is the
standard live gate for every chantier from 3 on** — action 7.2 adds a second scenario to it rather
than inventing a new tool. Never run against the live daemon's own `journal/`/`queue/` — see
"Isolation" below.

Why this exists, in one line: shadow mode and `--dry-run` prove the state machine's own logic;
nothing before this proved that a real card, run for real, actually produces the journal a judge
was supposed to see.

**Isolation.** Its own journal root and queue directory, `.recette/<runId>/{journal,queue}/`
(`<runId>` = `<epoch-ms>-<pid>`) — never the live `journal/`/`queue/` the daemon holds
`daemon.lock` on (orchestrator/lock.js). `.recette/` is gitignored. `--keep` leaves the run
directory behind for a maintainer to inspect by hand; without it, cleanup removes it.

**The dedicated test issue.** One GitHub issue, created fresh every run, labelled `spo-recette`
— distinct enough that no human mistakes it for real backlog work. The label does not drive
cleanup (cleanup always acts on the exact issue number this run just created, in-process, never a
search) — it is the human safety net for the case cleanup itself does not finish. Create it once,
by hand, before the first live run:

```bash
gh label create spo-recette --repo Crazz-Org/SPO-WebClient --color 5319e7 \
  --description "synthetic card created by spo recette -- never real backlog work"
```

One risk this build could not verify from a read-only pass of `~/SPO-WebClient`: whether the
product repo's board automation adds a freshly created issue to the project board at all (the
same automation `orchestrator/intake.js`'s `fileCard` relies on). If it does not,
`npm run board:take` (WORKTREE's own claim) can fail `claim-lost`/`claim-unrecognized-exit` on the
very first live run — a park, not a crash, and cleanup still runs regardless — but worth
verifying by hand first.

**The scenario.** `trivial-doc-log` (the only one shipped with this action) asks IMPLEMENT to
append exactly one line to `doc/recette-log.md` in the product repo — a **docs-only** change,
deliberately: reading `~/SPO-WebClient`'s own scripts (2026-08-31) confirmed `npm run typecheck`
(four `tsc --noEmit` passes over named project files) and `npm run lint` (`eslint .`, but every
rule block in `eslint.config.js` is scoped to `src/**` / `scripts/**`) both never look at a `.md`
file at all, and `npm run coverage:changed` (`scripts/coverage-changed.js`) restricts itself to
`src/**/*.ts(x)` — a docs-only diff has zero eligible files, so it takes the script's own
"no eligible source file changed — running the suite, nothing to measure" branch: the full Jest
suite runs once, and the check passes exactly when that suite is green. GATE receives the same
diff CHECK already passed — the smallest, least surprising input the bench can be asked to judge.
See `orchestrator/recette.js`'s own comment above `RECETTE_DOC_FILE` for the full reasoning.

**Scenarios are data.** `recette.js`'s `SCENARIOS` is a plain object, one entry per scenario:
`{name, label, description, driver, k, buildCard(ctx), targetFile(index), assertions: [...],
crossTaskAssertions?}` — `driver` is `'inline'` (the original path, verbatim: `drainQueueOnce` plus
the `deps.spawnSync`-wrapped cap) or `'dispatcher'` (drives the real `createDispatcher` with real
worker children); `k` is how many synthetic cards the scenario runs; `capLlmSteps`/`capMs` are
optional per-scenario overrides of the global cap defaults (opts/env still win over them);
`crossTaskAssertions` only applies at `k > 1`, checked once across every task's combined events
rather than per-task. A scenario that only changes what IMPLEMENT is asked to do, at `driver:
'inline'`, really is just a second object literal, touching neither `runRecette` nor
`evaluateAssertions` nor the cleanup logic — `trivial-doc-log` (`k: 1`) is exactly that. That does
not hold for a `dispatcher`-driver scenario: chantier 7 action 7.2 landed `parallel-doc-log`
(`k: 2`) at `c0e4bbb`, which needed its own driver branch (`runDispatcherScenario`) and an
out-of-process cap (`runDispatcherCapWatchdog`, summing `llm-call` events across every task the
run owns), since the inline cap wraps `deps.spawnSync` in-process and a dispatcher runs its
workers as separate OS processes the in-process wrapper never sees.

**The cap — `driver: 'inline'`.** The remediation plan's "capped budget" predates this project
retiring dollars as a metric (`spo tokens`, 2026-08-31) — recalibrated here as two independent,
honestly-enforceable bounds, both checked at the one choke point every real spawn *the inline
driver makes* (scripted **and** `claude -p`, per `steps/llm.js`'s `invokeClaudeReal`) already
passes through: `deps.spawnSync`. This does not extend to `driver: 'dispatcher'` — its workers are
separate OS processes, invisible to an in-process `deps.spawnSync` wrapper, which is exactly why
that driver carries its own out-of-process watchdog (`runDispatcherCapWatchdog`, above) instead of
reusing this mechanism.

- **Wall clock**, default 45 minutes (`--cap-ms`, `SPO_RECETTE_CAP_MS`). Checked before every
  spawn — `spawnSync` is synchronous and blocking, so nothing here can interrupt an in-flight
  child. Combined with the existing per-command-class timeouts (`config.commandTimeoutsMs`), the
  true worst-case overrun above the cap is bounded by the single longest command timeout in
  flight when the cap is crossed (today, `npm-gate`'s 7800s) — this is "abort at the next
  opportunity", not "abort within `capMs` of the wall clock". It always terminates and always
  cleans up; it never hangs.
- **LLM step count**, default 12 (`--cap-llm-steps`, `SPO_RECETTE_CAP_LLM_STEPS`). Every real LLM
  call in this codebase spawns literally `claude`, so this is an exact count, not a heuristic —
  checked, and enforced, **before** the over-cap call spawns at all. 12 comfortably covers a
  trivial card's own budgets (`diagnoseBudget` 3, `validateRejectBudget` 3) stacked on the 3-call
  happy path (PLAN, IMPLEMENT, VALIDATE).

Either bound tripping throws `RecetteCapExceededError` — deliberately **not** a `ParkSignal`
(state-machine.js's `runTask` only catches `ParkSignal`; anything else propagates, "a real bug —
surface it, do not disguise it as a park"), so it surfaces straight out of `drainQueueOnce`.
`runRecette`'s own `try/catch` treats it as a tripped run, never a crash reported to the caller,
and cleanup runs in the enclosing step regardless.

**The assertions.** Reaching `DONE` proves far less than proving the judges ran on real inputs.
`trivial-doc-log`'s own assertion set (`orchestrator/recette.js`) checks, against the produced
journal: no park; `DONE` reached; PLAN actually wrote `plan-<issue>.md`/`invariants-<issue>.md`
(not the "no fixture" shortcut); IMPLEMENT reported a non-empty `files_changed`; **VALIDATE's own
judge inputs actually included `diff.patch`** (`judge-inputs-prepared`, action 1.3) — the assertion
that would catch a judge silently receiving nothing to judge; the change-validator actually
rendered `PASS`/`PASS_WITH_FINDINGS`; MERGE actually enqueued the PR; FINISH recorded a PR number.
Each assertion is `{id, description, check(info) -> {ok, detail}}` and never throws — one broken
event fails only its own assertion, so the report always shows the rest.

**Safety: refuses while a live daemon is running.** Chantier 6 action 6.4 added a real
product-repo mutex (`orchestrator/product-repo-lock.js`, `config.js`'s own note on the
44-worktree/61-branch incident this project already paid for once), but recette does not itself
acquire it — WORKTREE's setup and FINISH's teardown already take the lock, the same `realWorktree`/
`realFinish` code every driver runs (via `drainQueueOnce` for `driver: 'inline'`, via a real worker
process for `driver: 'dispatcher'`). What recette adds on top is a coarser, earlier guard: refusing
to *start* at all while a live daemon holds **its own** lock file, `<repoRoot>/journal/daemon.lock`
(`orchestrator/lock.js`) — 6.4's lock is scoped to one WORKTREE/FINISH call and says nothing about
whether a daemon is running at all before recette begins. Checked read-only (recette reads the
lock file and probes the pid's liveness the same way `lock.js`'s own stale-sweep does — it never
calls `acquireLock`, which would create the lock itself). `--force` overrides, loudly, for a
maintainer who has confirmed by hand that nothing is actually running. This is a best-effort
check, not a mutex: it catches "I forgot the daemon is running", not a daemon that starts a second
after the check passes.

**Safety: a second, unrelated refusal for `driver: 'dispatcher'`.** A dispatcher-driver scenario
spawns a real scanner child, and that child inherits `SPO_REMOTE_REPORT_URL` from this process's
own environment exactly as it inherits the seven zeroed scan-timer vars (see "Scenarios are data"
above) — but zeroing `SPO_REMOTE_REPORT_PULL_MS` does not stop `remote-report-pull.js`'s first
pull, which runs unconditionally on scanner startup. If `SPO_REMOTE_REPORT_URL` is ever set in the
shell `spo recette` runs from (today it lives only in the live daemon's systemd drop-in, never an
interactive shell), a `driver: 'dispatcher'` run would make a genuine HTTPS pull-and-ack against
production bug reports into this machine's real `~/.spo-reports`. `runRecette` refuses outright
when that env var is set and the driver is `dispatcher` (`reason: 'remote-report-url-set'`),
`--force` overrides both refusals for a maintainer who has confirmed by hand that a real pull is
acceptable. `driver: 'inline'` never spawns a scanner at all, so this refusal never applies to it.

**`--dry`** resolves the exact same config `--force`-free real run would (one function,
`buildPlan`, feeds both paths so they cannot structurally diverge), prints it, and returns before
the safety check, before any issue is created, before any directory is written, before any spawn
— nothing runs.

**Cleanup runs on every exit path** — success, a park, a thrown error, a tripped cap — never
throws, and is idempotent (every step tolerates "already gone": `git worktree remove`/`branch -D`/
`push --delete` against something that never existed, or was already removed by a **successful**
run's own FINISH step, just report a non-zero exit, never throw). In order: `git worktree remove
--force` + `git worktree prune`, delete the local branch (`branch -D`), delete the remote branch
(`push origin --delete`), **delete every `wip/<taskId>-<ts>` ref this run pushed to origin**,
`gh pr close` (skipped if no PR number was ever recorded), `gh issue close`, remove
`.recette/<runId>/`. `--keep` skips all of it.

The `wip/` step is not hypothetical bookkeeping: a **park** — the most likely first-live-run
outcome — makes `steps/scripted.js`'s `preserveWorktreeWip` push the dirty worktree to a durable
`wip/<taskId>-<ts>` branch **on origin**, in a namespace the `claude-pipe/<taskId>` delete above
deliberately does not touch (`sweepWorktreeLeftovers` rule 2 depends on that separation). Without
its own step, every parked recette run would leave one remote branch behind in the product repo,
permanently — exactly the artifact class `config.js`'s 44-worktree/61-branch note exists to
prevent. The refs are read back off the run's own journal (`wip-preserved` /
`leftover-wip-preserved`, both journaled immediately after their push returns 0), because the
`Date.now()` suffix in the ref name is only knowable there. **On partial failure**: every step
runs regardless of whether an earlier one failed (`cleanup()`'s own per-step `try/catch`, never a
short-circuit); the run's own report lists which steps were not clean, by name, so a maintainer
knows exactly what (if anything) still needs a hand — see `spo recette`'s own printed `cleanup:`
line.

**"Already gone" is clean, not a failure.** A cleanup step's job is "this artifact is no longer
there", not "my command exited 0", and on the SUCCESS path those differ: FINISH has already
removed the worktree, MERGE has already merged the PR (so `gh pr close` refuses), and the merge
deleted the remote branch. Three of seven steps therefore exit non-zero on a *perfect* run — the
first green live run (2026-08-31, issue #469) printed `3 not-clean` having left nothing behind at
all. Reporting that as failure teaches the reader to ignore the one line that would report a real
leak, so `classifyStep` recognises the tools' own "there was nothing to do" messages and records
those steps as `gone`. Anything **unrecognised** stays a failure: the classifier must never
launder a real error (a `Could not resolve host` on the remote-branch delete leaves a branch
behind) into silence, and a test pins exactly that.

**Exit code is the verdict** (CLAUDE.md: "Verdict by exit code, never by reading text output") —
`0` only when the run completed **and** every declared assertion passed; a refusal, a tripped cap,
a park, or a failed assertion are all `1`.

## Running as a service

`bash scripts/daemon-install.sh` (run from the checkout that should host the daemon) installs
`spo-pipeline-daemon.service` as a systemd `--user` unit, mirroring the bench worker's
`bench-install.sh`: `Restart=always` with a start-rate limit (a refuse-to-start — empty
account pool, held lock — stops after five tries instead of looping), linger enabled, and an
**explicit PATH** including `~/.local/bin`, because the daemon spawns the `claude` CLI and the
systemd user PATH does not reach it (the bench unit gets away without this only because it
spawns nothing outside `/usr/bin`).

The unit runs `--real` with auto-pull ON (5 min): installing it makes the daemon autonomous.
Auto-pull off for the unit: `systemctl --user edit spo-pipeline-daemon.service` →
`[Service]` / `Environment=SPO_AUTO_PULL_MS=0`. Stop:
`systemctl --user stop spo-pipeline-daemon.service`. Re-run the installer after pulling
daemon changes; it rebuilds nothing (no build step) and restarts.

**Report intake is ON by default too, stage 1/2 only.** `autoIntakeMs`/`reportConfirmScanMs`
default nonzero (see "Report intake" above), so a freshly installed unit already files raw report
cards and reacts to "confirm"/"discard" replies with no extra configuration. Stage 3
(`autoTriageMs`, the reproduction/filing step) stays off by default -- a drop-in setting
`Environment=SPO_AUTO_TRIAGE_MS=900000` is what turns it on; the same
`systemctl --user edit spo-pipeline-daemon.service` mechanism, `[Service]` section.

## Park alerting

A park is well recorded (journal event, `state.json`, `report.md`, the gh comment, the board
move) but every surface has to be gone and looked at. Two push halves close that gap
(`orchestrator/park-alert.js`):

- every park — any mode — appends one `parked` line to `<journalRoot>/daemon.jsonl`, so that
  file reads as the single chronological "needs a human" stream (auto-pull cycles, lock
  takeovers, parks);
- in real mode, `SPO_PARK_ALERT_CMD` (config `parkAlertCmd`, unset by default) names one
  executable spawned as `<cmd> <taskId> <reason> <lastState>` per park. The command decides
  what a park is worth — `notify-send`, an ntfy curl, a reason filter (a self-recovering
  rate-limit park may not deserve a ping; the soak's parks-by-reason data is what settles
  that). Same failure policy as `board.js`'s moves: a failed or hung alert (10 s timeout) is
  journaled (`park-alert-failed`) and never blocks anything — the task is terminal before the
  alert runs.

### The default notifier

`scripts/park-alert.sh` is what `daemon-install.sh` wires as `SPO_PARK_ALERT_CMD`, so an
installed daemon notifies out of the box. Three independent best-effort channels, cheapest
first, and it always exits 0 — a broken channel must never become a `park-alert-failed`:

| channel | switch | notes |
|---|---|---|
| a log line | always on | `$SPO_PARK_LOG`, default `~/.spo-parks.log`. `tail -f` this during a soak. |
| ntfy | `$SPO_PARK_NTFY_URL` | the one that reaches a phone — what an overnight run needs. `--connect-timeout 2 -m 5`, measured at ~2 s against a black-holed host, well inside the daemon's 10 s. |
| Windows toast (WSL) | `$SPO_PARK_TOAST=1` | opt-in: launching `powershell.exe` costs a second or more, so it is fired **detached** and never waited on. |

Set the phone channel with a drop-in rather than editing the unit:
`systemctl --user edit spo-pipeline-daemon.service` → `[Service]` /
`Environment=SPO_PARK_NTFY_URL=https://ntfy.sh/<your-topic>`.

## Tokens: what `spo tokens` measures, and what it does not

Dollars are retired as the headline metric entirely (maintainer decision, 2026-08-31): the
pool is Claude Max *subscription* accounts with a *quota*, never the metered API, so a dollar
figure never meant money spent. `orchestrator/tokens.js` reads token efficiency back out of the
journals instead — every real `claude -p` call already records its own token counts in an
`llm-call` event (`steps/llm.js`'s `extractTokens`: `tokensSource`, `freshInputTokens`,
`cacheCreationTokens`, `cacheReadTokens`, `outputTokens`, `billableTokens`), so there is no
second ledger to keep in sync. `spo tokens` prints it per task (state, calls, the four token
counts, billable-weighted total, park reasons), then the aggregate, billable-weighted tokens
per DONE card and the parking rate — the two numbers migration step 3 asks for. Parked-task
count and park-*event* count are both shown because they answer different questions: card #247
parked six times and still reached DONE. `spo cost` still works too, as a deprecated alias that
prints a one-line notice and then the same table (some docs/gates still say "watching `spo
cost`").

**Intake spend is in the ledger too (SPO-Pipeline#117).** `DRAFT_CARD`, `REVIEW_CARD` and
`TRIAGE_BUG_REPORT` run before a card has a task directory, so `intake.js`'s
`callIntakeStepWithRotation` — the one choke point all three go through — journals their
`llm-call` events into `journal/daemon.jsonl` instead, in the same shape `steps/llm.js` writes
into `journal.jsonl`. `tokens.js` reads both files through one accumulator: `tokenReport` returns
them as an `intake` row *and* folds them into every aggregate, `todaySpend` applies the same
local-midnight filter to both, `spo tokens` renders an `(intake)` row, and `spo status` names the
intake share under today's figure. One event per `claude` spawn, so a deadline-timeout retry or
an account rotation leaves two — the doubled call is precisely what is worth counting. Before
this, the token block was computed by `invokeClaudeReal`, returned by all three functions, and
dropped one stack frame later by callers that journal only through `appendDaemonEvent`: 58
auto-triage cycles produced zero `llm-call` events, and `spo status` printed "this figure is
short by an unknown amount" because the number could not be made honest any other way. The
dashboard's tokens trend never had this gap — `console/usage-scan.js` streams
`~/.claude*/projects` session transcripts, not the journals.

**Billable-weighted tokens = fresh input + cache-creation + output.** Cache-*read* tokens are
reported separately and never folded into that total: on a quota plan a cache read is nearly
free while fresh input and a cache write are not, and cache-read tokens dominate raw counts by
orders of magnitude (`console/usage-scan.js`'s own header) — a single "total tokens" number
would just be measuring cache hit rate, not the thing worth watching. `tokensSource` is
`'modelUsage'` when at least one recognized field was found there, else `null` — so a reader
can tell "zero tokens" from "not reported" (a killed/E2BIG call that never got a `modelUsage`
block at all).

**"n/a" means not reported, not zero.** `spo tokens` prints `n/a` — never `0` — in the token
columns of any task whose `llm-call` events carry no `tokensSource`, and closes the report with a
footer naming how many of the run's calls lacked the fields. Two things land there: journals
written **before** token capture shipped (2026-08-31), whose events recorded only the retired
`costUsd`, and a call killed before a `modelUsage` block existed (deadline kill, E2BIG, non-JSON
stdout — `tokensSource: null`). `billableTokensPerDoneCard` is `null` (rendered `n/a`) whenever
*no* call reported tokens, because a per-card figure computed off journals with no token data is
a false measurement rather than a small one. **Every historical journal in this repo is in that
state** — `spo tokens` over `journal/` reports `n/a` throughout until the current build has run
some cards. This is also the plan's action 7.4 landing in the reader-facing surface, not just in
the event shape.

**There is deliberately no cumulative ceiling** (maintainer decision, 2026-08-29, restated
2026-08-31): there was never a real dollar spend to cap, and capping tokens would enforce a
limit that does not exist either. What actually constrains a run is the pool — per-account rate
limits and the cooldowns `accounts.js` already tracks. The **per-step** `--max-budget-usd` caps
`step-contracts.js`'s own header once described are, today, not actually set anywhere in that
file — every step (and every `orchestrator/intake.js` LLM call) passes `maxBudgetUsd: undefined`
and runs uncapped; see that file's own comment for the (still-current) maintainer decision
behind it. See § Budgets (above) for what actually is enforced — `stepDeadlineMs`,
`LLM_STEP_DEADLINE_MS`, the two retry budgets, and recette's own caps.

**Cache-expiry flag (advisory only).** The `claude` CLI's prompt cache has (at least) two
ephemeral TTL tiers — 5 minutes and 1 hour (`config.js`'s `cacheTtlMs`, currently the observed
1-hour tier this pipeline's calls land in). When the gap between two calls sharing a cached
prefix exceeds that TTL, the cache expires and the next call re-pays cache-creation on the whole
preamble (~40k tokens for a PLAN/IMPLEMENT call) instead of a near-free cache read.
`orchestrator/tokens.js`'s `computeLikelyCacheExpiries` flags a task's call as a
`likelyCacheExpiry` when the gap since its task's previous `llm-call` exceeded `cacheTtlMs` AND
its own cache-creation tokens dominate its cache-read tokens — evidence, never proof (the cache
could have been evicted earlier, or the two calls might never have shared a prefix at all).
`spo tokens` surfaces it as a per-task marker and an aggregate count. Reporting only: nothing
here parks, retries, or otherwise changes pipeline behavior.

## How much the daemon takes on at once

Chantier 6 replaced the single-process daemon with three kinds of process sharing one journal
root, and how much work is in flight is now split across two different questions: how many
tasks run at once, and how many more are allowed to queue up unstarted.

**Three processes, one journal root.**

- The **dispatcher** (`node orchestrator/daemon.js (--shadow|--dry-run|--real)`, no mode flag
  beyond that — `orchestrator/dispatcher.js`) holds the single-instance lock and is the only one
  of the three that does. It spawns and reaps up to `K` worker children and exactly one scanner
  child; it never itself runs a scan or a task.

  It carries **two independent circuit breakers**, and they count differently on purpose. A
  worker's streak (`consecutiveCrashes`) resets on any `done` **or** `parked` outcome — a park is
  a successful run of the state machine, so a run of parked cards can never trip a breaker meant
  to catch a broken one. A scanner has no terminal outcome to succeed at (it only ever leaves by
  crashing), so its streak resets on **uptime**: a scanner that lived at least
  `scannerHealthyUptimeMs` before dying starts a new streak instead of extending the old one.
  Chantier 7 fixed that field, which was incremented and reset nowhere — three scanner crashes
  across a dispatcher's entire lifetime, however far apart, used to stop the whole daemon while
  the journalled field said "consecutive". `scanner-crashed` now carries `consecutiveScannerCrashes`,
  the cumulative `totalScannerCrashes` under its own honest name, the measured `uptimeMs`, and
  `scannerHealthyUptimeMs` itself — without that last one, `{"uptimeMs":45000,
  "consecutiveScannerCrashes":3}` cannot be read without also opening config.js and the
  operator's environment. **The trade this makes is real and is filed as #79**: a crash loop
  slower than the bar never trips the breaker at all, and every scanner respawn runs a full scan
  cycle immediately, because every `should*` predicate treats a null last-run as due now.
- A **worker** (`daemon.js --worker <taskDir>`) runs the one task already sitting in `<taskDir>`
  to its terminal state and exits — action 6.1. It does not take the single-instance lock (the
  dispatcher already holds it for the whole journal root).
- The **scanner** (`daemon.js --scanner`, exactly one, action 6.3) runs `state-machine.js`'s
  `runForever` — now just the periodic scans (orphan/unpark/auto-pull/report-intake) on their
  own timers, queue-draining removed — forever, in its own process. It was split out after
  measuring one of those scans (auto-triage's `claude` call) block the single JS thread for
  3+ minutes, which would otherwise freeze worker-slot refills and SIGTERM handling for that
  whole window if it ran inside the dispatcher's own loop.

**How many tasks run at once.** `orchestrator/dispatcher.js`'s `fillSlots` fills as many worker
slots as `K` currently allows, where `K` is `Math.min(config.workers, healthy accounts)` —
re-clamped to `accounts.countHealthyAccounts(accountsDir)` immediately before *every* spawn, not
once per loop. `config.workers` (`SPO_WORKERS`) defaults to **1** — at K=1 the dispatcher still
spawns a worker child for every task rather than keeping a separate in-process serial path, so
there is one code path to keep correct instead of two.

**How many more are allowed to queue up unstarted.** Auto-pull used to mean "how many candidates
one cycle takes off the board", with nothing else bounding how many cycles could each take that
many — at the shipped defaults (workers=1, autoPullMs=5min, autoPullLimit=1) a scanner with no
ceiling could still put 12 cards/hour into `queue/`, unclaimable by a human, with no relation to
how many workers actually exist. Action 6.6 added a second, harder ceiling above the per-cycle
rate: `orchestrator/auto-pull.js`'s `computeAutoPullBudget` reads how many tasks are already
queued (`queuedIds`) and how many are already in flight (`live-workers.json`, the dispatcher's own
published set — read as `K` worst-case if the file is missing/unreadable, never as 0) and clamps
this cycle's pull to `min(autoPullLimit, K - queued - inFlight)`, never negative. `autoPullLimit`
(`SPO_AUTO_PULL_LIMIT`, **default 1**) survives as the per-cycle rate cap; `K` (`config.workers`)
is the watermark, not `K + autoPullLimit` — the maintainer's own stated rationale for
`autoPullLimit` ("cards stay on the board — visible, reorderable, claimable by a human — until
ready") only holds while `K` is also the ceiling on how much can ever be unstarted-but-claimed at
once. This scan runs in the scanner process (above), not the dispatcher.

At the shipped defaults, this still behaves like the old description in the common case: one card
queued, one worker running, look again next cycle. The difference only shows once `K > 1` or a
maintainer manually queues several cards at once — the watermark, not the per-cycle rate, is what
stops the scanner from over-filling `queue/` beyond what the dispatcher can actually run.

## Where journals live

```
journal/<id>/
  task.json       the original queue file, moved here on intake
  journal.jsonl   append-only: {ts, state, event, ...detail} — one line per event, never rewritten
  ledger.md       one line per DIAGNOSE attempt
  state.json      current state + counters, overwritten every transition
  report.md       written once, only if the task ends PARKED
```

`state.json` is the file `orphan-scan.js` reads at every daemon startup to decide whether a task
is orphaned, so `journal.js`'s `writeState` writes it via tmp-file-then-`rename` (same directory,
atomic within a filesystem) rather than a single `fs.writeFileSync` — a crash or `kill -9`
mid-write can no longer leave a truncated, unparsable `state.json` behind for a real in-flight
task (action 2.5).

`bin/spo`'s read-only subcommands (`status`/`task`/`parked`/`resume`/`tokens`/`reports`) read
only these files (plus `queue/` for depth, and the account pool, `~/.spo-bench`,
`~/.spo-reports` for their own sections) — they hold no state of their own. Several other
subcommands DO write local or live state: `account add`/`account enable`/`account disable`/
`account clear-cooldown` touch the account pool and `state.json`/`daemon.jsonl`; `ask`/`pull`/
`intake`/`triage --file`/`recette` write to real GitHub. See `bin/spo`'s own header comment.

### Journal event literals

`journal.jsonl`/`daemon.jsonl` carry many more event names than the ones called out in prose
elsewhere in this doc. The table below is that missing index — one row per event literal
`doc/comment-corpus-audit-2026-09-03.md`'s E2 finding (action 9.1) found reachable but
undocumented, read from its real `appendEvent`/`appendDaemonEvent`/`journal(...)`-alias call
site(s), not guessed from the name. **Kind** is `task` for a per-card `journal.jsonl` line,
`daemon` for a repo-wide `daemon.jsonl` line (see "Where journals live" above for the
task/daemon split itself).

| Event | Kind | What it records |
|---|---|---|
| `account-cooldown-cleared` | daemon | `spo account clear-cooldown <name>` manually cleared an account's cooldown — journalled so a hand edit of the account pool still leaves a trace (`bin/spo`). |
| `abandon-branch-deleted` | task | `abandon` cleanup deleted the local `claude-pipe/<id>` branch once ancestry proved it safe to drop (`park-loop.js`). |
| `abandon-cleanup-failed` | task | one step of `abandon` cleanup (PR close, worktree remove, local/remote branch delete) exited non-zero or hit an unexpected error — `detail.step` says which (`park-loop.js`). |
| `abandon-cleanup-skipped` | task | the worktree step of `abandon` cleanup was skipped because `git status` itself failed or the tree was dirty — a dirty tree is never destroyed (`park-loop.js`). |
| `abandon-pr-closed` | task | `abandon` cleanup closed the card's open PR (`gh pr close`) before touching the worktree or branch (`park-loop.js`, via its `journal(...)` alias). |
| `abandon-remote-branch-deleted` | task | `abandon` cleanup deleted the remote branch after its tip was vouched for (merged) or preserved (`park-loop.js`). |
| `abandon-remote-preserved` | task | `abandon` cleanup pushed the remote branch's unmerged tip to a throwaway ref before deleting the branch (`park-loop.js`). |
| `abandon-worktree-removed` | task | `abandon` cleanup ran `git worktree remove --force` on a clean tree (`park-loop.js`). |
| `checks-green` | task | CI_CHECKS found every required check passing, routing on to VALIDATE or a main-moved regate (`state-machine.js` / `steps/scripted.js`). |
| `ci-implement-retry` | task | CI_CHECKS routed back to IMPLEMENT for another attempt; records the attempt number and the failing check/step that caused it (`state-machine.js`). |
| `ci-step-lookup-failed` | task | CI_CHECKS could not look up a failing job's step detail via `gh api .../actions/jobs/<id>` (exception, non-zero exit, or unparsable JSON) — routing falls back to check-level classification (`steps/scripted.js`). |
| `comment-scan-backoff-skip` | task | `comment-scan.js`'s own default name for "skipped this cycle, still backed off from a recent `gh` failure" — reached only by a caller that omits its own event override; today's two callers (unpark scan, report-confirm scan) always override it (`comment-scan.js`). |
| `comment-scan-ignored-unauthorized` | task | same posture: `comment-scan.js`'s default name for "a comment matched a keyword but its author is not an authorized collaborator" (`comment-scan.js`). |
| `comment-scan-truncated` | task | same posture: `comment-scan.js`'s default name for "the comment fetch hit `maxPages` before reaching the end of the issue's comments" (`comment-scan.js`). |
| `diagnose-surface-skipped` | task | DIAGNOSE could not post its "diagnosing, attempt N/3" comment because the card carries no GitHub issue number (`park-loop.js`). |
| `diff-empty` | task | the diff captured for this state came back empty even though `committed` files were listed (`steps/scripted.js`). |
| `dispatcher-drain-end` | daemon | the drain finished, written AFTER the signalled stragglers have been reaped rather than at the bound: `drained` (did every in-flight card finish on its own), `waitedMs`, `survivors` (ids still running when the bound expired) and `outcomes` (what each survivor actually ended as). `drained: false` records that the daemon stopped waiting, which is not the same fact as a card being lost — `outcomes` is the one to read for that (`dispatcher.js`). |
| `dispatcher-kill-escalated` | daemon | a signalled straggler was still alive after `config.drainKillGraceMs`, so the dispatcher SIGKILLed it itself rather than waiting unbounded and leaving systemd's cgroup kill as the only backstop (which would skip daemon.js's exit hook and leak the lock file). Records `graceMs` and `stillLive` (`dispatcher.js`). |
| `dispatcher-drain-start` | daemon | a SIGTERM/SIGINT asked the dispatcher to drain instead of killing: records the `signal`, the `timeoutMs` bound (`config.drainTimeoutMs`) and the `inFlight` card ids it is about to wait for. Claiming has already stopped by the time this is written — the scanner, the only producer of new queue entries, is signalled inside `requestDrain` (`dispatcher.js`). |
| `dispatcher-start` | daemon | the dispatcher process started; records its pid, configured worker count and the sha/ref of the PIPELINE checkout it is running (`pipelineSha`/`pipelineRef`, `pipeline-version.js`), and anchors a later "pool idle" edge to this process (`dispatcher.js`). |
| `pipeline-version` | task | the first line a `--worker` writes: the sha and ref of the pipeline checkout THAT WORKER loaded, plus its pid — the per-card answer to "which version of the orchestrator produced this park?". Recorded per worker rather than inherited from `dispatcher-start` because `dispatcher.js` resolves `DAEMON_PATH` at every spawn, so a `git pull` with no restart genuinely puts a new-sha worker under an old-sha dispatcher; the two lines disagreeing is that gap made visible. `sha: null` means the checkout could not describe itself (no `.git`, unreadable HEAD), which is itself the fact worth recording (`daemon.js`, `pipeline-version.js`). |
| `empty-implement` | task | IMPLEMENT's payload declared `files_changed` but the list parsed empty — routes to DIAGNOSE (`state-machine.js`). |
| `force-state` | task | a shadow-mode task's `task.shadow.forceState` short-circuited INTAKE straight to the named state — a test/fixture hook (`state-machine.js`). |
| `gate-main-moved-abort-failed` | task | GATE's `git merge --abort` (cleaning up a failed main-moved regate merge) itself exited non-zero or hit a spawn timeout (`steps/scripted.js`). |
| `gate-main-moved-fetch-failed` | task | GATE's `git fetch origin main` (refreshing before a main-moved regate) exited non-zero — not fatal, continues with the local tip (`steps/scripted.js`). |
| `gate-main-moved-rev-parse-failed` | task | GATE's `git rev-parse origin/main` (checking whether the refreshed main is nightly-red) exited non-zero — the red-main guard is skipped, not fatal (`steps/scripted.js`). |
| `gate-verdict` | task | the bench's verdict for this head sha (`{verdict, baseMain, merged}`) was read and journalled before GATE routes on it (`steps/scripted.js`). |
| `invariants-declared-parsed-mismatch` | task | PLAN's declared `invariant_ids` count disagrees with the count `invariants.js` actually parsed from the worktree — a signal to go look at the parser, never a park (`state-machine.js`, two call sites). |
| `leftover-branch-deleted` | task | WORKTREE's retry-leftover sweep deleted a stale local `claude-pipe/<id>` branch it proved safe to drop (`steps/scripted.js`). |
| `leftover-pr-closed` | task | the leftover sweep closed an open PR on the stale branch before deleting the remote ref (`steps/scripted.js`). |
| `leftover-pr-lookup-failed` | task | the leftover sweep's `gh pr list` for the stale branch failed or returned unparsable JSON — the delete is refused rather than risk closing an invisible PR (`steps/scripted.js`). |
| `leftover-remote-preserved` | task | the leftover sweep pushed the stale remote branch's unmerged tip to a `wip/` ref before deleting it (`steps/scripted.js`). |
| `leftover-worktree-removed` | task | the leftover sweep removed (or pruned the registration of) a stale worktree directory (`steps/scripted.js`). |
| `no-worktree-change` | task | IMPLEMENT's `files_changed` claim was non-empty but `git status --porcelain` on the worktree came back clean — routes to DIAGNOSE (card #385's cross-check, `state-machine.js`). |
| `orphan-scan-unknown-owner` | daemon | the daemon-startup orphan scan found a task `state.json` with no recognisable `owner.workerPid`/`owner.pid` — skipped rather than guessed at (`orphan-scan.js`). |
| `park-anchor` | task | the retry/abandon scan boundary for this park cycle, journalled when `gh issue comment` FAILED so the card stays reachable (issue #77). Carries `at`, stamped **before** the `gh` call so a `retry` posted while it was in flight still counts, but appended **after** it so the anchor remains the worker's last journal event — the only thing stopping `unparkScan` acting on a park mid-write. A successful comment journals `park-comment` instead, and its numeric id is the sharper boundary (`park-loop.js`). |
| `park-comment-skipped` | task | the PARKED-state board comment could not be posted because the card carries no GitHub issue number (`park-loop.js`). |
| `park-repeat` | task | this park shares the same reason+detail fingerprint as an earlier park on the same card, at least twice — feeds the park comment's "repeated" wording (`state-machine.js`). |
| `pr-body-patch-failed` | task | PUSH_PR's `gh api ... -X PATCH` re-titling a reused PR exited non-zero — the reuse still proceeds to GATE (`steps/scripted.js`). |
| `pr-created` | task | `gh pr create` succeeded; records the new PR number before routing to GATE (`steps/scripted.js`). |
| `pr-merge-enqueue` | task | MERGE's enqueue step (`gh pr merge --merge`, or the scripted `prMergeEnqueue`) ran; records its exit code before `pr:wait` (`state-machine.js` / `steps/scripted.js`). |
| `pr-reused` | task | PUSH_PR found an already-open PR for this branch and reused it (patching its body) instead of creating a new one (`steps/scripted.js`). |
| `remote-branch-cleaned` | task | the leftover sweep's final step: the stale remote branch was deleted (`git push origin --delete`) once any PR was closed and the tip preserved or vouched for (`steps/scripted.js`). |
| `remote-report-pull-failed` | daemon | a periodic remote-report pull tick failed — either the pull itself reported `ok: false`, or the call threw (`remote-report-pull.js`). |
| `report-confirm-scan-ignored-author` | daemon | `report-intake.js`'s own name for `comment-scan.js`'s shared `ignoredAuthor` event, reached by the confirm/discard comment scan (`report-intake.js`, via `comment-scan.js`). |
| `report-intake-cycle` | daemon | one report-intake pass filed, deduplicated, or otherwise disposed of at least one report; summarises `processed`/`filed`/`duplicates`/`schemaVersion`/`errors` for the cycle (`report-intake.js`). |
| `report-promote-failed` | daemon | auto-triage's move of a confirmed report's issue to the `Todo` column failed (`board.moveIssueToColumn` returned not-ok) (`auto-triage.js`). |
| `scanner-exit-during-shutdown` | daemon | the scanner subprocess exited while the daemon was already stopping — not counted as a crash (`dispatcher.js`). |
| `scanner-orphan-exit` | daemon | a scanner process detected its parent pid no longer matches the daemon that spawned it, and exited rather than keep running detached (`state-machine.js`'s `runScanCycle` guard). |
| `scanner-spawn` | daemon | the dispatcher spawned the (single) scanner subprocess; records its pid (`dispatcher.js`). |
| `touches-rdo-members-rederived` | task | PUSH_PR's real diff touched the RDO members catalogue even though intake's own guess (`ctx.task.touchesRdoMembers`) said it wouldn't — the flag is corrected before CITATION_VERIFIER runs (`steps/scripted.js`). |
| `uncaught-error` | daemon | `daemon.js`'s top-level handler caught an otherwise-uncaught exception or unhandled rejection; records the crash context (mode, id, taskDir) and a capped message/stack before the process exits (`daemon.js`). |
| `unpark-scan-ok` | task | the unpark (retry/abandon) comment scan reached GitHub, journalled ONLY when that is a change of outcome: the first proven-live scan of this park cycle, or a recovery from a standing `unpark-scan-failed` streak (`afterFailures` says which, and `firstFailedAt` dates the streak it ends). Never per-cycle — a healthy scan that has already said so writes nothing. Project-2 card #476: before it a successful scan journalled nothing at all, so an old failure streak in a journal's tail could not be told apart from a channel that had recovered silently, and "the retry channel is alive" was only ever inferrable from an ABSENCE of failures (`park-loop.js`; the rule deciding when it is an outcome change is `retry-channel.js`'s `shouldJournalScanOk`). |
| `unpark-scan-backoff-skip` | task | `park-loop.js`'s own name for `comment-scan.js`'s shared `backoffSkip` event, reached when the unpark (retry/abandon) comment scan is still backed off from a recent `gh` failure (`park-loop.js`, via `comment-scan.js`). |
| `validate-findings-post-skipped` | task | VALIDATE's findings comment could not be posted because the card carries no GitHub issue number (`park-loop.js`). |
| `wip-preserve-failed` | task | `preserveWorktreeWip` could not commit/push a dirty worktree's diff to a `wip/` ref before a park (a spawn timeout, or a failed `git status`/`checkout --detach`/etc. step) — the park still proceeds without a wip ref (`steps/scripted.js`). |
| `worker-crash-repark-failed` | daemon | the dispatcher's own attempt to repark a crashed worker's task itself failed (couldn't read `task.json`, or an unexpected error mid-repark) (`dispatcher.js`). |
| `worker-exit` | daemon | a worker process exited; records its outcome (done/parked/crashed), code, and signal (`dispatcher.js`). |
| `worker-exit-after-terminal` | daemon | a worker process produced exit-path activity after its task was already DONE/PARKED/ABANDONED on disk — not reparked, so a second writer never races the terminal state (`dispatcher.js`). |
| `worker-exit-during-shutdown` | daemon | a worker crashed while the daemon was already stopping — not counted against the crash-loop breaker (`dispatcher.js`). |
| `worker-spawn` | daemon | the dispatcher spawned a new worker process for a claimed task; records its pid (`dispatcher.js`). |

## CLI

```bash
bin/spo status [--journal <dir>] [--queue <dir>]   # queue depth, active/parked/done, per-task state
bin/spo task <id> [--journal <dir>]                # human-readable timeline from journal.jsonl
bin/spo parked [--journal <dir>]                   # parked tasks + reasons
bin/spo tokens [--journal <dir>]                   # per-task + aggregate token accounting, billable/DONE-card, parking rate (see "Tokens" above)
bin/spo cost [--journal <dir>]                     # DEPRECATED alias for `spo tokens` -- prints a notice, then the same table
bin/spo resume <id> [--journal <dir>]              # print `claude --resume <sessionId>` for a task's LLM steps
bin/spo accounts [--accounts-dir <dir>]            # list the account pool: name, enabled, cooldown, token, credentials
bin/spo account add <name> [--accounts-dir <dir>]  # create the pool slot, print the guided setup steps
bin/spo account clear-cooldown <name>              # drop a locally-invented cooldown (and its escalation state)
bin/spo account enable|disable <name> [--accounts-dir <dir>]  # toggle the `disabled` marker
bin/spo ask <text…> [--dry]                        # draft -> review -> file a card (see "Intake" above)
bin/spo ask --draft-file <path> [--dry]             # same, skipping DRAFT_CARD (brainstorm lane)
bin/spo pull [--limit <n>]                         # write queue/<seq>-issue-<n>.json for the top N claimable board cards
bin/spo pull-reports                               # STAGE 0: pull queued reports from a production deployment over HTTPS
bin/spo intake [--limit <n>] [--reports-dir <dir>] # STAGE 1: file a RAW report card, zero LLM calls (see "Report intake" above)
bin/spo reports [--reports-dir <dir>]              # list what's pending a "confirm"/"discard" reply -- the intake analogue of `spo parked`
bin/spo triage [--limit <n>] [--file]              # STAGE 3: reproduce/route/draft the CONFIRMED reports; defaults to --dry
bin/spo triage --retry <issue> [--file]            # action 3.4: re-inject one HELD report (report-held / report-held-mechanical / do-not-file); defaults to --dry (see "The recovery path" above)
bin/spo recette [--scenario <name>] [--keep] [--dry] [--force]  # the supervised live harness -- one trivial synthetic card, real mode (see "Recette" above)
```

## Dashboard

```bash
bin/spo dashboard [--journal <dir>] [--queue <dir>] [--out <path>]   # generate once (static): the deck at --out, health.html beside it
bin/spo dashboard --watch                                            # regenerate every 30s (setInterval), Ctrl-C to stop
bin/spo dashboard --serve [--port 8090] [--host <addr>] [--no-prod]  # live server (see below), Ctrl-C to stop
```

### Two pages

`/` is the **flight deck**, `/health` is everything else. The split exists because the console
answered "is the machine healthy" and could not answer "what is the machine doing": you had to
know which tile to read before it told you anything.

The deck draws each live card as a run along the twelve-state track from `state-machine.js`'s
lifecycle table, using the vocabulary in `console/plain-language.js` -- one plain sentence per
state, each checked against the commands that state actually runs, so CHECK reads "checking it
compiles, passes lint, and the tests still pass" rather than "CHECK". Four things on it are
measured rather than styled:

- **Retry budgets are drawn as lives.** `diagnoseBudget`, `validateRejectBudget`, `ciRetryBudget`
  and `mainMovedRegateBudget` from `config.js`. Spending them all IS how a card parks, so a
  filling row of pips is a card heading for a hand-back.
- **Par times** come from `console/par-times.js`, which walks every journal on disk and takes the
  p50/p90 of each state, one sample per VISIT. The live server recomputes on a five-minute timer
  and persists to `<journalRoot>/par-times.json`; `collectAll` only ever reads that file -- the
  same split `collectTrend` already uses for the tokens trend.
- **Being sent back** is derived, not special-cased: `collect.js`'s `buildRun` flags a leg whose
  exit transition moved to an earlier position on the track, or to DIAGNOSE. 22 of 39 journals in
  the corpus loop at least once; only 17 walk the track cleanly.
- **What an LLM step is doing right now** comes from `console/live-step.js`. PLAN, IMPLEMENT,
  DIAGNOSE and VALIDATE run through `spawnSync` with piped stdio, so nothing is journalled and no
  log grows until the call returns -- twelve minutes at IMPLEMENT's p90. The `claude` CLI's own
  session transcript does move, and is reachable by an exact chain of identities: `state.json`'s
  `owner.workerPid` names the worker, the lease file naming that pid names the account,
  `config.cwdForStep` names the directory, and the session file created after the split's
  `enteredAt` is this step's. Any break in that chain returns a named miss and the deck falls
  back to the clock alone -- it never guesses which transcript belongs to which card.

The deck shows LIVE cards only: no history list, no Todo. A finished run lingers for ten minutes
(`DECK_LINGER_MS`) so a run that ends while you are looking at it does not vanish mid-glance --
which is also what bounds the cost, since the per-leg walk runs for those cards and no others.
The pipeline is idle most of the time (12.4% duty cycle measured over a week, and `SPO_WORKERS`
defaults to 1), so the standing-by panel is the common case and names the queue depth: without
it, "nothing to do" and "work waiting and the daemon is wedged" look identical.

`/health` carries the service tiles, daemon counters, accounts, reports and token trend the root
page used to carry -- the same `renderXxxInner` functions with the same fragment ids, moved
rather than rewritten. The deck links across to it and names what is degraded, so an unlabelled
warning light never sends you to the other page just to find out what it meant.

Three poll cadences in `--serve` mode: `/api/live` every 2s (the deck alone -- it renders a card
that moves), `/api/system` every 1s (CPU/memory, health page only), `/api/data` every 30s
(everything else). `/api/data` also carries the `live` fragment so a client that never started
the fast timer still refreshes.

Two render modes, same underlying data:

- **Static** (default, and `--watch`): `console/collect.js` reads the local surfaces
  (`journal/<id>/`, `queue/`, the account pool via `orchestrator/accounts.js`, the read-only
  `~/.spo-bench/{nightly/latest.json, verdicts/*.json}`, and `~/.spo-reports` for the bug-report
  pipeline counters) and hands the result to `console/render.js`, a pure function producing one
  self-contained HTML file: inline CSS, no external requests, a 30s `<meta
  http-equiv="refresh">`, light+dark via `prefers-color-scheme`. Instant and network-free -- the
  CPU/memory card and the Prod tile render as "not monitored" in this mode (the tokens trend is
  the one exception, see below -- it can still show history in static mode). A missing source
  renders as an empty section, never a crash -- same "reader, never a second source of truth"
  rule as the rest of the console.
- **Live** (`--serve`): `console/serve.js` wraps the same `collectAll`/`renderDashboard` but adds
  two JSON routes the page polls client-side (no full reload): `GET /api/system` (CPU-per-core +
  memory, meant to be polled every 1s -- see `console/system.js`) and `GET /api/data`
  (everything else -- services (daemon/queue/workers/retry-channel/bench-worker/nightly/verdicts/
  prod), accounts,
  daemon stats, bug reports, tokens -- meant to be polled every 30s). `--no-prod` disables the
  outbound starpeace.zz.works / GitHub Releases probe (`console/prod-version.js`) for an offline
  run. **Binds all interfaces by default, with no authentication of its own**: `bin/spo`'s
  `server.listen(port, opts.host || undefined, …)` binds `::`/`0.0.0.0` unless `--host` names a
  specific interface, and `console/serve.js` has no auth layer at all -- the externally hosted
  copy's nginx + basic auth (a `spo dashboard` + rsync concern owned by SPO-Deploy) is the only
  access control in front of it. Run `--serve` with an explicit `--host localhost` (or behind a
  firewall) unless you mean to expose it.

Per-task detail (id, state, reason, per-LLM-step `claude --resume <sessionId>`) is deliberately
NOT rendered -- it duplicates the GitHub Projects board (Kanban), which owns that view. The
journal is still read for other consumers (daemon stats, token-usage session attribution). The
dashboard never renders a dollar figure -- this build carries none anywhere. `spo tokens` /
`orchestrator/tokens.js` own the token-accounting view instead (`spo cost` stays as a
deprecated alias).

**Bug reports card:** counters only (queued/pending/confirmed, last intake cycle, 24h
filed/held/duplicate, remote-pull health) from `orchestrator/report-intake.js` +
`auto-triage.js` + `remote-report-pull.js`'s own `daemon.jsonl` events -- never a report's file
path, URL, token, or free-text `reason`/`error` field (those can carry secrets or a production
URL). See § Report intake above for the pipeline itself.

**Prod tile:** watches `starpeace.zz.works` (SPO-WebClient's production deployment) without SSH,
via two independent HTTPS probes (`console/prod-version.js`): a root/`SPO_PROD_HEALTH_PATH` ping
for UP/DOWN + latency (cached `SPO_PROD_URL` default `https://starpeace.zz.works`, 120s TTL),
and the SPO-WebClient GitHub Releases API for the "expected" (latest tag) version (300s TTL,
unauthenticated). No `/healthz` endpoint exists on production today -- that would be a
SPO-WebClient/SPO-Deploy change, outside this repo's scope -- so the deployed version shows
"not exposed" until one is added; a `~v1.2.3` prefix on the tile means that's the expected
(release-tag) version, unconfirmed live. Rendered as one of the top services tiles, not its own
section -- see `console/render.js`'s `renderProdTile`.

**Tokens card:** two parts. The primary view is an operating-cost **trend**
(`console/usage-scan.js`'s `buildTrendViews`, fed by `<journalRoot>/usage-rollups.json` -- a small,
durable daily-rollup file the live server's usage-scan timer writes on the same ~5-minute
cadence it already scans on, capped at 180 days): a weighted (`WEIGHT()`-formula) average
Mtok-equivalent per session, with today/7d/30d KPI tiles and week-over-week deltas, a sparkline,
and a 14-day bar list flagging days where the cache-write ratio spiked (a near-deterministic
sign a prompt/config file changed that day, since prompt caching invalidates on any change to
the cached prefix). Because it only reads an already-computed rollup file, this part CAN show
history in static mode too, as long as a live server has run at least once before. The demoted,
collapsed **breakdown** (`<details>`, "Task / model / account breakdown") is the old by-task /
by-model / by-account tables: live mode incrementally scans every pool account's own
`CLAUDE_CONFIG_DIR/projects/` plus `~/.claude/projects` as the synthetic `local` account
(`console/usage-scan.js`, first pass 2s after the server starts, then every 5 minutes, cached by
mtime+size so an unchanged transcript is never re-read -- see the module's own header on why a
naive slurp took a WSL VM down once; `local` usage is excluded from the trend above, since it's
ambient/non-pooled and not part of the daemon's own operating cost), joins each `sessionId` back
to its SPO task via the journal's own `llm-call` events (`console/collect.js`'s
`buildSessionIndex`). Static mode has no live scan for this part; it falls back to an optional,
operator-produced `journal/usage-snapshot.json`:

```bash
node scripts/usage-report.js > journal/usage-snapshot.json
```

## Tests

```bash
node --test --test-timeout=30000 test/*.test.js
```

From the repo root. **Do not run it bare.** Bare `node --test` auto-discovers recursively, so the
moment a parked card holds a product worktree under `~/.spo-worktrees/issue-<n>/` it walks into
SPO-WebClient's own TypeScript suites and reports thousands of foreign failures — 1926 tests /
1168 failures with four parked cards, none of them this repo's. `worktrees/` is gitignored, so
`git status` stays clean and the result reads as a catastrophic regression in code that is fine.
`--test-timeout=30000` bounds a single test that hangs instead of letting the whole run stall
(`doc/remediation-progress.md` pins the reference count at this invocation). **When reading the
result — mutation testing especially — check `# fail` AND `# cancelled`, never `# fail` alone.**
Node reports a timed-out test as `cancelled`, not `fail`: a run that prints `# pass 1418 # fail 0`
can still have killed a hanging test past the 30s bound, and reading `# fail` alone reads that
killed mutant as a survivor.

`node --test test/` does not work either: Node treats `test/` as a test-name filter rather than a
directory, matches nothing, and prints `not ok 1 - test`.

The glob loses nothing — verified by diffing test names against bare discovery. The only
difference is `test/helpers.js`, which bare discovery loads as a test file and counts as one
passing "test" despite defining none. `scripts/smoke-llm.js` (the one manual real `claude` call)
still deliberately lives outside `test/`, and now also outside the glob.

All state-machine tests run in `--shadow` mode against `fs.mkdtempSync(os.tmpdir())`
queue/journal directories — no shared state, no product-repo or bench interaction, no network.
`test/llm-real.test.js`, `test/llm-real-card.test.js` and `test/account-rotation.test.js`
exercise **real-mode** LLM code (`invokeClaudeReal`, `callLlmStep`) and `test/real-steps.test.js`
exercises the real-mode **scripted** functions ("Real scripted steps" above, now including each
one's own `board.js` `moveCard` call) — all of them only ever through an injected fake
`spawnSync` (`deps.spawnSync`), calling
`realWorktree`/`realCheck`/`realPushPr`/`realGate`/`realCiChecks`/`realMerge`/`realFinish`
directly rather than through `daemon.js`'s own dispatch (which has no injection point). Kanban
piloting's own tests follow the same convention one layer up: `test/board-move.test.js` covers
`board.js`'s `moveCard` directly plus `HANDLERS.IMPLEMENT`/`HANDLERS.VALIDATE`'s real-mode move
(via `buildCtx`'s `config.deps`, since neither state has a `realX(ctx, deps)` split of its own);
`test/park-loop.test.js` covers the park comment's content and the PARKED round trip via
`runTask` directly, plus `unparkScan`'s retry/abandon/idempotency and (action 2.7) its own
collaborator-allowlist/pagination/backoff integration on top of `comment-scan.js`;
`test/comment-scan.test.js` covers that shared module directly -- pagination across pages and its
bound, the collaborator cache's fail-open/stale decisions, and per-issue backoff -- independent of
either caller; `test/auto-pull.test.js`
covers `shouldAutoPull`'s pure timer decision and `runAutoPull`'s top-N + journal-only-when-
enqueued rules; `test/remote-report-pull.test.js` covers stage 0 (`shouldPullRemoteReports`,
`isSafeReportFilename`/`readPullToken`, the list->fetch->land->ack wiring via an injected
`deps.http` -- untrusted-input rejection, sha256 verification, the "already-acked filename is
skipped" and "local-but-unacked file retries the ack only" idempotency cases) -- no real socket is
ever opened; `test/report-intake.test.js` covers stages 1-2 of the human-first bug-report
pipeline (`shouldAutoIntake`/`shouldScanConfirms`, `parseCardOutput`, the mechanical dedup, the
confirm/discard comment scan's anchor logic, and -- same as `test/park-loop.test.js` -- action
2.7's collaborator-allowlist/pagination/backoff integration on the shared `comment-scan.js`);
`test/auto-triage.test.js` covers stage 3
(`shouldAutoTriage`, `findConfirmedAwaitingTriage`, `processConfirmedReport`'s outcome routing --
including the "a negative outcome after confirm is HELD, never archived" rule -- and the dry/real
split); `test/spo-triage.test.js` covers `cmdPullReports`/`cmdIntake`/`cmdReports`/`cmdTriage`'s
flag wiring, same convention as `test/intake.test.js`'s `cmdAsk`/`cmdPull` coverage (which also covers
`amendCard` and `makeTask`'s `reportIntakeLabel` skip guard). `test/recette.test.js` covers the
live harness (action 2.9, "Recette" above) the same way: `--dry`'s zero-side-effects guarantee,
the daemon-lock refusal and its `--force` override, a full real-mode happy path to `DONE` through
an injected `spawnSync` covering every git/gh/npm/`claude` call the `trivial-doc-log` scenario
makes (including recette's own issue creation and cleanup), both caps tripping mid-run and still
cleaning up, cleanup's idempotency (including when the injected `spawnSync` itself throws), and
`evaluateAssertions` as a pure function -- including the one that hands it a `DONE` journal
missing a required event and confirms the assertion set actually catches it, never rubber-stamping
a run that merely reached `DONE`. None of them ever touch a real
`git`, `npm`, `gh` or `claude` process in-process -- but that is not the same as "the whole suite
never spawns one for real": a test that spawns a real `daemon.js --worker`/`--scanner` child
reaches the real `spawnSync` inside that child, unpatched. See "The hermeticity guarantee stops
at a process boundary" immediately below.

**The hermeticity guarantee stops at a process boundary.** `test/no-real-spawn.js` (the killswitch
above) patches `child_process.spawnSync` in the parent test process only — it protects every call
made in-process, but a test that spawns a real `daemon.js --worker`/`--scanner` child reaches the
real `spawnSync` inside that child with no killswitch at all, since the patch was never applied to
that process's own `child_process` module. This is a limitation of the guard's own design, not a
bug in it (`test/no-real-spawn-sweep.test.js`'s file-by-file scan can only ever prove "this file
requires the module first," never "nothing this file's tests spawn can reach `spawnSync`
unpatched"), and it was proved the hard way during chantier 7: a mutation-testing round routed
tests through real `daemon.js --worker` children and created a live worktree and branch in
`/home/crazz/SPO-WebClient` while the `--real` daemon was running against it. Any future test that
spawns the dispatcher or a worker/scanner child for real needs its own injection point or its own
isolation — this suite does not give it one for free.
