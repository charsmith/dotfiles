#!/usr/bin/env bash
# Outputs the effective command name for the current pane, substituting "pi"
# when a pi process is detected in the tree (tmux sees the underlying "node"
# process, not the pi shebang script name).
pane_pid=$1
current_cmd=$2

# Fast-path: if it's not node, just echo it directly.
if [ "$current_cmd" != "node" ]; then
  echo "$current_cmd"
  exit 0
fi

# Snapshot: pid ppid comm args
ps_snapshot=$(ps -ax -o pid=,ppid=,comm=,args= 2>/dev/null)

get_children() {
  local parent=$1
  echo "$ps_snapshot" | awk -v ppid="$parent" '$2==ppid {print $1}'
}

# Walk process tree rooted at $1; return 0 if any node has comm == "pi"
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
  echo "pi"
else
  echo "$current_cmd"
fi
