import { afterEach, describe, expect, it, vi } from "vitest";

import { GrokDriver } from "./grok.ts";

describe("GrokDriver catalog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the account model list from the xAI API", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "grok-current" }, { id: "grok-next" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = await GrokDriver.create({
      instanceId: "grok-api-test",
      displayName: "Grok API Test",
      environment: { XAI_API_KEY: "test-key" },
      enabled: true,
      config: { url: "https://xai.test/v1", apiKeyEnv: "XAI_API_KEY" },
    });

    await expect(instance.catalog()).resolves.toEqual({
      default: { model: "grok-current" },
      options: [
        { id: "grok-current", label: "grok-current" },
        { id: "grok-next", label: "grok-next" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://xai.test/v1/models",
      expect.objectContaining({ headers: { authorization: "Bearer test-key" } }),
    );
    await instance.dispose();
  });

  it("does not substitute a hardcoded model when selection is missing", async () => {
    const instance = await GrokDriver.create({
      instanceId: "grok-api-test",
      displayName: "Grok API Test",
      environment: { XAI_API_KEY: "test-key" },
      enabled: true,
      config: { url: "https://xai.test/v1", apiKeyEnv: "XAI_API_KEY" },
    });

    await expect(instance.adapter.sendTurn({ threadId: "missing-model", text: "go" })).rejects.toThrow(
      /model selection is required/,
    );
    await instance.dispose();
  });
});
