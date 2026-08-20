// Pure vault logic, off-Electron: a fake keystore backend stands in for
// safeStorage so the security-relevant behaviour — metadata never carries a
// secret, and a fill only matches the right origin+bot+context — is tested
// without the Electron runtime.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Vault, normalizeOrigin } = require("./vault.cjs");

// a reversible "keystore": good enough to prove round-trips, not real crypto
const fakeStore = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s) => Buffer.from(s, "utf8").toString("base64"),
  decryptStringAsync: async (buf) => ({ result: Buffer.from(buf.toString(), "base64").toString("utf8") }),
};
const newVault = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-vault-"));
  const vault = new Vault({ file: join(dir, "vault.bin"), storage: fakeStore, touchId: async () => {} });
  return { vault, dir };
};

test("normalizeOrigin stores scheme+host, accepts bare host or full URL", () => {
  assert.equal(normalizeOrigin("accounts.google.com"), "https://accounts.google.com");
  assert.equal(normalizeOrigin("https://mail.google.com/mail/u/0/#inbox"), "https://mail.google.com");
  assert.equal(normalizeOrigin("HTTP://Example.com:8080/x"), "http://example.com:8080");
  assert.equal(normalizeOrigin("  "), "");
});

test("list() returns metadata and NEVER the secret or totp seed", async () => {
  const { vault, dir } = newVault();
  try {
    await vault.upsert({ origin: "accounts.google.com", username: "me@gmail.com", secret: "hunter2", totpSeed: "JBSW Y3DP", allowedBots: ["b1"], contexts: ["vm"] });
    const list = await vault.list();
    assert.equal(list.length, 1);
    const row = list[0];
    assert.equal(row.username, "me@gmail.com");
    assert.equal(row.origin, "https://accounts.google.com");
    assert.equal(row.hasTotp, true);
    // the wire shape carries no secret material at all
    assert.equal(JSON.stringify(row).includes("hunter2"), false);
    assert.equal(JSON.stringify(row).includes("JBSWY3DP"), false);
    assert.equal("secret" in row, false);
    assert.equal("totpSeed" in row, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matchForFill scopes by origin, allowed bot, and context", async () => {
  const { vault, dir } = newVault();
  try {
    await vault.upsert({ origin: "accounts.google.com", username: "me", secret: "s", allowedBots: ["brody"], contexts: ["vm"] });
    // right origin, right bot, right context → matches
    assert.equal((await vault.matchForFill({ origin: "https://accounts.google.com/signin", botId: "brody", context: "vm" })).length, 1);
    // wrong origin (a lookalike) → no match, the anti-phishing control
    assert.equal((await vault.matchForFill({ origin: "https://accounts-google.com", botId: "brody", context: "vm" })).length, 0);
    // wrong bot → no match
    assert.equal((await vault.matchForFill({ origin: "accounts.google.com", botId: "someone-else", context: "vm" })).length, 0);
    // wrong context (host is never allowed; only vm here) → no match
    assert.equal((await vault.matchForFill({ origin: "accounts.google.com", botId: "brody", context: "box" })).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty allowedBots means any bot; contexts default to vm+box", async () => {
  const { vault, dir } = newVault();
  try {
    await vault.upsert({ origin: "example.com", username: "u", secret: "s", allowedBots: [], contexts: [] });
    assert.equal((await vault.matchForFill({ origin: "example.com", botId: "anyone", context: "box" })).length, 1);
    assert.equal((await vault.matchForFill({ origin: "example.com", botId: "anyone", context: "vm" })).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit keeps the old secret when none is supplied; reveal returns it; remove deletes", async () => {
  const { vault, dir } = newVault();
  try {
    const { id } = await vault.upsert({ origin: "example.com", username: "u", secret: "s3cr3t" });
    await vault.upsert({ id, origin: "example.com", username: "u2", secret: "" }); // rename only
    const [row] = await vault.list();
    assert.equal(row.username, "u2");
    assert.equal((await vault.reveal(id)).secret, "s3cr3t");
    assert.equal((await vault.remove(id)).removed, true);
    assert.equal((await vault.list()).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("survives a reload — a new Vault over the same file reads it back", async () => {
  const { vault, dir } = newVault();
  try {
    await vault.upsert({ origin: "example.com", username: "u", secret: "s" });
    const again = new Vault({ file: join(dir, "vault.bin"), storage: fakeStore });
    assert.equal((await again.list()).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
