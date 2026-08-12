import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences, utilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources", "app-icon.png");

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverReady = true;
async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const proc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      OMB_PORT: String(port),
    },
    stdio: "inherit",
  });
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  for (let i = 0; i < 40; i++) {
    if (exited) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.app === "openmausbot" && body.pid === proc.pid && body.static) return proc;
        break; // someone else owns this port — try the next one
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    proc.kill();
  } catch {}
  return null;
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
      const proc = await startServerOn(port);
      if (proc) {
        serverProc = proc;
        SERVER_PORT = port;
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

const ERROR_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">Something else is using its ports. Quit and reopen OpenMausBot — if it keeps happening, restart your computer.</p></div></body>`,
  );

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    // macOS: hidden traffic lights for a clean look; other platforms use
    // the standard OS title bar
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : { titleBarStyle: "default" }),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : ERROR_PAGE);
  } else {
    win.loadURL(DEV_URL);
  }
}

// "This machine" screen preview — served from the main process so the
// permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// ── Platform-specific permission handling ──────────────────────────────
// Onboarding permission checks. On macOS, status reads are free; the mic
// request pops the real TCC prompt attributed to the app.
// On Windows/Linux these are no-ops (no TCC equivalent).
if (isMac) {
  ipcMain.handle("perm:status", () => ({
    mic: systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown",
  }));
  ipcMain.handle("perm:request-mic", async () => {
    try {
      return await systemPreferences.askForMediaAccess("microphone");
    } catch {
      return false;
    }
  });
  // macOS never re-prompts a denied permission — the only path is System
  // Settings; deep-link straight to the right privacy pane.
  ipcMain.handle("perm:open-settings", (_event, pane) => {
    const panes = {
      mic: "Privacy_Microphone",
      screen: "Privacy_ScreenCapture",
      speech: "Privacy_SpeechRecognition",
    };
    return shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${panes[pane] ?? "Privacy"}`,
    );
  });
} else {
  // Windows / Linux: no TCC prompts; always report "granted" so onboarding
  // doesn't block. Screen capture works without special permission on
  // Windows; on Linux it depends on the compositor but we don't gate it.
  ipcMain.handle("perm:status", () => ({ mic: "granted" }));
  ipcMain.handle("perm:request-mic", async () => true);
  ipcMain.handle("perm:open-settings", async (_event, _pane) => {
    // Open Windows Settings privacy section
    if (isWin) {
      shell.openExternal("ms-settings:privacy-microphone");
    }
  });
}

ipcMain.handle("speech:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
ipcMain.handle("speech:stop", () => stopSpeech());

app.whenReady().then(async () => {
  if (isMac) app.dock.setIcon(APP_ICON);
  // getDisplayMedia in the renderer → this handler → screen capture, all
  // inside the app's own processes. On macOS this uses ScreenCaptureKit
  // (the one capture path macOS reliably attributes to the app). On
  // Windows this uses desktopCapturer directly.
  if (isMac) {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
          .catch(() => callback({}));
      },
      { useSystemPicker: false },
    );
  }
  registerCuaIpc();
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  startCua().catch((e) => console.error("[cua] start failed:", e));
  if (app.isPackaged) serverReady = await startServerPackaged();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS: keep running; Windows/Linux: quit
  if (process.platform !== "darwin") app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
let cuaCleanedUp = false;
app.on("before-quit", (e) => {
  if (cuaCleanedUp) return;
  e.preventDefault();
  try {
    serverProc?.kill();
  } catch {}
  stopCua().finally(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});