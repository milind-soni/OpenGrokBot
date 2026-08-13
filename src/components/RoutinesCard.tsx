// Routines — recurring autonomous tasks for one bot. Lives in the
// Computer panel's card slot; every mutation goes through the harness
// API and comes back via the SSE routine frames, so all clients stay
// in sync without local bookkeeping.
import { useState } from "react";
import {
  CalendarClock,
  Loader2,
  Pause,
  Play,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { api, useStore, type Bot, type Routine, type RoutineSchedule } from "@/state/store";
import { cn } from "@/lib/cn";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

export function scheduleLabel(s: RoutineSchedule): string {
  switch (s.kind) {
    case "interval":
      return s.minutes % 60 === 0 ? `Every ${s.minutes / 60}h` : `Every ${s.minutes}m`;
    case "daily":
      return `Daily ${pad(s.hour)}:${pad(s.minute)}`;
    case "weekly":
      return `${DAYS[s.day]} ${pad(s.hour)}:${pad(s.minute)}`;
  }
}

export function relTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const delta = ts - Date.now();
  const abs = Math.abs(delta);
  const unit =
    abs < 90_000
      ? "now"
      : abs < 60 * 60_000
        ? `${Math.round(abs / 60_000)}m`
        : abs < 36 * 60 * 60_000
          ? `${Math.round(abs / 3_600_000)}h`
          : `${Math.round(abs / 86_400_000)}d`;
  if (unit === "now") return delta >= 0 ? "due now" : "just now";
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}

function RoutineRow({ routine }: { routine: Routine }) {
  const [pending, setPending] = useState<"run" | "toggle" | "delete" | null>(null);
  const act = (kind: "run" | "toggle" | "delete") => {
    setPending(kind);
    const req =
      kind === "run"
        ? api(`/api/routines/${routine.id}/run`, { method: "POST" })
        : kind === "toggle"
          ? api(`/api/routines/${routine.id}`, {
              method: "PATCH",
              body: JSON.stringify({ enabled: !routine.enabled }),
            })
          : api(`/api/routines/${routine.id}`, { method: "DELETE" });
    req.catch(() => {}).finally(() => setPending(null));
  };
  const statusDot = routine.enabled
    ? routine.lastStatus === "error"
      ? "bg-danger"
      : "bg-success"
    : "bg-ink-secondary/40";
  return (
    <div className="group rounded-lg border border-hairline/40 bg-inset px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", statusDot)} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{routine.name}</span>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => act("run")}
            disabled={pending !== null}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            title="Run now"
          >
            {pending === "run" ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
          </button>
          <button
            onClick={() => act("toggle")}
            disabled={pending !== null}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            title={routine.enabled ? "Pause" : "Resume"}
          >
            {pending === "toggle" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : routine.enabled ? (
              <Pause size={13} />
            ) : (
              <Play size={13} />
            )}
          </button>
          <button
            onClick={() => act("delete")}
            disabled={pending !== null}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-40"
            title="Delete routine"
          >
            {pending === "delete" ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          </button>
        </div>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[11.5px] text-ink-secondary">
        <span>{scheduleLabel(routine.schedule)}</span>
        <span>·</span>
        <span>{routine.enabled ? `next ${relTime(routine.nextRunAt)}` : "paused"}</span>
        {routine.lastStatus === "error" && (
          <span className="truncate text-danger" title={routine.lastError}>
            · last run failed
          </span>
        )}
        {routine.lastStatus === "skipped-busy" && <span>· last run skipped (busy)</span>}
      </div>
    </div>
  );
}

function CreateRoutineForm({ botId, onDone }: { botId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<RoutineSchedule["kind"]>("daily");
  const [minutes, setMinutes] = useState(60);
  const [time, setTime] = useState("09:00");
  const [day, setDay] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const [hour, minute] = time.split(":").map((v) => Number(v) || 0);
    const schedule: RoutineSchedule =
      kind === "interval"
        ? { kind, minutes }
        : kind === "daily"
          ? { kind, hour, minute }
          : { kind, day, hour, minute };
    setSaving(true);
    setError(null);
    api("/api/routines", {
      method: "POST",
      body: JSON.stringify({ botId, name, prompt, schedule }),
    })
      .then(onDone)
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const field = "w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary/60 focus:border-accent-border focus:outline-none";
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-hairline/40 bg-inset/60 p-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name — e.g. Morning brief"
        className={field}
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should the bot do each run?"
        rows={3}
        className={cn(field, "resize-none")}
      />
      <div className="flex overflow-hidden rounded-lg border border-hairline/40">
        {(
          [
            ["interval", "Every…"],
            ["daily", "Daily"],
            ["weekly", "Weekly"],
          ] as const
        ).map(([k, label], i) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={cn(
              "flex-1 py-1.5 text-[12.5px]",
              i > 0 && "border-l border-hairline/40",
              kind === k ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        {kind === "interval" ? (
          <label className="flex flex-1 items-center gap-2 text-[12.5px] text-ink-secondary">
            every
            <input
              type="number"
              min={5}
              max={10080}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value) || 5)}
              className={cn(field, "w-20 flex-none")}
            />
            minutes
          </label>
        ) : (
          <>
            {kind === "weekly" && (
              <select value={day} onChange={(e) => setDay(Number(e.target.value))} className={cn(field, "flex-1")}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            )}
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={cn(field, "flex-1")} />
          </>
        )}
      </div>
      {error && <div className="text-[12px] text-danger">{error}</div>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={saving || !name.trim() || !prompt.trim()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          Create
        </button>
        <button
          onClick={onDone}
          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function RoutinesCard({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const [creating, setCreating] = useState(false);
  const mine = state.routines
    .filter((r) => r.botId === bot.id)
    .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
          <CalendarClock size={16} className="text-ink-secondary" />
          Routines
        </div>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Plus size={13} /> New
          </button>
        )}
      </div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Recurring tasks this bot runs on its own — same approvals, no typing.
      </div>
      {mine.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {mine.map((r) => (
            <RoutineRow key={r.id} routine={r} />
          ))}
        </div>
      )}
      {creating ? (
        <CreateRoutineForm botId={bot.id} onDone={() => setCreating(false)} />
      ) : (
        mine.length === 0 && (
          <button
            onClick={() => setCreating(true)}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover"
          >
            <Plus size={14} />
            Create Routine
          </button>
        )
      )}
    </div>
  );
}
