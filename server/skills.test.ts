import { describe, expect, it } from "vitest";
import { normalizeSkill, skillPrompt, skillSnapshot } from "./skills.ts";

describe("selective skills", () => {
  it("keeps content out of catalog snapshots", () => {
    const skill = normalizeSkill({ id: "write", name: "Writing", instructions: "Secret local guidance", description: "Write clearly" });
    expect(skillSnapshot(skill)).not.toHaveProperty("instructions");
  });
  it("loads only assigned, enabled skills", () => {
    const writing = normalizeSkill({ id: "write", name: "Writing", instructions: "Use short sentences" });
    const disabled = normalizeSkill({ id: "disabled", name: "Disabled", instructions: "Never show", enabled: false });
    expect(skillPrompt([writing, disabled], ["write", "disabled", "unknown"])).toContain("Use short sentences");
    expect(skillPrompt([writing, disabled], ["write", "disabled", "unknown"])).not.toContain("Never show");
    expect(skillPrompt([writing], [])).toBe("");
  });
  it("rejects incomplete skills", () => expect(() => normalizeSkill({ name: "Missing instructions" })).toThrow(/needs a name and instructions/));
});
