#!/usr/bin/env bash
# Install pi coding agent and its packages.
# Run manually on each machine — not wired into bootstrap by default.
#
# Usage: bash scripts/install-pi.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Install pi CLI (global npm)
# ---------------------------------------------------------------------------
if command -v pi &>/dev/null; then
  echo "pi already installed ($(pi --version 2>/dev/null || echo 'unknown version')), skipping."
else
  echo "Installing pi coding agent..."
  npm install -g @earendil-works/pi-coding-agent
fi

# ---------------------------------------------------------------------------
# 2. Point pi at the dotfiles-managed config dir
# ---------------------------------------------------------------------------
export PI_CODING_AGENT_DIR="$HOME/.config/pi"

# ---------------------------------------------------------------------------
# 3. Install packages listed here
# ---------------------------------------------------------------------------
packages=(
  npm:@aliou/pi-guardrails
)

for pkg in "${packages[@]}"; do
  echo "Installing pi package: $pkg"
  pi install "$pkg"
done

echo "Done."
