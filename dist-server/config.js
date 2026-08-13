// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "openrouter": {"key":"sk-or-…"}, "ollamaCloud": {"key":"…"},
//     "openaiCompatible": {"url":"http://127.0.0.1:11434/v1", "model":"gpt-oss:20b"},
//     "instances": { "<instanceId>": {"driver":"openaiCompatible", …} } }
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// OMB_DATA_DIR isolates test/soak rigs from the user's real fleet.
export const DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");
export const MEDIA_DIR = join(DATA_DIR, "media");
export function ensureDirs() {
    // one-time migration from the pre-rename data dir — bots, transcripts,
    // config and keys all carry over
    if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
        try {
            renameSync(LEGACY_DATA_DIR, DATA_DIR);
        }
        catch {
            /* cross-device or busy — fall through to a fresh dir */
        }
    }
    for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR, MEDIA_DIR])
        mkdirSync(dir, { recursive: true });
}
export function loadConfig() {
    let cfg = {};
    try {
        cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    }
    catch {
        /* first run — env fallbacks below */
    }
    cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
    cfg.openrouter = { key: process.env.OPENROUTER_API_KEY, ...cfg.openrouter };
    cfg.ollamaCloud = { key: process.env.OLLAMA_API_KEY, ...cfg.ollamaCloud };
    cfg.openaiCompatible = {
        key: process.env.OPENAI_COMPATIBLE_API_KEY,
        url: process.env.OPENAI_COMPATIBLE_BASE_URL,
        model: process.env.OPENAI_COMPATIBLE_MODEL,
        ...cfg.openaiCompatible,
    };
    cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
    cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
    return cfg;
}
/** Merge a partial config into ~/.openmausbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch) {
    const p = join(DATA_DIR, "config.json");
    let disk = {};
    try {
        disk = JSON.parse(readFileSync(p, "utf8"));
    }
    catch {
        /* first write */
    }
    for (const key of [
        "xai",
        "openrouter",
        "ollamaCloud",
        "openaiCompatible",
        "composio",
        "box",
        "profile",
    ]) {
        if (patch[key] && typeof patch[key] === "object") {
            disk[key] = { ...disk[key], ...patch[key] };
        }
    }
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(p, JSON.stringify(disk, null, 2));
}
// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg) {
    // The default `grok` instance rides the `grokAgent` driver, not the API-key
    // one: like claude and codex it needs no credential from us, just the CLI
    // installed and logged in (it shows up unavailable otherwise). The API-key
    // `grok` driver stays registered but out of the default fleet — that key is
    // a credential Milind doesn't want to manage; an `instances` entry brings
    // it back anytime.
    const map = cfg.instances && Object.keys(cfg.instances).length
        ? cfg.instances
        : {
            grok: { driver: "grokAgent" },
            gemini: { driver: "geminiAgent" },
            claude: { driver: "claudeAgent" },
            codex: { driver: "codex" },
            openrouter: {
                driver: "openrouter",
                config: { url: cfg.openrouter?.url, model: cfg.openrouter?.model },
            },
            "ollama-cloud": {
                driver: "ollamaCloud",
                config: { url: cfg.ollamaCloud?.url, model: cfg.ollamaCloud?.model },
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
            computer: { driver: "boxAgent" },
        };
    for (const entry of Object.values(map)) {
        entry.environment = {
            ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
            ...(cfg.openrouter?.key ? { OPENROUTER_API_KEY: cfg.openrouter.key } : {}),
            ...(cfg.ollamaCloud?.key ? { OLLAMA_API_KEY: cfg.ollamaCloud.key } : {}),
            ...(cfg.openaiCompatible?.key ? { OPENAI_COMPATIBLE_API_KEY: cfg.openaiCompatible.key } : {}),
            ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
            ...entry.environment,
        };
    }
    return map;
}
