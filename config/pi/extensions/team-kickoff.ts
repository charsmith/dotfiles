/**
 * team-kickoff — /ag:charter command + pick_charter tool
 *
 * /ag:charter [task]
 *   Quick picker: shows all charters in a SelectList, alphabetically.
 *   If task arg provided, immediately queues a run after selection.
 *
 * pick_charter tool (LLM-callable)
 *   Called by the LLM after running team-planner.
 *   Receives structured recommendations and shows a sectioned SelectList:
 *     ★  recommended (up to 3, best-fit first)
 *     ✦  create new team (proposed spec)
 *        all other charters, alphabetically
 *
 * Flow for task-driven kickoff:
 *   user describes task
 *   → LLM: launch_agent(team-planner, task)
 *   → LLM: pick_charter(task, recommended, proposed)
 *   → user picks in SelectList
 *   → LLM: run_charter(charter, task)  OR  team-builder for new team
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Charter loader ───────────────────────────────────────────────────────────

interface CharterEntry {
  name: string;
  description: string;
}

function loadCharters(): CharterEntry[] {
  const chartersDir = join(os.homedir(), ".config", "pi", "charters");
  if (!existsSync(chartersDir)) return [];

  const files = readdirSync(chartersDir).filter(
    (f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && !f.endsWith(".bak"),
  );

  return files
    .map((f) => {
      const name = f.replace(/\.ya?ml$/, "");
      try {
        const content = readFileSync(join(chartersDir, f), "utf-8");
        const m = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
        return { name, description: m ? m[1].replace(/^["']|["']$/g, "").trim() : "" };
      } catch {
        return { name, description: "" };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Shared SelectList UI builder ─────────────────────────────────────────────

async function showPicker(
  ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
  items: SelectItem[],
  title: string,
  subtitle?: string,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    let query = "";
    const queryText = new Text("", 1, 0);

    function updateQuery(newQuery: string) {
      query = newQuery;
      const display = query
        ? theme.fg("accent", ` /${query}`) + theme.fg("dim", "_")
        : theme.fg("dim", " /filter…");
      queryText.setText(display);
      list.setFilter(query);
      tui.requestRender();
    }

    const container = new Container();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(` ${title}`)), 1, 0));
    if (subtitle) {
      container.addChild(
        new Text(
          theme.fg("muted", ` ${subtitle.length > 72 ? subtitle.slice(0, 69) + "…" : subtitle}`),
          1,
          0,
        ),
      );
    }
    container.addChild(queryText);
    container.addChild(new Spacer(1));

    const list = new SelectList(items, Math.min(items.length + 2, 16), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText:   (t) => theme.fg("accent", t),
      description:    (t) => theme.fg("muted", t),
      scrollInfo:     (t) => theme.fg("dim", t),
      noMatch:        (t) => theme.fg("warning", t),
    });

    list.onSelect = (item) => {
      // Section headers are non-actionable — skip them
      if (item.value.startsWith("__")) return;
      done(item.value);
    };
    list.onCancel = () => done(null);

    container.addChild(list);
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("dim", " ↑↓ navigate · type to filter · backspace clear · esc cancel"), 1, 0),
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    // Seed display
    updateQuery("");

    return {
      render:     (w) => container.render(w),
      invalidate: ()  => container.invalidate(),
      handleInput(d: string) {
        // Backspace / delete — trim query
        if (d === "\x7f" || d === "\x08") {
          updateQuery(query.slice(0, -1));
          return;
        }
        // Escape — clear query first, then cancel if already empty
        if (d === "\x1b") {
          if (query) { updateQuery(""); return; }
          list.handleInput(d);
          tui.requestRender();
          return;
        }
        // Navigation / confirm — pass through to SelectList
        if (d === "\x1b[A" || d === "\x1b[B" || d === "\r" || d === "\n") {
          list.handleInput(d);
          tui.requestRender();
          return;
        }
        // Printable ASCII — append to query
        if (d.length === 1 && d.charCodeAt(0) >= 32) {
          updateQuery(query + d);
          return;
        }
        // Everything else (ctrl keys, etc.) — pass through
        list.handleInput(d);
        tui.requestRender();
      },
    };
  });
}

// ─── Task input dialog ───────────────────────────────────────────────────────

async function showTaskInput(
  ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
  charter: string,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const input = new Input();
    input.focused = true;

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(` Task for "${charter}"`)), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", " What do you want to research?"), 1, 0));
    container.addChild(new Text(theme.fg("dim",   " >"), 1, 0));
    container.addChild(input);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", " enter to confirm · esc to cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    input.onSubmit = (value) => {
      const task = value.trim();
      if (task) done(task);
    };
    input.onEscape = () => done(null);

    return {
      render:     (w) => container.render(w),
      invalidate: ()  => container.invalidate(),
      handleInput(d: string) { input.handleInput(d); tui.requestRender(); },
    };
  });
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── pick_charter tool ─────────────────────────────────────────────────────────
  // LLM calls this after running team-planner with structured results.

  pi.registerTool({
    name: "pick_charter",
    label: "Pick Team",
    description:
      "Show an interactive team picker after running team-planner. " +
      "Pass the structured recommendations from team-planner output. " +
      "Returns the selected charter name or a signal to build a new team.",
    promptSnippet: "Show a team selection UI after analyzing a task with team-planner",
    parameters: Type.Object({
      task: Type.String({ description: "The research task" }),
      recommended: Type.Array(
        Type.Object({
          charter:  Type.String({ description: "Existing charter name" }),
          fit:      Type.String({ description: "Why this charter fits" }),
          gap:      Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        { description: "Up to 3 recommended existing charters, best-fit first" },
      ),
      proposed: Type.Optional(
        Type.Union([
          Type.Object({
            name: Type.String({ description: "Proposed charter name" }),
            why:  Type.String({ description: "Why a new team is needed" }),
            members: Type.Array(
              Type.Object({
                agent:       Type.String(),
                name:        Type.Optional(Type.String()),
                role:        Type.String(),
                context:     Type.Optional(Type.String()),
                context_dir: Type.Optional(Type.String()),
              }),
            ),
          }),
          Type.Null(),
        ]),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const allCharters  = loadCharters();
      const recNames     = new Set(params.recommended.map((r) => r.charter));
      const items: SelectItem[] = [];

      // Section: recommended
      if (params.recommended.length > 0) {
        for (const rec of params.recommended.slice(0, 3)) {
          const gap = rec.gap && rec.gap !== "none" && rec.gap !== "null"
            ? `  ·  gap: ${rec.gap}` : "";
          items.push({
            value:       `existing:${rec.charter}`,
            label:       `★  ${rec.charter}`,
            description: rec.fit + gap,
          });
        }
        // Visual separator (non-actionable — onSelect will skip __-prefixed values)
        items.push({ value: "__sep1__", label: "─".repeat(40), description: "" });
      }

      // Option: create new team
      if (params.proposed) {
        items.push({
          value:       "new",
          label:       "✦  Create new team",
          description: `${params.proposed.name}  ·  ${params.proposed.why}`,
        });
        items.push({ value: "__sep2__", label: "─".repeat(40), description: "" });
      }

      // Section: all other charters
      for (const c of allCharters.filter((c) => !recNames.has(c.name))) {
        items.push({ value: `existing:${c.name}`, label: `   ${c.name}`, description: c.description });
      }

      const result = await showPicker(ctx, items, "Select a team", params.task);

      if (!result) {
        return { content: [{ type: "text" as const, text: "Team picker cancelled." }], details: {} };
      }

      if (result === "new" && params.proposed) {
        // Build a human-readable YAML preview of the proposed members for team-builder
        const memberLines = params.proposed.members.map((m) => {
          const lines = [`  - agent: ${m.agent}`];
          if (m.name)        lines.push(`    name: ${m.name}`);
          lines.push(`    role: ${m.role}`);
          if (m.context)     lines.push(`    context: "${m.context}"`);
          if (m.context_dir) lines.push(`    context_dir: ${m.context_dir}`);
          if (m.role !== "coordinator") lines.push(`    reports_to: coordinator`);
          return lines.join("\n");
        }).join("\n");

        return {
          content: [{ type: "text" as const, text:
            `User chose to create a new team.\n\n` +
            `Charter name: ${params.proposed.name}\n` +
            `Why: ${params.proposed.why}\n\n` +
            `Proposed members:\n${memberLines}\n\n` +
            `Run team-builder with this spec. Show the user the charter YAML before writing it.`,
          }],
          details: { action: "new", proposed: params.proposed },
        };
      }

      const charter = result.replace("existing:", "");
      return {
        content: [{ type: "text" as const, text:
          `User selected "${charter}". Call run_charter("${charter}", task) to run it.`,
        }],
        details: { action: "run", charter },
      };
    },
  });

  // ── /ag:charter command ─────────────────────────────────────────────────────
  // Quick catalog picker — no LLM analysis, just browse and pick.

  pi.registerCommand("ag:charter", {
    description: "Browse the charter catalog and pick one to run  ·  /ag:charter [task]",
    handler: async (args, ctx) => {
      const charters = loadCharters();
      if (charters.length === 0) {
        ctx.ui.notify("No charters found in ~/.config/pi/charters/", "warning");
        return;
      }

      const items: SelectItem[] = charters.map((c) => ({
        value:       c.name,
        label:       c.name,
        description: c.description,
      }));

      let task = args?.trim() ?? "";
      const subtitle = task ? `Task: ${task}` : "Pick a charter — type to filter";
      const selected = await showPicker(ctx, items, "Select a team", subtitle);

      if (!selected) return;

      // If no task provided upfront, ask for it in a second TUI step
      if (!task) {
        const entered = await showTaskInput(ctx, selected);
        if (!entered) return;
        task = entered;
      }

      pi.sendUserMessage(
        `Run the "${selected}" charter on this task: ${task}`,
        { deliverAs: "followUp" },
      );
    },
  });
}
