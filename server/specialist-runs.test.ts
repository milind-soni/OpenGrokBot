import { describe, expect, it, vi } from "vitest";

import { SpecialistRunManager } from "./specialist-runs.ts";

describe("SpecialistRunManager", () => {
  it("reports a timed-out media run before removing it", async () => {
    vi.useFakeTimers();
    const terminal: Array<{ status: string; error: string; messageId?: string }> = [];
    const interrupt = vi.fn(async () => {});
    const runs = new SpecialistRunManager(100);
    const run = runs.start({
      runtimeThreadId: "specialist:b1:video:timeout",
      visibleThreadId: "thread-1",
      botId: "b1",
      primaryTurnId: "primary-1",
      task: "video",
      interrupt,
      onTerminal: (outcome) => terminal.push(outcome),
    });
    run.mediaMessageId = "message-1";
    const rejected = expect(run.result).rejects.toThrow("video generation timed out");

    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(terminal).toEqual([
      { status: "failed", error: "video generation timed out", messageId: "message-1" },
    ]);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(runs.forThread(run.runtimeThreadId)).toBeUndefined();
    vi.useRealTimers();
  });

  it("allows only one active run per bot and media task", () => {
    const runs = new SpecialistRunManager();
    runs.start({
      runtimeThreadId: "specialist:b1:image:1",
      visibleThreadId: "thread-1",
      botId: "b1",
      primaryTurnId: "primary-1",
      task: "image",
      interrupt: vi.fn(),
    });
    expect(() =>
      runs.start({
        runtimeThreadId: "specialist:b1:image:2",
        visibleThreadId: "thread-1",
        botId: "b1",
        primaryTurnId: "primary-1",
        task: "image",
        interrupt: vi.fn(),
      }),
    ).toThrow(/already generating an image/);
  });

  it("waits for media caching after the provider turn completes", async () => {
    const runs = new SpecialistRunManager();
    const run = runs.start({
      runtimeThreadId: "specialist:b1:image:1",
      visibleThreadId: "thread-1",
      botId: "b1",
      primaryTurnId: "primary-1",
      task: "image",
      interrupt: vi.fn(),
    });
    let finishCache!: () => void;
    const caching = new Promise<void>((resolve) => (finishCache = resolve));
    runs.setMediaPipeline(run.runtimeThreadId, "message-1", caching);
    runs.turnCompleted(run.runtimeThreadId, true);

    let settled = false;
    void run.result.finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    finishCache();
    await expect(run.result).resolves.toEqual({ messageId: "message-1", task: "image" });
    expect(runs.forThread(run.runtimeThreadId)).toBeUndefined();
  });

  it("cancels only runs belonging to the interrupted primary turn", async () => {
    const runs = new SpecialistRunManager();
    const interruptImage = vi.fn(async () => {});
    const interruptVideo = vi.fn(async () => {});
    const image = runs.start({
      runtimeThreadId: "specialist:b1:image:1",
      visibleThreadId: "thread-1",
      botId: "b1",
      primaryTurnId: "primary-1",
      task: "image",
      interrupt: interruptImage,
    });
    const video = runs.start({
      runtimeThreadId: "specialist:b1:video:1",
      visibleThreadId: "thread-1",
      botId: "b1",
      primaryTurnId: "primary-2",
      task: "video",
      interrupt: interruptVideo,
    });

    await runs.cancelPrimary("b1", "primary-1");
    await expect(image.result).rejects.toThrow(/cancelled/);
    expect(interruptImage).toHaveBeenCalledOnce();
    expect(interruptVideo).not.toHaveBeenCalled();
    expect(runs.forThread(video.runtimeThreadId)).toBeDefined();
    runs.fail(video.runtimeThreadId, new Error("cleanup"));
    await expect(video.result).rejects.toThrow("cleanup");
  });

  it("cancels the specialist attached to a visible media message", async () => {
    const runs = new SpecialistRunManager();
    const terminal: Array<{ status: string; error: string; messageId?: string }> = [];
    const interrupt = vi.fn(async () => {});
    const run = runs.start({
      runtimeThreadId: "specialist:b1:video:1",
      visibleThreadId: "thread-1",
      botId: "b1",
      primaryTurnId: "primary-1",
      task: "video",
      interrupt,
      onTerminal: (outcome) => terminal.push(outcome),
    });
    run.mediaMessageId = "message-1";
    void run.result.catch(() => {});

    const cancelled = await runs.cancelMessage("b1", "message-1");

    expect(cancelled).toBe(true);
    await expect(run.result).rejects.toThrow("video generation cancelled");
    expect(terminal).toEqual([
      { status: "cancelled", error: "video generation cancelled", messageId: "message-1" },
    ]);
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("cancels every specialist before provider reload", async () => {
    const runs = new SpecialistRunManager();
    const interrupt = vi.fn(async () => {});
    const image = runs.start({
      runtimeThreadId: "specialist:b1:image:reload",
      visibleThreadId: "thread-1",
      botId: "b1",
      primaryTurnId: "primary-1",
      task: "image",
      interrupt,
    });
    await runs.cancelAll("provider reload");
    await expect(image.result).rejects.toThrow("provider reload");
    expect(interrupt).toHaveBeenCalledOnce();
    expect(runs.forThread(image.runtimeThreadId)).toBeUndefined();
  });
});
