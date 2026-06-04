#!/usr/bin/env bash
# Merge dotfiles-managed Claude Code settings into ~/.claude/settings.json.
# Idempotent — safe to re-run. Only touches keys this dotfiles repo owns:
#   statusLine, theme, hooks.SessionStart, hooks.PreToolUse, hooks.PostToolUse,
#   hooks.PermissionRequest, hooks.Stop, hooks.UserPromptSubmit, hooks.SessionEnd
# All other keys (apiKeyHelper, env, etc.) are left untouched.

set -euo pipefail

SETTINGS="$HOME/.claude/settings.json"

if ! command -v jq &>/dev/null; then
  echo "install-claude: jq not found, skipping Claude settings install."
  exit 0
fi

if [[ ! -d "$HOME/.claude" ]]; then
  echo "install-claude: ~/.claude not found (Claude Code not installed?), skipping."
  exit 0
fi

# Start from existing settings or an empty object
existing="{}"
if [[ -f "$SETTINGS" ]]; then
  existing="$(cat "$SETTINGS")"
fi

owned=$(cat <<'EOF'
{
  "theme": "dark",
  "statusLine": {
    "type": "command",
    "command": "bash ~/.config/claude/statusline-command.sh"
  },
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.config/claude/tmux-claude-state.sh $(jq -r 'if .tool_name == \"AskUserQuestion\" then \"waiting\" else \"running\" end')"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.config/claude/tmux-claude-state.sh running"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.config/claude/tmux-claude-state.sh waiting"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.config/claude/tmux-claude-state.sh inactive"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.config/claude/tmux-claude-state.sh running"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.config/claude/tmux-claude-state.sh inactive"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.config/claude/tmux-window-name.sh"
          }
        ]
      }
    ]
  }
}
EOF
)

# Merge statusLine (safe scalar replace) and append each hook entry only if
# our exact command isn't already present (idempotent, preserves user hooks).
merged="$(echo "$existing" | jq --argjson owned "$owned" '
  .theme = $owned.theme |
  .statusLine = $owned.statusLine |
  reduce ($owned.hooks | to_entries[]) as $e (
    .;
    if (.hooks[$e.key] // [] | map(.hooks[].command) | index($e.value[0].hooks[0].command)) != null
    then .
    else .hooks[$e.key] = ((.hooks[$e.key] // []) + $e.value)
    end
  )
')"

# Write atomically
tmp="$(mktemp)"
echo "$merged" > "$tmp"
mv "$tmp" "$SETTINGS"

echo "install-claude: ~/.claude/settings.json updated."
