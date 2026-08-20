// The harness's side of the vault fill bridge. The secret lives in Electron
// main; this asks main to fill it and receives an OUTCOME only. There is no
// path here that could carry a secret — by construction, not by discipline.
//
// The {port, token} descriptor is written by main to userData/vault-bridge
// .json (the same shared-file pattern as cua-connection.json), so the
// standalone dev server and the packaged forked server both find it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type VaultFillOutcome =
  | { outcome: "filled" }
  | { outcome: "no-match"; count?: number }
  | { outcome: "needs-approval"; approvalToken: string; origin: string; username: string }
  | { outcome: "unavailable" };

export interface VaultFillRequest {
  botId: string;
  threadId: string;
  /** the browser's REAL origin, read by the harness — never the model's claim */
  origin: string;
  field: "username" | "password" | "totp";
  context: "vm" | "box";
  /** returned by a prior needs-approval, after the user approved the card */
  approvalToken?: string;
}

function descriptorCandidates(userData: string | undefined, home: string, platform: NodeJS.Platform): string[] {
  const out = userData ? [join(userData, "vault-bridge.json")] : [];
  if (platform === "darwin") {
    for (const dir of ["OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"]) {
      out.push(join(home, "Library", "Application Support", dir, "vault-bridge.json"));
    }
  }
  return [...new Set(out)];
}

export function readVaultBridge(opts: { userData?: string; home?: string; platform?: NodeJS.Platform } = {}): { port: number; token: string } | null {
  const userData = opts.userData ?? process.env.OMB_USER_DATA;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  for (const file of descriptorCandidates(userData, home, platform)) {
    try {
      const d = JSON.parse(readFileSync(file, "utf8"));
      if (typeof d?.port === "number" && typeof d?.token === "string") return { port: d.port, token: d.token };
    } catch {
      /* missing / stale — unavailable */
    }
  }
  return null;
}

/** Ask main to fill. `unavailable` when the bridge is absent (browser build,
 * or a main that predates the vault) — the caller treats it as "can't fill". */
export async function requestVaultFill(req: VaultFillRequest, fetchImpl: typeof fetch = fetch): Promise<VaultFillOutcome> {
  const bridge = readVaultBridge();
  if (!bridge) return { outcome: "unavailable" };
  try {
    const res = await fetchImpl(`http://127.0.0.1:${bridge.port}/vault/fill`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { outcome: "unavailable" };
    return (await res.json()) as VaultFillOutcome;
  } catch {
    return { outcome: "unavailable" };
  }
}
