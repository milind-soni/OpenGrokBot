import { afterEach, describe, expect, it, vi } from "vitest";

import {
  roomTurnTimeoutMessage,
  roomTurnTimeoutMs,
  scheduleRoomTurnTimeout,
} from "./room-turn-timeout.ts";

afterEach(() => vi.useRealTimers());

describe("room turn timeout", () => {
  it("converts configured minutes to milliseconds", () => {
    expect(roomTurnTimeoutMs(20)).toBe(20 * 60_000);
  });

  it("fires exactly at the configured absolute deadline", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timer = scheduleRoomTurnTimeout(20, onTimeout);

    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    clearTimeout(timer);
  });

  it("can be cancelled when the room turn settles", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timer = scheduleRoomTurnTimeout(5, onTimeout);
    clearTimeout(timer);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("formats singular and plural timeout messages", () => {
    expect(roomTurnTimeoutMessage("Atlas", 1)).toBe(
      "Atlas's room turn exceeded 1 minute and was stopped",
    );
    expect(roomTurnTimeoutMessage("Atlas", 20)).toBe(
      "Atlas's room turn exceeded 20 minutes and was stopped",
    );
  });
});
