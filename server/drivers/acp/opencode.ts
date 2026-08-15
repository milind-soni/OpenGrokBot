// OpenCode harness support — `opencode acp` over ACP stdio, riding the generic
// runtime in acp/core.ts. Verified against opencode 1.18.18.
//
// Two things set OpenCode apart from the other ACP harnesses:
//
// 1. It is provider-plural. The model list is whatever the user has
//    credentials for — 471 entries on a configured machine, 7 (the free
//    OpenCode Zen ones) on a virgin HOME — so the catalog is discovered at
//    runtime instead of compiled in. And `opencode acp` takes no -m, so the
//    model is set with session/set_config_option (support.selectModel).
//
// 2. Its default permission policy allows everything: the `build` agent
//    carries {permission:"*", action:"allow", pattern:"*"}, so a bot would run
//    shell commands with no approval card at all — a real gap against the
//    claude and codex drivers. See ASK_POLICY below.

import type { ModelCatalog } from "../../contracts.ts";
import { execCli } from "../../procs.ts";

import { createAcpDriver, type AcpSupport } from "./core.ts";

type Env = Record<string, string | undefined>;

const CATALOG_TTL_MS = 60_000;
// Bounds every execCli call in this file (`opencode models` and `debug
// config`). ProviderInstance.catalog's contract requires discovery to bound
// its own latency: describe() awaits every instance together, so a call
// that never settles stalls the whole /api/instances response, and server
// startup with it, not just this row. Measured at ~1.1s against 1.18.18;
// 10s leaves generous slack for a slower machine while landing close to
// core.ts's 8s snapshot() version-probe ceiling — describe() awaits that
// and this back to back for the same instance, so the two bounds stack,
// and the previous 20s let this half alone run two and a half times as
// long as the other.
const CLI_TIMEOUT_MS = 10_000;

// Injectable so the TTL can be tested by moving time rather than waiting for
// it — a test that needs a sleep to pass is wrong.
let now: () => number = () => Date.now();
const cache = new Map<string, { at: number; value: ModelCatalog }>();

export const __catalogTestHooks = {
  reset() {
    cache.clear();
    now = () => Date.now();
  },
  setClock(clock: () => number) {
    now = clock;
  },
};

/** Run a read-only opencode subcommand, resolving to null on any failure.
 *  `opencode models` is ~15 KB; the buffer is generous so a machine with many
 *  providers cannot silently truncate its own catalog. */
function run(cli: string, args: string[], env: Env): Promise<string | null> {
  return new Promise((resolve) => {
    execCli(cli, args, { timeout: CLI_TIMEOUT_MS, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/** The model opencode itself would use. `debug config` is a debug command with
 *  no stability promise, so its failure is absorbed: the default falls back to
 *  the first catalog entry, which on a machine with no credentials is a free
 *  OpenCode Zen model. */
async function defaultModel(cli: string, env: Env): Promise<string | null> {
  const raw = await run(cli, ["debug", "config"], env);
  if (!raw) return null;
  try {
    const model = JSON.parse(raw)?.model;
    return typeof model === "string" && model ? model : null;
  } catch {
    return null;
  }
}

/** Two instances can point at the same binary through different homes or
 *  config paths and legitimately see different catalogs, so the key carries
 *  everything that changes what opencode resolves.
 *
 *  JSON rather than a joined string: joining on a separator lets a value that
 *  contains that separator collide with a different split of the same
 *  characters (HOME "a b" + XDG "c" against HOME "a" + XDG "b c"), and Windows
 *  paths routinely contain spaces. JSON also keeps an unset variable distinct
 *  from one explicitly set to empty. */
function cacheKey(cli: string, env: Env): string {
  return JSON.stringify([
    cli,
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.OPENCODE_CONFIG,
    env.OPENCODE_CONFIG_DIR,
  ]);
}

export async function discoverCatalog(cli: string, env: Env): Promise<ModelCatalog> {
  const key = cacheKey(cli, env);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CATALOG_TTL_MS) return hit.value;

  const [listing, configured] = await Promise.all([run(cli, ["models"], env), defaultModel(cli, env)]);
  // A CLI that could not run at all is not a CLI reporting no models. Caching
  // that would keep the engine dark for the whole TTL after the problem
  // cleared, and re-opening the picker would not help. Serve the last good
  // catalog if we have one, store nothing, and let the next call retry.
  if (listing === null) return hit?.value ?? { default: "", options: [] };

  const options = parseModels(listing);
  const chosen = configured && options.some((o) => o.id === configured) ? configured : (options[0]?.id ?? "");
  const value: ModelCatalog = { default: chosen, options };
  cache.set(key, { at: now(), value });
  return value;
}

/** Parse `opencode models`: one provider-qualified id per line, no decoration.
 *  Measured on 1.18.18: 471 lines, all matching, no ANSI. Anything that does
 *  not match is dropped rather than guessed at — if the format ever grows a
 *  header, the catalog goes empty and the engine reports itself unavailable,
 *  which is noisy but never a lie. */
export function parseModels(stdout: string): Array<{ id: string; label: string }> {
  const models: Array<{ id: string; label: string }> = [];
  // Split on \r?\n rather than \n: a CRLF stream would otherwise leave a \r
  // glued to every line, which `\S+$` cannot consume, and the whole catalog
  // would parse to nothing — silently, on the one platform we cannot exercise
  // from here.
  for (const line of stdout.split(/\r?\n/)) {
    if (!/^[\w.-]+\/\S+$/.test(line)) continue;
    models.push({ id: line, label: line.slice(line.indexOf("/") + 1) });
  }
  return models;
}

// Mirrors the claude driver's default --permission-mode acceptEdits: reads and
// edits go through, anything that leaves the sandbox asks. `*: ask` is the
// conservative half — it also catches tools claude has no equivalent for.
const ASK_POLICY = {
  "*": "ask",
  read: "allow",
  glob: "allow",
  grep: "allow",
  lsp: "allow",
  edit: "allow",
  bash: "ask",
  webfetch: "ask",
  websearch: "ask",
  external_directory: "ask",
};

/** Compose the child's OPENCODE_CONFIG_CONTENT.
 *
 *  OPENCODE_CONFIG_CONTENT rather than the undocumented OPENCODE_PERMISSION:
 *  it is documented, and it merges AFTER the project's own opencode.json, so a
 *  repository cannot lower the policy we set. We overwrite only `permission`,
 *  so the user's MCP servers, agents and skills survive — but we always win on
 *  that one key, which is the whole point. */
function permissionEnv(existing: string | undefined, fullAuto: boolean): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed;
    } catch {
      /* not our JSON to repair — replace it rather than ship a broken config */
    }
  }
  return JSON.stringify({ ...base, permission: fullAuto ? "allow" : ASK_POLICY });
}

const support: AcpSupport = {
  driverKind: "opencodeAgent",
  displayName: "OpenCode",
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  // The real catalog is per-machine and comes from catalog(); this is only the
  // honest fallback if discovery fails. An empty list makes the engine report
  // itself unusable, which beats advertising models the user cannot run.
  models: { default: "", options: [] },
  catalog: (config, env) => discoverCatalog(config.cli, env),
  selectModel: { configId: "model" },

  // `opencode acp` takes no -m: the model rides session/set_config_option.
  spawnArgs: () => ["acp"],

  transformEnv: (env, config) => {
    env.OPENCODE_CONFIG_CONTENT = permissionEnv(env.OPENCODE_CONFIG_CONTENT, config.fullAuto);
  },

  // The only advertised method is {id:"opencode-login"}, whose own description
  // says to run a terminal command — it cannot be driven over ACP. Ride the
  // ambient login instead, exactly like kimi.
  pickAuthMethod: () => null,
  authFailure: "continue",

  // OpenCode runs with no login at all: a virgin HOME still lists the free
  // OpenCode Zen models, and they answer. So readiness is "is there anything
  // left to run", not "is there a credential file".
  isAuthenticated: async (env, config) =>
    ((await discoverCatalog(config.cli, env).catch(() => null))?.options.length ?? 0) > 0,

  loginNote: "OpenCode has no usable model — run `opencode auth login` to connect a provider",

  install: {
    // The vendor's primary installer, and it needs no Node. There is no
    // PowerShell one-liner (opencode.ai/install.ps1 is a 404), so Windows gets
    // npm, the only documented route that does not need another package
    // manager first. needsNode is deliberately unset: it is a whole-descriptor
    // flag and would show a false "Needs Node.js" under the curl commands.
    command: {
      darwin: "curl -fsSL https://opencode.ai/install | bash",
      linux: "curl -fsSL https://opencode.ai/install | bash",
      win32: "npm install -g opencode-ai",
    },
    docsUrl: "https://opencode.ai/docs/",
    signInCommand: "opencode auth login",
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const OpenCodeAgentDriver = createAcpDriver(support);
