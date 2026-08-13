import { createOpenAICompatibleDriver } from "./openai-compatible.js";
export const OpenRouterDriver = createOpenAICompatibleDriver({
    driverKind: "openrouter",
    displayName: "OpenRouter",
    defaultUrl: "https://openrouter.ai/api/v1",
    defaultApiKeyEnv: "OPENROUTER_API_KEY",
    apiKeyRequired: true,
    defaultModel: "openrouter/auto",
    fallbackModels: [{ id: "openrouter/auto", label: "Auto Router" }],
    imageModelsPath: "/images/models",
    videoModelsPath: "/videos/models",
    imagePath: "/images",
    videoPath: "/videos",
    headers: {
        "HTTP-Referer": "https://github.com/milind-soni/OpenMausBot",
        "X-OpenRouter-Title": "OpenMausBot",
    },
    missingCredentialMessage: "no OpenRouter API key — add one in App Settings or set OPENROUTER_API_KEY",
});
