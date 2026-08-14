// PATH augmentation for GUI launches — the fix for "CLI not found" when
// the app is opened from Finder (issues #8, #12).
//
// A macOS app launched from Finder inherits a bare PATH
// (/usr/bin:/bin:...): no ~/.local/bin (the claude installer default),
// no /opt/homebrew/bin, and no nvm/volta/asdf shims — those only exist
// in interactive shells. The terminal sees the CLIs; the packaged app
// doesn't. So every spawn of an agent CLI goes through augmentedPath():
// the inherited PATH, plus the well-known install locations that exist
// on this machine, plus (async, best-effort) whatever PATH the user's
// real login shell reports.
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";

/** nvm keeps every node version's bin dir separately; newest first so a
 * CLI installed under the latest node wins. */
function nvmBinDirs(): string[] {
  try {
    const base = join(homedir(), ".nvm", "versions", "node");
    return readdirSync(base)
      .filter((v) => v.startsWith("v"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(base, v, "bin"));
  } catch {
    return [];
  }
}

function knownDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"), // claude installer default
    join(home, ".claude", "local"), // claude "local install"
    "/opt/homebrew/bin", // brew, Apple silicon
    "/usr/local/bin", // brew Intel / classic installs
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".deno", "bin"),
    join(home, "bin"),
    ...nvmBinDirs(),
  ];
}

let cached: string | null = null;
let probed = false;

/** Current best PATH, synchronously. Cheap after the first call. */
export function augmentedPath(): string {
  if (cached === null) {
    cached = mergePaths([
      ...(process.env.OMB_EXTRA_PATH ? process.env.OMB_EXTRA_PATH.split(delimiter) : []),
      ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
      // GUI apps on Windows inherit the user PATH already; the unix
      // install-dir scan and shell probe are the darwin/linux cure
      ...(process.platform === "win32" ? [] : knownDirs().filter((d) => existsSync(d))),
    ]);
  }
  // belt-and-braces: fold in the login shell's PATH once, in the
  // background — catches anything the known-dirs list doesn't (custom
  // rc exports). Never blocks a spawn; the next one benefits.
  if (!probed && !process.env.VITEST && process.platform !== "win32") {
    probed = true;
    probeLoginShellPath();
  }
  return cached;
}

function mergePaths(parts: string[]): string {
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

function probeLoginShellPath(): void {
  const shell = process.env.SHELL || "/bin/zsh";
  // -l -i: nvm and friends live in .zshrc/.bashrc, which only interactive
  // shells read. A marker isolates $PATH from any rc-file noise.
  execFile(
    shell,
    ["-l", "-i", "-c", 'printf "__OMB_PATH__%s" "$PATH"'],
    { timeout: 5000 },
    (err, stdout) => {
      if (err || !stdout) return;
      const m = /__OMB_PATH__([^\n]*)/.exec(stdout);
      if (!m || !m[1]) return;
      cached = mergePaths([...(cached ?? "").split(delimiter), ...m[1].split(delimiter)]);
    },
  );
}

/** Test hook — the cache is process-wide otherwise. */
export function resetPathCacheForTests(): void {
  cached = null;
  probed = false;
}

// Windows CLI resolution ───────────────────────────────────────────────
// PATH alone is not enough on Windows. libuv ignores PATHEXT, so
// spawn("claude") never finds claude.cmd — and since Node's
// CVE-2024-27980 fix, spawning a .cmd without shell:true throws
// synchronously anyway. shell:true is not an option here: the drivers
// pass raw JSON in argv (claude's --mcp-config), which cmd would mangle.
// Windows also has no #! support, so a node-shebang script (every fake
// CLI in server/testing) is unspawnable as itself.
//
// So resolve the real file ourselves, PATHEXT-aware, and turn what we
// find into a spawn that needs no shell: npm's .cmd shims are parsed
// down to the .exe or node script they wrap, and shebang scripts become
// `node <script>`. An unknown shim is deliberately left unspawnable instead
// of crossing the repository's no-shell security boundary.

export interface ResolvedSpawn {
  command: string;
  args: string[];
}

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** PATHEXT-aware `which`. A path-ish cli is probed where it points. */
function whichWin(cli: string): string | null {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // an extensionless name is not runnable on Windows, so PATHEXT wins over
  // the bare file — npm installs both `claude` (a sh script) and `claude.cmd`
  const probe = (base: string) => {
    const order = extname(base) ? [base, ...exts.map((e) => base + e)] : [...exts.map((e) => base + e), base];
    return order.find(isFile) ?? null;
  };
  if (/[\\/]/.test(cli) || /^[a-zA-Z]:/.test(cli)) return probe(cli);
  for (const dir of augmentedPath().split(delimiter)) {
    if (!dir) continue;
    const hit = probe(join(dir, cli));
    if (hit) return hit;
  }
  return null;
}

/** node.exe to run a script with: the one npm's shim would pick, else PATH,
 * else this executable only when it really is Node. In a packaged app,
 * process.execPath is Electron and must never be mistaken for node.exe. */
function nodeExe(near: string): string | null {
  const local = join(near, "node.exe");
  if (isFile(local)) return local;
  // Ask for the executable explicitly so a custom PATHEXT ordering cannot
  // make a stray node.cmd hide the real node.exe beside it.
  const onPath = whichWin("node.exe");
  if (onPath && extname(onPath).toLowerCase() === ".exe") return onPath;
  return (process.versions as Record<string, string | undefined>).electron ? null : process.execPath;
}

/** npm/pnpm .cmd shims all spell their target as "%dp0%\..." (or
 * "%~dp0\..."). Whatever of those exists on disk is what the shim runs. */
function parseCmdShim(shim: string): ResolvedSpawn | null {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(shim);
  const targets = [...text.matchAll(/"%~?dp0%?\\?([^"]+)"/g)]
    .map((m) => join(dir, m[1]))
    .filter((p) => isFile(p) && basename(p).toLowerCase() !== "node.exe");
  const script = targets.find((p) => /\.[cm]?js$/i.test(p));
  if (script) {
    const node = nodeExe(dir);
    if (node) return { command: node, args: [script] };
  }
  const exe = targets.find((p) => extname(p).toLowerCase() === ".exe");
  return exe ? { command: exe, args: [] } : null;
}

/** `#!/usr/bin/env node` → `node <script>`. Only node: nothing else has a
 * meaningful Windows equivalent worth guessing at. */
function parseNodeShebang(file: string): ResolvedSpawn | null {
  let head = "";
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort descriptor cleanup */
      }
    }
  }
  if (!/^#!.*\bnode(\.exe)?\b/.test(head)) return null;
  const node = nodeExe(dirname(file));
  return node ? { command: node, args: [file] } : null;
}

/**
 * How to actually spawn `cli` with `args` on this platform. Identity
 * everywhere but win32 — POSIX already resolves PATH and #! itself.
 */
export function resolveCliSpawn(cli: string, args: string[]): ResolvedSpawn {
  if (process.platform !== "win32") return { command: cli, args };
  const file = whichWin(cli);
  // not found: hand back the name so spawn reports its own ENOENT
  if (!file) return { command: cli, args };
  const ext = extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const direct = parseCmdShim(file);
    return direct ? { command: direct.command, args: [...direct.args, ...args] } : { command: file, args };
  }
  if (ext === ".exe" || ext === ".com") return { command: file, args };
  const viaNode = parseNodeShebang(file);
  return viaNode ? { command: viaNode.command, args: [...viaNode.args, ...args] } : { command: file, args };
}
