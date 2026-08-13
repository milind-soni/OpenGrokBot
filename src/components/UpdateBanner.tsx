// Auto-update popup — a small card floating bottom-left, driven by the
// preload's updater bridge. Renders nothing in the browser/dev (no bridge)
// and while idle/checking; appears only when actionable: an update to
// download, a download in progress, a restart to apply, or an error.
import { useState } from "react";
import { ArrowDownToLine, RefreshCw, Sparkles, X } from "lucide-react";
import { useUpdaterState } from "@/lib/updater";

export function UpdateBanner() {
  const s = useUpdaterState();
  // dismissal is per status+version, so the popup returns for the next
  // update (and when an available one finishes downloading)
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!s || s.status === "idle" || s.status === "checking") return null;
  const key = `${s.status}:${s.version ?? ""}`;
  if (dismissed === key) return null;
  const updater = window.ogb!.updater!;

  const title =
    s.status === "available"
      ? `Mirxa Bot ${s.version} is available`
      : s.status === "downloading"
        ? `Downloading ${s.version ?? "update"}…`
        : s.status === "downloaded"
          ? `${s.version} is ready`
          : "Update check failed";
  const subtitle =
    s.status === "available"
      ? "A newer version is ready to download."
      : s.status === "downloading"
        ? `${Math.round(s.percent ?? 0)}%`
        : s.status === "downloaded"
          ? "Restart to finish updating."
          : (s.message ?? "Something went wrong.");

  return (
    <div className="animate-panel-in fixed bottom-4 left-4 z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary" title={subtitle}>
            {subtitle}
          </div>
        </div>
        {s.status !== "downloading" && (
          <button
            onClick={() => setDismissed(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {s.status === "downloading" && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-raised">
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.min(100, Math.max(0, s.percent ?? 0))}%` }}
          />
        </div>
      )}

      {s.status !== "downloading" && (
        <div className="mt-2.5 flex gap-2">
          {s.status === "available" && (
            <button
              onClick={() => void updater.download()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white"
            >
              <ArrowDownToLine size={13} /> Download
            </button>
          )}
          {s.status === "downloaded" && (
            <button
              onClick={() => void updater.install()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white"
            >
              <RefreshCw size={13} /> Restart to update
            </button>
          )}
          {s.status === "error" && (
            <button
              onClick={() => void updater.check()}
              className="flex-1 rounded-lg bg-raised py-1.5 text-[13px] text-ink hover:bg-raised-hover"
            >
              Try again
            </button>
          )}
          <button
            onClick={() => setDismissed(key)}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Later
          </button>
        </div>
      )}
    </div>
  );
}
