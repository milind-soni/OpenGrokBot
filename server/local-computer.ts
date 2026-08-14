import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LocalComputerConnection = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

type ConnectionDescriptor = {
  mode?: string;
  mcpCommand?: unknown;
  mcpArgs?: unknown;
  mcpEnv?: unknown;
};

function decodeDescriptor(value: ConnectionDescriptor): LocalComputerConnection | null {
  if (!value || value.mode === "unavailable" || typeof value.mcpCommand !== "string") return null;
  if (value.mcpArgs !== undefined && !Array.isArray(value.mcpArgs)) return null;
  if (
    value.mcpEnv !== undefined &&
    (!value.mcpEnv || typeof value.mcpEnv !== "object" || Array.isArray(value.mcpEnv))
  ) {
    return null;
  }

  const args = value.mcpArgs ?? ["mcp"];
  if (!args.every((arg) => typeof arg === "string")) return null;

  const env = value.mcpEnv ?? {};
  if (!Object.values(env).every((entry) => typeof entry === "string")) return null;

  return {
    command: value.mcpCommand,
    args,
    env: env as Record<string, string>,
  };
}

export function readCuaConnection({
  platform = process.platform,
  userData = process.env.OMB_USER_DATA,
  home = homedir(),
}: {
  platform?: NodeJS.Platform;
  userData?: string;
  home?: string;
} = {}): LocalComputerConnection | null {
  // Linux local automation is deliberately outside the Ubuntu baseline.
  // Ignore even a forged or stale descriptor until the CUA follow-up adds
  // session-aware readiness and end-to-end evidence.
  if (platform === "linux") return null;

  const candidates = userData ? [join(userData, "cua-connection.json")] : [];
  if (platform === "darwin") {
    // Legacy/dev fallback. Packaged Electron passes its exact userData path.
    for (const dir of ["OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"]) {
      candidates.push(join(home, "Library", "Application Support", dir, "cua-connection.json"));
    }
  }

  for (const file of [...new Set(candidates)]) {
    try {
      const decoded = decodeDescriptor(JSON.parse(readFileSync(file, "utf8")));
      if (decoded) return decoded;
    } catch {
      // Missing, invalid, or stale descriptors are simply unavailable.
    }
  }
  return null;
}
