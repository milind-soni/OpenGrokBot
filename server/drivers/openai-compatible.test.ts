import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

let server: ReturnType<typeof createServer>;
let baseUrl = "";
const requests: Array<{
  method: string;
  url: string;
  authorization?: string;
  body?: any;
}> = [];
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function jsonBody(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const request = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      authorization: req.headers.authorization,
      body: req.method === "POST" ? await jsonBody(req) : undefined,
    };
    requests.push(request);

    if (
      request.method === "GET" &&
      (request.url === "/v1/models" || request.url === "/v1/models?output_modalities=all")
    ) {
      return json(res, 200, {
        data: [
          { id: "test-model", name: "Friendly test model" },
          { id: "second-model" },
          {
            id: "image-model",
            name: "Image model",
            input_modalities: ["text"],
            output_modalities: ["text", "image"],
          },
          {
            id: "video-model",
            name: "Video model",
            architecture: { input_modalities: ["text"], output_modalities: ["video"] },
          },
        ],
      });
    }
    if (request.method === "GET" && request.url === "/v1/videos/models") {
      return json(res, 200, { data: [{ id: "video-only-model", name: "Video only model" }] });
    }
    if (request.method === "GET" && request.url === "/v1/images/models") {
      return json(res, 200, { data: [{ id: "image-only-model", name: "Image only model" }] });
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      if (request.body.tools) {
        if (request.body.messages.some((message: any) => message.content === "reject media tools")) {
          return json(res, 400, { error: { message: "tools are unsupported" } });
        }
        const hasToolResult = request.body.messages.some((message: any) => message.role === "tool");
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (!hasToolResult) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-image-1","type":"function","function":{"name":"generate_image","arguments":"{\\"prompt\\":\\"copper "}}]}}]}\n\n',
          );
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"robot\\"}"}}]}}]}\n\n',
          );
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Your image is ready."}}]}\n\n');
        }
        res.end("data: [DONE]\n\n");
        return;
      }
      if (!request.body.stream) {
        return json(res, 200, {
          choices: [{ message: { role: "assistant", content: "short title" } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
      // Deliberately split one JSON event across writes; the driver must
      // buffer transport chunks until a complete SSE line arrives.
      res.write('data: {"choices":[{"delta":{"content":"hel');
      res.write('lo"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n');
      res.end("data: [DONE]\n\n");
      return;
    }
    if (request.method === "POST" && request.url === "/v1/internal-media") {
      return json(res, 200, { ok: true, task: request.body.task, messageId: "media-message-1" });
    }
    if (request.method === "POST" && request.url === "/v1/images/generations") {
      if (request.body.prompt === "reject this") {
        return json(res, 400, { error: { message: "prompt rejected" } });
      }
      return json(res, 200, {
        data: [{ b64_json: TINY_PNG_BASE64, media_type: "image/png", width: 1, height: 1 }],
      });
    }
    if (request.method === "POST" && request.url === "/v1/videos") {
      return json(res, 200, {
        id: "video-job-1",
        status: "queued",
        polling_url: `${baseUrl}/video-status/video-job-1`,
      });
    }
    if (request.method === "GET" && request.url === "/v1/video-status/video-job-1") {
      return json(res, 200, {
        id: "video-job-1",
        status: "completed",
        unsigned_urls: [`${baseUrl}/videos/video-job-1/content?index=0`],
        duration: 4,
      });
    }
    json(res, 404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

function testDriver(
  apiKeyRequired = false,
  extra: Partial<Parameters<typeof createOpenAICompatibleDriver>[0]> = {},
) {
  return createOpenAICompatibleDriver({
    driverKind: "compatibleTest",
    displayName: "Compatible Test",
    defaultUrl: baseUrl || "http://127.0.0.1:1/v1",
    defaultApiKeyEnv: "OMB_COMPAT_TEST_KEY",
    apiKeyRequired,
    defaultModel: "test-model",
    ...extra,
  });
}

describe("OpenAI-compatible driver", () => {
  it("validates and normalizes endpoint configuration", () => {
    const driver = testDriver();
    expect(driver.decodeConfig({ url: `${baseUrl}/`, model: " custom-model " })).toEqual({
      url: baseUrl,
      apiKeyEnv: "OMB_COMPAT_TEST_KEY",
      model: "custom-model",
      modelTasks: {},
      imagePath: "/images/generations",
      videoPath: "/videos",
    });
    expect(
      driver.decodeConfig({
        url: baseUrl,
        modelTasks: { "custom-image": "image", "custom-video": "video" },
        imagePath: "/generate/image",
        videoPath: "/generate/video",
      }),
    ).toMatchObject({
      modelTasks: { "custom-image": "image", "custom-video": "video" },
      imagePath: "/generate/image",
      videoPath: "/generate/video",
    });
    expect(() => driver.decodeConfig({ url: "ftp://models.example/v1" })).toThrow(/http or https/);
    expect(() => driver.decodeConfig({ url: "not a url" })).toThrow(/absolute http/);
    expect(() => driver.decodeConfig({ modelTasks: { unsafe: "audio" } })).toThrow(/modelTasks/);
    expect(() => driver.decodeConfig({ imagePath: "https://evil.example/images" })).toThrow(/relative path/);
    expect(() => driver.decodeConfig({ videoPath: "/../secrets" })).toThrow(/relative path/);
    expect(() => driver.decodeConfig("bad")).toThrow(/object/);
  });

  it("fails closed when a provider requires a missing API key", async () => {
    const driver = testDriver(true);
    const instance = await driver.create({
      instanceId: "required",
      displayName: "Required",
      environment: {},
      enabled: true,
      config: driver.decodeConfig({ url: baseUrl }),
    });

    expect(await instance.snapshot()).toMatchObject({
      state: "unavailable",
      authenticated: false,
      reason: expect.stringContaining("OMB_COMPAT_TEST_KEY"),
    });
    await expect(
      instance.adapter.sendTurn({ threadId: "missing-key", text: "hello", model: "test-model" }),
    ).rejects.toThrow(/API key/);
    await instance.dispose();
  });

  it("discovers models and streams transcript, reasoning, text, and usage", async () => {
    requests.length = 0;
    const driver = testDriver(true);
    const instance = await driver.create({
      instanceId: "remote",
      displayName: "Remote",
      environment: { OMB_COMPAT_TEST_KEY: "secret-test-key" },
      enabled: true,
      config: driver.decodeConfig({ url: baseUrl, model: "test-model" }),
    });

    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      authenticated: true,
      version: "4 models",
    });
    expect(instance.models).toEqual({
      default: "test-model",
      options: [
        { id: "test-model", label: "Friendly test model" },
        { id: "second-model", label: "second-model" },
        {
          id: "image-model",
          label: "Image model",
          task: "image",
          inputModalities: ["text"],
          outputModalities: ["text", "image"],
        },
        {
          id: "video-model",
          label: "Video model",
          task: "video",
          inputModalities: ["text"],
          outputModalities: ["video"],
        },
      ],
    });

    const events: RuntimeEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      instance.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed") resolve();
      });
    });
    await instance.adapter.sendTurn({
      threadId: "streaming",
      text: "latest",
      model: "second-model",
      system: "persona",
      transcript: [
        { role: "user", text: "earlier" },
        { role: "assistant", text: "answer" },
      ],
    });
    await completed;

    expect(
      events.filter((event) => event.type === "content.delta").map((event) => ({
        kind: event.type === "content.delta" ? event.streamKind : "",
        delta: event.type === "content.delta" ? event.delta : "",
      })),
    ).toEqual([
      { kind: "reasoning_text", delta: "thinking" },
      { kind: "assistant_text", delta: "hello" },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "item.completed", text: "hello" }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "thread.token-usage.updated", input: 11, output: 4 }),
    );
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });

    const modelRequest = requests.find((request) => request.method === "GET")!;
    const chatRequest = requests.find((request) => request.method === "POST")!;
    expect(modelRequest.authorization).toBe("Bearer secret-test-key");
    expect(chatRequest.authorization).toBe("Bearer secret-test-key");
    expect(chatRequest.body).toMatchObject({
      model: "second-model",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "persona" },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "latest" },
      ],
    });

    expect(await instance.generateText?.("name this bot")).toBe("short title");
    expect(requests.at(-1)?.body).toMatchObject({ model: "test-model", stream: false });
    await instance.dispose();
  });

  it("omits Authorization for keyless local endpoints", async () => {
    requests.length = 0;
    const driver = testDriver(false);
    const instance = await driver.create({
      instanceId: "local",
      displayName: "Local",
      environment: {},
      enabled: true,
      config: driver.decodeConfig({ url: baseUrl }),
    });
    expect(await instance.snapshot()).toMatchObject({ state: "available" });
    expect(requests.at(-1)?.authorization).toBeUndefined();
    await instance.dispose();
  });

  it("runs standard media function tools and resumes the chat completion", async () => {
    requests.length = 0;
    const driver = testDriver(false);
    const instance = await driver.create({
      instanceId: "tool-primary",
      displayName: "Tool primary",
      environment: {},
      enabled: true,
      config: driver.decodeConfig({ url: baseUrl }),
    });
    const events: RuntimeEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      instance.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed") resolve();
      });
    });

    await instance.adapter.sendTurn({
      threadId: "tool-loop",
      text: "make a copper robot",
      model: "test-model",
      integrations: {
        media: {
          command: process.execPath,
          args: [],
          env: {},
          tasks: ["image"],
          endpoint: `${baseUrl}/internal-media`,
          token: "internal-token",
          botId: "bot-1",
          primaryTurnId: "primary-1",
        },
      },
    });
    await completed;

    const chats = requests.filter((request) => request.url === "/v1/chat/completions");
    expect(chats).toHaveLength(2);
    expect(chats[0].body.tools[0]).toMatchObject({ function: { name: "generate_image" } });
    expect(chats[1].body.messages.at(-2)).toMatchObject({
      role: "assistant",
      tool_calls: [expect.objectContaining({ id: "call-image-1" })],
    });
    expect(chats[1].body.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-image-1",
    });
    const mediaCall = requests.find((request) => request.url === "/v1/internal-media")!;
    expect(mediaCall.authorization).toBe("Bearer internal-token");
    expect(mediaCall.body).toEqual({
      botId: "bot-1",
      primaryTurnId: "primary-1",
      task: "image",
      prompt: "copper robot",
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "item.started", title: "generate_image" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "item.completed", text: "Your image is ready." }));
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    await instance.dispose();
  });

  it("explains when the selected primary provider rejects function tools", async () => {
    requests.length = 0;
    const driver = testDriver(false);
    const instance = await driver.create({
      instanceId: "no-tools",
      displayName: "No tools",
      environment: {},
      enabled: true,
      config: driver.decodeConfig({ url: baseUrl }),
    });
    const events: RuntimeEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      instance.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed") resolve();
      });
    });
    await instance.adapter.sendTurn({
      threadId: "reject-tools",
      text: "reject media tools",
      integrations: {
        media: {
          command: process.execPath,
          args: [],
          env: {},
          tasks: ["image"],
          endpoint: `${baseUrl}/internal-media`,
          token: "token",
          botId: "bot-1",
          primaryTurnId: "primary-1",
        },
      },
    });
    await completed;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime.error",
        message: expect.stringContaining("does not support tool calling"),
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
    await instance.dispose();
  });

  it("merges a provider's dedicated video catalog into model discovery", async () => {
    requests.length = 0;
    const driver = testDriver(false, {
      modelQuery: "?output_modalities=all",
      imageModelsPath: "/images/models",
      videoModelsPath: "/videos/models",
    });
    const instance = await driver.create({
      instanceId: "video-catalog",
      displayName: "Video catalog",
      environment: {},
      enabled: true,
      config: driver.decodeConfig({ url: baseUrl }),
    });

    expect(await instance.snapshot()).toMatchObject({ state: "available", version: "6 models" });
    expect(instance.models.options).toContainEqual({
      id: "image-only-model",
      label: "Image only model",
      task: "image",
      outputModalities: ["image"],
    });
    expect(instance.models.options).toContainEqual({
      id: "video-only-model",
      label: "Video only model",
      task: "video",
      outputModalities: ["video"],
    });
    expect(requests.some((request) => request.url === "/v1/models?output_modalities=all")).toBe(true);
    expect(requests.some((request) => request.url === "/v1/images/models")).toBe(true);
    expect(requests.some((request) => request.url === "/v1/videos/models")).toBe(true);
    await instance.dispose();
  });

  it("routes an image model to image generation and emits structured output", async () => {
    requests.length = 0;
    const driver = testDriver();
    const instance = await driver.create({
      instanceId: "images",
      displayName: "Images",
      environment: {},
      enabled: true,
      config: driver.decodeConfig({ url: baseUrl }),
    });
    await instance.snapshot();

    const events: RuntimeEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      instance.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed") resolve();
      });
    });
    await instance.adapter.sendTurn({ threadId: "image-turn", text: "a tiny green square", model: "image-model" });
    await completed;

    expect(requests.some((request) => request.url === "/v1/chat/completions")).toBe(false);
    expect(requests.find((request) => request.url === "/v1/images/generations")?.body).toEqual({
      model: "image-model",
      prompt: "a tiny green square",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        itemType: "media",
        media: [
          expect.objectContaining({
            kind: "image",
            status: "ready",
            mime: "image/png",
            width: 1,
            height: 1,
            source: { type: "base64", data: TINY_PNG_BASE64, mime: "image/png" },
          }),
        ],
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    await instance.dispose();
  });

  it("routes a video model through job polling and emits its completed URL", async () => {
    requests.length = 0;
    const driver = testDriver(true);
    const instance = await driver.create({
      instanceId: "videos",
      displayName: "Videos",
      environment: { OMB_COMPAT_TEST_KEY: "secret-test-key" },
      enabled: true,
      config: driver.decodeConfig({ url: baseUrl }),
    });
    await instance.snapshot();

    const events: RuntimeEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      instance.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed") resolve();
      });
    });
    await instance.adapter.sendTurn({ threadId: "video-turn", text: "a four second orbit", model: "video-model" });
    await completed;

    expect(requests.some((request) => request.url === "/v1/chat/completions")).toBe(false);
    expect(requests.find((request) => request.url === "/v1/videos")?.body).toEqual({
      model: "video-model",
      prompt: "a four second orbit",
    });
    expect(requests.some((request) => request.url === "/v1/video-status/video-job-1")).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        itemType: "media",
        media: [
          expect.objectContaining({
            kind: "video",
            status: "ready",
            durationSeconds: 4,
            providerJobId: "video-job-1",
            source: {
              type: "url",
              url: `${baseUrl}/videos/video-job-1/content?index=0`,
              headers: { authorization: "Bearer secret-test-key" },
            },
          }),
        ],
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    await instance.dispose();
  });

  it("settles the pending media item when generation fails", async () => {
    requests.length = 0;
    const driver = testDriver();
    const instance = await driver.create({
      instanceId: "failed-images",
      displayName: "Failed images",
      environment: {},
      enabled: true,
      config: driver.decodeConfig({ url: baseUrl }),
    });
    await instance.snapshot();

    const events: RuntimeEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      instance.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed") resolve();
      });
    });
    await instance.adapter.sendTurn({ threadId: "failed-image", text: "reject this", model: "image-model" });
    await completed;

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        itemType: "media",
        media: [expect.objectContaining({ kind: "image", status: "failed", error: expect.stringContaining("prompt rejected") })],
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "error" });
    await instance.dispose();
  });
});
