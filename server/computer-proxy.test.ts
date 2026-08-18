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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
  let browserUrl = "https://example.com/";
  let cropFails = false;

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
          const stdout = command.includes("127.0.0.1:9222/json/list")
            ? JSON.stringify([
                { id: "page-1", type: "page", title: " Example ", url: browserUrl },
              ])
            : command.includes("openmausbot-cdp.mjs snapshot")
              ? JSON.stringify({
                  title: "Account",
                  url: "https://user:password@example.com/form?token=secret#private",
                  elements: [
                    { ref: "b41", role: "textbox", name: "Email" },
                    { ref: "b42", role: "button", name: "Continue" },
                  ],
                })
              : command.includes("openmausbot-cdp.mjs click") || command.includes("openmausbot-cdp.mjs fill")
                ? `GEOM 1920 1080\nHASH ${hash}\nSIZE ${size}\nB64 ${JPEG}\nSEM ok\n`
            : cropFails && /convert "\$f" -crop/.test(command)
              ? `GEOM 1920 1080\nHASH ${hash}\nCROP_FAILED\n`
              : /GEOM/.test(command)
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

  it("exposes action, structured-state, crop, and metrics tools", async () => {
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = await waitFor(2);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("computer_batch");
    expect(names).toEqual(
      expect.arrayContaining([
        "browser_state",
        "browser_snapshot",
        "browser_click",
        "browser_fill",
        "computer_status",
        "wait_for_navigation",
        "observation_metrics",
      ]),
    );
    const click = res.result.tools.find((t: any) => t.name === "click");
    expect(click.description).toMatch(/return the resulting screen/i);
    const screenshot = res.result.tools.find((t: any) => t.name === "screenshot");
    expect(screenshot.inputSchema.properties.region).toBeTruthy();
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
    expect(command).toContain('exec env -i HOME="$HOME"');
    if (process.platform !== "win32") expect(spawnSync("/bin/bash", ["-n", "-c", command]).status).toBe(0);
    expect(command).toMatch(/xdotool mousemove \$CX \$CY click 1/);
    expect(command).toContain("/opt/ogb/cua-driver call click");
    expect(command).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(command).toMatch(/getdisplaygeometry/); // scaling resolved box-side
    // scaling is conditional: a display narrower than the model's space is
    // captured at native size, so the coordinates must pass through as-is
    expect(command).toMatch(/if \[ "\$W" -gt 1280 \].*CX=\$\(\( 100 \* W \/ 1280 \)\).*else CX=100/);
    expect(command).toMatch(/scrot -o -q 75/); // JPEG, no unconditional convert
    expect(command).toContain("call get_desktop_state");
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
    expect(commands.at(-1)).toMatch(/xdotool type --clearmodifiers --delay 8 -- .*hello/);
    expect(res.result.content[1]).toMatchObject({ type: "image" });
  });

  it("types leading hyphens as text after clearing stuck modifiers", async () => {
    hash = "bbbb2223";
    rpc({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "type_text", arguments: { text: "--safe" } },
    });
    await waitFor(51);
    expect(commands.at(-1)).toMatch(/xdotool type --clearmodifiers --delay 8 -- .*--safe/);
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

  it("never exposes browser credentials, queries, or fragments", async () => {
    browserUrl = "https://user:password@example.com/path?token=secret#private";
    rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "browser_state", arguments: {} } });
    const res = await waitFor(8);
    const output = res.result.content[0].text;
    expect(output).toContain("https://example.com/path");
    expect(output).not.toMatch(/user|password|token|secret|private/);
  });

  it("uses fresh semantic browser refs without exposing URL secrets", async () => {
    rpc({ jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
    const snapshot = await waitFor(81);
    const snapshotText = snapshot.result.content[0].text;
    expect(snapshotText).toContain("[b41] textbox: Email");
    expect(snapshotText).toContain("https://example.com/form");
    expect(snapshotText).not.toMatch(/user|password|token|secret|private/);

    hash = "semantic-1";
    const before = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 82,
      method: "tools/call",
      params: { name: "browser_fill", arguments: { ref: "b41", text: "person@example.com" } },
    });
    const filled = await waitFor(82);
    expect(commands.length - before).toBe(1);
    expect(commands.at(-1)).toContain("openmausbot-cdp.mjs fill");
    expect(commands.at(-1)).not.toContain("person@example.com");
    expect(filled.result.content[0].text).toMatch(/trusted Chrome DevTools input/);

    const staleBefore = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 83,
      method: "tools/call",
      params: { name: "browser_click", arguments: { ref: "b42" } },
    });
    const stale = await waitFor(83);
    expect(stale.result.isError).toBe(true);
    expect(stale.result.content[0].text).toMatch(/stale/i);
    expect(commands.length).toBe(staleBefore);
  });

  it("does not verify a different query or an invalid expected URL", async () => {
    browserUrl = "https://example.com/path?step=2#done";
    rpc({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "observation_metrics", arguments: {} } });
    const metricsBefore = JSON.parse((await waitFor(90)).result.content[0].text);
    const beforeInvalid = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "wait_for_navigation", arguments: { url: "not a URL" } },
    });
    const invalid = await waitFor(9);
    expect(invalid.result.isError).toBe(true);
    expect(commands.length).toBe(beforeInvalid);

    rpc({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "wait_for_navigation",
        arguments: { url: "https://example.com/path?step=1#done" },
      },
    });
    const mismatch = await waitFor(10);
    expect(mismatch.result.isError).toBe(true);
    expect(mismatch.result.content[0].text).toMatch(/not verified/i);

    rpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "wait_for_navigation",
        arguments: { url: "https://example.com/path?step=2#done" },
      },
    });
    const exact = await waitFor(11);
    expect(exact.result.isError).not.toBe(true);
    expect(exact.result.content[0].text).toMatch(/verified/i);
    expect(exact.result.content[0].text).not.toContain("step=2");

    rpc({ jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "observation_metrics", arguments: {} } });
    const metricsAfter = JSON.parse((await waitFor(91)).result.content[0].text);
    expect(metricsAfter.structuredBrowserObservations).toBe(metricsBefore.structuredBrowserObservations);
  });

  it("rejects out-of-height crops and fails closed when conversion fails", async () => {
    rpc({
      jsonrpc: "2.0",
      id: 120,
      method: "tools/call",
      params: { name: "screenshot", arguments: {} },
    });
    await waitFor(120);
    const beforeBounds = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 0, y: 700, width: 100, height: 50 } },
      },
    });
    const bounds = await waitFor(12);
    expect(bounds.result.isError).toBe(true);
    expect(bounds.result.content[0].text).toMatch(/1280×720/);
    expect(commands.length).toBe(beforeBounds);

    cropFails = true;
    rpc({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 10, y: 20, width: 100, height: 80 } },
      },
    });
    const failed = await waitFor(13);
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content).toHaveLength(1);
    expect(failed.result.content[0].text).toMatch(/crop failed/i);

    cropFails = false;
  });

  it("uses a private Chrome profile, strips URL credentials, and reports redirects", async () => {
    browserUrl = "https://example.com/landed?private=value#done";
    const before = commands.length;
    rpc({
      jsonrpc: "2.0",
      id: 130,
      method: "tools/call",
      params: {
        name: "open_url",
        arguments: {
          url: "https://user:password@example.com/requested?token=secret#fragment",
          observe: false,
        },
      },
    });
    const result = await waitFor(130);
    const issued = commands.slice(before);
    expect(issued).toHaveLength(2);
    expect(issued[0]).toContain('profile="$HOME/.openmausbot/chrome-profile"');
    expect(issued[0]).toContain('chmod 700 "$profile"');
    expect(issued[0]).toContain('! cp -a -n "$browser_dir"/. "$profile"/');
    expect(issued[0]).toContain('echo "failed to copy browser profile: $browser_dir" >&2');
    expect(issued[0]).toContain('ln -s "$profile" "$browser_dir"');
    expect(issued[0]).not.toContain("do;");
    expect(issued[0]).not.toContain("then;");
    expect(issued[0]).toContain('--user-data-dir="$HOME/.openmausbot/chrome-profile"');
    expect(issued[0]).toContain("--password-store=basic");
    expect(issued[0]).toContain("--disable-session-crashed-bubble");
    expect(issued[0]).not.toContain("user:password@");
    expect(issued[0]).toContain("'https://example.com/requested?token=secret#fragment'");
    expect(result.result.content[0].text).toContain("https://example.com/landed");
    expect(result.result.content[0].text).not.toMatch(/private|value|token|secret|fragment/);
  });

  it("hashes the full frame while treating distinct crops as distinct observations", async () => {
    hash = "dddd4444";
    rpc({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 10, y: 20, width: 100, height: 80 } },
      },
    });
    const first = await waitFor(14);
    expect(first.result.content.some((item: any) => item.type === "image")).toBe(true);
    const command = commands.at(-1)!;
    expect(command.indexOf('echo "HASH')).toBeLessThan(command.indexOf('-crop 100x80+10+20'));

    rpc({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 20, y: 20, width: 100, height: 80 } },
      },
    });
    const second = await waitFor(15);
    expect(second.result.content.some((item: any) => item.type === "image")).toBe(true);

    rpc({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: { region: { x: 20, y: 20, width: 100, height: 80 } },
      },
    });
    const repeated = await waitFor(16);
    expect(repeated.result.content).toHaveLength(1);
    expect(repeated.result.content[0].text).toMatch(/identical/i);
  });
});
