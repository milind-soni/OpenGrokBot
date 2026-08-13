// Speech helper lifecycle, main-process side. The Swift helper is spawned
// from HERE (never the harness server) so the Microphone + Speech
// Recognition permission prompts attribute to the app. Compiled lazily on
// first use; each recording session is one helper process.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "resources", "speech-helper.swift");
// packaged: the helper ships pre-built + signed in Resources (a signed app
// bundle must never be written into — lazy compile would break the seal)
const BIN = app.isPackaged
  ? path.join(process.resourcesPath, "speech-helper")
  : path.join(__dirname, "resources", "speech-helper");

let child = null;

function ensureBuilt() {
  if (app.isPackaged) return; // pre-built at package time
  const stale = !existsSync(BIN) || statSync(BIN).mtimeMs < statSync(SRC).mtimeMs;
  if (!stale) return;
  // Xcode CLT required; ~2s once, then cached until the source changes
  execFileSync("swiftc", ["-O", SRC, "-o", BIN], { stdio: "pipe", timeout: 120_000 });
}

export function startSpeech(win) {
  stopSpeech();
  if (process.platform !== "darwin") {
    // the helper is a Swift SFSpeechRecognizer binary — macOS only; tell
    // the renderer with a distinct code so it can say why
    if (!win.isDestroyed()) win.webContents.send("speech:end", { code: 2 });
    return;
  }
  ensureBuilt();
  const proc = spawn(BIN, [], { stdio: ["ignore", "pipe", "pipe"] });
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
    child.kill("SIGTERM");
  } catch {}
  child = null;
}
