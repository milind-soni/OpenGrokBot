import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DroidAgentDriver, ensureDroidInjectModel } from "./acp/droid.ts";
import { ensureGrokInjectSlug } from "./acp/grok.ts";
import { ensureKimiInjectAlias, KimiAgentDriver } from "./acp/kimi.ts";
import { ensureOpenCodeInjectModel } from "./acp/opencode-go.ts";
import { AntigravityDriver } from "./antigravity.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const FAKE_AGY = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");
import { ensureHermesInjectProvider } from "./acp/hermes.ts";
import { ensureQwenInjectModel } from "./acp/qwen.ts";
import {
  applyClaudeInject,
  applyOpenAIInject,
  codexLocalProviderArgs,
  decodeInjectId,
  encodeInjectId,
  loadedIdsFromPayloads,
  LOCAL_HOSTS,
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

describe("loadedIdsFromPayloads", () => {
  const omlx = LOCAL_HOSTS.find((host) => host.id === "omlx")!;
  const ollama = LOCAL_HOSTS.find((host) => host.id === "ollama")!;
  const lmstudio = LOCAL_HOSTS.find((host) => host.id === "lmstudio")!;

  it("uses oMLX /health default_model when no per-model loaded flags exist", () => {
    const loaded = loadedIdsFromPayloads(
      omlx,
      { data: [{ id: "gemma-4-31b-it-bf16" }, { id: "GLM-5.2-fp8" }] },
      { default_model: "gemma-4-31b-it-bf16", engine_pool: { loaded_count: 1 } },
    );
    expect([...loaded]).toEqual(["gemma-4-31b-it-bf16"]);
  });

  it("pins every oMLX /v1/models/status loaded row, not the default_model", () => {
    const loaded = loadedIdsFromPayloads(
      omlx,
      {
        data: [
          { id: "Qwen3.8-27B-Abliterated-MLX-BF16" },
          { id: "gemma-4-31b-it-bf16" },
          { id: "GLM-5.2-fp8" },
        ],
      },
      {
        default_model: "Qwen3.8-27B-Abliterated-MLX-BF16",
        loaded_count: 2,
        models: [
          { id: "Qwen3.8-27B-Abliterated-MLX-BF16", loaded: false },
          { id: "gemma-4-31b-it-bf16", loaded: true },
          { id: "GLM-5.2-fp8", loaded: true },
        ],
      },
    );
    expect([...loaded].sort()).toEqual(["GLM-5.2-fp8", "gemma-4-31b-it-bf16"]);
  });

  it("uses Ollama /api/ps running models", () => {
    const loaded = loadedIdsFromPayloads(
      ollama,
      { data: [{ id: "llama3.2:latest" }, { id: "mistral:latest" }] },
      { models: [{ name: "llama3.2:latest", size: 1 }] },
    );
    expect([...loaded]).toEqual(["llama3.2:latest"]);
  });

  it("pins the catalog id when /api/ps reports a tagged name", () => {
    const loaded = loadedIdsFromPayloads(
      ollama,
      { data: [{ id: "llama3.2" }, { id: "mistral" }] },
      { models: [{ name: "llama3.2:latest", size: 1 }] },
    );
    expect(loaded.has("llama3.2")).toBe(true);
    expect(loaded.has("llama3.2:latest")).toBe(true);
  });

  it("uses LM Studio state=loaded and skips not-loaded", () => {
    const loaded = loadedIdsFromPayloads(
      lmstudio,
      { data: [{ id: "qwen" }, { id: "other" }] },
      { data: [{ id: "qwen", state: "loaded" }, { id: "other", state: "not-loaded" }] },
    );
    expect([...loaded]).toEqual(["qwen"]);
  });

  it("does not pin a default_model that is not in the catalog", () => {
    const loaded = loadedIdsFromPayloads(
      omlx,
      { data: [{ id: "gemma-4-31b-it-bf16" }] },
      { default_model: "someone-elses-model" },
    );
    expect(loaded.size).toBe(0);
  });
});

describe("mergeLocalInject", () => {
  it("marks oMLX /v1/models/status loaded rows, not the default_model", async () => {
    const catalog = await mergeLocalInject(
      { default: "keep", options: [{ id: "keep", label: "Keep" }] },
      { VITEST: "true", OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" },
      async (url) => {
        const href = String(url);
        if (href.includes("/v1/models/status")) {
          return new Response(
            JSON.stringify({
              default_model: "Qwen3.8-27B-Abliterated-MLX-BF16",
              models: [
                { id: "Qwen3.8-27B-Abliterated-MLX-BF16", loaded: false },
                { id: "gemma-4-31b-it-bf16", loaded: true },
                { id: "GLM-5.2-fp8", loaded: true },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.includes(":8080/v1/models")) {
          return new Response(
            JSON.stringify({
              data: [
                { id: "Qwen3.8-27B-Abliterated-MLX-BF16" },
                { id: "gemma-4-31b-it-bf16" },
                { id: "GLM-5.2-fp8" },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 500 });
      },
    );
    expect(catalog.options.find((option) => option.id === "omlx::gemma-4-31b-it-bf16")).toMatchObject({
      custom: true,
      loaded: true,
    });
    expect(catalog.options.find((option) => option.id === "omlx::GLM-5.2-fp8")).toMatchObject({
      custom: true,
      loaded: true,
    });
    expect(catalog.options.find((option) => option.id === "omlx::Qwen3.8-27B-Abliterated-MLX-BF16")?.loaded).toBeUndefined();
  });

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

describe("applyOpenAIInject", () => {
  it("points an OpenAI-compatible CLI at the local host", () => {
    const env: Record<string, string | undefined> = {};
    const applied = applyOpenAIInject(env, "omlx::MiniMax-M3-4bit");
    expect(applied).toEqual({ model: "MiniMax-M3-4bit", injected: true });
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1");
    expect(env.OPENAI_API_KEY).toBe("omlx");
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

describe("codexLocalProviderArgs", () => {
  it("configures custom providers through env keys without putting credentials on argv", () => {
    const env: Record<string, string | undefined> = { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" };
    const args = codexLocalProviderArgs(env, "unsloth::local-model");
    const rendered = JSON.stringify(args);
    expect(rendered).toContain("model_providers.unsloth.base_url");
    expect(rendered).toContain("OPENMAUSBOT_LOCAL_UNSLOTH_API_KEY");
    expect(rendered).not.toContain("unsloth-secret");
    expect(rendered).not.toContain("model_providers.ollama.base_url");
    expect(rendered).not.toContain("model_providers.lmstudio.base_url");
    expect(env.OPENMAUSBOT_LOCAL_UNSLOTH_API_KEY).toBe("unsloth-secret");
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

  it("writes the resolved Unsloth credential instead of a placeholder", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-grok-unsloth-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".grok"), { recursive: true });
    ensureGrokInjectSlug("unsloth::local-model", {
      HOME: home,
      UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret",
    });
    const text = readFileSync(join(home, ".grok", "config.toml"), "utf8");
    expect(text).toContain(`api_key = "unsloth-secret"`);
  });
});

describe("ensureKimiInjectAlias", () => {
  it("writes an openai_legacy provider and model alias without touching hooks", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-kimi-inject-"));
    scratchDirs.push(home);
    const root = join(home, ".kimi-code");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.toml"), "# keep me\n[[hooks]]\nevent = \"Stop\"\n");
    const first = ensureKimiInjectAlias("omlx::GLM-5.2-fp8", { HOME: home });
    const again = ensureKimiInjectAlias("omlx::GLM-5.2-fp8", { HOME: home });
    expect(first).toBe("omlx/GLM-5.2-fp8");
    expect(again).toBe(first);
    const text = readFileSync(join(root, "config.toml"), "utf8");
    expect(text).toContain("[[hooks]]");
    expect(text.match(/\[providers\.omlx\]/g)?.length).toBe(1);
    expect(text).toContain(`base_url = "http://127.0.0.1:8080/v1"`);
    expect(text).toContain(`model = "GLM-5.2-fp8"`);
  });

  it("treats USERPROFILE as the same home for credentials and config", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-kimi-userprofile-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(join(home, ".kimi-code", "credentials", "kimi-code.json"), "{}");
    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-userprofile",
      displayName: "Kimi",
      environment: { HOME: "", USERPROFILE: home },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: false },
    });
    try {
      const snap = await instance.snapshot();
      expect(snap.state).toBe("available");
      expect(snap.authenticated).toBe(true);
      expect(ensureKimiInjectAlias("omlx::GLM-5.2-fp8", { HOME: undefined, USERPROFILE: home })).toBe("omlx/GLM-5.2-fp8");
      expect(readFileSync(join(home, ".kimi-code", "config.toml"), "utf8")).toContain("[providers.omlx]");
    } finally {
      await instance.dispose();
    }
  });
});

describe("ensureDroidInjectModel", () => {
  it("upserts a generic-chat-completion BYOK row and reuses it", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-droid-inject-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".factory"), { recursive: true });
    writeFileSync(join(home, ".factory", "settings.json"), JSON.stringify({ hooks: { Stop: [] } }));
    const first = ensureDroidInjectModel("omlx::MiniMax-M3-4bit", { HOME: home });
    const again = ensureDroidInjectModel("omlx::MiniMax-M3-4bit", { HOME: home });
    expect(first).toBe("custom:openmausbot-omlx-MiniMax-M3-4bit");
    expect(again).toBe(first);
    const settings = JSON.parse(readFileSync(join(home, ".factory", "settings.json"), "utf8")) as {
      hooks: unknown;
      customModels: Array<{ id: string; model: string; baseUrl: string; provider: string }>;
    };
    expect(settings.hooks).toEqual({ Stop: [] });
    expect(settings.customModels).toHaveLength(1);
    expect(settings.customModels[0]).toMatchObject({
      id: first,
      model: "MiniMax-M3-4bit",
      baseUrl: "http://127.0.0.1:8080/v1",
      provider: "generic-chat-completion-api",
    });
  });

  it("persists a generated id onto a matching customModels row that has none", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-droid-inject-noid-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".factory"), { recursive: true });
    writeFileSync(
      join(home, ".factory", "settings.json"),
      JSON.stringify({
        customModels: [{ model: "MiniMax-M3-4bit", baseUrl: "http://127.0.0.1:8080/v1", displayName: "local" }],
      }),
    );
    const id = ensureDroidInjectModel("omlx::MiniMax-M3-4bit", { HOME: home });
    const settings = JSON.parse(readFileSync(join(home, ".factory", "settings.json"), "utf8")) as {
      customModels: Array<{ id?: string; model: string }>;
    };
    expect(id).toBe("custom:openmausbot-omlx-MiniMax-M3-4bit");
    expect(settings.customModels).toHaveLength(1);
    expect(settings.customModels[0]?.id).toBe(id);
  });
});

describe("ensureOpenCodeInjectModel", () => {
  it("merges a host provider into opencode.json without dropping existing models", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-opencode-inject-"));
    scratchDirs.push(home);
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({
        provider: {
          omlx: {
            npm: "@ai-sdk/openai-compatible",
            name: "oMLX",
            options: { baseURL: "http://127.0.0.1:8080/v1" },
            models: { "already-there": { name: "Keep me" } },
          },
        },
      }),
    );
    const native = ensureOpenCodeInjectModel("omlx::GLM-5.2-fp8", { HOME: home });
    expect(native).toBe("omlx/GLM-5.2-fp8");
    const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as {
      provider: { omlx: { models: Record<string, { name: string }>; options: { baseURL: string } } };
    };
    expect(config.provider.omlx.models["already-there"]).toEqual({ name: "Keep me" });
    expect(config.provider.omlx.models["GLM-5.2-fp8"]).toBeTruthy();
    expect(config.provider.omlx.options.baseURL).toBe("http://127.0.0.1:8080/v1");
  });

  it("injects into a default object when opencode.json is malformed", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-opencode-bad-json-"));
    scratchDirs.push(home);
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), "{not-json");
    expect(ensureOpenCodeInjectModel("omlx::GLM-5.2-fp8", { HOME: home })).toBe("omlx/GLM-5.2-fp8");
    const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as {
      provider: { omlx: { models: Record<string, unknown> } };
    };
    expect(config.provider.omlx.models["GLM-5.2-fp8"]).toBeTruthy();
  });
});

describe("ensureHermesInjectProvider", () => {
  it("writes a named custom provider and returns the ACP model id", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-hermes-inject-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "config.yaml"), "model:\n  provider: auto\n  base_url: https://openrouter.ai/api/v1\n");
    const native = ensureHermesInjectProvider("omlx::gemma-4-31b-it-bf16", { HOME: home });
    expect(native).toBe("custom:omlx:gemma-4-31b-it-bf16");
    const again = ensureHermesInjectProvider("omlx::gemma-4-31b-it-bf16", { HOME: home });
    expect(again).toBe(native);
    const text = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
    expect(text).toContain("provider: auto");
    expect(text).toContain("https://openrouter.ai/api/v1");
    expect(text.match(/^  omlx:$/gm)?.length).toBe(1);
    expect(text).toContain("base_url: http://127.0.0.1:8080/v1");
    expect(text).toContain("api_key: omlx");
  });

  it("replaces a nested provider block without leaving orphan YAML lines", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-hermes-nested-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "config.yaml"),
      [
        "providers:",
        "  omlx:",
        "    base_url: http://old",
        "    extras:",
        "      nested: keep-sibling-not-this",
        "    api_key: old",
        "  other:",
        "    base_url: http://other",
        "",
      ].join("\n"),
    );
    ensureHermesInjectProvider("omlx::gemma-4-31b-it-bf16", { HOME: home });
    const text = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
    expect(text).toContain("  other:\n    base_url: http://other");
    expect(text).toContain("base_url: http://127.0.0.1:8080/v1");
    expect(text).not.toContain("nested: keep-sibling-not-this");
    expect(text).not.toContain("http://old");
    expect(text.match(/^  omlx:$/gm)?.length).toBe(1);
  });
});

describe("ensureQwenInjectModel", () => {
  it("upserts an OpenAI-compatible provider without dropping existing rows", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-qwen-inject-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".qwen"), { recursive: true });
    writeFileSync(
      join(home, ".qwen", "settings.json"),
      JSON.stringify({
        modelProviders: {
          openai: [{ id: "keep-me", name: "Keep me", baseUrl: "http://127.0.0.1:9/v1", envKey: "KEEP" }],
        },
      }),
    );
    const native = ensureQwenInjectModel("omlx::GLM-5.2-fp8", { HOME: home });
    expect(native).toBe("GLM-5.2-fp8");
    const settings = JSON.parse(readFileSync(join(home, ".qwen", "settings.json"), "utf8")) as {
      env: Record<string, string>;
      modelProviders: { openai: Array<{ id: string }> };
    };
    expect(settings.modelProviders.openai.map((row) => row.id)).toEqual(["keep-me", "GLM-5.2-fp8"]);
    expect(settings.env.OPENMAUSBOT_QWEN_OMLX_API_KEY).toBe("omlx");
    if (process.platform !== "win32") {
      expect(statSync(join(home, ".qwen", "settings.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("injects into a default object when settings.json is malformed", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-qwen-bad-json-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".qwen"), { recursive: true });
    writeFileSync(join(home, ".qwen", "settings.json"), "{not-json");
    expect(ensureQwenInjectModel("omlx::GLM-5.2-fp8", { HOME: home })).toBe("GLM-5.2-fp8");
    const settings = JSON.parse(readFileSync(join(home, ".qwen", "settings.json"), "utf8")) as {
      modelProviders: { openai: Array<{ id: string }> };
    };
    expect(settings.modelProviders.openai.map((row) => row.id)).toEqual(["GLM-5.2-fp8"]);
  });
});

describe("live Custom lists on every local CLI harness", () => {
  it("merges probed host models onto Kimi, Droid, and Antigravity", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes(":8080")) {
        return new Response(JSON.stringify({ data: [{ id: "GLM-5.2-fp8" }] }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const home = mkdtempSync(join(tmpdir(), "omb-all-inject-"));
    scratchDirs.push(home);
    const environment = { HOME: home, OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" };
    const instances: Array<Awaited<ReturnType<typeof KimiAgentDriver.create>>> = [];
    try {
      instances.push(
        await KimiAgentDriver.create({
          instanceId: "kimi",
          displayName: "Kimi",
          environment,
          enabled: true,
          config: { cli: FAKE_ACP, fullAuto: false },
        }),
      );
      instances.push(
        await DroidAgentDriver.create({
          instanceId: "droid",
          displayName: "Droid",
          environment,
          enabled: true,
          config: { cli: FAKE_ACP, fullAuto: false },
        }),
      );
      instances.push(
        await AntigravityDriver.create({
          instanceId: "agy",
          displayName: "Antigravity",
          environment,
          enabled: true,
          config: { cli: FAKE_AGY, fullAuto: true },
        }),
      );
      for (const instance of instances) {
        expect(instance.models.options.some((option) => option.id === "omlx::GLM-5.2-fp8" && option.custom)).toBe(
          true,
        );
      }
    } finally {
      globalThis.fetch = previous;
      for (const instance of instances) await instance.dispose();
    }
  });
});
