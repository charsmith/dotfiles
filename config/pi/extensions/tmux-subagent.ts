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

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Shared spawn/IPC primitive — the "one link" both this extension and
// pi-chain.ts build on. See lib/agent-spawn.ts.
import {
  type AgentDef,
  type AgentPrompt,
  type AgentState,
  type AgentUsage,
  fmtElapsed,
  fmtTokens,
  fmtUsage,
  isPaneAlive,
  loadAgentDef,
  sanitizeAgentName,
  sendKeysToPane,
  shortModelName,
  spawnAgentWindow,
  TmuxSpawnError,
  windowForPane,
} from "./lib/agent-spawn.ts";

// ─── Types (caller-specific) ─────────────────────────────────────────────────

type AgentMode = "blocking" | "background" | "team";

// Display status shown in the widget — extends wire AgentStatus with a
// 'working' alias used for team members so they read differently from solo agents.
type DisplayStatus = "running" | "working" | "idle" | "stopped" | "completed" | "done" | "error";

interface AgentEntry {
  id: string;
  name: string;
  windowName: string;
  task: string;
  mode: AgentMode;
  isCoordinator?: boolean;   // designated coordinator of a team
  teamProject?: string;      // coms-bus project name (set for team members)
  workDir?: string;          // work directory for coordinator agents
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

// ─── Extension ─────────────────────────────────────────────────────────────

// ─── Agent-teams config + coordinator helpers ────────────────────────────────

function agentTeamsWorkdir(): string {
  const cfgPath = path.join(os.homedir(), ".config", "pi", "agent-teams.json");
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const wd  = typeof raw.workdir === "string" ? raw.workdir : "~/code/agent-teams";
    return wd.replace(/^~/, os.homedir());
  } catch {
    return path.join(os.homedir(), "code", "agent-teams");
  }
}

function makeUnitOfWorkId(task: string): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const ts  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-` +
              `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // Use first non-empty line only — keeps the slug short and readable
  const firstLine = task.split("\n").map(l => l.trim()).find(l => l.length > 0) ?? task;
  const slug = firstLine.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `${ts}-${slug}` : ts;
}

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

  // Model label, tmux session/pane helpers, and pane liveness now live in
  // lib/agent-spawn.ts (shortModelName, currentTmuxSession, windowForPane,
  // isPaneAlive, sendKeysToPane) — imported above.

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

  function displayStatus(agent: AgentEntry): DisplayStatus {
    if (agent.status === "running" && agent.mode === "team") return "working";
    return agent.status as DisplayStatus;
  }

  function renderCard(agent: AgentEntry, inner: number, theme: any): string[] {
    const ds = displayStatus(agent);
    // cardColor drives the border and name — stays accent while alive so the
    // card doesn't go visually dead just because an agent is between turns.
    const cardColor: any =
      ds === "running" || ds === "working" || ds === "idle" ? "accent"
      : ds === "stopped"   ? "warning"
      : ds === "completed" ? "success"
      : ds === "done"      ? "success"
      :                      "error";
    // statusColor drives only the icon + status label line.
    const statusColor: any =
      ds === "running" || ds === "working" ? "accent"
      : ds === "idle"      ? "dim"
      : ds === "stopped"   ? "warning"
      : ds === "completed" ? "success"
      : ds === "done"      ? "success"
      :                      "error";

    const icon =
      ds === "running" || ds === "working" ? "●"
      : ds === "idle"      ? "◦"
      : ds === "stopped"   ? "⚠"
      : ds === "completed" ? "✓"
      : ds === "done"      ? "✓"
      :                      "✗";

    const cell = (styled: string): string => {
      const vis = visibleWidth(styled);
      return (
        theme.fg(cardColor, "│") +
        styled +
        " ".repeat(Math.max(0, inner - vis)) +
        theme.fg(cardColor, "│")
      );
    };

    // Line 1: name · model  [coordinator badge if applicable]
    const coordBadge  = agent.isCoordinator ? " [coordinator]" : "";
    const safeName    = agent.name.replace(/[\r\n\t]+/g, " ").trim();
    const rawNameModel = safeName + coordBadge + (agent.model ? ` · ${agent.model}` : "");
    const trunc        = truncateToWidth(rawNameModel, inner - 1);
    const dotIdx       = trunc.indexOf(" · ");
    const nameStyled   = dotIdx >= 0
      ? theme.fg(cardColor, theme.bold(trunc.slice(0, dotIdx))) +
        theme.fg("dim", trunc.slice(dotIdx))
      : theme.fg(cardColor, theme.bold(trunc));

    // Line 2: status indicator + pane ref + elapsed (or stop reason)
    const elapsed    = fmtElapsed(Date.now() - agent.startedAt);
    const u          = agent.usage;
    const liveStats  = u && (u.turns || u.input || u.output || u.cost)
      ? `↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)}  $${u.cost.toFixed(3)}  ${elapsed}`
      : elapsed;
    const safeReason = agent.stopReason?.replace(/[\r\n\t]+/g, " ").trim();
    // Pad the status label to a fixed width so the window target and stats
    // don't shift when transitioning between labels of different lengths
    // (e.g. "idle" ↔ "working" ↔ "running").
    const STATUS_WIDTH = 9; // length of "completed", the longest label
    const statusLabel = (ds === "completed" ? "completed" : ds).padEnd(STATUS_WIDTH);
    const rawStatus  = ds === "stopped" && safeReason
      ? `${icon} ${'stopped'.padEnd(STATUS_WIDTH)}  [${agent.windowTarget}]  ${safeReason}`
      : `${icon} ${statusLabel}  [${agent.windowTarget}]  ${liveStats}`;
    const statusText = truncateToWidth(rawStatus, inner - 1);

    // Line 3: task text — collapse newlines/control chars so the cell stays
    // on a single terminal line (LLMs often pass multi-line task strings).
    const flatTask = agent.task.replace(/[\r\n\t]+/g, " ").trim();
    const taskText = truncateToWidth(flatTask, inner - 1);

    const top = theme.fg(cardColor, "┌" + "─".repeat(inner) + "┐");
    const bot = theme.fg(cardColor, "└" + "─".repeat(inner) + "┘");

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

      // Coordinator finished the unit of work — output.md was written.
      // Deliver a single clean follow-up with the report content.
      if (state.status === "completed" && agent.status !== "completed") {
        agent.status = "completed";
        agent.model  = state.model ? shortModelName(state.model) : agent.model;
        agent.usage  = state.usage;
        setWidgetForAgent(agent);
        const workDir = agent.workDir ?? state.workDir;
        let reportContent = "(no report written)";
        if (workDir) {
          try { reportContent = readFileSync(path.join(workDir, "output.md"), "utf-8").trim(); } catch {}
        }
        const usageLine  = agent.usage ? fmtUsage(agent.usage) : "";
        const reportPath = workDir ? path.join(workDir, "output.md") : "(unknown)";
        pi.sendMessage({
          customType: "coordinator-complete",
          content: [
            `Coordinator "${agent.name}" completed (${usageLine}).`,
            `Report: ${reportPath}`,
            "",
            reportContent.slice(0, 2000),
            reportContent.length > 2000 ? "\n\n…(truncated — read the full report at the path above)" : "",
          ].join("\n").trimEnd(),
          display: true,
        }, { deliverAs: "followUp", triggerTurn: true });
        // Collect usage across all team members before teardown, then write info.md.
        if (agent.workDir) {
          try {
            const rows: { name: string; model: string | undefined; usage: AgentUsage | undefined }[] = [
              { name: agent.name, model: agent.model, usage: state.usage ?? agent.usage },
            ];
            if (agent.teamProject) {
              for (const [, member] of agents) {
                if (member !== agent && member.teamProject === agent.teamProject) {
                  rows.push({ name: member.name, model: member.model, usage: member.usage });
                }
              }
            }
            const totals = rows.reduce(
              (acc, r) => ({
                turns:  acc.turns  + (r.usage?.turns  ?? 0),
                input:  acc.input  + (r.usage?.input  ?? 0),
                output: acc.output + (r.usage?.output ?? 0),
                cost:   acc.cost   + (r.usage?.cost   ?? 0),
              }),
              { turns: 0, input: 0, output: 0, cost: 0 },
            );
            const tableRows = rows.map(r => {
              const u = r.usage;
              return `| ${r.name} | ${r.model ?? ""} | ${u?.turns ?? 0} | ${fmtTokens(u?.input ?? 0)} | ${fmtTokens(u?.output ?? 0)} | $${(u?.cost ?? 0).toFixed(3)} |`;
            }).join("\n");
            const elapsed = fmtElapsed(Date.now() - agent.startedAt);
            const info = [
              `# Team Run Info`,
              ``,
              `**Team:** ${agent.teamProject ?? "(ad-hoc)"}`,
              `**Unit of work:** ${path.basename(agent.workDir)}`,
              `**Completed:** ${new Date().toISOString()}`,
              `**Wall time:** ${elapsed}`,
              ``,
              `## Cost`,
              ``,
              `| Agent | Model | Turns | Input | Output | Cost |`,
              `|-------|-------|-------|-------|--------|------|`,
              tableRows,
              `| **Total** | | **${totals.turns}** | **${fmtTokens(totals.input)}** | **${fmtTokens(totals.output)}** | **$${totals.cost.toFixed(3)}** |`,
            ].join("\n");
            writeFileSync(path.join(agent.workDir, "info.md"), info, "utf-8");
          } catch { /* ignore — don't let info.md failure block teardown */ }
        }

        // Tear down all other tracked team members, then the coordinator.
        if (agent.teamProject) {
          for (const [, member] of agents) {
            if (member !== agent && member.teamProject === agent.teamProject) {
              cleanupAgent(member);
            }
          }
        }
        finishAgent(agent, state.output, false);
        return;
      }

      // Persistent agent finished a turn → now idle. Update the widget silently.
      // Workers and coordinators are both silent on idle — only completed fires a follow-up.
      if (state.status === "idle" && agent.status === "running") {
        agent.status = "idle";
        agent.model  = state.model ? shortModelName(state.model) : agent.model;
        agent.usage  = state.usage;
        setWidgetForAgent(agent);
        return;
      }

      // Idle → running again (new coms message arrived)
      if (state.status === "running" && agent.status === "idle") {
        agent.status = "running";
        agent.model  = state.model ? shortModelName(state.model) : agent.model;
        setWidgetForAgent(agent);
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
    if ((agent.status === "running" || agent.status === "idle" || agent.status === "completed") && !isPaneAlive(agent.paneId)) {
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
    if (!Array.from(agents.values()).some(a => a.status === "running" || a.status === "stopped" || a.status === "idle")) {
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

    // Persistent team members do their real work over coms; their final text (if
    // any) already went back to the asker that way. When such a member exits
    // (typically a /team-down or coms_shutdown teardown, or a manual kill), a
    // "finished" follow-up is just confusing duplicate noise — so suppress it by
    // default and surface only a quiet toast.
    if (agent.mode === "team") {
      try { latestCtx?.ui?.notify?.(`Team member "${agent.name}" exited.`, "info"); } catch { /* ignore */ }
      return;
    }

    // Background launch: deliver as a follow-up message to the parent thread.
    pi.sendMessage({
      customType: "subagent-result",
      content: resultText,
      display: true,
    }, { deliverAs: "followUp", triggerTurn: true });
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
      coordinator: Type.Optional(Type.Boolean({
        description:
          "Mark this team member as the coordinator. When it finishes a turn, its output is " +
          "delivered as a follow-up to the main thread. Workers are always silent.",
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

      // Load the agent definition first so a bad name errors before we spawn.
      let agentDef: AgentDef | null = null;
      if (params.agent) {
        agentDef = loadAgentDef(params.agent);
        if (!agentDef) {
          return {
            content: [{ type: "text", text: `Agent definition "${params.agent}" not found in ~/.config/pi/agents/ or ~/.pi/agents/` }],
            details: {}, isError: true,
          };
        }
      }

      // Team members auto-join the coms-bus via env vars (coms-bus.ts activates
      // on PI_COMS_PROJECT/PI_COMS_CNAME). The cname must match the window's
      // safeName, so derive both with the shared sanitizeAgentName().
      const safeName = sanitizeAgentName(params.name);
      const extraEnv: Record<string, string> = {};
      let coordinatorWorkDir: string | undefined;
      if (isTeam) {
        extraEnv.PI_COMS_PROJECT = params.team!;
        extraEnv.PI_COMS_CNAME   = safeName;
        const purpose = (agentDef?.description || params.system_prompt || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 100);
        if (purpose) extraEnv.PI_COMS_PURPOSE = purpose;
        if (process.env.PI_COMS_BUS_DIR) extraEnv.PI_COMS_BUS_DIR = process.env.PI_COMS_BUS_DIR;

        if (params.coordinator) {
          const workdir = agentTeamsWorkdir();
          const unitId  = makeUnitOfWorkId(params.task);
          coordinatorWorkDir = path.join(workdir, params.team!, unitId);
          mkdirSync(coordinatorWorkDir, { recursive: true });
          writeFileSync(path.join(coordinatorWorkDir, "input.md"), params.task, "utf-8");
          extraEnv.PI_COORDINATOR = "1";
          extraEnv.PI_WORK_DIR    = coordinatorWorkDir;
        }
      }

      // Spawn the window + wire the IPC via the shared "one link" primitive.
      let handle;
      try {
        handle = spawnAgentWindow({
          name: params.name,
          task: params.task,
          persistent: isTeam,
          model: params.model,
          sessionModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
          agentDef,
          systemPrompt: params.system_prompt,
          extraEnv,
          coordinatorWorkDir,
        });
      } catch (err: any) {
        const text = err instanceof TmuxSpawnError
          ? `Error: launch_agent ${err.message}`
          : `Error: failed to launch agent: ${(err as Error).message}`;
        return { content: [{ type: "text", text }], details: {}, isError: true };
      }

      const { id, windowName, windowTarget, paneId, extFile, stateFile, inboxFile, startedAt } = handle;

      const agent: AgentEntry = {
        id, name: params.name, windowName,
        task: isTeam ? `[team:${params.team}] ${params.task}` : params.task,
        mode: effectiveMode,
        windowTarget, paneId, extFile, stateFile, inboxFile,
        status: "running", startedAt,
        model: handle.modelLabel,
        isCoordinator: isTeam && params.coordinator === true,
        teamProject: isTeam ? params.team : undefined,
        workDir: coordinatorWorkDir,
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

      if (!context.argsComplete) {
        // LLM is still streaming the tool call parameters — show a composing
        // indicator so it's clear the agent hasn't launched yet.
        const nameHint = args.name ? theme.fg("accent", args.name) + "  " : "";
        const taskPreview = task.length > 55 ? task.slice(0, 54) + "…" : task;
        text.setText(
          theme.fg("dim", "→ ") + theme.fg("toolTitle", theme.bold("launch_agent ")) +
          nameHint + theme.fg("warning", "⟳ composing…") +
          "\n  " + theme.fg("dim", taskPreview)
        );
      } else {
        text.setText(
          theme.fg("accent", "→ ") + theme.fg("toolTitle", theme.bold("launch_agent ")) +
          theme.fg("accent", name) + theme.fg("dim", modelTag) +
          "\n  " + theme.fg("dim", task.length > 72 ? task.slice(0, 71) + "…" : task)
        );
      }
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

  pi.registerCommand("ag:agents", {
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

  pi.registerCommand("ag:agents-clear", {
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
