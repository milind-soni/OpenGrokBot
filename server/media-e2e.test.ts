import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const HARNESS_PORT = 31000 + Math.floor(Math.random() * 5_000);
const PROVIDER_PORT = 36000 + Math.floor(Math.random() * 5_000);
const HARNESS = `http://127.0.0.1:${HARNESS_PORT}`;
const PROVIDER = `http://127.0.0.1:${PROVIDER_PORT}/v1`;
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let provider: ReturnType<typeof createServer>;
let child: ChildProcess;
let home: string;
let stderr = "";
let stdout = "";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function requestBody(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${HARNESS}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function observeEvents(
  run: () => Promise<void>,
  done: (frames: any[]) => boolean,
): Promise<any[]> {
  const response = await fetch(`${HARNESS}/api/events`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) throw new Error(`events stream failed with HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: any[] = [];
  let buffer = "";
  await run();
  try {
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) throw new Error("events stream ended before the expected frame");
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data) frames.push(JSON.parse(data));
        if (done(frames)) return frames;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

beforeAll(async () => {
  provider = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      return json(res, 200, {
        data: [
          { id: "fixture-image", name: "Fixture image", output_modalities: ["image"] },
          { id: "fixture-chat", name: "Fixture chat" },
        ],
      });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await requestBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!body.messages.some((message: any) => message.role === "tool")) {
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"generate-1","type":"function","function":{"name":"generate_image","arguments":"{\\"prompt\\":\\"draw via specialist\\"}"}}]}}]}\n\n',
        );
      } else {
        res.write('data: {"choices":[{"delta":{"content":"Made it with the image specialist."}}]}\n\n');
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      const body = await requestBody(req);
      if (
        body.model !== "fixture-image" ||
        (body.prompt !== "draw one pixel" && body.prompt !== "draw via specialist")
      ) {
        return json(res, 400, { error: { message: "wrong generation request" } });
      }
      return json(res, 200, { data: [{ url: `${PROVIDER}/fixture.png`, media_type: "image/png" }] });
    }
    if (req.method === "GET" && req.url === "/v1/fixture.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(TINY_PNG_BASE64, "base64"));
      return;
    }
    return json(res, 404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve) => provider.listen(PROVIDER_PORT, "127.0.0.1", resolve));

  home = mkdtempSync(join(tmpdir(), "omb-media-e2e-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      instances: {
        media: {
          driver: "openaiCompatible",
          displayName: "Media fixture",
          config: { url: PROVIDER, model: "fixture-image", modelTasks: { "fixture-image": "image" } },
        },
      },
    }),
  );
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(HARNESS_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`harness did not start. stdout: ${stdout}\nstderr: ${stderr}`)),
      20_000,
    );
    timeout.unref?.();
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes("openmausbot server on")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`harness exited ${code}. stdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}, 30_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

describe("generated media e2e", () => {
  it("routes, caches, persists, and serves an image generation", async () => {
    const before = await api("GET", "/api/bots");
    const bot = before.body.bots[0];
    expect(bot.modelSelection).toEqual({ instanceId: "media", model: "fixture-image" });

    let sent: Awaited<ReturnType<typeof api>> | null = null;
    const frames = await observeEvents(
      async () => {
        sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "draw one pixel" });
      },
      (seen) => seen.some((frame) => frame.kind === "message.patch" && frame.message?.media?.[0]?.status === "ready"),
    );
    expect(sent!.status).toBe(202);
    const mediaMessage = frames.find(
      (frame) => frame.kind === "message.patch" && frame.message?.media?.[0]?.status === "ready",
    )!.message;

    expect(mediaMessage).toMatchObject({
      role: "bot",
      kind: "media",
      media: [
        {
          kind: "image",
          status: "ready",
          mime: "image/png",
          bytes: 68,
          cacheKey: expect.stringMatching(/\.png$/),
        },
      ],
    });
    expect(JSON.stringify(mediaMessage)).not.toContain(TINY_PNG_BASE64);
    expect(JSON.stringify(mediaMessage)).not.toContain("authorization");

    const cached = await fetch(`${HARNESS}/api/media/${mediaMessage.media[0].cacheKey}`);
    expect(cached.status).toBe(200);
    expect(cached.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(Buffer.from(TINY_PNG_BASE64, "base64"));
  });

  it("lets a primary chat model call a configured image specialist", async () => {
    const before = await api("GET", "/api/bots");
    const bot = before.body.bots[0];
    const existingMediaIds = new Set(
      bot.messages.filter((message: any) => message.kind === "media").map((message: any) => message.id),
    );
    const configured = await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "media", model: "fixture-chat" },
      specialists: { image: { instanceId: "media", model: "fixture-image" } },
    });
    expect(configured.status).toBe(200);

    let sent: Awaited<ReturnType<typeof api>> | null = null;
    const frames = await observeEvents(
      async () => {
        sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "please create a specialist image" });
      },
      (seen) =>
        seen.some(
          (frame) =>
            frame.kind === "message.patch" &&
            !existingMediaIds.has(frame.message?.id) &&
            frame.message?.media?.[0]?.status === "ready",
        ) &&
        seen.some(
          (frame) => frame.kind === "message" && frame.message?.text === "Made it with the image specialist.",
        ) &&
        seen.some((frame) => frame.kind === "bot" && frame.bot?.id === bot.id && frame.bot?.busy === false),
    );
    expect(sent!.status).toBe(202);
    const mediaMessage = frames.find(
      (frame) =>
        frame.kind === "message.patch" &&
        !existingMediaIds.has(frame.message?.id) &&
        frame.message?.media?.[0]?.status === "ready",
    )!.message;
    const assistantText = frames.find(
      (frame) => frame.kind === "message" && frame.message?.text === "Made it with the image specialist.",
    )!.message.text;

    expect(mediaMessage).toMatchObject({
      kind: "media",
      media: [{ kind: "image", status: "ready", cacheKey: expect.stringMatching(/\.png$/) }],
    });
    expect(assistantText).toBe("Made it with the image specialist.");
  });
});
