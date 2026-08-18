import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type RequestRecord = { method: string; path: string; headers: IncomingMessage["headers"]; body: string };

describe("cloud computer provisioning cleanup", () => {
  let api: Server;
  let provisionBox: typeof import("./box.ts").provisionBox;
  let scenario: "rename-failure" | "existing-desktop-failure" = "rename-failure";
  const requests: RequestRecord[] = [];

  const nameFor = (botId: string) => {
    const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
    const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
    return `ogb-${prefix}-${hash}`;
  };

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers, body });
        res.setHeader("content-type", "application/json");

        if (url.pathname === "/api/box/v1/boxes" && req.method === "GET") {
          const boxes =
            scenario === "existing-desktop-failure"
              ? [{ id: "existing-box", name: nameFor("existing-bot"), state: "ready" }]
              : [];
          res.writeHead(200).end(JSON.stringify({ ok: true, boxes }));
        } else if (url.pathname === "/api/box/v1/boxes" && req.method === "POST") {
          res.writeHead(201).end(JSON.stringify({ ok: true, box: { id: "new-box", state: "provisioning" } }));
        } else if (url.pathname === "/api/box/v1/boxes/new-box" && req.method === "PATCH") {
          res.writeHead(500).end(JSON.stringify({ ok: false, message: "rename rejected" }));
        } else if (url.pathname === "/api/box/v1/boxes/new-box" && req.method === "DELETE") {
          res.writeHead(202).end(JSON.stringify({ ok: true, operationId: "delete-1" }));
        } else if (url.pathname === "/api/box/v1/boxes/existing-box" && req.method === "GET") {
          res.writeHead(200).end(
            JSON.stringify({ ok: true, box: { id: "existing-box", name: nameFor("existing-bot"), state: "ready" } }),
          );
        } else if (url.pathname.endsWith("/commands")) {
          res.writeHead(200).end(JSON.stringify({ ok: true, exitCode: 0, stdout: "bootstrapped", stderr: "" }));
        } else if (url.pathname.endsWith("/desktop")) {
          res.writeHead(500).end(JSON.stringify({ ok: false, message: "desktop unavailable" }));
        } else {
          res.writeHead(404).end(JSON.stringify({ ok: false, message: `unexpected ${req.method} ${url.pathname}` }));
        }
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as any).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    ({ provisionBox } = await import("./box.ts"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("permanently deletes a newly created box when naming fails", async () => {
    scenario = "rename-failure";
    requests.length = 0;

    await expect(provisionBox({ box: { token: "box_test" } } as any, "new-bot", "New Bot")).rejects.toThrow(
      /box naming failed: rename rejected/,
    );

    const removal = requests.find((request) => request.method === "DELETE");
    const creation = requests.find((request) => request.method === "POST" && request.path.endsWith("/boxes"));
    expect(JSON.parse(creation?.body ?? "{}")).toMatchObject({ noEnv: true });
    expect(removal?.path).toBe("/api/box/v1/boxes/new-box");
    expect(removal?.headers["x-ascii-confirm-delete"]).toBe("new-box");
  });

  it("never deletes a pre-existing box when a later step fails", async () => {
    scenario = "existing-desktop-failure";
    requests.length = 0;

    await expect(
      provisionBox({ box: { token: "box_test" } } as any, "existing-bot", "Existing Bot"),
    ).rejects.toThrow(/desktop link could not be created/);

    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });
});
