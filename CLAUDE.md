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
| `config/pi/extensions/coms-bus.ts` | Pi extension — peer-to-peer messaging bus so an orchestrator can build a *team* (one expert per tool + an architect) and ask/answer questions across it. Tools `coms_list`/`coms_send`/`coms_broadcast`/`coms_poll`/`coms_shutdown` (remote teardown via a `kind:"control"` message → receiver calls `ctx.shutdown()`); commands `/coms`, `/coms-join` (runtime join, no restart), `/coms-leave`. Async-first (replies arrive as follow-ups; `wait:true` blocks) to avoid orchestrator↔expert deadlock. File-IPC under `~/.pi/coms-bus/` (registry + per-message inbox files; each agent watches only its own inbox). Dormant by default (global ext auto-loads everywhere); activates only on `--coms`/`--cname`/`--project`/`--explicit` or `PI_COMS_CNAME`/`PI_COMS_PROJECT`. Identity via `--cname`/`--purpose`/`--project`. Separate from tmux-subagent so the spawn layer can go headless. Redis-via-podman is the planned substrate upgrade. Architecture in `coms-bus.md` |
| `config/pi/extensions/pi-chain.ts` | Pi extension — `run_chain` tool runs a declared chain of agents (`~/.config/pi/agents/agent-chain.yaml`, `kind: chain`) as a deterministic pipe: each step's output feeds the next as `$INPUT` (`$ORIGINAL` = original input). A chain is always a live team with two orthogonal axes — `persist` (chain: `false` default = one-shot, tear agents down after the answer; `true` = keep the team warm for the next `run_chain`) and `clearContext` (chain + per-step override: `true` default = fresh ephemeral spawn per topic; `false` = persistent agent reused across topics, accumulating context). Persistent steps stay alive and are fed successive topics via the `agent-spawn` inbox; per-topic completion is detected by the state file's monotonic `seq` counter (set in `lib/agent-spawn.ts` on each `agent_end`). Steps reference an `agent:` def (full persona/tools/skills) or inline `system_prompt`, with optional per-step `model`. Flow widget above the editor auto-dismisses 10s after a terminal state (`/chain-show` re-displays). Commands `/chain` (set active), `/chain-list`, `/chain-show`, `/chain-reset`, `/chain-down` (shut down a warm team). Reuses the tmux-subagent spawn/IPC layer — no coms-bus involvement. Architecture in `pi-chain.md` |
| `config/pi/extensions/tmux-subagent.ts` | Pi extension — `launch_agent`/`agent_reply` tools spawn pi subagents in tmux windows (blocking, background, or `team` = persistent coms-bus member). `team:"<project>"` + `system_prompt:"..."` (inline persona) launches a persistent teammate that auto-joins the bus (via `PI_COMS_PROJECT`/`PI_COMS_CNAME` env) and stays alive to answer coms messages — `task` is a plain warm-up. File-based IPC via `$TMPDIR/pi-agent-*` state/inbox files; windows tracked by stable pane id; per-agent widget card. Guardrails prompts surface as an inline parent dialog (Allow/Deny driven by `tmux send-keys`) or can be answered in the child window. Architecture documented in `tmux-subagent.md` |
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

`nvim`, `bash`, `tmux`, `wezterm`, `starship`, `claude`, `pi`, `scripts`, `bootstrap`, `notifications`

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
