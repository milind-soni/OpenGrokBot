import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { HERMES_CONFIG_MODEL_ID, hermesAcpModelId, hermesConfiguredModel } from "./hermes.ts";

describe("hermesConfiguredModel", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTempDir(d);
  });

  const home = (env: string, cfg?: string) => {
    const root = mkdtempSync(join(tmpdir(), "omb-hermes-"));
    dirs.push(root);
    const h = join(root, ".hermes");
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, ".env"), env);
    if (cfg !== undefined) writeFileSync(join(h, "config.yaml"), cfg);
    return { HERMES_HOME: h };
  };

  it("offers the configured model when a hosted key is set", () => {
    const env = home("OPENROUTER_API_KEY=sk-or-v1-test\n", "model:\n  default: anthropic/claude-opus-4.6\n");
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "anthropic/claude-opus-4.6 (Hermes config)",
    });
  });

  it("treats a commented-out key as not configured", () => {
    // The shipped .env carries `# OPENROUTER_API_KEY=`; reading that as
    // configured would offer a model that cannot authenticate.
    const env = home("# OPENROUTER_API_KEY=\n", "model:\n  default: anthropic/claude-opus-4.6\n");
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it("returns null when there is no .env at all, leaving local-only setups unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-hermes-bare-"));
    dirs.push(root);
    expect(hermesConfiguredModel({ HERMES_HOME: join(root, ".hermes") })).toBeNull();
  });

  it("still offers the model when config.yaml is unreadable, with a generic label", () => {
    const env = home("OPENROUTER_API_KEY=sk-or-v1-test\n");
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "Hermes default (config)",
    });
  });

  it("does not map to an ACP model id, so no session/set_model is sent for it", () => {
    // This is what makes Hermes fall through to its own configured provider.
    expect(hermesAcpModelId(HERMES_CONFIG_MODEL_ID)).toBeNull();
  });
});
