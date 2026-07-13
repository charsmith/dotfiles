#!/usr/bin/env bash
# jump-active-agent.sh <next|prev>
# Navigate to the next/previous tmux window with a running pi agent (green pill).
# The green pill is set by tmux-pi-state.ts and contains the color #A6E3A1.

direction="${1:-next}"
session=$(tmux display-message -p '#{session_name}')
current=$(tmux display-message -p '#{window_index}')

# Get all window indices in ascending order
mapfile -t indices < <(tmux list-windows -t "$session" -F '#{window_index}' | sort -n)
n=${#indices[@]}

if [[ $n -eq 0 ]]; then exit 0; fi

# Find indices of "green" (actively running agent) windows.
# tmux-pi-state.ts writes #A6E3A1 into window-status-format when an agent_start
# event fires and unsets it on agent_end / session_shutdown.
green=()
for idx in "${indices[@]}"; do
  fmt=$(tmux show-window-options -v -t "${session}:${idx}" window-status-format 2>/dev/null || true)
  if [[ "$fmt" == *"#A6E3A1"* ]]; then
    green+=("$idx")
  fi
done

if [[ ${#green[@]} -eq 0 ]]; then
  tmux display-message "No active agents"
  exit 0
fi

if [[ "$direction" == "next" ]]; then
  # First green window whose index is strictly greater than current; else wrap to first.
  target=""
  for gidx in "${green[@]}"; do
    if [[ "$gidx" -gt "$current" ]]; then
      target="$gidx"
      break
    fi
  done
  [[ -z "$target" ]] && target="${green[0]}"
else
  # Last green window whose index is strictly less than current; else wrap to last.
  target=""
  for gidx in "${green[@]}"; do
    if [[ "$gidx" -lt "$current" ]]; then
      target="$gidx"
    fi
  done
  [[ -z "$target" ]] && target="${green[-1]}"
fi

tmux select-window -t "${session}:${target}"
