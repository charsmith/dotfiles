/**
 * guardrails-block — set guardrails to auto-block mode for this session.
 *
 * Loaded by team agents (via -e) so they never pause waiting for a human
 * to approve a permission prompt. Uses the guardrails configLoader's
 * in-memory scope — no files written, no global config changed.
 *
 * The import path hits the same module-cache entry as the guardrails plugin
 * itself (same resolved path), so the memory override is visible to the
 * path-access and permission-gate extensions in the same process.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Absolute path to the guardrails configLoader singleton.
// Must match what the guardrails npm package resolves to so Node's module
// cache returns the same instance that path-access/permission-gate use.
const LOADER_PATH =
  "/Users/charsmith/.config/pi/npm/node_modules/@aliou/pi-guardrails/src/shared/config/index.ts";

export default async function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    try {
      const { configLoader } = await import(LOADER_PATH) as any;
      await configLoader.save("memory", {
        pathAccess: { mode: "block" },
        permissionGate: { requireConfirmation: false },
      });
    } catch (err) {
      // Don't crash the session — just means the guardrails package moved or
      // isn't installed. Team member will still work, just may pause on prompts.
      console.error("[guardrails-block] could not set block mode:", err);
    }
  });
}
