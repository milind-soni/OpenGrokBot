// The model-facing rebuild of a thread. There are two transcripts and only
// one of them shrinks: the display path — store.activePath(), shipped whole
// to the app — grows without bound and is never touched. What a model
// receives when it has no native session (a fresh engine, a rewind, a
// transcript-replay driver, a room) is bounded here, and bounded FOR THE
// TARGET: the same thread may be handed to an 8k local model and a 200k
// Claude, so the budget is a function of the model, and a summary is a
// cached input to the rebuild, never its fixed output.
import type { Message } from "./store.ts";

export interface ReplayEntry {
  role: "user" | "assistant";
  text: string;
}

/** Everything a rebuild needs to know about one message. Text is the
 * speaker's line; activity is a compact tool note — a handed-over engine
 * must see that work was done, not just people talking. Cards, screens
 * and error chips carry nothing a model can use. */
export function renderEntry(m: Message, opts: { attribute?: boolean } = {}): ReplayEntry | null {
  const role = m.role === "user" ? "user" : "assistant";
  if (m.kind === "activity") {
    const name = m.tool?.name ?? "";
    if (!name || name.startsWith("error:")) return null;
    return { role, text: `[tool: ${name} ${m.tool?.ok === false ? "✗" : "✓"}]` };
  }
  if (m.kind !== "text") return null;
  const text = (m.text ?? "").trim();
  if (!text) return null;
  const speaker = opts.attribute && m.role === "bot" && m.from?.name ? `${m.from.name}: ` : "";
  return { role, text: speaker + text };
}

export function replayEntries(path: readonly Message[], opts: { excludeId?: string; attribute?: boolean } = {}): ReplayEntry[] {
  const out: ReplayEntry[] = [];
  for (const m of path) {
    if (m.id === opts.excludeId) continue;
    const e = renderEntry(m, opts);
    if (e) out.push(e);
  }
  return out;
}

/** ~4 chars per token plus a little per entry for role framing. A
 * heuristic on purpose: provider-reported usage anchors it later. */
const CHARS_PER_TOKEN = 4;
const ENTRY_OVERHEAD = 4;
export function estimateTokens(entries: readonly ReplayEntry[]): number {
  return entries.reduce((n, e) => n + Math.ceil(e.text.length / CHARS_PER_TOKEN) + ENTRY_OVERHEAD, 0);
}
export const estimateTextTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** The replay may take this much of the window; the rest is the system
 * prompt, the tools, and room to answer. Scaled with the window rather
 * than a flat reserve — a flat 16k would leave an 8k model permanently
 * over the line — with a floor so a tiny window still gets the last few
 * turns. Unknown windows are assumed small-ish, not 200k. */
export const REPLAY_SHARE = 0.4;
export const REPLAY_FLOOR = 4_000;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export function budgetFor(contextWindow: number | undefined): number {
  const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return Math.max(REPLAY_FLOOR, Math.floor(window * REPLAY_SHARE));
}

/** How many of the oldest entries to fold into a summary so the rest fits.
 * The newest `keepTail` entries always stay verbatim, even over budget: a
 * small model should get the recent turns, not nothing. */
export function planFold(
  entries: readonly ReplayEntry[],
  opts: { budget: number; keepTail: number; summaryTokens?: number },
): { fold: number } {
  const room = opts.budget - (opts.summaryTokens ?? 0);
  if (estimateTokens(entries) <= room) return { fold: 0 };
  const minKeep = Math.min(opts.keepTail, entries.length);
  let fold = 0;
  while (entries.length - fold > minKeep && estimateTokens(entries.slice(fold)) > room) fold++;
  return { fold };
}

/** The prompt that turns folded entries (and any earlier summary) into the
 * next summary. Read and modified files are asked for explicitly so they
 * carry forward cumulatively across compactions. */
export function summaryPrompt(previousSummary: string | undefined, folded: readonly ReplayEntry[]): string {
  return [
    "You are compacting the earlier part of a long conversation between a user and an assistant so a model with a smaller context can continue it.",
    "Write a dense summary (aim for under 400 words) that preserves: the user's goals and constraints, decisions made, facts the user stated about themselves or their project, names, paths, URLs and identifiers, files that were read or modified, what work was completed and what remains open, and the current state of any task. Keep it in third person. Do not add advice or commentary.",
    previousSummary ? `Earlier summary (already compacted; carry its facts forward):\n${previousSummary}` : "",
    "Conversation to compact:",
    ...folded.map((e) => `${e.role === "user" ? "User" : "Assistant"}: ${e.text}`),
    "Summary:",
  ]
    .filter(Boolean)
    .join("\n\n");
}
