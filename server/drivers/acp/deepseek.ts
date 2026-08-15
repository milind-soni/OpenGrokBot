// DeepSeek Harness support — drives DeepSeek agents through the DeepSeek
// Harness (dsh) automation ACP server (Agent Client Protocol over JSON-RPC
// stdio). Unlike the CLI-based drivers, the "CLI" is the deepseek-acp
// launcher, which boots a built dsh checkout's ACP server and reads
// DEEPSEEK_API_KEY from ~/.dsh/.credentials.yaml (the same file `dsh web`
// uses) — no claude/codex/grok binary or login.
//
// The instance config points the driver at the launcher and checkout:
//   { "instances": { "deepseek": {
//       "driver": "deepseek",
//       "config": { "cli": "<repo>/server/drivers/acp/deepseek-acp.mjs",
//                   "workspace": "<agent cwd>" },
//       "environment": { "DSH_HOME": "<built dsh checkout>" } } } }
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAcpDriver, type AcpSupport } from "./core.ts";

function dshCredentialsPath(): string {
  return join(homedir(), ".dsh", ".credentials.yaml");
}

function hasCredentials(env: Record<string, string | undefined>): boolean {
  if (env.DEEPSEEK_API_KEY) return true;
  try {
    return (
      existsSync(dshCredentialsPath()) &&
      /^\s*DEEPSEEK_API_KEY:\s*\S/m.test(readFileSync(dshCredentialsPath(), "utf8"))
    );
  } catch {
    return false;
  }
}

const support: AcpSupport = {
  driverKind: "deepseek",
  displayName: "DeepSeek",
  models: {
    default: "deepseek-v4-pro",
    options: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    ],
  },
  defaultCli: "deepseek-acp",
  nativeSource: "deepseek.acp",
  loginNote:
    "DeepSeek Harness isn't configured — set DEEPSEEK_API_KEY in ~/.dsh/.credentials.yaml and DSH_HOME to a built dsh checkout",

  install: {
    command: {
      darwin:
        "git clone https://github.com/deepseek-ai/deepseek-harness.git ~/deepseek-harness && cd ~/deepseek-harness && pnpm install && pnpm run build",
      linux:
        "git clone https://github.com/deepseek-ai/deepseek-harness.git ~/deepseek-harness && cd ~/deepseek-harness && pnpm install && pnpm run build",
    },
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    needsNode: true,
  },

  // The DSH ACP server advertises no auth methods; the key rides the
  // launcher's environment, so auth is always ambient.
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: hasCredentials,

  // DSH ACP rejects non-empty mcpServers (session/new accepts only empty
  // additionalDirectories and mcpServers), so computer/agents tooling must
  // not be advertised for this driver.
  capabilities: { agentsMcp: false, computerMcp: false },

  // dsh's ACP server has no session/load, so every turn is a fresh session.
  // Replay the settled transcript inline (same shape as the grok API driver)
  // instead of relying on provider-side resume.
  buildPromptText: (turn) => {
    const parts: string[] = [];
    if (turn.system) parts.push(turn.system);
    for (const m of turn.transcript ?? []) {
      parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.text}`);
    }
    parts.push(`User: ${turn.text}`);
    return parts.join("\n\n");
  },

  spawnArgs: (_config, turn) => (turn.model ? ["--model", turn.model] : []),
};

export const DeepSeekDriver = createAcpDriver(support);
