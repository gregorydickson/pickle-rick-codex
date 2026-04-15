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
runner_cmd="while true; do clear; echo 'Runner Log'; echo; if [[ -s '$RUNNER_LOG' ]]; then tail -n 120 '$RUNNER_LOG'; else echo 'Waiting for runner log...'; fi; sleep 2; done"
state_cmd="while true; do clear; echo 'State JSON'; echo; cat '$SESSION_ROOT/state.json' 2>/dev/null || echo 'No state.json yet.'; sleep 2; done"
last_message_cmd="while true; do clear; node '$RUNTIME_ROOT/bin/latest-worker-message.js' '$SESSION_ROOT'; sleep 2; done"

tmux set-option -t "$NAME" mouse on

TOP_LEFT="$(tmux new-window -P -F '#{pane_id}' -t "$NAME" -n monitor -c "$SESSION_ROOT")"
BOTTOM_LEFT="$(tmux split-window -P -F '#{pane_id}' -v -t "$TOP_LEFT" -l 40% -c "$SESSION_ROOT")"
TOP_RIGHT="$(tmux split-window -P -F '#{pane_id}' -h -t "$TOP_LEFT" -c "$SESSION_ROOT")"
BOTTOM_RIGHT="$(tmux split-window -P -F '#{pane_id}' -h -t "$BOTTOM_LEFT" -c "$SESSION_ROOT")"

tmux send-keys -t "$TOP_LEFT" "$status_cmd" Enter
tmux send-keys -t "$TOP_RIGHT" "$runner_cmd" Enter
tmux send-keys -t "$BOTTOM_LEFT" "$state_cmd" Enter
tmux send-keys -t "$BOTTOM_RIGHT" "$last_message_cmd" Enter

tmux select-pane -t "$TOP_LEFT" -T "status"
tmux select-pane -t "$TOP_RIGHT" -T "runner-log"
tmux select-pane -t "$BOTTOM_LEFT" -T "state-json"
tmux select-pane -t "$BOTTOM_RIGHT" -T "worker-message"
tmux select-window -t "$NAME:monitor"
