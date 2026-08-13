// Cross-platform process spawning for the agent CLIs. Three Windows
// differences live here and nowhere else:
//   1. CreateProcess can't exec .cmd/.bat shims directly (codex installs
//      one) — those go through cmd.exe. Native .exe shims (claude) spawn
//      directly so quoting-sensitive args like --mcp-config <json> survive
//      (a cmd.exe hop would mangle embedded quotes).
//   2. No process-group kill (kill(-pid) is POSIX) — taskkill /T reaps the
//      whole tree, CLI + its spawned MCP proxies alike.
//   3. Console apps spawned from the GUI shell flash a console window
//      unless windowsHide is set.
import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";

interface ResolvedCli {
  command: string;
  prefixArgs: string[];
}

export function resolveCli(cli: string): ResolvedCli {
  if (process.platform !== "win32") return { command: cli, prefixArgs: [] };
  // explicit path or bare .exe — direct spawn, no shell in between
  if (/[\\/]/.test(cli) || /\.(exe|com)$/i.test(cli)) return { command: cli, prefixArgs: [] };
  try {
    const hit = execFileSync("where.exe", [cli], { encoding: "utf8", timeout: 5000 })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .find((p) => /\.(exe|com|cmd|bat)$/i.test(p));
    if (hit && /\.(cmd|bat)$/i.test(hit)) return { command: "cmd.exe", prefixArgs: ["/d", "/s", "/c", hit] };
    if (hit) return { command: hit, prefixArgs: [] };
  } catch {
    /* unresolved — let the spawn itself surface the error */
  }
  return { command: cli, prefixArgs: [] };
}

export function spawnCli(
  cli: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const { command, prefixArgs } = resolveCli(cli);
  return spawn(command, [...prefixArgs, ...args], {
    ...opts,
    // posix: own process group so kill(-pid) reaps child MCP servers;
    // win32: taskkill /T does the reaping instead (see killCliTree)
    ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
  }) as ChildProcessByStdio<Writable, Readable, Readable>; // callers always pipe all three
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string) => void,
): void {
  const { command, prefixArgs } = resolveCli(cli);
  execFile(command, [...prefixArgs, ...args], { ...opts, windowsHide: true }, (err, stdout) =>
    cb(err, typeof stdout === "string" ? stdout : String(stdout)),
  );
}

/** Stop a CLI and every process it spawned (MCP proxies included). */
export function killCliTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    if (child.pid) {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Per-turn broker channel: unix socket on POSIX, named pipe on Windows
 * (Node can't listen on a filesystem socket path there — EACCES). */
export function brokerSocketPath(dataDir: string, tag: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\openmausbot-perm-${tag}`
    : join(dataDir, `perm-${tag}.sock`);
}
