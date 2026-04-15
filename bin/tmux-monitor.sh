#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-}"
SESSION_ROOT="${2:-}"
MODE="${3:-pickle}"

if [[ -z "$NAME" || -z "$SESSION_ROOT" ]]; then
  echo "Usage: tmux-monitor.sh <session-name> <session-root> [pickle]" >&2
  exit 1
fi

RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$MODE" == "pickle" ]]; then
  RUNNER_LOG="$SESSION_ROOT/mux-runner.log"
else
  RUNNER_LOG="$SESSION_ROOT/loop-runner.log"
fi

mkdir -p "$SESSION_ROOT"
touch "$RUNNER_LOG"

status_cmd="while true; do clear; node '$RUNTIME_ROOT/bin/status.js' --session-dir '$SESSION_ROOT'; sleep 2; done"
runner_cmd="tail -n 120 -F '$RUNNER_LOG'"
state_cmd="while true; do clear; cat '$SESSION_ROOT/state.json' 2>/dev/null || echo 'No state.json yet.'; sleep 2; done"
last_message_cmd="while true; do clear; node '$RUNTIME_ROOT/bin/latest-worker-message.js' '$SESSION_ROOT'; sleep 2; done"

tmux new-window -t "$NAME" -n monitor -c "$SESSION_ROOT"
tmux send-keys -t "$NAME:monitor.0" "$status_cmd" Enter
tmux split-window -h -t "$NAME:monitor.0" -c "$SESSION_ROOT"
tmux send-keys -t "$NAME:monitor.1" "$runner_cmd" Enter
tmux split-window -v -t "$NAME:monitor.0" -c "$SESSION_ROOT"
tmux send-keys -t "$NAME:monitor.2" "$state_cmd" Enter
tmux split-window -v -t "$NAME:monitor.1" -c "$SESSION_ROOT"
tmux send-keys -t "$NAME:monitor.3" "$last_message_cmd" Enter
tmux select-layout -t "$NAME:monitor" tiled >/dev/null
tmux select-window -t "$NAME:monitor"
