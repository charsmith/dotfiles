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
        render(_width: number): string[] {
          return [buildStatusBar(ctx, footerData.getGitBranch())];
        },
      };
    });
  });

  // Refresh dirty state + re-render after each agent turn completes
  pi.on("agent_end", (_event, ctx) => {
    void refreshGitDirty(ctx.cwd).then(() => activeTui?.requestRender());
  });

  // ─── Render ────────────────────────────────────────────────────────────────

  function buildStatusBar(ctx: ExtensionContext, gitBranch: string | null): string {
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
    let out = "";
    let prev = _surface0;

    // Opening rounded cap — fg:surface0, no bg (left pill edge)
    out += `${fg(_surface0)}${cap_open}`;

    // Segment 1: os icon + username
    out += `${fg_bg(_surface0, _text)}${os_icon} charsmith `;

    // Segment 2: directory
    out += `${fg_bg(_peach, _surface0)}${arrow}`;
    out += `${fg(_mantle)} ${shortDir} `;
    prev = _peach;

    // Segment 3: git branch (optional)
    if (gitBranch) {
      out += `${fg_bg(_green, prev)}${arrow}`;
      out += `${fg(_base)} ${git_icon} ${gitBranch}${gitDirty ? " !? " : " "}`;
      prev = _green;
    }

    // Segment 4: model (optional)
    if (model) {
      out += `${fg_bg(_teal, prev)}${arrow}`;
      out += `${fg(_base)} ${model} `;
      prev = _teal;
    }

    // Segment 5: context % (optional)
    if (usedPct !== null) {
      out += `${fg_bg(_blue, prev)}${arrow}`;
      out += `${fg(_base)} ctx:${usedPct}% `;
      prev = _blue;
    }

    // Segment 6: cost + token breakdown (optional, only once cost > 0)
    if (cost > 0) {
      const costFmt = `$${cost.toFixed(3)}`;
      const tokFmt  = (tokensIn > 0 || tokensOut > 0)
        ? ` \u2191${fmtTokens(tokensIn)} \u2193${fmtTokens(tokensOut)}`
        : "";
      out += `${fg_bg(_yellow, prev)}${arrow}`;
      out += `${fg(_base)} ${costFmt}${tokFmt} `;
      prev = _yellow;
    }

    // Closing chevron back to terminal background
    out += `${fg(prev)}${arrow}${reset}`;

    return out;
  }
}
