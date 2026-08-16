import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { OpenAICompatibleDriver } from "./openai-compatible.ts";
import type { ProviderInstance } from "../contracts.ts";

let server: ReturnType<typeof createServer>;
let baseUrl = "";
let instance: ProviderInstance;
let recorder: EventRecorder;
let responseMode: "stream" | "hold" | "unauthorized" | "rate-limited" = "stream";
let requestObserved!: () => void;
let requestStarted: Promise<void>;

beforeEach(async () => {
  responseMode = "stream";
  requestStarted = new Promise<void>((resolve) => { requestObserved = resolve; });
  server = createServer((req, res) => {
    if (req.url === "/v1/chat/completions") {
      requestObserved();
      if (responseMode === "unauthorized") return void res.writeHead(401).end("server-secret-error-body");
      if (responseMode === "rate-limited") return void res.writeHead(429).end("server-secret-error-body");
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (responseMode === "hold") {
        req.on("close", () => res.end());
        return;
      }
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      res.write('data: malformed\n\n');
      res.write('data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
  instance = await OpenAICompatibleDriver.create({
    instanceId: "test", displayName: "Test API", environment: { OPENAI_COMPAT_API_KEY: "secret" }, enabled: true,
    config: { baseUrl, apiKeyEnv: "OPENAI_COMPAT_API_KEY", requiresApiKey: true, models: [{ id: "test-model" }] },
  });
  recorder = recordEvents(instance.adapter);
});

afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("OpenAI-compatible driver", () => {
  it("normalizes streaming text and provider-reported usage", async () => {
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi", model: "test-model" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events.map((event) => event.type)).toEqual([
      "turn.started", "session.started", "content.delta", "content.delta", "item.completed", "thread.token-usage.updated", "turn.completed",
    ]);
    expect(recorder.events.find((event) => event.type === "item.completed")).toMatchObject({ text: "Hello world" });
    expect(recorder.events.find((event) => event.type === "thread.token-usage.updated")).toMatchObject({ input: 12, output: 3 });
  });

  it("does not make a provider available without a model", async () => {
    const empty = await OpenAICompatibleDriver.create({
      instanceId: "empty", displayName: undefined, environment: { OPENAI_COMPAT_API_KEY: "secret" }, enabled: true,
      config: { baseUrl, apiKeyEnv: "OPENAI_COMPAT_API_KEY", requiresApiKey: true, models: [] },
    });
    await expect(empty.snapshot()).resolves.toMatchObject({ state: "unavailable", reason: expect.stringMatching(/no models discovered/) });
    await empty.dispose();
  });

  it("interrupts an in-flight streaming turn without a spurious runtime error", async () => {
    responseMode = "hold";
    await instance.adapter.sendTurn({ threadId: "interrupted", text: "hi", model: "test-model" });
    await requestStarted;
    await instance.adapter.interruptTurn("interrupted");
    await recorder.until((event) => event.type === "turn.completed" && event.threadId === "interrupted");
    expect(recorder.events.find((event) => event.type === "turn.completed" && event.threadId === "interrupted")).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(recorder.events.some((event) => event.type === "runtime.error" && event.threadId === "interrupted")).toBe(false);
  });

  it.each(["unauthorized", "rate-limited"] as const)("reports %s safely without exposing response bodies", async (mode) => {
    responseMode = mode;
    await instance.adapter.sendTurn({ threadId: mode, text: "hi", model: "test-model" });
    await recorder.until((event) => event.type === "turn.completed" && event.threadId === mode);
    const error = recorder.events.find((event) => event.type === "runtime.error" && event.threadId === mode);
    expect(error).toMatchObject({ message: mode === "unauthorized" ? "provider authentication failed (HTTP 401)" : "provider rate limited the request (HTTP 429)" });
    expect(JSON.stringify(error)).not.toContain("server-secret-error-body");
  });

  it("rejects non-local HTTP endpoints and does not expose provider response bodies", async () => {
    expect(() => OpenAICompatibleDriver.decodeConfig({ baseUrl: "http://example.com/v1" })).toThrow(/HTTPS or local loopback/);
    const failed = await OpenAICompatibleDriver.create({
      instanceId: "failed", displayName: undefined, environment: { OPENAI_COMPAT_API_KEY: "secret" }, enabled: true,
      config: { baseUrl, apiKeyEnv: "OPENAI_COMPAT_API_KEY", requiresApiKey: true, models: [{ id: "test-model" }] },
    });
    await failed.dispose();
  });
});
