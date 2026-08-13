import { useEffect, useState } from "react";
import { AlertTriangle, Copy, Download, Loader2, Maximize2, RefreshCw, X } from "lucide-react";

import type { MediaOutput, Message } from "@/state/store";

const mediaUrl = (cacheKey: string) => `/api/media/${encodeURIComponent(cacheKey)}`;

function statusLabel(media: MediaOutput): string {
  if (media.status === "queued") return `Queued ${media.kind}`;
  if (media.status === "downloading") return `Saving ${media.kind}`;
  if (media.status === "cancelled") return `${media.kind === "image" ? "Image" : "Video"} generation cancelled`;
  return `Generating ${media.kind}`;
}

function MediaFailure({ media, onRetry }: { media: MediaOutput[]; onRetry?: () => void }) {
  const message = media.find((item) => item.error)?.error ?? "Media generation did not complete.";
  return (
    <div className="max-w-[85%] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{message}</span>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
        >
          <RefreshCw size={12} /> Retry
        </button>
      )}
    </div>
  );
}

function MediaProgress({ media }: { media: MediaOutput[] }) {
  const active = media.find((item) => item.status !== "ready") ?? media[0]!;
  const percent =
    active.progress === undefined
      ? null
      : Math.round(active.progress <= 1 ? active.progress * 100 : active.progress);
  return (
    <div className="max-w-[85%] rounded-2xl border border-hairline/40 bg-card px-4 py-3 text-ink">
      <div className="flex items-center gap-2.5 text-[13.5px]">
        <Loader2 size={15} className="animate-spin text-accent" />
        <span>{statusLabel(active)}…</span>
        {percent !== null && <span className="tabular-nums text-ink-secondary">{percent}%</span>}
      </div>
      {percent !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-inset" aria-label={`${percent}% complete`}>
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
        </div>
      )}
    </div>
  );
}

export function MediaViewer({ media, onClose }: { media: MediaOutput; onClose: () => void }) {
  if (!media.cacheKey) return null;
  const video = media.kind === "video";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Generated ${media.kind} viewer`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
      onClick={onClose}
    >
      <button onClick={onClose} className="absolute right-5 top-5 rounded-full bg-black/60 p-2 text-white hover:bg-black" title={`Close ${media.kind} viewer`}>
        <X size={20} />
      </button>
      {video ? (
        <video
          controls
          autoPlay
          src={mediaUrl(media.cacheKey)}
          className="max-h-full max-w-full bg-black object-contain"
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <img
          src={mediaUrl(media.cacheKey)}
          alt="Generated image enlarged"
          className="max-h-full max-w-full object-contain"
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </div>
  );
}

export function MediaMessage({
  message,
  onRetry,
  requestedMediaId,
  openRequestId,
}: {
  message: Message;
  onRetry?: () => void;
  requestedMediaId?: string;
  openRequestId?: string;
}) {
  const media = message.media ?? [];
  const [viewer, setViewer] = useState<MediaOutput | null>(null);
  useEffect(() => {
    if (!openRequestId || !requestedMediaId) return;
    const requested = media.find(
      (item) => item.id === requestedMediaId && item.status === "ready" && item.cacheKey,
    );
    if (requested) setViewer(requested);
  }, [media, openRequestId, requestedMediaId]);
  const terminalFailure =
    media.length > 0 && media.every((item) => item.status === "failed" || item.status === "cancelled");
  if (terminalFailure) return <MediaFailure media={media} onRetry={onRetry} />;
  if (media.some((item) => item.status !== "ready" && item.status !== "failed" && item.status !== "cancelled")) {
    return <MediaProgress media={media} />;
  }

  const ready = media.filter((item) => item.status === "ready" && item.cacheKey);
  if (!ready.length) return <MediaFailure media={media} onRetry={onRetry} />;

  const copyImage = async (item: MediaOutput) => {
    if (!item.cacheKey || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return;
    const blob = await fetch(mediaUrl(item.cacheKey)).then((response) => response.blob());
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  };

  return (
    <div className="w-full max-w-[85%]">
      <div className={ready.length > 1 ? "grid grid-cols-2 gap-2" : "space-y-2"}>
        {ready.map((item, index) => {
          const src = mediaUrl(item.cacheKey!);
          if (item.kind === "video") {
            return (
              <div key={item.id} data-media-id={item.id} className="group/media overflow-hidden rounded-2xl border border-hairline/40 bg-card">
                <video controls preload="metadata" src={src} className="max-h-[520px] w-full bg-black object-contain" />
                <div className="flex items-center justify-between px-3 py-2 text-[12px] text-ink-secondary">
                  <span>{item.durationSeconds ? `${item.durationSeconds}s generated video` : "Generated video"}</span>
                  <span className="flex items-center gap-1">
                    <button onClick={() => setViewer(item)} className="rounded p-1 hover:bg-raised hover:text-ink" title="Open video viewer">
                      <Maximize2 size={14} />
                    </button>
                    <a href={src} download={`generated-video-${index + 1}`} className="rounded p-1 hover:bg-raised hover:text-ink" title="Download video">
                      <Download size={14} />
                    </a>
                  </span>
                </div>
              </div>
            );
          }
          return (
            <div key={item.id} data-media-id={item.id} className="group/media relative overflow-hidden rounded-2xl border border-hairline/40 bg-card">
              <button onClick={() => setViewer(item)} className="block w-full cursor-zoom-in" title="Open image viewer">
                <img
                  src={src}
                  alt={`Generated image ${index + 1}`}
                  loading="lazy"
                  width={item.width}
                  height={item.height}
                  className="max-h-[520px] w-full object-contain"
                />
              </button>
              <div className="absolute right-2 top-2 flex gap-1 rounded-lg bg-black/65 p-1 text-white opacity-0 backdrop-blur transition-opacity group-hover/media:opacity-100 group-focus-within/media:opacity-100">
                <button onClick={() => setViewer(item)} className="rounded p-1 hover:bg-white/15" title="Open image viewer">
                  <Maximize2 size={14} />
                </button>
                <button onClick={() => void copyImage(item)} className="rounded p-1 hover:bg-white/15" title="Copy image">
                  <Copy size={14} />
                </button>
                <a href={src} download={`generated-image-${index + 1}`} className="rounded p-1 hover:bg-white/15" title="Download image">
                  <Download size={14} />
                </a>
              </div>
            </div>
          );
        })}
      </div>
      {viewer && <MediaViewer media={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}
