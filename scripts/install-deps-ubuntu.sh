#!/usr/bin/env bash
# Install dependencies on Ubuntu/Debian.
#
# Strategy:
# - apt for system packages and pyenv build deps
# - GitHub release tarballs for neovim (matches /opt/nvim-linux64 expected by
#   config/bash/locals/linux)
# - Official installer scripts for starship, zoxide, pyenv, nvm
# - wezterm is skipped here — install separately if you use it on Linux

set -euo pipefail

APT_PACKAGES=(
  build-essential
  ca-certificates
  curl
  git
  gh
  tmux
  unzip
  bash-completion
  fzf
  bat
  fd-find
  ripgrep
  direnv
  # pyenv build deps
  libssl-dev
  zlib1g-dev
  libbz2-dev
  libreadline-dev
  libsqlite3-dev
  libncursesw5-dev
  xz-utils
  tk-dev
  libxml2-dev
  libxmlsec1-dev
  libffi-dev
  liblzma-dev
)

NVIM_VERSION="${NVIM_VERSION:-stable}"
NVM_VERSION="${NVM_VERSION:-v0.39.7}"

echo "Updating apt..."
sudo apt-get update -y
sudo apt-get install -y "${APT_PACKAGES[@]}"

# Ubuntu ships bat as `batcat` and fd-find as `fdfind` to avoid name clashes.
# The bashrc and fzf integration expect `bat` and `fd`, so shim them into
# ~/.local/bin (already on PATH per bashrc).
mkdir -p "$HOME/.local/bin"
if command -v batcat >/dev/null 2>&1 && ! command -v bat >/dev/null 2>&1; then
  ln -sf "$(command -v batcat)" "$HOME/.local/bin/bat"
fi
if command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1; then
  ln -sf "$(command -v fdfind)" "$HOME/.local/bin/fd"
fi

# eza isn't in default apt; pull from its GitHub release.
if ! command -v eza &>/dev/null; then
  echo "Installing eza..."
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/eza-community/eza/releases/latest/download/eza_x86_64-unknown-linux-gnu.tar.gz" -o "$tmp/eza.tar.gz"
  tar -C "$tmp" -xzf "$tmp/eza.tar.gz"
  install -m 0755 "$tmp/eza" "$HOME/.local/bin/eza"
  rm -rf "$tmp"
fi

# neovim: install to /opt/nvim-linux64 (matches config/bash/locals/linux PATH)
if [[ ! -x /opt/nvim-linux64/bin/nvim ]]; then
  echo "Installing neovim ($NVIM_VERSION)..."
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/nvim-linux64.tar.gz" -o "$tmp/nvim.tar.gz"
  sudo rm -rf /opt/nvim-linux64
  sudo tar -C /opt -xzf "$tmp/nvim.tar.gz"
  rm -rf "$tmp"
else
  echo "neovim already installed at /opt/nvim-linux64, skipping."
fi

# starship
if ! command -v starship &>/dev/null; then
  echo "Installing starship..."
  curl -fsSL https://starship.rs/install.sh | sh -s -- --yes
else
  echo "starship already installed, skipping."
fi

# zoxide
if ! command -v zoxide &>/dev/null; then
  echo "Installing zoxide..."
  curl -fsSL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash
else
  echo "zoxide already installed, skipping."
fi

# pyenv
if [[ ! -d "$HOME/.pyenv" ]]; then
  echo "Installing pyenv..."
  curl -fsSL https://pyenv.run | bash
else
  echo "pyenv already installed, skipping."
fi

# uv
if ! command -v uv &>/dev/null; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
else
  echo "uv already installed, skipping."
fi

# nvm
if [[ ! -d "$HOME/.nvm" ]]; then
  echo "Installing nvm..."
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
else
  echo "nvm already installed, skipping."
fi

echo "Ubuntu dependencies ready."
echo "Note: wezterm is not installed by this script. Install from https://wezfurlong.org/wezterm/install/linux.html if needed."
