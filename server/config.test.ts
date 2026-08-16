import { describe, expect, it } from "vitest";

import { instanceConfigs, withInstanceCli, type AppConfig } from "./config.ts";

describe("Instance CLI override", () => {
  it("sets, replaces, and clears config.cli on a default-fleet instance", () => {
    const cfg: AppConfig = {};
    const set = withInstanceCli(cfg, "claude", "/opt/claude-2.1/bin/claude");
    expect(set.ok).toBe(true);
    expect(set.config.instances!.claude.config).toEqual({ cli: "/opt/claude-2.1/bin/claude" });

    const replaced = withInstanceCli(set.config, "claude", "~/bin/claude");
    expect(replaced.config.instances!.claude.config).toEqual({ cli: "~/bin/claude" });

    const cleared = withInstanceCli(replaced.config, "claude", "");
    expect(cleared.config.instances!.claude.config).toBeUndefined();
  });

  it("preserves sibling config keys when clearing only cli", () => {
    const cfg: AppConfig = {
      instances: { claude: { driver: "claudeAgent", config: { cli: "/x/claude", permissionMode: "bypassPermissions" } } },
    };
    const cleared = withInstanceCli(cfg, "claude", "");
    expect(cleared.config.instances!.claude.config).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("leaves the original config untouched and rejects unknown instances", () => {
    const cfg: AppConfig = { instances: { codex: { driver: "codex" } } };
    const result = withInstanceCli(cfg, "codex", "/new/codex");
    expect(result.config.instances!.codex.config).toEqual({ cli: "/new/codex" });
    expect(cfg.instances!.codex.config).toBeUndefined();

    expect(withInstanceCli(cfg, "nope", "/x").ok).toBe(false);
  });

  it("never persists the credential env instanceConfigs injects", () => {
    // instanceConfigs() copies xai/box/opencodeGo keys into every entry's
    // environment for the live fleet; withInstanceCli must strip them back
    // out, or saving a CLI override would copy secrets into the instances
    // section of config.json.
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
    };
    const set = withInstanceCli(cfg, "claude", "/opt/claude");
    expect(set.ok).toBe(true);
    for (const entry of Object.values(set.config.instances!)) {
      expect(entry.environment ?? {}).toEqual({});
    }
    // user-authored env survives
    const custom = { instances: { claude: { driver: "claudeAgent", environment: { MY_FLAG: "1" } } } };
    const kept = withInstanceCli(custom, "claude", "/x");
    expect(kept.config.instances!.claude.environment).toEqual({ MY_FLAG: "1" });
  });
});

describe("OpenCode configuration", () => {
  it("injects the key only into OpenCode instances", () => {
    const cfg: AppConfig = {
      opencode: { apiKey: "secret-value" },
      instances: {
        opencode: { driver: "opencodeAgent" },
        grok: { driver: "grokAgent" },
      },
    };

    const instances = instanceConfigs(cfg);
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "secret-value" });
    expect(instances.grok.environment).toEqual({});
  });

  // The key used to live under `opencodeGo`. Anyone who saved one before this
  // rename has it on disk under the old name, and silently dropping it would
  // send them back to the sign-in screen with no idea why.
  it("still reads a key saved under the previous name", () => {
    const cfg: AppConfig = {
      opencodeGo: { apiKey: "saved-before-the-rename" },
      instances: { opencode: { driver: "opencodeAgent" } },
    };

    expect(instanceConfigs(cfg).opencode.environment).toEqual({
      OPENCODE_API_KEY: "saved-before-the-rename",
    });
  });

  it("prefers the current name when a config carries both", () => {
    const cfg: AppConfig = {
      opencode: { apiKey: "current" },
      opencodeGo: { apiKey: "legacy" },
      instances: { opencode: { driver: "opencodeAgent" } },
    };

    expect(instanceConfigs(cfg).opencode.environment).toEqual({ OPENCODE_API_KEY: "current" });
  });
});
