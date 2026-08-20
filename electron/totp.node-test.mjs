import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { generateTotp } = require("./totp.cjs");

test("matches RFC 6238 SHA-1 test vectors", () => {
  // the RFC's canonical seed is ASCII "12345678901234567890" → base32:
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(generateTotp(seed, { now: 59_000, digits: 8 }), "94287082");
  assert.equal(generateTotp(seed, { now: 1111111109_000, digits: 8 }), "07081804");
});
test("6 digits by default, tolerates spaces in the seed", () => {
  const code = generateTotp("JBSW Y3DP EHPK 3PXP", { now: 0 });
  assert.match(code, /^\d{6}$/);
});
test("rejects a non-base32 seed", () => {
  assert.throws(() => generateTotp("not base 32 !!!"));
});
