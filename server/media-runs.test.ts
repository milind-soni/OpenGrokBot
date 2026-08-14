import { describe, expect, it, vi } from "vitest";

import { MediaRunCoordinator } from "./media-runs.ts";

describe("MediaRunCoordinator", () => {
  it("propagates cancellation and never lets late completion replace it", async () => {
    let finish!: (value: { cacheKey: string; mime: string; bytes: number }) => void;
    let observedSignal: AbortSignal | undefined;
    const patches: Array<Record<string, unknown>> = [];
    const onDone = vi.fn();
    const runs = new MediaRunCoordinator({ imageTimeoutMs: 10_000, videoTimeoutMs: 10_000 });
    const run = runs.start({
      botId: "bot-1",
      threadId: "thread-1",
      messageId: "message-1",
      outputId: "output-1",
      task: "video",
      execute: (signal) => {
        observedSignal = signal;
        return new Promise((resolve) => (finish = resolve));
      },
      onPatch: (patch) => patches.push(patch),
      onDone,
    });

    expect(runs.cancel("bot-1", "message-1")).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect(patches.at(-1)).toMatchObject({ status: "cancelled" });
    expect(onDone).toHaveBeenCalledTimes(1);

    finish({ cacheKey: "late.mp4", mime: "video/mp4", bytes: 10 });
    await run.done;
    expect(patches).not.toContainEqual(expect.objectContaining({ status: "ready" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("times out by aborting the provider and recording a terminal failure", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let finish!: (value: { cacheKey: string; mime: string; bytes: number }) => void;
    const patches: Array<Record<string, unknown>> = [];
    const onDone = vi.fn();
    const runs = new MediaRunCoordinator({ imageTimeoutMs: 100, videoTimeoutMs: 100 });
    const run = runs.start({
      botId: "bot-1",
      threadId: "thread-1",
      messageId: "message-1",
      outputId: "output-1",
      task: "image",
      execute: (signal) => {
        observedSignal = signal;
        return new Promise((resolve) => (finish = resolve));
      },
      onPatch: (patch) => patches.push(patch),
      onDone,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(observedSignal?.aborted).toBe(true);
    expect(patches.at(-1)).toMatchObject({ status: "failed" });
    expect(String(patches.at(-1)?.error)).toContain("timed out");
    expect(onDone).toHaveBeenCalledTimes(1);
    finish({ cacheKey: "too-late.png", mime: "image/png", bytes: 10 });
    await run.done;
    expect(patches).not.toContainEqual(expect.objectContaining({ status: "ready" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
