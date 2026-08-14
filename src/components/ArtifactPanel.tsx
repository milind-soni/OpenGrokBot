import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Copy, Download, RefreshCw, ShieldCheck, X } from "lucide-react";

import { buildArtifactDocument, type HtmlArtifact } from "@/lib/html-artifacts";

const MIN_WIDTH = 320;

interface ResizePoint {
  clientX: number;
}

export function beginArtifactResize({
  startX,
  startWidth,
  maximumWidth,
  onWidthChange,
  capture,
  release,
  listen,
}: {
  startX: number;
  startWidth: number;
  maximumWidth: number;
  onWidthChange: (width: number) => void;
  capture: () => void;
  release: () => void;
  listen: (
    type: "pointermove" | "pointerup" | "pointercancel",
    listener: (event: ResizePoint) => void,
  ) => () => void;
}): () => void {
  let finished = false;
  const removeListeners: Array<() => void> = [];
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const remove of removeListeners.splice(0)) remove();
    release();
  };
  const clamp = (value: number) => Math.min(maximumWidth, Math.max(MIN_WIDTH, Math.round(value)));

  capture();
  removeListeners.push(
    listen("pointermove", (event) => onWidthChange(clamp(startWidth - (event.clientX - startX)))),
    listen("pointerup", finish),
    listen("pointercancel", finish),
  );
  return finish;
}

export function ArtifactPanel({
  artifact,
  width,
  onWidthChange,
  onClose,
}: {
  artifact: HtmlArtifact;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const finishResize = useRef<() => void>(() => {});

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => () => finishResize.current(), []);

  const maximum = () => Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.7));
  const clamp = (value: number) => Math.min(maximum(), Math.max(MIN_WIDTH, Math.round(value)));

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    finishResize.current();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const listen = (
      type: "pointermove" | "pointerup" | "pointercancel",
      listener: (point: ResizePoint) => void,
    ) => {
      const browserListener = listener as unknown as EventListener;
      window.addEventListener(type, browserListener);
      return () => window.removeEventListener(type, browserListener);
    };
    finishResize.current = beginArtifactResize({
      startX: event.clientX,
      startWidth: width,
      maximumWidth: maximum(),
      onWidthChange,
      capture: () => target.setPointerCapture?.(pointerId),
      release: () => {
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      },
      listen,
    });
  };

  const copy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(artifact.html);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([artifact.html], { type: "text/html;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `artifact-${artifact.index + 1}.html`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-hairline/50 bg-panel max-[799px]:fixed max-[799px]:inset-0 max-[799px]:z-40 max-[799px]:!w-full"
      style={{ width }}
      aria-label="HTML artifact workspace"
    >
      <div
        role="separator"
        aria-label="Resize artifact workspace"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={typeof window === "undefined" ? 1200 : maximum()}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onWidthChange(clamp(width + 24));
          else if (event.key === "ArrowRight") onWidthChange(clamp(width - 24));
          else if (event.key === "Home") onWidthChange(MIN_WIDTH);
          else if (event.key === "End") onWidthChange(maximum());
          else return;
          event.preventDefault();
        }}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent hover:after:bg-accent focus-visible:after:bg-accent max-[799px]:hidden"
      />
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-hairline/40 px-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-ink">artifact-{artifact.index + 1}.html</div>
          <div className="text-[10px] text-ink-secondary">Interactive preview</div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <span
            className="mr-1 rounded p-1 text-ink-secondary"
            title="Network access disabled"
            aria-label="Network access disabled"
          >
            <ShieldCheck size={14} />
          </span>
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Refresh preview"
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Copy HTML"
          >
            {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
          </button>
          <button
            type="button"
            onClick={download}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Download HTML"
          >
            <Download size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Close preview"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <iframe
        key={`${artifact.id}:${revision}`}
        title={`Preview of artifact ${artifact.index + 1}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={buildArtifactDocument(artifact.html)}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </aside>
  );
}
