#!/usr/bin/env bash
# Merge dotfiles-managed Claude Code settings into ~/.claude/settings.json.
# Idempotent — safe to re-run. Only touches keys this dotfiles repo owns:
#   statusLine, hooks.SessionStart
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
  "statusLine": {
    "type": "command",
    "command": "bash ~/.config/claude/statusline-command.sh"
  },
  "hooks": {
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

# Deep-merge: existing wins on scalar conflicts, our keys set where absent or override
# For hooks.SessionStart we own the whole array, so * replaces it cleanly.
merged="$(echo "$existing" | jq --argjson owned "$owned" '. * $owned')"

# Write atomically
tmp="$(mktemp)"
echo "$merged" > "$tmp"
mv "$tmp" "$SETTINGS"

echo "install-claude: ~/.claude/settings.json updated."
