import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readCuaConnection } from "./local-computer.ts";

describe("local computer descriptor", () => {
  it("fails closed on Linux even when a valid-looking descriptor exists", () => {
    const userData = join(process.env.HOME!, "linux-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "/tmp/cua-driver",
        mcpArgs: ["mcp", "--embedded"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );

    expect(readCuaConnection({ platform: "linux", userData })).toBeNull();
  });

  it("reads and validates an exact platform userData descriptor", () => {
    const userData = join(process.env.HOME!, "windows-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "C:\\cua-driver.exe",
        mcpArgs: ["mcp"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );

    expect(readCuaConnection({ platform: "win32", userData })).toEqual({
      command: "C:\\cua-driver.exe",
      args: ["mcp"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
    });
  });

  it("rejects malformed argv and environment values", () => {
    const userData = join(process.env.HOME!, "invalid-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({ mode: "embedded", mcpCommand: "cua-driver", mcpArgs: "mcp" }),
    );

    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
  });

  it("rejects an array environment descriptor", () => {
    const userData = join(process.env.HOME!, "array-environment-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "cua-driver",
        mcpEnv: ["CUA_DRIVER_EMBEDDED=1"],
      }),
    );

    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
  });
});
