/**
 * catalog — unified view of all agents, chains, and teams.
 *
 * Tools:    catalog_list, catalog_read, catalog_validate,
 *           agent_author, charter_author
 * Commands: /ag:catalog [filter|name]
 *
 * Paths are resolved from agent-workspace.json (see lib/workspace.ts).
 * After every write, an auto-commit is made to the workspace git repo
 * using a conventional-commit message derived from the file path alone —
 * no LLM involved.
 *
 * Read order (first-seen wins on name clash):
 *   workspace/agents/*.md
 *   workspace/charters/*.yaml
 *   .pi/agents/*.md          (project-local)
 *   .pi/charters/*.yaml      (project-local)
 *   legacy agent-chain.yaml  (back-compat)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  CONFIG_PATH,
  commitWorkspaceFile,
  getWorkspace,
  workspaceAgentDir,
  workspaceCharterDir,
  workspaceSkillsDir,
} from "./lib/workspace.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentEntry {
  name: string;
  description: string;
  skills: string;
  spawnAgents: boolean;
  filePath: string;
}

interface ChainEntry {
  name: string;
  description?: string;
  steps: number;
  persist: boolean;
}

interface TeamEntry {
  name: string;
  description?: string;
  members: string[];
  topology: string;
  guardrail: string;
  entry_point?: string;
}

interface Catalog {
  agents: AgentEntry[];
  chains: ChainEntry[];
  teams: TeamEntry[];
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/** Directories to scan for agent .md files (workspace first, then project-local). */
function agentDirs(): string[] {
  const dirs: string[] = [];
  const ws = workspaceAgentDir();
  if (ws) dirs.push(ws);
  dirs.push(path.join(process.cwd(), ".pi", "agents"));
  // Legacy fallback when no workspace configured
  if (!ws) dirs.push(path.join(os.homedir(), ".config", "pi", "agents"));
  return dirs;
}

/** Directories to scan for per-file charter .yaml files. */
function charterDirs(): string[] {
  const dirs: string[] = [];
  const ws = workspaceCharterDir();
  if (ws) dirs.push(ws);
  dirs.push(path.join(process.cwd(), ".pi", "charters"));
  if (!ws) dirs.push(path.join(os.homedir(), ".config", "pi", "charters"));
  return dirs;
}

/** Legacy monolithic agent-chain.yaml locations (back-compat only). */
function legacyChainFiles(): string[] {
  const files: string[] = [];
  const ws = workspaceAgentDir();
  if (ws) files.push(path.join(ws, "agent-chain.yaml"));
  files.push(path.join(process.cwd(), ".pi", "agents", "agent-chain.yaml"));
  if (!ws) files.push(path.join(os.homedir(), ".config", "pi", "agents", "agent-chain.yaml"));
  return files;
}

// ─── Catalog readers ──────────────────────────────────────────────────────────

function readAgents(): AgentEntry[] {
  const seen = new Set<string>();
  const out: AgentEntry[] = [];
  for (const dir of agentDirs()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const raw = readFileSync(path.join(dir, f), "utf-8");
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!match) continue;
        const fm: Record<string, string> = {};
        for (const line of match[1].split(/\r?\n/)) {
          const idx = line.indexOf(":");
          if (idx > 0) {
            fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
              .replace(/^["']|["']$/g, "");
          }
        }
        if (!fm.name) continue;
        out.push({
          name: fm.name,
          description: fm.description || "",
          skills: fm.skills || "",
          spawnAgents: fm.spawn_agents === "true",
          filePath: path.join(dir, f),
        });
      } catch { continue; }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Minimal YAML parser for charter files.
function parseSimpleYaml(src: string): Record<string, any> {
  const lines = src.split(/\r?\n/);
  const root: Record<string, any> = {};
  let currentKey: string | null = null;
  let currentObj: Record<string, any> | null = null;
  let inList = false;
  let listItems: any[] = [];
  let listItemObj: Record<string, any> | null = null;

  const flush = () => {
    if (currentKey && currentObj) {
      if (inList) {
        if (listItemObj) { listItems.push(listItemObj); listItemObj = null; }
        root[currentKey] = listItems;
      } else {
        root[currentKey] = currentObj;
      }
    }
    currentKey = null; currentObj = null; inList = false; listItems = []; listItemObj = null;
  };

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

    if (indent === 0) {
      flush();
      const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)/);
      if (m) {
        currentKey = m[1];
        const inlineVal = m[2].replace(/^["']|["']$/g, "").trim();
        if (inlineVal) { root[m[1]] = inlineVal; currentKey = null; currentObj = null; }
        else { currentObj = {}; }
      }
      continue;
    }

    if (!currentKey) continue;

    if (indent === 2) {
      const kv = line.trim().match(/^(\w[\w-]*)\s*:\s*(.*)/);
      if (kv) {
        const v = kv[2].replace(/^["']|["']$/g, "");
        if (currentObj) currentObj[kv[1]] = v;
        continue;
      }
      if (line.trim().startsWith("-")) {
        inList = true;
        if (listItemObj) { listItems.push(listItemObj); listItemObj = null; }
        const rest = line.trim().slice(1).trim();
        if (rest) {
          const kv2 = rest.match(/^(\w[\w-]*)\s*:\s*(.*)/);
          if (kv2) { listItemObj = { [kv2[1]]: kv2[2].replace(/^["']|["']$/g, "") }; }
          else { listItems.push(rest.replace(/^["']|["']$/g, "")); }
        } else {
          listItemObj = {};
        }
        continue;
      }
    }

    if (indent >= 4 && inList && listItemObj) {
      const kv = line.trim().match(/^(\w[\w-]*)\s*:\s*(.*)/);
      if (kv) listItemObj[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  flush();
  return root;
}

function ingestCharterBlock(
  name: string, raw: any,
  seenChains: Set<string>, seenTeams: Set<string>,
  chains: ChainEntry[], teams: TeamEntry[],
) {
  if (!raw || typeof raw !== "object") return;
  if (raw.kind === "chain" && !seenChains.has(name)) {
    seenChains.add(name);
    const stepList = Array.isArray(raw.steps) ? raw.steps : Array.isArray(raw.members) ? raw.members : [];
    chains.push({ name, description: raw.description, steps: stepList.length, persist: raw.persist === "true" || raw.persist === true });
  } else if (raw.kind === "team" && !seenTeams.has(name)) {
    seenTeams.add(name);
    const members = Array.isArray(raw.members)
      ? raw.members.map((m: any) => (typeof m === "object" ? m.agent : m)).filter(Boolean)
      : [];
    teams.push({ name, description: raw.description, members, topology: raw.topology || "hub-spoke", guardrail: raw.guardrail || "confirm", entry_point: raw.entry_point });
  }
}

function readChainsAndTeams(): { chains: ChainEntry[]; teams: TeamEntry[] } {
  const chains: ChainEntry[] = [];
  const teams: TeamEntry[] = [];
  const seenChains = new Set<string>();
  const seenTeams  = new Set<string>();

  for (const dir of charterDirs()) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir).filter((f: string) => f.endsWith(".yaml") || f.endsWith(".yml")); }
    catch { continue; }
    for (const f of files) {
      const name = f.replace(/\.ya?ml$/, "");
      try {
        const raw = parseSimpleYaml(readFileSync(path.join(dir, f), "utf-8"));
        ingestCharterBlock(name, raw, seenChains, seenTeams, chains, teams);
      } catch { continue; }
    }
  }

  for (const file of legacyChainFiles()) {
    if (!existsSync(file)) continue;
    let doc: Record<string, any>;
    try { doc = parseSimpleYaml(readFileSync(file, "utf-8")); }
    catch { continue; }
    for (const [name, raw] of Object.entries(doc)) {
      ingestCharterBlock(name, raw, seenChains, seenTeams, chains, teams);
    }
  }

  return { chains, teams };
}

function buildCatalog(): Catalog {
  return { agents: readAgents(), ...readChainsAndTeams() };
}

// ─── Catalog digest (compact one-liner per entry, injected into session context)

export function catalogDigest(): string {
  const { agents, chains, teams } = buildCatalog();
  if (!agents.length && !chains.length && !teams.length) return "";

  const lines: string[] = ["Available multi-agent resources (use catalog_read(name) for details):"];
  for (const t of teams)  lines.push(`  TEAM  ${t.name} — ${t.description ?? "(no description)"}  [guardrail: ${t.guardrail}]`);
  for (const c of chains) lines.push(`  CHAIN ${c.name} — ${c.description ?? "(no description)"}  [${c.steps} steps]`);
  for (const a of agents) lines.push(`  AGENT ${a.name} — ${a.description || "(no description)"}`);
  return lines.join("\n");
}

// ─── Extension ────────────────────────────────────────────────────────────────

// ─── Init menu helper ────────────────────────────────────────────────────────────────
//
// Framed SelectList panel used by /ag:init. Small fixed menus — no filter needed.

type CmdCtx = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

async function showInitMenu(
  ctx: CmdCtx,
  title: string,
  subtitle: string,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(` ${title}`)), 1, 0));
    if (subtitle) container.addChild(new Text(theme.fg("muted", ` ${subtitle}`), 1, 0));
    container.addChild(new Spacer(1));

    const list = new SelectList(items, Math.min(items.length + 2, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText:   (t) => theme.fg("accent", t),
      description:    (t) => theme.fg("muted", t),
      scrollInfo:     (t) => theme.fg("dim", t),
      noMatch:        (t) => theme.fg("warning", t),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel  = () => done(null);

    container.addChild(list);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", " ↑↓ navigate · enter select · esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

    return {
      render:     (w) => container.render(w),
      invalidate: ()  => container.invalidate(),
      handleInput(d: string) { list.handleInput(d); tui.requestRender(); },
    };
  });
}

export default function (pi: ExtensionAPI) {
  // Catalog tools are main-thread only — subagents don't need to browse or
  // author charters, and loading the tools wastes their context budget.
  if (process.env.PI_SUBAGENT) return;

  // ── Expose workspace skills path via resources_discover ──────────────────
  //
  // workspace/skills/ sits alongside agents/ and charters/. Any skill
  // subdirectory there (e.g. skills/catalog/) is discovered automatically.
  // Symlinked skills in ~/.config/pi/skills/ are picked up by pi natively.

  pi.on("resources_discover", (_event, _ctx) => {
    const skillsDir = workspaceSkillsDir();
    if (skillsDir && existsSync(skillsDir)) {
      return { skillPaths: [skillsDir] };
    }
  });

  // ── catalog_list ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "catalog_list",
    label: "Catalog List",
    description:
      "List all available agents, chains, and teams. " +
      "Optional kind filter: 'agent', 'chain', or 'team'.",
    promptSnippet: "List available agents, chains, and teams",
    parameters: Type.Object({
      kind: Type.Optional(Type.String({
        description: "Filter by kind: 'agent', 'chain', or 'team'. Omit for all.",
      })),
    }),
    async execute(_id, params) {
      const { agents, chains, teams } = buildCatalog();
      const filter = params.kind?.toLowerCase();
      const lines: string[] = [];

      if (!filter || filter === "team") {
        if (teams.length) {
          lines.push(`TEAMS (${teams.length})`);
          for (const t of teams) {
            lines.push(`  ${t.name}  [${t.members.length} members, ${t.topology}, guardrail: ${t.guardrail}]`);
            if (t.description) lines.push(`    ${t.description}`);
          }
        } else if (filter === "team") lines.push("No teams defined.");
      }

      if (!filter || filter === "chain") {
        if (chains.length) {
          if (lines.length) lines.push("");
          lines.push(`CHAINS (${chains.length})`);
          for (const c of chains) {
            lines.push(`  ${c.name}  [${c.steps} steps${c.persist ? ", persistent" : ""}]`);
            if (c.description) lines.push(`    ${c.description}`);
          }
        } else if (filter === "chain") lines.push("No chains defined.");
      }

      if (!filter || filter === "agent") {
        if (agents.length) {
          if (lines.length) lines.push("");
          lines.push(`AGENTS (${agents.length})`);
          for (const a of agents) {
            const tags = [a.skills && `skills: ${a.skills}`, a.spawnAgents && "spawn_agents"].filter(Boolean).join(", ");
            lines.push(`  ${a.name}${tags ? `  [${tags}]` : ""}`);
            if (a.description) lines.push(`    ${a.description}`);
          }
        } else if (filter === "agent") lines.push("No agent definitions found.");
      }

      if (!lines.length) lines.push("Catalog is empty.");
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { agents: agents.length, chains: chains.length, teams: teams.length },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("catalog_list")), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d = result.details as any;
      const summary = `${d?.agents ?? 0} agents · ${d?.chains ?? 0} chains · ${d?.teams ?? 0} teams`;
      return new Text(theme.fg("dim", summary), 0, 0);
    },
  });

  // ── catalog_read ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "catalog_read",
    label: "Catalog Read",
    description:
      "Read the full definition of a named agent, chain, or team. " +
      "Returns the YAML block or agent .md content.",
    promptSnippet: "Read full definition of an agent, chain, or team",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the agent, chain, or team to read." }),
    }),
    async execute(_id, params) {
      const { agents, chains, teams } = buildCatalog();
      const n = params.name;

      const team = teams.find(t => t.name === n);
      if (team) {
        for (const dir of charterDirs()) {
          for (const ext of [".yaml", ".yml"]) {
            const file = path.join(dir, `${n}${ext}`);
            if (!existsSync(file)) continue;
            try {
              const raw = readFileSync(file, "utf-8").trim();
              return { content: [{ type: "text" as const, text: `# Team: ${n}\n\n\`\`\`yaml\n${raw}\n\`\`\`` }], details: { kind: "team", path: file } };
            } catch { /* try next */ }
          }
        }
        return { content: [{ type: "text" as const, text: `Team "${n}" found in catalog but charter file could not be read.` }], details: { kind: "team" } };
      }

      const chain = chains.find(c => c.name === n);
      if (chain) {
        for (const dir of charterDirs()) {
          for (const ext of [".yaml", ".yml"]) {
            const file = path.join(dir, `${n}${ext}`);
            if (!existsSync(file)) continue;
            try {
              const raw = readFileSync(file, "utf-8").trim();
              return { content: [{ type: "text" as const, text: `# Chain: ${n}\n\n\`\`\`yaml\n${raw}\n\`\`\`` }], details: { kind: "chain", path: file } };
            } catch { /* try next */ }
          }
        }
        for (const file of legacyChainFiles()) {
          if (!existsSync(file)) continue;
          const raw = readFileSync(file, "utf-8");
          const blockMatch = raw.match(new RegExp(`(^${n}:\\s*\\n(?:[ \\t]+.*\\n?)*)`, "m"));
          if (blockMatch) return { content: [{ type: "text" as const, text: `# Chain: ${n}\n\n\`\`\`yaml\n${blockMatch[1].trimEnd()}\n\`\`\`` }], details: { kind: "chain" } };
        }
        return { content: [{ type: "text" as const, text: `Chain "${n}" found in catalog but charter file could not be read.` }], details: { kind: "chain" } };
      }

      const agent = agents.find(a => a.name === n);
      if (agent) {
        try {
          const content = readFileSync(agent.filePath, "utf-8");
          return { content: [{ type: "text" as const, text: `# Agent: ${n}\n\n${content}` }], details: { kind: "agent", path: agent.filePath } };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Error reading agent file: ${e.message}` }], details: { kind: "agent" }, isError: true };
        }
      }

      return {
        content: [{ type: "text" as const, text: `"${n}" not found in catalog. Use catalog_list() to see available entries.` }],
        details: {}, isError: true,
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("catalog_read ")) + theme.fg("accent", (args as any).name ?? "?"), 0, 0);
    },
    renderResult(result, _opts, theme) {
      const d = result.details as any;
      return new Text(theme.fg(result.isError ? "error" : "dim", d?.kind ? `[${d.kind}]` : ""), 0, 0);
    },
  });

  // ── catalog_validate ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "catalog_validate",
    label: "Catalog Validate",
    description:
      "Validate a charter name (checks the live file) or a raw YAML string. " +
      "Returns structured errors. No writes — safe to call on drafts.",
    promptSnippet: "Validate a charter or agent definition before writing",
    parameters: Type.Object({
      input: Type.String({ description: "A charter name to validate, or a raw YAML block string." }),
    }),
    async execute(_id, params) {
      const { chains, teams } = buildCatalog();
      const named = [...chains, ...teams].find(e => e.name === params.input);

      if (named) {
        return {
          content: [{ type: "text" as const, text: `✓ "${params.input}" is valid in the catalog.` }],
          details: { valid: true, name: params.input },
        };
      }

      let doc: Record<string, any>;
      try { doc = parseSimpleYaml(params.input); }
      catch (e: any) {
        return { content: [{ type: "text" as const, text: `Parse error: ${e.message}` }], details: { valid: false }, isError: true };
      }

      const errs: string[] = [];
      for (const [name, raw] of Object.entries(doc)) {
        if (!raw || typeof raw !== "object") { errs.push(`"${name}": not an object`); continue; }
        if (!raw.kind) { errs.push(`"${name}": missing kind (chain or team)`); continue; }
        if (raw.kind === "chain") {
          if (!Array.isArray(raw.steps) || raw.steps.length === 0) errs.push(`chain "${name}": missing or empty steps`);
        } else if (raw.kind === "team") {
          if (!Array.isArray(raw.members) || raw.members.length === 0) errs.push(`team "${name}": missing or empty members`);
          if (raw.entry_point && !raw.members?.some((m: any) => m.agent === raw.entry_point))
            errs.push(`team "${name}": entry_point "${raw.entry_point}" not in members`);
          const agentCounts = new Map<string, number>();
          for (const m of (raw.members ?? [])) if (m.agent) agentCounts.set(m.agent, (agentCounts.get(m.agent) ?? 0) + 1);
          for (const [agent, count] of agentCounts) {
            if (count > 1) {
              const instances = (raw.members ?? []).filter((m: any) => m.agent === agent);
              const names = instances.map((m: any) => m.name).filter(Boolean);
              if (names.length < count)
                errs.push(`team "${name}": ${count} members use agent "${agent}" — add a distinct name: field to each to prevent coms-bus routing collisions`);
              else if (new Set(names).size < names.length)
                errs.push(`team "${name}": duplicate name: values among members using agent "${agent}" — each must be unique`);
            }
          }
        } else {
          errs.push(`"${name}": unknown kind "${raw.kind}"`);
        }
      }

      if (errs.length) {
        return { content: [{ type: "text" as const, text: `Validation errors:\n${errs.map(e => `  • ${e}`).join("\n")}` }], details: { valid: false, errors: errs }, isError: true };
      }
      return { content: [{ type: "text" as const, text: `✓ Valid. ${Object.keys(doc).length} entry/entries parsed successfully.` }], details: { valid: true, entries: Object.keys(doc) } };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("catalog_validate")), 0, 0);
    },
    renderResult(result, _opts, theme) {
      return new Text(result.isError ? theme.fg("error", "✗ invalid") : theme.fg("success", "✓ valid"), 0, 0);
    },
  });

  // ── /ag:catalog command ───────────────────────────────────────────────────

  pi.registerCommand("ag:catalog", {
    description: "List agents/chains/teams.  /ag:catalog [agent|chain|team|<name>]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const { agents, chains, teams } = buildCatalog();
      const ws = getWorkspace();

      const allEntries = [
        ...teams.map(t => ({ ...t, kind: "team" })),
        ...chains.map(c => ({ ...c, kind: "chain" })),
        ...agents.map(a => ({ ...a, kind: "agent" })),
      ];
      const match = allEntries.find(e => e.name === arg);
      if (match) {
        if (match.kind === "agent") {
          const a = agents.find(x => x.name === arg)!;
          ctx.ui.notify(`AGENT: ${a.name}\n${a.description}\nSkills: ${a.skills || "none"}  spawn_agents: ${a.spawnAgents}\nFile: ${a.filePath}`, "info");
          return;
        }
        if (match.kind === "team") {
          const t = teams.find(x => x.name === arg)!;
          ctx.ui.notify(`TEAM: ${t.name}\n${t.description ?? ""}\nTopology: ${t.topology}  Guardrail: ${t.guardrail}\nMembers: ${t.members.join(", ")}\nEntry point: ${t.entry_point ?? "(none)"}`, "info");
          return;
        }
        if (match.kind === "chain") {
          const c = chains.find(x => x.name === arg)!;
          ctx.ui.notify(`CHAIN: ${c.name}\n${c.description ?? ""}\n${c.steps} steps  persist: ${c.persist}`, "info");
          return;
        }
      }

      const filter = ["agent", "chain", "team"].includes(arg) ? arg : null;
      const lines: string[] = [];
      if (ws) lines.push(`Workspace: ${ws.workspace}`);

      if (!filter || filter === "team") {
        lines.push(`\nTEAMS (${teams.length})`);
        for (const t of teams) lines.push(`  ${t.name}  [${t.members.length} members]  ${t.description ?? ""}`);
        if (!teams.length) lines.push("  (none)");
      }
      if (!filter || filter === "chain") {
        lines.push(`\nCHAINS (${chains.length})`);
        for (const c of chains) lines.push(`  ${c.name}  [${c.steps} steps]  ${c.description ?? ""}`);
        if (!chains.length) lines.push("  (none)");
      }
      if (!filter || filter === "agent") {
        lines.push(`\nAGENTS (${agents.length})`);
        for (const a of agents) lines.push(`  ${a.name}  ${a.description}`);
        if (!agents.length) lines.push("  (none)");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── agent_author ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "agent_author",
    label: "Agent Author",
    description:
      "Write or update an agent definition at <workspace>/agents/<name>.md. " +
      "Validates frontmatter before writing. Creates a .bak backup if the file exists. " +
      "Always use this instead of writing agent files directly.",
    promptSnippet: "Create or update an agent definition",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name (becomes the filename, no .md extension)." }),
      content: Type.String({ description: "Full .md file content including YAML frontmatter (--- ... ---) and system prompt body." }),
      overwrite: Type.Optional(Type.Boolean({ description: "Set true to overwrite an existing agent. Default: false (errors if exists)." })),
    }),
    async execute(_id, params) {
      const safeName = params.name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

      // Validate frontmatter
      const fmMatch = params.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch) return { content: [{ type: "text" as const, text: "Error: content must start with YAML frontmatter (--- ... ---)." }], details: {}, isError: true };
      const fm: Record<string, string> = {};
      for (const line of fmMatch[1].split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      if (!fm.name) return { content: [{ type: "text" as const, text: "Error: frontmatter must include a 'name' field." }], details: {}, isError: true };
      if (!fm.description) return { content: [{ type: "text" as const, text: "Error: frontmatter must include a 'description' field." }], details: {}, isError: true };

      const dir  = workspaceAgentDir() ?? path.join(os.homedir(), ".config", "pi", "agents");
      const dest = path.join(dir, `${safeName}.md`);
      const isNew = !existsSync(dest);

      if (!isNew && !params.overwrite) {
        return { content: [{ type: "text" as const, text: `Error: agent "${safeName}" already exists. Pass overwrite:true to replace it.` }], details: {}, isError: true };
      }
      if (!isNew) {
        writeFileSync(`${dest}.bak.${Date.now()}`, readFileSync(dest, "utf-8"), "utf-8");
      }

      mkdirSync(dir, { recursive: true });
      writeFileSync(dest, params.content, "utf-8");

      // Auto-commit to workspace repo
      const relPath = `agents/${safeName}.md`;
      const commit = commitWorkspaceFile(relPath, isNew);
      const commitNote = commit.committed
        ? ` (committed ${commit.hash}: ${commit.message})`
        : commit.error ? ` (commit failed: ${commit.error})` : "";

      const verb = isNew ? "written" : "updated";
      return {
        content: [{ type: "text" as const, text: `Agent "${safeName}" ${verb} to ${dest}${commitNote}` }],
        details: { path: dest, committed: commit.committed, hash: commit.hash },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("agent_author ")) + theme.fg("accent", (args as any).name ?? "?"), 0, 0);
    },
    renderResult(result, _opts, theme) {
      return new Text(result.isError
        ? theme.fg("error", "✗ ") + result.content[0]?.text
        : theme.fg("success", "✓ ") + theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);
    },
  });

  // ── charter_author ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "charter_author",
    label: "Charter Author",
    description:
      "Write a new charter (team or chain) to <workspace>/charters/<name>.yaml. " +
      "Validates structure before writing. Creates a .bak backup if overwriting. " +
      "The yaml_content must be the charter body only (no top-level name key). " +
      "Always use this instead of writing charter files directly.",
    promptSnippet: "Create or update a team or chain charter",
    parameters: Type.Object({
      name: Type.String({ description: "Charter name (becomes the filename, no .yaml extension)." }),
      yaml_content: Type.String({ description: "Charter YAML body. Must include 'kind: chain' or 'kind: team' at the top level." }),
      overwrite: Type.Optional(Type.Boolean({ description: "Set true to overwrite an existing charter. Default: false." })),
    }),
    async execute(_id, params) {
      const safeName = params.name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

      // Validate
      const errs: string[] = [];
      const kindMatch = params.yaml_content.match(/^kind:\s*(\S+)/m);
      if (!kindMatch) {
        errs.push("Missing 'kind: chain' or 'kind: team'");
      } else {
        const kind = kindMatch[1];
        if (kind === "chain") {
          if (!/steps:/m.test(params.yaml_content) && !/members:/m.test(params.yaml_content))
            errs.push("kind:chain requires a 'steps' or 'members' list");
        } else if (kind === "team") {
          if (!/members:/m.test(params.yaml_content)) errs.push("kind:team requires a 'members' list");
          const memberBlocks = params.yaml_content.split(/\n  - /g).slice(1);
          const memberAgents: string[] = [];
          const memberNames: string[] = [];
          for (const block of memberBlocks) {
            const agentM = block.match(/^agent:\s*(\S+)/);
            const nameM  = block.match(/\bname:\s*(\S+)/);
            if (agentM) { memberAgents.push(agentM[1]); memberNames.push(nameM?.[1] ?? ""); }
          }
          const agentCounts = new Map<string, number[]>();
          memberAgents.forEach((a, i) => { if (!agentCounts.has(a)) agentCounts.set(a, []); agentCounts.get(a)!.push(i); });
          for (const [agent, idxs] of agentCounts) {
            if (idxs.length > 1) {
              const names = idxs.map(i => memberNames[i]).filter(Boolean);
              if (names.length < idxs.length)
                errs.push(`${idxs.length} members use agent "${agent}" — add a distinct name: field to each to prevent coms-bus routing collisions`);
              else if (new Set(names).size < names.length)
                errs.push(`duplicate name: values among members using agent "${agent}" — each must be unique`);
            }
          }
        } else {
          errs.push(`Unknown kind: "${kind}". Use 'chain' or 'team'.`);
        }
      }
      if (errs.length) return { content: [{ type: "text" as const, text: `Validation errors:\n${errs.map(e => `  • ${e}`).join("\n")}` }], details: { errors: errs }, isError: true };

      const dir  = workspaceCharterDir() ?? path.join(os.homedir(), ".config", "pi", "charters");
      const dest = path.join(dir, `${safeName}.yaml`);
      const isNew = !existsSync(dest);

      if (!isNew && !params.overwrite) {
        return { content: [{ type: "text" as const, text: `Error: charter "${safeName}" already exists. Pass overwrite:true to replace it.` }], details: {}, isError: true };
      }
      if (!isNew) {
        writeFileSync(`${dest}.bak.${Date.now()}`, readFileSync(dest, "utf-8"), "utf-8");
      }

      mkdirSync(dir, { recursive: true });
      writeFileSync(dest, params.yaml_content.trimEnd() + "\n", "utf-8");

      // Auto-commit to workspace repo
      const relPath = `charters/${safeName}.yaml`;
      const commit = commitWorkspaceFile(relPath, isNew);
      const commitNote = commit.committed
        ? ` (committed ${commit.hash}: ${commit.message})`
        : commit.error ? ` (commit failed: ${commit.error})` : "";

      const verb = isNew ? "written" : "updated";
      return {
        content: [{ type: "text" as const, text: `Charter "${safeName}" ${verb} to ${dest}${commitNote}` }],
        details: { path: dest, kind: kindMatch?.[1], committed: commit.committed, hash: commit.hash },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("charter_author ")) + theme.fg("accent", (args as any).name ?? "?"), 0, 0);
    },
    renderResult(result, _opts, theme) {
      return new Text(result.isError
        ? theme.fg("error", "✗ ") + result.content[0]?.text
        : theme.fg("success", "✓ ") + theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);
    },
  });

  // ── /ag:init ──────────────────────────────────────────────────────────────

  pi.registerCommand("ag:init", {
    description: "Initialize or reconfigure the pi agents workspace",
    handler: async (_args, ctx) => {
      const existing = getWorkspace();

      if (existing) {
        // Already configured: show status + action menu
        const agentCount   = (() => { try { return readdirSync(path.join(existing.workspace, "agents")).filter(f => f.endsWith(".md")).length; } catch { return 0; } })();
        const charterCount = (() => { try { return readdirSync(path.join(existing.workspace, "charters")).filter(f => f.endsWith(".yaml") || f.endsWith(".yml")).length; } catch { return 0; } })();
        const isGit    = existsSync(path.join(existing.workspace, ".git"));
        const subtitle = `${existing.workspace}  ·  ${agentCount} agents · ${charterCount} charters · autoCommit: ${existing.autoCommit ? "on" : "off"} · git: ${isGit ? "yes" : "no"}`;

        const choice = await showInitMenu(ctx, "ag:init — Workspace", subtitle, [
          { value: "path",   label: "Reconfigure path",  description: "Change where the workspace repo lives" },
          { value: "commit", label: "Toggle autoCommit",  description: `Currently: ${existing.autoCommit ? "on → off" : "off → on"}` },
          { value: "cancel", label: "Cancel",             description: "" },
        ]);
        if (!choice || choice === "cancel") return;

        if (choice === "commit") {
          const updated = { workspace: existing.workspace.replace(os.homedir(), "~"), autoCommit: !existing.autoCommit };
          writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`autoCommit → ${updated.autoCommit}. Run /reload to apply.`, "info");
          return;
        }
        // "path" falls through to path-entry flow

      } else {
        // Not yet configured: onboarding entry point
        const intro = await showInitMenu(ctx, "ag:init — Setup", "No workspace configured yet.", [
          { value: "setup",  label: "Set up workspace", description: "Choose a path, create dirs, initialize git" },
          { value: "cancel", label: "Cancel",           description: "" },
        ]);
        if (!intro || intro === "cancel") return;
      }

      // Path entry
      const defaultPath = existing?.workspace.replace(os.homedir(), "~") ?? "~/code/hacking/pi_agents";
      const rawPath = await ctx.ui.input("Workspace path", { placeholder: defaultPath, initialValue: defaultPath });
      if (!rawPath?.trim()) { ctx.ui.notify("Cancelled.", "info"); return; }

      const resolved  = rawPath.trim().replace(/^~/, os.homedir());
      const dirExists = existsSync(resolved);
      const hasGit    = existsSync(path.join(resolved, ".git"));

      // Determine mode
      let mode: string | null;
      if (dirExists && hasGit) {
        mode = "existing";  // existing git repo — just point config at it
      } else if (dirExists) {
        mode = await showInitMenu(ctx, "ag:init — Existing Directory",
          `${resolved} exists but is not a git repo.`,
          [
            { value: "init",   label: "Initialize here", description: "git init + create agents/, charters/, skills/" },
            { value: "cancel", label: "Cancel",          description: "" },
          ],
        );
      } else {
        mode = await showInitMenu(ctx, "ag:init — New Workspace",
          `${resolved} does not exist.`,
          [
            { value: "init",   label: "Create workspace", description: "mkdir + git init + subdirs + .gitignore" },
            { value: "cancel", label: "Cancel",           description: "" },
          ],
        );
      }
      if (!mode || mode === "cancel") { ctx.ui.notify("Cancelled.", "info"); return; }

      // Create workspace if needed
      if (mode === "init") {
        try {
          mkdirSync(path.join(resolved, "agents"),   { recursive: true });
          mkdirSync(path.join(resolved, "charters"), { recursive: true });
          mkdirSync(path.join(resolved, "skills"),   { recursive: true });
          execSync(`git -C ${JSON.stringify(resolved)} init`, { stdio: "pipe" });
          writeFileSync(path.join(resolved, ".gitignore"), "*.bak.*\n*.bak\n", "utf-8");
          execSync(`git -C ${JSON.stringify(resolved)} add .gitignore`, { stdio: "pipe" });
          execSync(`git -C ${JSON.stringify(resolved)} commit -m "chore: init pi_agents workspace"`, { stdio: "pipe" });
        } catch (e: any) {
          ctx.ui.notify(`Setup failed: ${e?.message ?? e}`, "error"); return;
        }
      }

      // autoCommit preference
      const commitChoice = await showInitMenu(ctx, "ag:init — Auto-commit",
        "Automatically commit after every agent/charter write?",
        [
          { value: "on",  label: "Yes — auto-commit", description: "Every write creates a conventional-commit with a derived message" },
          { value: "off", label: "No — manual only",  description: "You commit to the workspace repo yourself" },
        ],
      );
      if (commitChoice === null) { ctx.ui.notify("Cancelled.", "info"); return; }

      // Write config
      const newConfig = { workspace: rawPath.trim(), autoCommit: commitChoice === "on" };
      writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2) + "\n", "utf-8");
      ctx.ui.notify(
        [`✓ Workspace: ${resolved}`, `  autoCommit: ${newConfig.autoCommit}`, `  Run /reload to activate.`].join("\n"),
        "info",
      );
    },
  });
}
