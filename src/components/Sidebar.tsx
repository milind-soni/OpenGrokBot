import { track } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  BellDot,
  Bot as BotIcon,
  CalendarDays,
  Check,
  ClipboardCopy,
  Copy,
  Crown,
  EyeOff,
  FileUp,
  FolderPlus,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Puzzle,
  Trash2,
  Users,
} from "lucide-react";
import { api, useStore, formatTime, visibleMessages, type Bot, type Group } from "@/state/store";
import { MausAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { downloadSelectedTeam } from "@/lib/team-files";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RenameTitle } from "./RenameTitle";

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

/** Manual update check, next to the settings gear. Packaged app only (no
 * bridge in dev/browser). One button, state-dependent: check → download →
 * restart, with a brief "up to date" tick when a check finds nothing so a
 * click is never silent. The bottom-left popup handles the loud cases. */
function UpdateButton() {
  const s = useUpdaterState();
  const [checkedAt, setCheckedAt] = useState(0);
  const updater = window.ogb?.updater;
  const status = s?.status ?? "idle";
  // download and install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [status]);
  // a check that found nothing lands back on idle — acknowledge it for 3s
  const upToDate = Boolean(checkedAt) && (!s || s.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);
  if (!updater) return null;

  const working =
    pending || status === "checking" || status === "downloading" || status === "installing";
  const label =
    status === "available"
      ? `Version ${s?.version ?? ""} available — download`
      : status === "downloading"
        ? s?.percent == null
          ? "Starting download…"
          : `Downloading… ${Math.round(s.percent)}%`
        : status === "downloaded"
          ? `Version ${s?.version ?? ""} ready — restart to update`
          : status === "installing"
            ? "Restarting to update…"
            : status === "checking"
              ? "Checking for updates…"
              : upToDate
                ? "You're up to date"
                : "Check for updates";

  return (
    <button
      onClick={() => {
        if (status === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        if (status === "available") {
          setPending(true);
          return void updater.download();
        }
        setCheckedAt(Date.now());
        void updater.check();
      }}
      disabled={working}
      title={label}
      aria-label={label}
      className="relative rounded-md p-2 text-accent hover:bg-raised disabled:opacity-60"
    >
      {working ? (
        <Loader2 size={18} className="animate-spin" />
      ) : upToDate ? (
        <Check size={18} />
      ) : status === "available" ? (
        <ArrowDownToLine size={18} />
      ) : (
        <RefreshCw size={18} />
      )}
      {status === "downloaded" && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
      )}
    </button>
  );
}

function preview(bot: Bot): string {
  if (bot.busy) return "Working…";
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from
  const last = visibleMessages(bot).at(-1);
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

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return `${bots.find((b) => b.id === group.busyBotId)?.name ?? "A bot"} is working…`;
  }
  const last = group.messages.at(-1);
  if (!last) return "No messages yet";
  const text = last.kind === "activity" && last.tool ? last.tool.name : (last.text ?? "");
  if (last.role === "user") return `You: ${text}`;
  return last.from ? `${last.from.name}: ${text}` : text;
}

/** Room avatar: 2–3 overlapping mauses in the same 56px slot a bot gets. */
function StackedMauses({ members }: { members: Bot[] }) {
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className="flex size-14 shrink-0 items-center justify-center">
        {b ? <MausAvatar color={b.color} state="happy" size={56} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div className="flex size-14 shrink-0 items-center justify-center">
      <div className="flex items-center -space-x-3">
        {shown.map((b) => (
          <MausAvatar key={b.id} color={b.color} state="happy" size={30} />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-[22px] items-center justify-center rounded-full border border-hairline/40 bg-raised text-[10px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

function GroupListItem({ group, onMenu }: { group: Group; onMenu: (menu: { groupId: string; x: number; y: number }) => void }) {
  const { state, dispatch } = useStore();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <button
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <StackedMauses members={members} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-ink">{group.name}</span>
          {selected && last && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(last.at)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">{groupPreview(group, state.bots)}</span>
          {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>
      </div>
    </button>
  );
}

function RoomContextMenu({
  menu,
  onClose,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === menu.groupId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-room-menu]")) onClose();
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

  if (!group) return null;
  const top = Math.min(menu.y, window.innerHeight - 164);
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        Copy conversation ID
      </button>
      <button
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        Delete Room
      </button>
    </div>,
    document.body,
  );
}

interface PendingTeamImport {
  manifest: unknown;
  name: string;
  roomName: string;
  members: Array<{ name: string; title: string }>;
}

function importPreview(manifest: unknown): PendingTeamImport {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("This file does not contain a team.");
  }
  const root = manifest as Record<string, unknown>;
  if (root.format !== "openmaus.team") throw new Error("This is not an OpenMaus team file.");
  if (root.version !== 1) throw new Error(`Team file version ${String(root.version)} is not supported.`);
  if (!root.team || typeof root.team !== "object" || Array.isArray(root.team)) {
    throw new Error("This team file is missing its team definition.");
  }
  const team = root.team as Record<string, unknown>;
  if (typeof team.name !== "string" || !team.name.trim()) throw new Error("This team does not have a name.");
  if (!Array.isArray(team.members) || team.members.length === 0) throw new Error("This team has no members.");
  const members = team.members.map((member, index) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw new Error(`Team member ${index + 1} is invalid.`);
    }
    const value = member as Record<string, unknown>;
    if (typeof value.name !== "string" || !value.name.trim()) {
      throw new Error(`Team member ${index + 1} does not have a name.`);
    }
    return {
      name: value.name.trim(),
      title: typeof value.title === "string" ? value.title.trim() : "",
    };
  });
  const room = team.room;
  const roomName =
    room && typeof room === "object" && !Array.isArray(room) && typeof (room as Record<string, unknown>).name === "string"
      ? String((room as Record<string, unknown>).name).trim()
      : team.name.trim();
  return { manifest, name: team.name.trim(), roomName, members };
}

function ImportTeamPanel({
  pending,
  onClose,
  onImported,
  returnFocusRef,
}: {
  pending: PendingTeamImport;
  onClose: () => void;
  onImported: (name: string) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { dispatch } = useStore();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [returnFocusRef]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, working]);

  const importTeam = async () => {
    setWorking(true);
    setError("");
    try {
      const response = (await api("/api/teams/import", {
        method: "POST",
        body: JSON.stringify(pending.manifest),
      })) as { bots: Bot[]; group: Group };
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      dispatch({ type: "groupPatched", group: response.group });
      dispatch({ type: "select", id: response.group.id });
      track("team_imported", { members: response.bots.length });
      onImported(pending.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45"
      onMouseDown={(event) => event.target === event.currentTarget && !working && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-team-title"
        tabIndex={-1}
        className="w-[420px] max-w-[calc(100vw-32px)] rounded-2xl border border-hairline/50 bg-card p-5 shadow-2xl"
      >
        <div id="import-team-title" className="text-[17px] font-semibold text-ink">Import {pending.name}?</div>
        <div className="mt-1 text-[13px] text-ink-secondary">
          This creates {pending.members.length} new {pending.members.length === 1 ? "bot" : "bots"} and the room “{pending.roomName}”.
        </div>
        <div className="mt-4 max-h-64 space-y-1 overflow-y-auto rounded-xl bg-raised/50 p-2">
          {pending.members.map((member, index) => (
            <div key={`${member.name}-${index}`} className="flex items-baseline gap-2 rounded-lg px-2.5 py-2">
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{member.name}</span>
              <span className="max-w-[190px] truncate text-[12.5px] text-ink-secondary">
                {member.title || "General assistant"}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">
          The bots will use your default engine. Conversations, permissions, and computer access are never imported.
        </div>
        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={working}
            className="rounded-lg px-3.5 py-2 text-[13.5px] text-ink-secondary hover:bg-raised disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={() => void importTeam()}
            disabled={working}
            className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
          >
            {working ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />}
            {working ? "Importing…" : "Import Team"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ExportTeamPanel({
  onClose,
  onExported,
  returnFocusRef,
}: {
  onClose: () => void;
  onExported: (name: string) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const bots = state.bots.filter((bot) => !bot.hidden);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [returnFocusRef]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, working]);

  const toggle = (id: string) => {
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < 50) next.add(id);
      return next;
    });
  };

  const exportTeam = async () => {
    const teamName = name.trim();
    if (!teamName || picked.size === 0) return;
    setWorking(true);
    setError("");
    try {
      const exported = await downloadSelectedTeam(teamName, [...picked]);
      track("team_exported", { members: exported.members });
      onExported(exported.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45"
      onMouseDown={(event) => event.target === event.currentTarget && !working && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-team-title"
        tabIndex={-1}
        className="w-[380px] max-w-[calc(100vw-32px)] rounded-2xl border border-hairline/50 bg-card p-5 shadow-2xl"
      >
        <div id="export-team-title" className="text-[17px] font-semibold text-ink">Export Team</div>
        <div className="mt-1 text-[13px] text-ink-secondary">
          Choose any bots to share. You do not need to create a room first.
        </div>
        <input
          ref={nameRef}
          value={name}
          maxLength={100}
          disabled={working}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void exportTeam();
          }}
          placeholder="Team name"
          aria-label="Team name"
          className="mt-4 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none disabled:opacity-60"
        />
        <div className="mt-3 flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-xl bg-raised/30 p-1.5">
          {bots.length === 0 && (
            <div className="px-2 py-5 text-center text-[13px] text-ink-secondary">
              Create a bot first, then it can be shared as part of a team.
            </div>
          )}
          {bots.map((bot) => {
            const selected = picked.has(bot.id);
            const capped = !selected && picked.size >= 50;
            return (
              <button
                key={bot.id}
                type="button"
                aria-pressed={selected}
                disabled={working || capped}
                onClick={() => toggle(bot.id)}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/70 disabled:opacity-40"
              >
                <MausAvatar color={bot.color} state="happy" size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{bot.name}</span>
                  {bot.title && <span className="block truncate text-[11.5px] text-ink-secondary">{bot.title}</span>}
                </span>
                <span
                  className={cn(
                    "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-accent bg-accent text-white" : "border-hairline/60",
                  )}
                >
                  {selected && <Check size={12} />}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">
          Messages, permissions, credentials, engines, and computer access are never included.
        </div>
        {error && (
          <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
            {error}
          </div>
        )}
        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-ink-secondary">
            {picked.size} {picked.size === 1 ? "bot" : "bots"} selected
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={working}
              className="rounded-lg px-3.5 py-2 text-[13.5px] text-ink-secondary hover:bg-raised disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void exportTeam()}
              disabled={working || !name.trim() || picked.size === 0}
              className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
            >
              {working ? <Loader2 size={15} className="animate-spin" /> : <ArrowDownToLine size={15} />}
              {working ? "Exporting…" : "Export"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Pick members → Create. The room name is optional; the server defaults it. */
function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({ type: "createGroup", memberIds: [...picked], name: name.trim() || undefined });
    track("room_created", { members: picked.size });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">New Room</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Room name (optional)"
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {bots.length === 0 && (
            <div className="px-2 py-4 text-center text-[13px] text-ink-secondary">Create a bot first — rooms are made of bots.</div>
          )}
          {bots.map((b) => (
            <button
              key={b.id}
              onClick={() => toggle(b.id)}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50"
            >
              <MausAvatar color={b.color} state="happy" size={28} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{b.name}</span>
              <span
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                  picked.has(b.id) ? "border-accent bg-accent text-white" : "border-hairline/60",
                )}
              >
                {picked.has(b.id) && <Check size={12} />}
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          Create Room{picked.size ? ` · ${picked.size} ${picked.size === 1 ? "bot" : "bots"}` : ""}
        </button>
      </div>
    </div>
  );
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
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  // keep the menu on-screen near the click
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 380));
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
        item(
          <Crown size={16} className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"} />,
          bot.chiefOfStaff ? "Remove Chief of Staff" : "Make Chief of Staff",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
          {
            disabled: !bot.chiefOfStaff && !canCoordinate,
            hint: !bot.chiefOfStaff && !canCoordinate ? "Choose a Claude or ACP engine first" : undefined,
          },
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
        item(
          <EyeOff size={16} className="text-ink-secondary" />,
          "Hide from sidebar",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { hidden: true } }),
          {
            disabled: Boolean(bot.chiefOfStaff),
            hint: bot.chiefOfStaff ? "Choose another Chief of Staff first" : undefined,
          },
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
  const [renaming, setRenaming] = useState(false);
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  // the visible branch, so a version switch changes the row with the chat
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  const rowClass = cn(
    "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left",
    bot.chiefOfStaff
      ? selected
        ? "border-accent/40 bg-accent/15"
        : "border-accent/25 bg-accent/5 hover:bg-accent/10"
      : selected
        ? "border-transparent bg-raised"
        : "border-transparent hover:bg-raised/50",
  );
  const body = (
    <>
      <MausAvatar
        color={bot.color}
        state={stateForBot({ ...bot, messages: visible })}
        size={56}
        motion={mascotMotion?.kind ?? "none"}
        motionKey={mascotMotion?.nonce ?? 0}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <RenameTitle
              value={bot.name}
              onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[15px] font-semibold"
            />
          </span>
          {selected && last && !renaming && (
            <span className="shrink-0 text-xs text-ink-secondary">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-ink-secondary">
            {bot.chiefOfStaff && (
              <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-accent">
                <Crown size={11} /> Chief of Staff
              </span>
            )}
            {bot.chiefOfStaff && preview(bot) && <span className="shrink-0 text-ink-secondary/60">·</span>}
            <span className="truncate">{preview(bot)}</span>
          </span>
          {bot.unread && (
            <span className="size-2 shrink-0 rounded-full bg-accent" />
          )}
        </div>
      </div>
    </>
  );
  return (
    <div
      role="button"
      tabIndex={renaming ? -1 : 0}
      onClick={() => {
        if (!renaming) dispatch({ type: "select", id: bot.id });
      }}
      onKeyDown={(event) => {
        if (renaming) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          dispatch({ type: "select", id: bot.id });
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
      }}
      className={rowClass}
    >
      {body}
    </div>
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const importInputRef = useRef<HTMLInputElement>(null);
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [exportTeamOpen, setExportTeamOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingTeamImport | null>(null);
  const [teamFeedback, setTeamFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [query, setQuery] = useState("");

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Room panel can be open on top of it, so the same Escape press closes
  // them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const chooseTeamFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > 1_000_000) {
      setTeamFeedback({ error: true, text: "That team file is too large." });
      return;
    }
    try {
      const manifest: unknown = JSON.parse(await file.text());
      setPendingImport(importPreview(manifest));
      setTeamFeedback(null);
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof SyntaxError ? "That team file is not valid JSON." : cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";

  const q = query.trim().toLowerCase();
  const matchingBots = state.bots
    .filter((b) => !b.hidden)
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        preview(b).toLowerCase().includes(q),
    );
  const chiefBot = matchingBots.find((bot) => bot.chiefOfStaff);
  const visibleBots = matchingBots
    .filter((bot) => !bot.chiefOfStaff)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  const visibleGroups = state.groups.filter((g) => !q || g.name.toLowerCase().includes(q));

  return (
    <aside
      className={cn(
        "flex h-full w-[320px] shrink-0 flex-col border-r border-hairline/40 bg-panel",
        // Below md only: the sidebar leaves the flow and slides in over the chat.
        // Scoped with max-md: rather than cancelled with md: on purpose — Tailwind
        // v4 emits the native `translate` property, and any value other than
        // `none` turns this element into a containing block for its `fixed`
        // descendants. Cancelling it with an `md:` prefix still emits a value, which
        // silently reparents NewRoomPanel's overlay and the "+" menu backdrop on
        // desktop.
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      {/* macOS owns inset traffic lights; Linux/Windows use native chrome. */}
      <div
        className="flex items-center justify-between px-4 pt-3.5 pb-1"
        style={macInset ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined}
      >
        {macInset ? (
          <div className="w-14" />
        ) : browser ? (
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : <div />}
        <div
          className="relative"
          style={macInset ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
        >
          <button
            ref={importReturnRef}
            onClick={() => setPlusOpen((o) => !o)}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="New or share"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60">
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  New Bot
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  New Room
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setExportTeamOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <ArrowDownToLine size={16} className="text-ink-secondary" />
                  Export Team
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    importInputRef.current?.click();
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <FileUp size={16} className="text-ink-secondary" />
                  Import Team
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept=".json,.mausteam.json,application/json"
        onChange={(event) => void chooseTeamFile(event)}
        className="hidden"
        aria-label="Choose an OpenMaus team file"
      />

      {/* Search */}
      <div className="px-3 pt-2 pb-3">
        <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
          <Search size={16} className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search"
            aria-label="Search bots"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          {!chiefBot && visibleBots.length === 0 && visibleGroups.length === 0 && q && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">Nothing matches “{query}”</div>
          )}
          {chiefBot && (
            <div className="mb-1.5">
              <BotListItem bot={chiefBot} onMenu={setMenu} />
            </div>
          )}
          {visibleGroups.map((g) => (
            <GroupListItem key={g.id} group={g} onMenu={setRoomMenu} />
          ))}
          {visibleBots.map((b) => (
            <BotListItem key={b.id} bot={b} onMenu={setMenu} />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="px-3 pb-3 pt-2">
        <button
          onClick={() => dispatch({ type: "showRoutines" })}
          className={cn(
            "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
            state.activeView === "routines" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
          )}
        >
          <CalendarDays size={20} className={state.activeView === "routines" ? "text-accent" : "text-ink-secondary"} />
          <span className="flex-1 text-[14px]">Automations</span>
          {state.routineRuns.some((run) => ["failed", "missed"].includes(run.status) && !run.seenAt) && (
            <span className="size-2 rounded-full bg-danger" />
          )}
        </button>
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
          <UpdateButton />
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
      {roomMenu && (
        <RoomContextMenu
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
        />
      )}
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {exportTeamOpen && (
        <ExportTeamPanel
          returnFocusRef={importReturnRef}
          onClose={() => setExportTeamOpen(false)}
          onExported={(name) => {
            setExportTeamOpen(false);
            setTeamFeedback({ error: false, text: `${name} exported` });
          }}
        />
      )}
      {pendingImport && (
        <ImportTeamPanel
          pending={pendingImport}
          returnFocusRef={importReturnRef}
          onClose={() => setPendingImport(null)}
          onImported={(name) => {
            setPendingImport(null);
            setTeamFeedback({ error: false, text: `${name} imported` });
          }}
        />
      )}
      {teamFeedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
              teamFeedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            {teamFeedback.text}
          </div>,
          document.body,
        )}
    </aside>
  );
}
