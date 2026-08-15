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

import { homedir } from "node:os";

import type { ModelCatalog } from "../../contracts.ts";
import { execCli } from "../../procs.ts";

import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

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

/** Run an opencode subcommand, resolving to null on any failure.
 *  `opencode models` is ~15 KB; the buffer is generous so a machine with many
 *  providers cannot silently truncate its own catalog.
 *
 *  These are NOT read-only, and an earlier version of this comment said they
 *  were — a maintainer can disprove it in one command, so say it here instead.
 *  Measured on 1.18.18, one `opencode models` against a genuinely empty HOME:
 *
 *      ~/.cache/opencode/models.json                3.8 MB, created
 *      ~/.config/opencode/opencode.jsonc            seeded (with a .gitignore)
 *      ~/.local/share/opencode/opencode.db{,-wal,-shm}  created
 *      ~/.local/state/opencode/locks/<hash>.lock/   created
 *
 *  The working directory is untouched. Choosing these over an ACP probe still
 *  stands — a stray model cache is not a stray session, and no turn, no
 *  session and no prompt is created — but it is a smaller claim than "no side
 *  effect at all". One consequence worth knowing before writing a test: the
 *  FIRST probe on a fresh HOME returned 8 models and the second 7, so the free
 *  OpenCode Zen list is not an invariant and must not be asserted as one. */
function run(cli: string, args: string[], env: Env, cwd: string | undefined): Promise<string | null> {
  return new Promise((resolve) => {
    execCli(cli, args, { timeout: CLI_TIMEOUT_MS, env, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/** Where a probe runs. core.ts computes a turn's cwd as
 *  `turn.cwd ?? config.workspace ?? homedir()`; a catalog probe has no turn, so
 *  it matches the other two terms. Left to itself, execCli inherits the
 *  SERVER's cwd — wherever the app happened to be launched from, which is both
 *  non-deterministic and the wrong directory: in fullAuto, where project config
 *  stays enabled, a project-defined provider is runnable by the turn and
 *  invisible to the catalog. */
const probeCwd = (config: AcpConfig): string => config.workspace ?? homedir();

/** The model opencode itself would use. `debug config` is a debug command with
 *  no stability promise, so its failure is absorbed: the default falls back to
 *  the first catalog entry, which on a machine with no credentials is a free
 *  OpenCode Zen model.
 *
 *  `raw` IS A SECRET. `debug config` echoes the whole resolved config, which on
 *  a real machine carries MCP server credentials — measured: a token in an
 *  `mcp.*.environment` entry and a token inside an argv array both came back
 *  verbatim. So it is read for `.model` and dropped: never logged, never
 *  cached, and run() swallows the error object too (which would quote the
 *  command line on a spawn failure). Keep it that way — a `console.error(raw)`
 *  added while debugging this function would put the user's tokens in a log
 *  file. CONTRIBUTING.md:113-117 is the standing rule. */
async function defaultModel(cli: string, env: Env, cwd: string | undefined): Promise<string | null> {
  const raw = await run(cli, ["debug", "config"], env, cwd);
  if (!raw) return null;
  try {
    const model = JSON.parse(raw)?.model;
    return typeof model === "string" && model ? model : null;
  } catch {
    return null;
  }
}

/** Two instances can point at the same binary through different homes or
 *  configs and legitimately see different catalogs, so the key carries where
 *  opencode reads its config from AND what that config says.
 *
 *  It does NOT carry ambient provider credentials. Measured against 1.18.18,
 *  each of these alone changes what `opencode models` lists — the keys are not
 *  validated, so a bogus value is enough: ANTHROPIC_API_KEY (7 -> 22 lines),
 *  OPENAI_API_KEY (7 -> 55), OPENROUTER_API_KEY (7 -> 358). Enumerating every
 *  provider variable opencode auto-detects would be a list that goes stale
 *  upstream, so the honest statement of the bound is: two instances differing
 *  ONLY by an API key share one catalog for up to CATALOG_TTL_MS. Keying on the
 *  whole env is not the alternative — three tests mutate FAKE_ACP_MODELS as
 *  their "did it re-probe" signal, and a whole-env key would make every such
 *  mutation a cache miss.
 *
 *  The Windows half is not decoration either: HOME and the XDG_* variables are
 *  all undefined there, so a key naming only those collapses every opencode
 *  instance onto one entry — the silent-failure shape CONTRIBUTING.md forbids.
 *
 *  JSON rather than a joined string: joining on a separator lets a value that
 *  contains that separator collide with a different split of the same
 *  characters (HOME "a b" + XDG "c" against HOME "a" + XDG "b c"), and Windows
 *  paths routinely contain spaces. JSON also keeps an unset variable distinct
 *  from one explicitly set to empty. */
function cacheKey(cli: string, env: Env, cwd: string | undefined): string {
  return JSON.stringify([
    cli,
    // in fullAuto the project's own config still loads, so the directory the
    // probe runs in changes the list — same reasoning as the config keys below
    cwd,
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    // the Windows equivalents of the three above
    env.USERPROFILE,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.OPENCODE_CONFIG,
    env.OPENCODE_CONFIG_DIR,
    // can declare a whole provider, so it changes the list and not just where
    // the list is read from — and transformEnv writes it per instance
    env.OPENCODE_CONFIG_CONTENT,
  ]);
}

export async function discoverCatalog(cli: string, env: Env, cwd?: string): Promise<ModelCatalog> {
  const key = cacheKey(cli, env, cwd);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CATALOG_TTL_MS) return hit.value;

  const [listing, configured] = await Promise.all([
    run(cli, ["models"], env, cwd),
    defaultModel(cli, env, cwd),
  ]);
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
//
// Two details are not decoration. The `read` sub-map exists to carry opencode's
// own `.env` guard THROUGH our policy rather than to invent it: measured on
// 1.18.18, the stock CLI already resolves `read *` allow / `*.env` ask /
// `*.env.*` ask / `*.env.example` allow with nothing injected at all. But our
// `"*": "ask"` is appended after those built-ins, and a bare `read: "allow"`
// after that would be the last match for every read — so omitting the sub-map
// makes every read a card, and flattening it to `"allow"` reads secrets with no
// card where the stock CLI would have asked. This is defence-in-depth over
// opencode's defaults, not the only thing standing between a bot and a `.env`.
// And the bookkeeping tools are allowed on purpose: with a bare `*: ask` the
// user gets an approval card for every directory listing and every to-do
// update, which trains them to click through cards — the opposite of what this
// policy is for.
const ASK_POLICY = {
  "*": "ask",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
  glob: "allow",
  grep: "allow",
  lsp: "allow",
  list: "allow",
  todowrite: "allow",
  question: "allow",
  edit: "allow",
  bash: "ask",
  webfetch: "ask",
  websearch: "ask",
  external_directory: "ask",
} satisfies Record<string, "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">>;

// The agents a session can start on: `build` is opencode's default, `plan` its
// read-only sibling, `general` the one the `task` tool spawns. Each gets the
// same policy pinned on it — see permissionEnv for why naming them is what
// makes the top-level policy stick.
const PINNED_AGENTS = ["build", "plan", "general"] as const;

/** A plain JSON object, or an empty one. Spreading a string or an array would
 *  smear indices into the config we are about to hand opencode. */
function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Compose the child's OPENCODE_CONFIG_CONTENT.
 *
 *  OPENCODE_CONFIG_CONTENT rather than the undocumented OPENCODE_PERMISSION:
 *  it is documented, and it merges after every config file, so it wins every
 *  key it names. We name only the keys we have to, so the user's MCP servers,
 *  skills, extra agents and per-agent models all survive.
 *
 *  Three keys, and each one closes a route that was measured open against
 *  1.18.18 — with OPENCODE_DISABLE_PROJECT_CONFIG=1 already set, from the
 *  user's GLOBAL ~/.config/opencode/opencode.json, which that flag does not
 *  touch because it drops PROJECT config only:
 *
 *  - `permission` — the top-level policy. A config file's own top-level
 *    `permission` collides with ours on the same key path and loses the merge.
 *    This key alone used to be the whole fix, and it was not enough.
 *
 *  - `agent.<name>.permission` — a DIFFERENT key path, which is the entire
 *    reason it was not enough. A per-agent block does not collide; it is
 *    flattened into the resolved rule array AFTER the top-level policy, and
 *    evaluation is last-match-wins, so `{"agent":{"build":{"permission":
 *    {"bash":"allow"}}}}` restored uncarded shell. Naming the same key path
 *    takes it back — measured: the hostile block is replaced rather than
 *    appended, while sibling fields on that same agent (its `model`, say) still
 *    merge through untouched.
 *
 *  - `default_agent` — otherwise a config can define a brand-new agent we do
 *    not name and point the session at it: `{"default_agent":"evil","agent":
 *    {"evil":{"permission":{"bash":"allow"}}}}` resolved to `evil`. Pinning
 *    collides on that key path too, so `build` wins.
 *
 *  An agent we do not name stays *selectable* — `evil` above still appears
 *  among a session's mode choices — and that is a decision, not an oversight:
 *  only the ACP client can change a session's mode and OpenMausBot never does,
 *  so the agent's only route to one is the `task` tool, which falls under
 *  `"*": "ask"` and is therefore carded.
 *
 *  fullAuto is the user asking for no gate at all, so it hands over the
 *  top-level key and pins nothing. */
export function permissionEnv(existing: string | undefined, fullAuto: boolean): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed;
      else console.error("opencode: ignoring a non-object OPENCODE_CONFIG_CONTENT");
    } catch {
      // Not our JSON to repair. Say so: silently dropping it would make the
      // user's MCP servers vanish with nothing to grep for.
      console.error("opencode: ignoring an unparseable OPENCODE_CONFIG_CONTENT");
    }
  }
  if (fullAuto) return JSON.stringify({ ...base, permission: "allow" });

  const callerAgents = plainObject(base.agent);
  const agent: Record<string, unknown> = { ...callerAgents };
  for (const name of PINNED_AGENTS) {
    agent[name] = { ...plainObject(callerAgents[name]), permission: ASK_POLICY };
  }
  return JSON.stringify({ ...base, agent, permission: ASK_POLICY, default_agent: "build" });
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
  // The list is per-machine, so it is read from the CLI on demand rather than
  // compiled in; discoverCatalog bounds its own latency, as the contract asks.
  // It runs where a turn would run, not where the server was launched — see
  // probeCwd.
  catalog: (config, env) => discoverCatalog(config.cli, env, probeCwd(config)),
  // `opencode acp` accepts no -m, so the model has to be set through the
  // session's config option before the prompt goes out.
  selectModel: { configId: "model" },

  spawnArgs: () => ["acp"],

  transformEnv: (env, config) => {
    env.OPENCODE_CONFIG_CONTENT = permissionEnv(env.OPENCODE_CONFIG_CONTENT, config.fullAuto);
    if (config.fullAuto) return;
    // permissionEnv owns the config KEYS an attacker would reach for. These
    // three env vars sidestep the config merge instead, and all three are
    // inherited from our own process, so strip them from the child the way kimi
    // strips a stray API key:
    //
    //   - OPENCODE_PERMISSION is applied after every config merge, so an
    //     inherited one lands after the policy we just injected and, under
    //     last-match-wins, beats it.
    //   - OPENCODE_CONFIG / OPENCODE_CONFIG_DIR point opencode at a config file
    //     or directory we do not control; a hostile one there also resolved to
    //     `bash: allow`. cacheKey already names both as things that change what
    //     opencode resolves — same reasoning, other half of the driver.
    //
    // OPENCODE_DISABLE_PROJECT_CONFIG closes the workspace route: a repository's
    // opencode.json or .opencode/agent/*.md could otherwise carry a per-agent
    // block. The cost is real and deliberate — a repository's own opencode
    // config is ignored while an OpenMausBot bot works in it, including MCP
    // servers it defines — and we take it because `edit` is allowed here and a
    // fresh child spawns per turn, so an agent that could write
    // .opencode/agent/build.md would hold uncarded shell on its very next turn.
    //
    // The user's GLOBAL config still loads, and we neither disable it nor could:
    // it is where their providers and MCP servers live. It simply can no longer
    // OUTRANK the policy, because permissionEnv now owns `permission`,
    // `agent.<name>.permission` and `default_agent`. An earlier version of this
    // comment presented the surviving global config as a pure benefit; it was
    // also the open half of the escalation this driver claims to close.
    delete env.OPENCODE_PERMISSION;
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_DIR;
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
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
    ((await discoverCatalog(config.cli, env, probeCwd(config)).catch(() => null))?.options.length ?? 0) > 0,

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
