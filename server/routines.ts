// Routines — recurring tasks a bot runs on a schedule. The scheduler lives
// in the harness (server/index.ts) because it owns turns: a routine firing
// is just a user-less startTurn, so it flows through the same permission
// broker, event bus, and transcript as anything the human types.
//
// Persisted to ~/.openmausbot/routines.json alongside bots.json. Schedule
// math is pure and lives here so it can be tested without a clock.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

/** Daily/weekly fire in the user's LOCAL time — a "9:00 standup" routine
 * means 9am where the Mac is, not UTC. */
export type Schedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number };

export interface Routine {
  id: string;
  botId: string;
  title: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt: number;
}

const ROUTINES_FILE = join(DATA_DIR, "routines.json");
export const MAX_ROUTINE_TITLE_LENGTH = 48;

/** A routine that came due while the app was closed fires once if it was
 * missed within this window; anything staler rolls forward silently, so a
 * laptop shut for a week never wakes up to seven stacked runs. */
export const CATCHUP_WINDOW_MS = 60 * 60_000;

const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_PROMPT = 4_000;

function intIn(value: unknown, min: number, max: number, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`routine: ${field} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/** Decode an untrusted schedule; throws on invalid (same contract as a
 * driver's decodeConfig — callers turn the throw into a 400). */
export function decodeSchedule(raw: unknown): Schedule {
  const s = raw as { kind?: unknown } | null | undefined;
  switch (s?.kind) {
    case "interval":
      return { kind: "interval", minutes: intIn((s as any).minutes, 1, MAX_INTERVAL_MINUTES, "minutes") };
    case "daily":
      return {
        kind: "daily",
        hour: intIn((s as any).hour, 0, 23, "hour"),
        minute: intIn((s as any).minute, 0, 59, "minute"),
      };
    case "weekly":
      return {
        kind: "weekly",
        day: intIn((s as any).day, 0, 6, "day"),
        hour: intIn((s as any).hour, 0, 23, "hour"),
        minute: intIn((s as any).minute, 0, 59, "minute"),
      };
    default:
      throw new Error('routine: schedule.kind must be "interval", "daily", or "weekly"');
  }
}

export function decodePrompt(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("routine: prompt required");
  if (text.length > MAX_PROMPT) throw new Error(`routine: prompt must be under ${MAX_PROMPT} characters`);
  return text;
}

export function decodeTitle(raw: unknown, fallback: string): string {
  const text = String(raw ?? "").trim();
  if (text.length > MAX_ROUTINE_TITLE_LENGTH) {
    throw new Error(`routine: title must be ${MAX_ROUTINE_TITLE_LENGTH} characters or fewer`);
  }
  return text || fallback.trim().slice(0, MAX_ROUTINE_TITLE_LENGTH);
}

/** The next firing strictly after `from`. Pure — no Date.now() inside. */
export function nextRunAfter(schedule: Schedule, from: number): number {
  if (schedule.kind === "interval") return from + schedule.minutes * 60_000;

  const at = new Date(from);
  at.setHours(schedule.hour, schedule.minute, 0, 0);
  if (schedule.kind === "weekly") {
    at.setDate(at.getDate() + ((schedule.day - at.getDay() + 7) % 7));
    if (at.getTime() <= from) at.setDate(at.getDate() + 7);
    return at.getTime();
  }
  if (at.getTime() <= from) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** A short human label for the schedule — shared by the UI and the
 * activity line the bot posts when a routine fires. */
export function describeSchedule(schedule: Schedule): string {
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const clock = (h: number, m: number) => `${h}:${String(m).padStart(2, "0")}`;
  switch (schedule.kind) {
    case "interval": {
      const { minutes } = schedule;
      if (minutes % (24 * 60) === 0) {
        const days = minutes / (24 * 60);
        return days === 1 ? "every day" : `every ${days} days`;
      }
      if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return hours === 1 ? "every hour" : `every ${hours} hours`;
      }
      return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
    }
    case "daily":
      return `every day at ${clock(schedule.hour, schedule.minute)}`;
    case "weekly":
      return `every ${DAYS[schedule.day]} at ${clock(schedule.hour, schedule.minute)}`;
  }
}

export class RoutineStore {
  private routines: Routine[] = [];

  constructor(now = Date.now()) {
    let repaired = false;
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      const raw = JSON.parse(readFileSync(ROUTINES_FILE, "utf8"));
      this.routines = Array.isArray(raw) ? raw : [];
    } catch {
      this.routines = [];
    }
    // a routine written by a newer build (unknown schedule kind) is dropped
    // rather than crashing the boot — same spirit as a shadow instance
    this.routines = this.routines.filter((r) => {
      try {
        r.schedule = decodeSchedule(r.schedule);
        if (!Number.isFinite(r.nextRunAt)) {
          r.nextRunAt = nextRunAfter(r.schedule, now);
          repaired = true;
        }
        return true;
      } catch {
        repaired = true;
        return false;
      }
    });
    if (this.rollForwardStale(now) || repaired) this.save();
  }

  /** Missed-run policy on boot: anything staler than the catch-up window
   * jumps to its next future firing. Returns true when something moved. */
  private rollForwardStale(now: number): boolean {
    let moved = false;
    for (const r of this.routines) {
      if (r.nextRunAt < now - CATCHUP_WINDOW_MS) {
        r.nextRunAt = nextRunAfter(r.schedule, now);
        moved = true;
      }
    }
    return moved;
  }

  private save() {
    writeFileSync(ROUTINES_FILE, JSON.stringify(this.routines, null, 2));
  }

  all(): Routine[] {
    return this.routines;
  }

  forBot(botId: string): Routine[] {
    return this.routines.filter((r) => r.botId === botId).sort((a, b) => a.nextRunAt - b.nextRunAt);
  }

  get(id: string): Routine | null {
    return this.routines.find((r) => r.id === id) ?? null;
  }

  create(input: { botId: string; prompt: string; schedule: Schedule; title?: unknown }, now = Date.now()): Routine {
    const routine: Routine = {
      id: newId(),
      botId: input.botId,
      title: decodeTitle(input.title, input.prompt),
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: true,
      createdAt: now,
      nextRunAt: nextRunAfter(input.schedule, now),
    };
    this.routines.push(routine);
    this.save();
    return routine;
  }

  patch(
    id: string,
    patch: { title?: unknown; prompt?: string; schedule?: Schedule; enabled?: boolean },
    now = Date.now(),
  ) {
    const routine = this.get(id);
    if (!routine) return null;
    if (patch.title !== undefined) routine.title = decodeTitle(patch.title, routine.title);
    if (patch.prompt !== undefined) routine.prompt = patch.prompt;
    if (patch.schedule !== undefined) routine.schedule = patch.schedule;
    if (patch.enabled !== undefined) routine.enabled = patch.enabled;
    // a re-scheduled or re-enabled routine restarts its countdown from now
    if (patch.schedule || patch.enabled === true) routine.nextRunAt = nextRunAfter(routine.schedule, now);
    this.save();
    return routine;
  }

  /** Routines that should fire at `now`, soonest first. */
  due(now = Date.now()): Routine[] {
    return this.routines.filter((r) => r.enabled && r.nextRunAt <= now).sort((a, b) => a.nextRunAt - b.nextRunAt);
  }

  /** Stamp a firing and schedule the next one from `now` — never from the
   * missed slot, so a slow turn can't build a backlog. */
  markRan(
    id: string,
    { now = Date.now(), advanceSchedule = true }: { now?: number; advanceSchedule?: boolean } = {},
  ): Routine | null {
    const routine = this.get(id);
    if (!routine) return null;
    routine.lastRunAt = now;
    if (advanceSchedule) routine.nextRunAt = nextRunAfter(routine.schedule, now);
    this.save();
    return routine;
  }

  delete(id: string): boolean {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    if (this.routines.length === before) return false;
    this.save();
    return true;
  }

  /** Routines die with their bot. */
  deleteForBot(botId: string): number {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.botId !== botId);
    const removed = before - this.routines.length;
    if (removed) this.save();
    return removed;
  }
}
