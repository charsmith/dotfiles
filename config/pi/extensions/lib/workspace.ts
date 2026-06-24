/**
 * workspace — resolves the pi_agents workspace and handles auto-commits.
 *
 * Config: ~/.config/pi/agent-workspace.json
 *   { "workspace": "~/code/hacking/pi_agents", "autoCommit": true }
 *
 * When autoCommit is true, every agent_author / charter_author write
 * triggers a git commit in the workspace repo with a conventional-commit
 * message derived entirely from the file path and operation — no LLM.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CONFIG_PATH = path.join(os.homedir(), ".config", "pi", "agent-workspace.json");

export interface WorkspaceConfig {
  workspace: string;   // absolute resolved path
  autoCommit: boolean;
}

// Re-read on every call so /reload picks up config changes without restart.
export function getWorkspace(): WorkspaceConfig | null {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (!raw.workspace) return null;
    const workspace = (raw.workspace as string).replace(/^~/, os.homedir());
    return { workspace, autoCommit: raw.autoCommit !== false };
  } catch {
    return null;
  }
}

// Convenience dir accessors — return null if no workspace configured.
export function workspaceAgentDir(): string | null {
  const ws = getWorkspace();
  return ws ? path.join(ws.workspace, "agents") : null;
}

export function workspaceCharterDir(): string | null {
  const ws = getWorkspace();
  return ws ? path.join(ws.workspace, "charters") : null;
}

export function workspaceSkillsDir(): string | null {
  const ws = getWorkspace();
  return ws ? path.join(ws.workspace, "skills") : null;
}

// ─── Commit ───────────────────────────────────────────────────────────────────

export interface CommitResult {
  committed: boolean;
  message?: string;
  hash?: string;
  skipped?: boolean;  // nothing staged after add -A
  error?: string;
}

/**
 * Stage all workspace changes and commit with a derived conventional-commit message.
 *
 * @param relPath  Path relative to workspace root, e.g. "agents/my-agent.md"
 * @param isNew    true = file was created (feat), false = file was updated (fix)
 */
export function commitWorkspaceFile(relPath: string, isNew: boolean): CommitResult {
  const ws = getWorkspace();
  if (!ws) return { committed: false, error: "no agent-workspace.json configured" };
  if (!ws.autoCommit) return { committed: false, skipped: true };

  const repo = ws.workspace;
  if (!existsSync(path.join(repo, ".git"))) {
    return { committed: false, error: `${repo} is not a git repository` };
  }

  try {
    execSync(`git -C ${JSON.stringify(repo)} add -A`, { stdio: "pipe" });

    const staged = execSync(
      `git -C ${JSON.stringify(repo)} diff --cached --name-only`,
      { stdio: "pipe" },
    ).toString().trim();

    if (!staged) return { committed: false, skipped: true };

    const message = buildMessage(relPath, isNew);
    execSync(
      `git -C ${JSON.stringify(repo)} commit -m ${JSON.stringify(message)}`,
      { stdio: "pipe" },
    );

    const hash = execSync(
      `git -C ${JSON.stringify(repo)} rev-parse --short HEAD`,
      { stdio: "pipe" },
    ).toString().trim();

    return { committed: true, message, hash };
  } catch (e: any) {
    const detail = (e?.stderr?.toString?.() ?? e?.message ?? "").trim();
    return { committed: false, error: detail || "git error" };
  }
}

// ─── Message generation (pure code, no LLM) ──────────────────────────────────

function buildMessage(relPath: string, isNew: boolean): string {
  const norm    = relPath.replace(/\\/g, "/");
  const parts   = norm.split("/");
  const scope   = parts[0];                                   // agents | charters | skills
  const rawName = parts[parts.length - 1];
  const name    = rawName.replace(/\.(md|ya?ml)$/, "");      // strip extension
  const verb    = isNew ? "feat" : "fix";
  const action  = isNew ? "add" : "update";
  return `${verb}(${scope}): ${action} ${name}`;
}
