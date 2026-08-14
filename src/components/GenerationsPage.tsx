import { useCallback, useEffect, useMemo, useState } from "react";
import { Code2, Film, Image as ImageIcon, Loader2, RefreshCw, Search, Sparkles } from "lucide-react";

import { ArtifactPanel } from "./ArtifactPanel";
import { MediaViewer } from "./MediaMessage";
import { api } from "@/state/store";
import { collectGenerations, type GenerationItem, type GenerationSource } from "@/lib/generations";
import { cn } from "@/lib/cn";

function htmlSummary(html: string) {
  return html
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Interactive HTML preview";
}

export function GenerationCard({ item, onOpen }: { item: GenerationItem; onOpen: (item: GenerationItem) => void }) {
  const title = item.kind === "html" ? "HTML creation" : item.kind === "image" ? "Image" : "Video";
  const url = item.kind === "html" ? "" : `/api/media/${encodeURIComponent(item.output.cacheKey!)}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-label={`Open ${item.kind} generation from ${item.ownerName}`}
      className="group overflow-hidden rounded-2xl border border-hairline/40 bg-card text-left transition hover:-translate-y-0.5 hover:border-hairline hover:shadow-xl hover:shadow-black/20"
    >
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-inset">
        {item.kind === "html" ? (
          <div className="flex size-full flex-col justify-between bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,.16),transparent_55%)] p-5">
            <Code2 size={24} className="text-accent" />
            <div className="line-clamp-4 text-[14px] leading-relaxed text-ink-secondary">
              {htmlSummary(item.artifact.html)}
            </div>
          </div>
        ) : item.kind === "image" ? (
          <img src={url} alt="" loading="lazy" className="size-full object-cover transition duration-300 group-hover:scale-[1.02]" />
        ) : (
          <div className="relative size-full">
            <video src={url} muted preload="metadata" className="size-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/20">
              <span className="rounded-full bg-black/65 p-3 text-white"><Film size={22} /></span>
            </span>
          </div>
        )}
      </div>
      <div className="p-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
            {item.kind === "html" ? <Code2 size={14} /> : item.kind === "image" ? <ImageIcon size={14} /> : <Film size={14} />}
            {title}
          </span>
          <span className="shrink-0 text-[11px] text-ink-secondary">
            {new Date(item.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
          </span>
        </div>
        <div className="mt-1 truncate text-[12px] text-ink-secondary">{item.ownerName} · {item.contextTitle}</div>
      </div>
    </button>
  );
}

type Filter = "all" | "html" | "image" | "video";

export function GenerationsPage() {
  const [sources, setSources] = useState<GenerationSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GenerationItem | null>(null);
  const [artifactWidth, setArtifactWidth] = useState(() => Math.min(Math.max(320, window.innerWidth * 0.42), 640));

  const refresh = useCallback(() => {
    setRefreshing(true);
    setError(null);
    return api("/api/generations")
      .then((result) => setSources(result.sources ?? []))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setRefreshing(false));
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const items = useMemo(() => collectGenerations(sources ?? []), [sources]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) =>
      (filter === "all" || item.kind === filter) &&
      (!needle || `${item.ownerName} ${item.contextTitle} ${item.kind}`.toLowerCase().includes(needle)),
    );
  }, [filter, items, query]);
  const open = (item: GenerationItem) => setSelected(item);

  return (
    <main className="flex h-full min-w-0 flex-1 bg-app">
      <section className="min-w-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[1120px]">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[20px] font-semibold text-ink">
                <Sparkles size={20} className="text-accent" /> Generations
              </div>
              <div className="mt-1 text-[13px] text-ink-secondary">
                Reopen HTML, images, and videos created across every bot and task.
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              aria-label="Refresh generations"
              title="Refresh generations"
            >
              <RefreshCw size={17} className={cn(refreshing && "animate-spin")} />
            </button>
          </header>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl bg-card p-1">
              {(["all", "html", "image", "video"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-[13px] capitalize",
                    filter === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {value === "all" ? `All ${items.length ? `(${items.length})` : ""}` : value === "html" ? "HTML" : value}
                </button>
              ))}
            </div>
            <label className="ml-auto flex min-w-[220px] items-center gap-2 rounded-xl bg-card px-3 py-2">
              <Search size={15} className="text-ink-secondary" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search generations"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </label>
          </div>

          {error && <div className="mt-5 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger">{error}</div>}
          {sources === null && !error ? (
            <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
              <Loader2 size={16} className="animate-spin" /> Loading generations…
            </div>
          ) : visible.length ? (
            <div className="mt-5 grid grid-cols-2 gap-4 min-[1180px]:grid-cols-3">
              {visible.map((item) => <GenerationCard key={item.id} item={item} onOpen={open} />)}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Sparkles size={28} className="text-ink-secondary/50" />
              <div className="mt-3 text-[15px] font-medium text-ink">No generations here yet</div>
              <div className="mt-1 max-w-[360px] text-[13px] text-ink-secondary">
                Ask a bot with a configured specialist for an image or video, or have it build an HTML creation.
              </div>
            </div>
          )}
        </div>
      </section>

      {selected?.kind === "html" && (
        <ArtifactPanel
          artifact={selected.artifact}
          width={artifactWidth}
          onWidthChange={setArtifactWidth}
          onClose={() => setSelected(null)}
        />
      )}
      {selected && selected.kind !== "html" && (
        <MediaViewer output={selected.output} onClose={() => setSelected(null)} />
      )}
    </main>
  );
}
