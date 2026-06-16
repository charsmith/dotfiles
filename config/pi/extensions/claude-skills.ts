/**
 * claude-skills — expose Claude Code skill directories to pi.
 *
 * Adds two skill search paths on every session start / reload:
 *   1. ~/.claude/skills  (global Claude skills)
 *   2. <cwd>/.claude/skills  (project-local Claude skills)
 *
 * Paths that don't exist are silently skipped by pi's skill discovery.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async (event, _ctx) => {
    const home = process.env.HOME ?? "";
    const candidates = [
      join(home, ".claude", "skills"),
      join(event.cwd, ".claude", "skills"),
    ];

    const skillPaths = candidates.filter(existsSync);
    return { skillPaths };
  });
}
