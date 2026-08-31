'use strict';
// recette.js -- ACTION 2.9: `spo recette`, the supervised live harness. Closes chantier 2's gate
// and becomes the standard live gate every chantier from 3 on reuses (action 7.2 adds a second
// SCENARIO here, without touching the runner below).
//
// WHAT IT DOES: drives exactly one trivial, synthetic `kind: "card"` task through the REAL
// pipeline (state-machine.js's drainQueueOnce, config.real = true -- the same code path a live
// `daemon.js --real` uses) against a dedicated GitHub issue in the product repo, under a
// wall-clock + LLM-step-count cap, and asserts the produced journal actually shows the judges
// ran on real inputs -- not just that the task reached DONE. Cleanup (worktree, branches, PR,
// issue, the recette's own journal dir) runs unconditionally, on every exit path, and never
// throws.
//
// SAFETY: real mode here spawns actual git/npm/gh/claude commands against config.productRepo --
// the exact repo a live daemon may be driving real cards through right now. There is no
// product-repo mutex until chantier 6 action 6.4 (see config.js's own productRepo comment on the
// 44-worktree/61-branch incident this project already paid for once). The only guard available
// today is refusing to START while a live daemon holds ITS OWN lock file
// (<repoRoot>/journal/daemon.lock, orchestrator/lock.js) -- checked here READ-ONLY (recette is
// not a daemon and must never create, touch, or release that lock itself). `--force` overrides,
// loudly, for a maintainer who has confirmed by hand that nothing is actually running. This is a
// best-effort check, not a mutex: it catches "I forgot the daemon is running", not a daemon that
// starts a second after this check passes.
//
// SCENARIOS ARE DATA: `SCENARIOS` below is a plain object; the runner (`runRecette`) is generic
// over any entry shaped `{name, label, buildCard(ctx), assertions: [...]}`. `evaluateAssertions`
// is exported and pure (events in, verdict out) specifically so it can be unit-tested against a
// hand-built, deliberately-broken journal -- see test/recette.test.js's "detects a broken
// pipeline" case, the one the brief calls out as proving this harness is not a rubber stamp.

const fs = require('fs');
const path = require('path');

const defaultConfig = require('./config');
const { drainQueueOnce } = require('./state-machine');
const { lockPath, processAlive } = require('./lock');
const { runSync: armedRunSync, normalizeExit } = require('./board');
const intake = require('./intake');

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

// Thrown by the daemon-lock safety gate below. Never a ParkSignal (nothing has run yet -- there
// is no task, no journal, nothing to park) and never a RecetteCapExceededError (this is a refusal
// to start, not a run that tripped a limit).
class RecetteRefusedError extends Error {
  constructor(reason, detail = {}) {
    super(`spo recette: refusing to run -- ${reason}`);
    this.name = 'RecetteRefusedError';
    this.reason = reason;
    this.detail = detail;
  }
}

// Thrown by the cap-wrapped `deps.spawnSync` (see `makeCap` below) the moment either bound is
// crossed. Deliberately NOT a ParkSignal: state-machine.js's runTask only catches ParkSignal and
// lets anything else propagate ("a real bug -- surface it, do not disguise it as a park") --
// exactly what this needs. It surfaces out of drainQueueOnce, runRecette's own try/catch treats
// it as a tripped run (never a park, never a JS crash reported to the caller), and cleanup below
// always runs in the enclosing `finally`.
class RecetteCapExceededError extends Error {
  constructor(reason, detail = {}) {
    super(`spo recette: cap exceeded -- ${reason}`);
    this.name = 'RecetteCapExceededError';
    this.reason = reason;
    this.detail = detail;
  }
}

class RecetteError extends Error {
  constructor(reason, detail = {}) {
    super(`spo recette: ${reason}`);
    this.name = 'RecetteError';
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

// Label the dedicated test issue always carries -- distinct enough that no human mistakes it for
// real backlog work, and (secondarily) a visible marker if cleanup ever fails to run and a
// maintainer has to close it by hand. It is NOT how cleanup finds the issue (cleanup always
// closes the exact issue number this run just created, in-process, never a search) -- it is a
// human safety net, one label, created once by hand before the first live run:
//   gh label create spo-recette --repo Crazz-Org/SPO-WebClient --color 5319e7 \
//     --description "synthetic card created by spo recette -- never real backlog work"
// (the same one-time-setup shape this repo already uses for report-intake's `report:raw` label
// and its "Intake" board column -- see orchestrator/README.md § Report intake.) `gh issue
// create --label` does not create a missing label on the fly; an unrecognized label name makes
// the whole call fail loudly (gh-issue-create-failed below), which is the right failure mode --
// silently filing an unlabelled synthetic issue is exactly what this label exists to prevent.
const RECETTE_LABEL = 'spo-recette';

// Why doc/recette-log.md, and not a src/ file: this harness runs unattended against the REAL
// product repo, so the safest possible input to CHECK/GATE is one that touches no code path at
// all. Verified against SPO-WebClient's own scripts (2026-08-31 read, ~/SPO-WebClient):
//   - `npm run typecheck` is four `tsc --noEmit` passes over named tsconfig projects, none of
//     which globs anything outside `src/`/tests -- a doc/ file is invisible to it.
//   - `npm run lint` is `eslint .`, but eslint.config.js's every rule block is scoped to
//     `src/**/*.{ts,tsx}` / `scripts/**/*.js` / etc -- flat config's default extension set is
//     JS/TS family only, so a .md file matches no block and is never linted.
//   - `npm run coverage:changed` (scripts/coverage-changed.js) restricts itself to
//     `src/**/*.ts(x)` (`isEligible`); a docs-only diff has zero eligible files, so its own
//     `main()` takes the `files.length === 0` branch: "no eligible source file changed --
//     running the suite, nothing to measure", runs the full Jest suite ONCE, and returns 0 as
//     long as that suite is green. A docs change is therefore held to the same bar as any other
//     change (the whole suite must pass) without asking GATE's bench to judge a coverage ratio
//     that a one-line markdown diff cannot produce.
//   - GATE (`npm run gate` -> scripts/bench-gate.sh -> the bench) receives the same diff CHECK
//     already passed -- the smallest, least surprising input the bench can be asked to gate.
// One risk this build could NOT verify from a read-only pass: SPO-WebClient's board automation
// (the workflow that adds a freshly created issue to the project board's Todo column, referenced
// by intake.js's fileCard header) may or may not fire for an issue outside the normal intake
// flow. If it does not, `npm run board:take -- <issue>` (realWorktree's own claim, action 1's
// WORKTREE step) can fail claim-lost/claim-unrecognized-exit on the very first real run -- a
// park, not a crash, and the harness's own cleanup still runs. Flagged here rather than assumed
// away: verify by hand before the first live run (`gh issue view <n> --repo ... --json
// projectItems` after creating one test issue), see orchestrator/README.md § Recette.
const RECETTE_DOC_FILE = 'doc/recette-log.md';

function trivialDocLogCard({ runId }) {
  const title = `[spo-recette] synthetic card ${runId}`;
  const body = [
    'This issue was created automatically by `spo recette` (orchestrator/recette.js) -- the',
    'supervised live harness that is the standard live gate for this project from chantier 3 on.',
    '',
    'It is not real backlog work. It exists only to drive one trivial, synthetic card through the',
    `real pipeline end to end. Labelled \`${RECETTE_LABEL}\`, and closed by the harness's own`,
    'cleanup once the run finishes (success, park, or a tripped cap). If you are reading this on',
    'a still-open issue, cleanup did not run to completion -- it is safe to close by hand, and',
    'worth checking `.recette/` in the SPO-Pipeline checkout for what the run left behind.',
    '',
    '## Done means',
    '',
    `Append exactly one new line to \`${RECETTE_DOC_FILE}\` recording this run (create the file,`,
    'with a one-line header, if it does not exist yet). The new line should read exactly:',
    '',
    `- ${runId} -- synthetic recette card, no product behaviour changed`,
    '',
    `Touch no other file. In particular, touch nothing under \`src/\`.`,
    '',
    `Source: \`spo recette\`, run ${runId}.`,
  ].join('\n');

  // The criterion is returned EXPLICITLY, not re-derived from the body above. The first live run
  // (2026-08-31, issue #467) failed because enqueueTask called intake.extractCriterion(body),
  // which stops at the first blank line after the "## Done means" heading -- so the card reached
  // IMPLEMENT truncated at "The new line should read exactly:", with neither the required text
  // nor the "touch nothing under src/" instruction. IMPLEMENT invented a line, VALIDATE rejected
  // it, and the run burned a REJECT, an empty IMPLEMENT and a DIAGNOSE before converging.
  // (DIAGNOSE diagnosed it exactly, by reading recette.js itself.)
  //
  // extractCriterion is right for a HUMAN-written card, where the body is the only source of
  // truth. Here the harness authored the card, so re-parsing its own rendered markdown to
  // recover its own intent is a round trip that can only lose information.
  const criterion = [
    `Append exactly one new line to ${RECETTE_DOC_FILE} (create the file with a one-line header`,
    'if it does not exist yet). The new line must read exactly, byte for byte:',
    `- ${runId} -- synthetic recette card, no product behaviour changed`,
    'Touch no other file. In particular, touch nothing under src/.',
  ].join(' ');

  return { title, body, criterion };
}

// Each assertion is `{id, description, check(info) -> {ok, detail}}`, never throwing (a thrown
// assertion would abort evaluation of every assertion after it, hiding exactly the information a
// broken-pipeline report needs). `info` is `{events, finalState, capTripped}` -- see
// `evaluateAssertions` below for how `events` is read.
const TRIVIAL_DOC_LOG_ASSERTIONS = [
  {
    id: 'no-park',
    description: 'the task never parked',
    check: ({ events, finalState }) => {
      const parked = events.find((e) => e.event === 'parked');
      return {
        ok: finalState !== 'PARKED' && !parked,
        detail: parked ? `parked in ${parked.state}: ${parked.reason}` : `finalState=${finalState}`,
      };
    },
  },
  {
    id: 'reached-done',
    description: 'the task reached the DONE terminal state',
    check: ({ finalState }) => ({ ok: finalState === 'DONE', detail: `finalState=${finalState}` }),
  },
  {
    id: 'plan-wrote-files',
    description: 'PLAN actually wrote plan/invariants files (not the "no fixture, trivially ok" shortcut)',
    check: ({ events }) => {
      const e = events.find((ev) => ev.state === 'PLAN' && ev.event === 'files-written');
      return { ok: !!e, detail: e ? `${e.planPath}` : 'no PLAN files-written event' };
    },
  },
  {
    id: 'implement-changed-files',
    description: 'IMPLEMENT reported a non-empty files_changed -- proves it did not report empty/unparsable work',
    check: ({ events }) => {
      const results = events.filter((ev) => ev.state === 'IMPLEMENT' && ev.event === 'result');
      const last = results[results.length - 1];
      const payload = last && last.payload;
      const raw = payload && ('files_changed' in payload ? payload.files_changed : payload.filesChanged);
      const parsed = Array.isArray(raw) ? raw : typeof raw === 'string' ? safeJsonArray(raw) : null;
      return {
        ok: !!parsed && parsed.length > 0,
        detail: last ? `files_changed=${JSON.stringify(raw)}` : 'no IMPLEMENT result event',
      };
    },
  },
  {
    id: 'implement-touched-only-the-recette-doc',
    description: `IMPLEMENT changed ${RECETTE_DOC_FILE} and NOTHING else -- nothing under src/`,
    // The assertion that makes this harness safe to point at the real repo. Everything else here
    // asks "did the pipeline work"; this one asks "did it do what we asked". Without it a run
    // that rewrote forty src/ files would satisfy every other assertion and be MERGED INTO
    // PRODUCT MAIN, because this scenario ends in a real merge. The card body already says
    // "Touch no other file. In particular, touch nothing under src/" -- an instruction nothing
    // was checking. Read from IMPLEMENT's own reported list, and cross-checked against the diff
    // the judges were handed, so a model that under-reports what it touched is caught too.
    check: ({ events }) => {
      const results = events.filter((ev) => ev.state === 'IMPLEMENT' && ev.event === 'result');
      const last = results[results.length - 1];
      const payload = last && last.payload;
      const raw = payload && ('files_changed' in payload ? payload.files_changed : payload.filesChanged);
      const parsed = Array.isArray(raw) ? raw : typeof raw === 'string' ? safeJsonArray(raw) : null;
      if (!parsed) return { ok: false, detail: 'no parsable files_changed' };

      const normalise = (f) => String(f).replace(/^\.\//, '').trim();
      const unexpected = parsed.map(normalise).filter((f) => f !== RECETTE_DOC_FILE);
      return {
        ok: unexpected.length === 0,
        detail:
          unexpected.length === 0
            ? `only ${RECETTE_DOC_FILE}`
            : `UNEXPECTED files changed (this run would merge them into product main): ${unexpected.join(', ')}`,
      };
    },
  },
  {
    id: 'validate-got-real-diff',
    description:
      "VALIDATE's judge inputs actually included diff.patch -- proves the change-validator judged a real diff, not an absent/empty one",
    check: ({ events }) => {
      const e = events.find((ev) => ev.state === 'VALIDATE' && ev.event === 'judge-inputs-prepared');
      const produced = (e && e.produced) || [];
      return {
        ok: produced.includes('diff.patch'),
        detail: e ? `produced=${JSON.stringify(produced)} missing=${JSON.stringify(e.missing)}` : 'no judge-inputs-prepared event for VALIDATE',
      };
    },
  },
  {
    id: 'validate-verdict-pass',
    description: 'the change-validator actually rendered PASS/PASS_WITH_FINDINGS (not a REJECT that happened to retry into a later PASS unnoticed)',
    check: ({ events }) => {
      const results = events.filter((ev) => ev.state === 'VALIDATE' && ev.event === 'change-validator');
      const last = results[results.length - 1];
      const verdict = last && last.verdict;
      return { ok: verdict === 'PASS' || verdict === 'PASS_WITH_FINDINGS', detail: `verdict=${verdict}` };
    },
  },
  {
    id: 'merged',
    description: 'MERGE actually enqueued the PR (pr-merge-enqueue exit 0)',
    check: ({ events }) => {
      const e = events.find((ev) => ev.state === 'MERGE' && ev.event === 'pr-merge-enqueue');
      return { ok: !!e && e.exit === 0, detail: e ? `exit=${e.exit}` : 'no pr-merge-enqueue event' };
    },
  },
  {
    id: 'finished',
    description: 'FINISH ran and recorded the PR number',
    check: ({ events }) => {
      const e = events.find((ev) => ev.state === 'FINISH' && ev.event === 'finished');
      return { ok: !!e && !!e.prNumber, detail: e ? `prNumber=${e.prNumber}` : 'no FINISH finished event' };
    },
  },
];

function safeJsonArray(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const SCENARIOS = {
  'trivial-doc-log': {
    name: 'trivial-doc-log',
    label: RECETTE_LABEL,
    description:
      `One line appended to ${RECETTE_DOC_FILE} -- a docs-only change (see the comment above ` +
      'RECETTE_DOC_FILE for why this is the safest input CHECK/GATE can be handed).',
    buildCard: trivialDocLogCard,
    assertions: TRIVIAL_DOC_LOG_ASSERTIONS,
  },
};

function resolveScenario(name) {
  const key = name || 'trivial-doc-log';
  const scenario = SCENARIOS[key];
  if (!scenario) {
    throw new RecetteError('unknown-scenario', { name: key, known: Object.keys(SCENARIOS) });
  }
  return scenario;
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

const DEFAULT_CAP_MS = 45 * 60 * 1000; // 45 minutes wall clock for one trivial card, real mode
const DEFAULT_CAP_LLM_STEPS = 12; // PLAN + IMPLEMENT(*1-4) + VALIDATE(*1-4) + slack -- see makeCap's header

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// resolveConfig(opts) -- the ONE place `--dry`'s printed plan and the real run's actual config
// both come from, so the two can never structurally diverge (requirement: "--dry prints the plan
// of what it would do"). `opts.recetteDir` (default `<repoRoot>/.recette`) is the parent of every
// run's own `<runId>/{journal,queue}` -- gitignored, never the live `journal/`/`queue/` the
// daemon holds a lock on. `opts.productJournalRoot` is a test-only override for the safety
// check's own target (default: `<repoRoot>/journal`, i.e. the REAL daemon's journal root,
// regardless of where THIS run's own isolated journal lives).
function resolveConfig(opts = {}) {
  const repoRoot = defaultConfig.REPO_ROOT;
  const runId = opts.runId || `${Date.now()}-${process.pid}`;
  const recetteDir = opts.recetteDir || path.join(repoRoot, '.recette');
  const runDir = path.join(recetteDir, runId);

  return {
    ...defaultConfig,
    real: true,
    shadowMode: false,
    dryRun: false,
    claudeAccountsDir: opts.accountsDir || defaultConfig.claudeAccountsDir,
    runId,
    recetteDir,
    runDir,
    journalRoot: path.join(runDir, 'journal'),
    queueDir: path.join(runDir, 'queue'),
    productJournalRoot: opts.productJournalRoot || path.join(repoRoot, 'journal'),
    capMs: opts.capMs || envInt('SPO_RECETTE_CAP_MS', DEFAULT_CAP_MS),
    capLlmSteps: opts.capLlmSteps || envInt('SPO_RECETTE_CAP_LLM_STEPS', DEFAULT_CAP_LLM_STEPS),
    // Test-only escape hatch: an arbitrary config-field override (e.g. spoBenchDir, productRepo,
    // pipelineWorktreesDir, ciChecksMaxPolls), applied last so a test never has to touch this
    // repo's real ~/.spo-bench or ~/SPO-WebClient just to isolate a full real-mode run. `bin/spo`
    // never sets this -- there is no CLI flag for it, deliberately: every one of these fields
    // already has its own env-var override for a maintainer's real use (config.js), this is only
    // for a test process that wants to set several at once without setting five env vars.
    ...(opts.configOverrides || {}),
  };
}

function taskIdFor(issueNumber) {
  return `recette-${issueNumber}`;
}

function branchFor(taskId) {
  // Matches realWorktree's own convention exactly (steps/scripted.js: `ctx.task.branch =
  // \`claude-pipe/${ctx.id}\``) -- computed here, not read back off state.json (which never
  // stores `branch`), so cleanup can target it even when WORKTREE never ran far enough to
  // journal anything (createIssue failed, the cap tripped pre-WORKTREE, ...).
  return `claude-pipe/${taskId}`;
}

function worktreePathFor(config, taskId) {
  return path.join(config.pipelineWorktreesDir, taskId);
}

// ---------------------------------------------------------------------------------------------
// Safety: refuse while a live daemon holds ITS OWN lock (read-only check -- see module header)
// ---------------------------------------------------------------------------------------------

function readLockHolder(journalRoot) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(journalRoot), 'utf8'));
  } catch {
    return null; // absent, unreadable, or torn -- treated as "no live holder" (same as lock.js)
  }
}

// Returns the live holder {host, pid, startedAt, mode}, or null when the lock is absent, torn,
// or its pid is no longer alive on this host. Never creates, touches, or removes the lock file
// itself -- unlike orchestrator/lock.js's acquireLock, which this function deliberately does not
// call, precisely because acquireLock's side effect (creating the lock on a clean read) is wrong
// for a mere check by a non-daemon caller.
function liveDaemonHolder(productJournalRoot, deps = {}) {
  const holder = readLockHolder(productJournalRoot);
  if (!holder || typeof holder.pid !== 'number') return null;
  const isAlive = deps.isAlive || processAlive;
  return isAlive(holder.pid) ? holder : null;
}

// ---------------------------------------------------------------------------------------------
// Cap: wall-clock ceiling + hard LLM-step-count ceiling, enforced at the one choke point every
// real spawn (scripted AND `claude -p`, per steps/llm.js's invokeClaudeReal) already passes
// through: `deps.spawnSync`. No state-machine.js change needed -- this wraps the SAME injection
// point production code already threads through config.deps.
//
// Wall clock is checked before every spawn, not preemptively mid-spawn (spawnSync is
// synchronous and blocking -- nothing here can interrupt an in-flight child). Combined with the
// existing per-command-class timeouts (config.commandTimeoutsMs), the true worst-case overrun
// above `capMs` is bounded by the single longest command timeout in flight when the cap is
// crossed (today, `npm-gate`'s 7800s) -- reported honestly here rather than claimed away: this
// is "abort at the next opportunity", not "abort within capMs of the wall clock". It still always
// terminates and always cleans up; it does not hang.
//
// LLM steps are counted by (command === 'claude') -- every real LLM call in this codebase
// (invokeClaudeReal) spawns literally 'claude', so this is an exact count, not a heuristic --
// and the cap is enforced BEFORE the (N+1)th call spawns, so an over-cap call never runs at all.
function makeCap(config, { now = Date.now } = {}) {
  const startedAt = now();
  let llmSteps = 0;
  let tripped = null;

  function wrapSpawnSync(spawnSyncFn) {
    const real = spawnSyncFn || require('child_process').spawnSync;
    return (command, args, opts) => {
      const elapsedMs = now() - startedAt;
      if (elapsedMs > config.capMs) {
        tripped = { reason: 'wall-clock-cap-exceeded', elapsedMs, capMs: config.capMs };
        throw new RecetteCapExceededError(tripped.reason, tripped);
      }
      if (command === 'claude') {
        // Checked BEFORE incrementing, so the over-cap call is never counted as having run --
        // `llmSteps` after a trip reports exactly how many LLM calls actually executed, and the
        // (capLlmSteps + 1)th never spawns at all.
        if (llmSteps + 1 > config.capLlmSteps) {
          tripped = { reason: 'llm-step-cap-exceeded', llmSteps, capLlmSteps: config.capLlmSteps };
          throw new RecetteCapExceededError(tripped.reason, tripped);
        }
        llmSteps += 1;
      }
      return real(command, args, opts);
    };
  }

  return {
    wrapSpawnSync,
    tripped: () => tripped,
    elapsedMs: () => now() - startedAt,
    llmSteps: () => llmSteps,
  };
}

// ---------------------------------------------------------------------------------------------
// GitHub issue: create (real mode) / close (cleanup)
// ---------------------------------------------------------------------------------------------

function createIssue(scenario, config, deps) {
  const { title, body, criterion } = scenario.buildCard({ runId: config.runId });
  fs.mkdirSync(config.runDir, { recursive: true });
  const bodyFile = path.join(config.runDir, 'issue-body.md');
  fs.writeFileSync(bodyFile, body);

  const result = armedRunSync(
    deps,
    'gh',
    ['issue', 'create', '--repo', config.ghRepo, '--title', title, '--body-file', bodyFile, '--label', scenario.label],
    {},
    config
  );
  const exit = normalizeExit(result);
  if (exit !== 0) {
    throw new RecetteError('gh-issue-create-failed', { exit, stderr: result && result.stderr, timedOut: result && result.timedOut });
  }
  const issueNumber = intake.parseIssueNumber(result.stdout);
  if (!issueNumber) {
    throw new RecetteError('gh-issue-create-no-number', { stdout: result.stdout });
  }
  const url = intake.parseIssueUrl(result.stdout) || `https://github.com/${config.ghRepo}/issues/${issueNumber}`;
  return { issueNumber, url, title, body, criterion };
}

function enqueueTask(config, issue) {
  const task = {
    id: taskIdFor(issue.issueNumber),
    kind: 'card',
    issue: issue.issueNumber,
    title: issue.title,
    // scenario.buildCard's own criterion when it supplies one -- see trivialDocLogCard for why
    // re-parsing the rendered body loses information. extractCriterion stays the fallback for a
    // scenario that only renders a body.
    criterion: issue.criterion || intake.extractCriterion(issue.body),
    size: 'S',
    area: '',
    touchesRdoMembers: false,
  };
  fs.mkdirSync(config.queueDir, { recursive: true });
  fs.writeFileSync(path.join(config.queueDir, '0001-recette.json'), JSON.stringify(task, null, 2) + '\n');
  return task;
}

function readStateSafe(journalRoot, taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(journalRoot, taskId, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readJournalEvents(journalRoot, taskId) {
  try {
    return fs
      .readFileSync(path.join(journalRoot, taskId, 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Assertions -- pure, exported standalone so a test can drive a hand-built/broken events array
// without running anything (see this file's own header + test/recette.test.js).
// ---------------------------------------------------------------------------------------------

function evaluateAssertions(scenario, info) {
  const results = scenario.assertions.map((a) => {
    let outcome;
    try {
      outcome = a.check(info);
    } catch (err) {
      outcome = { ok: false, detail: `assertion threw: ${err.message}` };
    }
    return { id: a.id, description: a.description, ok: !!(outcome && outcome.ok), detail: outcome && outcome.detail };
  });
  return { ok: results.every((r) => r.ok), results };
}

// ---------------------------------------------------------------------------------------------
// Cleanup -- runs on EVERY exit path (success, park, thrown error, tripped cap), never throws,
// idempotent (every step tolerates "already gone"). `deps` here must be the RAW, un-cap-wrapped
// deps: a wall-clock-tripped cap's wrapper would otherwise reject every cleanup spawn too, since
// elapsed time only ever increases -- see runRecette below, which is careful to pass the
// original `deps`, never `wrappedDeps`, into this function.
// ---------------------------------------------------------------------------------------------

function tryStep(steps, name, fn) {
  try {
    steps.push({ name, ok: true, detail: fn() });
  } catch (err) {
    steps.push({ name, ok: false, detail: err && err.message });
  }
}

// wipRefsFrom(events) -> the `wip/<taskId>-<ts>` branch names THIS run pushed to origin.
//
// A park is not an exotic path here -- it is the most likely first-live-run outcome -- and
// steps/scripted.js's preserveWorktreeWip pushes the dirty worktree to a durable `wip/` ref on
// origin before finalizePark writes state.json (state-machine.js's finalizePark; also
// sweepWorktreeLeftovers' own 'leftover' call, which journals the same payload under
// 'leftover-wip-preserved'). That ref is a REMOTE BRANCH IN THE PRODUCT REPO, in a namespace
// cleanup's `claude-pipe/<taskId>` delete does not touch -- so before this function existed,
// every recette run that parked dirty left one behind permanently. Exactly the artifact class
// this harness exists to never create (config.js's 44-worktree/61-branch note).
//
// Read off the journal rather than recomputed: the ref name carries a `Date.now()` suffix chosen
// inside preserveWorktreeWip, so the journal is the only place it is knowable. The event is
// appended immediately after the push returns 0, so a ref that exists on origin always has its
// event, and an event never names a ref that was not pushed.
function wipRefsFrom(events) {
  const refs = [];
  for (const e of events || []) {
    if (!e || typeof e.event !== 'string' || !e.event.endsWith('wip-preserved')) continue;
    if (typeof e.ref === 'string' && e.ref && !refs.includes(e.ref)) refs.push(e.ref);
  }
  return refs;
}

function cleanup({ scenario, config, deps, issueNumber, prNumber, wipRefs, keepRunDir = false }) {
  const steps = [];
  const taskId = issueNumber ? taskIdFor(issueNumber) : null;

  if (taskId) {
    const worktreePath = worktreePathFor(config, taskId);
    const branch = branchFor(taskId);

    // `git worktree remove` on a path that was never created (createIssue/enqueue failed before
    // WORKTREE ran, or the cap tripped before it) exits non-zero cleanly -- recorded as ok:false
    // below, never thrown. Same for every other step: idempotency here means "never throws",
    // not "always reports success".
    tryStep(steps, 'worktree-remove', () => {
      const r = armedRunSync(deps, 'git', ['-C', config.productRepo, 'worktree', 'remove', '--force', worktreePath], {}, config);
      return { exit: normalizeExit(r) };
    });
    tryStep(steps, 'worktree-prune', () => {
      const r = armedRunSync(deps, 'git', ['-C', config.productRepo, 'worktree', 'prune'], {}, config);
      return { exit: normalizeExit(r) };
    });
    tryStep(steps, 'branch-delete-local', () => {
      const r = armedRunSync(deps, 'git', ['-C', config.productRepo, 'branch', '-D', branch], {}, config);
      return { exit: normalizeExit(r) };
    });
    tryStep(steps, 'branch-delete-remote', () => {
      const r = armedRunSync(deps, 'git', ['-C', config.productRepo, 'push', 'origin', '--delete', branch], {}, config);
      return { exit: normalizeExit(r) };
    });
  }

  // The `wip/` refs this run pushed to origin (park path only -- see wipRefsFrom above). One
  // step per ref, named with the ref, so the printed cleanup line says exactly which remote
  // branch still needs a hand if a delete fails.
  for (const ref of wipRefs || []) {
    tryStep(steps, `wip-ref-delete:${ref}`, () => {
      const r = armedRunSync(deps, 'git', ['-C', config.productRepo, 'push', 'origin', '--delete', ref], {}, config);
      return { exit: normalizeExit(r) };
    });
  }

  if (prNumber) {
    tryStep(steps, 'pr-close', () => {
      const r = armedRunSync(deps, 'gh', ['pr', 'close', String(prNumber), '--repo', config.ghRepo], {}, config);
      return { exit: normalizeExit(r) };
    });
  }

  if (issueNumber) {
    tryStep(steps, 'issue-close', () => {
      const r = armedRunSync(
        deps,
        'gh',
        ['issue', 'close', String(issueNumber), '--repo', config.ghRepo, '--comment', 'Closed automatically by `spo recette` cleanup.'],
        {},
        config
      );
      return { exit: normalizeExit(r) };
    });
  }

  // Keep the run's own evidence when the run FAILED. Everything else here is a real-world
  // artifact that must not linger (issues, branches, worktrees, PRs); the run directory is the
  // opposite -- it is journal.jsonl, state.json, report.md, gate.log, logs/ and diff.patch, i.e.
  // the only material anyone has to diagnose WHY the gate failed. Deleting it exactly when the
  // gate goes red leaves the printed assertion details as the sole record, and `--keep` is a
  // decision the maintainer has to make BEFORE the run, when they do not yet know they will need
  // it. GitHub-side cleanup still happens either way.
  if (keepRunDir) {
    steps.push({
      name: 'journal-dir-kept',
      ok: true,
      detail: { kept: config.runDir, why: 'the run failed -- evidence preserved for diagnosis' },
    });
  } else {
    tryStep(steps, 'journal-dir-remove', () => {
      fs.rmSync(config.runDir, { recursive: true, force: true });
      return { removed: config.runDir };
    });
  }

  const anyFailed = steps.some((s) => !s.ok || (s.detail && typeof s.detail.exit === 'number' && s.detail.exit !== 0));
  return { steps, anyFailed };
}

// ---------------------------------------------------------------------------------------------
// Plan (shared by --dry and the real run -- see resolveConfig's own header)
// ---------------------------------------------------------------------------------------------

function buildPlan(scenario, config) {
  return {
    scenario: scenario.name,
    description: scenario.description,
    label: scenario.label,
    ghRepo: config.ghRepo,
    productRepo: config.productRepo,
    runDir: config.runDir,
    journalRoot: config.journalRoot,
    queueDir: config.queueDir,
    productJournalRoot: config.productJournalRoot,
    capMs: config.capMs,
    capLlmSteps: config.capLlmSteps,
    accountsDir: config.claudeAccountsDir,
    steps: [
      `refuse if a live daemon holds ${lockPath(config.productJournalRoot)} (unless --force)`,
      `create a dedicated GitHub issue in ${config.ghRepo}, labelled "${scenario.label}"`,
      `enqueue one kind:"card" task into ${config.queueDir}`,
      `drain it for real (config.real=true) into ${config.journalRoot}, capped at ${config.capMs}ms wall clock / ${config.capLlmSteps} LLM steps`,
      'evaluate the scenario\'s declared assertions against the produced journal',
      'clean up: worktree remove+prune, local+remote branch delete, PR close, issue close, remove the run dir (unless --keep)',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

// runRecette(opts, deps) -> {ok, dry?, refused?, plan, scenario, runId, issueNumber, prNumber,
//   finalState, capTripped, assertions, cleanupReport, error}
//
// `opts`: {scenario, keep, dry, force, recetteDir, productJournalRoot, accountsDir, capMs,
//          capLlmSteps, runId}  -- all optional, all also settable via resolveConfig's env vars
//          where noted.
// `deps`: {spawnSync, isAlive} -- production passes neither (real spawnSync, real
//          process.kill-based liveness); tests inject both. `deps` is passed to cleanup
//          UNWRAPPED -- see cleanup's own header.
async function runRecette(opts = {}, deps = {}) {
  const scenario = resolveScenario(opts.scenario);
  const config = resolveConfig(opts);
  const plan = buildPlan(scenario, config);

  if (opts.dry) {
    return { ok: true, dry: true, plan, scenario: scenario.name };
  }

  if (!opts.force) {
    const holder = liveDaemonHolder(config.productJournalRoot, deps);
    if (holder) {
      return {
        ok: false,
        refused: true,
        plan,
        scenario: scenario.name,
        reason: 'daemon-lock-held',
        detail: { holder, lockPath: lockPath(config.productJournalRoot) },
      };
    }
  }

  const cap = makeCap(config);
  const wrappedDeps = { ...deps, spawnSync: cap.wrapSpawnSync(deps.spawnSync) };

  let issue = null;
  let finalState = null;
  let runError = null;

  try {
    issue = createIssue(scenario, config, wrappedDeps);
    const task = enqueueTask(config, issue);
    fs.mkdirSync(config.journalRoot, { recursive: true });

    const results = await drainQueueOnce(config.queueDir, config.journalRoot, { ...config, deps: wrappedDeps });
    const result = results.find((r) => r.id === task.id);
    finalState = result ? result.finalState : null;
  } catch (err) {
    runError = err;
  }

  const taskId = issue ? taskIdFor(issue.issueNumber) : null;
  const state = taskId ? readStateSafe(config.journalRoot, taskId) : null;
  const events = taskId ? readJournalEvents(config.journalRoot, taskId) : [];
  const prNumber = state && state.prNumber;

  let assertions = null;
  if (!runError && finalState) {
    assertions = evaluateAssertions(scenario, { events, finalState, capTripped: cap.tripped() });
  }

  const capTripped = cap.tripped();
  const ok = !runError && !capTripped && !!assertions && assertions.ok;

  let cleanupReport = null;
  if (!opts.keep) {
    cleanupReport = cleanup({
      scenario,
      config,
      deps,
      issueNumber: issue && issue.issueNumber,
      prNumber,
      wipRefs: wipRefsFrom(events),
      keepRunDir: !ok, // a failed gate's own journal is the only diagnosis material there is
    });
  }

  return {
    ok,
    plan,
    scenario: scenario.name,
    runId: config.runId,
    issueNumber: issue && issue.issueNumber,
    issueUrl: issue && issue.url,
    taskId,
    finalState,
    prNumber: prNumber || null,
    capTripped,
    elapsedMs: cap.elapsedMs(),
    llmSteps: cap.llmSteps(),
    assertions,
    cleanupReport,
    kept: !!opts.keep,
    error: runError instanceof RecetteCapExceededError ? null : runError ? { message: runError.message, name: runError.name } : null,
  };
}

module.exports = {
  SCENARIOS,
  resolveScenario,
  resolveConfig,
  buildPlan,
  liveDaemonHolder,
  makeCap,
  evaluateAssertions,
  cleanup,
  wipRefsFrom,
  createIssue,
  enqueueTask,
  taskIdFor,
  branchFor,
  worktreePathFor,
  readStateSafe,
  readJournalEvents,
  runRecette,
  RecetteRefusedError,
  RecetteCapExceededError,
  RecetteError,
  RECETTE_LABEL,
  RECETTE_DOC_FILE,
};
