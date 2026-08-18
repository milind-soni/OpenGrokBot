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

import { app, ipcMain } from "electron";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");

const INSTALLED_DRIVER = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const STANDALONE_SOCKET = path.join(
  app.getPath("home"),
  "Library/Caches/cua-driver/cua-driver.sock",
);
const HOST_BUNDLE_ID = "com.openmausbot.app";
const CUA_ENV = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" };
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED ??= "0";

let embeddedHost = null; // EmbeddedCuaDriverHost | null
const connectionStore = createCuaConnectionStore({
  getUserData: () => app.getPath("userData"),
});

export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "cua-driver");
    if (fs.existsSync(bundled)) return bundled;
  }
  if (fs.existsSync(INSTALLED_DRIVER)) return INSTALLED_DRIVER;
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

async function loadEmbeddedSdk() {
  if (!app.isPackaged) {
    const [embedded, permissions] = await Promise.all([
      import("@trycua/cua-driver/embedded"),
      import("@trycua/cua-driver/electron"),
    ]);
    return { ...embedded, ...permissions };
  }
  process.env.OPENMAUSBOT_CUA_SDK_LIBRARY = path.join(
    process.resourcesPath,
    "cua-sdk",
    "native",
    "libcua_driver_sdk.dylib",
  );
  return import(pathToFileURL(path.join(process.resourcesPath, "cua-sdk", "cua-sdk.mjs")).href);
}

async function startEmbedded(binary) {
  // Import from the staged Resources tree in production. The app intentionally
  // excludes general node_modules, so a bare package import only works in dev.
  const sdk = await loadEmbeddedSdk();
  // CUA's embedding contract requires grants before the child daemon starts;
  // these SDK calls execute in Electron main so macOS attributes them to
  // OpenMausBot rather than to a terminal or helper process.
  const permissionStatus = sdk.requestMacOSPermissions();
  if (!sdk.hasRequiredMacOSPermissions(permissionStatus)) {
    const missing = [
      !permissionStatus.accessibility && "Accessibility",
      !permissionStatus.screenRecording && "Screen Recording",
    ].filter(Boolean).join(" and ");
    throw new Error(`${missing || "macOS permissions"} required; grant access in System Settings and restart OpenMausBot`);
  }
  embeddedHost = new sdk.EmbeddedCuaDriverHost(binary, HOST_BUNDLE_ID);
  const conn = await embeddedHost.start();
  return {
    mode: "embedded",
    socketPath: conn.socketPath,
    mcpCommand: binary,
    mcpArgs: ["mcp", "--embedded", "--socket", conn.socketPath],
    mcpEnv: { ...CUA_ENV, CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
  };
}

export async function startCua() {
  const binary = resolveDriverBinary();
  if (!binary) {
    return connectionStore.persist({
      mode: "unavailable",
      reason: "cua-driver binary not found",
    });
  }

  const wantEmbedded =
    app.isPackaged || process.env.OPENMAUSBOT_CUA_EMBEDDED === "1";
  let nextConnection;

  if (wantEmbedded) {
    try {
      nextConnection = await startEmbedded(binary);
    } catch (err) {
      nextConnection = {
        mode: "unavailable",
        reason: `embedded host failed: ${err?.message ?? err}`,
      };
    }
  } else if (await socketAlive(STANDALONE_SOCKET)) {
    // Dev machine with CuaDriver.app's daemon already running.
    nextConnection = {
      mode: "standalone",
      socketPath: STANDALONE_SOCKET,
      mcpCommand: binary,
      mcpArgs: ["mcp"],
      mcpEnv: { ...CUA_ENV },
    };
  } else {
    nextConnection = {
      mode: "unavailable",
      reason:
        "no running cua-driver daemon; run `cua-driver serve` or grant via `cua-driver permissions grant`",
    };
  }

  return connectionStore.persist(nextConnection);
}

export function cuaPermissionsStatus() {
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = spawnSync(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, ...CUA_ENV },
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
  if (connectionStore.get()) {
    connectionStore.persist({ mode: "unavailable", reason: "desktop-host-stopped" });
  }
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", () => connectionStore.get());
  ipcMain.handle("cua:permissions", () => cuaPermissionsStatus());
}
