import { createOpenAIEndpointDriver } from "./openai-compatible.ts";

export const OpenRouterDriver = createOpenAIEndpointDriver({
  driverKind: "openrouter",
  displayName: "OpenRouter",
  defaultUrl: "https://openrouter.ai/api/v1",
  defaultModel: "openrouter/auto",
  apiKeyEnv: "OPENROUTER_API_KEY",
  credentialRequired: true,
  headers: {
    "HTTP-Referer": "https://github.com/milind-soni/OpenMausBot",
    "X-OpenRouter-Title": "OpenMausBot",
  },
});
