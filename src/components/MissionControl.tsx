// Mission Control (⌘⇧M) — the whole fleet on one screen. Every bot is a
// live card: mascot state, streaming text as it arrives, the latest tool
// run, a live frame of its computer, and the next scheduled routine. Pure
// projection of store state — zero transports, zero new endpoints.
import { useEffect, useMemo } from "react";
import {
  Activity,
  ArrowUpRight,
  CalendarClock,
  Grid2x2,
  Loader2,
  Monitor,
  Square,
  X,
  Zap,
} from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { relTime, scheduleLabel } from "./RoutinesCard";
import { cn } from "@/lib/cn";

function statusLine(bot: Bot, streaming?: string): { label: string; tone: "busy" | "unread" | "idle" } {
  if (bot.busy) return { label: streaming ? "Replying…" : "Working…", tone: "busy" };
  if (bot.unread) return { label: "New reply", tone: "unread" };
  const last = bot.messages[bot.messages.length - 1];
  if (!last) return { label: "Idle", tone: "idle" };
  const ago = relTime(last.at);
  return { label: `Idle · ${ago === "just now" ? "just now" : `active ${ago}`}`, tone: "idle" };
}

function BotCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const streaming = state.streaming[bot.threadId];
  const screen = state.screens[bot.id];
  const status = statusLine(bot, streaming);
  const lastActivity = [...bot.messages].reverse().find((m) => m.kind === "activity")?.tool;
  const lastScreenMessage = [...bot.messages].reverse().find((m) => m.kind === "screen" && m.png);
  const frame = screen ?? (lastScreenMessage ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png" } : null);
  const nextRoutine = state.routines
    .filter((r) => r.botId === bot.id && r.enabled && r.nextRunAt)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
  const preview =
    streaming ??
    [...bot.messages].reverse().find((m) => m.kind === "text" && m.text)?.text ??
    "";

  const open = (surface?: "computer") => {
    dispatch({ type: "select", id: bot.id });
    dispatch({ type: "toggleMissionControl", open: false });
    if (surface === "computer") dispatch({ type: "toggleComputer", open: true });
  };

  return (
    <div
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border bg-panel text-left transition-colors",
        bot.busy ? "mc-live border-accent/50" : "border-hairline/50 hover:border-hairline",
      )}
    >
      <button onClick={() => open()} className="flex items-start gap-3 px-4 pb-2 pt-4 text-left">
        <MausAvatar color={bot.color} state={stateForBot(bot)} size={44} motion="none" motionKey={0} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-ink">{bot.name}</span>
            {bot.busy && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px]">
            <span
              className={cn(
                "size-1.5 rounded-full",
                status.tone === "busy" ? "bg-accent" : status.tone === "unread" ? "bg-success" : "bg-ink-secondary/40",
              )}
            />
            <span
              className={cn(
                status.tone === "busy" ? "text-accent" : status.tone === "unread" ? "text-success" : "text-ink-secondary",
              )}
            >
              {status.label}
            </span>
          </div>
        </div>
        <span className="rounded-md border border-hairline/50 bg-inset px-1.5 py-0.5 text-[10.5px] text-ink-secondary">
          {bot.modelSelection.model}
        </span>
      </button>

      {/* live surface: screen frame beats text preview */}
      <button onClick={() => open()} className="mx-4 mb-3 mt-1 flex-1 text-left">
        {frame ? (
          <div className="relative overflow-hidden rounded-lg border border-hairline/40 bg-card">
            <img
              src={`data:${frame.mime};base64,${frame.png}`}
              alt={`${bot.name}'s screen`}
              className="aspect-[16/9] w-full object-cover"
            />
            {bot.busy && screen && (
              <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white">
                <span className="size-1.5 animate-pulse rounded-full bg-danger" /> LIVE
              </span>
            )}
          </div>
        ) : (
          <div
            className={cn(
              "line-clamp-3 min-h-[52px] text-[13px] leading-relaxed",
              streaming ? "text-ink" : "text-ink-secondary",
            )}
          >
            {preview || "No conversation yet — say hello."}
            {streaming && <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-ink-secondary align-middle" />}
          </div>
        )}
      </button>

      <div className="flex items-center gap-2 border-t border-hairline/40 bg-inset/40 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px] text-ink-secondary">
          {bot.busy && lastActivity ? (
            <>
              <Activity size={12} className="shrink-0" />
              <span className="truncate font-mono">{lastActivity.name}</span>
            </>
          ) : nextRoutine ? (
            <>
              <CalendarClock size={12} className="shrink-0" />
              <span className="truncate">
                {nextRoutine.name} · {relTime(nextRoutine.nextRunAt)}
              </span>
            </>
          ) : (
            <span className="truncate">{bot.title || "No routines scheduled"}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {bot.busy ? (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-danger"
              title="Stop this turn"
            >
              <Square size={13} className="fill-current" />
            </button>
          ) : (
            nextRoutine && (
              <button
                onClick={() => void api(`/api/routines/${nextRoutine.id}/run`, { method: "POST" }).catch(() => {})}
                className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                title={`Run "${nextRoutine.name}" now`}
              >
                <Zap size={13} />
              </button>
            )
          )}
          <button
            onClick={() => open("computer")}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Computer"
          >
            <Monitor size={13} />
          </button>
          <button
            onClick={() => open()}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Open chat"
          >
            <ArrowUpRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function MissionControl() {
  const { state, dispatch } = useStore();
  const close = () => dispatch({ type: "toggleMissionControl", open: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bots = state.bots.filter((b) => !b.hidden);
  const working = bots.filter((b) => b.busy).length;
  const unread = bots.filter((b) => b.unread).length;
  const scheduled = state.routines.filter((r) => r.enabled).length;

  const upcoming = useMemo(
    () =>
      state.routines
        .filter((r) => r.enabled && r.nextRunAt)
        .sort((a, b) => a.nextRunAt! - b.nextRunAt!)
        .slice(0, 4),
    [state.routines],
  );
  const botName = (id: string) => state.bots.find((b) => b.id === id)?.name ?? "?";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-app/97 backdrop-blur-sm">
      {/* Header */}
      <div className="mx-auto flex w-full max-w-[1240px] items-center gap-4 px-8 pb-2 pt-7">
        <div className="flex items-center gap-2.5">
          <Grid2x2 size={20} className="text-accent" />
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">Mission Control</h1>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <span className="rounded-full border border-hairline/50 bg-panel px-2.5 py-1">
            {bots.length} bot{bots.length === 1 ? "" : "s"}
          </span>
          <span
            className={cn(
              "rounded-full border px-2.5 py-1",
              working ? "border-accent/40 bg-accent/10 text-accent" : "border-hairline/50 bg-panel",
            )}
          >
            {working} working
          </span>
          {unread > 0 && (
            <span className="rounded-full border border-success/40 bg-success/10 px-2.5 py-1 text-success">
              {unread} unread
            </span>
          )}
          <span className="rounded-full border border-hairline/50 bg-panel px-2.5 py-1">
            {scheduled} routine{scheduled === 1 ? "" : "s"} scheduled
          </span>
        </div>
        <button
          onClick={close}
          className="ml-auto rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Close (Esc)"
        >
          <X size={20} />
        </button>
      </div>

      {/* Fleet grid */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1240px] grid-cols-1 gap-4 px-8 py-4 sm:grid-cols-2 xl:grid-cols-3">
          {bots.map((b) => (
            <BotCard key={b.id} bot={b} />
          ))}
        </div>
      </div>

      {/* Upcoming routines strip */}
      {upcoming.length > 0 && (
        <div className="border-t border-hairline/40 bg-panel/80">
          <div className="mx-auto flex w-full max-w-[1240px] items-center gap-3 overflow-x-auto px-8 py-3">
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary/70">
              <CalendarClock size={12} /> Up next
            </span>
            {upcoming.map((r) => (
              <span
                key={r.id}
                className="flex shrink-0 items-center gap-2 rounded-full border border-hairline/50 bg-inset px-3 py-1 text-[12px] text-ink-secondary"
              >
                <span className="font-medium text-ink">{botName(r.botId)}</span>
                {r.name} · {scheduleLabel(r.schedule)} · {relTime(r.nextRunAt)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
