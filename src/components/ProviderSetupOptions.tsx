import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { ApiKeyRow } from "./ApiKeys";
import { OpenAIEndpointFields } from "./OpenAIEndpointFields";

function ProviderDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-xl border border-hairline/40 bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-3 text-[13.5px] font-medium text-ink [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronRight size={15} className="text-ink-secondary transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-hairline/30 px-3.5 py-3">{children}</div>
    </details>
  );
}

export function ProviderSetupOptions() {
  return (
    <div>
      <div className="flex flex-col gap-2">
        <ProviderDisclosure title="OpenRouter">
          <ApiKeyRow section="openrouter" label="OpenRouter API key" placeholder="sk-or-v1-…" />
        </ProviderDisclosure>
        <ProviderDisclosure title="Ollama Cloud">
          <ApiKeyRow section="ollamaCloud" label="Ollama Cloud API key" placeholder="Ollama API key" />
        </ProviderDisclosure>
        <ProviderDisclosure title="Custom OpenAI-compatible">
          <div className="flex flex-col gap-3">
            <OpenAIEndpointFields compact />
            <ApiKeyRow
              section="openaiCompatible"
              label="Bearer token (optional)"
              placeholder="Not needed for local Ollama"
            />
          </div>
        </ProviderDisclosure>
      </div>
      <div className="mt-2 text-[11.5px] text-ink-secondary">Set up later in App Settings</div>
    </div>
  );
}
