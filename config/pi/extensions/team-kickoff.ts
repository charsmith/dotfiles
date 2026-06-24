/**
 * team-kickoff — /ag:charter command
 *
 * /ag:charter [task]
 *   Quick picker: shows all charters in a SelectList, alphabetically.
 *   If task arg provided, immediately queues a run after selection.
 *
 * To design a new charter from a task description, use the charter-builder-chain:
 *   run_chain("charter-builder-chain", "<task description>")
 *   → charter-planner reads catalog and outputs a JSON spec
 *   → charter-builder writes the YAML file
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { workspaceCharterDir } from "./lib/workspace.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Spacer, Text } from "@earendil-works/pi-tui";


// ─── Charter loader ───────────────────────────────────────────────────────────

interface CharterEntry {
  name: string;
  description: string;
}

function loadCharters(): CharterEntry[] {
  // Check all charter dirs: workspace first, then project-local, then legacy
  const dirs: string[] = [];
  const ws = workspaceCharterDir();
  if (ws) dirs.push(ws);
  dirs.push(join(process.cwd(), ".pi", "charters"));
  if (!ws) dirs.push(join(os.homedir(), ".config", "pi", "charters"));

  const seen = new Set<string>();
  const entries: CharterEntry[] = [];

  for (const chartersDir of dirs) {
    if (!existsSync(chartersDir)) continue;
    const files = readdirSync(chartersDir).filter(
      (f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && !f.endsWith(".bak"),
    );
    for (const f of files) {
      const name = f.replace(/\.ya?ml$/, "");
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const content = readFileSync(join(chartersDir, f), "utf-8");
        const m = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
        entries.push({ name, description: m ? m[1].replace(/^["']|["']$/g, "").trim() : "" });
      } catch {
        entries.push({ name, description: "" });
      }
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
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
