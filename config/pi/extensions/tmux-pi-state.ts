import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  // Capture the pane ID at process start — this is the pane pi was launched in,
  // not whatever happens to be focused later.
  const tmuxPane = process.env.TMUX_PANE;
  const inTmux = Boolean(process.env.TMUX && tmuxPane);

  if (!inTmux) return;

  // Resolve the window ID once so all state changes target pi's own window.
  let windowId: string | null = null;
  try {
    windowId = execSync(
      `tmux display-message -p -t ${tmuxPane} '#{window_id}'`,
      { stdio: ["ignore", "pipe", "ignore"] }
    ).toString().trim();
  } catch {
    return; // tmux not reachable — bail out silently
  }

  if (!windowId) return;

  // Nerd Font rounded pill caps (U+E0B6 left, U+E0B4 right)
  const lc = "\uE0B6";
  const rc = "\uE0B4";
  // Subagent windows use ᴨ (U+1D28) directly; regular pi sessions call window-icon.sh.
  const isSubagent = Boolean(process.env.PI_SUBAGENT);
  const icon = isSubagent
    ? "\u1D28 "   // ᴨ — upside-down π for subagents
    : "#(~/.config/tmux/scripts/window-icon.sh #{pane_pid} #{pane_current_command})";

  function pillFmt(color: string): string {
    return (
      `#[fg=#11111b,bg=${color}]#[fg=#181825,reverse]${lc}#[none]` +
      `#I #[fg=#cdd6f4,bg=#45475a] ${icon}#W` +
      `#[fg=#181825,reverse]${rc}#[none]`
    );
  }

  function setPill(color: string): void {
    try {
      execSync(
        `tmux set-window-option -t ${windowId} window-status-format ${JSON.stringify(pillFmt(color))}` +
        ` && tmux refresh-client -S`,
        { stdio: "ignore" }
      );
    } catch {
      // Silently ignore — tmux pane may have closed.
    }
  }

  function revertPill(): void {
    try {
      execSync(
        `tmux set-window-option -ut ${windowId} window-status-format 2>/dev/null || true` +
        ` ; tmux refresh-client -S`,
        { stdio: "ignore" }
      );
    } catch {
      // Silently ignore.
    }
  }

  // Green while the agent is working.
  pi.on("agent_start", () => {
    setPill("#A6E3A1");
  });

  // Back to theme default when the agent finishes a turn.
  pi.on("agent_end", () => {
    revertPill();
  });

  // Also revert on shutdown (e.g. Ctrl-C while idle).
  pi.on("session_shutdown", () => {
    revertPill();
  });
}
