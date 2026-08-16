import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { WebhookManager } from "./webhooks.ts";

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export interface WebhookIngress {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    let done = false;
    const fail = (status: number, message: string) => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error(message), { status }));
    };
    req.on("data", (chunk) => {
      if (done) return;
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > MAX_WEBHOOK_BODY_BYTES) return fail(413, "Webhook body is too large");
      raw += chunk;
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(raw);
    });
    req.on("error", () => fail(400, "Could not read webhook body"));
  });
}

function parsePayload(raw: string, contentType: string): unknown {
  if (!raw) return {};
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("Invalid JSON webhook body"), { status: 400 });
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerSecret(req: IncomingMessage): string {
  const authorization = header(req, "authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || header(req, "x-openmaus-secret")?.trim() || "";
}

function deliveryId(req: IncomingMessage, payload: unknown): string | undefined {
  const fromHeader =
    header(req, "idempotency-key") ??
    header(req, "x-webhook-id") ??
    header(req, "x-github-delivery") ??
    header(req, "webhook-id");
  if (fromHeader?.trim()) return fromHeader.trim();
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const candidate = (payload as Record<string, unknown>).id ?? (payload as Record<string, unknown>).event_id;
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
  }
  return undefined;
}

export function createWebhookIngressHandler(manager: WebhookManager) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { app: "openmausbot-webhooks", ready: true });
    }
    const match = url.pathname.match(/^\/hooks\/(wh_[A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
    if (!match) return json(res, 404, { error: "Unknown webhook endpoint" });
    if (req.method !== "POST") return json(res, 405, { error: "Webhooks accept POST requests" });

    try {
      const pathSecret = match[2] ? decodeURIComponent(match[2]) : "";
      const secret = pathSecret || bearerSecret(req);
      // Reject bad capability URLs before buffering or parsing attacker input.
      if (!manager.authorize(match[1], secret)) return json(res, 401, { error: "Invalid webhook URL or secret" });
      const raw = await readRawBody(req);
      const contentType = header(req, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "text/plain";
      const payload = parsePayload(raw, contentType);
      const result = manager.receive(match[1], secret, {
        payload,
        contentType,
        eventName:
          header(req, "x-github-event") ??
          header(req, "x-webhook-event") ??
          header(req, "x-event-type") ??
          header(req, "ce-type"),
        userAgent: header(req, "user-agent"),
        deliveryId: deliveryId(req, payload),
      });
      return json(res, 202, { accepted: true, ...result });
    } catch (error) {
      const status = Number((error as { status?: number })?.status) || 500;
      return json(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export async function listenWebhookIngress(
  manager: WebhookManager,
  options: { host?: string; port: number },
): Promise<WebhookIngress> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer(createWebhookIngressHandler(manager));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Webhook receiver did not get a TCP address");
  }
  return { server, host, port: address.port, baseUrl: `http://${host}:${address.port}` };
}

export function webhookCredential(baseUrl: string, endpointId: string, secret: string) {
  const endpointUrl = `${baseUrl.replace(/\/$/, "")}/hooks/${endpointId}`;
  return {
    endpointUrl,
    secret,
    url: `${endpointUrl}/${encodeURIComponent(secret)}`,
  };
}
