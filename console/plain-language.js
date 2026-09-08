'use strict';
// console/plain-language.js -- the flight deck's vocabulary: how each pipeline state and each
// park reason is said to a human who is watching the deck rather than reading the state machine.
//
// WHY THIS IS A MODULE AND NOT PROSE INSIDE THE RENDERER. Two reasons, both learned the hard way
// elsewhere in this repo. First, the same wording is wanted in more than one place -- the deck
// today, the park comment park-loop.js posts to GitHub tomorrow -- and a second copy is a second
// thing to forget to update. Second, a dictionary that lives in a table can be TESTED for
// completeness: test/dashboard-deck.test.js asserts that every state state-machine.js dispatches
// and every reason a ParkSignal can carry has an entry here, so a new state cannot land without
// its sentence. A sentence buried in a template literal cannot be checked that way.
//
// EVERY SENTENCE BELOW WAS CHECKED AGAINST WHAT THE STEP ACTUALLY RUNS, not against its name --
// the `verified` field on each state records what it was checked against, taken from the spawn
// events in the real corpus and from orchestrator/step-contracts.js. "Test" says types, lint and
// coverage because CHECK literally spawns `npm run typecheck`, `npm run lint` and
// `npm run coverage:changed`, and nothing else.
//
// The raw slug is NEVER replaced, only accompanied: the renderer shows the plain sentence large
// and the slug small, because the slug is what a maintainer greps for and what the GitHub
// comment carries. Translating it away would cost more than it buys.

// ---- states ------------------------------------------------------------------------------
//
//   label    -- the name on the track tile. Short enough to sit under a 56px tile.
//   sentence -- what is happening, for someone who does not know the pipeline.
//   icon     -- the sprite id in render.js's icon set (one per state; DIAGNOSE shares none).
//   judge    -- GATE and VALIDATE only: the two steps that can send a passing card backwards.
//               Drawn as hexagons rather than tiles. Derived from board.js's own column split,
//               not invented here.
//   offTrack -- DIAGNOSE only: not a position on the track, the detour a failure forces.
const STATES = {
  INTAKE: {
    label: 'Claim',
    sentence: 'Picking the card up off the board.',
    icon: 'ic-claim',
    verified: 'npm run board:take',
  },
  WORKTREE: {
    label: 'Set up',
    sentence: 'Making a private copy of the app and installing it.',
    icon: 'ic-setup',
    verified: 'git worktree add · npm ci',
  },
  PLAN: {
    label: 'Plan',
    sentence: 'Reading the app to work out what to change. It cannot edit anything yet.',
    icon: 'ic-plan',
    verified: "step-contracts.js PLAN: permissionMode 'plan', no edit tool",
  },
  IMPLEMENT: {
    label: 'Write the code',
    sentence: 'Claude is editing files in the private copy.',
    icon: 'ic-code',
    verified: 'step-contracts.js IMPLEMENT: sonnet, worktree cwd',
  },
  CHECK: {
    label: 'Test',
    sentence: 'Checking it compiles, passes lint, and the tests still pass.',
    icon: 'ic-test',
    verified: 'npm run typecheck · npm run lint · npm run coverage:changed',
  },
  PUSH_PR: {
    label: 'Open PR',
    sentence: 'Pushing the branch and opening the pull request.',
    icon: 'ic-pr',
    verified: 'git push · gh pr create',
  },
  GATE: {
    label: 'Full test run',
    sentence: 'Running the whole browser test suite on a clean machine.',
    icon: 'ic-gate',
    judge: true,
    verified: 'npm run gate (bench worker)',
  },
  CI_CHECKS: {
    label: 'GitHub CI',
    sentence: "Waiting for GitHub's own checks to go green.",
    icon: 'ic-ci',
    verified: 'gh api .../check-runs, up to 30 polls',
  },
  VALIDATE: {
    label: 'Review',
    sentence: 'A second Claude reads the diff and votes to accept or reject.',
    icon: 'ic-review',
    judge: true,
    verified: 'step-contracts.js VALIDATE + prompts/validate-change.md',
  },
  DIAGNOSE: {
    label: 'Diagnose',
    sentence: 'Something failed — working out why before trying again.',
    icon: 'ic-diagnose',
    offTrack: true,
    verified: 'step-contracts.js DIAGNOSE: opus, effort high',
  },
  MERGE: {
    label: 'Merge',
    sentence: 'Queued for merge, waiting for it to land on main.',
    icon: 'ic-merge',
    verified: 'gh pr merge · npm run pr:wait',
  },
  FINISH: {
    label: 'Clean up',
    sentence: 'Marking the card done and deleting the private copy.',
    icon: 'ic-clean',
    verified: 'npm run board:move · git worktree remove',
  },
  DONE: {
    label: 'Shipped',
    sentence: 'Merged into main.',
    icon: 'ic-ship',
    verified: '—',
  },
  PARKED: {
    label: 'Handed back',
    sentence: 'Stopped, with a reason, and waiting for you.',
    icon: 'ic-diagnose',
    verified: 'park-loop.js',
  },
  ABANDONED: {
    label: 'Abandoned',
    sentence: 'You told it to stop working on this card.',
    icon: 'ic-diagnose',
    verified: "park-loop.js 'abandoned-by-maintainer'",
  },
  UNKNOWN: {
    label: 'Unknown',
    sentence: 'This card has no readable state on disk.',
    icon: 'ic-diagnose',
    verified: '—',
  },
};

// ---- park reasons --------------------------------------------------------------------------
//
// One line per reason a ParkSignal can carry, written as the answer to "why did it stop". Two
// reasons are DYNAMIC and cannot be table keys -- they are matched by prefix in reasonText():
// `all-accounts-cooling-until-<iso>` and `llm-transport-failed:<STEP>`.
//
// The list is exhaustive against `grep -o "ParkSignal('...'" orchestrator/` as of 2026-09-04
// (66 distinct reasons); test/dashboard-deck.test.js re-runs that grep so a new ParkSignal
// cannot ship without its sentence.
const PARK_REASONS = {
  // --- budgets: the card ran out of lives -----------------------------------------------
  'diagnose-budget-exhausted': 'It tried to fix the same failure three times and could not.',
  'diagnose-duplicate-root-cause': 'It diagnosed the same cause twice — it was going in circles.',
  'diagnose-no-new-cause': 'It could not work out why the last attempt failed.',
  'validate-reject-budget-exhausted': 'The reviewer rejected the change three times.',
  'ci-retry-budget-exhausted': "GitHub's checks failed three times in a row.",
  'step-deadline-exceeded-twice': 'The same step ran past its time limit twice.',
  'main-moved-twice': 'Someone else merged to main twice while this card was working.',

  // --- accounts and quota ---------------------------------------------------------------
  'all-accounts-cooling-after-retry':
    'Every Claude account was out of quota, even after waiting. It will start again on its own once one frees up.',
  'all-accounts-cooling-unknown':
    'Every Claude account is disabled, or none are registered as usable. There is no cooldown to wait out.',
  'all-accounts-leased': 'Every account was busy on another card for longer than the wait allows.',
  'all-accounts-cooling-wait-cap-exceeded': 'Every Claude account was out of quota for so long that it gave up waiting.',
  'no-accounts-registered': 'There are no Claude accounts configured to run this.',
  'claim-rate-limited': 'GitHub rate-limited the attempt to claim the card.',

  // --- the plan came back wrong ----------------------------------------------------------
  'plan-invalid': 'The plan came back in a shape the pipeline could not use.',
  'plan-requires-protected-files':
    'The plan needs to edit files an agent is not allowed to touch — settings or hooks.',
  'invalid-task-json': 'The card file itself was malformed.',
  'rdo-citation-missing': 'The plan changed RDO wiring without citing the rule it has to follow.',
  'real-flag-required': 'This card can only run against the real repository, and it was not.',

  // --- the gate (full test run) -----------------------------------------------------------
  'gate-dirty-tree': 'The working copy had uncommitted changes when the test run started.',
  'gate-worker-down': 'The machine that runs the full test suite was not answering.',
  'gate-worker-died-midjob': 'The test machine died in the middle of the run.',
  'gate-worker-not-built': 'The test machine has not been built yet.',
  'gate-worker-dirty-checkout': "The test machine's own checkout was not clean.",
  'gate-timeout': 'The full test run took too long and was cut off.',
  'gate-environment': 'The test run failed for an environment reason, not because of the change.',
  'gate-interrupted': 'The test run was interrupted.',
  'gate-abandoned': 'The test run was abandoned before it finished.',
  'gate-stale': 'The test result was for an older version of the branch.',
  'gate-non-attesting': 'The test run finished but produced no verdict to trust.',
  'gate-duplicate-job': 'Two identical test runs were queued for the same commit.',
  'gate-live-blocked': 'The live-server test run could not get a slot.',
  'gate-live-not-driven': 'The live-server test run started but nothing drove it.',
  'gate-not-pushed': 'The branch was not on GitHub when the test run was asked for.',
  'gate-unrecognized-exit': 'The test run exited in a way the pipeline does not recognise.',
  'npm-gate-timed-out': 'The gate command itself timed out.',
  'bench-install-timed-out': 'Installing the test machine took too long.',

  // --- GitHub CI ---------------------------------------------------------------------------
  'ci-checks-still-running': "GitHub's checks were still running when the wait ran out.",
  'ci-checks-read-failed': "Could not read GitHub's check results.",
  'ci-checks-rev-parse-failed': 'Could not work out which commit the checks belong to.',

  // --- review and citations -----------------------------------------------------------------
  'validate-unrecognized-verdict': 'The reviewer answered in a shape the pipeline does not recognise.',
  'citation-false': 'The change cited a rule that does not say what it claims.',
  'citation-verifier-failed': 'The citation check could not run.',
  'citation-verifier-unrecognized-verdict': 'The citation check answered in an unrecognised shape.',
  'judge-inputs-missing': 'The reviewer was missing the diff or the test log it needs to judge.',

  // --- merge ---------------------------------------------------------------------------------
  'merge-queue-not-landing': "The merge was queued but never landed, and GitHub didn't say why.",
  'merge-conflict': 'The pull request has a conflict with the base branch.',
  'merge-blocked': 'GitHub is blocking the merge — a required review, a required check, or branch protection.',
  'merge-behind-base': 'The pull request is behind the base branch and needs updating.',
  'merge-pr-draft': 'The pull request is still a draft.',
  'merge-checks-failing': "GitHub's checks on the pull request are failing.",
  'pr-closed-unmerged': 'The pull request was closed without being merged.',
  'pr-merge-enqueue-failed': 'The merge could not be queued.',
  'pr-wait-unrecognized-exit': 'Waiting for the merge exited in an unrecognised way.',
  'main-moved-conflict': 'Someone else merged first and the changes conflict.',
  'main-moved-merge-failed': 'Someone else merged first and rebasing onto it failed.',
  'finish-failed': 'The card could not be marked done on the board.',

  // --- git and the worktree --------------------------------------------------------------------
  'worktree-failed': 'Could not create a private copy of the app.',
  'worktree-add-failed': 'Creating the private copy failed.',
  'worktree-fetch-failed': 'Could not fetch the latest code before starting.',
  'worktree-npm-ci-failed': 'Installing dependencies in the private copy failed.',
  'worktree-rev-parse-failed': 'Could not work out which commit to branch from.',
  'worktree-cleanup-failed': 'The private copy could not be deleted afterwards.',
  'worktree-dirty-leftover': 'A previous run left uncommitted changes behind.',
  'branch-unmerged-leftover': 'A previous run left an unmerged branch behind.',
  'git-timed-out': 'A git command took too long.',
  'command-killed-by-signal':
    'Something outside the pipeline killed the command it was running — a restart, an out-of-memory kill, or someone stopping it by hand. Nothing was wrong with the card itself.',
  'push-pr-failed': 'Pushing the branch or opening the pull request failed.',
  'product-repo-lock-timeout': 'Another card held the repository for too long.',

  // --- main is red ------------------------------------------------------------------------------
  'main-red-refuse-worktree': 'Main is failing its own tests — it refused to start on a broken base.',
  'main-red-no-merge': 'Main is failing its own tests — it refused to merge into a broken base.',
  'nightly-main-red': "Last night's full test run on main failed.",

  // --- claiming the card -------------------------------------------------------------------------
  'claim-lost': 'Another worker claimed this card first.',
  'claim-finished-worktree': 'The card was already finished when it was picked up.',
  'claim-unrecognized-exit': 'Claiming the card exited in an unrecognised way.',

  // --- maintainer verdicts ------------------------------------------------------------------------
  'abandoned-by-maintainer': 'You told it to stop working on this card.',
};

// The reasons the daemon retries on its own, mirrored from state-machine.js's
// TRANSIENT_RETRY_REASONS. NOT re-derived and NOT the source of truth -- the deck reads this to
// decide whether to say "it will try again on its own" or "it is waiting for you", and
// test/dashboard-deck.test.js pins it against the orchestrator's own set so a rename there
// cannot silently make the deck lie. (That failure mode is real: TRANSIENT_RETRY_REASONS keys on
// the string, so splitting a reason into two names quietly makes every new name terminal.)
//
// The account-pool family is deliberately NOT folded into this set -- state-machine.js's own
// TRANSIENT_RETRY_REASONS excludes it too (see that const's header there), because "comes back on
// its own" splits WITHIN the family rather than being one answer for it. ACCOUNT_POOL_SELF_RETRYING
// below is that family's own mirror, kept separate for the same reason SELF_RETRYING itself is
// kept separate from PARK_REASONS: a rename or a split must be caught, not silently absorbed.
const SELF_RETRYING = new Set([
  'claim-rate-limited',
  'gate-non-attesting',
  'gate-live-blocked',
  'gate-environment',
  'gate-interrupted',
  'gate-abandoned',
  'gate-stale',
]);

// ACCOUNT_POOL_SELF_RETRYING -- mirrors state-machine.js's ACCOUNT_POOL_PARK_REASON_FAMILY (card
// #119 action 1.1), same five members, same `match`/`kind` shape. NOT re-derived, same convention
// and same reason as SELF_RETRYING above (a runtime `require` of orchestrator/state-machine.js
// from this file would invert the dependency this module's header already commits to avoiding) --
// test/dashboard-deck.test.js pins this mirror against the orchestrator's own
// ACCOUNT_POOL_PARK_REASON_FAMILY plus poolCooldownDeadlineMs, the same way it pins SELF_RETRYING
// against TRANSIENT_RETRY_REASONS.
//
// Unlike TRANSIENT_RETRY_REASONS/SELF_RETRYING, this family does NOT get one answer: action 1.2
// (card #119) re-enqueues at the cooldown deadline only the two members that actually carry one
// (`all-accounts-cooling-until-<ISO>` and `all-accounts-cooling-after-retry`, per
// state-machine.js's own poolCooldownDeadlineMs); the other three -- no deadline exists
// (`all-accounts-cooling-unknown`), a lease rather than a cooldown (`all-accounts-leased`), or
// this IS the give-up (`all-accounts-cooling-wait-cap-exceeded`) -- never come back unattended.
// This is why reasonText() below must DERIVE selfRetrying from this table rather than hardcode a
// literal in the branch that handles the dynamic `-until-` member: a `true` written there once
// could not tell that `-after-retry` also deserves it, or that the other three do not.
const ACCOUNT_POOL_SELF_RETRYING = [
  { match: 'all-accounts-leased', kind: 'literal', selfRetrying: false },
  { match: 'all-accounts-cooling-unknown', kind: 'literal', selfRetrying: false },
  { match: 'all-accounts-cooling-until-', kind: 'prefix', selfRetrying: true },
  { match: 'all-accounts-cooling-after-retry', kind: 'literal', selfRetrying: true },
  { match: 'all-accounts-cooling-wait-cap-exceeded', kind: 'literal', selfRetrying: false },
];

// accountPoolMember(reason) -> the matching ACCOUNT_POOL_SELF_RETRYING entry, or undefined if
// `reason` is not a member of the family at all. Same matching convention as the orchestrator's
// own isAccountPoolParkReason: a literal member matches by exact equality, a prefix member by
// `reason.startsWith(match)` -- never a substring test.
function accountPoolMember(reason) {
  return ACCOUNT_POOL_SELF_RETRYING.find(({ match, kind }) => (kind === 'literal' ? reason === match : reason.startsWith(match)));
}

// formatCooldownDeadline(iso) -> a human-readable UTC stamp, or null if `iso` does not parse. Used
// only for the `-until-` prefix member, whose deadline is the ISO suffix of the reason STRING
// itself (already in hand -- no plumbing invented to fetch it). The `-after-retry` sibling's
// deadline lives only in the park detail, which reasonText(reason) never receives (its one caller,
// render-deck.js's renderOutcome, calls it with `outcome.reason` alone) -- so that member's
// sentence stays generic rather than inventing a detail parameter no caller has to give it.
function formatCooldownDeadline(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function stateInfo(state) {
  return STATES[state] || STATES.UNKNOWN;
}

// reasonText(reason) -> {text, selfRetrying}. Handles the two dynamic families by prefix, then
// the table, then degrades to the slug itself with the dashes opened out -- which is still more
// readable than nothing and is honest about being a fallback rather than a written sentence.
function reasonText(reason) {
  if (!reason || typeof reason !== 'string') {
    return { text: 'It stopped without recording a reason.', selfRetrying: false, known: false };
  }

  if (reason.startsWith('all-accounts-cooling-until-')) {
    const member = accountPoolMember(reason);
    const when = formatCooldownDeadline(reason.slice('all-accounts-cooling-until-'.length));
    return {
      text: when
        ? `Every Claude account is out of quota. It will start again on its own at ${when}.`
        : 'Every Claude account is out of quota. It will start again on its own once one frees up.',
      selfRetrying: member ? member.selfRetrying : true,
      known: true,
    };
  }

  if (reason.startsWith('llm-transport-failed:')) {
    const step = reason.slice('llm-transport-failed:'.length);
    const label = STATES[step] ? STATES[step].label.toLowerCase() : step;
    return {
      text: `The call to Claude for “${label}” never came back. It will try again on its own.`,
      selfRetrying: true,
      known: true,
    };
  }

  const hit = PARK_REASONS[reason];
  if (hit) {
    const member = accountPoolMember(reason);
    return { text: hit, selfRetrying: member ? member.selfRetrying : SELF_RETRYING.has(reason), known: true };
  }

  return { text: reason.replace(/[-:]/g, ' '), selfRetrying: false, known: false };
}

module.exports = { STATES, PARK_REASONS, SELF_RETRYING, ACCOUNT_POOL_SELF_RETRYING, stateInfo, reasonText };
