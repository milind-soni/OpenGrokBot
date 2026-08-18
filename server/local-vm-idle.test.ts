import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalVmIdleTimer } from "./local-vm-idle.ts";

describe("LocalVmIdleTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("suspends only after a complete idle window", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("renews the deadline on activity", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(700);
    idle.touch();
    await vi.advanceTimersByTimeAsync(700);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("never suspends active work and retries after another full window", async () => {
    let busy = true;
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => busy, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("can be cancelled after a manual stop", async () => {
    const suspend = vi.fn(async () => {});
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);
    idle.touch();
    idle.cancel();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(suspend).not.toHaveBeenCalled();
  });

  it("re-arms after a transient suspension failure", async () => {
    const suspend = vi.fn().mockRejectedValueOnce(new Error("runtime unavailable")).mockResolvedValue(undefined);
    const idle = new LocalVmIdleTimer(1_000, () => false, suspend);

    idle.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(suspend).toHaveBeenCalledTimes(2);
  });
});
