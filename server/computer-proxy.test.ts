// Contract test for the computer tools' latency shape. The proxy is a
// stdio MCP server that talks to the box's REST command endpoint, so a
// fake box lets us assert the things that actually make UI steps fast:
//
//   1. an action and its screenshot are ONE round trip (act, settle and
//      capture ride in a single shell command),
//   2. the frame comes back INSIDE the action's result as an MCP image
//      block, so the model never needs a follow-up screenshot call,
//   3. click coordinates are scaled box-side (no geometry round trip),
//   4. computer_batch runs a whole sequence in one round trip,
//   5. an unchanged screen is reported as text instead of resending the
//      same pixels.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROXY = join(SERVER_DIR, "computer-proxy.ts");

// smallest valid JPEG header + payload — enough for the proxy's magic-byte
// check, which is what stops a truncated stdout reaching the model
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(700, 0x20),
  Buffer.from([0xff, 0xd9]),
]).toString("base64");

describe("computer proxy (fake box)", () => {
  let box: Server;
  let proxy: ChildProcess;
  let port = 0;
  const commands: string[] = [];
  let fileReads = 0;
  let hash = "aaaa1111";

  const rpc = (msg: unknown) => proxy.stdin!.write(JSON.stringify(msg) + "\n");
  const results = new Map<number, any>();
  const waitFor = async (id: number, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (results.has(id)) return results.get(id);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no response for id ${id}; commands so far: ${commands.join(" | ")}`);
  };

  beforeAll(async () => {
    box = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname.endsWith("/commands")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const command = JSON.parse(body || "{}").command ?? "";
          commands.push(command);
          // a real box echoes what the capture block printed
          const size = Buffer.from(JPEG, "base64").length;
          const stdout = /GEOM/.test(command)
            ? `GEOM 1920 1080\nHASH ${hash}\nSIZE ${size}\nB64 ${JPEG}\nACT ok\n`
            : "ACT ok\n";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ exitCode: 0, stdout, stderr: "" }));
        });
        return;
      }
      if (url.pathname.endsWith("/artifacts") || url.pathname.endsWith("/files")) {
        fileReads += 1;
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(JPEG, "base64"));
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => box.listen(0, "127.0.0.1", r));
    port = (box.address() as any).port;

    proxy = spawn(process.execPath, ["--experimental-strip-types", PROXY], {
      env: {
        ...process.env,
        OGB_BOX_API: `http://127.0.0.1:${port}`,
        OGB_BOX_ID: "box-1",
        OGB_BOX_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    proxy.stdout!.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) results.set(msg.id, msg);
        } catch {
          /* ignore */
        }
      }
    });
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
  }, 20_000);

  afterAll(() => {
    proxy?.kill();
    box?.close();
  });

  it("exposes a batch tool and advertises that actions return the screen", async () => {
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = await waitFor(2);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("computer_batch");
    const click = res.result.tools.find((t: any) => t.name === "click");
    expect(click.description).toMatch(/return the resulting screen/i);
  });

  it("clicks and returns the frame in ONE round trip, scaled box-side", async () => {
    const before = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "click", arguments: { x: 100, y: 200 } },
    });
    const res = await waitFor(3);
    // one command carried the click, the settle and the capture
    expect(commands.length - before).toBe(1);
    const command = commands.at(-1)!;
    expect(command).toMatch(/xdotool mousemove \$CX \$CY click 1/);
    expect(command).toMatch(/getdisplaygeometry/); // scaling resolved box-side
    // scaling is conditional: a display narrower than the model's space is
    // captured at native size, so the coordinates must pass through as-is
    expect(command).toMatch(/if \[ "\$W" -gt 1280 \].*CX=\$\(\( 100 \* W \/ 1280 \)\).*else CX=100/);
    expect(command).toMatch(/scrot -o -q 75/); // JPEG, no unconditional convert
    // ...and the model got pixels back with it, no second tool call
    const content = res.result.content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/clicked 100,200/);
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(content[1].data).toBe(JPEG);
    expect(fileReads).toBe(0); // inline stdout, so no extra HTTP hop
  });

  it("reports an unchanged screen as text instead of resending pixels", async () => {
    rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "press_key", arguments: { keys: "Tab" } },
    });
    const res = await waitFor(4);
    expect(res.result.content).toHaveLength(1);
    expect(res.result.content[0].text).toMatch(/identical to the frame you already have/i);
    // must not tell the model to redo a possibly-successful action
    expect(res.result.content[0].text).toMatch(/don't repeat the action/i);
  });

  it("sends a new frame once the screen actually changes", async () => {
    hash = "bbbb2222";
    rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "type_text", arguments: { text: "hello" } },
    });
    const res = await waitFor(5);
    expect(commands.at(-1)).toMatch(/xdotool type --delay 8 'hello'/);
    expect(res.result.content[1]).toMatchObject({ type: "image" });
  });

  it("runs a whole batch in one round trip with one frame at the end", async () => {
    hash = "cccc3333";
    const before = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "computer_batch",
        arguments: {
          actions: [
            { action: "click", x: 10, y: 20 },
            { action: "type_text", text: "milind@example.com" },
            { action: "press_key", keys: "Tab" },
          ],
        },
      },
    });
    const res = await waitFor(6);
    expect(commands.length - before).toBe(1);
    const command = commands.at(-1)!;
    expect(command).toMatch(/mousemove/);
    expect(command).toMatch(/xdotool type/);
    expect(command).toMatch(/xdotool key Tab/);
    expect((command.match(/scrot/g) ?? []).length).toBe(1); // one capture
    expect(res.result.content[1]).toMatchObject({ type: "image" });
  });

  it("skips the capture entirely when the caller opts out", async () => {
    rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "scroll", arguments: { direction: "down", observe: false } },
    });
    const res = await waitFor(7);
    expect(commands.at(-1)).not.toMatch(/scrot/);
    expect(res.result.content).toHaveLength(1);
  });
});
