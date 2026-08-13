// Command Palette (⌘K) — one keystroke to anywhere. Fuzzy-matches bots,
// app surfaces, and per-bot actions; free text becomes "send to bot"
// dispatch rows so a message can be fired at ANY bot without leaving the
// keyboard. Pure overlay: every result maps to existing store actions.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Grid2x2,
  MessageSquare,
  Monitor,
  Plus,
  Puzzle,
  Search,
  Send,
  Settings,
  Square,
  UserRound,
} from "lucide-react";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";

/** Subsequence fuzzy score: higher is better, null = no match. Word-start
 * and contiguous hits win; everything is lowercase-folded. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    streak = found === ti ? streak + 1 : 1;
    score += streak * 2 + (found === 0 || /[\s\-_@]/.test(t[found - 1] ?? "") ? 3 : 0);
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  keywords?: string;
  section: "Send" | "Bots" | "Actions";
  run: () => void;
}

export function CommandPalette() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => dispatch({ type: "togglePalette", open: false });
  const selected = state.bots.find((b) => b.id === state.selectedId);

  useEffect(() => {
    setQuery("");
    setIndex(0);
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, []);

  const items = useMemo<PaletteItem[]>(() => {
    const bots = state.bots.filter((b) => !b.hidden);
    const list: PaletteItem[] = [];

    // free text → dispatch rows: the selected bot first, then the rest
    const text = query.trim();
    const asMessage = text.length > 2 && !text.startsWith("/");
    if (asMessage && selected) {
      const targets = [selected, ...bots.filter((b) => b.id !== selected.id)];
      for (const bot of targets.slice(0, 3)) {
        if (bot.busy) continue;
        list.push({
          id: `send-${bot.id}`,
          label: `Send to ${bot.name}`,
          hint: `"${text.length > 44 ? `${text.slice(0, 44)}…` : text}"`,
          icon: <Send size={15} className="text-accent" />,
          section: "Send",
          run: () => {
            dispatch({ type: "select", id: bot.id });
            dispatch({ type: "send", botId: bot.id, text });
          },
        });
      }
    }

    for (const bot of bots) {
      list.push({
        id: `bot-${bot.id}`,
        label: bot.name,
        hint: bot.busy ? "working…" : bot.title || bot.modelSelection.model,
        keywords: `open chat ${bot.title}`,
        icon: (
          <MausAvatar color={bot.color} state={stateForBot(bot)} size={20} motion="none" motionKey={0} />
        ),
        section: "Bots",
        run: () => dispatch({ type: "select", id: bot.id }),
      });
    }

    const actions: Array<[string, string, React.ReactNode, () => void, string?]> = [
      ["new-bot", "New bot", <Plus size={15} />, () => dispatch({ type: "newBot" }), "create add agent"],
      [
        "mission-control",
        "Mission Control",
        <Grid2x2 size={15} />,
        () => dispatch({ type: "toggleMissionControl", open: true }),
        "fleet overview hud dashboard all bots",
      ],
      [
        "computer",
        `Computer — ${selected?.name ?? "bot"}`,
        <Monitor size={15} />,
        () => dispatch({ type: "toggleComputer", open: true }),
        "screen desktop box routines vm",
      ],
      [
        "bot-settings",
        `Bot settings — ${selected?.name ?? "bot"}`,
        <UserRound size={15} />,
        () => dispatch({ type: "toggleSettings", open: true }),
        "profile edit persona model",
      ],
      ["plugins", "Connected apps", <Puzzle size={15} />, () => dispatch({ type: "togglePlugins", open: true }), "plugins marketplace composio integrations"],
      ["app-settings", "App settings", <Settings size={15} />, () => dispatch({ type: "toggleAppSettings", open: true }), "keys config api profile"],
    ];
    if (selected?.busy) {
      actions.unshift([
        "interrupt",
        `Stop ${selected.name}`,
        <Square size={15} className="fill-current" />,
        () => dispatch({ type: "interrupt", botId: selected.id }),
        "interrupt cancel halt",
      ]);
    }
    for (const [id, label, icon, run, keywords] of actions) {
      list.push({ id, label, icon, run, keywords, section: "Actions" });
    }
    return list;
  }, [state.bots, query, selected, dispatch]);

  const results = useMemo(() => {
    const q = query.trim();
    const scored = items
      .map((item) => {
        if (item.section === "Send") return { item, score: 1_000 }; // always on top while typing text
        const score = fuzzyScore(q, `${item.label} ${item.keywords ?? ""}`);
        return score === null ? null : { item, score };
      })
      .filter((x): x is { item: PaletteItem; score: number } => x !== null);
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item).slice(0, 12);
  }, [items, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const runItem = (item: PaletteItem) => {
    close();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[index];
      if (item) runItem(item);
    }
  };

  let lastSection: string | null = null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[16vh] backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="animate-pop-in w-[600px] max-w-[calc(100vw-48px)] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl shadow-black/70">
        <div className="flex items-center gap-2.5 border-b border-hairline/40 px-4 py-3">
          <Search size={17} className="shrink-0 text-ink-secondary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a bot, run a command, or type a message…"
            className="w-full bg-transparent text-[15px] text-ink placeholder:text-ink-secondary/60 focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-hairline/60 bg-inset px-1.5 py-0.5 text-[10.5px] text-ink-secondary">
            esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[380px] overflow-y-auto py-1.5">
          {results.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px] text-ink-secondary">Nothing matches</div>
          )}
          {results.map((item, i) => {
            const showHeader = item.section !== lastSection;
            lastSection = item.section;
            return (
              <div key={item.id}>
                {showHeader && (
                  <div className="px-4 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-secondary/70">
                    {item.section}
                  </div>
                )}
                <button
                  data-idx={i}
                  onClick={() => runItem(item)}
                  onMouseMove={() => setIndex(i)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2 text-left",
                    i === index ? "bg-raised/80" : "hover:bg-raised/40",
                  )}
                >
                  <span className="flex w-5 shrink-0 items-center justify-center text-ink-secondary">
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{item.label}</span>
                  {item.hint && (
                    <span className="max-w-[200px] shrink-0 truncate text-[12px] text-ink-secondary">
                      {item.hint}
                    </span>
                  )}
                  {i === index && <ArrowRight size={13} className="shrink-0 text-ink-secondary" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-hairline/40 bg-inset/50 px-4 py-2 text-[11px] text-ink-secondary">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-hairline/60 bg-inset px-1 py-px">↑↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-hairline/60 bg-inset px-1 py-px">↵</kbd> run
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <MessageSquare size={11} />
            type a sentence to message any bot
          </span>
        </div>
      </div>
    </div>
  );
}
