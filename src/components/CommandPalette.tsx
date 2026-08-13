// Command palette (⌘K). Every entry is derived from live state — the bots
// in the store, the provider instances the harness reports, the sections
// that exist right now — so the palette can never offer a bot, model, or
// section that isn't really there. Nothing here is a fixed list except the
// app's own panels, which are structural.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot as BotIcon,
  CalendarClock,
  Cpu,
  FolderPlus,
  Monitor,
  Pin,
  PinOff,
  Puzzle,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { scoreAny } from "@/lib/search";
import { cn } from "@/lib/cn";

interface Command {
  id: string;
  label: string;
  /** shown right-aligned: the group this command belongs to */
  group: string;
  hint?: string;
  icon: React.ReactNode;
  /** extra text the query may match (bot titles, model ids, …) */
  keywords?: Array<string | undefined | null>;
  danger?: boolean;
  run: () => void;
}

export function CommandPalette() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const open = state.paletteOpen;
  const close = () => dispatch({ type: "togglePalette", open: false });
  const selected: Bot | undefined = state.bots.find((b) => b.id === state.selectedId);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    // Jump to any bot that exists right now
    for (const bot of state.bots.filter((b) => !b.hidden)) {
      const section = state.sections.find((s) => s.id === bot.sectionId);
      list.push({
        id: `bot:${bot.id}`,
        label: bot.name,
        group: section ? section.name : "Bots",
        hint: bot.busy ? "working…" : bot.title || undefined,
        icon: <BotIcon size={15} className="text-ink-secondary" />,
        keywords: [bot.title, bot.description],
        run: () => dispatch({ type: "select", id: bot.id }),
      });
    }

    // Switch the selected bot's model — options come from the harness's
    // live instance list, so unavailable providers simply aren't offered
    if (selected) {
      for (const instance of state.instances) {
        if (instance.snapshot.state !== "available") continue;
        for (const model of instance.models.options) {
          list.push({
            id: `model:${instance.instanceId}:${model.id}`,
            label: `${selected.name} → ${model.label}`,
            group: "Model",
            hint: instance.displayName,
            icon: <Cpu size={15} className="text-ink-secondary" />,
            keywords: [model.id, instance.displayName, instance.driverKind],
            run: () =>
              dispatch({
                type: "setModel",
                botId: selected.id,
                selection: { instanceId: instance.instanceId, model: model.id },
              }),
          });
        }
      }

      // File the selected bot into a section that exists
      for (const section of state.sections) {
        if (section.id === selected.sectionId) continue;
        list.push({
          id: `section:${section.id}`,
          label: `Move ${selected.name} to ${section.name}`,
          group: "Sections",
          icon: <FolderPlus size={15} className="text-ink-secondary" />,
          run: () => dispatch({ type: "updateBot", botId: selected.id, patch: { sectionId: section.id } }),
        });
      }

      list.push(
        {
          id: "bot:pin",
          label: selected.pinned ? `Unpin ${selected.name}` : `Pin ${selected.name}`,
          group: "Bot",
          icon: selected.pinned ? (
            <PinOff size={15} className="text-ink-secondary" />
          ) : (
            <Pin size={15} className="text-ink-secondary" />
          ),
          run: () => dispatch({ type: "updateBot", botId: selected.id, patch: { pinned: !selected.pinned } }),
        },
        {
          id: "bot:settings",
          label: "Bot settings",
          group: "Panels",
          icon: <SlidersHorizontal size={15} className="text-ink-secondary" />,
          run: () => dispatch({ type: "toggleSettings", open: true }),
        },
        {
          id: "bot:computer",
          label: "Bot's computer",
          group: "Panels",
          icon: <Monitor size={15} className="text-ink-secondary" />,
          run: () => dispatch({ type: "toggleComputer", open: true }),
        },
        {
          id: "bot:routines",
          label: "Routines",
          group: "Panels",
          hint: "schedule a recurring task",
          icon: <CalendarClock size={15} className="text-ink-secondary" />,
          // routines live inside the computer panel
          run: () => dispatch({ type: "toggleComputer", open: true }),
        },
      );

      if (selected.busy) {
        list.push({
          id: "bot:interrupt",
          label: `Stop ${selected.name}`,
          group: "Bot",
          icon: <Square size={15} className="text-danger" />,
          danger: true,
          run: () => dispatch({ type: "interrupt", botId: selected.id }),
        });
      }

      list.push({
        id: "bot:delete",
        label: `Delete ${selected.name}`,
        group: "Bot",
        icon: <Trash2 size={15} className="text-danger" />,
        danger: true,
        run: () => dispatch({ type: "deleteBot", botId: selected.id }),
      });
    }

    list.push(
      {
        id: "app:new-bot",
        label: "New bot",
        group: "App",
        icon: <BotIcon size={15} className="text-ink-secondary" />,
        run: () => dispatch({ type: "newBot" }),
      },
      {
        id: "app:plugins",
        label: "Plugins",
        group: "Panels",
        icon: <Puzzle size={15} className="text-ink-secondary" />,
        run: () => dispatch({ type: "togglePlugins", open: true }),
      },
      {
        id: "app:settings",
        label: "App settings",
        group: "Panels",
        icon: <Settings size={15} className="text-ink-secondary" />,
        run: () => dispatch({ type: "toggleAppSettings", open: true }),
      },
    );

    return list;
  }, [state.bots, state.sections, state.instances, selected, dispatch]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return commands.slice(0, 40);
    return commands
      .map((command) => ({ command, rank: scoreAny([command.label, command.group, ...(command.keywords ?? [])], q) }))
      .filter((entry) => entry.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 40)
      .map((entry) => entry.command);
  }, [commands, query]);

  // reset each time it opens; keep the highlight inside the result list
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  // ⌘K / ctrl+K toggles from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        dispatch({ type: "togglePalette" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  if (!open) return null;

  const runActive = () => {
    const command = results[active];
    if (!command) return;
    command.run();
    close();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="animate-pop-in w-[560px] max-w-[92vw] overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-2 border-b border-hairline/40 px-3.5 py-3">
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "Enter") (e.preventDefault(), runActive());
              if (e.key === "ArrowDown") (e.preventDefault(), setActive((i) => Math.min(i + 1, results.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setActive((i) => Math.max(i - 1, 0)));
            }}
            placeholder="Search bots, models, sections, panels…"
            className="w-full min-w-0 bg-transparent text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-hairline/50 px-1.5 py-0.5 text-[11px] text-ink-secondary">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
          {results.map((command, i) => (
            <button
              key={command.id}
              data-active={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => {
                command.run();
                close();
              }}
              className={cn(
                "flex w-full items-center gap-3 px-3.5 py-2 text-left",
                i === active ? "bg-raised" : "hover:bg-raised/50",
              )}
            >
              {command.icon}
              <span className={cn("min-w-0 flex-1 truncate text-[14px]", command.danger ? "text-danger" : "text-ink")}>
                {command.label}
              </span>
              {command.hint && (
                <span className="shrink-0 truncate text-[12px] text-ink-secondary">{command.hint}</span>
              )}
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-secondary/70">
                {command.group}
              </span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="px-3.5 py-8 text-center text-[13px] text-ink-secondary">
              Nothing matches “{query.trim()}”.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
