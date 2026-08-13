export const PROVIDER_PRESETS = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", requiresApiKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", requiresApiKey: true },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", requiresApiKey: true },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", requiresApiKey: true },
  together: { label: "Together AI", baseUrl: "https://api.together.xyz/v1", requiresApiKey: true },
  fireworks: { label: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", requiresApiKey: true },
  mistral: { label: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", requiresApiKey: true },
  qwen: { label: "Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", requiresApiKey: true },
  kimi: { label: "Kimi", baseUrl: "https://api.moonshot.ai/v1", requiresApiKey: true },
  minimax: { label: "MiniMax", baseUrl: "https://api.minimax.io/v1", requiresApiKey: true },
  ollama: { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", requiresApiKey: false },
  lmstudio: { label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", requiresApiKey: false },
  vllm: { label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1", requiresApiKey: false },
} as const;

export type ProviderPresetId = keyof typeof PROVIDER_PRESETS;

export interface ApiProviderModel {
  id: string;
  label?: string;
}

export interface ApiProviderConfig {
  preset: ProviderPresetId | "custom";
  label?: string;
  baseUrl: string;
  requiresApiKey: boolean;
  apiKey?: string;
  enabled?: boolean;
  models?: ApiProviderModel[];
  defaultModel?: string;
  discoveredAt?: number;
  discoveryError?: string;
}

export function normalizeProviderBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("provider base URL is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("provider base URL must be a valid URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("provider base URL must use HTTPS or local loopback HTTP");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export function providerDisplayName(provider: ApiProviderConfig): string {
  if (provider.label?.trim()) return provider.label.trim();
  return provider.preset === "custom" ? "Custom OpenAI-compatible" : PROVIDER_PRESETS[provider.preset].label;
}

export function safeProviderSummary(id: string, provider: ApiProviderConfig) {
  return {
    id,
    preset: provider.preset,
    label: providerDisplayName(provider),
    baseUrl: provider.baseUrl,
    requiresApiKey: provider.requiresApiKey,
    configured: provider.requiresApiKey ? Boolean(provider.apiKey) : true,
    enabled: provider.enabled !== false,
    models: provider.models ?? [],
    defaultModel: provider.defaultModel ?? provider.models?.[0]?.id ?? "",
    discoveredAt: provider.discoveredAt,
    discoveryError: provider.discoveryError,
  };
}
