// Grok Build harness support — the official `grok` CLI over ACP stdio
// (`grok … agent stdio`), on the grok.com subscription login
// (~/.grok/auth.json), NOT the xAI API key (that driver is drivers/grok.ts).
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against grok 1.0.0.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const STATIC_GROK_MODELS: ModelCatalog = {
  default: "grok-4.6",
  options: [
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

function grokHome(env: Record<string, string | undefined>): string {
  if (env.GROK_HOME) return env.GROK_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".grok");
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/** Local slugs from ~/.grok/config.toml, plus the two cloud defaults.
 *  `grok -m <slug>` already accepts these; the picker just didn't list them. */
export function readGrokModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return STATIC_GROK_MODELS;
  }

  const options = STATIC_GROK_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let configuredDefault: string | null = null;
  let current: { slug: string; name?: string } | null = null;
  let inModels = false;

  const flush = () => {
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "[models]") {
      flush();
      inModels = true;
      continue;
    }
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      inModels = false;
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      inModels = false;
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (current && key === "name" && value) current.name = value;
    if (!current && inModels && key === "default") configuredDefault = value;
  }
  flush();

  return {
    default: configuredDefault && seen.has(configuredDefault) ? configuredDefault : STATIC_GROK_MODELS.default,
    options,
  };
}

const support: AcpSupport = {
  driverKind: "grokAgent",
  displayName: "Grok",
  models: STATIC_GROK_MODELS,
  resolveModels: (env) => readGrokModelCatalog(env),
  // Grok's accepted levels vary by model and the CLI validates lazily — a
  // rejected level only logs and falls back. Offer the intersection shared
  // by every model in this driver's picker; notably, grok-4.5 rejects xhigh.
  effortLevels: ["low", "medium", "high"],
  defaultCli: "grok",
  nativeSource: "grok.acp",
  loginNote: "Grok CLI is not signed in — run `grok login` in a terminal",

  // No Windows one-liner: the installer is a POSIX shell script, and offering
  // `curl … | bash` there would be advice that cannot run. Windows falls back
  // to docsUrl, which is honest rather than broken.
  install: {
    command: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
    docsUrl: "https://x.ai/cli",
    signInCommand: "grok login",
  },

  // --permission-mode must always be explicit: ~/.grok/config.toml may set
  // permission_mode = "always-approve", which would silently make every
  // session yolo and never fire session/request_permission.
  spawnArgs: (config, turn) => [
    "--permission-mode",
    config.fullAuto ? "bypassPermissions" : "default",
    ...(turn.model ? ["-m", turn.model] : []),
    // long form on purpose: `--effort` is documented as an alias, and an
    // alias is the part a CLI is free to rename
    ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    "agent",
    "stdio",
  ],

  // The CLI owns its own grok.com login; a leaked API key silently flips
  // billing from the subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.XAI_API_KEY;
  },

  // Bind the grok.com subscription login. No API-key fallback by design —
  // an unauthenticated CLI is a user action, not something to paper over.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: () => existsSync(join(homedir(), ".grok", "auth.json")),

  // `--append-system-prompt`/`--rules` are accepted by the CLI but do NOT
  // reach the agent-stdio system prompt (verified against 1.0.0), so the
  // persona is prepended codex-style.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GrokAgentDriver = createAcpDriver(support);
