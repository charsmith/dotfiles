/**
 * pi-chain — run a declared chain of agents as a deterministic pipe.
 *
 * A chain is a sequence of steps. Each step spawns a pi subagent in a tmux
 * window (via the shared lib/agent-spawn.ts "one link" primitive), waits for it
 * to finish, and feeds its output to the next step as $INPUT:
 *
 *     $INPUT ─▶ step1 ─▶ out1 ─▶ step2 ─▶ out2 ─▶ … ─▶ final
 *
 * A blocking launch_agent already IS one link (spawn → run → return output);
 * run_chain is the deterministic loop over that primitive, so the hand-off
 * can't drift: it owns $INPUT/$ORIGINAL substitution, runs steps strictly in
 * order, and halts on the first error. The whole pipeline is shown live in a
 * flow widget above the editor.
 *
 * Chains are declared in YAML (see lib/mini-yaml.ts for the supported subset):
 *
 *   ~/.config/pi/agents/agent-chain.yaml   (and ./.pi/agents/agent-chain.yaml)
 *
 *   dp-research:
 *     kind: chain
 *     description: "Research a data platform topic end-to-end"
 *     persist: false        # default: tear agents down after the run (one-shot)
 *     clearContext: true    # default: each topic starts on a clean slate
 *     steps:
 *       - agent: dp-researcher
 *         prompt: "$INPUT"
 *       - agent: dp-synthesizer
 *         clearContext: false   # this step remembers prior topics
 *         prompt: |
 *           Synthesize these findings into a knowledge base entry:
 *
 *           $INPUT
 *
 *           Original question: $ORIGINAL
 *
 * Step fields: `agent` (definition name) or `system_prompt` (inline persona);
 * `model` (optional override); `prompt` (template with $INPUT / $ORIGINAL);
 * `clearContext` (per-step override of the chain default).
 *
 * Chain fields: `persist` (keep the team warm between run_chain calls; default
 * false = one-shot) and `clearContext` (default true = fresh context per topic;
 * false = persistent agents that accumulate context across topics). A chain is
 * always a live team — "one-shot" is just persist:false (shut down after the
 * answer). clearContext:false steps stay alive and are fed successive topics via
 * the agent-spawn inbox; per-topic completion is detected by the state file's
 * `seq` counter advancing.
 *
 * Tool:     run_chain (chain?, input)
 * Commands: /chain (set active), /chain-list, /chain-show, /chain-reset,
 *           /chain-down (shut down a warm persistent team)
 *
 * The `kind:` discriminator is shared with team definitions so the YAML can
 * grow into a composition language (a step that is itself a team/chain). Only
 * kind: chain is handled here.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  type AgentDef,
  type AgentState,
  type AgentUsage,
  fmtElapsed,
  fmtUsage,
  isPaneAlive,
  loadAgentDef,
  type SpawnHandle,
  spawnAgentWindow,
  TmuxSpawnError,
  windowForPane,
} from "./lib/agent-spawn.ts";
import { parseYaml } from "./lib/mini-yaml.ts";

// ─── Chain definitions ───────────────────────────────────────────────────────

interface StepDef {
  agent?: string;          // agent definition name (~/.config/pi/agents/<name>.md)
  system_prompt?: string;  // inline persona (alternative to agent)
  model?: string;          // optional per-step model override
  prompt: string;          // template; $INPUT / $ORIGINAL are substituted
  clearContext?: boolean;  // per-step override of the chain-level clearContext
}

interface ChainDef {
  name: string;
  kind: "chain";
  description?: string;
  steps: StepDef[];
  persist: boolean;
  clearContext: boolean;
}

interface TeamMemberDef {
  agent: string;          // references an agent .md file
  role?: string;          // coordinator | specialist | etc.
  description?: string;
  reports_to?: string;
}

interface TeamDef {
  name: string;
  kind: "team";
  description?: string;
  guardrail?: "confirm" | "auto" | "never";
  persist?: boolean;
  topology?: string;      // hub-spoke | mesh | chain | custom
  entry_point?: string;  // agent name that receives the initial task
  members: TeamMemberDef[];
}

function charterDirs(): string[] {
  return [
    path.join(os.homedir(), ".config", "pi", "charters"),
    path.join(process.cwd(), ".pi", "charters"),
  ];
}

// Back-compat: also read the old monolithic agent-chain.yaml if present.
function legacyChainFiles(): string[] {
  return [
    path.join(os.homedir(), ".config", "pi", "agents", "agent-chain.yaml"),
    path.join(process.cwd(), ".pi", "agents", "agent-chain.yaml"),
  ];
}

// Parse a single charter block (raw object) into a ChainDef or TeamDef.
// name = charter name (from filename or YAML key).
function parseCharterBlock(
  name: string, raw: any,
  chains: Map<string, ChainDef>, teams: Map<string, TeamDef>, errors: string[],
) {
  if (!raw || typeof raw !== "object") return;
  if (raw.kind === "chain") {
    if (chains.has(name)) return;
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      errors.push(`chain "${name}": missing or empty steps`); return;
    }
    const steps: StepDef[] = [];
    let ok = true;
    for (let i = 0; i < raw.steps.length; i++) {
      const s = raw.steps[i];
      if (!s || typeof s !== "object" || typeof s.prompt !== "string") {
        errors.push(`chain "${name}" step ${i + 1}: each step needs a "prompt" string`);
        ok = false; break;
      }
      if (!s.agent && !s.system_prompt) {
        errors.push(`chain "${name}" step ${i + 1}: needs "agent" or "system_prompt"`);
        ok = false; break;
      }
      steps.push({
        agent: s.agent, system_prompt: s.system_prompt, model: s.model, prompt: s.prompt,
        clearContext: typeof s.clearContext === "boolean" ? s.clearContext : undefined,
      });
    }
    if (ok) chains.set(name, {
      name, kind: "chain", description: raw.description, steps,
      persist: raw.persist === true,
      clearContext: raw.clearContext !== false,
    });
  } else if (raw.kind === "team") {
    if (teams.has(name)) return;
    if (!Array.isArray(raw.members) || raw.members.length === 0) {
      errors.push(`team "${name}": missing or empty members`); return;
    }
    const members: TeamMemberDef[] = raw.members
      .filter((m: any) => m && typeof m.agent === "string")
      .map((m: any) => ({ agent: m.agent, role: m.role, description: m.description, reports_to: m.reports_to }));
    teams.set(name, {
      name, kind: "team", description: raw.description,
      guardrail: raw.guardrail ?? "confirm",
      persist: raw.persist === true,
      topology: raw.topology ?? "hub-spoke",
      entry_point: raw.entry_point,
      members,
    });
  }
  // unknown kind: silently skip (forward-compat)
}

// Load + validate all charters from:
//   ~/.config/pi/charters/<name>.yaml  (one charter per file, filename = name)
//   .pi/charters/<name>.yaml           (project-local, same format)
//   agent-chain.yaml                   (legacy monolithic, backward-compat)
// First-seen wins on name clash.
function loadCatalog(): { chains: Map<string, ChainDef>; teams: Map<string, TeamDef>; errors: string[] } {
  const chains = new Map<string, ChainDef>();
  const teams  = new Map<string, TeamDef>();
  const errors: string[] = [];

  // Per-file charters (primary format)
  for (const dir of charterDirs()) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml")); }
    catch { continue; }
    for (const f of files) {
      const name = f.replace(/\.ya?ml$/, "");
      let raw: any;
      try { raw = parseYaml(readFileSync(path.join(dir, f), "utf-8")); }
      catch (e: any) { errors.push(`${f}: parse error: ${e?.message ?? e}`); continue; }
      parseCharterBlock(name, raw, chains, teams, errors);
    }
  }

  // Legacy: agent-chain.yaml (multi-charter per file, name = YAML key)
  for (const file of legacyChainFiles()) {
    if (!existsSync(file)) continue;
    let doc: any;
    try { doc = parseYaml(readFileSync(file, "utf-8")); }
    catch (e: any) { errors.push(`${file}: parse error: ${e?.message ?? e}`); continue; }
    if (!doc || typeof doc !== "object") continue;
    for (const [name, raw] of Object.entries<any>(doc)) {
      parseCharterBlock(name, raw, chains, teams, errors);
    }
  }

  return { chains, teams, errors };
}

// Back-compat shim used by existing callers inside pi-chain.ts.
function loadChains(): { chains: Map<string, ChainDef>; errors: string[] } {
  const { chains, errors } = loadCatalog();
  return { chains, errors };
}

// Single-pass $INPUT / $ORIGINAL substitution (safe if the input text itself
// contains a "$INPUT"/"$ORIGINAL" literal).
function fillTemplate(tpl: string, input: string, original: string): string {
  return tpl.replace(/\$(INPUT|ORIGINAL)/g, (_, k) => (k === "INPUT" ? input : original));
}

// ─── Run-time state (for the flow widget) ────────────────────────────────────

// "waiting" = a persistent (warm) step that finished its topic and is idle,
// kept alive for the next one. Rendered as an empty circle so a persistent step
// visibly switches from a filled green circle (running) to an empty one (warm/idle).
type StepStatus = "pending" | "running" | "stopped" | "waiting" | "done" | "error";

interface StepRun {
  label: string;          // agent name or "step N"
  status: StepStatus;
  startedAt?: number;
  elapsedMs?: number;
  usage?: AgentUsage;
  windowTarget?: string;
  note?: string;          // short status note (e.g. stop reason / error)
}

interface ChainRun {
  name: string;
  steps: StepRun[];
  current: number;        // index of the active step
  startedAt: number;
  finishedAt?: number;    // frozen at terminal state so the timer stops ticking
  status: "running" | "done" | "error";
  persist?: boolean;      // chain persists its team between runs
  warm?: boolean;         // a warm (persistent) team is still alive after this run
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Chains spawn agents → only the top-level session orchestrates them.
  if (process.env.PI_SUBAGENT) return;

  let latestCtx: ExtensionContext | null = null;
  let activeChain: string | null = null;   // default chain set via /chain
  let run: ChainRun | null = null;          // the in-progress (or last) run
  let lastRun: ChainRun | null = null;      // retained after auto-dismiss, for /chain-show
  let tick: ReturnType<typeof setInterval> | null = null;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;

  // How long the finished card lingers before it auto-dismisses.
  const DISMISS_AFTER_MS = 10_000;

  // ── Live (persistent) team ───────────────────────────────────────────────
  // A retain-context step (clearContext:false) keeps its agent alive across
  // topics: we spawn once, then feed each new topic via the inbox file and watch
  // the state file's `seq` advance. Members are indexed by step position. The
  // team is kept warm between run_chain calls when the chain has persist:true;
  // otherwise it's torn down as soon as the run returns.
  interface LiveMember { handle: SpawnHandle; lastSeq: number; }
  interface LiveTeam { chainName: string; members: (LiveMember | null)[]; }
  let liveTeam: LiveTeam | null = null;

  function killMember(m: LiveMember | null) {
    if (!m) return;
    if (m.handle.paneId) { try { execSync(`tmux kill-pane -t ${m.handle.paneId}`, { stdio: "ignore" }); } catch {} }
    for (const f of [m.handle.extFile, m.handle.stateFile, m.handle.inboxFile]) {
      try { unlinkSync(f); } catch {}
    }
  }
  function teardownLiveTeam() {
    if (!liveTeam) return;
    for (const m of liveTeam.members) killMember(m);
    liveTeam = null;
  }

  // ── Flow widget ────────────────────────────────────────────────────────────
  let widgetRegistered = false;
  let widgetHandle: { requestRender(): void } | null = null;

  // Two orthogonal cues:
  //   fill  — ● solid = settled (running while active, gray once finished/gone),
  //           ○ hollow = pending-or-idle.
  //   color — green = the agent is ALIVE (working or warm), gray = inactive/gone,
  //           red = stopped/error.
  // So a persistent step reads as a green ● (running) → green ○ (warm/idle), and a
  // one-shot "done" step reads as a gray ● — visibly different from a warm one.
  function stepGlyph(s: StepStatus): string {
    return s === "error" ? "✗"
      : (s === "running" || s === "stopped" || s === "done") ? "●"  // filled
      : "○";                                                        // pending / waiting
  }
  function stepColor(s: StepStatus): string {
    return s === "error" ? "error"
      : s === "stopped" ? "error"      // red ●
      : s === "running" ? "success"    // green ● — alive, working
      : s === "waiting" ? "success"    // green ○ — alive, warm/idle (persistent)
      : s === "done" ? "dim"           // gray ● — finished & gone
      : "dim";                          // gray ○ — pending
  }

  function refreshWidget() {
    const ctx = latestCtx;
    if (!ctx?.hasUI) return;
    if (!run) {
      try { ctx.ui.setWidget("pi-chain", undefined); } catch {}
      widgetRegistered = false; widgetHandle = null;
      return;
    }
    if (!widgetRegistered) {
      widgetRegistered = true;
      ctx.ui.setWidget("pi-chain", (tui, theme) => {
        widgetHandle = tui;
        return {
          render(width: number): string[] {
            if (!run) return [];
            const MAX = 60;
            const inner = Math.max(0, Math.min(width, MAX) - 2);
            const cell = (s: string) => {
              const v = visibleWidth(s);
              return theme.fg("dim", "│") + s + " ".repeat(Math.max(0, inner - v)) + theme.fg("dim", "│");
            };
            const top = theme.fg("dim", "┌" + "─".repeat(inner) + "┐");
            const bot = theme.fg("dim", "└" + "─".repeat(inner) + "┘");

            const headColor = run.status === "error" ? "error" : run.status === "done" ? "success" : "accent";
            const total = run.steps.length;
            const doneCount = run.steps.filter(s => s.status === "done" || s.status === "waiting").length;
            // Timer is frozen at completion (finishedAt) so the card stops changing
            // once the chain is no longer actively running.
            const runElapsed = fmtElapsed((run.finishedAt ?? Date.now()) - run.startedAt);
            const phase = run.status === "running"
              ? `running ${Math.min(run.current + 1, total)}/${total}`
              : run.status === "done"
                ? (run.warm ? `warm ${doneCount}/${total} · /chain-down to stop` : `done ${doneCount}/${total}  ${runElapsed}`)
                : `failed at ${run.current + 1}/${total}`;
            const title = truncateToWidth(`chain: ${run.name} · ${phase}`, inner - 1);

            const lines = [top, cell(" " + theme.fg(headColor, theme.bold(title)))];
            run.steps.forEach((st, i) => {
              const col = stepColor(st.status);
              const glyph = theme.fg(col, stepGlyph(st.status));
              const elapsed = st.status === "running" && st.startedAt
                ? fmtElapsed(Date.now() - st.startedAt)
                : st.elapsedMs != null ? fmtElapsed(st.elapsedMs) : "";
              const stats = st.usage && (st.usage.input || st.usage.output || st.usage.cost)
                ? `↑${tk(st.usage.input)} ↓${tk(st.usage.output)} $${st.usage.cost.toFixed(3)}`
                : "";
              const win = st.status === "running" && st.windowTarget ? `[${st.windowTarget}]` : "";
              const right = [elapsed, stats, win].filter(Boolean).join("  ");
              const rowRaw = `${stepGlyph(st.status)} ${st.label}`;
              const labelW = inner - 2 - visibleWidth(right) - 1;
              const label = truncateToWidth(st.label, Math.max(4, labelW));
              const pad = Math.max(1, inner - 2 - 2 - visibleWidth(label) - visibleWidth(right));
              lines.push(cell(" " + glyph + " " + theme.fg(col, label) + " ".repeat(pad) + theme.fg("dim", right)));
              if (st.note) {
                lines.push(cell("    " + theme.fg("dim", truncateToWidth(st.note.replace(/[\r\n\t]+/g, " "), inner - 5))));
              }
              // pipe connector between steps
              if (i < run.steps.length - 1) lines.push(cell("  " + theme.fg("dim", "│")));
            });
            lines.push(bot);
            return lines;
          },
          invalidate() {},
        };
      });
    }
    widgetHandle?.requestRender();
  }

  function tk(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${n}`;
  }

  function startTick() {
    if (tick) return;
    tick = setInterval(() => refreshWidget(), 1000);
  }
  function stopTick() {
    if (tick) { clearInterval(tick); tick = null; }
  }
  function cancelDismiss() {
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
  }
  // Called when a run reaches a terminal state: stop the live ticker, remember
  // the run so /chain-show can bring it back, and schedule auto-dismiss.
  function scheduleDismiss() {
    stopTick();
    lastRun = run;
    cancelDismiss();
    // A warm (persistent) team stays alive after the run, so its card is a live
    // "team is warm" indicator — leave it up until /chain-down or /chain-reset.
    if (run?.status === "done" && run.warm) return;
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      run = null;
      refreshWidget();
    }, DISMISS_AFTER_MS);
  }

  // ── Run one step: spawn + wait for terminal state ────────────────────────────
  //
  // Reuses the shared spawn primitive, then waits on the same {tmpBase}.state.json
  // contract the launcher uses. No widget/guardrails coupling here — if a step
  // pauses on a guardrails prompt we surface a one-time notification pointing at
  // its window; resolving it there lets the run continue (agent_end → done).

  interface StepResult { output: string; usage?: AgentUsage; isError: boolean; reason?: string; }

  function runStep(step: StepDef, prompt: string, stepRun: StepRun, signal?: AbortSignal): Promise<StepResult> {
    let agentDef: AgentDef | null = null;
    if (step.agent) {
      agentDef = loadAgentDef(step.agent);
      if (!agentDef) {
        return Promise.resolve({ output: "", isError: true, reason: `agent definition "${step.agent}" not found` });
      }
    }

    let handle;
    try {
      handle = spawnAgentWindow({
        name: step.agent || stepRun.label,
        task: prompt,
        model: step.model,
        sessionModel: latestCtx?.model ? { provider: latestCtx.model.provider, id: latestCtx.model.id } : undefined,
        agentDef,
        systemPrompt: step.system_prompt,
      });
    } catch (err: any) {
      const reason = err instanceof TmuxSpawnError ? err.message : (err?.message ?? String(err));
      return Promise.resolve({ output: "", isError: true, reason });
    }

    stepRun.startedAt = handle.startedAt;
    stepRun.windowTarget = handle.windowTarget;
    stepRun.status = "running";
    refreshWidget();

    return new Promise<StepResult>((resolve) => {
      let settled = false;
      let watcher: FSWatcher | undefined;
      let poll: ReturnType<typeof setInterval> | null = null;
      let notifiedStopped = false;

      const cleanup = () => {
        if (poll) clearInterval(poll);
        watcher?.close();
        if (handle.paneId) { try { execSync(`tmux kill-pane -t ${handle.paneId}`, { stdio: "ignore" }); } catch {} }
        for (const f of [handle.extFile, handle.stateFile, handle.inboxFile]) {
          try { unlinkSync(f); } catch {}
        }
      };

      const finish = (res: StepResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      };

      const check = () => {
        if (settled) return;
        // keep the displayed window target fresh (indices shift)
        const live = windowForPane(handle.paneId);
        if (live) stepRun.windowTarget = live;

        if (existsSync(handle.stateFile)) {
          let state: AgentState;
          try { state = JSON.parse(readFileSync(handle.stateFile, "utf-8")); }
          catch { return; }

          if (state.usage) stepRun.usage = state.usage;

          if (state.status === "stopped") {
            stepRun.status = "stopped";
            stepRun.note = state.reason ?? "needs input in its window";
            refreshWidget();
            if (!notifiedStopped) {
              notifiedStopped = true;
              latestCtx?.ui.notify(
                `Chain step "${stepRun.label}" needs input — switch to tmux window ${stepRun.windowTarget}: ${stepRun.note}`,
                "warning",
              );
            }
            return;
          }

          if (state.status === "running" && stepRun.status === "stopped") {
            stepRun.status = "running";
            stepRun.note = undefined;
            refreshWidget();
          }

          if (state.status === "done" || state.status === "error") {
            stepRun.usage = state.usage;
            finish({ output: state.output ?? "", usage: state.usage, isError: state.status === "error" });
            return;
          }
        }

        // Pane died without writing a terminal state → treat as finished.
        if (!isPaneAlive(handle.paneId)) {
          let output = "";
          try {
            const s = JSON.parse(readFileSync(handle.stateFile, "utf-8")) as AgentState;
            output = s.output ?? "";
            stepRun.usage = s.usage ?? stepRun.usage;
          } catch {}
          finish({ output, usage: stepRun.usage, isError: false });
        }
      };

      try { watcher = watch(handle.stateFile, { persistent: false }, () => check()); } catch {}
      poll = setInterval(check, 1000);

      if (signal) {
        if (signal.aborted) finish({ output: "", isError: true, reason: "chain cancelled" });
        else signal.addEventListener("abort", () => finish({ output: "", isError: true, reason: "chain cancelled" }), { once: true });
      }
    });
  }

  // ── Persistent (retain-context) step ─────────────────────────────────────────
  //
  // The agent stays alive across topics. First topic spawns it (persistent:true)
  // and the warm-up task IS the first topic; later topics are written to the
  // inbox file. Either way we wait for the state file's `seq` to advance past the
  // value it held before this topic — that's the per-topic completion edge.
  //
  // Returns the (possibly newly spawned) member so the caller can stash it in the
  // live team; member is null if the pane died and the slot should be recycled.
  function runPersistentStep(
    step: StepDef,
    prompt: string,
    stepRun: StepRun,
    member: LiveMember | null,
    signal?: AbortSignal,
  ): Promise<{ result: StepResult; member: LiveMember | null }> {
    if (!member) {
      let agentDef: AgentDef | null = null;
      if (step.agent) {
        agentDef = loadAgentDef(step.agent);
        if (!agentDef) return Promise.resolve({ result: { output: "", isError: true, reason: `agent definition "${step.agent}" not found` }, member: null });
      }
      let handle;
      try {
        handle = spawnAgentWindow({
          name: step.agent || stepRun.label,
          task: prompt,
          persistent: true,
          model: step.model,
          sessionModel: latestCtx?.model ? { provider: latestCtx.model.provider, id: latestCtx.model.id } : undefined,
          agentDef,
          systemPrompt: step.system_prompt,
        });
      } catch (err: any) {
        const reason = err instanceof TmuxSpawnError ? err.message : (err?.message ?? String(err));
        return Promise.resolve({ result: { output: "", isError: true, reason }, member: null });
      }
      member = { handle, lastSeq: 0 };
      stepRun.startedAt = handle.startedAt;
      stepRun.windowTarget = handle.windowTarget;
    } else {
      // Reuse: hand the next topic to the live agent via its inbox.
      stepRun.startedAt = Date.now();
      stepRun.windowTarget = windowForPane(member.handle.paneId) ?? member.handle.windowTarget;
      try { writeFileSync(member.handle.inboxFile, prompt, { mode: 0o600 }); }
      catch (err: any) { return Promise.resolve({ result: { output: "", isError: true, reason: `failed to message agent: ${err?.message ?? err}` }, member }); }
    }
    stepRun.status = "running";
    refreshWidget();

    const m = member;
    const targetSeq = m.lastSeq + 1;

    return new Promise((resolve) => {
      let settled = false;
      let watcher: FSWatcher | undefined;
      let poll: ReturnType<typeof setInterval> | null = null;
      let notifiedStopped = false;

      const finish = (result: StepResult, liveMember: LiveMember | null) => {
        if (settled) return;
        settled = true;
        if (poll) clearInterval(poll);
        watcher?.close();
        resolve({ result, member: liveMember });
      };

      const check = () => {
        if (settled) return;
        const live = windowForPane(m.handle.paneId);
        if (live) stepRun.windowTarget = live;

        if (existsSync(m.handle.stateFile)) {
          let state: AgentState;
          try { state = JSON.parse(readFileSync(m.handle.stateFile, "utf-8")); }
          catch { return; }

          if (state.usage) stepRun.usage = state.usage;

          if (state.status === "stopped") {
            stepRun.status = "stopped";
            stepRun.note = state.reason ?? "needs input in its window";
            refreshWidget();
            if (!notifiedStopped) {
              notifiedStopped = true;
              latestCtx?.ui.notify(
                `Chain step "${stepRun.label}" needs input — switch to tmux window ${stepRun.windowTarget}: ${stepRun.note}`,
                "warning",
              );
            }
            return;
          }
          if (state.status === "running" && stepRun.status === "stopped") {
            stepRun.status = "running";
            stepRun.note = undefined;
            refreshWidget();
          }

          // Per-topic completion: seq advanced past where it was before we sent.
          if ((state.seq ?? 0) >= targetSeq) {
            m.lastSeq = state.seq ?? targetSeq;
            stepRun.usage = state.usage;
            finish({ output: state.output ?? "", usage: state.usage, isError: state.status === "error" }, m);
            return;
          }
        }

        // Pane died → drop the member so its slot gets re-spawned next time.
        if (!isPaneAlive(m.handle.paneId)) {
          let output = "";
          try {
            const s = JSON.parse(readFileSync(m.handle.stateFile, "utf-8")) as AgentState;
            output = s.output ?? "";
            stepRun.usage = s.usage ?? stepRun.usage;
          } catch {}
          finish({ output, usage: stepRun.usage, isError: false }, null);
        }
      };

      try { watcher = watch(m.handle.stateFile, { persistent: false }, () => check()); } catch {}
      poll = setInterval(check, 1000);

      if (signal) {
        // On cancel, kill the agent and drop the member: a cancelled topic may
        // still finish and bump `seq`, which would desync the next topic's
        // wait. Recycling the slot (member:null) forces a clean respawn.
        const onAbort = () => { killMember(m); finish({ output: "", isError: true, reason: "chain cancelled" }, null); };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  // ── run_chain tool ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "run_chain",
    label: "Run Chain",
    description: [
      "Run a declared chain of agents as a deterministic pipe: each step is a",
      "subagent whose output becomes the next step's $INPUT ($ORIGINAL is always",
      "the original input). Steps run in order in tmux windows and the chain halts",
      "on the first error. Use this for staged multi-agent work (e.g. research →",
      "synthesize → write). Chains are declared in ~/.config/pi/agents/agent-chain.yaml;",
      "see /chain-list for available chains. Returns the final step's output.",
    ].join(" "),
    promptSnippet: "Run a declared agent chain (output of each step pipes to the next)",
    parameters: Type.Object({
      chain: Type.Optional(Type.String({
        description: "Name of the chain to run (from agent-chain.yaml). Defaults to the active chain set via /chain.",
      })),
      input: Type.String({ description: "Input for the first step ($INPUT for step 1, and $ORIGINAL throughout)." }),
    }),

    async execute(_id, params, signal, _onUpdate, ctx) {
      latestCtx = ctx;

      if (process.env.PI_SUBAGENT && !process.env.PI_AGENT_SPAWN) {
        return { content: [{ type: "text", text: "Error: subagents cannot run chains." }], details: {}, isError: true };
      }

      const { chains, errors } = loadChains();
      const name = params.chain || activeChain;
      if (!name) {
        const avail = [...chains.keys()].join(", ") || "(none defined)";
        return { content: [{ type: "text", text: `No chain specified and no active chain set. Use /chain or pass "chain". Available: ${avail}` }], details: {}, isError: true };
      }
      const def = chains.get(name);
      if (!def) {
        const avail = [...chains.keys()].join(", ") || "(none defined)";
        const errNote = errors.length ? `\nDefinition errors: ${errors.join("; ")}` : "";
        return { content: [{ type: "text", text: `Chain "${name}" not found. Available: ${avail}${errNote}` }], details: {}, isError: true };
      }

      // Reuse a warm team only if it's for this same chain; otherwise tear the
      // stale one down before starting.
      if (liveTeam && liveTeam.chainName !== def.name) teardownLiveTeam();
      if (!liveTeam) liveTeam = { chainName: def.name, members: def.steps.map(() => null) };
      const team = liveTeam;

      // Build the run + widget.
      cancelDismiss();
      run = {
        name: def.name,
        steps: def.steps.map((s, i) => ({ label: s.agent || s.system_prompt ? (s.agent || `step ${i + 1}`) : `step ${i + 1}`, status: "pending" as StepStatus })),
        current: 0,
        startedAt: Date.now(),
        status: "running",
        persist: !!def.persist,
      };
      refreshWidget();
      startTick();

      const original = params.input;
      let input = params.input;
      let finalOutput = "";

      try {
        for (let i = 0; i < def.steps.length; i++) {
          run.current = i;
          const step = def.steps[i];
          const stepRun = run.steps[i];
          const prompt = fillTemplate(step.prompt, input, original);

          // clearContext (default true) → ephemeral spawn-and-kill per topic.
          // clearContext:false → persistent agent reused across topics.
          const clearCtx = step.clearContext ?? def.clearContext;
          // A persistent step in a persisted chain stays warm between runs → it
          // ends a topic in "waiting" (empty circle) rather than "done".
          const stepWarm = !clearCtx && !!def.persist;
          let res: StepResult;
          if (clearCtx) {
            res = await runStep(step, prompt, stepRun, signal);
          } else {
            const r = await runPersistentStep(step, prompt, stepRun, team.members[i], signal);
            team.members[i] = r.member;
            res = r.result;
          }

          if (res.isError) {
            stepRun.status = "error";
            stepRun.note = res.reason || "step failed";
            stepRun.elapsedMs = stepRun.startedAt ? Date.now() - stepRun.startedAt : undefined;
            run.status = "error";
            run.finishedAt = Date.now();
            refreshWidget();
            if (!def.persist) teardownLiveTeam();
            scheduleDismiss();
            const summary = res.usage ? `  ${fmtUsage(res.usage)}` : "";
            const detail = res.output ? `\n\n${res.output}` : "";
            return {
              content: [{ type: "text", text: `Chain "${def.name}" failed at step ${i + 1} (${stepRun.label}): ${stepRun.note}${summary}${detail}` }],
              details: { chain: def.name, failedStep: i + 1 },
              isError: true,
            };
          }

          stepRun.status = stepWarm ? "waiting" : "done";
          stepRun.note = stepWarm ? "warm — awaiting next topic" : undefined;
          stepRun.elapsedMs = stepRun.startedAt ? Date.now() - stepRun.startedAt : undefined;
          refreshWidget();
          input = res.output;
          finalOutput = res.output;
        }
      } catch (err: any) {
        run.status = "error";
        run.finishedAt = Date.now();
        refreshWidget();
        if (!def.persist) teardownLiveTeam();
        scheduleDismiss();
        return { content: [{ type: "text", text: `Chain "${def.name}" errored: ${err?.message ?? err}` }], details: {}, isError: true };
      }

      run.status = "done";
      run.current = def.steps.length - 1;
      run.finishedAt = Date.now();
      // Warm when the chain persists and at least one member is still alive.
      run.warm = !!def.persist && !!liveTeam && liveTeam.members.some(m => m !== null);
      refreshWidget();
      // persist:false → one-shot: shut the agents down now we have the answer.
      // persist:true → leave them warm for the next run_chain of this chain.
      if (!def.persist) teardownLiveTeam();
      scheduleDismiss();

      return {
        content: [{ type: "text", text: `Chain "${def.name}" completed ${def.steps.length} step${def.steps.length > 1 ? "s" : ""}${def.persist ? " (team kept warm — /chain-down to stop)" : ""}.\n\n${finalOutput || "(no output)"}` }],
        details: { chain: def.name, steps: def.steps.length, persist: def.persist },
      };
    },

    renderResult(result, _opts, theme) {
      const txt = result.content[0];
      const body = txt?.type === "text" ? txt.text : "(done)";
      const icon = result.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      return new Text(icon + theme.fg("muted", body), 0, 0);
    },
  });

  // ── Commands ─────────────────────────────────────────────────────────────────

  pi.registerCommand("ag:chain", {
    description: "Set the active chain (pick from agent-chain.yaml).",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const { chains, errors } = loadChains();
      if (chains.size === 0) {
        ctx.ui.notify(`No chains defined.${errors.length ? " Errors: " + errors.join("; ") : " Add some to ~/.config/pi/agents/agent-chain.yaml."}`, "warning");
        return;
      }
      const arg = (args ?? "").trim();
      if (arg) {
        if (!chains.has(arg)) { ctx.ui.notify(`Chain "${arg}" not found. Available: ${[...chains.keys()].join(", ")}`, "warning"); return; }
        activeChain = arg;
        ctx.ui.notify(`Active chain set to "${arg}".`, "info");
        return;
      }
      const names = [...chains.keys()];
      const choice = await ctx.ui.select("Select the active chain", names);
      if (choice) { activeChain = choice; ctx.ui.notify(`Active chain set to "${choice}".`, "info"); }
    },
  });

  pi.registerCommand("ag:chains", {
    description: "List all defined chains and their steps.",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      const { chains, errors } = loadChains();
      if (chains.size === 0 && errors.length === 0) { ctx.ui.notify("No chains defined. Add some to ~/.config/pi/agents/agent-chain.yaml.", "info"); return; }
      const blocks = [...chains.values()].map(c => {
        const star = c.name === activeChain ? " ★" : "";
        const steps = c.steps.map((s, i) => `   ${i + 1}. ${s.agent || "(inline)"}`).join("\n");
        return `${c.name}${star}${c.description ? ` — ${c.description}` : ""}\n${steps}`;
      });
      const errNote = errors.length ? `\n\nErrors:\n${errors.map(e => " - " + e).join("\n")}` : "";
      ctx.ui.notify(blocks.join("\n\n") + errNote, errors.length ? "warning" : "info");
    },
  });

  pi.registerCommand("ag:chain-down", {
    description: "Shut down the warm (persistent) chain team, if any.",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      if (!liveTeam || liveTeam.members.every(m => m === null)) {
        ctx.ui.notify("No warm chain team to shut down.", "info");
        return;
      }
      const n = liveTeam.members.filter(m => m !== null).length;
      const chainName = liveTeam.chainName;
      teardownLiveTeam();
      // The warm card is a "team is alive" indicator — drop it now the team is gone.
      if (run?.warm) { run = null; stopTick(); cancelDismiss(); refreshWidget(); }
      ctx.ui.notify(`Shut down ${n} agent${n > 1 ? "s" : ""} from chain "${chainName}".`, "info");
    },
  });

  pi.registerCommand("ag:chain-reset", {
    description: "Clear the current chain run from the flow widget.",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      run = null;
      lastRun = null;
      stopTick();
      cancelDismiss();
      refreshWidget();
      ctx.ui.notify("Chain widget cleared.", "info");
    },
  });

  pi.registerCommand("ag:chain-show", {
    description: "Re-show the last chain run's flow widget after it auto-dismissed.",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      if (!run && !lastRun) { ctx.ui.notify("No chain run to show yet.", "info"); return; }
      if (!run) run = lastRun;
      cancelDismiss();
      // If it's still running, resume the live ticker; otherwise leave it static.
      if (run && run.status === "running") startTick();
      refreshWidget();
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    run = null;
    lastRun = null;
    widgetRegistered = false;
    widgetHandle = null;
    stopTick();
    cancelDismiss();
    teardownLiveTeam();
  });

  pi.on("session_shutdown", async () => {
    stopTick();
    cancelDismiss();
    teardownLiveTeam();
    latestCtx = null;
  });
}
