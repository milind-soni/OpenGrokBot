import { describe, expect, it } from "vitest";

import { score } from "../src/lib/search.ts";

describe("score", () => {
  it("keeps literal matches positive even at large offsets", () => {
    expect(score(`${"x".repeat(1_000)}needle`, "needle")).toBeGreaterThan(0);
    expect(score(`${"word ".repeat(1_000)}needle`, "needle")).toBeGreaterThan(0);
  });

  it("preserves match-kind ordering after bounding positional penalties", () => {
    const exact = score("needle", "needle");
    const prefix = score(`needle${"x".repeat(1_000)}`, "needle");
    const wordStart = score(`${"word ".repeat(1_000)}needle`, "needle");
    const substring = score(`${"x".repeat(1_000)}needle`, "needle");
    const subsequence = score("n-x-e-x-e-x-d-x-l-x-e", "needle");

    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
  });
});
