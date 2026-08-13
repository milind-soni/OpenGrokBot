import { describe, expect, it } from "vitest";

import { instanceConfigs } from "./config.ts";

describe("model provider instance configuration", () => {
  it("adds OpenRouter, Ollama Cloud, and a configurable OpenAI endpoint to the default fleet", () => {
    const configs = instanceConfigs({
      openrouter: { key: "router-key" },
      ollamaCloud: { key: "ollama-key" },
      openaiCompatible: {
        key: "endpoint-key",
        url: "http://10.0.0.42:8000/v1",
        model: "org/open-model",
        modelTasks: { "org/image-model": "image", "org/video-model": "video" },
        imagePath: "/generate/image",
        videoPath: "/generate/video",
      },
    });

    expect(configs.openrouter).toMatchObject({
      driver: "openrouter",
      environment: { OPENROUTER_API_KEY: "router-key" },
    });
    expect(configs["ollama-cloud"]).toMatchObject({
      driver: "ollamaCloud",
      environment: { OLLAMA_API_KEY: "ollama-key" },
    });
    expect(configs["openai-compatible"]).toMatchObject({
      driver: "openaiCompatible",
      config: {
        url: "http://10.0.0.42:8000/v1",
        model: "org/open-model",
        modelTasks: { "org/image-model": "image", "org/video-model": "video" },
        imagePath: "/generate/image",
        videoPath: "/generate/video",
      },
      environment: { OPENAI_COMPATIBLE_API_KEY: "endpoint-key" },
    });
  });

  it("injects top-level credentials into advanced custom instances", () => {
    const configs = instanceConfigs({
      openrouter: { key: "router-key" },
      instances: {
        private: {
          driver: "openaiCompatible",
          environment: { EXISTING: "kept" },
          config: { url: "https://models.example/v1", model: "custom" },
        },
      },
    });

    expect(configs.private.environment).toMatchObject({
      OPENROUTER_API_KEY: "router-key",
      EXISTING: "kept",
    });
  });
});
