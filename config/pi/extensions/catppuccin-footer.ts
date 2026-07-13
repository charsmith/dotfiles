/**
 * Catppuccin Mocha footer for pi — mirrors the Claude statusline-command.sh style:
 *
 *   [ os  charsmith ][ …/dir ][ git-branch ][ model ][ ctx:N% ][ $cost in/out ]
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Cached git dirty flag — updated async, read synchronously inside render()
  let gitDirty = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let activeTui: any;

  async function refreshGitDirty(cwd: string): Promise<void> {
    try {
      const r = await pi.exec("git", ["status", "--porcelain"], { cwd });
      gitDirty = r.code === 0 && r.stdout.trim().length > 0;
    } catch {
      gitDirty = false;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    void refreshGitDirty(ctx.cwd);

    ctx.ui.setFooter((tui: any, _theme: any, footerData: any) => {
      activeTui = tui;

      const unsubBranch = footerData.onBranchChange(() => {
        void refreshGitDirty(ctx.cwd).then(() => tui.requestRender());
      });

      return {
        dispose: () => {
          activeTui = undefined;
          unsubBranch();
        },
        invalidate() {},
        render(width: number): string[] {
          try {
            return [buildStatusBar(ctx, footerData.getGitBranch(), width)];
          } catch {
            // Never let a footer bug take down the whole session — fall back
            // to a minimal, guaranteed-safe line rather than throwing.
            return [""];
          }
        },
      };
    });
  });

  // Refresh dirty state + re-render after each agent turn completes
  pi.on("agent_end", (_event, ctx) => {
    void refreshGitDirty(ctx.cwd).then(() => activeTui?.requestRender());
  });

  // ─── Render ────────────────────────────────────────────────────────────────

  function buildStatusBar(ctx: ExtensionContext, gitBranch: string | null, width: number): string {
    // Leave a 1-column safety margin — some terminals/renderers treat an
    // exact-width line as an overflow (this caused hard crashes previously).
    const budget = Math.max(0, (Number.isFinite(width) && width > 0 ? width : 158) - 1);
    let visibleLen = 0;
    const truncate = (s: string, max: number): string =>
      s.length > max ? (max <= 1 ? s.slice(0, max) : `${s.slice(0, max - 1)}\u2026`) : s;
    // Catppuccin Mocha RGB values (same as statusline-command.sh)
    const _surface0 = "49;50;68";
    const _peach    = "250;179;135";
    const _green    = "166;227;161";
    const _teal     = "148;226;213";
    const _blue     = "137;180;250";
    const _yellow   = "249;226;175";
    const _text     = "205;214;244";
    const _mantle   = "24;24;37";
    const _base     = "30;30;46";

    // ANSI helpers — match statusline-command.sh exactly
    const fg    = (c: string)             => `\x1b[38;2;${c}m`;
    const fg_bg = (bg: string, f: string) => `\x1b[48;2;${bg};38;2;${f}m`;
    const reset = "\x1b[0m";

    // Nerd Font glyphs
    const cap_open = "\uE0B6"; // rounded left pill cap
    const arrow    = "\uE0B0"; // solid right chevron
    const os_icon  = "\uE711"; // macOS logo
    const git_icon = "\uF418"; // git branch icon

    // ── Directory (starship style: …/parent/leaf) ──────────────────────────
    const ellipsis = "\u2026";
    const rawDir   = ctx.cwd ?? "";
    const home     = process.env.HOME ?? "";
    let shortDir: string;
    const relDir = rawDir.startsWith(home + "/") ? rawDir.slice(home.length + 1) : rawDir;
    if (relDir === rawDir) {
      shortDir = rawDir;
    } else {
      const segs = relDir.split("/");
      const cnt  = segs.length;
      shortDir   = cnt > 2
        ? `${ellipsis}/${segs[cnt - 2]}/${segs[cnt - 1]}`
        : `${ellipsis}/${segs[cnt - 1]}`;
    }

    // ── Cost + token totals from session branch ────────────────────────────
    // usage.input is only non-cached new tokens; use getContextUsage().tokens
    // for the real current context size (includes cache hits).
    let cost = 0, tokensOut = 0;
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        tokensOut += m.usage.output;
        cost      += m.usage.cost.total;
      }
    }

    // ── Model display name ─────────────────────────────────────────────────
    const model = (ctx.model as any)?.name ?? ctx.model?.id ?? "";

    // ── Context usage % + current context token count ─────────────────────
    const usage    = ctx.getContextUsage();
    const usedPct  = (usage && usage.percent !== null) ? Math.round(usage.percent) : null;
    const tokensIn = usage?.tokens ?? 0;

    // ── Token formatter (matches statusline-command.sh fmt_tokens) ─────────
    const fmtTokens = (n: number): string => {
      if (n >= 1000) {
        const k = Math.floor(n / 1000);
        const r = Math.floor((n % 1000) / 100);
        return r > 0 ? `${k}.${r}k` : `${k}k`;
      }
      return `${n}`;
    };

    // ── Assemble pill segments ─────────────────────────────────────────────
    // Every segment tracks its own *visible* (non-ANSI) width against
    // `budget` so the assembled line can never overflow the terminal width
    // (an overflow previously crashed the whole pi renderer with no error).
    let out = "";
    let prev = _surface0;

    // addSeg: appends styled text but only if `visibleText` fits in the
    // remaining budget. Returns true if the segment was added.
    const addSeg = (styled: string, visibleText: string): boolean => {
      if (visibleLen + visibleText.length > budget) return false;
      out += styled;
      visibleLen += visibleText.length;
      return true;
    };

    // Opening rounded cap — fg:surface0, no bg (left pill edge). Glyph is a
    // single visible column.
    addSeg(`${fg(_surface0)}${cap_open}`, " ");

    // Segment 1: os icon + username — always shown, always short.
    {
      const text = `${os_icon} charsmith `;
      addSeg(`${fg_bg(_surface0, _text)}${text}`, text);
    }

    // Segment 2: directory — truncate to fit if the budget is tight.
    {
      const remaining = budget - visibleLen;
      const dirText = ` ${truncate(shortDir, Math.max(0, remaining - 3))} `; // -3 for arrow+padding
      if (addSeg(`${fg_bg(_peach, _surface0)}${arrow}${fg(_mantle)}${dirText}`, `${arrow}${dirText}`)) {
        prev = _peach;
      }
    }

    // Segment 3: git branch (optional) — the variable-length segment most
    // likely to overflow (charter run branch names embed a full task path).
    // Truncate it to whatever's left rather than dropping other segments.
    if (gitBranch) {
      const suffix = gitDirty ? " !? " : " ";
      const remaining = budget - visibleLen - `${arrow} ${git_icon} `.length - suffix.length;
      if (remaining > 0) {
        const branchText = truncate(gitBranch, remaining);
        const visible = `${arrow} ${git_icon} ${branchText}${suffix}`;
        if (addSeg(`${fg_bg(_green, prev)}${arrow}${fg(_base)} ${git_icon} ${branchText}${suffix}`, visible)) {
          prev = _green;
        }
      }
    }

    // Segment 4: model (optional) — dropped entirely if there's no room.
    if (model) {
      const text = ` ${model} `;
      if (addSeg(`${fg_bg(_teal, prev)}${arrow}${fg(_base)}${text}`, `${arrow}${text}`)) {
        prev = _teal;
      }
    }

    // Segment 5: context % (optional) — dropped entirely if there's no room.
    if (usedPct !== null) {
      const text = ` ctx:${usedPct}% `;
      if (addSeg(`${fg_bg(_blue, prev)}${arrow}${fg(_base)}${text}`, `${arrow}${text}`)) {
        prev = _blue;
      }
    }

    // Segment 6: cost + token breakdown (optional, only once cost > 0) —
    // dropped entirely if there's no room.
    if (cost > 0) {
      const costFmt = `$${cost.toFixed(3)}`;
      const tokFmt  = (tokensIn > 0 || tokensOut > 0)
        ? ` \u2191${fmtTokens(tokensIn)} \u2193${fmtTokens(tokensOut)}`
        : "";
      const text = ` ${costFmt}${tokFmt} `;
      if (addSeg(`${fg_bg(_yellow, prev)}${arrow}${fg(_base)}${text}`, `${arrow}${text}`)) {
        prev = _yellow;
      }
    }

    // Closing chevron back to terminal background — always safe, 1 column.
    out += `${fg(prev)}${arrow}${reset}`;

    return out;
  }
}
