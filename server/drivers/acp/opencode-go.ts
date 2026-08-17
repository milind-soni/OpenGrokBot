// OpenCode Go subscription/API product through the maintained OpenCode CLI's
// ACP stdio interface. The generic protocol runtime lives in core.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";

const CATALOG_URL = "https://opencode.ai/zen/go/v1/models";
const STATIC_MODELS: ModelCatalog = {
  default: "opencode-go/minimax-m3",
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
  } catch {
    return lastSuccessfulCatalog ?? STATIC_MODELS;
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
    config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
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

function storedAuthPath(env: Record<string, string | undefined>) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const dataRoot = env.XDG_DATA_HOME
    || (process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : join(home, ".local", "share"));
  return join(dataRoot, "opencode", "auth.json");
}

function hasStoredOpenCodeGoAuth(env: Record<string, string | undefined>) {
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  try {
    candidates.push(readFileSync(storedAuthPath(env), "utf8"));
  } catch {
    // A missing or unreadable file simply means there is no ambient login.
  }
  return candidates.some((raw) => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const auth = parsed["opencode-go"];
      return Boolean(auth && typeof auth === "object" && (auth as { key?: unknown }).key);
    } catch {
      return false;
    }
  });
}

const support = (fetcher: typeof fetch): AcpSupport => ({
  driverKind: "opencodeGo",
  displayName: "OpenCode Go",
  models: STATIC_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode-go.acp",
  loginNote: "OpenCode Go is not configured — add an OPENCODE_API_KEY in OpenMausBot settings",
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
  resolveModels: async (environment) => mergeLocalInject(await fetchOpenCodeGoModels(fetcher), environment),
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
