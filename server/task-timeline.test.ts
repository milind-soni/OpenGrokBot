import { describe, expect, it } from "vitest";
import { timelineEvents } from "../src/lib/taskTimeline.ts";

describe("execution timeline", () => {
  it("derives only persisted, observable events and preserves failures", () => {
    const events = timelineEvents([
      { id: "start", role: "user", kind: "text", text: "Research this", at: 1 },
      { id: "tool", role: "bot", kind: "activity", tool: { name: "browser.search", ok: true }, at: 2 },
      { id: "screen", role: "bot", kind: "screen", png: "x", at: 3 },
      { id: "failure", role: "bot", kind: "activity", tool: { name: "error: blocked", ok: false }, at: 4 },
      { id: "response", role: "bot", kind: "text", text: "I could not complete it.", at: 5 },
    ]);
    expect(events).toMatchObject([
      { kind: "task", state: "observed" },
      { label: "browser.search", kind: "tool", state: "complete" },
      { kind: "screen", state: "observed" },
      { label: "blocked", kind: "tool", state: "failed" },
      { kind: "result", state: "complete" },
    ]);
  });
});
