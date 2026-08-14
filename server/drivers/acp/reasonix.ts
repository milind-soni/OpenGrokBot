// Reasonix driver — `reasonix acp`, a full ACP v1 agent (NDJSON JSON-RPC 2.0
// over stdio). Rides the generic ACP runtime in acp/core.ts; this file is only
// the per-harness quirks.
//
// Auth is lenient (authFailure "continue"): the only advertised method is the
// terminal `reasonix-setup` flow, which a GUI host cannot drive, so it is
// skipped entirely and the turn proceeds on Reasonix's ambient login —
// <Reasonix home>/.env (see CONFIG_PATHS.md upstream).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAcpDriver, type AcpSupport } from "./core.ts";

// Credentials live in <Reasonix home>/.env. REASONIX_HOME overrides;
// REASONIX_STATE_HOME only relocates runtime state (sessions/archives/
// memory), never provider credentials. Windows: %APPDATA%\reasonix.
export function reasonixHome(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  return (
    env.REASONIX_HOME ||
    (platform === "win32"
      ? join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "reasonix")
      : join(homedir(), ".reasonix"))
  );
}

// One KEY=value assignment with a non-empty value; `export` prefix and quoted
// values are accepted by Reasonix's own reader. Rejects empty, comment-only,
// and quoted-empty (`KEY=""`/`KEY=''`) assignments.
export function hasReasonixCredentials(content: string): boolean {
  return /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=[ \t]*["']?[^\s"'=]/m.test(content);
}

// True when <Reasonix home>/.env holds a non-empty credential.
export function isReasonixAuthenticated(env: Record<string, string | undefined>): boolean {
  try {
    return hasReasonixCredentials(readFileSync(join(reasonixHome(env), ".env"), "utf8"));
  } catch {
    return false;
  }
}

const support: AcpSupport = {
  driverKind: "reasonix",
  displayName: "Reasonix",
  models: {
    default: "deepseek-flash-0731",
    options: [
      { id: "deepseek-flash-0731", label: "DeepSeek Flash 0731" },
      { id: "deepseek-pro", label: "DeepSeek Pro (v4 0813)" },
    ],
  },
  defaultCli: "reasonix",
  nativeSource: "reasonix.acp",
  loginNote: "Reasonix not configured — run `reasonix setup` and add a provider key",

  // `--model` selects the startup model when the client does not override it;
  // OpenMausBot passes the picker model verbatim (provider name or provider/model).
  spawnArgs: (_config, turn) => ["acp", ...(turn.model ? ["--model", turn.model] : [])],

  // The one advertised auth method is terminal (launches `reasonix setup` in a
  // real terminal); OpenMausBot cannot drive it, so skip authenticate and rely
  // on the ambient <Reasonix home>/.env login. Returning the id would make
  // core.ts issue a useless terminal authenticate RPC.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: isReasonixAuthenticated,
};

export const ReasonixDriver = createAcpDriver(support);
