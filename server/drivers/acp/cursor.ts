// Cursor Agent CLI harness support — Anysphere's `agent acp` over ACP stdio,
// billed on the Cursor subscription (`agent login`, CURSOR_API_KEY, or
// CURSOR_AUTH_TOKEN). The generic protocol runtime lives in acp/core.ts; this
// file is only the per-harness quirks.
//
// Verified against the public CLI contract (cursor.com/docs/cli/acp,
// …/reference/parameters): `agent acp` speaks JSON-RPC on stdio, advertises
// `cursor_login`, and takes `--force` / `--model` as global flags before the
// `acp` subcommand. `session/set_model` is attempted when the CLI supports it;
// a missing method falls back to the argv `--model` pin.
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const STATIC_CURSOR_MODELS: ModelCatalog = {
  default: "composer-2",
  options: [
    { id: "composer-2", label: "Composer 2" },
    { id: "gpt-5", label: "GPT-5" },
    { id: "sonnet-4.5", label: "Claude 4.5 Sonnet" },
    { id: "opus-4.6", label: "Claude 4.6 Opus" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._:+-]*$/i;
const EXEC_TIMEOUT_MS = 8_000;

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

function firstJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // CLIs sometimes print a banner before the payload. Take the first
    // {...} or [...] span that parses, rather than requiring a clean stdout.
  }
  const start = trimmed.search(/[{[]/);
  if (start < 0) return null;
  for (let end = trimmed.length; end > start + 1; end--) {
    const slice = trimmed.slice(start, end).trim();
    if (!slice.endsWith("}") && !slice.endsWith("]")) continue;
    try {
      return JSON.parse(slice);
    } catch {
      // keep shrinking
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function labelFor(id: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  return id
    .split(/[-_./]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pushModel(
  options: ModelCatalog["options"],
  seen: Set<string>,
  id: string,
  label?: string,
  custom = false,
): void {
  if (!SLUG.test(id) || seen.has(id)) return;
  seen.add(id);
  options.push({ id, label: labelFor(id, label), ...(custom ? { custom: true as const } : {}) });
}

/** Turn `agent models` JSON (or a close cousin) into a picker catalog.
 *  Unknown shapes return null so the caller can try text / keep the fallback. */
export function decodeCursorModelCatalog(payload: unknown): ModelCatalog | null {
  const records: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.models)
      ? (asRecord(payload)!.models as unknown[])
      : Array.isArray(asRecord(payload)?.data)
        ? (asRecord(payload)!.data as unknown[])
        : Array.isArray(asRecord(payload)?.modelIds)
          ? (asRecord(payload)!.modelIds as unknown[])
          : [];
  if (!records.length) return null;

  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const row of records) {
    if (typeof row === "string") {
      pushModel(options, seen, row, undefined, true);
      continue;
    }
    const rec = asRecord(row);
    if (!rec) continue;
    const id = rec.id ?? rec.modelId ?? rec.slug ?? rec.name;
    if (typeof id !== "string") continue;
    const label =
      (typeof rec.label === "string" && rec.label) ||
      (typeof rec.displayName === "string" && rec.displayName) ||
      (typeof rec.name === "string" && rec.name !== id ? rec.name : undefined);
    pushModel(options, seen, id, label || undefined, true);
  }
  if (!options.length) return null;

  const defaultId =
    (typeof asRecord(payload)?.default === "string" && seen.has(asRecord(payload)!.default as string)
      ? (asRecord(payload)!.default as string)
      : undefined) ??
    (seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : options[0]!.id);

  // Keep the static cloud set at the front (stable picker rail) and append
  // live ids the static list does not already name.
  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  return { default: defaultId, options: merged };
}

/** Last-resort parse of `agent models` text: one slug per line, optional
 *  `id — label` / `id: label` columns. */
export function decodeCursorModelText(text: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^models?\b/i.test(line)) continue;
    const stripped = line.replace(/^[\s*•\-]+\s*/, "");
    const parts = stripped.split(/\s+[—–|:]\s+|\s+-\s+|\s{2,}/);
    const id = (parts[0] ?? "").trim();
    const label = parts.slice(1).join(" ").trim();
    pushModel(options, seen, id, label || undefined, true);
  }
  if (!options.length) return null;
  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  const defaultId = seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : merged[0]!.id;
  return { default: defaultId, options: merged };
}

function truthyAuthFlag(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "authenticated", "logged_in", "logged-in", "yes"].includes(normalized)) return true;
    if (["false", "unauthenticated", "logged_out", "logged-out", "no"].includes(normalized)) return false;
  }
  return null;
}

/** Read `agent status --format json` / `agent whoami --format json`.
 *  Returns null when the payload does not actually answer the question. */
export function decodeCursorAuthStatus(payload: unknown): boolean | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const auth = asRecord(rec.auth);
  const candidates = [
    rec.isAuthenticated,
    rec.authenticated,
    rec.loggedIn,
    rec.logged_in,
    auth?.isAuthenticated,
    auth?.authenticated,
    rec.status,
    auth?.status,
  ];
  for (const candidate of candidates) {
    const flag = truthyAuthFlag(candidate);
    if (flag !== null) return flag;
  }
  return null;
}

function execText(
  run: typeof execCli,
  cli: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<string | null> {
  return new Promise((resolve) => {
    run(cli, args, { timeout: EXEC_TIMEOUT_MS, env: env as NodeJS.ProcessEnv }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout ?? ""));
    });
  });
}

export async function probeCursorAuth(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<boolean> {
  if (nonBlank(env.CURSOR_API_KEY) || nonBlank(env.CURSOR_AUTH_TOKEN)) return true;
  for (const args of [
    ["status", "--format", "json"],
    ["whoami", "--format", "json"],
  ] as const) {
    const stdout = await execText(run, cli, [...args], env);
    if (stdout == null) continue;
    const decoded = decodeCursorAuthStatus(firstJsonValue(stdout));
    if (decoded !== null) return decoded;
  }
  return false;
}

export async function fetchCursorModels(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<ModelCatalog> {
  const stdout = await execText(run, cli, ["models", "--format", "json"], env);
  if (stdout != null) {
    const fromJson = decodeCursorModelCatalog(firstJsonValue(stdout));
    if (fromJson) return fromJson;
    const fromText = decodeCursorModelText(stdout);
    if (fromText) return fromText;
  }
  return STATIC_CURSOR_MODELS;
}

export function classifyCursorError(error: unknown): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (
    code === -32000 ||
    /unauthoriz|unauthenticated|not signed in|not logged in|invalid api key|invalid_credentials|authentication required/.test(
      blob,
    )
  ) {
    return "invalid_credentials";
  }
  if (/inactive subscription|subscription.*(expired|inactive)|upgrade your (plan|subscription)/.test(blob)) {
    return "inactive_subscription";
  }
  return undefined;
}

const support = (run: typeof execCli): AcpSupport => ({
  driverKind: "cursorAgent",
  displayName: "Cursor",
  models: STATIC_CURSOR_MODELS,
  defaultCli: "agent",
  nativeSource: "cursor.acp",
  loginNote: "Cursor CLI is not signed in — run `agent login` in a terminal, or set CURSOR_API_KEY",

  install: {
    command: {
      darwin: "curl https://cursor.com/install -fsS | bash",
      linux: "curl https://cursor.com/install -fsS | bash",
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
    },
    docsUrl: "https://cursor.com/docs/cli/installation",
    signInCommand: "agent login",
  },

  // Global flags must precede `acp` (cursor.com/docs/cli/reference/parameters).
  // `--force` is the documented auto-approve switch (`--yolo` is an alias);
  // `--model` is the reliable pin — ACP session/set_model is best-effort below.
  spawnArgs: (config, turn) => [
    ...(config.fullAuto ? ["--force"] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    "acp",
  ],
  credentialEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],

  resolveModels: (environment, config) => fetchCursorModels(config.cli || "agent", environment, run),

  // Prefer the advertised ACP method. An already-signed-in CLI should accept
  // cursor_login without a browser; a missing method rides the ambient login
  // (CURSOR_API_KEY / `agent login`) instead of failing the turn.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cursor_login") ? "cursor_login" : null),
  authFailure: "continue",
  isAuthenticated: (env, config) => probeCursorAuth(config.cli || "agent", env, run),
  classifyError: classifyCursorError,

  async configureSession({ request, sessionId, turn }) {
    if (!turn.model) return;
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (e) {
      const err = e as Error & { code?: unknown };
      if (err.code === -32601) return;
      throw new Error(
        `Cursor rejected model "${turn.model}" via session/set_model: ${err.message}. ` +
          `Check that \`agent\` is current and that this account can use that model.`,
      );
    }
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
});

export function createCursorAgentDriver(run: typeof execCli = execCli) {
  return createAcpDriver(support(run));
}

export const CursorAgentDriver = createCursorAgentDriver();
