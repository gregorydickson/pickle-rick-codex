#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-}"
SESSION_ROOT="${2:-}"
MODE="${3:-pickle}"

if [[ -z "$NAME" || -z "$SESSION_ROOT" ]]; then
  echo "Usage: tmux-monitor.sh <session-name> <session-root> [mode]" >&2
  exit 1
fi

RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER_DESCRIPTOR="$(
  node --input-type=module - "$RUNTIME_ROOT" "$MODE" <<'EOF'
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtimeRoot = process.argv[2];
const mode = process.argv[3];
const moduleUrl = pathToFileURL(path.join(runtimeRoot, 'lib', 'runner-descriptors.js')).href;
const { getRunnerDescriptor } = await import(moduleUrl);
const descriptor = getRunnerDescriptor(mode);
console.log(descriptor.runnerLog);
console.log(descriptor.monitorMode);
EOF
)"
RUNNER_LOG="$SESSION_ROOT/$(printf '%s\n' "$RUNNER_DESCRIPTOR" | sed -n '1p')"
MONITOR_MODE="$(printf '%s\n' "$RUNNER_DESCRIPTOR" | sed -n '2p')"

mkdir -p "$SESSION_ROOT"
touch "$RUNNER_LOG"

status_cmd="while true; do clear; node '$RUNTIME_ROOT/bin/status.js' --session-dir '$SESSION_ROOT'; sleep 2; done"
runner_cmd="while true; do clear; echo '${MONITOR_MODE} Runner Log'; echo; if [[ -s '$RUNNER_LOG' ]]; then tail -n 120 '$RUNNER_LOG'; else echo 'Waiting for ${MONITOR_MODE} runner log...'; fi; sleep 2; done"
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
tmux select-pane -t "$TOP_RIGHT" -T "${MONITOR_MODE}-runner-log"
tmux select-pane -t "$BOTTOM_LEFT" -T "state-json"
tmux select-pane -t "$BOTTOM_RIGHT" -T "worker-message"
tmux select-window -t "$NAME:monitor"
