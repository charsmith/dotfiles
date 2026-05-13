#!/usr/bin/env bash
# Outputs a Nerd Font icon + trailing space when nvim or claude is running in
# the pane, otherwise empty string. Uses ps-based tree walk because pgrep -P
# is unreliable on macOS.
pane_pid=$1
current_cmd=$2

if [ "$current_cmd" = "nvim" ]; then
  printf '\xee\uf27d\xb6 ' # U+E736 vim logo
  exit 0
fi

# Walk process tree: collect all pids whose ancestor chain includes pane_pid,
# then check if any of their args contain the claude binary path.
ps_snapshot=$(ps -ax -o pid=,ppid=,args= 2>/dev/null)

get_children() {
  local parent=$1
  echo "$ps_snapshot" | awk -v ppid="$parent" '$2==ppid {print $1}'
}

check_tree() {
  local pid=$1
  local args
  args=$(echo "$ps_snapshot" | awk -v p="$pid" '$1==p {$1=$2=""; print}')
  if echo "$args" | grep -q "claude/versions"; then
    return 0
  fi
  local child
  for child in $(get_children "$pid"); do
    check_tree "$child" && return 0
  done
  return 1
}

if check_tree "$pane_pid"; then
  printf '\xef\uee0d\x84 ' # U+F544 robot icon
fi
