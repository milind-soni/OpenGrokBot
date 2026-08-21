import { afterEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { BoxAgentDriver } from "./boxagent.ts";

describe("BoxAgentDriver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the explicit provider instead of inferring it from the model id", async () => {
    let promptBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/boxes/box-1/prompt")) {
          promptBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ promptId: "prompt-1" }), { status: 200 });
        }
        if (url.endsWith("/boxes/box-1/events")) {
          return new Response(JSON.stringify({ events: [] }), { status: 200 });
        }
        if (url.endsWith("/boxes/box-1/prompts/prompt-1")) {
          return new Response(JSON.stringify({ promptRun: { status: "finished", result: "done" } }), { status: 200 });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    );
    const instance = await BoxAgentDriver.create({
      instanceId: "computer",
      displayName: "Computer",
      environment: { BOX_TOKEN: "test-token" },
      enabled: true,
      config: { pollMs: 1 },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "box-turn",
      text: "go",
      model: "gpt-custom-but-claude-routed",
      modelProvider: "claude-code",
      integrations: { computer: { kind: "box", boxId: "box-1", token: "test-token" } },
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(promptBody).toMatchObject({
      provider: "claude-code",
      model: "gpt-custom-but-claude-routed",
    });
    recorder.stop();
    await instance.dispose();
  });
});
