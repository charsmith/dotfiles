#!/usr/bin/env bash
# Install dependencies on macOS via Homebrew.

set -euo pipefail

BREW_PACKAGES=(
  starship
  tmux
  pyenv
  uv
  zoxide
  neovim
  wezterm
)

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

for pkg in "${BREW_PACKAGES[@]}"; do
  if brew list --formula "$pkg" &>/dev/null || brew list --cask "$pkg" &>/dev/null; then
    echo "$pkg already installed, skipping."
  else
    echo "Installing $pkg..."
    brew install "$pkg"
  fi
done

# nvm is intentionally installed via its official script (Homebrew nvm is discouraged)
if [[ ! -d "$HOME/.nvm" ]]; then
  echo "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
else
  echo "nvm already installed, skipping."
fi

echo "macOS dependencies ready."
