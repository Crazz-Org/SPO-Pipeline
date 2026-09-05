'use strict';
// The engine: the lifecycle table from doc/state-machine-spec.md v1.1, one handler per state,
// a queue drain loop, and the journal/ledger/state.json/report.md bookkeeping around it.
//
// Lifecycle (spec v1.1):
//   INTAKE -> WORKTREE -> PLAN -> IMPLEMENT -> CHECK -> PUSH_PR -> GATE -> CI_CHECKS ->
//   VALIDATE -> MERGE -> FINISH -> DONE
//   IMPLEMENT/CHECK/GATE(1)/CI_CHECKS(unmatched check) -> DIAGNOSE -> IMPLEMENT (retry)
//   any state -> PARKED (catch-all: report + stop; PARKED is terminal for the daemon)
//
// Contract each handler follows: `async (ctx) => nextStateString`, or `throw new
// ParkSignal(reason, detail)` to end the task at PARKED. A handler must never return a state
// name that departs from the table above -- the only place unknown-state routing happens is
// the outer loop's `HANDLERS[state]` lookup, which is also how a fixture-injected bogus state
// (task.shadow.forceState) exercises the catch-all in tests.
//
// A handler-internal JavaScript bug (as opposed to a recognized bad state/exit/verdict, which
// is always an explicit ParkSignal) is deliberately NOT caught here -- it propagates and fails
// the daemon run loudly. The spec's catch-all is about states/exits/outputs the *task* can
// produce, not about hiding programming errors in this engine.

const fs = require('fs');
const path = require('path');

const {
  appendEvent,
  appendDaemonEvent,
  appendLedgerLine,
  writeState,
  writeReport,
  readLiveWorkerIds,
} = require('./journal');
const { scratchDir, lastResultPayload, lastJournaledCitations } = require('./task-values');
const { buildBaseline } = require('./invariants');
const { makeFixtureReader } = require('./fixture');
const { ParkSignal } = require('./park-signal');
const { detectProtectedFiles, PROTECTED_MATCH_CAP, PROTECTED_LINE_MAX_LENGTH } = require('./intake');
const { LockLostError } = require('./lock');
const { callWithDeadline } = require('./deadline');
const {
  runScripted,
  sleep,
  spawnStep,
  realWorktree,
  realCheck,
  realPushPr,
  realGate,
  realCiChecks,
  realMerge,
  realFinish,
  preserveWorktreeWip,
  prepareJudgeInputs,
} = require('./steps/scripted');
const { runLlm } = require('./steps/llm');
const { classifyCiFailure } = require('./ci-cause-table');
const { resolveMainMovedRegateBudget } = require('./main-moved-budget');
const accounts = require('./accounts');
const { leaseHealthyAccount } = require('./account-lease');
const { moveCard } = require('./board');
const {
  postParkComment,
  postDiagnoseSurfaceComment,
  normalizeFindingsPayload,
  postValidateFindingsComment,
  unparkScan,
  shouldScanUnpark,
  countRepeatedParks,
  readJournalLines,
  reEnqueueTask,
} = require('./park-loop');
const { createScanState } = require('./comment-scan');
const { shouldScanOrphans, orphanScan } = require('./orphan-scan');
const { alertPark } = require('./park-alert');
const { shouldAutoPull, runAutoPull } = require('./auto-pull');
const { shouldAutoTriage, runAutoTriage } = require('./auto-triage');
const { shouldAutoIntake, shouldScanConfirms, runReportIntake, reportConfirmScan } = require('./report-intake');
const { startRemoteReportPullLoop } = require('./remote-report-pull');

// True once neither shadow fixtures nor --dry-run's fixture-free stand-ins apply -- the only
// condition under which a scripted step's handler dispatches to steps/scripted.js's real
// per-state functions (realWorktree, realCheck, ...), which spawn actual git/npm/gh commands.
// Reachable today only via daemon.js's --real flag (see handleIntake's own gate on
// kind: "card" tasks) or a direct unit test constructing ctx by hand.
function isRealMode(ctx) {
  return !ctx.shadowMode && !ctx.dryRun;
}

// ---- LLM step invocation, with account rotation in real mode --------------------------------
//
// Shadow mode: identical to calling callWithDeadline(ctx, stepName, () => runLlm(...)) directly
// -- every existing shadow-mode test asserts on the exact journal/state.json shape that produces,
// so this branch must stay byte-for-byte what it replaces.
//
// Real mode: one pass over the healthy accounts, per state-machine-spec.md § Account pool ("a
// limit error ... puts the account in cooldown ... and the step retries on the next healthy
// account"). Each attempt now goes through account-lease.js's leaseHealthyAccount instead of a
// bare accounts.pick() (action 6.2): it picks a healthy account NOT currently leased by another
// live process (this daemon's own worker, or the dispatcher's intake.js scan timers, both draw
// from the same pool -- see account-lease.js's own header for why per-step leasing beats
// per-task), leases it for the duration of this one call, and releases it in the `finally` below
// whether the call succeeds, limits, or throws. When a call comes back {kind: 'limit'}, this cools
// that account down (accounts.markLimit, journaled as 'account-cooldown') and asks for the next
// one. The loop is bounded to the number of enabled accounts in the registry, so a step can never
// retry the same account twice for a COOLDOWN or spin forever: once every account has been tried,
// or leasing itself finds nothing usable, the task is PARKED -- the spec's "then PARKED" for this
// path, now with three distinct reasons instead of two:
//   - AllAccountsCoolingError -- every enabled account is cooling. Never waited on (see
//     account-lease.js) -- parked immediately, same as before this action.
//   - AllAccountsLeasedError -- every HEALTHY account is leased by another live process.
//     leaseHealthyAccount already waited up to config.accountLeaseWaitMs for one to free up
//     before throwing this -- so by the time it's caught here, the wait is already spent.
//   - NoAccountsRegisteredError -- the pool has zero subdirectories at all. daemon.js additionally
//     refuses to even START in --real mode on this one.
async function callLlmStep(ctx, stepName, fixtureKey, deps = {}) {
  if (ctx.shadowMode) {
    return callWithDeadline(ctx, stepName, () => runLlm(ctx, stepName, fixtureKey, deps));
  }

  const accountsDir = ctx.config.claudeAccountsDir;
  const maxAttempts = Math.max(accounts.readRegistry(accountsDir).filter((a) => a.enabled).length, 1);

  let result;
  // R6 (F3): with maxAttempts === pool size, exhausting every account inside this loop exits
  // WITHOUT re-calling pick() -- so the maintainer never sees pick()'s own good
  // `all-accounts-cooling-until-<ISO>` reason on the park below, only {attempts, lastResult}.
  // That named a real wall-clock time back when cooldowns were flat; now that R1 makes cooldown
  // duration escalate per-account, it says nothing at all. Carry the last cooldown event's own
  // cooldownUntilIso through instead, so the park always names when to retry.
  let lastCooldownUntilIso = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let leased;
    try {
      leased = await leaseHealthyAccount(accountsDir, {
        waitMs: ctx.config.accountLeaseWaitMs,
        pollMs: ctx.config.accountLeasePollMs,
        sleep: deps.leaseSleep,
        now: deps.leaseNow,
        isAlive: deps.leaseIsAlive,
      });
    } catch (err) {
      if (
        err instanceof accounts.AllAccountsCoolingError ||
        err instanceof accounts.NoAccountsRegisteredError ||
        err instanceof accounts.AllAccountsLeasedError
      ) {
        throw new ParkSignal(err.reason, err.detail);
      }
      throw err;
    }

    ctx.account = leased.account;
    try {
      result = await callWithDeadline(ctx, stepName, () => runLlm(ctx, stepName, fixtureKey, deps));
    } finally {
      // Release the lease the instant this ONE call is done, success or throw -- a per-step
      // lease held any longer than the call it guards would start re-creating the per-task
      // contention this action exists to avoid.
      leased.release();
    }

    if (!(result && result.ok === false && result.kind === 'limit')) {
      return result;
    }

    const event = accounts.markLimit(accountsDir, leased.account.name, result.limitKind);
    lastCooldownUntilIso = event.cooldownUntilIso;
    appendEvent(ctx.taskDir, stepName, 'account-cooldown', event);
  }

  throw new ParkSignal('all-accounts-cooling-after-retry', {
    attempts: maxAttempts,
    lastResult: result,
    cooldownUntilIso: lastCooldownUntilIso,
  });
}

// ---- per-state handlers ----------------------------------------------------------------

async function handleIntake(ctx) {
  if (!ctx.task || ctx.task.__invalid) {
    throw new ParkSignal('invalid-task-json', { rawPreview: ctx.task && ctx.task.rawPreview });
  }
  if (ctx.task.shadow && ctx.task.shadow.forceState) {
    const to = ctx.task.shadow.forceState;
    appendEvent(ctx.taskDir, 'INTAKE', 'force-state', { to });
    return to;
  }
  // A kind: "card" task reaching real execution (neither --shadow nor --dry-run) needs the
  // driver to have explicitly opted in with daemon.js's --real flag -- real scripted steps spawn
  // actual git/npm/gh commands against the product repo. Checked here, not just at the CLI, so
  // any caller that builds ctx.config by hand (a future scheduler, a test) gets the same refusal
  // rather than a card silently running for real.
  if (ctx.task.kind === 'card' && isRealMode(ctx) && !(ctx.config && ctx.config.real)) {
    throw new ParkSignal('real-flag-required', { kind: ctx.task.kind });
  }
  // Action 3.2, site 1 -- REMOVED 2026-09-05 (#118), and this comment is the record of why.
  //
  // A kind:"card" task's own criterion and title used to be scanned here for a protected-file
  // mention, parking the card at zero cost before PLAN ever ran. That scan was PROSE, and prose
  // cannot tell "my criterion EDITS this file" from "my criterion CITES this file" -- the exact
  // structural argument that had already retired the plan_markdown scan at site 2 (33% precision,
  // 2 false positives against 1 true positive across all 17 real plans) was never applied to this
  // site, which reads text of the same kind from the same kind of author.
  //
  // Measured over the whole journal corpus: this site fired EXACTLY ONCE, on 2026-09-04, on
  // Crazz-Org/SPO-WebClient#482 -- the card written to repair the very guard below, whose
  // acceptance criterion quotes '.claude/settings.json' and '.claude/hooks/*.sh' as the examples
  // of what a working guard must catch. One firing, one false positive, zero true positives, and
  // the card it refused was the fix. The header's own defence ("free insurance with no measured
  // false-positive risk") was written before there was any measurement; there is now, and it says
  // the opposite.
  //
  // What is given up: the rare card whose human-written criterion really does name a protected
  // path now costs one PLAN call before parking, instead of parking free at INTAKE. What is kept:
  // the signal that is actually machine-readable -- PLAN's own files_to_change declaration
  // (guardDeclaredFiles below), documented in prompts/plan.md as the files the plan will CHANGE,
  // never the ones it reads, cites, or asserts the absence of. #118 made that site reachable for
  // the first time, which is what makes dropping this one affordable.
  appendEvent(ctx.taskDir, 'INTAKE', 'ok', { title: ctx.task.title, kind: ctx.task.kind });
  return 'WORKTREE';
}

async function handleWorktree(ctx) {
  // action B3.3: this fixture read is checked BEFORE isRealMode(ctx) is even consulted below,
  // and it can only ever be true off task.shadow.nightlyMainRed -- orchestrator/intake.js's
  // makeTask (the only real-card producer) never writes a `shadow` key, so for a real card this
  // is always false and `main-red-refuse-worktree` cannot fire in real mode. That is deliberate,
  // not a gap: it is the shadow-mode-only sibling of realWorktree's OWN real check further down
  // this file's steps/scripted.js (guardNightlyRed's classifyNightly, reading
  // <spoBenchDir>/nightly/latest.json), which throws ParkSignal('nightly-main-red', ...) on a
  // genuine red main and IS wired to the real signal -- see doc/state-machine-spec.md's WORKTREE
  // row and test/gate-legs-reachability.test.js for both legs firing, each in the one mode it can.
  if (ctx.fixture('nightlyMainRed', false)) {
    throw new ParkSignal('main-red-refuse-worktree', {});
  }
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'WORKTREE', () => realWorktree(ctx, ctx.deps));
  }
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'WORKTREE', () =>
    runScripted(ctx, 'worktree', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'WORKTREE', 'result', { exit, stdoutTail });
  if (exit === 0) {
    // --dry-run's generic runScripted() path (unlike realWorktree) never runs a real `git
    // worktree add`, so it never learns a worktreePath/branch. A real kind: "card" task from
    // spo pull/makeTask carries neither (see orchestrator/intake.js's makeTask), so without this
    // the PLAN prompt template's `worktree` placeholder is left unfilled and the task PARKs at
    // PLAN -- defeating --dry-run as a pre-flight check. Synthesize the same names realWorktree
    // would have picked, but only when a fixture/test hasn't already set one.
    if (ctx.dryRun && !ctx.task.worktreePath) {
      ctx.task.worktreePath = path.join(ctx.config.pipelineWorktreesDir, ctx.id);
      ctx.task.branch = `claude-pipe/${ctx.id}`;
    }
    return 'PLAN';
  }
  throw new ParkSignal('worktree-failed', { exit });
}

// PLAN runs permissionMode: 'plan' (step-contracts.js) -- the harness refuses every Write call,
// so the model cannot write plan-<issue>.md / invariants-<issue>.md itself (confirmed by
// today's real run of card issue-247: plan-mode Write refusals, followed by the model reporting
// paths in its structured output anyway -- files that were never created). PLAN's contract
// (prompts/plan.md, step-contracts.js) now has the model RETURN both documents' full text as
// plan_markdown/invariants_markdown; this handler is the one place that writes them, the same
// division of labour intake.js's draftCard (composes) / fileCard (writes) already uses.
//
// `result === null` means no shadow.llm.PLAN fixture was wired for this task at all (fixture.js
// returns the caller's default) -- the pre-existing "trivially ok, nothing to validate"
// convention this file already used before this fix (see handleImplement below, same idiom) is
// kept unchanged for that case: there is no plan content to validate or write, and plenty of
// tests unrelated to PLAN rely on it. Once a payload actually exists -- a real LLM reply, an
// explicit shadow fixture, or --dry-run's own canned payload (steps/llm.js) -- it is held to the
// real contract.
// Action 3.1: park reasons that indict the PLAN ITSELF, not just this attempt's execution of it
// -- a plan invalid on its face, one that named protected files IMPLEMENT structurally cannot
// touch, IMPLEMENT/DIAGNOSE finding the same root cause a second time (the plan sent it back to
// the identical failure), DIAGNOSE burning its whole budget without ever clearing IMPLEMENT's
// failure, change-validator rejecting the built, gated-green change repeatedly, or (action 4.3)
// CI failing the same way three times running on retries IMPLEMENT could not clear. Reusing the
// plan that produced any of these on a `retry` would spend a whole remediation cycle to arrive at
// the identical park -- worse for the budget-exhaustion pair, since without them reuse -> DIAGNOSE
// burns its budget -> park -> `retry` with `main` unmoved -> identical reuse -> identical cycle,
// bounded only by a human giving up. Every other park reason -- transport failures, gate/CI
// failures, claim losses, merge conflicts -- is orthogonal to whether the plan was right, so it
// does not disqualify reuse.
const PLAN_INVALIDATING_PARK_REASONS = new Set([
  'plan-invalid',
  'plan-requires-protected-files',
  'diagnose-duplicate-root-cause',
  'diagnose-no-new-cause',
  'diagnose-budget-exhausted',
  'validate-reject-budget-exhausted',
  // action 4.3: same shape as the two budget exhaustions above, and added in the same commit that
  // first makes CI_CHECKS -> IMPLEMENT reachable at all (the cause table had been keyed on step
  // names GitHub never sends). A retry that reuses the plan sends the identical implementation
  // back through the identical CI, which fails identically -- three more retries, identical park.
  'ci-retry-budget-exhausted',
]);

// Action 3.1: decides whether handlePlan may skip PLAN's LLM call entirely and reuse the plan
// already on disk from an EARLIER run of this same task -- the case a maintainer's `retry` after
// a park creates: INTAKE restarts the task from scratch, and without this, PLAN re-derives a plan
// that already existed and was correct (measured on the real corpus at ~$24, 36% of PLAN spend --
// see this action's own header in the remediation plan). Reads only journal.jsonl + fs.statSync
// -- no spawning -- so it is directly unit-testable on its own.
//
// Returns `{ planPath, invariantsPath, baseMainSha, previousPayload }` to reuse, or null the
// moment any ONE of the following seven conditions fails -- null always means "run PLAN
// normally, exactly as before this action":
//
//   0. isRealMode(ctx) -- shadow and --dry-run must never reuse, full stop. This used to be true
//      only "by construction" (condition 1 below can never pass without a real realWorktree run),
//      which made it incidental rather than guaranteed: a shadow task.json that happens to carry
//      a baseMainSha field (hand-built fixture, copy-pasted task.json, ...) would reuse anyway.
//      Checked explicitly, first, so the exclusion doc/state-machine-spec.md and
//      orchestrator/README.md both describe as a guarantee actually is one.
//   1. ctx.task.baseMainSha is a non-empty string. Only realWorktree (steps/scripted.js) sets
//      it, so a real task that never reached a fresh WORKTREE run this attempt never has one set
//      either, and so never reaches reuse.
//   2. journal.jsonl holds at least one PLAN 'files-written' event carrying a baseMainSha field
//      (a journal written before this action never has one -- that is the backward-compatibility
//      case, and it must fall through to "run normally", not throw). Take the LAST such event.
//   3. That event's baseMainSha equals ctx.task.baseMainSha -- origin/main has not moved since
//      the plan was written; a mismatch means the plan may no longer fit the tree it targets.
//   4. Both planPath and invariantsPath from that event exist on disk, are regular files, AND are
//      non-empty -- guards a wiped scratch dir, a directory where a file was expected, or a
//      truncated write from being reused as though it were intact. Wrapped so a TOCTOU (the file
//      vanishing between the check and the stat) can never throw out of this function -- see the
//      try/catch below.
//   5. A PLAN 'result' event with a payload exists (task-values.js's lastResultPayload contract),
//      AND that payload is not itself a failure (`ok !== false`) -- IMPLEMENT and VALIDATE read
//      plan_path/invariants_path/invariant_ids/check_commands from exactly this event, and a
//      failure payload (action 1.4's transport-failure branch, `{ok:false, kind:'error'}`) never
//      carries any of them. A run can park on a transport failure (not plan-invalidating) with
//      the LAST PLAN 'result' event still being that failure -- e.g. a run that PLANned fine, then
//      parked downstream, then a later retry re-ran PLAN and hit a transport error, then main was
//      reverted and retried again -- so "a payload exists" alone is not enough; it must be one PLAN
//      actually produced a verdict for.
//   6. The most recent 'parked' event in the journal, if any, has a reason that is NOT one of
//      PLAN_INVALIDATING_PARK_REASONS above.
function decidePlanReuse(ctx) {
  if (!isRealMode(ctx)) return null;

  const baseMainSha = ctx.task && ctx.task.baseMainSha;
  if (typeof baseMainSha !== 'string' || baseMainSha === '') return null;

  const lines = readJournalLines(ctx.taskDir);

  const filesWrittenEvents = lines.filter(
    (e) => e.state === 'PLAN' && e.event === 'files-written' && typeof e.baseMainSha === 'string'
  );
  const lastFilesWritten = filesWrittenEvents[filesWrittenEvents.length - 1];
  if (!lastFilesWritten || lastFilesWritten.baseMainSha !== baseMainSha) return null;

  const { planPath, invariantsPath } = lastFilesWritten;
  if (!planPath || !invariantsPath) return null;
  // Action 3.1 (defect fix): fs.existsSync then fs.statSync is a TOCTOU -- if the file is removed
  // in the gap between the two calls, statSync's ENOENT propagates out of this function, out of
  // handlePlan, past runTask's ParkSignal-only catch, and kills the daemon process entirely. That
  // is strictly worse than the bug this action fixes. One statSync per path, wrapped so ANY error
  // (ENOENT, EACCES, whatever) is just "not reusable", never a crash; isFile() also rejects a
  // planPath/invariantsPath that resolved to a directory, which a bare `.size` check would not
  // have caught (a directory's stat size is non-zero).
  const isNonEmptyFile = (p) => {
    try {
      const st = fs.statSync(p);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  };
  if (!isNonEmptyFile(planPath) || !isNonEmptyFile(invariantsPath)) return null;

  const previousPayload = lastResultPayload(ctx.taskDir, 'PLAN');
  if (!previousPayload || previousPayload.ok === false) return null;

  const lastParked = [...lines].reverse().find((e) => e.event === 'parked');
  if (lastParked && PLAN_INVALIDATING_PARK_REASONS.has(lastParked.reason)) return null;

  return { planPath, invariantsPath, baseMainSha, previousPayload };
}

// Action 3.2, site 2, revised again 2026-09-05 (#118) -- the ONE place PLAN's declared file list
// is normalized, judged and journalled, called from both of handlePlan's paths: a fresh reply, and
// action 3.1's reuse of a plan already on disk.
//
// The shape test used to be `Array.isArray(payload.files_to_change)`, inline, and it never once
// passed. Measured across the whole journal corpus on 2026-09-05: of 151 PLAN 'result' events, 93
// carry files_to_change and every single one of them delivers it as a JSON-ENCODED STRING
// ('["/abs/path", ...]'), 0 as a real array. So the scan sat in an `else if` no live card ever
// reached and action 3.2's guard had never run, on any card, since it was built -- 44 journalled
// `plan-files-undeclared { receivedType: "string" }` events are the fail-open record of it. Nothing
// was lost by luck alone: of 809 declared paths in that corpus, 0 name a protected file (12 name
// `.claude/agents|commands|skills/*`, which detectProtectedFiles deliberately does not match).
//
// This is the same shape park-loop.js's normalizeFindingsPayload was written for when VALIDATE's
// `findings` turned out to arrive the same way, so it is reused here rather than reimplemented:
// exactly one definition of "an array, or a JSON string holding one, or neither".
//
// What counts as a DECLARATION is the array and json-string-of-array shapes only. Everything else
// -- absent, null, an object, a bare unparsable string -- is journalled as 'plan-files-undeclared'
// and proceeds unparked, exactly as before: a reply that fails to declare must never fall back to
// scanning plan_markdown prose (33% precision over 17 real plans -- the measurement that produced
// this site in the first place), and files_to_change stays `optional` in step-contracts.js, since
// promoting it to `required` while this was broken would have turned a silent fail-open into a
// park on every card. An empty list IS a declaration ("this plan changes nothing already on
// record" -- a docs-only or investigation-only plan): declared and clean, no event, no park.
//
// The declared paths arrive ABSOLUTE, under the card's worktree
// ('/home/crazz/SPO-Pipeline/worktrees/issue-473/src/...'), per prompts/plan.md's own contract.
// detectProtectedFiles substring-matches, so an absolute path still trips it -- pinned by a test
// rather than assumed, since it was the trap #118 flagged as unverified.
function guardDeclaredFiles(ctx, rawFilesToChange, provenance) {
  const declared = normalizeFindingsPayload(rawFilesToChange);
  const isList = declared.shape === 'array' || declared.shape === 'json-string';
  const filesToChange = isList ? declared.items : [];
  const allStrings = filesToChange.every((f) => typeof f === 'string');
  if (!isList || !allStrings) {
    appendEvent(ctx.taskDir, 'PLAN', 'plan-files-undeclared', {
      // Unchanged for every shape that could already reach this line -- 'undefined' (absent),
      // 'object' (null or a real object), 'string' (a bare string that is not JSON), and
      // 'array-with-non-string-entry' all still report exactly what they reported before, so the
      // 44 events already on the record stay comparable with the ones written from here on. The
      // one new value is the json-string that parses to something other than a list of strings.
      receivedType: !isList
        ? typeof rawFilesToChange
        : declared.shape === 'array'
          ? 'array-with-non-string-entry'
          : 'json-string-with-non-string-entry',
      // `shape` is normalizeFindingsPayload's own verdict, journalled alongside receivedType
      // rather than instead of it: 'unparsable-string' and 'json-string-object' both report
      // receivedType 'string', and telling them apart is the whole evidence base for the eventual
      // required-key promotion.
      shape: declared.shape,
      // String(...) wraps the JSON.stringify call: a function value (unreachable from the wire,
      // where this payload is always JSON.parse'd, but reachable from a hand-built ctx) makes
      // JSON.stringify return `undefined`, and `undefined.slice` would throw a TypeError that
      // escapes handlePlan past runTask's ParkSignal-only catch and kills the daemon. One
      // character of belt-and-braces against that.
      receivedSample: String(JSON.stringify(rawFilesToChange === undefined ? null : rawFilesToChange)).slice(0, 200),
      ...provenance,
    });
    return;
  }
  if (filesToChange.length === 0) return;
  // D1: detectProtectedFiles already caps matches PER CALL (PROTECTED_MATCH_CAP), but this site
  // flatMaps it across every declared file, so the total is unbounded (N x PROTECTED_MATCH_CAP).
  // declaredFiles below used to be filesToChange verbatim -- the whole array, uncapped in both
  // element count and element length. Both go straight into the park detail, which park-loop.js
  // JSON.stringifies into a GitHub comment body: GitHub caps comment bodies at 65536 chars, and
  // measured pathological inputs blow past that (a single 70000-char entry alone produces a
  // 70375-char detail; ~550 protected entries crosses 65536). When that happens `gh issue
  // comment` exits non-zero, park-loop.js journals park-comment-failed and returns with NO
  // comment posted -- and, per the pre-existing (not fixed here) null-anchor bug in
  // findParkAnchor/unparkScan/comment-scan.js, the card also becomes retry/abandon-able by any
  // historical comment on the issue thread. Cap both the matches (defense in depth -- already
  // capped per-file, this caps the total across all files) and the declared-files list itself,
  // and record the true count separately so a truncated list is never mistaken for the whole
  // one.
  const protectedMatches = filesToChange.flatMap((f) => detectProtectedFiles(f)).slice(0, PROTECTED_MATCH_CAP);
  if (protectedMatches.length > 0) {
    throw new ParkSignal('plan-requires-protected-files', {
      source: 'files_to_change',
      matches: protectedMatches,
      declaredFiles: filesToChange.slice(0, 50).map((f) => f.slice(0, PROTECTED_LINE_MAX_LENGTH)),
      declaredFileCount: filesToChange.length,
      ...provenance,
    });
  }
}

async function handlePlan(ctx) {
  // Action 3.1: a still-valid plan from an earlier run short-circuits everything below, including
  // the LLM call itself -- that IS the point, not an optimization bolted onto a call that still
  // happens. See decidePlanReuse's own header for the seven conditions (0-6).
  const reuse = decidePlanReuse(ctx);
  if (reuse) {
    const { planPath, invariantsPath, baseMainSha, previousPayload } = reuse;
    appendEvent(ctx.taskDir, 'PLAN', 'plan-reused', { planPath, invariantsPath, baseMainSha });
    // Re-journal 'files-written' so every downstream reader that asserts "PLAN wrote its files
    // this run" (notably recette.js's assertion set) still finds one, exactly as the normal path
    // below produces.
    appendEvent(ctx.taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha });

    // #118: the reuse path scans the carried-forward declaration too. A third call site here was
    // deleted when site 2 was first revised, on the argument that a plan tripping site 2 parks
    // 'plan-requires-protected-files', which is plan-invalidating, so a dirty plan could never
    // reach reuse in the first place. That argument held only while site 2 worked -- and site 2
    // has never worked. Every plan written between action 3.2 and this fix passed through an
    // Array.isArray test that rejected its own wire shape, so the corpus holds 93 plans whose
    // declarations were never judged; each is one `retry` away from being reused straight into
    // IMPLEMENT, unscanned. The invariant this restores is the one worth stating: no plan reaches
    // IMPLEMENT without its declared file list having been read at least once. Cost when the
    // declaration is clean: one regex pass over an array already in memory.
    guardDeclaredFiles(ctx, previousPayload.files_to_change, { planPath, invariantsPath, reused: true });

    // The action-1.8 invariants baseline is rebuilt exactly as the normal path does, below --
    // never reused itself. Reuse is a bet on the PLAN TEXT still being right, not on which
    // invariants currently resolve in the tree; CHECK's regression check needs a baseline taken
    // against THIS run's fresh worktree regardless of which path produced the plan it is checking
    // against. The declared-vs-parsed canary compares against invariant_ids from the reused
    // payload, since that is the only declaration this run has.
    if (isRealMode(ctx) && ctx.task.worktreePath) {
      const baseline = buildBaseline(ctx.task.worktreePath, invariantsPath);
      appendEvent(ctx.taskDir, 'PLAN', 'invariants-baseline', baseline);

      const declaredIds = Array.isArray(previousPayload.invariant_ids) ? previousPayload.invariant_ids : [];
      const parsedIds = (baseline.invariants || []).map((inv) => inv.id);
      if (declaredIds.length !== parsedIds.length) {
        appendEvent(ctx.taskDir, 'PLAN', 'invariants-declared-parsed-mismatch', {
          declared: declaredIds.length,
          parsed: parsedIds.length,
          declaredIds,
          parsedIds,
          issues: baseline.issues || [],
        });
      }
    }

    // Action 3.1 (defect fix): stamp plan_path/invariants_path explicitly from `reuse`, rather
    // than trusting previousPayload to already carry them. It usually does (the normal path below
    // journals 'result' a second time, at the very end, with the paths added) -- but the normal
    // path also journals 'result' a FIRST time right after the LLM reply, markdown-only, no paths,
    // with files-written and buildBaseline in between. A daemon SIGTERM in that window (the
    // post-merge hook genuinely causes these) leaves journal.jsonl holding a markdown-only
    // 'result' followed by 'files-written'. orphan-scan.js reparks that as
    // 'task-orphaned-daemon-restart', which is not plan-invalidating, so a `retry` with `main`
    // unmoved reaches this branch with a previousPayload that has never had plan_path/
    // invariants_path added. Copying it forward as-is would hand IMPLEMENT `plan_path: undefined`
    // -> MissingPlaceholderError -> park; worse, steps/scripted.js's runInvariantCheck treats a
    // missing invariants_path as "nothing to check" and returns [], so CHECK's invariant gate goes
    // silently vacuous instead of failing loudly. planPath/invariantsPath here came from the very
    // 'files-written' event condition 4 just stat'd, so they are more trustworthy than whatever
    // previousPayload happened to carry -- let them win.
    appendEvent(ctx.taskDir, 'PLAN', 'result', {
      payload: { ...previousPayload, plan_path: planPath, invariants_path: invariantsPath, reused: true },
    });
    return 'IMPLEMENT';
  }

  const result = await callLlmStep(ctx, 'PLAN', 'llm.PLAN', ctx.deps);
  const payload = result === null ? { ok: true } : result;
  appendEvent(ctx.taskDir, 'PLAN', 'result', { payload });

  // Action 1.4: a transport failure (spawn error, non-JSON output, missing required key, a
  // deadline kill -- classifyFailure's 'error' kind, or timedOut on its own) means PLAN never
  // produced a verdict at all. Route it to its own park, distinct from 'plan-invalid', which is
  // reserved for a real reply the model DID produce that fails the plan_markdown/
  // invariants_markdown contract below. `kind: 'limit'` is deliberately excluded here -- that is
  // the account-rotation path callLlmStep already retries across accounts; a 'limit' result
  // reaching this line at all would mean rotation gave up, and is left to plan-invalid/the
  // generic ok:false branch exactly as before.
  if (payload && payload.ok === false && (payload.kind === 'error' || payload.timedOut)) {
    throw new ParkSignal('llm-transport-failed:PLAN', {
      kind: payload.kind,
      timedOut: payload.timedOut,
      error: payload.error,
    });
  }
  if (!payload || payload.ok === false) {
    throw new ParkSignal('plan-invalid', { payload });
  }
  if (result === null) return 'IMPLEMENT';

  const planMarkdown = payload.plan_markdown;
  const invariantsMarkdown = payload.invariants_markdown;
  const missing = [];
  if (typeof planMarkdown !== 'string' || planMarkdown.trim() === '') missing.push('plan_markdown');
  if (typeof invariantsMarkdown !== 'string' || invariantsMarkdown.trim() === '') missing.push('invariants_markdown');
  if (missing.length > 0) {
    throw new ParkSignal('plan-invalid', { payload, missing });
  }

  const dir = scratchDir(ctx.taskDir);
  fs.mkdirSync(dir, { recursive: true });
  const issue = ctx.task && ctx.task.issue != null ? ctx.task.issue : ctx.id;
  const planPath = path.join(dir, `plan-${issue}.md`);
  const invariantsPath = path.join(dir, `invariants-${issue}.md`);
  fs.writeFileSync(planPath, planMarkdown);
  fs.writeFileSync(invariantsPath, invariantsMarkdown);
  // Action 3.1: baseMainSha rides along so a LATER retry's decidePlanReuse has something to
  // compare against (condition 2/3) -- ctx.task.baseMainSha is undefined outside real mode
  // (shadow/dry-run never call realWorktree), which is exactly why reuse never triggers there.
  appendEvent(ctx.taskDir, 'PLAN', 'files-written', { planPath, invariantsPath, baseMainSha: ctx.task.baseMainSha });

  // #118, folded in from SPO-Pipeline#31: the guard now runs AFTER plan-<issue>.md and
  // invariants-<issue>.md are written, not before. #31's own acceptance criterion was that the
  // park "surface the plan's own path, so a human can hand plan-<issue>.md to an interactive
  // session" -- and until now it could not: the park fired ahead of the write, so the plan text
  // existed only inside journal.jsonl and the promised handoff did not exist even once the
  // Array.isArray bug above was fixed. Writing first costs one mkdir and two file writes on a card
  // that is about to park, and buys the maintainer the file itself; the park detail carries the
  // path. It does NOT open the plan up for reuse: 'plan-requires-protected-files' is in
  // PLAN_INVALIDATING_PARK_REASONS, so decidePlanReuse's condition 6 refuses the very plan this
  // park was raised on. The expensive work (buildBaseline, below) still happens strictly after the
  // guard, so a parking card never pays for it.
  guardDeclaredFiles(ctx, payload.files_to_change, { planPath, invariantsPath });

  // Action 1.8: the PLAN-time invariant baseline. Real mode only (shadow/dry-run never spawn a
  // real worktree for buildBaseline to resolve against, and doc/state-machine-spec.md's
  // invariant substring check is itself a real-mode-only CHECK behaviour -- see realCheck).
  // Every invariant is resolved against the just-created worktree right now, while it still
  // reflects nothing but PLAN's own read of it; an invariant that fails to resolve here is a
  // journalled warning, never a park -- see orchestrator/invariants.js's own header for why
  // (a misquote must not cost a real remediation cycle). The baseline this produces is the ONLY
  // thing realCheck (steps/scripted.js) is allowed to fail an invariant on: an id that resolved
  // here and no longer does at CHECK time.
  if (isRealMode(ctx) && ctx.task.worktreePath) {
    const baseline = buildBaseline(ctx.task.worktreePath, invariantsPath);
    appendEvent(ctx.taskDir, 'PLAN', 'invariants-baseline', baseline);

    // Canary against a silent parser/prompt divergence. The whole feature fails OPEN: if the
    // parser stops recognising what plan.md tells the model to emit, every invariant lands
    // unresolved, the baseline is empty, CHECK verifies nothing -- and the pipeline looks
    // perfectly healthy. That is exactly how the CRLF bug in the first cut of invariants.js
    // behaved. PLAN already declares invariant_ids in its own payload, so a declared-vs-parsed
    // mismatch is free to detect and is the one signal that would surface such a regression.
    // Journalled, deliberately never a park: PLAN's prose and its id list disagreeing is not
    // grounds to fail a card, it is grounds to go look at the parser.
    const declaredIds = Array.isArray(payload.invariant_ids) ? payload.invariant_ids : [];
    const parsedIds = (baseline.invariants || []).map((inv) => inv.id);
    if (declaredIds.length !== parsedIds.length) {
      appendEvent(ctx.taskDir, 'PLAN', 'invariants-declared-parsed-mismatch', {
        declared: declaredIds.length,
        parsed: parsedIds.length,
        declaredIds,
        parsedIds,
        issues: baseline.issues || [],
      });
    }
  }

  // Re-journal PLAN's 'result' with plan_path/invariants_path added -- task-values.js's
  // lastResultPayload reads the *last* PLAN 'result' event for IMPLEMENT/VALIDATE's own
  // placeholder derivation, and that lookup must keep resolving to these exact paths.
  appendEvent(ctx.taskDir, 'PLAN', 'result', {
    payload: { ...payload, plan_path: planPath, invariants_path: invariantsPath },
  });

  return 'IMPLEMENT';
}

// Parses IMPLEMENT's files_changed value, which arrives as either a real array or (as seen in
// today's card issue-247 run) a JSON-encoded string like "[]". Returns null for anything that
// isn't cleanly one or the other -- missing, unparsable, or the wrong shape are all treated the
// same as "no files changed" by the caller below.
function parseFilesChanged(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function handleImplement(ctx) {
  // Kanban piloting: move to "Implementing" before the LLM call -- IMPLEMENT is an LLM step, not
  // a scripted one, so there is no realX(ctx, deps) function for board.js's moveCard to live
  // inside; it runs here instead, gated the same way every real-mode call in this file is.
  if (isRealMode(ctx)) moveCard(ctx, ctx.deps, 'IMPLEMENT');
  const result = await callLlmStep(ctx, 'IMPLEMENT', 'llm.IMPLEMENT', ctx.deps);
  const payload = result === null ? { ok: true } : result;
  appendEvent(ctx.taskDir, 'IMPLEMENT', 'result', { payload });

  // Action 1.4: a transport failure never reached a verdict -- routing it to DIAGNOSE (the old
  // `!payload || payload.ok === false` branch below) paid a real LLM call to diagnose a failure
  // that never reached the model at all (issue-452: three Fable diagnoses, $1.75, for a $0 E2BIG
  // spawn failure). Park directly instead. `kind: 'limit'` is deliberately excluded -- see
  // handlePlan's own comment on the same guard.
  if (payload && payload.ok === false && (payload.kind === 'error' || payload.timedOut)) {
    throw new ParkSignal('llm-transport-failed:IMPLEMENT', {
      kind: payload.kind,
      timedOut: payload.timedOut,
      error: payload.error,
    });
  }
  if (!payload || payload.ok === false) return 'DIAGNOSE';

  // Transport-level ok:true is not enough to trust CHECK with the worktree: today's real run of
  // card issue-247 saw IMPLEMENT return {ok: true, filesChanged: "[]", allGreen: "false",
  // summary: "Cannot proceed: the required plan file ... does not exist"} -- the old code sent
  // that straight to CHECK, which passed on the untouched worktree, and PUSH_PR only then parked
  // (push-pr-failed, "nothing to commit") two states and one misleading reason later than the
  // real problem. Route an empty/unparsable files_changed to DIAGNOSE instead, the existing
  // bounded remediation path.
  //
  // Gated on BOTH isRealMode(ctx) AND the payload actually carrying a files_changed/filesChanged
  // key, not on isRealMode alone -- two existing, legitimate shapes would otherwise break:
  //   - --dry-run's own canned IMPLEMENT payload (steps/llm.js's cannedDryRunPayload) reports
  //     files_changed: [] on purpose (nothing really ran); isRealMode(ctx) is already false for
  //     --dry-run, so the key-presence check is redundant there but kept for clarity.
  //   - the legacy ctx.task.llm.IMPLEMENT override path (steps/llm.js's runLlm: "honoured
  //     verbatim, no outputContract validation" -- still real mode, still exercised by
  //     test/board-move.test.js) returns invokeClaudeReal's raw {ok, result, ...} shape, which
  //     never has a files_changed field at all -- that is a different payload shape, not an
  //     empty-implement bug, so it is left alone and still reaches CHECK as before.
  // A legitimate implement with red tests (non-empty filesChanged, allGreen false) still reaches
  // CHECK, provided the worktree it named actually moved -- see the tree cross-check below.
  if (isRealMode(ctx)) {
    const hasFilesChangedField =
      Object.prototype.hasOwnProperty.call(payload, 'files_changed') ||
      Object.prototype.hasOwnProperty.call(payload, 'filesChanged');
    if (hasFilesChangedField) {
      const raw = 'files_changed' in payload ? payload.files_changed : payload.filesChanged;
      const filesChanged = parseFilesChanged(raw);
      if (!filesChanged || filesChanged.length === 0) {
        appendEvent(ctx.taskDir, 'IMPLEMENT', 'empty-implement', { filesChanged: raw, summary: payload.summary });
        return 'DIAGNOSE';
      }

      // Card #385: IMPLEMENT declared 30 files_changed while the worktree had not actually
      // moved -- CHECK then passed on the untouched tree, and PUSH_PR only parked
      // (push-pr-failed, "nothing to commit") two states later, on a misleading reason. The
      // guard above only checks the SHAPE of the LLM's claim (present, parses, non-empty); this
      // cross-checks the claim itself against the tree it says it touched. Deliberately nested
      // inside the same hasFilesChangedField branch as the guard above, not gated on isRealMode
      // + worktreePath alone, for the same reason that branch exists in the first place: the
      // legacy ctx.task.llm.IMPLEMENT override shape (test/board-move.test.js) carries no
      // files_changed claim at all, so there is nothing here to cross-check against -- this
      // exempts it exactly as the guard above already does.
      if (ctx.task.worktreePath) {
        const status = spawnStep(ctx, ctx.deps, 'IMPLEMENT', 'git', ['-C', ctx.task.worktreePath, 'status', '--porcelain']);
        if (status.exit === 0 && status.stdout.trim() === '') {
          appendEvent(ctx.taskDir, 'IMPLEMENT', 'no-worktree-change', { claimedFilesChanged: filesChanged.length });
          return 'DIAGNOSE';
        }
      }
    }
  }

  return 'CHECK';
}

async function handleCheck(ctx) {
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'CHECK', () => realCheck(ctx, ctx.deps));
  }
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'CHECK', () =>
    runScripted(ctx, 'check', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'CHECK', 'result', { exit, stdoutTail });
  if (exit === 0) return 'PUSH_PR';
  return 'DIAGNOSE';
}

async function handlePushPr(ctx) {
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'PUSH_PR', () => realPushPr(ctx, ctx.deps));
  }
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'PUSH_PR', () =>
    runScripted(ctx, 'pushPr', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'PUSH_PR', 'result', { exit, stdoutTail });
  if (exit === 0) return 'GATE';
  throw new ParkSignal('push-pr-failed', { exit });
}

async function handleGate(ctx) {
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'GATE', () => realGate(ctx, ctx.deps));
  }
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'GATE', () =>
    runScripted(ctx, 'gate', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'GATE', 'result', { exit, stdoutTail });
  if (exit === 0) return 'CI_CHECKS';
  if (exit === 1) return 'DIAGNOSE';
  if (exit === 2) throw new ParkSignal('gate-dirty-tree', { exit });
  if (exit === 3) throw new ParkSignal('gate-worker-down', { exit });
  if (exit === 4) throw new ParkSignal('gate-timeout', { exit });
  throw new ParkSignal('gate-unrecognized-exit', { exit });
}

// CI_CHECKS does two things, in order, per state-machine-spec.md's (a)/(b):
//  (a) map the one failing check name (if any) this visit;
//  (b) only if (a) was green: the main-moved test, at most one re-merge-and-regate per task.
//
// Action 4.3 adds a third thing, after (a)/(b) have both resolved a next state: charge the
// CI_CHECKS -> IMPLEMENT retry budget. Both branches below are restructured to resolve `next`
// FIRST and return through the one shared chargeCiImplementRetry() call at the bottom, so the
// real path (realCiChecks) and the shadow-fixture path (resolveShadowCiChecks) can never charge
// this budget differently -- the same reason ci-cause-table.js is one shared module rather than
// two copies.
async function handleCiChecks(ctx) {
  const next = isRealMode(ctx)
    ? await callWithDeadline(ctx, 'CI_CHECKS', () => realCiChecks(ctx, ctx.deps))
    : resolveShadowCiChecks(ctx);
  return chargeCiImplementRetry(ctx, next);
}

// The shadow-fixture half of CI_CHECKS, unchanged in behaviour from before action 4.3 except
// that it now returns its resolved next state to handleCiChecks instead of returning directly
// out of the handler -- see the restructuring note above.
//
// The `ciChecks` fixture takes two shapes, and both are load-bearing:
//   - a bare string ('Something-unknown'), the legacy shape every pre-4.3 fixture uses. It names
//     a failing CHECK with no step information, which is exactly what the real path sees when
//     the job lookup degrades -- classifyCiFailure gets one argument, lands on its "no step
//     info" branch, and resolves to DIAGNOSE for EVERY check name. That is a real behaviour
//     change for those fixtures (a string 'Lint' used to route straight to IMPLEMENT) and a
//     deliberate one: see ci-cause-table.js's header for why a real 'Lint' CHECK name could
//     never have existed in the first place.
//   - `{check, step}`, added by action 4.3. Shadow mode cannot make the `gh api
//     .../actions/jobs/<id>` call the real path uses to recover the failing step, so without
//     this shape shadow mode could no longer reach CI_CHECKS -> IMPLEMENT or the
//     `pr-rules-needs-approval` park AT ALL -- the two routes this action makes reachable for
//     the first time would have had zero end-to-end coverage in the only mode the daemon test
//     suite can drive end to end. The fixture supplies the step the real path looks up; every
//     line of routing, journalling and budgeting after that point is the shared code.
function resolveShadowCiChecks(ctx) {
  const raw = ctx.fixture('ciChecks', null);
  if (raw) {
    const failingCheck = typeof raw === 'string' ? raw : raw.check;
    const failingStep = typeof raw === 'string' ? null : raw.step || null;
    appendEvent(ctx.taskDir, 'CI_CHECKS', 'check-failed', { check: failingCheck, step: failingStep });
    const outcome = classifyCiFailure(failingCheck, failingStep);
    if (outcome.kind === 'park') {
      throw new ParkSignal(outcome.reason, { check: failingCheck, step: failingStep });
    }
    return outcome.nextState;
  }
  appendEvent(ctx.taskDir, 'CI_CHECKS', 'checks-green', {});

  const moved = ctx.fixture('mainMoved', false);
  if (!moved) return 'VALIDATE';

  if (ctx.fixture('nightlyMainRed', false)) {
    throw new ParkSignal('main-red-no-merge', {});
  }
  // Action 6.5: compare against the configurable budget (default 1 -- see config.js's
  // mainMovedRegateBudget comment), not a hardcoded "once". The reason string stays
  // `main-moved-twice` even past a raised budget -- it names the EVENT (a move refused because
  // the budget for this task is spent), not a literal second occurrence, and no code outside
  // this file's own three throw sites reads the string, so renaming it would only cost every
  // existing test and journal entry their continuity for no reader anywhere.
  const budget = resolveMainMovedRegateBudget(ctx.config);
  if (ctx.counters.mainMoveUsed >= budget) {
    throw new ParkSignal('main-moved-twice', { mainMoveUsed: ctx.counters.mainMoveUsed, mainMovedRegateBudget: budget });
  }
  ctx.counters.mainMoveUsed += 1;
  appendEvent(ctx.taskDir, 'CI_CHECKS', 'main-moved-merge', {});
  return 'CHECK';
}

// Action 4.3: charge the CI_CHECKS -> IMPLEMENT retry budget. Out of CI_CHECKS, 'IMPLEMENT' can
// only mean classifyCiFailure routed a failing check/step there -- VALIDATE, CHECK and DIAGNOSE
// are all untouched below, on purpose, including the main-moved merge path (which must keep
// working exactly as it does today).
//
// `check`/`step` for the journalled line are read back from the 'check-failed' event
// realCiChecks/resolveShadowCiChecks just wrote (above), rather than threaded through as a
// return value: every existing caller of realCiChecks (steps/scripted.js's own test suite)
// depends on it returning a bare state-name string, and widening that return shape to carry
// {check, step} everywhere would be a much bigger, unrelated blast radius for a value this one
// call site needs. The 'check-failed' event was always written before 'IMPLEMENT' can be
// returned (see ci-cause-table.js: IMPLEMENT only ever comes from a failing check having just
// been classified), so it is always there to read.
//
// Budget itself mirrors handleDiagnose's diagnoseAttempts: the ledger line is written for EVERY
// attempt, including the one that trips the budget, so ciImplementRetries and the journal can
// never disagree about how many attempts actually happened.
function chargeCiImplementRetry(ctx, next) {
  if (next !== 'IMPLEMENT') return next;

  const lastFailure = readJournalLines(ctx.taskDir)
    .reverse()
    .find((e) => e.state === 'CI_CHECKS' && e.event === 'check-failed');
  const check = lastFailure ? lastFailure.check : null;
  const step = lastFailure ? lastFailure.step : null;

  const attempt = ++ctx.counters.ciImplementRetries;
  appendEvent(ctx.taskDir, 'CI_CHECKS', 'ci-implement-retry', { attempt, check, step });
  if (attempt > ctx.config.ciRetryBudget) {
    throw new ParkSignal('ci-retry-budget-exhausted', { attempts: attempt, check, step });
  }
  return next;
}

// DIAGNOSE budget: at most config.diagnoseBudget attempts, and any root cause seen before
// (this task only) parks immediately, even under budget. Ledger gets a line for every attempt,
// including the one that trips either rule.
async function handleDiagnose(ctx) {
  if (ctx.counters.diagnoseAttempts >= ctx.config.diagnoseBudget) {
    // Unreachable through the normal loop -- the budget check below always parks on the attempt
    // that reaches it rather than letting a further one be attempted. Reachable by configuration
    // though: `diagnoseBudget` is a plain config value (default 3), and at 0 this guard is the
    // only thing that ever fires, since the check below never runs.
    throw new ParkSignal('diagnose-budget-exhausted', { attempts: ctx.counters.diagnoseAttempts });
  }

  // Action 5.1 (DIAGNOSE-surfacing sub-item -- see park-loop.js's own "action 5.1" comment on
  // why this used to be miswritten "5.1d"; the plan does not letter row 5.1's sub-items):
  // surface DIAGNOSE on the card, first entry only -- see park-loop.js's
  // postDiagnoseSurfaceComment for the comment mechanics/measurement and this file's own
  // ctx.counters.diagnoseSurfaced comment (buildCtx) for why the flag is in-memory and per-run.
  // Set BEFORE calling, not after: "first entry" means first entry regardless of whether the
  // comment itself lands (real mode/never-blocks policy, same as board.js's moveCard), and the
  // attempt named in the comment is the one about to run (diagnoseAttempts + 1), not the one
  // that already ran.
  if (isRealMode(ctx) && !ctx.counters.diagnoseSurfaced) {
    ctx.counters.diagnoseSurfaced = true;
    postDiagnoseSurfaceComment(ctx, ctx.deps, {
      attempt: ctx.counters.diagnoseAttempts + 1,
      budget: ctx.config.diagnoseBudget,
    });
  }

  // Action 1.3: generate DIAGNOSE's declared judge inputs (diff.patch / gate.log / gate-report.md)
  // before the LLM call, real mode only. gate.log is required only when this DIAGNOSE was
  // entered from GATE (ctx.cameFrom, set by runTask's transition loop below) -- from anywhere
  // else (a CHECK failure, an empty IMPLEMENT, an unmatched CI_CHECKS) no gate has ever run for
  // this attempt, and the spec's "CHECK Failure -> DIAGNOSE, never PARKED" must hold regardless.
  if (isRealMode(ctx)) prepareJudgeInputs(ctx, ctx.deps, { forState: 'DIAGNOSE' });

  const result = await callLlmStep(ctx, 'DIAGNOSE', 'llm.DIAGNOSE', ctx.deps);

  // Action 1.4: a transport failure never produced a verdict at all -- park immediately, before
  // any attempt is counted or any ledger line written. Previously this fell through to the
  // rootCause fallback below and got journaled as a fabricated, always-unique
  // "unspecified-cause-N", which could never trip the duplicate-root-cause guard and paid a full
  // extra IMPLEMENT attempt for nothing (issue-452: three Fable diagnoses, $1.75, for a $0 E2BIG
  // spawn failure). `kind: 'limit'` deliberately excluded -- see handlePlan's own comment.
  if (result && result.ok === false && (result.kind === 'error' || result.timedOut)) {
    throw new ParkSignal('llm-transport-failed:DIAGNOSE', {
      kind: result.kind,
      timedOut: result.timedOut,
      error: result.error,
    });
  }

  const attemptN = ++ctx.counters.diagnoseAttempts;

  // Action 1.5: diagnose.md declares two mutually exclusive reply shapes, and step-contracts.js's
  // outputContract deliberately treats a PRESENT-but-null root_cause as satisfying the contract
  // (its own comment: "a present-but-null root_cause [is] satisfied, never ... 'missing'") -- it
  // means "I have no cause that is not already on the ledger", the documented honest answer, not
  // "no answer at all". The old `(result && result.rootCause) || fabricated` conflated the two:
  // null is falsy, so the honest answer was silently replaced by an always-unique fabricated
  // string that could never trip the duplicate-root-cause guard (issues 213, 428, 452).
  //
  // Distinguish PRESENCE of the key from its VALUE, and check both the wire's snake_case
  // `root_cause` and its camelCase alias: llm.js's withCamelAliases keeps both names on a real
  // reply, but --dry-run's cannedDryRunPayload returns only `root_cause` (it is never run through
  // withCamelAliases), and shadow-mode fixtures in this test suite use only `rootCause`.
  const hasRootCauseKey =
    !!result &&
    (Object.prototype.hasOwnProperty.call(result, 'rootCause') ||
      Object.prototype.hasOwnProperty.call(result, 'root_cause'));
  const rootCauseValue = hasRootCauseKey
    ? Object.prototype.hasOwnProperty.call(result, 'rootCause')
      ? result.rootCause
      : result.root_cause
    : undefined;

  if (hasRootCauseKey && rootCauseValue === null) {
    // The documented "no new cause" answer. Append the ledger line for the attempt first (same
    // order the rest of this function already follows: journal, then ledger, then park), never
    // fabricate a cause, never retry IMPLEMENT on it.
    appendEvent(ctx.taskDir, 'DIAGNOSE', 'result', {
      attempt: attemptN,
      payload: { rootCause: null, reason: result.reason || null },
    });
    appendLedgerLine(ctx.taskDir, attemptN, '(no new cause)', 'parked (no new cause)');
    throw new ParkSignal('diagnose-no-new-cause', { attempt: attemptN, reason: result.reason || null });
  }

  // root_cause absent entirely (neither key present) is not one of diagnose.md's two documented
  // shapes. On the production `kind: "card"` path it is unreachable past the transport-failure
  // park above: step-contracts.js's outputContract requires the `root_cause` key, so llm.js's
  // real-reply path already turns a reply omitting it into {ok: false, kind: 'error', error:
  // '... missing required key(s): root_cause'}, caught above. It stays reachable on two paths
  // that bypass that validation -- a shadow-mode fixture that forgot to wire rootCause, and the
  // legacy ctx.task.llm.DIAGNOSE override, which is real mode but returns invokeClaudeReal's raw
  // shape with no contract check at all. Kept as the pre-existing "fabricate a unique
  // placeholder" behaviour: nothing in this change package asks for a different answer here, and
  // no existing test relies on one. Note the fabricated cause is always unique, so it evades the
  // duplicate guard below -- the same waste 1.5 removes for the documented null shape.
  //
  // A falsy-but-present root_cause (notably "") is deliberately NOT fabricated over: it flows
  // through as-is, so repeating it trips the duplicate guard instead of evading it.
  const rootCause = hasRootCauseKey ? rootCauseValue : `unspecified-cause-${attemptN}`;
  const category = (result && result.category) || null;
  const suggestedFix = (result && result.suggestedFix) || null;
  // Journal category/suggestedFix alongside rootCause -- task-values.js's IMPLEMENT derivation
  // (buildPromptValues) reads this same 'result' event back so the next IMPLEMENT attempt
  // actually sees what DIAGNOSE found, instead of re-reading only the original PLAN and
  // reporting "already implements this plan exactly" against a cause it never learned about
  // (see doc/todo-triage-after-hooks-retirement.md's issue-213 case: three IMPLEMENT attempts in
  // a row went empty because the diagnosed SSRF/untrusted-write cause was never threaded to
  // IMPLEMENT, only ever written to the ledger).
  // Nested under `payload`, matching PLAN's/IMPLEMENT's own 'result' event shape -- task-values.js's
  // lastResultPayload() (the reader every other step's derivation already goes through) only
  // ever looks at `event.payload`, so a flat shape here would be silently invisible to it.
  appendEvent(ctx.taskDir, 'DIAGNOSE', 'result', {
    attempt: attemptN,
    payload: { rootCause, category, suggestedFix },
  });

  const duplicate = ctx.counters.seenRootCauses.has(rootCause);
  const budgetExhausted = attemptN >= ctx.config.diagnoseBudget;
  const outcome = duplicate ? 'parked (duplicate root cause)' : budgetExhausted ? 'parked (budget exhausted)' : 'retry';
  appendLedgerLine(ctx.taskDir, attemptN, rootCause, outcome);

  if (duplicate) throw new ParkSignal('diagnose-duplicate-root-cause', { attempt: attemptN, rootCause });
  ctx.counters.seenRootCauses.add(rootCause);
  if (budgetExhausted) throw new ParkSignal('diagnose-budget-exhausted', { attempt: attemptN, rootCause });
  return 'IMPLEMENT';
}

// VALIDATE: citation-verifier only when the task touches rdo-members.ts, then change-validator.
// change-validator REJECT has its own budget (config.validateRejectBudget), separate from
// DIAGNOSE's -- a false citation from citation-verifier parks immediately, no budget.
async function handleValidate(ctx) {
  // Kanban piloting: move to "Validation" once per VALIDATE entry, before either LLM call --
  // same reasoning as handleImplement's own moveCard (no realX(ctx, deps) split for an LLM step).
  if (isRealMode(ctx)) moveCard(ctx, ctx.deps, 'VALIDATE');

  // Action 1.3: generate VALIDATE's declared judge inputs (diff.patch / gate-report.md), real
  // mode only. diff.patch is always required here (VALIDATE only runs post-PUSH_PR, so a commit
  // and a push have already happened) -- unproducible throws ParkSignal('judge-inputs-missing')
  // itself, before either LLM call below ever spawns.
  if (isRealMode(ctx)) prepareJudgeInputs(ctx, ctx.deps, { forState: 'VALIDATE' });

  // Action 5.3: citationVerdict/citationEntries survive past this block so the DIVERGES branch
  // below (before the 'MERGE' return) can route `entries` into a comment a human actually sees.
  // Stay at their defaults (null/[]) whenever touchesRdoMembers is false -- the overwhelming
  // majority of tasks, which never run citation-verifier at all.
  let citationVerdict = null;
  let citationEntries = [];

  // 2026-09-04, interim: run the verifier only when there is something to verify.
  //
  // WHY. Two different facts decide this block today and they can disagree. Whether the step RUNS
  // is `ctx.task.touchesRdoMembers` -- an intake GUESS made from the card's own text
  // (intake.js's makeTask: `area === 'rdo'` or a literal "rdo-members.ts" mention). Whether the
  // step CAN run is whether `citations` exists -- and realPushPr only ever collects those when
  // the REAL diff touched the catalogue. realPushPr corrects the guess false -> true when the
  // diff disagrees (the `touches-rdo-members-rederived` event, added for card #385), but never
  // true -> false, so an intake false positive survives all the way to here and meets an empty
  // citations list.
  //
  // Measured: card #489 (2026-09-03) was implemented, passed every invariant, opened PR #659 and
  // went CI-green -- then parked `prompt-missing-placeholder:citations` because its diff touched
  // no catalogue file and no `rdo-citation` event was ever written (journal: 0 of them). Card
  // #385 parked on the same reason pre-C1. The step has ONE successful execution in the project's
  // history (#462).
  //
  // The availability test mirrors task-values.js's own resolution order exactly (in-memory first,
  // journal fallback second) so this can never skip a call the placeholder fill would have
  // satisfied. When the guess says RDO and no citations exist, the skip is journaled -- it is a
  // real signal (either intake over-flagged, or an RDO change shipped uncited) and must not go
  // silent. Fail-closed behaviour for every OTHER cv shape below is untouched.
  //
  // This is an INTERIM narrowing, not the fix: the fix is to make the trigger and the input come
  // from the same source (the diff). See the SPO Factory card that carries this note.
  const inMemoryCitations = Array.isArray(ctx.task.citations) && ctx.task.citations.length > 0;
  const citationsAvailable = inMemoryCitations || (lastJournaledCitations(ctx.taskDir) || []).length > 0;

  if (ctx.task.touchesRdoMembers && !citationsAvailable) {
    appendEvent(ctx.taskDir, 'VALIDATE', 'citation-verifier-skipped-no-citations', {
      touchesRdoMembers: true,
      source: 'interim-narrowing-2026-09-04',
    });
  }

  if (ctx.task.touchesRdoMembers && citationsAvailable) {
    const cv = await callLlmStep(ctx, 'CITATION_VERIFIER', 'llm.CITATION_VERIFIER', ctx.deps);

    // Fail-closed judge (2026-08-30 audit): the citation verifier has never actually been
    // executable in real mode, and the previous `(cv && cv.verdict) || 'PASS'` default meant a
    // transport error, a timeout, or a malformed payload all silently became a PASS -- the only
    // branch that has ever run. Every shape cv can take is classified explicitly below; nothing
    // falls through to PASS by default.
    if (cv === null && ctx.shadowMode) {
      // No shadow.llm.CITATION_VERIFIER fixture wired for this task at all (fixture.js returns
      // the caller's default) -- the pre-existing "trivially ok, nothing to validate" convention
      // this file already uses (see handlePlan's `result === null` idiom) is kept for this one
      // case, so shadow mode stays usable as a fixture harness for tasks that don't care about
      // citation-verifier specifically. Must NOT apply outside shadow mode: a null cv in real
      // mode or --dry-run means something actually went wrong (see the branch below).
      appendEvent(ctx.taskDir, 'VALIDATE', 'citation-verifier', { verdict: 'PASS', source: 'no-fixture' });
    } else if (!cv || cv.ok === false || typeof cv.verdict !== 'string') {
      // Transport error ({ok: false, kind: 'error'}), timeout ({ok: false, timedOut: true}), a
      // payload with no verdict key, or a null cv (real mode/--dry-run) -- none of these is a
      // verdict the change-validator can be let through on. Park, don't guess.
      const detail = { ok: cv && cv.ok, kind: cv && cv.kind, timedOut: cv && cv.timedOut, verdict: cv && cv.verdict };
      appendEvent(ctx.taskDir, 'VALIDATE', 'citation-verifier', detail);
      throw new ParkSignal('citation-verifier-failed', detail);
    } else if (cv.verdict === 'REJECT') {
      appendEvent(ctx.taskDir, 'VALIDATE', 'citation-verifier', { verdict: cv.verdict });
      throw new ParkSignal('citation-false', { verdict: cv.verdict });
    } else if (cv.verdict === 'PASS' || cv.verdict === 'DIVERGES') {
      // Action 5.3 / erratum B: step-contracts.js's CITATION_VERIFIER contract requires
      // `{verdict, entries}`, but this event used to journal only `{verdict}` -- the single real
      // DIVERGES in the corpus (issue-462, 2026-08-31T08:35:08Z) recorded exactly
      // `{"verdict":"DIVERGES"}`, so what actually diverged is unrecoverable today. `entries` is
      // now carried on BOTH branches, not just DIVERGES: PASS's own entries are dropped by the
      // exact same discard-by-omission this action exists to fix, and journalling them here costs
      // nothing (they are already in memory) versus leaving that half of the same bug standing
      // for whichever future action happens to be measuring PASS instead of DIVERGES. Raw, not
      // normalized -- same convention the 'change-validator' event below already follows for
      // `result.findings` -- so the journal is always a faithful record of what the model sent;
      // normalizeFindingsPayload (park-loop.js) is applied at read time -- at render, and (since the
      // REJECT-path fix below) wherever a finding is threaded onward.
      appendEvent(ctx.taskDir, 'VALIDATE', 'citation-verifier', { verdict: cv.verdict, entries: cv.entries });
      citationVerdict = cv.verdict;
      citationEntries = cv.entries;
      // PASS or DIVERGES both continue -- DIVERGES is not blocking, but IS routed to a human
      // comment below (action 5.3), replacing the previous "flagged for a human" that named no
      // actual human-facing surface.
    } else {
      // An unrecognized verdict string -- never continue on a verdict the code doesn't
      // understand.
      appendEvent(ctx.taskDir, 'VALIDATE', 'citation-verifier', { verdict: cv.verdict });
      throw new ParkSignal('citation-verifier-unrecognized-verdict', { verdict: cv.verdict });
    }
  }

  const result = await callLlmStep(ctx, 'VALIDATE', 'llm.VALIDATE', ctx.deps);
  const verdict = result && result.verdict;
  appendEvent(ctx.taskDir, 'VALIDATE', 'change-validator', { verdict, findings: result && result.findings });

  // Action 1.4: a transport failure on the change-validator previously fell through to the
  // generic `throw new ParkSignal('validate-unrecognized-verdict', ...)` at the bottom of this
  // function, blaming the model for a verdict it never rendered. Distinct park, same exclusion
  // of `kind: 'limit'` as handlePlan/handleImplement. This is the change-validator only -- the
  // CITATION_VERIFIER branch above keeps its own 'citation-verifier-failed' reason (action 1.1),
  // deliberately not retargeted to this one.
  if (result && result.ok === false && (result.kind === 'error' || result.timedOut)) {
    throw new ParkSignal('llm-transport-failed:VALIDATE', {
      kind: result.kind,
      timedOut: result.timedOut,
      error: result.error,
    });
  }

  if (verdict === 'PASS' || verdict === 'PASS_WITH_FINDINGS') {
    // Action 5.3: post the judge findings a human would otherwise never see -- BEFORE returning
    // 'MERGE', so the comment lands while the change is still in flight, not after the card is
    // already closed. Real mode only (shadow/dry-run never spawn a `gh` call at all, same gate
    // every other real spawn in this file uses). See park-loop.js's own header on this block
    // (buildValidateFindingsComment/postValidateFindingsComment) for the full rationale: issue,
    // not PR; one comment, not two; no auto-filed follow-up card.
    //
    // Gated on there being something to say: a PASS_WITH_FINDINGS with an empty/malformed
    // findings payload, or a citation-verifier verdict that was never DIVERGES, posts nothing --
    // same "don't manufacture a comment out of nothing" discipline every other best-effort
    // comment in this file already follows (postDiagnoseSurfaceComment's own budget/attempt
    // numbers, postParkComment's <details> block only when `detail` is non-empty).
    if (isRealMode(ctx)) {
      // Only journal the received shape when there was actually a findings payload to receive --
      // a plain PASS has nothing to say here, and journalling `{shape: 'null', count: 0}` on
      // every ordinary merge (the overwhelming majority of VALIDATE outcomes) would be pure
      // journal noise with no erratum A signal in it.
      const findingsNorm =
        verdict === 'PASS_WITH_FINDINGS' ? normalizeFindingsPayload(result && result.findings) : { items: [], shape: null };
      if (verdict === 'PASS_WITH_FINDINGS') {
        appendEvent(ctx.taskDir, 'VALIDATE', 'validate-findings-shape', { shape: findingsNorm.shape, count: findingsNorm.items.length });
      }

      const diverges = citationVerdict === 'DIVERGES';
      const hasFindings = findingsNorm.items.length > 0;
      if (diverges || hasFindings) {
        // postValidateFindingsComment already has its own never-throws contract (park-loop.js's
        // own header), same as postParkComment/postDiagnoseSurfaceComment -- this try/catch is a
        // SECOND line of defence, same belt-and-suspenders park-loop.js's own unparkScan already
        // applies around reconcileExternalClosure/abandonCleanup: a card reaching this line has
        // already passed every gate that matters (the merge itself is not in question), so an
        // unanticipated throw from a best-effort comment must never be what parks -- or crashes
        // the daemon out from under -- an otherwise-successful card.
        try {
          const divergesEntriesNorm = normalizeFindingsPayload(diverges ? citationEntries : null);
          postValidateFindingsComment(ctx, ctx.deps, {
            prNumber: ctx.prNumber,
            findings: findingsNorm.items,
            diverges,
            divergesEntries: divergesEntriesNorm.items,
          });
        } catch (err) {
          appendEvent(ctx.taskDir, 'VALIDATE', 'validate-findings-post-failed', {
            exit: -1,
            timedOut: false,
            error: String((err && err.message) || err),
          });
        }
      }
    }
    return 'MERGE';
  }
  if (verdict === 'REJECT') {
    ctx.counters.validateRejects += 1;
    const attemptN = ctx.counters.validateRejects;

    // Action 1.6: a REJECT's reasons/findings were previously journaled only as the flat
    // 'change-validator' event above (verdict + findings, no reasons) and never threaded any
    // further -- the next IMPLEMENT re-read the original PLAN and its {{diagnosis}} placeholder
    // and could reproduce the exact change VALIDATE just rejected. Mirror handleDiagnose's own
    // fix for the same gap (DIAGNOSE -> IMPLEMENT): journal a 'result' event nested under
    // `payload`, matching DIAGNOSE's/PLAN's/IMPLEMENT's own 'result' shape -- task-values.js's
    // lastResultPayload (the reader every other step's derivation already goes through) only
    // ever looks at `event.payload`, so a flat shape here would be silently invisible to it. See
    // task-values.js's diagnosisSummary for the reader side that now also considers this event.
    const reasons = Array.isArray(result.reasons) ? result.reasons.filter(Boolean) : [];
    // normalizeFindingsPayload, not `Array.isArray(...) ? ... : []`, and this is the eighth
    // production bug of its class in this project. Measured 2026-09-01: ALL 16 `change-validator`
    // events in the 19-journal corpus carry `findings` as a JSON-ENCODED STRING, never an array --
    // the same shape that made 3.2's protected-files guard fail open on every real card. So the
    // `Array.isArray` test here has been false every single time it has ever run, action 1.6's
    // whole point (thread a REJECT's findings into the next IMPLEMENT so it cannot rebuild the
    // change VALIDATE just rejected) has never once fired with a finding in it, and the hermetic
    // suite could not see it because every fixture constructs the array the reading code expects.
    // The corpus's one real REJECT happened to carry an empty array, so nothing was lost yet.
    const findings = normalizeFindingsPayload(result.findings).items;
    appendEvent(ctx.taskDir, 'VALIDATE', 'result', {
      attempt: attemptN,
      payload: { reasons, findings },
    });

    const budgetExhausted = attemptN >= ctx.config.validateRejectBudget;
    const outcome = budgetExhausted ? 'parked (validate-reject-budget-exhausted)' : 'retry (validate reject)';
    // Ledger line distinct from a DIAGNOSE attempt's own ("attempt N | ..."): 'validate-reject'
    // as the line's `kind` (journal.js's appendLedgerLine) so the two are never confused when
    // both appear in the same ledger.md, per validate-change.md's own instruction that `reasons`
    // for a REJECT is "the root cause in one line, exactly as it should appear on the ledger".
    appendLedgerLine(ctx.taskDir, attemptN, reasons.length ? reasons.join('; ') : '(no reason given)', outcome, 'validate-reject');

    if (budgetExhausted) {
      throw new ParkSignal('validate-reject-budget-exhausted', { rejects: attemptN });
    }
    return 'IMPLEMENT';
  }
  throw new ParkSignal('validate-unrecognized-verdict', { verdict });
}

// MERGE: gh pr merge --merge (enqueue) + pr:wait; pr:wait exit 4 (still open) gets exactly one
// bounded re-wait, never a loop. Exit 0 -> FINISH, anything else -> PARKED.
async function handleMerge(ctx) {
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'MERGE', () => realMerge(ctx, ctx.deps));
  }
  const enqueue = await callWithDeadline(ctx, 'MERGE', () => runScripted(ctx, 'prMergeEnqueue', { defaultExit: 0 }));
  appendEvent(ctx.taskDir, 'MERGE', 'pr-merge-enqueue', { exit: enqueue.exit });
  if (enqueue.exit !== 0) throw new ParkSignal('pr-merge-enqueue-failed', { exit: enqueue.exit });

  const w1 = await callWithDeadline(ctx, 'MERGE', () => runScripted(ctx, 'prWait', { defaultExit: 0 }));
  appendEvent(ctx.taskDir, 'MERGE', 'pr-wait', { attempt: 1, exit: w1.exit });
  if (w1.exit === 0) return 'FINISH';
  if (w1.exit === 1) throw new ParkSignal('pr-closed-unmerged', { exit: w1.exit });
  if (w1.exit === 4) {
    const w2 = await callWithDeadline(ctx, 'MERGE', () => runScripted(ctx, 'prWait', { defaultExit: 0 }));
    appendEvent(ctx.taskDir, 'MERGE', 'pr-wait', { attempt: 2, exit: w2.exit, bounded: true });
    if (w2.exit === 0) return 'FINISH';
    throw new ParkSignal('merge-queue-not-landing', { lastExit: w2.exit });
  }
  throw new ParkSignal('pr-wait-unrecognized-exit', { exit: w1.exit });
}

async function handleFinish(ctx) {
  if (isRealMode(ctx)) {
    return callWithDeadline(ctx, 'FINISH', () => realFinish(ctx, ctx.deps));
  }
  const { exit, stdoutTail } = await callWithDeadline(ctx, 'FINISH', () =>
    runScripted(ctx, 'finish', { defaultExit: 0 })
  );
  appendEvent(ctx.taskDir, 'FINISH', 'result', { exit, stdoutTail });
  if (exit === 0) return 'DONE';
  throw new ParkSignal('finish-failed', { exit });
}

const HANDLERS = {
  INTAKE: handleIntake,
  WORKTREE: handleWorktree,
  PLAN: handlePlan,
  IMPLEMENT: handleImplement,
  CHECK: handleCheck,
  PUSH_PR: handlePushPr,
  GATE: handleGate,
  CI_CHECKS: handleCiChecks,
  DIAGNOSE: handleDiagnose,
  VALIDATE: handleValidate,
  MERGE: handleMerge,
  FINISH: handleFinish,
};

// ---- task runner ------------------------------------------------------------------------

// dryRun (daemon.js's --dry-run): real-mode semantics -- config.shadowMode stays false, so
// callLlmStep takes its real branch (step-contracts.js + prompt-template.js, account rotation)
// -- but nothing spawns. steps/llm.js's runLlm and steps/scripted.js's runScripted both check
// ctx.dryRun before their own spawn point and return a fixture-free "assumed success" (scripted)
// or a canned outputContract-satisfying payload (LLM), so a --dry-run run can walk a synthetic
// card task to DONE with zero subprocesses and zero `claude` CLI calls.
function buildCtx(id, task, taskDir, config) {
  return {
    id,
    task,
    taskDir,
    config,
    shadowMode: !!config.shadowMode,
    dryRun: !!config.dryRun,
    fixture: makeFixtureReader(task),
    // The one real-mode injection point every realX(ctx, deps)/callLlmStep(ctx, ..., deps) call
    // site in this file now threads through: production never sets config.deps, so this is {}
    // (real spawnSync/claude) unless a test explicitly builds config with one -- same convention
    // as steps/scripted.js's own deps.spawnSync, one level up so board.js's moveCard and
    // park-loop.js's postParkComment (called from inside this file, with no realX split of
    // their own) share it too.
    deps: (config && config.deps) || {},
    // The daemon process that owns this run, for orphan-scan.js to tell "still running" apart
    // from "died mid-task" after a restart. null outside daemon.js (tests, --once shadow runs
    // with no config.owner) -- orphan-scan.js treats an owner-less snapshot as unknown, never
    // as orphaned, rather than risk a false-positive park on a task with no owner data at all.
    owner: (config && config.owner) || null,
    account: null, // set per-attempt by callLlmStep in real mode; unused in shadow mode
    prNumber: null, // set by realPushPr once `gh pr create`'s URL is parsed; unused in shadow mode
    // The state runTask's transition loop just came FROM, set fresh by that loop before every
    // handler call (null for the very first, INTAKE) -- action 1.3's prepareJudgeInputs reads it
    // to tell "DIAGNOSE entered from GATE" (gate.log required) from every other DIAGNOSE entry
    // point (gate.log optional). Deliberately NOT part of snapshot()/state.json: a retry always
    // restarts a task at INTAKE (card #424 -- see steps/scripted.js's sweepWorktreeLeftovers
    // header), and orphan-scan.js reparks an orphaned task directly through finalizePark without
    // ever re-entering this loop, so nothing ever resumes runTask mid-state from a persisted
    // snapshot -- cameFrom has no restart to be durable across in the first place. A direct-unit-
    // test caller of HANDLERS.DIAGNOSE/VALIDATE that bypasses runTask must set it explicitly.
    cameFrom: null,
    counters: {
      diagnoseAttempts: 0,
      seenRootCauses: new Set(),
      validateRejects: 0,
      // Action 6.5: a COUNT, not a boolean -- how many main-moved re-gates this task has already
      // spent, checked against config.mainMovedRegateBudget (default 1, today's behaviour
      // unchanged) rather than a hardcoded "once". See main-moved-budget.js and config.js's own
      // mainMovedRegateBudget comment for the settled decision and the corpus this default rests
      // on. `0` compares identically to the old `false` everywhere it is read with `>=`/truthy
      // checks (and loose `==`, which snapshot-reading tests still use), so this is not itself a
      // behaviour change.
      mainMoveUsed: 0,
      // Action 4.3's CI_CHECKS -> IMPLEMENT retry budget -- see config.js's ciRetryBudget
      // comment for why this is a separate counter from diagnoseAttempts/validateRejects rather
      // than reusing one of them.
      ciImplementRetries: 0,
      // Action 5.1 (DIAGNOSE-surfacing sub-item, see park-loop.js's own "action 5.1" comment):
      // whether this task has already posted its one-time "pipeline diagnosing"
      // comment (park-loop.js's postDiagnoseSurfaceComment). Same in-memory, per-ctx, never-
      // persisted lifetime as board.js's own 5.1c dedupe memo, and for the same reason: a retry
      // always restarts a task at INTAKE with a fresh ctx (see this file's own cameFrom comment),
      // so "first DIAGNOSE entry" is naturally scoped to one run, never carried across a restart.
      diagnoseSurfaced: false,
    },
  };
}

function snapshot(ctx, state) {
  return {
    id: ctx.id,
    title: ctx.task && ctx.task.title,
    kind: ctx.task && ctx.task.kind,
    state,
    diagnoseAttempts: ctx.counters.diagnoseAttempts,
    validateRejects: ctx.counters.validateRejects,
    ciImplementRetries: ctx.counters.ciImplementRetries,
    mainMoveUsed: ctx.counters.mainMoveUsed,
    prNumber: ctx.prNumber || null,
    worktreePath: (ctx.task && ctx.task.worktreePath) || null,
    owner: ctx.owner || null,
    updatedAt: new Date().toISOString(),
  };
}

// action 4.4: the closed, named allowlist of park reasons finalizePark auto-retries instead of
// parking for real -- see that function's own header comment for the eligibility rule and
// doc/state-machine-spec.md Principle 2 for why this is a narrow exception, not a policy change.
// Every entry here is transient BY CONSTRUCTION, not by hope:
//
//   claim-rate-limited      -- steps/scripted.js's realWorktree throws this on `npm run
//                               board:take` exit 4/5. A rate limit is transient by definition:
//                               the same claim will succeed once the window resets, and nothing
//                               about the CARD is at fault. Measured twice in the journal corpus
//                               (card #247).
//   gate-non-attesting      -- action 4.2's realGate throws this when the bench's own verdict
//                               file for HEAD is missing outright, which worker.ts's
//                               `NON_ATTESTING` set ({DIRTY, ENVIRONMENT, ABANDONED}) never
//                               writes. All three of those outcomes mean nothing was learned
//                               about the code -- a dead gateway, a lost owner lease, a failed
//                               fetch -- so retrying is asking the SAME bench the SAME question
//                               again, not asking a judge to explain a failure it never observed.
//   llm-transport-failed:*  -- state-machine.js's own callLlmStep call sites (PLAN, IMPLEMENT,
//                               DIAGNOSE, VALIDATE -- the four that actually throw this reason;
//                               CITATION_VERIFIER's transport failure is deliberately its own
//                               `citation-verifier-failed`, never this family) throw it when a
//                               step never produced a verdict at all: a spawn error, a deadline
//                               kill, non-JSON output. Measured once (card #455, exit 143 -- the
//                               post-merge hook SIGTERMing an in-flight `claude`). The model
//                               never ran; there is nothing about THIS card's plan or diff that
//                               made the transport fail.
//   gate-live-blocked       -- action B2.3's realGate throws this on an exit-1 `BLOCKED` verdict
//                               whose `live` fact is NOT "routed but undriven" (that shape stays
//                               `gate-live-not-driven`, below, deliberately not on this list).
//                               SPO-WebClient's `run.ts:63` `runLive` returns BLOCKED from
//                               exactly one place now -- the world lock refused the run (dirty,
//                               or another live run already in flight -- `world-lock.ts`'s
//                               single-flight error). Action B3.5 (SPO-WebClient PR #646)
//                               DELETED the second producer, a live-run rate limiter that could
//                               never fire (`minIntervalMinutes: 0`, `maxRunsPerDay: 1000`);
//                               `checkRateLimit` and its `run-history.json` ledger are gone, so
//                               the world lock is the whole of it. The
//                               operational case this exists for: a maintainer running
//                               `gate:local --live` takes that single-flight lock, and it clears
//                               itself within minutes -- parking the daemon's card permanently
//                               on it would be wrong. A genuinely dirty lock does not self-heal,
//                               but `why` is free text from a different repo, not a contract this
//                               file parses to split the two apart -- this budget (below) already
//                               bounds that cost at 2 wasted WORKTREE->PLAN->IMPLEMENT->GATE
//                               cycles before falling through to an ordinary, human-visible park,
//                               the same trade-off `gate-non-attesting` above already makes.
//
// Built as exact strings from the four step names above, not a prefix/substring match -- C3
// shipped a bug behind exactly that shortcut (a loose `llm-transport-failed` match), and this
// action exists partly to not repeat it. `llm-transport-failed` alone and
// `llm-transport-failed:NOPE` must NOT be on this set.
//
// Deliberately NOT on the list: `push-pr-failed`. Every one of its four occurrences in the
// journal corpus is a logic failure (`step: 'commit'` -- "nothing to commit", i.e. IMPLEMENT
// produced no diff), never a network failure -- auto-retrying it would re-run an entire card,
// worktree rebuild and all, to arrive at the identical "nothing to commit" a few minutes later.
// Also deliberately NOT on the list: `gate-live-not-driven` -- a routed-but-undriven diff is a
// property of the worker binary or a reused verdict, not of the moment; see steps/scripted.js's
// own comment on that reason for the full argument.
//
// Action B3.4, round 2 (fixing a regression round 1 shipped): before this action, `DIRTY`,
// `ENVIRONMENT`, `ABANDONED` and `INTERRUPTED` all shared ONE reason -- `gate-non-attesting`,
// above -- and that reason retries. Round 1 split each into its own name
// (steps/scripted.js's realGate) but reported the split as "naming correctness, not retry
// policy" and added none of the four to this set. That is not a no-op: this Set is exactly what
// `isTransientRetryReason` below keys on, so the split silently turned the commonest non-PASS
// bench outcome (`gate-environment` -- 7 of 29 real completed jobs, all "git fetch failed",
// measured 2026-09-03) from auto-retried into terminal/human-only, along with three siblings.
// Restoring the pre-split behaviour per reason, not blanket:
//   gate-environment      -- ADD. A failed `git fetch` is a fact about this worker's network
//                             at this moment, not about the code; retrying asks the same bench
//                             the same question again, exactly the class this file's own header
//                             comment (below) already names as the transient one.
//   gate-interrupted      -- ADD. The worker restarted mid-job (`recoverInterrupted`,
//                             worker.ts) -- precisely what `realFinish`'s bench reinstall does
//                             to a sibling card's in-flight gate. The FINISH design already
//                             treats this cut job as recovering and transient-retryable; this
//                             set must agree with that design, not silently contradict it.
//   gate-abandoned        -- ADD. The depositing session's pid was gone before the job started
//                             -- a fact about that moment's process table, not about the diff;
//                             resubmitting is a fresh deposit with a live pid.
//   gate-stale            -- ADD. Newly a park at all under this action (previously fell into
//                             the generic exit-1 `return 'DIAGNOSE'`, spending a judge call on a
//                             body verdict for a tree that no longer exists -- see
//                             steps/scripted.js's own STALE comment) so there is no PRIOR retry
//                             behaviour to preserve here, but the same "asks the same bench the
//                             same question again" test applies: `verify-gate.js`'s own STALE
//                             detail text says the fix is literally "resubmit", and nothing about
//                             the code was implicated -- terminal would waste a human's attention
//                             on a race that a second gate run most likely just clears.
//   gate-worker-dirty-checkout -- DELIBERATELY NOT added; see its own paragraph below. This IS a
//                             narrowing versus the pre-split `gate-non-attesting` behaviour, and
//                             is called out as one rather than slipped in silently.
// The exit-2/3 sub-causes this same action split out of `gate-dirty-tree`/`gate-worker-down`
// (`gate-not-pushed`, `gate-duplicate-job`, `gate-worker-not-built`, `gate-worker-died-midjob`)
// are NOT added either -- neither `gate-dirty-tree` nor `gate-worker-down` was ever on this set,
// so leaving their four children off it is the status quo continuing, not a new decision.
//
// `gate-worker-dirty-checkout` (DIRTY): the worker's OWN shared `ref` checkout
// (`paths.refCheckout` in SPO-WebClient, one instance for the whole bench, never a per-card
// worktree) found dirty by `worker.ts` -- but only AFTER `prepareRef` has already run that same
// checkout through `reset --hard` + `clean -fd` for THIS job (doc/bench-audit-2026-09-02.md's
// D5: "atStart.hash === atEnd.hash, both taken by the worker on its own checkout, which
// `prepareRef` has just reset --hard'ed and clean -fd'ed"). A dirty verdict reached AFTER an
// automatic reset+clean cycle already ran is not the ordinary case reset+clean exists to fix --
// it is what SURVIVES that cycle: git-ignored artifacts `clean -fd` does not touch, a file a
// stray process still holds, a permission problem, or manual interference with a shared host
// resource. A bare retry re-runs the IDENTICAL reset+clean and asks the identical question of
// the identical checkout, with no structural reason to expect a different answer -- the same
// "real LLM spend burned per attempt, for as long as the underlying condition stands" argument
// `gate-non-attesting`'s own `verdictDirExists === false` carve-out already makes for a
// misconfigured `spoBenchDir`, below. Because the checkout is SHARED, once genuinely stuck this
// way it stays stuck for every card's gate until a human clears it by hand, not only this one's.
// Decision: terminal, human-only -- a DELIBERATE NARROWING versus the pre-split behaviour (DIRTY
// used to share `gate-non-attesting`'s blanket auto-retry), stated here and in
// doc/state-machine-spec.md rather than left for a reader to infer from an absence.
const TRANSIENT_RETRY_LLM_STEPS = ['PLAN', 'IMPLEMENT', 'DIAGNOSE', 'VALIDATE'];
const TRANSIENT_RETRY_REASONS = new Set([
  'claim-rate-limited',
  'gate-non-attesting',
  'gate-live-blocked',
  'gate-environment',
  'gate-interrupted',
  'gate-abandoned',
  'gate-stale',
  ...TRANSIENT_RETRY_LLM_STEPS.map((step) => `llm-transport-failed:${step}`),
]);

// Membership in the set above is necessary but not sufficient, for exactly one entry. Action 4.2
// deliberately did NOT split the misconfigured-bench-directory case out of `gate-non-attesting`
// into a reason of its own -- it records it as a boolean on the park detail instead
// (steps/scripted.js's realGate: `verdictDirExists`, "the two cases a maintainer has to tell
// apart -- the bench genuinely attested nothing vs the machine was looking in the wrong place").
// So the reason string alone conflates a transient fact about the world (a dead gateway, a lost
// owner lease, a failed fetch: retrying asks the same bench the same question again) with a
// PERMANENT fact about this machine's configuration (`config.spoBenchDir` unmounted, moved, or
// simply wrong). The second is not transient by any construction: retrying it re-runs WORKTREE,
// PLAN, IMPLEMENT and GATE -- real LLM spend -- to look in the same wrong place twice more, and
// realGate's own comment says a misconfigured spoBenchDir makes EVERY failing gate land here, so
// the waste is per-card and repeats for as long as the misconfiguration stands. Auto-retry is
// therefore refused when the verdicts directory itself is absent; that park goes straight to a
// human, which is the only thing that can actually fix it. `=== false` and not a falsy test on
// purpose: a journal written before 4.2, or any other caller of this reason, has no
// `verdictDirExists` key at all, and "the field is missing" must keep today's transient
// treatment rather than silently opting every old park out of the retry.
function isTransientRetryReason(reason, detail) {
  if (!TRANSIENT_RETRY_REASONS.has(reason)) return false;
  if (reason === 'gate-non-attesting' && detail && detail.verdictDirExists === false) return false;
  return true;
}

function finalizePark(ctx, lastState, reason, detail) {
  appendEvent(ctx.taskDir, lastState, 'parked', { reason, detail });

  // action 4.4: eligibility for the bounded auto-retry above, checked BEFORE any of the ordinary
  // park machinery below (the board move, the park comment, the PARKED state.json/report.md) --
  // a card that takes this branch is not parked and must not look parked to `spo parked`, the
  // dashboard, or a maintainer reading the issue thread, because none of those writes happen.
  // Real mode only (isRealMode) -- a dry-run or shadow run must never re-enqueue itself: neither
  // one has a real queue/ worth writing into, and doing so would leave a synthetic/fixture task
  // sitting in the REAL queue directory a `--real` daemon polls next. Eligibility also requires
  // the reason to be on TRANSIENT_RETRY_REASONS above AND the per-task budget
  // (config.transientRetryBudget, ctx.task.transientRetries so far) not yet exhausted -- once
  // exhausted, this SAME reason falls straight through to the ordinary park below, unconditionally
  // (no special-casing needed: the `if` below is simply false and every line after it runs
  // exactly as it always has).
  if (isRealMode(ctx) && isTransientRetryReason(reason, detail)) {
    const budget = (ctx.config && ctx.config.transientRetryBudget) || 0;
    const priorRetries = (ctx.task && ctx.task.transientRetries) || 0;
    // A queue directory is not optional here, and its absence must not be discovered by
    // `path.join(undefined, ...)` throwing. finalizePark is called from INSIDE runTask's own
    // ParkSignal catch, so anything it throws escapes past that catch, out of drainQueueOnce and
    // kills the daemon process -- C3 already shipped exactly that shape once (preserveWorktreeWip
    // throwing inside this function, a crash loop over one hung `git status`).
    //
    // Action 6.1 changed who supplies it, and the change is worth stating plainly because it
    // removed a belt this comment used to describe as a second one. Before 6.1, drainQueueOnce
    // was the ONLY injector (`{...config, queueDir}` per task), so orphan-scan.js -- which builds
    // its own ctx from runForever's config -- structurally could not reach the branch below at
    // all. 6.1 needed queueDir on the config in worker mode too (a worker never goes through
    // drainQueueOnce), and set it once in daemon.js's main() for BOTH modes; runForever's config
    // therefore carries it now, and so does the ctx orphan-scan builds from it. Verified against
    // this file's own reader: `buildCtx(id, task, taskDir, {...config, deps})` in orphan-scan.js.
    //
    // Nothing changes in practice TODAY -- orphan-scan's only park reason
    // (`task-orphaned-daemon-restart`) is not on TRANSIENT_RETRY_REASONS, so isTransientRetryReason
    // already rejects it before this line is read. But the allowlist is now the ONLY thing
    // standing between an orphan repark and an auto-retry: adding that reason to the set would
    // silently make orphan-scan re-enqueue, where before 6.1 it would still have parked. Anyone
    // extending TRANSIENT_RETRY_REASONS must decide that on purpose.
    //
    // The guard below stays regardless: no queue to write to means no auto-retry; park honestly.
    const queueDir = ctx.config && ctx.config.queueDir;
    if (priorRetries < budget && typeof queueDir === 'string' && queueDir !== '') {
      const attempt = priorRetries + 1;
      const delays = (ctx.config && ctx.config.transientRetryDelaysMs) || [];
      // Attempt N (1-indexed) -> index min(N-1, length-1): a budget raised past this array's
      // length keeps reusing the LAST (longest) delay instead of reading `undefined` off the end
      // and retrying instantly with no backoff at all.
      const delayMs = delays.length > 0 ? delays[Math.min(attempt - 1, delays.length - 1)] : 0;
      const notBefore = new Date(Date.now() + delayMs).toISOString();

      // park-loop.js's reEnqueueTask does the whole write, in ONE atomic step, with this
      // attempt's two fields handed in through its `extra` parameter -- see its header for why
      // "write the base entry, then patch it" is a correctness bug and not a style choice. The
      // `notBefore` deadline lives on the queue ENTRY, never in a `sleep`. Stale-as-of-C6
      // justification this comment used to give: "runForever's drainQueueOnce loop is awaited, so
      // sleeping inside it would stall every other card in the queue" -- true before chantier 6,
      // false now that a real daemon runs each task in its own worker process (dispatcher.js);
      // a `sleep` here today would stall only the one worker process that is exiting anyway.
      // `notBefore` on the queue entry is still the right mechanism regardless -- a deadline
      // survives that process exiting, a `sleep` would not -- it just isn't preventing the stall
      // it was originally written to prevent.
      //
      // Queue entry first, journal line second, and the return gated on the write having actually
      // happened: `transient-retry` is the journal's claim that this card IS coming back, and the
      // journal is the single source of truth (Principle 5). Journalling it first would let a
      // failed write (a full disk, a queue dir yanked out from under us) leave behind a record of
      // a retry that does not exist on a card that is also not parked -- invisible to `spo
      // parked`, invisible to the queue, recoverable only by orphan-scan noticing the stale
      // state.json much later. Falling through to the ordinary park instead costs one honest park
      // comment and keeps every reader's view of this card true.
      let requeuedFile = null;
      try {
        requeuedFile = reEnqueueTask(queueDir, ctx.taskDir, ctx.id, { transientRetries: attempt, notBefore });
      } catch (err) {
        appendEvent(ctx.taskDir, lastState, 'transient-retry-failed', {
          reason,
          attempt,
          error: String((err && err.message) || err),
        });
      }
      if (requeuedFile) {
        appendEvent(ctx.taskDir, lastState, 'transient-retry', { reason, attempt, delayMs, notBefore });
        return; // not parked -- see the header comment above; every write below is skipped.
      }
    }
  }

  // Loop breaker for card #385's exact failure mode: branch-unmerged-leftover parked four times
  // in a row, byte-identical reason and detail every time, because each preserveWorktreeWip
  // commit advanced the very local branch rule 2 of sweepWorktreeLeftovers could not vouch for --
  // a maintainer's bare "retry" reply could only ever reproduce the same park, never resolve it.
  // Count how many parks in a row (most recent first, the one just journaled above included)
  // share this exact reason+detail fingerprint, and have the park comment say so once that
  // streak reaches 2 (park-loop.js's countRepeatedParks/buildParkComment). Never blocks retry
  // itself -- unparkScan is untouched -- this only changes what the comment says.
  const repeat = countRepeatedParks(readJournalLines(ctx.taskDir), reason, detail);
  if (repeat >= 2) {
    appendEvent(ctx.taskDir, lastState, 'park-repeat', { reason, repeat });
  }

  // Any park with a still-existing, still-dirty worktree gets its diff pushed to a durable wip/
  // ref before anything else -- not just the WORKTREE-retry dirty-leftover case sweepWorktreeLeftovers
  // itself already handles. This is what would have saved card #385's 620 lines of stranded
  // IMPLEMENT work: a task orphaned mid-DIAGNOSE (orphan-scan.js) reparks through this exact
  // function, and its worktree is very likely still sitting there, uncommitted.
  let mergedDetail = detail;
  if (isRealMode(ctx)) {
    const worktreePath = (ctx.task && ctx.task.worktreePath) || (detail && detail.worktreePath) || null;
    const preserved = preserveWorktreeWip(ctx, ctx.deps, { worktreePath, reason });
    if (preserved) mergedDetail = { ...detail, wip: preserved };
  }

  const snap = snapshot(ctx, 'PARKED');
  snap.reason = reason;
  snap.lastState = lastState;
  writeState(ctx.taskDir, snap);
  writeReport(ctx.taskDir, { id: ctx.id, reason, lastState, ts: snap.updatedAt, detail: mergedDetail });

  // The daemon-level feed: one `parked` line in <journalRoot>/daemon.jsonl alongside the
  // per-task event above, so daemon.jsonl reads as the single chronological "needs a human"
  // stream (auto-pull cycles, lock takeovers, parks). All modes -- it is a file append, and
  // taskDir is join(journalRoot, id) by construction (takeNextTask), so dirname recovers the
  // root without threading a new parameter through every ctx.
  appendDaemonEvent(path.dirname(ctx.taskDir), 'parked', { id: ctx.id, reason, lastState });

  // The push half: SPO_PARK_ALERT_CMD, real mode only (an external spawn -- shadow/dry-run
  // tests must see none, same rule as postParkComment below). Never blocks -- park-alert.js
  // carries board.js's failure policy.
  if (isRealMode(ctx)) {
    alertPark(ctx, ctx.deps, { reason, lastState });
  }

  // Kanban piloting, the park half of the round trip: real mode, kind:"card" tasks only -- never
  // for shadow/dry-run (every existing PARKED test in this suite is shadow mode and must see no
  // new spawn) and never for a non-card task (nothing to comment on). park-loop.js's own
  // moveCard('PARKED') call inside postParkComment skips itself, journaled, when the worktree
  // was never created (a pre-WORKTREE park) -- the gh comment still posts either way.
  if (isRealMode(ctx) && ctx.task && ctx.task.kind === 'card') {
    postParkComment(ctx, ctx.deps, { reason, detail: mergedDetail, lastState, repeat });
  }
}

// Runs one task through the state machine to completion (DONE or PARKED). Never throws for a
// recognized outcome -- a ParkSignal anywhere in the handler chain is caught here and turned
// into the PARKED terminal state. An unrecognized state name (HANDLERS[state] undefined,
// including one injected by a shadow fixture for testing) is itself routed through ParkSignal,
// which is the catch-all the spec calls for.
async function runTask(id, task, taskDir, config) {
  const ctx = buildCtx(id, task, taskDir, config);
  let state = 'INTAKE';
  ctx.cameFrom = null; // no previous state yet -- see the field's own doc comment on buildCtx/snapshot
  writeState(taskDir, snapshot(ctx, state));

  // Runaway guard: a real handler bug that returns a valid-looking but cyclic path (e.g. an
  // infinite DIAGNOSE<->IMPLEMENT loop from a logic error) still terminates the run instead of
  // hanging the daemon. Every legitimate path above completes in well under this many hops.
  let hops = 0;
  const HOP_LIMIT = 200;

  while (state !== 'DONE' && state !== 'PARKED') {
    if (++hops > HOP_LIMIT) {
      finalizePark(ctx, state, 'state-machine-runaway', { hops });
      return 'PARKED';
    }
    // Cooperative lock check, between states rather than inside a handler: a handler can be
    // mid-spawnSync (blocking, single-threaded) when lock.js's watchLock timer fires, so the
    // timer alone cannot interrupt a running step -- this is the point every step chain passes
    // through. config.lockLost is set by daemon.js only; absent in every test and in --once
    // shadow runs, so this is a no-op there. Deliberately NOT caught below (LockLostError is not
    // a ParkSignal -- see lock.js's own doctrine comment): a park is itself a write to shared
    // state this process may no longer be the legitimate owner of.
    if (config.lockLost && config.lockLost()) {
      throw new LockLostError('lock-lost-mid-task', config.lockLostHolder && config.lockLostHolder());
    }
    const handler = HANDLERS[state];
    if (!handler) {
      finalizePark(ctx, state, 'unrecognized-state', { state });
      return 'PARKED';
    }
    let next;
    try {
      next = await handler(ctx);
    } catch (err) {
      if (err instanceof ParkSignal) {
        finalizePark(ctx, state, err.reason, err.detail);
        return 'PARKED';
      }
      throw err; // a real bug -- surface it, do not disguise it as a park
    }
    appendEvent(taskDir, state, 'transition', { to: next });
    ctx.cameFrom = state; // the state that just ran, for the NEXT handler to read (e.g.
    // prepareJudgeInputs' DIAGNOSE-from-GATE rule) -- set from the state variable itself, not
    // re-derived, so it is exactly what the transition event above just journaled.
    state = next;
    writeState(taskDir, snapshot(ctx, state));
  }

  if (state === 'DONE') {
    appendEvent(taskDir, 'DONE', 'done', {});
    writeState(taskDir, snapshot(ctx, 'DONE'));
  }
  return state;
}

// ---- queue draining -----------------------------------------------------------------------

function listQueueFiles(queueDir) {
  if (!fs.existsSync(queueDir)) return [];
  return fs
    .readdirSync(queueDir)
    .filter((f) => f.endsWith('.json'))
    .sort(); // processing order = filename sort
}

// action 4.4: is this queue entry allowed to be taken RIGHT NOW? A missing/empty/unparsable
// `notBefore` means "eligible now" -- never "skip forever" -- which is also exactly what an
// __invalid (unparsable JSON) entry gets, unconditionally: it never had a chance to carry a
// notBefore field in the first place, and today's behaviour (take it immediately, let INTAKE's
// own `__invalid` handling park it honestly) must not change. `Date.parse` of `undefined` or a
// garbage string is `NaN`, and `NaN > nowMs` is always `false`, so the single comparison below
// already covers "no field" and "unparsable field" without a separate typeof check.
function isQueueEntryEligibleNow(task, nowMs) {
  if (!task || task.__invalid) return true;
  const notBeforeMs = task.notBefore ? Date.parse(task.notBefore) : NaN;
  return !(notBeforeMs > nowMs);
}

// Takes the earliest ELIGIBLE task file out of queue/ and into its own runtime dir,
// journal/<id>/task.json -- moving it (not copying) is what makes "queue depth" mean "not yet
// taken" for `spo status`, and what keeps a polling daemon from reprocessing it.
//
// action 4.4: "earliest" used to mean "files[0], unconditionally" -- now it means "the first
// entry in filename-sort order whose notBefore has passed", so a queue holding both an
// auto-retry scheduled for five minutes from now and an ordinary fresh card still takes the
// fresh card immediately, rather than the daemon sitting idle waiting on the scheduled one. The
// scan itself does not reorder or reshape anything on disk -- it still walks `listQueueFiles`'s
// existing order (preserving the `0000-retry-` filename-sort priority that ordering already
// gives a maintainer's manual retry over a fresh auto-pulled card), and it still takes (renames)
// only the ONE file it selects. `null` is returned when the queue is non-empty but every entry is
// scheduled for later -- drainQueueOnce's `for (;;)` loop below breaks on a `null` the exact same
// way it already breaks on an empty queue, so the daemon just polls again next cycle rather than
// spinning.
// action 6.3: `liveIds` (a Set<string>, default null/none) is the dispatcher's own live-worker
// table -- the ids currently owned by a worker process it has spawned and not yet seen exit. A
// candidate whose derived id is in that set is SKIPPED, exactly like a not-yet-eligible
// `notBefore` entry above: it stays in queue/ for a later pass, never taken now. This is the
// "never start a queue file whose id matches a live worker" half of the taskDir single-writer
// invariant (see journal.js's own doc comment for the invariant's full statement) -- without it,
// a queue entry that happens to carry the SAME id as a task currently running under a worker (a
// duplicate auto-pull, a maintainer's manual re-file, a retry landing before the original attempt
// finished) would have this function rename its file straight into
// `<journalRoot>/<id>/task.json`, silently clobbering the live worker's own copy out from under
// it mid-run. `null`/omitted (every non-dispatcher caller: drainQueueOnce, recette.js, every
// pre-6.3 test) is exactly today's behaviour -- `liveIds.has(...)` is never reached when there is
// no set to check, so this is additive, not a redefinition of "eligible".
//
// id derivation moves INSIDE the loop (used to happen once, after the loop picked a file) so this
// check can run per-candidate before a file is ever chosen -- the loop already reads and parses
// every candidate up to and including the one it takes, so this costs nothing extra.
function takeNextTask(queueDir, journalRoot, liveIds = null) {
  const files = listQueueFiles(queueDir);
  if (files.length === 0) return null;

  const nowMs = Date.now();
  let file = null;
  let task = null;
  let id = null;
  for (const candidate of files) {
    const candidateRaw = fs.readFileSync(path.join(queueDir, candidate), 'utf8');
    let candidateTask;
    try {
      candidateTask = JSON.parse(candidateRaw);
    } catch {
      candidateTask = { __invalid: true, rawPreview: candidateRaw.slice(0, 200) };
    }
    if (!isQueueEntryEligibleNow(candidateTask, nowMs)) continue;
    const candidateId =
      candidateTask && candidateTask.id ? String(candidateTask.id) : path.basename(candidate, '.json');
    if (liveIds && liveIds.has(candidateId)) continue; // owned by a live worker right now -- see header above
    file = candidate;
    task = candidateTask;
    id = candidateId;
    break;
  }
  if (!file) return null; // every entry is scheduled for later, or live-owned -- see the header comment above.

  const srcPath = path.join(queueDir, file);
  const taskDir = path.join(journalRoot, id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.renameSync(srcPath, path.join(taskDir, 'task.json'));
  appendEvent(taskDir, 'INTAKE', 'taken', { fromFile: file });

  return { id, task, taskDir };
}

// action 4.4: `queueDir` is added onto the config every runTask/finalizePark call in this drain
// sees, alongside whatever the caller already passed -- the ONE plumbing point every real-mode
// caller of runTask goes through (daemon.js --once calls this directly; --real's runForever
// awaits it in a loop; recette.js already passes its own queueDir through its own config, so this
// is a harmless no-op re-assignment there). Without it, finalizePark's auto-retry path
// (state-machine.js, above) would have no queue directory to write a re-enqueued task.json into.
async function drainQueueOnce(queueDir, journalRoot, config) {
  const results = [];
  for (;;) {
    const taken = takeNextTask(queueDir, journalRoot);
    if (!taken) break;
    const { id, task, taskDir } = taken;
    const finalState = await runTask(id, task, taskDir, { ...config, queueDir });
    results.push({ id, finalState });
  }
  return results;
}

// ---- periodic real-mode scans (action 6.3) -------------------------------------------------
//
// Extracted out of runForever's own for(;;) body (which used to inline all of this) so action
// 6.3's dispatcher.js can drive the SAME scans from ITS OWN loop -- one that must NOT block on a
// worker's exit the way runForever blocks on `await drainQueueOnce` below. Action 2.7's own
// comment on unparkScan already flagged this gap: its dedicated timer only guarantees "not more
// often than config.unparkScanMs", never a guaranteed floor, because a long task running inside
// drainQueueOnce starves every timer below it for as long as that task's own step takes. Making
// the floor real is this action's own deliverable -- see dispatcher.js's header and
// test/dispatcher.test.js's "scan runs while a worker is still alive" case.
//
// createScanTimers() returns the mutable last-ran-at bag runScanCycle reads/writes; callers own
// its lifetime (one per daemon run, same as runForever's own now-removed local `let`s).
function createScanTimers() {
  return {
    lastAutoPullAt: null,
    lastAutoIntakeAt: null,
    lastConfirmScanAt: null,
    lastAutoTriageAt: null,
    lastOrphanScanAt: null,
    lastUnparkScanAt: null,
  };
}

// Runs (at most) one pass of every real-mode periodic scan whose own timer has elapsed --
// orphan scan, unpark scan, auto-pull, and the three report-intake stages -- in the exact same
// order runForever's inline body always ran them in (orphan before unpark: "an orphan reparked
// THIS cycle must be visible to a maintainer's retry/abandon reply starting next cycle, not a
// full extra poll later" -- see the comment that used to sit here, preserved below at each call
// site). A no-op outside real mode, same as the `if (config.real)` guard this body used to live
// inside.
//
// action 6.3 (post-verification correction): the scan cycle now runs in its OWN process (the
// scanner, daemon.js --scanner, spawned and supervised by dispatcher.js -- see that file's header
// for the measured reason: intake's blocking `claude` calls inside auto-triage run 3+ minutes,
// long enough that running them inside the DISPATCHER's own loop would freeze worker-slot
// refills, timer service, and SIGTERM handling for that whole window). The scanner's process
// therefore has no in-memory live-worker table of its own -- that table lives in the dispatcher's
// memory. journal.js's readLiveWorkerIds reads the dispatcher's own published, atomically-written
// <journalRoot>/live-workers.json -- see that file's header (the taskDir single-writer invariant
// section) for the full cross-process design and the staleness reasoning in both directions.
//
// Read HERE, fresh, every time this function considers running orphanScan (never cached across
// cycles, never passed in by a caller) -- this is what keeps a stale read bounded to one cycle:
// the file might lag the dispatcher's true in-memory state by a few milliseconds at the instant
// of the read, but never by a whole scan interval. A journal root with no dispatcher running
// against it at all (a --once run, a --worker-only test, a hand-invoked scan) reads back an empty
// Set (journal.js's own tolerant-read posture), which is exactly today's "nothing to protect"
// case -- byte-for-byte the same as passing `null` used to be, before this correction.
async function runScanCycle(timers, queueDir, journalRoot, config, scanStates) {
  if (!config.real) return;
  const deps = config.deps || {};

  // Before unparkScan: an orphan reparked THIS cycle must be visible to a maintainer's
  // retry/abandon reply starting next cycle, not a full extra poll later.
  if (shouldScanOrphans(timers.lastOrphanScanAt, Date.now(), config.orphanScanMs)) {
    timers.lastOrphanScanAt = Date.now();
    await orphanScan(queueDir, journalRoot, config, deps, readLiveWorkerIds(journalRoot));
  }

  // action 2.7 bullet 4: a dedicated timer (config.unparkScanMs, 60s by default), not
  // unconditionally on every drainQueueOnce cycle (pollIntervalMs, 5s by default) the way
  // this used to run -- see park-loop.js's shouldScanUnpark for why.
  if (shouldScanUnpark(timers.lastUnparkScanAt, Date.now(), config.unparkScanMs)) {
    timers.lastUnparkScanAt = Date.now();
    await unparkScan(queueDir, journalRoot, config, deps, scanStates.unpark);
  }

  const now = Date.now();
  if (shouldAutoPull(timers.lastAutoPullAt, now, config.autoPullMs)) {
    timers.lastAutoPullAt = now;
    await runAutoPull(queueDir, journalRoot, config, deps);
  }

  // Human-first bug-report intake, THREE independent timers -- see report-intake.js's own
  // header, remote-report-pull.js's own header, and orchestrator/README.md § Report intake
  // for the full design. (A fourth stage, runRemoteReportPull, runs on its own
  // startRemoteReportPullLoop timer, outside this cycle entirely -- see runForever/dispatcher.js's
  // own call to startRemoteReportPullLoop, made once, not per-cycle.)
  //   1. runReportIntake  -- mechanical (zero LLM). Files a RAW card per queued report and
  //      waits for a maintainer's "confirm"/"discard" reply. Nonzero by default
  //      (config.autoIntakeMs), same risk class as auto-pull.
  //   2. reportConfirmScan -- reads that reply. Nonzero by default (reportConfirmScanMs).
  //   3. runAutoTriage -- reproduction + the reviewCard/fileCard-shaped gate, but ONLY for a
  //      report reportConfirmScan already marked "confirmed". config.autoTriageMs keeps its
  //      pre-redesign name/env var (SPO_AUTO_TRIAGE_MS) so the live systemd drop-in needs no
  //      change; a report filed here becomes an ordinary Todo card the *next* auto-pull
  //      cycle picks up -- the "player report -> nightly fix" chain README.md's migration
  //      step 5 names.
  if (shouldAutoIntake(timers.lastAutoIntakeAt, now, config.autoIntakeMs)) {
    timers.lastAutoIntakeAt = now;
    await runReportIntake(journalRoot, config, deps);
  }
  if (shouldScanConfirms(timers.lastConfirmScanAt, now, config.reportConfirmScanMs)) {
    timers.lastConfirmScanAt = now;
    await reportConfirmScan(journalRoot, config, deps, scanStates.reportConfirm);
  }
  if (shouldAutoTriage(timers.lastAutoTriageAt, now, config.autoTriageMs)) {
    timers.lastAutoTriageAt = now;
    await runAutoTriage(journalRoot, config, deps);
  }
}

// THE SCANNER'S LOOP (action 6.3, post-verification correction). This function used to also
// drain the queue (`await drainQueueOnce(...)` before the scan cycle, every pass) -- that call is
// GONE now, on purpose: verification found the plan's premise wrong ("the dispatcher's own short
// calls (auto-pull, scans) stay spawnSync" -- false about the scans specifically, which reach
// intake.js's callIntakeStepWithRotation -> a BLOCKING `claude` spawnSync measured at 3-3.5
// minutes on the live daemon's own journal). Running that inside the DISPATCHER's own loop -- the
// process that also refills worker slots, services SIGTERM, and holds the single-instance lock --
// would freeze all three for the whole call. So this function is no longer "drain, then scan" in
// one process; it is JUST the scan half, run in its OWN process (daemon.js --scanner), spawned
// and supervised by dispatcher.js exactly like a worker (see that file's header for the
// supervision/respawn/breaker design). This function therefore now has exactly ONE caller:
// daemon.js's `--scanner` branch. `queueDir` is still a parameter -- the scans themselves still
// need it (orphanScan's queued-id check, unparkScan/reEnqueueTask's retry re-enqueue) -- it is
// only the DRAINING of it that moved out.
//
// Never takes the single-instance lock (daemon.js's own --scanner branch skips acquireLock, same
// posture --worker mode already has for the identical reason: K of these each trying to take it
// would defeat the point, and here there is exactly one scanner anyway, supervised by the
// dispatcher that DOES hold it).
async function runForever(queueDir, journalRoot, config) {
  const timers = createScanTimers();

  // action 2.7: one comment-scan.js scanState PER SCANNER, created ONCE here (not inside the
  // for(;;) below) so the collaborator-login cache and the per-issue backoff table both survive
  // across poll cycles -- see comment-scan.js's own header for why either living only as long as
  // one unparkScan/reportConfirmScan call would defeat their own purpose (a cache that resets
  // every cycle is not a cache; a backoff that resets every cycle never backs off). This survival
  // is exactly WHY the rejected "spawn a fresh child per scan cycle" fix was wrong: a fresh
  // process would mean a fresh, empty scanState every cycle, destroying both.
  const scanStates = { unpark: createScanState(), reportConfirm: createScanState() };

  // Started once, outside the for(;;) below, on its own setTimeout chain -- see
  // startRemoteReportPullLoop's own header. Already independent of the rest of this loop before
  // this correction (it never waited on drainQueueOnce either), so it needs no change here beyond
  // living in what is now a dedicated process.
  if (config.real) {
    startRemoteReportPullLoop(journalRoot, config, config.deps || {});
  }

  for (;;) {
    // PARENT-LIVENESS (action 6.6 verification, Task 2). dispatcher.js spawns this process
    // `detached: true` -- required for a WORKER, whose process group must be reachable by
    // `kill(-pid)` so a killed card never orphans a still-spending `claude` grandchild. For a
    // scanner the same flag has a second, unwanted consequence: this `for(;;)` never returns on
    // its own, so a dispatcher that dies WITHOUT killing its group (a crash, not a
    // `systemctl stop` -- KillMode=control-group covers the unit case) leaves this loop running
    // unsupervised forever. Measured before this check existed: four such orphans, alive 1h22m
    // after the run that spawned them, pointed at deleted /tmp roots. Worse than litter, because
    // the unit is `Restart=always`: systemd starts a new dispatcher, that dispatcher spawns its
    // own scanner, and now TWO scanners run the same timers against the same journal root --
    // duplicate unpark scans, duplicate report intake, and two independent auto-pull watermark
    // computations racing one queue, which is precisely the invariant action 6.6 exists to hold.
    //
    // `process.ppid !== parentPid` is an EXACT test of "my parent died", not a heuristic: the
    // kernel reparents an orphan the instant its parent exits, so the value changes if and only
    // if the dispatcher is gone. Compared, never probed with `kill(pid, 0)`, so a recycled pid
    // cannot resurrect a dead parent; and correct where the dispatcher is itself pid 1, which a
    // bare `process.ppid === 1` test would get backwards. config.parentPid is null for a
    // hand-run `daemon.js --scanner` (daemon.js only sets it from --parent-pid, which only
    // dispatcher.js passes), and a null parent is never watched.
    //
    // Checked once per iteration, which bounds an orphan's remaining life by ONE scan cycle
    // rather than by nothing. It cannot be tightened with a timer: runScanCycle reaches
    // intake.js's blocking `spawnSync('claude', ...)` (measured at 3m24.9s on the live daemon),
    // and no timer fires in a single-threaded process that is blocked inside a sync call. One
    // cycle of duplicate scanning is survivable; forever is not.
    if (Number.isInteger(config.parentPid) && config.parentPid > 0 && process.ppid !== config.parentPid) {
      appendDaemonEvent(journalRoot, 'scanner-orphan-exit', {
        parentPid: config.parentPid,
        ppid: process.ppid,
      });
      return;
    }

    await runScanCycle(timers, queueDir, journalRoot, config, scanStates);
    await sleep(config.pollIntervalMs);
  }
}

module.exports = {
  HANDLERS,
  runTask,
  listQueueFiles,
  takeNextTask,
  drainQueueOnce,
  runForever,
  createScanTimers, // exported for dispatcher.js -- action 6.3's own loop drives runScanCycle directly
  runScanCycle, // exported for dispatcher.js -- see this function's own header
  callLlmStep, // exported for direct unit tests of the account-rotation retry loop (real mode)
  buildCtx,
  finalizePark, // exported for orphan-scan.js -- reparking an orphan reuses the exact same park
  snapshot, // exported for orphan-scan.js -- read the same shape it writes, without duplicating it
  isRealMode, // exported for orphan-scan.js -- shadow/dry-run must detect-and-journal only, never park
};
