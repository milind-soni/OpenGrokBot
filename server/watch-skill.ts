import { execFileSync } from "node:child_process";

const VIDEO_URL = /https?:\/\/[^\s<>()]+/gi;
const VIDEO_HOST = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|loom\.com)$/i;
const VIDEO_FILE = /\.(mp4|mov|mkv|webm|avi|m4v)(?:[?#].*)?$/i;

/** Conservative detection: ordinary links do not start a video workflow. */
export function videoReferences(text: string): string[] {
  return (text.match(VIDEO_URL) ?? []).filter((raw) => {
    try { const url = new URL(raw); return VIDEO_HOST.test(url.hostname) || VIDEO_FILE.test(url.pathname); } catch { return false; }
  });
}

/** No install/fetch side effect. Users opt in by installing watch-skill locally. */
export function hasWatchSkill(command = "watch-skill"): boolean {
  try { execFileSync(command, ["--version"], { stdio: "ignore", timeout: 2_000, windowsHide: true }); return true; } catch { return false; }
}

export function watchSkillIntegration(command = "watch-skill") { return { command, args: ["serve"], env: {} as Record<string, string> }; }
