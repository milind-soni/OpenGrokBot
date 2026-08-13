// Pure scheduling math — no clocks, no fs, no server.
import { describe, expect, it } from "vitest";

import { computeNextRunAt, decodeSchedule, type Routine } from "./routines.ts";

const base = (over: Partial<Routine>): Routine => ({
  id: "r1",
  botId: "b1",
  name: "Test",
  prompt: "do the thing",
  schedule: { kind: "interval", minutes: 30 },
  enabled: true,
  createdAt: 0,
  ...over,
});

describe("computeNextRunAt", () => {
  it("is null when disabled", () => {
    expect(computeNextRunAt(base({ enabled: false }), Date.now())).toBeNull();
  });

  it("interval: anchors on creation, then on the last run", () => {
    const created = Date.UTC(2026, 0, 1, 12, 0, 0);
    const r = base({ createdAt: created, schedule: { kind: "interval", minutes: 30 } });
    expect(computeNextRunAt(r, created)).toBe(created + 30 * 60_000);
    r.lastRunAt = created + 30 * 60_000;
    expect(computeNextRunAt(r, r.lastRunAt)).toBe(created + 60 * 60_000);
  });

  it("interval: an overdue routine is due immediately, not in the past", () => {
    const created = 1_000_000;
    const now = created + 10 * 60 * 60_000; // 10h later
    expect(computeNextRunAt(base({ createdAt: created }), now)).toBe(now);
  });

  it("interval: floors runaway-small intervals to 5 minutes", () => {
    const created = 1_000_000;
    const r = base({ createdAt: created, schedule: { kind: "interval", minutes: 0 } });
    expect(computeNextRunAt(r, created)).toBe(created + 5 * 60_000);
  });

  it("daily: picks today's slot when still ahead, tomorrow's when passed", () => {
    const now = new Date(2026, 3, 10, 8, 0, 0, 0).getTime(); // local 08:00
    const r = base({ schedule: { kind: "daily", hour: 9, minute: 30 } });
    expect(computeNextRunAt(r, now)).toBe(new Date(2026, 3, 10, 9, 30, 0, 0).getTime());
    const later = new Date(2026, 3, 10, 10, 0, 0, 0).getTime();
    expect(computeNextRunAt(r, later)).toBe(new Date(2026, 3, 11, 9, 30, 0, 0).getTime());
  });

  it("daily: never re-fires the slot it just ran", () => {
    const slot = new Date(2026, 3, 10, 9, 30, 0, 0).getTime();
    const r = base({ schedule: { kind: "daily", hour: 9, minute: 30 }, lastRunAt: slot });
    // a second later the next fire is tomorrow, not the just-run slot
    expect(computeNextRunAt(r, slot + 1000)).toBe(new Date(2026, 3, 11, 9, 30, 0, 0).getTime());
  });

  it("weekly: rolls forward to the requested weekday", () => {
    // 2026-04-10 is a Friday (day 5); ask for Monday (1) 09:00
    const now = new Date(2026, 3, 10, 8, 0, 0, 0).getTime();
    const r = base({ schedule: { kind: "weekly", day: 1, hour: 9, minute: 0 } });
    const next = computeNextRunAt(r, now)!;
    const d = new Date(next);
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(9);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(7 * 24 * 60 * 60_000);
  });

  it("weekly: same-day later-time fires today", () => {
    // 2026-04-10 08:00 is a Friday; ask for Friday 09:00 → today
    const now = new Date(2026, 3, 10, 8, 0, 0, 0).getTime();
    const r = base({ schedule: { kind: "weekly", day: 5, hour: 9, minute: 0 } });
    expect(computeNextRunAt(r, now)).toBe(new Date(2026, 3, 10, 9, 0, 0, 0).getTime());
  });
});

describe("decodeSchedule", () => {
  it("round-trips valid shapes", () => {
    expect(decodeSchedule({ kind: "interval", minutes: 45 })).toEqual({ kind: "interval", minutes: 45 });
    expect(decodeSchedule({ kind: "daily", hour: 7, minute: 15 })).toEqual({ kind: "daily", hour: 7, minute: 15 });
    expect(decodeSchedule({ kind: "weekly", day: 3, hour: 18, minute: 0 })).toEqual({
      kind: "weekly",
      day: 3,
      hour: 18,
      minute: 0,
    });
  });

  it("rejects junk loudly", () => {
    expect(() => decodeSchedule(null)).toThrow();
    expect(() => decodeSchedule({ kind: "cron", expr: "* * * * *" })).toThrow(/unknown schedule kind/);
    expect(() => decodeSchedule({ kind: "daily", hour: 99, minute: 0 })).toThrow(/hour/);
    expect(() => decodeSchedule({ kind: "interval", minutes: 2 })).toThrow(/minutes/);
  });
});
