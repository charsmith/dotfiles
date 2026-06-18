/**
 * coms-bus — peer-to-peer messaging bus between pi agents (file-IPC substrate)
 *
 * A standalone messaging layer so an orchestrator can build a *team* of agents
 * (e.g. one expert per tool + an architect), ask them questions, answer their
 * questions back, and let the group collaborate. Deliberately separate from
 * tmux-subagent.ts so the spawn/visibility layer can change (e.g. go headless)
 * without touching messaging.
 *
 * Every agent that loads this extension joins a *project* namespace (the team)
 * and becomes addressable by name. Messaging is fully bidirectional and
 * peer-to-peer: orchestrator→expert, expert→orchestrator, expert↔expert.
 *
 * ── Async-first (important) ────────────────────────────────────────────────
 * coms_send defaults to NON-blocking: it returns a msg_id immediately and the
 * reply arrives later as a follow-up message (same mechanism as a background
 * subagent result). This avoids a genuine deadlock: if an orchestrator BLOCKS
 * awaiting expert A, and A asks the orchestrator a sub-question, both wait
 * forever. Async delivery lets turns interleave. `wait: true` is offered as a
 * blocking convenience for simple leaf calls (documented caveat).
 *
 * ── Substrate (file-IPC, swappable) ─────────────────────────────────────────
 * Everything under the "SUBSTRATE" banner is file-based and is the only part
 * that changes when we move to Redis later. Layout under ~/.pi/coms-bus/:
 *   projects/<project>/agents/<name>.json     registry entry (presence)
 *   projects/<project>/inbox/<name>/<ulid>.json   one file per message
 * Each agent watches ONLY its own inbox dir (1 fs.watch + 1s tick fallback) so
 * watchers scale linearly, never quadratically. Per-message files (atomic
 * write-temp-then-rename) avoid concurrent-writer corruption. Presence is
 * pruned by PID liveness. Practical envelope: dozens of agents on one host.
 *
 * Identity flags (pi owns --name, so we use --cname):
 *   --cname <name>      addressable name (env PI_COMS_CNAME)
 *   --purpose <text>    one-line role (env PI_COMS_PURPOSE)
 *   --project <name>    team namespace, default "default" (env PI_COMS_PROJECT)
 *   --explicit          hide from auto-discovery / broadcast (only direct-addressable)
 *
 * Tools:    coms_list, coms_send, coms_broadcast, coms_poll, coms_shutdown
 * Command:  /coms  (refresh + inspect the team pool)
 *
 * Usage:  pi -e extensions/coms-bus.ts --cname architect --project kb-change
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  unlinkSync, watch, writeFileSync,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const BUS_DIR = process.env.PI_COMS_BUS_DIR || path.join(os.homedir(), ".pi", "coms-bus");
const MAX_HOPS = Number(process.env.PI_COMS_BUS_MAX_HOPS) || 5;
const HEARTBEAT_MS = Number(process.env.PI_COMS_BUS_HEARTBEAT_MS) || 10_000;
const STALE_MS = Number(process.env.PI_COMS_BUS_STALE_MS) || 30_000;
const WAIT_TIMEOUT_MS = Number(process.env.PI_COMS_BUS_TIMEOUT_MS) || 1_800_000; // 30m
const TICK_MS = 1_000;

const FALLBACK_PALETTE = [
  "#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
  "#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type MessageKind = "prompt" | "response" | "control";

interface Message {
  kind: MessageKind;
  msg_id: string;
  group_id: string | null;
  from_session: string;
  from_name: string;
  from_cwd: string;
  to_name: string;
  hops: number;
  ts: string;
  // prompt
  prompt?: string;
  conversation_id?: string | null;
  response_schema?: object | null;
  // response
  response?: unknown;
  error?: string | null;
  // control (kind === "control")
  control?: "shutdown";
  reason?: string;
}

interface RegistryEntry {
  session_id: string;
  name: string;
  purpose: string;
  model: string;
  color: string;
  pid: number;
  cwd: string;
  project: string;
  explicit: boolean;
  started_at: string;
  heartbeat_at: string;
  context_used_pct: number;
  queue_depth: number;
}

interface Identity {
  session_id: string;
  name: string;
  purpose: string;
  model: string;
  color: string;
  project: string;
  explicit: boolean;
  cwd: string;
}

// An inbound prompt we're currently servicing (drives hop inheritance + reply).
interface Inbound {
  msg_id: string;
  group_id: string | null;
  from_name: string;
  from_session: string;
  hops: number;
  response_schema: object | null;
}

// A reply we're waiting on (from a coms_send / coms_broadcast we issued).
interface Pending {
  msg_id: string;
  group_id: string | null;
  target_name: string;
  created_at: string;
  result?: { response?: unknown; error?: string | null };
  resolve: (v: { response?: unknown; error?: string | null }) => void;
  promise: Promise<{ response?: unknown; error?: string | null }>;
  consumed: boolean; // true once returned via wait:true (suppresses followUp)
}

// ━━ Small utilities ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function nowIso(): string { return new Date().toISOString(); }

// Monotonic-ish id: timestamp (sortable) + random suffix. Used for msg ids and
// inbox filenames so per-message files sort FIFO.
function ulid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isValidHex(s: string | undefined): s is string {
  return !!s && /^#[0-9a-fA-F]{6}$/.test(s);
}

function fallbackColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

function shortModel(model: string): string {
  const slash = model.indexOf("/");
  let id = slash >= 0 ? model.slice(slash + 1) : model;
  for (const p of ["claude-", "gemini-", "gpt-"]) {
    if (id.startsWith(p)) { id = id.slice(p.length); break; }
  }
  return id;
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; } // EPERM = exists, not ours
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SUBSTRATE (file-IPC) — the only section that changes for the Redis swap.
// Public surface used by the rest of the extension:
//   ensureDirs, writeRegistry, removeRegistry, listLiveAgents, resolveTarget,
//   deliverMessage, drainInbox, watchInbox
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function projectDir(project: string): string {
  return path.join(BUS_DIR, "projects", project);
}
function agentsDir(project: string): string {
  return path.join(projectDir(project), "agents");
}
function registryPath(project: string, name: string): string {
  return path.join(agentsDir(project), `${name}.json`);
}
function inboxDir(project: string, name: string): string {
  return path.join(projectDir(project), "inbox", name);
}

function ensureDirs(id: Identity): void {
  mkdirSync(agentsDir(id.project), { recursive: true });
  mkdirSync(inboxDir(id.project, id.name), { recursive: true });
}

// Atomic write: temp file in same dir + rename (rename is atomic on same fs).
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

function writeRegistry(entry: RegistryEntry): void {
  atomicWrite(registryPath(entry.project, entry.name), JSON.stringify(entry));
}

function removeRegistry(project: string, name: string): void {
  try { unlinkSync(registryPath(project, name)); } catch { /* ignore */ }
  try { rmSync(inboxDir(project, name), { recursive: true, force: true }); } catch { /* ignore */ }
}

function readRegistryEntry(project: string, name: string): RegistryEntry | null {
  try { return JSON.parse(readFileSync(registryPath(project, name), "utf-8")) as RegistryEntry; }
  catch { return null; }
}

// List live agents in a project; prune dead (pid gone) entries as we scan.
function listLiveAgents(project: string): RegistryEntry[] {
  const dir = agentsDir(project);
  if (!existsSync(dir)) return [];
  const out: RegistryEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -5);
    const e = readRegistryEntry(project, name);
    if (!e) continue;
    if (!pidAlive(e.pid)) { removeRegistry(project, name); continue; }
    out.push(e);
  }
  return out;
}

function listProjects(): string[] {
  const root = path.join(BUS_DIR, "projects");
  if (!existsSync(root)) return [];
  try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

// Resolve a target string to a live registry entry. Match by name within the
// caller's project first, then by session_id across all projects.
function resolveTarget(target: string, callerProject: string): RegistryEntry | null {
  const inProject = readRegistryEntry(callerProject, target);
  if (inProject && pidAlive(inProject.pid)) return inProject;
  for (const proj of listProjects()) {
    for (const e of listLiveAgents(proj)) {
      if (e.name === target || e.session_id === target) return e;
    }
  }
  return null;
}

// Drop a message file into the target's inbox dir (atomic). Returns false if
// the target inbox dir doesn't exist (target offline).
function deliverMessage(target: RegistryEntry, msg: Message): boolean {
  const dir = inboxDir(target.project, target.name);
  if (!existsSync(dir)) return false;
  atomicWrite(path.join(dir, `${msg.ts.replace(/[:.]/g, "")}-${msg.msg_id}.json`), JSON.stringify(msg));
  return true;
}

// Read + delete all pending inbox files for this agent, oldest first.
function drainInbox(id: Identity): Message[] {
  const dir = inboxDir(id.project, id.name);
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith(".json")).sort(); }
  catch { return []; }
  const msgs: Message[] = [];
  for (const f of files) {
    const fp = path.join(dir, f);
    try {
      const msg = JSON.parse(readFileSync(fp, "utf-8")) as Message;
      msgs.push(msg);
    } catch { /* skip corrupt/partial */ }
    try { unlinkSync(fp); } catch { /* ignore */ }
  }
  return msgs;
}

function watchInbox(id: Identity, onChange: () => void): FSWatcher | null {
  try {
    return watch(inboxDir(id.project, id.name), { persistent: false }, () => onChange());
  } catch { return null; }
}

// ━━ End SUBSTRATE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ━━ Extension ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
  // Register identity flags so pi's CLI parser always accepts them (otherwise
  // pi rejects the invocation before this extension's hooks run).
  pi.registerFlag("coms", { description: "Join the coms-bus (default project). Otherwise the extension stays dormant.", type: "boolean", default: false });
  pi.registerFlag("cname", { description: "coms-bus agent name (pi owns --name). Env: PI_COMS_CNAME", type: "string", default: undefined });
  pi.registerFlag("purpose", { description: "coms-bus one-line role/purpose. Env: PI_COMS_PURPOSE", type: "string", default: undefined });
  pi.registerFlag("project", { description: "coms-bus team namespace. Env: PI_COMS_PROJECT", type: "string", default: undefined });
  pi.registerFlag("explicit", { description: "Hide from auto-discovery/broadcast; only direct-addressable.", type: "boolean", default: false });
  pi.registerFlag("color", { description: "Hex color #RRGGBB for the team pool widget.", type: "string", default: undefined });

  // ── Opt-in gate ───────────────────────────────────────────────────────────
  // coms-bus lives in the global extensions dir, so it auto-loads in EVERY pi
  // session. We only want it active when you're actually building/joining a
  // team. Activate only when explicitly asked: --coms / --cname / --project /
  // --explicit, or PI_COMS_CNAME / PI_COMS_PROJECT in the env. Otherwise stay
  // dormant: no tools, no widget, no registry entry, no timers.
  // NOTE: flags are only parsed by the time session_start fires — pi.getFlag()
  // returns undefined at module-load — so opt-in is computed in session_start.
  function isOptedIn(): boolean {
    return (
      pi.getFlag("coms") === true ||
      !!pi.getFlag("cname") || !!pi.getFlag("project") || pi.getFlag("explicit") === true ||
      !!process.env.PI_COMS_CNAME || !!process.env.PI_COMS_PROJECT
    );
  }

  const COMS_TOOLS = ["coms_list", "coms_send", "coms_broadcast", "coms_poll", "coms_shutdown"];
  let joined = false;

  let identity: Identity | null = null;
  let latestCtx: ExtensionContext | null = null;
  let watcher: FSWatcher | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const pending = new Map<string, Pending>();   // msg_id -> our outstanding sends
  const inboundQueue: Inbound[] = [];            // prompts waiting to be serviced
  let currentInbound: Inbound | null = null;     // the one in-flight (drives hops + reply)
  const prompts = new Map<string, string>();    // msg_id -> prompt text (pending delivery)
  let startedAtIso = nowIso();
  // True while the agent is running ANY turn (human- or coms-driven). We only
  // hand a coms prompt to the LLM when idle, so the *next* agent_end is
  // unambiguously the reply to that prompt — otherwise a human turn's output
  // could be mis-shipped as a coms answer.
  let busy = false;

  // ── Identity resolution (flags > env > defaults) ───────────────────────────
  function resolveIdentity(ctx: ExtensionContext, overrides?: { project?: string; name?: string; purpose?: string; explicit?: boolean }): Identity {
    const session_id = ulid();
    const project = overrides?.project || (pi.getFlag("project") as string) || process.env.PI_COMS_PROJECT || "default";
    const explicit = overrides?.explicit ?? (pi.getFlag("explicit") === true);
    const desired = overrides?.name || (pi.getFlag("cname") as string) || process.env.PI_COMS_CNAME || `agent-${session_id.slice(-5)}`;
    const name = uniqueName(project, desired, session_id);
    const purpose = overrides?.purpose || (pi.getFlag("purpose") as string) || process.env.PI_COMS_PURPOSE || "";
    const colorFlag = pi.getFlag("color") as string | undefined;
    const color = isValidHex(colorFlag) ? colorFlag : fallbackColor(session_id);
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
    return {
      session_id, name, purpose, model, color, project, explicit,
      cwd: ctx.cwd || process.cwd(),
    };
  }

  // Avoid clobbering a live peer with the same name.
  function uniqueName(project: string, desired: string, session_id: string): string {
    const existing = readRegistryEntry(project, desired);
    if (!existing || !pidAlive(existing.pid) || existing.session_id === session_id) return desired;
    for (let i = 2; i < 100; i++) {
      const cand = `${desired}-${i}`;
      const e = readRegistryEntry(project, cand);
      if (!e || !pidAlive(e.pid)) return cand;
    }
    return `${desired}-${session_id.slice(-4)}`;
  }

  function contextPct(): number {
    try {
      const u = latestCtx?.getContextUsage?.();
      if (u && (u as any).percent != null) return Math.round((u as any).percent);
      if (u && (u as any).tokens && (u as any).contextWindow) {
        return Math.round(((u as any).tokens / (u as any).contextWindow) * 100);
      }
    } catch { /* ignore */ }
    return 0;
  }

  function publishHeartbeat(): void {
    if (!identity) return;
    const entry: RegistryEntry = {
      session_id: identity.session_id,
      name: identity.name,
      purpose: identity.purpose,
      model: identity.model,
      color: identity.color,
      pid: process.pid,
      cwd: identity.cwd,
      project: identity.project,
      explicit: identity.explicit,
      started_at: startedAtIso,
      heartbeat_at: nowIso(),
      context_used_pct: contextPct(),
      queue_depth: inboundQueue.length + (currentInbound ? 1 : 0),
    };
    try { writeRegistry(entry); } catch { /* best-effort */ }
  }

  // ── Receiving: drain inbox, act on prompts, resolve responses ──────────────

  function onInboxChange(): void {
    if (!identity) return;
    for (const msg of drainInbox(identity)) {
      if (msg.kind === "response") {
        resolveResponse(msg);
      } else if (msg.kind === "control") {
        handleControl(msg);
      } else {
        inboundQueue.push({
          msg_id: msg.msg_id,
          group_id: msg.group_id,
          from_name: msg.from_name,
          from_session: msg.from_session,
          hops: msg.hops,
          response_schema: (msg.response_schema as object) ?? null,
        });
        deliverPrompt(msg);
      }
    }
    serviceNextInbound();
  }

  // Stash the prompt text until serviceNextInbound delivers it (one at a time).
  function deliverPrompt(msg: Message): void { prompts.set(msg.msg_id, msg.prompt ?? ""); }

  // Service inbound prompts one at a time, and only while the agent is idle, so
  // each coms-driven turn maps to exactly one reply (see `busy` above).
  function serviceNextInbound(): void {
    if (busy || currentInbound || inboundQueue.length === 0 || !identity) return;
    const next = inboundQueue.shift()!;
    currentInbound = next;
    const body = prompts.get(next.msg_id) ?? "";
    const schemaNote = next.response_schema
      ? `\n\n(Reply with JSON matching this schema; your final assistant message is sent back verbatim:\n${JSON.stringify(next.response_schema)})`
      : "";
    try {
      pi.sendMessage({
        customType: "coms-inbound",
        content: `[coms · question from ${next.from_name}]\n\n${body}${schemaNote}`,
        display: true,
        details: { msg_id: next.msg_id, from: next.from_name },
      }, { deliverAs: "followUp", triggerTurn: true });
      pi.appendEntry("coms-bus-log", { event: "inbound_prompt", msg_id: next.msg_id, from: next.from_name, hops: next.hops });
    } catch {
      currentInbound = null;
    }
    refreshWidget();
  }

  // A control message landed (currently only "shutdown"). Acknowledge to the
  // human, log it, then gracefully exit on the next tick so this drain + any
  // in-flight reply can finish first. ctx.shutdown() fires session_shutdown,
  // which runs removeRegistry, so we leave the bus cleanly.
  function handleControl(msg: Message): void {
    if (msg.control !== "shutdown") return;
    pi.appendEntry("coms-bus-log", { event: "control_shutdown", from: msg.from_name, reason: msg.reason ?? null });
    try { latestCtx?.ui?.notify?.(`coms: shutdown requested by ${msg.from_name}${msg.reason ? ` — ${msg.reason}` : ""}`, "warning"); } catch { /* ignore */ }
    setTimeout(() => { try { latestCtx?.shutdown?.(); } catch { try { shutdown(); process.exit(0); } catch { /* ignore */ } } }, 50);
  }

  // A response landed in our inbox for one of our outstanding sends.
  function resolveResponse(msg: Message): void {
    const p = pending.get(msg.msg_id);
    pi.appendEntry("coms-bus-log", { event: "inbound_response", msg_id: msg.msg_id, from: msg.from_name, error: msg.error ?? null });
    if (!p) return; // orphan (we restarted, or already cleaned up)
    p.result = { response: msg.response, error: msg.error ?? null };
    p.resolve(p.result);
    // If nobody is blocking on this via wait:true, surface it as a follow-up so
    // the orchestrator processes it in a fresh turn (async, deadlock-free).
    if (!p.consumed) {
      const tag = p.group_id ? ` (broadcast ${p.group_id})` : "";
      const bodyText = msg.error
        ? `[coms · ERROR from ${msg.from_name}${tag}] ${msg.error}`
        : `[coms · answer from ${msg.from_name}${tag}]\n\n${typeof msg.response === "string" ? msg.response : JSON.stringify(msg.response, null, 2)}`;
      try {
        pi.sendMessage({
          customType: "coms-response",
          content: bodyText,
          display: true,
          details: { msg_id: msg.msg_id, group_id: p.group_id, from: msg.from_name },
        }, { deliverAs: "followUp", triggerTurn: true });
      } catch { /* ignore */ }
    }
    refreshWidget();
  }

  // Track run lifecycle so serviceNextInbound only fires when truly idle.
  pi.on("turn_start", () => { busy = true; });

  // ── Replying: on agent_end, ship the turn's final text back to the asker ──
  pi.on("agent_end", async (event, _ctx) => {
    busy = false;
    if (!identity || !currentInbound) {
      // Not a coms-driven turn — just see if a queued coms prompt can go now.
      serviceNextInbound();
      return;
    }
    const inb = currentInbound;

    // Extract the most recent assistant text from this turn.
    let text = "";
    const msgs = (event as any).messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      if (typeof m.content === "string") { text = m.content; break; }
      if (Array.isArray(m.content)) {
        const t = m.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
        if (t) { text = t; break; }
      }
    }

    let payload: unknown = text;
    let error: string | null = null;
    if (inb.response_schema) {
      try { payload = JSON.parse(text); }
      catch { error = "response not valid JSON"; payload = null; }
    }

    const target = resolveTarget(inb.from_session, identity.project) ?? resolveTarget(inb.from_name, identity.project);
    if (target) {
      const reply: Message = {
        kind: "response", msg_id: inb.msg_id, group_id: inb.group_id,
        from_session: identity.session_id, from_name: identity.name, from_cwd: identity.cwd,
        to_name: target.name, hops: 0, ts: nowIso(),
        response: payload, error,
      };
      try { deliverMessage(target, reply); }
      catch { /* best-effort */ }
      pi.appendEntry("coms-bus-log", { event: "outbound_response", msg_id: inb.msg_id, to: target.name, error });
    }

    prompts.delete(inb.msg_id);
    currentInbound = null;
    refreshWidget();
    // Pick up any queued prompt that arrived while we were busy.
    serviceNextInbound();
  });

  // ── Tools ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "coms_list",
    label: "Coms List",
    description:
      "List teammate agents on the coms bus (name, purpose, model, live context%). " +
      "These are who you can message with coms_send / coms_broadcast. " +
      "project=\"*\" scans all projects; include_explicit=true reveals hidden agents.",
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Project/team namespace, or \"*\" for all. Defaults to your project." })),
      include_explicit: Type.Optional(Type.Boolean({ description: "Include agents launched with --explicit. Default false." })),
    }),
    async execute(_id, params) {
      if (!identity) return errResult("coms-bus not initialised");
      const includeExp = params.include_explicit === true;
      const filter = params.project ?? identity.project;
      const projects = filter === "*" ? listProjects() : [filter];
      const agents: any[] = [];
      for (const proj of projects) {
        for (const e of listLiveAgents(proj)) {
          if (e.session_id === identity.session_id) continue;
          if (e.explicit && !includeExp) continue;
          const stale = Date.now() - new Date(e.heartbeat_at).getTime() > STALE_MS;
          agents.push({
            name: e.name, purpose: e.purpose, model: shortModel(e.model),
            project: proj, context_used_pct: e.context_used_pct,
            queue_depth: e.queue_depth, status: stale ? "stale" : "online",
          });
        }
      }
      const lines = agents.length === 0 ? "No teammates found."
        : agents.map(a => {
            const dot = a.status === "online" ? "●" : "◐";
            return `${dot} ${a.name} (${a.model}) ${a.context_used_pct}%${a.purpose ? ` — ${a.purpose}` : ""}`;
          }).join("\n");
      return { content: [{ type: "text" as const, text: `${agents.length} teammate(s):\n${lines}` }], details: { agents } };
    },
    renderResult(result, opts, theme) {
      const agents: any[] = (result.details as any)?.agents ?? [];
      const header = theme.fg("accent", `📡 ${agents.length} teammate(s)`);
      if (!opts.expanded || agents.length === 0) return new Text(header, 0, 0);
      const rows = agents.map(a => {
        const dot = a.status === "online" ? theme.fg("success", "●") : theme.fg("warning", "◐");
        return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", a.model)} ${theme.fg("warning", a.context_used_pct + "%")}`;
      }).join("\n");
      return new Text(header + "\n" + rows, 0, 0);
    },
  });

  pi.registerTool({
    name: "coms_send",
    label: "Coms Send",
    description:
      "Send a question/task to one teammate. Returns a msg_id immediately and the " +
      "answer arrives later as a follow-up message (async — keep working / send to others). " +
      "Set wait=true to BLOCK and return the answer inline (convenient for a single leaf " +
      "call; do NOT use wait=true if the teammate might ask YOU something back — that deadlocks). " +
      "Use coms_poll(msg_id) to check an async send without blocking.",
    parameters: Type.Object({
      target: Type.String({ description: "Teammate name (preferred, scoped to your project) or session_id." }),
      prompt: Type.String({ description: "The question or task." }),
      wait: Type.Optional(Type.Boolean({ description: "Block until the answer lands (default false). See deadlock caveat." })),
      response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema; the teammate is asked to reply with matching JSON." })),
      conversation_id: Type.Optional(Type.String({ description: "Optional id to thread a multi-message exchange." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Override wait timeout (ms). Only used with wait=true." })),
    }),
    async execute(_id, params) {
      if (!identity) return errResult("coms-bus not initialised");
      const target = resolveTarget(params.target, identity.project);
      if (!target) return errResult(`coms: no live teammate "${params.target}"`);
      const hops = currentInbound ? currentInbound.hops + 1 : 0;
      if (hops >= MAX_HOPS) return errResult(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);

      const msg_id = ulid();
      const sent = sendPrompt(target, msg_id, null, params.prompt, params.response_schema ?? null, params.conversation_id ?? null, hops);
      if (!sent) return errResult(`coms: failed to deliver to "${target.name}" (offline?)`);

      if (params.wait === true) {
        const p = pending.get(msg_id)!;
        p.consumed = true;
        const timeoutMs = typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : WAIT_TIMEOUT_MS;
        const timed = new Promise<{ error: string }>(res => { const t = setTimeout(() => res({ error: "timeout" }), timeoutMs); (t as any).unref?.(); });
        const winner = await Promise.race([p.promise, timed]);
        if ((winner as any).error) return { content: [{ type: "text" as const, text: `coms_send → ${target.name}: ${(winner as any).error}` }], details: { msg_id, error: (winner as any).error }, isError: true };
        const resp = (winner as any).response;
        return { content: [{ type: "text" as const, text: typeof resp === "string" ? resp : JSON.stringify(resp, null, 2) }], details: { msg_id, target: target.name, response: resp } };
      }
      return { content: [{ type: "text" as const, text: `coms_send → ${target.name}\nmsg_id ${msg_id}\nThe answer will arrive as a follow-up message. Use coms_poll("${msg_id}") to check, or keep working.` }], details: { msg_id, target: target.name, hops, async: true } };
    },
    renderCall(args, theme) {
      const tgt = (args as any).target ?? "?";
      const prompt = (args as any).prompt ?? "";
      const preview = prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt;
      return new Text(theme.fg("toolTitle", theme.bold("coms_send ")) + theme.fg("accent", tgt) + theme.fg("dim", " — ") + theme.fg("muted", preview), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d = result.details as any;
      if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
      if (d?.async) return new Text(theme.fg("success", "→ ") + theme.fg("accent", d.target) + theme.fg("dim", `  msg_id ${d.msg_id}`), 0, 0);
      const t = result.content[0];
      return new Text((t?.type === "text" ? t.text : ""), 0, 0);
    },
  });

  pi.registerTool({
    name: "coms_broadcast",
    label: "Coms Broadcast",
    description:
      "Send the same question/task to multiple teammates at once. Always async: returns a " +
      "group_id and the per-teammate msg_ids; each answer arrives as its own follow-up message. " +
      "Use coms_poll(group_id) to see how many answers are in. Pass targets=[\"*\"] to fan out to " +
      "the whole team (excludes you and explicit/hidden agents).",
    parameters: Type.Object({
      targets: Type.Array(Type.String(), { description: "Teammate names, or [\"*\"] for the whole team." }),
      prompt: Type.String({ description: "The shared question or task." }),
      response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema for replies." })),
    }),
    async execute(_id, params) {
      if (!identity) return errResult("coms-bus not initialised");
      const hops = currentInbound ? currentInbound.hops + 1 : 0;
      if (hops >= MAX_HOPS) return errResult(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);

      let recipients: RegistryEntry[];
      if (params.targets.length === 1 && params.targets[0] === "*") {
        recipients = listLiveAgents(identity.project).filter(e => e.session_id !== identity!.session_id && !e.explicit);
      } else {
        recipients = [];
        for (const t of params.targets) {
          const e = resolveTarget(t, identity.project);
          if (e && !recipients.some(r => r.session_id === e.session_id)) recipients.push(e);
        }
      }
      if (recipients.length === 0) return errResult("coms_broadcast: no live recipients");

      const group_id = `g-${ulid()}`;
      const msg_ids: string[] = [];
      const delivered: string[] = [];
      for (const r of recipients) {
        const msg_id = ulid();
        if (sendPrompt(r, msg_id, group_id, params.prompt, params.response_schema ?? null, null, hops)) {
          msg_ids.push(msg_id); delivered.push(r.name);
        }
      }
      pi.appendEntry("coms-bus-log", { event: "broadcast", group_id, recipients: delivered });
      return {
        content: [{ type: "text" as const, text: `coms_broadcast → ${delivered.join(", ")}\ngroup_id ${group_id} · ${msg_ids.length} sent\nAnswers arrive as follow-up messages; coms_poll("${group_id}") for status.` }],
        details: { group_id, msg_ids, recipients: delivered },
      };
    },
    renderCall(args, theme) {
      const tgts = ((args as any).targets ?? []).join(", ");
      return new Text(theme.fg("toolTitle", theme.bold("coms_broadcast ")) + theme.fg("accent", tgts), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d = result.details as any;
      if (d?.error || result.isError) { const t = result.content[0]; return new Text(theme.fg("error", "✗ " + (t?.type === "text" ? t.text : "")), 0, 0); }
      return new Text(theme.fg("success", `→ ${(d?.recipients ?? []).length} teammate(s)  `) + theme.fg("dim", d?.group_id ?? ""), 0, 0);
    },
  });

  pi.registerTool({
    name: "coms_poll",
    label: "Coms Poll",
    description:
      "Non-blocking status of an async coms_send (pass its msg_id) or coms_broadcast (pass its group_id). " +
      "Returns which replies are in, which are still pending, and the answers received so far.",
    parameters: Type.Object({
      id: Type.String({ description: "A msg_id from coms_send or a group_id from coms_broadcast." }),
    }),
    async execute(_id, params) {
      const key = params.id;
      const groupMembers = [...pending.values()].filter(p => p.group_id === key);
      const entries = key.startsWith("g-") || groupMembers.length > 0
        ? groupMembers
        : (pending.has(key) ? [pending.get(key)!] : []);
      if (entries.length === 0) return { content: [{ type: "text" as const, text: `coms_poll: nothing tracked for "${key}" (already delivered as a follow-up, or unknown id).` }], details: { status: "unknown" } };
      const done = entries.filter(e => e.result);
      const lines = entries.map(e => {
        if (!e.result) return `… ${e.target_name}: pending`;
        if (e.result.error) return `✗ ${e.target_name}: ${e.result.error}`;
        const r = e.result.response;
        return `✓ ${e.target_name}: ${typeof r === "string" ? r : JSON.stringify(r)}`;
      }).join("\n");
      return { content: [{ type: "text" as const, text: `${done.length}/${entries.length} in:\n${lines}` }], details: { total: entries.length, done: done.length } };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("coms_poll ")) + theme.fg("warning", (args as any).id ?? "?"), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d = result.details as any;
      return new Text(theme.fg(d?.done === d?.total && d?.total ? "success" : "warning", `${d?.done ?? 0}/${d?.total ?? 0}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "coms_shutdown",
    label: "Coms Shutdown",
    description:
      "Dismiss (gracefully shut down) one or more teammates when the team's work is done. " +
      "Pass a single name, a list of names, or [\"*\"] to dismiss the whole team. Each target " +
      "exits its pi session and leaves the bus. Does NOT shut yourself down. Returns who was signaled.",
    parameters: Type.Object({
      targets: Type.Array(Type.String(), { description: "Teammate name(s), or [\"*\"] for the whole team (excludes you)." }),
      reason: Type.Optional(Type.String({ description: "Optional note shown to each teammate before it exits." })),
    }),
    async execute(_id, params) {
      if (!identity) return errResult("coms-bus not initialised");
      let recipients: RegistryEntry[];
      if (params.targets.length === 1 && params.targets[0] === "*") {
        recipients = listLiveAgents(identity.project).filter(e => e.session_id !== identity!.session_id);
      } else {
        recipients = [];
        for (const t of params.targets) {
          const e = resolveTarget(t, identity.project);
          if (e && e.session_id !== identity.session_id && !recipients.some(r => r.session_id === e.session_id)) recipients.push(e);
        }
      }
      if (recipients.length === 0) return errResult("coms_shutdown: no matching live teammates");
      const signaled: string[] = [];
      for (const r of recipients) {
        const msg: Message = {
          kind: "control", control: "shutdown", reason: params.reason,
          msg_id: ulid(), group_id: null,
          from_session: identity.session_id, from_name: identity.name, from_cwd: identity.cwd,
          to_name: r.name, hops: 0, ts: nowIso(),
        };
        if (deliverMessage(r, msg)) signaled.push(r.name);
      }
      pi.appendEntry("coms-bus-log", { event: "shutdown_sent", to: signaled, reason: params.reason ?? null });
      return { content: [{ type: "text" as const, text: `coms_shutdown → ${signaled.join(", ") || "(none)"}\nSignaled ${signaled.length} teammate(s) to exit.` }], details: { signaled } };
    },
    renderCall(args, theme) {
      const tgts = ((args as any).targets ?? []).join(", ");
      return new Text(theme.fg("toolTitle", theme.bold("coms_shutdown ")) + theme.fg("warning", tgts), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d = result.details as any;
      if (d?.error || result.isError) { const t = result.content[0]; return new Text(theme.fg("error", "✗ " + (t?.type === "text" ? t.text : "")), 0, 0); }
      return new Text(theme.fg("warning", `⚠ dismissed ${(d?.signaled ?? []).length} teammate(s)`), 0, 0);
    },
  });

  // Build + deliver a prompt message, registering the pending reply slot.
  function sendPrompt(
    target: RegistryEntry, msg_id: string, group_id: string | null,
    prompt: string, response_schema: object | null, conversation_id: string | null, hops: number,
  ): boolean {
    if (!identity) return false;
    const msg: Message = {
      kind: "prompt", msg_id, group_id,
      from_session: identity.session_id, from_name: identity.name, from_cwd: identity.cwd,
      to_name: target.name, hops, ts: nowIso(),
      prompt, conversation_id, response_schema,
    };
    if (!deliverMessage(target, msg)) return false;
    let resolveFn!: (v: { response?: unknown; error?: string | null }) => void;
    const promise = new Promise<{ response?: unknown; error?: string | null }>(res => { resolveFn = res; });
    pending.set(msg_id, { msg_id, group_id, target_name: target.name, created_at: nowIso(), resolve: resolveFn, promise, consumed: false });
    pi.appendEntry("coms-bus-log", { event: "outbound_prompt", msg_id, to: target.name, group_id, hops });
    return true;
  }

  function errResult(text: string) {
    return { content: [{ type: "text" as const, text }], details: { error: text }, isError: true };
  }

  // ── Widget: team pool ──────────────────────────────────────────────────────
  let widgetRegistered = false;
  let widgetHandle: { requestRender(): void } | null = null;

  function refreshWidget(): void {
    const ctx = latestCtx;
    if (!ctx?.hasUI || !identity) return;
    if (!widgetRegistered) {
      widgetRegistered = true;
      ctx.ui.setWidget("coms-bus-pool", (tui, theme) => {
        widgetHandle = tui;
        return {
          render(width: number): string[] {
            if (!identity) return [];
            const MAX = 58;
            const inner = Math.max(0, Math.min(width, MAX) - 2);
            const peers = listLiveAgents(identity.project).filter(e => e.session_id !== identity!.session_id);
            const cell = (s: string) => { const v = visibleWidth(s); return theme.fg("dim", "│") + s + " ".repeat(Math.max(0, inner - v)) + theme.fg("dim", "│"); };
            const top = theme.fg("dim", "┌" + "─".repeat(inner) + "┐");
            const bot = theme.fg("dim", "└" + "─".repeat(inner) + "┘");
            const title = truncateToWidth(`coms · ${identity.project} · ${identity.name}`, inner - 1);
            const qd = inboundQueue.length + (currentInbound ? 1 : 0);
            const selfLine = truncateToWidth(`you${qd ? `  inbox:${qd}` : ""}  pending:${pending.size}`, inner - 1);
            const lines = [top, cell(" " + theme.fg("accent", theme.bold(title))), cell(" " + theme.fg("dim", selfLine))];
            if (peers.length === 0) {
              lines.push(cell(" " + theme.fg("dim", "no teammates online")));
            } else {
              for (const p of peers) {
                const stale = Date.now() - new Date(p.heartbeat_at).getTime() > STALE_MS;
                const dot = stale ? theme.fg("warning", "◐") : theme.fg("success", "●");
                const row = truncateToWidth(`${p.name}  ${shortModel(p.model)}  ${p.context_used_pct}%${p.queue_depth ? ` q${p.queue_depth}` : ""}`, inner - 3);
                lines.push(cell(" " + dot + " " + theme.fg("muted", row)));
              }
            }
            lines.push(bot);
            return lines;
          },
          invalidate() { /* recompute each render */ },
        };
      });
    }
    widgetHandle?.requestRender();
  }

  // ── /coms command ────────────────────────────────────────────────────────
  pi.registerCommand("coms", {
    description: "Show the coms-bus team pool (peers, presence, your inbox/pending).",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      if (!identity) { ctx.ui.notify("coms-bus not initialised.", "warning"); return; }
      refreshWidget();
      const peers = listLiveAgents(identity.project).filter(e => e.session_id !== identity!.session_id);
      const body = peers.length
        ? peers.map(p => `● ${p.name} (${shortModel(p.model)}) ${p.context_used_pct}%${p.purpose ? ` — ${p.purpose}` : ""}`).join("\n")
        : "No teammates online.";
      ctx.ui.notify(`coms · ${identity.project} · you=${identity.name}\ninbox:${inboundQueue.length + (currentInbound ? 1 : 0)}  pending:${pending.size}\n\n${body}`, "info");
    },
  });

  // ── Tool activation: keep coms_* hidden until we're actually on a bus ───────
  function setComsToolsActive(on: boolean): void {
    try {
      const active = new Set(pi.getActiveTools());
      for (const t of COMS_TOOLS) { if (on) active.add(t); else active.delete(t); }
      pi.setActiveTools([...active]);
    } catch { /* ignore */ }
  }

  // ── Join / leave (used by flags at launch AND /coms-join at runtime) ────────
  function joinBus(overrides?: { project?: string; name?: string; purpose?: string; explicit?: boolean }): boolean {
    const ctx = latestCtx;
    if (!ctx) return false;
    if (joined) { ctx.ui?.notify?.(`coms: already on "${identity?.project}" as "${identity?.name}". /coms-leave first.`, "warning"); return false; }
    identity = resolveIdentity(ctx, overrides);
    startedAtIso = nowIso();
    try { ensureDirs(identity); }
    catch (e: any) { ctx.ui?.notify?.(`coms-bus: failed to create dirs — ${e?.message ?? e}`, "error"); identity = null; return false; }
    publishHeartbeat();
    watcher = watchInbox(identity, onInboxChange);
    heartbeat = setInterval(publishHeartbeat, HEARTBEAT_MS); (heartbeat as any).unref?.();
    tick = setInterval(() => { onInboxChange(); refreshWidget(); }, TICK_MS); (tick as any).unref?.();
    joined = true;
    setComsToolsActive(true);
    onInboxChange(); // pick up anything already queued
    refreshWidget();
    pi.appendEntry("coms-bus-log", { event: "join", name: identity.name, project: identity.project, session_id: identity.session_id });
    ctx.ui?.notify?.(`coms: joined "${identity.project}" as "${identity.name}".`, "info");
    return true;
  }

  function leaveBus(opts?: { silent?: boolean }): void {
    if (!joined && !identity) return;
    if (tick) { clearInterval(tick); tick = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    try { watcher?.close(); } catch { /* ignore */ }
    watcher = null;
    const wasProject = identity?.project, wasName = identity?.name;
    if (identity) {
      removeRegistry(identity.project, identity.name);
      try { pi.appendEntry("coms-bus-log", { event: "leave", name: identity.name, session_id: identity.session_id }); } catch { /* ignore */ }
    }
    // Drop in-flight state so a later rejoin starts clean.
    pending.clear(); inboundQueue.length = 0; currentInbound = null; prompts.clear();
    if (latestCtx?.hasUI) { try { latestCtx.ui.setWidget("coms-bus-pool", undefined); } catch { /* ignore */ } }
    widgetRegistered = false; widgetHandle = null;
    identity = null; joined = false;
    setComsToolsActive(false);
    if (!opts?.silent && latestCtx?.hasUI && wasName) latestCtx.ui.notify(`coms: left "${wasProject}".`, "info");
  }

  // Back-compat name used by the control-message (remote shutdown) handler.
  function shutdown(): void { leaveBus({ silent: true }); }

  // ── Runtime join/leave commands ────────────────────────────────────────────
  pi.registerCommand("coms-join", {
    description: "Join a coms-bus team now (no restart):  /coms-join [team] [as <name>] [explicit]",
    handler: async (args, ctx) => {
      latestCtx = latestCtx ?? (ctx as unknown as ExtensionContext);
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      let project: string | undefined, name: string | undefined, explicit = false;
      for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i];
        if (tk === "as" && tokens[i + 1]) name = tokens[++i];
        else if (tk === "--explicit" || tk === "explicit") explicit = true;
        else if (!project) project = tk;
      }
      joinBus({ project, name, explicit });
    },
  });

  pi.registerCommand("coms-leave", {
    description: "Leave the current coms-bus team (the session keeps running).",
    handler: async (_args, ctx) => {
      latestCtx = latestCtx ?? (ctx as unknown as ExtensionContext);
      if (!joined) { ctx.ui.notify("coms: not on a bus.", "info"); return; }
      leaveBus();
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    if (isOptedIn()) joinBus();
    else setComsToolsActive(false); // dormant: hide coms_* tools until /coms-join
  });

  pi.on("session_shutdown", async () => leaveBus({ silent: true }));
  process.on("SIGINT", () => leaveBus({ silent: true }));
  process.on("SIGTERM", () => leaveBus({ silent: true }));
}
