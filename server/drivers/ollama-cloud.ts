import { createOpenAIEndpointDriver } from "./openai-compatible.ts";

export const OllamaCloudDriver = createOpenAIEndpointDriver({
  driverKind: "ollamaCloud",
  displayName: "Ollama Cloud",
  defaultUrl: "https://ollama.com/v1",
  defaultModel: "gpt-oss:120b",
  apiKeyEnv: "OLLAMA_API_KEY",
  credentialRequired: true,
});
