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

  function tmuxExec(cmd: string): void {
    try {
      execSync(cmd, { stdio: "ignore" });
    } catch {
      // Silently ignore — tmux pane may have closed.
    }
  }

  // Nerd Font rounded pill caps (U+E0B6 left, U+E0B4 right)
  const lc = "\uE0B6";
  const rc = "\uE0B4";
  // Pass #{window_name} and #{@pi_running} so window-icon.sh can use its fast paths.
  const icon = "#(~/.config/tmux/scripts/window-icon.sh #{pane_pid} #{pane_current_command} #{window_name} #{@pi_running})";

  function pillFmt(color: string): string {
    return (
      `#[fg=#11111b,bg=${color}]#[fg=#181825,reverse]${lc}#[none]` +
      `#I #[fg=#cdd6f4,bg=#45475a] ${icon}#W` +
      `#[fg=#181825,reverse]${rc}#[none]`
    );
  }

  function setPill(color: string): void {
    tmuxExec(
      `tmux set-window-option -t ${windowId} window-status-format ${JSON.stringify(pillFmt(color))}` +
      ` && tmux refresh-client -S`
    );
  }

  function revertPill(): void {
    tmuxExec(
      `tmux set-window-option -ut ${windowId} window-status-format 2>/dev/null || true` +
      ` ; tmux refresh-client -S`
    );
  }

  // Mark this window as a pi session so window-icon.sh can return the π icon
  // instantly (same as the nvim fast-path) without any ps tree walk.
  tmuxExec(`tmux set-window-option -t ${windowId} @pi_running 1`);

  // Green pill while the agent is working; revert to theme default otherwise.
  // Only window-status-format (inactive windows) is touched — catppuccin's
  // window-status-current-format (active/focused window) is left alone.
  pi.on("agent_start", () => {
    setPill("#A6E3A1");
  });

  pi.on("agent_end", () => {
    revertPill();
  });

  pi.on("session_shutdown", () => {
    tmuxExec(`tmux set-window-option -ut ${windowId} @pi_running`);
    revertPill();
  });
}
