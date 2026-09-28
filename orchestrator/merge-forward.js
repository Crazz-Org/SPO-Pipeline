'use strict';
// merge-forward.js -- SPO-Pipeline#235, option A: when `git merge origin/main` into the card's
// branch conflicts at GATE or CI_CHECKS, IMPLEMENT gets one attempt to merge and resolve it (a
// `MERGE-FORWARD` diagnosis source) before the card parks. MERGE's own conflict path is not
// touched: it still parks `merge-conflict`, `continue` offered (regateAfterNonLanding,
// steps/scripted.js).
//
// Measured before it was built (#235's comment of 2026-09-26): 26 of 27 real conflict parks
// resolved to a green tree, the 27th was a correct refusal, and none left a marker -- but the
// session's own `all_green` was `true` on a tree with two of main's tests red (537h). So nothing
// here trusts the session's report: the pipeline checks the tree itself (unmerged paths, markers,
// both parents), then the card takes the ordinary route, CHECK -> PUSH_PR -> GATE, and the
// re-gate on the new sha is the proof.
//
// The flow, and the one state it never leaves behind:
//
//   GATE / CI_CHECKS  the merge conflicts -> offerMergeForward: the conflict is aborted and the
//                     tree verified clean at the pushed head (GATE already aborted, as it always
//                     has; CI_CHECKS aborts only when it is about to offer the attempt), the
//                     attempt is journalled (`merge-forward-attempt`) and IMPLEMENT is next.
//   IMPLEMENT         the session re-runs `git merge --no-ff --no-commit <mainSha>` itself and
//                     resolves it (prompts/implement.md § MERGE-FORWARD). settleMergeForward then
//                     checks the tree and commits the merge; anything short of a clean, committed
//                     merge of both parents -> restoreBeforeMergeForward + today's park.
//   CHECK             as usual. Red -> DIAGNOSE -> IMPLEMENT, under the ordinary diagnose budget;
//                     when that budget ends the card (mergeForwardCheckRedFallback), it parks
//                     under today's resumable reason too.
//
// Why the orchestrator aborts and the session merges, rather than handing the session a tree that
// is still mid-merge (the shape the measurement used): with this order, every state boundary sees
// either a clean tree at the pushed head or a committed merge -- never MERGE_HEAD. A crash, a lock
// loss or a drain between GATE and IMPLEMENT leaves nothing half-merged behind, the conflict is
// reproducible from (headSha, mainSha) alone, and a fallback can always restore the one state it
// verified before the attempt. The session sees exactly the conflict the orchestrator saw: it
// merges the pinned sha, not whatever `origin/main` has become since.
//
// Budget: one attempt per card per site, read back from the journal (`merge-forward-attempt`), so
// no restart, resume or `continue` can grant a second one -- nor can a later, different main sha.
// Within one run the shared `mainMovedRegateBudget` already stops a second main-moved merge; this
// journal count is the only bound that survives the counter reset every resume and `continue`
// makes. A second conflict on the same card is the spine-contention signal a human should see, and
// at the measured rate (1-2 conflict parks a week) that human costs less than a loop would.

const { appendEvent } = require('./journal');
const { ParkSignal } = require('./park-signal');
const { readJournalLines } = require('./task-summary');

const MERGE_FORWARD_SITES = Object.freeze(['GATE', 'CI_CHECKS']);

// A sha as `git rev-parse` prints it. A failing rev-parse prints the ref name itself on stdout
// (realPushPr's own comment, steps/scripted.js), so a string is not enough.
const SHA_RE = /^[0-9a-f]{7,64}$/;

// Git's own four conflict markers, at the start of a line, each followed by a space or the end of
// the line -- `=======` alone on its line. Checked on 2026-09-27: `git grep` finds none of them
// anywhere in SPO-WebClient's main, so a match is a marker, not content. Were a file on main ever
// to carry one legitimately, every merge-forward would fall back to today's park, naming that file
// in `mergeForward.files` -- a safe failure, never a silent pass.
const CONFLICT_MARKER_RE = '^(<{7}|>{7}|[|]{7})( |$)|^={7}$';

// Caps what reaches the journal, the prompt and the park comment. The measured corpus peaked at 8
// conflicted files.
const LIST_CAP = 50;

// The ways DIAGNOSE ends a card (handleDiagnose, state-machine.js): the three ordinary budget ends,
// plus (SPO-Pipeline#305) `diagnose-out-of-scope`, which a merge-forward's CHECK always reaches as a
// park (CHECK is not a state an out-of-scope answer re-checks). While a merge-forward resolution has
// not yet passed CHECK, each of them parks under the site's own resumable reason instead, on the
// restored pushed head -- see mergeForwardCheckRedFallback. Left as `diagnose-out-of-scope`, that
// park would keep the unverified local merge commit, and a `continue` would refuse it
// (prepareResume's local-commits-ahead-of-origin check).
const CHECK_RED_REASONS = new Set([
  'diagnose-budget-exhausted',
  'diagnose-no-new-cause',
  'diagnose-duplicate-root-cause',
  'diagnose-out-of-scope',
]);

// Lazy: steps/scripted.js requires this module for its two call sites, so a top-level require here
// would hand back scripted.js's exports before they exist.
function spawnStep(...args) {
  return require('./steps/scripted').spawnStep(...args);
}

// One git command in the worktree that never throws a park: spawnStep's own `git-timed-out` /
// killed-by-signal ParkSignal becomes `{exit: null, parked}`, so a hung git inside this module can
// only ever end in the site's own fallback park, never in a park that names the cleanup instead of
// the cause (the same doctrine as realGate's `merge --abort` try/catch).
function git(ctx, deps, state, worktreePath, args) {
  try {
    return spawnStep(ctx, deps, state, 'git', ['-C', worktreePath, ...args]);
  } catch (err) {
    if (!(err instanceof ParkSignal)) throw err;
    return { exit: null, stdout: '', stderr: '', parked: err.reason };
  }
}

function lines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function cap(list) {
  return list.slice(0, LIST_CAP);
}

// Today's park at each site, with literal reasons (test/park-reason-doc-sweep.test.js reads every
// `new ParkSignal(...)` call site from source and accepts a literal or a known pass-through).
function sitePark(site, detail) {
  if (site === 'CI_CHECKS') return new ParkSignal('main-moved-merge-failed', detail);
  return new ParkSignal('gate-merge-refused', detail);
}

function branchOf(ctx) {
  return (ctx.task && ctx.task.branch) || `claude-pipe/${ctx.id}`;
}

// The files a conflicted merge left unmerged, read BEFORE anything aborts it. Empty when the read
// fails or the merge failed for another reason (`not something we can merge`, an overwrite
// refusal): no conflicted file, no attempt.
function listConflictedFiles(ctx, deps, state, worktreePath) {
  const r = git(ctx, deps, state, worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  return r.exit === 0 ? lines(r.stdout) : [];
}

// The most recent `merge-forward-attempt` this card ever journalled at `site`, or null.
function priorMergeForwardAttempt(taskDir, site) {
  const all = readJournalLines(taskDir);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e && e.event === 'merge-forward-attempt' && e.site === site) return e;
  }
  return null;
}

// Called by realGate / realCiChecks once their `git merge origin/main` has exited non-zero.
// Returns `{next: 'IMPLEMENT'}` when the attempt is offered, and otherwise `{parkDetail}`: the
// caller then throws its own park (`gate-merge-refused` / `main-moved-merge-failed`) with that
// detail -- `fallbackDetail` exactly as today, plus a `mergeForward` note only when the budget is
// what refused the attempt.
//
// `mergeAborted`: GATE has already run its own `merge --abort` (unchanged); CI_CHECKS never did,
// and still does not when no attempt follows -- its park keeps today's conflicted tree, which
// prepareResume already knows how to clean.
function offerMergeForward(ctx, deps, { site, worktreePath, headSha, mainSha, conflictedFiles, mergeAborted, fallbackDetail }) {
  const skip = (why, mergeForward) => {
    appendEvent(ctx.taskDir, site, 'merge-forward-skipped', { site, why });
    return { parkDetail: mergeForward ? { ...fallbackDetail, mergeForward } : fallbackDetail };
  };

  if (!Array.isArray(conflictedFiles) || conflictedFiles.length === 0) return skip('no-conflicted-files');
  if (typeof mainSha !== 'string' || !SHA_RE.test(mainSha)) return skip('main-sha-unknown');

  const prior = priorMergeForwardAttempt(ctx.taskDir, site);
  if (prior) {
    return skip('budget-spent', {
      tried: true,
      site,
      outcome: 'budget-spent',
      priorAttempt: { ts: prior.ts, mainSha: prior.mainSha, headSha: prior.headSha },
    });
  }

  if (!mergeAborted) git(ctx, deps, site, worktreePath, ['merge', '--abort']);

  // The one state a fallback restores: the pushed head, nothing in progress, nothing on disk.
  // `rev-parse -q --verify MERGE_HEAD` exits 1 when there is none; anything else -- 0, or a
  // timeout -- is not "known clean".
  const merging = git(ctx, deps, site, worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  const status = git(ctx, deps, site, worktreePath, ['status', '--porcelain']);
  if (merging.exit !== 1 || status.exit !== 0 || status.stdout.trim() !== '') return skip('tree-not-clean');

  const attempt = {
    site,
    issue: ctx.task && ctx.task.issue,
    mainSha,
    headSha,
    conflictedFiles: cap(conflictedFiles),
    conflictedCount: conflictedFiles.length,
  };
  appendEvent(ctx.taskDir, site, 'merge-forward-attempt', attempt);
  ctx.mergeForward = { ...attempt, fallbackDetail };
  return { next: 'IMPLEMENT' };
}

// IMPLEMENT's `{{diagnosis}}` for a merge-forward attempt (task-values.js's buildPromptValues).
// Starts with the literal `MERGE-FORWARD` prompts/implement.md step 3 keys on.
function mergeForwardDiagnosis(mf) {
  const more = mf.conflictedCount > mf.conflictedFiles.length ? ` (and ${mf.conflictedCount - mf.conflictedFiles.length} more)` : '';
  return (
    `MERGE-FORWARD (found at ${mf.site}: origin/main moved and no longer merges cleanly into this branch): ` +
    `run \`git merge --no-ff --no-commit ${mf.mainSha}\` in the worktree; branch head before the merge: ${mf.headSha}; ` +
    `it conflicts in: ${mf.conflictedFiles.join(', ')}${more}`
  );
}

// Puts the worktree back exactly where offerMergeForward verified it: on the branch, at the pushed
// head, clean. `checkout -f` also ends a merge in progress (measured: MERGE_HEAD is gone after it),
// `reset --hard` drops a merge commit the session may have made, `clean -fd` removes what it
// created (never an ignored file -- node_modules stays). Nothing here is lost that origin does not
// hold: the pushed head is origin's, and the attempt is reproducible from (headSha, mainSha).
// A failing step is journalled and stops the restore; the park still happens.
function restoreBeforeMergeForward(ctx, deps, mf, state) {
  const worktreePath = ctx.task.worktreePath;
  for (const args of [
    ['checkout', '-f', branchOf(ctx)],
    ['reset', '--hard', mf.headSha],
    ['clean', '-fd'],
  ]) {
    const r = git(ctx, deps, state, worktreePath, args);
    if (r.exit !== 0) {
      appendEvent(ctx.taskDir, state, 'merge-forward-restore-failed', {
        site: mf.site,
        step: args[0],
        exit: r.exit,
        ...(r.parked ? { parked: r.parked } : {}),
      });
      return false;
    }
  }
  return true;
}

// Restores the tree, journals `merge-forward-fallback`, and returns (never throws) the site's own
// park, today's detail plus the `mergeForward` note the park comment reads.
function mergeForwardFallback(ctx, deps, mf, state, outcome, extra = {}) {
  const restored = restoreBeforeMergeForward(ctx, deps, mf, state);
  const note = {
    tried: true,
    site: mf.site,
    outcome,
    mainSha: mf.mainSha,
    headSha: mf.headSha,
    conflictedFiles: mf.conflictedFiles,
    restored,
    ...extra,
  };
  appendEvent(ctx.taskDir, state, 'merge-forward-fallback', note);
  return sitePark(mf.site, { ...mf.fallbackDetail, mergeForward: note });
}

// After the session: is this a clean, committed merge of both parents on the card's branch?
// Returns the resolved head sha, or throws the fallback park. Never reads the session's
// `all_green` -- CHECK and the re-gate decide that.
function settleMergeForward(ctx, deps, mf, payload, stopReason) {
  const worktreePath = ctx.task.worktreePath;
  const run = (args) => git(ctx, deps, 'IMPLEMENT', worktreePath, args);
  const fail = (outcome, extra) => mergeForwardFallback(ctx, deps, mf, 'IMPLEMENT', outcome, extra);

  if (!payload || payload.ok === false) {
    throw fail('session-failed', { kind: (payload && payload.kind) || null, timedOut: !!(payload && payload.timedOut) });
  }
  if (stopReason) throw fail('declined', { stopReason });

  const unmerged = run(['ls-files', '-u']);
  if (unmerged.exit !== 0 || unmerged.stdout.trim() !== '') {
    const paths = [...new Set(lines(unmerged.stdout).map((l) => l.split('\t').pop()))];
    throw fail('unmerged-paths', { exit: unmerged.exit, files: cap(paths) });
  }

  // `git grep` exits 1 when nothing matches, 0 on a match, anything else when it could not look.
  // `--untracked` so a new file counts too; ignored files (node_modules) are skipped.
  const markers = run(['grep', '-n', '-I', '--untracked', '-E', CONFLICT_MARKER_RE]);
  if (markers.exit !== 1) {
    const files = [...new Set(lines(markers.stdout).map((l) => l.split(':')[0]))];
    throw fail('markers-left', { exit: markers.exit, files: cap(files) });
  }

  // The pipeline commits the merge (the prompt forbids the session to), with git's own message --
  // never PUSH_PR, whose `commit -F` would title a merge commit with the card's own subject.
  const merging = run(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (merging.exit === 0) {
    const commit = run(['commit', '--no-edit']);
    if (commit.exit !== 0) throw fail('commit-failed', { exit: commit.exit });
  }

  const onBranch = run(['symbolic-ref', '--short', 'HEAD']);
  const facts = {
    onBranch: onBranch.exit === 0 && onBranch.stdout.trim() === branchOf(ctx),
    mainMerged: run(['merge-base', '--is-ancestor', mf.mainSha, 'HEAD']).exit === 0,
    headKept: run(['merge-base', '--is-ancestor', mf.headSha, 'HEAD']).exit === 0,
  };
  const head = run(['rev-parse', 'HEAD']);
  const resolvedHead = head.exit === 0 ? head.stdout.trim() : '';
  if (!facts.onBranch || !facts.mainMerged || !facts.headKept || !SHA_RE.test(resolvedHead)) {
    throw fail('not-merged', facts);
  }

  appendEvent(ctx.taskDir, 'IMPLEMENT', 'merge-forward-resolved', {
    site: mf.site,
    mainSha: mf.mainSha,
    headSha: mf.headSha,
    resolvedHead,
    conflictedFiles: mf.conflictedFiles,
  });
  return resolvedHead;
}

// A ParkSignal from DIAGNOSE while a merge-forward resolution has not yet passed CHECK: when it is
// one of the ordinary diagnose-budget ends, the card parks under the site's own resumable reason
// instead (a `continue` then works on the restored branch; the underlying park is kept in the
// note). Returns `err` unchanged otherwise.
function mergeForwardCheckRedFallback(ctx, deps, err) {
  const pending = ctx.mergeForwardAwaitingCheck;
  if (!pending || !(err instanceof ParkSignal) || !CHECK_RED_REASONS.has(err.reason)) return err;
  ctx.mergeForwardAwaitingCheck = null;
  return mergeForwardFallback(ctx, deps, pending, 'DIAGNOSE', 'check-red', {
    resolvedHead: pending.resolvedHead,
    underlying: { reason: err.reason, detail: err.detail },
  });
}

module.exports = {
  MERGE_FORWARD_SITES,
  CONFLICT_MARKER_RE,
  CHECK_RED_REASONS,
  listConflictedFiles,
  priorMergeForwardAttempt,
  offerMergeForward,
  mergeForwardDiagnosis,
  restoreBeforeMergeForward,
  mergeForwardFallback,
  settleMergeForward,
  mergeForwardCheckRedFallback,
};
