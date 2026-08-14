// Reasonix credential resolution — pure unit tests, no spawn. Covers the
// <Reasonix home>/.env detection the reviewer asked for: REASONIX_HOME and
// Windows %APPDATA% fallback, plus the .env value grammar (valid, empty,
// comment-only, quoted-empty, export-prefixed).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hasReasonixCredentials, isReasonixAuthenticated, reasonixHome } from "./reasonix.ts";

describe("reasonixHome", () => {
  it("REASONIX_HOME wins over every fallback", () => {
    expect(reasonixHome({ REASONIX_HOME: "/custom/reasonix" }, "linux")).toBe("/custom/reasonix");
    expect(reasonixHome({ REASONIX_HOME: "/custom/reasonix", APPDATA: "C:\\AppData" }, "win32")).toBe(
      "/custom/reasonix",
    );
  });

  it("Windows uses %APPDATA%\\reasonix", () => {
    expect(reasonixHome({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toBe(
      join("C:\\Users\\me\\AppData\\Roaming", "reasonix"),
    );
  });

  it("Windows without APPDATA falls back to ~/AppData/Roaming/reasonix", () => {
    expect(reasonixHome({}, "win32")).toBe(
      join(process.env.HOME || process.env.USERPROFILE || "", "AppData", "Roaming", "reasonix"),
    );
  });

  it("non-Windows defaults to ~/.reasonix", () => {
    expect(reasonixHome({}, "linux")).toBe(join(process.env.HOME || "", ".reasonix"));
  });
});

describe("hasReasonixCredentials", () => {
  it("accepts a plain KEY=value", () => {
    expect(hasReasonixCredentials("DEEPSEEK_API_KEY=sk-abc123")).toBe(true);
  });

  it("accepts an export-prefixed assignment", () => {
    expect(hasReasonixCredentials("export DEEPSEEK_API_KEY=sk-abc123")).toBe(true);
  });

  it("accepts quoted values", () => {
    expect(hasReasonixCredentials('DEEPSEEK_API_KEY="sk-abc123"')).toBe(true);
    expect(hasReasonixCredentials("DEEPSEEK_API_KEY='sk-abc123'")).toBe(true);
  });

  it("rejects an empty assignment", () => {
    expect(hasReasonixCredentials("DEEPSEEK_API_KEY=")).toBe(false);
  });

  it("rejects a quoted-empty assignment", () => {
    expect(hasReasonixCredentials('DEEPSEEK_API_KEY=""')).toBe(false);
    expect(hasReasonixCredentials("DEEPSEEK_API_KEY=''")).toBe(false);
  });

  it("rejects a comment-only file", () => {
    expect(hasReasonixCredentials("# DEEPSEEK_API_KEY=sk-abc123\n# another comment")).toBe(false);
  });

  it("finds a valid key among comments and blanks", () => {
    expect(hasReasonixCredentials("# header\n\nDEEPSEEK_API_KEY=sk-abc123\n")).toBe(true);
  });
});

describe("isReasonixAuthenticated", () => {
  let scratch: string;

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("true when <home>/.env has a credential", () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-reasonix-"));
    writeFileSync(join(scratch, ".env"), "export DEEPSEEK_API_KEY=sk-abc123\n");
    expect(isReasonixAuthenticated({ REASONIX_HOME: scratch })).toBe(true);
  });

  it("false when <home>/.env is empty or quoted-empty", () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-reasonix-"));
    writeFileSync(join(scratch, ".env"), 'DEEPSEEK_API_KEY=""\n');
    expect(isReasonixAuthenticated({ REASONIX_HOME: scratch })).toBe(false);
  });

  it("false when <home>/.env is missing", () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-reasonix-"));
    expect(isReasonixAuthenticated({ REASONIX_HOME: scratch })).toBe(false);
  });
});
