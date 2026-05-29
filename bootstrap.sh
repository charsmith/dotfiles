#!/usr/bin/env bash
# Entry point for a fresh machine.
# Detects OS, installs dependencies, clones the repo, and symlinks configs.

set -euo pipefail

DOTFILES_DIR="${DOTFILES_DIR:-$HOME/.dotfiles}"
REPO="${DOTFILES_REPO:-https://github.com/charsmith/.dotfiles}"

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)
      if [[ -r /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        case "${ID:-}${ID_LIKE:-}" in
          *ubuntu*|*debian*) echo "ubuntu" ;;
          *) echo "unsupported-linux" ;;
        esac
      else
        echo "unsupported-linux"
      fi
      ;;
    *) echo "unsupported" ;;
  esac
}

OS="$(detect_os)"

# Clone dotfiles first so we can run scripts from the repo
if [[ ! -d "$DOTFILES_DIR" ]]; then
  echo "Cloning dotfiles to $DOTFILES_DIR..."
  git clone "$REPO" "$DOTFILES_DIR"
else
  echo "$DOTFILES_DIR already exists, skipping clone."
fi

case "$OS" in
  macos)
    bash "$DOTFILES_DIR/scripts/install-deps-macos.sh"
    ;;
  ubuntu)
    bash "$DOTFILES_DIR/scripts/install-deps-ubuntu.sh"
    ;;
  *)
    echo "Unsupported OS: $OS. Skipping dependency install — symlinks only."
    ;;
esac

bash "$DOTFILES_DIR/scripts/install-symlinks.sh"
bash "$DOTFILES_DIR/scripts/install-claude.sh"

echo "Bootstrap complete."
