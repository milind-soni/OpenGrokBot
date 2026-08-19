// Remote ACP — a provider-neutral engine for any command that speaks the
// Agent Client Protocol on stdio for an agent that EXECUTES SOMEWHERE ELSE:
// a hosted sandbox service's CLI (`fountain acp --agent x`), an agent on
// another machine (`ssh box -- codex acp`), a container (`docker exec -i …`).
// Nothing about the provider is hard-coded; the instance's `config` says
// how to start the bridge, how to list what the picker can choose, and how
// to tell whether it is signed in.
//
//   {
//     "instances": {
//       "fountain": {
//         "driver": "remoteAcp",
//         "displayName": "Fountain",
//         "config": {
//           "cli": "fountain",
//           "args": ["acp", "--agent", "{model}"],
//           "catalog": ["agent", "list", "--json"],
//           "authCheck": ["auth", "whoami"]
//         },
//         "environment": { "FOUNTAIN_API_KEY": "…" }
//       }
//     }
//   }
//
// What "remote" changes, and what this support therefore encodes:
//
//   • The picker chooses whatever the catalog command lists — a model, an
//     agent, a profile, an environment: the remote side's unit of choice —
//     and the pick lands in the command line where `{model}` appears. ACP
//     has no field for it; the bridge's argv is the only channel.
//   • The agent does not run on this machine, so by default no local MCP
//     integration is mounted: the bot is never told it has a computer, a
//     Composio connection, or peers that its driver cannot hand it. A bridge
//     that DOES forward mcpServers (ssh to a box that runs them there) can
//     opt back in per mount with `config.mcp`.
//   • Credentials are the bridge's own. No `authenticate` RPC is sent
//     unless `config.authMethod` names one; sign-in is probed with
//     `config.authCheck` (exit 0 = signed in) and trusted otherwise.
//   • The ACP session id is whatever the remote side uses for a
//     conversation, so the resume cursor core.ts already stores survives
//     restarts and machines when the bridge implements session/load.
//
// The catalog contract is deliberately small: print JSON — an array, or an
// object whose `data`/`models`/`agents`/`items` is one — of rows with a
// string `id` and optionally `label` or `name`. A row with `acp: false`
// (the remote side's way of saying this entry cannot be driven over the
// protocol) is left out. Anything else is ignored. Static `models` work
// too, for bridges with nothing to list, and merge ahead of the command's.
import { z } from "zod";

import { execCli } from "../../procs.ts";
import { parseJson, schemaIssue } from "../../schema.ts";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpMcpMounts, type AcpSupport } from "./core.ts";

const EMPTY: ModelCatalog = { default: "", options: [] };
const CLI_TIMEOUT = 20_000;
/** Where the picked catalog id lands in `args`. */
export const MODEL_PLACEHOLDER = "{model}";

export interface RemoteAcpConfig extends AcpConfig {
  /** argv after the binary that enters ACP stdio mode. `{model}` is replaced
   *  by the picker's choice; see {@link remoteAcpSpawnArgs} for the empty case. */
  args: string[];
  /** argv after the binary that prints the picker catalog as JSON. */
  catalog?: string[];
  /** Static picker entries, listed ahead of whatever `catalog` returns. */
  models: Array<{ id: string; label: string }>;
  /** argv after the binary whose exit status answers "signed in?". Omitted:
   *  the bridge is trusted to hold its own credentials. */
  authCheck?: string[];
  /** ACP authenticate methodId to use when the agent advertises it. Omitted:
   *  never call authenticate — the bridge already holds the credentials. */
  authMethod?: string;
  /** Which local MCP integrations the bridge forwards to the remote agent.
   *  All false unless set: a remote agent cannot reach this machine. */
  mcp: AcpMcpMounts;
}

const argvSchema = z.array(z.string());
const modelRowSchema = z.union([
  z.string().min(1).transform((id) => ({ id, label: id })),
  z.object({ id: z.string().min(1), label: z.string().optional() }).transform((row) => ({
    id: row.id,
    label: row.label || row.id,
  })),
]);
const mountsSchema = z.object({
  agents: z.boolean().optional(),
  computer: z.boolean().optional(),
  composio: z.boolean().optional(),
});
/** The remote-specific keys of the instance `config` envelope; the shared
 * cli/fullAuto/workspace triple is read by core before this runs. */
const remoteConfigSchema = z.object({
  args: argvSchema.optional(),
  catalog: argvSchema.optional(),
  models: z.array(modelRowSchema).optional(),
  authCheck: argvSchema.optional(),
  authMethod: z.string().optional(),
  mcp: mountsSchema.optional(),
});

/** Read the remote-specific settings out of the instance's `config`. Throws on
 * a malformed entry so the registry shows WHY the engine is a shadow instead
 * of running a command that was never what the user meant. */
export function decodeRemoteAcpConfig(raw: Record<string, unknown>, base: AcpConfig): RemoteAcpConfig {
  const parsed = remoteConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`remoteAcp config.${schemaIssue(parsed.error, "is not valid")}`);
  const { args, catalog, models, authCheck, authMethod, mcp } = parsed.data;
  return {
    ...base,
    args: args ?? [],
    catalog,
    models: models ?? [],
    authCheck,
    authMethod: authMethod || undefined,
    mcp: mcp ?? {},
  };
}

/** One catalog row as the contract reads it; anything else is ignored. */
const catalogRowSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  name: z.string().optional(),
  acp: z.boolean().optional(),
});
const rowsSchema = z.array(z.unknown());
/** An array, or the common object envelopes around one. */
const catalogSchema = z.union([
  rowsSchema,
  z
    .object({
      data: rowsSchema.optional(),
      models: rowsSchema.optional(),
      agents: rowsSchema.optional(),
      items: rowsSchema.optional(),
    })
    .transform((o) => o.data ?? o.models ?? o.agents ?? o.items ?? []),
]);

/** Turn the catalog command's JSON into picker options. See the contract in
 * the header: rows with a string `id`; `label` else `name` else the id; a
 * row marked `acp: false` is skipped. */
export function parseRemoteAcpCatalog(json: string): ModelCatalog["options"] {
  let parsed: unknown;
  try {
    parsed = parseJson(json);
  } catch {
    return [];
  }
  const rows = catalogSchema.safeParse(parsed);
  if (!rows.success) return [];
  const options: ModelCatalog["options"] = [];
  for (const raw of rows.data) {
    const row = catalogRowSchema.safeParse(raw);
    if (!row.success || row.data.acp === false) continue;
    options.push({ id: row.data.id, label: row.data.label || row.data.name || row.data.id });
  }
  return options;
}

/** Static entries first, then the command's, first occurrence of an id wins. */
export function mergeRemoteAcpCatalog(
  statics: ModelCatalog["options"],
  listed: ModelCatalog["options"],
): ModelCatalog {
  const seen = new Set<string>();
  const options: ModelCatalog["options"] = [];
  for (const option of [...statics, ...listed]) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    options.push(option);
  }
  return { default: options[0]?.id ?? "", options };
}

/** Substitute the pick into the argv template. With nothing picked (empty
 * catalog, or the picker left blank) the `{model}` argument is dropped, and
 * so is a directly preceding option (`--agent`, `-m`) that would otherwise
 * be left dangling; the bridge then runs on its own default, or reports
 * that it has none — its error, in its words, not ours. */
export function remoteAcpSpawnArgs(template: readonly string[], model: string | undefined): string[] {
  const out: string[] = [];
  for (const arg of template) {
    if (!arg.includes(MODEL_PLACEHOLDER)) {
      out.push(arg);
      continue;
    }
    if (model) {
      out.push(arg.split(MODEL_PLACEHOLDER).join(model));
      continue;
    }
    if (arg === MODEL_PLACEHOLDER && out.length && /^-/.test(out[out.length - 1]!)) out.pop();
  }
  return out;
}

/** The bridge's own words for "you are not signed in", as far as any one
 * pattern can be provider-neutral. Sign-in is a user action, not a retry. */
export function classifyRemoteAcpError(error: unknown): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/not (signed|logged) in|not authenticated|unauthenticated|credentials .*rejected|\b401\b|unauthori[sz]ed/i.test(message)) {
    return "invalid_credentials";
  }
  return undefined;
}

/** How the catalog and sign-in probes reach the bridge; injectable so tests
 * need no binary. */
export type RemoteAcpRunner = (
  cli: string,
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<{ ok: boolean; stdout: string }>;

const runCli: RemoteAcpRunner = (cli, args, env) =>
  new Promise((resolve) => {
    // SAFETY: the env map is process.env + instance environment (string or
    // undefined values), which is exactly NodeJS.ProcessEnv's shape.
    execCli(cli, args, { timeout: CLI_TIMEOUT, env: env as NodeJS.ProcessEnv }, (err, stdout) =>
      resolve({ ok: !err, stdout }),
    );
  });

export function createRemoteAcpDriver(run: RemoteAcpRunner = runCli) {
  const support: AcpSupport<RemoteAcpConfig> = {
    driverKind: "remoteAcp",
    displayName: "Remote ACP",
    // Cloud rail: whatever the bridge lists IS the catalog (agents on a
    // hosted service, models on another box). "custom" would send the
    // picker to the local-models pane, where a remote agent has nothing.
    access: "subscription",
    models: EMPTY,
    defaultCli: "acp",
    decodeConfig: decodeRemoteAcpConfig,
    resolveModels: async (env, config) => {
      let listed: ModelCatalog["options"] = [];
      if (config.catalog) {
        const { ok, stdout } = await run(config.cli, config.catalog, env);
        // a failed listing throws so core keeps the last usable catalog
        // instead of emptying the picker while the remote side is down
        if (!ok) throw new Error("catalog command failed");
        listed = parseRemoteAcpCatalog(stdout);
      }
      return mergeRemoteAcpCatalog(config.models, listed);
    },
    nativeSource: "remote.acp",
    loginNote: "the remote ACP command is not signed in",
    mcp: (config) => ({
      agents: config.mcp.agents ?? false,
      computer: config.mcp.computer ?? false,
      composio: config.mcp.composio ?? false,
    }),
    spawnArgs: (config, turn) => remoteAcpSpawnArgs(config.args, turn.model),
    // The wire authenticate step is opt-in by method id: most bridges hold
    // their credentials themselves and advertise `authenticate` only to say
    // "go sign in". A missing login then fails session/new with an error
    // the classifier below turns into a setup prompt.
    pickAuthMethod: (methods, config) =>
      config.authMethod && methods.some((m) => m.id === config.authMethod) ? config.authMethod : null,
    authFailure: "continue",
    isAuthenticated: async (env, config) => {
      if (!config.authCheck) return true;
      const { ok } = await run(config.cli, config.authCheck, env);
      return ok;
    },
    classifyError: classifyRemoteAcpError,
  };
  return createAcpDriver(support);
}

export const RemoteAcpDriver = createRemoteAcpDriver();
