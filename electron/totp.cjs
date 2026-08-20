// RFC 6238 TOTP, dependency-free, main-side. The seed never leaves main;
// this turns it into the 6-digit code that is typed into the computer.
const crypto = require("node:crypto");

/** Decode a base32 (RFC 4648) secret, ignoring spaces and padding. */
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input).toUpperCase().replace(/[\s=]/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 in TOTP seed");
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** @param {string} seed base32 secret @param {{ now?: number, digits?: number, period?: number }} [opts] */
function generateTotp(seed, opts = {}) {
  const digits = opts.digits ?? 6;
  const period = opts.period ?? 30;
  const counter = Math.floor((opts.now ?? Date.now()) / 1000 / period);
  const key = base32Decode(seed);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

module.exports = { generateTotp, base32Decode };
