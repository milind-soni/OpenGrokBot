import { describe, expect, it } from "vitest";

import { inspectMcpServer, mcpServersForBot, mcpSnapshot, normalizeMcpServer, validRemoteUrl } from "./mcp.ts";

describe("MCP registry", () => {
  it("accepts safe stdio config while retaining env only in server config", () => {
    const server = normalizeMcpServer({
      id: "filesystem",
      name: "Filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { API_TOKEN: "not-for-renderer" },
      botIds: ["bot-a"],
    });
    expect(server.env).toEqual({ API_TOKEN: "not-for-renderer" });
    expect(mcpSnapshot(server)).toEqual({
      id: "filesystem",
      name: "Filesystem",
      enabled: true,
      transport: "stdio",
      configured: true,
      assignedBotIds: ["bot-a"],
    });
  });

  it("limits assignments to global or selected bots", () => {
    const global = normalizeMcpServer({ name: "Global", transport: "stdio", command: "node" });
    const selected = normalizeMcpServer({ name: "Selected", transport: "stdio", command: "node", botIds: ["b"] });
    expect(mcpServersForBot([global, selected], "a")).toEqual([global]);
    expect(mcpServersForBot([global, selected], "b")).toEqual([global, selected]);
  });

  it("allows HTTPS and loopback HTTP remote endpoints only", () => {
    expect(validRemoteUrl("https://mcp.example.test/stream")).toBe(true);
    expect(validRemoteUrl("http://localhost:3000/mcp")).toBe(true);
    expect(validRemoteUrl("http://127.0.0.1:3000/mcp")).toBe(true);
    expect(validRemoteUrl("http://[::1]:3000/mcp")).toBe(true);
    expect(validRemoteUrl("http://example.test/mcp")).toBe(false);
    expect(validRemoteUrl("https://user:secret@mcp.example.test/mcp")).toBe(false);
    expect(() => normalizeMcpServer({ name: "Bad", transport: "http", url: "http://example.test/mcp" })).toThrow(/HTTPS/);
  });

  it("keeps update IDs immutable and rejects route-incompatible create IDs", () => {
    expect(() => normalizeMcpServer({ id: "server.one", name: "Bad", transport: "stdio", command: "node" })).toThrow(/unsupported/);
    expect(normalizeMcpServer({ id: "other", name: "Updated", transport: "stdio", command: "node" }, "stable").id).toBe("stable");
  });

  it("reports invalid and unavailable servers without exposing process output", async () => {
    const missing = normalizeMcpServer({ name: "Missing", transport: "stdio", command: "definitely-not-an-mcp-command" });
    await expect(inspectMcpServer(missing)).resolves.toMatchObject({ ok: false, message: "Could not start the MCP server" });
  });
});
