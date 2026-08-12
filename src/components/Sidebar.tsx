import { track } from "@/lib/analytics";
import { useEffect, useState } from "react";
import {
  BellDot,
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
} from "lucide-react";
import { useStore, formatTime, type Bot } from "@/state/store";
import { MausAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
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

function BotContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);

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
        item(<FolderPlus size={16} className="text-ink-secondary" />, "Move to new section", undefined, {
          disabled: true,
          hint: "Coming soon",
        }),
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

export function Sidebar() {
  const { state, dispatch } = useStore();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const visibleBots = state.bots
    .filter((b) => !b.hidden)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));

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
          <Search size={16} className="text-ink-secondary" />
          <input
            placeholder="Search"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          {visibleBots.map((b) => (
            <BotListItem key={b.id} bot={b} onMenu={setMenu} />
          ))}
        </div>
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
