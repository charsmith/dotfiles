#!/usr/bin/env bash
# Patch @aliou/pi-guardrails migration 005 to not destroy { kind, path }
# objects produced by migration 010.
#
# Bug: migration 005's shouldRun predicate fires on any non-string item in
# allowedPaths. After migration 010 runs (strings -> { kind, path } objects),
# 005 sees non-strings, fires, tries to extract a missing "pattern" field, and
# writes back an empty array — wiping all allowed paths on every startup.
#
# Fix: skip items already in { kind, path } format (same treatment the author
# applied to migration 009 in the same commit that introduced the bug).
#
# Remove this script once @aliou/pi-guardrails ships a fix upstream:
# https://github.com/aliou/pi-guardrails/commit/e012ea011621681dbcbbf669544d7aae924a3c90
#
# Usage: bash scripts/patch-guardrails.sh

set -euo pipefail

MIGRATION="$HOME/.config/pi/npm/node_modules/@aliou/pi-guardrails/src/shared/config/migration/005-normalize-allowed-paths.ts"

if [[ ! -f "$MIGRATION" ]]; then
  echo "Error: migration file not found: $MIGRATION" >&2
  exit 1
fi

if grep -q 'obj.kind === "file"' "$MIGRATION"; then
  echo "Already patched, nothing to do."
  exit 0
fi

python3 - "$MIGRATION" <<'PYEOF'
import sys

path = sys.argv[1]
with open(path) as f:
    src = f.read()

old = '''export function shouldRun(config: GuardrailsConfig): boolean {
  const raw = config as Record<string, unknown>;
  const pathAccess = raw.pathAccess as Record<string, unknown> | undefined;
  if (!Array.isArray(pathAccess?.allowedPaths)) return false;
  return pathAccess.allowedPaths.some((item) => typeof item !== "string");
}'''

new = '''export function shouldRun(config: GuardrailsConfig): boolean {
  const raw = config as Record<string, unknown>;
  const pathAccess = raw.pathAccess as Record<string, unknown> | undefined;
  if (!Array.isArray(pathAccess?.allowedPaths)) return false;
  return pathAccess.allowedPaths.some((item) => {
    if (typeof item === "string") return false;
    if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      // Already in { kind, path } format (produced by migration 010) — do not re-migrate.
      if (
        typeof obj.path === "string" &&
        (obj.kind === "file" || obj.kind === "directory")
      ) {
        return false;
      }
    }
    return true;
  });
}'''

if old not in src:
    print(f"Error: expected pattern not found in {path} — package may have changed, patch manually.", file=sys.stderr)
    sys.exit(1)

with open(path, "w") as f:
    f.write(src.replace(old, new, 1))

print(f"Patched: {path}")
PYEOF
