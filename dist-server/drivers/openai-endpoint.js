import { createOpenAICompatibleDriver } from "./openai-compatible.js";
// User-configurable local/LAN/remote endpoint. It defaults to Ollama's local
// OpenAI-compatible listener, but the same driver works with vLLM and any
// server exposing /v1/models and /v1/chat/completions. Authentication is
// optional because local Ollama does not require it.
export const OpenAIEndpointDriver = createOpenAICompatibleDriver({
    driverKind: "openaiCompatible",
    displayName: "OpenAI-compatible",
    defaultUrl: "http://127.0.0.1:11434/v1",
    defaultApiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    apiKeyRequired: false,
    defaultModel: "gpt-oss:20b",
    fallbackModels: [{ id: "gpt-oss:20b", label: "gpt-oss 20B" }],
});
