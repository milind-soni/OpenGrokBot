// Local-first MCP registry helpers. Configuration (including env values) is
// deliberately server-only; snapshots contain only safe, useful metadata.
import { spawnCli, killCliTree } from "./procs.ts";
import type { McpServerConfig } from "./config.ts";

export interface McpServerSnapshot {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  configured: boolean;
  assignedBotIds: string[];
  url?: string;
}

export interface McpInspection {
  ok: boolean;
  transport: "stdio" | "http";
  tools?: Array<{ name: string; description?: string }>;
  message?: string;
}

const MAX_NAME = 80;
const MAX_TOOLS = 100;
const INSPECTION_TIMEOUT_MS = 6_000;
const MAX_STDIO_OUTPUT_BYTES = 1_000_000;

function safeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function validRemoteUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeMcpServer(raw: unknown, existingId?: string): McpServerConfig {
  if (!raw || typeof raw !== "object") throw new Error("MCP server configuration is required");
  const input = raw as Record<string, unknown>;
  const transport = input.transport === "http" ? "http" : input.transport === "stdio" ? "stdio" : null;
  if (!transport) throw new Error("MCP transport must be stdio or http");
  const requestedId = safeText(input.id, 100);
  if (!existingId && requestedId && !/^[\w-]+$/.test(requestedId)) {
    throw new Error("MCP server id contains unsupported characters");
  }
  const id = existingId || requestedId || crypto.randomUUID();
  const name = safeText(input.name, MAX_NAME);
  if (!name) throw new Error("MCP server name is required");
  const botIds = Array.isArray(input.botIds) ? input.botIds.filter((id) => typeof id === "string" && id.length <= 100) : [];
  const enabled = input.enabled !== false;
  if (transport === "stdio") {
    const command = safeText(input.command, 500);
    if (!command) throw new Error("A stdio MCP server needs a command");
    const args = Array.isArray(input.args) ? input.args.filter((arg) => typeof arg === "string").map((arg) => arg.slice(0, 2_000)) : [];
    const env: Record<string, string> = {};
    if (input.env && typeof input.env === "object") {
      for (const [key, value] of Object.entries(input.env as Record<string, unknown>)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string") env[key] = value.slice(0, 10_000);
      }
    }
    return { id, name, enabled, transport, command, args, env, botIds };
  }
  const url = safeText(input.url, 2_000);
  if (!validRemoteUrl(url)) throw new Error("Remote MCP URLs must use HTTPS, or loopback HTTP");
  return { id, name, enabled, transport, url, botIds };
}

export function mcpSnapshot(server: McpServerConfig): McpServerSnapshot {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled !== false,
    transport: server.transport,
    configured: server.transport === "stdio" ? Boolean(server.command) : validRemoteUrl(server.url),
    assignedBotIds: server.botIds ?? [],
    ...(server.transport === "http" && server.url ? { url: server.url } : {}),
  };
}

export function mcpServersForBot(servers: McpServerConfig[] | undefined, botId: string): McpServerConfig[] {
  return (servers ?? []).filter((server) => server.enabled !== false && (!server.botIds?.length || server.botIds.includes(botId)));
}

/** Bounded stdio JSON-RPC initialization + tools/list. Stderr and raw server
 * responses are intentionally never surfaced because they can contain secrets. */
export async function inspectMcpServer(server: McpServerConfig): Promise<McpInspection> {
  if (server.transport === "http") {
    if (!validRemoteUrl(server.url)) return { ok: false, transport: "http", message: "Remote URL is invalid" };
    try {
      const response = await fetch(server.url!, { method: "OPTIONS", signal: AbortSignal.timeout(INSPECTION_TIMEOUT_MS) });
      return response.ok || response.status === 405
        ? { ok: true, transport: "http", message: "Endpoint responded; remote tool inspection is not available yet." }
        : { ok: false, transport: "http", message: `Endpoint returned HTTP ${response.status}` };
    } catch {
      return { ok: false, transport: "http", message: "Could not reach the remote MCP endpoint" };
    }
  }
  if (!server.command) return { ok: false, transport: "stdio", message: "Stdio command is missing" };
  return new Promise((resolve) => {
    const child = spawnCli(server.command!, server.args ?? [], {
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    let outputBytes = 0;
    const finish = (result: McpInspection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killCliTree(child);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, transport: "stdio", message: "MCP server did not respond within 6 seconds" }), INSPECTION_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", () => finish({ ok: false, transport: "stdio", message: "Could not start the MCP server" }));
    child.on("exit", () => finish({ ok: false, transport: "stdio", message: "MCP server exited before responding" }));
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_STDIO_OUTPUT_BYTES) return finish({ ok: false, transport: "stdio", message: "MCP server produced too much output" });
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        }
        if (message.id === 2 && message.result) {
          const tools = Array.isArray(message.result.tools)
            ? message.result.tools.slice(0, MAX_TOOLS).flatMap((tool: unknown) => {
                if (!tool || typeof tool !== "object") return [];
                const value = tool as Record<string, unknown>;
                const name = safeText(value.name, MAX_NAME);
                return name ? [{ name, ...(safeText(value.description, 240) ? { description: safeText(value.description, 240) } : {}) }] : [];
              })
            : [];
          finish({ ok: true, transport: "stdio", tools });
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "OpenMausBot", version: "0.1" } } }) + "\n");
  });
}
