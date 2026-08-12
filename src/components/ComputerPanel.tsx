// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: cloud → provision the box on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll; local ("This Mac") → frames
// come from the Electron main process (desktopCapturer over the preload
// bridge — box endpoints are never touched); off → parked. Auto (unset)
// prefers the cloud box when one exists, else local inside the app.
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  CalendarClock,
  Check,
  Circle,
  ExternalLink,
  Loader2,
  Monitor,
  Moon,
  Pause,
  Play,
  Power,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";

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

interface Routine {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  everyMinutes: number;
  enabled: boolean;
  lastRunAt: number | null;
  createdAt: number;
}

interface MacroAction {
  t: number;
  type: "move" | "down" | "up" | "wheel" | "key";
  x?: number;
  y?: number;
  button?: string;
  delta?: number;
  vk?: number;
  ext?: boolean;
  down?: boolean;
}

interface Macro {
  id: string;
  botId: string;
  name: string;
  actions: MacroAction[];
  durationMs: number;
  createdAt: number;
}

function formatRoutineTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ComputerPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<"join" | "sleep" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // bumped when a Box token is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);

  // ── routines ─────────────────────────────────────────────────────────
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [showRoutineForm, setShowRoutineForm] = useState(false);
  const [routineName, setRoutineName] = useState("");
  const [routinePrompt, setRoutinePrompt] = useState("");
  const [routineInterval, setRoutineInterval] = useState("60");
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [pendingRoutine, setPendingRoutine] = useState<string | null>(null);
  const [routineError, setRoutineError] = useState<string | null>(null);

  const loadRoutines = () => {
    api("/api/routines")
      .then(({ routines }) => setRoutines(routines.filter((r: Routine) => r.botId === bot.id)))
      .catch((e) => setRoutineError(e.message));
  };
  useEffect(() => {
    loadRoutines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const saveRoutine = () => {
    if (!routinePrompt.trim()) return;
    setSavingRoutine(true);
    setRoutineError(null);
    api("/api/routines", {
      method: "POST",
      body: JSON.stringify({
        botId: bot.id,
        name: routineName.trim() || "Untitled routine",
        prompt: routinePrompt.trim(),
        everyMinutes: Number(routineInterval) || 60,
      }),
    })
      .then(() => {
        setShowRoutineForm(false);
        setRoutineName("");
        setRoutinePrompt("");
        loadRoutines();
      })
      .catch((e) => setRoutineError(e.message))
      .finally(() => setSavingRoutine(false));
  };

  const runRoutine = (id: string) => {
    setPendingRoutine(id);
    setRoutineError(null);
    api(`/api/routines/${id}/run`, { method: "POST" })
      .then(loadRoutines)
      .catch((e) => setRoutineError(e.message))
      .finally(() => setPendingRoutine(null));
  };

  const toggleRoutine = (r: Routine) => {
    setRoutineError(null);
    api(`/api/routines/${r.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !r.enabled }),
    })
      .then(loadRoutines)
      .catch((e) => setRoutineError(e.message));
  };

  const deleteRoutine = (id: string) => {
    setRoutineError(null);
    api(`/api/routines/${id}`, { method: "DELETE" })
      .then(loadRoutines)
      .catch((e) => setRoutineError(e.message));
  };

  // ── macros (record/replay this computer's input) ────────────────────
  const canMacro = Boolean(window.ogb?.macroRecordStart && window.ogb?.macroReplay);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [recording, setRecording] = useState(false);
  const [macroName, setMacroName] = useState("");
  const [savingMacro, setSavingMacro] = useState(false);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [macroError, setMacroError] = useState<string | null>(null);
  const [macroInfo, setMacroInfo] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<MacroAction[] | null>(null);

  const loadMacros = () => {
    api("/api/macros")
      .then(({ macros }) => setMacros(macros.filter((m: Macro) => m.botId === bot.id)))
      .catch((e) => setMacroError(e.message));
  };
  useEffect(() => {
    loadMacros();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const toggleRecording = async () => {
    setMacroError(null);
    setMacroInfo(null);
    if (!recording) {
      const res = await window.ogb!.macroRecordStart();
      if (!res.ok) return setMacroError(res.error ?? "couldn't start recording");
      setRecording(true);
      setMacroInfo("Recording… do your thing, then stop. Your input is captured on this computer.");
    } else {
      const res = await window.ogb!.macroRecordStop();
      setRecording(false);
      if (!res.ok || !res.actions?.length) {
        setMacroError(res.error ?? "nothing was recorded");
        setMacroInfo(null);
        return;
      }
      setPendingActions(res.actions);
      setMacroName("");
      setMacroInfo(`Recorded ${res.actions.length} events — name it and save, or discard.`);
    }
  };

  const saveMacro = () => {
    if (!pendingActions) return;
    setSavingMacro(true);
    setMacroError(null);
    api("/api/macros", {
      method: "POST",
      body: JSON.stringify({ botId: bot.id, name: macroName.trim() || "Untitled macro", actions: pendingActions }),
    })
      .then(() => {
        setPendingActions(null);
        setMacroInfo(null);
        loadMacros();
      })
      .catch((e) => setMacroError(e.message))
      .finally(() => setSavingMacro(false));
  };

  const replayMacro = async (m: Macro) => {
    setReplayingId(m.id);
    setMacroError(null);
    setMacroInfo(null);
    try {
      const res = await window.ogb!.macroReplay(m.actions);
      if (!res.ok) setMacroError(res.error ?? "replay failed");
      else setMacroInfo(`Replayed ${res.events ?? m.actions.length} events.`);
    } catch (e) {
      setMacroError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplayingId(null);
    }
  };

  const deleteMacro = (id: string) => {
    setMacroError(null);
    api(`/api/macros/${id}`, { method: "DELETE" })
      .then(loadMacros)
      .catch((e) => setMacroError(e.message));
  };

  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setLocalFrame(null);
    setError(null);
    const isElectron = Boolean(window.ogb);
    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      setPhase(isElectron ? "local" : "local-unavailable");
      return;
    }
    // cloud, or auto (cloud box wins when one exists, else local in-app)
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        const autoLocal = bot.computer !== "cloud" && isElectron;
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
  }, [bot.id, bot.computer, retry]);

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

  // local preview: frames from the Electron main process
  useEffect(() => {
    if (phase !== "local" || !window.ogb) return;
    let alive = true;
    const shoot = async () => {
      try {
        const url = await window.ogb!.screenFrame();
        if (alive && url) setLocalFrame(url);
      } catch {
        /* capture denied or transient — next tick */
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
    "local-unavailable": "Local preview needs the desktop app — run pnpm dev:desktop",
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
                    ? "Capturing this Mac's screen…"
                    : emptyState[phase]}
              </span>
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
              Paste a Box token from box.ascii.dev to give this bot a cloud computer — it spins up right here.
            </div>
            <ApiKeyRow
              section="box"
              label="Box token"
              placeholder="Token from box.ascii.dev"
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
                {bot.computer ? "" : "Auto: the cloud box when one exists, else this computer. "}Pick where this
                bot's computer lives.
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
                onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } })}
                className={cn(
                  "flex-1 py-1.5 text-[13px]",
                  i > 0 && "border-l border-hairline/40",
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
          <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <CalendarClock size={16} className="text-ink-secondary" />
            Routines
          </div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Recurring tasks this agent runs on a schedule — like you asked it yourself.
          </div>

          {routineError && <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{routineError}</div>}

          {routines.length > 0 && (
            <ul className="mt-3 space-y-2">
              {routines.map((r) => (
                <li key={r.id} className="rounded-lg border border-hairline/40 bg-inset p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-ink">{r.name}</div>
                      <div className="truncate text-[11px] text-ink-secondary">
                        every {r.everyMinutes} min{r.lastRunAt ? ` · last ran ${formatRoutineTime(r.lastRunAt)}` : " · never ran"}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => runRoutine(r.id)}
                        disabled={pendingRoutine === r.id}
                        className="rounded-md px-1.5 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                        title="Run now"
                      >
                        {pendingRoutine === r.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      </button>
                      <button
                        onClick={() => toggleRoutine(r)}
                        className={cn(
                          "rounded-md px-1.5 py-1 text-[11px] hover:bg-raised",
                          r.enabled ? "text-success" : "text-ink-secondary",
                        )}
                        title={r.enabled ? "Pause" : "Resume"}
                      >
                        <Pause size={12} />
                      </button>
                      <button
                        onClick={() => deleteRoutine(r.id)}
                        className="rounded-md px-1.5 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-danger"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {showRoutineForm ? (
            <div className="mt-3 space-y-2">
              <input
                value={routineName}
                onChange={(e) => setRoutineName(e.target.value)}
                placeholder="Name (e.g. Daily report)"
                className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
              <textarea
                value={routinePrompt}
                onChange={(e) => setRoutinePrompt(e.target.value)}
                placeholder="What should it do each run? (e.g. summarize today's chats and post the summary on X)"
                rows={3}
                className="w-full resize-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
              <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <span>every</span>
                <input
                  type="number"
                  min={1}
                  value={routineInterval}
                  onChange={(e) => setRoutineInterval(e.target.value)}
                  className="w-16 rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[13px] text-ink focus:border-hairline focus:outline-none"
                />
                <span>minutes</span>
                <button
                  onClick={saveRoutine}
                  disabled={savingRoutine || !routinePrompt.trim()}
                  className="ml-auto flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingRoutine ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  Save
                </button>
              </div>
              <button
                onClick={() => setShowRoutineForm(false)}
                className="w-full text-center text-[12px] text-ink-secondary hover:text-ink"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowRoutineForm(true)}
              className="mt-3 w-full rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              Create Routine
            </button>
          )}
        </div>

        {/* Macros */}
        {canMacro && (
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
              <Activity size={16} className="text-ink-secondary" />
              Macros
            </div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Record your mouse & keyboard on this computer, then replay the whole thing anytime.
            </div>

            {macroError && (
              <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                {macroError}
              </div>
            )}
            {macroInfo && (
              <div className="mt-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[12px] text-success">
                {macroInfo}
              </div>
            )}

            {macros.length > 0 && (
              <ul className="mt-3 space-y-2">
                {macros.map((m) => (
                  <li key={m.id} className="rounded-lg border border-hairline/40 bg-inset p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink">{m.name}</div>
                        <div className="text-[11px] text-ink-secondary">
                          {m.actions.length} events · {(m.durationMs / 1000).toFixed(1)}s
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => replayMacro(m)}
                          disabled={replayingId === m.id}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink hover:bg-raised disabled:opacity-50"
                          title="Replay"
                        >
                          {replayingId === m.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                          Replay
                        </button>
                        <button
                          onClick={() => deleteMacro(m.id)}
                          className="rounded-md px-1.5 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-danger"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {pendingActions ? (
              <div className="mt-3 space-y-2">
                <input
                  value={macroName}
                  onChange={(e) => setMacroName(e.target.value)}
                  placeholder="Name this macro (e.g. Log into X)"
                  className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={saveMacro}
                    disabled={savingMacro}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                  >
                    {savingMacro ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    Save macro
                  </button>
                  <button
                    onClick={() => setPendingActions(null)}
                    className="flex-1 rounded-lg bg-raised py-2 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
                  >
                    Discard
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={toggleRecording}
                className={cn(
                  "mt-3 flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[13px]",
                  recording
                    ? "bg-danger text-white hover:opacity-90"
                    : "bg-raised text-ink hover:bg-raised-hover",
                )}
              >
                {recording ? (
                  <>
                    <Square size={13} /> Stop recording
                  </>
                ) : (
                  <>
                    <Circle size={13} className="text-danger" /> Record a macro
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
