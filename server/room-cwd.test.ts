import { describe, expect, it } from "vitest";

import { groupTurnCwd } from "./room-cwd.ts";

describe("groupTurnCwd", () => {
  it("the room's pinned folder overrides the member's own default", () => {
    expect(groupTurnCwd("/tmp/room", "/workspaces/bot-a")).toBe("/tmp/room");
  });

  it("a room with no folder keeps each member's own default", () => {
    expect(groupTurnCwd(null, "/workspaces/bot-a")).toBe("/workspaces/bot-a");
  });

  it("an off-host member (cloud box, API engine) gets no folder even when the room has one", () => {
    expect(groupTurnCwd("/tmp/room", undefined)).toBeUndefined();
    expect(groupTurnCwd(null, undefined)).toBeUndefined();
  });
});
