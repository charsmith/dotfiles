#!/usr/bin/env bash
# Install dependencies on macOS via Homebrew.
# Packages are declared in the repo-root Brewfile.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Install Homebrew if missing
if ! command -v brew &>/dev/null; then
  echo "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Make brew available in this shell (Apple Silicon vs Intel paths)
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

brew bundle --file="$REPO_DIR/Brewfile"

# wezterm: install as a cask, but don't let a flaky cask block the rest.
if ! brew list --cask wezterm &>/dev/null; then
  echo "Installing wezterm cask..."
  brew install --cask wezterm || echo "wezterm install failed — continuing." >&2
else
  echo "wezterm already installed, skipping."
fi

# tree-sitter CLI: required by nvim-treesitter (main branch) to compile parsers.
# The Homebrew tree-sitter formula is library-only (no CLI binary), so we pull
# the pre-built binary from GitHub releases instead.
if ! command -v tree-sitter &>/dev/null; then
  echo "Installing tree-sitter CLI..."
  arch="$(uname -m)"
  case "$arch" in
    arm64)  ts_arch="arm64" ;;
    x86_64) ts_arch="x64" ;;
    *) echo "Unsupported arch $arch for tree-sitter, skipping." >&2; ts_arch="" ;;
  esac
  if [[ -n "$ts_arch" ]]; then
    mkdir -p "$HOME/.local/bin"
    curl -fsSL "https://github.com/tree-sitter/tree-sitter/releases/latest/download/tree-sitter-macos-${ts_arch}.gz" \
      | gunzip > "$HOME/.local/bin/tree-sitter"
    chmod +x "$HOME/.local/bin/tree-sitter"
  fi
else
  echo "tree-sitter already installed, skipping."
fi

# nvm is intentionally installed via its official script (Homebrew nvm is discouraged)
if [[ ! -d "$HOME/.nvm" ]]; then
  echo "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
else
  echo "nvm already installed, skipping."
fi

echo "macOS dependencies ready."
