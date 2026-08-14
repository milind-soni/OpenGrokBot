import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Expand, LoaderCircle, Square, X } from "lucide-react";

import type { MediaOutput } from "@/state/store";
import { cn } from "@/lib/cn";

function mediaUrl(output: MediaOutput) {
  return output.cacheKey ? `/api/media/${encodeURIComponent(output.cacheKey)}` : "";
}

export function MediaViewer({ output, onClose }: { output: MediaOutput; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button, video[controls]")]
        .filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus.current?.focus();
    };
  }, [onClose]);

  const url = mediaUrl(output);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${output.kind} viewer`}
        className="relative flex max-h-full max-w-full items-center justify-center rounded-xl bg-black p-2 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close media viewer"
          className="absolute right-3 top-3 z-10 rounded-full bg-black/70 p-2 text-white hover:bg-black"
        >
          <X size={18} />
        </button>
        {output.kind === "image" ? (
          <img src={url} alt="Generated image" className="max-h-[88vh] max-w-[90vw] object-contain" />
        ) : (
          <video src={url} controls autoPlay className="max-h-[88vh] max-w-[90vw]" tabIndex={0} />
        )}
      </div>
    </div>
  );
}

export function MediaMessage({
  messageId,
  outputs,
  onCancel,
}: {
  messageId: string;
  outputs: MediaOutput[];
  onCancel: (messageId: string) => void;
}) {
  const [viewing, setViewing] = useState<MediaOutput | null>(null);

  return (
    <div className="flex max-w-[680px] flex-col gap-2">
      {outputs.map((output) => {
        const active = output.status === "queued" || output.status === "generating" || output.status === "downloading";
        const percent = output.progress !== undefined ? `${Math.round(output.progress * 100)}%` : "";
        if (active) {
          return (
            <div key={output.id} className="flex min-w-[320px] items-center gap-3 rounded-xl bg-card px-4 py-3 text-[13px] text-ink">
              <LoaderCircle size={16} className="animate-spin text-accent" />
              <span className="flex-1">
                {output.status === "downloading" ? "Saving" : "Generating"} {output.kind}… {percent}
              </span>
              <button
                type="button"
                onClick={() => onCancel(messageId)}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <Square size={10} fill="currentColor" /> Stop
              </button>
            </div>
          );
        }
        if (output.status === "failed" || output.status === "cancelled") {
          return (
            <div
              key={output.id}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-4 py-3 text-[13px]",
                output.status === "failed" ? "border-danger/40 bg-danger/10 text-danger" : "border-hairline/40 bg-card text-ink-secondary",
              )}
            >
              <AlertTriangle size={15} /> {output.error ?? `${output.kind} generation ${output.status}`}
            </div>
          );
        }
        const url = mediaUrl(output);
        if (!url) return null;
        return (
          <div key={output.id} className="group relative overflow-hidden rounded-xl bg-card">
            {output.kind === "image" ? (
              <button type="button" onClick={() => setViewing(output)} aria-label="Open image" className="block">
                <img src={url} alt="Generated image" className="max-h-[620px] w-auto max-w-full object-contain" />
              </button>
            ) : (
              <video src={url} controls preload="metadata" className="max-h-[620px] max-w-full" />
            )}
            <button
              type="button"
              onClick={() => setViewing(output)}
              aria-label={`Open ${output.kind}`}
              className="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg bg-black/70 px-2.5 py-1.5 text-[12px] text-white opacity-90 hover:bg-black group-hover:opacity-100"
            >
              <Expand size={14} /> Open
            </button>
          </div>
        );
      })}
      {viewing && <MediaViewer output={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
