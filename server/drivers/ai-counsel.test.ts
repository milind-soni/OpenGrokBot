// AI Counsel driver smoke test
//
// Same pattern as hermes-os.test.ts: spin up a mock HTTP server that
// mimics the Counsel's /api/conversations and SSE response, then exercise
// the driver end-to-end. Verifies:
//   - decodeConfig rejects missing baseUrl
//   - snapshot is unavailable when the counsel is unreachable
//   - snapshot is available when /api/conversations responds
//   - a successful full-mode council round emits the canonical
//     session.started → turn.started → per-model item.completed →
//     stage3 item.completed → turn.completed → session.exited sequence
//   - a runtime error from the counsel surfaces as runtime.error
//     + turn.completed(ok: false, stopReason: "error")
//   - the model catalog includes the local-agents and ollama seats
//
// Run with: pnpm vitest run server/drivers/ai-counsel.test.ts

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { AiCounselDriver } from "./ai-counsel.ts";
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

function drain(instance: Awaited<ReturnType<typeof AiCounselDriver["create"]>>, turn: SendTurnInput): Promise<RuntimeEvent[]> {
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

describe("ai-counsel driver", () => {
  afterEach(async () => { await stopMock(); });

  it("defaultConfig is callable without args", () => {
    const cfg = AiCounselDriver.defaultConfig();
    expect(cfg.baseUrl).toMatch(/^https?:\/\//);
    expect(cfg.defaultModel).toBe("ollama:hermes3:8b");
  });

  it("decodeConfig rejects missing baseUrl", () => {
    expect(() => AiCounselDriver.decodeConfig({})).toThrow(/baseUrl/);
  });

  it("decodeConfig strips trailing slashes", () => {
    const a = AiCounselDriver.decodeConfig({ baseUrl: "http://h:8020/" });
    expect(a.baseUrl).toBe("http://h:8020");
  });

  it("snapshot is unavailable when counsel is unreachable", async () => {
    const cfg = AiCounselDriver.decodeConfig({ baseUrl: "http://127.0.0.1:1" });
    const inst = await AiCounselDriver.create({
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

  it("snapshot is available when /api/conversations responds", async () => {
    await startMock((req, res, _body) => {
      if (req.url === "/api/conversations" && req.method === "GET") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([]));
        return;
      }
      res.statusCode = 404; res.end();
    });
    const cfg = AiCounselDriver.decodeConfig({ baseUrl });
    const inst = await AiCounselDriver.create({
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

  it("emits canonical event sequence for a successful 3-stage council round", async () => {
    const convId = "test-conv-uuid";
    await startMock((req, res, _body) => {
      // conversation create
      if (req.url === "/api/conversations" && req.method === "POST") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: convId, created_at: "2026-01-01T00:00:00Z", title: "test", mode: "council", messages: [] }));
        return;
      }
      // SSE stream
      if (req.url === `/api/conversations/${convId}/message/stream` && req.method === "POST") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const events = [
          { type: "stage1_start" },
          { type: "stage1_init", total: 1 },
          { type: "stage1_progress", data: { model: "test:model-a", response: "first answer", error: null, usage: { input_tokens: 10, output_tokens: 5 } } },
          { type: "stage1_complete", data: [{ model: "test:model-a", response: "first answer" }] },
          { type: "stage2_init", total: 1 },
          { type: "stage2_progress", data: { model: "test:model-b", response: "peer review", error: null } },
          { type: "stage2_complete", data: [] },
          { type: "stage3_start" },
          { type: "stage3_complete", data: { model: "chairman", response: "synthesized final answer", usage: { input_tokens: 100, output_tokens: 20 } } },
          { type: "complete", metadata: { cost_report: { input_tokens: 110, output_tokens: 25 } } },
        ];
        for (const e of events) {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
        res.end();
        return;
      }
      res.statusCode = 404; res.end();
    });
    const cfg = AiCounselDriver.decodeConfig({ baseUrl, defaultModel: "test:model-a" });
    const inst = await AiCounselDriver.create({
      instanceId: "test-3",
      displayName: "test",
      environment: {},
      enabled: true,
      config: cfg,
    });
    const events = await drain(inst, { threadId: "t1", text: "hello" });
    const types = events.map((e) => e.type);

    // canonical sequence: session, turn, items, turn.completed, session.exited
    expect(types[0]).toBe("session.started");
    expect(types[1]).toBe("turn.started");
    expect(types).toContain("item.completed");
    expect(types).toContain("turn.completed");
    expect(types[types.length - 1]).toBe("session.exited");

    // three item.completed: stage1, stage2, stage3
    const items = events.filter((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text") as Array<any>;
    expect(items).toHaveLength(3);
    expect(items[0].text).toBe("first answer");
    expect(items[1].text).toBe("peer review");
    expect(items[2].text).toBe("synthesized final answer");

    // turn completed successfully
    const completed = events.find((e) => e.type === "turn.completed") as any;
    expect(completed?.ok).toBe(true);
    expect(completed?.stopReason).toBe("stop");

    // token usage was reported (one from stage1 usage, one from stage3 usage, one from cost_report)
    const usage = events.filter((e) => e.type === "thread.token-usage.updated") as Array<any>;
    expect(usage.length).toBeGreaterThanOrEqual(2);

    await inst.dispose();
  });

  it("emits runtime.error + failed turn when the counsel reports a preflight error", async () => {
    await startMock((req, res, _body) => {
      if (req.url === "/api/conversations" && req.method === "POST") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "c1", created_at: "2026-01-01T00:00:00Z", title: "t", mode: "council", messages: [] }));
        return;
      }
      if (req.url === "/api/conversations/c1/message/stream" && req.method === "POST") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "error", message: "all models failed preflight" })}\n\n`);
        res.end();
        return;
      }
      res.statusCode = 404; res.end();
    });
    const cfg = AiCounselDriver.decodeConfig({ baseUrl });
    const inst = await AiCounselDriver.create({
      instanceId: "test-4",
      displayName: "test",
      environment: {},
      enabled: true,
      config: cfg,
    });
    const events = await drain(inst, { threadId: "t2", text: "hi" });
    const err = events.find((e) => e.type === "runtime.error") as any;
    expect(err?.message).toMatch(/preflight/);
    const completed = events.find((e) => e.type === "turn.completed") as any;
    expect(completed?.ok).toBe(false);
    expect(completed?.stopReason).toBe("error");
    await inst.dispose();
  });

  it("emits runtime.error + failed turn when the conversation create fails", async () => {
    await startMock((req, res, _body) => {
      if (req.url === "/api/conversations" && req.method === "POST") {
        res.statusCode = 500;
        res.end(JSON.stringify({ detail: "boom" }));
        return;
      }
      res.statusCode = 404; res.end();
    });
    const cfg = AiCounselDriver.decodeConfig({ baseUrl });
    const inst = await AiCounselDriver.create({
      instanceId: "test-5",
      displayName: "test",
      environment: {},
      enabled: true,
      config: cfg,
    });
    const events = await drain(inst, { threadId: "t3", text: "hi" });
    const err = events.find((e) => e.type === "runtime.error") as any;
    expect(err?.message).toMatch(/create conversation/);
    const completed = events.find((e) => e.type === "turn.completed") as any;
    expect(completed?.ok).toBe(false);
    await inst.dispose();
  });

  it("model catalog includes local-agents and ollama seats", () => {
    const cfg = AiCounselDriver.decodeConfig({ baseUrl: "http://h" });
    const ids = cfg ? AiCounselDriver.models.options.map((o) => o.id) : [];
    expect(ids).toContain("local-agents:claude-code-mac");
    expect(ids).toContain("local-agents:minimax-mac");
    expect(ids).toContain("ollama:hermes3:8b");
  });
});
