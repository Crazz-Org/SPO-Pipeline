#!/usr/bin/env bash
# One-time install of the dashboard server as a systemd --user service.
#
# Same model as scripts/daemon-install.sh (the orchestrator daemon unit): systemd restarts a
# dead server (Restart=always, rate-limited so a genuine config error stops instead of
# looping), survives reboot via `loginctl enable-linger`. Re-run this script from the
# SPO-Pipeline checkout that should host the server after pulling dashboard changes -- it
# restarts the unit.
#
# Unlike the orchestrator daemon, the dashboard server (bin/spo dashboard --serve) mostly reads
# local state to render HTML -- it does write a couple of small files of its own (par-times.json
# on its own timer, and now an occasional daemon.jsonl event on a write failure, card #137) -- but
# it does not spawn gh or claude, so it needs no extra PATH entries beyond node itself.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# ONE CHECKOUT MAY INSTALL THE DASHBOARD, AND IT IS NOT WHICHEVER ONE YOU HAPPEN TO RUN THIS FROM.
# Run from an agent worktree under .claude/worktrees/<slug>/, this script would otherwise overwrite
# the LIVE unit file with that worktree's own copy of the heredoc below, then enable/restart the
# live service from it. Unlike scripts/daemon-install.sh it cannot repoint the service AT the
# worktree -- the unit's ExecStart is $CURRENT_LINK and no release is cut here -- and the two
# `ln -sf` at the end cannot even complete: a worktree's .git is a FILE, so they fail with "Not a
# directory" under `set -e`, leaving the unit already rewritten and the service already restarted.
# The rule is shared, not reinvented here: scripts/git-hooks/post-merge and
# scripts/daemon-install.sh enforce the same one, and all three source scripts/lib/deploy-guard.sh
# so it cannot silently diverge between the three places it is enforced.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/deploy-guard.sh"
if ! deploy_guard_check "$REPO"; then
  {
    echo "!! dashboard-install.sh: refusing to install -- $DEPLOY_GUARD_REASON"
    echo "!!   tree seen:       $DEPLOY_GUARD_TREE"
    echo "!!   tree expected:   $DEPLOY_GUARD_SOURCE_REPO"
    echo "!!   branch seen:     $DEPLOY_GUARD_BRANCH"
    echo "!!   branch expected: $DEPLOY_GUARD_DEPLOY_BRANCH"
    echo "!!   nothing was written, no service was touched."
    echo "!!   if this is deliberate, override with SPO_SOURCE_REPO=... and/or SPO_DEPLOY_BRANCH=..."
  } >&2
  exit 1
fi

CURRENT_LINK="${SPO_CURRENT_LINK:-$HOME/.spo-current}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/spo-pipeline-dashboard.service"
PORT="${SPO_DASHBOARD_PORT:-8090}"

# The node that runs the server: resolved now, at install time, so an nvm-style setup where
# node is not in /usr/bin still produces a working unit.
NODE_BIN="$(command -v node)"

echo "== source checkout: $REPO  (the service runs from $CURRENT_LINK, never from here)"
echo "== node: $NODE_BIN"
echo "== port: $PORT"

echo "== writing $UNIT"
mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=SPO pipeline dashboard server (bin/spo dashboard --serve)
# StartLimitIntervalSec/StartLimitBurst are [Unit] directives, not [Service] ones: in [Service]
# systemd drops StartLimitIntervalSec ("Unknown key name ... ignoring") and the restart window
# falls back to its own 10s default, not the 300s below. Same mechanism, documented at length in
# scripts/daemon-install.sh's own [Unit] comment for the sibling unit that had the identical bug.
# A refuse-to-start (port already bound) exits immediately; five tries in five minutes then stop,
# instead of looping on a config error forever.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
# Same release symlink the daemon unit uses -- see scripts/daemon-install.sh's own comment. The
# dashboard reads the journal, which now lives outside every tree (~/.spo-state, see
# orchestrator/state-root.js), so running it from a release is a pure win: it reports on the same
# state whichever release is current.
WorkingDirectory=$CURRENT_LINK
ExecStart=$NODE_BIN $CURRENT_LINK/bin/spo dashboard --serve --port $PORT
Restart=always
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNITEOF

systemctl --user daemon-reload
systemctl --user enable --now spo-pipeline-dashboard.service
systemctl --user restart spo-pipeline-dashboard.service

# Without linger the whole --user manager dies with the last login session, taking the server
# with it. This may prompt for sudo on some setups; if it fails, run it by hand.
if ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "!! could not enable linger — run manually:  sudo loginctl enable-linger $USER" >&2
fi

sleep 2
systemctl --user --no-pager --lines=8 status spo-pipeline-dashboard.service || true

# Restart-on-update: a git post-merge hook restarts this unit (and spo-pipeline-daemon.service
# if present) right after `git pull`/merge lands new code. Symlinked, not copied, so hook
# edits made in the repo take effect on the next merge without re-running this script.
echo "== wiring post-merge hook (restart on git pull)"
ln -sf "$REPO/scripts/git-hooks/post-merge" "$REPO/.git/hooks/post-merge"

# Pre-push gate, same as daemon-install.sh wires -- either install script arms both hooks, so a box
# that installed only the dashboard is not left with the restart hook but no gate.
echo "== wiring pre-push hook (run the gate before pushing)"
ln -sf "$REPO/scripts/git-hooks/pre-push" "$REPO/.git/hooks/pre-push"

echo ""
echo "== dashboard now runs as a systemd --user service: restarts on crash, survives reboot."
echo "== url:   http://localhost:$PORT/"
echo "== stop:  systemctl --user stop spo-pipeline-dashboard.service"
echo "== port:  set SPO_DASHBOARD_PORT before running this script to change it, then re-run"
