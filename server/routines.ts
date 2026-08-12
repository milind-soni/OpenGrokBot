// Routines — recurring tasks an agent runs on a schedule. Persisted to
// ~/.openmausbot/routines.json; the scheduler ticks from server/index.ts
// and hands each due routine to startTurn() like a normal user message.
// A routine is scoped to one bot and is just a prompt + an interval:
// every N minutes the bot runs that prompt on its configured computer.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export interface Routine {
  id: string;
  botId: string;
  /** Short label shown in the Routines panel. */
  name: string;
  /** The prompt dispatched to the bot each time it runs. */
  prompt: string;
  /** Interval in minutes between runs (min 1). */
  everyMinutes: number;
  /** Persisted schedule state; the in-memory `nextDueAt` drives the tick. */
  enabled: boolean;
  createdAt: number;
  /** Set when the routine actually fires; shown in the UI. */
  lastRunAt: number | null;
}

interface RoutineRecord extends Routine {
  nextDueAt: number;
}

const ROUTINES_FILE = join(DATA_DIR, "routines.json");

export class RoutineStore {
  private routines: RoutineRecord[] = [];

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      const raw = JSON.parse(readFileSync(ROUTINES_FILE, "utf8"));
      this.routines = Array.isArray(raw) ? raw : [];
    } catch {
      this.routines = [];
    }
    for (const r of this.routines) {
      // normalize + seed nextDueAt (now) so a fresh routine doesn't fire
      // immediately after a restart unless its interval has truly elapsed
      r.everyMinutes = Math.max(1, Math.floor(Number(r.everyMinutes) || 60));
      r.nextDueAt = r.lastRunAt ? r.lastRunAt + r.everyMinutes * 60_000 : Date.now();
    }
  }

  private save() {
    writeFileSync(ROUTINES_FILE, JSON.stringify(this.routines, null, 2));
  }

  all(): Routine[] {
    return this.routines.map(({ nextDueAt, ...r }) => ({ ...r, lastRunAt: r.lastRunAt ?? null }));
  }

  get(id: string): Routine | null {
    const r = this.routines.find((r) => r.id === id);
    if (!r) return null;
    const { nextDueAt: _remove, ...rest } = r;
    return rest;
  }

  forBot(botId: string): Routine[] {
    return this.routines.filter((r) => r.botId === botId).map(({ nextDueAt: _remove, ...r }) => r);
  }

  create(input: Omit<Routine, "id" | "createdAt" | "lastRunAt">): Routine {
    const routine: RoutineRecord = {
      id: newId(),
      botId: input.botId,
      name: String(input.name ?? "").trim() || "Untitled routine",
      prompt: String(input.prompt ?? "").trim(),
      everyMinutes: Math.max(1, Math.floor(Number(input.everyMinutes) || 60)),
      enabled: input.enabled !== false,
      createdAt: Date.now(),
      lastRunAt: null,
      nextDueAt: Date.now(),
    };
    if (!routine.prompt) throw Object.assign(new Error("prompt is required"), { status: 400 });
    this.routines.push(routine);
    this.save();
    return this.get(routine.id)!;
  }

  patch(id: string, patch: Partial<Pick<Routine, "name" | "prompt" | "everyMinutes" | "enabled" | "botId">>): Routine | null {
    const r = this.routines.find((r) => r.id === id);
    if (!r) return null;
    if (patch.name !== undefined) r.name = String(patch.name).trim() || r.name;
    if (patch.prompt !== undefined) {
      const p = String(patch.prompt).trim();
      if (!p) throw Object.assign(new Error("prompt is required"), { status: 400 });
      r.prompt = p;
    }
    if (patch.everyMinutes !== undefined) r.everyMinutes = Math.max(1, Math.floor(Number(patch.everyMinutes) || r.everyMinutes));
    if (patch.enabled !== undefined) r.enabled = Boolean(patch.enabled);
    if (patch.botId !== undefined) r.botId = patch.botId;
    this.save();
    return this.get(id)!;
  }

  remove(id: string): boolean {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    const removed = this.routines.length !== before;
    if (removed) this.save();
    return removed;
  }

  /** Hand the scheduler the routines due right now. Resets each one's
   *  next-due timestamp only when it is actually executed. */
  due(): RoutineRecord[] {
    const now = Date.now();
    return this.routines.filter((r) => r.enabled && r.nextDueAt <= now);
  }

  markRun(id: string) {
    const r = this.routines.find((r) => r.id === id);
    if (!r) return;
    r.lastRunAt = Date.now();
    r.nextDueAt = r.lastRunAt + r.everyMinutes * 60_000;
    this.save();
  }

  /** Called by the app when a run was attempted but failed — back off and
   *  retry next tick so a flaky failure doesn't hot-loop the bot. */
  postpone(id: string) {
    const r = this.routines.find((r) => r.id === id);
    if (!r) return;
    r.nextDueAt = Date.now() + Math.max(30_000, r.everyMinutes * 60_000 * 0.1);
  }
}
