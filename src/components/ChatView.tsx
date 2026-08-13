import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Check, ChevronLeft, ChevronRight, Loader2, Monitor, Pencil, Square, X } from "lucide-react";
import { useStore, formatTime, messageVersions, visibleMessages, type Bot, type Message } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard } from "./OptionCard";
import { Composer } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { cn } from "@/lib/cn";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className="w-full max-w-[70%] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  editing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  bot: Bot;
  message: Message;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
}) {
  const { dispatch } = useStore();
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const collapsible =
    user && !expanded && (text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };

  return (
    <div className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
      <div className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {/* editing rewinds the thread, so it waits for the turn to end —
            same rule as the version switcher below */}
        {user && message.kind === "text" && !bot.busy && (
          <button
            onClick={onStartEdit}
            className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink group-hover:opacity-100"
            title="Edit message"
          >
            <Pencil size={14} />
          </button>
        )}
        <div
          className={cn(
            "max-w-[70%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
            user ? "whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
          )}
        >
          {user ? (
            <>
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
              >
                {text}
              </div>
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show full message
                </button>
              )}
            </>
          ) : (
            <ChatMarkdown text={text} />
          )}
        </div>
      </div>
      {versions.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Previous version"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Next version"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. */
function ActivityChip({ message }: { message: Message }) {
  const tool = message.tool;
  if (!tool) return null;
  const failed = tool.ok === false;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          // min-w-0 lets the label truncate at the column width — a long
          // tool name (or routine title) must never widen the transcript
          "flex min-w-0 max-w-full items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
          failed ? "text-danger" : "text-ink-secondary",
        )}
      >
        {tool.ok === undefined ? (
          <Loader2 size={13} className="animate-spin" />
        ) : failed ? (
          <X size={13} className="shrink-0" />
        ) : (
          <Check size={13} className="shrink-0 text-success" />
        )}
        <span className="min-w-0 max-w-[480px] truncate font-mono">{tool.name}</span>
      </div>
    </div>
  );
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Bot's screen"
        className="max-w-[70%] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[70%] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        <ChatMarkdown text={text} streaming />
        <span className="ml-0.5 inline-block h-[14px] w-[2px] animate-pulse bg-ink-secondary align-middle" />
      </div>
    </div>
  );
}

/** "Working for 12s" that ticks by mutating textContent on an interval —
 * no React commit per second while a turn streams (upstream trick). */
function WorkingTimer({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = `Working for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={ref} className="text-[12.5px] text-ink-secondary" />;
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const streaming = state.streaming[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id]);
  const submitEdit = (messageId: string, text: string) => {
    setEditingId(null); // closes the editor first — a double Enter can't fork twice
    dispatch({ type: "editMessage", botId: bot.id, messageId, text });
  };
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user" && m.kind === "text");

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const touchY = useRef(0);

  useEffect(() => setFollow(true), [bot.id]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bot.id, messages.length, streaming, bot.busy, follow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const jumpToLatest = () => {
    setFollow(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const first = messages[0];

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings" })}
          className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-raised/50"
          title="Bot settings"
        >
          <MausAvatar
            color={bot.color}
            state={stateForBot({ ...bot, messages })}
            size={28}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
          <span className="text-[15px] font-semibold text-ink">{bot.name}</span>
          {bot.busy && <Loader2 size={14} className="animate-spin text-ink-secondary" />}
        </button>
        <div className="flex items-center gap-2">
          {bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              title="Stop this turn"
            >
              <Square size={12} className="fill-current" />
              Stop
            </button>
          )}
          <ModelPicker bot={bot} />
          <button
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Bot's computer"
          >
            <Monitor size={18} />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {state.error && (
        <div className="mx-auto w-full max-w-[900px] px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onScroll={() => {
          if (!follow && atEnd()) setFollow(true);
        }}
      >
        <div className="mx-auto flex max-w-[900px] flex-col gap-3 pb-4">
          {first && (
            <div className="py-3 text-center text-[13px] text-ink-secondary">
              Today {formatTime(first.at)}
            </div>
          )}
          {messages.map((m) => {
            switch (m.kind) {
              case "options":
                return <OptionCard key={m.id} botId={bot.id} message={m} />;
              case "activity":
                return <ActivityChip key={m.id} message={m} />;
              case "screen":
                return m.png ? <ScreenFrame key={m.id} png={m.png} mime={m.mime} /> : null;
              default:
                return (
                  <Bubble
                    key={m.id}
                    bot={bot}
                    message={m}
                    editing={editingId === m.id}
                    onStartEdit={() => setEditingId(m.id)}
                    onCancelEdit={() => setEditingId(null)}
                    onSubmitEdit={(text) => submitEdit(m.id, text)}
                  />
                );
            }
          })}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                Setting up this bot's computer…
              </div>
            </div>
          )}
          {streaming ? (
            <StreamingBubble text={streaming} />
          ) : (
            bot.busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
                  </span>
                  <WorkingTimer since={lastUserMessage?.at ?? Date.now()} />
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Reading scrollback while new content arrives — one tap back to live */}
      {!follow && (bot.busy || Boolean(streaming)) && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}

      {/* keyed by bot: a draft belongs to the conversation it was typed in,
          so switching bots starts from an empty composer instead of carrying
          the previous bot's half-written message over */}
      <Composer
        key={bot.id}
        bot={bot}
        onEditLast={lastUserMessage ? () => setEditingId(lastUserMessage.id) : undefined}
      />

    </main>
  );
}
