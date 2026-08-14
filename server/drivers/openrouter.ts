import { createOpenAIEndpointDriver } from "./openai-compatible.ts";

export const OpenRouterDriver = createOpenAIEndpointDriver({
  driverKind: "openrouter",
  displayName: "OpenRouter",
  defaultUrl: "https://openrouter.ai/api/v1",
  defaultModel: "openrouter/auto",
  apiKeyEnv: "OPENROUTER_API_KEY",
  credentialRequired: true,
  imageModelsPath: "/images/models",
  videoModelsPath: "/videos/models",
  imagePath: "/images",
  videoPath: "/videos",
  headers: {
    "HTTP-Referer": "https://github.com/milind-soni/OpenMausBot",
    "X-OpenRouter-Title": "OpenMausBot",
  },
});
