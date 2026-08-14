import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe("media generation HTTP lifecycle", () => {
  let child: ChildProcess;
  let provider: Server;
  let providerPort = 0;
  let home: string;
  let stderr = "";
  const pendingPolls = new Set<ServerResponse>();

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const getBot = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, description: string) => {
    const deadline = Date.now() + 15_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeAll(async () => {
    provider = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://provider.test").pathname;
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && path === "/v1/models") {
        return response.end(JSON.stringify({ data: [
          { id: "chat-model" },
          { id: "video-model", output_modalities: ["video"] },
        ] }));
      }
      if (request.method === "POST" && path === "/v1/videos") {
        response.statusCode = 202;
        return response.end(JSON.stringify({ id: "job-1" }));
      }
      if (request.method === "GET" && path === "/v1/videos/job-1") {
        pendingPolls.add(response);
        response.on("close", () => {
          pendingPolls.delete(response);
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/chat/completions") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"choices":[{"delta":{"content":"after cancel"}}]}\n\n');
        return response.end("data: [DONE]\n\n");
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    providerPort = (provider.address() as { port: number }).port;

    home = mkdtempSync(join(tmpdir(), "omb-media-api-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: {
        endpoint: {
          driver: "openaiCompatible",
          config: {
            url: `http://127.0.0.1:${providerPort}/v1`,
            model: "chat-model",
            modelTasks: { "video-model": "video" },
          },
        },
      },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    await waitFor(async () => {
      try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
    }, "server startup");
  }, 30_000);

  afterAll(async () => {
    for (const response of pendingPolls) response.destroy();
    provider?.close();
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("cancels a stuck video and accepts the bot's next text turn", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      specialists: { video: { instanceId: "endpoint", model: "video-model" } },
    })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, {
      text: "make me a 5 second video in 9:16",
    })).status).toBe(202);

    let mediaMessage: any;
    await waitFor(async () => {
      const current = await getBot(bot.id);
      mediaMessage = current.messages.find((message: { kind: string }) => message.kind === "media");
      return mediaMessage?.media?.[0]?.status === "generating";
    }, "video generation");
    const stableOutputId = mediaMessage.media[0].id;

    expect((await api("POST", `/api/bots/${bot.id}/messages/${mediaMessage.id}/cancel-media`)).status).toBe(200);
    await waitFor(async () => {
      const current = await getBot(bot.id);
      const output = current.messages.find((message: { id: string }) => message.id === mediaMessage.id)?.media?.[0];
      return !current.busy && output?.status === "cancelled";
    }, "terminal cancellation");
    expect((await getBot(bot.id)).messages.find((message: { id: string }) => message.id === mediaMessage.id).media[0].id)
      .toBe(stableOutputId);

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello after the failed video" })).status).toBe(202);
    await waitFor(async () => {
      const current = await getBot(bot.id);
      return !current.busy && current.messages.some((message: { text?: string }) => message.text === "after cancel");
    }, "next text response");
  }, 25_000);
});
