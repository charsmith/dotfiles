import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
  // Capture the pane ID at process start — this is the pane pi was launched in,
  // not whatever happens to be focused later.
  const tmuxPane = process.env.TMUX_PANE;
  const inTmux = Boolean(process.env.TMUX && tmuxPane);

  if (!inTmux) return;

  pi.on("session_start", async (_event, ctx) => {
    const name = basename(ctx.cwd);
    if (!name) return;

    try {
      // -t <pane-id> resolves to the window containing that pane,
      // so this renames pi's own window regardless of tmux focus.
      execSync(`tmux rename-window -t ${tmuxPane} ${JSON.stringify(name)}`, {
        stdio: "ignore",
      });
    } catch {
      // Silently ignore — tmux may not be running or the pane may be gone.
    }
  });
}
