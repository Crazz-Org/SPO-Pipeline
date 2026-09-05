#!/usr/bin/env bash
# One-time install of the dashboard server as a systemd --user service.
#
# Same model as scripts/daemon-install.sh (the orchestrator daemon unit): systemd restarts a
# dead server (Restart=always, rate-limited so a genuine config error stops instead of
# looping), survives reboot via `loginctl enable-linger`. Re-run this script from the
# SPO-Pipeline checkout that should host the server after pulling dashboard changes -- it
# restarts the unit.
#
# Unlike the orchestrator daemon, the dashboard server (bin/spo dashboard --serve) only reads
# local state to render HTML -- it does not spawn gh or claude -- so it needs no extra PATH
# entries beyond node itself.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CURRENT_LINK="${SPO_CURRENT_LINK:-$HOME/.spo-current}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/spo-pipeline-dashboard.service"
PORT="${SPO_DASHBOARD_PORT:-8090}"

# The node that runs the server: resolved now, at install time, so an nvm-style setup where
# node is not in /usr/bin still produces a working unit.
NODE_BIN="$(command -v node)"

echo "== dashboard repo: $REPO"
echo "== node: $NODE_BIN"
echo "== port: $PORT"

echo "== writing $UNIT"
mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=SPO pipeline dashboard server (bin/spo dashboard --serve)

[Service]
# Same release symlink the daemon unit uses -- see scripts/daemon-install.sh's own comment. The
# dashboard reads the journal, which now lives outside every tree (~/.spo-state, see
# orchestrator/state-root.js), so running it from a release is a pure win: it reports on the same
# state whichever release is current.
WorkingDirectory=$CURRENT_LINK
ExecStart=$NODE_BIN $CURRENT_LINK/bin/spo dashboard --serve --port $PORT
Restart=always
RestartSec=5
# A refuse-to-start (port already bound) exits immediately; five tries in five minutes then
# stop, instead of looping on a config error forever.
StartLimitIntervalSec=300
StartLimitBurst=5
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
