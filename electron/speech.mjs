// Speech helper lifecycle, main-process side.
//  - macOS: the Swift helper (SFSpeechRecognizer, on-device) is spawned
//    from HERE (never the harness server) so the Microphone + Speech
//    Recognition permission prompts attribute to the app. Compiled lazily
//    on first use; each recording session is one helper process.
//  - Windows: a PowerShell helper (System.Speech, on-device dictation)
//    emits the same NDJSON protocol. No compile step; the .ps1 ships in
//    Resources for the packaged app.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

let child = null;

function helperCommand() {
  if (IS_MAC) {
    // packaged: the helper ships pre-built + signed in Resources (a signed app
    // bundle must never be written into — lazy compile would break the seal)
    return {
      bin: app.isPackaged
        ? path.join(process.resourcesPath, "speech-helper")
        : path.join(__dirname, "resources", "speech-helper"),
      args: [],
    };
  }
  if (IS_WIN) {
    const script = app.isPackaged
      ? path.join(process.resourcesPath, "speech-helper.ps1")
      : path.join(__dirname, "resources", "speech-helper.ps1");
    return {
      bin: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
      ],
    };
  }
  return null; // unsupported platform — no dictation
}

function ensureBuilt() {
  if (!IS_MAC || app.isPackaged) return; // pre-built at package time (or not needed)
  const src = path.join(__dirname, "resources", "speech-helper.swift");
  const bin = path.join(__dirname, "resources", "speech-helper");
  const stale = !existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs;
  if (!stale) return;
  // Xcode CLT required; ~2s once, then cached until the source changes
  execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "pipe", timeout: 120_000 });
}

export function startSpeech(win) {
  stopSpeech();
  const helper = helperCommand();
  if (!helper) {
    if (!win.isDestroyed()) win.webContents.send("speech:end", { code: 1 });
    return;
  }
  ensureBuilt();
  const proc = spawn(helper.bin, helper.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child = proc;

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        if (!win.isDestroyed()) win.webContents.send("speech:transcript", JSON.parse(line));
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  });
  proc.on("close", (code) => {
    if (child === proc) child = null;
    if (!win.isDestroyed()) win.webContents.send("speech:end", { code });
  });
  proc.on("error", () => {
    if (child === proc) child = null;
    if (!win.isDestroyed()) win.webContents.send("speech:end", { code: 1 });
  });
}

export function stopSpeech() {
  if (!child) return;
  try {
    child.kill();
  } catch {}
  child = null;
}
