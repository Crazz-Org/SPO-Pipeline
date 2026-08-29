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
- One of `--shadow` or `--dry-run` is required. `--shadow` drives shadow-mode task files only
  (`task.shadow.*` fixtures, no real code path reached). `--dry-run` drives a *real*
  `kind: "card"` task file through real-mode semantics — step-contracts.js resolution,
  prompt-template.js fill, account rotation — with the one spawn point in each step (a `claude`
  CLI call, a scripted command) replaced by a fixture-free "assumed success" — see "Real mode"
  → "--dry-run" below. Real execution of the *scripted* steps (`npm run gate`, `gh pr merge`, …)
  remains a documented stub in `steps/scripted.js` regardless of mode — the *LLM* steps
  (`steps/llm.js`) are the only ones with a real (non-dry-run) implementation today, exercised
  by direct unit tests (`test/llm-real.test.js`, `test/llm-real-card.test.js`,
  `test/account-rotation.test.js`) and the one manual smoke script (`scripts/smoke-llm.js`),
  never by an actual `daemon.js` run with real spawning (`--dry-run` walks the same real-mode
  code paths but never spawns; nothing in the `node --test` suite ever calls the real `claude`
  CLI).
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
  command run.

`--dry-run` is ignored if `--shadow` is also passed (shadow wins). `test/dry-run-demo.test.js`
walks a synthetic `kind: "card"` task through the full lifecycle this way and asserts on the
final `DONE` state, the three `dryrun-{PLAN,IMPLEMENT,VALIDATE}.md` files (DIAGNOSE and
CITATION_VERIFIER are never reached on a happy path), and that `dryrun-PLAN.md` shows the real
argv flags and the filled prompt.

### Account registry

`claude-accounts/` is git-ignored (secrets) and has two files, created as needed:

- **`accounts.json`** — hand-authored, the registry: `[{name, configDir, enabled}]`.
  `configDir` is an absolute path to a `CLAUDE_CONFIG_DIR`, or `null` for the ambient default
  login. A missing file, or an empty array, both fall back to one implicit account —
  `{name: "default", configDir: null}` — so a fresh checkout with no registry still runs real
  mode against whatever `claude` is already logged into.
- **`state.json`** — machine-written, runtime cooldowns: `{accountName: {cooldownUntil:
  epochMs}}`. Not authored, not committed, disposable — deleting it just clears every cooldown.

**Adding a Claude Max account**: each additional account is one more subscription logged into
its own config directory, then one more registry line:

```bash
CLAUDE_CONFIG_DIR=/home/crazz/.claude-accounts/acct-2 claude setup-token
```

then add `{"name": "acct-2", "configDir": "/home/crazz/.claude-accounts/acct-2", "enabled":
true}` to `claude-accounts/accounts.json`. `K` parallel workers scales with `K` healthy
accounts — the gate itself stays serialized (one live world), so adding an account adds
implementation capacity, not gate throughput (state-machine-spec.md § Account pool).

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
directory). Run it by hand:

```bash
node scripts/smoke-llm.js
```

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
`test/llm-real.test.js` and `test/account-rotation.test.js` exercise **real-mode** code
(`invokeClaudeReal`, `callLlmStep`) but only ever through an injected fake `spawnSync`
(`deps.spawnSync`) — they never touch the real `claude` CLI, so the whole suite stays hermetic.
