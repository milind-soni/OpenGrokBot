// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.ogb), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("ogb", {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  /** The companion sidecar: the one part of this app that listens off the
   * machine, so it runs as its own process and is off until switched on.
   * Every call answers with the whole state, so the panel never has to
   * stitch two round-trips together. */
  companion: {
    state: () => ipcRenderer.invoke("companion:state"),
    start: () => ipcRenderer.invoke("companion:start"),
    stop: () => ipcRenderer.invoke("companion:stop"),
    pairing: (open) => ipcRenderer.invoke("companion:pairing", open),
    revoke: (deviceId) => ipcRenderer.invoke("companion:revoke", deviceId),
  },
  /** One frame of this computer's screen as a data: URL when supported. */
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  /** Absolute path of a dropped File — Electron 32 removed File.path, and
   * only the preload can ask. "" when the drag carried no file on disk. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * No screen field — macOS 15+ caches that status per-process, so any
   * value here would lie for the whole session after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),

  /** Copies an engine install command and opens a blank terminal. Resolves
   * false if no terminal could be launched; the clipboard still has it. */
  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  /** Open a web link in the default browser. Unlike renderer window.open,
   * this remains reliable after an asynchronous API request. */
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  /** Native folder picker for a bot's working folder; null when cancelled. */
  pickFolder: (current) => ipcRenderer.invoke("desktop:pick-folder", current),
  /** Store a provider credential with OS-backed encryption. */
  setCredential: (name, value) => ipcRenderer.invoke("credential:set", name, value),

  /** In-app auto-update. State object:
   *  { status: "idle"|"checking"|"available"|"downloading"|"downloaded"|"error",
   *    version?, percent?, message? }. onState fires immediately with the
   *    current state, then on every transition. Dormant in dev (no bridge). */
  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    onState: (cb) => {
      ipcRenderer
        .invoke("update:get-state")
        .then((s) => cb(s))
        .catch(() => {});
      const handler = (_event, s) => cb(s);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
});
