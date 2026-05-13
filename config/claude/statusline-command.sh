#!/usr/bin/env bash
export COLORTERM=truecolor

input=$(cat)

raw_dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
model=$(echo "$input" | jq -r '.model.display_name // ""')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# Path: replicate starship behavior — strip home prefix then prepend …/ (matches observed output)
ellipsis=$(printf '\xe2\x80\xa6')
rel_dir="${raw_dir/#"$HOME"\//}"  # strip $HOME/ prefix, leaving e.g. ".dotfiles" or "a/b/c"
if [[ "$rel_dir" == "$raw_dir" ]]; then
  short_dir="$raw_dir"  # not under home, show as-is
else
  IFS='/' read -ra segs <<< "$rel_dir"
  cnt=${#segs[@]}
  (( cnt > 2 )) && short_dir="${ellipsis}/${segs[cnt-2]}/${segs[cnt-1]}" || short_dir="${ellipsis}/${segs[cnt-1]}"
fi

# Git info
git_branch=""
git_dirty=""
if GIT_OPTIONAL_LOCKS=0 git -C "$raw_dir" rev-parse --git-dir >/dev/null 2>&1; then
  git_branch=$(GIT_OPTIONAL_LOCKS=0 git -C "$raw_dir" symbolic-ref --short HEAD 2>/dev/null \
    || GIT_OPTIONAL_LOCKS=0 git -C "$raw_dir" rev-parse --short HEAD 2>/dev/null)
  dirty=$(GIT_OPTIONAL_LOCKS=0 git -C "$raw_dir" status --porcelain 2>/dev/null | head -1)
  [ -n "$dirty" ] && git_dirty="!? "
fi

# Catppuccin mocha RGB values (verified from starship xxd output)
_surface0="49;50;68"
_peach="250;179;135"
_green="166;227;161"
_teal="148;226;213"
_blue="137;180;250"
_text="205;214;244"
_mantle="24;24;37"
_base="30;30;46"

# ANSI helpers — combined codes, no resets mid-render (matches starship exactly)
fg()    { printf '\033[38;2;%sm' "$1"; }
fg_bg() { printf '\033[48;2;%s;38;2;%sm' "$1" "$2"; }  # bg first, then fg

reset=$(printf '\033[0m')

# Nerd font chars as UTF-8 byte sequences (bash 3.2 compatible)
cap_open=$(printf '\xee\x82\xb6')  # U+E0B6 rounded left pill cap
arrow=$(printf '\xee\x82\xb0')     # U+E0B0 solid chevron
os_icon=$(printf '\xee\x9c\x91')   # U+E711 macOS icon
git_icon=$(printf '\xef\x90\x98')  # U+F418 git branch icon

# Build output — structure mirrors starship exactly:
#   fg:prev_color + cap/arrow | fg_bg(new_bg, prev_bg) + arrow | fg(text_color) + content
out=""

# Opening rounded cap: fg:surface0, no bg (renders as left pill edge against terminal bg)
out+="$(fg $_surface0)${cap_open}"

# Segment 1 — os icon + username: combined bg:surface0 + fg:text
out+="$(fg_bg $_surface0 $_text)${os_icon} charsmith "

# Transition surface0 → peach: combined bg:peach + fg:surface0
out+="$(fg_bg $_peach $_surface0)${arrow}"
# Directory content: fg:mantle only (bg:peach carries over from transition)
out+="$(fg $_mantle) ${short_dir} "

# Transition peach → green (or peach → teal if no git)
if [ -n "$git_branch" ]; then
  out+="$(fg_bg $_green $_peach)${arrow}"
  out+="$(fg $_base) ${git_icon} ${git_branch} ${git_dirty}"
  prev_color="$_green"
else
  prev_color="$_peach"
fi

# Transition → teal for model
if [ -n "$model" ]; then
  out+="$(fg_bg $_teal $prev_color)${arrow}"
  out+="$(fg $_base) ${model} "
  prev_color="$_teal"
fi

# Transition → blue for context %
if [ -n "$used_pct" ]; then
  out+="$(fg_bg $_blue $prev_color)${arrow}"
  out+="$(fg $_base) ctx:$(printf '%.0f' "$used_pct")% "
  prev_color="$_blue"
fi

# Closing arrow back to terminal bg: fg:last_color, no bg
out+="$(fg $prev_color)${arrow}${reset}"

printf '%s' "$out"
