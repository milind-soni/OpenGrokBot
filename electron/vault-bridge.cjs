// The vault fill bridge — the trust boundary for Phase 1b.
//
// The secret lives in Electron main and must NEVER reach the harness server
// or the model. But the server is what drives the VM and knows when a bot
// wants to sign in. So the direction is: the server REQUESTS a fill over a
// loopback endpoint main owns; main validates, decrypts, types into the
// isolated computer, and answers with an OUTCOME only. A secret is never in
// a response body, so the channel cannot leak one even if misused.
//
// Auth mirrors the harness's own /api/internal guard: a random token +
// loopback-only bind. The {port, token} descriptor is written to a 0600 file
// in the shared userData dir (like cua-connection.json), so the standalone
// dev server and the packaged forked server both find it the same way.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DESCRIPTOR = "vault-bridge.json";
const APPROVAL_TTL_MS = 5 * 60_000;

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a ?? "");
  const bb = Buffer.from(b ?? "");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * @param {{
 *   userData: string,
 *   vault: import("./vault.cjs").Vault,
 *   log?: (m: string) => void,
 *   fillIntoComputer: (job: { entry: any, field: "username"|"password"|"totp", context: "vm"|"box", threadId: string, botId: string }) => Promise<void>,
 *   readOrigin?: (ctx: { context: "vm"|"box", threadId: string }) => Promise<string>,
 *   totp?: (seed: string) => string,
 * }} deps
 */
function startVaultBridge(deps) {
  const log = deps.log ?? (() => {});
  const token = crypto.randomBytes(24).toString("hex");
  // approvalToken -> { entryId, field, context, botId, threadId, at }
  const pendingApprovals = new Map();

  const gc = () => {
    const now = Date.now();
    for (const [k, v] of pendingApprovals) if (now - v.at > APPROVAL_TTL_MS) pendingApprovals.delete(k);
  };

  /** Do the fill for a validated match. Returns an outcome, never a secret. */
  const doFill = async (entry, field, context, botId, threadId) => {
    if (field === "totp") {
      if (!entry.totpSeed) return { outcome: "no-match" };
    }
    await deps.fillIntoComputer({ entry, field, context, threadId, botId });
    await deps.vault.markUsed(entry.id);
    return { outcome: "filled" };
  };

  const handleFill = async (body) => {
    gc();
    const botId = String(body?.botId ?? "");
    const threadId = String(body?.threadId ?? "");
    const origin = String(body?.origin ?? "");
    const field = body?.field === "username" || body?.field === "totp" ? body.field : "password";
    const context = body?.context === "box" ? "box" : "vm";

    // an approval token from a prior needs-approval → validate and fill
    if (body?.approvalToken) {
      const pending = pendingApprovals.get(String(body.approvalToken));
      pendingApprovals.delete(String(body.approvalToken));
      if (!pending || Date.now() - pending.at > APPROVAL_TTL_MS) return { outcome: "unavailable" };
      const entry = (await deps.vault.matchForFill({ origin: pending.origin, botId: pending.botId, context: pending.context })).find((e) => e.id === pending.entryId);
      if (!entry) return { outcome: "no-match" };
      return doFill(entry, pending.field, pending.context, pending.botId, pending.threadId);
    }

    // main reads the REAL origin itself when it can, so a compromised
    // server cannot steer the match; the body origin is only a fallback for
    // callers (and tests) without a live browser.
    let realOrigin = origin;
    if (deps.readOrigin) {
      try {
        realOrigin = await deps.readOrigin({ context, threadId });
      } catch (err) {
        log(`vault fill: could not read origin: ${err?.message ?? err}`);
        return { outcome: "no-match", reason: "no-origin" };
      }
    }
    const matches = await deps.vault.matchForFill({ origin: realOrigin, botId, context });
    // zero, or ambiguous (more than one for the same origin+bot) → refuse.
    // Ambiguity must never resolve to "guess one"; the user disambiguates.
    if (matches.length !== 1) return { outcome: "no-match", count: matches.length };
    const entry = matches[0];

    if (entry.askEveryFill !== false) {
      const approvalToken = crypto.randomBytes(18).toString("hex");
      pendingApprovals.set(approvalToken, { entryId: entry.id, field, context, botId, threadId, origin: realOrigin, at: Date.now() });
      // metadata only — the card the harness raises shows who/where, never the secret
      return { outcome: "needs-approval", approvalToken, origin: entry.origin, username: entry.username };
    }
    return doFill(entry, field, context, botId, threadId);
  };

  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // loopback-only, even though we bind to 127.0.0.1: defence in depth
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") return send(403, { error: "forbidden" });
    if (!timingSafeEqual(req.headers.authorization ?? "", `Bearer ${token}`)) return send(401, { error: "unauthorized" });
    if (req.method !== "POST" || req.url !== "/vault/fill") return send(404, { error: "not found" });
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 8192) req.destroy();
    });
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return send(400, { error: "bad json" });
      }
      handleFill(body)
        .then((outcome) => send(200, outcome))
        .catch((err) => {
          log(`vault fill failed: ${err?.message ?? err}`);
          send(200, { outcome: "unavailable" });
        });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const file = path.join(deps.userData, DESCRIPTOR);
      try {
        fs.writeFileSync(file, JSON.stringify({ port, token }), { mode: 0o600 });
      } catch (err) {
        log(`vault bridge descriptor write failed: ${err?.message ?? err}`);
      }
      log(`vault bridge on 127.0.0.1:${port}`);
      resolve({
        port,
        stop: () => {
          try {
            fs.unlinkSync(file);
          } catch {}
          server.close();
        },
      });
    });
  });
}

module.exports = { startVaultBridge, DESCRIPTOR };
