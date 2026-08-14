import { describe, expect, it } from "vitest";

import { instanceConfigs } from "./config.ts";

describe("model provider instance configuration", () => {
  it("adds the API-backed providers to the default fleet", () => {
    const configs = instanceConfigs({
      openrouter: { key: "router-key" },
      ollamaCloud: { key: "ollama-key" },
      openaiCompatible: {
        key: "endpoint-key",
        url: "http://10.0.0.42:8000/v1",
        model: "org/open-model",
      },
    });

    expect(configs.openrouter).toMatchObject({
      driver: "openrouter",
      config: { url: "https://openrouter.ai/api/v1" },
      environment: { OPENROUTER_API_KEY: "router-key" },
    });
    expect(configs["ollama-cloud"]).toMatchObject({
      driver: "ollamaCloud",
      config: { url: "https://ollama.com/v1" },
      environment: { OLLAMA_API_KEY: "ollama-key" },
    });
    expect(configs["openai-compatible"]).toMatchObject({
      driver: "openaiCompatible",
      config: { url: "http://10.0.0.42:8000/v1", model: "org/open-model" },
      environment: { OPENAI_COMPATIBLE_API_KEY: "endpoint-key" },
    });
  });

  it("injects each provider credential only into its matching driver", () => {
    const configs = instanceConfigs({
      xai: { key: "xai-key" },
      openrouter: { key: "router-key" },
      ollamaCloud: { key: "ollama-key" },
      openaiCompatible: { key: "endpoint-key" },
      box: { token: "box-token" },
      instances: {
        grokApi: { driver: "grok" },
        router: { driver: "openrouter" },
        ollama: { driver: "ollamaCloud" },
        endpoint: { driver: "openaiCompatible" },
        computer: { driver: "boxAgent" },
        unrelated: { driver: "claudeAgent" },
      },
    });

    expect(configs.grokApi.environment).toEqual({ XAI_API_KEY: "xai-key" });
    expect(configs.router.environment).toEqual({ OPENROUTER_API_KEY: "router-key" });
    expect(configs.ollama.environment).toEqual({ OLLAMA_API_KEY: "ollama-key" });
    expect(configs.endpoint.environment).toEqual({ OPENAI_COMPATIBLE_API_KEY: "endpoint-key" });
    expect(configs.computer.environment).toEqual({ BOX_TOKEN: "box-token" });
    expect(configs.unrelated.environment).toEqual({});
  });

  it("preserves explicit per-instance credential overrides", () => {
    const configs = instanceConfigs({
      openrouter: { key: "global-router-key" },
      instances: {
        router: {
          driver: "openrouter",
          environment: { OPENROUTER_API_KEY: "instance-router-key", EXISTING: "kept" },
        },
      },
    });

    expect(configs.router.environment).toEqual({
      OPENROUTER_API_KEY: "instance-router-key",
      EXISTING: "kept",
    });
  });
});
