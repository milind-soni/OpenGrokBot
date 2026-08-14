import { afterEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import {
  OpenAICompatibleDriver,
  normalizeBaseUrl,
  normalizeEndpointPath,
  type OpenAIEndpointConfig,
} from "./openai-compatible.ts";
import { OpenRouterDriver } from "./openrouter.ts";

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

  it("keeps media routes same-origin and relative", () => {
    expect(normalizeEndpointPath("/images/generations", "/images")).toBe("/images/generations");
    expect(() => normalizeEndpointPath("https://attacker.example/images", "/images")).toThrow();
    expect(() => normalizeEndpointPath("//attacker.example/images", "/images")).toThrow();
    expect(() => normalizeEndpointPath("/images?target=internal", "/images")).toThrow();
  });
});

describe("OpenAI-compatible text driver", () => {
  it("discovers models from an endpoint that does not require a key", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
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

describe("OpenAI-compatible media generation", () => {
  it("generates base64 images with an abortable provider request", async () => {
    const tinyPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ b64_json: tinyPng }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = await createInstance({
      url: "https://models.example/v1",
      model: "example-chat",
      modelTasks: { "example-image": "image" },
    });
    const controller = new AbortController();

    const generated = await instance.generateMedia!({
      threadId: "thread-image",
      task: "image",
      model: "example-image",
      prompt: "a copper robot, 16:9",
      signal: controller.signal,
    });

    expect(generated).toEqual([
      expect.objectContaining({ kind: "image", source: { type: "base64", data: tinyPng, mime: "image/png" } }),
    ]);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://models.example/v1/images/generations");
    expect((request as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String((request as RequestInit).body))).toMatchObject({
      model: "example-image",
      prompt: "a copper robot, 16:9",
      response_format: "b64_json",
      aspect_ratio: "16:9",
    });
    await instance.dispose();
  });

  it("polls OpenRouter video jobs, forwards 9:16 and duration, and downloads only same-origin content", async () => {
    const videoBytes = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/videos")) {
        return new Response(JSON.stringify({ id: "job-1", polling_url: "https://attacker.example/steal" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/videos/job-1")) {
        return new Response(JSON.stringify({ status: "completed", unsigned_urls: ["http://[::ffff:127.0.0.1]/admin"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/videos/job-1/content?index=0")) {
        return new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await OpenRouterDriver.create({
      instanceId: "openrouter",
      displayName: "OpenRouter",
      environment: { OPENROUTER_API_KEY: "router-secret" },
      enabled: true,
      config: OpenRouterDriver.decodeConfig({ model: "google/veo-3.1" }),
    });

    const generated = await instance.generateMedia!({
      threadId: "thread-video",
      task: "video",
      model: "google/veo-3.1",
      prompt: "Make a 5 second funny vertical video in 9:16",
      signal: new AbortController().signal,
      pollIntervalMs: 0,
    });

    const submit = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/videos"))?.[1] as RequestInit;
    expect(JSON.parse(String(submit.body))).toMatchObject({
      model: "google/veo-3.1",
      duration: 5,
      aspect_ratio: "9:16",
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("attacker.example"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("::ffff"))).toBe(false);
    expect(generated[0]).toMatchObject({
      kind: "video",
      providerJobId: "job-1",
      source: { type: "bytes", mime: "video/mp4" },
    });
    await instance.dispose();
  });

  it("propagates AbortSignal cancellation into media fetches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      ),
    );
    const instance = await createInstance({ modelTasks: { "slow-image": "image" } });
    const controller = new AbortController();
    const generation = instance.generateMedia!({
      threadId: "thread-cancel",
      task: "image",
      model: "slow-image",
      prompt: "slow image",
      signal: controller.signal,
    });

    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(generation).rejects.toMatchObject({ name: "AbortError" });
    await instance.dispose();
  });

  it("cancels oversized error response readers", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1_100_000));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 500 })));
    const instance = await createInstance({ modelTasks: { "bad-image": "image" } });

    await expect(
      instance.generateMedia!({
        threadId: "thread-large-error",
        task: "image",
        model: "bad-image",
        prompt: "fail",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/response limit/i);
    expect(cancel).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });
});
