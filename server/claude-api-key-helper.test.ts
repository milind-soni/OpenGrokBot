import { describe, expect, it } from "vitest";

import {
  claudeApiKeyHelperChildEnv,
  readClaudeApiKey,
} from "./claude-api-key-helper.ts";

describe("Claude bare-mode API key helper", () => {
  it("accepts only logical CredVault aliases and never falls back to host OAuth files", () => {
    for (const value of [undefined, "", "../../credential", "alias with spaces", "alias\nnext"]) {
      expect(() => readClaudeApiKey(value)).toThrow(/alias is invalid/);
    }
  });

  it("re-executes a packaged Electron binary in Node mode", () => {
    expect(claudeApiKeyHelperChildEnv({ PATH: "/safe/bin", HOME: "/safe/home" })).toEqual({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });
});
