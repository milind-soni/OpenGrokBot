// Shared local-host inject — the sidecar workflow, inside the picker.
// Probe oMLX / Ollama / EXO / LM Studio / Unsloth, list whatever they
// serve under Custom on every agent, and decode a pick back into a host
// + API id the selected driver can inject.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../contracts.ts";

export interface LocalHost {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

export const LOCAL_HOSTS: LocalHost[] = [
  { id: "omlx", label: "oMLX", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "omlx" },
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
  { id: "local_ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
  { id: "exo", label: "EXO", baseUrl: "http://127.0.0.1:52415/v1", apiKey: "exo" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio" },
  { id: "unsloth", label: "Unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
  { id: "unsloth_api", label: "Unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
];

export const INJECT_SEP = "::";

const HOST_BY_ID = new Map(LOCAL_HOSTS.map((host) => [host.id, host]));
const MODEL_ID = /^[\w][\w./:+-]*$/;

export interface InjectedModel {
  id: string;
  host: string;
  model: string;
  label: string;
}

export function encodeInjectId(host: string, model: string): string {
  return `${host}${INJECT_SEP}${model}`;
}

export function decodeInjectId(id: string | null | undefined): { host: string; model: string } | null {
  if (!id) return null;
  const sep = id.indexOf(INJECT_SEP);
  if (sep <= 0) return null;
  const host = id.slice(0, sep);
  const model = id.slice(sep + INJECT_SEP.length);
  if (!HOST_BY_ID.has(host) || !MODEL_ID.test(model)) return null;
  return { host, model };
}

export function localHost(id: string): LocalHost | undefined {
  return HOST_BY_ID.get(id);
}

export function injectedApiModel(id: string | null | undefined): string | null {
  return decodeInjectId(id)?.model ?? null;
}

/** Anthropic-compatible base (Claude Code wants this without a trailing /v1). */
export function anthropicBaseUrl(host: LocalHost): string {
  return host.baseUrl.replace(/\/v1\/?$/, "");
}

export function hostApiKey(host: LocalHost, env: Record<string, string | undefined> = process.env): string {
  if (host.apiKeyEnv && env[host.apiKeyEnv]) return env[host.apiKeyEnv]!;
  if (host.apiKey) return host.apiKey;
  if (host.id === "unsloth" || host.id === "unsloth_api") {
    const fromFile = readUnslothKey(env);
    if (fromFile) return fromFile;
  }
  return "local";
}

const CODEX_RESERVED_PROVIDERS = new Set(["openai", "ollama", "lmstudio"]);

/**
 * Configure the custom local providers on the Codex app-server without
 * rewriting the user's config.toml. Provider secrets ride in the child
 * environment; argv only contains the corresponding environment key name.
 */
export function codexLocalProviderArgs(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): string[] {
  const inject = decodeInjectId(modelId);
  if (!inject || CODEX_RESERVED_PROVIDERS.has(inject.host)) return [];
  const host = localHost(inject.host);
  if (!host) return [];
  const envKey = `OPENMAUSBOT_LOCAL_${host.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  env[envKey] = hostApiKey(host, env);
  return [
    "-c",
    `model_providers.${host.id}.name=${JSON.stringify(host.label)}`,
    "-c",
    `model_providers.${host.id}.base_url=${JSON.stringify(host.baseUrl)}`,
    "-c",
    `model_providers.${host.id}.env_key=${JSON.stringify(envKey)}`,
  ];
}

function readUnslothKey(env: Record<string, string | undefined>): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    const raw = JSON.parse(readFileSync(join(home, ".unsloth", "studio", "auth", "agent_api_key.json"), "utf8")) as {
      api_key?: unknown;
    };
    return typeof raw.api_key === "string" && raw.api_key ? raw.api_key : null;
  } catch {
    return null;
  }
}

function idsFromModelsPayload(payload: unknown): string[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];
  return records.flatMap((record) => {
    if (typeof record === "string") return MODEL_ID.test(record) ? [record] : [];
    if (!record || typeof record !== "object") return [];
    const id = (record as { id?: unknown; name?: unknown }).id ?? (record as { name?: unknown }).name;
    if (typeof id !== "string" || !MODEL_ID.test(id)) return [];
    const low = id.toLowerCase();
    if (low.includes("embed") || low.includes("bge-") || low.includes("nomic")) return [];
    return [id];
  });
}

async function probeHost(
  host: LocalHost,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const url = `${host.baseUrl.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${hostApiKey(host, env)}` },
    });
    if (!response.ok) return [];
    return idsFromModelsPayload(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Live models from the same local hosts the sidecar probed. */
export async function probeLocalInjects(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<InjectedModel[]> {
  const seenHosts = new Set<string>();
  const hosts = LOCAL_HOSTS.filter((host) => {
    const key = host.baseUrl.replace(/\/$/, "");
    if (seenHosts.has(key)) return false;
    seenHosts.add(key);
    return true;
  });
  const found: InjectedModel[] = [];
  const pages = await Promise.all(hosts.map(async (host) => ({ host, ids: await probeHost(host, env, fetchImpl) })));
  for (const { host, ids } of pages) {
    for (const model of ids) {
      found.push({
        id: encodeInjectId(host.id, model),
        host: host.id,
        model,
        label: `${model} (${host.label})`,
      });
    }
  }
  return found;
}

/** Append live local models as custom rows. Official rows stay first. */
export async function mergeLocalInject(
  catalog: ModelCatalog,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalog> {
  if (env.VITEST === "true" && env.OPENMAUSBOT_PROBE_LOCAL_INJECT !== "1") return catalog;
  const extras = await probeLocalInjects(env, fetchImpl);
  if (!extras.length) return catalog;
  const options = catalog.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: catalog.default, options };
}

/** Point Claude Code at the injected host instead of Anthropic cloud. */
export function applyClaudeInject(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): { model: string | null; injected: boolean } {
  const inject = decodeInjectId(modelId);
  if (!inject) return { model: modelId ?? null, injected: false };
  const host = localHost(inject.host);
  if (!host) return { model: modelId ?? null, injected: false };
  const key = hostApiKey(host, env);
  env.ANTHROPIC_BASE_URL = anthropicBaseUrl(host);
  env.ANTHROPIC_AUTH_TOKEN = key;
  env.ANTHROPIC_API_KEY = key;
  env.ANTHROPIC_MODEL = inject.model;
  return { model: inject.model, injected: true };
}
