import { describe, expect, it } from "vitest";
import { normalizeTemplate, templateSnapshot } from "./templates.ts";

describe("task templates", () => {
  it("validates, owns IDs, and hides instructions from catalogs", () => {
    const item = normalizeTemplate({ id: "not/route-safe", name: "Research", instructions: "Find sources" });
    expect(item.id).not.toBe("not/route-safe");
    expect(templateSnapshot(item)).not.toHaveProperty("instructions");
  });

  it("rejects incomplete input", () => expect(() => normalizeTemplate({ name: "x" })).toThrow(/needs a name/));
});
