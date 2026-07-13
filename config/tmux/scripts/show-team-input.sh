#!/usr/bin/env bash
# show-team-input.sh
# Show the input.md of the active charter team running in THIS tmux session.
# Opens in nvim (read-only) for markdown rendering.
# Triggered by Cmd+O via WezTerm → tmux C-M-S-o binding.
#
# Strategy: grab the start command of the first pi: window in the current
# session, extract the -e <ext.ts> path, swap to <ext.state.json>, read
# workDir from the state file, then open workDir/input.md.

session=$(tmux display-message -p '#{session_name}')

# Find the first pi: window in this session.
first_pi=$(tmux list-windows -t "$session" -F '#{window_index}:#{window_name}' \
  | grep ':pi:' | head -1)

if [[ -z "$first_pi" ]]; then
  tmux display-popup \
    -T " No active team " \
    -w 46 -h 5 \
    -E "echo 'No team agents running in this session.'; echo; read -r -p 'Press enter to close' _"
  exit 0
fi

win_idx="${first_pi%%:*}"

# Extract the extension file from the pane's start command.
start_cmd=$(tmux display-message -t "${session}:${win_idx}" -p '#{pane_start_command}')
ext_file=$(echo "$start_cmd" | grep -o '\-e [^ ]*' | cut -d' ' -f2)

if [[ -z "$ext_file" ]]; then
  tmux display-popup \
    -T " Error " \
    -w 50 -h 5 \
    -E "echo 'Could not extract extension file from pane start command.'; echo; read -r -p 'Press enter to close' _"
  exit 0
fi

state_file="${ext_file%.ts}.state.json"

work_dir=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('workDir', ''))
except Exception:
    print('')
" "$state_file" 2>/dev/null)

if [[ -z "$work_dir" ]]; then
  tmux display-popup \
    -T " Error " \
    -w 50 -h 5 \
    -E "echo 'Could not read workDir from state file.'; echo '$state_file'; echo; read -r -p 'Press enter to close' _"
  exit 0
fi

input_file="$work_dir/input.md"

if [[ ! -f "$input_file" ]]; then
  tmux display-popup \
    -T " Error " \
    -w 60 -h 5 \
    -E "echo 'input.md not found at:'; echo '$input_file'; echo; read -r -p 'Press enter to close' _"
  exit 0
fi

# Get the charter name for the title from the manifest.
manifest="$work_dir/session/manifest.json"
team_name=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('charter', 'team'))
except Exception:
    print('team')
" "$manifest" 2>/dev/null)

tmux display-popup \
  -T "  ${team_name} " \
  -w 80% -h 80% \
  -b rounded \
  -E "nvim -R '$input_file'"
