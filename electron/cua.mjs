// CUA computer-use wiring for the Electron main process.
//
// Two modes, per cua-driver's EMBEDDING.md:
//  - "embedded" (packaged app): spawn our own private daemon via
//    EmbeddedCuaDriverHost so TCC grants attribute to OpenMausBot and the
//    driver inherits them. One prompt, named OpenMausBot, out of the box.
//  - "standalone" (dev): attach to an already-installed CuaDriver.app daemon
//    (its own TCC identity, typically already granted on a dev machine).
//
// Agents never talk to the daemon socket directly — they spawn the official
// stdio MCP proxy: `cua-driver mcp [--embedded --socket <path>]`. The proxy
// executes nothing; the host-owned daemon does.
//
// The resulting connection descriptor is written to
// <userData>/cua-connection.json for the harness server to hand to drivers.
//
// On non-macOS platforms (Windows/Linux) the CUA driver is not available —
// local computer use degrades to "unavailable" and the rest of the app
// works normally.

import { app, ipcMain } from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const isMac = process.platform === "darwin";

const INSTALLED_DRIVER = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const STANDALONE_SOCKET = path.join(
  app.getPath("home"),
  "Library/Caches/cua-driver/cua-driver.sock",
);
const HOST_BUNDLE_ID = "com.openmausbot.app";

let embeddedHost = null; // EmbeddedCuaDriverHost | null
let connection = null; // descriptor exposed to harness + renderer

export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "cua-driver");
    if (fs.existsSync(bundled)) return bundled;
  }
  if (isMac && fs.existsSync(INSTALLED_DRIVER)) return INSTALLED_DRIVER;
  return null;
}

function socketAlive(sockPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve(false);
    const s = net.createConnection(sockPath);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1500).unref();
  });
}

async function startEmbedded(binary) {
  // Dynamic import: the SDK ships a native FFI lib; keep dev startup
  // resilient if it fails to load on this machine.
  const { EmbeddedCuaDriverHost } = await import("@trycua/cua-driver/embedded");
  embeddedHost = new EmbeddedCuaDriverHost(binary, HOST_BUNDLE_ID);
  const conn = await embeddedHost.start();
  return {
    mode: "embedded",
    socketPath: conn.socketPath,
    mcpCommand: binary,
    mcpArgs: ["mcp", "--embedded", "--socket", conn.socketPath],
    mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
  };
}

export async function startCua() {
  // Non-macOS: CUA driver is macOS-only (TCC, ScreenCaptureKit, etc.)
  if (!isMac) {
    connection = {
      mode: "unavailable",
      reason: "Local computer use (CUA) is currently only available on macOS",
    };
    fs.writeFileSync(
      path.join(app.getPath("userData"), "cua-connection.json"),
      JSON.stringify(connection, null, 2),
    );
    return connection;
  }

  const binary = resolveDriverBinary();
  if (!binary) {
    connection = { mode: "unavailable", reason: "cua-driver binary not found" };
    return connection;
  }

  const wantEmbedded =
    app.isPackaged || process.env.OPENMAUSBOT_CUA_EMBEDDED === "1";

  if (wantEmbedded) {
    try {
      connection = await startEmbedded(binary);
    } catch (err) {
      connection = {
        mode: "unavailable",
        reason: `embedded host failed: ${err?.message ?? err}`,
      };
    }
  } else if (await socketAlive(STANDALONE_SOCKET)) {
    // Dev machine with CuaDriver.app's daemon already running.
    connection = {
      mode: "standalone",
      socketPath: STANDALONE_SOCKET,
      mcpCommand: binary,
      mcpArgs: ["mcp"],
      mcpEnv: {},
    };
  } else {
    connection = {
      mode: "unavailable",
      reason:
        "no running cua-driver daemon; run `cua-driver serve` or grant via `cua-driver permissions grant`",
    };
  }

  fs.writeFileSync(
    path.join(app.getPath("userData"), "cua-connection.json"),
    JSON.stringify(connection, null, 2),
  );
  return connection;
}

export function cuaPermissionsStatus() {
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = spawnSync(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
  });
  try {
    return { available: true, ...JSON.parse(out.stdout) };
  } catch {
    return { available: true, raw: out.stdout?.trim() };
  }
}

export async function stopCua() {
  if (embeddedHost) {
    try {
      await embeddedHost.stop();
      embeddedHost.uniffiDestroy?.();
    } catch {
      // daemon holds a parent-liveness pipe; host death closes it anyway
    }
    embeddedHost = null;
  }
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", () => connection);
  ipcMain.handle("cua:permissions", () => {
    if (!isMac) return { available: false };
    return cuaPermissionsStatus();
  });
}