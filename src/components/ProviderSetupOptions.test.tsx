import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider } from "@/state/store";
import { ProviderSetupOptions } from "./ProviderSetupOptions";

describe("ProviderSetupOptions", () => {
  it("offers every API and network model provider without requiring a key", () => {
    const html = renderToStaticMarkup(
      <StoreProvider>
        <ProviderSetupOptions />
      </StoreProvider>,
    );

    expect(html).toContain("OpenRouter");
    expect(html).toContain("Ollama Cloud");
    expect(html).toContain("Custom OpenAI-compatible");
    expect(html).toContain("Set up later in App Settings");
    expect(html).toContain('type="password"');
    expect(html).toContain("http://127.0.0.1:11434/v1");
    expect(html).not.toContain("Image path");
    expect(html).not.toContain("Model task overrides");
  });
});
