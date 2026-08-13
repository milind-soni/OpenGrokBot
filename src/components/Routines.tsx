// Routines — the recurring tasks a bot runs on a schedule. The harness owns
// the clock (server/routines.ts fires them as user-less turns), so this is a
// thin CRUD view over /api/bots/:id/routines that re-reads while it's open,
// letting a firing move the countdown without a manual refresh.
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";

type Schedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number };

interface Routine {
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

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const INTERVALS: Array<[number, string]> = [
  [15, "15 minutes"],
  [30, "30 minutes"],
  [60, "hour"],
  [180, "3 hours"],
  [360, "6 hours"],
  [720, "12 hours"],
];

/** Mirror of the server's describeSchedule — a shared label is not worth a
 * package boundary between the app and the harness. */
function describeSchedule(s: Schedule): string {
  const clock = (h: number, m: number) => `${h}:${String(m).padStart(2, "0")}`;
  if (s.kind === "daily") return `Every day at ${clock(s.hour, s.minute)}`;
  if (s.kind === "weekly") return `Every ${DAYS[s.day]} at ${clock(s.hour, s.minute)}`;
  if (s.minutes % 1440 === 0) return s.minutes === 1440 ? "Every day" : `Every ${s.minutes / 1440} days`;
  if (s.minutes % 60 === 0) return s.minutes === 60 ? "Every hour" : `Every ${s.minutes / 60} hours`;
  return `Every ${s.minutes} minutes`;
}

function countdown(nextRunAt: number): string {
  const ms = nextRunAt - Date.now();
  if (ms <= 0) return "any moment now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function Routines({ botId }: { botId: string }) {
  const [loaded, setLoaded] = useState<{ botId: string; routines: Routine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadRequest = useRef(0);
  const activeBotId = useRef(botId);
  activeBotId.current = botId;
  const routines = loaded?.botId === botId ? loaded.routines : null;

  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<Schedule["kind"]>("daily");
  const [minutes, setMinutes] = useState(60);
  const [time, setTime] = useState("09:00");
  const [day, setDay] = useState(1);

  const load = useCallback(() => {
    if (activeBotId.current !== botId) return;
    const request = ++loadRequest.current;
    api(`/api/bots/${botId}/routines`)
      .then((body) => {
        if (request !== loadRequest.current || activeBotId.current !== botId) return;
        if (!Array.isArray(body.routines)) throw new Error("Invalid routines response");
        setLoaded({ botId, routines: body.routines });
        setError(null);
      })
      .catch((e) => {
        if (request !== loadRequest.current || activeBotId.current !== botId) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [botId]);

  // re-read while the panel is open: the countdown ticks and a routine that
  // fires server-side should move on its own
  useEffect(() => {
    setLoaded(null);
    setError(null);
    setComposing(false);
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      loadRequest.current += 1;
      clearInterval(timer);
    };
  }, [load]);

  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await run();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    const [hour, minute] = time.split(":").map(Number);
    if (
      kind !== "interval" &&
      (!Number.isInteger(hour) ||
        !Number.isInteger(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59)
    ) {
      setError("Enter a valid time between 00:00 and 23:59.");
      return;
    }
    const schedule: Schedule =
      kind === "interval"
        ? { kind: "interval", minutes }
        : kind === "daily"
          ? { kind: "daily", hour, minute }
          : { kind: "weekly", day, hour, minute };
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${botId}/routines`, { method: "POST", body: JSON.stringify({ prompt, schedule }) });
      setPrompt("");
      setComposing(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
        <CalendarClock size={16} className="text-ink-secondary" />
        Routines
      </div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Routines are recurring tasks this agent runs on a schedule.
      </div>

      {routines === null ? (
        <div className="mt-3 flex items-center justify-center gap-2 py-4 text-[13px] text-ink-secondary">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : (
        routines.length > 0 && (
          <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
            {routines.map((routine, i) => (
              <div key={routine.id} className={cn("bg-inset px-3 py-2.5", i > 0 && "border-t border-hairline/40")}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">{routine.title}</div>
                    <div className="mt-0.5 text-[12px] text-ink-secondary">
                      {describeSchedule(routine.schedule)}
                      {routine.enabled ? ` · ${countdown(routine.nextRunAt)}` : " · paused"}
                    </div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={routine.enabled}
                    aria-label={routine.enabled ? "Pause routine" : "Resume routine"}
                    disabled={busyId === routine.id}
                    onClick={() =>
                      act(routine.id, () =>
                        api(`/api/routines/${routine.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ enabled: !routine.enabled }),
                        }),
                      )
                    }
                    className={cn(
                      "relative mt-0.5 h-[20px] w-[34px] shrink-0 rounded-full transition-colors disabled:opacity-50",
                      routine.enabled ? "bg-accent" : "bg-raised",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-[3px] size-[14px] rounded-full bg-white transition-all",
                        routine.enabled ? "left-[17px]" : "left-[3px]",
                      )}
                    />
                  </button>
                  <button
                    title="Run now"
                    aria-label="Run now"
                    disabled={busyId === routine.id}
                    onClick={() => act(routine.id, () => api(`/api/routines/${routine.id}/run`, { method: "POST" }))}
                    className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                  >
                    {busyId === routine.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  </button>
                  <button
                    title="Delete routine"
                    aria-label="Delete routine"
                    disabled={busyId === routine.id}
                    onClick={() =>
                      act(routine.id, () => api(`/api/routines/${routine.id}`, { method: "DELETE" }))
                    }
                    className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}

      {composing ? (
        <div className="mt-3 rounded-lg border border-hairline/40 bg-inset p-3">
          <textarea
            autoFocus
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should this bot do? e.g. Summarize my unread email and flag anything urgent."
            className={cn(fieldClass, "resize-none")}
          />
          <div className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
            {(
              [
                ["interval", "Repeating"],
                ["daily", "Daily"],
                ["weekly", "Weekly"],
              ] as const
            ).map(([value, label], i) => (
              <button
                key={value}
                onClick={() => setKind(value)}
                className={cn(
                  "flex-1 py-1.5 text-[12px]",
                  i > 0 && "border-l border-hairline/40",
                  kind === value ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-2 flex items-center gap-2">
            {kind === "interval" ? (
              <>
                <span className="text-[13px] text-ink-secondary">Every</span>
                <select
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                  className={cn(fieldClass, "flex-1")}
                >
                  {INTERVALS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                {kind === "weekly" && (
                  <select
                    value={day}
                    onChange={(e) => setDay(Number(e.target.value))}
                    className={cn(fieldClass, "flex-1")}
                  >
                    {DAYS.map((label, value) => (
                      <option key={label} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                <span className="text-[13px] text-ink-secondary">at</span>
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className={cn(fieldClass, "flex-1")}
                />
              </>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              disabled={!prompt.trim() || saving}
              onClick={create}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {saving && <Loader2 size={13} className="animate-spin" />}
              Create
            </button>
            <button
              onClick={() => (setComposing(false), setError(null))}
              className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setComposing(true)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover"
        >
          <Plus size={14} />
          Create Routine
        </button>
      )}
    </div>
  );
}
