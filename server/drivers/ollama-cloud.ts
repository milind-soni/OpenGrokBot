import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

export const OllamaCloudDriver = createOpenAICompatibleDriver({
  driverKind: "ollamaCloud",
  displayName: "Ollama Cloud",
  defaultUrl: "https://ollama.com/v1",
  defaultApiKeyEnv: "OLLAMA_API_KEY",
  apiKeyRequired: true,
  defaultModel: "gpt-oss:120b",
  fallbackModels: [
    { id: "gpt-oss:120b", label: "gpt-oss 120B" },
    { id: "gpt-oss:20b", label: "gpt-oss 20B" },
  ],
  missingCredentialMessage: "no Ollama Cloud API key — add one in App Settings or set OLLAMA_API_KEY",
});
