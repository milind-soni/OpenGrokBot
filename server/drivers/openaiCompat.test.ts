import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { OpenAICompatDriver } from "./openaiCompat.ts";

describe("OpenAI-compatible driver", () => {
  let server: Server;
  let baseUrl: string;
  let instance: ProviderInstance | undefined;
  const requests: Array<{ url: string; authorization?: string }> = [];

  beforeEach(async () => {
    requests.length = 0;
    server = createServer((req, res) => {
      requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "local/stellar-7b" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("discovers models and streams authenticated completion deltas", async () => {
    instance = await OpenAICompatDriver.create({
      instanceId: "custom-test",
      displayName: "Custom test",
      environment: { OPENAI_COMPAT_API_KEY: "secret-key" },
      enabled: true,
      config: {
        baseUrl,
        models: [],
        defaultModel: "",
        apiKeyEnv: "OPENAI_COMPAT_API_KEY",
        discoverModels: true,
      },
    });

    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    expect(instance.models.options).toEqual([{ id: "local/stellar-7b", label: "Stellar 7b" }]);

    const events: RuntimeEvent[] = [];
    const done = new Promise<void>((resolve) => {
      instance!.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed") resolve();
      });
    });
    await instance.adapter.sendTurn({ threadId: "thread-1", text: "Hello", model: "local/stellar-7b" });
    await done;

    expect(
      events.filter((event) => event.type === "content.delta").map((event) => event.delta),
    ).toEqual(["hello ", "world"]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(requests.every((request) => request.authorization === "Bearer secret-key")).toBe(true);
  });

  it("reports an actionable unavailable reason when unconfigured", async () => {
    instance = await OpenAICompatDriver.create({
      instanceId: "custom-test",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: {
        baseUrl: "",
        models: [],
        defaultModel: "",
        apiKeyEnv: "",
        discoverModels: true,
      },
    });
    expect(await instance.snapshot()).toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("add a base URL"),
    });
  });
});
