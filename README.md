# dotfiles

Personal dotfiles for macOS and Ubuntu/Debian. Symlink-based — configs live in this repo, get linked into `~` and `~/.config`.

## Install

One-liner on a fresh machine:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/charsmith/.dotfiles/master/bootstrap.sh)
```

`bootstrap.sh` detects the OS, ensures git is installed, clones this repo to `~/.dotfiles` (if not already present), installs dependencies, creates the symlinks, and applies Claude Code settings. Safe to re-run.

> **macOS note:** if git isn't found, bootstrap will trigger the Xcode Command Line Tools installer and then exit — re-run bootstrap once the install completes.

## What's included

| Tool | Config | Purpose |
|------|--------|---------|
| bash | `config/bash/` + `_bashrc`, `_inputrc` | Shell, aliases, functions, OS-specific locals |
| tmux | `config/tmux/` + `_tmux.conf` | Terminal multiplexer (catppuccin mocha theme) |
| neovim | `config/nvim/` | LazyVim-based editor config |
| starship | `config/starship.toml` | Cross-shell prompt |
| wezterm | `config/wezterm/` | Terminal emulator (macOS) |
| claude | `config/claude/` | Claude Code status line, tmux hook scripts |
| pi | `config/pi/` | Pi coding agent extensions |

## Dependencies

| Tool | macOS | Ubuntu |
|------|-------|--------|
| starship, tmux, neovim, zoxide, pyenv, uv | `brew` | apt + official installers |
| nvm | official install script | official install script |
| wezterm | `brew --cask` | not auto-installed — install separately if needed |

Pyenv is kept alongside uv to provide a system-wide `python` for tools that expect it on `$PATH`.

## Layout

```
bootstrap.sh                  # OS detection + entrypoint
scripts/
  Brewfile                    # Homebrew bundle (macOS packages/casks/taps)
  install-deps-macos.sh       # brew + nvm
  install-deps-ubuntu.sh      # apt + GitHub releases + installers
  install-symlinks.sh         # symlink-only (idempotent)
  install-claude.sh           # merges Claude Code config keys into ~/.claude/settings.json
  install-pi.sh               # installs pi coding agent (npm) + pi packages
config/                       # → ~/.config/
  bash/                       # bashrc, aliases, functions, OS locals
  nvim/                       # LazyVim neovim config
  tmux/                       # tmux config + vendored plugins
  wezterm/                    # WezTerm lua config
  starship.toml               # Starship prompt
  claude/                     # Claude Code integration scripts
  pi/                         # Pi coding agent extensions
_bashrc, _inputrc, _tmux.conf # → ~/.bashrc etc. (underscore becomes dot)
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

Reload configs without restarting:

| Config | Reload command |
|--------|---------------|
| bash | `source ~/.bashrc` |
| tmux | `tmux source ~/.tmux.conf` |
| neovim plugins | `:Lazy sync` inside nvim |
| starship | automatic on next prompt |
| wezterm | automatic (hot reload enabled) |

## Claude Code integration

`config/claude/` contains three scripts wired into Claude Code's hook system:

- **`statusline-command.sh`** — renders a catppuccin mocha status line showing the current directory, git branch, active model, and context usage percentage.
- **`tmux-claude-state.sh`** — drives the tmux window pill color based on Claude's state: green while running (`PreToolUse`/`PostToolUse`), red when waiting for permission (`PermissionRequest`), gray when idle (`Stop`).
- **`tmux-window-name.sh`** — renames the tmux window to the basename of Claude's working directory on `SessionStart`.

Apply Claude settings (merges `theme`, `statusLine`, and `hooks` keys into `~/.claude/settings.json`):

```bash
bash ~/.dotfiles/scripts/install-claude.sh
```

## Pi coding agent

`config/pi/extensions/` contains two extensions:

- **`catppuccin-footer.ts`** — footer extension matching the catppuccin mocha pill style used in the Claude status line.
- **`tmux-window-name.ts`** — renames the tmux window to the working directory basename on session start.

Install pi and its packages:

```bash
bash ~/.dotfiles/scripts/install-pi.sh
```

## Secrets

Secrets live in the macOS Keychain and are loaded at shell startup via `set_secret_env` in `config/bash/locals/macos.sh`:

```bash
security add-generic-password -a "$USER" -s "SLACK_TOKEN" -w "xoxb-..."
```

Missing keychain entries are skipped with a warning rather than exporting empty values.

## Notes

- `_gitconfig` is intentionally gitignored. Add your own at `~/.dotfiles/_gitconfig` after cloning and re-run `install-symlinks.sh`.
- On Apple Silicon, brew lives at `/opt/homebrew`. On Intel Macs, `/usr/local`. The bashrc handles both.
