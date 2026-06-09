#!/usr/bin/env bash
# Outputs an icon + trailing space when nvim, claude, or pi is running in
# the pane, otherwise empty string. Uses ps-based tree walk because pgrep -P
# is unreliable on macOS.
pane_pid=$1
current_cmd=$2

if [ "$current_cmd" = "nvim" ]; then
  printf '\xee\x9c\xb6 ' # U+E736 vim logo (nf-dev-vim)
  exit 0
fi

# Snapshot: pid ppid comm args (comm is the short executable name)
ps_snapshot=$(ps -ax -o pid=,ppid=,comm=,args= 2>/dev/null)

get_children() {
  local parent=$1
  echo "$ps_snapshot" | awk -v ppid="$parent" '$2==ppid {print $1}'
}

# Walk process tree rooted at $1; return 0 if any node matches predicate $2
# Predicate is a grep pattern matched against the full ps line for each pid.
check_tree() {
  local pid=$1
  local pattern=$2
  local line
  line=$(echo "$ps_snapshot" | awk -v p="$pid" '$1==p')
  if echo "$line" | grep -q "$pattern"; then
    return 0
  fi
  local child
  for child in $(get_children "$pid"); do
    check_tree "$child" "$pattern" && return 0
  done
  return 1
}

# Claude: look for "claude/versions" anywhere in the args subtree
if check_tree "$pane_pid" "claude/versions"; then
  printf '\xef\x95\x84 ' # U+F544 robot icon (nf-mdi-robot)
  exit 0
fi

# Pi coding agent: look for comm == "pi" anywhere in the subtree.
# The pi binary is a Node shebang so tmux sees "node" as current_cmd,
# but ps shows comm="pi" for the pi process itself.
check_pi_tree() {
  local pid=$1
  local line comm
  line=$(echo "$ps_snapshot" | awk -v p="$pid" '$1==p')
  comm=$(echo "$line" | awk '{print $3}')
  if [ "$comm" = "pi" ]; then
    return 0
  fi
  local child
  for child in $(get_children "$pid"); do
    check_pi_tree "$child" && return 0
  done
  return 1
}

if check_pi_tree "$pane_pid"; then
  printf '\xcf\x80 ' # π U+03C0
fi
