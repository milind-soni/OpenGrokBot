// Codex model catalog — official ChatGPT rows stay in the main picker;
// everything the user already wired in ~/.codex (providers, profiles,
// cached catalogs, live /v1/models) is tagged `custom` so ModelPicker
// can hide it behind Custom. `codex app-server` thread/start takes
// `model` + `modelProvider` separately; picker ids encode both.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ModelCatalog } from "../contracts.ts";
import { mergeLocalInject } from "./local-inject.ts";

export const STATIC_CODEX_MODELS: ModelCatalog = {
  default: "gpt-5.6-sol",
  options: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.4", label: "GPT-5.4" },
  ],
};

/** Built-in ChatGPT / OpenAI provider id. Official picker rows force this
 *  so a user's local `model_provider = "omlx"` does not swallow GPT-5.6. */
export const OFFICIAL_CODEX_PROVIDER = "openai";

const SEP = "::";
const MODEL_ID = /^[\w][\w./:+-]*$/;
const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/i;

export function encodeCodexSelection(provider: string, model: string): string {
  return `${provider}${SEP}${model}`;
}

export function decodeCodexSelection(id: string | null | undefined): {
  model: string | null;
  modelProvider: string | null;
} {
  if (!id) return { model: null, modelProvider: null };
  if (STATIC_CODEX_MODELS.options.some((option) => option.id === id)) {
    return { model: id, modelProvider: OFFICIAL_CODEX_PROVIDER };
  }
  const sep = id.indexOf(SEP);
  if (sep > 0) {
    return { model: id.slice(sep + SEP.length), modelProvider: id.slice(0, sep) };
  }
  return { model: id, modelProvider: null };
}

export function codexHome(env: Record<string, string | undefined>): string {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".codex");
}

function unquote(raw: string): string {
  let value = raw.trim();
  const hash = value.indexOf(" #");
  if (hash !== -1 && !(value.startsWith('"') || value.startsWith("'"))) {
    value = value.slice(0, hash).trim();
  }
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}

interface CodexProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  envKey?: string;
}

interface CodexToml {
  model?: string;
  modelProvider?: string;
  providers: CodexProvider[];
}

function parseCodexToml(text: string): CodexToml {
  const result: CodexToml = { providers: [] };
  const byId = new Map<string, CodexProvider>();
  let section: "root" | "other" | CodexProvider = "root";

  const providerFor = (id: string): CodexProvider => {
    let provider = byId.get(id);
    if (!provider) {
      provider = { id };
      byId.set(id, provider);
      result.providers.push(provider);
    }
    return provider;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      const inner = stripped.slice(1, -1);
      const match = /^model_providers\.(.+)$/.exec(inner);
      if (match) {
        let id = match[1];
        if (id.startsWith('"') && id.endsWith('"')) id = id.slice(1, -1);
        section = PROVIDER_ID.test(id) ? providerFor(id) : "other";
      } else {
        section = "other";
      }
      continue;
    }
    const eq = stripped.indexOf("=");
    if (eq < 0) continue;
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (!value) continue;
    if (section === "root") {
      if (key === "model") result.model = value;
      if (key === "model_provider") result.modelProvider = value;
      continue;
    }
    if (section === "other") continue;
    if (key === "name") section.name = value;
    if (key === "base_url") section.baseUrl = value;
    if (key === "env_key") section.envKey = value;
  }
  return result;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function providerName(provider: string, known: Map<string, CodexProvider>): string {
  return known.get(provider)?.name || provider;
}

function niceLabel(model: string, provider: string, known: Map<string, CodexProvider>, named: Map<string, string>): string {
  const encoded = encodeCodexSelection(provider, model);
  if (named.has(encoded)) return named.get(encoded)!;
  const host = providerName(provider, known);
  return host === provider ? model : `${model} (${host})`;
}

function collectCatalogNames(home: string): Map<string, string> {
  const named = new Map<string, string>();
  for (const file of listDir(join(home, "model-catalogs"))) {
    if (!file.endsWith(".json")) continue;
    const provider = basename(file, ".json").replace(/-models$/, "");
    if (!PROVIDER_ID.test(provider)) continue;
    const raw = readText(join(home, "model-catalogs", file));
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const records = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)
          ? (parsed as { data: unknown[] }).data
          : [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const row = record as { slug?: unknown; id?: unknown; display_name?: unknown; name?: unknown };
      const slug = typeof row.slug === "string" ? row.slug : typeof row.id === "string" ? row.id : "";
      if (!MODEL_ID.test(slug)) continue;
      const label = typeof row.display_name === "string" ? row.display_name : typeof row.name === "string" ? row.name : "";
      if (label) named.set(encodeCodexSelection(provider, slug), label);
    }
  }
  return named;
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
    const id = (record as { id?: unknown; slug?: unknown }).id ?? (record as { slug?: unknown }).slug;
    return typeof id === "string" && MODEL_ID.test(id) ? [id] : [];
  });
}

async function probeProviderModels(
  provider: CodexProvider,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  if (!provider.baseUrl) return [];
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (provider.envKey && env[provider.envKey]) {
    headers.Authorization = `Bearer ${env[provider.envKey]}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    if (!response.ok) return [];
    return idsFromModelsPayload(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Local slugs Codex already knows, plus the three official cloud rows. */
export async function readCodexModelCatalog(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalog> {
  const home = codexHome(env);
  const mainText = readText(join(home, "config.toml"));
  if (!mainText) return STATIC_CODEX_MODELS;

  const main = parseCodexToml(mainText);
  const known = new Map(main.providers.map((provider) => [provider.id, provider]));
  const named = collectCatalogNames(home);
  const extras: Array<{ provider: string; model: string }> = [];

  const remember = (provider: string | undefined, model: string | undefined) => {
    if (!provider || !model) return;
    if (!PROVIDER_ID.test(provider) || !MODEL_ID.test(model)) return;
    // A local provider may expose the same slug as an official OpenAI model.
    // Keep that provider-qualified row; otherwise selecting the configured
    // default would decode the bare slug back to the OpenAI provider.
    if (
      provider === OFFICIAL_CODEX_PROVIDER &&
      STATIC_CODEX_MODELS.options.some((option) => option.id === model)
    ) return;
    extras.push({ provider, model });
  };

  remember(main.modelProvider, main.model);

  for (const file of listDir(home)) {
    if (!file.endsWith(".config.toml")) continue;
    const profile = parseCodexToml(readText(join(home, file)) ?? "");
    for (const provider of profile.providers) {
      if (!known.has(provider.id)) known.set(provider.id, provider);
    }
    remember(profile.modelProvider ?? main.modelProvider, profile.model);
  }

  for (const [encoded, _label] of named) {
    const decoded = decodeCodexSelection(encoded);
    if (decoded.model && decoded.modelProvider) remember(decoded.modelProvider, decoded.model);
  }

  const live = await Promise.all(
    [...known.values()].map(async (provider) => {
      const ids = await probeProviderModels(provider, env, fetchImpl);
      return ids.map((model) => ({ provider: provider.id, model }));
    }),
  );
  for (const row of live.flat()) remember(row.provider, row.model);

  const options = STATIC_CODEX_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    const id = encodeCodexSelection(extra.provider, extra.model);
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: niceLabel(extra.model, extra.provider, known, named),
      custom: true,
    });
  }

  const configured = main.model && main.modelProvider
    ? main.modelProvider === OFFICIAL_CODEX_PROVIDER &&
      STATIC_CODEX_MODELS.options.some((option) => option.id === main.model)
      ? main.model
      : encodeCodexSelection(main.modelProvider, main.model)
    : main.model && seen.has(main.model)
      ? main.model
      : null;

  return mergeLocalInject(
    {
      default: configured && seen.has(configured) ? configured : STATIC_CODEX_MODELS.default,
      options,
    },
    env,
    fetchImpl,
  );
}
