// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"key":"ck_…"}, "box": {"token":"…"},
//     "ollama": {"url":"http://127.0.0.1:11434"},
//     "ollamaWorkstation": {"url":"http://192.168.68.70:11434"},
//     "ollamaCloud": {"url":"https://api.ollama.com", "apiKey":"…"},
//     "instances": { "<instanceId>": {"driver":"ollama", …} } }
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const DATA_DIR = join(homedir(), ".openmausbot");
const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");
export function ensureDirs() {
    if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
        try {
            renameSync(LEGACY_DATA_DIR, DATA_DIR);
        }
        catch { }
    }
    for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR])
        mkdirSync(dir, { recursive: true });
}
export function loadConfig() {
    let cfg = {};
    try {
        cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    }
    catch { }
    cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
    cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
    cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
    cfg.ollama = { url: process.env.OLLAMA_URL, ...cfg.ollama };
    cfg.ollamaWorkstation = { ...cfg.ollamaWorkstation };
    cfg.ollamaCloud = { apiKey: process.env.OLLAMA_API_KEY_2, ...cfg.ollamaCloud };
    return cfg;
}
export function saveConfig(patch) {
    const p = join(DATA_DIR, "config.json");
    let disk = {};
    try {
        disk = JSON.parse(readFileSync(p, "utf8"));
    }
    catch { }
    for (const key of ["xai", "composio", "box", "ollama", "ollamaWorkstation", "ollamaCloud", "profile"]) {
        if (patch[key] && typeof patch[key] === "object") {
            disk[key] = { ...disk[key], ...patch[key] };
        }
    }
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(p, JSON.stringify(disk, null, 2));
}
// Default fleet: three Ollama instances (local, workstation, cloud) plus
// the original CLI-based drivers. Config-file keys are injected as
// per-instance environment so drivers see them without needing real
// process env vars.
export function instanceConfigs(cfg) {
    const map = cfg.instances && Object.keys(cfg.instances).length
        ? cfg.instances
        : {
            ollamaLocal: {
                driver: "ollama",
                displayName: "Ollama (Laptop)",
                config: { url: cfg.ollama?.url ?? "http://127.0.0.1:11434" },
            },
            ollamaWorkstation: {
                driver: "ollama",
                displayName: "Ollama (Workstation)",
                config: { url: cfg.ollamaWorkstation?.url ?? "http://192.168.68.70:11434" },
            },
            ollamaCloud: {
                driver: "ollama",
                displayName: "Ollama (Cloud)",
                config: {
                    url: cfg.ollamaCloud?.url ?? "https://api.ollama.com",
                    apiKeyEnv: "OLLAMA_CLOUD_KEY",
                },
            },
            grok: { driver: "grokAgent" },
            gemini: { driver: "geminiAgent" },
            claude: { driver: "claudeAgent" },
            codex: { driver: "codex" },
            computer: { driver: "boxAgent" },
        };
    for (const entry of Object.values(map)) {
        entry.environment = {
            ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
            ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
            // Inject the cloud API key into the ollamaCloud instance's environment
            ...(cfg.ollamaCloud?.apiKey ? { OLLAMA_CLOUD_KEY: cfg.ollamaCloud.apiKey } : {}),
            ...entry.environment,
        };
    }
    return map;
}
