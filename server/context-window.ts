// How big is this model's window? Drivers can say so on their catalog
// entries; most don't, so a small pattern table over the model id covers
// the engines OpenMausBot ships with, and anything unrecognised is treated
// as smallish rather than as a frontier model — over-estimating a window
// puts a rebuild over the line, under-estimating just summarizes earlier.
import type { ModelCatalog } from "./contracts.ts";
import { DEFAULT_CONTEXT_WINDOW } from "./context-rebuild.ts";

const TABLE: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/claude/i, 200_000],
  [/^(gpt-5|o[34]|codex)/i, 200_000],
  [/^gpt-4\.1/i, 1_000_000],
  [/^gpt-4o/i, 128_000],
  [/grok-4/i, 256_000],
  [/grok/i, 128_000],
  [/kimi|moonshot/i, 128_000],
  [/minimax/i, 200_000],
  [/qwen|deepseek|llama|mistral|gemma|phi/i, 32_000],
];

/** Dev/test override: pretend every model has this window, to watch
 * compaction happen on a short thread. */
const FORCED = Number(process.env.OMB_CONTEXT_WINDOW) || 0;

export function contextWindowFor(modelId: string | undefined, catalog?: ModelCatalog): number {
  if (FORCED > 0) return FORCED;
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  const declared = catalog?.options.find((o) => o.id === modelId)?.contextWindow;
  if (declared) return declared;
  // injected local models carry the host in the id (see local-inject.ts);
  // match on the model part too
  const bare = modelId.split("/").pop() ?? modelId;
  for (const [re, size] of TABLE) if (re.test(modelId) || re.test(bare)) return size;
  return DEFAULT_CONTEXT_WINDOW;
}
