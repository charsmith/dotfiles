# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Personal dotfiles managed with a symlink-based install system. All configs live under `config/` and get symlinked into `~/.config/` at install time. Files prefixed with `_` in the repo root get symlinked to `~/` with the `_` replaced by `.` (e.g., `_bashrc` → `~/.bashrc`).

## Install / Bootstrap

Fresh machine setup (clones repo + installs packages + runs install):
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/charsmith/.dotfiles/master/bootstrap.sh)
```

Re-apply symlinks only (safe to re-run, skips already-linked files):
```bash
bash ~/.dotfiles/scripts/install-symlinks.sh
```

Reinstall deps only:
```bash
bash ~/.dotfiles/scripts/install-deps-macos.sh    # or install-deps-ubuntu.sh
```

## Scripts

| Script | Role |
|--------|------|
| `bootstrap.sh` | Entry point. Detects OS via `uname` + `/etc/os-release`, clones repo if missing, runs the right deps script, then symlinks. |
| `scripts/install-deps-macos.sh` | Homebrew + nvm (via official installer). |
| `scripts/install-deps-ubuntu.sh` | apt for system pkgs + pyenv build deps; GitHub release tarball for neovim (to `/opt/nvim-linux64`); official installers for starship, zoxide, pyenv, nvm. |
| `scripts/install-symlinks.sh` | Symlinks only — no package installs. Uses `TARGET_HOME` env var (defaults to `$HOME`) so it can be dry-tested. |

## Symlink Conventions

- `config/<name>/` → symlinked as `~/.config/<name>`
- `_<name>` in repo root → symlinked as `~/.<name>` (underscore becomes dot)
- `install.sh` skips already-symlinked targets; backs up existing files to `<file>.bak`

## Config Structure

| Path | Purpose |
|------|---------|
| `config/bash/bashrc` | Main bash config — sources functions, aliases, locals |
| `config/bash/bash_aliases` | Shell aliases (`vi=nvim`, `cd=z`, ls variants) |
| `config/bash/bash_functions` | Bash utility functions |
| `config/bash/locals/macos` | macOS-specific env (reads secrets from macOS Keychain) |
| `config/bash/locals/linux` | Linux-specific env |
| `config/nvim/` | Neovim config (LazyVim-based) |
| `config/tmux/tmux.conf` | Tmux config (tpm + catppuccin mocha theme) |
| `config/tmux/plugins/` | Vendored tmux plugins (tpm, catppuccin, vim-tmux-navigator) |
| `config/starship.toml` | Starship prompt config |
| `config/wezterm/wezterm.lua` | WezTerm terminal config |
| `_bashrc` | `~/.bashrc` entry point — sources `~/.config/bash/bashrc` |
| `_inputrc` | Readline config |
| `_tmux.conf` | `~/.tmux.conf` entry point |

## Neovim Setup

Built on [LazyVim](https://www.lazyvim.org/). Entry: `config/nvim/init.lua` loads `config.options` then `config.lazy`. Plugin specs live in `config/nvim/lua/plugins/`. `lazy-lock.json` pins plugin versions.

Key plugins: catppuccin theme, telescope, neo-tree, lualine, noice, treesitter, nvim-tmux-navigator, completion stack.

## Secrets (macOS)

Secrets are stored in macOS Keychain and loaded via `set_secret_env` in `config/bash/locals/macos`:
```bash
security add-generic-password -a $USER -s "SECRET_NAME" -w "value"
```
The function exports the value as an env var at shell startup. Do not hardcode secrets in any config file.

## Adding a New Config

1. Add files under `config/<tool>/`
2. Re-run `bash install.sh` to create the symlink at `~/.config/<tool>`
3. For a dotfile in `~/`, add `_<name>` to the repo root and re-run install
