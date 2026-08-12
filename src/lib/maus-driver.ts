/**
 * One animation frame for every Maus on screen.
 *
 * The reference engine starts a requestAnimationFrame loop per avatar, which is
 * fine for a hero but not for a sidebar of bots or the appearance picker's grid.
 * Subscribers share a single loop, and the loop stops entirely once the last one
 * unmounts — a screen with no avatars costs nothing.
 */
type Tick = (now: number) => void;

const subscribers = new Set<Tick>();
let frame = 0;

function loop(now: number) {
  frame = requestAnimationFrame(loop);
  // Copied, so a subscriber unmounting mid-tick cannot mutate the live set.
  for (const tick of [...subscribers]) tick(now);
}

export function subscribeToFrames(tick: Tick): () => void {
  subscribers.add(tick);
  if (!frame) frame = requestAnimationFrame(loop);

  return () => {
    subscribers.delete(tick);
    if (subscribers.size === 0 && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}

/** Exposed for the preview's perf readout. */
export function activeFrameSubscribers() {
  return subscribers.size;
}
