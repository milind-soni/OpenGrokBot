import { describe, expect, it } from "vitest";

import { TurnLiveness } from "./liveness.ts";

const MIN = 60_000;
const opts = { quietAfterMs: 2 * MIN };

describe("TurnLiveness", () => {
  it("flags a busy thread once it has been quiet past the threshold, and only once", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { at: 0 });
    expect(l.tick(1 * MIN)).toEqual([]);
    expect(l.tick(2 * MIN)).toEqual([{ threadId: "t1", action: "flag", quietSince: 0 }]);
    // still quiet: no repeat flag
    expect(l.tick(3 * MIN)).toEqual([]);
  });

  it("clears the flag when events resume, and can flag again later", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { at: 0 });
    l.tick(2 * MIN);
    l.touch("t1", 2.5 * MIN);
    expect(l.tick(2.6 * MIN)).toEqual([{ threadId: "t1", action: "clear" }]);
    expect(l.tick(4.4 * MIN)).toEqual([]);
    expect(l.tick(4.5 * MIN)).toEqual([{ threadId: "t1", action: "flag", quietSince: 2.5 * MIN }]);
  });

  it("a turn parked on a human is not quiet — no flag while waiting, clock restarts when answered", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { at: 0 });
    l.setWaitingOnHuman("t1", true, 0.5 * MIN);
    expect(l.tick(10 * MIN)).toEqual([]);
    l.setWaitingOnHuman("t1", false, 10 * MIN);
    expect(l.tick(11 * MIN)).toEqual([]);
    expect(l.tick(12 * MIN)).toEqual([{ threadId: "t1", action: "flag", quietSince: 10 * MIN }]);
    // going back to waiting while flagged clears the note
    l.setWaitingOnHuman("t1", true, 12.5 * MIN);
    expect(l.tick(13 * MIN)).toEqual([{ threadId: "t1", action: "clear" }]);
  });

  it("forgets a thread on settle — no flags after the turn ended", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { at: 0 });
    l.settle("t1");
    expect(l.tick(10 * MIN)).toEqual([]);
    expect(l.quietSince("t1")).toBeNull();
  });

  it("a settle on a flagged thread reports a clear so the UI drops the note", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { at: 0 });
    l.tick(2 * MIN);
    expect(l.settle("t1")).toBe(true); // was flagged
    expect(l.settle("t1")).toBe(false); // already gone
  });

  it("restarting a thread's turn resets its clock", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { at: 0 });
    l.tick(2 * MIN); // flagged
    l.start("t1", { at: 3 * MIN });
    expect(l.quietSince("t1")).toBeNull();
    expect(l.tick(4 * MIN)).toEqual([]);
    expect(l.tick(5 * MIN)).toEqual([{ threadId: "t1", action: "flag", quietSince: 3 * MIN }]);
  });
});
