import { afterEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import {
  OpenAICompatibleDriver,
  normalizeBaseUrl,
  type OpenAIEndpointConfig,
} from "./openai-compatible.ts";

const createInstance = async (
  config: Partial<OpenAIEndpointConfig> = {},
  environment: Record<string, string> = {},
) =>
  OpenAICompatibleDriver.create({
    instanceId: "endpoint",
    displayName: "Endpoint",
    environment,
    enabled: true,
    config: OpenAICompatibleDriver.decodeConfig(config),
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible endpoint validation", () => {
  it("normalizes an HTTP base URL without changing its path", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/v1");
  });

  it.each([
    "file:///tmp/provider",
    "https://user:password@example.com/v1",
    "https://example.com/v1?token=secret",
    "https://example.com/v1#models",
  ])("rejects unsafe or ambiguous base URL %s", (url) => {
    expect(() => normalizeBaseUrl(url)).toThrow();
  });

  it("does not let endpoint config select another provider's credential", () => {
    expect(
      OpenAICompatibleDriver.decodeConfig({
        apiKeyEnv: "OPENROUTER_API_KEY",
      }).apiKeyEnv,
    ).toBe("OPENAI_COMPATIBLE_API_KEY");
  });
});

describe("OpenAI-compatible text driver", () => {
  it("discovers models from an endpoint that does not require a key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "qwen2.5-coder" }, { id: "deepseek-r1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = await createInstance({ url: "http://192.168.1.20:8000/v1", model: "qwen2.5-coder" });

    await expect(instance.snapshot()).resolves.toMatchObject({ state: "available", authenticated: true });
    expect(instance.models).toEqual({
      default: "qwen2.5-coder",
      options: [
        { id: "qwen2.5-coder", label: "qwen2.5-coder" },
        { id: "deepseek-r1", label: "deepseek-r1" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.20:8000/v1/models",
      expect.objectContaining({ headers: expect.not.objectContaining({ authorization: expect.anything() }) }),
    );
    await instance.dispose();
  });

  it("streams a chat completion and sends only its configured credential", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(body, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = await createInstance(
      { url: "https://models.example/v1", model: "example-chat" },
      { OPENAI_COMPATIBLE_API_KEY: "endpoint-secret" },
    );
    const events = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread-1", text: "Hi" });
    const completed = await events.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true });
    expect(events.events.filter((event) => event.type === "content.delta")).toHaveLength(2);
    expect(events.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "hello world" }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(request.headers).toMatchObject({ authorization: "Bearer endpoint-secret" });
    expect(JSON.parse(String(request.body))).toMatchObject({ model: "example-chat", stream: true });
    events.stop();
    await instance.dispose();
  });

  it("cancels the response reader when a streamed API error aborts parsing", async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"error":{"message":"provider exploded"}}\n\n'));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const instance = await createInstance({ url: "https://models.example/v1", model: "example-chat" });
    const events = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread-error", text: "Hi" });
    const completed = await events.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(cancel).toHaveBeenCalledTimes(1);
    events.stop();
    await instance.dispose();
  });

  it("cancels oversized HTTP error bodies instead of buffering them", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1_100_000));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 500 })));
    const instance = await createInstance({ url: "https://models.example/v1", model: "example-chat" });

    await expect(instance.generateText!("Hi")).rejects.toThrow(/response limit/i);
    expect(cancel).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });
});
