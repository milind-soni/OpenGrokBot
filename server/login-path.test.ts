// The bug this guards against is silent and total: with the launchd PATH
// every driver reports its CLI missing on a machine where that CLI runs
// fine in Terminal. So the contract is (a) the merge never loses an entry
// the process already had, (b) a shell that hangs, dies or chatters can't
// take the harness down or leave PATH worse than it was, and (c) the
// probe really does read the login shell — proven against a real one.
import { delimiter } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureUserPath, extractPath, loginShellPath, mergePath, type ProbeRunner } from "./login-path.ts";

const LAUNCHD_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
const posixOnly = process.platform === "win32" ? it.skip : it;

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

/** A shell that answers with `path`, wrapped in the noise rc files print. */
const fakeShell =
  (path: string): ProbeRunner =>
  async () =>
    `Welcome to your shell!\n__OMB_PATH_BEGIN__${path}\n__OMB_PATH_END__`;

describe("mergePath", () => {
  it("appends the extra entries and keeps the current ones first", () => {
    expect(mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/Users/x/.local/bin")).toBe(
      "/usr/bin:/bin:/opt/homebrew/bin:/Users/x/.local/bin",
    );
  });

  it("drops duplicates and empty segments", () => {
    expect(mergePath("/usr/bin::/bin", "/bin:/usr/bin:/opt/homebrew/bin:")).toBe("/usr/bin:/bin:/opt/homebrew/bin");
  });

  it("survives an empty side", () => {
    expect(mergePath("", "/opt/homebrew/bin")).toBe("/opt/homebrew/bin");
    expect(mergePath("/usr/bin", "")).toBe("/usr/bin");
  });
});

describe("extractPath", () => {
  it("reads the PATH out of a chatty login shell", () => {
    const out = `nvm loaded\n__OMB_PATH_BEGIN__/opt/homebrew/bin:/usr/bin\n__OMB_PATH_END__\nbye\n`;
    expect(extractPath(out)).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("returns null when the sentinels never showed up", () => {
    expect(extractPath("command not found: printenv\n")).toBeNull();
    expect(extractPath("__OMB_PATH_BEGIN__/usr/bin")).toBeNull();
  });

  it("returns null for an empty answer rather than an empty PATH", () => {
    expect(extractPath("__OMB_PATH_BEGIN__\n__OMB_PATH_END__")).toBeNull();
  });
});

describe("ensureUserPath", () => {
  posixOnly("adds the login shell's directories to the launchd PATH", async () => {
    process.env.PATH = LAUNCHD_PATH;

    const merged = await ensureUserPath(fakeShell(`${LAUNCHD_PATH}:/Users/x/.local/bin:/opt/homebrew/bin`));

    expect(merged.split(delimiter)).toContain("/Users/x/.local/bin");
    expect(merged.split(delimiter)).toContain("/opt/homebrew/bin");
    expect(process.env.PATH).toBe(merged);
  });

  posixOnly("never drops an entry the process already had", async () => {
    process.env.PATH = `${LAUNCHD_PATH}:/only/here`;

    const merged = await ensureUserPath(fakeShell("/opt/homebrew/bin"));

    for (const entry of [...LAUNCHD_PATH.split(delimiter), "/only/here"]) {
      expect(merged.split(delimiter)).toContain(entry);
    }
  });

  posixOnly("is idempotent — a second call adds no duplicates", async () => {
    process.env.PATH = LAUNCHD_PATH;
    const shell = fakeShell(`${LAUNCHD_PATH}:/opt/homebrew/bin`);

    const once = await ensureUserPath(shell);
    const twice = await ensureUserPath(shell);

    expect(twice).toBe(once);
  });

  posixOnly("falls back instead of throwing when the shell fails", async () => {
    process.env.PATH = LAUNCHD_PATH;
    const brokenShell: ProbeRunner = async () => {
      throw new Error("spawn /bin/zsh ETIMEDOUT");
    };

    const merged = await ensureUserPath(brokenShell);

    expect(merged.split(delimiter)).toEqual(expect.arrayContaining(LAUNCHD_PATH.split(delimiter)));
  });

  it.skipIf(process.platform !== "win32")("leaves PATH alone on Windows", async () => {
    process.env.PATH = "C:\\Windows\\system32";
    expect(await ensureUserPath(fakeShell("/opt/homebrew/bin"))).toBe("C:\\Windows\\system32");
  });
});

describe("loginShellPath", () => {
  // the whole fix rests on this actually working against a real shell
  posixOnly("reads a delimiter-joined PATH out of the host's login shell", async () => {
    const path = await loginShellPath();

    expect(path).toBeTruthy();
    expect(path!.split(delimiter)).toContain("/usr/bin");
  });
});
