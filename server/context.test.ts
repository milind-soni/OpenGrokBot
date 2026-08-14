import { describe, expect, it } from "vitest";
import { CONTEXT_CHAR_BUDGET, packTranscript } from "./context.ts";

describe("packTranscript", () => {
  it("leaves short history byte-for-byte intact", () => {
    const source = [{ role: "user" as const, text: "Plan a trip" }, { role: "assistant" as const, text: "Where would you like to go?" }];
    expect(packTranscript(source)).toMatchObject({
      transcript: source,
      stats: { compacted: false, omittedMessages: 0, submittedChars: 38 },
    });
  });

  it("preserves original goal and recent exchange while compacting old history", () => {
    const source = [
      { role: "user" as const, text: "Build a release checklist for the Windows app." },
      ...Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? ("assistant" as const) : ("user" as const), text: `turn ${index}: ${"details ".repeat(180)}` })),
      { role: "user" as const, text: "Keep the final checklist concise and include signing." },
    ];
    const packed = packTranscript(source);
    expect(packed.stats).toMatchObject({ compacted: true, originalMessages: 32 });
    expect(packed.stats.submittedChars).toBeLessThanOrEqual(CONTEXT_CHAR_BUDGET);
    expect(packed.stats.submittedEstimatedTokens).toBeLessThan(packed.stats.originalEstimatedTokens);
    expect(packed.transcript[0].text).toContain("Build a release checklist");
    expect(packed.transcript.at(-1)?.text).toContain("include signing");
  });

  it("keeps an oversized original goal verbatim instead of clipping it", () => {
    const goal = `Keep this exact task definition. ${"important constraint ".repeat(900)}`;
    const packed = packTranscript([
      { role: "user", text: goal },
      { role: "assistant", text: "Acknowledged" },
      { role: "user", text: "And do not forget the release notes." },
    ], 1_000);

    expect(packed.transcript).toEqual([{ role: "user", text: goal }]);
    expect(packed.stats).toMatchObject({ compacted: true, omittedMessages: 2, submittedChars: goal.length });
  });
});
