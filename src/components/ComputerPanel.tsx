// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: cloud → provision the box on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll; local ("This Mac") → frames
// come from the Electron main process (desktopCapturer over the preload
// bridge — box endpoints are never touched); off → parked. Auto (unset)
// prefers the cloud box when one exists, else local inside the app.
import { useEffect, useRef, useState } from "react";
import {
  Camera,
  ChevronRight,
  ExternalLink,
  Loader2,
  Monitor,
  Moon,
  Power,
  Radio,
  Settings,
  TerminalSquare,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { RoutinesCard } from "./RoutinesCard";
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
  const liveSrc =
    phase === "local"
      ? localFrame
      : phase === "ready" || phase === "starting"
        ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
        : null;

  // Filmstrip: the last 8 distinct frames of this session. Click a thumb to
  // scrub back in time; the LIVE chip returns to the moving picture.
  const [film, setFilm] = useState<Array<{ src: string; at: number }>>([]);
  const [pinnedAt, setPinnedAt] = useState<number | null>(null);
  useEffect(() => {
    setFilm([]);
    setPinnedAt(null);
  }, [bot.id]);
  useEffect(() => {
    if (!liveSrc) return;
    setFilm((prev) => (prev[prev.length - 1]?.src === liveSrc ? prev : [...prev.slice(-7), { src: liveSrc, at: Date.now() }]));
  }, [liveSrc]);
  const pinnedFrame = pinnedAt !== null ? film.find((f) => f.at === pinnedAt) : null;
  const frameSrc = pinnedFrame?.src ?? liveSrc;

  // Capture-now: force one screenshot instead of waiting for the next tick.
  const [capturing, setCapturing] = useState(false);
  const captureNow = () => {
    setCapturing(true);
    const req =
      phase === "local" && window.ogb
        ? window.ogb.screenFrame().then((url) => url && setLocalFrame(url))
        : api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" }).then(({ png, format }) =>
            setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" }),
          );
    req.catch(() => {}).finally(() => setCapturing(false));
  };

  // Quick command: run one shell line on the bot's box, output inline.
  const [cmd, setCmd] = useState("");
  const [execBusy, setExecBusy] = useState(false);
  const [execLog, setExecLog] = useState<Array<{ cmd: string; out: string; ok: boolean }>>([]);
  useEffect(() => {
    setExecLog([]);
    setCmd("");
  }, [bot.id]);
  const runCmd = () => {
    const command = cmd.trim();
    if (!command || execBusy) return;
    setExecBusy(true);
    setCmd("");
    api(`/api/bots/${bot.id}/computer/exec`, { method: "POST", body: JSON.stringify({ command }) })
      .then((r) => {
        const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
        setExecLog((l) => [...l.slice(-19), { cmd: command, out: out || `(exit ${r.exitCode})`, ok: r.exitCode === 0 }]);
        captureNow(); // the command likely changed the screen
      })
      .catch((e) => setExecLog((l) => [...l.slice(-19), { cmd: command, out: e.message, ok: false }]))
      .finally(() => setExecBusy(false));
  };

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
          <span className="flex items-center gap-1.5">
            {phase === "local" && <span className="text-[11px]">this Mac</span>}
            {(phase === "ready" || phase === "local") && (
              <button
                onClick={captureNow}
                disabled={capturing}
                className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
                title="Capture now"
              >
                {capturing ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
              </button>
            )}
          </span>
        </div>
        <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
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
                      ? "No frames yet — the preview needs Screen Recording permission. After granting, relaunch the app (macOS applies it on next launch)."
                      : "Capturing this Mac's screen…"
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
          {pinnedFrame && (
            <button
              onClick={() => setPinnedAt(null)}
              className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10.5px] font-medium text-white hover:bg-black/85"
              title="Back to live"
            >
              <Radio size={10} /> Back to live
            </button>
          )}
        </div>

        {/* Filmstrip: scrub through the session's recent frames */}
        {film.length > 1 && (
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
            {film.map((f) => (
              <button
                key={f.at}
                onClick={() => setPinnedAt(pinnedAt === f.at ? null : f.at)}
                className={cn(
                  "h-11 w-[72px] shrink-0 overflow-hidden rounded-md border",
                  pinnedAt === f.at
                    ? "border-accent"
                    : pinnedAt === null && f.src === liveSrc
                      ? "border-hairline"
                      : "border-hairline/40 opacity-70 hover:opacity-100",
                )}
                title={new Date(f.at).toLocaleTimeString()}
              >
                <img src={f.src} alt="frame" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}

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

        {/* Quick command: drive the box by hand without leaving the app */}
        {phase === "ready" && (
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
              <TerminalSquare size={16} className="text-ink-secondary" />
              Quick command
            </div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Run one shell line on this bot's computer — the preview refreshes after.
            </div>
            {execLog.length > 0 && (
              <div className="mt-3 max-h-44 overflow-y-auto rounded-lg border border-hairline/40 bg-inset p-2 font-mono text-[11.5px] leading-relaxed">
                {execLog.map((entry, i) => (
                  <div key={i} className={cn(i > 0 && "mt-2 border-t border-hairline/30 pt-2")}>
                    <div className="flex items-center gap-1 text-ink">
                      <ChevronRight size={11} className={entry.ok ? "text-success" : "text-danger"} />
                      <span className="truncate">{entry.cmd}</span>
                    </div>
                    <pre className="mt-0.5 whitespace-pre-wrap break-all pl-4 text-ink-secondary">{entry.out}</pre>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-accent-border">
              <ChevronRight size={13} className="shrink-0 text-ink-secondary" />
              <input
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runCmd()}
                placeholder="xdg-open https://example.com"
                spellCheck={false}
                className="w-full bg-transparent font-mono text-[12.5px] text-ink placeholder:text-ink-secondary/50 focus:outline-none"
              />
              {execBusy && <Loader2 size={13} className="shrink-0 animate-spin text-ink-secondary" />}
            </div>
          </div>
        )}

        {/* Computer source */}
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Runs on</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {bot.computer ? "" : "Auto: the cloud box when one exists, else this Mac. "}Pick where this bot's
            computer lives.
          </div>
          <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
            {(
              [
                ["cloud", "Cloud box"],
                ["local", "This Mac"],
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
        <RoutinesCard bot={bot} />
      </div>
    </aside>
  );
}
