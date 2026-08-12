// PATH augmentation for GUI launches — the fix for "CLI not found" when
// the app is opened from Finder/Explorer (issues #8, #12).
//
// A macOS app launched from Finder inherits a bare PATH
// (/usr/bin:/bin:...): no ~/.local/bin (the claude installer default),
// no /opt/homebrew/bin, and no nvm/volta/asdf shims — those only exist
// in interactive shells. The terminal sees the CLIs; the packaged app
// doesn't. So every spawn of an agent CLI goes through augmentedPath():
// the inherited PATH, plus the well-known install locations that exist
// on this machine, plus (async, best-effort) whatever PATH the user's
// real login shell reports.
//
// On Windows the PATH is inherited from the system environment and is
// usually sufficient, but we add common tool locations (scoop, chocolatey,
// nvm-windows, etc.) just in case.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
/** nvm keeps every node version's bin dir separately; newest first so a
 * CLI installed under the latest node wins. */
function nvmBinDirs() {
    try {
        const base = join(homedir(), ".nvm", "versions", "node");
        return readdirSync(base)
            .filter((v) => v.startsWith("v"))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map((v) => join(base, v, "bin"));
    }
    catch {
        return [];
    }
}
/** Windows-specific tool directories. */
function windowsKnownDirs() {
    const home = homedir();
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return [
        join(appData, "npm"), // global npm bin
        join(localAppData, "Programs", "Ollama"), // Ollama install location
        join(programFiles, "Ollama"), // Ollama (system install)
        join(home, "scoop", "shims"), // Scoop package manager
        join(home, "AppData", "Local", "scoop", "shims"),
        join(programFiles, "nodejs"), // Node.js install
        "C:\\Python312", // Python (common install)
        "C:\\Python311",
        "C:\\Python310",
    ];
}
function knownDirs() {
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
let cached = null;
let probed = false;
/** Current best PATH, synchronously. Cheap after the first call. */
export function augmentedPath() {
    if (cached === null) {
        const platformDirs = process.platform === "win32" ? windowsKnownDirs() : knownDirs();
        cached = mergePaths([
            ...(process.env.OMB_EXTRA_PATH ? process.env.OMB_EXTRA_PATH.split(delimiter) : []),
            ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
            // GUI apps on Windows inherit the user PATH already; the unix
            // install-dir scan and shell probe are the darwin/linux cure
            ...platformDirs.filter((d) => existsSync(d)),
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
function mergePaths(parts) {
    return [...new Set(parts.filter(Boolean))].join(delimiter);
}
function probeLoginShellPath() {
    const shell = process.env.SHELL || "/bin/zsh";
    // -l -i: nvm and friends live in .zshrc/.bashrc, which only interactive
    // shells read. A marker isolates $PATH from any rc-file noise.
    execFile(shell, ["-l", "-i", "-c", 'printf "__OMB_PATH__%s" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout)
            return;
        const m = /__OMB_PATH__([^\n]*)/.exec(stdout);
        if (!m || !m[1])
            return;
        cached = mergePaths([...(cached ?? "").split(delimiter), ...m[1].split(delimiter)]);
    });
}
/** Test hook — the cache is process-wide otherwise. */
export function resetPathCacheForTests() {
    cached = null;
    probed = false;
}
