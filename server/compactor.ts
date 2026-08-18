// Producing the model-facing rebuild for a target model, compacting first
// when it will not fit. Called at dispatch for every path that rebuilds:
// the inline replay for a fresh or rewound engine, a transcript-replay
// driver's history, a room member's turn. The display path is never
// touched — a compaction is one more record in the tree.
import {
  budgetFor,
  estimateTextTokens,
  estimateTokens,
  planFold,
  replayEntries,
  summaryPrompt,
  type ReplayEntry,
} from "./context-rebuild.ts";
import type { Message, Store } from "./store.ts";

/** Newest entries always kept verbatim, even over budget. */
export const KEEP_TAIL = 12;

export interface RebuildResult {
  /** what to hand the model, oldest first — the summary is NOT included */
  entries: ReplayEntry[];
  /** the latest summary on the path, when one applies */
  summary?: string;
  /** true when this call wrote a new compaction record */
  compacted: boolean;
}

export async function rebuildForModel(input: {
  store: Store;
  threadId: string;
  contextWindow: number | undefined;
  /** the summarizer; absent (or throwing) means bound-by-dropping instead */
  generateText: ((prompt: string) => Promise<string>) | undefined;
  excludeId?: string;
  attribute?: boolean;
}): Promise<RebuildResult> {
  const { store, threadId, generateText, excludeId, attribute } = input;
  const budget = budgetFor(input.contextWindow);
  const ctx = store.modelContext(threadId);
  const entries = replayEntries(ctx.messages, { excludeId, attribute });
  const summaryTokens = ctx.summary ? estimateTextTokens(ctx.summary) : 0;

  const { fold } = planFold(entries, { budget, keepTail: KEEP_TAIL, summaryTokens });
  if (fold === 0) return { entries, summary: ctx.summary, compacted: false };

  const folded = entries.slice(0, fold);
  const kept = entries.slice(fold);

  if (generateText) {
    try {
      const summary = (await generateText(summaryPrompt(ctx.summary, folded))).trim();
      if (summary) {
        // the kept tail's first message id: entries and messages are not 1:1
        // (cards/screens are skipped), so find the message that produced the
        // first kept entry by counting renderable messages
        const firstKeptId = firstKeptMessageId(ctx.messages, fold, excludeId, attribute);
        if (firstKeptId) {
          store.appendCompaction(threadId, { summary, firstKeptId, tokensBefore: estimateTokens(entries) + summaryTokens });
          return { entries: kept, summary, compacted: true };
        }
      }
    } catch {
      // the summarizer is best-effort: never let it fail the turn
    }
  }
  // no summarizer, or it failed: bound the rebuild by dropping the oldest.
  // Nothing is written — the next attempt may have a summarizer again.
  return { entries: kept, summary: ctx.summary, compacted: false };
}

/** The id of the message behind the `fold`-th renderable entry. */
function firstKeptMessageId(messages: readonly Message[], fold: number, excludeId?: string, attribute?: boolean): string | null {
  let seen = 0;
  for (const m of messages) {
    if (m.id === excludeId) continue;
    if (replayEntries([m], { attribute }).length === 0) continue;
    if (seen === fold) return m.id;
    seen++;
  }
  return null;
}
