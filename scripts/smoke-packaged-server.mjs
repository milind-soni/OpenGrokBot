// Prove the built server actually STARTS with no node_modules in reach.
//
// 0.1.24 shipped a server that died on every launch with
//   ERR_MODULE_NOT_FOUND: Cannot find package 'zod'
// because `tsc` leaves bare imports verbatim and the packaged app carries no
// node_modules. Every existing gate passed it: the unit suite runs in the repo
// (where zod resolves), and the packaging check only asserts index.js EXISTS.
//
// So this copies dist-server OUT of the repo before running it. Inside the
// repo a bare import still resolves by walking up to ./node_modules and the
// test passes on a build that would be dead in the field — which is precisely
// how the bug escaped. The copy is the whole point; do not "simplify" it away.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "omb-smoke-"));
const home = mkdtempSync(join(tmpdir(), "omb-smoke-home-"));
const port = 21000 + Math.floor(Math.random() * 9000);

cpSync(join(root, "dist-server"), join(staging, "server"), { recursive: true });

const child = spawn(process.execPath, [join(staging, "server", "index.js")], {
  cwd: staging,
  env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

// Best-effort by design. Windows holds file handles open a little longer than
// the process that owned them, so removing the scratch dir immediately after
// the kill raises EPERM; Linux runners can raise EACCES the same way. Scratch
// cleanup must never decide whether the build is good — it failed a green run
// on Windows once already, and see f66d30f for the same lesson on Linux.
const cleanup = () => {
  child.kill("SIGKILL");
  for (const dir of [staging, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will reap it; the assertion below is what matters */
    }
  }
};

const deadline = Date.now() + 45_000;
let listening = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) {
      listening = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

cleanup();

if (!listening) {
  console.error(`the packaged server never served /api/health on port ${port}.`);
  console.error(`exit code: ${child.exitCode}`);
  console.error(output.trim() || "(no output)");
  process.exit(1);
}

console.log(`packaged server started with no node_modules in reach (port ${port}) ✓`);
