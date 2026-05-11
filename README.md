# dotfiles

Personal dotfiles for macOS and Ubuntu/Debian. Symlink-based — configs live in this repo, get linked into `~` and `~/.config`.

## Install

One-liner on a fresh machine:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/charsmith/.dotfiles/master/bootstrap.sh)
```

`bootstrap.sh` detects the OS, installs dependencies, clones this repo to `~/.dotfiles` (if not already cloned), and creates the symlinks. Safe to re-run.

## What's included

| Tool | Config | Purpose |
|------|--------|---------|
| bash | `config/bash/` + `_bashrc`, `_inputrc` | Shell, prompt setup, aliases |
| tmux | `config/tmux/` + `_tmux.conf` | Terminal multiplexer (catppuccin theme) |
| neovim | `config/nvim/` | LazyVim-based editor config |
| starship | `config/starship.toml` | Cross-shell prompt |
| wezterm | `config/wezterm/` | Terminal emulator (macOS) |

## Dependencies

| Tool | macOS | Ubuntu |
|------|-------|--------|
| starship, tmux, neovim, zoxide, pyenv, uv | `brew` | apt + official installers |
| nvm | official install script | official install script |
| wezterm | `brew --cask` | not auto-installed — install separately if needed |

Pyenv is kept alongside uv to provide a system-wide `python` for tools that expect it on `$PATH`.

## Layout

```
bootstrap.sh                # OS detection + entrypoint
scripts/
  install-deps-macos.sh     # brew + nvm
  install-deps-ubuntu.sh    # apt + GitHub releases + installers
  install-symlinks.sh       # symlink-only (idempotent)
config/                     # → ~/.config/
_bashrc, _inputrc, _tmux.conf  # → ~/.bashrc etc. (underscore becomes dot)
```

## Common tasks

Re-apply symlinks after adding a new config:

```bash
bash ~/.dotfiles/scripts/install-symlinks.sh
```

Re-run deps only (e.g. after editing the package list):

```bash
bash ~/.dotfiles/scripts/install-deps-macos.sh
```

Update neovim plugins:

```bash
nvim --headless "+Lazy! sync" +qa
# commit the resulting config/nvim/lazy-lock.json
```

## Secrets

Secrets live in the macOS Keychain and are loaded at shell startup via `set_secret_env` in `config/bash/locals/macos`:

```bash
security add-generic-password -a "$USER" -s "SLACK_TOKEN" -w "xoxb-..."
```

Missing keychain entries are skipped with a warning rather than exporting empty values.

## Notes

- `_gitconfig` is intentionally gitignored. Add your own at `~/.dotfiles/_gitconfig` after cloning and re-run `install-symlinks.sh`.
- On Apple Silicon, brew lives at `/opt/homebrew`. On Intel Macs, `/usr/local`. The bashrc handles both.
