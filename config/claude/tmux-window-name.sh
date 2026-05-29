#!/usr/bin/env bash
# Rename the current tmux window to the basename of the Claude startup directory.
[ -z "$TMUX" ] && exit 0

input=$(cat)
dir=$(echo "$input" | jq -r '.cwd // .workspace.current_dir // ""')
[ -z "$dir" ] && exit 0

tmux rename-window "$(basename "$dir")" 2>/dev/null || true
