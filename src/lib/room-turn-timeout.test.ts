import { describe, expect, it } from "vitest";

import { parseRoomTurnTimeoutMinutes, saveRoomTurnTimeoutMinutes } from "./room-turn-timeout";

describe("room turn timeout input", () => {
  it.each(["", " ", "0", "1.5", "1441", "twenty"])(
    "rejects %j",
    (value) => {
      expect(parseRoomTurnTimeoutMinutes(value)).toEqual({
        ok: false,
        error: "Enter a whole number from 1 to 1,440.",
      });
    },
  );

  it.each([
    ["1", 1],
    ["20", 20],
    ["1440", 1440],
  ])("accepts %s", (value, expected) => {
    expect(parseRoomTurnTimeoutMinutes(value)).toEqual({ ok: true, minutes: expected });
  });

  it("does not persist invalid input", async () => {
    const persist = async (_minutes: number) => {
      throw new Error("Persistence should not be called");
    };

    await expect(saveRoomTurnTimeoutMinutes("1.5", persist)).resolves.toEqual({
      ok: false,
      error: "Enter a whole number from 1 to 1,440.",
    });
  });

  it("persists parsed minutes and returns the confirmed value", async () => {
    let receivedMinutes: number | undefined;

    const result = await saveRoomTurnTimeoutMinutes(" 20 ", async (minutes) => {
      receivedMinutes = minutes;
      return 25;
    });

    expect(receivedMinutes).toBe(20);
    expect(result).toEqual({ ok: true, minutes: 25 });
  });

  it("preserves an Error message when persistence fails", async () => {
    const result = await saveRoomTurnTimeoutMinutes("20", async () => {
      throw new Error("The server rejected this setting.");
    });

    expect(result).toEqual({ ok: false, error: "The server rejected this setting." });
  });

  it("uses a fallback error for non-Error persistence failures", async () => {
    const result = await saveRoomTurnTimeoutMinutes("20", async () => {
      throw "unavailable";
    });

    expect(result).toEqual({ ok: false, error: "Could not save the room turn limit." });
  });
});
