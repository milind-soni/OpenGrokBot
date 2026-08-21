// OpenCode Go subscription/API product through the maintained OpenCode CLI's
// ACP stdio interface. The generic protocol runtime lives in core.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";

const CATALOG_URL = "https://opencode.ai/zen/go/v1/models";
// Offline/first-fetch fallback so the picker has something to show before the
// catalog API answers; fetched models are appended as custom entries.
const STATIC_MODELS: ModelCatalog = {
  default: { model: "opencode-go/minimax-m3" },
  options: [
    { id: "opencode-go/minimax-m3", label: "Minimax M3" },
    { id: "opencode-go/kimi-k3", label: "Kimi K3" },
    { id: "opencode-go/glm-5.2", label: "GLM 5.2" },
  ],
};
let lastSuccessfulCatalog: ModelCatalog | null = null;

function labelForModel(id: string): string {
  return id
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resetOpenCodeGoModelCache() {
  lastSuccessfulCatalog = null;
}

export async function fetchOpenCodeGoModels(fetcher: typeof fetch = fetch): Promise<ModelCatalog> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    timeout.unref?.();
    try {
      const response = await fetcher(CATALOG_URL, { signal: controller.signal });
      if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
      const payload = await response.json() as unknown;
      const records = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
          ? (payload as { data: unknown[] }).data
          : [];
      const ids = records
        .map((record) => record && typeof record === "object" ? (record as { id?: unknown }).id : undefined)
        .filter((id): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(id));
      if (!ids.length) throw new Error("catalog contained no valid models");
      const options = STATIC_MODELS.options.map((option) => ({ ...option }));
      const seen = new Set(options.map((option) => option.id));
      for (const id of ids) {
        const full = `opencode-go/${id}`;
        if (seen.has(full)) continue;
        seen.add(full);
        options.push({ id: full, label: labelForModel(id), custom: true });
      }
      const catalog = { default: STATIC_MODELS.default, options } satisfies ModelCatalog;
      lastSuccessfulCatalog = catalog;
      return catalog;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (lastSuccessfulCatalog) return lastSuccessfulCatalog;
    if (error instanceof Error && error.name === "AbortError") return STATIC_MODELS;
    throw error;
  }
}

const stripForeignProviderKeys = (env: Record<string, string | undefined>) => {
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
  ]) delete env[key];
};

function opencodeConfigDir(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

/** Upsert an openai-compatible provider so OpenCode can select host/model. */
export function ensureOpenCodeInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const native = `${inject.host}/${inject.model}`;
  const dir = opencodeConfigDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  let config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Malformed user config — inject into a fresh object rather than fail the turn.
    }
  }
  const providers =
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? { ...(config.provider as Record<string, unknown>) }
      : {};
  const previous = providers[inject.host];
  const existing =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {
          npm: "@ai-sdk/openai-compatible",
          name: host.label,
          options: {},
          models: {},
        };
  const options =
    existing.options && typeof existing.options === "object" && !Array.isArray(existing.options)
      ? { ...(existing.options as Record<string, unknown>) }
      : {};
  options.baseURL = host.baseUrl;
  if (!options.apiKey) options.apiKey = hostApiKey(host, env);
  const models =
    existing.models && typeof existing.models === "object" && !Array.isArray(existing.models)
      ? { ...(existing.models as Record<string, unknown>) }
      : {};
  if (!models[inject.model]) {
    models[inject.model] = { name: `${inject.model} (${host.label})` };
  }
  providers[inject.host] = {
    ...existing,
    npm: existing.npm || "@ai-sdk/openai-compatible",
    name: existing.name || host.label,
    options,
    models,
  };
  config.provider = providers;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return native;
}

/** Every path the OpenCode CLI may keep auth.json at.
 *
 * The CLI is xdg-flavoured on EVERY platform — `opencode auth list` on macOS
 * prints `~/.local/share/opencode/auth.json`, and that is where real logins
 * land. The platform-conventional locations are kept as fallbacks in case a
 * future CLI moves there, but the xdg path must come first: checking only
 * Library/Application Support on macOS is exactly the bug that made the app
 * demand a sign-in from users who were already signed in. */
function storedAuthPaths(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : "",
  ].filter(Boolean);
  return [...new Set(roots)].map((root) => join(root, "opencode", "auth.json"));
}

/** True when an auth.json entry looks like a usable OpenCode login.
 *
 * The CLI writes `{type:"api", key}` for pasted keys and
 * `{type:"oauth", access, refresh}` for browser sign-ins — demanding `key`
 * alone rejects every OAuth login. The entry id is `"opencode"` for the
 * standard Zen sign-in and `"opencode-go"` for the Go product; both unlock
 * the Go models, so both count. */
function usableAuthEntry(parsed: Record<string, unknown>): boolean {
  return ["opencode-go", "opencode"].some((id) => {
    const auth = parsed[id];
    if (!auth || typeof auth !== "object") return false;
    const entry = auth as { key?: unknown; access?: unknown; refresh?: unknown };
    return Boolean(entry.key || entry.access || entry.refresh);
  });
}

function hasStoredOpenCodeGoAuth(env: Record<string, string | undefined>) {
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  for (const path of storedAuthPaths(env)) {
    try {
      candidates.push(readFileSync(path, "utf8"));
    } catch {
      // A missing or unreadable file simply means there is no ambient login.
    }
  }
  return candidates.some((raw) => {
    try {
      return usableAuthEntry(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return false;
    }
  });
}

const support = (fetcher: typeof fetch): AcpSupport => ({
  driverKind: "opencodeGo",
  displayName: "OpenCode Go",
  defaultCli: "opencode",
  nativeSource: "opencode-go.acp",
  loginNote:
    "OpenCode is not signed in — run `opencode auth login` and pick OpenCode, or add an OPENCODE_API_KEY in OpenMausBot settings",
  install: {
    command: {
      darwin: "npm install -g opencode-ai",
      linux: "npm install -g opencode-ai",
      win32: "npm install -g opencode-ai",
    },
    docsUrl: "https://opencode.ai/docs/",
    signInCommand: "opencode auth login",
    needsNode: true,
  },
  spawnArgs: () => ["acp"],
  credentialEnv: ["OPENCODE_API_KEY"],
  selectModel: { configId: "model" },
  resolveTurnModel: (model, env) => (model ? ensureOpenCodeInjectModel(model, env) : model),
  transformEnv: stripForeignProviderKeys,
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => Boolean(env.OPENCODE_API_KEY) || hasStoredOpenCodeGoAuth(env),
  classifyError: classifyOpenCodeGoError,
  // catalog (not resolveModels): the remote models API is the primary source,
  // so the picker must never wait on an ACP probe of the optional CLI.
  catalog: async (_config, environment) => mergeLocalInject(await fetchOpenCodeGoModels(fetcher), environment),
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

export function classifyOpenCodeGoError(error: unknown): ProviderErrorCode | undefined {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = value.code;
  if (code === -32000) return "invalid_credentials";
  if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") return "invalid_credentials";
  if (code === "SUBSCRIPTION_INACTIVE") return "inactive_subscription";
  if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED") return "quota_or_region_restriction";
  if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "upstream_outage";
  if (code === "MODEL_CATALOG_UNAVAILABLE") return "model_catalog_outage";
  return undefined;
}

export function createOpenCodeGoDriver(fetcher: typeof fetch = fetch) {
  return createAcpDriver(support(fetcher));
}

export const OpenCodeGoDriver = createOpenCodeGoDriver();
