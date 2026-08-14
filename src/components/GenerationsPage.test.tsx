import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GenerationCard } from "./GenerationsPage";

describe("GenerationCard", () => {
  it("renders cached images as an accessible open control", () => {
    const html = renderToStaticMarkup(
      <GenerationCard
        item={{
          id: "media:image-1",
          kind: "image",
          createdAt: 100,
          ownerId: "bot-1",
          ownerName: "Builder",
          contextTitle: "Campaign",
          threadId: "thread-1",
          messageId: "message-1",
          output: { id: "image-1", kind: "image", status: "ready", cacheKey: "safe.png", mime: "image/png" },
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(html).toContain('src="/api/media/safe.png"');
    expect(html).toContain('aria-label="Open image generation from Builder"');
    expect(html).toContain("Campaign");
  });

  it("labels HTML creations without executing them in the grid", () => {
    const html = renderToStaticMarkup(
      <GenerationCard
        item={{
          id: "html:message-1:0",
          kind: "html",
          createdAt: 100,
          ownerId: "bot-1",
          ownerName: "Builder",
          contextTitle: "Landing page",
          threadId: "thread-1",
          messageId: "message-1",
          artifact: {
            id: "message-1:0",
            messageId: "message-1",
            index: 0,
            language: "html",
            html: "<script>window.__ran = true</script><h1>Preview</h1>",
            sourceLine: 1,
          },
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(html).toContain("HTML creation");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("window.__ran = true");
  });
});
