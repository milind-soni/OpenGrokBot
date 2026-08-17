import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureGrokInjectSlug } from "./acp/grok.ts";
import {
  applyClaudeInject,
  decodeInjectId,
  encodeInjectId,
  mergeLocalInject,
} from "./local-inject.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inject ids", () => {
  it("round-trips a host and API id", () => {
    expect(decodeInjectId(encodeInjectId("omlx", "GLM-5.2-fp8"))).toEqual({
      host: "omlx",
      model: "GLM-5.2-fp8",
    });
  });

  it("rejects official cloud slugs", () => {
    expect(decodeInjectId("claude-sonnet-5")).toBeNull();
    expect(decodeInjectId("gpt-5.6-sol")).toBeNull();
  });
});

describe("mergeLocalInject", () => {
  it("appends live host models as custom without touching official rows", async () => {
    const catalog = await mergeLocalInject(
      { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }] },
      { VITEST: "true", OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" },
      async (url) => {
        if (String(url).includes(":8080")) {
          return new Response(JSON.stringify({ data: [{ id: "GLM-5.2-fp8" }, { id: "nomic-embed" }] }), { status: 200 });
        }
        return new Response("nope", { status: 500 });
      },
    );
    expect(catalog.options[0]).toEqual({ id: "claude-sonnet-5", label: "Claude Sonnet 5" });
    expect(catalog.options.some((option) => option.id === "omlx::GLM-5.2-fp8" && option.custom)).toBe(true);
    expect(catalog.options.some((option) => option.id.includes("nomic"))).toBe(false);
  });
});

describe("applyClaudeInject", () => {
  it("points Claude at the local host instead of Anthropic", () => {
    const env: Record<string, string | undefined> = {};
    const applied = applyClaudeInject(env, "omlx::MiniMax-M3-4bit");
    expect(applied).toEqual({ model: "MiniMax-M3-4bit", injected: true });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("omlx");
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M3-4bit");
  });
});

describe("ensureGrokInjectSlug", () => {
  it("writes a config block the first time and reuses it after", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-grok-inject-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "config.toml"), "[cli]\nchannel = \"alpha\"\n");
    const first = ensureGrokInjectSlug("omlx::GLM-5.2-fp8", { HOME: home });
    const again = ensureGrokInjectSlug("omlx::GLM-5.2-fp8", { HOME: home });
    expect(first).toBe(again);
    const text = readFileSync(join(home, ".grok", "config.toml"), "utf8");
    expect(text).toContain(`model = "GLM-5.2-fp8"`);
    expect(text).toContain(`base_url = "http://127.0.0.1:8080/v1"`);
  });
});
