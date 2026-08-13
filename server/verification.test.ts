import { describe, expect, it } from "vitest";
import { completionEvidence } from "./verification.ts";
describe("turn completion evidence", () => {
  it("does not call tool success task verification", () => expect(completionEvidence({ started: 1, succeeded: 1, failed: 0 }, true)?.name).toContain("task result is agent-reported"));
  it("reports mixed and failed evidence as failures", () => {
    expect(completionEvidence({ started: 2, succeeded: 1, failed: 1 }, true)).toMatchObject({ ok: false });
    expect(completionEvidence({ started: 1, succeeded: 0, failed: 1 }, false)).toMatchObject({ ok: false });
  });
  it("does not add noise to purely conversational turns", () => expect(completionEvidence({ started: 0, succeeded: 0, failed: 0 }, true)).toBeNull());
});
