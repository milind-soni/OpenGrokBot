import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.resolve(
  process.env.OMB_SMOKE_EXECUTABLE ?? path.join(root, "release", "linux-unpacked", "openmausbot"),
);
if (!existsSync(executable)) throw new Error(`[smoke-linux-package] missing executable: ${executable}`);

const sandbox = mkdtempSync(path.join(tmpdir(), "omb-linux-smoke-"));
const home = path.join(sandbox, "home");
const xdgConfig = path.join(sandbox, "config");
const marker = path.join(sandbox, "cua-was-executed");
const sentinel = path.join(sandbox, "cua-driver");
mkdirSync(path.join(home, ".openmausbot"), { recursive: true });
mkdirSync(xdgConfig, { recursive: true });
writeFileSync(
  path.join(home, ".openmausbot", "config.json"),
  JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
);
writeFileSync(sentinel, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`);
chmodSync(sentinel, 0o755);

let output = "";
let smokeResult = null;
const child = spawn(executable, [], {
  cwd: root,
  detached: true,
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    CUA_DRIVER_PATH: sentinel,
    OMB_SMOKE_TEST: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/\[smoke\] renderer-ready (\{.*\})\r?\n/);
    if (match && !smokeResult) smokeResult = JSON.parse(match[1]);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (child.exitCode !== null) {
      throw new Error(`Electron exited ${child.exitCode} while waiting for ${description}.\n${output}`);
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}.\n${output}`);
}

async function waitForExit() {
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(50);
  if (child.exitCode === null) throw new Error(`Electron did not exit after its window closed.\n${output}`);
}

async function stopProcess() {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const stopDeadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < stopDeadline) await delay(50);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

try {
  const result = await until(async () => smokeResult, "the packaged renderer smoke result");
  const { capabilities, health, location, title } = result;
  if (health?.app !== "openmausbot" || health.static !== true) {
    throw new Error(`unexpected embedded health response: ${JSON.stringify(health)}`);
  }
  if (!String(title).includes("OpenMausBot")) throw new Error(`unexpected renderer title: ${title}`);
  if (capabilities.host.platform !== "linux") throw new Error("renderer did not report Linux");
  if (capabilities.dictation.available) throw new Error("dictation must be unavailable on Linux");
  if (capabilities.localComputer.available) throw new Error("local control must be unavailable on Linux");
  if (existsSync(marker)) throw new Error("Linux executed the CUA sentinel");

  await waitForExit();
  const staleHealth = await fetch(new URL("/api/health", location)).catch(() => null);
  if (staleHealth?.ok) throw new Error("embedded harness remained reachable after Electron quit");
  if (existsSync(marker)) throw new Error("Linux executed the CUA sentinel during shutdown");

  console.log("[smoke-linux-package] OK: renderer, capabilities, embedded harness, and shutdown");
} finally {
  await stopProcess();
  if (process.env.OMB_KEEP_SMOKE_DIR !== "1") rmSync(sandbox, { recursive: true, force: true });
  else console.log(`[smoke-linux-package] kept ${sandbox}`);
}
