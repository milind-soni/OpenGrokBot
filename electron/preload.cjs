// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.ogb), never Node or ipcRenderer itself.
//
// On Windows/Linux, speech and macOS-specific permissions are no-ops —
// the handlers in main.mjs return safe defaults.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ogb", {
  /** One frame of this machine's screen as a data: URL. */
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  speechStart: () => ipcRenderer.invoke("speech:start"),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
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
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * On Windows/Linux, always returns "granted" (no TCC equivalent). */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted.
   * On Windows/Linux, always resolves true. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech.
   * On Windows, opens the Windows Settings privacy section. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
});