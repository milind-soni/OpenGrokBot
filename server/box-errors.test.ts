// What the user is told when the box provider refuses. These strings are
// the whole difference between "box create failed (402)" and knowing you
// need to start a plan — so they are pinned, including the rule that the
// provider's own wording wins over ours.
import { describe, expect, it } from "vitest";

import { boxErrorMessage } from "./box.ts";

const billing = {
  ok: false,
  status: 402,
  code: "billing_required",
  message: "Start the $20/month Box plan to create sandboxes.",
  error: {
    code: "billing_required",
    details: { billingUrl: "https://box.ascii.dev/box/dashboard?tab=billing", accessTier: "trial" },
  },
};

describe("boxErrorMessage", () => {
  it("passes the provider's billing message through, with its link", () => {
    const msg = boxErrorMessage(402, "box create", billing);
    expect(msg).toContain("$20/month Box plan");
    expect(msg).toContain("https://box.ascii.dev/box/dashboard");
    expect(msg).not.toMatch(/\(402\)/);
  });

  it("still says something useful when the provider says nothing", () => {
    expect(boxErrorMessage(402, "box create", {})).toMatch(/paid Box plan/i);
  });

  it("tells you to re-paste the token on an auth failure", () => {
    const msg = boxErrorMessage(401, "box create", { message: "unauthorized" });
    expect(msg).toMatch(/token/i);
    expect(msg).toMatch(/box_/);
  });

  it("names the rate limit rather than a bare status", () => {
    expect(boxErrorMessage(429, "box create", { message: "Too many boxes created today." })).toBe(
      "Too many boxes created today.",
    );
  });

  it("falls back to the status when nothing is known", () => {
    expect(boxErrorMessage(500, "box create")).toBe("box create failed (500)");
  });
});
