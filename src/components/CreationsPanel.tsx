import { useMemo, useState } from "react";
import { Code2, ImageIcon, Play, Sparkles, Video, X } from "lucide-react";

import type { CreationEntry, CreationKind } from "@/lib/creations";
import { cn } from "@/lib/cn";
import { formatTime } from "@/state/store";

type Filter = "all" | CreationKind;

const mediaUrl = (cacheKey: string) => `/api/media/${encodeURIComponent(cacheKey)}`;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "html", label: "HTML" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
];

function CreationPreview({ creation }: { creation: CreationEntry }) {
  if (creation.kind === "image" && creation.media?.cacheKey) {
    return (
      <img
        src={mediaUrl(creation.media.cacheKey)}
        alt=""
        loading="lazy"
        className="h-20 w-24 shrink-0 rounded-lg bg-inset object-cover"
      />
    );
  }
  if (creation.kind === "video") {
    return (
      <span className="flex h-20 w-24 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
        <span className="flex size-9 items-center justify-center rounded-full bg-raised">
          <Play size={16} className="ml-0.5" />
        </span>
      </span>
    );
  }
  return (
    <span className="flex h-20 w-24 shrink-0 items-center justify-center rounded-lg bg-inset text-accent">
      <Code2 size={26} />
    </span>
  );
}

function KindIcon({ kind }: { kind: CreationKind }) {
  if (kind === "image") return <ImageIcon size={13} />;
  if (kind === "video") return <Video size={13} />;
  return <Code2 size={13} />;
}

export function CreationsPanel({
  creations,
  onOpen,
  onClose,
}: {
  creations: CreationEntry[];
  onOpen: (creation: CreationEntry) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = filter === "all" ? creations : creations.filter((creation) => creation.kind === filter);
  const groups = useMemo(() => {
    const grouped = new Map<string, CreationEntry[]>();
    for (const creation of visible) {
      const entries = grouped.get(creation.botId) ?? [];
      entries.push(creation);
      grouped.set(creation.botId, entries);
    }
    return [...grouped.values()];
  }, [visible]);

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="animate-pop-in flex max-h-[82%] w-[620px] flex-col rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[17px] font-semibold text-ink">
            <Sparkles size={18} className="text-accent" /> Creations
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink" title="Close Creations">
            <X size={18} />
          </button>
        </div>
        <div className="mt-1 text-[13px] text-ink-secondary">HTML, images, and videos generated across your conversations.</div>

        <div className="mt-4 flex gap-1 rounded-lg bg-inset p-1" aria-label="Filter creations">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              onClick={() => setFilter(option.id)}
              aria-pressed={filter === option.id}
              className={cn(
                "flex-1 rounded-md px-2 py-1.5 text-[12.5px] transition-colors",
                filter === option.id ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-14 text-center">
              <Sparkles size={28} className="text-ink-secondary" />
              <div className="mt-3 text-[14px] font-medium text-ink">No creations yet</div>
              <div className="mt-1 max-w-[320px] text-[13px] leading-relaxed text-ink-secondary">
                Your HTML, images, and videos will appear here when a bot creates them.
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {groups.map((entries) => (
                <section key={entries[0]!.botId} aria-label={`${entries[0]!.botName} creations`}>
                  <div className="mb-2 flex items-center justify-between px-1">
                    <div className="truncate text-[13px] font-medium text-ink">{entries[0]!.botName}</div>
                    <div className="text-[11px] tabular-nums text-ink-secondary">{entries.length}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {entries.map((creation) => (
                      <button
                        key={creation.id}
                        onClick={() => onOpen(creation)}
                        className="flex min-w-0 items-center gap-3 rounded-xl border border-hairline/40 bg-card p-2 text-left hover:border-hairline hover:bg-raised/50"
                        aria-label={`Open ${creation.title}`}
                      >
                        <CreationPreview creation={creation} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1 text-[11px] capitalize text-ink-secondary">
                            <KindIcon kind={creation.kind} /> {creation.kind}
                          </span>
                          <span className="mt-1 block truncate text-[13px] font-medium text-ink">{creation.title}</span>
                          <span className="mt-1 block text-[11px] text-ink-secondary">{formatTime(creation.createdAt)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
