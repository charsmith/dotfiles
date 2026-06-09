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
| `scripts/Brewfile` | Homebrew bundle — declarative list of all macOS packages/casks/taps. |
| `scripts/install-deps-macos.sh` | Homebrew + nvm (via official installer). |
| `scripts/install-deps-ubuntu.sh` | apt for system pkgs + pyenv build deps; GitHub release tarball for neovim (to `/opt/nvim-linux64`); official installers for starship, zoxide, pyenv, nvm. |
| `scripts/install-symlinks.sh` | Symlinks only — no package installs. Uses `TARGET_HOME` env var (defaults to `$HOME`) so it can be dry-tested. |
| `scripts/install-claude.sh` | Merges dotfiles-managed keys (`theme`, `statusLine`, `hooks`) into `~/.claude/settings.json`. Idempotent; skips silently if Claude Code or `jq` is absent. |
| `scripts/install-pi.sh` | Installs pi coding agent (global npm) and pi packages (`@aliou/pi-guardrails`). Run manually — not wired into bootstrap by default. |

## Symlink Conventions

- `config/<name>/` → symlinked as `~/.config/<name>`
- `_<name>` in repo root → symlinked as `~/.<name>` (underscore becomes dot)
- `scripts/install-symlinks.sh` skips already-symlinked targets; backs up existing files to `<file>.bak`

## Config Structure

| Path | Purpose |
|------|---------|
| `config/bash/bashrc` | Main bash config — sources functions, aliases, locals |
| `config/bash/bash_aliases` | Shell aliases (`vi=nvim`, `cd=z`, ls variants) |
| `config/bash/bash_functions` | Bash utility functions (`mkcd`, `extract`, `gho`, `notify`) |
| `config/bash/locals/macos.sh` | macOS-specific env (reads secrets from macOS Keychain) |
| `config/bash/locals/linux.sh` | Linux-specific env |
| `config/bash/locals/windows.sh` | Windows (Git Bash / MSYS2) env |
| `config/nvim/` | Neovim config (LazyVim-based) |
| `config/tmux/tmux.conf` | Tmux config (tpm + catppuccin mocha theme) |
| `config/tmux/plugins/` | Vendored tmux plugins (tpm, catppuccin, vim-tmux-navigator) |
| `config/starship.toml` | Starship prompt config |
| `config/wezterm/wezterm.lua` | WezTerm terminal config |
| `config/claude/statusline-command.sh` | Claude Code status line renderer (catppuccin mocha, shows dir/git/model/ctx%) |
| `config/claude/tmux-claude-state.sh` | Drives tmux window pill color based on Claude hook events (running/waiting/inactive) |
| `config/claude/tmux-window-name.sh` | Renames the tmux window to the Claude session's working directory basename (fired by `SessionStart` hook) |
| `config/pi/extensions/catppuccin-footer.ts` | Pi footer extension — same catppuccin mocha pill style as the Claude status line |
| `config/pi/extensions/tmux-window-name.ts` | Pi extension — renames tmux window to basename of the working directory on session start |
| `config/pi/extensions/tmux-pi-state.ts` | Pi extension — drives tmux window pill green while pi is running, reverts to gray on idle/shutdown |
| `_bash_profile` | `~/.bash_profile` — delegates to `~/.bashrc` for login shells |
| `_bashrc` | `~/.bashrc` entry point — sources `~/.config/bash/bashrc` |
| `_inputrc` | Readline config |
| `_tmux.conf` | `~/.tmux.conf` entry point |

## Neovim Setup

Built on [LazyVim](https://www.lazyvim.org/). Entry: `config/nvim/init.lua` loads `config.options` then `config.lazy`. Plugin specs live in `config/nvim/lua/plugins/`. `lazy-lock.json` pins plugin versions.

Key plugins: catppuccin theme, telescope, neo-tree, lualine, noice, treesitter, nvim-tmux-navigator, completion stack.

To update all plugins and refresh the lockfile, run `:Lazy sync` inside Neovim. Commit the resulting `lazy-lock.json` change as a separate `chore(nvim)` commit.

## Reloading Configs

After editing a config, apply changes without restarting:

| Config | Reload command |
|--------|---------------|
| bash | `source ~/.bashrc` |
| tmux | `tmux source ~/.tmux.conf` |
| neovim plugins | `:Lazy sync` inside nvim |
| starship | automatic on next prompt |
| wezterm | automatic (hot reload enabled) |

## `notify()` Function

`config/bash/bash_functions` defines a `notify` function that sends WezTerm toast notifications, routing through tmux when inside a tmux session. Use it for long-running commands:

```bash
sleep 10 && notify "Build done"
```

## Claude Hook Wiring (`config/claude/`)

`tmux-claude-state.sh` drives the tmux window pill color based on Claude's state. Hook event notes learned from testing:

- `Notification` fires for the "task complete" OS notification — **not** for permission prompts. Do not use it for the waiting/red state.
- `PermissionRequest` fires specifically when Claude needs tool approval — use this for waiting (red).
- `Stop` fires reliably when Claude finishes a turn — use for inactive (gray).
- `PreToolUse` / `PostToolUse` fire around every tool call — use for running (green).

When iterating on hook behavior, **test live before committing** — hook event semantics are easy to get wrong and each wrong guess produces a noisy tweak commit.

**Never commit or push changes in this repo until the user explicitly says they are satisfied.**

## Commit Scopes

Use these scopes consistently when committing changes to this repo:

`nvim`, `bash`, `tmux`, `wezterm`, `starship`, `claude`, `scripts`, `bootstrap`, `notifications`

## Secrets (macOS)

Secrets are stored in macOS Keychain and loaded via `set_secret_env` in `config/bash/locals/macos.sh`:
```bash
security add-generic-password -a $USER -s "SECRET_NAME" -w "value"
```
The function exports the value as an env var at shell startup. Do not hardcode secrets in any config file.

## Adding a New Config

1. Add files under `config/<tool>/`
2. Re-run `bash scripts/install-symlinks.sh` to create the symlink at `~/.config/<tool>`
3. For a dotfile in `~/`, add `_<name>` to the repo root and re-run the symlink script
4. Add a row to the Config Structure table above
