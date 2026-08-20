// The CUA realisation of the blind fill (Phase 1b, approach B).
//
// Runs in Electron main, so the secret never leaves this process. Uses the
// cua-driver `page` tool — the same browser automation the agent's computer
// uses — to (1) read the page's REAL origin via location.origin (the
// anti-phishing anchor: it comes from the browser, never from the model)
// and (2) fill the focused field via CDP Input.insertText (no synthesized
// keystrokes to sniff). On the isolated VM the browser runs with remote-
// debugging so CDP answers directly; on a host browser the user must enable
// "JavaScript from Apple Events" once (macOS Chrome), which is why fills are
// VM/box-only in production.
//
// This module shells `cua-driver call <tool> <json> --socket <sock>`, the
// same protocol the server-side computer proxy speaks, reading the socket
// from the cua-connection descriptor main already writes.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function cuaConnection(userData, home) {
  const candidates = [];
  if (userData) candidates.push(path.join(userData, "cua-connection.json"));
  if (process.platform === "darwin") {
    for (const d of ["OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"]) {
      candidates.push(path.join(home, "Library", "Application Support", d, "cua-connection.json"));
    }
  }
  for (const file of [...new Set(candidates)]) {
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      if (d && d.mode !== "unavailable" && typeof d.mcpCommand === "string" && typeof d.socketPath === "string") {
        return { binary: d.mcpCommand, socket: d.socketPath };
      }
    } catch {
      /* missing / stale */
    }
  }
  return null;
}

function call(binary, socket, tool, args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(binary, ["call", tool, JSON.stringify(args), "--socket", socket], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || "").toString().slice(0, 200)));
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = { raw: String(stdout).trim() };
      }
      resolve(parsed);
    });
  });
}

/** The frontmost on-screen browser window, or null. */
async function frontBrowser(binary, socket) {
  const res = await call(binary, socket, "list_windows", {});
  const windows = (res && (res.windows || res.result?.windows)) || [];
  const browsers = windows.filter((w) => w.is_on_screen && /Chrome|Chromium|Brave|Edge|Arc|Safari|Firefox/i.test(w.app_name || ""));
  if (!browsers.length) return null;
  browsers.sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0)); // topmost first
  const w = browsers[0];
  return { pid: w.pid, windowId: w.window_id };
}

/** location.origin from the live browser — the security anchor. */
async function readOrigin(deps) {
  const conn = cuaConnection(deps.userData, deps.home);
  if (!conn) throw new Error("no computer connection");
  const b = await frontBrowser(conn.binary, conn.socket);
  if (!b) throw new Error("no browser window in the computer");
  const res = await call(conn.binary, conn.socket, "page", { action: "execute_javascript", pid: b.pid, window_id: b.windowId, javascript: "location.origin" });
  const value = typeof res?.result === "string" ? res.result : typeof res?.value === "string" ? res.value : typeof res?.raw === "string" ? res.raw : null;
  if (!value || !/^https?:\/\//i.test(value)) throw new Error(`could not read the page origin (${JSON.stringify(res).slice(0, 120)})`);
  return value.trim();
}

/** Type a value into whatever field currently holds focus in the browser.
 * The secret arrives here, in main, and goes straight to the browser via
 * CDP insert_text; it is not returned or logged. */
async function fillIntoComputer(deps, job) {
  const conn = cuaConnection(deps.userData, deps.home);
  if (!conn) throw new Error("no computer connection");
  const b = await frontBrowser(conn.binary, conn.socket);
  if (!b) throw new Error("no browser window in the computer");
  const value =
    job.field === "totp"
      ? (deps.totp ?? (() => { throw new Error("no TOTP generator"); }))(job.entry.totpSeed)
      : job.field === "username"
        ? job.entry.username
        : job.entry.secret;
  // insert_text writes at the current DOM focus — the model focused the
  // field before calling vault_fill. No keystroke events, nothing to sniff.
  await call(conn.binary, conn.socket, "page", { action: "insert_text", pid: b.pid, window_id: b.windowId, text: value });
}

/** Bind the seams the bridge expects, closing over userData/home. */
function cuaFillSeams(opts) {
  const deps = { userData: opts.userData, home: opts.home, totp: opts.totp };
  return {
    readOrigin: () => readOrigin(deps),
    fillIntoComputer: (job) => fillIntoComputer(deps, job),
  };
}

module.exports = { cuaFillSeams, readOrigin, fillIntoComputer, cuaConnection };
