/** "3m" / "1h 12m" — how long a turn has been quiet, for the header note
 * and the sidebar preview. */
export function quietFor(since: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - since) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
