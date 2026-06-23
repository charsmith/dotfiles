/**
 * Shared sound utilities for pi extensions.
 *
 * Provides helpers to ensure a sound file is present on disk (downloading it
 * from a URL if necessary) and to play it via macOS `afplay`.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const SOUND_DIR = join(homedir(), ".config", "pi", "sounds");

export interface SoundDefinition {
  /** Filename within SOUND_DIR (e.g. "golf-clap.wav") */
  filename: string;
  /** Remote URL to fetch the file from if it isn't present locally. Omit if the
   *  file is always pre-installed (e.g. bundled with dotfiles). */
  url?: string;
}

/** Returns the absolute path for a named sound file. */
export function soundPath(filename: string): string {
  return join(SOUND_DIR, filename);
}

/**
 * Ensures the sound file exists on disk.
 * If a URL is provided and the file is missing, downloads it via curl.
 * Throws if the download fails.
 */
export function ensureSound(def: SoundDefinition): void {
  const file = soundPath(def.filename);
  if (existsSync(file)) return;
  if (!def.url) return; // pre-installed; nothing to do

  mkdirSync(SOUND_DIR, { recursive: true });
  execFileSync("curl", ["-sL", def.url, "-o", file]);
}

/**
 * Plays a sound file via `afplay`.
 *
 * @param filename  Filename within SOUND_DIR (must already exist on disk).
 * @param options.maxDuration  Cap playback at this many seconds (default: no cap).
 * @param options.signal  AbortSignal — kills the process early on abort.
 * @returns A promise that resolves when playback finishes (or is aborted/capped).
 */
export async function playSound(
  filename: string,
  options: { maxDuration?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const file = soundPath(filename);
  const args: string[] = [];
  if (options.maxDuration != null) args.push("-t", String(options.maxDuration));
  args.push(file);

  await new Promise<void>((resolve) => {
    const proc = execFile("afplay", args, () => resolve());
    options.signal?.addEventListener("abort", () => {
      proc.kill();
      resolve();
    });
  });
}
