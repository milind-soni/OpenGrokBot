import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { replayMacro, startRecording, stopRecording } from "./macros.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");

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
    // macOS traffic lights / inset title bar are macOS-only concepts;
    // Windows/Linux get the standard frame (or hidden + custom controls)
    ...(IS_MAC
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : IS_WIN
        ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#070707", symbolColor: "#fcfcfc", height: 40 } }
        : {}),
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

// "This Mac" screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app (macOS). Screen Recording
// has no programmatic request — the first desktopCapturer call prompts.
// On Windows there is no TCC — these resolve to "unknown"/no-op so the
// renderer's permission step simply collapses to "not applicable".
ipcMain.handle("perm:status", () => {
  if (!IS_MAC) return { mic: "unknown", screen: "unknown", platform: process.platform };
  return {
    mic: systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown",
    screen: systemPreferences.getMediaAccessStatus?.("screen") ?? "unknown",
    platform: process.platform,
  };
});
ipcMain.handle("perm:request-mic", async () => {
  if (!IS_MAC) return true; // Windows: mic is granted implicitly at getUserMedia time
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});
// Screen Recording: an app only APPEARS in the Settings pane after TCC
// registers a capture attempt, and Electron's thumbnail API doesn't always
// register one on newer macOS. A child `screencapture` probe inherits the
// app's TCC identity — it registers OpenMausBot in the pane and triggers
// the system dialog on first use.
const PERM_HELPER = app.isPackaged
  ? path.join(process.resourcesPath, "perm-helper")
  : path.join(__dirname, "resources", "perm-helper");
ipcMain.handle("perm:request-screen", async () => {
  if (!IS_MAC) return "unknown"; // desktopCapturer on Windows needs no grant
  // CGRequestScreenCaptureAccess via the helper — registers the app in the
  // pane and shows the system dialog; child inherits the app's TCC identity
  await new Promise((resolve) => {
    execFile(PERM_HELPER, ["request"], { timeout: 15_000 }, () => resolve());
  });
  return systemPreferences.getMediaAccessStatus?.("screen") ?? "unknown";
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane. On Windows we
// open the equivalent Settings page (or no-op — there's no TCC).
ipcMain.handle("perm:open-settings", (_event, pane) => {
  if (IS_MAC) {
    const panes = {
      mic: "Privacy_Microphone",
      screen: "Privacy_ScreenCapture",
      speech: "Privacy_SpeechRecognition",
    };
    return shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${panes[pane] ?? "Privacy"}`,
    );
  }
  if (IS_WIN) {
    const pages = {
      mic: "ms-settings:privacy-microphone",
      screen: "ms-settings:privacy-broadcasting",
      speech: "ms-settings:privacy-speechtyping",
    };
    return shell.openExternal(pages[pane] ?? "ms-settings:privacy");
  }
  return null;
});

ipcMain.handle("speech:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
ipcMain.handle("speech:stop", () => stopSpeech());

// Macro record/replay — Windows-only; the renderer hides these on other
// platforms, so the handlers just resolve to an error there.
ipcMain.handle("macro:record-start", () => startRecording());
ipcMain.handle("macro:record-stop", () => stopRecording());
ipcMain.handle("macro:replay", (_event, actions) => replayMacro(actions));

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  // getDisplayMedia in the renderer → this handler → ScreenCaptureKit (mac)
  // or the equivalent capture path (win), all inside the app's own
  // processes — the capture path macOS reliably attributes to the app
  // (registers it in the Screen Recording pane and prompts). Used by the
  // onboarding "Enable screen preview" button.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
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
