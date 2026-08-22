import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CUA_DRIVER_VERSION } from "./container-computer.ts";
import {
  existingVmComputerMcp,
  existingVmLivenessArgs,
  existingVmMcpArgs,
  existingVmScreenshot,
  existingVmStatus,
  type ExistingVmOptions,
} from "./existing-vm.ts";
import type { AppConfig } from "./config.ts";

const FIXED_SSH_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
];

const fakeSshSource = String.raw`import { Buffer } from "node:buffer";

const args = process.argv.slice(2);
const alias = args[9];
const remote = args.slice(10).join(" ");

if (remote === "uname -s") {
  process.stdout.write(alias === "vm-windows" ? "Windows_NT\n" : "Linux\n");
  process.exit(0);
}
if (remote === "cua-driver --version") {
  process.stdout.write(alias === "vm-bad-version" ? "cua-driver 0.19.0\n" : "cua-driver 0.20.0\n");
  process.exit(0);
}
if (remote !== "cua-driver mcp") process.exit(2);

const image = Buffer.alloc(512);
image.set(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 0);
image.set(Buffer.from("IEND"), image.length - 4);
const tools = ["get_desktop_state", "list_apps", "click", "type_text", "press_key", "scroll"];
if (alias === "vm-missing-tool") tools.pop();
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize") result = { protocolVersion: "2024-11-05" };
    else if (message.method === "tools/list") result = { tools: tools.map((name) => ({ name })) };
    else if (message.method === "tools/call" && alias === "vm-no-image") result = { content: [{ type: "text", text: "no image" }] };
    else if (message.method === "tools/call") result = { content: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }] };
    else result = {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;

describe("Existing VM transport", () => {
  let temp: string;
  let fakeSsh: string;
  let options: ExistingVmOptions;

  beforeAll(() => {
    temp = mkdtempSync(join(tmpdir(), "openmausbot-existing-vm-"));
    fakeSsh = join(temp, "fake-ssh.mjs");
    writeFileSync(fakeSsh, fakeSshSource, "utf8");
    options = { sshCommand: process.execPath, sshCommandPrefix: [fakeSsh] };
  });

  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  const config = (sshAlias: string): AppConfig => ({ localVm: { source: "existing", sshAlias } });

  it("uses a fixed SSH command and rejects shell-like aliases", () => {
    expect(existingVmMcpArgs("my-vm")).toEqual([...FIXED_SSH_OPTIONS, "my-vm", "cua-driver", "mcp"]);
    expect(existingVmLivenessArgs("my-vm")).toEqual([...FIXED_SSH_OPTIONS, "my-vm", "true"]);
    expect(() => existingVmMcpArgs("vm; reboot")).toThrow("invalid Existing VM SSH config alias");
    expect(() => existingVmLivenessArgs("$(id)")).toThrow("invalid Existing VM SSH config alias");
  });

  it("requires Linux, the pinned driver, MCP tools, and a complete desktop image", async () => {
    const status = await existingVmStatus(config("vm-good"), options);

    expect(status).toMatchObject({
      source: "existing",
      configured: true,
      ssh: "connected",
      os: "linux",
      driver: "compatible",
      mcp: "ready",
      desktopReady: true,
      ready: true,
      driver_version: CUA_DRIVER_VERSION,
      viewer_url: "",
      watch_only: true,
    });
    expect(status.tools).toEqual(expect.arrayContaining(["get_desktop_state", "click", "type_text", "press_key", "scroll"]));
    expect(status).not.toHaveProperty("mode");
    expect(status).not.toHaveProperty("max_instances");

    const frame = await existingVmScreenshot(config("vm-good"), options);
    expect(frame.format).toBe("png");
    expect(frame.png).toBeTruthy();
  });

  it.each([
    ["vm-windows", "unsupported", "remote-os"],
    ["vm-bad-version", "incompatible", "cua-version"],
    ["vm-missing-tool", "failed", "mcp"],
    ["vm-no-image", "failed", "desktop"],
  ] as const)("reports the failing readiness stage for %s", async (alias, stage, errorCode) => {
    const status = await existingVmStatus(config(alias), options);
    expect(status.ready).toBe(false);
    if (stage === "unsupported") expect(status.os).toBe(stage);
    if (stage === "incompatible") expect(status.driver).toBe(stage);
    if (stage === "failed") expect(status.mcp).toBe(stage);
    expect(status.errorCode).toBe(errorCode);
  });

  it("does not expose a viewer or a managed lifecycle through the MCP spawn contract", () => {
    const mcp = existingVmComputerMcp(config("my-vm"));
    expect(mcp.command).toBe(process.execPath);
    expect(mcp.args.at(-1)).toBe("my-vm");
    expect(mcp.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });
});
