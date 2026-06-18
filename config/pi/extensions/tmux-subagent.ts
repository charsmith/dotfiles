/**
 * tmux-subagent — launch pi subagents in separate tmux windows
 *
 * `launch_agent` spawns a pi session in a new tmux window. It runs in one of
 * two modes:
 *   - blocking (default): the tool call waits and returns the agent's result
 *     inline (with usage), just like any other tool.
 *   - background: the tool returns immediately and the result arrives later as
 *     a followUp message, so the parent can keep working.
 *
 * If the agent hits a guardrails path-access prompt, it pauses and the parent
 * surfaces an inline dialog (with the tool + path context) so the human can
 * Allow once / Deny right here — the choice is applied by sending the matching
 * keys to the child's tmux pane. "Open the agent's window" jumps there for the
 * advanced grant options. Anything we can't drive inline falls back to a
 * notification pointing at the child window. agent_reply can inject plain
 * follow-up text into a running/stopped background agent (not a modal prompt).
 *
 * File-based IPC (no screen-scraping):
 *   {tmpBase}.ts          — temp extension (deletes itself on load)
 *   {tmpBase}.state.json  — child writes status/output/usage
 *   {tmpBase}.inbox.txt   — parent writes messages for child to inject
 *
 * States: running → (stopped: paused for input) → running → done | error
 *
 * Widget card per agent (above editor, disappears when done):
 *   ┌──────────────────────────────────────────────────────┐
 *   │ name · model-id                                      │
 *   │ ● running  [0:2]  23s                                │
 *   │ truncated task text…                                 │
 *   └──────────────────────────────────────────────────────┘
 *
 * Tools:   launch_agent (task, mode, model, agent, team, system_prompt), agent_reply
 * Commands: /agents, /agents-clear
 *
 * Team members (team="<project>"): launched as PERSISTENT coms-bus members
 * (coms-bus.ts auto-joins via PI_COMS_PROJECT/PI_COMS_CNAME env). They are NOT
 * killed when their first turn ends — `task` is a plain warm-up message and they
 * stay alive to service coms_send/coms_broadcast, addressable by `name`. The
 * parent finishes them only when the pane dies (exit / coms_shutdown / window
 * close). system_prompt="..." sets an inline persona (alternative to `agent`).
 *
 * Agent definitions live in ~/.config/pi/agents/<name>.md — YAML frontmatter
 * (name, description, tools, skills) + system prompt body. Pass agent=<name> to
 * launch_agent to apply the agent's system prompt, tool list, and skills.
 *
 * Skills policy: subagents always launch with --no-skills by default.
 *   skills: "og,cy,ta"  — load only those named skills from ~/.config/pi/skills/
 *   skills: "*"         — load all global skills (skip --no-skills)
 *   skills omitted      — no skills
 *
 * Spawn policy: subagents cannot launch further agents by default (PI_SUBAGENT blocks).
 *   spawn_agents: true  — sets PI_AGENT_SPAWN=1, overriding the block for one level.
 *   Children of a spawn_agents agent do NOT inherit PI_AGENT_SPAWN — nesting stops at 1.
 *
 * See tmux-subagent.md (next to this file) for the full architecture: the
 * file-based IPC, the stop/approval flow, window tracking, and the gotchas.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Agent definition loader ────────────────────────────────────────────────

interface AgentDef {
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

function resolveSkillPath(skillName: string): string | null {
  for (const dir of SKILL_DIRS) {
    const p = path.join(dir, skillName);
    if (existsSync(path.join(p, "SKILL.md"))) return p;
    // Also allow bare .md skills
    const md = path.join(dir, `${skillName}.md`);
    if (existsSync(md)) return md;
  }
  return null;
}

function loadAgentDef(agentName: string): AgentDef | null {
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
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Types ─────────────────────────────────────────────────────────────────

type AgentStatus = "running" | "stopped" | "done" | "error";

interface AgentUsage {
  turns: number;
  input: number;
  output: number;
  cost: number;
  elapsedMs: number;
}

interface AgentPrompt {
  kind?: string;       // guardrails prompt kind ("confirmation" | "permission")
  toolName?: string;   // tool the subagent was trying to run
  path?: string;       // target path (path-access prompts)
  reason?: string;     // human-readable reason
}

interface AgentState {
  status: AgentStatus;
  output?: string;
  reason?: string;   // guardrails stop reason
  prompt?: AgentPrompt;
  model?: string;
  usage?: AgentUsage;
}

type AgentMode = "blocking" | "background" | "team";

interface AgentEntry {
  id: string;
  name: string;
  windowName: string;
  task: string;
  mode: AgentMode;
  windowTarget: string;
  paneId: string;
  extFile: string;
  stateFile: string;
  inboxFile: string;
  status: AgentStatus;
  stopReason?: string;
  prompt?: AgentPrompt;
  decisions?: string[];   // permission prompts the human resolved inline
  promptAbort?: AbortController;  // aborts an open parent dialog if resolved elsewhere
  startedAt: number;
  model?: string;
  usage?: AgentUsage;
  notifiedStopped?: boolean;
  // Set for blocking agents — resolves the launch_agent tool's execute() promise.
  watcher?: FSWatcher;           // fs.watch on the state file for instant usage updates
  resolve?: (result: ToolResultLike) => void;
}

interface ToolResultLike {
  content: { type: "text"; text: string }[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

// ─── Formatting ────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtUsage(u: AgentUsage): string {
  const parts: string[] = [];
  if (u.turns)  parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
  if (u.input)  parts.push(`↑${fmtTokens(u.input)}`);
  if (u.output) parts.push(`↓${fmtTokens(u.output)}`);
  if (u.cost)   parts.push(`$${u.cost.toFixed(3)}`);
  parts.push(fmtElapsed(u.elapsedMs));
  return parts.join("  ");
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // When running as a subagent, this extension is still loaded from the global
  // config directory — but subagents must not register launch_agent / agent_reply
  // (they'd be visible to the model and it would try to use them). The temp
  // extension handles everything the child session needs; bail here.
  if (process.env.PI_SUBAGENT) return;

  const agents = new Map<string, AgentEntry>();
  let latestCtx: ExtensionContext | null = null;
  let tickInterval: ReturnType<typeof setInterval> | null = null;
  let tickCount = 0;
  let currentModelLabel = "";   // updated on model_select; used in renderCall

  // ── Model label ─────────────────────────────────────────────────────────

  // Return a compact display label for a model string like "anthropic/claude-opus-4-5".
  // Strips the provider prefix, then strips well-known model-family prefixes
  // ("claude-", "gemini-", "gpt-") so we just see "opus-4-5", "2.0-flash", etc.
  function shortModelName(modelStr: string): string {
    // Strip "provider/" prefix
    const slash = modelStr.indexOf("/");
    let id = slash >= 0 ? modelStr.slice(slash + 1) : modelStr;
    // Strip well-known family prefixes
    for (const prefix of ["claude-", "gemini-", "gpt-"]) {
      if (id.startsWith(prefix)) { id = id.slice(prefix.length); break; }
    }
    return id;
  }

  // ── Tmux helper ──────────────────────────────────────────────────────────

  function currentTmuxSession(): string | null {
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
  function windowForPane(paneId: string): string | null {
    if (!paneId) return null;
    try {
      return execSync(
        `tmux display-message -p -t ${paneId} '#{session_name}:#{window_index}'`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || null;
    } catch { return null; }
  }

  // ── State file watcher ───────────────────────────────────────────────────────────────────
  // Watch the state file for changes — fires instantly when the child writes
  // usage/status updates, so the widget card stays live without polling lag.

  function startWatching(agent: AgentEntry): FSWatcher | undefined {
    try {
      return watch(agent.stateFile, { persistent: false }, () => {
        if (!agents.has(agent.id)) return;
        if (!existsSync(agent.stateFile)) return;
        try {
          const state = JSON.parse(readFileSync(agent.stateFile, "utf-8")) as AgentState;
          if (state.usage)  agent.usage = state.usage;
          if (state.model)  agent.model = shortModelName(state.model);
          setWidgetForAgent(agent);
        } catch {}
      });
    } catch { return undefined; }
  }

  // ── Widget card ──────────────────────────────────────────────────────────
  //
  // All agents share a single widget slot ("subagents") so the display order
  // is always determined by startedAt — re-calling setWidget on a per-agent
  // key would re-insert it at the end, causing flicker / reordering.

  function renderCard(agent: AgentEntry, inner: number, theme: any): string[] {
    const statusColor: any =
      agent.status === "running" ? "accent"
      : agent.status === "stopped" ? "warning"
      : agent.status === "done"    ? "success"
      :                              "error";

    const icon =
      agent.status === "running" ? "●"
      : agent.status === "stopped" ? "⚠"
      : agent.status === "done"    ? "✓"
      :                              "✗";

    const cell = (styled: string): string => {
      const vis = visibleWidth(styled);
      return (
        theme.fg(statusColor, "│") +
        styled +
        " ".repeat(Math.max(0, inner - vis)) +
        theme.fg(statusColor, "│")
      );
    };

    // Line 1: name · model
    const safeName    = agent.name.replace(/[\r\n\t]+/g, " ").trim();
    const rawNameModel = safeName + (agent.model ? ` · ${agent.model}` : "");
    const trunc        = truncateToWidth(rawNameModel, inner - 1);
    const dotIdx       = trunc.indexOf(" · ");
    const nameStyled   = dotIdx >= 0
      ? theme.fg(statusColor, theme.bold(trunc.slice(0, dotIdx))) +
        theme.fg("dim", trunc.slice(dotIdx))
      : theme.fg(statusColor, theme.bold(trunc));

    // Line 2: status indicator + pane ref + elapsed (or stop reason)
    const elapsed    = fmtElapsed(Date.now() - agent.startedAt);
    const u          = agent.usage;
    const liveStats  = u && (u.turns || u.input || u.output || u.cost)
      ? `↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)}  $${u.cost.toFixed(3)}  ${elapsed}`
      : elapsed;
    const safeReason = agent.stopReason?.replace(/[\r\n\t]+/g, " ").trim();
    const rawStatus  = agent.status === "stopped" && safeReason
      ? `${icon} stopped  [${agent.windowTarget}]  ${safeReason}`
      : `${icon} ${agent.status}  [${agent.windowTarget}]  ${liveStats}`;
    const statusText = truncateToWidth(rawStatus, inner - 1);

    // Line 3: task text — collapse newlines/control chars so the cell stays
    // on a single terminal line (LLMs often pass multi-line task strings).
    const flatTask = agent.task.replace(/[\r\n\t]+/g, " ").trim();
    const taskText = truncateToWidth(flatTask, inner - 1);

    const top = theme.fg(statusColor, "┌" + "─".repeat(inner) + "┐");
    const bot = theme.fg(statusColor, "└" + "─".repeat(inner) + "┘");

    return [
      top,
      cell(" " + nameStyled),
      cell(" " + theme.fg(statusColor, statusText)),
      cell(" " + theme.fg("dim", taskText)),
      bot,
    ];
  }

  // The single widget is registered once per session (lazily on first agent)
  // and cleared when the last agent is removed. Between those events we just
  // flip a dirty flag and call requestRender(); render() skips recomputing if
  // nothing has changed. invalidate() clears the cache on theme changes.
  let widgetDirty        = false;
  let widgetRegistered   = false;
  let widgetHandle: { requestRender(): void } | null = null;
  let cachedLines: string[] = [];
  let cachedWidth        = -1;

  function refreshWidget() {
    const ctx = latestCtx;
    if (!ctx) return;

    if (agents.size === 0) {
      ctx.ui.setWidget("subagents", undefined);
      widgetRegistered = false;
      widgetHandle = null;
      cachedLines = [];
      cachedWidth = -1;
      return;
    }

    widgetDirty = true;
    widgetHandle?.requestRender();

    if (widgetRegistered) return;  // already set up — dirty flag + requestRender is enough
    widgetRegistered = true;

    ctx.ui.setWidget("subagents", (tui, theme) => {
      widgetHandle = tui;
      return {
        render(width: number): string[] {
          if (!widgetDirty && width === cachedWidth) return cachedLines;
          widgetDirty = false;
          cachedWidth = width;
          const MAX_WIDTH = 58;
          const inner     = Math.max(0, Math.min(width, MAX_WIDTH) - 2);
          // Sort by launch time so the order never changes as widgets update.
          const sorted = Array.from(agents.values()).sort((a, b) => a.startedAt - b.startedAt);
          const lines: string[] = [];
          for (const agent of sorted) {
            if (lines.length > 0) lines.push("");  // gap between cards
            lines.push(...renderCard(agent, inner, theme));
          }
          cachedLines = lines;
          return lines;
        },
        invalidate() {
          // Called by the TUI on theme changes — clear the cache so the next
          // render() recomputes with the fresh theme colours.
          cachedLines = [];
          cachedWidth = -1;
        },
      };
    });
  }

  // Aliases kept so the rest of the code compiles without changes.
  function setWidgetForAgent(_agent: AgentEntry) { refreshWidget(); }
  function clearWidgetForAgent(_id: string)       { refreshWidget(); }
  function updateAllWidgets()                      { refreshWidget(); }

  // ── State file polling + followUp delivery ───────────────────────────────

  function pollAgentState(agent: AgentEntry) {
    // Keep windowTarget fresh from the stable pane id — the index may have
    // shifted since launch as other windows came and went.
    const liveTarget = windowForPane(agent.paneId);
    if (liveTarget) agent.windowTarget = liveTarget;

    // Step 1: check state file for stopped/done signals
    if (existsSync(agent.stateFile)) {
      let state: AgentState;
      try { state = JSON.parse(readFileSync(agent.stateFile, "utf-8")); }
      catch { return; }

      // Live usage update — agent still running, not paused. Update in-place
      // but do NOT return: fall through to the pane-liveness check (Step 2) so
      // a crashed child that leaves a stale "running" state file is still caught.
      if (state.status === "running" && agent.status === "running") {
        if (state.usage)  agent.usage = state.usage;
        if (state.model)  agent.model = shortModelName(state.model);
      }

      // Resumed after a pause (e.g. answered in the child window) — close any
      // dangling parent dialog, then clear the stopped flag.
      if (state.status === "running" && agent.status === "stopped") {
        agent.promptAbort?.abort();
        agent.status         = "running";
        agent.stopReason     = undefined;
        agent.notifiedStopped = false;
        agent.model          = state.model ? shortModelName(state.model) : agent.model;
        setWidgetForAgent(agent);
        return;
      }

      if (state.status === "stopped" && agent.status !== "stopped") {
        agent.status     = "stopped";
        agent.stopReason = state.reason ?? "needs your input";
        agent.prompt     = state.prompt;
        agent.model      = state.model ? shortModelName(state.model) : agent.model;
        setWidgetForAgent(agent);
        if (!agent.notifiedStopped) {
          agent.notifiedStopped = true;
          void onAgentStopped(agent);
        }
        return;
      }

      if (state.status === "done" || state.status === "error") {
        agent.status = state.status;
        agent.model  = state.model ? shortModelName(state.model) : agent.model;
        agent.usage  = state.usage;
        finishAgent(agent, state.output, state.status === "error");
        return;
      }
    }

    // Step 2: if pane is dead (agent exited without writing done state), clean up
    if (agent.status === "running" && !isPaneAlive(agent.paneId)) {
      // Try one last read in case the file appeared between checks
      let output: string | undefined;
      if (existsSync(agent.stateFile)) {
        try {
          const s = JSON.parse(readFileSync(agent.stateFile, "utf-8")) as AgentState;
          output = s.output;
          agent.model = s.model ? shortModelName(s.model) : agent.model;
          agent.usage = s.usage;
        } catch {}
      }
      finishAgent(agent, output, false);
    }
  }

  // Only one inline parent dialog at a time.
  let parentDialogBusy = false;

  function sendKeysToPane(paneId: string, key: string) {
    if (!paneId) return;
    try { execSync(`tmux send-keys -t ${paneId} ${key}`, { stdio: "ignore" }); } catch {}
  }

  // Mark a paused agent as active again (after we drive its prompt). We also
  // overwrite the state file back to "running" — the child can't tell us its
  // modal closed, so without this the still-"stopped" file would re-fire the
  // dialog on the next tick. A genuine second prompt rewrites "stopped" again.
  function markResumed(agent: AgentEntry) {
    agent.status         = "running";
    agent.stopReason     = undefined;
    agent.prompt         = undefined;
    agent.notifiedStopped = false;
    try {
      writeFileSync(agent.stateFile, JSON.stringify({ status: "running", model: agent.model }), "utf-8");
    } catch {}
    setWidgetForAgent(agent);
  }

  // Show the subagent's guardrails prompt inline in the parent — with the
  // context of what it was trying to do — and drive the child's modal via
  // tmux send-keys. Returns true if it handled the stop, false if it couldn't
  // show a dialog (caller should fall back to a notification).
  async function promptInParent(agent: AgentEntry): Promise<boolean> {
    const ctx = latestCtx;
    // Only auto-drive the path-access confirmation modal, whose key map we
    // know (Enter = first option "Allow once", Esc = Deny).
    if (!ctx?.hasUI || parentDialogBusy || agent.prompt?.kind !== "confirmation") {
      return false;
    }
    parentDialogBusy = true;
    try {
      const p = agent.prompt;
      const ctxBits = [
        p.toolName ? `tool: ${p.toolName}` : "",
        p.path ? `path: ${p.path}` : "",
      ].filter(Boolean).join("   ");
      const message =
        `Subagent "${agent.name}" needs permission\n` +
        `${p.reason ?? agent.stopReason ?? ""}` +
        (ctxBits ? `\n${ctxBits}` : "");

      const ac = new AbortController();
      agent.promptAbort = ac;
      const choice = await ctx.ui.select(message, [
        "Allow once",
        "Deny",
        "Open the agent's tmux window",
      ], { signal: ac.signal });
      agent.promptAbort = undefined;

      // We aborted the dialog because the agent resolved elsewhere (answered in
      // the child window, or finished). Nothing to do — stay silent.
      if (ac.signal.aborted || !agents.has(agent.id)) return true;

      const what = `${p.toolName ?? "a tool"}${p.path ? ` → ${p.path}` : ""}`;
      if (choice === "Allow once" || choice === "Deny") {
        const verb = choice === "Allow once" ? "allowed" : "denied";
        sendKeysToPane(agent.paneId, choice === "Allow once" ? "Enter" : "Escape");
        (agent.decisions ??= []).push(`${verb} ${what}`);
        markResumed(agent);
        // Immediate, visible feedback that the click registered. The decision
        // is also folded into the final result so the thread/LLM is aware.
        ctx.ui.notify(`Subagent "${agent.name}": ${verb} ${what}`, verb === "allowed" ? "info" : "warning");
      } else if (choice === "Open the agent's tmux window") {
        // Re-resolve the window target from the pane id — pane IDs (%N) are not
        // valid window targets for select-window; need the session:index form.
        const freshTarget = windowForPane(agent.paneId) ?? agent.windowTarget;
        try { execSync(`tmux select-window -t ${freshTarget}`, { stdio: "ignore" }); } catch {}
        ctx.ui.notify(`Switched to ${agent.windowName}. Respond there.`, "info");
      } else {
        // Dismissed without choosing — leave a breadcrumb to the window.
        ctx.ui.notify(
          `Agent "${agent.name}" still waiting — window ${agent.windowTarget} ("${agent.windowName}")`,
          "warning",
        );
      }
      return true;
    } finally {
      parentDialogBusy = false;
    }
  }

  // Decide how to surface a stopped agent: prefer an inline dialog in the
  // parent, otherwise fall back to a notification / follow-up.
  async function onAgentStopped(agent: AgentEntry) {
    if (await promptInParent(agent)) return;
    notifyNeedsAttention(agent);
  }

  // Alert whoever can act when an agent stops for input (guardrails prompt,
  // question, etc.). Background → notify the parent LLM so it can switch
  // windows or use agent_reply. Blocking → the parent LLM is busy inside
  // execute(), so toast the human directly to switch to the child window.
  function notifyNeedsAttention(agent: AgentEntry) {
    const idxHint = agent.windowTarget.split(":")[1] ?? "?";
    if (agent.mode === "background") {
      pi.sendMessage({
        customType: "subagent-stopped",
        content:
          `Agent "${agent.name}" needs input in tmux window ${agent.windowTarget} ` +
          `(Ctrl-b then ${idxHint} — the index can shift, so look for the "${agent.windowName}" window).\n\n` +
          `Reason: ${agent.stopReason}\n\n` +
          `Switch to that window to respond. Guardrails permission prompts and ` +
          `interactive questions must be answered in the window. For a plain ` +
          `follow-up instruction you can also use agent_reply(id="${agent.id}", message="...").`,
        display: true,
      }, { deliverAs: "followUp", triggerTurn: true });
    } else {
      latestCtx?.ui.notify(
        `Agent "${agent.name}" needs input — switch to tmux window ${agent.windowTarget} ("${agent.windowName}"): ${agent.stopReason}`,
        "warning",
      );
    }
  }

  // Tear down the tmux window + temp files and drop the agent from tracking.
  function cleanupAgent(agent: AgentEntry) {
    // Close any parent dialog still waiting on this (now-finished) agent.
    agent.promptAbort?.abort();
    // Target the window by its stable pane id, never by index — a stale index
    // could resolve to one of the user's other windows and kill it.
    if (agent.paneId) {
      try { execSync(`tmux kill-pane -t ${agent.paneId}`, { stdio: "ignore" }); } catch {}
    }
    try { unlinkSync(agent.extFile); } catch {}
    try { unlinkSync(agent.stateFile); } catch {}
    try { unlinkSync(agent.inboxFile); } catch {}
    agent.watcher?.close();
    clearWidgetForAgent(agent.id);
    agents.delete(agent.id);
    if (!Array.from(agents.values()).some(a => a.status === "running" || a.status === "stopped")) {
      stopTicking();
      latestCtx?.ui.setWorkingVisible(true);
    }
  }

  function finishAgent(agent: AgentEntry, output: string | undefined, isError: boolean) {
    const resolve = agent.resolve;   // capture before cleanup drops the entry
    cleanupAgent(agent);

    const summary  = agent.usage ? `  ${fmtUsage(agent.usage)}` : "";
    const decisionNote = agent.decisions?.length
      ? `\n\n(Permission prompts you handled inline: ${agent.decisions.join("; ")}.)`
      : "";
    const resultText = (output
      ? (isError
          ? `Agent "${agent.name}" failed: ${output}`
          : `Agent "${agent.name}" finished.${summary}\n\n${output}`)
      : `Agent "${agent.name}" finished${summary} (no output captured).`) + decisionNote;

    if (agent.mode === "blocking" && resolve) {
      // Blocking launch: hand the result back as the tool's own result so it
      // renders inline (with usage) just like any other tool call.
      resolve({
        content: [{ type: "text", text: resultText }],
        details: { id: agent.id, mode: "blocking", usage: agent.usage },
        isError,
      });
      return;
    }

    // Background launch: deliver as a follow-up message to the parent thread.
    pi.sendMessage({
      customType: "subagent-result",
      content: resultText,
      display: true,
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  // ── Pane liveness ───────────────────────────────────────────────────────

  function isPaneAlive(paneId: string): boolean {
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

  // ── Tick loop ────────────────────────────────────────────────────────────

  function startTicking() {
    if (tickInterval) return;
    tickInterval = setInterval(() => {
      tickCount++;
      // Poll state files every tick (1s) so fast runs don't get missed
      for (const agent of agents.values()) pollAgentState(agent);
      updateAllWidgets();
    }, 1000);
  }

  function stopTicking() {
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; tickCount = 0; }
  }

  // ── launch_agent tool ────────────────────────────────────────────────────

  pi.registerTool({
    name: "launch_agent",
    label: "Launch Agent",
    description: [
      "Launch a pi subagent in a new tmux window to work on a task.",
      "mode='blocking' (default) waits for the agent and returns its result",
      "inline like a normal tool, with token/cost usage.",
      "mode='background' returns immediately and delivers the result later as a",
      "follow-up message so you can keep working.",
      "In either mode, if the agent needs input (a guardrails permission prompt",
      "or an interactive question) it pauses and you respond by switching to its",
      "tmux window. For plain follow-up instructions to a running/stopped",
      "background agent you can also use agent_reply. NOTE: this tool is only",
      "available to the top-level session and subagents with spawn_agents: true",
      "in their agent definition.",
      "agent (optional): name of an agent definition from ~/.config/pi/agents/<name>.md",
      "— applies that agent's system prompt, tool restrictions, skills, and spawn policy.",
      "team (optional): launch as a PERSISTENT coms-bus member of this team (project).",
      "The agent stays alive (it is not killed when its first turn ends) and is",
      "addressable by `name` via coms_send / coms_broadcast. `task` becomes a plain",
      "warm-up message. system_prompt (optional): an inline persona/system prompt,",
      "an alternative to `agent` for ad-hoc personas.",
    ].join(" "),
    promptSnippet: "Launch a subagent in a tmux window (blocking or background)",
    parameters: Type.Object({
      name: Type.String({ description: "Short label for this agent (used as tmux window name)" }),
      task: Type.String({ description: "Task description to send as the agent's first message" }),
      mode: Type.Optional(StringEnum(["blocking", "background"] as const, {
        description:
          "'blocking' (default): wait and return the result inline. " +
          "'background': return immediately; result arrives as a follow-up.",
      })),
      model: Type.Optional(StringEnum([
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-opus-4-8",
        "anthropic/claude-fable-5",
      ] as const, {
        description:
          "Model to use for the agent. Defaults to the current session model. " +
          "Do not specify unless explicitly asked by the user.",
      })),
      agent: Type.Optional(Type.String({
        description:
          "Agent definition name to load from ~/.config/pi/agents/<name>.md. " +
          "Applies the agent's system prompt and tool restrictions to the subagent session.",
      })),
      team: Type.Optional(Type.String({
        description:
          "Launch as a persistent coms-bus team member in this team (project). The agent " +
          "stays alive and is addressable by `name` via coms_send/coms_broadcast; `task` is a warm-up message.",
      })),
      system_prompt: Type.Optional(Type.String({
        description: "Inline persona/system prompt for the agent (alternative to `agent`).",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      latestCtx = ctx;

      if (process.env.PI_SUBAGENT && !process.env.PI_AGENT_SPAWN) {
        return {
          content: [{ type: "text", text: "Error: this subagent is not configured to launch further agents. Set spawn_agents: true in the agent definition." }],
          details: {}, isError: true,
        };
      }

      const mode: AgentMode = params.mode === "background" ? "background" : "blocking";
      // Team members are persistent coms-bus listeners; everything else is the
      // task-then-done subagent. effectiveMode drives lifecycle + return shape.
      const isTeam = typeof params.team === "string" && params.team.trim().length > 0;
      const effectiveMode: AgentMode = isTeam ? "team" : mode;

      const session = currentTmuxSession();
      if (!session) {
        return {
          content: [{ type: "text", text: "Error: launch_agent requires pi to be running inside a tmux session." }],
          details: {}, isError: true,
        };
      }

      const safeName = (
        params.name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-")
          .replace(/^-|-$/g, "").slice(0, 20) || "agent"
      );
      const windowName = `pi:${safeName}`;

      // ── Temp files ────────────────────────────────────────────────────
      const timestamp = Date.now();
      const id        = `${timestamp}-${Math.random().toString(36).slice(2, 6)}`;
      const tmpBase   = path.join(os.tmpdir(), `pi-agent-${timestamp}`);
      const tmpExtPath  = `${tmpBase}.ts`;
      const stateFile   = `${tmpBase}.state.json`;
      const inboxFile   = `${tmpBase}.inbox.txt`;


      // ── Temp extension ────────────────────────────────────────────────
      //
      // Runs in the child pi process. Responsibilities:
      //   1. Send the initial task as the first user message
      //   2. On guardrails permission prompt → write transient "stopped" state
      //      (agent is paused waiting for in-window input)
      //   3. On agent_end → write "done" with output + usage (the run is over,
      //      regardless of any earlier guardrails pause that the human cleared)
      //   4. Poll inbox.txt every 1s → inject parent messages via sendUserMessage
      //
      const tmpExtSource = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
export default function (pi: ExtensionAPI) {
  let fired = false;
  // PERSISTENT (team) members never write "done" — they stay alive to keep
  // servicing coms messages; the parent finishes them only when the pane dies.
  const PERSISTENT = ${isTeam ? "true" : "false"};
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
    pi.sendUserMessage(${JSON.stringify(params.task)});
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
      status: PERSISTENT ? "running" : "done",
      output: finalOutput || "(no output)",
      model: modelId || undefined,
      usage: { turns: totalTurns, input, output: totalOutput, cost: totalCost, elapsedMs: Date.now() - startedAt },
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

      // ── Agent definition: inject system prompt into child extension ───
      let agentDef: AgentDef | null = null;
      let finalExtSource = tmpExtSource;
      if (params.agent) {
        agentDef = loadAgentDef(params.agent);
        if (!agentDef) {
          return {
            content: [{ type: "text", text: `Agent definition "${params.agent}" not found in ~/.config/pi/agents/ or ~/.pi/agents/` }],
            details: {}, isError: true,
          };
        }
      }
      // Persona: inline system_prompt wins, else the agent def's system prompt.
      // Injected via a before_agent_start hook spliced before the final brace.
      const personaPrompt = (params.system_prompt && params.system_prompt.trim()) || agentDef?.systemPrompt || "";
      if (personaPrompt) {
        const hookCode = `
  pi.on("before_agent_start", async (_event, _ctx) => {
    return { systemPrompt: ${JSON.stringify(personaPrompt)} };
  });
`;
        const lastBrace = finalExtSource.lastIndexOf("\n}");
        if (lastBrace !== -1) {
          finalExtSource = finalExtSource.slice(0, lastBrace) + hookCode + "\n}";
        }
      }

      writeFileSync(tmpExtPath, finalExtSource, { mode: 0o600 });
      // Pre-create state file so fs.watch has a target before the child writes.
      // 0o600 — state/inbox files carry task text + agent output in a shared tmp dir.
      writeFileSync(stateFile, JSON.stringify({ status: "running" }), { mode: 0o600 });

      // ── Spawn tmux window ─────────────────────────────────────────────
      let windowTarget: string;
      let paneId: string;

      // Resolve the model to use: explicit param > current session model.
      // Parse "provider/model-id" or bare "model-id" from the param.
      let agentProvider: string | undefined;
      let agentModelId: string | undefined;
      if (params.model) {
        const slash = params.model.indexOf("/");
        if (slash > 0) {
          agentProvider = params.model.slice(0, slash);
          agentModelId  = params.model.slice(slash + 1);
        } else {
          agentModelId = params.model;
        }
      } else if (ctx.model) {
        agentProvider = ctx.model.provider;
        agentModelId  = ctx.model.id;
      }

      try {
        const piDir   = process.env.PI_CODING_AGENT_DIR ?? "";
        // PI_SUBAGENT tells tmux-window-name.ts not to rename this window to the
        // cwd basename — the launcher owns the name (pi:<name>).
        // PI_AGENT_SPAWN allows the child to spawn further subagents (one level only —
        // children spawned by this agent will NOT inherit PI_AGENT_SPAWN).
        const envArgs = ["-e", "PI_SUBAGENT=1"];
        if (agentDef?.spawnAgents) envArgs.push("-e", "PI_AGENT_SPAWN=1");
        if (piDir) envArgs.push("-e", `PI_CODING_AGENT_DIR=${piDir}`);
        // Team members auto-join the coms-bus: these env vars opt coms-bus.ts in
        // (it auto-loads globally and activates on PI_COMS_PROJECT/PI_COMS_CNAME).
        if (isTeam) {
          envArgs.push("-e", `PI_COMS_PROJECT=${params.team}`);
          envArgs.push("-e", `PI_COMS_CNAME=${safeName}`);
          const purpose = (agentDef?.description || params.system_prompt || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 100);
          if (purpose) envArgs.push("-e", `PI_COMS_PURPOSE=${purpose}`);
          // Propagate a custom bus dir (tests/non-default) to the child.
          if (process.env.PI_COMS_BUS_DIR) envArgs.push("-e", `PI_COMS_BUS_DIR=${process.env.PI_COMS_BUS_DIR}`);
        }
        // Pass provider API keys from the parent's environment — the parent
        // already has them sourced from Keychain; a child login shell may not.
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
        const toolList = agentDef?.tools;
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
        const agentSkills = agentDef?.skills ?? "";
        if (agentSkills === "*") {
          // load all global skills — omit --no-skills
        } else {
          skillArgs.push("--no-skills");
          if (agentSkills) {
            for (const skillName of agentSkills.split(",").map(s => s.trim()).filter(Boolean)) {
              const skillPath = resolveSkillPath(skillName);
              if (skillPath) {
                skillArgs.push("--skill", skillPath);
              }
            }
          }
        }

        const raw = execFileSync("tmux", [
          "new-window", "-d",
          "-n", windowName,
          "-P", "-F", "#{session_name}:#{window_index}\t#{pane_id}",
          ...envArgs,
          "--", "pi", "-e", tmpExtPath, ...modelArgs, ...toolArgs, ...skillArgs,
        ], { encoding: "utf-8" }).trim();

        const [wt, pd] = raw.split("\t");
        windowTarget = wt ?? `${session}:?`;
        paneId       = pd ?? "";
      } catch (err: any) {
        try { unlinkSync(tmpExtPath); } catch {}
        return {
          content: [{ type: "text", text: `Failed to create tmux window: ${(err as Error).message}` }],
          details: {}, isError: true,
        };
      }

      // Lock the window name: PI_SUBAGENT stops tmux-window-name.ts, and the two
      // window options stop tmux's own escape-sequence / command-based renames.
      // @pi_subagent is read by window-icon.sh to show the subagent icon.
      // Target via the stable pane id (window index may shift later).
      try {
        execSync(`tmux set-window-option -t ${paneId} allow-rename off`, { stdio: "ignore" });
        execSync(`tmux set-window-option -t ${paneId} automatic-rename off`, { stdio: "ignore" });
        execSync(`tmux set-window-option -t ${paneId} @pi_subagent 1`, { stdio: "ignore" });
      } catch {}

      // ── Register + start ticking ──────────────────────────────────────
      // Build a display label for the widget card from the resolved model.
      const launchModelLabel = agentProvider && agentModelId
        ? shortModelName(`${agentProvider}/${agentModelId}`)
        : agentModelId ? shortModelName(agentModelId) : undefined;

      const agent: AgentEntry = {
        id, name: params.name, windowName,
        task: isTeam ? `[team:${params.team}] ${params.task}` : params.task,
        mode: effectiveMode,
        windowTarget, paneId, extFile: tmpExtPath, stateFile, inboxFile,
        status: "running", startedAt: timestamp,
        model: launchModelLabel,
      };
      agents.set(id, agent);

      agent.watcher = startWatching(agent);
      setWidgetForAgent(agent);
      startTicking();

      if (isTeam) {
        // Persistent coms member: returns now; it lives until it exits / is
        // dismissed (coms_shutdown) / its window closes.
        ctx.ui.setWorkingVisible(false);
        return {
          content: [{ type: "text", text: `Team member "${params.name}" joined "${params.team}" (${windowTarget}) and is warming up. Talk to it with coms_send(target:"${safeName}", ...) once you're on the bus (/coms-join ${params.team}). It will keep running until dismissed (coms_shutdown) or its window closes.` }],
          details: { id, windowTarget, windowName, mode: effectiveMode, team: params.team, cname: safeName },
        };
      }

      if (mode === "background") {
        // Returns now; the result lands later as a follow-up message.
        ctx.ui.setWorkingVisible(false);
        return {
          content: [{ type: "text", text: `Agent "${params.name}" launched in background (${windowTarget}). Result will arrive as a follow-up message. If it pauses for input, switch to its tmux window or use agent_reply.` }],
          details: { id, windowTarget, windowName, mode },
        };
      }

      // Blocking: hold the tool open until the agent reaches a terminal state.
      // The human can still respond by switching to the child's tmux window.
      onUpdate?.({ content: [{ type: "text", text: `Running in ${windowTarget} — switch to that window if it asks for input.` }] });
      return await new Promise<ToolResultLike>((resolve) => {
        agent.resolve = resolve;
        const onAbort = () => {
          if (!agents.has(id)) return;   // already finished normally
          cleanupAgent(agent);
          resolve({
            content: [{ type: "text", text: `Agent "${params.name}" was cancelled before finishing.` }],
            details: { id, mode, windowName },
            isError: true,
          });
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    renderCall(args, theme, context) {
      const name      = args.name ?? "…";
      const task      = args.task ?? "…";
      // Prefer the explicit arg, fall back to the current session model.
      const rawModel  = (args as any).model ?? currentModelLabel;
      const modelTag  = rawModel ? ` [${shortModelName(rawModel)}]` : "";
      const text      = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        theme.fg("accent", "→ ") + theme.fg("toolTitle", theme.bold("launch_agent ")) +
        theme.fg("accent", name) + theme.fg("dim", modelTag) +
        "\n  " + theme.fg("dim", task.length > 72 ? task.slice(0, 71) + "…" : task)
      );
      return text;
    },

    renderResult(result, _opts, theme, _context) {
      // Background launches carry their result in a follow-up message, so the
      // tool result itself stays invisible. Blocking launches render the
      // agent's result (and usage) inline like a normal tool.
      if ((result.details as any)?.mode !== "blocking") return new Text("", 0, 0);
      const txt = result.content[0];
      const body = txt?.type === "text" ? txt.text : "(done)";
      const icon = result.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      return new Text(icon + theme.fg("muted", body), 0, 0);
    },
  });

  // ── agent_reply tool ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "agent_reply",
    label: "Agent Reply",
    description: "Inject a follow-up user message into a running or stopped background agent (by id from launch_agent). Use it to add instructions or context. It cannot dismiss a guardrails permission prompt or an interactive question — those must be answered by switching to the agent's tmux window. Only works while the agent is still active; once it finishes, its window closes. NOTE: only available to the top-level session — subagents cannot use this tool.",
    promptSnippet: "Send a follow-up message to a running/stopped background subagent",
    parameters: Type.Object({
      id: Type.String({ description: "Agent ID from launch_agent, or the tmux window target shown in the widget (e.g. '0:9')" }),
      message: Type.String({ description: "Message to send to the agent" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;

      if (process.env.PI_SUBAGENT && !process.env.PI_AGENT_SPAWN) {
        return {
          content: [{ type: "text", text: "Error: this subagent is not configured to use agent_reply." }],
          details: {}, isError: true,
        };
      }

      const agent = agents.get(params.id)
        ?? [...agents.values()].find(a => a.windowTarget === params.id);

      if (!agent) {
        return {
          content: [{ type: "text", text: `No agent found with id "${params.id}". Use /agents to list active agents.` }],
          details: {}, isError: true,
        };
      }

      writeFileSync(agent.inboxFile, params.message, { mode: 0o600 });

      // Flip back to running so the widget updates
      if (agent.status === "stopped") {
        agent.status    = "running";
        agent.stopReason = undefined;
        setWidgetForAgent(agent);
      }

      return {
        content: [{ type: "text", text: `Message sent to agent "${agent.name}". It will be injected on the next inbox poll (≤1s).` }],
        details: { id: params.id, windowTarget: agent.windowTarget },
      };
    },

    renderCall(args, theme, _context) {
      const text = new Text("", 0, 0);
      const id  = (args as any).id ?? "…";
      const msg = (args as any).message ?? "…";
      text.setText(
        theme.fg("toolTitle", theme.bold("agent_reply ")) + theme.fg("accent", id) +
        "\n  " + theme.fg("dim", msg.length > 72 ? msg.slice(0, 71) + "…" : msg)
      );
      return text;
    },

    renderResult(result, _opts, theme, _context) {
      const txt = result.content[0];
      const msg = txt?.type === "text" ? txt.text : "(sent)";
      return new Text(
        result.isError ? theme.fg("error", "✗ ") + msg : theme.fg("success", "✓ ") + theme.fg("muted", msg),
        0, 0
      );
    },
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  pi.registerCommand("agents", {
    description: "List all tracked subagents and their current status",
    handler: async (_args, ctx) => {
      if (agents.size === 0) { ctx.ui.notify("No active agents.", "info"); return; }
      const lines = Array.from(agents.values()).map((a) => {
        const icon  = a.status === "running" ? "●" : a.status === "stopped" ? "⚠" : a.status === "done" ? "✓" : "✗";
        const stats = a.usage ? fmtUsage(a.usage) : fmtElapsed(Date.now() - a.startedAt);
        const extra = a.stopReason ? `  — ${a.stopReason}` : "";
        return `${icon}  ${a.name}  [${a.windowTarget}]  ${stats}${extra}\n   id: ${a.id}`;
      });
      ctx.ui.notify(lines.join("\n\n"), "info");
    },
  });

  pi.registerCommand("agents-clear", {
    description: "Remove finished/failed agents from the widget stack",
    handler: async (_args, ctx) => {
      let removed = 0;
      for (const [id, a] of agents) {
        if (a.status !== "running" && a.status !== "stopped") {
          clearWidgetForAgent(id); agents.delete(id); removed++;
        }
      }
      ctx.ui.notify(removed ? `Cleared ${removed} agent${removed > 1 ? "s" : ""}.` : "No finished agents to clear.", removed ? "info" : "info");
    },
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  pi.on("model_select", (event) => {
    currentModelLabel = `${event.model.provider}/${event.model.id}`;
  });

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    // Seed the model label — model_select only fires on changes, so if the
    // extension loads after the model is already set we'd otherwise start empty.
    if (ctx.model) currentModelLabel = `${ctx.model.provider}/${ctx.model.id}`;
    stopTicking();
    for (const id of agents.keys()) clearWidgetForAgent(id);
    agents.clear();
    // Reset widget registration so it binds to the new context on next launch.
    widgetRegistered = false;
    widgetHandle = null;
    cachedLines = [];
    cachedWidth = -1;
  });

  pi.on("session_shutdown", async () => {
    stopTicking();
    latestCtx = null;
  });
}
