// hermes-os driver smoke test
//
// Spins up a tiny mock HTTP server that mimics hermes-os's
// /v1/chat/completions SSE response, then exercises the driver
// end-to-end. Verifies:
//   - the driver emits the canonical session/turn/item event sequence
//   - SSE content.delta events are reconstructed into a single
//     item.completed: assistant_text
//   - usage and turn completion are reported
//   - a non-2xx response produces a runtime.error + turn.completed(ok=false)
//   - a server that's unreachable produces an unavailable snapshot
//   - defaultConfig() is callable without args
//
// Run with: pnpm vitest run server/drivers/hermes-os.test.ts

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { HermesOsDriver } from "./hermes-os.ts";
import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";

let server: ReturnType<typeof createServer> | null = null;
let baseUrl = "";

function startMock(handler: (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void) {
  return new Promise<void>((resolve) => {
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        await handler(req, res, body);
      } catch (e: any) {
        try { res.statusCode = 500; res.end(JSON.stringify({ error: e?.message ?? String(e) })); } catch {}
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopMock(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => { server = null; resolve(); });
  });
}

function drain(instance: Awaited<ReturnType<typeof HermesOsDriver["create"]>>, turn: SendTurnInput): Promise<RuntimeEvent[]> {
  return new Promise(async (resolve, reject) => {
    const events: RuntimeEvent[] = [];
    const unsub = instance.adapter.onEvent((e) => events.push(e));
    try {
      await instance.adapter.sendTurn(turn);
    } catch (e) { reject(e); }
    unsub();
    resolve(events);
  });
}

describe("hermes-os driver", () => {
  afterEach(async () => { await stopMock(); });

  it("defaultConfig is callable without args", () => {
    const cfg = HermesOsDriver.defaultConfig();
    expect(cfg.baseUrl).toMatch(/^https?:\/\//);
    expect(cfg.defaultModel).toBe("gemini");
  });

  it("decodeConfig rejects missing baseUrl", () => {
    expect(() => HermesOsDriver.decodeConfig({})).toThrow(/baseUrl/);
  });

  it("decodeConfig strips trailing slashes and /v1 suffix", () => {
    const a = HermesOsDriver.decodeConfig({ baseUrl: "http://h:8001/" });
    const b = HermesOsDriver.decodeConfig({ baseUrl: "http://h:8001/v1" });
    const c = HermesOsDriver.decodeConfig({ baseUrl: "http://h:8001/openai/v1" });
    expect(a.baseUrl).toBe("http://h:8001");
    expect(b.baseUrl).toBe("http://h:8001");
    expect(c.baseUrl).toBe("http://h:8001");
  });

  it("snapshot is unavailable when hub is unreachable", async () => {
    // Pick a port nothing is bound to
    const cfg = HermesOsDriver.decodeConfig({ baseUrl: "http://127.0.0.1:1" });
    const inst = await HermesOsDriver.create({
      instanceId: "test-1",
      displayName: "test",
      environment: {},
      enabled: true,
      config: cfg,
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toBeTruthy();
    await inst.dispose();
  });

  it("snapshot is available when hub /v1/models responds", async () => {
    await startMock((req, res, _body) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "gemini" }, { id: "openai" }] }));
        return;
      }
      res.statusCode = 404; res.end();
    });
    const cfg = HermesOsDriver.decodeConfig({ baseUrl });
    const inst = await HermesOsDriver.create({
      instanceId: "test-2",
      displayName: "test",
      environment: {},
      enabled: true,
      config: cfg,
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("available");
    await inst.dispose();
  });

  it("emits canonical event sequence for a successful SSE turn", async () => {
    await startMock((req, res, _body) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "gemini" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // one big string so the chunks the test sees are deterministic
        const body =
          `data: {"id":"x1","choices":[{"delta":{"content":"Hello"}}]}\n\n` +
          `data: {"id":"x2","choices":[{"delta":{"content":", world"}}]}\n\n` +
          `data: {"id":"x3","choices":[{"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n` +
          `data: [DONE]\n\n`;
        res.end(body);
        return;
      }
      res.statusCode = 404; res.end();
    });
    const cfg = HermesOsDriver.decodeConfig({ baseUrl, defaultModel: "gemini" });
    const inst = await HermesOsDriver.create({
      instanceId: "test-3",
      displayName: "test",
      environment: {},
      enabled: true,
      config: cfg,
    });
    const events = await drain(inst, { threadId: "t1", text: "hi", model: "gemini" });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("session.started");
    expect(types).toContain("turn.started");
    expect(types).toContain("content.delta");
    expect(types).toContain("item.completed");
    expect(types).toContain("turn.completed");
    expect(types[types.length - 1]).toBe("session.exited");

    // delta count
    const deltas = events.filter((e) => e.type === "content.delta");
    expect(deltas).toHaveLength(3);
    expect(deltas.map((d) => (d as any).delta).join("")).toBe("Hello, world!");

    // final item
    const final = events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text") as any;
    expect(final?.text).toBe("Hello, world!");

    // turn completion reports success
    const completed = events.find((e) => e.type === "turn.completed") as any;
    expect(completed?.ok).toBe(true);
    expect(completed?.stopReason).toBe("stop");

    // usage event
    const usage = events.find((e) => e.type === "thread.token-usage.updated") as any;
    expect(usage?.input).toBe(7);
    expect(usage?.output).toBe(3);

    await inst.dispose();
  });

  it("emits runtime.error + failed turn on non-2xx response", async () => {
    await startMock((req, res, _body) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: { message: "rate limit" } }));
        return;
      }
      res.statusCode = 404; res.end();
    });
    const cfg = HermesOsDriver.decodeConfig({ baseUrl });
    const inst = await HermesOsDriver.create({
      instanceId: "test-4",
      displayName: "test",
      environment: {},
      enabled: true,
      config: cfg,
    });
    const events = await drain(inst, { threadId: "t2", text: "hi" });
    const err = events.find((e) => e.type === "runtime.error") as any;
    expect(err?.message).toMatch(/429/);
    const completed = events.find((e) => e.type === "turn.completed") as any;
    expect(completed?.ok).toBe(false);
    expect(completed?.stopReason).toBe("rate_limit");
    await inst.dispose();
  });

  it("forwards Authorization header when apiKey is set", async () => {
    let seenAuth: string | null = null;
    await startMock((req, res, _body) => {
      if (req.url === "/v1/models") {
        seenAuth = req.headers["authorization"] ?? null;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.statusCode = 404; res.end();
    });
    const cfg = HermesOsDriver.decodeConfig({ baseUrl, apiKey: "secret-token-123" });
    const inst = await HermesOsDriver.create({
      instanceId: "test-5",
      displayName: "test",
      environment: {},
      enabled: true,
      config: cfg,
    });
    await inst.snapshot();
    expect(seenAuth).toBe("Bearer secret-token-123");
    await inst.dispose();
  });
});
