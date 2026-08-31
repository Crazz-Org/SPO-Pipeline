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

const { appendEvent } = require('../journal');
const { ParkSignal } = require('../park-signal');
const { classifyCiFailure } = require('../ci-cause-table');
const { moveCard } = require('../board');
const { classifyCommand, classTimeoutMs, isSpawnTimeout } = require('../command-timeout');
const { diffPath, gateLogPath, gateReportPath, lastResultPayload, lastInvariantsBaseline } = require('../task-values');
const { checkRegressions } = require('../invariants');

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
// retry policy at 48 call sites (or worse, at only some of them) is exactly the kind of drift
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
//      already ran): deleted with `push origin --delete`. This is always a prior, superseded
//      attempt in the pipeline's own namespace, regenerated fresh every pass -- leaving it makes
//      this attempt's own `push -u origin <branch>` (PUSH_PR) non-fast-forward. If a PR was open
//      from it, deleting the branch closes that PR; PUSH_PR opens a fresh one on the retry. This
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
    const del = spawnStep(ctx, deps, 'WORKTREE', 'git', ['-C', productRepo, 'push', 'origin', '--delete', branch]);
    if (del.exit !== 0) throw new ParkSignal('worktree-cleanup-failed', { step: 'remote-branch-delete', exit: del.exit });
    appendEvent(ctx.taskDir, 'WORKTREE', 'remote-branch-cleaned', { branch, sha: remoteSha });
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

async function realWorktree(ctx, deps = {}) {
  const config = ctx.config;
  const productRepo = config.productRepo;
  const worktreesDir = config.pipelineWorktreesDir;
  const taskId = ctx.id;
  const issue = ctx.task && ctx.task.issue;
  const branch = `claude-pipe/${taskId}`;
  const worktreePath = path.join(worktreesDir, taskId);

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

  const nightly = readJsonSafe(path.join(config.spoBenchDir, 'nightly', 'latest.json'));
  if (nightly && nightly.verdict === 'FAIL' && nightly.sha === originMainSha) {
    throw new ParkSignal('nightly-main-red', { sha: originMainSha });
  }

  sweepWorktreeLeftovers(ctx, deps, { productRepo, worktreePath, branch });

  fs.mkdirSync(worktreesDir, { recursive: true });
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

  // The diff is ground truth; intake.js:927 only ever infers touchesRdoMembers from the issue's
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
// `npm run gate`: 0 PASS -> CI_CHECKS, 1 fail -> DIAGNOSE, 2 dirty / 3 worker down / 4 timeout
// -> PARKED. Mirrors handleGate's own shadow-mode cause table exactly.
async function realGate(ctx, deps = {}) {
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

  if (r.exit === 0) return 'CI_CHECKS';
  if (r.exit === 1) return 'DIAGNOSE';
  if (r.exit === 2) throw new ParkSignal('gate-dirty-tree', { exit: r.exit });
  if (r.exit === 3) throw new ParkSignal('gate-worker-down', { exit: r.exit });
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

  const nightly = readJsonSafe(path.join(config.spoBenchDir, 'nightly', 'latest.json'));
  const originMainSha = await gitRevParse(ctx, deps, worktreePath, 'origin/main');
  if (nightly && nightly.verdict === 'FAIL' && nightly.sha === originMainSha) {
    throw new ParkSignal('main-red-no-merge', {});
  }
  if (ctx.counters.mainMoveUsed) {
    throw new ParkSignal('main-moved-twice', {});
  }
  ctx.counters.mainMoveUsed = true;

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
function finalComment(ctx) {
  const lines = [`Merged via claude-pipe/${ctx.id}.`];
  if (ctx.prNumber) lines.push(`PR #${ctx.prNumber}.`);
  lines.push('Pipeline run complete.');
  return lines.join('\n') + '\n';
}

// sumJournalBillableTokens(taskDir) -- the task's total billable-weighted tokens (fresh input +
// cache-creation + output, cache-read excluded -- see orchestrator/tokens.js's header for why),
// summed across every `llm-call` event this task's journal recorded. Dollar figures are retired
// entirely (maintainer decision, 2026-08-31); this replaces the old sumJournalCost, same
// "journal is the only ledger" reasoning, same defensive read.
function sumJournalBillableTokens(taskDir) {
  const file = path.join(taskDir, 'journal.jsonl');
  if (!fs.existsSync(file)) return 0;
  let total = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.event === 'llm-call' && typeof event.billableTokens === 'number') total += event.billableTokens;
    } catch {
      // malformed line -- skip, never fail FINISH over a journal read
    }
  }
  return total;
}

async function realFinish(ctx, deps = {}) {
  const config = ctx.config;
  const worktreePath = ctx.task.worktreePath;
  const issue = ctx.task && ctx.task.issue;

  const move = spawnStep(ctx, deps, 'FINISH', 'npm', ['run', 'board:move', '--', String(issue), 'Done'], {
    cwd: worktreePath,
  });
  if (move.exit !== 0) throw new ParkSignal('finish-failed', { step: 'board-move', exit: move.exit });

  const commentFile = path.join(ctx.taskDir, 'final-comment.md');
  fs.writeFileSync(commentFile, finalComment(ctx));
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

  const remove = spawnStep(ctx, deps, 'FINISH', 'git', [
    '-C',
    config.productRepo,
    'worktree',
    'remove',
    '--force',
    worktreePath,
  ]);
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
};
