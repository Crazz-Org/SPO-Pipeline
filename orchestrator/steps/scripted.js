'use strict';
// scripted.js -- the "spawn a command, return {exit, stdoutTail}" step interface.
//
// Shadow mode (ctx.shadowMode === true): never spawns anything. Reads the next value for
// `fixtureKey` from the task's shadow fixture (see fixture.js) as the exit code, optionally
// preceded by an artificial delay read from `delays.<fixtureKey>` (ms) -- used by the step-
// deadline test to simulate a slow step without a real subprocess.
//
// ctx.dryRun (daemon.js's --dry-run flag, real-mode semantics without spawning): every scripted
// step is "fixture-free assumed success" -- exit 0, no command run -- so a synthetic card can
// walk the whole lifecycle to DONE with zero subprocesses. This is the scripted-step half of
// --dry-run; the LLM half (building the filled prompt + argv without spawning `claude`) lives in
// steps/llm.js's runLlm.
//
// Real mode (ctx.shadowMode === false && ctx.dryRun === false, daemon.js's --real flag or a
// direct unit test): one function per orchestrator state that has scripted work (realWorktree,
// realCheck, realPushPr, realGate, realCiChecks, realMerge, realFinish below), each building the
// exact product npm-alias / git / gh argv the state needs, spawning it through the same
// injectable-runner pattern steps/llm.js already uses (`deps.spawnSync`, production code never
// passing it -- see invokeClaudeReal), and judging the result on its exit code alone (principle
// 1, doc/state-machine-spec.md). Every spawn journals a compact {state, argv (first 6 tokens),
// exit, ms} event via appendEvent and appends its stdout (falling back to stderr) tail to
// journal/<id>/logs/<STATE>.log -- see spawnStep. state-machine.js's handlers dispatch to these
// functions instead of the generic runScripted()+fixture path once neither shadow nor dry-run
// applies; runScripted() itself is otherwise unchanged from the shadow-mode skeleton.
//
// orchestrator/README.md "Real scripted steps" is the narrative walkthrough (ordering, cwd
// policy, the WORKTREE claim-after-worktree-creation rule, --real).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { appendEvent, writeBenchReinstallOwed, readBenchReinstallOwed, clearBenchReinstallOwed } = require('../journal');
const { ParkSignal } = require('../park-signal');
const { classifyCiFailure } = require('../ci-cause-table');
const { resolveMainMovedRegateBudget } = require('../main-moved-budget');
const { moveCard } = require('../board');
const { classifyCommand, classTimeoutMs, isSpawnTimeout } = require('../command-timeout');
const {
  acquireProductRepoLock,
  releaseProductRepoLock,
  ProductRepoLockTimeoutError,
} = require('../product-repo-lock');
const { diffPath, gateLogPath, gateReportPath, lastResultPayload, lastInvariantsBaseline } = require('../task-values');
const { checkRegressions } = require('../invariants');
const { summarizeTask, formatAttemptLines, formatDuration } = require('../task-summary');
const { formatTokenCount } = require('../tokens');

function lastLines(text, n = 20) {
  if (!text) return '';
  return text.split('\n').slice(-n).join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScripted(ctx, fixtureKey, opts = {}) {
  const { defaultExit = 0, command = null, args = [] } = opts;

  if (ctx.shadowMode) {
    const exit = ctx.fixture(fixtureKey, defaultExit);
    const delay = ctx.fixture(`delays.${fixtureKey}`, 0);
    if (delay > 0) await sleep(delay);
    return { exit, stdoutTail: `[shadow] ${fixtureKey} -> exit ${exit}` };
  }

  if (ctx.dryRun) {
    return { exit: 0, stdoutTail: `[dry-run] ${fixtureKey} -> assumed success` };
  }

  if (!command) {
    throw new Error(
      `scripted.js: no real command configured for "${fixtureKey}" -- non-shadow execution ` +
        `is not implemented in this skeleton (shadow mode only for now).`
    );
  }
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const exit = result.status === null || result.status === undefined ? 1 : result.status;
  return { exit, stdoutTail: lastLines(result.stdout || result.stderr || '') };
}

// ---- real mode: shared spawn primitive --------------------------------------------------

// `deps.spawnSync` is the test injection point (same convention as steps/llm.js's
// invokeClaudeReal) -- production code never passes it, so a real call always spawns the real
// binary on PATH.
function runSync(deps, command, args, opts = {}) {
  const spawnSyncFn = (deps && deps.spawnSync) || spawnSync;
  return spawnSyncFn(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function appendSpawnLog(taskDir, state, header, text) {
  const dir = path.join(taskDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${state}.log`);
  fs.appendFileSync(file, `----- ${header} -----\n${text || ''}\n\n`);
}

// ---- action 2.1: per-command-class timeouts + timeout-vs-exit-1 disambiguation ------------
//
// classifyCommand(command, args) -> one of config.commandTimeoutsMs's keys, or null -- and
// classTimeoutMs(config, commandClass) -> the millisecond value for that class. Both now live in
// ../command-timeout.js (action 2.1b), not here: that action found four OTHER modules
// (board.js, park-loop.js, report-intake.js, intake.js) that spawn real git/gh/npm commands
// through their own private runSync instead of this file's spawnStep, and needed the identical
// classification -- board.js in particular is required BY this file (`../board`, above), so
// having board.js require the classifier back out of this file would be circular. Re-exported
// below (`module.exports`) so every existing caller/test of this file's own classifyCommand is
// unaffected by the move.
//
// Every spawnStep call site in this file passes a LITERAL command string ('git' | 'npm' | 'gh')
// -- only the args vary, and always as a plain array (never something classification has to
// evaluate at runtime beyond args[0]/args[1]) -- so this is a pure, total function over the 48
// call sites as they exist today. `npm run gate` gets its own class (the plan's calibration);
// every other `npm run <alias>` (typecheck, lint, coverage:changed, board:take, board:move,
// pr:wait) shares 'npm-run' -- see config.js's own comment on why that default is bounded below
// by pr:wait's internal budget. An unrecognized (command, args) pair returns null, meaning "no
// class default" -- spawnStep then arms no timeout unless the caller passed an explicit
// opts.timeout, exactly like before this action.

// One single spawnSync attempt: runs the command, maps the result to {exit, timedOut, ...}, and
// journals it. Split out of spawnStep (below) so the retry-once policy can call this twice
// without duplicating the exit-mapping/journal/log logic -- and so a test can see both attempts
// as two distinct 'spawn' events (attempt: 1, attempt: 2) explaining a park.
//
// THE TRAP THIS FUNCTION EXISTS TO CLOSE: spawnSync on a `timeout` kill sets BOTH
// `result.signal` (the kill signal, SIGTERM here) AND `result.error` (an Error with
// `.code === 'ETIMEDOUT'`) -- exactly steps/llm.js's invokeClaudeReal already had to learn the
// hard way (card #449, that file's own comment). The pre-existing code here mapped
// `status: null` (which a timeout kill also produces) straight to exit 1, indistinguishable
// from a genuine failure -- so a timeout-killed GATE (exit 1 -> DIAGNOSE) paid a real LLM call
// to diagnose a hang. `timedOut` is therefore branched FIRST, before the exit mapping, mirroring
// llm.js's own `killedByDeadline` idiom (not a new third convention). A bare `signal` with NO
// timeout armed (an operator's kill -9, an OOM kill) is deliberately NOT a timeout -- same
// `deadlineArmed` guard llm.js uses -- and falls through to the pre-existing `error -> exit -1`
// / `status: null with no error/signal -> exit 1` branches, unchanged.
function spawnOnce(ctx, deps, state, command, args, spawnOpts, { commandClass, timeoutMs, attempt }) {
  const start = Date.now();
  const result = runSync(deps, command, args, spawnOpts);
  const ms = Date.now() - start;

  const deadlineArmed = typeof spawnOpts.timeout === 'number';
  const timedOut = isSpawnTimeout(result, deadlineArmed);

  let exit;
  if (timedOut) {
    exit = -1; // never routed on -- callers must check `timedOut` before looking at `exit` at all
  } else if (result && result.error) {
    exit = -1;
  } else {
    exit = result.status === null || result.status === undefined ? 1 : result.status;
  }

  const stdout = (result && result.stdout) || '';
  const stderr = (result && result.stderr) || '';
  const tail = lastLines(stdout || stderr);

  appendEvent(ctx.taskDir, state, 'spawn', {
    argv: [command, ...args].slice(0, 6),
    exit,
    ms,
    attempt,
    commandClass: commandClass || null,
    timeoutMs: deadlineArmed ? timeoutMs : null,
    timedOut,
    signal: (result && result.signal) || null,
  });
  appendSpawnLog(ctx.taskDir, state, [command, ...args].join(' '), stdout || stderr);

  return {
    exit,
    stdout,
    stderr,
    stdoutTail: tail,
    ms,
    timedOut,
    commandClass: commandClass || null,
    timeoutMs: deadlineArmed ? timeoutMs : undefined,
    signal: (result && result.signal) || null,
  };
}

// Spawns one real command for `state`. The one place every real command in this file actually
// runs -- unchanged call signature for all 48 existing call sites.
//
// Arms spawnSync's own `timeout` (the only real defence against a hung child -- see this
// module's header and config.js's commandTimeoutsMs comment): classifyCommand's class default,
// unless the caller passed an explicit `opts.timeout`, which always wins.
//
// Retry-once-then-park (action 2.1(c)): ONLY on a timeout, never on a genuine non-zero exit or
// spawn error (those return to the caller exactly as before, unretried -- a caller's own routing
// on exit codes is completely unchanged). Chosen to live HERE, at the single choke point every
// real command already passes through, rather than as a per-call-site wrapper: duplicating a
// retry policy at every call site (62 and counting; or worse, at only some of them) is exactly the kind of drift
// this file's own "one place every real command runs" design already exists to avoid, and every
// caller already treats spawnStep's return as the final word on one command's outcome.
//
// Idempotency of the retried command was audited call-site by call-site rather than assumed:
//   - Every `git` command here is either read-only (rev-parse/diff/status/list) or naturally
//     idempotent on a retry (`push` reports "up to date" / fails cleanly on a real divergence
//     rather than duplicating a ref; `worktree remove`/`branch -D`/`merge-base --is-ancestor`
//     are all safe to repeat; `commit` on a tree with nothing staged fails harmlessly rather
//     than double-committing).
//   - `gh pr create` (PUSH_PR): GitHub itself refuses a second PR for the same head branch
//     ("A pull request ... already exists") -- a retry after a timeout either creates the ONE
//     pr (if the first attempt's network call never actually landed) or fails cleanly into the
//     existing push-pr-failed park (if it did land server-side despite the local hang).
//   - `npm run board:take` (WORKTREE): SPO-WebClient's board-take.sh is explicitly documented
//     idempotent -- exit 0 with "(already held)" on a re-run that already succeeded.
//   - `gh pr merge` (MERGE): re-enqueuing an already-enqueued/merged PR is a GitHub-side no-op
//     or a clean non-zero exit, never a second merge.
//   - The one call this audit does NOT fully close: `gh issue comment` (FINISH). Issue comments
//     have no server-side dedup, so a retry after a timeout whose first attempt's network call
//     actually succeeded could in principle post a duplicate "Merged via ..." comment. This is
//     cosmetic (never a second PR, branch, merge, or claim) and journaled like every other
//     attempt, so it is visible if it ever happens -- but it is a real, not fully eliminated,
//     residual risk, called out here rather than silently assumed away.
function spawnStep(ctx, deps, state, command, args, opts = {}) {
  const config = (ctx && ctx.config) || {};
  const commandClass = classifyCommand(command, args);
  const timeoutMs = opts.timeout !== undefined ? opts.timeout : classTimeoutMs(config, commandClass);
  const spawnOpts = timeoutMs === undefined ? opts : { ...opts, timeout: timeoutMs };

  const first = spawnOnce(ctx, deps, state, command, args, spawnOpts, { commandClass, timeoutMs, attempt: 1 });
  if (!first.timedOut) return first;

  // `npm run gate` is the one command here that must NOT be retried. It submits a job to the
  // live bench, and job.ts refuses a second job for the same (worktree, ref) while the first is
  // still queued -- DuplicateJobError -> cli.ts exit 2 -> realGate's ParkSignal('gate-dirty-tree'),
  // a reason describing a dirty worktree that is in fact perfectly clean. spawnSync's timeout
  // kills only the direct child, so the orphaned `node cli.js wait` grandchild keeps the first
  // job alive and makes that refusal near-certain rather than a race. With npm-gate's timeout now
  // derived from the bench's own 7200s bound (config.js), reaching this line at all means the
  // bench itself is wedged -- a retry cannot help, and parking honestly is the better answer.
  if (commandClass === 'npm-gate') {
    throw new ParkSignal('npm-gate-timed-out', {
      state,
      argv: [command, ...args].slice(0, 6),
      commandClass,
      timeoutMs,
      retried: false,
      detail: 'not retried: re-running `npm run gate` re-submits a bench job for the same (worktree, ref)',
    });
  }

  // R2 (post-verification, third pass): `bash scripts/bench-install.sh` must NOT be retried
  // either, for the IDENTICAL mechanics npm-gate's own comment just above already names --
  // spawnSync's timeout kills only the direct child (`bash`), never any grandchild it spawned.
  // bench-install.sh's own body runs `npm run build:e2e` (a `tsc` compile into `productRepo`'s
  // shared `dist/`) followed by `systemctl --user restart spo-bench-worker.service`; a killed
  // `bash` can leave `tsc` (or, past that point, the restarted worker itself) still running, and
  // a retry immediately starts a SECOND `npm run build:e2e` writing into the SAME `dist/`
  // directory plus a SECOND `systemctl restart` racing the first -- two concurrent builds landing
  // in one output directory is exactly "installs the wrong binary and reports success", the
  // defect class this whole action exists to close, reproduced by the retry policy meant to make
  // spawnStep more resilient. Not transient-retryable either way: a `bench-install` timeout means
  // `npm run build:e2e` (or the restart) is taking longer than SPO_TIMEOUT_BENCH_INSTALL_MS
  // (900000ms / 15 min, generous already), and a second attempt cannot make that faster.
  if (commandClass === 'bench-install') {
    throw new ParkSignal('bench-install-timed-out', {
      state,
      argv: [command, ...args].slice(0, 6),
      commandClass,
      timeoutMs,
      retried: false,
      detail: 'not retried: a killed `bash` can leave `npm run build:e2e`/`systemctl restart` still running underneath it, so a second attempt would build into the same dist/ concurrently',
    });
  }

  const second = spawnOnce(ctx, deps, state, command, args, spawnOpts, { commandClass, timeoutMs, attempt: 2 });
  if (!second.timedOut) return second;

  // Both attempts killed by the same timeout -- a dedicated park reason naming the command
  // class, never the caller's own failure reason (a caller must not be able to mistake this for
  // its own domain failure -- e.g. realGate's exit-1 -> DIAGNOSE routing never even sees this,
  // because spawnStep never returns in this branch). Both 'spawn' events above already journaled
  // attempt 1 and 2 with timedOut: true, so the journal explains the park on its own.
  throw new ParkSignal(`${commandClass || 'command'}-timed-out`, {
    state,
    argv: [command, ...args].slice(0, 6),
    commandClass,
    timeoutMs,
  });
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function splitLines(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---- shared: nightly-verdict semantics (action B3.2) ---------------------------------------
//
// One classification, three states, read by every real-mode consumer of
// `<spoBenchDir>/nightly/latest.json` in this file (realWorktree's own nightly-main-red check
// and guardNightlyRed below, shared by CI_CHECKS' and GATE's main-moved paths) -- mirrored,
// case for case, by SPO-WebClient's `scripts/nightly-check.sh` (the human-facing
// `npm run bench:nightly` probe over the SAME file, from the other repo). The two cannot share
// one implementation across the repo boundary (bash vs. Node, two separate repos, no shared
// runtime, no package either would take a cross-repo dependency on) -- kept in sync by hand,
// each side's header pointing at the other's, rather than by import. Before this action, this
// file itself had already drifted from ONE implementation into an inline duplicate a second
// time (realWorktree's own read-compare-throw next to this function, below) -- exactly the
// class of copy this comment used to warn about while itself being a second copy. Both real-mode
// call sites now go through classifyNightly.
//
// - 'green'   -- a positive attestation that `main` AT THIS EXACT SHA passed: verdict PASS, a
//                sha recorded, and it equals the sha being asked about.
// - 'red'     -- a positive attestation that `main` AT THIS EXACT SHA failed: verdict FAIL, a
//                sha recorded, and it equals the sha being asked about. This is the only state
//                a merge-onto-main decision refuses over.
// - 'unknown' -- everything else: no file, unreadable/malformed JSON, no verdict field, an
//                unrecognised verdict, a verdict that by design attests nothing about main
//                (worker.ts's own NON_ATTESTING -- DIRTY/ENVIRONMENT/ABANDONED -- plus
//                INTERRUPTED/BLOCKED/STALE/LEASED, none of which NON_ATTESTING covers), or a
//                PASS/FAIL recorded for a DIFFERENT sha than the one being asked about. A sha
//                mismatch is the routine case, not corruption -- it means "unproven for the sha
//                in question", never "broken" and never "clean". This is NOT because nightly runs
//                at most once a day (NIGHTLY_MIN_GAP_MS, nightly.ts, governs only the periodic
//                window path): nightlyDue also re-fires on a main-moved event, rate-limited at
//                just NIGHTLY_MOVE_RATE_LIMIT_MS = 15 minutes (nightly.ts), so the nightly runs
//                several times a day in practice -- five drives on 2026-09-02 alone. A mismatch
//                is routine because proving a *freshly-arrived* tip still takes time: measured
//                over that day, two of five origin/main tips were superseded before any nightly
//                ever proved them, and the fastest proof took 7 minutes. Never silently folded into
//                'green' (the old bug this action fixes) or into 'red' (the inversion the plan
//                explicitly warns against) -- see each caller below for what 'unknown' costs it.
const NIGHTLY_NON_ATTESTING_VERDICTS = new Set([
  'ENVIRONMENT',
  'INTERRUPTED',
  'BLOCKED',
  'DIRTY',
  'ABANDONED',
  'STALE',
  'LEASED',
]);

function classifyNightly(nightly, targetSha) {
  if (!nightly || typeof nightly !== 'object') {
    return { status: 'unknown', reason: 'no nightly result on file' };
  }
  const verdict = nightly.verdict;
  if (!verdict) {
    return { status: 'unknown', reason: 'nightly result carries no verdict field' };
  }
  if (NIGHTLY_NON_ATTESTING_VERDICTS.has(verdict)) {
    return { status: 'unknown', reason: `nightly verdict ${verdict} proves nothing about main` };
  }
  if (verdict !== 'PASS' && verdict !== 'FAIL') {
    return { status: 'unknown', reason: `unrecognised nightly verdict ${verdict}` };
  }
  // `nightly.sha` is read from a file another repo writes -- never assume it is a string just
  // because it is truthy (a number, an object, `true`, ... are all valid JSON and all crash
  // `.slice`). A non-string sha can never equal targetSha anyway, so it is unknown either way;
  // the only change here is not throwing on the way to that answer.
  const shaIsString = typeof nightly.sha === 'string' && nightly.sha.length > 0;
  if (!shaIsString || nightly.sha !== targetSha) {
    const got = shaIsString ? nightly.sha.slice(0, 8) : '(no sha)';
    const want = targetSha ? targetSha.slice(0, 8) : '(none)';
    return {
      status: 'unknown',
      reason: `nightly ${verdict} recorded for ${got}, not the sha in question (${want})`,
    };
  }
  return verdict === 'PASS'
    ? { status: 'green', reason: 'nightly PASS at this exact sha' }
    : { status: 'red', reason: 'nightly FAIL at this exact sha' };
}

// "Is origin/main itself red right now" guard (action 4.2, semantics fixed by action B3.2).
//
// Both CI_CHECKS' main-moved path and GATE's own main-moved path (GATE section below) merge
// `origin/main` into the branch when it has moved during the task -- and both need the identical
// refusal when `origin/main`'s own tip is currently failing the nightly build: merging a
// known-red `main` into an otherwise-passing branch would poison the very signal CHECK/GATE
// exists to produce with a failure that has nothing to do with the task's own code. Before
// action 4.2 this read-compare-throw existed once, inline in realCiChecks; GATE needed the exact
// same check for its own main-moved path (a FAIL verdict with no baseMain -- see that section's
// header comment), and copying the three lines a second time is exactly the kind of drift
// CLAUDE.md's own `gh api -f` story warns about: one wrong copy can silently outlive a fixed one
// for months. Factored out so both call sites share one definition of "red".
//
// action B3.2: only 'red' blocks -- unchanged from before, and deliberately so. 'unknown' does
// NOT block, and this is called from the main-moved path specifically -- CI_CHECKS' and GATE's
// own re-merge, which runs seconds after `origin/main` is observed to have moved during the task.
// By construction it is asking about a sha that has JUST appeared, and proving a fresh tip takes
// real time (see classifyNightly's own header comment for why -- it is the 15-minute main-moved
// rate limit, not a once-daily cadence). Measured directly against the 2026-09-02 corpus: of the
// five origin/main tips that day, this guard would have classified 'unknown' for all five (two
// were superseded before ever being nightly-proven; the fastest proof took 7 minutes) -- so
// treating 'unknown' as a merge refusal here would park essentially every main-moved merge on
// timing, not on any evidence anything is wrong. That mirrors an existing
// precedent in this same file: GATE's own unreadable verdict is journalled
// (`gate-verdict-unreadable`) and treated as "proceed", never parked, because "a failed
// diagnostic must not become the thing that parks the card" (see realGate below). What action
// B3.2 changes is that 'unknown' is no longer silently indistinguishable from 'green' the way it
// used to be (a stale FAIL used to fall through this function's old FAIL-and-sha-match check
// exactly like a genuine PASS did) -- it is now classified, and journalled, as what it is.
function guardNightlyRed(ctx, stepName, config, originMainSha) {
  const nightly = readJsonSafe(path.join(config.spoBenchDir, 'nightly', 'latest.json'));
  const { status, reason } = classifyNightly(nightly, originMainSha);
  if (status === 'red') {
    throw new ParkSignal('main-red-no-merge', {});
  }
  if (status === 'unknown') {
    appendEvent(ctx.taskDir, stepName, 'nightly-unknown', { sha: originMainSha, reason });
  }
}

// ---- judge inputs: diff.patch / gate.log / gate-report.md (action 1.3) --------------------
//
// task-values.js declares three fixed paths (diff_path/gate_log_path/gate_report_path) for the
// DIAGNOSE and VALIDATE prompts, but until this action no step ever produced the files at those
// paths -- the judges ran against files that did not exist. prepareJudgeInputs is the one place
// that now generates them, called from handleDiagnose/handleValidate (state-machine.js) under
// isRealMode(ctx), before the LLM call.

// Renders a bench verdict JSON (`<spoBenchDir>/verdicts/<headSha>.json`) as small, readable
// markdown for gate-report.md -- never a raw JSON dump. The verdict's exact shape is an external
// contract this repo does not itself define (only `.baseMain` is read elsewhere, by
// realCiChecks); known fields are rendered by name, anything else is kept, verbatim but
// collapsed into one small fenced block, so a judge never loses a field this function didn't
// anticipate.
function renderGateReport(verdict) {
  const lines = ['# Gate report', ''];
  const known = new Set(['verdict', 'sha', 'baseMain', 'summary', 'findings']);

  if (verdict.verdict !== undefined) lines.push(`**Verdict:** ${verdict.verdict}`);
  if (verdict.sha) lines.push(`**SHA:** ${verdict.sha}`);
  if (verdict.baseMain) lines.push(`**Base main:** ${verdict.baseMain}`);
  if (lines.length > 2) lines.push('');

  if (typeof verdict.summary === 'string' && verdict.summary.trim() !== '') {
    lines.push('## Summary', '', verdict.summary.trim(), '');
  }

  if (Array.isArray(verdict.findings) && verdict.findings.length > 0) {
    lines.push('## Findings', '');
    for (const f of verdict.findings) {
      lines.push(`- ${typeof f === 'string' ? f : JSON.stringify(f)}`);
    }
    lines.push('');
  }

  const rest = Object.keys(verdict).filter((k) => !known.has(k));
  if (rest.length > 0) {
    const restObj = {};
    for (const k of rest) restObj[k] = verdict[k];
    lines.push('## Other fields', '', '```json', JSON.stringify(restObj, null, 2), '```', '');
  }

  return lines.join('\n');
}

// prepareJudgeInputs(ctx, deps, {forState: 'DIAGNOSE' | 'VALIDATE'}) -- real mode only, called
// under isRealMode(ctx) right before the LLM call for that state.
//
// (a) diff.patch: `git diff origin/main...HEAD` once the branch carries a commit HEAD differs
//     from origin/main (post-PUSH_PR); plain `git diff` (working tree) beforehand -- DIAGNOSE is
//     reachable from a CHECK failure or an empty IMPLEMENT, both BEFORE any commit, where HEAD
//     still equals origin/main (the branch was cut from it and nothing has committed yet).
//     Untracked files never appear in a `git diff` -- a trailing section lists
//     `git status --porcelain`'s own `??` lines so a judge can see a file was created but never
//     staged. Written even when the diff itself is empty (the empty-IMPLEMENT case IS a
//     finding); an empty diff is journaled, not treated as failure to produce one.
// (b) gate.log: never generated here -- realGate (above) is the only writer, overwriting on
//     every real gate run. This function only checks whether the file already exists on disk.
// (c) gate-report.md: rendered from `<spoBenchDir>/verdicts/<headSha>.json` via the same
//     readJsonSafe idiom realCiChecks already uses for the very same file. Optional: absent when
//     the bench hasn't recorded a verdict for this HEAD yet, never fatal.
//
// Requirement rules (doc/state-machine-spec.md's "CHECK Failure -> DIAGNOSE, never PARKED"):
//   - VALIDATE always requires diff.patch -- unproducible -> ParkSignal('judge-inputs-missing',
//     {step: 'VALIDATE', missing: ['diff.patch']}).
//   - DIAGNOSE requires gate.log ONLY when ctx.cameFrom === 'GATE' (state-machine.js's runTask
//     threads the previous state through) -- unproducible there ->
//     ParkSignal('judge-inputs-missing', {step: 'DIAGNOSE', missing: ['gate.log']}). From any
//     other entry point (CHECK failure, empty IMPLEMENT, CI_CHECKS-unmatched) a missing gate.log
//     is expected (no gate has run yet) and is journaled, never parked.
//
// Every input, produced or absent, is journaled as one 'judge-inputs-prepared' event so a
// judge's verdict can be audited afterwards against what it could actually see.
function prepareJudgeInputs(ctx, deps, { forState }) {
  const config = ctx.config;
  const worktreePath = ctx.task && ctx.task.worktreePath;
  const produced = [];

  // -- (a) diff.patch ---------------------------------------------------------------------------
  let diffProduced = false;
  let headSha = null;
  if (worktreePath) {
    const headRes = spawnStep(ctx, deps, forState, 'git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
    if (headRes.exit === 0) {
      headSha = headRes.stdout.trim();
      const mainRes = spawnStep(ctx, deps, forState, 'git', ['-C', worktreePath, 'rev-parse', 'origin/main']);
      if (mainRes.exit === 0) {
        // Committed-vs-not by sha comparison. Exact while the daemon drains one task at a
        // time: origin/main only moves in the shared .git when WORKTREE fetches, so within a
        // run HEAD == origin/main means "IMPLEMENT has not committed yet". Under chantier 6's
        // K workers this stops being exact -- a sibling worker's fetch can advance origin/main
        // while this branch still has no commit of its own, and `diff origin/main...HEAD` would
        // then resolve merge-base == HEAD and hand the judge an EMPTY patch over a full working
        // tree. Replace with `git rev-list --count origin/main..HEAD` (0 == not committed),
        // which is exact regardless of what origin/main does, when 6.4's product-repo mutex
        // lands. Not changed now: unreachable single-threaded, and it would churn every
        // judge-input test's fake spawn for a race that does not yet exist.
        const committed = headSha !== mainRes.stdout.trim();
        const diffArgs = committed
          ? ['-C', worktreePath, 'diff', 'origin/main...HEAD']
          : ['-C', worktreePath, 'diff'];
        const diffRes = spawnStep(ctx, deps, forState, 'git', diffArgs);
        if (diffRes.exit === 0) {
          const isEmpty = (diffRes.stdout || '').trim() === '';
          let content = diffRes.stdout || '';

          const statusRes = spawnStep(ctx, deps, forState, 'git', ['-C', worktreePath, 'status', '--porcelain']);
          const untracked =
            statusRes.exit === 0 ? splitLines(statusRes.stdout).filter((l) => l.startsWith('??')) : [];
          if (untracked.length > 0) {
            content +=
              (content === '' ? '' : content.endsWith('\n') ? '\n' : '\n\n') +
              '----- untracked (git status --porcelain; NOT part of the diff above) -----\n' +
              untracked.join('\n') +
              '\n';
          }

          fs.writeFileSync(diffPath(ctx.taskDir), content);
          produced.push('diff.patch');
          diffProduced = true;
          if (isEmpty) appendEvent(ctx.taskDir, forState, 'diff-empty', { committed });
        }
      }
    }
  }

  // -- (b) gate.log -- existence check only, realGate is the sole writer -----------------------
  const gateLogProduced = fs.existsSync(gateLogPath(ctx.taskDir));
  if (gateLogProduced) produced.push('gate.log');

  // -- (c) gate-report.md -- optional, from the bench's own verdict for this HEAD sha ----------
  let gateReportProduced = false;
  if (headSha && config && config.spoBenchDir) {
    const verdict = readJsonSafe(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`));
    if (verdict) {
      fs.writeFileSync(gateReportPath(ctx.taskDir), renderGateReport(verdict));
      produced.push('gate-report.md');
      gateReportProduced = true;
    }
  }

  const missing = ['diff.patch', 'gate.log', 'gate-report.md'].filter((f) => !produced.includes(f));
  appendEvent(ctx.taskDir, forState, 'judge-inputs-prepared', {
    forState,
    cameFrom: ctx.cameFrom || null,
    produced,
    missing,
  });

  if (forState === 'VALIDATE' && !diffProduced) {
    throw new ParkSignal('judge-inputs-missing', { step: 'VALIDATE', missing: ['diff.patch'] });
  }
  if (forState === 'DIAGNOSE' && ctx.cameFrom === 'GATE' && !gateLogProduced) {
    throw new ParkSignal('judge-inputs-missing', { step: 'DIAGNOSE', missing: ['gate.log'] });
  }

  return { produced, missing, diffProduced, gateLogProduced, gateReportProduced };
}

// ---- WORKTREE ------------------------------------------------------------------------------
//
// fetch origin -> refuse if the nightly says main is red -> `git worktree add` off origin/main
// -> `npm ci` (a product worktree carries no node_modules) -> THEN claim the card
// (`npm run board:take`). Claim runs last, from inside the fresh worktree, because the npm
// aliases need a product cwd and the human's main SPO-WebClient checkout must never run them --
// see orchestrator/README.md "Real scripted steps" for the rationale in full.

// git worktree list --porcelain prints one `worktree <path>` line per registered worktree
// (plus HEAD/branch/bare lines this caller doesn't need). Paths are compared resolved -- git
// prints an absolute, symlink-resolved path, and `worktreePath` here is built from config, so
// normalize both sides before comparing rather than assume they're already byte-identical.
function worktreeListPaths(porcelainOutput) {
  return (porcelainOutput || '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length).trim()));
}

// card #424 -- "retry always restarts at INTAKE" bit us three times today: runTask always
// restarts a task at INTAKE (state-machine.js), so retrying anything parked past WORKTREE
// collided with the previous attempt's own worktree/branch and failed worktree-add-failed. The
// pipeline owns the namespace worktrees/<taskId> + branch claude-pipe/<taskId> exclusively (no
// human or other process ever creates either), so within that namespace it may clean its own
// leftovers before trying again -- runTask's restart-at-INTAKE behaviour is otherwise untouched.
// Order matters -- each rule guards the one after it:
//   1. Worktree path leftover (registered in `git worktree list` OR present on disk at the
//      exact task path): a dirty working tree (`git status --porcelain` non-empty) is NEVER
//      destroyed -- it might be uncommitted human-or-unknown work -- and parks
//      worktree-dirty-leftover so a maintainer can look. Clean -> `git worktree remove`, then
//      `git worktree prune` to also clear a stale registration whose directory is already gone
//      (nothing on disk to be dirty in that case, so the status check is skipped for it).
//   2. Local branch leftover (claude-pipe/<id>): deleted with `branch -D` when its tip is an
//      ancestor of origin/main (merged, or the previous attempt never advanced past it), OR
//      equals origin/claude-pipe/<id>'s own tip (fully pushed, nothing local-only), OR is an
//      ancestor of one of this task's own `refs/remotes/origin/wip/<id>-*` refs (preserveWorktreeWip,
//      above, already saved it durably -- this pipeline made that commit and can vouch for it,
//      unlike an arbitrary local-only tip). Anything else means local-only commits exist that
//      this run never produced and cannot vouch for -- parks branch-unmerged-leftover rather
//      than guess.
//   3. Remote branch leftover (origin/claude-pipe/<id>, checked against the fetch this step
//      already ran): this is always a prior, superseded attempt in the pipeline's own namespace,
//      regenerated fresh every pass -- leaving it makes this attempt's own `push -u origin
//      <branch>` (PUSH_PR) non-fast-forward. Unlike step 2, this rule used to delete on nothing
//      but "the ref exists", with none of step 2's safety analysis -- action 4.6, card #455: a
//      remote delete auto-closes any open PR built from that branch as a GitHub side effect, and
//      a retry silently closed a green, merge-ready PR this way (recovered only by a hand-made
//      rescue tag). It now vouches for the tip or preserves it to a `wip/<id>-<ts>` ref, closes
//      any open PR deliberately (`gh pr close`, journalled, never left to the delete's own side
//      effect), and only then deletes -- see the inline comments right above the code for the
//      full account, including why a PR *lookup* failure parks while "no PR found" does not. This
//      step is independent of step 2 (it also runs when there was no local branch left to clean,
//      or when step 2's own remote-tip lookup already answered the same question -- one call is
//      redone here rather than threaded through, so each of the three rules stays independently
//      readable and testable).
//   4. Nothing found at any of the three checks -> no cleanup call is ever issued; the add below
//      runs exactly as it did before this fix.
function sweepWorktreeLeftovers(ctx, deps, { productRepo, worktreePath, branch }) {
  // -- 1. worktree path -----------------------------------------------------------------------
  const list = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'worktree', 'list', '--porcelain']);
  const registered = list.exit === 0 && worktreeListPaths(list.stdout).includes(path.resolve(worktreePath));
  const existsOnDisk = fs.existsSync(worktreePath);

  if (registered || existsOnDisk) {
    if (existsOnDisk) {
      const status = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', worktreePath, 'status', '--porcelain']);
      if (status.exit !== 0 || status.stdout.trim() !== '') {
        // A dirty leftover is, by construction, a previous attempt's own uncommitted work (this
        // namespace is pipeline-exclusive -- see the header above): push it to a durable wip/
        // ref before ever destroying the worktree, rather than parking and leaving the diff to
        // depend on this local directory surviving. Only fall back to the old park-and-wait
        // behaviour if that preservation itself fails (no network, origin refuses, ...) -- never
        // destroy what wasn't first saved somewhere durable.
        const preserved = preserveWorktreeWip(ctx, deps, { worktreePath, reason: 'leftover', state: 'WORKTREE' });
        if (!preserved) {
          throw new ParkSignal('worktree-dirty-leftover', { worktreePath, statusExit: status.exit, statusTail: status.stdoutTail });
        }
        appendEvent(ctx.taskDir, 'WORKTREE', 'leftover-wip-preserved', preserved);
      }
      const remove = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'worktree', 'remove', '--force', worktreePath]);
      if (remove.exit !== 0) {
        throw new ParkSignal('worktree-cleanup-failed', { step: 'worktree-remove', exit: remove.exit });
      }
    }
    // Registered-only (directory already gone by some other means) or just-removed above --
    // either way, prune clears the administrative leftover git worktree list would otherwise
    // keep reporting.
    spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'worktree', 'prune']);
    appendEvent(ctx.taskDir, 'WORKTREE', 'leftover-worktree-removed', { worktreePath, wasOnDisk: existsOnDisk });
  }

  // -- 2. local branch --------------------------------------------------------------------------
  const localRef = `refs/heads/${branch}`;
  const localRevParse = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'rev-parse', '--verify', '--quiet', localRef]);
  if (localRevParse.exit === 0) {
    const localSha = localRevParse.stdout.trim();
    const ancestor = spawnStep(ctx, deps, 'WORKTREE', 'git', [
      '-C',
      productRepo,
      'merge-base',
      '--is-ancestor',
      localRef,
      'origin/main',
    ]);
    let safe = ancestor.exit === 0;
    let remoteSha = null;
    if (!safe) {
      const remoteRevParse = spawnStep(ctx, deps, 'WORKTREE', 'git', [
        '-C',
        productRepo,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${branch}`,
      ]);
      remoteSha = remoteRevParse.exit === 0 ? remoteRevParse.stdout.trim() : null;
      safe = remoteSha !== null && remoteSha === localSha;
    }
    // (c) neither (a) nor (b) vouches for this tip -- but a tip already contained in one of this
    // task's own `wip/<id>-*` refs is not a mystery local commit: it's a save this pipeline made
    // itself (preserveWorktreeWip) and pushed durably to origin, so the caution that "a local-only
    // tip cannot be vouched for" does not apply to it. Check every wip ref this task has ever
    // pushed, oldest first, and stop at the first one that contains this tip.
    let wipRef = null;
    let wipRefsChecked = 0;
    if (!safe) {
      const wipRefs = spawnStep(ctx, deps, 'WORKTREE', 'git', [
        '-C',
        productRepo,
        'for-each-ref',
        '--format=%(refname)',
        `refs/remotes/origin/wip/${ctx.id}-*`,
      ]);
      for (const candidate of splitLines(wipRefs.stdout)) {
        wipRefsChecked += 1;
        const covers = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'merge-base', '--is-ancestor', localRef, candidate]);
        if (covers.exit === 0) {
          safe = true;
          wipRef = candidate;
          break;
        }
      }
    }
    if (!safe) {
      throw new ParkSignal('branch-unmerged-leftover', { branch, localSha, remoteSha, wipRefsChecked });
    }
    const del = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'branch', '-D', branch]);
    if (del.exit !== 0) throw new ParkSignal('worktree-cleanup-failed', { step: 'branch-delete', exit: del.exit });
    const deletedDetail = wipRef ? { branch, sha: localSha, coveredByWipRef: wipRef } : { branch, sha: localSha };
    appendEvent(ctx.taskDir, 'WORKTREE', 'leftover-branch-deleted', deletedDetail);
  }

  // -- 3. remote branch -------------------------------------------------------------------------
  // card #455, live: this rule used to be "the ref exists -> `push origin --delete`", full stop
  // -- no safety analysis at all, unlike rule 2 immediately above (which will not touch a LOCAL
  // branch without proving the tip is contained in origin/main, equal to its own remote tip, or
  // covered by one of this task's own wip/<id>-* refs). That asymmetry is the bug: deleting a
  // remote branch on GitHub auto-closes any open PR built from it, as a side effect of the
  // delete rather than a decision anyone made. A retry silently closed a green, merge-ready PR
  // and orphaned its commits; the work survived only because a `rescue/issue-455-run1` tag was
  // made by hand after the fact. This rule is always the pipeline's own, disposable
  // claude-pipe/<id> namespace (see the header above), so the fix is not "never delete" -- it is
  // "vouch for or preserve the tip, and close any PR on purpose, before the delete can do either
  // silently". This mirrors abandonCleanup's own PR-before-branch ordering (park-loop.js, action
  // 4.5) for the exact same GitHub side effect, so the two cleanup paths agree.
  //
  // Do NOT park here instead of deleting when an open PR is found: that is the exact deadlock C2
  // had to fix for rule 2's branch-unmerged-leftover on card #385 -- a maintainer's bare `retry`
  // could only ever reproduce the same park, forever, because the park itself is what the retry
  // hits first every time. Preserving the tip and closing the PR deliberately lets the retry
  // actually make progress (a fresh branch/PR on the next PUSH_PR pass) while destroying nothing
  // that wasn't first made durable or closed on the record.
  const remoteCheck = spawnStep(ctx, deps, 'WORKTREE', 'git', [
    '-C',
    productRepo,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);
  if (remoteCheck.exit === 0) {
    const remoteSha = remoteCheck.stdout.trim();

    // -- 3a. Vouch for the tip, or preserve it, before anything destructive runs. ----------------
    // If the tip is already an ancestor of origin/main, nothing can be lost by deleting the ref
    // that points at it -- the commits live on in main regardless. Otherwise this remote tip
    // carries work origin/main does not have, and it gets one chance to survive: pushed to this
    // task's own `wip/<id>-<ts>` namespace, the exact shape preserveWorktreeWip already uses and
    // rule 2 above already reads back when vouching for a local tip -- reusing it here rather
    // than inventing a second shape keeps "durable save this pipeline made" a single, recognisable
    // pattern across both rules. A failed preserve push (no network, origin refuses, ...) must
    // block the delete entirely: unlike the dirty-worktree case in rule 1, there is no "park and
    // wait" fallback that keeps the ref alive on its own -- so this throws rather than falling
    // through, and deletes nothing.
    let preservedRef = null;
    const ancestorOfMain = spawnStep(ctx, deps, 'WORKTREE', 'git', [
      '-C',
      productRepo,
      'merge-base',
      '--is-ancestor',
      remoteSha,
      'origin/main',
    ]);
    if (ancestorOfMain.exit !== 0) {
      const wipRef = `wip/${ctx.id}-${Date.now()}`;
      const preserve = spawnStep(ctx, deps, 'WORKTREE', 'git', [
        '-C',
        productRepo,
        'push',
        'origin',
        `${remoteSha}:refs/heads/${wipRef}`,
      ]);
      if (preserve.exit !== 0) {
        throw new ParkSignal('worktree-cleanup-failed', { step: 'remote-preserve', exit: preserve.exit });
      }
      preservedRef = wipRef;
      appendEvent(ctx.taskDir, 'WORKTREE', 'leftover-remote-preserved', { branch, sha: remoteSha, ref: wipRef });
    }

    // -- 3b. Close any open PR deliberately, before the delete can close it as an invisible side
    // effect. Same argv shape and JSON-parse defensiveness as realPushPr's own `gh pr list` call
    // further down this file (a non-zero exit or unparsable output there falls through to `gh pr
    // create`; here there is nothing to fall through to, because the very thing being checked is
    // "is it safe to delete" -- so the same two failure shapes must instead refuse the delete).
    // We cannot prove there is no PR from a failed or unreadable lookup, and guessing "no PR" would
    // let the delete close one invisibly -- exactly the bug this rule exists to fix -- so both
    // shapes park rather than proceed.
    const prList = spawnStep(ctx, deps, 'WORKTREE', 'gh', [
      'pr',
      'list',
      '--repo',
      ctx.config.ghRepo,
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number',
    ]);
    let openPrs = null;
    if (prList.exit === 0) {
      try {
        openPrs = JSON.parse(prList.stdout);
      } catch {
        openPrs = null;
      }
    }
    if (!Array.isArray(openPrs)) {
      appendEvent(ctx.taskDir, 'WORKTREE', 'leftover-pr-lookup-failed', { branch, exit: prList.exit });
      throw new ParkSignal('worktree-cleanup-failed', { step: 'remote-pr-lookup', exit: prList.exit });
    }
    let closedPr = null;
    if (openPrs.length > 0) {
      const prNumber = openPrs[0].number;
      const close = spawnStep(ctx, deps, 'WORKTREE', 'gh', ['pr', 'close', String(prNumber), '--repo', ctx.config.ghRepo]);
      if (close.exit !== 0) {
        throw new ParkSignal('worktree-cleanup-failed', { step: 'remote-pr-close', prNumber, exit: close.exit });
      }
      closedPr = prNumber;
      appendEvent(ctx.taskDir, 'WORKTREE', 'leftover-pr-closed', { prNumber, branch });
    }

    // -- 3c. Only now, with the tip vouched-for-or-preserved and any PR closed on purpose, is the
    // delete itself safe to run.
    const del = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'push', 'origin', '--delete', branch]);
    if (del.exit !== 0) throw new ParkSignal('worktree-cleanup-failed', { step: 'remote-branch-delete', exit: del.exit });
    appendEvent(ctx.taskDir, 'WORKTREE', 'remote-branch-cleaned', { branch, sha: remoteSha, preservedRef, closedPr });
  }
}

// preserveWorktreeWip(ctx, deps, {worktreePath, reason, state}) -> {ref, sha} | null
//
// Real mode only. If `worktreePath` has uncommitted changes, detaches HEAD, commits them
// (`git add -A` + a wip(<id>) commit) and pushes to a throwaway `wip/<id>-<ts>` branch on
// origin, so the diff survives independently of the local worktree directory -- see the module
// header and doc/state-machine-spec.md's note on card #385, where 620 lines of IMPLEMENT work
// were stranded in a worktree with no durable copy anywhere else. `wip/` is a deliberately
// different namespace from `claude-pipe/<id>` (the pipeline's own regenerate-and-delete branch):
// sweepWorktreeLeftovers' rules 2/3 assume claude-pipe/<id> is disposable and safe to
// force-delete on the next attempt -- pushing a WIP there would make THIS branch look like an
// unmerged leftover on the very next retry and park branch-unmerged-leftover instead of cleaning
// up.
//
// The detach is not optional housekeeping: this worktree is checked out on `claude-pipe/<id>`,
// and a worktree commit updates whatever branch HEAD currently points to. Committing without
// detaching first would advance `claude-pipe/<id>` locally even though the commit is only ever
// meant to live on the disposable `wip/` ref -- and twelve lines below (in the caller), rule 2 of
// sweepWorktreeLeftovers then finds a claude-pipe/<id> tip it cannot vouch for (not an ancestor
// of origin/main, not equal to origin/claude-pipe/<id>) and parks branch-unmerged-leftover on the
// very commit this function itself just made. That was the loop observed on card #385: four
// rigorously identical parks. Detaching first means the wip commit lands on no branch at all, so
// claude-pipe/<id>'s local pointer never moves and rule 2 finds it exactly where WORKTREE left it.
//
// Never blocks or throws: a park is already terminal by the time finalizePark calls this, and the
// dirty-leftover sweep call site treats a failed preservation as "fall back to the old
// park-and-wait behaviour", not as a harder failure. Returns null (no event beyond the failure
// one, if any) when there is nothing to preserve (no worktree, already clean) or a step failed.
//
// The "never throws" half of that contract is NOT free since action 2.1: every spawnStep below
// now throws ParkSignal('git-timed-out') when the same git command is killed by its own
// spawnSync timeout twice in a row. Uncaught, that throw leaves finalizePark (state-machine.js)
// half-done -- thrown from INSIDE runTask's `catch (ParkSignal)` handler, so state.json is never
// written, report.md/daemon.jsonl/the park comment never happen, the task stays forever in its
// last in-flight state, and the error escapes to daemon.js's main().catch, which exits 1. The
// next start's orphanScan reparks that same task through this same function and dies the same
// way: a crash loop over a single hung `git status` in a parked card's worktree. A timeout here
// is therefore just another failed preservation step -- journaled and null-returned, exactly
// like the non-zero-exit branches below.
function preserveWorktreeWip(ctx, deps, opts = {}) {
  try {
    return preserveWorktreeWipUnguarded(ctx, deps, opts);
  } catch (err) {
    if (!(err instanceof ParkSignal)) throw err;
    appendEvent(ctx.taskDir, opts.state || 'PARKED', 'wip-preserve-failed', {
      step: 'timed-out',
      reason: err.reason,
      argv: err.detail && err.detail.argv,
    });
    return null;
  }
}

function preserveWorktreeWipUnguarded(ctx, deps, { worktreePath, reason, state = 'PARKED' } = {}) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;

  const status = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'status', '--porcelain']);
  if (status.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'wip-preserve-failed', { step: 'status', exit: status.exit });
    return null;
  }
  if (status.stdout.trim() === '') return null; // clean tree -- nothing to preserve

  const detach = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'checkout', '--detach']);
  if (detach.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'wip-preserve-failed', { step: 'detach', exit: detach.exit });
    return null;
  }

  const add = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'add', '-A']);
  if (add.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'wip-preserve-failed', { step: 'add', exit: add.exit });
    return null;
  }

  const messageFile = path.join(ctx.taskDir, 'wip-message.txt');
  fs.writeFileSync(messageFile, `wip(${ctx.id}): parked${reason ? ` -- ${reason}` : ''}\n`);
  const commit = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'commit', '-F', messageFile]);
  if (commit.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'wip-preserve-failed', { step: 'commit', exit: commit.exit });
    return null;
  }

  const revParse = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
  const wipRef = `wip/${ctx.id}-${Date.now()}`;
  const push = spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, 'push', 'origin', `HEAD:refs/heads/${wipRef}`]);
  if (push.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'wip-preserve-failed', { step: 'push', exit: push.exit });
    return null;
  }

  const preserved = { ref: wipRef, sha: revParse.exit === 0 ? revParse.stdout.trim() : null };
  appendEvent(ctx.taskDir, state, 'wip-preserved', preserved);
  return preserved;
}

// ---- action 6.4: product-repo mutex ---------------------------------------------------------
//
// withProductRepoLock(ctx, deps, phase, fn) -- runs `fn` (an async thunk) with the product-repo
// lock held, releasing it in a `finally` on every exit path: a normal return, a ParkSignal thrown
// by `fn`, or any other throw. See product-repo-lock.js's own header for the full rationale, the
// WORST_HOLD_MS/MAX_LOCK_AGE_MS derivation, and why realWorktree (setup) and realFinish
// (teardown), below, share this ONE lock rather than two.
//
// `deps.acquireProductRepoLock`/`deps.releaseProductRepoLock` are the test-injection points, same
// convention as `deps.spawnSync` -- production code never passes them, so a real call always goes
// through the real lock file. `deps.productRepoLockOpts` is forwarded to the REAL acquire call
// untouched (isAlive/now/monotonicNowMs/sleep/waitMs/pollMs/filePath) -- the point a test drives
// the real fs-backed lock with a small waitMs/pollMs or a fake clock without having to fake the
// whole acquire function.
//
// A ProductRepoLockTimeoutError (the wait bound exceeded with the lock never acquired) becomes
// ParkSignal('product-repo-lock-timeout', {phase, waitedMs, workers}) -- a reason that greps
// distinctly from a genuine git failure (worktree-fetch-failed, worktree-add-failed,
// finish-failed/worktree-remove, ...), per the spec's own requirement that a maintainer reading
// `spo parked` can tell mutex starvation from a real git problem at a glance. `phase` disambiguates
// which of the two critical sections (setup vs teardown) a park came from without needing a second
// reason string.
async function withProductRepoLock(ctx, deps, phase, fn) {
  const acquireFn = (deps && deps.acquireProductRepoLock) || acquireProductRepoLock;
  const releaseFn = (deps && deps.releaseProductRepoLock) || releaseProductRepoLock;

  let acquired;
  try {
    acquired = await acquireFn(ctx.config, (deps && deps.productRepoLockOpts) || {});
  } catch (err) {
    if (err instanceof ProductRepoLockTimeoutError) {
      throw new ParkSignal('product-repo-lock-timeout', { phase, waitedMs: err.waitedMs, workers: err.workers });
    }
    throw err;
  }

  try {
    return await fn();
  } finally {
    releaseFn(acquired);
  }
}

// fastForwardMainAndInstall(ctx, deps, config, {state, skipFetch, decideInstall}) -- action B1.4
// round 4: the ONE implementation of "is config.productRepo's checkout safe to build a bench
// binary from, and should bench-install.sh actually run" -- fetch, then refuse (never force)
// unless the checkout is on `main` and clean of TRACKED changes, then `git merge --ff-only
// origin/main`, then -- ONLY once that succeeded AND the caller's own `decideInstall()` says so --
// `bash scripts/bench-install.sh`. realFinish (this card's OWN merge) and
// payBenchReinstallDebtIfOwed (an EARLIER card's deferred debt, paid back from WORKTREE) both call
// THIS function rather than each keeping their own copy of these preconditions -- a second copy is
// precisely the drift CLAUDE.md's own `gh api -f` story is about, and round 3's reconciler
// (orchestrator/bench-reconcile.js, since deleted) shipped with NONE of them, reproducing
// realFinish's own "installs the WRONG binary and reports success" defect from a second door.
//
// `state` is the caller's own step name ('WORKTREE' or 'FINISH') -- every spawnStep/appendEvent
// call below is journalled under it, so the SAME event vocabulary
// (main-fast-forward-failed/main-fast-forwarded/bench-reinstalled/bench-reinstall-failed) reads
// correctly from either caller's journal without a second, parallel vocabulary.
//
// `skipFetch` -- realFinish already ran an UNCONDITIONAL `git fetch origin` of its own (its step 1,
// needed before `gh pr view`'s merge sha and the bench-path diff can be resolved, both of which
// happen BEFORE this function is ever called there) -- so realFinish passes `skipFetch: true` to
// avoid a redundant second fetch, and starts straight at the branch/dirty check.
// payBenchReinstallDebtIfOwed has no such earlier fetch, so it leaves this false.
//
// `decideInstall()` -- called ONLY once the fast-forward has actually succeeded, and must resolve
// to `{install: bool}`. This is where the two callers genuinely differ, so it stays theirs, not
// folded into this function: realFinish's own version waits for the bench to go idle (a BOUNDED
// POLL, waitForBenchIdle) and defers (writeBenchReinstallOwed) rather than install if it never
// does; payBenchReinstallDebtIfOwed's own version checks ONCE, never polls, and leaves the debt
// owed rather than block the card if the bench is busy -- see that function's own header for why.
//
// Returns {ffOk, ffReason, ffDetail, installed, installExit} -- the caller, not this function,
// decides whether a failure PARKS (realFinish, when benchTouched) or is merely journalled and
// left owed (payBenchReinstallDebtIfOwed, always -- this function never throws a ParkSignal
// itself, so a debt repayment can never block the card paying it).
async function fastForwardMainAndInstall(ctx, deps, config, { state, skipFetch, decideInstall }) {
  const productRepo = config.productRepo;

  if (!skipFetch) {
    const fetch = spawnStep(ctx, deps, state, 'git', ['-C', productRepo, 'fetch', 'origin']);
    if (fetch.exit !== 0) {
      appendEvent(ctx.taskDir, state, 'main-fast-forward-failed', { reason: 'fetch-failed', exit: fetch.exit });
      return { ffOk: false, ffReason: 'fetch-failed', ffDetail: { exit: fetch.exit }, installed: false, installExit: null };
    }
  }

  // Same narrowing as this function has always used (`--untracked-files=no`, not bare
  // `--porcelain`) -- config.productRepo is a checkout a HUMAN also works in directly, so a stray
  // untracked file must never refuse a fast-forward `git pull --ff-only` itself would sail
  // through.
  const branch = spawnStep(ctx, deps, state, 'git', ['-C', productRepo, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const onMain = branch.exit === 0 && branch.stdout.trim() === 'main';
  const status = onMain
    ? spawnStep(ctx, deps, state, 'git', ['-C', productRepo, 'status', '--porcelain', '--untracked-files=no'])
    : null;
  const clean = onMain && status.exit === 0 && status.stdout.trim() === '';
  const merge = clean
    ? spawnStep(ctx, deps, state, 'git', ['-C', productRepo, 'merge', '--ff-only', 'origin/main'])
    : null;
  const ffOk = clean && merge.exit === 0;

  // A command that FAILED TO ANSWER (branch.exit/status.exit non-zero) is not the same fact as a
  // tree that genuinely IS dirty or genuinely IS on the wrong branch -- `check-failed` gives that
  // its own value (R3, post-verification third pass) rather than misreporting it as `dirty`/
  // `wrong-branch`.
  const branchCheckFailed = branch.exit !== 0;
  const statusCheckFailed = onMain && status.exit !== 0;

  let ffReason = null;
  let ffDetail = {};
  if (branchCheckFailed) {
    ffReason = 'check-failed';
    ffDetail = { check: 'branch', exit: branch.exit };
  } else if (!onMain) {
    ffReason = 'wrong-branch';
  } else if (statusCheckFailed) {
    ffReason = 'check-failed';
    ffDetail = { check: 'status', exit: status.exit };
  } else if (!clean) {
    ffReason = 'dirty';
  } else if (!ffOk) {
    ffReason = 'not-fast-forwardable';
  }

  if (!ffOk) {
    appendEvent(ctx.taskDir, state, 'main-fast-forward-failed', { reason: ffReason, ...ffDetail });
    return { ffOk: false, ffReason, ffDetail, installed: false, installExit: null };
  }
  appendEvent(ctx.taskDir, state, 'main-fast-forwarded', {});

  const decision = (await decideInstall()) || { install: false };
  if (!decision.install) {
    return { ffOk: true, ffReason: null, ffDetail: {}, installed: false, installExit: null };
  }

  const install = spawnStep(ctx, deps, state, 'bash', [path.join(productRepo, 'scripts', 'bench-install.sh')], {
    cwd: productRepo,
  });
  if (install.exit !== 0) {
    appendEvent(ctx.taskDir, state, 'bench-reinstall-failed', { exit: install.exit });
    return { ffOk: true, ffReason: null, ffDetail: {}, installed: false, installExit: install.exit };
  }
  appendEvent(ctx.taskDir, state, 'bench-reinstalled', {});
  return { ffOk: true, ffReason: null, ffDetail: {}, installed: true, installExit: 0 };
}

// payBenchReinstallDebtIfOwed(ctx, deps, config) -- action B1.4 round 4: pays back a bench-worker
// reinstall an EARLIER card's FINISH deferred (writeBenchReinstallOwed) instead of parking, from
// INSIDE WORKTREE's own product-repo lock span, before this card does anything else.
//
// WHY WORKTREE, not FINISH-only and not a separate timer: WORKTREE runs before GATE, so a card
// that STARTS while a reinstall is owed pays it back before it can gate against a stale worker --
// the exact failure this debt exists to prevent. Paying only at FINISH would leave a one-card
// window where a card gates stale and only then settles the debt. Round 3's answer was a
// dedicated daemon scan timer (orchestrator/bench-reconcile.js) -- deleted: it held the SAME
// product-repo lock from a THIRD process `waitBoundMs`'s own derivation assumes cannot exist (at
// K=1 a worker reaching this lock while the scanner held it parked `product-repo-lock-timeout`
// after 0ms, terminal and human-only), ran bench-install.sh with none of this function's
// preconditions, and had no backoff on a failing install. Three rounds of adding to a SEPARATE
// reconciler produced a new must-fix each round -- more machinery than the problem needs. This is
// simpler: reuse the lock a worker already holds, reuse the preconditions realFinish already
// enforces, no new lock holder, no new timer.
//
// NEVER blocks or parks THIS card over a debt it did not create: every failure mode below (a
// fast-forward failure, a busy bench, an unreadable bench dir, an owed mergeSha that is not yet an
// ancestor of the fast-forwarded HEAD, a failed install) leaves the record owed, journals why, and
// returns -- WORKTREE continues exactly as if nothing were owed. The NEXT card's WORKTREE tries
// again. No hot loop either: this runs at most once per card, never retried within the same call.
//
// R4 (fifth pass, F1): the paragraph above was true only of the EXIT-CODE failure modes -- it did
// NOT cover spawnStep itself throwing. A `bash scripts/bench-install.sh` or `git` call that TIMES
// OUT (config.js's commandTimeoutsMs) makes spawnStep throw ParkSignal('bench-install-timed-out'
// / 'git-timed-out') rather than return a non-zero exit, and `bench-install-timed-out` is not on
// state-machine.js's TRANSIENT_RETRY_REASONS -- an uncaught throw here would park THIS card
// terminally, and (worse) leave the debt owed, so the NEXT card's WORKTREE hits the same wedged
// installer and parks the same way: a hung reinstall would terminally stall the whole backlog,
// exactly what this function's own header already claims cannot happen. clearBenchReinstallOwed
// below can also throw a raw Error (e.g. a read-only/full journalRoot) -- runTask deliberately does
// NOT convert a bare Error into a park (see park-signal.js's header), so uncaught that crashes the
// worker outright. The try/catch below is what actually makes the "never blocks or parks" and
// "never throws" claims true for every failure mode, not just exit codes: anything thrown while
// paying the debt is journalled (with the caught reason, so the failure stays VISIBLE -- only its
// propagation is suppressed, not the record of it) and swallowed here, leaving the debt owed for
// the next attempt. It deliberately wraps ONLY this function's own work -- realWorktree's other
// steps (worktree add, npm ci, board:take, ...) are called from OUTSIDE this function and keep
// throwing/parking exactly as before.
async function payBenchReinstallDebtIfOwed(ctx, deps, config) {
  const journalRoot = path.dirname(ctx.taskDir);
  const owed = readBenchReinstallOwed(journalRoot);
  if (!owed) return; // the common case, every WORKTREE, on a healthy daemon -- no journal line at all

  try {
    const result = await fastForwardMainAndInstall(ctx, deps, config, {
      state: 'WORKTREE',
      decideInstall: async () => {
        const depth = benchQueueDepth(deps, config);
        if (depth.error) {
          appendEvent(ctx.taskDir, 'WORKTREE', 'bench-debt-dir-unreadable', {
            mergeSha: owed.mergeSha,
            code: (depth.error && depth.error.code) || null,
          });
          return { install: false };
        }
        if (depth.spool > 0 || depth.running > 0) {
          appendEvent(ctx.taskDir, 'WORKTREE', 'bench-debt-still-busy', {
            mergeSha: owed.mergeSha,
            spool: depth.spool,
            running: depth.running,
          });
          return { install: false };
        }
        // Defense in depth, not a behaviour change: the fast-forward above already proves
        // config.productRepo is a clean, up-to-date `main`, and `bash scripts/bench-install.sh`
        // builds from whatever is CURRENTLY checked out there -- but owed.mergeSha was written by a
        // DIFFERENT card's FINISH, possibly long ago, so this confirms it really is an ancestor of
        // the checkout about to be rebuilt from rather than trusting the record blindly.
        const ancestry = spawnStep(ctx, deps, 'WORKTREE', 'git', [
          '-C',
          config.productRepo,
          'merge-base',
          '--is-ancestor',
          owed.mergeSha,
          'HEAD',
        ]);
        if (ancestry.exit !== 0) {
          appendEvent(ctx.taskDir, 'WORKTREE', 'bench-debt-ancestry-check-failed', {
            mergeSha: owed.mergeSha,
            exit: ancestry.exit,
          });
          return { install: false };
        }
        return { install: true };
      },
    });

    if (result.installed) {
      clearBenchReinstallOwed(journalRoot, { lastMergeSha: owed.mergeSha });
      appendEvent(ctx.taskDir, 'WORKTREE', 'bench-debt-paid', { mergeSha: owed.mergeSha });
    }
    // Any other outcome (ffOk === false, or installed === false for any other reason) leaves the
    // debt owed -- already journalled above or inside fastForwardMainAndInstall -- and WORKTREE
    // continues normally below.
  } catch (err) {
    // Anything thrown while paying an EARLIER card's debt -- a ParkSignal from spawnStep's own
    // timeout handling (bench-install-timed-out, git-timed-out, ...) or a raw Error from
    // clearBenchReinstallOwed's own fs call -- must never propagate out of THIS function: this
    // card did not create the debt and must not park or crash over it. The debt stays owed
    // (nothing above ran clearBenchReinstallOwed successfully on this path) for the next card's
    // WORKTREE to retry. Journalled, not silently swallowed, so a wedged installer or a broken
    // journalRoot is still visible to a human reading the journal.
    appendEvent(ctx.taskDir, 'WORKTREE', 'bench-debt-attempt-failed', {
      mergeSha: owed.mergeSha,
      reason: err && err.name === 'ParkSignal' ? err.reason : (err && err.code) || (err && err.name) || 'error',
      message: (err && err.message) || String(err),
    });
  }
}

// action 6.4: everything from `fetch` through `npm ci` below mutates config.productRepo's shared
// `.git` (fetch writes FETCH_HEAD; the leftover sweep and `worktree add` mutate
// `.git/worktrees/`'s administrative files) or spikes shared disk/CPU (`npm ci`) -- see
// product-repo-lock.js's own header for the full rationale and the WORST_HOLD_MS arithmetic.
// `board:take` (npm run, further down) is deliberately OUTSIDE the lock: it only talks to the
// GitHub project board via `gh`/GraphQL from inside the now-created worktree, never touches
// config.productRepo, and holding the mutex across it would only add an unrelated network call's
// latency to every OTHER worker's wait.
async function realWorktree(ctx, deps = {}) {
  const config = ctx.config;
  const productRepo = config.productRepo;
  const worktreesDir = config.pipelineWorktreesDir;
  const taskId = ctx.id;
  const issue = ctx.task && ctx.task.issue;
  const branch = `claude-pipe/${taskId}`;
  const worktreePath = path.join(worktreesDir, taskId);

  // Moved up from just before `worktree add` (its pre-6.4 position): the product-repo lock file
  // (product-repo-lock.js) lives inside worktreesDir and must exist before withProductRepoLock's
  // first acquire attempt, not just before `worktree add`. Idempotent (recursive: true) on every
  // run after the first, so moving it earlier changes nothing about worktree add's own behaviour.
  fs.mkdirSync(worktreesDir, { recursive: true });

  await withProductRepoLock(ctx, deps, 'worktree', async () => {
    // action B1.4 round 4: pay back an owed bench-worker reinstall from an EARLIER card's
    // deferred FINISH before this card does anything else -- see payBenchReinstallDebtIfOwed's
    // own header for why WORKTREE, and why this can never block or park this card.
    await payBenchReinstallDebtIfOwed(ctx, deps, config);

    const fetch = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'fetch', 'origin']);
    if (fetch.exit !== 0) throw new ParkSignal('worktree-fetch-failed', { exit: fetch.exit });

    const revParse = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'rev-parse', 'origin/main']);
    if (revParse.exit !== 0) throw new ParkSignal('worktree-rev-parse-failed', { exit: revParse.exit });
    const originMainSha = revParse.stdout.trim();

    // Action 3.1: journal the base sha this run is building on, and hand it to ctx.task, before
    // any park can happen below (including nightly-main-red). This 'base-main' event is a
    // diagnostic record -- "what origin/main sha did this run cut its worktree from" -- journalled
    // here, ahead of the nightly-red check, so it exists even for a run that parks right there and
    // never reaches PLAN. It is NOT what handlePlan's reuse guard (decidePlanReuse,
    // state-machine.js) reads: that guard's actual input is the baseMainSha field PLAN's own
    // 'files-written' event carries (only written once PLAN succeeds), compared against
    // ctx.task.baseMainSha as set on the line right below. A run that parks before ever reaching
    // PLAN leaves no PLAN 'files-written' event at all, so there is nothing for a later retry to
    // compare this run's base-main against in the first place.
    appendEvent(ctx.taskDir, 'WORKTREE', 'base-main', { sha: originMainSha });
    ctx.task.baseMainSha = originMainSha;

    // action B3.2: routed through the same classifyNightly this file's guardNightlyRed uses --
    // this used to be its own second copy of the FAIL-and-sha-match predicate (the exact kind of
    // drift guardNightlyRed's own header warns about), and it silently treated every other
    // verdict, including INTERRUPTED, the same as a clean PASS. Only 'red' still parks; 'unknown'
    // is now journalled rather than falling through unlabelled -- see guardNightlyRed's header
    // for why 'unknown' does not also park here.
    const nightly = readJsonSafe(path.join(config.spoBenchDir, 'nightly', 'latest.json'));
    const nightlyClassification = classifyNightly(nightly, originMainSha);
    if (nightlyClassification.status === 'red') {
      throw new ParkSignal('nightly-main-red', { sha: originMainSha });
    }
    if (nightlyClassification.status === 'unknown') {
      appendEvent(ctx.taskDir, 'WORKTREE', 'nightly-unknown', {
        sha: originMainSha,
        reason: nightlyClassification.reason,
      });
    }

    sweepWorktreeLeftovers(ctx, deps, { productRepo, worktreePath, branch });

    const add = spawnStep(ctx, deps, 'WORKTREE', 'git', [
      '-C',
      productRepo,
      'worktree',
      'add',
      worktreePath,
      '-b',
      branch,
      'origin/main',
    ]);
    if (add.exit !== 0) throw new ParkSignal('worktree-add-failed', { exit: add.exit });

    // Every later real step (CHECK/PUSH_PR/GATE/... and PLAN/IMPLEMENT via config.cwdForStep)
    // reads this back off ctx.task -- the one place a fresh worktree's path becomes known.
    ctx.task.worktreePath = worktreePath;
    ctx.task.branch = branch;

    const ci = spawnStep(ctx, deps, 'WORKTREE', 'npm', ['ci'], { cwd: worktreePath });
    if (ci.exit !== 0) throw new ParkSignal('worktree-npm-ci-failed', { exit: ci.exit });
  });

  const claim = spawnStep(ctx, deps, 'WORKTREE', 'npm', ['run', 'board:take', '--', String(issue)], {
    cwd: worktreePath,
  });
  if (claim.exit === 0) {
    // Kanban piloting: the worktree now exists and cwd for board:move -- move the card to
    // "Planning" (the state PLAN, next, belongs to). Never blocks (board.js's own rule).
    moveCard(ctx, deps, 'WORKTREE');
    return 'PLAN';
  }
  if (claim.exit === 3) throw new ParkSignal('claim-lost', { exit: claim.exit });
  if (claim.exit === 4 || claim.exit === 5) throw new ParkSignal('claim-rate-limited', { exit: claim.exit });
  if (claim.exit === 6) throw new ParkSignal('claim-finished-worktree', { exit: claim.exit });
  throw new ParkSignal('claim-unrecognized-exit', { exit: claim.exit });
}

// ---- CHECK ---------------------------------------------------------------------------------
//
// Action 1.8: the invariant substring check runs FIRST, before typecheck/lint/coverage:changed --
// deliberately, for two reasons. (1) It is pure `fs` reads (orchestrator/invariants.js -- no
// spawning at all), while every CHECK_ALIASES entry spawns an `npm run` subprocess; there is no
// reason to pay for three subprocess spawns before a free check that can already fail the visit.
// (2) A broken invariant is the single most surgical, most actionable signal this state can hand
// DIAGNOSE: it names the exact fact ("id X, cited in file Y") IMPLEMENT was told to preserve and
// broke, whereas a bare typecheck/lint failure is often already self-explanatory from the tool's
// own output and gains nothing from running first. Then typecheck, lint, coverage:changed, same
// order as before this action; the first non-zero exit names its own alias and goes to DIAGNOSE
// (never PARKED -- matches the shadow-mode contract, and doc/state-machine-spec.md's own "CHECK
// Failure -> DIAGNOSE, never PARKED").
const CHECK_ALIASES = ['typecheck', 'lint', 'coverage:changed'];

// Re-resolves the PLAN-time invariant baseline (if any -- see task-values.js's
// lastInvariantsBaseline) against the worktree as CHECK finds it, journals the outcome as
// 'invariants-checked', and returns the list of broken ids (empty when nothing regressed, when
// there was no baseline at all, or when the baseline/invariants file itself could not be read --
// fail-open on parse, per orchestrator/invariants.js's own contract).
function runInvariantCheck(ctx, deps, worktreePath) {
  const planPayload = lastResultPayload(ctx.taskDir, 'PLAN') || {};
  const invariantsPath = planPayload.invariants_path;
  const baselineEvent = lastInvariantsBaseline(ctx.taskDir);
  if (!invariantsPath || !baselineEvent) return [];

  const { parseError, broken, checkedIds } = checkRegressions(
    worktreePath,
    invariantsPath,
    baselineEvent.invariants || []
  );
  appendEvent(ctx.taskDir, 'CHECK', 'invariants-checked', {
    parseError: parseError || null,
    checkedIds,
    broken,
  });
  return broken;
}

async function realCheck(ctx, deps = {}) {
  const worktreePath = ctx.task.worktreePath;
  moveCard(ctx, deps, 'CHECK'); // kanban piloting: "Checks & PR" -- covers PUSH_PR too, no separate move there

  const broken = runInvariantCheck(ctx, deps, worktreePath);
  if (broken.length > 0) {
    appendEvent(ctx.taskDir, 'CHECK', 'check-failed', { alias: 'invariants', broken });
    return 'DIAGNOSE';
  }

  for (const alias of CHECK_ALIASES) {
    const r = spawnStep(ctx, deps, 'CHECK', 'npm', ['run', alias], { cwd: worktreePath });
    if (r.exit !== 0) {
      appendEvent(ctx.taskDir, 'CHECK', 'check-failed', { alias, exit: r.exit });
      return 'DIAGNOSE';
    }
  }
  return 'PUSH_PR';
}

// ---- PUSH_PR --------------------------------------------------------------------------------

function commitMessage(ctx) {
  const title = (ctx.task && ctx.task.title) || `Card #${ctx.task && ctx.task.issue}`;
  const issue = ctx.task && ctx.task.issue;
  return `${title}\n\nCloses #${issue}\n`;
}

// prBody(ctx, citations) -- prBody(ctx) alone (no second argument) is byte-for-byte the original
// two-line template; only caller is realPushPr, below. `citations`, when a non-empty array, is
// appended as its own "### RDO catalogue" section -- see realPushPr's own header comment on why
// this exists (SPO-WebClient's required "typecheck + tests" check rejects a PR touching
// src/shared/rdo-members.ts without one).
function prBody(ctx, citations) {
  const issue = ctx.task && ctx.task.issue;
  const lines = [`Closes #${issue}`, '', `_pipeline: claude-pipe/${ctx.id}_`, ''];
  if (Array.isArray(citations) && citations.length > 0) {
    lines.push('### RDO catalogue', '', ...citations, '');
  }
  return lines.join('\n');
}

function parsePrNumber(stdout) {
  const m = (stdout || '').match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// A citation of the form `<Fichier>.pas:<Ligne>` -- what SPO-WebClient/scripts/check-pr-rules.js
// requires somewhere in the PR body before it will let a diff touching src/shared/rdo-members.ts
// through the required "typecheck + tests" check.
const RDO_CITATION_RE = /[\w.-]+\.pas:\d+/i;

// Pulls citations out of a `git diff -U0` against rdo-members.ts: added lines only (`+`, not the
// `+++` file-header line), keeping the whole source line -- not just the matched token -- so the
// citation reads as the reviewer's own justification, not a bare filename:line pair. Stripped, in
// order: the leading `+` diff marker, a `//` comment marker (with whatever whitespace sits
// between the two), then the line's own edge whitespace.
function extractCitations(diffText) {
  const citations = [];
  for (const rawLine of (diffText || '').split('\n')) {
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) continue;
    const withoutComment = rawLine.slice(1).replace(/^\s*\/\/\s*/, '');
    const cleaned = withoutComment.trim();
    if (RDO_CITATION_RE.test(cleaned)) citations.push(cleaned);
  }
  return citations;
}

// Fallback source when the diff itself carries no citation: the task's own criterion text may
// already quote one (a maintainer citing the source record when filing the card). Kept lines are
// used verbatim -- there is no diff `+`/`//` framing to strip here.
function extractCitationsFromCriterion(criterion) {
  const citations = [];
  for (const rawLine of (criterion || '').split('\n')) {
    const trimmed = rawLine.trim();
    if (RDO_CITATION_RE.test(trimmed)) citations.push(trimmed);
  }
  return citations;
}

async function realPushPr(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;
  const title = (ctx.task && ctx.task.title) || `Card #${ctx.task && ctx.task.issue}`;
  const branch = (ctx.task && ctx.task.branch) || `claude-pipe/${ctx.id}`;

  const messageFile = path.join(ctx.taskDir, 'commit-message.txt');
  fs.writeFileSync(messageFile, commitMessage(ctx));

  const add = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'add', '-A']);
  if (add.exit !== 0) throw new ParkSignal('push-pr-failed', { step: 'add', exit: add.exit });

  const commit = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'commit', '-F', messageFile]);
  // `git commit` exits 1 on "nothing to commit", and that is reached from two structurally
  // different places:
  //   (1) CI_CHECKS' main-moved path (realCiChecks, ~line 1191 below) already ran
  //       `git merge origin/main` in the worktree and returned 'CHECK' -- CHECK passes, PUSH_PR
  //       runs again, but the merge commit is ALREADY committed, so `git add -A` above stages
  //       nothing and this commit exits 1 over a tip origin has never seen. Parking here would
  //       strand a perfectly good merge commit, and the retry sweep would then park
  //       branch-unmerged-leftover on it forever.
  //   (2) Nothing new was produced this pass -- IMPLEMENT wrote no diff (or wrote one that
  //       reproduced what a prior pass already committed and pushed). Parking is correct here:
  //       re-pushing and re-gating a byte-identical sha cannot produce a different CI result.
  //
  // The plan for this action (doc/remediation-plan-2026-08.md, action 4.1) said to tell these
  // apart by HEAD vs origin/main: "clean tree + HEAD != origin/main -> skip the commit, proceed
  // to push". Measured against the real journal, that condition is wrong. Card #213, run 1
  // (journal/issue-213/journal.jsonl): PUSH_PR succeeded and created the PR at 19:23:03, CI
  // failed, DIAGNOSE -> IMPLEMENT produced no diff, and PUSH_PR parked
  // {"step":"commit","exit":1} at 19:38:02. At that moment HEAD != origin/main -- the branch
  // already carried its first-pass commits -- so the plan's own condition would have skipped the
  // park, pushed a no-op, and re-gated an unchanged sha. An unchanged commit cannot produce a
  // different CI result, so the card would have looped DIAGNOSE -> IMPLEMENT until the diagnose
  // budget parked it anyway, having burned that budget for nothing. The fact that actually tells
  // the two cases apart is whether the tip carries work ORIGIN HAS NOT SEEN YET -- case (1)'s
  // merge commit is unpushed even though HEAD has also moved past origin/main; case #213's
  // "nothing new" tip was already pushed even though HEAD had also moved past origin/main. So
  // the comparison below is against origin/<branch> (this branch's own remote tip), not
  // origin/main.
  if (commit.exit !== 0) {
    const status = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'status', '--porcelain']);
    if (status.exit !== 0) {
      throw new ParkSignal('push-pr-failed', { step: 'commit', exit: commit.exit, statusExit: status.exit });
    }
    if (status.stdout.trim() !== '') {
      // A dirty tree after `git add -A; git commit` means the commit failed for a real reason
      // (hook rejection, a bad `-F` message file, an index lock...), not "nothing to commit" --
      // there is staged or unstaged work sitting uncommitted. Park exactly as before this action.
      throw new ParkSignal('push-pr-failed', { step: 'commit', exit: commit.exit, dirty: true });
    }

    // Tree is clean, so commit's exit 1 really was "nothing to commit". Resolve HEAD and this
    // branch's own remote tip to tell case (1) (unpushed work at HEAD) from case (2) (HEAD
    // already equals what origin has, or nothing was ever implemented).
    const headRev = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
    // Checked, exactly like origin/main below, and for a sharper reason than symmetry: a failing
    // `git rev-parse <ref>` prints the REF NAME ITSELF to stdout (measured: an orphan/unborn HEAD
    // gives exit 128, "fatal: ambiguous argument 'HEAD'" on stderr, and the literal `HEAD` on
    // stdout). Trusting stdout regardless of exit therefore does not fail closed with an empty
    // string -- it yields the plausible-looking non-sha `"HEAD"`, which equals neither origin/main
    // nor origin/<branch>, so BOTH parks below are skipped, `commit-skipped-nothing-staged` is
    // journalled with `head: "HEAD"` (a lie the maintainer and DIAGNOSE both read as a sha), and
    // the step falls through to a push that can only fail -- parking `{step:'push'}` and
    // swallowing the real cause two commands later. Same rule as the status check above: a
    // diagnostic must never bury the failure it was added to explain.
    if (headRev.exit !== 0) {
      throw new ParkSignal('push-pr-failed', { step: 'commit', exit: commit.exit, revParseFailed: 'HEAD' });
    }
    const head = headRev.stdout.trim();

    // A never-pushed branch has no refs/remotes/origin/<branch> at all -- rev-parse --verify
    // --quiet exits non-zero for that, which is an EXPECTED outcome here (first pass, push
    // below hasn't run yet), never an error. --quiet suppresses the "not a valid ref" stderr
    // noise that would otherwise pollute the spawn log for the expected case.
    const remoteBranch = spawnStep(ctx, deps, 'PUSH_PR', 'git', [
      '-C',
      worktreePath,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${branch}`,
    ]);
    const remoteBranchSha = remoteBranch.exit === 0 ? remoteBranch.stdout.trim() : null;

    const originMain = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'rev-parse', 'origin/main']);
    if (originMain.exit !== 0) {
      throw new ParkSignal('push-pr-failed', { step: 'commit', exit: commit.exit, revParseFailed: 'origin/main' });
    }
    const mainSha = originMain.stdout.trim();

    if (head === mainSha) {
      // HEAD sits exactly on origin/main -- IMPLEMENT never produced a commit on this branch at
      // all, on this pass or any prior one. There is genuinely nothing to push.
      throw new ParkSignal('push-pr-failed', {
        step: 'commit',
        exit: commit.exit,
        reason: 'nothing-implemented',
      });
    }
    if (remoteBranchSha !== null && head === remoteBranchSha) {
      // #213's shape: the remote tip for THIS branch already equals HEAD, so this pass's PR (or
      // prior push) already carries everything at HEAD -- pushing again would push nothing and
      // re-gate a sha CI has already judged.
      throw new ParkSignal('push-pr-failed', {
        step: 'commit',
        exit: commit.exit,
        reason: 'nothing-new-to-push',
        head,
      });
    }

    // Otherwise there IS unpushed work at HEAD -- the main-moved merge commit (case (1) above)
    // is the motivating example, but this also covers a branch that has simply never been
    // pushed yet and whose commit failed for a benign "nothing to commit" reason (unusual, but
    // not this function's problem to rule out). Skip the commit -- there is nothing to add to it
    // -- and fall through to the push below exactly as if commit.exit had been 0.
    appendEvent(ctx.taskDir, 'PUSH_PR', 'commit-skipped-nothing-staged', {
      head,
      remoteBranchSha,
      branch,
    });
  }

  // Order matters: the branch is pushed BEFORE the citation check below, not after. A park
  // thrown between the commit and the push would leave a local-only, unpushed tip on
  // claude-pipe/<id> over a CLEAN worktree -- preserveWorktreeWip has nothing to save, so no
  // wip/ ref would cover it, and the next retry's sweepWorktreeLeftovers rule 2 would park
  // branch-unmerged-leftover forever. Pushing first makes the tip equal origin/claude-pipe/<id>,
  // which is rule 2's own case (b) -- the retry cleans it up instead of deadlocking on it.
  const push = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'push', '-u', 'origin', branch]);
  if (push.exit !== 0) throw new ParkSignal('push-pr-failed', { step: 'push', exit: push.exit });

  // card #385's first park: SPO-WebClient/scripts/check-pr-rules.js's required "typecheck +
  // tests" check fails any PR touching src/shared/rdo-members.ts unless the PR body itself
  // carries a `<Fichier>.pas:<Ligne>` citation -- prBody() used to be a static two-line template,
  // so no card touching the RDO catalogue could ever pass CI. Read the actual diff against
  // origin/main (not the task's own declared touchesRdoMembers -- see the rederivation right
  // below) so the citation search runs on what this attempt really changed.
  const changed = spawnStep(ctx, deps, 'PUSH_PR', 'git', ['-C', worktreePath, 'diff', '--name-only', 'origin/main...HEAD']);
  if (changed.exit !== 0) throw new ParkSignal('push-pr-failed', { step: 'diff-name-only', exit: changed.exit });
  const touchesCatalogue = splitLines(changed.stdout).includes('src/shared/rdo-members.ts');

  // The diff is ground truth; intake.js's makeTask only ever infers touchesRdoMembers from the issue's
  // OWN TEXT (area === 'rdo' or a literal "rdo-members.ts" mention). Card #385 touched the
  // catalogue with neither, so this stayed false all the way through VALIDATE and
  // handleValidate's CITATION_VERIFIER step never ran. Correct it the moment the real diff
  // disagrees with what intake guessed, so the rest of this task's VALIDATE pass sees the truth.
  if (touchesCatalogue && !ctx.task.touchesRdoMembers) {
    ctx.task.touchesRdoMembers = true;
    appendEvent(ctx.taskDir, 'PUSH_PR', 'touches-rdo-members-rederived', { from: false, to: true });
  }

  let citations = [];
  if (touchesCatalogue) {
    const catalogueDiff = spawnStep(ctx, deps, 'PUSH_PR', 'git', [
      '-C',
      worktreePath,
      'diff',
      '-U0',
      'origin/main...HEAD',
      '--',
      'src/shared/rdo-members.ts',
    ]);
    citations = extractCitations(catalogueDiff.stdout);
    if (citations.length === 0) citations = extractCitationsFromCriterion(ctx.task && ctx.task.criterion);
    if (citations.length === 0) {
      throw new ParkSignal('rdo-citation-missing', { file: 'src/shared/rdo-members.ts' });
    }
    appendEvent(ctx.taskDir, 'PUSH_PR', 'rdo-citation', { citations });
    // Same in-memory/journal split as touchesRdoMembers above: the journal event is what
    // survives a daemon restart between this PUSH_PR pass and the VALIDATE that follows it
    // (task-values.js falls back to it), while this assignment is what lets the SAME process's
    // VALIDATE -> CITATION_VERIFIER read the citations without a restart in between at all.
    ctx.task.citations = citations;
  }


  const bodyFile = path.join(ctx.taskDir, 'pr-body.md');
  const body = prBody(ctx, citations);
  fs.writeFileSync(bodyFile, body);

  // A second PUSH_PR pass on the same branch (CI red -> DIAGNOSE -> IMPLEMENT -> CHECK -> back
  // here) used to call `gh pr create` unconditionally, which GitHub refuses -- "a pull request
  // for branch ... already exists". Found by reading this function while diagnosing card #385,
  // not from a journaled incident: #385 never got this far, its own second pass died at the
  // commit above. Check for an open PR on this branch first and reuse it.
  const list = spawnStep(ctx, deps, 'PUSH_PR', 'gh', [
    'pr',
    'list',
    '--repo',
    config.ghRepo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  if (list.exit === 0) {
    const existing = (() => {
      try {
        return JSON.parse(list.stdout);
      } catch {
        return null;
      }
    })();
    if (Array.isArray(existing) && existing.length > 0) {
      const prNumber = existing[0].number;
      appendEvent(ctx.taskDir, 'PUSH_PR', 'pr-reused', { prNumber });
      // Never `gh pr edit` -- CLAUDE.md: it's in `deny` on this repo (Projects classic board).
      // Editing a PR goes through the REST API directly instead.
      const patch = spawnStep(ctx, deps, 'PUSH_PR', 'gh', ['api', `repos/${config.ghRepo}/pulls/${prNumber}`, '-X', 'PATCH', '-f', `body=${body}`]);
      if (patch.exit !== 0) {
        appendEvent(ctx.taskDir, 'PUSH_PR', 'pr-body-patch-failed', { exit: patch.exit });
      }
      ctx.prNumber = prNumber;
      return 'GATE';
    }
  }
  // Empty list, unparsable JSON, or a failed `gh pr list` call all fall through to `gh pr create`
  // exactly as before this fix -- an inability to check for an existing PR is not a reason to
  // stop trying to open one.

  // --head/--base are required here, not optional: every other command in this function targets
  // the worktree explicitly via `git -C worktreePath`, but `gh pr create` has no `-C`/cwd of its
  // own -- it infers the head branch from the process's own cwd, which is the daemon's cwd
  // (~/SPO-Pipeline, itself a git repo on `main`), not `worktreePath`. Without an explicit
  // --head, gh resolved head == base == main and refused with "No commits between main and main
  // (createPullRequest)" -- reproduced on card issue-247's 4th real pass: CHECK green, branch
  // `claude-pipe/issue-247` pushed and waiting, yet pr-create still parked push-pr-failed.
  const create = spawnStep(ctx, deps, 'PUSH_PR', 'gh', [
    'pr',
    'create',
    '--repo',
    config.ghRepo,
    '--title',
    title,
    '--body-file',
    bodyFile,
    '--head',
    branch,
    '--base',
    'main',
  ]);
  if (create.exit !== 0) throw new ParkSignal('push-pr-failed', { step: 'pr-create', exit: create.exit });

  const prNumber = parsePrNumber(create.stdout);
  if (!prNumber) {
    throw new ParkSignal('push-pr-failed', { step: 'pr-number-unparsed', stdoutTail: create.stdoutTail });
  }
  ctx.prNumber = prNumber;
  appendEvent(ctx.taskDir, 'PUSH_PR', 'pr-created', { prNumber });

  return 'GATE';
}

// ---- GATE -----------------------------------------------------------------------------------
//
// `npm run gate`: 0 PASS -> CI_CHECKS, 1 fail -> see the exit-1 block below (action 4.2), 2 dirty
// / 3 worker down / 4 timeout -> PARKED. 2/3/4 are unchanged and still mirror handleGate's own
// shadow-mode cause table exactly. Action B2.3: the green path (exit 0) is no longer silent --
// see the block below the `r.exit === 0` check.

// Shared by GATE's exit-0 and exit-1 paths (action B2.3, factored out of the exit-1 block action
// 4.1 originally wrote it for): resolves HEAD's sha, journalling and returning null on ANY
// failure to read it -- never fatal here. Action 4.1's own finding: exit 0 is necessary but not
// sufficient to trust the stdout -- an orphan/unborn HEAD prints the literal ref name `HEAD` on
// stdout with exit 0, so both a non-zero exit AND a result that does not look like an object name
// count as unreadable. A failed diagnostic must never become the thing that parks or blocks the
// card -- callers decide their own fallback routing on a null return.
//
// That "never fatal" contract was not actually true until this try/catch (adversarial
// verification of B2.3, finding T3-1): since action 2.1, spawnStep ITSELF throws
// ParkSignal('git-timed-out') -- not a non-zero exit -- when the same git command is killed by
// its own spawnSync timeout twice in a row. Uncaught, that throw unwinds straight out of this
// helper and, on the exit-0 path above (which spawns no other git command and has nothing else to
// catch it), parks a gate that PASSED, permanently (`git-timed-out` is not on
// TRANSIENT_RETRY_REASONS), because a purely diagnostic `git rev-parse HEAD` happened to hang.
// Same shape, same fix, as preserveWorktreeWip's own guard and the main-moved-conflict merge
// --abort guard just below in this file: catch ONLY ParkSignal (a genuine programming error must
// still escape, never get swallowed into a plausible-looking journal event), journal it as just
// another unreadable-HEAD outcome, and return null so callers fall back exactly as they already
// do for exit 128 / a malformed sha.
function resolveGateHeadSha(ctx, deps, worktreePath) {
  let headRes;
  try {
    headRes = spawnStep(ctx, deps, 'GATE', 'git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
  } catch (err) {
    if (!(err instanceof ParkSignal)) throw err;
    appendEvent(ctx.taskDir, 'GATE', 'gate-verdict-unreadable', {
      step: 'rev-parse',
      threw: true,
      reason: err.reason,
      argv: err.detail && err.detail.argv,
    });
    return null;
  }
  const headSha = (headRes.stdout || '').trim();
  if (headRes.exit !== 0 || !/^[0-9a-f]{7,64}$/.test(headSha)) {
    appendEvent(ctx.taskDir, 'GATE', 'gate-verdict-unreadable', { step: 'rev-parse', exit: headRes.exit, headSha });
    return null;
  }
  return headSha;
}

// The fact both the exit-0 and exit-1 paths below need to read off `verdict.live` (action B2.3):
// routing named flows this diff must be driven through, and the live stage never drove them.
// `required` is `LiveAttestation`'s own `skipped` member's field name (SPO-WebClient's
// src/e2e/bench/verdict.ts) -- present and non-empty is the one shape that means "the router
// asked for a live drive and nothing gave it one"; present-and-empty is the common, legitimate
// case (186 of 215 corpus skips -- doc/bench-audit-2026-09-02.md) and must never trip this.
function liveRoutedButNotDriven(live) {
  return !!live && live.status === 'skipped' && Array.isArray(live.required) && live.required.length > 0;
}

// ---- action B3.4: stop collapsing distinct causes at the wire (defect class D8) -----------
//
// `npm run gate`'s exit code is a lossy projection of what the bench actually decided.
// `SPO-WebClient/src/e2e/bench/cli.ts`'s own `wait()` collapses SEVEN distinct `JobVerdict`
// values (`SPO-WebClient/src/e2e/bench/job.ts`'s own union -- FAIL, BLOCKED, ENVIRONMENT,
// STALE, DIRTY, ABANDONED, INTERRUPTED; PASS/LEASED exit 0) onto the single exit 1. Two of
// those seven (BLOCKED, and a FAIL missing `baseMain`) are already read off
// `<spoBenchDir>/verdicts/<sha>.json` above (actions B2.3/4.2) -- but that file is written only
// for the `ref` job type and only when `worker.ts`'s own `NON_ATTESTING = {DIRTY, ENVIRONMENT,
// ABANDONED}` does NOT contain the verdict (`processOldest`'s own guard), and never at all for
// INTERRUPTED (`recoverInterrupted` writes straight to `done/`, skipping the `verdicts/` write
// entirely) -- so those four verdicts still fall through the `if (!verdict)` branch below into
// one undifferentiated `gate-non-attesting` park. Measured against the live bench today
// (`~/.spo-bench/done/*.json`, 24h retention, 2026-09-03): 7 of the last 29 completed jobs are
// verdict ENVIRONMENT ("git fetch failed while fetching <sha>") -- every one of those seven
// would have parked the identical `gate-non-attesting`, with nothing in the park comment
// distinguishing a fetch failure from an abandoned worktree or a dirty worker checkout.
//
// None of this is missing information -- it is on the floor, not gone: `cli.ts`'s `submit()`
// prints `` `job ${request.id} queued...` `` to stdout the moment a job is deposited (the SAME
// stdout `gateLogPath` above already captures), and `job.ts`'s `Spool.writeReport` writes
// `<spoBenchDir>/done/<id>.json` UNCONDITIONALLY, for every verdict, before `wait()`'s polling
// loop can ever return 0 or 1 -- so whenever `npm run gate` exits 0 or 1, that file already
// exists with the exact verdict/detail/staticProof the CLI's own exit code just collapsed.
//
// parseGateJobId/readGateDoneReport read that richer answer defensively: a missing, unreadable,
// malformed, or non-object `done/<id>.json` (a JSON `null`, a bare JSON string, and a JSON
// ARRAY all parse successfully and are none of them the JobReport object shape this reads --
// exactly the un-guarded-parse hazard this chantier has hit before, a bookkeeping file read
// with no shape check turning every subsequent gate into a false FAIL) must never turn a good
// gate into a park, and must never be silently read as a verdict either -- every call site below
// falls back to the pre-existing exit-code/verdicts-file routing exactly as it stood before this
// action whenever the richer read is unavailable, journalling why.
function parseGateJobId(stdout) {
  const m = /(?:^|\n)job (\S+) queued/.exec(stdout || '');
  return m ? m[1] : null;
}

function readGateDoneReport(config, jobId) {
  if (!jobId) return { report: null, skipped: 'no-job-id', donePath: null };
  const donePath = path.join(config.spoBenchDir, 'done', `${jobId}.json`);
  let raw;
  try {
    raw = fs.readFileSync(donePath, 'utf8');
  } catch (err) {
    // Distinguish "nothing there yet" (ENOENT -- the ordinary case for a job whose report has
    // not landed, e.g. exit 3/4's still-pending job) from a genuine read failure (permissions, a
    // misconfigured spoBenchDir mounted read-protected, ...) -- the same "misconfiguration vs.
    // genuine empty answer" split `verdictDirExists` already draws one function away, and
    // FINISH's own `bench-dir-unreadable` draws for `spool`/`running`.
    const skipped = err && err.code === 'ENOENT' ? 'missing' : 'unreadable';
    return { report: null, skipped, donePath, errCode: (err && err.code) || null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { report: null, skipped: 'malformed', donePath };
  }
  // Shape guard: `null`, a bare JSON string, and a JSON array all parse without throwing and are
  // none of them the JobReport object this function exists to read.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { report: null, skipped: 'wrong-shape', donePath };
  }
  if (typeof parsed.verdict !== 'string' || parsed.verdict === '') {
    return { report: null, skipped: 'no-verdict-field', donePath };
  }
  return { report: parsed, skipped: null, donePath };
}

// Journals the attempt either way (a maintainer reading journal.jsonl can always see whether the
// richer read was tried and why it did or did not apply) and returns the JobReport, or `null`
// when anything short of a genuine, well-shaped report was found -- callers fall back to their
// pre-existing routing on `null`, exactly as if this function did not exist.
function readGateJobReportForRouting(ctx, config, state, stdout) {
  const jobId = parseGateJobId(stdout);
  const { report, skipped, donePath } = readGateDoneReport(config, jobId);
  appendEvent(ctx.taskDir, state, 'gate-job-report-read', {
    jobId,
    donePath,
    skipped,
    verdict: report ? report.verdict : null,
  });
  return report;
}

async function realGate(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;
  moveCard(ctx, deps, 'GATE'); // kanban piloting
  const r = spawnStep(ctx, deps, 'GATE', 'npm', ['run', 'gate'], { cwd: worktreePath });

  // journal/<id>/gate.log is DIAGNOSE's declared input for "the last gate run's output" -- unlike
  // appendSpawnLog's own journal/<id>/logs/GATE.log (untouched, above, still accumulates across
  // every visit to this state), this file is OVERWRITTEN on every real gate run, so a judge
  // reading it always sees exactly this run and never a concatenation of earlier attempts. See
  // action 1.3 / prepareJudgeInputs below, which only ever checks this file for existence -- it
  // never runs the gate itself.
  fs.writeFileSync(gateLogPath(ctx.taskDir), r.stdout || r.stderr || '');

  if (r.exit === 0) {
    // ---- action B2.3(a): exit 0 is no longer read as proof on its own -----------------------
    //
    // The bench-side fix (verify-gate.js) now fails a routed-but-not-driven diff closed --
    // BLOCKED, never PASS -- so this combination should be unreachable from a CURRENT worker.
    // This check is the pipeline's OWN read of the same fact, defence in depth: it also covers a
    // verdict written by an older worker binary, and a REUSED verdict (merge-queue.ts's
    // `mayReuseVerdict`) copied forward from one. Reaching it at all means something is wrong
    // that a human should see, not something a retry can fix -- WORKTREE->PLAN->IMPLEMENT->GATE
    // would just ask the exact same worker the exact same question at real LLM cost, so this
    // reason is never added to state-machine.js's TRANSIENT_RETRY_REASONS.
    const headSha = resolveGateHeadSha(ctx, deps, worktreePath);
    if (!headSha) return 'CI_CHECKS'; // unreadable HEAD is a failed diagnostic, not evidence -- unchanged behaviour

    const verdictPath = path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`);
    const verdict = readJsonSafe(verdictPath); // same accessor the exit-1 path below and realCiChecks already use

    // Absence must be safe (action B2.3(c)): no verdict file at all (515 of 517 files on this
    // very machine today have none), a verdict present but with no `live` key (every verdict
    // written before this field existed -- see verdict.ts's own field comment), an unparsable
    // file, or `live.status === 'unknown'` are ALL the identical fact -- "nothing on file proves
    // the live stage ran" -- and none of them may be read as proof either way. Parking on any of
    // them would stall the whole backlog on old data; routing exactly as before (CI_CHECKS) is
    // the defensible middle this action calls for. Journalled so the gap stays visible without
    // being actionable per card.
    const live = verdict && verdict.live;
    if (!live || live.status === 'unknown') {
      appendEvent(ctx.taskDir, 'GATE', 'gate-live-unknown', {
        headSha,
        verdictPath,
        verdictExists: fs.existsSync(verdictPath),
      });
      return 'CI_CHECKS';
    }

    if (liveRoutedButNotDriven(live)) {
      appendEvent(ctx.taskDir, 'GATE', 'gate-live-not-driven', {
        headSha,
        exitFrom: 0,
        why: live.why,
        required: live.required,
      });
      // exitFrom on the ParkSignal detail too (adversarial verification T4), not only the
      // journal event above -- the park comment and state.json are built from `detail`
      // (park-loop.js's buildParkComment), and before this fix neither one said whether this
      // park arrived honestly off exit 1 or via the pipeline's own defence-in-depth read of a
      // PASS/exit-0 verdict; a maintainer had to open journal.jsonl to tell the two apart.
      throw new ParkSignal('gate-live-not-driven', { headSha, exitFrom: 0, why: live.why, required: live.required });
    }

    // live.status === 'ran', or 'skipped' with nothing required (the common, legitimate case) --
    // proceed exactly as before.
    return 'CI_CHECKS';
  }

  if (r.exit === 1) {
    // ---- action 4.2: exit 1 is no longer an unconditional route to DIAGNOSE ------------------
    //
    // The plan called for deriving `baseMain` from the journaled origin/main sha whenever the
    // bench's own verdict for HEAD lacks one, then intersecting file lists exactly like
    // CI_CHECKS' own main-moved test (below). Measurement changed the plan: `baseMain` is not
    // merely sometimes missing on a FAIL -- it is missing in EXACTLY the case this action exists
    // to catch, and there is nothing to derive it FROM when it is. `SPO-WebClient/src/e2e/bench/
    // worker.ts` sets `report.baseMain = deps.resolveRef(request.worktree, 'origin/main')` at
    // line ~429, AFTER `prepareRef` (line ~369) has already merged `origin/main` into the fetched
    // checkout -- and when that merge itself conflicts, `prepareRef` returns `finish('FAIL',
    // '<ref> does not merge cleanly with origin/main (base <sha>)')` at line ~374, before
    // `baseMain` is ever assigned. So a branch that no longer merges cleanly with `origin/main`
    // FAILs with no `baseMain` to derive anything from, and the plan's intersection test cannot
    // run there at all -- it is not implemented here.
    //
    // Measured over all 491 files in `~/.spo-bench/verdicts/`, restricted to the 375 `ref`-type
    // jobs `npm run gate` actually submits (`SPO-WebClient/scripts/bench-gate.sh` -- the other
    // job types are not what GATE waits on): PASS 359/359 carry `baseMain`; FAIL 14/16 carry
    // `baseMain` and the 2 that do NOT are the main-moved conflicts. Confirmed end to end on a
    // real card: `journal/issue-439/journal.jsonl` shows a GATE exit 1 at 2026-08-30T02:12:35Z;
    // that attempt's DIAGNOSE (attempt 2) root cause reads "The attempt's branch (379ada60, based
    // on main@5f0f4886) no longer merges cleanly with origin/main: while the task ran, PR #436
    // (issue-213, merge db3dec5a) landed..."; and
    // `~/.spo-bench/verdicts/379ada60dd05ab7e95df11d6bba77af2f88b05a0.json` is exactly
    // `{"verdict":"FAIL"}`, no `baseMain`, written 02:12:33.802Z -- the instant `prepareRef`
    // discovered the conflict, not a code failure. That card burned all 3 DIAGNOSE attempts (a
    // judge cannot fix a conflict IMPLEMENT never even saw) and parked `diagnose-budget-
    // exhausted`; a maintainer's `retry` restarted it at INTAKE from a fresh worktree off the new
    // `main` and it reached DONE in 19 minutes. That IS the fix this block encodes: recognise the
    // shape (FAIL, no baseMain) and either merge locally or park honestly for a fresh restart --
    // never spend a judge call trying to diagnose code that was never actually the problem.
    //
    // The mirror-image case matters just as much: a FAIL that DOES carry `baseMain` is a
    // genuinely different failure, not a smaller version of the main-moved one. The bench had
    // already merged `origin/main` into the checkout before it ever built, so that run failed
    // WITH `main` already in the tree -- there is nothing left for a local merge to fix, and
    // running the intersection test there would risk routing a real failure to CHECK instead of
    // to a judge. It keeps going to DIAGNOSE, unchanged, at the bottom of this block.
    //
    // A third shape a plain "exit 1 -> DIAGNOSE" mapping already missed entirely: worker.ts's
    // `NON_ATTESTING` set is `{DIRTY, ENVIRONMENT, ABANDONED}`, and verdicts in that set are
    // deliberately never written to `verdicts/` at all -- yet cli.ts's `wait()` returns
    // `report.verdict === 'PASS' || 'LEASED' ? 0 : 1`, so all three still reach here as a plain
    // exit 1, indistinguishable by exit code alone from a real gate failure. A dead gateway, a
    // lost owner lease, or a failed fetch means NOTHING was learned about the code -- not
    // "something went wrong reading the verdict file" -- so a MISSING verdict file parks honestly
    // (`gate-non-attesting`) instead of spending a DIAGNOSE call asking a judge to explain a
    // failure that was never actually observed. (Action 4.4 adds `gate-non-attesting` to its
    // transient auto-retry allowlist, so this parks honestly today and self-heals once that
    // lands -- no retry loop is built here.)
    // Action B2.3: this used to be its own inline rev-parse + shape check; now shared with the
    // exit-0 path above via resolveGateHeadSha (identical behaviour -- exit 0 is necessary but
    // NOT sufficient to trust the stdout, action 4.1's own finding: a failing `git rev-parse
    // <ref>` prints the REF NAME ITSELF on stdout, measured: an orphan/unborn HEAD gives exit
    // 128, "fatal: ambiguous argument 'HEAD'" on stderr, and the literal `HEAD` on stdout. The
    // cost of NOT catching the shape is higher here than at realPushPr's guard: there a bogus sha
    // fell through to a push that could only fail, whereas here it makes `verdicts/<bogus>.json`
    // miss -- and a miss PARKS the card `gate-non-attesting`, i.e. tells a maintainer "the bench
    // attested nothing about your code" when the truth is that the machine never asked the bench
    // the right question. Never park on a failed diagnostic -- routed to DIAGNOSE instead, same
    // as a non-zero exit.)
    const headSha = resolveGateHeadSha(ctx, deps, worktreePath);
    if (!headSha) return 'DIAGNOSE';

    const verdictPath = path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`);
    const verdict = readJsonSafe(verdictPath); // same accessor realCiChecks already uses below

    if (!verdict) {
      // readJsonSafe returns null for TWO different facts, and only one of them is "the run was
      // non-attesting": the file is not there (the NON_ATTESTING case this block exists for), or
      // the file IS there and did not parse -- a truncated write (379ada60's verdict landed at
      // 02:12:33.802Z, 1.2s before the CLI's own exit, so the window is small but real), a
      // permission error, a half-synced read. The second is a failed LOOKUP, not a verdict, and
      // parking a card on a failed lookup is exactly the mistake the rev-parse branch above
      // refuses to make. One `fs.existsSync` separates them.
      if (fs.existsSync(verdictPath)) {
        appendEvent(ctx.taskDir, 'GATE', 'gate-verdict-unreadable', { step: 'verdict-parse', verdictPath });
        return 'DIAGNOSE';
      }

      // Action B3.4: before falling back to the undifferentiated `gate-non-attesting`, ask the
      // job's own `done/<id>.json` which of the four NON_ATTESTING-or-INTERRUPTED verdicts this
      // actually was -- see readGateJobReportForRouting's header above for why this file is safe
      // to trust here and what makes it fall back cleanly when it is not available. Only the four
      // verdicts that explain "no verdicts/<sha>.json entry exists" are branched on by name; a
      // report present here that is verdict PASS/LEASED (contradicts exit 1) or FAIL/BLOCKED/
      // STALE (those DO get written to verdicts/<sha>.json, so reaching this branch at all with
      // one of THOSE verdicts means the two files disagree) is an inconsistency this function
      // does not try to explain -- it falls through to the pre-existing gate-non-attesting park
      // exactly as if the richer read had failed.
      const jobReport = readGateJobReportForRouting(ctx, config, 'GATE', r.stdout);
      if (jobReport) {
        const detail = { headSha, jobId: jobReport.id, jobDetail: jobReport.detail || null };
        if (jobReport.verdict === 'ENVIRONMENT') {
          appendEvent(ctx.taskDir, 'GATE', 'gate-environment', detail);
          throw new ParkSignal('gate-environment', detail);
        }
        if (jobReport.verdict === 'DIRTY') {
          // NOT the session's own tree (bench-gate.sh already refused a dirty session tree at
          // exit 2, before a job was ever deposited) -- this is worker.ts's OWN shared ref
          // checkout (`paths.refCheckout`) found dirty by the worker itself, after `prepareRef`.
          // A worker-side environment fact, never named `gate-dirty-tree` (that name is reserved
          // for the session's own tree, exit 2, below).
          appendEvent(ctx.taskDir, 'GATE', 'gate-worker-dirty-checkout', detail);
          throw new ParkSignal('gate-worker-dirty-checkout', detail);
        }
        if (jobReport.verdict === 'ABANDONED') {
          appendEvent(ctx.taskDir, 'GATE', 'gate-abandoned', detail);
          throw new ParkSignal('gate-abandoned', detail);
        }
        if (jobReport.verdict === 'INTERRUPTED') {
          appendEvent(ctx.taskDir, 'GATE', 'gate-interrupted', detail);
          throw new ParkSignal('gate-interrupted', detail);
        }
      }

      // `verdictDirExists` is on the event AND on the park detail deliberately: a misconfigured
      // or unmounted `config.spoBenchDir` makes EVERY failing gate land here, and the two cases a
      // maintainer has to tell apart -- "the bench genuinely attested nothing" vs "the machine
      // was looking in the wrong place" -- are otherwise indistinguishable from the park comment
      // alone. It is a stable boolean, so park-loop's countRepeatedParks fingerprint
      // (JSON.stringify(detail)) still matches across a repeated park exactly as before.
      const verdictDirExists = fs.existsSync(path.dirname(verdictPath));
      appendEvent(ctx.taskDir, 'GATE', 'gate-non-attesting', { headSha, verdictPath, verdictDirExists });
      throw new ParkSignal('gate-non-attesting', { headSha, verdictDirExists });
    }

    const baseMain = verdict.baseMain;
    appendEvent(ctx.taskDir, 'GATE', 'gate-verdict', {
      headSha,
      verdict,
      baseMain: baseMain || null,
      merged: verdict.merged === true,
    });

    // ---- action B2.3(b): BLOCKED stops being routed to DIAGNOSE -----------------------------
    //
    // `cli.ts`'s wait() collapses every non-PASS/LEASED report.verdict to the same exit 1
    // (`report.verdict === 'PASS' || 'LEASED' ? 0 : 1`) -- BLOCKED included, and BLOCKED is not in
    // worker.ts's `NON_ATTESTING` set, so the verdict IS on disk here, distinguishable from a real
    // FAIL by `verdict.verdict` alone. Without this check a BLOCKED gate falls straight through to
    // `return 'DIAGNOSE'` at the bottom of this block and asks a judge to diagnose a code defect
    // that was never observed -- verify-gate.js's own BLOCKED comment says as much: "This is not a
    // verdict on the change: the flows could not be driven, none failed." Same shape as
    // `main-moved-conflict` just below (a real park for a "not the code's fault" situation, not a
    // DIAGNOSE call spent on an unanswerable question).
    //
    // Adversarial verification of B2.3 (finding T4) found `BLOCKED` is not one fact, it is at
    // least four, from four different producers in SPO-WebClient, and a bare
    // `verdict.verdict === 'BLOCKED'` check collapsed all of them into `gate-live-not-driven` --
    // a name that asserts "routing required a live drive that never happened". That is true for
    // the headline case (a routed-but-undriven diff, `verify-gate.js:342`, and `verify-gate.js:
    // 308`'s capability-question variant) but false for the fourth: `run.ts:63`'s `runLive`
    // returning BLOCKED because the world lock refused the run (dirty, or another live run
    // already in flight) or, structurally possible but effectively dead today
    // (`E2E_MIN_INTERVAL_MINUTES=0`, `E2E_MAX_RUNS_PER_DAY=1000`, config.ts -- no override set
    // anywhere in this tree), a rate limit. `liveAttestationFrom` (worker.ts) maps that fourth
    // case to `live.status === 'unknown'` -- the IDENTICAL value the exit-0 path just above
    // reads as "nothing proven either way" and explicitly refuses to park on. Parking it here,
    // under a name that claims routing was proven undriven, was the collapse: the same fact
    // treated two opposite ways depending on which exit code carried it.
    //
    // So the split keys on the `live` FACT (`liveRoutedButNotDriven`, shared with the exit-0
    // path above), not the bare verdict string. Only a genuinely routed-but-undriven BLOCKED
    // gets `gate-live-not-driven` -- unchanged reason, unchanged non-transient treatment (a
    // property of the worker binary or a reused verdict, not of the moment; a retry just asks
    // the same worker the same question at real WORKTREE->PLAN->IMPLEMENT->GATE cost). Every
    // other BLOCKED -- world lock, rate limit, or `verify-gate.js:308`'s capability-question
    // variant, where `required` can be empty and nothing was actually routed -- gets its own
    // reason, `gate-live-blocked`, deliberately not reusing a name that would misdescribe it.
    //
    // `gate-live-blocked`'s own disposition: unlike `gate-live-not-driven`, this one IS added to
    // `TRANSIENT_RETRY_REASONS` below. The operational case that motivates it -- a maintainer
    // running `gate:local --live` takes the single-flight lock (`world-lock.ts`'s own error:
    // "A live run is already in flight ... Live runs are single-flight") -- clears itself in
    // minutes, and parking the daemon's card on it permanently for that reason alone would be
    // wrong. A genuinely DIRTY world lock ("Only a human clears this", world-lock.ts) does NOT
    // self-heal, and the rate-limit arm is dead either way -- but `why` is free text from a
    // different repo, not a contract this file should parse to split those apart, and
    // TRANSIENT_RETRY_REASONS' own bounded budget (`config.transientRetryBudget`, default 2)
    // already caps the cost of getting that wrong: a persistently-dirty lock burns at most 2
    // extra WORKTREE->PLAN->IMPLEMENT->GATE cycles before falling through to an ordinary,
    // human-visible park, exactly like `gate-non-attesting`'s own transient-but-bounded
    // treatment above. Self-healing the common case beats a permanent park on a condition that
    // was never the card's fault to begin with.
    if (verdict.verdict === 'BLOCKED') {
      const live = verdict.live;
      if (liveRoutedButNotDriven(live)) {
        appendEvent(ctx.taskDir, 'GATE', 'gate-live-not-driven', {
          headSha,
          exitFrom: 1,
          why: live.why,
          required: live.required,
        });
        throw new ParkSignal('gate-live-not-driven', { headSha, exitFrom: 1, why: live.why, required: live.required });
      }

      appendEvent(ctx.taskDir, 'GATE', 'gate-live-blocked', {
        headSha,
        exitFrom: 1,
        liveStatus: live && live.status,
        why: live && live.why,
      });
      throw new ParkSignal('gate-live-blocked', {
        headSha,
        exitFrom: 1,
        liveStatus: live && live.status,
        why: live && live.why,
      });
    }

    if (verdict.verdict === 'FAIL' && !baseMain) {
      // The bench never got past `prepareRef` -- this branch does not merge with origin/main.
      // Fetch the real remote tip first: the intersection/merge decision below must be made
      // against it, not a lagging local `origin/main`. A non-zero exit here is not fatal --
      // continue with what is already local rather than parking on a flaky fetch.
      const fetch = spawnStep(ctx, deps, 'GATE', 'git', ['-C', worktreePath, 'fetch', 'origin', 'main']);
      if (fetch.exit !== 0) {
        appendEvent(ctx.taskDir, 'GATE', 'gate-main-moved-fetch-failed', { exit: fetch.exit });
      }

      // Action 6.5: compare against the configurable budget (default 1, no behaviour change --
      // see config.js's mainMovedRegateBudget comment for the settled decision and the corpus
      // this default rests on) rather than a hardcoded "once".
      const gateBudget = resolveMainMovedRegateBudget(config);
      if (ctx.counters.mainMoveUsed >= gateBudget) {
        throw new ParkSignal('main-moved-twice', { mainMoveUsed: ctx.counters.mainMoveUsed, mainMovedRegateBudget: gateBudget });
      }
      ctx.counters.mainMoveUsed += 1;

      // Same nightly-red refusal CI_CHECKS applies to its own main-moved merge (guardNightlyRed,
      // above) -- a rev-parse failure here is likewise non-fatal: without a sha to compare, the
      // guard cannot fire, so this degrades to "not known to be red" rather than parking on what
      // is, same as the fetch above, an enrichment lookup rather than the merge decision itself.
      //
      // That asymmetry with CI_CHECKS (whose gitRevParse throws ParkSignal('ci-checks-rev-parse-
      // failed') on the very same failure) is deliberate and it is safe, for a reason worth
      // writing down rather than trusting: skipping the guard cannot let a red `main` be merged,
      // because the merge two lines below resolves the SAME ref. If `git rev-parse origin/main`
      // genuinely cannot resolve it, neither can `git merge origin/main` -- measured in a scratch
      // repo with no remote: rev-parse exits 128 ("unknown revision"), merge exits 1 ("merge:
      // origin/main - not something we can merge") -- so the card parks `main-moved-conflict`
      // rather than merging anything. The one residual window is a rev-parse that fails for a
      // reason unrelated to the ref while the ref itself is fine (an operator's `kill -9` with no
      // deadline armed, which spawnOnce maps to exit 1): the guard is skipped and a red `main`
      // could be merged. Accepted rather than closed, on the same principle as the fetch above --
      // a diagnostic lookup must not become the thing that parks the card -- and a merged red main
      // costs one CHECK/GATE cycle, where a false park costs a maintainer.
      const originMainRes = spawnStep(ctx, deps, 'GATE', 'git', ['-C', worktreePath, 'rev-parse', 'origin/main']);
      if (originMainRes.exit === 0) {
        guardNightlyRed(ctx, 'GATE', config, originMainRes.stdout.trim());
      } else {
        appendEvent(ctx.taskDir, 'GATE', 'gate-main-moved-rev-parse-failed', { exit: originMainRes.exit });
      }

      const merge = spawnStep(ctx, deps, 'GATE', 'git', ['-C', worktreePath, 'merge', 'origin/main']);
      if (merge.exit === 0) {
        appendEvent(ctx.taskDir, 'GATE', 'main-moved-merge', { from: 'GATE' });
        return 'CHECK';
      }

      // Non-zero: abort the failed merge so the worktree is left clean, then park. `merge
      // --abort` goes through spawnStep like everything else here, so its own exit is already
      // journalled by the generic 'spawn' event -- a NON-ZERO exit is deliberately not inspected,
      // because a failed abort must not be allowed to mask the park below.
      //
      // "Not inspected" is not the same as "cannot escape", and the try/catch is what makes the
      // sentence above actually true: since action 2.1, a spawnStep whose command is killed by
      // its own timeout TWICE does not return at all -- it throws ParkSignal('git-timed-out'),
      // which would unwind straight past the throw below and park the card under a reason naming
      // the CLEANUP instead of the cause, taking {headSha, mergeExit} with it. That is action
      // 4.3's verification finding in a different costume (a lookup documented as "never parks"
      // parking the card before its own event was written), and this is one of the two call sites
      // in this block where a spawnStep throw destroys information the rest of the system depends
      // on: `main-moved-conflict` is the whole output of this action, the reason a maintainer
      // reads, and the reason action 4.4 keys its transient-retry decision off. Journal the
      // timeout, then park for the real reason regardless. (The other spawnStep calls here --
      // rev-parse, fetch, merge -- are deliberately NOT wrapped: a hung git there parks
      // `git-timed-out` before any routing decision has been made, which is honest and is exactly
      // what spawnStep's own header prescribes.)
      //
      // What a failed abort leaves behind, traced rather than assumed: an unresolved index with
      // conflict markers. finalizePark then calls preserveWorktreeWip, which does `git status
      // --porcelain` (non-empty -> proceeds), then `git checkout --detach` -- and git REFUSES
      // that on an unmerged index ("error: you need to resolve your current index first", exit 1,
      // measured). preserveWorktreeWip journals `wip-preserve-failed {step:'detach'}` and returns
      // null, so a conflicted tree is never committed to a `wip/` ref and no branch pointer moves.
      // Nothing is lost either: the only content in that tree that is not already on the branch is
      // origin/main's own, and `retry` rebuilds the worktree from scratch anyway.
      try {
        spawnStep(ctx, deps, 'GATE', 'git', ['-C', worktreePath, 'merge', '--abort']);
      } catch (err) {
        if (!(err instanceof ParkSignal)) throw err;
        appendEvent(ctx.taskDir, 'GATE', 'gate-main-moved-abort-failed', { reason: err.reason });
      }
      // Parking here is deliberate, not a gap: #439 proves DIAGNOSE cannot fix a conflict
      // IMPLEMENT never even saw, and a maintainer's `retry` restarts at INTAKE from a fresh
      // worktree off the new main -- which is what actually resolved it, in 19 minutes.
      throw new ParkSignal('main-moved-conflict', { headSha, mergeExit: merge.exit });
    }

    // Action B3.4: STALE ("the tree changed between deposit and the end of the run") is not a
    // code defect either -- verify-gate.js's own PASS/FAIL body verdict, whatever it was, applies
    // to a tree that no longer exists, and the bench's own advice is "resubmit", never "diagnose
    // this". Unlike DIRTY/ENVIRONMENT/ABANDONED/INTERRUPTED above, `verdicts/<sha>.json` IS
    // written for STALE (it is not in `NON_ATTESTING`), so `verdict.verdict === 'STALE'` is
    // already known here without needing `done/<id>.json` -- but that file's own `detail` still
    // gives a maintainer the human-readable "what changed and when" the compact verdicts/ entry
    // does not carry, so it is read best-effort for that alone; its absence never blocks the park.
    if (verdict.verdict === 'STALE') {
      const jobReport = readGateJobReportForRouting(ctx, config, 'GATE', r.stdout);
      const jobDetail = jobReport && jobReport.verdict === 'STALE' ? jobReport.detail || null : null;
      const detail = { headSha, jobDetail };
      appendEvent(ctx.taskDir, 'GATE', 'gate-stale', detail);
      throw new ParkSignal('gate-stale', detail);
    }

    // FAIL carrying baseMain (a real failure -- see the header comment above), or any other
    // shape (e.g. a PASS verdict recorded against an exit-1 gate; BLOCKED/STALE are carved out
    // above) -> DIAGNOSE, unchanged.
    return 'DIAGNOSE';
  }

  // ---- action B3.4: exit 2/3 sub-causes, named from the CLI's own printed diagnostic --------
  //
  // Principle 1 above ("exit codes are the contract... never printed text") still decides the
  // ROUTE for exit 2 and exit 3 -- both remain a park, unconditionally, exactly as before this
  // action. What changes is only the NAME attached to that already-decided park: `done/<id>.json`
  // cannot help here (SPO-WebClient/scripts/bench-gate.sh's own two pre-flight refusals, and
  // cli.ts submit()'s WORKER DOWN / DuplicateJobError checks, all run BEFORE any job is deposited
  // -- there is no job id to parse yet; the one exit-3 case where a job WAS deposited, "WORKER
  // DIED while job was pending", returns the instant `!worker.alive`, before the worker's own
  // restart-time `recoverInterrupted` has had any chance to write that job's `done/<id>.json`) --
  // so the only place the distinguishing fact still exists is the literal diagnostic text each
  // script already prints to stderr, captured unchanged in `r.stderr` (and journalled to
  // gate.log above regardless). Three sub-causes per exit code
  // (SPO-WebClient/scripts/bench-gate.sh's "DIRTY TREE"/"NOT PUSHED", cli.ts submit()'s
  // DuplicateJobError message, for exit 2; SPO-WebClient/scripts/bench-submit.sh's "bench client
  // not built", cli.ts submit()'s "WORKER DOWN", cli.ts wait()'s "WORKER DIED", for exit 3) --
  // matched by substring against known, stable literals this pipeline does not control but does
  // cite exactly (see each regex's own comment). Anything unrecognized falls back to the
  // pre-existing, most-common-case name (`gate-dirty-tree` / `gate-worker-down`) exactly as
  // before this action -- never a new failure mode, only a more specific one when the text is
  // there to support it.
  if (r.exit === 2) {
    const text = (r.stderr || '') + '\n' + (r.stdout || '');
    // scripts/bench-gate.sh: `echo "NOT PUSHED: ..." >&2`
    if (/NOT PUSHED/.test(text)) throw new ParkSignal('gate-not-pushed', { exit: r.exit });
    // job.ts's DuplicateJobError message: "This worktree already has job <id> ... waiting..."
    if (/already has job/.test(text)) throw new ParkSignal('gate-duplicate-job', { exit: r.exit });
    // scripts/bench-gate.sh: `echo "DIRTY TREE: ..." >&2` -- also the fallback for anything this
    // pipeline does not recognize, matching this reason's own pre-existing, most-common meaning.
    throw new ParkSignal('gate-dirty-tree', { exit: r.exit });
  }
  if (r.exit === 3) {
    const text = (r.stderr || '') + '\n' + (r.stdout || '');
    // scripts/bench-submit.sh: `echo "bench client not built at $CLI ..." >&2`
    if (/bench client not built/.test(text)) throw new ParkSignal('gate-worker-not-built', { exit: r.exit });
    // cli.ts wait(): `deps.err(\`WORKER DIED while job ${id} was pending: ...\`)`
    if (/WORKER DIED/.test(text)) throw new ParkSignal('gate-worker-died-midjob', { exit: r.exit });
    // cli.ts submit(): `deps.err(\`WORKER DOWN: ...\`)` -- also the fallback for anything
    // unrecognized, matching this reason's own pre-existing, most-common meaning.
    throw new ParkSignal('gate-worker-down', { exit: r.exit });
  }
  if (r.exit === 4) throw new ParkSignal('gate-timeout', { exit: r.exit });
  throw new ParkSignal('gate-unrecognized-exit', { exit: r.exit });
}

// ---- CI_CHECKS ------------------------------------------------------------------------------
//
// (a) read the check-runs for HEAD via `gh api`, map the one failing name through the shared
//     ci-cause-table.js (the same table handleCiChecks' shadow-fixture path uses).
// (b) only if (a) was green: the main-moved test -- baseMain from the bench's own verdict for
//     this HEAD sha, intersect what origin/main touched since baseMain with what the branch
//     itself touched; non-empty -> merge origin/main and re-CHECK (once; the nightly-red and
//     "already used" guards mirror handleCiChecks' shadow-mode ones exactly).
async function gitRevParse(ctx, deps, worktreePath, ref) {
  const r = spawnStep(ctx, deps, 'CI_CHECKS', 'git', ['-C', worktreePath, 'rev-parse', ref]);
  if (r.exit !== 0) throw new ParkSignal('ci-checks-rev-parse-failed', { ref, exit: r.exit });
  return r.stdout.trim();
}

const CI_GREEN_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `deps.sleep` is the test injection point for realCiChecks' bounded in-flight poll loop below
// -- same convention as `deps.spawnSync` (runSync above) -- production code never passes it, so
// a real run always sleeps for real. Tests inject a no-op (or a recording stub) so the suite
// never actually waits out ciChecksPollIntervalMs x ciChecksMaxPolls.
function pollSleep(deps, ms) {
  const sleepFn = (deps && deps.sleep) || defaultSleep;
  return sleepFn(ms);
}

// One `gh api .../check-runs` fetch for `headSha`, parsed down to
// [{name, conclusion, status, id, app}]. Goes through spawnStep like every other real command
// here, so every poll in the loop below is journalled the same way a single fetch always was.
// `id` and `app` were added by action 4.3: `id` is `check_run.id`, which -- for a GitHub Actions
// run -- IS the job id (`gh api repos/<repo>/actions/jobs/<id>` below); `app` is the check's
// reporting app slug (`r.app && r.app.slug`), which realCiChecks uses to gate that lookup to
// genuine GitHub Actions check runs only (a third-party check's `id` means nothing to that
// endpoint).
function fetchCheckRuns(ctx, deps, config, headSha) {
  const checkRuns = spawnStep(ctx, deps, 'CI_CHECKS', 'gh', [
    'api',
    `repos/${config.ghRepo}/commits/${headSha}/check-runs`,
  ]);
  if (checkRuns.exit !== 0) throw new ParkSignal('ci-checks-read-failed', { exit: checkRuns.exit });

  const parsed = (() => {
    try {
      return JSON.parse(checkRuns.stdout);
    } catch {
      return null;
    }
  })();
  const runs = parsed && Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
  return runs.map((r) => ({
    name: r.name,
    conclusion: r.conclusion,
    status: r.status,
    id: r.id,
    app: r.app && r.app.slug,
  }));
}

async function realCiChecks(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;

  const headSha = await gitRevParse(ctx, deps, worktreePath, 'HEAD');

  // Action 1.7: `c.conclusion && !CI_GREEN_CONCLUSIONS.has(...)` used to skip a check-run whose
  // `conclusion` is still `null` (still running) when looking for a failing one -- so a CI run
  // that had not finished read as green, and an empty `check_runs` array (CI has not even
  // registered yet) had no failing element either, same silent false-green. The audit measured
  // 8/12 real "green" events with `claude review` still in progress. Treat both as "in flight":
  // re-poll, bounded by ciChecksMaxPolls, sleeping ciChecksPollIntervalMs between polls, before
  // ever applying the failing/green decision below. Only once nothing is in flight does that
  // pre-existing logic run.
  const maxPolls = config.ciChecksMaxPolls;
  const pollIntervalMs = config.ciChecksPollIntervalMs;
  let checks = [];
  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    checks = fetchCheckRuns(ctx, deps, config, headSha);
    // In flight = anything that has not landed a usable conclusion. `conclusion == null` catches
    // both null and an absent key, `!c.conclusion` also catches '' -- GitHub happens to always
    // send `conclusion: null` beside `status: 'queued'|'in_progress'`, but relying on that alone
    // left the same shape of hole 1.7 exists to close: a run with the key absent, or empty,
    // counted as neither pending nor failing and read as green. `status !== 'completed'` is the
    // authoritative signal, so honour it when present rather than inferring from conclusion.
    const pendingRuns = checks.filter(
      (c) => !c.conclusion || (c.status !== undefined && c.status !== 'completed')
    ).length;
    const inFlight = checks.length === 0 || pendingRuns > 0;

    if (!inFlight) break;

    appendEvent(ctx.taskDir, 'CI_CHECKS', 'checks-in-flight', {
      attempt,
      totalRuns: checks.length,
      pendingRuns,
    });

    if (attempt === maxPolls) {
      throw new ParkSignal('ci-checks-still-running', { attempts: attempt, totalRuns: checks.length, pendingRuns });
    }
    await pollSleep(deps, pollIntervalMs);
  }

  const failing = checks.find((c) => c.conclusion && !CI_GREEN_CONCLUSIONS.has(c.conclusion));

  if (failing) {
    // Action 4.3: `failing.name` is a JOB name (`typecheck + tests`, etc.), never one of the
    // step names ci-cause-table.js actually classifies on -- see that file's header for the full
    // measurement. Recover the step by treating `failing.id` as the GitHub Actions job id
    // (verified on six real failed runs) and fetching that job's `steps[]`. Gate the lookup to
    // genuine GitHub Actions runs with a numeric id: a third-party check (`app` anything else,
    // e.g. a bot-reported check with no run behind it) or a shape this code has never seen
    // degrades straight to `stepName = null` -- no lookup attempted -- rather than spawning a
    // `gh api` call that cannot possibly resolve to a job.
    let stepName = null;
    if (failing.app === 'github-actions' && typeof failing.id === 'number') {
      // This lookup is best-effort ONLY -- it exists to sharpen a DIAGNOSE-bound classification
      // into an IMPLEMENT retry or a PARK for the handful of steps ci-cause-table.js recognises.
      // It must never itself park or throw: a bad exit, an unparsable body, or a missing
      // `steps` array just degrades to today's behaviour (classify on the check name alone,
      // which -- see ci-cause-table.js's header -- always resolves to DIAGNOSE). Losing the step
      // detail must never be the thing that breaks a card.
      //
      // THE TRY/CATCH IS LOAD-BEARING, not defensive decoration. spawnStep is NOT a plain
      // "return a result" call: on a spawnSync timeout it retries once and then THROWS
      // ParkSignal(`${commandClass}-timed-out`) -- `gh-timed-out` here, since classifyCommand
      // gives `gh` a class default from config.commandTimeoutsMs. Without this catch, a slow or
      // hung GitHub API on a call that exists purely to ENRICH the routing would park a card
      // whose CI failure was perfectly routable to DIAGNOSE, and would do it BEFORE the
      // `check-failed` event below is written -- so the journal would carry `gh-timed-out` and
      // no record of the CI failure at all, blinding `spo`, the dashboard and the judges, which
      // all read `check-failed`. That is the exact shape of bug this action exists to remove
      // (a CI failure that cannot reach the right next state), reintroduced by its own fix.
      // Any other throw (a spawnSync argument rejection, a deps stub blowing up) degrades the
      // same way and for the same reason; it is journalled rather than swallowed, so a real
      // programming error here is still visible in the ledger instead of merely silent.
      let jobRes = null;
      try {
        jobRes = spawnStep(ctx, deps, 'CI_CHECKS', 'gh', [
          'api',
          `repos/${config.ghRepo}/actions/jobs/${failing.id}`,
        ]);
      } catch (err) {
        appendEvent(ctx.taskDir, 'CI_CHECKS', 'ci-step-lookup-failed', {
          check: failing.name,
          exit: null,
          error: (err && err.reason) || (err && err.message) || String(err),
        });
      }
      if (jobRes) {
        const jobParsed = (() => {
          try {
            return JSON.parse(jobRes.stdout);
          } catch {
            return null;
          }
        })();
        // Exit code first, per CLAUDE.md's "verdict by exit code, never by reading `gh`'s text
        // output": a non-zero `gh api` still prints a body (`{"message":"Not Found",...}`, and
        // on some failures a stale/partial one), so a parse that happens to succeed must not be
        // allowed to override the exit code's verdict.
        if (jobRes.exit !== 0 || !jobParsed || !Array.isArray(jobParsed.steps)) {
          appendEvent(ctx.taskDir, 'CI_CHECKS', 'ci-step-lookup-failed', {
            check: failing.name,
            exit: jobRes.exit,
          });
        } else {
          // FIRST non-success, non-skipped step, never the last: a failing step in ci.yml's
          // `verify` job is the CAUSE, and the steps after it are its consequences (a `Lint`
          // failure that leaves `Tests` failing too must route on `Lint` -> IMPLEMENT, not on
          // `Tests` -> DIAGNOSE). `skipped` is not a failure at all -- GitHub marks every step
          // after the failing one `skipped` when the job stops there.
          const failedStep = jobParsed.steps.find(
            (s) => s.conclusion !== 'success' && s.conclusion !== 'skipped'
          );
          stepName = failedStep ? failedStep.name : null;
        }
      }
    }

    appendEvent(ctx.taskDir, 'CI_CHECKS', 'check-failed', {
      check: failing.name,
      step: stepName,
      jobId: failing.id,
    });
    const outcome = classifyCiFailure(failing.name, stepName);
    // `step` in the detail as well as `check`: the park comment is a maintainer's only pointer at
    // WHICH ci.yml step demanded approval, and the shadow-fixture path emits the same two-field
    // detail -- park-loop.js's countRepeatedParks fingerprints on JSON.stringify(detail), so the
    // two paths' shapes have to agree or a repeated park stops being recognised as repeated.
    if (outcome.kind === 'park') throw new ParkSignal(outcome.reason, { check: failing.name, step: stepName });
    return outcome.nextState;
  }
  appendEvent(ctx.taskDir, 'CI_CHECKS', 'checks-green', { headSha, checks });

  const verdict = readJsonSafe(path.join(config.spoBenchDir, 'verdicts', `${headSha}.json`));
  const baseMain = verdict && verdict.baseMain;
  if (!baseMain) return 'VALIDATE'; // nothing recorded to compare against -- treat as not moved

  const diffMain = spawnStep(ctx, deps, 'CI_CHECKS', 'git', [
    '-C',
    worktreePath,
    'diff',
    '--name-only',
    `${baseMain}..origin/main`,
  ]);
  const diffBranch = spawnStep(ctx, deps, 'CI_CHECKS', 'git', [
    '-C',
    worktreePath,
    'diff',
    '--name-only',
    'origin/main...HEAD',
  ]);

  const filesMain = new Set(splitLines(diffMain.stdout));
  const filesBranch = splitLines(diffBranch.stdout);
  const moved = filesBranch.some((f) => filesMain.has(f));

  if (!moved) return 'VALIDATE';

  const originMainSha = await gitRevParse(ctx, deps, worktreePath, 'origin/main');
  guardNightlyRed(ctx, 'CI_CHECKS', config, originMainSha); // action 4.2: shared with GATE's own main-moved path
  // Action 6.5: same configurable-budget comparison GATE's own main-moved path uses above --
  // see this function's shared counter with realGate (action 4.2) and config.js's
  // mainMovedRegateBudget comment.
  const ciChecksBudget = resolveMainMovedRegateBudget(config);
  if (ctx.counters.mainMoveUsed >= ciChecksBudget) {
    throw new ParkSignal('main-moved-twice', { mainMoveUsed: ctx.counters.mainMoveUsed, mainMovedRegateBudget: ciChecksBudget });
  }
  ctx.counters.mainMoveUsed += 1;

  const merge = spawnStep(ctx, deps, 'CI_CHECKS', 'git', ['-C', worktreePath, 'merge', 'origin/main']);
  if (merge.exit !== 0) throw new ParkSignal('main-moved-merge-failed', { exit: merge.exit });

  appendEvent(ctx.taskDir, 'CI_CHECKS', 'main-moved-merge', {});
  return 'CHECK';
}

// ---- MERGE ----------------------------------------------------------------------------------
//
// `gh pr merge --merge` enqueues (never --delete-branch -- see orchestrator/README.md); then
// `npm run pr:wait`, with exactly one bounded re-wait on "still open" (exit 4), matching
// handleMerge's own shadow-mode logic.
async function realMerge(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;
  const prNumber = ctx.prNumber;

  moveCard(ctx, deps, 'MERGE'); // kanban piloting

  const enqueue = spawnStep(ctx, deps, 'MERGE', 'gh', [
    'pr',
    'merge',
    String(prNumber),
    '--repo',
    config.ghRepo,
    '--merge',
  ]);
  appendEvent(ctx.taskDir, 'MERGE', 'pr-merge-enqueue', { exit: enqueue.exit });
  if (enqueue.exit !== 0) throw new ParkSignal('pr-merge-enqueue-failed', { exit: enqueue.exit });

  const w1 = spawnStep(ctx, deps, 'MERGE', 'npm', ['run', 'pr:wait', '--', String(prNumber)], { cwd: worktreePath });
  appendEvent(ctx.taskDir, 'MERGE', 'pr-wait', { attempt: 1, exit: w1.exit });
  if (w1.exit === 0) return 'FINISH';
  if (w1.exit === 1) throw new ParkSignal('pr-closed-unmerged', { exit: w1.exit });
  if (w1.exit === 4) {
    const w2 = spawnStep(ctx, deps, 'MERGE', 'npm', ['run', 'pr:wait', '--', String(prNumber)], { cwd: worktreePath });
    appendEvent(ctx.taskDir, 'MERGE', 'pr-wait', { attempt: 2, exit: w2.exit, bounded: true });
    if (w2.exit === 0) return 'FINISH';
    throw new ParkSignal('merge-queue-not-landing', { lastExit: w2.exit });
  }
  throw new ParkSignal('pr-wait-unrecognized-exit', { exit: w1.exit });
}

// ---- FINISH ---------------------------------------------------------------------------------
//
// Board sync (Done + a short comment) runs from the worktree cwd, exactly like WORKTREE's claim
// -- the same "npm aliases need a product cwd" rule -- and BEFORE the worktree is removed.
// finalComment(ctx, deps) -- action 5.2: enriches the three-line Done comment ("Merged via
// claude-pipe/<id>.", the PR number, "Pipeline run complete.") with what the card actually cost
// and how hard it was, because a maintainer closing an issue used to learn neither. Everything
// below comes from task-summary.js's summarizeTask(ctx.taskDir), the SAME reduction
// sumJournalBillableTokens (below) and park-loop.js's postParkComment both use -- one read of
// this task's journal, one set of counting rules, not three independently-maintained ones.
//
// Token line: "not recorded" rather than "0" when no `llm-call` in the journal carried a numeric
// billableTokens at all (107 of 110 events in the corpus this action was measured against --
// only issue-471's 3 calls postdate token capture shipping, 2026-08-31). A journal whose one real
// call genuinely reports billableTokens: 0 still renders "0" -- summarizeTask's hasTokenData is
// keyed off FIELD PRESENCE, never off whether the sum happens to be zero, which is the whole
// point (see its own header).
//
// Duration line: labelled "pipeline time (first journal event to now)", deliberately NOT just
// "duration" -- measured on issue-471, the journal itself spans 15m12s (first event to `finished`)
// while the figure recorded everywhere else for that same card is 42 minutes, because report
// pull, intake, confirm and triage all run before this taskDir's journal.jsonl exists at all. An
// unlabelled duration here would read as contradicting the project's own record of the same card.
// The end boundary is "now" (deps.now, same injectable-clock convention unparkScan already uses),
// not the `finished` event's own timestamp, because that event is appended AFTER this comment is
// built and written (see realFinish below) -- the two are microseconds apart in practice.
//
// Attempts: only counters that are genuinely positive get a row (formatAttemptLines) -- a card
// that went straight through must not be padded with a row of zeroes, and DIAGNOSE/VALIDATE/CI-
// implement-retry counts are cumulative across this taskDir's whole history (every retry reuses
// the same taskDir -- see task-summary.js's own header), not just whichever run happened to
// finish.
function finalComment(ctx, deps = {}) {
  const lines = [`Merged via claude-pipe/${ctx.id}.`];
  if (ctx.prNumber) lines.push(`PR #${ctx.prNumber}.`);

  const summary = summarizeTask(ctx.taskDir);
  lines.push(
    `Billable-weighted tokens: ${summary.hasTokenData ? formatTokenCount(summary.billableTokens) : 'not recorded'}`
  );

  // Elapsed, and -- when the card ever parked -- how much of it was spent waiting on a human.
  // Measured, and the reason the bare number could not ship: on 6 of the 19 corpus tasks the
  // elapsed span is dominated by parked time, by up to 50x. issue-213 renders 48h44m49s against
  // about 1h24m of actual machine work across 2 parks; issue-428, 47h30m05s against ~59m.
  // "Pipeline time: 47h30m05s" with nothing beside it is a worse lie than the one erratum 3
  // warned about (15m12s vs the 42 minutes recorded for #471) -- same class, opposite direction,
  // and an order of magnitude bigger. The parked span is summed exactly from the journal, never
  // from a "gaps longer than N minutes" heuristic.
  if (summary.firstEventTs) {
    const nowMs = typeof deps.now === 'number' ? deps.now : Date.now();
    const duration = formatDuration(nowMs - Date.parse(summary.firstEventTs));
    if (duration) lines.push(`Elapsed (first journal event to now): ${duration}`);

    if (summary.parksCount > 0) {
      let parkedMs = summary.parkedMs;
      // An open park (parked with nothing after it) is closed against this same `now`, so the two
      // numbers on the card are always read off one clock.
      if (summary.openParkTs) {
        const open = nowMs - Date.parse(summary.openParkTs);
        if (Number.isFinite(open) && open > 0) parkedMs += open;
      }
      const parked = formatDuration(parkedMs);
      const plural = summary.parksCount === 1 ? 'park' : 'parks';
      if (parked) lines.push(`  of which ${parked} parked waiting for a maintainer, across ${summary.parksCount} ${plural}.`);
    }
  }

  const attemptLines = formatAttemptLines(summary);
  if (attemptLines.length > 0) {
    lines.push('Attempts:');
    lines.push(...attemptLines);
  }

  lines.push('Pipeline run complete.');
  return lines.join('\n') + '\n';
}

// sumJournalBillableTokens(taskDir) -- the task's total billable-weighted tokens (fresh input +
// cache-creation + output, cache-read excluded -- see orchestrator/tokens.js's header for why),
// summed across every `llm-call` event this task's journal recorded. Dollar figures are retired
// entirely (maintainer decision, 2026-08-31); this replaces the old sumJournalCost, same
// "journal is the only ledger" reasoning. Action 5.2 moved the actual read/parse/sum into
// task-summary.js's summarizeTask (shared with finalComment above and park-loop.js's
// postParkComment) -- this stays as a thin wrapper, unchanged signature and return type, so the
// 'finished' event below (and any other existing caller) doesn't have to change shape, and so
// there remains exactly ONE place that sums a journal's billable tokens, not a second one grown
// beside it.
function sumJournalBillableTokens(taskDir) {
  return summarizeTask(taskDir).billableTokens;
}

// BENCH_PATH_RE -- the pipeline's own copy of scripts/finish.sh's own path test
// (`grep -qE '^src/e2e/bench/|^scripts/bench-'`), matched against ONE name per line the way
// `git diff --name-only` (and this file's own splitLines) always produce it.
const BENCH_PATH_RE = /^(?:src\/e2e\/bench\/|scripts\/bench-)/;
function benchPathsTouched(diffNameOnlyOutput) {
  return splitLines(diffNameOnlyOutput).some((p) => BENCH_PATH_RE.test(p));
}

// Post-verification hazard fix (action B1.4): bench-install.sh ends in an unconditional
// `systemctl --user restart spo-bench-worker.service` -- worker.ts:1169 maps that SIGTERM straight
// to `process.exit(0)`, no drain -- and this daemon runs K=2 in production (SPO_WORKERS=2 on the
// live systemd drop-in). Without this wait, a card reaching FINISH's reinstall step can cut a
// SIBLING card's in-flight GATE mid-job: the cut job recovers as INTERRUPTED (worker.ts's
// recoverInterrupted never calls writeVerdictIn), so the sibling's GATE finds no
// verdicts/<sha>.json and parks `gate-non-attesting` -- transient-retryable, but
// state-machine.js's own TRANSIENT_RETRY_REASONS comment is explicit that a transient retry
// re-runs WORKTREE, PLAN, IMPLEMENT and GATE: real LLM spend caused by this action, not merely a
// wasted gate. The product-repo mutex this section already holds cannot guard against this
// either way -- the bench worker is a systemd unit, not the product-repo clone, so GATE (which
// takes no lock at all) is never excluded by it.
//
// benchQueueDepth(deps, config) -- ~/.spo-bench/spool (jobs waiting for a worker) and
// ~/.spo-bench/running (jobs a worker currently holds), the SAME two directories `spo status`
// already reports (bin/spo's own collectBenchQueueDepth) -- read the same way here rather than
// re-derived, the exact kind of second-copy-that-drifts CLAUDE.md's `gh api -f` story is about.
// `deps.readdirSync` is the test injection point, same convention as this file's own
// `deps.spawnSync`/`deps.sleep`; production code never passes it.
// countDirEntries(readdirSyncFn, dir) -> {count, error} -- W2 (post-verification, third pass):
// `error` is null for a genuinely EMPTY answer -- the directory does not exist (ENOENT), which
// covers BOTH "no bench installed on this box" and "neither spool/ nor running/ has ever been
// created yet", bin/spo's own countDirEntries makes the identical ENOENT -> 0 choice for the
// identical reason -- and non-null for anything else (EACCES, EIO, ENOTDIR, a symlink loop, ...)
// that must NEVER be silently read as "idle". Before this fix EVERY error collapsed to 0, i.e.
// "safe to restart the worker" -- the opposite of the conservative direction for a safety gate: a
// misconfigured or unreadable SPO_BENCH_DIR silently reduced the whole wait to a no-op while the
// suite stayed green (mutation W2, adversarial verification round 2). realGate's own
// `verdictDirExists` (this file, ~line 1455) already draws the identical distinction one function
// away -- "the bench genuinely attested nothing" vs "the machine was looking in the wrong place"
// -- this follows that same pattern rather than inventing a second one.
function countDirEntries(readdirSyncFn, dir) {
  try {
    return { count: readdirSyncFn(dir).length, error: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { count: 0, error: null };
    return { count: 0, error: err };
  }
}

// benchQueueDepth(deps, config) -- reads config.spoBenchDir's own spool/ (jobs waiting for a
// worker) and running/ (jobs a worker currently holds), the SAME two directories `spo status`
// already reports (bin/spo's own collectBenchQueueDepth) -- read the same way here rather than
// re-derived, the exact kind of second-copy-that-drifts CLAUDE.md's `gh api -f` story is about.
// `deps.readdirSync` is the test injection point, same convention as this file's own
// `deps.spawnSync`/`deps.sleep`; production code never passes it. Exported (module.exports below)
// so payBenchReinstallDebtIfOwed's own decideInstall (above) can read the SAME function rather
// than a second copy.
//
// `error` on the returned object (see countDirEntries above) is the FIRST of spool's/running's own
// unexpected errors, non-null only when one of the two subdirectories could not actually be read
// for a reason other than "it simply is not there yet" -- every caller below must treat that as
// UNKNOWN, never as "idle".
function benchQueueDepth(deps, config) {
  const readdirSyncFn = (deps && deps.readdirSync) || fs.readdirSync;
  const benchDir = config.spoBenchDir;
  const spool = countDirEntries(readdirSyncFn, path.join(benchDir, 'spool'));
  const running = countDirEntries(readdirSyncFn, path.join(benchDir, 'running'));
  return {
    spool: spool.count,
    running: running.count,
    error: spool.error || running.error,
  };
}

// waitForBenchIdle(ctx, deps, config) -> {idle, attempts, spool, running} -- polls
// benchQueueDepth until BOTH directories are empty, sleeping config.benchIdleWaitPollIntervalMs
// between polls (same `pollSleep` idiom realCiChecks' own bounded poll loop below uses), bounded
// by config.benchIdleWaitMaxPolls. Called ONLY once the fast-forward has already succeeded AND
// benchTouched is true -- i.e. only when the worker genuinely needs reinstalling (see realFinish's
// own call site below, and V20/adversarial verification round 2's own note on why that ordering
// itself is pinned by a dedicated test now, not merely implied).
//
// R1 (post-verification, third pass): this used to PARK (`finish-failed`/`bench-idle-wait`) the
// instant the bound was exhausted. That policy was wrong on three counts, all measured: (1)
// `finish-failed` is not on state-machine.js's TRANSIENT_RETRY_REASONS -- terminal, human-only;
// (2) the park fires BEFORE the board move below, so a card whose PR has ALREADY MERGED sits in
// `Merging` with its worktree still on disk until a human intervenes; (3) the 15-minute bound is
// not generous against the actual population of bench jobs -- the config comment's own "generous"
// claim was derived only from bench-queue-wait.js's ref/nightly constants and omitted
// SPO-WebClient's worker.ts:110-111 `DEFAULT_LEASE_MINUTES = 30` / `MAX_LEASE_MINUTES = 120`: an
// ORDINARY human bench lease on this shared machine (2x-8x the bound) would terminally park any
// bench-touching card the daemon finishes during it -- the same "a human's normal use of a shared
// resource terminally parks a merged card" failure the `--untracked-files=no` narrowing exists to
// prevent, reintroduced through a different door.
//
// So this function no longer THROWS on a timed-out wait -- it returns `{idle: false, ...}` and
// leaves the decision to its caller (realFinish): DEFER the reinstall (journal
// `bench-reinstall-deferred` loudly, record the debt durably via journal.js's
// writeBenchReinstallOwed, let the card finish normally -- board move, comment, worktree remove,
// DONE) rather than park a card whose PR has already merged. realWorktree's own
// payBenchReinstallDebtIfOwed pays the debt back the NEXT time a card reaches WORKTREE and finds
// the bench idle (round 4: no separate daemon timer). The bounded wait ITSELF is unchanged by
// this -- it still absorbs the common case of a gate finishing seconds later; only the TIMEOUT
// behaviour moved from park to defer.
//
// An UNREADABLE bench dir (W2's `depth.error`, above) is a different, non-transient class of
// problem that polling cannot fix -- no amount of waiting turns a misconfigured or permission-
// denied directory readable -- so that path is still thrown here, immediately, distinguishably
// from both a busy bench (deferred, not parked) and every other `finish-failed` reason.
async function waitForBenchIdle(ctx, deps, config) {
  const maxPolls = config.benchIdleWaitMaxPolls;
  const pollIntervalMs = config.benchIdleWaitPollIntervalMs;

  const throwUnreadable = (depth, attempt) => {
    appendEvent(ctx.taskDir, 'FINISH', 'bench-dir-unreadable', { code: (depth.error && depth.error.code) || null, attempt });
    throw new ParkSignal('finish-failed', {
      step: 'bench-idle-wait',
      reason: 'bench-dir-unreadable',
      code: (depth.error && depth.error.code) || null,
    });
  };

  let depth = benchQueueDepth(deps, config);
  if (depth.error) throwUnreadable(depth, 0);

  let attempt = 0;
  while ((depth.spool > 0 || depth.running > 0) && attempt < maxPolls) {
    attempt += 1;
    appendEvent(ctx.taskDir, 'FINISH', 'bench-busy-wait', { attempt, spool: depth.spool, running: depth.running });
    await pollSleep(deps, pollIntervalMs);
    depth = benchQueueDepth(deps, config);
    if (depth.error) throwUnreadable(depth, attempt);
  }
  if (depth.spool > 0 || depth.running > 0) {
    appendEvent(ctx.taskDir, 'FINISH', 'bench-idle-wait-timed-out', { attempts: attempt, spool: depth.spool, running: depth.running });
    return { idle: false, attempts: attempt, spool: depth.spool, running: depth.running };
  }
  appendEvent(ctx.taskDir, 'FINISH', 'bench-idle', { attempts: attempt });
  return { idle: true, attempts: attempt };
}

// action B1.4: fast-forward config.productRepo's own checkout to origin/main, then -- ONLY when
// this card's merge touched the bench worker's own sources -- reinstall it. Mirrors
// SPO-WebClient's scripts/finish.sh, the rule a HUMAN session already runs after merging (fast-
// forward `~/SPO-WebClient`, `git diff --name-only <merge_sha>^ <merge_sha> | grep -qE
// '^src/e2e/bench/|^scripts/bench-'`, then `bash scripts/bench-install.sh`) but that this pipeline
// itself had NEVER run: realFinish did board-move/issue-comment/worktree-remove and nothing else,
// so a PR merged by the daemon left the bench worker exactly as stale as one merged by a human who
// never ran `npm run finish` -- the root cause behind the bench worker silently running a stale
// binary for 3.5 days across 11 merges (see this action's own report for the full account).
//
// THE TRAP, and why this is not two independent steps: scripts/bench-install.sh builds from
// WHATEVER config.productRepo is currently checked out to (`REPO="$(cd "$(dirname "$0")/.." &&
// pwd)"`, then `npm run build:e2e`, then `systemctl --user restart`). Reinstalling from a checkout
// that is behind, dirty, or on the wrong branch installs the WRONG binary and reports success --
// reproducing the exact defect class this action exists to close. So the fast-forward always runs
// first, and the reinstall runs ONLY once it has actually succeeded.
//
// ORDER WITHIN THIS FUNCTION (deliberately not identical to finish.sh's own call order):
//   1. `git fetch origin` -- always first, unconditional on everything else: every other check
//      below depends on it (the merge-diff needs its objects, the fast-forward needs its ref), and
//      it never touches config.productRepo's WORKING TREE (no branch/dirty precondition), so it is
//      safe to attempt even when the checkout turns out to be unusable for anything else.
//   2. `gh pr view <prNumber> --json mergeCommit` -- this card's own merge commit sha, read off
//      GitHub by PR NUMBER (what ctx already carries -- ctx.prNumber, set by PUSH_PR), never
//      derived from origin/main's own tip: under config.js's WORKERS > 1 a sibling worker's PR can
//      merge after this one's, so "origin/main's tip" and "this task's own merge commit" stop
//      being the same claim once concurrency is real. ctx does not carry a merge sha anywhere
//      today (MERGE only ever asks `gh pr merge` + `npm run pr:wait` to enqueue/await the merge,
//      never reads the resulting commit back) -- this is the one place this action had to ask
//      GitHub for something ctx does not already carry, rather than inventing a local derivation.
//   3. `git diff --name-only <mergeSha>^ <mergeSha>` -- which paths this merge touched (a `git
//      diff <mergeSha>^ <mergeSha>` needs that commit's objects, which only a successful fetch
//      guarantees local as of THIS run) -- independent of the fast-forward's own git calls (steps
//      4-6), so it runs here, right after the sha is known, making `benchTouched` available BEFORE
//      deciding how severely to treat a fast-forward failure below (step 7).
//   4-6. the fast-forward itself: refuse (never force) on the wrong branch, a dirty tree, or
//      whatever `git merge --ff-only` itself refuses (diverged) -- each guards the next, the same
//      short-circuit shape sweepWorktreeLeftovers above already uses. The branch/dirty checks are
//      this pipeline's OWN addition, stricter than finish.sh's own `git pull --ff-only`-only
//      posture (which relies on ff-only's native refusal alone) -- see this action's report.
//   7. the fast-forward's own outcome, and the deliberate park-vs-journal split -- see this
//      action's own report for the argument on both sides. Short version: benchTouched, known from
//      step 3 regardless of whether steps 4-6 succeed, is the deciding fact, not "did the fast-
//      forward work" alone. A fast-forward failure on a merge that never touched the bench worker
//      leaves real but non-blocking drift (the same "35 commits behind" gap this action's own
//      background measured) on a card whose PR has already merged -- journalled, not parked, so an
//      unrelated repo-hygiene hiccup cannot stall the whole backlog. A fast-forward failure on a
//      merge that DID touch the bench worker is the high-stakes case this action exists to close:
//      reinstalling would be unsafe (the trap above) and skipping it silently is the exact failure
//      this whole remediation chantier is about, so this PARKS -- loud and blocking, and BEFORE
//      the board move below, while the card is still `Merging`, not after the board already says
//      `Done`.
//   8. post-verification hazard fix: wait for the bench worker to go IDLE (waitForBenchIdle,
//      bounded by config.benchIdleWaitMaxPolls/benchIdleWaitPollIntervalMs) before ever invoking
//      the reinstall -- ONLY reached once the fast-forward actually succeeded AND benchTouched is
//      true (the same gate step 9 below is reached under). See waitForBenchIdle's own header for
//      why: bench-install.sh's own unconditional `systemctl restart` can otherwise cut a SIBLING
//      card's in-flight GATE on this daemon's real K=2 deployment.
//   R1 (post-verification, third pass): a bench that never goes idle within the bound no longer
//      PARKS -- it DEFERS. waitForBenchIdle itself no longer throws on a timed-out wait (it still
//      throws immediately, and only, on an UNREADABLE bench dir -- see its own header); it returns
//      `{idle: false, ...}` and this function journals `bench-reinstall-deferred`, records the
//      debt durably (journal.js's writeBenchReinstallOwed), and returns -- the SAME early-return
//      shape step 7's non-blocking branch and the benchTouched-false skip below already use, so
//      FINISH proceeds to the board move exactly as if nothing were owed. See waitForBenchIdle's
//      own header for why parking here was wrong (terminal, pre-board-move, and derived from a
//      bound that omits SPO-WebClient's own bench leases) and payBenchReinstallDebtIfOwed
//      (realWorktree, above) for how the debt actually gets paid.
//   9. the reinstall itself, ONLY reached once the fast-forward succeeded AND the bench is
//      confirmed idle (not merely "the wait returned" -- a deferred wait takes the branch above
//      instead and never reaches this line).
//
// Every branch below is loud on both success and failure -- an appendEvent either way -- so the
// journal can answer "did the worker get reinstalled" without reading a log (this action's own
// design constraint).
async function realFinish(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;
  const issue = ctx.task && ctx.task.issue;
  const productRepo = config.productRepo;
  const prNumber = ctx.prNumber;

  await withProductRepoLock(ctx, deps, 'finish-sync', async () => {
    // 1. fetch -- see the header above for why this is unconditional and comes first.
    const fetch = spawnStep(ctx, deps, 'FINISH', 'git', ['-C', productRepo, 'fetch', 'origin']);
    if (fetch.exit !== 0) {
      appendEvent(ctx.taskDir, 'FINISH', 'main-fast-forward-failed', { reason: 'fetch-failed', exit: fetch.exit });
      throw new ParkSignal('finish-failed', { step: 'fast-forward', reason: 'fetch-failed', exit: fetch.exit });
    }

    // 2. this card's own merge commit, by PR number.
    const prView = spawnStep(ctx, deps, 'FINISH', 'gh', [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      config.ghRepo,
      '--json',
      'mergeCommit',
    ]);
    let mergeSha = null;
    if (prView.exit === 0) {
      try {
        const parsed = JSON.parse(prView.stdout);
        mergeSha = (parsed && parsed.mergeCommit && parsed.mergeCommit.oid) || null;
      } catch {
        mergeSha = null;
      }
    }
    if (!mergeSha) {
      appendEvent(ctx.taskDir, 'FINISH', 'merge-sha-lookup-failed', { prNumber, exit: prView.exit });
      throw new ParkSignal('finish-failed', { step: 'merge-sha-lookup', exit: prView.exit });
    }

    // 3. which paths this merge touched -- benchTouched is known from here on, REGARDLESS of
    // whether the fast-forward below (steps 4-6) succeeds.
    const diff = spawnStep(ctx, deps, 'FINISH', 'git', ['-C', productRepo, 'diff', '--name-only', `${mergeSha}^`, mergeSha]);
    if (diff.exit !== 0) {
      appendEvent(ctx.taskDir, 'FINISH', 'bench-diff-check-failed', { prNumber, mergeSha, exit: diff.exit });
      throw new ParkSignal('finish-failed', { step: 'bench-diff-check', exit: diff.exit });
    }
    const benchTouched = benchPathsTouched(diff.stdout);
    appendEvent(ctx.taskDir, 'FINISH', 'bench-diff-checked', { prNumber, mergeSha, benchTouched });

    // 4-9. fast-forward + conditional reinstall -- the ONE implementation shared with
    // payBenchReinstallDebtIfOwed (realWorktree, above), action B1.4 round 4. `skipFetch: true`:
    // this card's own fetch already ran at step 1 above (needed there for the mergeSha/diff
    // lookups this function does not do), so a second one here would be redundant.
    const result = await fastForwardMainAndInstall(ctx, deps, config, {
      state: 'FINISH',
      skipFetch: true,
      decideInstall: async () => {
        if (!benchTouched) {
          appendEvent(ctx.taskDir, 'FINISH', 'bench-reinstall-skipped', { reason: 'merge did not touch the bench worker' });
          return { install: false };
        }

        // post-verification hazard fix -- wait for the bench worker to go idle before ever
        // invoking the reinstall. waitForBenchIdle still throws immediately
        // (ParkSignal('finish-failed', {step: 'bench-idle-wait', reason: 'bench-dir-unreadable',
        // ...})) on an UNREADABLE bench dir -- a misconfiguration polling cannot fix. A timed-out
        // BUSY wait no longer throws at all: see R1 in the header above and waitForBenchIdle's
        // own header for the full account.
        const idleResult = await waitForBenchIdle(ctx, deps, config);
        if (!idleResult.idle) {
          // R1 (post-verification, third pass): DEFER, don't park. The card's PR has already
          // merged and nothing about the card itself is wrong -- only the bench worker's own
          // binary is now owed a reinstall. Journalled loudly (this is the ONLY place
          // `bench-reinstall-deferred` is ever written, so its presence alone answers "was this
          // card's reinstall deferred"), and recorded durably so a daemon restart cannot lose the
          // debt -- see journal.js's writeBenchReinstallOwed and realWorktree's own
          // payBenchReinstallDebtIfOwed for how the debt gets paid back (round 4: from WORKTREE's
          // own product-repo lock span, never a separate daemon timer).
          appendEvent(ctx.taskDir, 'FINISH', 'bench-reinstall-deferred', {
            prNumber,
            mergeSha,
            attempts: idleResult.attempts,
            spool: idleResult.spool,
            running: idleResult.running,
          });
          writeBenchReinstallOwed(path.dirname(ctx.taskDir), {
            mergeSha,
            prNumber,
            issue,
            spool: idleResult.spool,
            running: idleResult.running,
            attempts: idleResult.attempts,
          });
          return { install: false };
        }
        return { install: true };
      },
    });

    // 7 (fast-forward's own outcome) and 9 (the reinstall's own outcome) -- see the header above
    // for the park-vs-journal split. fastForwardMainAndInstall already journalled
    // main-fast-forward-failed/main-fast-forwarded/bench-reinstalled/bench-reinstall-failed;
    // deciding whether a failure PARKS this card is FINISH's own call (payBenchReinstallDebtIfOwed
    // never parks on the identical failures -- see its own header for why).
    if (!result.ffOk) {
      if (benchTouched) {
        throw new ParkSignal('finish-failed', { step: 'fast-forward', reason: result.ffReason, ...result.ffDetail });
      }
      return;
    }
    if (!result.installed && result.installExit !== null) {
      throw new ParkSignal('finish-failed', { step: 'bench-reinstall', exit: result.installExit });
    }
  });

  // realFinish's own `board:move -- <issue> Done` is deliberately NOT routed through board.js's
  // moveCard/COLUMN_BY_STATE: moveCard's whole contract is "never blocks the task" (board.js's own
  // header), because a stale board display is cosmetic everywhere else. It is not cosmetic here --
  // a card the daemon cannot mark Done is not actually done, so this is the one board move in the
  // whole system that must block on failure, via spawnStep's own ParkSignal path below, same as it
  // always has. Adding a `FINISH: 'Done'` entry to COLUMN_BY_STATE would silently arm moveCard's
  // non-blocking path for it instead -- see board.js's header for the matching note.
  const move = spawnStep(ctx, deps, 'FINISH', 'npm', ['run', 'board:move', '--', String(issue), 'Done'], {
    cwd: worktreePath,
  });
  // Action 5.1a: journal this move with board.js's own `board-move`/`board-move-failed`
  // vocabulary, not just spawnStep's compact {argv, exit, ms} line. Measured: 14 of the 18 tasks
  // in the journal corpus have `Merging` as their LAST journalled board-move, while the board
  // itself shows `Done` -- not 14 broken cards, one missing event, because this move has always
  // gone straight to `gh`/`git` with no appendEvent of its own. Without this, anything
  // reconciling journal against board reads 14 healthy cards as divergent. The failure branch
  // journals board-move-failed BEFORE the throw, deliberately: the ParkSignal below is existing
  // contract (this is the one move in the whole daemon that MUST block -- a card that cannot be
  // marked Done is not done) and must stay, but the attempt belongs on the record either way,
  // exactly like every other state's board-move-failed.
  if (move.exit !== 0) {
    appendEvent(ctx.taskDir, 'FINISH', 'board-move-failed', { column: 'Done', exit: move.exit });
    throw new ParkSignal('finish-failed', { step: 'board-move', exit: move.exit });
  }
  appendEvent(ctx.taskDir, 'FINISH', 'board-move', { column: 'Done' });

  const commentFile = path.join(ctx.taskDir, 'final-comment.md');
  fs.writeFileSync(commentFile, finalComment(ctx, deps));
  const comment = spawnStep(ctx, deps, 'FINISH', 'gh', [
    'issue',
    'comment',
    String(issue),
    '--repo',
    config.ghRepo,
    '--body-file',
    commentFile,
  ]);
  if (comment.exit !== 0) throw new ParkSignal('finish-failed', { step: 'issue-comment', exit: comment.exit });

  // action 6.4: `worktree remove` mutates config.productRepo's shared `.git/worktrees/`
  // administrative files, the same resource realWorktree's setup phase mutex-protects above --
  // see product-repo-lock.js's own header. board:move and the issue comment above are deliberately
  // OUTSIDE the lock: neither touches config.productRepo (board:move talks to the GitHub project
  // board, the comment to the issue), so holding the mutex across them would only add two
  // unrelated network calls' latency to every other worker's wait for no protective benefit.
  const remove = await withProductRepoLock(ctx, deps, 'finish', async () =>
    spawnStep(ctx, deps, 'FINISH', 'git', ['-C', config.productRepo, 'worktree', 'remove', '--force', worktreePath])
  );
  if (remove.exit !== 0) throw new ParkSignal('finish-failed', { step: 'worktree-remove', exit: remove.exit });

  const billableTokens = sumJournalBillableTokens(ctx.taskDir);
  appendEvent(ctx.taskDir, 'FINISH', 'finished', { issue, prNumber: ctx.prNumber || null, billableTokens });

  return 'DONE';
}

module.exports = {
  runScripted,
  sleep,
  lastLines,
  spawnStep,
  classifyCommand,
  realWorktree,
  realCheck,
  realPushPr,
  realGate,
  realCiChecks,
  realMerge,
  realFinish,
  preserveWorktreeWip,
  prepareJudgeInputs,
  finalComment,
  sumJournalBillableTokens,
  // Exported for test/real-steps.test.js's own direct coverage, and so
  // payBenchReinstallDebtIfOwed (above, in this same file) and realFinish's own waitForBenchIdle
  // read the SAME queue-depth logic rather than a second copy that can drift -- see
  // benchQueueDepth's own header.
  benchQueueDepth,
  // action B3.2: exported so test/nightly-verdict-semantics.test.js can pin the classification
  // table directly, one named assertion per verdict value, without spinning up a full
  // realWorktree/realCiChecks/realGate harness for every case -- the integration tests in that
  // same file still exercise the real call sites for the properties a unit test cannot see
  // (which park reason fires, that the 'unknown' journal event actually lands, ordering).
  classifyNightly,
};
