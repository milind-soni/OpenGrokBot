// Matching for the sidebar filter and the command palette. Both need the
// same two questions answered — "does this text match what was typed?" and
// "how well?" — so the ranking lives in one place rather than drifting
// between the two surfaces.

const normalize = (value: string) => value.toLowerCase().trim();

/**
 * Score `text` against `query`, higher is better, 0 = no match.
 *
 * Exact prefix beats word-start beats substring beats subsequence, so
 * typing "cl" ranks "Claude" over "Local computer" over "recall". The
 * subsequence pass is what makes a palette feel fuzzy ("bsc" → "Bot's
 * computer") without pulling in a matcher dependency.
 */
export function score(text: string, query: string): number {
  const t = normalize(text);
  const q = normalize(query);
  if (!q) return 1;
  if (!t) return 0;

  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - t.length;
  // word-start: "computer panel" matches "pan"
  if (t.split(/[\s\-_/]+/).some((word) => word.startsWith(q))) return 800 - t.length;
  const at = t.indexOf(q);
  if (at !== -1) return 700 - at - t.length / 100;

  // subsequence: every query character appears in order
  let cursor = 0;
  let gaps = 0;
  for (const char of q) {
    const found = t.indexOf(char, cursor);
    if (found === -1) return 0;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return Math.max(1, 500 - gaps);
}

/** Best score across several haystacks (name, title, transcript, …). */
export function scoreAny(texts: Array<string | undefined | null>, query: string): number {
  let best = 0;
  for (const text of texts) {
    if (!text) continue;
    const value = score(text, query);
    if (value > best) best = value;
  }
  return best;
}
