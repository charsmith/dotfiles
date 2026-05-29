#!/usr/bin/env bash
# Control the tmux window-status pill color for the Claude session window.
#
# Modes:
#   running   — green:  Claude is actively working
#   waiting   — red:    Claude needs user input / permission
#   inactive  — gray:   turn ended, nothing to do (revert to theme default)
#   watch     — start a 7s timer; if not cancelled, transitions to waiting (red)
#   unwatch   — cancel the pending watch timer
#
# Usage (manual):
#   bash ~/.config/claude/tmux-claude-state.sh <mode>
#
# Hook wiring:
#   PreToolUse     → watch
#   PostToolUse    → unwatch + running
#   Stop           → unwatch + inactive
#   UserPromptSubmit → unwatch + running
#   SessionStop    → inactive
#
# Reads and discards stdin (Claude Code pipes JSON into hooks).

cat > /dev/null

[ -z "$TMUX" ] && exit 0

mode="${1:-inactive}"

win=$(tmux display-message -p -t "${TMUX_PANE:-}" '#{window_id}' 2>/dev/null)
[ -z "$win" ] && exit 0

# Per-window PID file so multiple sessions don't collide
pidfile="/tmp/claude-tmux-watch${win}.pid"

# Nerd Font rounded pill caps: U+E0B6 (left), U+E0B4 (right)
lc=$(printf '\xee\x82\xb6')
rc=$(printf '\xee\x82\xb4')

icon="#(~/.config/tmux/scripts/window-icon.sh #{pane_pid} #{pane_current_command})"

pill_fmt() {
  local color="$1"
  echo "#[fg=#11111b,bg=${color}]#[fg=#181825,reverse]${lc}#[none]#I #[fg=#cdd6f4,bg=#45475a] ${icon}#W#[fg=#181825,reverse]${rc}#[none]"
}

set_pill() {
  tmux set-window-option -t "$win" window-status-format "$1"
  tmux refresh-client -S 2>/dev/null || true
}

revert_pill() {
  tmux set-window-option -ut "$win" window-status-format 2>/dev/null || true
  tmux refresh-client -S 2>/dev/null || true
}

cancel_watch() {
  if [[ -f "$pidfile" ]]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi
}

case "$mode" in
  running)
    cancel_watch
    set_pill "$(pill_fmt '#A6E3A1')" ;;

  waiting)
    cancel_watch
    set_pill "$(pill_fmt '#F38BA8')" ;;

  inactive)
    cancel_watch
    revert_pill ;;

  watch)
    cancel_watch
    # Export vars needed by the background subshell
    export TMUX TMUX_PANE
    ( sleep 7
      rm -f "$pidfile"
      bash ~/.config/claude/tmux-claude-state.sh waiting
    ) &
    echo $! > "$pidfile" ;;

  unwatch)
    cancel_watch ;;

  *)
    echo "usage: tmux-claude-state.sh [running|waiting|inactive|watch|unwatch]" >&2
    exit 1 ;;
esac
