import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MediaMessage, MediaViewer } from "./MediaMessage";

describe("MediaMessage", () => {
  it("offers a per-message stop control while a video is running", () => {
    const html = renderToStaticMarkup(
      <MediaMessage
        messageId="message-1"
        outputs={[{ id: "output-1", kind: "video", status: "generating", progress: 0.42 }]}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("Generating video");
    expect(html).toContain("42%");
    expect(html).toContain("Stop");
  });

  it("renders cached media without trusting a provider URL", () => {
    const html = renderToStaticMarkup(
      <MediaMessage
        messageId="message-2"
        outputs={[{ id: "output-2", kind: "image", status: "ready", cacheKey: "safe.png", mime: "image/png" }]}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain('src="/api/media/safe.png"');
    expect(html).toContain("Open image");
  });
});

describe("MediaViewer", () => {
  it("has dialog semantics and an explicit close control", () => {
    const html = renderToStaticMarkup(
      <MediaViewer
        output={{ id: "output-2", kind: "image", status: "ready", cacheKey: "safe.png", mime: "image/png" }}
        onClose={vi.fn()}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Close media viewer"');
  });
});
