// In-app auto-updater (electron-updater), manual/button-driven — the same
// shape t3code's desktop app uses: autoDownload off, quitAndInstall on the
// user's "Restart to update" click. One state object is broadcast to the
// renderer on every transition; the renderer just renders it.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, ipcMain } from "electron";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | error
let state = { status: "idle" };
// Whether the in-flight check came from the user's button. Background checks
// fail for reasons that are none of the user's business — no feed published
// for this platform yet, offline, a GitHub blip — and a popup for those on
// every launch is pure noise. Only a check the user asked for may surface an
// error; automatic ones fall back to idle.
let userInitiated = false;

function setState(patch) {
  state = { ...state, ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
}

function check(manual = false) {
  if (!autoUpdater) return;
  userInitiated = manual;
  try {
    autoUpdater.checkForUpdates();
  } catch (e) {
    reportError(e);
  }
}

function reportError(e) {
  if (!userInitiated) return setState({ status: "idle" });
  setState({ status: "error", message: String(e?.message ?? e) });
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", () => check(true));
  ipcMain.handle("update:download", () => {
    try {
      autoUpdater?.downloadUpdate();
    } catch (e) {
      setState({ status: "error", message: String(e?.message ?? e) });
    }
  });
  ipcMain.handle("update:install", () => {
    // isSilent, isForceRunAfter — relaunch straight into the new version
    try {
      autoUpdater?.quitAndInstall(true, true);
    } catch (e) {
      setState({ status: "error", message: String(e?.message ?? e) });
    }
  });
}

export function startUpdater(mainWindow) {
  win = mainWindow;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false; // button-driven download
  autoUpdater.autoInstallOnAppQuit = false; // button-driven install
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => setState({ status: "checking" }));
  autoUpdater.on("update-available", (info) =>
    setState({ status: "available", version: info?.version, message: undefined }),
  );
  autoUpdater.on("update-not-available", () => setState({ status: "idle" }));
  autoUpdater.on("download-progress", (p) =>
    setState({ status: "downloading", percent: Math.round(p?.percent ?? 0) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    setState({ status: "downloaded", version: info?.version }),
  );
  autoUpdater.on("error", reportError);

  // first check ~15s after launch (let the app settle), then hourly — both
  // silent on failure, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and start reporting errors again.
  setTimeout(() => check(), 15_000).unref?.();
  setInterval(() => check(), 60 * 60 * 1000).unref?.();
}
