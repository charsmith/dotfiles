/**
 * agent-spawn — shared "one link" primitive for spawning a pi agent in a tmux
 * window with file-based IPC.
 *
 * This is the substrate both `tmux-subagent.ts` (the launch_agent/agent_reply
 * tools) and `pi-chain.ts` (the sequential chain orchestrator) build on, so the
 * spawn mechanics and the IPC contract live in exactly one place and never
 * drift. It owns:
 *   - agent-definition loading (~/.config/pi/agents/<name>.md) + skill resolution
 *   - the shared status/usage/state types
 *   - token/elapsed/usage formatting + the compact model label
 *   - tmux helpers (session, pane→window, pane liveness, send-keys)
 *   - the generated child extension source (the IPC bridge that runs in the
 *     child pi process) — see buildChildExtensionSource
 *   - spawnAgentWindow(): write the IPC files, open the tmux window, return a
 *     handle the caller tracks
 *
 * It deliberately does NOT own widgets, guardrails approval UI, or lifecycle
 * tracking — those stay in the caller (tmux-subagent's AgentEntry map, or
 * pi-chain's step loop). See tmux-subagent.md for the full architecture and the
 * gotchas behind several of these pieces.
 *
 * IPC files ({tmpBase} = $TMPDIR/pi-agent-<timestamp>):
 *   {tmpBase}.ts          parent → child   generated child extension (pi -e)
 *   {tmpBase}.state.json  child → parent   {status, output?, reason?, prompt?, model?, usage?}
 *   {tmpBase}.inbox.txt   parent → child   plain text the child injects as a message
 *
 * NOTE: os.tmpdir() on macOS is $TMPDIR (/var/folders/.../T), NOT /tmp.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Agent definition loader ────────────────────────────────────────────────

export interface AgentDef {
  name: string;
  description: string;
  tools: string;        // comma-separated tool list, or "" for default
  skills: string;       // comma-separated skill names, "*" for all globals, or "" for none
  spawnAgents: boolean; // whether this agent can launch further subagents
  systemPrompt: string;
}

// Skill search dirs — same locations pi discovers globally
const SKILL_DIRS = [
  path.join(os.homedir(), ".config", "pi", "skills"),
  path.join(os.homedir(), ".pi", "agent", "skills"),
];

export function resolveSkillPath(skillName: string): string | null {
  for (const dir of SKILL_DIRS) {
    const p = path.join(dir, skillName);
    if (existsSync(path.join(p, "SKILL.md"))) return p;
    // Also allow bare .md skills
    const md = path.join(dir, `${skillName}.md`);
    if (existsSync(md)) return md;
  }
  return null;
}

export function loadAgentDef(agentName: string): AgentDef | null {
  const searchDirs = [
    path.join(os.homedir(), ".config", "pi", "agents"),
    path.join(os.homedir(), ".pi", "agents"),
  ];
  for (const dir of searchDirs) {
    const filePath = path.join(dir, `${agentName}.md`);
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf-8");
      // \r?\n so frontmatter parses regardless of LF / CRLF line endings.
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!match) continue;
      // Strip a single pair of surrounding quotes — the docs show quoted forms
      // (skills: "*", skills: "og,cy") and unstripped quotes silently break the
      // skills/tools parsing downstream.
      const stripQuotes = (v: string) => v.replace(/^["']|["']$/g, "").trim();
      const frontmatter: Record<string, string> = {};
      for (const line of match[1].split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx > 0) frontmatter[line.slice(0, idx).trim()] = stripQuotes(line.slice(idx + 1).trim());
      }
      if (!frontmatter.name) continue;
      return {
        name: frontmatter.name,
        description: frontmatter.description || "",
        tools: frontmatter.tools || "",
        skills: frontmatter.skills?.trim() || "",
        spawnAgents: frontmatter.spawn_agents?.trim() === "true",
        systemPrompt: match[2].trim(),
      };
    } catch { continue; }
  }
  return null;
}

// ─── Shared state / usage types ──────────────────────────────────────────────

export type AgentStatus = "running" | "idle" | "stopped" | "completed" | "done" | "error";

export interface AgentUsage {
  turns: number;
  input: number;
  output: number;
  cost: number;
  elapsedMs: number;
}

export interface AgentPrompt {
  kind?: string;       // guardrails prompt kind ("confirmation" | "permission")
  toolName?: string;   // tool the subagent was trying to run
  path?: string;       // target path (path-access prompts)
  reason?: string;     // human-readable reason
}

export interface AgentState {
  status: AgentStatus;
  output?: string;
  reason?: string;   // guardrails stop reason
  prompt?: AgentPrompt;
  model?: string;
  usage?: AgentUsage;
  seq?: number;      // monotonic completion counter (incremented each agent_end)
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function fmtUsage(u: AgentUsage): string {
  const parts: string[] = [];
  if (u.turns)  parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
  if (u.input)  parts.push(`↑${fmtTokens(u.input)}`);
  if (u.output) parts.push(`↓${fmtTokens(u.output)}`);
  if (u.cost)   parts.push(`$${u.cost.toFixed(3)}`);
  parts.push(fmtElapsed(u.elapsedMs));
  return parts.join("  ");
}

// Return a compact display label for a model string like
// "anthropic/claude-opus-4-5". Strips the provider prefix, then strips
// well-known model-family prefixes ("claude-", "gemini-", "gpt-") so we just
// see "opus-4-5", "2.0-flash", etc.
export function shortModelName(modelStr: string): string {
  const slash = modelStr.indexOf("/");
  let id = slash >= 0 ? modelStr.slice(slash + 1) : modelStr;
  for (const prefix of ["claude-", "gemini-", "gpt-"]) {
    if (id.startsWith(prefix)) { id = id.slice(prefix.length); break; }
  }
  return id;
}

// ─── tmux helpers ────────────────────────────────────────────────────────────

export function currentTmuxSession(): string | null {
  if (!process.env.TMUX) return null;
  try {
    return execSync("tmux display-message -p '#S'", {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

// Resolve the *current* session:window_index for a pane id. Window indices
// shift as windows open/close (esp. with renumber-windows), so the pane id
// (%N) is the only stable handle — always re-resolve from it.
export function windowForPane(paneId: string): string | null {
  if (!paneId) return null;
  try {
    return execSync(
      `tmux display-message -p -t ${paneId} '#{session_name}:#{window_index}'`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim() || null;
  } catch { return null; }
}

export function isPaneAlive(paneId: string): boolean {
  try {
    const out = execSync('tmux list-panes -a -F "#{pane_id} #{pane_dead}"', {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.trim().split("\n")) {
      const [id, dead] = line.trim().split(" ");
      if (id === paneId) return dead !== "1";
    }
    return false; // not found = gone
  } catch { return false; }
}

export function sendKeysToPane(paneId: string, key: string): void {
  if (!paneId) return;
  try { execSync(`tmux send-keys -t ${paneId} ${key}`, { stdio: "ignore" }); } catch {}
}

// Sanitize a free-form agent label into a tmux-window-safe / coms-cname-safe
// token. Used for both the window name (pi:<name>) and the coms cname so they
// always agree.
export function sanitizeAgentName(name: string): string {
  return (
    name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 20) || "agent"
  );
}

// ─── Child extension source (the IPC bridge running in the child pi) ─────────
//
// This is the heart of the IPC contract. The generated extension runs in the
// child pi process and:
//   1. session_start → send the initial task, write "running"
//   2. turn_start    → write "running" (clears any transient "stopped")
//   3. turn_end      → write "running" + live usage (keeps the parent card fresh)
//   4. guardrails:action:prompted → write transient "stopped" + prompt context
//   5. agent_end     → write "done"(+output,usage)  [persistent: "running"]
//   6. poll inbox.txt every 1s → inject parent messages via sendUserMessage(steer)
//
// PERSISTENT (team) members never write "done" — they stay alive to keep
// servicing coms messages; the parent finishes them only when the pane dies.
// An optional persona (inline system_prompt or an agent def's body) is injected
// via a before_agent_start hook spliced in before the final brace.

export function buildChildExtensionSource(opts: {
  task: string;
  stateFile: string;
  inboxFile: string;
  persistent: boolean;
  personaPrompt?: string;
}): string {
  const { task, stateFile, inboxFile, persistent, personaPrompt } = opts;

  let source = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
export default function (pi: ExtensionAPI) {
  let fired = false;
  // PERSISTENT (team) members never write "done" — they stay alive to keep
  // servicing coms messages; the parent finishes them only when the pane dies.
  const PERSISTENT = ${persistent ? "true" : "false"};
  // Monotonic completion counter: bumped on every agent_end. A persistent member
  // stays in status "running", so a chain orchestrator that feeds it successive
  // topics watches "seq" advance to detect each per-topic completion.
  let seq = 0;
  const startedAt = Date.now();
  let modelId = "";
  let contextTokens = 0, totalOutput = 0, totalCost = 0, totalTurns = 0;
  let sessionCtx: any = null;

  // extFile cleaned up by parent (pi watches -e files; self-deletion unloads the extension)

  const writeState = (data: object) => {
    try { writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(data), "utf-8"); } catch {}
  };

  pi.on("model_select", (event) => {
    modelId = event.model.id;
  });

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    if (fired) return;
    fired = true;
    writeState({ status: "running" });
    pi.sendUserMessage(${JSON.stringify(task)});
  });

  // Each turn starting means the run is active (e.g. resuming after the human
  // cleared a guardrails prompt) — clear any transient "stopped" state.
  pi.on("turn_start", () => {
    writeState({ status: "running", model: modelId || undefined });
  });

  // After each turn, snapshot the live context-window size (same source as the
  // footer status bar) and accumulate output tokens + cost. Written to the state
  // file so the parent widget card shows live counters while the agent runs.
  pi.on("turn_end", (event) => {
    const m = (event as any).message;
    // Snapshot — not a running sum. getContextUsage().tokens computes
    // totalTokens || (input + output + cacheRead + cacheWrite), matching the footer.
    contextTokens  = sessionCtx?.getContextUsage()?.tokens ?? 0;
    totalOutput   += m?.usage?.output      ?? 0;
    totalCost     += m?.usage?.cost?.total ?? 0;
    if (!modelId && m?.model) modelId = m.model;
    totalTurns++;
    writeState({
      status: "running",
      model: modelId || undefined,
      usage: { turns: totalTurns, input: contextTokens, output: totalOutput, cost: totalCost, elapsedMs: Date.now() - startedAt },
    });
  });

  // Guardrails is showing a permission prompt (ask mode) — the agent run is
  // paused waiting for the human to respond in this window. Write a transient
  // "stopped" state purely so the parent can flag it / notify. The next
  // agent_end (after the human responds, here or in-window) overwrites it with
  // "done", so resolving the prompt directly in the window works correctly.
  pi.events.on("guardrails:action:prompted", (payload: any) => {
    const reason = payload?.reason ?? "guardrails needs permission";
    writeState({
      status: "stopped",
      reason: "Guardrails needs permission: " + reason,
      prompt: {
        kind: payload?.prompt?.kind,
        toolName: payload?.context?.toolName,
        path: payload?.action?.path ?? payload?.action?.displayPath,
        reason: reason,
      },
      model: modelId || undefined,
    });
  });

  // Agent run finished — always write "done" with output + usage. agent_end
  // fires once the whole run completes (after any guardrails pause the human
  // already cleared), so it is the authoritative "task is over" signal.
  pi.on("agent_end", (event, ctx) => {
    // Reuse the accumulators from turn_end — consistent with the live widget stats.
    // Take a final getContextUsage() snapshot for input (same as the footer).
    const input = ctx.getContextUsage()?.tokens ?? contextTokens;
    let finalOutput = "";
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i];
      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type === "text" && part.text) { finalOutput = part.text; break; }
        }
        if (finalOutput) break;
      }
    }

    writeState({
      status: PERSISTENT ? "idle" : "done",
      output: finalOutput || "(no output)",
      model: modelId || undefined,
      usage: { turns: totalTurns, input, output: totalOutput, cost: totalCost, elapsedMs: Date.now() - startedAt },
      seq: ++seq,
    });
  });

  // Poll inbox.txt for messages from the parent thread (agent_reply / background
  // follow-ups). Injecting a message starts a fresh run → another agent_end →
  // another "done" write, so the parent stays in sync.
  const inboxInterval = setInterval(() => {
    if (!existsSync(${JSON.stringify(inboxFile)})) return;
    try {
      const msg = readFileSync(${JSON.stringify(inboxFile)}, "utf-8").trim();
      if (msg) {
        unlinkSync(${JSON.stringify(inboxFile)});
        pi.sendUserMessage(msg, { deliverAs: "steer" });
      }
    } catch {}
  }, 1000);

  pi.on("session_shutdown", () => clearInterval(inboxInterval));
}
`.trimStart();

  // Persona: injected via a before_agent_start hook spliced before the final brace.
  if (personaPrompt && personaPrompt.trim()) {
    const hookCode = `
  pi.on("before_agent_start", async (_event, _ctx) => {
    return { systemPrompt: ${JSON.stringify(personaPrompt)} };
  });
`;
    const lastBrace = source.lastIndexOf("\n}");
    if (lastBrace !== -1) {
      source = source.slice(0, lastBrace) + hookCode + "\n}";
    }
  }

  return source;
}

// ─── Spawn a pi agent in a tmux window ───────────────────────────────────────

export interface SpawnOptions {
  /** Short label for the agent; sanitized into the window name + coms cname. */
  name: string;
  /** First user message (task), or the warm-up message for a persistent member. */
  task: string;
  /** Persistent (team) member: stays alive, never writes "done". */
  persistent?: boolean;
  /** Explicit model as "provider/model-id" or bare "model-id". */
  model?: string;
  /** Fallback model when `model` is omitted (typically ctx.model). */
  sessionModel?: { provider: string; id: string };
  /** Loaded agent definition (system prompt, tools, skills, spawn policy). */
  agentDef?: AgentDef | null;
  /** Inline persona; wins over agentDef.systemPrompt. */
  systemPrompt?: string;
  /** Extra env vars to pass to the child (e.g. PI_COMS_PROJECT/PI_COMS_CNAME). */
  extraEnv?: Record<string, string>;
}

export interface SpawnHandle {
  id: string;
  safeName: string;
  windowName: string;
  windowTarget: string;
  paneId: string;
  extFile: string;
  stateFile: string;
  inboxFile: string;
  modelLabel?: string;
  startedAt: number;
}

export class TmuxSpawnError extends Error {}

/**
 * Write the IPC files and open a tmux window running a child pi session wired
 * to the parent via the generated extension. Throws TmuxSpawnError if not in a
 * tmux session or if `tmux new-window` fails.
 */
export function spawnAgentWindow(opts: SpawnOptions): SpawnHandle {
  const session = currentTmuxSession();
  if (!session) {
    throw new TmuxSpawnError("requires pi to be running inside a tmux session");
  }

  const safeName = sanitizeAgentName(opts.name);
  const windowName = `pi:${safeName}`;

  // ── Temp files ──────────────────────────────────────────────────────────
  const timestamp = Date.now();
  const id        = `${timestamp}-${Math.random().toString(36).slice(2, 6)}`;
  const tmpBase   = path.join(os.tmpdir(), `pi-agent-${timestamp}`);
  const extFile   = `${tmpBase}.ts`;
  const stateFile = `${tmpBase}.state.json`;
  const inboxFile = `${tmpBase}.inbox.txt`;

  // ── Generate + write the child extension ──────────────────────────────────
  const personaPrompt = (opts.systemPrompt && opts.systemPrompt.trim()) || opts.agentDef?.systemPrompt || "";
  const extSource = buildChildExtensionSource({
    task: opts.task,
    stateFile,
    inboxFile,
    persistent: !!opts.persistent,
    personaPrompt,
  });
  // 0o600 — state/inbox/ext files carry task text + agent output in a shared tmp dir.
  writeFileSync(extFile, extSource, { mode: 0o600 });
  // Pre-create state file so fs.watch has a target before the child writes.
  writeFileSync(stateFile, JSON.stringify({ status: "running" }), { mode: 0o600 });

  // ── Resolve the model ─────────────────────────────────────────────────────
  let agentProvider: string | undefined;
  let agentModelId: string | undefined;
  if (opts.model) {
    const slash = opts.model.indexOf("/");
    if (slash > 0) {
      agentProvider = opts.model.slice(0, slash);
      agentModelId  = opts.model.slice(slash + 1);
    } else {
      agentModelId = opts.model;
    }
  } else if (opts.sessionModel) {
    agentProvider = opts.sessionModel.provider;
    agentModelId  = opts.sessionModel.id;
  }

  let windowTarget: string;
  let paneId: string;
  try {
    const piDir = process.env.PI_CODING_AGENT_DIR ?? "";
    // PI_SUBAGENT tells tmux-window-name.ts not to rename this window to the cwd
    // basename — the launcher owns the name (pi:<name>) — and blocks the child
    // from registering launch_agent/agent_reply.
    // PI_AGENT_SPAWN allows one level of nesting (children do NOT inherit it).
    const envArgs = ["-e", "PI_SUBAGENT=1"];
    if (opts.agentDef?.spawnAgents) envArgs.push("-e", "PI_AGENT_SPAWN=1");
    if (piDir) envArgs.push("-e", `PI_CODING_AGENT_DIR=${piDir}`);
    for (const [k, v] of Object.entries(opts.extraEnv ?? {})) {
      if (v != null && v !== "") envArgs.push("-e", `${k}=${v}`);
    }
    // Pass provider API keys from the parent's environment — the parent already
    // has them sourced from Keychain; a child login shell may not.
    for (const key of Object.keys(process.env)) {
      if (/^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|XAI)_/i.test(key) && process.env[key]) {
        envArgs.push("-e", `${key}=${process.env[key]}`);
      }
    }

    const modelArgs: string[] = [];
    if (agentProvider) modelArgs.push("--provider", agentProvider);
    if (agentModelId)  modelArgs.push("--model",    agentModelId);

    // Tool restrictions from the agent definition
    const toolArgs: string[] = [];
    const toolList = opts.agentDef?.tools;
    if (toolList === "none") {
      toolArgs.push("--no-tools");
    } else if (toolList && toolList !== "all") {
      toolArgs.push("--tools", toolList);
    }

    // Skills policy:
    //   - Default (no agent, or agent with no skills field): --no-skills
    //   - Agent with skills: "*": load all global skills (no --no-skills)
    //   - Agent with skills: "og,cy,...": --no-skills + --skill <path> per named skill
    const skillArgs: string[] = [];
    const agentSkills = opts.agentDef?.skills ?? "";
    if (agentSkills === "*") {
      // load all global skills — omit --no-skills
    } else {
      skillArgs.push("--no-skills");
      if (agentSkills) {
        for (const skillName of agentSkills.split(",").map(s => s.trim()).filter(Boolean)) {
          const skillPath = resolveSkillPath(skillName);
          if (skillPath) skillArgs.push("--skill", skillPath);
        }
      }
    }

    const raw = execFileSync("tmux", [
      "new-window", "-d",
      "-n", windowName,
      "-P", "-F", "#{session_name}:#{window_index}\t#{pane_id}",
      ...envArgs,
      "--", "pi", "-e", extFile,
        // Team agents load the guardrails-block extension so they auto-deny
        // permission prompts rather than pausing and waiting for human input.
        ...(opts.persistent ? ["-e", path.join(os.homedir(), ".config", "pi", "extensions", "guardrails-block.ts")] : []),
        ...modelArgs, ...toolArgs, ...skillArgs,
    ], { encoding: "utf-8" }).trim();

    const [wt, pd] = raw.split("\t");
    windowTarget = wt ?? `${session}:?`;
    paneId       = pd ?? "";
  } catch (err: any) {
    try { execSync(`rm -f ${JSON.stringify(extFile)}`, { stdio: "ignore" }); } catch {}
    throw new TmuxSpawnError(`Failed to create tmux window: ${(err as Error).message}`);
  }

  // Lock the window name: PI_SUBAGENT stops tmux-window-name.ts, and the two
  // window options stop tmux's own escape-sequence / command-based renames.
  // @pi_subagent is read by window-icon.sh to show the subagent icon.
  // Target via the stable pane id (window index may shift later).
  // Batch all three set-window-option calls into one tmux invocation to save
  // two process forks (small but real startup latency).
  try {
    execSync(
      `tmux set-window-option -t ${paneId} allow-rename off` +
      ` \; set-window-option -t ${paneId} automatic-rename off` +
      ` \; set-window-option -t ${paneId} @pi_subagent 1`,
      { stdio: "ignore" },
    );
  } catch {}

  const modelLabel = agentProvider && agentModelId
    ? shortModelName(`${agentProvider}/${agentModelId}`)
    : agentModelId ? shortModelName(agentModelId) : undefined;

  return {
    id, safeName, windowName, windowTarget, paneId,
    extFile, stateFile, inboxFile, modelLabel, startedAt: timestamp,
  };
}
