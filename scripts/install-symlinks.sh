#!/usr/bin/env bash
# Symlink dotfiles into $HOME and config/ into $HOME/.config.
#
# - Files matching `_*` at the repo root are linked to `~/.<name>`
#   (e.g. _bashrc -> ~/.bashrc). Existing real files are backed up to <file>.bak.
# - Subdirectories of `config/` are linked to `~/.config/<name>`.
# - Existing symlinks are left alone (safe to re-run).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_HOME="${TARGET_HOME:-$HOME}"

link_file() {
  local source="$1"
  local target="$2"

  if [[ -L "$target" ]]; then
    return
  fi

  if [[ -e "$target" ]]; then
    echo "Backing up existing $target -> $target.bak"
    mv "$target" "$target.bak"
  fi

  ln -s "$source" "$target"
  echo "Linked $source -> $target"
}

# Link _foo files at repo root to ~/.foo
shopt -s nullglob
for source in "$REPO_DIR"/_*; do
  name="$(basename "$source")"
  target="$TARGET_HOME/.${name#_}"
  link_file "$source" "$target"
done

# Link config/* to ~/.config/*
mkdir -p "$TARGET_HOME/.config"
for source in "$REPO_DIR"/config/*; do
  name="$(basename "$source")"
  target="$TARGET_HOME/.config/$name"
  link_file "$source" "$target"
done

echo "Done."
