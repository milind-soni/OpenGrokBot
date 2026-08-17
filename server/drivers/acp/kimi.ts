// Kimi Code harness support — Moonshot's `kimi` CLI over ACP stdio
// (`kimi acp`), on the Kimi Code subscription login
// (~/.kimi-code/credentials/kimi-code.json), not a Moonshot API key.
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against kimi-code 0.29.1: initialize reports
// loadSession:true (session/load resume works), mcpCapabilities http+sse,
// and a full session/new → session/prompt roundtrip streams
// agent_thought_chunk + agent_message_chunk and settles with end_turn.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

function credentialsPath(env: Record<string, string | undefined>) {
  const dataRoot = env.KIMI_CODE_HOME || join(env.HOME || homedir(), ".kimi-code");
  return join(dataRoot, "credentials", "kimi-code.json");
}

const STATIC_KIMI_MODELS: ModelCatalog = {
  default: "kimi-code/k3",
  options: [
    { id: "kimi-code/k3", label: "Kimi K3" },
    { id: "kimi-code/k3-256k", label: "Kimi K3 256K" },
    { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding" },
    { id: "kimi-code/kimi-for-coding-highspeed", label: "Kimi for Coding Highspeed" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._:/-]*$/i;

function readKimiModelCatalog(env: Record<string, string | undefined>): ModelCatalog {
  const dataRoot = env.KIMI_CODE_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".kimi-code");
  let text = "";
  try {
    text = readFileSync(join(dataRoot, "config.toml"), "utf8");
  } catch {
    return STATIC_KIMI_MODELS;
  }
  const options = STATIC_KIMI_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let current: { slug: string; name?: string } | null = null;
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
    if ((stripped.startsWith("[model.") || stripped.startsWith("[models.")) && stripped.endsWith("]")) {
      flush();
      let inner = stripped.replace(/^\[models?\./, "").slice(0, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (current && (key === "name" || key === "label") && value) current.name = value;
  }
  flush();
  return { default: STATIC_KIMI_MODELS.default, options };
}

const support: AcpSupport = {
  driverKind: "kimiAgent",
  displayName: "Kimi",
  // Aliases from the CLI's own catalog (~/.kimi-code/config.toml
  // [models."kimi-code/…"] — `kimi provider list` reports the same four).
  models: STATIC_KIMI_MODELS,
  resolveModels: (env) => readKimiModelCatalog(env),
  defaultCli: "kimi",
  nativeSource: "kimi.acp",
  loginNote: "Kimi Code CLI is not signed in — run `kimi login` in a terminal",

  // Official installers put the binary on PATH without requiring an existing
  // Node install. Keep the commands platform-specific so Windows never gets a
  // POSIX-only curl|bash instruction.
  install: {
    command: {
      darwin: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      linux: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      win32: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
    },
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
    signInCommand: "kimi login",
  },

  // -m is a global commander option and must precede the `acp` subcommand
  // (verified against 0.29.1).
  spawnArgs: (_config, turn) => [...(turn.model ? ["-m", turn.model] : []), "acp"],

  // Subscription CLI: a leaked Moonshot/Kimi API key must not flip billing
  // to pay-as-you-go inside the spawned agent (mirrors claude/grok).
  transformEnv: (env) => {
    delete env.MOONSHOT_API_KEY;
    delete env.KIMI_API_KEY;
  },

  // The only advertised authMethod is {id:"login", type:"terminal"} — a
  // device-code flow that cannot be driven over ACP. Never pick it; ride
  // the ambient login from a prior `kimi login` instead.
  pickAuthMethod: () => null,
  authFailure: "continue",
  // Match the child CLI's own data-root precedence. A custom instance HOME or
  // KIMI_CODE_HOME must not be checked against the server user's home instead.
  isAuthenticated: (env) => existsSync(credentialsPath(env)),

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KimiAgentDriver = createAcpDriver(support);
