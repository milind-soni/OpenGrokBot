import { execFile } from "node:child_process";

const VIDEO_URL = /https?:\/\/[^\s<>()]+/gi;
const VIDEO_FILE = /\.(mp4|mov|mkv|webm|avi|m4v)(?:[?#].*)?$/i;
let availability: Promise<boolean> | undefined;

function isHostedVideo(url: URL) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  if (host === "youtu.be") return path.length > 1;
  if (host.endsWith("youtube.com")) return (path === "/watch" && Boolean(url.searchParams.get("v"))) || /^\/(shorts|live|embed)\/[^/]+$/i.test(path);
  if (host.endsWith("vimeo.com")) return /^\/(video\/)?\d+$/i.test(path);
  if (host === "clips.twitch.tv") return path.length > 1;
  if (host.endsWith("twitch.tv")) return /^\/videos\/\d+$/i.test(path) || /^\/[^/]+\/clip\/[^/]+$/i.test(path);
  if (host.endsWith("loom.com")) return /^\/(share|embed)\/[^/]+$/i.test(path);
  return false;
}

/** Conservative detection: ordinary links do not start a video workflow. */
export function videoReferences(text: string): string[] {
  return (text.match(VIDEO_URL) ?? []).flatMap((raw) => {
    const candidate = raw.replace(/[.,;:'"\]\)]+$/, "");
    try {
      const url = new URL(candidate);
      return isHostedVideo(url) || VIDEO_FILE.test(url.pathname) ? [candidate] : [];
    } catch { return []; }
  });
}

/** No install/fetch side effect. Users opt in by installing watch-skill locally. */
export function hasWatchSkill(command = "watch-skill"): Promise<boolean> {
  if (command === "watch-skill" && availability) return availability;
  const probe = new Promise<boolean>((resolve) => {
    execFile(command, ["--version"], { windowsHide: true, timeout: 2_000 }, (error) => resolve(!error));
  });
  if (command === "watch-skill") availability = probe;
  return probe;
}

export function watchSkillIntegration(command = "watch-skill") { return { command, args: ["serve"], env: {} as Record<string, string> }; }
