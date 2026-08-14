import { describe, expect, it } from "vitest";

import { isAllowedSubframeNavigation, isTrustedExternalOpen } from "./navigation-policy.mjs";

describe("artifact subframe navigation policy", () => {
  it("allows only local opaque-document schemes", () => {
    expect(isAllowedSubframeNavigation("about:srcdoc")).toBe(true);
    expect(isAllowedSubframeNavigation("data:text/html,ok")).toBe(true);
    expect(isAllowedSubframeNavigation("blob:http://127.0.0.1/id")).toBe(true);
  });

  it.each([
    "https://attacker.example/collect",
    "http://127.0.0.1:11434/admin",
    "file:///etc/passwd",
    "javascript:location='https://attacker.example'",
  ])("blocks model-authored subframe navigation to %s", (url) => {
    expect(isAllowedSubframeNavigation(url)).toBe(false);
  });
});

describe("external window policy", () => {
  it("opens web links only when the app's top document supplied the referrer", () => {
    expect(isTrustedExternalOpen(
      "https://docs.example/page",
      "http://127.0.0.1:8799/chat",
      "http://127.0.0.1:8799/",
    )).toBe(true);
    expect(isTrustedExternalOpen(
      "https://attacker.example/collect?secret=x",
      "",
      "http://127.0.0.1:8799/",
    )).toBe(false);
    expect(isTrustedExternalOpen(
      "file:///etc/passwd",
      "http://127.0.0.1:8799/chat",
      "http://127.0.0.1:8799/",
    )).toBe(false);
  });
});
