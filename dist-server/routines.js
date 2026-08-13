// Routines — recurring tasks a bot runs on a schedule. The scheduler lives
// in the harness (server/index.ts) because it owns turns: a routine firing
// is just a user-less startTurn, so it flows through the same permission
// broker, event bus, and transcript as anything the human types.
//
// Persisted to ~/.openmausbot/routines.json alongside bots.json. Schedule
// math is pure and lives here so it can be tested without a clock.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { newId } from "./contracts.js";
const ROUTINES_FILE = join(DATA_DIR, "routines.json");
/** A routine that came due while the app was closed fires once if it was
 * missed within this window; anything staler rolls forward silently, so a
 * laptop shut for a week never wakes up to seven stacked runs. */
export const CATCHUP_WINDOW_MS = 60 * 60_000;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_PROMPT = 4_000;
function intIn(value, min, max, field) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`routine: ${field} must be an integer between ${min} and ${max}`);
    }
    return n;
}
/** Decode an untrusted schedule; throws on invalid (same contract as a
 * driver's decodeConfig — callers turn the throw into a 400). */
export function decodeSchedule(raw) {
    const s = raw;
    switch (s?.kind) {
        case "interval":
            return { kind: "interval", minutes: intIn(s.minutes, 1, MAX_INTERVAL_MINUTES, "minutes") };
        case "daily":
            return {
                kind: "daily",
                hour: intIn(s.hour, 0, 23, "hour"),
                minute: intIn(s.minute, 0, 59, "minute"),
            };
        case "weekly":
            return {
                kind: "weekly",
                day: intIn(s.day, 0, 6, "day"),
                hour: intIn(s.hour, 0, 23, "hour"),
                minute: intIn(s.minute, 0, 59, "minute"),
            };
        default:
            throw new Error('routine: schedule.kind must be "interval", "daily", or "weekly"');
    }
}
export function decodePrompt(raw) {
    const text = String(raw ?? "").trim();
    if (!text)
        throw new Error("routine: prompt required");
    if (text.length > MAX_PROMPT)
        throw new Error(`routine: prompt must be under ${MAX_PROMPT} characters`);
    return text;
}
/** The next firing strictly after `from`. Pure — no Date.now() inside. */
export function nextRunAfter(schedule, from) {
    if (schedule.kind === "interval")
        return from + schedule.minutes * 60_000;
    const at = new Date(from);
    at.setHours(schedule.hour, schedule.minute, 0, 0);
    if (schedule.kind === "weekly") {
        at.setDate(at.getDate() + ((schedule.day - at.getDay() + 7) % 7));
        if (at.getTime() <= from)
            at.setDate(at.getDate() + 7);
        return at.getTime();
    }
    if (at.getTime() <= from)
        at.setDate(at.getDate() + 1);
    return at.getTime();
}
/** A short human label for the schedule — shared by the UI and the
 * activity line the bot posts when a routine fires. */
export function describeSchedule(schedule) {
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const clock = (h, m) => `${h}:${String(m).padStart(2, "0")}`;
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
    routines = [];
    constructor(now = Date.now()) {
        mkdirSync(DATA_DIR, { recursive: true });
        try {
            const raw = JSON.parse(readFileSync(ROUTINES_FILE, "utf8"));
            this.routines = Array.isArray(raw) ? raw : [];
        }
        catch {
            this.routines = [];
        }
        // a routine written by a newer build (unknown schedule kind) is dropped
        // rather than crashing the boot — same spirit as a shadow instance
        this.routines = this.routines.filter((r) => {
            try {
                r.schedule = decodeSchedule(r.schedule);
                return true;
            }
            catch {
                return false;
            }
        });
        if (this.rollForwardStale(now))
            this.save();
    }
    /** Missed-run policy on boot: anything staler than the catch-up window
     * jumps to its next future firing. Returns true when something moved. */
    rollForwardStale(now) {
        let moved = false;
        for (const r of this.routines) {
            if (r.nextRunAt < now - CATCHUP_WINDOW_MS) {
                r.nextRunAt = nextRunAfter(r.schedule, now);
                moved = true;
            }
        }
        return moved;
    }
    save() {
        writeFileSync(ROUTINES_FILE, JSON.stringify(this.routines, null, 2));
    }
    all() {
        return this.routines;
    }
    forBot(botId) {
        return this.routines.filter((r) => r.botId === botId).sort((a, b) => a.nextRunAt - b.nextRunAt);
    }
    get(id) {
        return this.routines.find((r) => r.id === id) ?? null;
    }
    create(input, now = Date.now()) {
        const routine = {
            id: newId(),
            botId: input.botId,
            title: (input.title ?? "").trim() || input.prompt.slice(0, 48),
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
    patch(id, patch, now = Date.now()) {
        const routine = this.get(id);
        if (!routine)
            return null;
        Object.assign(routine, patch);
        // a re-scheduled or re-enabled routine restarts its countdown from now
        if (patch.schedule || patch.enabled === true)
            routine.nextRunAt = nextRunAfter(routine.schedule, now);
        this.save();
        return routine;
    }
    /** Routines that should fire at `now`, soonest first. */
    due(now = Date.now()) {
        return this.routines.filter((r) => r.enabled && r.nextRunAt <= now).sort((a, b) => a.nextRunAt - b.nextRunAt);
    }
    /** Stamp a firing and schedule the next one from `now` — never from the
     * missed slot, so a slow turn can't build a backlog. */
    markRan(id, now = Date.now()) {
        const routine = this.get(id);
        if (!routine)
            return null;
        routine.lastRunAt = now;
        routine.nextRunAt = nextRunAfter(routine.schedule, now);
        this.save();
        return routine;
    }
    delete(id) {
        const before = this.routines.length;
        this.routines = this.routines.filter((r) => r.id !== id);
        if (this.routines.length === before)
            return false;
        this.save();
        return true;
    }
    /** Routines die with their bot. */
    deleteForBot(botId) {
        const before = this.routines.length;
        this.routines = this.routines.filter((r) => r.botId !== botId);
        const removed = before - this.routines.length;
        if (removed)
            this.save();
        return removed;
    }
}
