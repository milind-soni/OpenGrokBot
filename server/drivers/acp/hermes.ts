// Hermes Agent — Nous Research's `hermes acp` CLI. Custom-only: Hermes is
// a BYOK/local harness. ACP ignores `hermes -m` (cmd_acp does not forward
// it), and setting OPENAI_API_KEY makes provider:auto resolve to OpenRouter
// without an OpenRouter key — that is the "HTTP 401: Missing Authentication
// header" failure. Inject writes providers.<host> and session/set_model
// `custom:<host>:<model>` instead.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };

function hermesHome(env: Record<string, string | undefined>): string {
  return env.HERMES_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".hermes");
}

function quoteYaml(value: string): string {
  if (/^[\w./:+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function upsertHermesProvider(text: string, hostId: string, baseUrl: string, apiKey: string): string {
  const block = [`  ${hostId}:`, `    base_url: ${quoteYaml(baseUrl)}`, `    api_key: ${quoteYaml(apiKey)}`, ""].join(
    "\n",
  );
  if (/^providers:\s*$/m.test(text)) {
    const replaced = replaceHermesHostBlock(text, hostId, block);
    if (replaced !== null) return replaced;
    return text.replace(/^providers:\s*$/m, `providers:\n${block.trimEnd()}`);
  }
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}\nproviders:\n${block}`;
}

/** Replace `  hostId:` through the next sibling 2-space key or a top-level key. */
function replaceHermesHostBlock(text: string, hostId: string, block: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${hostId}:`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (/^  \S/.test(line) || /^\S/.test(line)) break;
    end++;
  }
  while (end > start + 1 && lines[end - 1] === "") end--;
  return [...lines.slice(0, start), ...block.replace(/\n$/, "").split("\n"), ...lines.slice(end)].join("\n");
}

/** Register an OpenAI-compatible host so ACP can `session/set_model custom:host:model`. */
export function ensureHermesInjectProvider(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const dir = hermesHome(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.yaml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  const next = upsertHermesProvider(text, inject.host, host.baseUrl, hostApiKey(host, env));
  if (next !== text) writeFileSync(path, next);
  return hermesAcpModelId(modelId) ?? modelId;
}

/** ACP session/set_model id. Hermes parse_model_input treats `custom:name:model`. */
export function hermesAcpModelId(modelId: string | null | undefined): string | null {
  const inject = decodeInjectId(modelId);
  if (!inject) return null;
  return `custom:${inject.host}:${inject.model}`;
}

/** The id used when Hermes should run on the provider its own config names.
 *
 * Deliberately not an inject id: `hermesAcpModelId` returns null for it, so
 * `configureSession` sends no `session/set_model` and Hermes falls through to
 * the model in its own `config.yaml`. `spawnArgs` passes no `-m` either (ACP
 * ignores it), so nothing overrides that choice.
 */
export const HERMES_CONFIG_MODEL_ID = "hermes-default";

/** Model Hermes' own config will use, when a remote provider is configured.
 *
 * Hermes is a BYOK harness and OpenMausBot only ever offered it *local* hosts
 * (Ollama, LM Studio, EXO...). A user who has configured Hermes with a hosted
 * provider — an OpenRouter key in `~/.hermes/.env`, which is how `hermes setup`
 * stores it — had no selectable model at all: the picker showed "No local
 * models found" and greyed the agent out, despite Hermes being installed,
 * authenticated and perfectly able to answer.
 *
 * Read-only on purpose. `ensureHermesInjectProvider` writes `config.yaml`, and
 * doing that from a catalog probe would rewrite the user's real Hermes config
 * as a side effect of opening a menu.
 *
 * Returns null when no hosted key is configured, which leaves the catalog
 * exactly as it was for local-only setups.
 */
export function hermesConfiguredModel(
  env: Record<string, string | undefined> = process.env,
): { id: string; label: string } | null {
  const dir = hermesHome(env);
  let secrets = "";
  try {
    secrets = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    return null;
  }
  // Only an uncommented, non-empty assignment counts; the shipped file has the
  // key present but commented out, and that must not read as "configured".
  const keyed = /^[ \t]*OPENROUTER_API_KEY[ \t]*=[ \t]*(\S+)/m.exec(secrets);
  if (!keyed) return null;

  let model = "";
  try {
    const cfg = readFileSync(join(dir, "config.yaml"), "utf8");
    const m = /^[ \t]*default[ \t]*:[ \t]*["']?([\w./:+-]+)["']?[ \t]*$/m.exec(cfg);
    if (m) model = m[1];
  } catch {
    /* config unreadable — the id still works, only the label is less specific */
  }
  return {
    id: HERMES_CONFIG_MODEL_ID,
    label: model ? `${model} (Hermes config)` : "Hermes default (config)",
  };
}

async function resolveModels(env: Record<string, string | undefined>): Promise<ModelCatalog> {
  const catalog = await mergeLocalInject(EMPTY, env);
  const configured = hermesConfiguredModel(env);
  // Listed first so it is the default: someone who configured a hosted provider
  // meant to use it, and a local host may not even be running.
  const options = configured ? [configured, ...catalog.options] : catalog.options;
  return { default: options[0]?.id ?? "", options };
}

async function applySetting(
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>,
  method: string,
  params: Record<string, unknown>,
  what: string,
) {
  try {
    await request(method, params);
  } catch (e) {
    throw new Error(`Hermes rejected ${what} via ${method}: ${(e as Error).message}`);
  }
}

const support: AcpSupport = {
  driverKind: "hermesAgent",
  displayName: "Hermes",
  access: "custom",
  models: EMPTY,
  resolveModels,
  resolveTurnModel: (model, env) => {
    if (!model) return model;
    ensureHermesInjectProvider(model, env);
    return model;
  },
  defaultCli: "hermes",
  nativeSource: "hermes.acp",
  loginNote: "Hermes CLI is not installed",
  install: {
    command: {
      darwin: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      linux: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      win32: "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
    },
    docsUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
    signInCommand: "hermes setup",
  },
  spawnArgs: () => ["acp"],
  transformEnv: (env) => {
    // A leftover OPENAI_API_KEY makes Hermes auto-resolve to OpenRouter and
    // send no Authorization header. ACP also reloads ~/.hermes/.env, so the
    // named custom provider + session/set_model is the real route.
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  async configureSession({ request, sessionId, turn }) {
    // Decode only — resolveTurnModel already wrote the named provider using
    // the instance HOME. Calling ensure* again here would hit process.env
    // and rewrite the user's real ~/.hermes/config.yaml.
    const native = hermesAcpModelId(turn.model);
    if (!native) return;
    await applySetting(
      request,
      "session/set_model",
      { sessionId, modelId: native },
      `model "${native}"`,
    );
  },
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const HermesAgentDriver = createAcpDriver(support);
