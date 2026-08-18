import { describe, expect, it } from "vitest";

import { mergeCurrentConnectorStatus, type ConnectorStatus } from "./PluginsPanel";

describe("connected-app status races", () => {
  it("does not let an older not_connected response erase a newer OAuth attempt", async () => {
    const generations = new Map([["gmail", 0]]);
    const initialRequestGenerations = new Map(generations);
    let deliverInitialResponse: (value: Record<string, ConnectorStatus>) => void = () => {};
    const delayedInitialResponse = new Promise<Record<string, ConnectorStatus>>((resolve) => {
      deliverInitialResponse = resolve;
    });

    generations.set("gmail", 1);
    const localOAuthState = {
      gmail: { connected: false, pending: true, status: "INITIATED" },
    };
    deliverInitialResponse({ gmail: { connected: false, pending: false, status: "not_connected" } });

    const merged = mergeCurrentConnectorStatus(
      localOAuthState,
      await delayedInitialResponse,
      generations,
      initialRequestGenerations,
    );

    expect(merged.gmail).toEqual({ connected: false, pending: true, status: "INITIATED" });
  });

  it("still applies a response from the current generation", () => {
    const generations = new Map([["gmail", 1]]);
    const merged = mergeCurrentConnectorStatus(
      { gmail: { connected: false, pending: true, status: "INITIATED" } },
      { gmail: { connected: true, pending: false, status: "ACTIVE" } },
      generations,
      new Map(generations),
    );

    expect(merged.gmail).toEqual({ connected: true, pending: false, status: "ACTIVE" });
  });
});
