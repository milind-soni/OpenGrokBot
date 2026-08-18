// Transparent stdio bridge into Cua Driver's official MCP server inside the
// Local VM. This process defines no tools and parses no MCP messages.
import { spawn } from "node:child_process";

import { augmentedPath } from "./env-path.ts";

const [runtime, container, socket] = process.argv.slice(2);
if (!runtime || !["docker", "podman", "container"].includes(runtime)) {
  process.stderr.write("invalid Local VM runtime\n");
  process.exit(2);
}
if (!container || !/^[a-zA-Z0-9_.-]+$/.test(container) || !socket?.startsWith("/run/user/1000/")) {
  process.stderr.write("invalid Local VM connection\n");
  process.exit(2);
}

const child = spawn(
  runtime,
  [
    "exec",
    "-i",
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    "DISPLAY=:1",
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    container,
    "/usr/local/libexec/openmausbot/cua-driver",
    "mcp",
    "--socket",
    socket,
  ],
  {
    env: { ...process.env, PATH: augmentedPath() },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on("error", (error) => {
  process.stderr.write(`could not connect to Cua Driver: ${error.message}\n`);
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (signal) process.stderr.write(`Cua Driver connection ended with ${signal}\n`);
  process.exit(code ?? 1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => child.kill(signal));
}
