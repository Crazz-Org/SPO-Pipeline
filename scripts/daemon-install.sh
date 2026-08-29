#!/usr/bin/env bash
# One-time install of the pipeline daemon as a systemd --user service.
#
# Mirrors SPO-WebClient's scripts/bench-install.sh (the proven model on this machine): run it
# FROM the SPO-Pipeline checkout that should host the daemon, re-run it after pulling daemon
# changes (it restarts). Supervision model: systemd restarts a dead daemon (Restart=always,
# rate-limited so a genuine config error stops instead of looping); the single-instance lock
# (orchestrator/lock.js) makes the unit and any hand-run daemon mutually exclusive, and a
# crashed daemon's stale lock is swept on the next start.
#
# TWO DELIBERATE DIFFERENCES from bench-install.sh:
#
#   1. PATH is set explicitly. The bench worker only spawns node/npm/gh -- all in /usr/bin --
#      so inheriting systemd's default PATH works. The pipeline daemon also spawns the
#      `claude` CLI (steps/llm.js), which lives in ~/.local/bin on this machine: absent from
#      the systemd user-manager PATH. Without this line every LLM step fails at spawn and
#      every card parks.
#   2. Restart is rate-limited (StartLimitIntervalSec/Burst). The daemon refuses to start on
#      real config errors -- empty account pool, held lock -- and Restart=always alone would
#      hammer that refusal forever.
#
# The daemon starts in --real mode with auto-pull ON by default (autoPullMs = 5 min,
# orchestrator/config.js): once this unit is up, the daemon pulls claimable Todo cards and
# drives them END TO END on its own. To run the unit with auto-pull off, override the
# environment via a drop-in:  systemctl --user edit spo-pipeline-daemon.service
#   [Service]
#   Environment=SPO_AUTO_PULL_MS=0
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/spo-pipeline-daemon.service"

# The node that runs the daemon: resolved now, at install time, so an nvm-style setup where
# node is not in /usr/bin still produces a working unit.
NODE_BIN="$(command -v node)"

echo "== daemon repo: $REPO"
echo "== node: $NODE_BIN"

echo "== writing $UNIT"
mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=SPO pipeline daemon (orchestrator, --real: drives product cards end to end)
# Not a hard dependency -- the daemon parks tasks fine while the bench is down -- but when
# both start together the worker should be up before GATE steps begin depositing.
After=spo-bench-worker.service

[Service]
WorkingDirectory=$REPO
ExecStart=$NODE_BIN orchestrator/daemon.js --real
Restart=always
RestartSec=5
# A refuse-to-start (empty account pool, held single-instance lock) exits 1 immediately;
# five tries in five minutes then stop, instead of looping on a config error forever.
StartLimitIntervalSec=300
StartLimitBurst=5
# gh and claude must find their auth; PATH must reach node, npm, gh AND the claude CLI
# (~/.local/bin -- absent from the systemd user PATH, see the header).
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
# Park notification. The script always writes ~/.spo-parks.log; set SPO_PARK_NTFY_URL in a
# drop-in to also reach a phone, and SPO_PARK_TOAST=1 for a Windows toast. See its header.
Environment=SPO_PARK_ALERT_CMD=$REPO/scripts/park-alert.sh

[Install]
WantedBy=default.target
UNITEOF

systemctl --user daemon-reload
systemctl --user enable --now spo-pipeline-daemon.service
systemctl --user restart spo-pipeline-daemon.service

# Without linger the whole --user manager dies with the last login session, taking the
# daemon with it. This may prompt for sudo on some setups; if it fails, run it by hand.
if ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "!! could not enable linger — run manually:  sudo loginctl enable-linger $USER" >&2
fi

sleep 2
systemctl --user --no-pager --lines=8 status spo-pipeline-daemon.service || true

echo ""
echo "== the daemon is now AUTONOMOUS: --real, auto-pull every 5 min, one card at a time."
echo "== journals: $REPO/journal/   status: bin/spo status   cost: bin/spo cost"
echo "== parks:    tail -f $HOME/.spo-parks.log   (set SPO_PARK_NTFY_URL in a drop-in for push)"
echo "== stop:     systemctl --user stop spo-pipeline-daemon.service"
