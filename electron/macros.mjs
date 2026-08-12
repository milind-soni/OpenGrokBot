// Macro record/replay, main-process side.
//  - record: spawn macro-record.ps1 (Win32 low-level hooks via Add-Type),
//    buffer the NDJSON stream, stop → return the parsed actions.
//  - replay: write the actions to a temp file, spawn macro-replay.ps1
//    (SendInput) and wait for it to finish.
// Windows-only; the recorder needs win32 — on macOS this resolves to
// nothing (the renderer hides the buttons).
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

let recorder = null; // { proc, buf, lines[] }
let replaying = false;

function scriptPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, "resources", name);
}

export function startRecording() {
  if (!IS_WIN) return { ok: false, error: "macro recording is Windows-only" };
  stopRecording();
  const script = scriptPath("macro-record.ps1");
  const proc = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const rec = { proc, buf: "", lines: [] };
  proc.stdout.on("data", (chunk) => {
    rec.buf += chunk;
    let nl;
    while ((nl = rec.buf.indexOf("\n")) !== -1) {
      const line = rec.buf.slice(0, nl).trim();
      rec.buf = rec.buf.slice(nl + 1);
      if (line) rec.lines.push(line);
    }
  });
  proc.stderr.on("data", () => {});
  proc.on("error", () => {
    if (recorder === rec) recorder = null;
  });
  proc.on("close", () => {
    if (recorder === rec) recorder = null;
  });
  recorder = rec;
  return { ok: true };
}

export function stopRecording() {
  const rec = recorder;
  recorder = null;
  if (!rec) return { ok: false, error: "not recording" };
  try {
    rec.proc.kill();
  } catch {}
  const actions = [];
  for (const line of rec.lines) {
    try {
      const a = JSON.parse(line);
      if (a.error) return { ok: false, error: a.error };
      actions.push(a);
    } catch {
      /* skip noise */
    }
  }
  return { ok: true, actions };
}

export async function replayMacro(actions) {
  if (!IS_WIN) return { ok: false, error: "macro replay is Windows-only" };
  if (!Array.isArray(actions) || !actions.length) return { ok: false, error: "empty macro" };
  if (replaying) return { ok: false, error: "a macro is already replaying" };
  replaying = true;
  const file = path.join(tmpdir(), `omb-macro-${Date.now()}.json`);
  try {
    writeFileSync(file, JSON.stringify(actions), "utf8");
    const script = scriptPath("macro-replay.ps1");
    const result = await new Promise((resolve) => {
      const proc = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-File",
          file,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let out = "";
      let err = "";
      proc.stdout.on("data", (c) => (out += c));
      proc.stderr.on("data", (c) => (err += c));
      const done = (code) => {
        const last = out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        try {
          resolve({ code, ...(last ? JSON.parse(last) : {}) });
        } catch {
          resolve({ code, error: last || err.trim().slice(-300) || "replay failed" });
        }
      };
      proc.on("error", (e) => resolve({ code: -1, error: e.message }));
      proc.on("close", done);
      setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        done(124);
      }, 300_000).unref();
    });
    return result.error ? { ok: false, error: result.error } : { ok: true, events: result.events };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      unlinkSync(file);
    } catch {}
    replaying = false;
  }
}
