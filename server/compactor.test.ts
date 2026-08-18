import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { rebuildForModel } from "./compactor.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

function seeded(n: number, chars = 400) {
  const store = new Store(selection);
  const bot = store.createBot();
  for (let i = 0; i < n; i++) {
    store.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `m${i} ` + "x".repeat(chars) });
  }
  return { store, bot };
}

describe("rebuildForModel", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("returns the whole path when it fits, writing nothing", async () => {
    const { store, bot } = seeded(6);
    const before = store.activePath(bot.threadId).length;
    const out = await rebuildForModel({ store, threadId: bot.threadId, contextWindow: 200_000, generateText: async () => "never" });
    expect(out.compacted).toBe(false);
    expect(out.summary).toBeUndefined();
    expect(out.entries.length).toBe(7); // greeting + 6 (the options card is skipped)
    expect(store.activePath(bot.threadId).length).toBe(before);
  });

  it("summarizes the oldest part for a small window and writes a compaction record in the tree", async () => {
    const { store, bot } = seeded(40);
    const prompts: string[] = [];
    const out = await rebuildForModel({
      store,
      threadId: bot.threadId,
      contextWindow: 10_000, // budget 4000 → ~38 entries × 104 tok won't fit
      generateText: async (p) => (prompts.push(p), "SUMMARY-1"),
    });
    expect(out.compacted).toBe(true);
    expect(out.summary).toBe("SUMMARY-1");
    // the prompt carried the folded lines and nothing from the kept tail
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("m0 ");
    expect(prompts[0]).not.toContain("m39 ");
    // record in the tree, display path intact
    const path = store.activePath(bot.threadId);
    expect(path.at(-1)?.kind).toBe("compaction");
    expect(path.some((m) => m.text?.startsWith("m0 "))).toBe(true);
    // the model-facing view starts where the record says
    const ctx = store.modelContext(bot.threadId);
    expect(ctx.summary).toBe("SUMMARY-1");
    expect(ctx.messages[0].text).toMatch(/^m\d+ /);
    expect(out.entries.length).toBe(ctx.messages.length);
  });

  it("feeds the previous summary into the next one, so facts carry forward", async () => {
    const { store, bot } = seeded(40);
    await rebuildForModel({ store, threadId: bot.threadId, contextWindow: 10_000, generateText: async () => "FIRST" });
    for (let i = 40; i < 70; i++) {
      store.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `m${i} ` + "x".repeat(400) });
    }
    const prompts: string[] = [];
    const out = await rebuildForModel({ store, threadId: bot.threadId, contextWindow: 10_000, generateText: async (p) => (prompts.push(p), "SECOND") });
    expect(out.compacted).toBe(true);
    expect(prompts[0]).toContain("Earlier summary");
    expect(prompts[0]).toContain("FIRST");
    expect(store.modelContext(bot.threadId).summary).toBe("SECOND");
  });

  it("without a summarizer it still bounds the rebuild — drops the oldest, writes no record", async () => {
    const { store, bot } = seeded(40);
    const before = store.activePath(bot.threadId).length;
    const out = await rebuildForModel({ store, threadId: bot.threadId, contextWindow: 10_000, generateText: undefined });
    expect(out.compacted).toBe(false);
    expect(out.summary).toBeUndefined();
    expect(out.entries.length).toBeLessThan(40);
    expect(out.entries.at(-1)?.text.startsWith("m39 ")).toBe(true);
    expect(store.activePath(bot.threadId).length).toBe(before);
  });

  it("a summarizer that fails falls back the same way rather than failing the turn", async () => {
    const { store, bot } = seeded(40);
    const out = await rebuildForModel({
      store,
      threadId: bot.threadId,
      contextWindow: 10_000,
      generateText: async () => {
        throw new Error("model down");
      },
    });
    expect(out.compacted).toBe(false);
    expect(out.entries.length).toBeLessThan(40);
  });

  it("excludes the message being sent now, and attributes room speakers when asked", async () => {
    const { store, bot } = seeded(2);
    const now = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "the new one" });
    const out = await rebuildForModel({ store, threadId: bot.threadId, contextWindow: 200_000, generateText: undefined, excludeId: now.id });
    expect(out.entries.some((e) => e.text === "the new one")).toBe(false);
  });
});
