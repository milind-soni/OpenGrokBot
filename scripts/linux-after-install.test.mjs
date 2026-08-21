import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "build", "linux-after-install.sh");
const temporaryDirectories = [];

function fixture() {
  const appRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omb-deb-upgrade-"));
  temporaryDirectories.push(appRoot);
  const resources = path.join(appRoot, "resources");
  const cuaRoot = path.join(resources, "cua-linux-x64");
  fs.mkdirSync(cuaRoot, { recursive: true, mode: 0o775 });
  for (const directory of [appRoot, resources, cuaRoot]) fs.chmodSync(directory, 0o775);
  for (const executable of ["cua-driver", "cua-cursor-theme"]) {
    fs.writeFileSync(path.join(cuaRoot, executable), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(cuaRoot, executable), 0o664);
  }
  const chromiumSandbox = path.join(appRoot, "chrome-sandbox");
  fs.writeFileSync(chromiumSandbox, "fixture", { mode: 0o664 });
  fs.chmodSync(chromiumSandbox, 0o664);
  return { appRoot, resources, cuaRoot, chromiumSandbox };
}

function runHook(appRoot) {
  return spawnSync("/bin/sh", [hook], {
    encoding: "utf8",
    env: { ...process.env, OPENMAUSBOT_POSTINSTALL_TEST_ROOT: appRoot },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")("Linux DEB upgrade hook", () => {
  it("repairs legacy directory and executable modes idempotently", () => {
    const { appRoot, resources, cuaRoot, chromiumSandbox } = fixture();

    for (let pass = 0; pass < 2; pass += 1) {
      const result = runHook(appRoot);
      expect(result.status, result.stderr).toBe(0);
      for (const directory of [appRoot, resources, cuaRoot]) {
        expect(fs.lstatSync(directory).mode & 0o777).toBe(0o755);
      }
      for (const executable of ["cua-driver", "cua-cursor-theme"]) {
        expect(fs.lstatSync(path.join(cuaRoot, executable)).mode & 0o777).toBe(0o755);
      }
      expect(fs.lstatSync(chromiumSandbox).mode & 0o7777).toBe(0o4755);
    }
  });

  it("refuses to follow a replaced package directory symlink", () => {
    const { appRoot, resources } = fixture();
    const external = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omb-deb-external-"));
    temporaryDirectories.push(external);
    fs.chmodSync(external, 0o777);
    fs.rmSync(resources, { recursive: true });
    fs.symlinkSync(external, resources, "dir");

    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing or unsafe");
    expect(fs.lstatSync(external).mode & 0o777).toBe(0o777);
  });

  it("fails the install when a bundled executable is missing", () => {
    const { appRoot, cuaRoot } = fixture();
    fs.unlinkSync(path.join(cuaRoot, "cua-driver"));

    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("package executable is missing or unsafe");
  });

  it("fails the install when the Chromium sandbox is replaced by a symlink", () => {
    const { appRoot, chromiumSandbox } = fixture();
    const external = path.join(appRoot, "external-sandbox");
    fs.writeFileSync(external, "fixture", { mode: 0o755 });
    fs.unlinkSync(chromiumSandbox);
    fs.symlinkSync(external, chromiumSandbox, "file");

    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Chromium sandbox is missing or unsafe");
  });

  it("rejects a test override outside the private temporary root", () => {
    const result = runHook(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must stay under /tmp");
  });

  it("resolves the test root before applying the temporary-directory boundary", () => {
    const escaped = path.join(fs.realpathSync(os.tmpdir()), "..", path.relative("/", root));
    const result = runHook(escaped);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must stay under /tmp");
  });
});
