// The user's real PATH, recovered once at harness startup.
//
// A packaged macOS app is launched by launchd, not by a shell, so it
// inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing else. Every
// driver spawns its CLI by bare name — `spawn(config.cli, …)` with
// { ...process.env } — so a working install in ~/.local/bin, Homebrew,
// nvm, pnpm or bun is invisible to the harness and the probe reports
// "`claude` CLI not found" on a machine where `claude` runs fine in
// Terminal (#12, #8).
//
// The login shell is the only thing that knows where the user put their
// tools, so ask it: `-l` for the profile files, `-i` because nvm, pyenv
// and friends usually export from an rc file only interactive shells
// read. Its stdout is whatever those rc files felt like printing, so the
// answer comes back between sentinels rather than as "the output", and
// via `printenv` rather than `$PATH` so shells with list-valued PATH
// (fish) still hand back a delimiter-joined string.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BEGIN = "__OMB_PATH_BEGIN__";
const END = "__OMB_PATH_END__";
const PROBE_SCRIPT = `printf %s "${BEGIN}"; printenv PATH; printf %s "${END}"`;
const PROBE_TIMEOUT_MS = 5_000;

/** Where user-managed CLIs land, for when the shell won't answer. */
function fallbackDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".volta", "bin"),
  ].filter((dir) => existsSync(dir));
}

/** `current` then `extra`, first occurrence wins, empty segments dropped. */
export function mergePath(current: string, extra: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...current.split(delimiter), ...extra.split(delimiter)]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(delimiter);
}

/** The PATH between the sentinels, or null if the shell talked past them. */
export function extractPath(output: string): string | null {
  const start = output.indexOf(BEGIN);
  if (start === -1) return null;
  const from = start + BEGIN.length;
  const end = output.indexOf(END, from);
  if (end === -1) return null;
  return output.slice(from, end).trim() || null;
}

/** Runs the probe. Injectable so tests never depend on the host's rc files. */
export type ProbeRunner = (shell: string, args: string[]) => Promise<string>;

const runLoginShell: ProbeRunner = async (shell, args) => {
  const { stdout } = await execFileAsync(shell, args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

/** The PATH a terminal would have, or null if the shell wouldn't say. */
export async function loginShellPath(run: ProbeRunner = runLoginShell): Promise<string | null> {
  const shell = process.env.SHELL || "/bin/sh";
  try {
    return extractPath(await run(shell, ["-l", "-i", "-c", PROBE_SCRIPT]));
  } catch {
    // missing shell, an rc file that hangs past the timeout, a non-zero
    // exit — all the same answer here, and the fallback covers it
    return null;
  }
}

/**
 * Merge the user's real PATH into process.env.PATH, before any driver
 * probes or spawns. Never throws and never shrinks PATH: a harness that
 * boots with a worse PATH than it started with would be strictly worse
 * than one that boots a little slower.
 */
export async function ensureUserPath(run?: ProbeRunner): Promise<string> {
  const current = process.env.PATH ?? "";
  // POSIX login shells only — Windows inherits a usable PATH from the shell
  // that started it, and has no `$SHELL -lic` to ask
  if (process.platform === "win32") return current;
  const extra = (await loginShellPath(run)) ?? fallbackDirs().join(delimiter);
  const merged = mergePath(current, extra);
  process.env.PATH = merged;
  return merged;
}
