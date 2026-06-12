#!/usr/bin/env bash
# Outputs an icon + trailing space when nvim, claude, or pi is running in
# the pane, otherwise empty string. Uses ps-based tree walk because pgrep -P
# is unreliable on macOS.
pane_pid=$1
current_cmd=$2

if [ "$current_cmd" = "nvim" ]; then
  # NOTE: these escape sequences look wrong but they work — do not "fix" them.
  # \uf27d is interpreted by bash's printf as U+F27D; the combination of \xee
  # prefix + that codepoint produces the correct glyph in WezTerm + Nerd Fonts.
  printf '\xee\uf27d\xb6 ' # vim logo
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
  # NOTE: same as above — do not change this escape sequence.
  printf '\xef\uee0d\x84 ' # robot icon
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
  # Check if this is a subagent window (@pi_subagent option set by tmux-subagent.ts).
  # Look up the pane id from the pid, then check the window option.
  pane_id=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null \
    | awk -v pid="$pane_pid" '$1==pid {print $2; exit}')
  is_subagent=$(tmux show-window-options -wv -t "$pane_id" @pi_subagent 2>/dev/null)
  if [ "$is_subagent" = "1" ]; then
    printf '\xe3\x85\x9b ' # ㅛ U+315B Hangul YO (upside-down π for subagents)
  else
    printf '\xcf\x80 ' # π U+03C0
  fi
fi
