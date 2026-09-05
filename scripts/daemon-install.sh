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
# StartLimitIntervalSec/StartLimitBurst are [Unit] directives, NOT [Service] ones. They lived in
# [Service] until C6 verification, where systemd's own log said so out loud:
#   "Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring."
# and 'systemctl --user show' reported StartLimitIntervalUSec=10s -- the DEFAULT, not the 300s
# (quoted, not backticked, on purpose: UNITEOF is an UNQUOTED heredoc -- it must expand \$REPO,
#  \$NODE_BIN and \$HOME -- so a backtick pair here is COMMAND SUBSTITUTION. This exact line ran
#  'systemctl --user show' at install time and pasted its several-hundred-line output into the
#  [Service] section of the generated unit. It went unnoticed because the installer had not been
#  re-run since the comment was added; the live unit still carries the literal backticks.)
# this file thought it had set. With RestartSec=5 a crash loop restarts every ~5s, so at most ~2
# restarts ever land inside a 10s window and the burst of 5 was never reached: the rate limiter
# described below did not exist, and Restart=always looped on a genuine config error forever.
# That matters more since C6 than it did before: each restart can park up to workerCrashLimit (3)
# cards before its circuit breaker trips, so an unbounded restart loop is an unbounded park loop.
# A refuse-to-start (empty account pool, held single-instance lock) exits 1 immediately; five
# tries in five minutes then stop, instead of looping on a config error forever.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
WorkingDirectory=$REPO
ExecStart=$NODE_BIN orchestrator/daemon.js --real
Restart=always
RestartSec=5
# A DELIBERATE STOP IS NOT A FAILURE, and without this line systemd could not tell the two apart.
# The daemon installs SIGINT/SIGTERM handlers (it must: until a JS handler exists, Node kills the
# process on the OS default disposition and the single-instance lock file leaks), and those
# handlers exit 130/143. systemd reads any exit code outside SuccessExitStatus as a failure, so
# EVERY 'systemctl stop' left this unit 'failed' -- observed on this box on 2026-09-05:
#   ExecMainStatus=143  Result=exit-code  ActiveState=failed  UnitFileState=disabled
# That is not cosmetic, because scripts/git-hooks/post-merge gates on 'is-active OR is-enabled'.
# A 'failed', disabled unit answers no to both, so the hook skipped it IN SILENCE: the pull
# printed a dashboard restart, said nothing about the daemon, and looked exactly like a successful
# deploy. The sibling spo-pipeline-dashboard.service never had this problem precisely because it
# installs no handler -- SIGTERM kills it on the default disposition and systemd counts a death by
# the signal it sent as success.
# A CLEAN DRAIN NOW EXITS 0 (daemon.js), so 143/130 here cover only the other half: the drain's
# bound expired and stragglers had to be signalled, or a second signal asked for an immediate stop.
SuccessExitStatus=143 130
# MUST BE >= config.js's drainTimeoutMs (45 min = 2700s, the measured p95 of 56 real card runs)
# PLUS drainKillGraceMs (60s, how long a SIGTERMed straggler is given to finish dying) PLUS slack
# for the reap itself. 2700 + 60 + 60 = 2820.
# systemd SIGKILLs the whole cgroup when this expires, which skips daemon.js's exit hook entirely:
# no lock release, no park, no worktree WIP preserved. That is strictly worse than the SIGTERM the
# drain replaced, so a TimeoutStopSec below the sum does not SHORTEN the drain, it DELETES the
# orderly end of it. The daemon escalates to SIGKILL on its own inside the grace above precisely so
# that this ceiling is never the thing that ends the process. Raise all three together or none.
# A maintainer who does not want to wait sends the signal a second time
# (systemctl kill -s TERM spo-pipeline-daemon.service), which exits immediately.
TimeoutStopSec=2820
# The rate limit that bounds this Restart=always lives in [Unit] above -- see the comment there
# for the measurement that proved it was being silently ignored down here.
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

# Restart-on-update: a git post-merge hook restarts this unit (and spo-pipeline-dashboard.service
# if present) right after `git pull`/merge lands new code. Symlinked, not copied, so hook
# edits made in the repo take effect on the next merge without re-running this script.
echo "== wiring post-merge hook (restart on git pull)"
ln -sf "$REPO/scripts/git-hooks/post-merge" "$REPO/.git/hooks/post-merge"

# Pre-push gate: runs scripts/gate.sh (this repo's own suite) before a push leaves the machine.
# Same symlink mechanism as post-merge above, and installed by the same scripts, so a box that has
# the daemon also has the gate. See scripts/git-hooks/pre-push for why the local half exists
# alongside the CI one.
echo "== wiring pre-push hook (run the gate before pushing)"
ln -sf "$REPO/scripts/git-hooks/pre-push" "$REPO/.git/hooks/pre-push"

echo ""
echo "== the daemon is now AUTONOMOUS: --real, auto-pull every 5 min, one card at a time."
echo "== journals: $REPO/journal/   status: bin/spo status   cost: bin/spo cost"
echo "== parks:    tail -f $HOME/.spo-parks.log   (set SPO_PARK_NTFY_URL in a drop-in for push)"
echo "== stop:     systemctl --user stop spo-pipeline-daemon.service   (DRAINS: in-flight cards"
echo "==           finish first, up to 45 min; send it twice to stop immediately)"
