import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readVaultBridge, requestVaultFill } from "./vault-client.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "omb-vaultclient-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readVaultBridge", () => {
  it("reads a valid descriptor and rejects a malformed one", () => {
    const d = tmp();
    writeFileSync(join(d, "vault-bridge.json"), JSON.stringify({ port: 51234, token: "abc" }));
    expect(readVaultBridge({ userData: d, platform: "linux" })).toEqual({ port: 51234, token: "abc" });
    writeFileSync(join(d, "vault-bridge.json"), "{not json");
    expect(readVaultBridge({ userData: d, platform: "linux" })).toBeNull();
    expect(readVaultBridge({ userData: tmp(), platform: "linux" })).toBeNull();
  });
});

describe("requestVaultFill", () => {
  it("is unavailable when no bridge descriptor exists", async () => {
    const prev = process.env.OMB_USER_DATA;
    process.env.OMB_USER_DATA = tmp();
    try {
      expect(await requestVaultFill({ botId: "b", threadId: "t", origin: "x", field: "password", context: "vm" })).toEqual({ outcome: "unavailable" });
    } finally {
      if (prev === undefined) delete process.env.OMB_USER_DATA;
      else process.env.OMB_USER_DATA = prev;
    }
  });

  it("carries the request to the bridge and returns its outcome verbatim", async () => {
    const d = tmp();
    writeFileSync(join(d, "vault-bridge.json"), JSON.stringify({ port: 9, token: "tok" }));
    const prev = process.env.OMB_USER_DATA;
    process.env.OMB_USER_DATA = d;
    let seen: { url: string; auth: string | null; body: any } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), auth: (init.headers as Record<string, string>).authorization ?? null, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ outcome: "needs-approval", approvalToken: "a1", origin: "https://accounts.google.com", username: "me" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const out = await requestVaultFill({ botId: "brody", threadId: "t1", origin: "accounts.google.com", field: "password", context: "vm" }, fakeFetch);
      expect(out).toEqual({ outcome: "needs-approval", approvalToken: "a1", origin: "https://accounts.google.com", username: "me" });
      expect(seen!.url).toBe("http://127.0.0.1:9/vault/fill");
      expect(seen!.auth).toBe("Bearer tok");
      expect(seen!.body).toMatchObject({ botId: "brody", origin: "accounts.google.com", field: "password" });
    } finally {
      if (prev === undefined) delete process.env.OMB_USER_DATA;
      else process.env.OMB_USER_DATA = prev;
    }
  });
});
