// Edit an existing room's roster: the same picker "New Room" uses, opened
// from the member mauses in the room header and pre-ticked with who is
// already in. Membership is the only thing this touches — the transcript
// keeps every message a departing bot already sent.
import { useEffect, useMemo, useState } from "react";
import { track } from "@/lib/analytics";
import { useStore, type Group } from "@/state/store";
import { BotPickerList } from "./BotPickerList";
import { nextMemberIds } from "@/lib/room-members";

export function ManageMembersPanel({ group, onClose }: { group: Group; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(group.memberIds));

  // Archived bots stay listed while they are still members — otherwise a
  // room could keep a member you have no way to remove.
  const bots = useMemo(
    () => state.bots.filter((b) => !b.hidden || group.memberIds.includes(b.id)),
    [state.bots, group.memberIds],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const memberIds = nextMemberIds(
    group.memberIds,
    picked,
    bots.map((b) => b.id),
  );
  const changed = memberIds.length !== group.memberIds.length || memberIds.some((id, i) => id !== group.memberIds[i]);

  const save = () => {
    if (!memberIds.length) return;
    if (changed) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { memberIds } });
      track("room_members_changed", {
        members: memberIds.length,
        added: memberIds.filter((id) => !group.memberIds.includes(id)).length,
        removed: group.memberIds.filter((id) => !memberIds.includes(id)).length,
      });
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Manage members of ${group.name}`}
        className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
      >
        <div className="mb-1 text-[15px] font-semibold text-ink">Manage Members</div>
        <div className="mb-3 truncate text-[13px] text-ink-secondary">{group.name}</div>
        <BotPickerList bots={bots} picked={picked} onToggle={toggle} emptyHint="Create a bot first — rooms are made of bots." />
        {!memberIds.length && <div className="mt-2 text-[12px] text-ink-secondary">A room needs at least one bot.</div>}
        <div className="mt-3 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg bg-raised py-2 text-[14px] font-medium text-ink hover:brightness-110"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!memberIds.length}
            className="flex-1 rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            Save{memberIds.length ? ` · ${memberIds.length} ${memberIds.length === 1 ? "bot" : "bots"}` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
