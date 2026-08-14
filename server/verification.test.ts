import { describe, expect, it } from "vitest";
import { completionEvidence } from "./verification.ts";

describe("turn completion evidence", () => {
  it("reports exact successful evidence without claiming task verification", () => {
    expect(completionEvidence({ started: 1, succeeded: 1, failed: 0 }, true)).toEqual({
      name: "Evidence: 1 tool action succeeded; task result is agent-reported",
      ok: true,
    });
    expect(completionEvidence({ started: 1, succeeded: 1, failed: 0 }, false)).toEqual({
      name: "Evidence: 1 tool action succeeded; task result is agent-reported",
      ok: false,
    });
  });

  it("preserves complete mixed and failed counts when the turn fails", () => {
    expect(completionEvidence({ started: 2, succeeded: 1, failed: 1 }, true)).toEqual({
      name: "Evidence: 1 tool action succeeded, 1 failed",
      ok: false,
    });
    expect(completionEvidence({ started: 2, succeeded: 1, failed: 1 }, false)).toEqual({
      name: "Evidence: 1 tool action succeeded, 1 failed",
      ok: false,
    });
    expect(completionEvidence({ started: 1, succeeded: 0, failed: 1 }, false)).toEqual({
      name: "Evidence: 1 tool action failed",
      ok: false,
    });
  });

  it("does not add noise to purely conversational turns", () => expect(completionEvidence({ started: 0, succeeded: 0, failed: 0 }, true)).toBeNull());
});
