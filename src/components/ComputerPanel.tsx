// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: cloud → provision the box on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll; local ("This Mac") → frames
// come from the Electron main process (desktopCapturer over the preload
// bridge — box endpoints are never touched); off → parked. Auto (unset)
// prefers the cloud box when one exists, else local inside the app.
import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  CalendarClock,
  ExternalLink,
  Loader2,
  Monitor,
  Moon,
  Plus,
  Power,
  Settings,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutineEditor } from "./RoutinesPage";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

function routineScheduleLabel(routine: Routine) {
  if (routine.schedule.type === "once") {
    return new Date(routine.schedule.at).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const days = routine.schedule.weekdays;
  const cadence =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ");
  const [hour, minute] = routine.schedule.time.split(":").map(Number);
  return `${cadence} · ${new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function nextRunLabel(at: number | null) {
  if (at == null) return "Paused";
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `${sameDay ? "Today" : date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function ComputerPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const localAvailable = capabilities.localComputer.available;
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<"join" | "sleep" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  // bumped when a Box API key is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const cloudRoutineReady = Boolean(
    state.config?.box.configured &&
      state.instances.some((instance) => instance.driverKind === "boxAgent" && instance.snapshot.state === "available"),
  );
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );
  const computerDestination =
    bot.computer === "cloud"
      ? "this cloud box"
      : bot.computer === "local"
        ? "this computer"
        : bot.computer === "off"
          ? null
          : phase === "ready"
            ? "the cloud box selected by Auto"
            : "this computer selected by Auto";

  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setLocalFrame(null);
    setError(null);
    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      setPhase(capabilitiesReady && localAvailable ? "local" : "local-unavailable");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    // cloud, or auto (cloud box wins when one exists, else local in-app)
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        const autoLocal = bot.computer !== "cloud" && capabilitiesReady && localAvailable;
        if (!status.configured) {
          setPhase(autoLocal ? "local" : "unconfigured");
          return;
        }
        if (!status.box && autoLocal) {
          setPhase("local");
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoxState(r.state ?? null);
          setPhase("ready");
        });
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [bot.id, bot.computer, retry, capabilitiesReady, localAvailable]);

  // cloud preview: SSE frames win while the bot works; otherwise poll
  const live = state.screens[bot.id];
  const sseFlowing = Boolean(bot.busy && live);
  const inFlight = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || sseFlowing) return;
    let alive = true;
    const shoot = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { png, format } = await api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" });
        if (alive) setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch {
        /* box mid-command or asleep — next tick */
      } finally {
        inFlight.current = false;
      }
    };
    void shoot();
    const timer = setInterval(shoot, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, sseFlowing, bot.id]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (phase !== "local" || !window.ogb) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.ogb!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    const timer = setInterval(shoot, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase]);

  const lastScreenMessage = [...bot.messages].reverse().find((m) => m.kind === "screen" && m.png);
  const cloudFrame =
    live ??
    polledFrame ??
    (lastScreenMessage ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png" } : null);
  const frameSrc =
    phase === "local"
      ? localFrame
      : phase === "ready" || phase === "starting"
        ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
        : null;

  const run = (kind: "join" | "sleep") => {
    setPending(kind);
    setError(null);
    api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
      .then((result) => {
        // the join URL's stream token rotates — always freshly minted, never cached
        if (kind === "join" && result.joinUrl) window.open(result.joinUrl);
        if (kind === "sleep") setBoxState("archived");
      })
      .catch((e) => setError(e.message))
      .finally(() => setPending(null));
  };

  const emptyState: Record<Exclude<Phase, "ready" | "local">, string> = {
    checking: "Checking…",
    starting: "Starting your bot's computer…",
    unconfigured: "No cloud computer configured",
    "local-unavailable":
      capabilities.host.platform === "linux"
        ? "Local computer control isn't available on Linux yet. Use a cloud box instead."
        : capabilities.host.label === "Browser"
          ? "Local computer control requires the desktop app."
          : "CUA Driver isn't ready for local computer control.",
    off: "This bot's computer is off",
    error: "Couldn't reach the computer",
  };

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Bot settings"
        >
          <Settings size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Computer</span>
        <button
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
          {/* Screen preview */}
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            <span>{bot.name}'s screen</span>
            {phase === "local" && <span className="text-[11px]">this computer</span>}
        </div>
        <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {frameSrc ? (
            <img src={frameSrc} alt={`${bot.name}'s screen`} className="h-full w-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "local" ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {phase === "ready"
                  ? "Waiting for the first frame…"
                  : phase === "local"
                    ? localMisses >= 3
                      ? "No frames yet — the preview needs Screen Recording permission. After granting, relaunch the app."
                      : "Capturing this computer's screen…"
                    : emptyState[phase]}
              </span>
              {phase === "local" && localMisses >= 3 && (
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open Settings
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Add a Box API key to give this bot a cloud computer — it spins up right here.
            </div>
            <ApiKeyRow
              section="box"
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}

        {/* Cloud-only actions */}
        {phase === "ready" && (
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => run("join")}
              disabled={pending === "join"}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              Open desktop
            </button>
            {boxState !== "archived" && (
              <button
                onClick={() => run("sleep")}
                disabled={pending === "sleep"}
                className="flex items-center justify-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title="Put the computer to sleep"
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                Sleep
              </button>
            )}
          </div>
        )}

        {/* Computer source */}
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Runs on</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!bot.computer &&
                (localAvailable
                  ? "Auto uses a cloud box when one exists, otherwise this computer. "
                  : "Auto uses a cloud box when one is configured; otherwise computer use stays off. ")}
              Pick where this bot's computer lives.
          </div>
          <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
            {(
              [
                ["cloud", "Cloud box"],
                ["local", "This computer"],
                ["off", "Off"],
              ] as const
            ).map(([mode, label], i) => (
              <button
                key={mode}
                disabled={mode === "local" && !localAvailable}
                title={
                  mode === "local" && !localAvailable
                    ? capabilities.host.platform === "linux"
                      ? "Local computer control isn't available on Linux yet"
                      : capabilities.host.label === "Browser"
                        ? "Local computer control requires the desktop app"
                        : "CUA Driver isn't ready"
                    : undefined
                }
                onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } })}
                className={cn(
                  "flex-1 py-1.5 text-[13px]",
                  i > 0 && "border-l border-hairline/40",
                  mode === "local" && !localAvailable && "cursor-not-allowed opacity-40",
                  bot.computer === mode
                    ? "bg-raised text-ink"
                    : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Routines */}
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
              <CalendarClock size={16} className="text-accent" />
              Routines
            </div>
            {botRoutines.length > 0 && (
              <span className="rounded-full bg-raised px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
                {botRoutines.length}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Schedule work for {bot.name}. Use its current setup, or run the whole job inside its cloud VM.
          </div>
          {!computerDestination && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed text-warning">
              <Power size={13} className="mt-0.5 shrink-0" />
              MAUS-setup routines will not have desktop access while this is Off. Choose Cloud VM in the routine editor to run the whole job there.
            </div>
          )}
          {activeRoutineRun && (
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              className="mt-3 flex w-full items-center gap-2 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-left text-[12px] text-accent hover:bg-accent/15"
            >
              <Loader2 size={13} className={activeRoutineRun.status === "queued" ? "" : "animate-spin"} />
              <span className="min-w-0 flex-1 truncate">
                {activeRoutineRun.routineName} · {activeRoutineRun.status === "waiting" ? "needs you" : activeRoutineRun.status}
              </span>
            </button>
          )}
          {botRoutines.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {botRoutines.slice(0, 3).map((routine) => (
                <button
                  key={routine.id}
                  onClick={() => dispatch({ type: "showRoutines" })}
                  className="flex w-full items-center gap-2 rounded-lg bg-inset px-3 py-2 text-left hover:bg-raised/60"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", routine.enabled ? "bg-success" : "bg-ink-secondary/40")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{routine.name}</span>
                    <span className="block truncate text-[10.5px] text-ink-secondary">
                      {routineScheduleLabel(routine)}{routine.runOn === "cloud" ? " · runs on VM" : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-ink-secondary">{nextRunLabel(routine.nextRunAt)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setCreatingRoutine(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110"
            >
              <Plus size={14} />
              Create routine
            </button>
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
              title="Open routines calendar"
            >
              <CalendarDays size={14} />
              Calendar
            </button>
          </div>
        </div>
      </div>
      {creatingRoutine && (
        <RoutineEditor
          bots={[bot]}
          lockedBotId={bot.id}
          defaultRunOn={cloudRoutineReady ? "cloud" : "maus"}
          onClose={() => setCreatingRoutine(false)}
        />
      )}
    </aside>
  );
}
