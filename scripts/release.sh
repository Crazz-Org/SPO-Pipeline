#!/usr/bin/env bash
# release.sh -- cut an immutable release tree and point the running service at it.
#
# WHY THIS EXISTS. ~/SPO-Pipeline used to be three things at once: the tree the service EXECUTES,
# the tree a human EDITS, and the tree `git pull` MUTATES. dispatcher.js resolves DAEMON_PATH at
# every spawn, so mutating it while the daemon runs is enough to split versions with no restart at
# all -- an old dispatcher spawning new-code workers. The drain and the restart both narrow that
# window; neither can close it, because the window is a property of the layout.
#
# Here the service runs from ~/.spo-releases/<sha>, never from a checkout anyone edits. Deploying is
# "create a tree, move a symlink, drain-restart". The property that makes it work is not the symlink
# but Node's module resolution: `__dirname` is the REALPATH, so a live daemon keeps spawning workers
# out of ITS OWN release tree even after the symlink moves. Version cohesion stops being a question
# of timing and becomes one of layout.
#
#   scripts/release.sh              cut a release from the source checkout's HEAD and switch to it
#   scripts/release.sh <ref>        ... from a specific ref
#   scripts/release.sh --list       show releases, marking current and previous
#   scripts/release.sh --rollback   switch back to the previous release
#   scripts/release.sh --no-restart cut and switch, but leave the service alone
#
# Env overrides (all defaulted; the tests set every one of them):
#   SPO_SOURCE_REPO    the checkout to cut from          (default: this script's own repo)
#   SPO_RELEASES_DIR   where release trees live          (default: ~/.spo-releases)
#   SPO_CURRENT_LINK   the symlink the unit runs from    (default: ~/.spo-current)
#   SPO_RELEASE_KEEP   how many releases to retain       (default: 5)
#   SPO_RELEASE_UNITS  units to drain-restart            (default: the daemon + the dashboard)
set -euo pipefail

# GIT_* IS STRIPPED, AND THIS IS LOAD-BEARING RATHER THAN TIDY. scripts/git-hooks/post-merge calls
# this script, and a git hook runs with GIT_DIR (and GIT_INDEX_FILE, GIT_WORK_TREE, ...) exported.
# With those inherited, `git clone <src>` and every `git -C <dir>` below act on THE HOOK'S
# repository instead of the one named on the command line. That is not hypothetical: on 2026-09-05
# the same inheritance let this repo's own test suite write empty commits onto the branch being
# pushed, detach two live worktrees, leave refs/heads/main a dangling symref and set core.bare=true
# -- see test/no-git-env-sweep.test.js. A deploy script is a far worse place to learn it twice.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
      GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE GIT_CEILING_DIRECTORIES GIT_CONFIG GIT_CONFIG_GLOBAL

SOURCE_REPO="${SPO_SOURCE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
RELEASES_DIR="${SPO_RELEASES_DIR:-$HOME/.spo-releases}"
CURRENT_LINK="${SPO_CURRENT_LINK:-$HOME/.spo-current}"
KEEP="${SPO_RELEASE_KEEP:-5}"
UNITS="${SPO_RELEASE_UNITS:-spo-pipeline-daemon.service spo-pipeline-dashboard.service}"
PREV_FILE="$RELEASES_DIR/.previous"

die() { echo "!! release: $*" >&2; exit 1; }

# The symlink swap. `ln -sfn` is NOT atomic -- it unlinks and re-creates, so a reader between the
# two sees nothing at all. `mv -T` over a symlink is rename(2), which is. A daemon starting in that
# window is exactly the kind of once-a-year failure this layout is supposed to remove, not add.
switch_to() {
  local target="$1" tmp
  [ -d "$target" ] || die "no such release: $target"
  tmp="$(mktemp -u "${CURRENT_LINK}.tmp.XXXXXX")"
  ln -s "$target" "$tmp"
  mv -T "$tmp" "$CURRENT_LINK"
}

current_target() { readlink "$CURRENT_LINK" 2>/dev/null || true; }

restart_units() {
  if [ "${NO_RESTART:-0}" = "1" ]; then
    echo "== release: --no-restart, leaving services alone (they still run the OLD tree)"
    return
  fi
  for unit in $UNITS; do
    systemctl --user list-unit-files "$unit" >/dev/null 2>&1 || continue
    state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
    if [ "$state" = 'deactivating' ] || [ "$state" = 'activating' ]; then
      echo "== release: $unit is $state -- a restart is already in flight and will pick this up"
      continue
    fi
    if [ "$state" = 'active' ] || systemctl --user is-enabled "$unit" >/dev/null 2>&1; then
      # --no-block because a daemon stop DRAINS: it can legitimately take as long as the cards in
      # flight do (config.drainTimeoutMs, 45 min). Without it that wait lands on whoever ran the
      # deploy, in the middle of a `git pull`.
      echo "== release: restarting $unit (drains first; up to 45 min if a card is running)"
      systemctl --user restart --no-block "$unit" || echo "!! release: failed to restart $unit" >&2
    else
      echo "== release: SKIPPING $unit (installed but neither active nor enabled -- nothing to redeploy)"
    fi
  done
}

cmd_list() {
  [ -d "$RELEASES_DIR" ] || die "no releases directory at $RELEASES_DIR"
  local cur prev
  cur="$(current_target)"
  prev="$(cat "$PREV_FILE" 2>/dev/null || true)"
  for d in "$RELEASES_DIR"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    local mark=""
    [ "$d" = "$cur" ] && mark=" <- current"
    [ "$d" = "$prev" ] && mark="$mark (previous)"
    echo "$(basename "$d")$mark"
  done
}

cmd_rollback() {
  local prev
  prev="$(cat "$PREV_FILE" 2>/dev/null || true)"
  [ -n "$prev" ] || die "no previous release recorded in $PREV_FILE"
  [ -d "$prev" ] || die "the previous release is gone: $prev"
  local cur
  cur="$(current_target)"
  echo "== release: rolling back to $(basename "$prev")"
  switch_to "$prev"
  # Rollback is itself a switch, so the thing we just left becomes the new rollback target --
  # otherwise a second rollback would bounce back to the release we are rolling AWAY from.
  [ -n "$cur" ] && printf '%s\n' "$cur" > "$PREV_FILE"
  restart_units
}

# Keeps the newest $KEEP by mtime, and NEVER removes the current or previous target however old
# they are -- a rollback path that can be garbage-collected is not a rollback path.
prune_releases() {
  local cur prev
  cur="$(current_target)"
  prev="$(cat "$PREV_FILE" 2>/dev/null || true)"
  local -a all=()
  while IFS= read -r d; do all+=("$d"); done < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's:/$::')
  local i=0
  for d in "${all[@]}"; do
    i=$((i + 1))
    [ "$i" -le "$KEEP" ] && continue
    [ "$d" = "$cur" ] && continue
    [ "$d" = "$prev" ] && continue
    echo "== release: pruning $(basename "$d")"
    rm -rf "$d"
  done
}

cmd_release() {
  local ref="${1:-HEAD}" sha dest
  [ -d "$SOURCE_REPO/.git" ] || [ -f "$SOURCE_REPO/.git" ] || die "$SOURCE_REPO is not a git checkout"
  sha="$(git -C "$SOURCE_REPO" rev-parse --verify "$ref^{commit}" 2>/dev/null)" || die "no such ref in $SOURCE_REPO: $ref"

  # A release is a COMMIT. Cutting one from a dirty tree would produce a directory whose name
  # claims a sha it does not contain -- and pipeline-version.js would then journal that same wrong
  # sha on every card, which is precisely the provenance question this layout exists to answer.
  if [ -n "$(git -C "$SOURCE_REPO" status --porcelain 2>/dev/null)" ]; then
    die "$SOURCE_REPO has uncommitted changes -- commit or stash them; a release must be a commit"
  fi

  dest="$RELEASES_DIR/$sha"
  mkdir -p "$RELEASES_DIR"

  if [ -d "$dest" ]; then
    echo "== release: $sha already built, reusing"
  else
    echo "== release: building $sha"
    # A LOCAL CLONE, not `git worktree add`. A linked worktree keeps its administrative data inside
    # the SOURCE repo, so `git worktree prune`, a moved ~/SPO-Pipeline, or a deleted dev checkout
    # would break a RUNNING release. `git clone --local` hardlinks objects into the release's own
    # object store: cheap, and independent of the source's fate (hardlinked inodes survive the
    # source being gc'd or deleted). Deliberately NOT --shared, which would create exactly the
    # alternates dependency this avoids.
    #
    # It also keeps a real .git, which orchestrator/pipeline-version.js needs to report the sha --
    # `git archive` would give a tree that cannot describe itself, and every card's
    # `pipeline-version` line would read null.
    local tmp="$dest.partial.$$"
    rm -rf "$tmp"
    git clone --local --quiet --no-checkout "$SOURCE_REPO" "$tmp" || die "clone failed"
    git -C "$tmp" checkout --quiet --detach "$sha" || die "checkout of $sha failed"
    # Built under a .partial name and renamed into place, so an interrupted build never leaves a
    # half-populated tree that looks like a finished release to --list or to the symlink.
    mv -T "$tmp" "$dest"
  fi

  # THE RELEASE MUST BE ABLE TO DESCRIBE ITSELF, and it must describe itself as the sha we asked
  # for. This runs pipeline-version.js out of the new tree -- so it checks the clone, the detached
  # checkout, and the provenance path that every card's journal line depends on, in one probe.
  local reported
  reported="$(node -e 'process.stdout.write(String(require(process.argv[1]).readPipelineVersion().sha))' "$dest/orchestrator/pipeline-version.js" 2>/dev/null || true)"
  [ "$reported" = "$sha" ] || die "release $sha reports its own sha as '${reported:-<none>}' -- refusing to switch to a tree that cannot describe itself"

  local cur
  cur="$(current_target)"
  if [ "$cur" = "$dest" ]; then
    echo "== release: already current, nothing to switch"
  else
    [ -n "$cur" ] && printf '%s\n' "$cur" > "$PREV_FILE"
    switch_to "$dest"
    echo "== release: $CURRENT_LINK -> $sha"
  fi

  prune_releases
  restart_units
}

NO_RESTART=0
case "${1:-}" in
  --list)     cmd_list ;;
  --rollback) shift; [ "${1:-}" = "--no-restart" ] && NO_RESTART=1; cmd_rollback ;;
  --no-restart) NO_RESTART=1; shift; cmd_release "${1:-HEAD}" ;;
  -h|--help)  sed -n '2,30p' "$0" ;;
  *)          cmd_release "${1:-HEAD}" ;;
esac
