#!/usr/bin/env bash
# deploy-guard.sh -- "which tree may deploy", checked once and shared by the two callers that must
# never be allowed to drift apart on the answer: scripts/daemon-install.sh (refuses to INSTALL the
# unit from the wrong tree) and scripts/git-hooks/post-merge (refuses to DEPLOY a `git pull` from
# the wrong tree). Each caller used to carry its own private copy of this check -- the hook had
# one, the installer had none at all, and a duplicated (or missing) guard is exactly the hazard
# this file exists to close: run daemon-install.sh from an agent worktree and it would deploy that
# worktree's branch to the live service.
#
# Sourced, not executed: functions only, no side effect beyond the variables documented below, and
# it NEVER calls `exit`. This file is sourced both by a script running under `set -euo pipefail`
# (daemon-install.sh) and by one that must never abort a `git pull` no matter what it finds
# (post-merge). Sourcing it is safe under `set -e` regardless of what `deploy_guard_check` would
# ever return when CALLED: this file's only top-level statement is the function definition itself,
# which always succeeds when parsed (measured: even a mutated copy whose function body ends in a
# bare, unconditional `return 1` sources cleanly under `set -euo pipefail` -- none of a function's
# own `return` statements execute until something later calls it). What actually has to hold is
# that nothing at FILE scope, outside the function, can itself fail.
#
# It also deliberately does NOT decide the exit status of a refusal -- that is each caller's own
# call, and the two disagree on purpose: the hook must treat a refusal as "skip, exit 0" so a pull
# is never aborted by it, while the installer must treat the very same refusal as "exit non-zero"
# so it can never be mistaken for a successful install.

# deploy_guard_check <tree>
#
# Returns 0 if <tree> is the deploy checkout AND on the deploy branch; returns 1 otherwise.
# Honours exactly the two variables the hook already honoured, with the same defaults, because the
# whole point of sharing this file is that the names and defaults cannot drift between callers:
#   SPO_SOURCE_REPO  -- the deploy checkout (default $HOME/SPO-Pipeline)
#   SPO_DEPLOY_BRANCH -- the branch allowed to deploy (default main)
#
# ALWAYS sets the following, whichever way it returns:
#   DEPLOY_GUARD_TREE           -- <tree>, normalised with `pwd -P`
#   DEPLOY_GUARD_SOURCE_REPO    -- the deploy checkout, normalised with `pwd -P`
#   DEPLOY_GUARD_BRANCH         -- the branch found on <tree>
#   DEPLOY_GUARD_DEPLOY_BRANCH  -- the branch that is allowed to deploy
#   DEPLOY_GUARD_REASON         -- empty string on success, else why it refused
deploy_guard_check() {
  local tree="$1"
  local raw_source="${SPO_SOURCE_REPO:-$HOME/SPO-Pipeline}"

  DEPLOY_GUARD_REASON=""
  DEPLOY_GUARD_DEPLOY_BRANCH="${SPO_DEPLOY_BRANCH:-main}"

  # Normalise both sides the same way: a path that does not exist yields itself, uncanonicalised,
  # rather than aborting. The `|| echo` is load-bearing twice over: a command substitution's exit
  # status IS the assignment's status (measured: `X="$(cd /nope 2>/dev/null && pwd -P)"` exits 1
  # under `set -euo pipefail`), so without it a non-existent path would abort a `set -e` caller
  # that invokes this function OUTSIDE a condition; and it also means a typo'd path is compared
  # as-is instead of vanishing into an empty string.
  DEPLOY_GUARD_TREE="$(cd "$tree" 2>/dev/null && pwd -P || echo "$tree")"
  DEPLOY_GUARD_SOURCE_REPO="$(cd "$raw_source" 2>/dev/null && pwd -P || echo "$raw_source")"

  # `2>/dev/null || echo '?'` is not what keeps this line from aborting the caller under `set -e`
  # -- both shipped callers invoke this function as `if ! deploy_guard_check ...`, and bash
  # suspends `set -e` for the whole function body when it is called in a condition, so this must
  # only ever be called that way; a bare (unconditioned) call would still abort a `set -e` caller
  # on the function's legitimate `return 1`. What `2>/dev/null || echo '?'` actually does: a bare
  # `git rev-parse` on a path that is not a git repository exits 128, printing "fatal: not a git
  # repository" on stderr and nothing on stdout, and this swallows that fatal and substitutes a
  # legible '?' so the branch comparison below produces the guard's own refusal message instead of
  # git's. GIT_* is stripped from this one call so the answer is correct regardless of what
  # environment the caller (or something further up its own call chain) happens to be running under.
  DEPLOY_GUARD_BRANCH="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR -u GIT_OBJECT_DIRECTORY \
    git -C "$tree" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

  if [ "$DEPLOY_GUARD_TREE" != "$DEPLOY_GUARD_SOURCE_REPO" ]; then
    DEPLOY_GUARD_REASON="$DEPLOY_GUARD_TREE is not the deploy checkout ($DEPLOY_GUARD_SOURCE_REPO)"
    return 1
  fi

  if [ "$DEPLOY_GUARD_BRANCH" != "$DEPLOY_GUARD_DEPLOY_BRANCH" ]; then
    DEPLOY_GUARD_REASON="$DEPLOY_GUARD_SOURCE_REPO is on '$DEPLOY_GUARD_BRANCH', not '$DEPLOY_GUARD_DEPLOY_BRANCH'"
    return 1
  fi

  return 0
}
