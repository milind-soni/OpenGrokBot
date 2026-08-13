// Routine scheduling is pure arithmetic plus a JSON file, so it tests
// without a clock or a server: every case pins a fixed `now` and asserts
// the next firing. Local-time cases build their expectations with local
// Date math so the suite passes in any timezone.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "./config.ts";
import {
  CATCHUP_WINDOW_MS,
  MAX_ROUTINE_TITLE_LENGTH,
  RoutineStore,
  decodePrompt,
  decodeSchedule,
  describeSchedule,
  nextRunAfter,
  type Schedule,
} from "./routines.ts";

const ROUTINES_FILE = join(DATA_DIR, "routines.json");

/** Local wall-clock helper: today at hh:mm, offset by `days`. */
const localAt = (base: number, hour: number, minute: number, days = 0) => {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
};

const freshStore = (now?: number) => {
  ensureDirs();
  rmSync(join(DATA_DIR, "routines.json"), { force: true });
  return new RoutineStore(now);
};

describe("decodeSchedule", () => {
  it("accepts the three kinds", () => {
    expect(decodeSchedule({ kind: "interval", minutes: 30 })).toEqual({ kind: "interval", minutes: 30 });
    expect(decodeSchedule({ kind: "daily", hour: 9, minute: 5 })).toEqual({ kind: "daily", hour: 9, minute: 5 });
    expect(decodeSchedule({ kind: "weekly", day: 1, hour: 9, minute: 0 })).toEqual({
      kind: "weekly",
      day: 1,
      hour: 9,
      minute: 0,
    });
  });

  it("throws on an unknown kind (the route turns this into a 400)", () => {
    expect(() => decodeSchedule({ kind: "hourly" })).toThrow(/schedule.kind/);
    expect(() => decodeSchedule(undefined)).toThrow(/schedule.kind/);
    expect(() => decodeSchedule(null)).toThrow(/schedule.kind/);
  });

  it("rejects out-of-range and non-integer fields", () => {
    expect(() => decodeSchedule({ kind: "interval", minutes: 0 })).toThrow(/minutes/);
    expect(() => decodeSchedule({ kind: "interval", minutes: 10_081 })).toThrow(/minutes/);
    expect(() => decodeSchedule({ kind: "interval", minutes: 1.5 })).toThrow(/minutes/);
    expect(() => decodeSchedule({ kind: "daily", hour: 24, minute: 0 })).toThrow(/hour/);
    expect(() => decodeSchedule({ kind: "daily", hour: 9, minute: 60 })).toThrow(/minute/);
    expect(() => decodeSchedule({ kind: "weekly", day: 7, hour: 9, minute: 0 })).toThrow(/day/);
  });
});

describe("decodePrompt", () => {
  it("trims and requires text", () => {
    expect(decodePrompt("  summarize my inbox  ")).toBe("summarize my inbox");
    expect(() => decodePrompt("   ")).toThrow(/required/);
    expect(() => decodePrompt(undefined)).toThrow(/required/);
  });

  it("caps the length", () => {
    expect(() => decodePrompt("x".repeat(4_001))).toThrow(/4000/);
  });
});

describe("nextRunAfter", () => {
  const now = new Date(2026, 7, 13, 10, 30, 0, 0).getTime(); // Thursday

  it("adds the interval", () => {
    expect(nextRunAfter({ kind: "interval", minutes: 15 }, now)).toBe(now + 15 * 60_000);
  });

  it("takes today's slot when it is still ahead", () => {
    expect(nextRunAfter({ kind: "daily", hour: 18, minute: 0 }, now)).toBe(localAt(now, 18, 0));
  });

  it("rolls to tomorrow once today's slot has passed", () => {
    expect(nextRunAfter({ kind: "daily", hour: 9, minute: 0 }, now)).toBe(localAt(now, 9, 0, 1));
  });

  it("is strictly after `from` — the current minute never re-fires", () => {
    const exact = localAt(now, 10, 30);
    expect(nextRunAfter({ kind: "daily", hour: 10, minute: 30 }, exact)).toBe(localAt(exact, 10, 30, 1));
  });

  it("finds the next weekday, this week or next", () => {
    // Thursday (4) 10:30 → Friday (5) 09:00 is this week
    expect(nextRunAfter({ kind: "weekly", day: 5, hour: 9, minute: 0 }, now)).toBe(localAt(now, 9, 0, 1));
    // …Thursday 09:00 has passed, so it lands a full week out
    expect(nextRunAfter({ kind: "weekly", day: 4, hour: 9, minute: 0 }, now)).toBe(localAt(now, 9, 0, 7));
    // …Monday (1) is three days ahead
    expect(nextRunAfter({ kind: "weekly", day: 1, hour: 9, minute: 0 }, now)).toBe(localAt(now, 9, 0, 4));
  });
});

describe("describeSchedule", () => {
  it("says hours and days rather than raw minutes", () => {
    expect(describeSchedule({ kind: "interval", minutes: 1 })).toBe("every minute");
    expect(describeSchedule({ kind: "interval", minutes: 45 })).toBe("every 45 minutes");
    expect(describeSchedule({ kind: "interval", minutes: 60 })).toBe("every hour");
    expect(describeSchedule({ kind: "interval", minutes: 180 })).toBe("every 3 hours");
    expect(describeSchedule({ kind: "interval", minutes: 1440 })).toBe("every day");
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 5 })).toBe("every day at 9:05");
    expect(describeSchedule({ kind: "weekly", day: 1, hour: 17, minute: 0 })).toBe("every Monday at 17:00");
  });
});

describe("RoutineStore", () => {
  const every15: Schedule = { kind: "interval", minutes: 15 };
  let now: number;

  beforeEach(() => {
    now = Date.now();
  });

  it("creates with a derived title and the first firing scheduled", () => {
    const store = freshStore();
    const routine = store.create({ botId: "bot-1", prompt: "check the build", schedule: every15 }, now);
    expect(routine.title).toBe("check the build");
    expect(routine.enabled).toBe(true);
    expect(routine.nextRunAt).toBe(now + 15 * 60_000);
    expect(routine.lastRunAt).toBeUndefined();
  });

  it("persists across instances", () => {
    const store = freshStore();
    store.create({ botId: "bot-1", prompt: "standup", schedule: every15, title: "Standup" }, now);
    expect(new RoutineStore(now).forBot("bot-1").map((r) => r.title)).toEqual(["Standup"]);
  });

  it("repairs and saves an invalid persisted next-run timestamp", () => {
    freshStore(now);
    writeFileSync(
      ROUTINES_FILE,
      JSON.stringify([
        {
          id: "broken-time",
          botId: "bot-1",
          title: "Repair me",
          prompt: "Run this",
          schedule: every15,
          enabled: true,
          createdAt: now,
          nextRunAt: null,
        },
      ]),
    );

    const repaired = new RoutineStore(now).get("broken-time");
    expect(repaired?.nextRunAt).toBe(now + 15 * 60_000);
    const saved = JSON.parse(readFileSync(ROUTINES_FILE, "utf8")) as Array<{ nextRunAt: number }>;
    expect(saved[0].nextRunAt).toBe(now + 15 * 60_000);
  });

  it("normalizes and limits titles consistently on create and patch", () => {
    const store = freshStore();
    const routine = store.create(
      { botId: "bot-1", prompt: "check the build", schedule: every15, title: "  Build check  " },
      now,
    );
    expect(routine.title).toBe("Build check");
    expect(store.patch(routine.id, { title: "   " }, now)?.title).toBe("Build check");
    expect(() =>
      store.patch(routine.id, { title: "x".repeat(MAX_ROUTINE_TITLE_LENGTH + 1) }, now),
    ).toThrow(/48 characters or fewer/);
  });

  it("lists a bot's routines soonest-first and ignores other bots", () => {
    const store = freshStore();
    store.create({ botId: "bot-1", prompt: "later", schedule: { kind: "interval", minutes: 60 } }, now);
    store.create({ botId: "bot-1", prompt: "sooner", schedule: every15 }, now);
    store.create({ botId: "bot-2", prompt: "elsewhere", schedule: every15 }, now);
    expect(store.forBot("bot-1").map((r) => r.prompt)).toEqual(["sooner", "later"]);
  });

  it("only returns enabled, past-due routines from due()", () => {
    const store = freshStore();
    const ready = store.create({ botId: "bot-1", prompt: "ready", schedule: every15 }, now - 20 * 60_000);
    store.create({ botId: "bot-1", prompt: "waiting", schedule: every15 }, now);
    const off = store.create({ botId: "bot-1", prompt: "off", schedule: every15 }, now - 20 * 60_000);
    store.patch(off.id, { enabled: false }, now);

    expect(store.due(now).map((r) => r.id)).toEqual([ready.id]);
  });

  it("schedules the next run from now, so a late turn cannot build a backlog", () => {
    const store = freshStore();
    const routine = store.create({ botId: "bot-1", prompt: "poll", schedule: every15 }, now - 60 * 60_000);
    const ran = store.markRan(routine.id, { now })!;
    expect(ran.lastRunAt).toBe(now);
    expect(ran.nextRunAt).toBe(now + 15 * 60_000);
    expect(store.due(now)).toEqual([]);
  });

  it("records a manual run without consuming its scheduled occurrence", () => {
    const store = freshStore();
    const routine = store.create({ botId: "bot-1", prompt: "poll", schedule: every15 }, now);
    const nextRunAt = routine.nextRunAt;
    const ran = store.markRan(routine.id, { now: now + 60_000, advanceSchedule: false })!;
    expect(ran.lastRunAt).toBe(now + 60_000);
    expect(ran.nextRunAt).toBe(nextRunAt);
  });

  it("disabling holds the slot; re-enabling restarts the countdown", () => {
    const store = freshStore();
    const routine = store.create({ botId: "bot-1", prompt: "poll", schedule: every15 }, now);
    const paused = store.patch(routine.id, { enabled: false }, now + 60_000)!;
    expect(paused.nextRunAt).toBe(routine.nextRunAt);

    const resumed = store.patch(routine.id, { enabled: true }, now + 60_000)!;
    expect(resumed.nextRunAt).toBe(now + 60_000 + 15 * 60_000);
  });

  it("re-scheduling recomputes the next firing", () => {
    const store = freshStore();
    const routine = store.create({ botId: "bot-1", prompt: "poll", schedule: every15 }, now);
    const patched = store.patch(routine.id, { schedule: { kind: "interval", minutes: 60 } }, now)!;
    expect(patched.nextRunAt).toBe(now + 60 * 60_000);
  });

  it("deletes one routine, and all of a bot's routines with the bot", () => {
    const store = freshStore();
    const a = store.create({ botId: "bot-1", prompt: "a", schedule: every15 }, now);
    store.create({ botId: "bot-1", prompt: "b", schedule: every15 }, now);
    store.create({ botId: "bot-2", prompt: "c", schedule: every15 }, now);

    expect(store.delete(a.id)).toBe(true);
    expect(store.delete(a.id)).toBe(false);
    expect(store.deleteForBot("bot-1")).toBe(1);
    expect(store.forBot("bot-1")).toEqual([]);
    expect(store.forBot("bot-2")).toHaveLength(1);
  });

  it("fires a recently-missed run on boot but rolls a stale one forward", () => {
    const store = freshStore();
    const missed = store.create({ botId: "bot-1", prompt: "missed", schedule: every15 }, now - 30 * 60_000);
    const stale = store.create({ botId: "bot-1", prompt: "stale", schedule: every15 }, now - 5 * 60 * 60_000);
    expect(stale.nextRunAt).toBeLessThan(now - CATCHUP_WINDOW_MS);

    // reboot: the laptop was closed, both slots are in the past
    const rebooted = new RoutineStore(now);
    expect(rebooted.due(now).map((r) => r.id)).toEqual([missed.id]);
    expect(rebooted.get(stale.id)!.nextRunAt).toBe(now + 15 * 60_000);
  });

  it("drops a routine whose schedule this build cannot decode", () => {
    const store = freshStore();
    const keep = store.create({ botId: "bot-1", prompt: "keep", schedule: every15 }, now);
    // simulate a config written by a newer build
    const raw = store.all();
    raw.push({ ...keep, id: "from-the-future", schedule: { kind: "lunar" } as unknown as Schedule });
    store.patch(keep.id, {}, now); // force a save including the bogus entry

    const rebooted = new RoutineStore(now);
    expect(rebooted.all().map((r) => r.id)).toEqual([keep.id]);
  });
});
