// Reasonix driver — `reasonix acp`, a full ACP v1 agent (NDJSON JSON-RPC 2.0
// over stdio). Rides the generic ACP runtime in acp/core.ts; this file is only
// the per-harness quirks.
//
// Auth is lenient (authFailure "continue"): the advertised method is the
// terminal `reasonix-setup` flow, which OpenMausBot cannot drive, so the turn
// proceeds on Reasonix's ambient login — the AI_GATEWAY_API_KEY seeded into
// ~/.reasonix/.env by the finix `reasonix` wrapper.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAcpDriver, type AcpSupport } from "./core.ts";

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

  // The one advertised auth method is terminal (launches `reasonix setup`); skip
  // authenticate and rely on the ambient ~/.reasonix/.env login.
  pickAuthMethod: (methods) =>
    methods.some((m) => m.id === "reasonix-setup") ? "reasonix-setup" : null,
  authFailure: "continue",
  isAuthenticated: (env) => {
    const stateHome = env.REASONIX_STATE_HOME || join(homedir(), ".reasonix");
    return existsSync(join(stateHome, ".env"));
  },
};

export const ReasonixDriver = createAcpDriver(support);
