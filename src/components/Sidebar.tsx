import { track } from "@/lib/analytics";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BellDot,
  ChevronRight,
  ClipboardCopy,
  Copy,
  EyeOff,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Puzzle,
  Trash2,
  X,
} from "lucide-react";
import { useStore, formatTime, type Bot, type Section } from "@/state/store";
import { MausAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { scoreAny } from "@/lib/search";
import { cn } from "@/lib/cn";

const isElectron = navigator.userAgent.includes("Electron");

/** "Milind Soni" → "MS", "milind" → "M", "you@x.dev" → "Y", unset → "?" */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

function preview(bot: Bot): string {
  if (bot.busy) return "Working…";
  const last = bot.messages[bot.messages.length - 1];
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return "Screen frame";
  return last.text ?? "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

function SectionSubmenu({
  bot,
  onPick,
  onClose,
}: {
  bot: Bot;
  onPick: (sectionId: string | null) => void;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    dispatch({ type: "createSection", name: trimmed, botId: bot.id });
    onClose();
  };

  return (
    <div className="max-h-[260px] overflow-y-auto py-1">
      {state.sections.map((section) => (
        <button
          key={section.id}
          onClick={() => onPick(section.id)}
          className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <span className="truncate">{section.name}</span>
          {bot.sectionId === section.id && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
        </button>
      ))}
      {bot.sectionId && (
        <button
          onClick={() => onPick(null)}
          className="w-full px-3.5 py-2 text-left text-[14px] text-ink-secondary hover:bg-raised/70"
        >
          Remove from section
        </button>
      )}
      {state.sections.length > 0 && <div className="mx-2 my-1 border-t border-hairline/40" />}
      {creating ? (
        <div className="px-2 py-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="Section name"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Plus size={16} className="text-ink-secondary" />
          New section…
        </button>
      )}
    </div>
  );
}

function BotContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);
  const [sectionsOpen, setSectionsOpen] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  // keep the menu on-screen near the click
  const top = Math.min(menu.y, window.innerHeight - 340);
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? "Unpin" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        <div key="sections">
          <button
            onClick={() => setSectionsOpen((open) => !open)}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
          >
            <FolderPlus size={16} className="text-ink-secondary" />
            <span className="flex-1">Move to section</span>
            <ChevronRight
              size={14}
              className={cn("text-ink-secondary transition-transform", sectionsOpen && "rotate-90")}
            />
          </button>
          {sectionsOpen && (
            <div className="mx-1.5 mb-1 rounded-lg bg-inset/70">
              <SectionSubmenu
                bot={bot}
                onClose={onClose}
                onPick={(sectionId) => {
                  dispatch({ type: "updateBot", botId: bot.id, patch: { sectionId } });
                  onClose();
                }}
              />
            </div>
          )}
        </div>,
        item(<BellDot size={16} className="text-ink-secondary" />, "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(<EyeOff size={16} className="text-ink-secondary" />, "Hide from sidebar", () =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { hidden: true } }),
        ),
        item(<Trash2 size={16} />, "Delete", () => dispatch({ type: "deleteBot", botId: bot.id }), {
          danger: true,
        }),
      ]}
    </div>
  );
}

function BotListItem({ bot, onMenu }: { bot: Bot; onMenu: (menu: MenuState) => void }) {
  const { state, dispatch } = useStore();
  const selected = state.selectedId === bot.id;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const last = bot.messages[bot.messages.length - 1];
  return (
    <button
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <MausAvatar
        color={bot.color}
        state={stateForBot(bot)}
        size={56}
        motion={mascotMotion?.kind ?? "none"}
        motionKey={mascotMotion?.nonce ?? 0}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <span className="truncate">{bot.name}</span>
          </span>
          {selected && last && (
            <span className="shrink-0 text-xs text-ink-secondary">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">
            {preview(bot)}
          </span>
          {bot.unread && (
            <span className="size-2 shrink-0 rounded-full bg-accent" />
          )}
        </div>
      </div>
    </button>
  );
}

function SectionHeader({ section, count }: { section: Section; count: number }) {
  const { dispatch } = useStore();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(section.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== section.name) dispatch({ type: "renameSection", sectionId: section.id, name: trimmed });
    else setName(section.name);
    setRenaming(false);
  };

  if (renaming) {
    return (
      <div className="px-2 pb-1 pt-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") (setName(section.name), setRenaming(false));
          }}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-1 text-[12px] font-semibold tracking-wide text-ink focus:border-hairline focus:outline-none"
        />
      </div>
    );
  }

  return (
    <div className="group/section flex items-center gap-1 px-2 pb-1 pt-3">
      <button
        onClick={() => dispatch({ type: "toggleSection", sectionId: section.id })}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-ink-secondary hover:text-ink"
        aria-expanded={!section.collapsed}
      >
        <ChevronRight
          size={12}
          className={cn("shrink-0 transition-transform", !section.collapsed && "rotate-90")}
        />
        <span className="truncate text-[12px] font-semibold uppercase tracking-wide">{section.name}</span>
        <span className="shrink-0 text-[11px] tabular-nums opacity-70">{count}</span>
      </button>
      <button
        onClick={() => (setName(section.name), setRenaming(true))}
        title="Rename section"
        aria-label={`Rename section ${section.name}`}
        className="rounded-md p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover/section:opacity-100"
      >
        <Pencil size={12} />
      </button>
      <button
        onClick={() => (confirmDelete ? dispatch({ type: "deleteSection", sectionId: section.id }) : setConfirmDelete(true))}
        onBlur={() => setConfirmDelete(false)}
        title={confirmDelete ? "Click again to remove the section (bots are kept)" : "Remove section"}
        aria-label={`Remove section ${section.name}`}
        className={cn(
          "rounded-md p-1 opacity-0 hover:bg-raised group-hover/section:opacity-100",
          confirmDelete ? "text-danger opacity-100" : "text-ink-secondary hover:text-danger",
        )}
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function Sidebar() {
  const { state, dispatch } = useStore();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const query = state.search.trim();

  // One pass over live state: hide hidden bots, apply the search, then
  // group by section. Pinned always floats to the top of its own group.
  const { groups, ungrouped, matchCount } = useMemo(() => {
    const byPin = (a: Bot, b: Bot) => Number(b.pinned ?? false) - Number(a.pinned ?? false);
    const visible = state.bots.filter((b) => !b.hidden);
    const matched = query
      ? visible.filter(
          (b) =>
            scoreAny(
              [b.name, b.title, b.description, ...b.messages.map((m) => m.text ?? m.card?.title ?? m.tool?.name)],
              query,
            ) > 0,
        )
      : visible;

    const known = new Set(state.sections.map((s) => s.id));
    return {
      matchCount: matched.length,
      groups: state.sections.map((section) => ({
        section,
        bots: matched.filter((b) => b.sectionId === section.id).sort(byPin),
      })),
      // a bot filed under a section this build no longer knows about is
      // ungrouped, never invisible
      ungrouped: matched.filter((b) => !b.sectionId || !known.has(b.sectionId)).sort(byPin),
    };
  }, [state.bots, state.sections, query]);

  // ⌘F / ctrl+F focuses the filter — the palette owns ⌘K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-r border-hairline/40 bg-panel">
      {/* Titlebar: real traffic lights in Electron, faux ones in the browser */}
      <div
        className="flex items-center justify-between px-4 pt-3.5 pb-1"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {isElectron ? (
          <div className="w-14" />
        ) : (
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        )}
        <button
          onClick={() => { track("bot_created"); dispatch({ type: "newBot" }); }}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title="New bot"
        >
          <Plus size={20} strokeWidth={2} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pt-2 pb-3">
        <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <input
            ref={searchRef}
            value={state.search}
            onChange={(e) => dispatch({ type: "search", value: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && dispatch({ type: "search", value: "" })}
            placeholder="Search"
            className="w-full min-w-0 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          {query && (
            <button
              onClick={() => dispatch({ type: "search", value: "" })}
              aria-label="Clear search"
              className="shrink-0 rounded-md p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Bot list, grouped by section */}
      <div className="flex-1 overflow-y-auto px-2">
        {groups.map(({ section, bots }) => {
          // a search hides empty groups so results aren't buried in headers
          if (query && bots.length === 0) return null;
          return (
            <div key={section.id}>
              <SectionHeader section={section} count={bots.length} />
              {(!section.collapsed || query) && (
                <div className="flex flex-col gap-0.5">
                  {bots.map((b) => (
                    <BotListItem key={b.id} bot={b} onMenu={setMenu} />
                  ))}
                  {bots.length === 0 && (
                    <div className="px-3 py-1.5 text-[12px] text-ink-secondary">
                      Empty — move a bot here from its right-click menu.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {ungrouped.length > 0 && (
          <div className={cn("flex flex-col gap-0.5", groups.length > 0 && "mt-3")}>
            {ungrouped.map((b) => (
              <BotListItem key={b.id} bot={b} onMenu={setMenu} />
            ))}
          </div>
        )}

        {query && matchCount === 0 && (
          <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">No bots match “{query}”.</div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 pb-3 pt-2">
        <button
          onClick={() => dispatch({ type: "togglePlugins", open: true })}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50"
        >
          <Puzzle size={20} className="text-ink-secondary" />
          <span className="text-[14px] text-ink">Plugins</span>
        </button>
        <div className="flex items-center">
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50"
          >
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28} />
            <span className="truncate text-[14px] text-ink">
              {state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}
            </span>
          </button>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
            title="App settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>

      {menu && <BotContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}
