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
// the exact repo a live daemon may be driving real cards through right now. Chantier 6 action 6.4
// added a product-repo mutex (`orchestrator/product-repo-lock.js`, held by `steps/scripted.js`
// around WORKTREE's setup and FINISH's teardown -- see the 44-worktree/61-branch incident config.js's
// own productRepo comment records), but recette does not take it: this runner drives the task
// through `drainQueueOnce` like a real daemon worker would, so the same lock already applies to
// its WORKTREE/FINISH phases. The guard here is a coarser, earlier one: refusing to START while a
// live daemon holds ITS OWN lock file (<repoRoot>/journal/daemon.lock, orchestrator/lock.js) --
// checked here READ-ONLY (recette is not a daemon and must never create, touch, or release that
// lock itself). `--force` overrides, loudly, for a maintainer who has confirmed by hand that
// nothing is actually running. This is a best-effort check, not a mutex: it catches "I forgot the
// daemon is running", not a daemon that starts a second after this check passes.
//
// SCENARIOS ARE DATA: `SCENARIOS` below is a plain object; the runner (`runRecette`) is generic
// over any entry shaped `{name, label, buildCard(ctx), assertions: [...]}`. `evaluateAssertions`
// is exported and pure (events in, verdict out) specifically so it can be unit-tested against a
// hand-built, deliberately-broken journal -- see test/recette.test.js's "detects a broken
// pipeline" case, the one the brief calls out as proving this harness is not a rubber stamp.
//
// ACTION 7.2 -- `driver` (default 'inline') is now also part of that data shape:
//   'inline'     -- unchanged: drainQueueOnce runs the scenario's ONE task in THIS process, and
//                    makeCap's wrapped deps.spawnSync is the cap (see makeCap's own header). This
//                    is what trivial-doc-log still uses, byte-for-byte, and it stays the only
//                    driver a K=1, no-parallelism scenario needs.
//   'dispatcher' -- runs `scenario.k` (default 1) of the scenario's tasks through the REAL
//                    orchestrator/dispatcher.js's createDispatcher: K real spawned worker
//                    children plus a real spawned scanner, exactly what a live daemon runs. This
//                    exists because production stopped using drainQueueOnce for anything but a
//                    K=1, no-account-pool-contention edge case the moment action 6.3 shipped --
//                    an inline-only harness could prove a K=1 pipeline works and nothing about
//                    what K>1 actually does. See runDispatcherScenario below for the two things
//                    this driver has to do that inline never had to: enforce a cap on children it
//                    cannot instrument (runDispatcherCapWatchdog) and force every scan timer off
//                    IN THE SCANNER'S OWN PROCESS -- NOT in the JS config object handed to
//                    createDispatcher, which the scanner (a separate OS process) never reads at
//                    all; see the "Scanner timer forwarding" section just below for the actual
//                    mechanism (post-verification correction) and runDispatcherScenario's own
//                    comment for where it is applied. A live scanner with even one of these still
//                    on would auto-pull real backlog cards into this run's own throwaway queue.
// A scenario's OWN per-task assertions (`assertions`) keep exactly the shape and contract
// evaluateAssertions already has -- untouched by any of this. A dispatcher-driver scenario with
// k>1 additionally declares `crossTaskAssertions` (same {id, description, check} shape, a
// DIFFERENT info object -- see evaluateCrossTaskAssertions below), for claims no single task's
// own journal can prove on its own (two tasks really overlapped in wall time; nothing wrote
// across task boundaries; the scan timers this run handed to createDispatcher were really zero).

const fs = require('fs');
const path = require('path');

const defaultConfig = require('./config');
const { drainQueueOnce } = require('./state-machine');
const { lockPath, processAlive } = require('./lock');
const { runSync: armedRunSync, normalizeExit } = require('./board');
const intake = require('./intake');
// ACTION 7.2: the second driver. `driver: 'dispatcher'` runs the scenario's task(s) through the
// SAME createDispatcher production uses (K real spawned worker children, a real spawned scanner)
// instead of drainQueueOnce's in-process drain -- see this file's own header addition below (just
// above SCENARIOS) for why the inline path alone stopped being an honest stand-in for production.
const { createDispatcher } = require('./dispatcher');
// The ONLY clock this file uses for the dispatcher driver's own out-of-process cap -- see
// monotonic-clock.js's header for why: this box's Date.now() has been measured jumping backward,
// and every bounded-wait-loop bug that shape produces only ever makes a wait run LONGER, never
// shorter, which is exactly the wrong direction for a safety cap. Never written to disk, never
// compared across processes (both watchdog reads happen in THIS process only) -- see
// runDispatcherCapWatchdog below.
const { monotonicNowMs } = require('./monotonic-clock');

// ---------------------------------------------------------------------------------------------
// Scanner timer forwarding (action 7.2, post-verification correction) -- see
// runDispatcherScenario's own comment on WHERE this is applied for the full mechanism; this is
// WHAT gets forwarded and how a check can verify it against real, unmodified config.js.
//
// A dispatcher always spawns a scanner (dispatcher.js's run(), unconditionally). The scanner is a
// SEPARATE OS process (`node daemon.js --scanner ...`) that resolves its OWN config from SCRATCH
// via `require('./config')` -- it never sees any JS object this process builds. The only channel
// that reaches it is its INHERITED process.env at the moment child_process.spawn is called
// (dispatcher.js's spawnScanner passes no `env` override, so Node clones process.env as it
// stands right then). These are the seven fields runForever's own scan cycle
// (state-machine.js's runScanCycle) and remote-report-pull loop (startRemoteReportPullLoop) read,
// each with its own env var per config.js:
//
// SIX OF THEM ARE GENUINELY DISABLED BY "0" -- config.js's own should*/shouldScan* predicates
// (shouldScanOrphans/shouldScanUnpark/shouldAutoPull/shouldAutoIntake/shouldScanConfirms/
// shouldAutoTriage) all read `!(x > 0)` as "never due". SPO_REMOTE_REPORT_PULL_MS IS NOT: read
// remote-report-pull.js's own startRemoteReportPullLoop -- its `tick()` runs UNCONDITIONALLY the
// instant the scanner starts, never gated by remoteReportPullMs at all; that field only sets the
// RESCHEDULE delay after the first, always-happens pull. Forwarded here anyway (minimising that
// reschedule delay is still worth doing, and the scan-timers-disabled check below still proves
// the VALUE is 0), but it is NOT what keeps a dispatcher-driver scenario safe from a real
// pull+ack -- runRecette's own SPO_REMOTE_REPORT_URL refusal is (see that call site's comment).
// ---------------------------------------------------------------------------------------------
const SCANNER_TIMER_ENV_VARS = [
  'SPO_ORPHAN_SCAN_MS',
  'SPO_UNPARK_SCAN_MS',
  'SPO_AUTO_PULL_MS',
  'SPO_AUTO_INTAKE_MS',
  'SPO_REPORT_CONFIRM_SCAN_MS',
  'SPO_AUTO_TRIAGE_MS',
  'SPO_REMOTE_REPORT_PULL_MS',
];

// {SPO_ORPHAN_SCAN_MS: '0', ...} -- the seven timer vars, each mapped to the literal string "0"
// they are always forwarded as. Built once, here, so runDispatcherScenario's own combined
// save/restore loop (timers + SPO_ACCOUNTS_DIR, see that function's own A2 comment) can spread it
// alongside the one non-timer override without repeating the "0" literal seven times.
const SCANNER_TIMER_ENV_VARS_ZEROED = Object.fromEntries(SCANNER_TIMER_ENV_VARS.map((k) => [k, '0']));

// resolveScannerTimersUnderEnv(envOverrides) -> {orphanScanMs, unparkScanMs, autoPullMs,
//   autoIntakeMs, reportConfirmScanMs, autoTriageMs, remoteReportPullMs} -- faithfully reproduces
// what a FRESH `require('./config')` (exactly what daemon.js's own --scanner branch does, in its
// own process) resolves the seven fields to, under the given env var overrides. Runs config.js's
// own, unmodified parsing (env var name, Number() coercion, fallback-on-undefined) -- cache-busted
// and re-required here, synchronously, so this is never a hand-rolled duplicate of that logic that
// could silently drift from it. `envOverrides` is applied and reverted around one synchronous
// require; nothing else in this single-threaded process can observe the window in between.
//
// The require.cache entry is restored to whatever it was before this ran (not left cleared, and
// not left holding the overridden-env build) -- this process's own top-level `defaultConfig`
// (this file's own `require('./config')` above) is a separate, already-bound reference and is
// never affected either way, but restoring the cache entry keeps a LATER `require('./config')`
// anywhere else in this process idempotent, exactly as if this function had never run.
function resolveScannerTimersUnderEnv(envOverrides) {
  const configPath = require.resolve('./config');
  const savedEnv = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  const savedCacheEntry = require.cache[configPath];
  try {
    delete require.cache[configPath];
    const fresh = require('./config');
    return {
      orphanScanMs: fresh.orphanScanMs,
      unparkScanMs: fresh.unparkScanMs,
      autoPullMs: fresh.autoPullMs,
      autoIntakeMs: fresh.autoIntakeMs,
      reportConfirmScanMs: fresh.reportConfirmScanMs,
      autoTriageMs: fresh.autoTriageMs,
      remoteReportPullMs: fresh.remoteReportPullMs,
    };
  } finally {
    for (const [key, original] of Object.entries(savedEnv)) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    if (savedCacheEntry) require.cache[configPath] = savedCacheEntry;
    else delete require.cache[configPath];
  }
}

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

// Declared here (not down in the "Config" section, where they lived before this action's own
// post-verification correction) so a k>1 scenario's own capLlmSteps override, just below, can be
// written as a multiple of DEFAULT_CAP_LLM_STEPS rather than a bare, undocumented number.
const DEFAULT_CAP_MS = 45 * 60 * 1000; // 45 minutes wall clock for one trivial card, real mode
const DEFAULT_CAP_LLM_STEPS = 12; // PLAN + IMPLEMENT(*1-4) + VALIDATE(*1-4) + slack -- see makeCap's header

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
  // `index` (present on ctx for every driver -- see createIssue below) is deliberately unread
  // here: this scenario is k=1, so its own single card never needs to distinguish itself from a
  // sibling.
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
    description:
      "IMPLEMENT changed only this card's own target file and NOTHING else -- nothing under " +
      'src/, and nothing that belongs to a sibling card in a k>1 scenario',
    // The assertion that makes this harness safe to point at the real repo. Everything else here
    // asks "did the pipeline work"; this one asks "did it do what we asked". Without it a run
    // that rewrote forty src/ files would satisfy every other assertion and be MERGED INTO
    // PRODUCT MAIN, because this scenario ends in a real merge. The card body already says
    // "Touch no other file. In particular, touch nothing under src/" -- an instruction nothing
    // was checking. Read from IMPLEMENT's own reported list, and cross-checked against the diff
    // the judges were handed, so a model that under-reports what it touched is caught too.
    //
    // `expectedFile` -- threaded in via `info` by the caller (runInlineScenario passes
    // scenario.targetFile(0); runDispatcherScenario passes scenario.targetFile(t.index) per
    // task) -- defaults to RECETTE_DOC_FILE so a caller that never supplies it (every existing
    // trivial-doc-log-only test in this file) keeps its previous, correct behaviour unchanged.
    // For parallel-doc-log this is what makes "touched a SIBLING's own file" a DISTINCT, caught
    // failure from "touched src/": a sibling's file is a real, valid recette target under
    // doc/ -- exactly the kind of thing a same-shape check that only asked "is this under src/"
    // would miss -- but it is never THIS card's own file, so it lands in `unexpected` too.
    check: ({ events, expectedFile = RECETTE_DOC_FILE }) => {
      const results = events.filter((ev) => ev.state === 'IMPLEMENT' && ev.event === 'result');
      const last = results[results.length - 1];
      const payload = last && last.payload;
      const raw = payload && ('files_changed' in payload ? payload.files_changed : payload.filesChanged);
      const parsed = Array.isArray(raw) ? raw : typeof raw === 'string' ? safeJsonArray(raw) : null;
      if (!parsed) return { ok: false, detail: 'no parsable files_changed' };

      const normalise = (f) => String(f).replace(/^\.\//, '').trim();
      const unexpected = parsed.map(normalise).filter((f) => f !== expectedFile);
      return {
        ok: unexpected.length === 0,
        detail:
          unexpected.length === 0
            ? `only ${expectedFile}`
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

// ---------------------------------------------------------------------------------------------
// parallel-doc-log -- driver: 'dispatcher', k: 2.
//
// POST-INCIDENT CORRECTION (live run, 2026-09-02, issues #630/#631 -> PRs #632/#633): this
// scenario's original design had both cards append their OWN distinct line to the SAME file
// (RECETTE_DOC_FILE), reasoning that "two genuinely different lines" makes the eventual merge
// "well-defined". That reasoning was wrong, and the live run proved it the expensive way. PR
// #632 (card 631) merged at 15:02:22Z. PR #633 (card 630) was already enqueued in the merge
// queue at that point; GitHub then reported "This branch has conflicts that must be resolved:
// doc/recette-log.md", `npm run pr:wait 633` returned exit 4 twice, and the card PARKED on
// 'merge-queue-not-landing'. The distinct LINE TEXT never mattered: both cards' diffs are a
// hunk anchored at the same place -- the file's tail (or the same "create the file with a
// one-line header" hunk, if neither line existed yet) -- so whichever PR's base commit is no
// longer HEAD by the time the second one tries to land has a hunk that cannot apply against the
// file's new state. This is not a probabilistic flake: for K cards appending at the same anchor
// in the same file, it is GUARANTEED that K-1 of them cannot land cleanly once the first does.
// A "parallelism" scenario that guarantees K-1 of its own K cards a merge conflict proves nothing
// about concurrency -- it proves the opposite of what it set out to.
//
// THE FIX: each card gets its OWN target file, one per `index`, drawn from a small FIXED set
// reused every run (see `parallelDocFile`/`letterSuffix` below) -- `doc/recette-log-a.md` for
// index 0, `doc/recette-log-b.md` for index 1, and so on. Two cards' diffs then touch entirely
// disjoint files: there is no shared hunk for git (or GitHub's merge queue) to conflict over,
// regardless of landing order, regardless of how many lines either file has accumulated by then.
// This is structural, not timing-dependent -- unlike "make sure the two lines are far enough
// apart", it does not depend on how large the shared file has grown or on the two PRs' base SHAs
// lining up.
//
// REJECTED ALTERNATIVES:
//   1. Keep one shared file, distinct lines (the ORIGINAL design). Rejected: proven broken above.
//   2. One NEW file per RUN (e.g. `doc/recette-log-${runId}-a.md`). Rejected: "bounded repo
//      footprint" is an explicit constraint here -- these changes merge into SPO-WebClient's real
//      `main` on every green run, and a design keyed on `runId` accumulates a new pair of files in
//      doc/ forever. A design keyed on `index` instead stays at exactly `k` files, total, for the
//      life of the scenario -- the same small, constant footprint RECETTE_DOC_FILE itself already
//      has (one file, growing one line per run); this is that same shape, times k.
//   3. One shared file, cards write to different SECTIONS/headings within it (pre-reserved
//      regions). Rejected: still one file, so still one set of hunks a text-diff has to reconcile,
//      and the anchor-point problem does not go away -- it just moves from "the file's tail" to
//      "the boundary of section A vs section B", which shifts every time either section grows.
//      It is also strictly harder to hand an LLM an unambiguous instruction for ("append after
//      the third bullet under the second-level heading whose text is exactly...") than "append to
//      this file, which is yours alone" -- more surface for IMPLEMENT to get subtly wrong, for no
//      benefit over disjoint files.
//   4. Random/hash-based filenames per card. Rejected: fails the harness's OWN safety
//      requirement -- "the per-card target must be derivable by the card itself" (the card's body
//      is written once, by buildCard, and handed to an LLM; nothing about a random name is
//      re-derivable or checkable against a second source of truth the way `index` is).
//
// Each card is still, on its own, structurally identical to a trivial-doc-log card (append one
// line to a `doc/` file, touch nothing else) -- see RECETTE_DOC_FILE's own comment for why a
// `doc/` file is the safest input CHECK/GATE can be handed; every one of those properties
// (invisible to typecheck/lint/coverage:changed) holds for ANY file under `doc/`, this scenario's
// per-card files included, not just the one literal path RECETTE_DOC_FILE names.
// ---------------------------------------------------------------------------------------------

// letterSuffix(index) -- spreadsheet-column style: 0->'a', 1->'b', ..., 25->'z', 26->'aa', ...
// Deterministic and collision-free for any index >= 0, so the file-naming scheme below scales
// structurally to any K a scenario's own `k` ever becomes -- it is not a hand-fit for K=2, the
// only value `parallel-doc-log` happens to use today.
function letterSuffix(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(97 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// parallelDocFile(index) -- the ONE file this index's card is allowed to touch. THE single
// source of truth for that fact: both parallelDocLogCard (what the card is TOLD) and the
// 'implement-touched-only-the-recette-doc' assertion (what IMPLEMENT is CHECKED against, via
// scenario.targetFile -- see runInlineScenario/runDispatcherScenario below) call this same
// function, so the instruction and the check can never quietly drift into two different answers.
function parallelDocFile(index) {
  return `doc/recette-log-${letterSuffix(index)}.md`;
}

function parallelDocLogCard({ runId, index }) {
  const suffix = letterSuffix(index);
  const cardId = `${runId}-${suffix}`;
  const file = parallelDocFile(index);
  const title = `[spo-recette] parallel synthetic card ${cardId}`;
  const body = [
    'This issue was created automatically by `spo recette` (orchestrator/recette.js), scenario',
    '"parallel-doc-log" -- one of TWO synthetic cards this run files together, run through the',
    'real dispatcher (K=2) so the run can prove they were worked on concurrently, not merely both',
    'finished eventually.',
    '',
    'It is not real backlog work. Labelled `' + RECETTE_LABEL + '`, and closed by the harness\'s',
    'own cleanup once the run finishes (success, park, or a tripped cap). If you are reading this',
    'on a still-open issue, cleanup did not run to completion -- it is safe to close by hand.',
    '',
    '## Done means',
    '',
    `Append exactly one new line to \`${file}\` (create the file, with a one-line`,
    'header, if it does not exist yet). This file is this card\'s own -- the sibling card in this',
    'run targets a different file; do not touch it. The new line should read exactly:',
    '',
    `- ${cardId} -- synthetic parallel recette card, no product behaviour changed`,
    '',
    `Touch no other file. In particular, touch nothing under \`src/\`, and nothing that belongs`,
    'to the sibling card.',
    '',
    `Source: \`spo recette\`, scenario parallel-doc-log, run ${runId}, card ${suffix}.`,
  ].join('\n');

  // Explicit, never re-parsed off the body -- see trivialDocLogCard's own comment (issue #467)
  // for why: identical reasoning, identical fix, one card in two.
  const criterion = [
    `Append exactly one new line to ${file} (create the file with a one-line header`,
    'if it does not exist yet). The new line must read exactly, byte for byte:',
    `- ${cardId} -- synthetic parallel recette card, no product behaviour changed`,
    'Touch no other file. In particular, touch nothing under src/, and nothing that belongs to',
    'the sibling card\'s own file.',
  ].join(' ');

  return { title, body, criterion };
}

// The per-task assertions are TRIVIAL_DOC_LOG_ASSERTIONS itself, unmodified and reused, not a
// copy -- each of parallel-doc-log's two cards is, on its own, exactly a trivial-doc-log card
// (same file, same "only this file changed" requirement, same DONE/merge shape). What makes this
// scenario different is entirely in the cross-task assertions below, which no single task's own
// journal could ever prove.

// info: {tasks: [{taskId, events, finalState}, ...], daemonEvents, dispatcherConfig, capTripped}
// -- see evaluateCrossTaskAssertions' own header for why this is a SEPARATE info shape from
// evaluateAssertions' per-task one, and why that separation is deliberate, not an oversight.
const PARALLEL_DOC_LOG_CROSS_ASSERTIONS = [
  {
    id: 'real-overlap',
    description:
      'the two workers were genuinely alive at the same wall-clock instant (not two serial runs that merely both finished)',
    // CLOCK-FREE BY DESIGN (post-verification correction) -- the first cut of this check compared
    // Date.parse(spawn.ts)/Date.parse(exit.ts) and flaked: this box's Date.now() is documented
    // (orchestrator/monotonic-clock.js) to jump BACKWARD (measured -2515ms across a single 10ms
    // interval), and a jump landing between two events for the SAME task can invert their order
    // -- caught once in this file's own verification as a false "not concurrent" on a genuinely
    // concurrent run. Worse, the same jump is unsound in the DANGEROUS direction too: it can make
    // a truly SERIAL pair of tasks read as overlapping, and nothing in a timestamp-diff check can
    // tell the two apart after the fact.
    //
    // The fix needs no clock at all. 'worker-spawn' and 'worker-exit' for BOTH tasks are appended
    // by the SAME single process -- dispatcher.js's own spawnOne/handleExit, never a worker child
    // (grep orchestrator/dispatcher.js: both calls live there, nowhere else) -- to the SAME
    // daemon.jsonl, one synchronous fs.appendFileSync per call (journal.js's appendDaemonEvent).
    // Their RECORD ORDER in that file is therefore that one process's own single-threaded
    // execution order for these two event types specifically -- true causal (happens-before)
    // order, immune to any Date.now() jump in either direction, because no timestamp is read at
    // all. If B's own worker-spawn record appears BEFORE A's own worker-exit record, then A had
    // genuinely not exited yet at the instant B was spawned -- full stop, regardless of what any
    // clock says either event's `ts` field carries.
    check: ({ daemonEvents, tasks }) => {
      if (tasks.length !== 2) return { ok: false, detail: `expected exactly 2 tasks, got ${tasks.length}` };
      const events = daemonEvents || [];
      const [ta, tb] = tasks;
      const idx = (event, id) => events.findIndex((e) => e && e.event === event && e.id === id);
      const aSpawnIdx = idx('worker-spawn', ta.taskId);
      const aExitIdx = idx('worker-exit', ta.taskId);
      const bSpawnIdx = idx('worker-spawn', tb.taskId);
      const bExitIdx = idx('worker-exit', tb.taskId);

      if ([aSpawnIdx, aExitIdx, bSpawnIdx, bExitIdx].some((i) => i === -1)) {
        return {
          ok: false,
          detail: `missing worker-spawn/worker-exit record(s): aSpawn=${aSpawnIdx} aExit=${aExitIdx} bSpawn=${bSpawnIdx} bExit=${bExitIdx}`,
        };
      }
      // A task's own exit record appearing before (or at) its own spawn record is not a
      // concurrency question at all -- it means the events array itself is out of order or
      // corrupt (this check reads no timestamp, so it cannot be a clock artifact). Reported
      // distinctly so a human does not go hunting a concurrency bug that was never there.
      if (aSpawnIdx >= aExitIdx || bSpawnIdx >= bExitIdx) {
        return {
          ok: false,
          detail: `a task's own worker-exit record does not follow its own worker-spawn record -- corrupt event order, not evaluable: aSpawn=${aSpawnIdx} aExit=${aExitIdx} bSpawn=${bSpawnIdx} bExit=${bExitIdx}`,
        };
      }

      const overlap = bSpawnIdx < aExitIdx && aSpawnIdx < bExitIdx;
      return {
        ok: overlap,
        detail: `record order: aSpawn@${aSpawnIdx} aExit@${aExitIdx} bSpawn@${bSpawnIdx} bExit@${bExitIdx} overlap=${overlap}`,
      };
    },
  },
  {
    id: 'zero-cross-task-writes',
    description: "each task's own journal.jsonl carries only that task's own id -- never a sibling's",
    // The single-writer invariant journal.js's own header states (dispatcher.js's own header
    // reiterates it for the live-worker table) says a taskDir is only ever written by its own
    // owner. This checks the OBSERVABLE consequence of that holding for these two specific tasks:
    // neither task's own event stream ever mentions the OTHER task's id anywhere in its payload.
    check: ({ tasks }) => {
      if (tasks.length !== 2) return { ok: false, detail: `expected exactly 2 tasks, got ${tasks.length}` };
      const [a, b] = tasks;
      const leaked = (mine, otherId) => (mine.events || []).filter((e) => JSON.stringify(e).includes(otherId));
      const aLeaked = leaked(a, b.taskId);
      const bLeaked = leaked(b, a.taskId);
      return {
        ok: aLeaked.length === 0 && bLeaked.length === 0,
        detail:
          aLeaked.length === 0 && bLeaked.length === 0
            ? 'clean'
            : `cross-contamination: ${a.taskId} mentions ${b.taskId} ${aLeaked.length}x, ${b.taskId} mentions ${a.taskId} ${bLeaked.length}x`,
      };
    },
  },
  {
    id: 'zero-auto-pull',
    description: 'the run journalled zero auto-pull events -- the scanner never claimed a real backlog card into this run',
    // THE assertion that makes the dispatcher driver safe to point at the real repo -- see this
    // scenario's own header comment and the module header's "ACTION 7.2" paragraph. A dispatcher
    // always spawns a scanner (dispatcher.js's run(), unconditionally); if autoPullMs somehow
    // reached that scanner nonzero, it would run `npm run board:claim` against the LIVE board and
    // enqueue a real card into this run's own throwaway queue. This is the trivial-doc-log
    // 'implement-touched-only-the-recette-doc' assertion's own sibling for the dispatcher driver.
    check: ({ daemonEvents }) => {
      const pulls = (daemonEvents || []).filter((e) => e.event === 'auto-pull');
      return { ok: pulls.length === 0, detail: pulls.length === 0 ? 'zero auto-pull events' : `${pulls.length} auto-pull event(s): ${JSON.stringify(pulls)}` };
    },
  },
  {
    id: 'scan-timers-disabled',
    description:
      "the seven scan/report env vars are all forwarded to the scanner's own OS process env as \"0\", and config.js's own (unmodified) parsing of them resolves to 0 too -- NOTE: this proves the timer VALUES, not that every loop is disabled; see this check's own comment on SPO_REMOTE_REPORT_PULL_MS",
    // POST-VERIFICATION CORRECTION -- the first cut of this check inspected `dispatcherConfig`,
    // the JS object runDispatcherScenario builds for createDispatcher. That object is read by
    // THIS process's own createDispatcher (workers/shadowMode/dryRun/stepDeadlineMs -- the fields
    // that actually govern spawnOne/buildWorkerArgv) -- but the SCANNER never sees it. The
    // scanner is a SEPARATE OS process (dispatcher.js's spawnScanner -> `node daemon.js
    // --scanner ...`), and daemon.js's own --scanner branch resolves its OWN config from
    // SCRATCH via `require('./config')`, which reads `process.env.SPO_*_MS`, not any object this
    // process constructs. So the six zeroed fields on `dispatcherConfig` were true and completely
    // irrelevant: they described an object the scanner structurally cannot read. Demonstrated
    // during this action's own verification: zeroing every field on `dispatcherConfig` while
    // leaving the SPO_*_MS env vars at their real, nonzero defaults still let a live scanner's
    // very first cycle run auto-pull for real.
    //
    // The channel that actually reaches the scanner is its INHERITED `process.env` at the moment
    // `child_process.spawn` is called (spawnScanner passes no `env` override, so Node clones
    // `process.env` as it stands right then) -- runDispatcherScenario now forwards these SEVEN
    // env vars as "0" for the WHOLE span the dispatcher runs, and records that exact snapshot as
    // `scannerEnvOverrides` in the info this check reads. Checked in TWO layers, both against
    // real, unmodified production code -- never a copy that could silently drift from it:
    //   1. every one of the seven env vars was actually forwarded as the string "0" (not merely
    //      intended to be -- the literal snapshot recorded at spawn time).
    //   2. config.js itself -- the exact module the scanner's own process requires -- resolves
    //      all seven fields to the NUMBER 0, via `resolveScannerTimersUnderEnv` (this file,
    //      cache-busted so it is config.js's own parsing being exercised, never a hand-rolled
    //      duplicate that could drift from it). `info.resolveScannerTimers` overrides it --
    //      TEST-ONLY, production never sets it -- so a test can prove this layer is not
    //      decorative: hand it a fake resolver and confirm the check actually uses its return
    //      value rather than a hardcoded answer.
    //
    // SPO_REMOTE_REPORT_PULL_MS IS THE ONE EXCEPTION TO "0 MEANS DISABLED" (post-verification
    // finding) -- this check still proves that env var resolves to 0 (true and worth knowing: it
    // minimises the RESCHEDULE delay), but 0 does NOT disable remote-report-pull.js's own
    // startRemoteReportPullLoop, whose first `tick()` runs UNCONDITIONALLY on scanner startup,
    // never gated by remoteReportPullMs at all -- see runRecette's own comment at the
    // remote-report-url refusal for the full mechanism and why that refusal, not this timer, is
    // what actually keeps a dispatcher-driver scenario safe against a real pull+ack.
    check: ({ scannerEnvOverrides, resolveScannerTimers = resolveScannerTimersUnderEnv }) => {
      const required = SCANNER_TIMER_ENV_VARS;
      if (!scannerEnvOverrides) {
        return { ok: false, detail: 'no scannerEnvOverrides in info -- the dispatcher driver never recorded what it forwarded to the scanner' };
      }
      const notZeroString = required.filter((k) => scannerEnvOverrides[k] !== '0');
      if (notZeroString.length > 0) {
        return {
          ok: false,
          detail: `not forwarded as the string "0": ${notZeroString.map((k) => `${k}=${JSON.stringify(scannerEnvOverrides[k])}`).join(', ')}`,
        };
      }
      const resolved = resolveScannerTimers(scannerEnvOverrides);
      const nonZero = Object.entries(resolved).filter(([, v]) => v !== 0);
      return {
        ok: nonZero.length === 0,
        detail:
          nonZero.length === 0
            ? `all seven env-forwarded timers, and config.js's own resolution of them, are 0 (remoteReportPullMs=0 minimises reschedule delay only -- it does not gate the FIRST pull; see the remote-report-url refusal for that): ${JSON.stringify(resolved)}`
            : `config.js itself resolves a NON-ZERO value despite the "0" env override: ${JSON.stringify(resolved)}`,
      };
    },
  },
  {
    id: 'zero-remote-report-activity',
    description:
      'the run journalled zero remote-report-pull events -- belt-and-braces evidence that no real HTTPS pull/ack against production bug reports happened (the actual guard is runRecette\'s own SPO_REMOTE_REPORT_URL refusal, checked BEFORE this scenario ever starts; see that refusal\'s own comment for why remoteReportPullMs=0 alone cannot be trusted for this one loop)',
    check: ({ daemonEvents }) => {
      const events = (daemonEvents || []).filter((e) => typeof e.event === 'string' && e.event.startsWith('remote-report-'));
      return {
        ok: events.length === 0,
        detail: events.length === 0 ? 'zero remote-report-* events' : `${events.length} remote-report-* event(s): ${JSON.stringify(events)}`,
      };
    },
  },
];

const SCENARIOS = {
  'trivial-doc-log': {
    name: 'trivial-doc-log',
    label: RECETTE_LABEL,
    description:
      `One line appended to ${RECETTE_DOC_FILE} -- a docs-only change (see the comment above ` +
      'RECETTE_DOC_FILE for why this is the safest input CHECK/GATE can be handed).',
    driver: 'inline',
    k: 1,
    buildCard: trivialDocLogCard,
    // targetFile(index) -- the file THIS index's card is allowed to touch; k=1 so `index` is
    // always 0 and the answer is always the one constant. See parallel-doc-log's own targetFile
    // just below for why this exists as a per-scenario function rather than a bare constant read
    // straight off RECETTE_DOC_FILE: runInlineScenario/runDispatcherScenario call it uniformly
    // for every scenario, never special-casing k=1 vs k>1.
    targetFile: () => RECETTE_DOC_FILE,
    assertions: TRIVIAL_DOC_LOG_ASSERTIONS,
  },
  'parallel-doc-log': {
    name: 'parallel-doc-log',
    label: RECETTE_LABEL,
    description:
      'Two synthetic cards, same shape as trivial-doc-log, run through the real dispatcher at ' +
      'K=2 -- proves real concurrency (worker-spawn/worker-exit overlap), zero cross-task ' +
      'journal writes, and that every scan timer handed to the dispatcher was really off.',
    driver: 'dispatcher',
    k: 2,
    // POST-VERIFICATION CORRECTION: DEFAULT_CAP_LLM_STEPS (12) is sized, by its own comment, for
    // ONE card's worth of LLM steps (PLAN + IMPLEMENT*1-4 + VALIDATE*1-4 + slack). The
    // out-of-process cap (runDispatcherCapWatchdog) sums llm-call events ACROSS every task this
    // run owns (sumLlmSteps), so a k=2 scenario sharing the k=1 default would trip a perfectly
    // healthy run partway through the second card, having spent the WHOLE budget on the first.
    // Doubled here, one card's worth per card -- see resolveConfig's own scenarioCapOverride for
    // where this is actually read (opts/env still win over it, same as every other cap knob).
    // capMs is left at the global default: it is a WALL-CLOCK ceiling shared by K CONCURRENT
    // cards, not summed across them the way LLM steps are, so the k=1 budget already covers two
    // cards racing inside the same window.
    capLlmSteps: DEFAULT_CAP_LLM_STEPS * 2,
    buildCard: parallelDocLogCard,
    // targetFile(index) -- see parallelDocFile's own header comment for why this is the single
    // source of truth both the card body (what a card is TOLD) and
    // 'implement-touched-only-the-recette-doc' (what IMPLEMENT is CHECKED against) are built from.
    targetFile: parallelDocFile,
    assertions: TRIVIAL_DOC_LOG_ASSERTIONS,
    crossTaskAssertions: PARALLEL_DOC_LOG_CROSS_ASSERTIONS,
  },
};

// main-moved-doc-log was scoped for this action and deliberately NOT built -- see
// doc/remediation-progress.md's C7 action-7.2 entry (or the PR that landed this comment) for the
// full refusal. POST-VERIFICATION CORRECTION to the reasoning below (the original version claimed
// a main-moved scenario would be uniquely dangerous because it "requires pushing directly to
// origin/main" and that every other recette artifact is "cleanly disposable" -- both false:
// trivial-doc-log ALREADY merges a PR into product main on every green run, right now, on every
// scenario this action shipped -- that is what its own 'merged'/'finished' assertions assert, and
// its own module-level comment already says so. recette moves origin/main permanently through the
// pipeline's own ordinary MERGE step every time it succeeds; a main-moved scenario would not be
// introducing that risk class, it would be reusing it.
//
// The real reason this action did not build it is SCOPE AND SEQUENCING COMPLEXITY, not a risk
// class main-moved-doc-log alone would introduce. Exercising the re-gate for real needs a SECOND
// card's own commit to land on origin/main between card A's PUSH_PR and its CI_CHECKS -- in this
// scenario's case, confined to the same RECETTE_DOC_FILE line card A itself touches, so the
// intersection is real and the blast radius stays one doc line (see RECETTE_DOC_FILE's own
// comment on why that file is the safest input CHECK/GATE can be handed). That is a genuine
// SEQUENCING problem on top of the K=2 dispatcher parallel-doc-log already had to build for this
// same action: two independent cards racing through PUSH_PR/GATE/CI_CHECKS/MERGE with no shared
// coordination point, one of which has to be timed to land its own merge inside a narrow window of
// the other's own CI_CHECKS wait -- a materially different (and materially harder to get right and
// keep hermetic) shape than "two cards run concurrently and both finish", which is what
// parallel-doc-log already proves. Getting that sequencing wrong live would waste a real product-
// main merge and a real re-gate cycle for no signal, not create a new class of danger main-moved
// alone invented.
//
// test/gate-main-moved.test.js ALREADY proves the whole main-moved decision tree hermetically
// (realGate/realCiChecks driven directly with fake spawnSync, no product repo, no dispatcher) --
// see that file's own header. What a LIVE main-moved-doc-log scenario would add on top of that
// existing coverage is narrow and specific: proof that a REAL bench verdict file
// (~/.spo-bench/verdicts/<sha>.json) genuinely omits `baseMain` when origin/main has moved out
// from under a real worktree, which is an assumption test/gate-main-moved.test.js's own fake
// verdicts cannot exercise. That is a real, scoped, well-defined follow-up -- not a reason this
// harness cannot ever safely drive main-moved for real -- and is left for a future action rather
// than folded into this one's own already-large surface (a real dispatcher driver, an
// out-of-process cap, and a corrected scan-timer-forwarding mechanism).
//
// UPDATE (post-incident, 2026-09-02, issues #630/#631 -> PRs #632/#633): main-moved is no longer
// merely a hypothetical this action chose not to build -- the live parallel-doc-log run above
// REACHED it, unintentionally, at K=2: PR #632 (card 631) merged, moving origin/main, while PR
// #633 (card 630) was already sitting in the merge queue. That is exactly the intersection window
// main-moved-doc-log would have been built to exercise on purpose. It is STILL not a scenario
// here, and the reason has changed: it is not scope/sequencing complexity any more, it is that
// the pipeline does not yet re-gate that intersection -- card 630 PARKED
// ('merge-queue-not-landing') instead of being re-gated against the new origin/main. The
// intersection test that exists (test/gate-main-moved.test.js) runs realGate/realCiChecks at
// CI_CHECKS, BEFORE a sibling's merge can land; nothing re-runs it in the GATE-to-merge-queue-
// landing window where this incident actually happened, so the gap that window represents is
// unprotected today. A scenario whose own documented "done" outcome is a park is not a gate
// scenario -- shipping one here would either be marked expected-to-fail (useless as a gate) or
// would need the pipeline fix landed first. That pipeline/product fix is being filed separately,
// not folded into this action; a live main-moved-doc-log scenario stays future work, gated on it.

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

// DEFAULT_CAP_MS/DEFAULT_CAP_LLM_STEPS are declared earlier in this file now (just above
// "Scenarios" below) -- a k>1 scenario's own capMs/capLlmSteps override (see
// scenarioCapOverride/parallel-doc-log) needs them in scope at scenario-definition time, which is
// textually BEFORE this "Config" section.

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// A positive-integer field on the scenario itself (scenario.capMs/scenario.capLlmSteps), or null.
// `resolveConfig` folds this in BELOW opts/env but ABOVE the global DEFAULT_CAP_MS/
// DEFAULT_CAP_LLM_STEPS -- see that function's own header for why a scenario needs this at all
// (action 7.2, post-verification correction: DEFAULT_CAP_LLM_STEPS is sized, by its own comment,
// for ONE card's worth of LLM steps; a k>1 dispatcher-driver scenario's own out-of-process cap
// SUMS llm-call events across every task it owns, so K cards sharing one card's budget trips a
// perfectly healthy run partway through the SECOND card).
function scenarioCapOverride(scenario, field) {
  const n = scenario && scenario[field];
  return Number.isInteger(n) && n > 0 ? n : null;
}

// resolveConfig(opts, scenario) -- the ONE place `--dry`'s printed plan and the real run's actual
// config both come from, so the two can never structurally diverge (requirement: "--dry prints
// the plan of what it would do"). `opts.recetteDir` (default `<repoRoot>/.recette`) is the parent
// of every run's own `<runId>/{journal,queue}` -- gitignored, never the live `journal/`/`queue/`
// the daemon holds a lock on. `opts.productJournalRoot` is a test-only override for the safety
// check's own target (default: `<repoRoot>/journal`, i.e. the REAL daemon's journal root,
// regardless of where THIS run's own isolated journal lives).
//
// `scenario` (optional, default null -- every existing call site that omits it, including every
// test built before this parameter existed, resolves EXACTLY the global defaults it always did)
// only ever supplies capMs/capLlmSteps, and only when opts/the env var did not already say
// something more specific -- see scenarioCapOverride above and its own priority order:
// opts.capMs/capLlmSteps (an explicit `--cap-ms`/`--cap-llm-steps` flag or test override) wins
// over SPO_RECETTE_CAP_MS/SPO_RECETTE_CAP_LLM_STEPS, which wins over the scenario's own default,
// which wins over this file's global DEFAULT_CAP_MS/DEFAULT_CAP_LLM_STEPS.
function resolveConfig(opts = {}, scenario = null) {
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
    capMs: opts.capMs || envInt('SPO_RECETTE_CAP_MS', scenarioCapOverride(scenario, 'capMs') || DEFAULT_CAP_MS),
    capLlmSteps: opts.capLlmSteps || envInt('SPO_RECETTE_CAP_LLM_STEPS', scenarioCapOverride(scenario, 'capLlmSteps') || DEFAULT_CAP_LLM_STEPS),
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

// `index` (default 0, unread by a k=1 scenario's own buildCard) is what lets a k>1 scenario
// distinguish its own cards from each other -- see parallelDocLogCard.
function createIssue(scenario, config, deps, index = 0) {
  const { title, body, criterion } = scenario.buildCard({ runId: config.runId, index });
  fs.mkdirSync(config.runDir, { recursive: true });
  // Per-index filename (not a shared 'issue-body.md') -- a k>1 scenario calls this once per card,
  // sequentially, and a shared name would work by ACCIDENT of call ordering (each `gh` spawn
  // reads the file synchronously, before the next write happens) but a distinct file per card is
  // both safer against a future change to that ordering and keeps every card's own rendered body
  // on disk for a failed run's own diagnosis (see cleanup's own "keep on failure" reasoning).
  const bodyFile = path.join(config.runDir, `issue-body-${index}.md`);
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

// `index` (default 0) picks the queue filename, same zero-padded convention `spo pull`'s own
// intake.makeTask batch uses -- '0001-recette.json' for index 0, unchanged from before this
// action, so the k=1 inline path's own queue layout is byte-for-byte identical.
//
// `extra` (default {}, TEST-ONLY -- see resolveConfig's own `configOverrides` comment for the
// identical posture) is merged into the task object AFTER every field above, so a test can attach
// a `shadow` fixture to a k>1 dispatcher-driver scenario's own `kind: "card"` tasks -- the ONLY
// way to make those tasks' workers deterministic and instant without a real `claude`/`git`/`gh`,
// since state-machine.js's ctx.shadowMode (config-level, not task-level) governs every step
// uniformly regardless of task.kind (see steps/llm.js's and steps/scripted.js's own shadow
// branches, both gated on ctx.shadowMode alone). bin/spo never sets this -- there is no CLI flag.
function enqueueTask(config, issue, index = 0, extra = {}) {
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
    ...extra,
  };
  fs.mkdirSync(config.queueDir, { recursive: true });
  const filename = `${String(index + 1).padStart(4, '0')}-recette.json`;
  fs.writeFileSync(path.join(config.queueDir, filename), JSON.stringify(task, null, 2) + '\n');
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

// The daemon-level counterpart to readJournalEvents -- <journalRoot>/daemon.jsonl (journal.js's
// appendDaemonEvent: dispatcher.js's own worker-spawn/worker-exit/scanner-*/dispatcher-* lines,
// auto-pull.js's 'auto-pull' cycle summary). Only ever populated by the dispatcher driver -- the
// inline driver never spawns a dispatcher, so this file never exists on that path (empty array,
// same "absent means nothing happened yet" reading readJournalEvents/readStateSafe already use).
function readDaemonEvents(journalRoot) {
  try {
    return fs
      .readFileSync(path.join(journalRoot, 'daemon.jsonl'), 'utf8')
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

// evaluateCrossTaskAssertions(scenario, info) -- evaluateAssertions' sibling for a k>1
// dispatcher-driver scenario's own `crossTaskAssertions`, DELIBERATELY A SEPARATE FUNCTION rather
// than a widened evaluateAssertions: the brief this action shipped under is explicit that
// evaluateAssertions itself must stay pure and untouched (it is unit-tested standalone against a
// hand-built broken journal specifically to prove this harness is not a rubber stamp -- widening
// its own `info` shape to sometimes mean "one task" and sometimes "several" would be exactly the
// kind of change that erodes what that test proves). Same never-throws contract, same
// {id, description, ok, detail} result shape, same "one broken check does not hide the rest"
// behaviour -- `scenario.crossTaskAssertions` defaults to `[]` (a k=1 scenario has none) so this
// is always safe to call.
//
// `info`: {tasks: [{taskId, events, finalState}, ...], daemonEvents, dispatcherConfig,
//          capTripped} -- `dispatcherConfig` is the ACTUAL object runDispatcherScenario handed to
// createDispatcher (see that function below), not a value re-derived from any constant, so a
// scenario's own 'scan-timers-disabled' check (see parallel-doc-log) is checking production's own
// wiring, not a copy of it.
function evaluateCrossTaskAssertions(scenario, info) {
  const checks = scenario.crossTaskAssertions || [];
  const results = checks.map((a) => {
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

// A cleanup step's job is "this artifact is not there any more", not "my command exited 0".
// Those differ on the SUCCESS path, and the difference is not cosmetic: after a DONE run FINISH
// has already removed the worktree, MERGE has already merged (so `gh pr close` refuses) and the
// merge deleted the remote branch -- so three steps exit non-zero on a perfect run. Reporting
// that as `3 not-clean` teaches the maintainer to ignore the one line that would report a real
// leak, which is worse than not printing it at all. Measured on the first green live run
// (2026-08-31, issue #469): 3 of 7 steps "not-clean", nothing actually left behind.
//
// So: recognise the tool's own "there was nothing to do" messages and record them as `gone`.
// Anything unrecognised stays a failure -- this must never launder a real error into silence.
const ALREADY_GONE_PATTERNS = [
  /is not a working tree/i, //            git worktree remove, already removed by FINISH
  /No such file or directory/i, //        git worktree remove, path already gone
  /not a valid ref|unable to delete|remote ref does not exist/i, // push --delete, already deleted
  /branch .* not found|error: branch .* not found/i, //           branch -D, already deleted
  /already merged|Pull request .* is already closed|not open/i, // gh pr close on a merged PR
  /Could not resolve to a[n]? (PullRequest|Issue)/i, //           already gone entirely
];

function classifyStep(exit, text) {
  if (exit === 0) return { ok: true, gone: false };
  const t = String(text || '');
  if (ALREADY_GONE_PATTERNS.some((re) => re.test(t))) return { ok: true, gone: true };
  return { ok: false, gone: false };
}

function tryStep(steps, name, fn) {
  try {
    const detail = fn();
    // A step returning {exit, output} is classified; anything else (a plain fs step) is ok.
    if (detail && typeof detail.exit === 'number') {
      const { ok, gone } = classifyStep(detail.exit, detail.output);
      steps.push({ name, ok, gone, detail });
    } else {
      steps.push({ name, ok: true, gone: false, detail });
    }
  } catch (err) {
    steps.push({ name, ok: false, gone: false, detail: err && err.message });
  }
}

// The text a command used to explain itself -- stderr first, since that is where git and gh put
// "there was nothing to do".
function outputOf(r) {
  return `${(r && r.stderr) || ''}\n${(r && r.stdout) || ''}`;
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

// githubArtifactSteps -- the ONE task's worth of real-world artifact cleanup (worktree, local +
// remote branch, wip/ refs, PR, issue), factored out of `cleanup` below so a k>1 dispatcher-driver
// scenario's own `cleanupMultiTask` can run it once per task without duplicating the step list.
// `cleanup` itself is UNTOUCHED in every observable way (same steps, same order, same names, same
// {ok, gone, detail} shape) -- this is a pure extraction, not a behaviour change; see this file's
// own action-7.2 header note on why that has to stay true for the k=1 driver.
function githubArtifactSteps(scenario, config, deps, { issueNumber, prNumber, wipRefs }) {
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
      return { exit: normalizeExit(r), output: outputOf(r) };
    });
    tryStep(steps, 'worktree-prune', () => {
      const r = armedRunSync(deps, 'git', ['-C', config.productRepo, 'worktree', 'prune'], {}, config);
      return { exit: normalizeExit(r), output: outputOf(r) };
    });
    tryStep(steps, 'branch-delete-local', () => {
      const r = armedRunSync(deps, 'git', ['-C', config.productRepo, 'branch', '-D', branch], {}, config);
      return { exit: normalizeExit(r), output: outputOf(r) };
    });
    tryStep(steps, 'branch-delete-remote', () => {
      const r = armedRunSync(deps, 'git', ['-C', config.productRepo, 'push', 'origin', '--delete', branch], {}, config);
      return { exit: normalizeExit(r), output: outputOf(r) };
    });
  }

  // The `wip/` refs this run pushed to origin (park path only -- see wipRefsFrom above). One
  // step per ref, named with the ref, so the printed cleanup line says exactly which remote
  // branch still needs a hand if a delete fails.
  for (const ref of wipRefs || []) {
    tryStep(steps, `wip-ref-delete:${ref}`, () => {
      const r = armedRunSync(deps, 'git', ['-C', config.productRepo, 'push', 'origin', '--delete', ref], {}, config);
      return { exit: normalizeExit(r), output: outputOf(r) };
    });
  }

  if (prNumber) {
    tryStep(steps, 'pr-close', () => {
      const r = armedRunSync(deps, 'gh', ['pr', 'close', String(prNumber), '--repo', config.ghRepo], {}, config);
      return { exit: normalizeExit(r), output: outputOf(r) };
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
      return { exit: normalizeExit(r), output: outputOf(r) };
    });
  }

  return steps;
}

function cleanup({ scenario, config, deps, issueNumber, prNumber, wipRefs, keepRunDir = false }) {
  const steps = githubArtifactSteps(scenario, config, deps, { issueNumber, prNumber, wipRefs });

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

  // `gone` steps are clean: the artifact is not there, which is the whole point. Only a step we
  // could not account for counts as a failure -- so a non-zero `anyFailed` means something really
  // may have been left behind, and is worth reading.
  const anyFailed = steps.some((st) => !st.ok);
  return { steps, anyFailed };
}

// cleanupMultiTask -- `cleanup`'s own sibling for a k>1 dispatcher-driver scenario: one
// `githubArtifactSteps` pass PER TASK (they each own a distinct issue/branch/worktree/PR), but
// only ONE journal-dir-kept/-remove step, since every task in a dispatcher-driver run shares the
// SAME config.runDir (one queue/, one journalRoot, one daemon.jsonl -- see runDispatcherScenario).
// Calling plain `cleanup()` once per task would instead try to remove/keep that one shared
// directory K times, reporting K misleading 'journal-dir-remove'/'journal-dir-kept' steps for
// work that only ever happens once.
function cleanupMultiTask({ scenario, config, deps, tasks, keepRunDir = false }) {
  const perTask = (tasks || []).map((t) => ({
    issueNumber: t.issueNumber,
    steps: githubArtifactSteps(scenario, config, deps, t),
  }));

  let runDirStep;
  if (keepRunDir) {
    runDirStep = { name: 'journal-dir-kept', ok: true, detail: { kept: config.runDir, why: 'the run failed -- evidence preserved for diagnosis' } };
  } else {
    const steps = [];
    tryStep(steps, 'journal-dir-remove', () => {
      fs.rmSync(config.runDir, { recursive: true, force: true });
      return { removed: config.runDir };
    });
    runDirStep = steps[0];
  }

  const anyFailed = perTask.some((t) => t.steps.some((s) => !s.ok)) || !runDirStep.ok;
  return { perTask, runDirStep, anyFailed };
}

// ---------------------------------------------------------------------------------------------
// Plan (shared by --dry and the real run -- see resolveConfig's own header)
// ---------------------------------------------------------------------------------------------

function buildPlan(scenario, config) {
  const driver = scenario.driver || 'inline';
  const k = Math.max(1, Number(scenario.k) || 1);

  // The exact seven env vars a dispatcher-driver run forwards to its real spawned scanner --
  // named here individually (post-verification correction: the printed plan used to name six and
  // say "forced to 0" with no mechanism, which is precisely the vague shape that let the "forced
  // in the wrong object" ship-blocker go unnoticed). A maintainer reading --dry before a live run
  // should see WHAT is forwarded and HOW, not a paraphrase.
  const scannerEnvList = SCANNER_TIMER_ENV_VARS.join(', ');

  const driverSteps =
    driver === 'dispatcher'
      ? [
          `refuse if SPO_REMOTE_REPORT_URL is set in this process's own environment (unless --force) -- see the scanner-env-forwarding step below for why`,
          `enqueue ${k} kind:"card" task(s) into ${config.queueDir}`,
          `drive them through orchestrator/dispatcher.js's createDispatcher (K=${k} real spawned workers + 1 real spawned scanner)`,
          `force ${scannerEnvList} to the string "0" on THIS process's own env for the whole run, so the scanner (a separate OS process that resolves its own config via process.env, not any object this process builds) inherits them at spawn time -- SPO_REMOTE_REPORT_PULL_MS=0 only minimises a reschedule delay, it does not gate remote-report-pull.js's own unconditional first pull, which is why the refusal above exists`,
          `enforce the cap out of process: a watchdog polls monotonicNowMs() elapsed time and every taskDir's own 'llm-call' journal events, and calls dispatcher.stop()+killAllChildren() the instant either ${config.capMs}ms wall clock or ${config.capLlmSteps} LLM steps is crossed`,
          "evaluate the scenario's per-task assertions against each task's own journal, plus its crossTaskAssertions against daemon.jsonl and the env actually forwarded to the scanner",
        ]
      : [
          'enqueue one kind:"card" task into ' + config.queueDir,
          `drain it for real (config.real=true) into ${config.journalRoot}, capped at ${config.capMs}ms wall clock / ${config.capLlmSteps} LLM steps`,
          "evaluate the scenario's declared assertions against the produced journal",
        ];

  return {
    scenario: scenario.name,
    description: scenario.description,
    label: scenario.label,
    driver,
    k,
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
      `create ${k === 1 ? 'a dedicated GitHub issue' : `${k} dedicated GitHub issues`} in ${config.ghRepo}, labelled "${scenario.label}"`,
      // Named explicitly (post-incident addition, see parallel-doc-log's own header comment for
      // the #630/#631 incident this responds to): a maintainer reading --dry before a live run
      // must be able to see, without reading source, that no two cards target the same file --
      // exactly the property whose absence caused a real merge-queue conflict and a real park.
      ...(scenario.targetFile
        ? [
            k === 1
              ? `this card's own target file: ${scenario.targetFile(0)}`
              : `each card's own target file (structurally distinct, never shared -- ${k - 1} of ${k} cards would be a guaranteed merge conflict otherwise): ${Array.from({ length: k }, (_, i) => `card ${i}: ${scenario.targetFile(i)}`).join('; ')}`,
          ]
        : []),
      ...driverSteps,
      'clean up: worktree remove+prune, local+remote branch delete, PR close, issue close, remove the run dir (unless --keep)',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

// runRecette(opts, deps) -> {ok, dry?, refused?, plan, scenario, runId, ...} -- see
// runInlineScenario/runDispatcherScenario below for the two driver-specific result shapes. Both
// share `ok`, `capTripped`, `elapsedMs`, `llmSteps` at the top level (this action's own
// requirement: bin/spo's reporting and exit-code contract must not have to branch on driver).
//
// `opts`: {scenario, keep, dry, force, recetteDir, productJournalRoot, accountsDir, capMs,
//          capLlmSteps, runId}  -- all optional, all also settable via resolveConfig's env vars
//          where noted.
// `deps`: {spawnSync, isAlive} -- production passes neither (real spawnSync, real
//          process.kill-based liveness); tests inject both. `deps` is passed to cleanup
//          UNWRAPPED -- see cleanup's own header. The dispatcher driver additionally reads
//          `deps.createDispatcher`/`deps.monotonicNowMs`/`deps.dispatcherPollMs`, TEST-ONLY
//          overrides for the real createDispatcher/monotonicNowMs and the watchdog's own poll
//          cadence -- production passes none of them (see runDispatcherScenario).
async function runRecette(opts = {}, deps = {}) {
  const scenario = resolveScenario(opts.scenario);
  const config = resolveConfig(opts, scenario);
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

  const driver = scenario.driver || 'inline';
  if (driver === 'dispatcher') {
    // POST-VERIFICATION FIX: SPO_REMOTE_REPORT_PULL_MS=0 (forwarded by runDispatcherScenario,
    // see SCANNER_TIMER_ENV_VARS' own header) does NOT disable remote-report-pull.js's own
    // startRemoteReportPullLoop -- that function's `tick()` runs UNCONDITIONALLY on startup
    // (state-machine.js's runForever calls it once, outside any should*-style gate), and only
    // the RESCHEDULE delay after that first, always-happens pull reads remoteReportPullMs at all.
    // The pull itself is a no-op ONLY because runRemoteReportPull's own early return requires
    // config.remoteReportUrl -- i.e. SPO_REMOTE_REPORT_URL -- to be set, which today lives solely
    // in the live daemon's systemd drop-in, never an interactive shell. That is the ONLY thing
    // stopping a dispatcher-driven scenario's real spawned scanner from making a genuine HTTPS
    // pull-and-ack against production bug reports into this machine's real ~/.spo-reports the
    // moment that env var ever DOES reach a shell `spo recette` is run from -- inherited by the
    // scanner exactly the way the seven scan timers are (spawnScanner passes no `env` override).
    // Refusing outright, the same shape as the daemon-lock refusal just above, is the cheapest
    // correct answer: `--force` overrides both, for a maintainer who has confirmed by hand that a
    // real pull+ack is acceptable.
    if (!opts.force && process.env.SPO_REMOTE_REPORT_URL) {
      return {
        ok: false,
        refused: true,
        plan,
        scenario: scenario.name,
        reason: 'remote-report-url-set',
        detail: {
          message:
            'SPO_REMOTE_REPORT_URL is set in this process\'s own environment. A dispatcher-driver scenario spawns a real scanner process that inherits it, and remote-report-pull.js\'s own first pull runs unconditionally on scanner startup, regardless of remoteReportPullMs -- see this file\'s own comment at this call site. Unset it before running a dispatcher-driver scenario, or pass --force after confirming by hand that a real pull+ack against ~/.spo-reports is acceptable.',
        },
      };
    }
    return runDispatcherScenario(scenario, config, plan, opts, deps);
  }
  return runInlineScenario(scenario, config, plan, opts, deps);
}

// runInlineScenario -- the ORIGINAL runRecette body (action 2.9), moved here verbatim (same
// makeCap-wrapped deps.spawnSync, same drainQueueOnce, same single-task result shape) so
// trivial-doc-log's own behaviour and every existing test asserting on it stay byte-for-byte
// unchanged. `plan` is now a parameter (computed once, in runRecette above, shared with the
// dry-run/refusal checks) rather than recomputed here -- the only structural difference from the
// pre-7.2 body, and not an observable one (buildPlan is pure).
async function runInlineScenario(scenario, config, plan, opts, deps) {
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
    // scenario.targetFile(0) -- the inline driver only ever runs a single, index-0 card. See
    // 'implement-touched-only-the-recette-doc's own comment for why this is threaded explicitly
    // rather than left to that check's RECETTE_DOC_FILE default.
    const expectedFile = scenario.targetFile ? scenario.targetFile(0) : undefined;
    assertions = evaluateAssertions(scenario, { events, finalState, capTripped: cap.tripped(), expectedFile });
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
    driver: 'inline',
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

// ---------------------------------------------------------------------------------------------
// Dispatcher driver (action 7.2) -- the out-of-process cap, and the runner that uses it.
// ---------------------------------------------------------------------------------------------

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// sumLlmSteps(journalRoot, taskIds) -- the out-of-process equivalent of makeCap's own `llmSteps`
// counter. Sums 'llm-call' events (steps/llm.js's own appendEvent, real attempts only -- a
// dry-run event never counts, matching makeCap's own `command === 'claude'` count exactly) across
// every taskDir this run owns. Re-reads from disk on every call -- cheap (a handful of small
// files, K bounded by the account pool) and the ONLY way to observe what a separate OS process
// just wrote, since nothing here can be handed an in-process counter the way makeCap's wrapped
// deps.spawnSync is.
function sumLlmSteps(journalRoot, taskIds) {
  let total = 0;
  for (const id of taskIds) {
    total += readJournalEvents(journalRoot, id).filter((e) => e && e.event === 'llm-call').length;
  }
  return total;
}

function allTasksTerminal(journalRoot, taskIds) {
  return taskIds.every((id) => {
    const s = readStateSafe(journalRoot, id);
    return !!s && (s.state === 'DONE' || s.state === 'PARKED' || s.state === 'ABANDONED');
  });
}

// runDispatcherCapWatchdog -- the out-of-process cap for driver:'dispatcher'. See this file's own
// "ACTION 7.2" header paragraph for why this cannot be makeCap's own wrapped-spawnSync trick: the
// workers this cap has to bound are separate OS processes, spawned by createDispatcher itself, not
// calls this process makes. So the shape here is necessarily different from makeCap's, and
// honestly weaker in one respect, stated plainly rather than implied: makeCap refuses the
// (capLlmSteps+1)th `claude` spawn BEFORE it happens; this watchdog can only notice AFTER an
// llm-call event lands on disk and then make sure NO FURTHER one follows, by killing every live
// child the instant either bound is crossed. Same two trip reasons
// ('wall-clock-cap-exceeded'/'llm-step-cap-exceeded'), same {reason, ...detail} shape, checked in
// the same order (wall clock first) as makeCap's own wrapSpawnSync.
//
// Resolves WITHOUT tripping the moment every id in `taskIds` reaches a terminal state -- this is
// what lets a k>1 scenario's own dispatcher run stop on its own once its work is actually done,
// since createDispatcher's own run() never returns on its own (state-machine.js's runForever
// inside the scanner is `for (;;)`, and the dispatcher's own main loop only ever exits via
// stop()/the circuit breaker -- see dispatcher.js's own header). Either way this function is the
// ONLY caller of `dispatcher.stop()` on the happy path, so it always calls exactly one of "tripped,
// kill everything" or "done, stop cleanly" -- never both, never neither.
//
// `mono` (default the real monotonicNowMs) and `pollMs` (default 100) are TEST-ONLY injection
// points -- production passes neither. Never Date.now(): see monotonic-clock.js's own header and
// this file's own top-of-file comment on the require.
//
// `isAborted` (default: never aborted) -- POST-VERIFICATION CORRECTION. `runDispatcherScenario`
// used to race this function against `dispatcher.run()` with a bare `Promise.all`, which left
// whichever one lost dangling: if `run()` rejected (a bug -- never an expected outcome), this
// loop kept polling for up to `capMs` (45 minutes by default) with nothing left to coordinate
// with, and `dispatcher.stop()` was never called; if THIS function threw instead, `run()`'s own
// `for (;;)` never returns on its own, so the caller's `await` never resolved and the process
// could not exit either way. `isAborted` is the caller's own escape hatch: polled once per
// iteration (same cadence as everything else here), so a caller whose OWN `run()` promise
// rejected can flip it and let this loop stop within one `pollMs` tick instead of running out the
// clock.
async function runDispatcherCapWatchdog({
  dispatcher,
  journalRoot,
  taskIds,
  capMs,
  capLlmSteps,
  mono = monotonicNowMs,
  pollMs = 100,
  isAborted = () => false,
}) {
  const startedAt = mono();
  let tripped = null;
  let llmSteps = 0;

  for (;;) {
    if (isAborted()) break; // the caller's own dispatcher.run() already ended abnormally -- nothing left to watch

    const elapsedMs = mono() - startedAt;
    llmSteps = sumLlmSteps(journalRoot, taskIds);

    if (elapsedMs > capMs) {
      tripped = { reason: 'wall-clock-cap-exceeded', elapsedMs, capMs };
      break;
    }
    // STRICTLY GREATER, matching the inline cap's own permitted-call count (post-verification
    // correction: this used to be `>=`, which tripped the INSTANT the journal showed exactly
    // capLlmSteps calls -- killing a run that had used its full, legitimate budget and needed no
    // further call at all. makeCap's own wrapSpawnSync permits exactly capLlmSteps calls (refuses
    // only the (capLlmSteps+1)th, `llmSteps + 1 > config.capLlmSteps`); this watchdog is
    // necessarily POST-HOC (see this function's own header: it can only notice a call AFTER it
    // landed on disk, never refuse it beforehand) -- so the honest equivalent is "trip once a
    // (capLlmSteps+1)th call has ALREADY happened", i.e. `llmSteps > capLlmSteps`, not "trip the
    // moment the legitimate capLlmSteps-th one lands". A run using exactly capLlmSteps calls and
    // finishing on its own is therefore never wrongly killed by either driver.
    if (llmSteps > capLlmSteps) {
      tripped = { reason: 'llm-step-cap-exceeded', llmSteps, capLlmSteps };
      break;
    }
    if (allTasksTerminal(journalRoot, taskIds)) break;

    await sleepMs(pollMs);
  }

  if (tripped) {
    dispatcher.stop({ ...tripped });
    dispatcher.killAllChildren('SIGTERM');
  } else {
    // Reached either by every task going terminal (the ordinary happy path) or by isAborted()
    // (the caller's own run() already ended abnormally) -- both are "nothing left for THIS
    // function to trip over", so no kill here either way: a clean finish has nothing left
    // running to kill, and the abort case is exactly what `runDispatcherScenario`'s own
    // `finally` (a SEPARATE, unconditional teardown call -- see that function's own comment) is
    // for, so this function does not need to duplicate it. The caller's own `runError` (set from
    // whatever made run() reject) is what actually surfaces the abort case.
    dispatcher.stop({ reason: 'recette-scenario-complete' });
  }

  return { tripped, elapsedMs: mono() - startedAt, llmSteps };
}

// The reason strings THIS function itself can hand to dispatcher.stop() -- via the watchdog's own
// trip/complete calls, or the outer finally's own teardown call. Anything else `dispatcher.run()`
// resolves with means the dispatcher's OWN circuit breaker (worker-crash or scanner-crash) won
// the race and stopped it first -- see runDispatcherScenario's own A1 fix comment.
const RECETTE_OWN_STOP_REASONS = new Set([
  'llm-step-cap-exceeded',
  'wall-clock-cap-exceeded',
  'recette-scenario-complete',
  'recette-scenario-teardown',
]);

// computeDispatcherOk -- the dispatcher driver's own overall-`ok` decision, pulled out as a pure,
// standalone function (post-verification correction) specifically so each of its terms can
// be pinned by its own direct unit test: dropping `capTripped` or `crossTaskAssertions.ok` from
// this expression survived the full suite under the old inline version, because the only test
// exercising a dispatcher-driven `result.ok` used a fixture where `perTaskOk` was ALREADY false
// for an unrelated reason, making the other terms invisible to that one test. A pure function
// with its own fixtures closes that gap directly, independent of how hard an end-to-end run is to
// steer into isolating any ONE term (capTripped and "every task reached DONE" are close to
// mutually exclusive by construction -- a trip kills children before they finish).
//
// `dispatcherStopReason` (A1 fix) is the SAME shape of term as capTripped -- truthy means "this
// run did not complete on its own terms" -- but reported and gated SEPARATELY, never folded into
// capTripped: a circuit-breaker trip is not a cap, and computing `ok` the same way while
// REPORTING it under the wrong name would still leave a maintainer looking for the wrong cause.
function computeDispatcherOk({ runError, capTripped, dispatcherStopReason, perTaskOk, crossTaskAssertions }) {
  return !runError && !capTripped && !dispatcherStopReason && perTaskOk && (!crossTaskAssertions || crossTaskAssertions.ok);
}

// runDispatcherScenario -- the driver:'dispatcher' counterpart to runInlineScenario. Creates
// `scenario.k` GitHub issues + queue entries (createIssue/enqueueTask, `index` 0..k-1), then hands
// them to the REAL orchestrator/dispatcher.js's createDispatcher -- K real spawned worker
// children, one real spawned scanner, exactly production's own shape -- with three things bolted
// on that production's own daemon.js never needs: every scan timer forced to an explicit 0 (see
// below), the out-of-process cap watchdog racing the dispatcher's own run(), and per-task PLUS
// cross-task assertion evaluation once both finish.
async function runDispatcherScenario(scenario, config, plan, opts, deps) {
  const k = Math.max(1, Number(scenario.k) || 1);
  const monoFn = deps.monotonicNowMs || monotonicNowMs;
  const createDispatcherFn = deps.createDispatcher || createDispatcher;

  fs.mkdirSync(config.journalRoot, { recursive: true });
  fs.mkdirSync(config.queueDir, { recursive: true });

  // NOTE: unlike the inline driver, there is no makeCap-wrapped deps.spawnSync here for the
  // CHILD workers' own real git/gh/claude calls -- a wrapped function cannot cross a process
  // boundary (see this file's own "ACTION 7.2" header). `deps` still reaches createIssue's own
  // in-process `gh issue create` calls unwrapped -- those run in THIS process, same as always.
  const tasks = [];
  let runError = null;

  try {
    for (let i = 0; i < k; i++) {
      const issue = createIssue(scenario, config, deps, i);
      // Pushed IMMEDIATELY after createIssue succeeds -- post-verification correction. The
      // original shape pushed only after enqueueTask ALSO succeeded, so a real GitHub issue
      // created by createIssue (an actual `gh issue create` against the product repo) was
      // silently stranded -- never closed by cleanup -- if enqueueTask threw for that SAME card
      // (a queueDir write failure, say). `taskId: null` until enqueueTask fills it in just below;
      // every downstream reader of `tasks` (the per-task state-read loop, taskResults,
      // cleanupMultiTask) already has to tolerate "this task never produced a taskId" for the
      // symmetric case of createIssue itself throwing on card 2 while card 1 is already
      // enqueued -- see those call sites' own null-guards.
      // `index: i` carried on the entry (not re-derived later) so the per-task assertion loop
      // below can ask scenario.targetFile(t.index) for THIS task's own file -- the same `i` that
      // was handed to createIssue/buildCard for this exact card, never a re-guessed position.
      const entry = { issueNumber: issue.issueNumber, issueUrl: issue.url, taskId: null, index: i };
      tasks.push(entry);
      // opts.taskOverrides may be a plain object (applied identically to every task -- the only
      // shape this ever had before) OR a function of `index` (TEST-ONLY, same seam as
      // buildCard's own `index` parameter) -- needed so a hermetic shadow-mode test can hand each
      // task ITS OWN shadow IMPLEMENT payload (files_changed matching THIS task's own
      // scenario.targetFile(i), not a single shared literal) now that a k>1 scenario's cards no
      // longer share one target file. Never reachable from `spo recette`'s own CLI surface --
      // `opts.taskOverrides` has no flag wiring in bin/spo, only runRecette's own callers reach it.
      const taskOverrides = typeof opts.taskOverrides === 'function' ? opts.taskOverrides(i) : opts.taskOverrides || {};
      const task = enqueueTask(config, issue, i, taskOverrides);
      entry.taskId = task.id;
    }
  } catch (err) {
    runError = err;
  }

  // The JS config object handed to createDispatcher. `workers`/`shadowMode`/`dryRun`/
  // `stepDeadlineMs` ARE what this process's own createDispatcher reads (resolveWorkerCount,
  // buildWorkerArgv's mode flag, spawnOne). The six scan-timer fields below are NOT load-bearing
  // for safety -- kept at explicit 0 purely as documentation of intent for a reader of this
  // object, since the scanner (a SEPARATE OS process) never reads this object at all. THE REAL
  // MECHANISM is the env-var forwarding just below, around the dispatcher's own run() -- see the
  // "Scanner timer forwarding" section near the top of this file for what and why, and this
  // scenario's own 'scan-timers-disabled' assertion for how that gets verified. (Post-verification
  // correction: an earlier version of this comment claimed these six fields WERE the enforcement,
  // which was true of the object and false of what the scanner ever saw.)
  const dispatcherConfig = {
    ...config,
    deps: { ...deps, monotonicNowMs: monoFn },
    workers: k,
    orphanScanMs: 0,
    unparkScanMs: 0,
    autoPullMs: 0,
    autoIntakeMs: 0,
    reportConfirmScanMs: 0,
    autoTriageMs: 0,
  };

  let capTripped = null;
  let elapsedMs = 0;
  let llmSteps = 0;
  let scannerEnvOverrides = null;
  // A1 fix: the dispatcher's OWN circuit breaker stopReason, when it wins the race against this
  // run's own watchdog/teardown -- see the try block below for the full mechanism. null on every
  // ordinary path (ok, capped, or errored the ways this function already reported).
  let dispatcherStopReason = null;

  if (!runError) {
    const dispatcher = createDispatcherFn(config.queueDir, config.journalRoot, dispatcherConfig);
    const taskIds = tasks.map((t) => t.taskId);

    // THE ACTUAL enforcement for the scanner's own seven timers (see SCANNER_TIMER_ENV_VARS'
    // own header). Held on THIS process's process.env for the WHOLE span `dispatcher.run()` is
    // in flight -- not merely the one synchronous tick spawnScanner() runs in -- so that even a
    // scanner that crashes and gets RESPAWNED mid-run (dispatcher.js's handleScannerExit calls
    // spawnScanner() again, asynchronously, from its own exit handler) still inherits the same
    // "0" overrides as the first spawn. Restored in the `finally` below regardless of how this
    // span ends. Workers spawned during the same span inherit these too (buildWorkerArgv never
    // reads them, so this is harmless for them) -- nothing else in this process reads these
    // SPO_*_MS env vars for anything else, so holding them at "0" here cannot affect anything
    // other than what a freshly-spawned child resolves via its own `require('./config')`.
    //
    // POST-VERIFICATION FIX (cross-action sweep, A2) -- the IDENTICAL class of bug, for
    // SPO_ACCOUNTS_DIR: bin/spo's `--accounts-dir` reaches `config.claudeAccountsDir` in THIS
    // process (used by fillSlots/accounts.countHealthyAccounts to clamp K against the intended
    // pool), but buildWorkerArgv/buildScannerArgv forward NO accounts-dir flag or env override of
    // their own -- every spawned worker AND the scanner resolve their OWN config.claudeAccountsDir
    // fresh via `require('./config')`, which reads `process.env.SPO_ACCOUNTS_DIR` (falling back
    // to the real ~/.claude-accounts if unset). Without this, `spo recette --scenario
    // parallel-doc-log --accounts-dir /tmp/pool` clamps K against /tmp/pool in the parent while
    // every child leases/markLimit's the REAL pool -- and if that real pool is empty or
    // misconfigured, `daemon.js --worker`/`--scanner` refuse to start (exit 1) in every child,
    // which is precisely the crash-loop shape that trips the circuit breaker A1 exists to report
    // correctly. Same mechanism, same lifecycle, same restore -- forwarded alongside the seven
    // scan timers in ONE combined save/restore loop.
    const dispatcherEnvOverrideValues = { ...SCANNER_TIMER_ENV_VARS_ZEROED, SPO_ACCOUNTS_DIR: config.claudeAccountsDir };
    scannerEnvOverrides = {};
    const savedScannerEnv = {};
    for (const [key, value] of Object.entries(dispatcherEnvOverrideValues)) {
      savedScannerEnv[key] = process.env[key];
      process.env[key] = value;
      scannerEnvOverrides[key] = value;
    }

    // `dispatcher.run()` is called INSIDE this try (post-verification correction) -- the real
    // createDispatcher's own `run` is an async function and can therefore never throw
    // SYNCHRONOUSLY to its caller (any error becomes a rejected promise, per ordinary JS async-
    // function semantics), but `deps.createDispatcher` is a TEST-ONLY injection seam a test
    // double can hand back anything, including a plain `run: () => { throw ... }` that DOES throw
    // synchronously. Calling it here, inside the try, is what makes "the env vars are restored
    // and the dispatcher is torn down regardless of how this span ends" (the finally's own claim)
    // actually true for every caller of this function, not just the real one.
    let aborted = false;
    try {
      const runPromise = dispatcher.run();
      // THE mechanism that stops the watchdog from polling for up to capMs when run() rejects
      // (a bug, never an expected outcome) is `isAborted` below, checked once per poll tick --
      // NOT Promise.allSettled by itself. Proven directly: reverting ONLY Promise.allSettled to
      // Promise.all while leaving isAborted wired still passes the full suite, because the
      // watchdog notices the abort flag on its own very next tick regardless of which Promise
      // combinator the CALLER used to wait for it. Promise.allSettled's own, separate job is
      // ensuring this function does not RETURN while the watchdog is still mid-poll in the
      // background (Promise.all fails fast on the first rejection, so a bare Promise.all can let
      // this function return before the watchdog's own belated dispatcher.stop() call lands,
      // which is a real but much smaller gap than the capMs-scale one isAborted closes) -- see
      // this file's own test suite for a fixture that isolates each half.
      //
      // POST-VERIFICATION FIX (cross-action sweep, A1): `dispatcher.run()` RESOLVES with its own
      // `stopReason` when the CIRCUIT BREAKER trips (worker-crash or scanner-crash) -- it never
      // rejects for that (dispatcher.js's own run(): `killAllChildren('SIGTERM'); await
      // Promise.allSettled(pending); return stopReason`). A plain `.catch()` therefore never sees
      // a breaker trip at all, so `aborted` stayed false, and the watchdog had no way to learn
      // the dispatcher had already stopped ITSELF -- it just kept polling. Worse, a worker killed
      // during that shutdown is DELIBERATELY never reparked (dispatcher.js's own handleExit
      // comment: "NOT reparking here is strictly safer"), so state.json stays non-terminal
      // forever and allTasksTerminal() never becomes true either -- the watchdog's only remaining
      // exit was capMs itself (45 minutes by default), reporting the misleading
      // 'wall-clock-cap-exceeded' for a run that actually died to its own circuit breaker in
      // seconds. `.then()` (not just `.catch()`) now flips `aborted` on ANY resolution, breaker
      // trip included, so the watchdog notices within one poll tick either way.
      runPromise.then(() => {
        aborted = true;
      }, () => {
        aborted = true;
      });

      const [runOutcome, watchOutcome] = await Promise.allSettled([
        runPromise,
        runDispatcherCapWatchdog({
          dispatcher,
          journalRoot: config.journalRoot,
          taskIds,
          capMs: config.capMs,
          capLlmSteps: config.capLlmSteps,
          mono: monoFn,
          pollMs: deps.dispatcherPollMs || 100,
          isAborted: () => aborted,
        }),
      ]);
      if (runOutcome.status === 'rejected') throw runOutcome.reason;
      if (watchOutcome.status === 'rejected') throw watchOutcome.reason;
      capTripped = watchOutcome.value.tripped;
      elapsedMs = watchOutcome.value.elapsedMs;
      llmSteps = watchOutcome.value.llmSteps;
      // The dispatcher's OWN stopReason -- read regardless of whether it happened to match
      // allTasksTerminal/capMs timing (Promise.allSettled waits for BOTH promises, so this is
      // captured correctly whichever one "wins" the underlying race; see the two branches this
      // fix's own header names). Anything OTHER than a reason THIS function itself could have
      // produced (RECETTE_OWN_STOP_REASONS, below) means the dispatcher's own circuit breaker
      // won the race and stopped it before this run's own watchdog/teardown ever called stop() --
      // surfaced as its OWN distinct verdict, never folded into capTripped (a breaker trip is not
      // a cap, and reporting it as one would send a maintainer looking at the wrong number).
      const dispatcherStop = runOutcome.value;
      if (dispatcherStop && !RECETTE_OWN_STOP_REASONS.has(dispatcherStop.reason)) {
        dispatcherStopReason = dispatcherStop;
      }
    } catch (err) {
      runError = err;
    } finally {
      // Belt-and-braces teardown (post-verification correction): idempotent, safe even on the
      // ordinary path where the watchdog already called both itself -- guarantees no live child
      // is left running and no further scan cycle can fire regardless of which promise above
      // misbehaved. See dispatcher.js's own stop()/killAllChildren() headers for why repeat calls
      // are safe.
      dispatcher.stop({ reason: 'recette-scenario-teardown' });
      dispatcher.killAllChildren('SIGTERM');
      for (const key of Object.keys(dispatcherEnvOverrideValues)) {
        if (savedScannerEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedScannerEnv[key];
      }
    }
  }

  for (const t of tasks) {
    // t.taskId is null for a stranded task (createIssue succeeded, enqueueTask then threw for
    // that SAME card -- see this function's own per-task loop above) -- explicit guard rather
    // than relying on readStateSafe/readJournalEvents' own try/catch to swallow the TypeError
    // path.join(..., null, ...) would throw; both already tolerate it, but not by design.
    const state = t.taskId ? readStateSafe(config.journalRoot, t.taskId) : null;
    t.finalState = state ? state.state : null;
    t.prNumber = (state && state.prNumber) || null;
    t.events = t.taskId ? readJournalEvents(config.journalRoot, t.taskId) : [];
  }

  const daemonEvents = readDaemonEvents(config.journalRoot);

  let perTaskOk = true;
  const taskResults = tasks.map((t) => {
    let assertions = null;
    if (!runError && t.finalState) {
      // scenario.targetFile(t.index) -- THIS task's own file, not a shared constant. For
      // parallel-doc-log this is what lets 'implement-touched-only-the-recette-doc' catch a card
      // that wrote its SIBLING's own valid recette file, a distinct failure from writing src/
      // (see that assertion's own comment).
      const expectedFile = scenario.targetFile ? scenario.targetFile(t.index) : undefined;
      assertions = evaluateAssertions(scenario, { events: t.events, finalState: t.finalState, capTripped, expectedFile });
    }
    if (!assertions || !assertions.ok) perTaskOk = false;
    return {
      issueNumber: t.issueNumber,
      issueUrl: t.issueUrl,
      taskId: t.taskId,
      finalState: t.finalState,
      prNumber: t.prNumber,
      assertions,
    };
  });

  let crossTaskAssertions = null;
  if (!runError && scenario.crossTaskAssertions && scenario.crossTaskAssertions.length) {
    crossTaskAssertions = evaluateCrossTaskAssertions(scenario, {
      tasks: tasks.map((t) => ({ taskId: t.taskId, events: t.events, finalState: t.finalState })),
      daemonEvents,
      dispatcherConfig,
      scannerEnvOverrides,
      capTripped,
    });
  }

  const ok = computeDispatcherOk({ runError, capTripped, dispatcherStopReason, perTaskOk, crossTaskAssertions });

  let cleanupReport = null;
  if (!opts.keep) {
    cleanupReport = cleanupMultiTask({
      scenario,
      config,
      deps,
      tasks: tasks.map((t) => ({ issueNumber: t.issueNumber, prNumber: t.prNumber, wipRefs: wipRefsFrom(t.events) })),
      keepRunDir: !ok,
    });
  }

  return {
    ok,
    plan,
    scenario: scenario.name,
    driver: 'dispatcher',
    k,
    runId: config.runId,
    tasks: taskResults,
    crossTaskAssertions,
    capTripped,
    // A1 fix: the dispatcher's OWN circuit breaker stopReason (worker-crash-circuit-breaker /
    // scanner-crash-circuit-breaker), when it wins the race against this run's own watchdog --
    // null on every ordinary path. Distinct from capTripped on purpose -- see computeDispatcherOk's
    // own comment for why folding the two together would misreport the cause.
    dispatcherStopReason,
    elapsedMs,
    llmSteps,
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
  evaluateCrossTaskAssertions,
  cleanup,
  cleanupMultiTask,
  wipRefsFrom,
  createIssue,
  enqueueTask,
  taskIdFor,
  branchFor,
  worktreePathFor,
  readStateSafe,
  readJournalEvents,
  readDaemonEvents,
  sumLlmSteps,
  allTasksTerminal,
  runDispatcherCapWatchdog,
  computeDispatcherOk,
  SCANNER_TIMER_ENV_VARS,
  resolveScannerTimersUnderEnv,
  runInlineScenario,
  runDispatcherScenario,
  runRecette,
  RecetteRefusedError,
  RecetteCapExceededError,
  RecetteError,
  RECETTE_LABEL,
  RECETTE_DOC_FILE,
};
