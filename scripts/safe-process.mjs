// Safe process management for OpenMausBot on Windows.
// ENFORCEMENT: NEVER use `taskkill //F //IM node.exe` (that is, `taskkill /F /IM node.exe`)
// - it kills ALL node.exe processes on the machine, including other Claude code sessions,
// MCP servers, Electron apps, and unrelated dev tools.
// Use this script instead:
//   node scripts/safe-process.mjs status
//   node scripts/safe-process.mjs kill-omb
//   node scripts/safe-process.mjs kill-port 8799
//   node scripts/safe-process.mjs start

import { createServer } from "node:net";
import { execSync, spawn } from "node:child_process";

const OMB_PORT = Number(process.env.OMB_PORT || 8799);

// Find the PID that owns a TCP port (Windows)
function pidOnPort(port) {
  try {
    const out = execSync("netstat -ano -p tcp", { encoding: "utf8", timeout: 5000 });
    for (const line of out.split("\n")) {
      if (line.includes("LISTENING") && line.includes(":" + port)) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid > 0) return pid;
      }
    }
  } catch {}
  return null;
}

// Kill a specific PID (never by image name)
function killPid(pid) {
  try {
    execSync("taskkill /F /PID " + pid, { stdio: "pipe", timeout: 5000 });
    console.log(" Killed PID " + pid);
    return true;
  } catch {
    console.log(" PID " + pid + " not running or already dead");
    return false;
  }
}

// Check if a port is free
function isPortFree(port) {
  return new Promise((function (res) {
    const tester = createServer();
    tester.once("error", function () { res(false); });
    tester.once("listening", function () { tester.close(function () { res(true); }); });
    tester.listen(port, "127.0.0.1");
  }));
}

// Commands
async function cmdKillPort(port) {
  const pid = pidOnPort(port);
  if (!pid) { console.log(" Port " + port + " is free."); return; }
  console.log(" Found PID " + pid + " on port " + port + ", killing...");
  killPid(pid);
}

async function cmdKillOmb() {
  for (const port of [OMB_PORT, 18799, 28799]) {
    const pid = pidOnPort(port);
    if (pid) {
      try {
        const res = await fetch("http://127.0.0.1:" + port + "/api/health", { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const body = await res.json();
          if (body && body.app === "openmausbot") {
            console.log(" Killing OpenMausBot server (PID " + pid + ") on port " + port);
            killPid(pid);
            return;
          }
        }
      } catch {}
    }
  }
  console.log("  No OpenMausBot server found on known ports.");
}

async function cmdStatus() {
  console.log("OpenMausBot process status:\n");
  for (const port of [OMB_PORT, 18799, 28799]) {
    const pid = pidOnPort(port);
    if (pid) {
      try {
        const res = await fetch("http://127.0.0.1:" + port + "/api/health", { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const body = await res.json();
          console.log("  :" + port + "  PID " + pid + "  " + (body && body.app === "openmausbot" ? "OpenMausBot" : "other"));
        } else {
          console.log("  :" + port + "  PID " + pid + "  (no HTTP)");
        }
      } catch {
        console.log("  :" + port + "  PID " + pid + "  (no HTTP)");
      }
    } else {
      console.log("  :" + port + "  free");
    }
  }
}

async function cmdStart() {
  await cmdKillOmb();
  for (let i = 0; i < 10; i++) {
    if (await isPortFree(OMB_PORT)) break;
    await new Promise(function (r) { setTimeout(r, 500); });
  }
  console.log("  Starting harness server on :" + OMB_PORT + "...");
  const child = spawn("node", ["server/index.ts"], {
    stdio: "inherit",
    env: Object.assign({}, process.env, { OMB_PORT: String(OMB_PORT) }),
    cwd: process.cwd(),
  });
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + OMB_PORT + "/api/health", { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body && body.app === "openmausbot") {
          console.log("  Server ready at http://127.0.0.1:" + OMB_PORT + " (PID " + child.pid + ")");
          return;
        }
      }
    } catch {}
    await new Promise(function (r) { setTimeout(r, 1000); });
  }
  console.log("  Server did not become ready in 30s");
}

// Cli
async function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);
  switch (cmd) {
    case "kill-port": await cmdKillPort(parseInt(args[0] || String(OMB_PORT), 10)); break;
    case "kill-omb": await cmdKillOmb(); break;
    case "status": await cmdStatus(); break;
    case "start": await cmdStart(); break;
    default:
      console.log("Usage: node scripts/safe-process.mjs <command>\n\nCommands:\n  status        Show what's on OMB ports\n  kill-omb      Kill OMB server (by PID, never by image name)\n  kill-port <n> Kill whatever owns port <n>\n  start         Start the harness server\n\nWARNING: NEVER run taskkill //F //IM node.exe - it kills ALL node processes!");
  }
}
main();
