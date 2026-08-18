import { describe, expect, it } from "vitest";

import { webhookMessageView } from "./webhook-message";

describe("webhookMessageView", () => {
  it("presents an authenticated webhook task without its trust wrappers", () => {
    const text = [
      "[AUTHENTICATED WEBHOOK TASK]",
      "Summarize the failed deploy and suggest the first check.",
      "[/AUTHENTICATED WEBHOOK TASK]",
      "",
      "[UNTRUSTED WEBHOOK EVENT DATA]",
      "Received: 2026-08-16T12:47:58.969Z",
      "Delivery ID: deploy-418",
      "Event: deployment.failed",
      "",
      JSON.stringify({ task: "Summarize the failed deploy and suggest the first check.", service: "checkout-api", environment: "production" }, null, 2),
      "[/UNTRUSTED WEBHOOK EVENT DATA]",
    ].join("\n");

    expect(webhookMessageView(text)).toEqual({
      task: "Summarize the failed deploy and suggest the first check.",
      payload: JSON.stringify({ task: "Summarize the failed deploy and suggest the first check.", service: "checkout-api", environment: "production" }, null, 2),
    });
  });

  it("supports configured instructions and leaves normal chat messages alone", () => {
    const webhook = "[USER-CONFIGURED WEBHOOK INSTRUCTIONS]\nTriage every build failure.\n[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]\n\n[UNTRUSTED WEBHOOK EVENT DATA]\nEvent: build.failed\n\nraw payload\n[/UNTRUSTED WEBHOOK EVENT DATA]";
    expect(webhookMessageView(webhook)).toMatchObject({ task: "Triage every build failure.", payload: "raw payload" });
    expect(webhookMessageView("hello from a person")).toBeNull();
  });
});
