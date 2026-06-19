#!/usr/bin/env bash
# Patch @aliou/pi-guardrails to auto-block permission prompts in subagent
# sessions (PI_SUBAGENT=1) instead of pausing and waiting for human input.
#
# Team agents run headless from the main thread's perspective — a guardrails
# prompt would hang them forever. We treat PI_SUBAGENT the same as !ctx.hasUI
# (the existing non-interactive block path) in both path-access and
# permission-gate extensions.
#
# Remove this script if @aliou/pi-guardrails adds native subagent/non-interactive
# support and ships it upstream.
#
# Usage: bash scripts/patch-guardrails-subagent-block.sh

set -euo pipefail

BASE="$HOME/.config/pi/npm/node_modules/@aliou/pi-guardrails/extensions"
PATH_ACCESS="$BASE/path-access/index.ts"
PERM_GATE="$BASE/permission-gate/index.ts"

# ── path-access ──────────────────────────────────────────────────────────────

if [[ ! -f "$PATH_ACCESS" ]]; then
  echo "Error: file not found: $PATH_ACCESS" >&2
  exit 1
fi

if grep -q 'process.env.PI_SUBAGENT' "$PATH_ACCESS"; then
  echo "path-access: already patched."
else
  python3 - "$PATH_ACCESS" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()

old = 'if (config.pathAccess.mode === "block" || !ctx.hasUI) {'
new = 'if (config.pathAccess.mode === "block" || !ctx.hasUI || process.env.PI_SUBAGENT) {'

if old not in src:
    print(f"Error: expected pattern not found in {path}", file=sys.stderr)
    sys.exit(1)

with open(path, "w") as f:
    f.write(src.replace(old, new, 1))
print(f"Patched: {path}")
PYEOF
fi

# ── permission-gate ───────────────────────────────────────────────────────────

if [[ ! -f "$PERM_GATE" ]]; then
  echo "Error: file not found: $PERM_GATE" >&2
  exit 1
fi

if grep -q 'process.env.PI_SUBAGENT' "$PERM_GATE"; then
  echo "permission-gate: already patched."
else
  python3 - "$PERM_GATE" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()

old = '    if (!ctx.hasUI) {\n      const reason = `Dangerous command blocked (no UI to confirm): ${safety.reason}`'
new = '    if (!ctx.hasUI || process.env.PI_SUBAGENT) {\n      const reason = `Dangerous command blocked (no UI to confirm): ${safety.reason}`'

if old not in src:
    print(f"Error: expected pattern not found in {path}", file=sys.stderr)
    sys.exit(1)

with open(path, "w") as f:
    f.write(src.replace(old, new, 1))
print(f"Patched: {path}")
PYEOF
fi

echo "Done."
