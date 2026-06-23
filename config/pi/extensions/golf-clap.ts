import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureSound, playSound } from "./lib/sounds.js";

const GOLF_CLAP: Parameters<typeof ensureSound>[0] = {
  filename: "golf-clap.wav",
  url: "https://upload.wikimedia.org/wikipedia/commons/6/6d/277021_sandermotions_applause-2.wav",
};

const HAL_SORRY: Parameters<typeof ensureSound>[0] = {
  // "I'm sorry Dave, I'm afraid I can't do that."
  filename: "hal9000-cant-do-that.wav",
};

const HAL_JUST_WHAT: Parameters<typeof ensureSound>[0] = {
  // "Just what do you think you're doing, Dave?"
  filename: "hal9000-just-what.wav",
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    try {
      ensureSound(GOLF_CLAP);
      ensureSound(HAL_SORRY);
      ensureSound(HAL_JUST_WHAT);
    } catch {
      // ignore — playback will report the error at call time
    }
  });

  // ── Golf Clap ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "golf_clap",
    label: "👏 Golf Clap",
    description:
      "Play a polite golf clap to celebrate when the user does something good, achieves a goal, or deserves a small round of applause. Use sparingly — only for genuinely impressive moments.",
    promptSnippet: "Play a golf clap for the user when they deserve recognition",
    parameters: Type.Object({
      reason: Type.String({
        description: "Brief reason why the golf clap is deserved (shown to the user)",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        ensureSound(GOLF_CLAP);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `👏 Golf clap for: ${params.reason}\n(Sound file unavailable — could not download)`,
            },
          ],
        };
      }

      await playSound(GOLF_CLAP.filename, { maxDuration: 4, signal });

      return {
        content: [{ type: "text", text: `👏 Golf clap: ${params.reason}` }],
      };
    },
  });

  // ── HAL 9000: I'm sorry Dave, I'm afraid I can't do that ─────────────────
  pi.registerTool({
    name: "hal_cant_do_that",
    label: "🔴 HAL 9000: Can't Do That",
    description:
      "Play HAL 9000's 'I'm sorry Dave, I'm afraid I can't do that.' Use when the user asks for something you genuinely cannot or will not do.",
    promptSnippet: "Play HAL 9000's 'I'm afraid I can't do that' when refusing a request",
    parameters: Type.Object({
      reason: Type.String({
        description: "Brief reason why you can't do it (shown to the user)",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      await playSound(HAL_SORRY.filename, { signal });
      return {
        content: [{ type: "text", text: `🔴 I'm afraid I can't do that: ${params.reason}` }],
      };
    },
  });

  // ── HAL 9000: Just what do you think you're doing, Dave? ─────────────────
  pi.registerTool({
    name: "hal_just_what",
    label: "🔴 HAL 9000: Just What Do You Think You're Doing?",
    description:
      "Play HAL 9000's 'Just what do you think you're doing, Dave?' Use when the user is about to do something questionable, risky, or that seems like a bad idea.",
    promptSnippet: "Play HAL 9000 questioning the user's judgment when they're about to do something unwise",
    parameters: Type.Object({
      concern: Type.String({
        description: "Brief description of the concerning action (shown to the user)",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      await playSound(HAL_JUST_WHAT.filename, { signal });
      return {
        content: [{ type: "text", text: `🔴 Just what do you think you're doing? ${params.concern}` }],
      };
    },
  });
}
