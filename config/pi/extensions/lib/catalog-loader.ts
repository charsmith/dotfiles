/**
 * catalog-loader — shared charter/catalog types and YAML loading.
 *
 * Pure file I/O + parsing, no pi API. Importable by any extension that
 * needs to read charters or agent defs without depending on each other.
 *
 * Loads from (first-seen wins on name clash):
 *   ~/.config/pi/charters/<name>.yaml   (primary; filename = charter name)
 *   .pi/charters/<name>.yaml            (project-local)
 *   agent-chain.yaml                    (legacy monolithic, backward-compat)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseYaml } from "./mini-yaml.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepDef {
  agent?: string;
  system_prompt?: string;
  model?: string;
  prompt: string;
  clearContext?: boolean;
}

export interface ChainDef {
  name: string;
  kind: "chain";
  description?: string;
  steps: StepDef[];
  persist: boolean;
  clearContext: boolean;
}

export interface TeamMemberDef {
  agent: string;
  role?: string;
  description?: string;
  reports_to?: string;
}

export interface TeamDef {
  name: string;
  kind: "team";
  description?: string;
  guardrail?: "confirm" | "auto" | "never";
  persist?: boolean;
  topology?: string;
  entry_point?: string;
  members: TeamMemberDef[];
}

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

export function parseCharterBlock(
  name: string, raw: any,
  chains: Map<string, ChainDef>, teams: Map<string, TeamDef>, errors: string[],
): void {
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
        errors.push(`chain "${name}" step ${i + 1}: needs a "prompt" string`); ok = false; break;
      }
      if (!s.agent && !s.system_prompt) {
        errors.push(`chain "${name}" step ${i + 1}: needs "agent" or "system_prompt"`); ok = false; break;
      }
      steps.push({ agent: s.agent, system_prompt: s.system_prompt, model: s.model, prompt: s.prompt,
        clearContext: typeof s.clearContext === "boolean" ? s.clearContext : undefined });
    }
    if (ok) chains.set(name, { name, kind: "chain", description: raw.description, steps,
      persist: raw.persist === true, clearContext: raw.clearContext !== false });
  } else if (raw.kind === "team") {
    if (teams.has(name)) return;
    if (!Array.isArray(raw.members) || raw.members.length === 0) {
      errors.push(`team "${name}": missing or empty members`); return;
    }
    const members: TeamMemberDef[] = raw.members
      .filter((m: any) => m && typeof m.agent === "string")
      .map((m: any) => ({ agent: m.agent, role: m.role, description: m.description, reports_to: m.reports_to }));
    teams.set(name, { name, kind: "team", description: raw.description,
      guardrail: raw.guardrail ?? "confirm", persist: raw.persist === true,
      topology: raw.topology ?? "hub-spoke", entry_point: raw.entry_point, members });
  }
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
    for (const [name, raw] of Object.entries<any>(doc)) {
      parseCharterBlock(name, raw, chains, teams, errors);
    }
  }

  return { chains, teams, errors };
}

export function loadChains(): { chains: Map<string, ChainDef>; errors: string[] } {
  const { chains, errors } = loadCatalog();
  return { chains, errors };
}
