// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"key":"ck_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { InstanceConfigMap, ModelTask } from "./contracts.ts";

export interface OpenAICompatibleConfig {
  key?: string;
  url?: string;
  model?: string;
  modelTasks?: Record<string, ModelTask>;
  imagePath?: string;
  videoPath?: string;
}

export interface AppConfig {
  xai?: { key?: string; url?: string };
  openrouter?: { key?: string; url?: string; model?: string };
  ollamaCloud?: { key?: string; url?: string; model?: string };
  openaiCompatible?: OpenAICompatibleConfig;
  /** key = ck_… Connect consumer key (connections + agent tools);
   * apiKey = ak_… project API key — optional, unlocks the full toolkit
   * catalog with official logos in the plugins marketplace. */
  composio?: { key?: string; apiKey?: string; url?: string };
  box?: { token?: string };
  /** Voice (ElevenLabs). `key` is the credential and is never echoed back;
   * `voice` is the chosen voice id, which is a setting, not a secret. */
  tts?: { key?: string; voice?: string };
  /** The person using the app (collected in onboarding, shown in the
   * sidebar). Not a secret — echoed back by GET /api/config. */
  profile?: { name?: string; email?: string };
  instances?: InstanceConfigMap;
}

// OMB_DATA_DIR isolates test/soak rigs from the user's real fleet.
export const DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
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
  cfg.openrouter = { key: process.env.OPENROUTER_API_KEY, ...cfg.openrouter };
  cfg.ollamaCloud = { key: process.env.OLLAMA_API_KEY, ...cfg.ollamaCloud };
  cfg.openaiCompatible = {
    key: process.env.OPENAI_COMPATIBLE_API_KEY,
    ...cfg.openaiCompatible,
  };
  cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.tts = { key: process.env.OMB_TTS_KEY, ...cfg.tts };
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
  for (const key of [
    "xai",
    "openrouter",
    "ollamaCloud",
    "openaiCompatible",
    "composio",
    "box",
    "tts",
    "profile",
  ] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(p, JSON.stringify(disk, null, 2));
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
  //
  // Google rides `antigravityAgent` (the `agy` CLI), not `geminiAgent`:
  // Google retired Gemini CLI for the free/Pro/Ultra tiers on 2026-06-18
  // (developers.googleblog.com, "transitioning Gemini CLI to Antigravity
  // CLI"), so a default `gemini` instance could only ever show unavailable.
  // The driver stays registered for enterprise licences, which keep Gemini
  // CLI — `{"instances": {"gemini": {"driver": "geminiAgent"}}}` restores it.
  const map: InstanceConfigMap =
    cfg.instances && Object.keys(cfg.instances).length
      ? cfg.instances
      : {
          grok: { driver: "grokAgent" },
          claude: { driver: "claudeAgent" },
          codex: { driver: "codex" },
          openrouter: {
            driver: "openrouter",
            config: {
              url: cfg.openrouter?.url ?? "https://openrouter.ai/api/v1",
              model: cfg.openrouter?.model,
            },
          },
          "ollama-cloud": {
            driver: "ollamaCloud",
            config: {
              url: cfg.ollamaCloud?.url ?? "https://ollama.com/v1",
              model: cfg.ollamaCloud?.model,
            },
          },
          "openai-compatible": {
            driver: "openaiCompatible",
            config: {
              url: cfg.openaiCompatible?.url,
              model: cfg.openaiCompatible?.model,
              modelTasks: cfg.openaiCompatible?.modelTasks,
              imagePath: cfg.openaiCompatible?.imagePath,
              videoPath: cfg.openaiCompatible?.videoPath,
            },
          },
          antigravity: { driver: "antigravityAgent" },
          computer: { driver: "boxAgent" },
        };
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...(entry.driver === "grok" && cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(entry.driver === "openrouter" && cfg.openrouter?.key
        ? { OPENROUTER_API_KEY: cfg.openrouter.key }
        : {}),
      ...(entry.driver === "ollamaCloud" && cfg.ollamaCloud?.key
        ? { OLLAMA_API_KEY: cfg.ollamaCloud.key }
        : {}),
      ...(entry.driver === "openaiCompatible" && cfg.openaiCompatible?.key
        ? { OPENAI_COMPATIBLE_API_KEY: cfg.openaiCompatible.key }
        : {}),
      ...(entry.driver === "boxAgent" && cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...entry.environment,
    };
  }
  return map;
}
