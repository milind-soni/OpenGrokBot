// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.ogb), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ogb", {
  /** Renderer platform hints (darwin | win32 | linux | browser). */
  platform: process.platform,
  /** One frame of this screen as a data: URL (macOS Screen Recording TCC). */
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
  /** {mic, screen} TCC status strings: granted|denied|not-determined|unknown */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
  /** Registers a screen-capture attempt (adds the app to the TCC pane). */
  permRequestScreen: () => ipcRenderer.invoke("perm:request-screen"),
  /** Begin recording keyboard/mouse input (Windows). */
  macroRecordStart: () => ipcRenderer.invoke("macro:record-start"),
  /** Stop recording; resolves the captured action list. */
  macroRecordStop: () => ipcRenderer.invoke("macro:record-stop"),
  /** Replay a recorded action list through SendInput (Windows). */
  macroReplay: (actions) => ipcRenderer.invoke("macro:replay", actions),
});
