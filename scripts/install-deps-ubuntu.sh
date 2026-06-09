#!/usr/bin/env bash
# Install dependencies on Ubuntu/Debian.
#
# Strategy:
# - apt for system packages and pyenv build deps
# - GitHub release tarballs for neovim (matches /opt/nvim-linux-<arch> expected by
#   config/bash/locals/linux)
# - Official installer scripts for starship, zoxide, pyenv, nvm
# - wezterm is skipped here — install separately if you use it on Linux

set -euo pipefail

APT_PACKAGES=(
  build-essential
  ca-certificates
  curl
  git
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

# gh CLI is not in the default Ubuntu apt sources — add GitHub's repo first.
if ! command -v gh &>/dev/null; then
  echo "Adding GitHub CLI apt repository..."
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
fi

echo "Updating apt..."
sudo apt-get update -y
sudo apt-get install -y "${APT_PACKAGES[@]}" gh

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
  case "$(uname -m)" in
    x86_64)  _eza_arch="x86_64" ;;
    aarch64) _eza_arch="aarch64" ;;
    *) echo "Unsupported arch for eza: $(uname -m), skipping." >&2; _eza_arch="" ;;
  esac
  if [[ -n "$_eza_arch" ]]; then
    tmp="$(mktemp -d)"
    curl -fsSL "https://github.com/eza-community/eza/releases/latest/download/eza_${_eza_arch}-unknown-linux-gnu.tar.gz" -o "$tmp/eza.tar.gz"
    tar -C "$tmp" -xzf "$tmp/eza.tar.gz"
    install -m 0755 "$tmp/eza" "$HOME/.local/bin/eza"
    rm -rf "$tmp"
  fi
  unset _eza_arch
fi

# neovim: install to /opt/nvim-linux-<arch> (matches config/bash/locals/linux PATH)
# Asset naming changed in v0.10.4: nvim-linux64 → nvim-linux-x86_64 / nvim-linux-arm64
case "$(uname -m)" in
  x86_64)  _nvim_arch="x86_64" ;;
  aarch64) _nvim_arch="arm64"  ;;
  *) echo "Unsupported arch for neovim install: $(uname -m)"; exit 1 ;;
esac
_nvim_dir="/opt/nvim-linux-${_nvim_arch}"
if [[ ! -x "${_nvim_dir}/bin/nvim" ]]; then
  echo "Installing neovim ($NVIM_VERSION) for ${_nvim_arch}..."
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/nvim-linux-${_nvim_arch}.tar.gz" -o "$tmp/nvim.tar.gz"
  sudo rm -rf "${_nvim_dir}"
  sudo tar -C /opt -xzf "$tmp/nvim.tar.gz"
  rm -rf "$tmp"
else
  echo "neovim already installed at ${_nvim_dir}, skipping."
fi
unset _nvim_arch _nvim_dir

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

# tree-sitter CLI: required by nvim-treesitter (main branch) to compile parsers.
if ! command -v tree-sitter &>/dev/null; then
  echo "Installing tree-sitter CLI..."
  case "$(uname -m)" in
    x86_64)  _ts_arch="x64" ;;
    aarch64) _ts_arch="arm64" ;;
    *) echo "Unsupported arch for tree-sitter: $(uname -m), skipping." >&2; _ts_arch="" ;;
  esac
  if [[ -n "$_ts_arch" ]]; then
    mkdir -p "$HOME/.local/bin"
    curl -fsSL "https://github.com/tree-sitter/tree-sitter/releases/latest/download/tree-sitter-linux-${_ts_arch}.gz" \
      | gunzip > "$HOME/.local/bin/tree-sitter"
    chmod +x "$HOME/.local/bin/tree-sitter"
  fi
  unset _ts_arch
else
  echo "tree-sitter already installed, skipping."
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
