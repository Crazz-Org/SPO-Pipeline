#!/usr/bin/env bash
# The default SPO_PARK_ALERT_CMD: what the daemon runs when a task parks.
#
#   park-alert.sh <taskId> <reason> <lastState>
#
# orchestrator/park-alert.js spawns this with a 10 s timeout and treats a non-zero exit as
# `park-alert-failed` in the journal. So this script has exactly two obligations: be FAST, and
# never fail. Every channel below is best-effort and independently optional; the script always
# exits 0, even when every one of them is unavailable.
#
# Three layers, cheapest and most reliable first:
#
#   1. A log line, always. Zero config, survives a headless machine, and is the thing to
#      `tail -f` during a soak. $SPO_PARK_LOG (default ~/.spo-parks.log).
#   2. ntfy, if $SPO_PARK_NTFY_URL is set (e.g. https://ntfy.sh/<your-topic>) -- this is the
#      one that reaches a phone, which is what an overnight run actually needs. curl is capped
#      at 5 s so a dead network cannot eat the daemon's timeout budget.
#   3. A Windows toast, on WSL, if $SPO_PARK_TOAST=1. Opt-in because launching powershell.exe
#      from WSL costs a second or more -- so it is fired DETACHED and never waited on.
#
# The journals stay the source of truth (`spo parked`, `spo task <id>`, journal/daemon.jsonl):
# this is a notification, not a record.

# Deliberately NOT `set -e`: a failing channel must not abort the ones after it.
set -u

task_id="${1:-?}"
reason="${2:-?}"
last_state="${3:-?}"

stamp="$(date -Is)"
line="$stamp  PARKED  $task_id  reason=$reason  lastState=$last_state"

# --- 1. the log, always ------------------------------------------------------------------
log="${SPO_PARK_LOG:-$HOME/.spo-parks.log}"
mkdir -p "$(dirname "$log")" 2>/dev/null
printf '%s\n' "$line" >> "$log" 2>/dev/null

# --- 2. ntfy, if configured --------------------------------------------------------------
if [ -n "${SPO_PARK_NTFY_URL:-}" ]; then
  # --connect-timeout gives up fast on a host that is down or black-holing (measured: a
  # black-holed address otherwise burns the whole -m budget), while -m still allows a slow but
  # working upload to finish. Together they cap this channel well under the daemon's 10 s.
  curl -fsS --connect-timeout 2 -m 5 \
    -H "Title: SPO pipeline parked: $task_id" \
    -H "Tags: warning" \
    -H "Priority: default" \
    -d "$reason (at $last_state)

spo task $task_id
spo parked" \
    "$SPO_PARK_NTFY_URL" >/dev/null 2>&1
fi

# --- 3. Windows toast on WSL, opt-in, detached -------------------------------------------
PS='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
if [ "${SPO_PARK_TOAST:-0}" = "1" ] && [ -x "$PS" ]; then
  # The balloon needs the icon to stay alive while it shows, so the whole thing sleeps a few
  # seconds -- far past this script's budget. setsid + & detaches it: we never wait, and its
  # outcome cannot affect our exit code.
  setsid "$PS" -NoProfile -NonInteractive -Command "
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    \$n = New-Object System.Windows.Forms.NotifyIcon
    \$n.Icon = [System.Drawing.SystemIcons]::Warning
    \$n.Visible = \$true
    \$n.ShowBalloonTip(10000, 'SPO pipeline parked', '$task_id -- $reason', 'Warning')
    Start-Sleep -Seconds 8
    \$n.Dispose()
  " >/dev/null 2>&1 &
fi

exit 0
