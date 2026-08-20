// The credential vault — Phase 1a of the bot vault design.
//
// Secrets a bot may sign in WITH live here, in Electron main, encrypted at
// rest by the OS keystore (safeStorage → macOS Keychain / Windows DPAPI /
// Linux libsecret). They never leave this process as plaintext except when
// TYPED into an isolated computer during a blind fill (Phase 1b) — never to
// the harness server, never to the model, never into a tool argument or
// transcript. This module owns only storage and the metadata the UI needs;
// the fill itself is main-side too (a later phase) so a secret never crosses
// the process boundary to the server.
//
// The vault file is separate from credentials.bin (API keys): different
// lifetime, different blast radius, and a corrupt vault must not take the
// app's own keys down with it.
const { safeStorage, systemPreferences } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** @typedef {{ id: string, origin: string, username: string, secret: string,
 *   totpSeed?: string, allowedBots: string[], contexts: ("vm"|"box")[],
 *   askEveryFill: boolean, createdAt: number, updatedAt: number,
 *   lastUsedAt?: number }} VaultEntry */

function normalizeOrigin(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    // accept a bare host or a full URL; store the ORIGIN (scheme+host[+port])
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.origin.toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

class Vault {
  /** @param {{ file: string, log?: (m: string) => void, storage?: any, touchId?: (reason: string) => Promise<void> }} opts */
  constructor(opts) {
    this.file = opts.file;
    this.log = opts.log ?? (() => {});
    // injectable so the security-relevant logic is testable off-Electron;
    // in the app it is the OS keystore
    this.storage = opts.storage ?? safeStorage;
    this.touchId = opts.touchId;
    /** @type {VaultEntry[]} */
    this.entries = [];
    this.loaded = false;
  }

  async #load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.file) || !(await this.storage.isAsyncEncryptionAvailable())) return;
      const decrypted = await this.storage.decryptStringAsync(fs.readFileSync(this.file));
      const parsed = JSON.parse(decrypted.result);
      if (Array.isArray(parsed)) this.entries = parsed;
    } catch (error) {
      this.log(`vault load failed: ${error?.message ?? error}`);
    }
  }

  async #save() {
    if (!(await this.storage.isAsyncEncryptionAvailable())) {
      throw new Error("The operating-system credential store is unavailable, so the vault cannot be saved securely.");
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const encrypted = await this.storage.encryptStringAsync(JSON.stringify(this.entries));
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Metadata only — never a secret. Safe to hand to the renderer. */
  async list() {
    await this.#load();
    return this.entries.map((e) => ({
      id: e.id,
      origin: e.origin,
      username: e.username,
      hasTotp: Boolean(e.totpSeed),
      allowedBots: e.allowedBots ?? [],
      contexts: e.contexts ?? ["vm", "box"],
      askEveryFill: e.askEveryFill !== false,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      lastUsedAt: e.lastUsedAt,
    }));
  }

  /** Add or replace an entry. `input.secret` empty on an edit keeps the old one. */
  async upsert(input) {
    await this.#load();
    const origin = normalizeOrigin(input.origin);
    if (!origin) throw new Error("A site (origin) is required.");
    const username = String(input.username ?? "").trim();
    const now = Date.now();
    const existing = input.id ? this.entries.find((e) => e.id === input.id) : undefined;
    const secret = typeof input.secret === "string" && input.secret !== "" ? input.secret : existing?.secret;
    if (!secret) throw new Error("A password is required.");
    /** @type {VaultEntry} */
    const entry = {
      id: existing?.id ?? crypto.randomUUID(),
      origin,
      username,
      secret,
      totpSeed: typeof input.totpSeed === "string" && input.totpSeed.trim() ? input.totpSeed.replace(/\s+/g, "").toUpperCase() : existing?.totpSeed,
      allowedBots: Array.isArray(input.allowedBots) ? input.allowedBots.filter((b) => typeof b === "string") : (existing?.allowedBots ?? []),
      contexts: Array.isArray(input.contexts) && input.contexts.length ? input.contexts.filter((c) => c === "vm" || c === "box") : (existing?.contexts ?? ["vm", "box"]),
      askEveryFill: input.askEveryFill !== false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt,
    };
    if (existing) this.entries = this.entries.map((e) => (e.id === existing.id ? entry : e));
    else this.entries.unshift(entry);
    await this.#save();
    return { id: entry.id };
  }

  async remove(id) {
    await this.#load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) await this.#save();
    return { removed: before !== this.entries.length };
  }

  /** Reveal one secret to the USER, gated by an OS auth prompt where the
   * platform offers one (Touch ID). Never used by the fill path — the model
   * side is blind; this exists only so a person can check what they stored. */
  async reveal(id) {
    await this.#load();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error("No such entry.");
    const prompt = this.touchId ?? ((reason) =>
      process.platform === "darwin" && systemPreferences.canPromptTouchID?.()
        ? systemPreferences.promptTouchID(reason)
        : Promise.resolve());
    try {
      await prompt("reveal a stored password");
    } catch {
      throw new Error("Authentication was cancelled.");
    }
    return { secret: entry.secret, totpSeed: entry.totpSeed ?? null };
  }

  /** For the fill path (Phase 1b, main-side): the entries whose origin
   * matches AND that allow this bot in this context. Returns FULL entries —
   * callers must be in Electron main and must never forward the secret. */
  async matchForFill({ origin, botId, context }) {
    await this.#load();
    const want = normalizeOrigin(origin);
    return this.entries.filter(
      (e) =>
        e.origin === want &&
        (e.allowedBots.length === 0 || e.allowedBots.includes(botId)) &&
        (e.contexts ?? ["vm", "box"]).includes(context),
    );
  }

  async markUsed(id) {
    await this.#load();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.lastUsedAt = Date.now();
    await this.#save();
  }
}

/** @param {{ userData: string, log?: (m: string) => void }} opts */
function createVault(opts) {
  return new Vault({ file: path.join(opts.userData, "vault.bin"), log: opts.log });
}

module.exports = { createVault, normalizeOrigin, Vault };
