// The quiet line where the model-facing context was compacted. Everything
// above it is still here — scroll up and it's all there — this only marks
// where a summary now stands in for the older turns when the thread is
// replayed to an engine. Expands to show the summary.
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Message } from "@/state/store";

export function CompactionDivider({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const c = message.compaction;
  if (!c) return null;
  return (
    <div className="my-2 flex w-full flex-col items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[11.5px] text-ink-secondary hover:text-ink"
        title="The conversation was summarized for the model here. Earlier messages are still above."
      >
        <span className="h-px w-16 bg-hairline/60" />
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        Context compacted · earlier messages are still here
        <span className="h-px w-16 bg-hairline/60" />
      </button>
      {open && (
        <div className="mt-2 max-w-[640px] whitespace-pre-wrap rounded-xl border border-hairline/40 bg-card px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
          {c.summary}
        </div>
      )}
    </div>
  );
}
