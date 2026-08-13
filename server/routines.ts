// Routines — the autonomy layer. A routine is a recurring task a bot runs
// on a schedule without the user in the loop: the scheduler ticks, finds
// due routines, and starts a normal turn on the bot (same startTurn path
// as a typed message, so permissions/approvals/streaming all behave
// identically — autonomy changes WHEN a turn starts, never WHAT it may do).
// Persistence is one JSON file next to bots.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export type RoutineSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number }; // day: 0=Sun

export interface Routine {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "ok" | "skipped-busy" | "error";
  lastError?: string;
}

/** A routine plus its computed next fire time — what the API returns. */
export type RoutineView = Routine & { nextRunAt: number | null };

const MIN_INTERVAL_MINUTES = 5; // floor so a typo can't spin a bot forever

/** Pure next-fire computation so it's unit-testable without clocks.
 * `from` is "now"; the anchor for intervals is the last run (or creation). */
export function computeNextRunAt(routine: Routine, from: number): number | null {
  if (!routine.enabled) return null;
  const s = routine.schedule;
  if (s.kind === "interval") {
    const minutes = Math.max(MIN_INTERVAL_MINUTES, Math.round(s.minutes) || MIN_INTERVAL_MINUTES);
    const anchor = routine.lastRunAt ?? routine.createdAt;
    const next = anchor + minutes * 60_000;
    return next > from ? next : from; // overdue → due now
  }
  const at = new Date(from);
  at.setSeconds(0, 0);
  at.setHours(s.hour, s.minute, 0, 0);
  if (s.kind === "daily") {
    if (at.getTime() <= from || (routine.lastRunAt && at.getTime() <= routine.lastRunAt)) {
      at.setDate(at.getDate() + 1);
    }
    return at.getTime();
  }
  // weekly: roll forward to the requested weekday, then skip past now/lastRun
  while (
    at.getDay() !== s.day ||
    at.getTime() <= from ||
    (routine.lastRunAt !== undefined && at.getTime() <= routine.lastRunAt)
  ) {
    at.setDate(at.getDate() + 1);
    at.setHours(s.hour, s.minute, 0, 0);
    if (at.getTime() - from > 8 * 24 * 60 * 60_000) break; // safety: one loop of the week is enough
  }
  return at.getDay() === s.day ? at.getTime() : null;
}

export function decodeSchedule(raw: unknown): RoutineSchedule {
  const s = raw as Record<string, unknown> | null;
  if (!s || typeof s !== "object") throw new Error("schedule required");
  const num = (v: unknown, lo: number, hi: number, name: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`schedule.${name} must be ${lo}–${hi}`);
    return Math.round(n);
  };
  switch (s.kind) {
    case "interval":
      return { kind: "interval", minutes: num(s.minutes, MIN_INTERVAL_MINUTES, 7 * 24 * 60, "minutes") };
    case "daily":
      return { kind: "daily", hour: num(s.hour, 0, 23, "hour"), minute: num(s.minute, 0, 59, "minute") };
    case "weekly":
      return {
        kind: "weekly",
        day: num(s.day, 0, 6, "day"),
        hour: num(s.hour, 0, 23, "hour"),
        minute: num(s.minute, 0, 59, "minute"),
      };
    default:
      throw new Error(`unknown schedule kind "${String(s.kind)}"`);
  }
}

export type RoutineRunner = (routine: Routine) => Promise<void>;
export type RoutineChangeListener = (change: { kind: "routine"; routine: RoutineView } | { kind: "routine.deleted"; id: string }) => void;

export class RoutineStore {
  routines: Routine[] = [];
  private file = join(DATA_DIR, "routines.json");
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  private runner: RoutineRunner;
  private onChange: RoutineChangeListener;

  constructor(runner: RoutineRunner, onChange: RoutineChangeListener) {
    this.runner = runner;
    this.onChange = onChange;
    try {
      this.routines = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.routines = [];
    }
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.routines, null, 2));
  }

  view(r: Routine): RoutineView {
    return { ...r, nextRunAt: computeNextRunAt(r, Date.now()) };
  }

  list(botId?: string): RoutineView[] {
    return this.routines.filter((r) => !botId || r.botId === botId).map((r) => this.view(r));
  }

  get(id: string): Routine | null {
    return this.routines.find((r) => r.id === id) ?? null;
  }

  create(input: { botId: string; name: string; prompt: string; schedule: unknown; enabled?: boolean }): RoutineView {
    const name = String(input.name ?? "").trim();
    const prompt = String(input.prompt ?? "").trim();
    if (!name) throw Object.assign(new Error("name required"), { status: 400 });
    if (!prompt) throw Object.assign(new Error("prompt required"), { status: 400 });
    const routine: Routine = {
      id: newId(),
      botId: input.botId,
      name,
      prompt,
      schedule: decodeSchedule(input.schedule),
      enabled: input.enabled ?? true,
      createdAt: Date.now(),
    };
    this.routines.push(routine);
    this.save();
    const view = this.view(routine);
    this.onChange({ kind: "routine", routine: view });
    return view;
  }

  patch(
    id: string,
    patch: { name?: unknown; prompt?: unknown; schedule?: unknown; enabled?: unknown },
  ): RoutineView | null {
    const routine = this.get(id);
    if (!routine) return null;
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw Object.assign(new Error("name required"), { status: 400 });
      routine.name = name;
    }
    if (patch.prompt !== undefined) {
      const prompt = String(patch.prompt).trim();
      if (!prompt) throw Object.assign(new Error("prompt required"), { status: 400 });
      routine.prompt = prompt;
    }
    if (patch.schedule !== undefined) routine.schedule = decodeSchedule(patch.schedule);
    if (patch.enabled !== undefined) routine.enabled = Boolean(patch.enabled);
    this.save();
    const view = this.view(routine);
    this.onChange({ kind: "routine", routine: view });
    return view;
  }

  delete(id: string): boolean {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    if (this.routines.length === before) return false;
    this.save();
    this.onChange({ kind: "routine.deleted", id });
    return true;
  }

  deleteForBot(botId: string) {
    for (const r of this.routines.filter((x) => x.botId === botId)) this.delete(r.id);
  }

  /** Fire a routine now (scheduler tick or the user's "Run now"). The turn
   * itself runs in the background; failures land on the routine record, not
   * the process. */
  async fire(id: string, opts?: { manual?: boolean }): Promise<RoutineView | null> {
    const routine = this.get(id);
    if (!routine || this.running.has(id)) return routine ? this.view(routine) : null;
    this.running.add(id);
    routine.lastRunAt = Date.now();
    try {
      await this.runner(routine);
      routine.lastStatus = "ok";
      routine.lastError = undefined;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // "bot is busy" is a normal collision, not a failure of the routine
      routine.lastStatus = /already working/i.test(message) ? "skipped-busy" : "error";
      routine.lastError = message.slice(0, 200);
    } finally {
      this.running.delete(id);
    }
    this.save();
    const view = this.view(routine);
    this.onChange({ kind: "routine", routine: view });
    void opts;
    return view;
  }

  /** Scheduler loop — cheap scan every 20s; fire what's due. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const r of this.routines) {
        if (!r.enabled || this.running.has(r.id)) continue;
        const next = computeNextRunAt(r, now);
        if (next !== null && next <= now) void this.fire(r.id);
      }
    }, 20_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
