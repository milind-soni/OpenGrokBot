import { describe, expect, it } from "vitest";

import { budgetFor, estimateTokens, planFold, renderEntry, replayEntries, type ReplayEntry } from "./context-rebuild.ts";
import type { Message } from "./store.ts";

const m = (id: string, over: Partial<Message>): Message =>
  ({ id, role: "user", kind: "text", at: Number(id.replace(/\D/g, "")) || 0, parentId: null, ...over }) as Message;

describe("renderEntry / replayEntries", () => {
  it("renders text as the speaker's line and activity as a compact tool note", () => {
    expect(renderEntry(m("1", { role: "user", text: "hi" }))).toEqual({ role: "user", text: "hi" });
    expect(renderEntry(m("2", { role: "bot", text: "hello" }))).toEqual({ role: "assistant", text: "hello" });
    expect(renderEntry(m("3", { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } }))).toEqual({
      role: "assistant",
      text: "[tool: Bash ✓]",
    });
    expect(renderEntry(m("4", { role: "bot", kind: "activity", tool: { name: "Read", ok: false } }))).toEqual({
      role: "assistant",
      text: "[tool: Read ✗]",
    });
  });

  it("skips what a model can't use: cards, screens, empty text, error chips", () => {
    expect(renderEntry(m("1", { kind: "options", card: { title: "x", options: [] } as never }))).toBeNull();
    expect(renderEntry(m("2", { kind: "screen", png: "…" }))).toBeNull();
    expect(renderEntry(m("3", { text: "   " }))).toBeNull();
    expect(renderEntry(m("4", { role: "bot", kind: "activity", tool: { name: "error: boom", ok: false } }))).toBeNull();
    // room attribution: the member's name leads the line
    expect(renderEntry(m("5", { role: "bot", text: "on it", from: { botId: "b", name: "Scout", color: "green" } }), { attribute: true })).toEqual({
      role: "assistant",
      text: "Scout: on it",
    });
  });

  it("replayEntries keeps order and drops the current user message", () => {
    const path = [m("1", { text: "a" }), m("2", { role: "bot", text: "b" }), m("3", { text: "c" })];
    expect(replayEntries(path, { excludeId: "3" }).map((e) => e.text)).toEqual(["a", "b"]);
  });
});

describe("estimateTokens / budgetFor", () => {
  it("estimates ~4 chars per token with a per-entry overhead", () => {
    expect(estimateTokens([{ role: "user", text: "x".repeat(400) }])).toBe(100 + 4);
    expect(estimateTokens([])).toBe(0);
  });

  it("budgets 40% of the window with a floor, and a conservative default when unknown", () => {
    expect(budgetFor(200_000)).toBe(80_000);
    expect(budgetFor(8_000)).toBe(4_000); // floor
    expect(budgetFor(undefined)).toBe(budgetFor(128_000));
  });
});

describe("planFold", () => {
  const entries = (n: number, chars = 400): ReplayEntry[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `${i}:` + "x".repeat(chars) }));

  it("does nothing when the replay fits the budget", () => {
    expect(planFold(entries(10), { budget: 100_000, keepTail: 12 })).toEqual({ fold: 0 });
  });

  it("folds the oldest entries until the tail fits, never fewer than the keep-tail stays verbatim", () => {
    // 40 entries × ~104 tok = ~4160; budget 2000 → keep what fits from the end
    const plan = planFold(entries(40), { budget: 2000, keepTail: 12 });
    expect(plan.fold).toBeGreaterThan(0);
    const kept = entries(40).slice(plan.fold);
    expect(kept.length).toBeGreaterThanOrEqual(12);
    expect(estimateTokens(kept)).toBeLessThanOrEqual(2000);
  });

  it("keeps the tail even when the tail alone is over budget — a smaller model gets the recent turns, not nothing", () => {
    const plan = planFold(entries(20, 4000), { budget: 1000, keepTail: 6 });
    expect(plan.fold).toBe(14);
  });

  it("accounts for a summary that will lead the rebuild", () => {
    const withoutSummary = planFold(entries(40), { budget: 2000, keepTail: 4 });
    const withSummary = planFold(entries(40), { budget: 2000, keepTail: 4, summaryTokens: 800 });
    expect(withSummary.fold).toBeGreaterThan(withoutSummary.fold);
  });
});
