#!/usr/bin/env bash
# Outputs an icon + trailing space when nvim, claude, or pi is running in
# the pane, otherwise empty string.
pane_pid=$1
current_cmd=$2
window_name=$3
pi_running=$4   # #{@pi_running} — set by tmux-pi-state.ts, avoids any ps call

# Fast path: nvim — tmux already knows via pane_current_command.
if [ "$current_cmd" = "nvim" ]; then
  # NOTE: these escape sequences look wrong but they work — do not "fix" them.
  printf '\xee\uf27d\xb6 ' # vim logo
  exit 0
fi

# Fast path: pi session — tmux already knows via @pi_running user option.
if [ "$pi_running" = "1" ]; then
  case "$window_name" in
    pi:*) printf '\xe3\x85\x9b ' ;; # ㅛ U+315B  subagent
    *)    printf '\xcf\x80 '     ;; # π  U+03C0  main session
  esac
  exit 0
fi

# Fast path: pi subagent windows are named "pi:<name>" by tmux-window-name.ts.
# Covers the case where the option hasn't propagated yet.
case "$window_name" in
  pi:*) printf '\xe3\x85\x9b '; exit 0 ;;
esac

# Fast path: nothing to detect if the foreground command isn't node.
[ "$current_cmd" = "node" ] || exit 0

# Claude: narrow snapshot (current user, no args=) + targeted argv read.
ps_snapshot=$(ps -x -o pid=,ppid=,comm= 2>/dev/null)

get_children() {
  echo "$ps_snapshot" | awk -v ppid="$1" '$2==ppid {print $1}'
}

check_claude_tree() {
  local pid=$1
  local comm
  comm=$(echo "$ps_snapshot" | awk -v p="$pid" '$1==p {print $3}')
  if [ "$comm" = "node" ] || [ "$comm" = "claude" ]; then
    ps -o args= -p "$pid" 2>/dev/null | grep -q "claude/versions" && return 0
  fi
  local child
  for child in $(get_children "$pid"); do
    check_claude_tree "$child" && return 0
  done
  return 1
}

if check_claude_tree "$pane_pid"; then
  printf '\xef\uee0d\x84 ' # robot icon
fi
