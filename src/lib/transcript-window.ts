/** Long computer-use threads carry hundreds of rows (inline screenshots
 * included); mounting all of them makes the DOM heavy even though the memoized
 * list bails out of re-renders. Only the last `TRANSCRIPT_WINDOW_SIZE`
 * messages mount by default; a pill expands by the same step. */
export const TRANSCRIPT_WINDOW_SIZE = 120;

export interface TranscriptWindow<T> {
  visible: T[];
  /** Messages hidden before the window — the pill's "(X more)" count. */
  hiddenCount: number;
  /** The boundary actually applied after clamping; expand steps from this,
   * not from the stored value, so a clamped window expands predictably. */
  startIndex: number;
}

/** Boundary for a fresh window: the last `size` messages. */
export function tailWindowStart(total: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, total - size);
}

/** One "Show earlier" click: pull the boundary back by another `size`. */
export function expandWindowStart(startIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, startIndex - size);
}

/** Resolve a stored boundary against the current list. The boundary is
 * anchored — appends grow the window instead of sliding it, so rows the
 * reader is looking at never drop out from under them. Anchoring means a
 * thread that shrinks (branch switch, edit rewinding the tail) can leave the
 * boundary at or past the new end; that stale boundary falls back to a fresh
 * tail window rather than blanking the transcript. */
export function resolveTranscriptWindow<T>(
  messages: readonly T[],
  startIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
): TranscriptWindow<T> {
  const start =
    startIndex >= messages.length ? tailWindowStart(messages.length, size) : Math.max(0, startIndex);
  return { visible: messages.slice(start), hiddenCount: start, startIndex: start };
}
