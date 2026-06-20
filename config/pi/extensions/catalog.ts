/**
 * catalog — unified view of all agents, chains, and teams.
 *
 * Tools:    catalog_list, catalog_read, catalog_validate
 * Commands: /catalog [filter]
 *
 * The catalog is derived on-demand from the filesystem:
 *   Agents: ~/.config/pi/agents/*.md  (YAML frontmatter + system prompt)
 *   Chains + Teams: agent-chain.yaml  (kind: chain | kind: team)
 *
 * No index file — always in sync with the source files.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

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

// ─── Catalog readers ──────────────────────────────────────────────────────────

const AGENT_DIRS = [
  path.join(os.homedir(), ".config", "pi", "agents"),
  path.join(os.homedir(), ".pi", "agents"),
];

const CHARTER_DIRS = [
  path.join(os.homedir(), ".config", "pi", "charters"),
  path.join(process.cwd(), ".pi", "charters"),
];

// Back-compat: legacy monolithic file
const LEGACY_CHAIN_FILES = [
  path.join(os.homedir(), ".config", "pi", "agents", "agent-chain.yaml"),
  path.join(process.cwd(), ".pi", "agents", "agent-chain.yaml"),
];

function readAgents(): AgentEntry[] {
  const seen = new Set<string>();
  const out: AgentEntry[] = [];
  for (const dir of AGENT_DIRS) {
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

// Minimal YAML parser — handles enough for agent-chain.yaml.
// Re-implements just what we need rather than importing mini-yaml.ts
// (which lives in the pi-chain extension and isn't re-exported).
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
      const m = line.match(/^(\w[\w-]*)\s*:/);
      if (m) { currentKey = m[1]; currentObj = {}; }
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

function ingestCharterBlock(name: string, raw: any, seenChains: Set<string>, seenTeams: Set<string>, chains: ChainEntry[], teams: TeamEntry[]) {
  if (!raw || typeof raw !== "object") return;
  if (raw.kind === "chain" && !seenChains.has(name)) {
    seenChains.add(name);
    chains.push({ name, description: raw.description, steps: Array.isArray(raw.steps) ? raw.steps.length : 0, persist: raw.persist === "true" || raw.persist === true });
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

  // Per-file charters (primary)
  for (const dir of CHARTER_DIRS) {
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

  // Legacy monolithic agent-chain.yaml
  for (const file of LEGACY_CHAIN_FILES) {
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
  const agents = readAgents();
  const { chains, teams } = readChainsAndTeams();
  return { agents, chains, teams };
}

// ─── Catalog digest (compact one-liner per entry for session context) ─────────

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

export default function (pi: ExtensionAPI) {
  // Catalog tools are main-thread only — subagents don't need to browse or
  // author charters, and loading the tools wastes their context budget.
  if (process.env.PI_SUBAGENT) return;

  // ── Catalog digest injected into every turn's system prompt ───────────────
  // before_agent_start fires before each LLM turn so the digest is always
  // current (picks up new charters written mid-session). Appended as a small
  // block after the existing system prompt — doesn't replace anything.

  pi.on("before_agent_start", async (event) => {
    const digest = catalogDigest();
    if (!digest) return;
    return {
      systemPrompt: event.systemPrompt +
        `\n\n<!-- catalog-digest -->\n${digest}\n<!-- /catalog-digest -->`,
    };
  });

  // ── catalog_list ────────────────────────────────────────────────────────────

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
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { agents: agents.length, chains: chains.length, teams: teams.length } };
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

  // ── catalog_read ────────────────────────────────────────────────────────────

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

      // Check teams first
      const team = teams.find(t => t.name === n);
      if (team) {
        // Read raw YAML block from file
        for (const file of CHAIN_FILES) {
          if (!existsSync(file)) continue;
          const raw = readFileSync(file, "utf-8");
          // Find the block starting with the name
          const blockMatch = raw.match(new RegExp(`(^${n}:\\s*\\n(?:[ \\t]+.*\\n?)*)`, "m"));
          if (blockMatch) return { content: [{ type: "text" as const, text: `# Team: ${n}\n\n\`\`\`yaml\n${blockMatch[1].trimEnd()}\n\`\`\`` }], details: { kind: "team" } };
        }
        return { content: [{ type: "text" as const, text: `Team "${n}" found in catalog but YAML block could not be extracted.` }], details: { kind: "team" } };
      }

      // Check chains
      const chain = chains.find(c => c.name === n);
      if (chain) {
        for (const file of CHAIN_FILES) {
          if (!existsSync(file)) continue;
          const raw = readFileSync(file, "utf-8");
          const blockMatch = raw.match(new RegExp(`(^${n}:\\s*\\n(?:[ \\t]+.*\\n?)*)`, "m"));
          if (blockMatch) return { content: [{ type: "text" as const, text: `# Chain: ${n}\n\n\`\`\`yaml\n${blockMatch[1].trimEnd()}\n\`\`\`` }], details: { kind: "chain" } };
        }
        return { content: [{ type: "text" as const, text: `Chain "${n}" found in catalog but YAML block could not be extracted.` }], details: { kind: "chain" } };
      }

      // Check agents
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

  // ── catalog_validate ────────────────────────────────────────────────────────

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
          content: [{ type: "text" as const, text: `✓ "${params.input}" is a valid ${named.name ? "team" in named ? "team" : "chain" : "entry"} in the catalog.` }],
          details: { valid: true, name: params.input },
        };
      }

      // Try parsing as raw YAML
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

  // ── /catalog command ────────────────────────────────────────────────────────

  pi.registerCommand("ag:catalog", {
    description: "List all agents, chains, and teams.  /catalog [agent|chain|team]  or  /catalog <name>",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const { agents, chains, teams } = buildCatalog();

      // /catalog <name> — show full detail
      const allEntries = [...teams.map(t => ({ ...t, kind: "team" })), ...chains.map(c => ({ ...c, kind: "chain" })), ...agents.map(a => ({ ...a, kind: "agent" }))];
      const match = allEntries.find(e => e.name === arg);
      if (match) {
        if (match.kind === "agent") {
          const a = agents.find(x => x.name === arg)!;
          const body = `AGENT: ${a.name}\n${a.description}\nSkills: ${a.skills || "none"}  spawn_agents: ${a.spawnAgents}\nFile: ${a.filePath}`;
          ctx.ui.notify(body, "info"); return;
        }
        if (match.kind === "team") {
          const t = teams.find(x => x.name === arg)!;
          const body = `TEAM: ${t.name}\n${t.description ?? ""}\nTopology: ${t.topology}  Guardrail: ${t.guardrail}\nMembers: ${t.members.join(", ")}\nEntry point: ${t.entry_point ?? "(none)"}`;
          ctx.ui.notify(body, "info"); return;
        }
        if (match.kind === "chain") {
          const c = chains.find(x => x.name === arg)!;
          const body = `CHAIN: ${c.name}\n${c.description ?? ""}\n${c.steps} steps  persist: ${c.persist}`;
          ctx.ui.notify(body, "info"); return;
        }
      }

      // /catalog [filter]
      const filter = ["agent", "chain", "team"].includes(arg) ? arg : null;
      const lines: string[] = [];

      if (!filter || filter === "team") {
        lines.push(`TEAMS (${teams.length})`);
        for (const t of teams) lines.push(`  ${t.name}  [${t.members.length} members]  ${t.description ?? ""}`);
        if (!teams.length) lines.push("  (none)");
      }
      if (!filter || filter === "chain") {
        if (lines.length) lines.push("");
        lines.push(`CHAINS (${chains.length})`);
        for (const c of chains) lines.push(`  ${c.name}  [${c.steps} steps]  ${c.description ?? ""}`);
        if (!chains.length) lines.push("  (none)");
      }
      if (!filter || filter === "agent") {
        if (lines.length) lines.push("");
        lines.push(`AGENTS (${agents.length})`);
        for (const a of agents) lines.push(`  ${a.name}  ${a.description}`);
        if (!agents.length) lines.push("  (none)");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── agent_author ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "agent_author",
    label: "Agent Author",
    description:
      "Write or update an agent definition at ~/.config/pi/agents/<name>.md. " +
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
      const dir  = path.join(os.homedir(), ".config", "pi", "agents");
      const dest = path.join(dir, `${safeName}.md`);

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

      if (existsSync(dest) && !params.overwrite) {
        return { content: [{ type: "text" as const, text: `Error: agent "${safeName}" already exists. Pass overwrite:true to replace it.` }], details: {}, isError: true };
      }
      if (existsSync(dest)) {
        // Backup before overwrite
        writeFileSync(`${dest}.bak.${Date.now()}`, readFileSync(dest, "utf-8"), "utf-8");
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(dest, params.content, "utf-8");
      return { content: [{ type: "text" as const, text: `Agent "${safeName}" written to ${dest}` }], details: { path: dest } };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("agent_author ")) + theme.fg("accent", (args as any).name ?? "?"), 0, 0);
    },
    renderResult(result, _opts, theme) {
      return new Text(result.isError ? theme.fg("error", "✗ ") + result.content[0]?.text : theme.fg("success", "✓ ") + theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);
    },
  });

  // ── charter_author ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "charter_author",
    label: "Charter Author",
    description:
      "Write a new charter (team or chain) to ~/.config/pi/charters/<name>.yaml. " +
      "Validates structure before writing. Creates a .bak backup if overwriting. " +
      "The yaml_content must be the charter body only (no top-level name key — the filename is the name). " +
      "Always use this instead of writing charter files directly.",
    promptSnippet: "Create or update a team or chain charter",
    parameters: Type.Object({
      name: Type.String({ description: "Charter name (becomes the filename, no .yaml extension)." }),
      yaml_content: Type.String({ description: "Charter YAML body. Must include 'kind: chain' or 'kind: team' at the top level." }),
      overwrite: Type.Optional(Type.Boolean({ description: "Set true to overwrite an existing charter. Default: false." })),
    }),
    async execute(_id, params) {
      const safeName = params.name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      const dir  = path.join(os.homedir(), ".config", "pi", "charters");
      const dest = path.join(dir, `${safeName}.yaml`);

      // Basic validation
      const errs: string[] = [];
      const kindMatch = params.yaml_content.match(/^kind:\s*(\S+)/m);
      if (!kindMatch) { errs.push("Missing 'kind: chain' or 'kind: team'"); }
      else {
        const kind = kindMatch[1];
        if (kind === "chain") {
          if (!/steps:/m.test(params.yaml_content)) errs.push("kind:chain requires a 'steps' list");
        } else if (kind === "team") {
          if (!/members:/m.test(params.yaml_content)) errs.push("kind:team requires a 'members' list");
        } else {
          errs.push(`Unknown kind: "${kind}". Use 'chain' or 'team'.`);
        }
      }
      if (errs.length) return { content: [{ type: "text" as const, text: `Validation errors:\n${errs.map(e => `  • ${e}`).join("\n")}` }], details: { errors: errs }, isError: true };

      if (existsSync(dest) && !params.overwrite) {
        return { content: [{ type: "text" as const, text: `Error: charter "${safeName}" already exists. Pass overwrite:true to replace it.` }], details: {}, isError: true };
      }
      if (existsSync(dest)) {
        writeFileSync(`${dest}.bak.${Date.now()}`, readFileSync(dest, "utf-8"), "utf-8");
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(dest, params.yaml_content.trimEnd() + "\n", "utf-8");
      return { content: [{ type: "text" as const, text: `Charter "${safeName}" written to ${dest}` }], details: { path: dest, kind: kindMatch?.[1] } };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("charter_author ")) + theme.fg("accent", (args as any).name ?? "?"), 0, 0);
    },
    renderResult(result, _opts, theme) {
      return new Text(result.isError ? theme.fg("error", "✗ ") + result.content[0]?.text : theme.fg("success", "✓ ") + theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);
    },
  });
}
