// Turn liveness: SAYING when a running turn has gone quiet. Stopping a
// wedged turn is the TurnWatchdog's job (server/turn-watchdog.ts — no
// activity for 20 minutes, waiting-on-human exempt); this is the earlier,
// softer signal: a "quiet for 3m" note next to Stop, so a human looking at
// the chat can decide long before the watchdog would. It watches the same
// event stream, driver-agnostic. Informative, not a verdict — a long silent
// tool run looks exactly like a hung engine from out here.

export type LivenessAction =
  | { threadId: string; action: "flag"; quietSince: number }
  | { threadId: string; action: "clear" };

interface Tracked {
  lastEventAt: number;
  flagged: boolean;
  /** parked on an approval or a question — waiting on a person is not quiet */
  waitingOnHuman: boolean;
}

export class TurnLiveness {
  private readonly turns = new Map<string, Tracked>();
  private readonly opts: { quietAfterMs: number };

  constructor(opts: { quietAfterMs: number }) {
    this.opts = opts;
  }

  /** A turn was dispatched. Restarting a thread resets its clock. */
  start(threadId: string, input: { at: number }) {
    this.turns.set(threadId, { lastEventAt: input.at, flagged: false, waitingOnHuman: false });
  }

  /** Any runtime event for the thread counts as a sign of life. */
  touch(threadId: string, at: number) {
    const t = this.turns.get(threadId);
    if (t) t.lastEventAt = at;
  }

  /** A card reached a human (or was answered). While waiting, the clock is
   * paused; when answered, it restarts from now. */
  setWaitingOnHuman(threadId: string, waiting: boolean, at: number) {
    const t = this.turns.get(threadId);
    if (!t) return;
    t.waitingOnHuman = waiting;
    t.lastEventAt = at;
  }

  /** The turn ended. Returns true when it was flagged, so the caller can
   * clear the note in the UI. */
  settle(threadId: string): boolean {
    const t = this.turns.get(threadId);
    this.turns.delete(threadId);
    return Boolean(t?.flagged);
  }

  /** When the thread went quiet, if it is currently flagged. */
  quietSince(threadId: string): number | null {
    const t = this.turns.get(threadId);
    return t?.flagged ? t.lastEventAt : null;
  }

  /** Advance the clock. Each transition is reported once. */
  tick(now: number): LivenessAction[] {
    const out: LivenessAction[] = [];
    for (const [threadId, t] of this.turns) {
      const quiet = !t.waitingOnHuman && now - t.lastEventAt >= this.opts.quietAfterMs;
      if (t.flagged && !quiet) {
        t.flagged = false;
        out.push({ threadId, action: "clear" });
      } else if (!t.flagged && quiet) {
        t.flagged = true;
        out.push({ threadId, action: "flag", quietSince: t.lastEventAt });
      }
    }
    return out;
  }
}
