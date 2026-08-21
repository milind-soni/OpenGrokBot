import { describe, expect, it } from "vitest";

import type { ModelCatalog } from "./contracts.ts";
import { modelSupportsTools, selectedModel } from "./models.ts";

const catalog: ModelCatalog = {
  default: { model: "model-a", effort: "high", serviceTier: null },
  options: [
    {
      id: "model-a",
      label: "Model A",
      efforts: ["low", "high"],
      serviceTiers: [{ id: "fast", label: "Fast" }],
      toolUse: false,
      provider: "provider-a",
    },
  ],
};

describe("selectedModel", () => {
  it("returns the exact catalog option for a supported selection", () => {
    expect(selectedModel({ instanceId: "test", model: "model-a", effort: "high", serviceTier: "fast" }, catalog))
      .toMatchObject({ id: "model-a", toolUse: false, provider: "provider-a" });
  });

  it("rejects a model that disappeared from the catalog", () => {
    expect(() => selectedModel({ instanceId: "test", model: "old-model" }, catalog)).toThrow(
      /model "old-model" is not available/,
    );
  });

  it("rejects unsupported effort and service tier values", () => {
    expect(() => selectedModel({ instanceId: "test", model: "model-a", effort: "max" }, catalog)).toThrow(
      /effort "max" is not supported/,
    );
    expect(() => selectedModel({ instanceId: "test", model: "model-a", serviceTier: "flex" }, catalog)).toThrow(
      /service tier "flex" is not supported/,
    );
  });

  it("blocks tools only when native model metadata explicitly disables them", () => {
    expect(modelSupportsTools(catalog.options[0])).toBe(false);
    expect(modelSupportsTools({ id: "unknown", label: "Unknown" })).toBe(true);
  });
});
