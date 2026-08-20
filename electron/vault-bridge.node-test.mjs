// The vault fill bridge's trust boundary, off-Electron: real HTTP, a fake
// keystore-backed vault, a fill SINK that records what would be typed. The
// point is to prove the boundary — auth, loopback, origin/ambiguity refusal,
// approval flow — AND that a response body never carries a secret.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Vault } = require("./vault.cjs");
const { startVaultBridge, DESCRIPTOR } = require("./vault-bridge.cjs");

const fakeStore = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s) => Buffer.from(s, "utf8").toString("base64"),
  decryptStringAsync: async (b) => ({ result: Buffer.from(b.toString(), "base64").toString("utf8") }),
};

async function harness(seed = async () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-vbridge-"));
  const vault = new Vault({ file: join(dir, "vault.bin"), storage: fakeStore, touchId: async () => {} });
  await seed(vault);
  /** what was "typed" into the computer — the secret only ever reaches here */
  const sink = [];
  const bridge = await startVaultBridge({
    userData: dir,
    vault,
    fillIntoComputer: async (job) => {
      const value = job.field === "totp" ? "123456" : job.field === "username" ? job.entry.username : job.entry.secret;
      sink.push({ field: job.field, value, context: job.context, botId: job.botId });
    },
  });
  const { port, token } = JSON.parse(readFileSync(join(dir, DESCRIPTOR), "utf8"));
  const call = (body, auth = `Bearer ${token}`) =>
    fetch(`http://127.0.0.1:${port}/vault/fill`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });
  return { dir, vault, sink, port, token, call, stop: bridge.stop };
}

test("rejects a missing or wrong token, and a non-fill route", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call({}, "")).status, 401);
    assert.equal((await h.call({}, "Bearer nope")).status, 401);
    const bad = await fetch(`http://127.0.0.1:${h.port}/other`, { method: "POST", headers: { authorization: `Bearer ${h.token}` } });
    assert.equal(bad.status, 404);
  } finally {
    h.stop();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("no vault match → no-match, nothing typed", async () => {
  const h = await harness();
  try {
    const r = await (await h.call({ botId: "b", threadId: "t", origin: "accounts.google.com", field: "password" })).json();
    assert.equal(r.outcome, "no-match");
    assert.equal(h.sink.length, 0);
  } finally {
    h.stop();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("askEveryFill: first call needs approval (metadata only, no secret), the token then fills", async () => {
  const h = await harness(async (v) => {
    await v.upsert({ origin: "accounts.google.com", username: "me@gmail.com", secret: "hunter2", allowedBots: ["brody"], contexts: ["vm"], askEveryFill: true });
  });
  try {
    const first = await (await h.call({ botId: "brody", threadId: "t", origin: "https://accounts.google.com/signin", field: "password", context: "vm" })).json();
    assert.equal(first.outcome, "needs-approval");
    assert.equal(first.username, "me@gmail.com");
    assert.equal(first.origin, "https://accounts.google.com");
    // the needs-approval body carries NO secret
    assert.equal(JSON.stringify(first).includes("hunter2"), false);
    assert.equal(h.sink.length, 0);

    const done = await (await h.call({ approvalToken: first.approvalToken })).json();
    assert.equal(done.outcome, "filled");
    // the secret reached ONLY the fill sink
    assert.deepEqual(h.sink, [{ field: "password", value: "hunter2", context: "vm", botId: "brody" }]);
    assert.equal(JSON.stringify(done).includes("hunter2"), false);

    // the approval token is single-use
    assert.equal((await (await h.call({ approvalToken: first.approvalToken })).json()).outcome, "unavailable");
  } finally {
    h.stop();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("askEveryFill:false fills immediately; the response still has no secret", async () => {
  const h = await harness(async (v) => {
    await v.upsert({ origin: "example.com", username: "u", secret: "s3cr3t", allowedBots: [], contexts: ["vm"], askEveryFill: false });
  });
  try {
    const r = await (await h.call({ botId: "anyone", threadId: "t", origin: "example.com", field: "password", context: "vm" })).json();
    assert.equal(r.outcome, "filled");
    assert.equal(h.sink[0].value, "s3cr3t");
    assert.equal(JSON.stringify(r).includes("s3cr3t"), false);
  } finally {
    h.stop();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a lookalike origin never matches (anti-phishing), and ambiguity refuses", async () => {
  const h = await harness(async (v) => {
    await v.upsert({ origin: "accounts.google.com", username: "a", secret: "s1", askEveryFill: false });
    await v.upsert({ origin: "accounts.google.com", username: "b", secret: "s2", askEveryFill: false });
  });
  try {
    // phishing lookalike
    assert.equal((await (await h.call({ botId: "x", threadId: "t", origin: "https://accounts-google.com", field: "password" })).json()).outcome, "no-match");
    // two entries for the same origin: ambiguous → refuse, never guess
    const amb = await (await h.call({ botId: "x", threadId: "t", origin: "accounts.google.com", field: "password" })).json();
    assert.equal(amb.outcome, "no-match");
    assert.equal(amb.count, 2);
    assert.equal(h.sink.length, 0);
  } finally {
    h.stop();
    rmSync(h.dir, { recursive: true, force: true });
  }
});
