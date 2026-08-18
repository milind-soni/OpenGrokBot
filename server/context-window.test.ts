import { describe, expect, it } from "vitest";

import { DEFAULT_CONTEXT_WINDOW } from "./context-rebuild.ts";
import { contextWindowFor } from "./context-window.ts";

describe("contextWindowFor", () => {
  it("prefers what the driver declared on the catalog entry", () => {
    const catalog = { default: "x", options: [{ id: "x", label: "X", contextWindow: 42_000 }] };
    expect(contextWindowFor("x", catalog)).toBe(42_000);
  });
  it("falls back to the pattern table, then a conservative default", () => {
    expect(contextWindowFor("claude-sonnet-5")).toBe(200_000);
    expect(contextWindowFor("gemini-3.6-flash")).toBe(1_000_000);
    expect(contextWindowFor("gpt-5.4")).toBe(200_000);
    expect(contextWindowFor("grok-4-fast")).toBe(256_000);
    expect(contextWindowFor("ollama/qwen3:8b")).toBe(32_000);
    expect(contextWindowFor("something-new")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});
