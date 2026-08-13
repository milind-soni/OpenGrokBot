// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"key":"ck_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { InstanceConfigMap } from "./contracts.ts";

export interface AppConfig {
  xai?: { key?: string; url?: string };
  /** key = ck_… Connect consumer key (connections + agent tools);
   * apiKey = ak_… project API key — optional, unlocks the full toolkit
   * catalog with official logos in the plugins marketplace. */
  composio?: { key?: string; apiKey?: string; url?: string };
  box?: { token?: string };
  /** Custom OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, vLLM, …):
   * baseUrl up to /v1; key is optional for keyless local servers; models
   * optionally pins the list when the endpoint has no /models route. */
  openaiCompat?: { baseUrl?: string; key?: string; models?: string[] };
  /** The person using the app (collected in onboarding, shown in the
   * sidebar). Not a secret — echoed back by GET /api/config. */
  profile?: { name?: string; email?: string };
  instances?: InstanceConfigMap;
}

export const DATA_DIR = join(homedir(), ".openmausbot");
const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

export function ensureDirs() {
  // one-time migration from the pre-rename data dir — bots, transcripts,
  // config and keys all carry over
  if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
    try {
      renameSync(LEGACY_DATA_DIR, DATA_DIR);
    } catch {
      /* cross-device or busy — fall through to a fresh dir */
    }
  }
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
  } catch {
    /* first run — env fallbacks below */
  }
  cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
  cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.openaiCompat = { key: process.env.OPENAI_COMPAT_API_KEY, ...cfg.openaiCompat };
  return cfg;
}

/** Merge a partial config into ~/.openmausbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: Record<string, unknown> = {};
  try {
    disk = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* first write */
  }
  for (const key of ["xai", "composio", "box", "openaiCompat", "profile"] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(disk, null, 2));
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime.
  const defaults: InstanceConfigMap = {
    grok: { driver: "grokAgent" },
    gemini: { driver: "geminiAgent" },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    // Local runtimes light up automatically when their servers are running.
    ollama: { driver: "ollama" },
    lmstudio: { driver: "lmstudio" },
    custom: {
      driver: "openaiCompat",
      config: {
        baseUrl: cfg.openaiCompat?.baseUrl ?? "",
        models: cfg.openaiCompat?.models ?? [],
      },
    },
    computer: { driver: "boxAgent" },
  };
  // Saved fleets predate newly shipped drivers. Merge defaults so upgrades
  // gain new providers without discarding any customized instance entries.
  const map: InstanceConfigMap = { ...defaults, ...cfg.instances };
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...(cfg.openaiCompat?.key ? { OPENAI_COMPAT_API_KEY: cfg.openaiCompat.key } : {}),
      ...entry.environment,
    };
  }
  return map;
}
