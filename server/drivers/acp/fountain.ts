// Fountain — `fountain acp`, the ACP stdio adapter of the Fountain CLI
// (https://github.com/BinaryBourbon/fountain). Unlike every other ACP
// harness here the agent does NOT run on this machine: `fountain acp` is a
// window onto a conversation running in a sandbox on your Fountain instance.
// That changes three things about the driver:
//
//   • The "model" picker chooses a Fountain *agent*, not a model. A Fountain
//     agent already carries its model, runtime (claude/codex/opencode/…),
//     skills, MCP servers and environment; ACP has no field for it, so it
//     goes on the command line (`--agent`). The catalog is `fountain agent
//     list --json`, filtered to agents whose runtime speaks ACP.
//   • The session id IS the Fountain conversation id (ADR 0015), so the
//     resume cursor core.ts already keeps survives restarts, machines and
//     days: `session/load` replays the transcript from the server.
//   • `cwd` and `mcpServers` are ignored by the adapter — the sandbox has
//     its own checkout and the agent its own MCP config — so this support
//     declares no MCP integrations. A bot must never be told it has a
//     computer whose tools its driver cannot mount.
//
// Credentials are the CLI's (`fountain auth login`, or FOUNTAIN_API_KEY +
// FOUNTAIN_BASE_URL in the instance environment). Permission requests are
// not forwarded by `fountain acp` yet (fountain#643): sandboxed runtimes
// run under their own permission mode, so no approval cards appear.
import { execCli } from "../../procs.ts";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };
const CLI_TIMEOUT = 15_000;

/** One row of `fountain agent list --json`, the fields the catalog reads. */
interface FountainAgentRow {
  id?: unknown;
  name?: unknown;
  runtime?: unknown;
  model?: unknown;
  /** false when the agent's runtime does not speak ACP (gemini, fountain#659) */
  acp?: unknown;
}

/** Turn the CLI's agent listing into a picker catalog. Non-ACP agents are
 * dropped: `fountain acp` refuses them at session/new, and a picker entry
 * that can never run a turn is worse than none. The id is the agent's UUID
 * (stable across renames — `--agent` takes either); the label is the name
 * plus the runtime/model so two agents on the same model still read apart. */
export function parseFountainAgentCatalog(json: string): ModelCatalog {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return EMPTY;
  }
  if (!Array.isArray(rows)) return EMPTY;
  const options: ModelCatalog["options"] = [];
  for (const raw of rows as FountainAgentRow[]) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.id !== "string" || !raw.id) continue;
    if (raw.acp === false) continue;
    const name = typeof raw.name === "string" && raw.name ? raw.name : raw.id;
    const runtime = typeof raw.runtime === "string" ? raw.runtime : "";
    const model = typeof raw.model === "string" ? raw.model : "";
    const detail = [runtime, model].filter(Boolean).join(" · ");
    options.push({ id: raw.id, label: detail ? `${name} (${detail})` : name });
  }
  return { default: options[0]?.id ?? "", options };
}

/** How the catalog reaches the CLI; injectable so tests need no binary. */
export type FountainCliRunner = (
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<{ ok: boolean; stdout: string }>;

const runFountainCli: FountainCliRunner = (args, env) =>
  new Promise((resolve) => {
    // SAFETY: the env map is process.env + instance environment (string or
    // undefined values), which is exactly NodeJS.ProcessEnv's shape.
    execCli(cliName(env), args, { timeout: CLI_TIMEOUT, env: env as NodeJS.ProcessEnv }, (err, stdout) =>
      resolve({ ok: !err, stdout }),
    );
  });

/** The catalog and the sign-in probe run before any session exists, so
 * they only see the instance environment, not the decoded config. A user
 * who set a custom `cli` in the instance config can mirror it here. */
function cliName(env: Record<string, string | undefined>): string {
  return env.FOUNTAIN_CLI || "fountain";
}

/** Sign-in and agent-resolution failures, in the adapter's own words (see
 * docs/integrations/acp.md "When something goes wrong"). Both are user
 * actions, not retries. */
export function classifyFountainError(error: unknown): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/credentials .* were rejected|not signed in|not authenticated|401|unauthorized/i.test(message)) {
    return "invalid_credentials";
  }
  return undefined;
}

/** `fountain acp` argv: the agent from the picker, plus the optional vault
 * and environment overrides. Those two are per-instance knobs (one Fountain
 * engine entry per identity or environment, exactly how the CLI docs frame
 * `--vault`/`--environment`), so they ride the instance environment rather
 * than the model id. An empty model is passed through as no `--agent`: the
 * adapter answers "no Fountain agent configured", which surfaces as the
 * turn's runtime.error instead of a guess. */
export function fountainSpawnArgs(model: string | undefined, env: Record<string, string | undefined>): string[] {
  const args = ["acp"];
  if (model) args.push("--agent", model);
  if (env.FOUNTAIN_ACP_VAULT) args.push("--vault", env.FOUNTAIN_ACP_VAULT);
  if (env.FOUNTAIN_ACP_ENVIRONMENT) args.push("--environment", env.FOUNTAIN_ACP_ENVIRONMENT);
  // FOUNTAIN_PROFILE / FOUNTAIN_API_KEY / FOUNTAIN_BASE_URL are read by the
  // CLI itself from the environment, so they need no flag here.
  return args;
}

export function createFountainAgentDriver(run: FountainCliRunner = runFountainCli) {
  const support: AcpSupport = {
    driverKind: "fountainAgent",
    displayName: "Fountain",
    // No first-party cloud catalog: the picker lists YOUR agents on YOUR
    // instance, which is what "custom" means to the picker rail.
    access: "custom",
    models: EMPTY,
    resolveModels: async (env) => {
      const { ok, stdout } = await run(["agent", "list", "--json"], env);
      if (!ok) return EMPTY;
      return parseFountainAgentCatalog(stdout);
    },
    defaultCli: "fountain",
    nativeSource: "fountain.acp",
    loginNote: "Fountain CLI is not signed in — run `fountain auth login`",
    install: {
      command: {
        darwin: "brew install BinaryBourbon/tap/fountain",
        linux: "brew install BinaryBourbon/tap/fountain",
      },
      docsUrl: "https://github.com/BinaryBourbon/fountain/blob/main/docs/cli.md",
      signInCommand: "fountain auth login",
    },
    mcp: { agents: false, computer: false, composio: false },
    spawnArgs: (_config, turn, env) => fountainSpawnArgs(turn.model, env),
    // `fountain acp` advertises `authenticate` only when the CLI holds no
    // credentials, and its one method just says "run fountain auth login" —
    // there is nothing to authenticate over the wire. Skip it and let a
    // missing login fail session/new with a classified error instead.
    pickAuthMethod: () => null,
    authFailure: "continue",
    isAuthenticated: async (env) => {
      if (env.FOUNTAIN_API_KEY) return true;
      const { ok } = await run(["auth", "whoami"], env);
      return ok;
    },
    classifyError: classifyFountainError,
    // The Fountain agent carries its own system prompt; the bot persona
    // (name/title/description) is prepended like every other ACP harness so
    // "who am I to you" still lands.
    buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
  };
  return createAcpDriver(support);
}

export const FountainAgentDriver = createFountainAgentDriver();
