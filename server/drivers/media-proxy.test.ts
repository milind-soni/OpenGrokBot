import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "media-proxy.ts");
const TOKEN = "test-media-token";

let stub: Server;
let child: ChildProcess;
let lastAuth: string | undefined;
let lastBody: any = null;
const pending = new Map<number, (message: any) => void>();
let nextId = 1;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      lastBody = JSON.parse(data);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, task: "image", messageId: "media-message-1" }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as { port: number }).port;
  child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      OMB_HARNESS_URL: `http://127.0.0.1:${port}`,
      OMB_BOT_ID: "bot-1",
      OMB_COMMS_TOKEN: TOKEN,
      OMB_PRIMARY_TURN_ID: "primary-1",
      OMB_MEDIA_TASKS: "image",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

describe("media specialist MCP proxy", () => {
  it("exposes only configured task tools", async () => {
    const initialized = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(initialized.result.serverInfo.name).toContain("media");
    const listed = await rpc("tools/list");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["generate_image"]);
  });

  it("forwards the prompt with bot and primary-turn identity", async () => {
    const response = await rpc("tools/call", {
      name: "generate_image",
      arguments: { prompt: "a copper robot in moonlight" },
    });
    expect(response.result.isError).toBeFalsy();
    expect(response.result.content[0].text).toContain("ready in the chat");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(lastBody).toEqual({
      botId: "bot-1",
      primaryTurnId: "primary-1",
      task: "image",
      prompt: "a copper robot in moonlight",
    });
  });

  it("rejects unconfigured and empty requests", async () => {
    const video = await rpc("tools/call", { name: "generate_video", arguments: { prompt: "waves" } });
    expect(video.error.code).toBe(-32602);
    const empty = await rpc("tools/call", { name: "generate_image", arguments: { prompt: "  " } });
    expect(empty.result.isError).toBe(true);
    const oversized = await rpc("tools/call", {
      name: "generate_image",
      arguments: { prompt: "x".repeat(20_001) },
    });
    expect(oversized.result.isError).toBe(true);
    expect(oversized.result.content[0].text).toContain("20,000");
  });
});
