// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"apiKey":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { InstanceConfigMap } from "./contracts.ts";

export interface AppConfig {
  xai?: { key?: string; url?: string };
  /** Project key used for Sessions, catalog and agent tools. userId/sessionId
   * are non-secret local identifiers used to reuse one Composio Session. */
  composio?: {
    apiKey?: string;
    userId?: string;
    sessionId?: string;
  };
  box?: { token?: string };
  /** OpenCode key; persisted write-only and passed only to its child. It
   * unlocks the OpenCode Zen provider — the user's own providers authenticate
   * through opencode's own auth.json and need nothing from us. */
  opencode?: { apiKey?: string };
  /** Pre-rename spelling of `opencode`, still read so a key saved by an older
   * build is not silently dropped. Never written. */
  opencodeGo?: { apiKey?: string };
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
  cfg.composio = {
    ...cfg.composio,
    ...(process.env.COMPOSIO_API_KEY !== undefined ? { apiKey: process.env.COMPOSIO_API_KEY } : {}),
  };
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.opencode = { apiKey: process.env.OPENCODE_API_KEY, ...cfg.opencodeGo, ...cfg.opencode };
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
  for (const key of ["xai", "composio", "box", "opencode", "tts", "profile"] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  if (patch.instances && typeof patch.instances === "object") {
    const diskInstances = (disk.instances ?? {}) as Record<string, unknown>;
    for (const [instanceId, entry] of Object.entries(patch.instances)) {
      diskInstances[instanceId] = { ...(diskInstances[instanceId] as object), ...entry };
    }
    disk.instances = diskInstances;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
}

/** Set one instance's `config.cli` ("" clears the override back to the
 * driver default). Creating the instance entry is fine — a config-less
 * entry rides driver.defaultConfig(). Returns false for unknown instances
 * when the fleet is explicitly configured. The returned map must stay
 * PERSISTABLE: instanceConfigs() injects credential env into every entry
 * for the live fleet, so those injected keys are stripped back out before
 * the map is returned — otherwise saving an override would copy xai/box/
 * opencodeGo secrets into the instances section of config.json. */
export function withInstanceCli(
  cfg: AppConfig,
  instanceId: string,
  cli: string,
): { ok: boolean; config: AppConfig } {
  const next: AppConfig = structuredClone(cfg);
  const injected = injectedEnvironment(next);
  const map = instanceConfigs(next);
  // hasOwn, not truthiness: map is a plain object literal, so
  // map["__proto__"] resolves to Object.prototype — truthy — and the
  // assignment below would poison EVERY object in the process (instanceId
  // comes off the URL, where `__proto__` passes the route's [\w.-]+ regex)
  if (!Object.hasOwn(map, instanceId)) return { ok: false, config: cfg };
  const entry = map[instanceId];
  const cliKey = cli.trim();
  if (cliKey) entry.config = { ...(entry.config as object), cli: cliKey };
  else if (entry.config && typeof entry.config === "object" && "cli" in (entry.config as object)) {
    const rest = { ...(entry.config as Record<string, unknown>) };
    delete rest.cli;
    entry.config = Object.keys(rest).length ? rest : undefined;
  }
  for (const e of Object.values(map)) {
    if (!e.environment) continue;
    for (const [k, v] of Object.entries(e.environment)) {
      if (injected[k] === v) delete e.environment[k];
    }
    if (!Object.keys(e.environment).length) delete e.environment;
  }
  next.instances = map;
  return { ok: true, config: next };
}

/** The credential env instanceConfigs() injects — same keys, same rule. */
function injectedEnvironment(cfg: AppConfig): Record<string, string> {
  return {
    ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
    ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
    ...(cfg.opencodeGo?.apiKey ? { OPENCODE_API_KEY: cfg.opencodeGo.apiKey } : {}),
  };
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
  //
  // `opencode` needs no credential from us to be useful: unlike the others it
  // runs with no login at all (the free OpenCode Zen models), and its model
  // list is discovered from whatever providers the user has configured. A
  // saved OPENCODE_API_KEY is optional on top — it unlocks the paid Zen
  // catalog, and nothing else.
  const map: InstanceConfigMap =
    cfg.instances && Object.keys(cfg.instances).length
      ? cfg.instances
      : {
          grok: { driver: "grokAgent" },
          kimi: { driver: "kimiAgent" },
          droid: { driver: "droidAgent" },
          opencode: { driver: "opencodeAgent" },
          claude: { driver: "claudeAgent" },
          codex: { driver: "codex" },
          antigravity: { driver: "antigravityAgent" },
          opencodeGo: { driver: "opencodeGo" },
          computer: { driver: "boxAgent" },
        };
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...(entry.driver === "opencodeAgent" && (cfg.opencode?.apiKey ?? cfg.opencodeGo?.apiKey)
        ? { OPENCODE_API_KEY: (cfg.opencode?.apiKey ?? cfg.opencodeGo?.apiKey)! }
        : {}),
      ...entry.environment,
    };
  }
  return map;
}
