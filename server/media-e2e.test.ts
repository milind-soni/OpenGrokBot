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

beforeAll(async () => {
  provider = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      return json(res, 200, {
        data: [{ id: "fixture-image", name: "Fixture image", output_modalities: ["image"] }],
      });
    }
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      const body = await requestBody(req);
      if (body.model !== "fixture-image" || body.prompt !== "draw one pixel") {
        return json(res, 400, { error: { message: "wrong generation request" } });
      }
      return json(res, 200, { data: [{ b64_json: TINY_PNG_BASE64, media_type: "image/png" }] });
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

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${HARNESS}/api/health`)).ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(`harness exited ${child.exitCode}: ${stderr}`);
    if (Date.now() > deadline) throw new Error(`harness did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "draw one pixel" });
    expect(sent.status).toBe(202);

    const deadline = Date.now() + 10_000;
    let mediaMessage: any = null;
    while (Date.now() < deadline) {
      const snapshot = await api("GET", "/api/bots");
      const current = snapshot.body.bots.find((candidate: any) => candidate.id === bot.id);
      mediaMessage = current.messages.find((message: any) => message.kind === "media");
      if (mediaMessage?.media?.[0]?.status === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

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
});
