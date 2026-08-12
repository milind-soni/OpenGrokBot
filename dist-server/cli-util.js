// Cross-platform CLI launching. On Windows, npm-installed agent CLIs
// (`claude`, `codex`) are `.cmd` shims that CreateProcess can't run
// directly (Node throws EINVAL). This module resolves the shim to a real
// file and, when it's a batch file, spawns it through cmd.exe with proper
// command-line quoting so complex args (MCP JSON configs, prompts with
// spaces) survive intact.
import { execFile, spawn, spawnSync, } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
export const isWindows = process.platform === "win32";
const WIN_PATHEXT = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
/** CommandLineToArgvW-style quoting, the rules CreateProcess/cmd expect. */
export function winQuote(arg) {
    if (arg.length === 0)
        return '""';
    if (!/[ \t\n\v"]/.test(arg))
        return arg;
    let s = '"';
    let bs = 0;
    for (const ch of arg) {
        if (ch === "\\")
            bs++;
        else if (ch === '"') {
            s += "\\".repeat(bs * 2 + 1) + '"';
            bs = 0;
        }
        else {
            s += "\\".repeat(bs);
            bs = 0;
            s += ch;
        }
    }
    s += "\\".repeat(bs * 2) + '"';
    return s;
}
/** Resolve a bare CLI name (or relative/absolute path) to a real file. */
export function resolveCli(cli) {
    if (!isWindows)
        return cli;
    if (isAbsolute(cli) || cli.includes("\\") || cli.includes("/"))
        return cli;
    for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        for (const ext of WIN_PATHEXT) {
            const p = join(dir, cli + ext);
            if (existsSync(p))
                return p;
        }
    }
    return cli;
}
export function spawnCli(cli, args, opts = {}) {
    if (!isWindows)
        return spawn(cli, args, opts);
    const file = resolveCli(cli);
    const lower = file.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
        const inner = `${winQuote(file)} ${args.map(winQuote).join(" ")}`;
        return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${inner}"`], {
            ...opts,
            windowsVerbatimArguments: true,
        });
    }
    return spawn(file, args, opts);
}
/** execFile equivalent that survives .cmd shims on Windows. */
export function execFileCli(cli, args, opts = {}, cb) {
    if (!isWindows) {
        execFile(cli, args, opts, cb);
        return;
    }
    const child = spawnCli(cli, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: opts.env });
    let out = "";
    let err = "";
    let done = false;
    const finish = (e) => {
        if (done)
            return;
        done = true;
        clearTimeout(timer);
        cb(e, out, err);
    };
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => finish(e));
    child.on("close", (code) => finish(code ? new Error(`exit ${code}`) : null));
    const timer = setTimeout(() => {
        try {
            child.kill();
        }
        catch { }
        finish(new Error("ETIMEDOUT"));
    }, opts.timeout ?? 8000);
}
/** Kill a process and its descendants. POSIX: negative-PID group signal;
 * Windows: taskkill tree. Falls back to a plain kill. */
export function killProcessTree(pid) {
    if (isWindows) {
        try {
            spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
            return;
        }
        catch { }
        try {
            process.kill(pid, "SIGTERM");
        }
        catch { }
        return;
    }
    try {
        process.kill(-pid, "SIGTERM");
    }
    catch {
        try {
            process.kill(pid, "SIGTERM");
        }
        catch { }
    }
}
