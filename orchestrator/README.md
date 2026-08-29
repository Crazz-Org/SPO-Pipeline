# orchestrator — v2 skeleton, shadow mode

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
  over `--dry-run`. Nothing in the `node --test` suite ever spawns a real `git`/`npm`/`gh`/
  `claude` process — every real-mode test (`test/llm-real*.test.js`,
  `test/account-rotation.test.js`, `test/real-steps.test.js`) injects `deps.spawnSync` and calls
  the real-mode functions directly, never through `daemon.js`'s own child-process dispatch.
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
| `ciChecks` | the one failing CI check name this CI_CHECKS visit, or falsy for green | string \| null |
| `mainMoved` | whether `origin/main` touched the branch's files this CI_CHECKS visit | boolean |
| `prWait` | `pr:wait` exit code: 0 merged · 1 closed unmerged · 4 still open (bounded re-wait) | number |
| `llm.PLAN`, `llm.IMPLEMENT` | step payload; any object with `ok !== false` succeeds | object |
| `llm.DIAGNOSE` | `{ "rootCause": "…" }` | object |
| `llm.CITATION_VERIFIER` | `{ "verdict": "PASS" \| "REJECT" \| "DIVERGES" }` (only consulted when `task.touchesRdoMembers` is true) | object |
| `llm.VALIDATE` | `{ "verdict": "PASS" \| "PASS_WITH_FINDINGS" \| "REJECT" }` | object |
| `delays.<STATE>` | artificial ms delay before that step returns, for the deadline test | number |
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

Two independent counters per task, both journaled and both visible in `state.json`:

- **DIAGNOSE → IMPLEMENT retries**: `diagnoseBudget` (default 3) attempts total; any root
  cause seen twice for the same task parks immediately, even under budget. One line per
  attempt in `ledger.md`: `attempt N | root cause | outcome`.
- **VALIDATE REJECT**: `validateRejectBudget` (default 3), separate from the above — a REJECT
  verdict from `change-validator` retries straight to IMPLEMENT, no DIAGNOSE call.

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
  maxBudgetUsd: 0.10,
  promptText: 'Reply with exactly the single word: ok',
  cwd: '/home/crazz/SPO-Pipeline',
  account: { name: 'default', configDir: null },
  allowedTools: 'Read Grep',      // optional
  permissionMode: 'plan',         // optional
  jsonSchema: { type: 'object' }, // optional
  deadlineMs: 120000,             // optional -- see "deadline handling" below
});
// -> { ok: true, result: 'ok', sessionId: '...', costUsd: 0.0004, numTurns: 1, raw: 0 }
```

It spawns `claude -p <prompt> --model <model> --effort <effort> --output-format json
--max-budget-usd <n>` (plus `--allowedTools`/`--permission-mode`/`--json-schema` when given),
parses the JSON on stdout, sums `costUSD` across every entry of `modelUsage`, and classifies a
failure as `{kind: 'limit'}` (an `api_error_status` of 429, or a message matching
`/limit|overloaded|rate/i`) or `{kind: 'error'}` (everything else). `deps.spawnSync` is the test
injection point — production code never passes it, so a real call always spawns the real
`claude` binary on `PATH`.

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

`size` (`S`/`M`/`L`) drives effort and budget for PLAN/IMPLEMENT (`step-contracts.js`'s
`EFFORT_BY_SIZE`/`BUDGET_BY_SIZE_USD`); `touchesRdoMembers` is the RDO wire-rule escalation flag
for IMPLEMENT and VALIDATE (never PLAN — see the DIVERGENCE comment on `step-contracts.js`'s
PLAN entry); `escalate` is the generic "Opus 5 fallback" override every step but DIAGNOSE and
CITATION_VERIFIER can read; `citations`/`spoOriginalPath` only matter to CITATION_VERIFIER, and
only when `touchesRdoMembers` is true.

Each prompt's `{{placeholder}}` values come from one of two places
(`orchestrator/task-values.js`):

- **known at build time** — read straight off the task or `ctx.taskDir`:
  `{{issue_number}}`/`{{task_title}}`/`{{task_criterion}}`/`{{worktree}}`/`{{task_size}}` from
  the task fields above; `{{scratch_dir}}` = `journal/<id>/scratch`; `{{ledger_path}}` =
  `journal/<id>/ledger.md` (the file `journal.js` already owns); `{{spo_original_path}}`
  defaults to `~/SPO-Original`.
- **unknown at build time** — produced by an *earlier* state's own LLM call and read back from
  that state's journaled `result` event (`handlePlan` already does
  `appendEvent(ctx.taskDir, 'PLAN', 'result', { payload })` — `task-values.js` is the reader
  side of that same record): `{{plan_path}}`/`{{invariants_path}}`/`{{invariant_ids}}`/
  `{{check_commands}}` feed IMPLEMENT, and `{{invariants_path}}`/`{{invariant_ids}}` feed
  VALIDATE, both from PLAN's own output.
- `{{diff_path}}` / `{{gate_log_path}}` / `{{gate_report_path}}` are named as fixed
  `journal/<id>/{diff.patch,gate.log,gate-report.md}` conventions — nothing writes them yet,
  since real CHECK/GATE/PUSH_PR execution remains the documented stub described above; naming
  the path now fixes the contract a future real implementation of those steps must honour.

A missing value for any placeholder a prompt's header declares — PLAN called before
`worktreePath` is set, IMPLEMENT called before PLAN has run, or any other gap — throws
`prompt-template.js`'s `MissingPlaceholderError`, caught in `runLlm` and re-thrown as
`ParkSignal('prompt-missing-placeholder:<name>', { promptFile, placeholder, missing })`: the
task parks, it never sends a prompt with a bare `{{...}}` still in it. Fill is all-or-nothing —
one missing placeholder blocks the whole call, never a partial substitution.

A successful reply's `result` string is `JSON.parse`d and checked against the step's
`outputContract.required` (`in` check, so a legitimately-`null` field like DIAGNOSE's
`root_cause` still counts as present); a missing key returns the same `{ok: false, kind:
'error'}` shape `invokeClaudeReal` itself uses for a spawn/parse failure — handled by the same
existing DIAGNOSE/PARK paths in `state-machine.js`, no new failure category. The validated
payload is also given a snake_case→camelCase alias of every key (`root_cause` → `rootCause`
too, additively — this is the one step whose contract key differs from what
`state-machine.js`'s handlers already read; every other step's key names matched by
coincidence).

### --dry-run

`node orchestrator/daemon.js --dry-run --once [--queue <dir>] [--journal <dir>]` runs real-mode
semantics — step-contracts.js resolution, prompt-template.js fill, account rotation — **without
spawning anything**. `runLlm` (steps/llm.js) and `runScripted` (steps/scripted.js) both check
`ctx.dryRun` immediately before their own spawn point:

- an **LLM step** builds the real prompt and the real argv (via the same `buildArgv` real mode
  uses), writes both to `journal/<id>/dryrun-<STATE>.md` (the argv with the `-p` prompt elided
  to a pointer, then the filled prompt in full underneath — otherwise the one line worth
  scanning for `--model`/`--effort`/`--json-schema` is buried inside one giant JSON string),
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
                             epochMs}}. Disposable — deleting it just clears every cooldown.
```

A pool directory with zero subdirectories registers zero accounts: `accounts.pick()` throws a
typed `NoAccountsRegisteredError` (`state-machine.js` maps it to PARKED, same as
`AllAccountsCoolingError`), and `daemon.js --real` refuses to even start.

**Adding a Claude Max account** — guided, via `bin/spo`, never by hand-editing a registry file:

```bash
spo account add acct-2
```

prints the exact next steps (`CLAUDE_CONFIG_DIR=... claude setup-token`, where to paste the
token, the `chmod 600`, then `spo accounts` to verify) — it never runs `claude` itself.
`spo account enable <name>` / `spo account disable <name>` toggle the `disabled` marker.
`K` parallel workers scales with `K` healthy accounts — the gate itself stays serialized (one
live world), so adding an account adds implementation capacity, not gate throughput
(state-machine-spec.md § Account pool).

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
`test/` is auto-discovered by bare `node --test` on this Node version, even without a `.test.js`
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

**Where the commands run.** `config.productRepo` is always `path.join(os.homedir(),
'SPO-WebClient')` — the product checkout, never a relative `../SPO-WebClient` (a session
worktree's `..` does not resolve there). `config.pipelineWorktreesDir` (default
`<repo>/worktrees`, git-ignored) is where WORKTREE creates one `git worktree add` per task,
`<pipelineWorktreesDir>/<taskId>`; every later real step (and PLAN/IMPLEMENT via
`config.cwdForStep`) reads that path back off `ctx.task.worktreePath`, set once WORKTREE
succeeds. `config.ghRepo` (`Crazz-Org/SPO-WebClient`) is the `--repo` / API path every `gh`
call uses. `config.spoBenchDir` (default `~/.spo-bench`) is where the nightly-red refusal and
the main-moved `baseMain` lookup read local JSON instead of polling GitHub or the bench.

**WORKTREE, in order — and why claim is last.** `git -C <productRepo> fetch origin`, then `git
-C <productRepo> rev-parse origin/main` to get the sha the nightly check compares against
`~/.spo-bench/nightly/latest.json`'s `{verdict, sha}` (a `FAIL` at that exact sha parks
`nightly-main-red` before anything is created); then `git -C <productRepo> worktree add
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

**CHECK** runs `npm run typecheck`, `npm run lint`, `npm run coverage:changed` in that order in
the worktree; the first non-zero exit journals `{event: 'check-failed', alias}` naming which one
and returns `'DIAGNOSE'` (never PARKED) — the later aliases never run once one has failed.

**PUSH_PR** writes the commit message to `journal/<id>/commit-message.txt` (`git commit -F
<file>`, never the message inline on argv) and the PR body — `Closes #<issue>` plus a
`claude-pipe/<taskId>` pipeline stamp — to `journal/<id>/pr-body.md` (`gh pr create --body-file
<file>`), then `git add -A` / `git commit -F <file>` / `git push -u origin claude-pipe/<taskId>`
/ `gh pr create --repo <ghRepo> --title <title> --body-file <file>`, all `git -C <worktree>`. The
PR number is parsed off the `/pull/<n>` URL in `gh pr create`'s stdout and stored on `ctx.prNumber`
(and from there into every `state.json` snapshot) for MERGE and FINISH to read back; an
unparsable URL parks `push-pr-failed` (`step: 'pr-number-unparsed'`) rather than guessing.

**GATE** runs `npm run gate` in the worktree; the exit-code table is unchanged from shadow mode
(0 → `'CI_CHECKS'`, 1 → `'DIAGNOSE'`, 2/3/4 → PARKED `gate-dirty-tree`/`gate-worker-down`/
`gate-timeout`).

**CI_CHECKS** does the same two things the shadow-fixture path does, for real: (a) `git -C
<worktree> rev-parse HEAD`, then `gh api repos/<ghRepo>/commits/<headSha>/check-runs`, mapped to
`{name, conclusion}` pairs; the first check whose conclusion isn't `success`/`neutral`/`skipped`
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

**FINISH** runs `npm run board:move -- <issue> Done` and `gh issue comment <n> --repo <ghRepo>
--body-file <file>` (a 2–4 line comment in `journal/<id>/final-comment.md`) **before** removing
the worktree — the same "npm aliases need a product cwd" rule as WORKTREE's claim ordering, so
the board sync must happen while the worktree still exists. Only then `git -C <productRepo>
worktree remove --force <worktreePath>`. A final `finished` journal event carries the task's
summed `costUsd` (every `llm-call` event's `costUsd` in `journal.jsonl`) and the PR number.

**Every spawn**, across all seven functions, journals one compact `{state, argv (first 6
tokens), exit, ms}` `'spawn'` event via `appendEvent`, and appends its stdout (falling back to
stderr) to `journal/<id>/logs/<STATE>.log` — several spawns share one state's log file, in
call order, each under its own `----- <command> -----` header.

**`--real`** (`daemon.js`) is required for any `kind: "card"` task to leave `INTAKE` once neither
`--shadow` nor `--dry-run` applies — `state-machine.js`'s `handleIntake` parks a card task with
reason `real-flag-required` if `ctx.config.real` isn't set, as a defense-in-depth check
independent of the CLI flag (so a caller that builds `ctx.config` by hand gets the same
refusal). `--real` and `--shadow` are mutually exclusive at the CLI (`daemon.js` refuses to
start with both); a non-`"card"` (e.g. `"synthetic"`) task is never gated by `--real` at all.

**First live run is maintainer-supervised.** Nothing in `node --test` ever spawns a real
`git`/`npm`/`gh` process — every test in `test/real-steps.test.js` injects `deps.spawnSync` and
calls `realWorktree`/`realCheck`/... directly. The first time `daemon.js --real` actually drives
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

`CI_CHECKS` is deliberately absent -- it stays under `Gate`, no move. Every move above except
FINISH's own goes through `board.js`'s `moveCard(ctx, deps, state)`: `npm run board:move --
<issue> "<Column>"`, cwd = the task's worktree. **A failed move is journaled
(`board-move-failed`) and never blocks the task** -- board display is best-effort, the journal
is the truth. Before the worktree exists (a pre-WORKTREE park, e.g. `nightly-main-red`), the
move is skipped and journaled `board-move-skipped` (`reason: "no worktree"`) instead of
attempting a `board:move` with no product cwd to run it from; the issue comment (gh needs no
cwd) still posts either way.

### Park <-> kanban round trip

When a real, `kind: "card"` task parks, `state-machine.js`'s `finalizePark` calls
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

**`unparkScan`** (`park-loop.js`) runs once per daemon poll cycle, real mode only
(`state-machine.js`'s `runForever`, gated on `config.real` the same way everything else real in
that file is). For every journaled task still `PARKED` with a park-comment anchor not yet acted
on, it reads the issue's comments (`gh api repos/<repo>/issues/<n>/comments` -- one page,
GitHub's default 30; a very long-lived parked issue could in principle need pagination this
build does not implement) and looks only at comments posted after the anchor, oldest first. The
first one whose **first line** is `retry` (optionally followed by more text) or `abandon`,
case-insensitive, decides the outcome; anything else on the issue -- a `retry` posted *before*
the park comment, or a comment matching neither word -- is left alone, since a human
conversation on the issue is allowed:

- **`retry`** -- re-enqueues the task (`reEnqueueTask`: a fresh `queue/retry-<ts>-<id>.json`
  with the original `task.json` fields, `worktreePath`/`branch` dropped so WORKTREE derives both
  fresh, same as a first attempt) and journals `unparked-by-maintainer`. `buildCtx`'s fresh
  `ctx.counters` on the next `runTask` naturally resets the transient DIAGNOSE/VALIDATE-reject
  counters; the ledger (`journal/<id>/ledger.md`) is untouched, since the retry reuses the same
  `journal/<id>` directory the ledger already lives in.
- **`abandon`** -- terminal: `state.json`'s `state` is rewritten to `ABANDONED` directly (this
  task never re-enters `runTask`'s loop), journaled `abandoned-by-maintainer`, and a one-line ack
  comment ("Understood -- closing this attempt.") is posted on the issue. The card's *column* is
  deliberately left alone here -- where it lands next is the maintainer's own board gesture, not
  this build's to make.

Idempotent across scans: a task already acted on for its current park cycle (an
`unparked-by-maintainer`/`abandoned-by-maintainer` event already follows the anchor
`park-comment` in the journal) is skipped, whether or not the re-enqueued task has been drained
back out of `PARKED` yet.

### Auto-pull

`daemon.js --real`, when not `--once`, also runs `auto-pull.js`'s `runAutoPull` on a timer
between drain passes (`state-machine.js`'s `runForever`) -- the exact same `pullBoard` +
`makeTask` `spo pull` already runs by hand (same dedup: `makeTask` skips an issue already in
`queue/` or `journal/`), for the top `config.autoPullLimit` (default 3) claimable candidates.
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
entirely in the brainstorm lane) and one review-card -- both at `SMALL_BUDGET_USD`
(`step-contracts.js`), an order of magnitude cheaper than a single PLAN/IMPLEMENT call.

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
startedAt, mode}`, created atomically with `open(..., 'wx')` — acquired in `daemon.js` right
after the directories exist, released on exit and on SIGINT/SIGTERM. A second daemon on the
same root exits 1 naming the holder; the likely collision is a hand-run
`node orchestrator/daemon.js --real` while the systemd unit is up.

Why it exists: `takeNextTask`'s rename is atomic, so a contended task never runs twice — but
the losing daemon's `fs.renameSync` throws ENOENT, which (per `park-signal.js`'s catch-all
doctrine) crashes it; and two daemons also clobber the account pool's `state.json`
read-modify-write and double-run the auto-pull timer.

The lock is scoped to the journal root, not the process, so the test suite's temp-dir daemons
never contend with a live one. A holder whose pid is dead (hard kill, power loss) is swept and
taken over on the next start, journaled as a `lock-stale-taken` event in
`<journalRoot>/daemon.jsonl`.

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

## Spend: the reader and the ceiling

`orchestrator/cost.js` reads what the pipeline has spent back out of the journals — every real
`claude -p` call already records its own `costUsd` in an `llm-call` event, so there is no
second ledger to keep in sync. Two callers share the one computation:

- **`spo cost`** — per task (state, calls, cost, park reasons), then the aggregate, cost per
  DONE card and the parking rate. Parked-task count and park-*event* count are both printed
  because they answer different questions: card #247 parked six times and still reached DONE.
- **The cumulative ceiling** — `SPO_SOAK_BUDGET_USD` (config `soakBudgetUsd`, unset by default,
  so a supervised run is unaffected). Distinct from `step-contracts.js`'s **per-step** caps
  ($2/$5/$12 by size, $3 small, PLAN floor $3): those bound one call, this bounds a whole
  unattended run.

Reaching the ceiling stops the daemon **taking new work** and never interrupts a task in
flight — a card killed mid-flight leaves a worktree, a branch and possibly a PR half-done,
which costs more to clean up than the overrun it saves. The check runs *before* `takeNextTask`,
so a refused task stays in `queue/` untouched (nothing to clean up, and it runs as-is once the
ceiling is raised), and auto-pull stops enqueuing. One `budget-ceiling-reached` event per drain
pass lands in `<journalRoot>/daemon.jsonl`.

Note the daemon drains **serially** — one task at a time (`drainQueueOnce`). `autoPullLimit`
is how many cards are *enqueued* per auto-pull cycle, not a concurrency setting.

## Where journals live

```
journal/<id>/
  task.json       the original queue file, moved here on intake
  journal.jsonl   append-only: {ts, state, event, ...detail} — one line per event, never rewritten
  ledger.md       one line per DIAGNOSE attempt
  state.json      current state + counters, overwritten every transition
  report.md       written once, only if the task ends PARKED
```

`bin/spo` reads only these files (plus `queue/` for depth) — it holds no state of its own.

## CLI

```bash
bin/spo status [--journal <dir>] [--queue <dir>]   # queue depth, active/parked/done, per-task state
bin/spo task <id> [--journal <dir>]                # human-readable timeline from journal.jsonl
bin/spo parked [--journal <dir>]                   # parked tasks + reasons
bin/spo resume <id> [--journal <dir>]              # print `claude --resume <sessionId>` for a task's LLM steps
bin/spo accounts [--accounts-dir <dir>]            # list the account pool: name, enabled, cooldown, token, credentials
bin/spo account add <name> [--accounts-dir <dir>]  # create the pool slot, print the guided setup steps
bin/spo account enable|disable <name> [--accounts-dir <dir>]  # toggle the `disabled` marker
bin/spo ask <text…> [--dry]                        # draft -> review -> file a card (see "Intake" above)
bin/spo ask --draft-file <path> [--dry]             # same, skipping DRAFT_CARD (brainstorm lane)
bin/spo pull [--limit <n>]                         # write queue/<seq>-issue-<n>.json for the top N claimable board cards
```

## Dashboard

```bash
bin/spo dashboard [--journal <dir>] [--queue <dir>] [--out <path>]   # generate once, default out: console/dashboard.html
bin/spo dashboard --watch                                            # regenerate every 30s (setInterval), Ctrl-C to stop
```

`console/collect.js` reads the same local surfaces as the rest of `bin/spo` (`journal/<id>/`,
`queue/`), plus the account pool directory (discovered through `orchestrator/accounts.js`, see
§ Account registry above) and the read-only `~/.spo-bench/{nightly/latest.json,
verdicts/*.json}`, and hands the result to
`console/render.js` -- a pure function that turns that data into one self-contained HTML file:
inline CSS, no external requests, a 30s `<meta http-equiv="refresh">`, light+dark via
`prefers-color-scheme`. A missing source (no `claude-accounts/`, no `~/.spo-bench/`, an empty
`journal/`) renders as an empty section, never a crash -- same "reader, never a second source of
truth" rule as the rest of the console (see README.md § Observability).

Each task card's per-LLM-step table comes straight from the journal's `llm-call` events
(`step`, `model`, `account`, `costUsd`, `sessionId`) and prints the exact `claude --resume
<sessionId>` command in a `<code>` block, same convention as `spo resume`.

**Usage snapshot (optional):** if `journal/usage-snapshot.json` exists, the dashboard renders
its `estUsd` total/`byModel` and `byPhase_Mtokens` table. Nothing writes that file
automatically -- the operator produces it by hand when they want a token-usage view alongside
the pipeline state:

```bash
node scripts/usage-report.js > journal/usage-snapshot.json
```

## Tests

```bash
node --test
```

Run bare, with no arguments, from the repo root — `node --test test/` does **not** work on
this machine (Node treats `test/` as a test-name filter rather than a directory to scan, and
matches nothing: `not ok 1 - test` / `test failed`). The bare form auto-discovers every `.js`
file directly under `test/`, no `.test.js` suffix required — which is also why
`scripts/smoke-llm.js` (the one manual real `claude` call) deliberately lives outside `test/`.

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
`runTask` directly, plus `unparkScan`'s retry/abandon/idempotency; `test/auto-pull.test.js`
covers `shouldAutoPull`'s pure timer decision and `runAutoPull`'s top-N + journal-only-when-
enqueued rules. None of them ever touch a real `git`, `npm`, `gh` or `claude` process, so the
whole suite stays hermetic.
