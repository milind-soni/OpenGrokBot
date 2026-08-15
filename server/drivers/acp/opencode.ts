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

type Env = Record<string, string | undefined>;

const CATALOG_TTL_MS = 60_000;
const CLI_TIMEOUT_MS = 20_000;

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
 *  everything that changes what opencode resolves. */
function cacheKey(cli: string, env: Env): string {
  return [cli, env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.OPENCODE_CONFIG, env.OPENCODE_CONFIG_DIR].join(
    " ",
  );
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
