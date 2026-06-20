/**
 * catalog-loader — shared charter/catalog types and YAML loading.
 *
 * Both chains and teams use the same `members:` list. The `kind:` field
 * drives execution: chains run members as a sequential pipeline; teams run
 * them as a hub-spoke coordination. Chain-specific fields (prompt, model,
 * clearContext) are ignored for teams; team-specific fields (role, reports_to)
 * are ignored for chains.
 *
 * Loads from (first-seen wins on name clash):
 *   ~/.config/pi/charters/<name>.yaml   (primary; filename = charter name)
 *   .pi/charters/<name>.yaml            (project-local)
 *   agent-chain.yaml                    (legacy; steps: key still accepted)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseYaml } from "./mini-yaml.ts";

// ─── Unified member definition ────────────────────────────────────────────────
//
// All fields are optional except `agent` (the display name + agent.md lookup).
// Chain-specific and team-specific fields coexist on the same type; each
// execution mode ignores fields it doesn't use.

export interface MemberDef {
  agent: string;           // display name; also the agent.md filename to try
  // Persona (chain + team)
  description?: string;    // fallback system prompt if no agent.md found
  system_prompt?: string;  // explicit inline persona (wins over description)
  model?: string;          // optional per-member model override
  // Chain-specific
  prompt?: string;         // input template ($INPUT / $ORIGINAL); default "$INPUT"
  clearContext?: boolean;  // ephemeral per-topic (default true)
  // Team-specific
  role?: string;           // coordinator | specialist | etc.
  reports_to?: string;     // routing hint for retro analysis
}

// ─── Charter definitions ──────────────────────────────────────────────────────

export interface ChainDef {
  name: string;
  kind: "chain";
  description?: string;
  members: MemberDef[];
  persist: boolean;
  clearContext: boolean;    // chain-level default; per-member clearContext overrides
}

export interface TeamDef {
  name: string;
  kind: "team";
  description?: string;
  guardrail?: "confirm" | "auto" | "never";
  persist?: boolean;
  topology?: string;
  entry_point?: string;
  members: MemberDef[];
}

// Back-compat alias — pi-chain.ts still references StepDef in a few places.
export type StepDef = MemberDef;

// ─── File paths ───────────────────────────────────────────────────────────────

export function charterDirs(): string[] {
  return [
    path.join(os.homedir(), ".config", "pi", "charters"),
    path.join(process.cwd(), ".pi", "charters"),
  ];
}

export function legacyChainFiles(): string[] {
  return [
    path.join(os.homedir(), ".config", "pi", "agents", "agent-chain.yaml"),
    path.join(process.cwd(), ".pi", "agents", "agent-chain.yaml"),
  ];
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function parseMember(m: any): MemberDef | null {
  if (!m || typeof m !== "object") return null;
  // Support both `agent:` (new) and legacy step fields
  const agent = m.agent ?? m.name;
  if (!agent || typeof agent !== "string") return null;
  return {
    agent,
    description: m.description,
    system_prompt: m.system_prompt,
    model: m.model,
    prompt: m.prompt,
    clearContext: typeof m.clearContext === "boolean" ? m.clearContext : undefined,
    role: m.role,
    reports_to: m.reports_to,
  };
}

export function parseCharterBlock(
  name: string, raw: any,
  chains: Map<string, ChainDef>, teams: Map<string, TeamDef>, errors: string[],
): void {
  if (!raw || typeof raw !== "object") return;

  if (raw.kind === "chain") {
    if (chains.has(name)) return;
    // Accept both `members:` (new) and `steps:` (legacy)
    const rawMembers = raw.members ?? raw.steps;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      errors.push(`chain "${name}": missing or empty members/steps`); return;
    }
    const members: MemberDef[] = [];
    let ok = true;
    for (let i = 0; i < rawMembers.length; i++) {
      const m = parseMember(rawMembers[i]);
      if (!m) {
        // Legacy step: might be an inline system_prompt step without agent:
        const s = rawMembers[i];
        if (s?.system_prompt) {
          members.push({
            agent: "",  // inline-only: no agent.md needed
            system_prompt: s.system_prompt,
            model: s.model,
            prompt: s.prompt ?? "$INPUT",
            clearContext: typeof s.clearContext === "boolean" ? s.clearContext : undefined,
          });
          continue;
        }
        errors.push(`chain "${name}" member ${i + 1}: needs "agent" or "system_prompt"`);
        ok = false; break;
      }
      if (!m.prompt) m.prompt = "$INPUT";  // default
      members.push(m);
    }
    if (ok) chains.set(name, {
      name, kind: "chain", description: raw.description, members,
      persist: raw.persist === true,
      clearContext: raw.clearContext !== false,
    });

  } else if (raw.kind === "team") {
    if (teams.has(name)) return;
    const rawMembers = raw.members;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      errors.push(`team "${name}": missing or empty members`); return;
    }
    const members: MemberDef[] = rawMembers.map(parseMember).filter(Boolean) as MemberDef[];
    if (members.length === 0) {
      errors.push(`team "${name}": no valid members parsed`); return;
    }
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

// ─── Loaders ──────────────────────────────────────────────────────────────────

export function loadCatalog(): { chains: Map<string, ChainDef>; teams: Map<string, TeamDef>; errors: string[] } {
  const chains = new Map<string, ChainDef>();
  const teams  = new Map<string, TeamDef>();
  const errors: string[] = [];

  for (const dir of charterDirs()) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml")); }
    catch { continue; }
    for (const f of files) {
      const name = f.replace(/\.ya?ml$/, "");
      try { parseCharterBlock(name, parseYaml(readFileSync(path.join(dir, f), "utf-8")), chains, teams, errors); }
      catch (e: any) { errors.push(`${f}: parse error: ${e?.message ?? e}`); }
    }
  }

  for (const file of legacyChainFiles()) {
    if (!existsSync(file)) continue;
    let doc: any;
    try { doc = parseYaml(readFileSync(file, "utf-8")); }
    catch (e: any) { errors.push(`${file}: parse error: ${e?.message ?? e}`); continue; }
    if (!doc || typeof doc !== "object") continue;
    for (const [n, raw] of Object.entries<any>(doc)) {
      parseCharterBlock(n, raw, chains, teams, errors);
    }
  }

  return { chains, teams, errors };
}

export function loadChains(): { chains: Map<string, ChainDef>; errors: string[] } {
  const { chains, errors } = loadCatalog();
  return { chains, errors };
}
