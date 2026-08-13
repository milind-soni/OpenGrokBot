import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { MediaMessage, MediaViewer } from "./MediaMessage";

function message(media: NonNullable<Message["media"]>): Message {
  return { id: "message-1", role: "bot", kind: "media", media, at: 1 };
}

describe("MediaMessage", () => {
  it("renders cached images and videos from the guarded media route", () => {
    const html = renderToStaticMarkup(
      <MediaMessage
        message={message([
          {
            id: "image-1",
            kind: "image",
            status: "ready",
            mime: "image/png",
            width: 1024,
            height: 768,
            cacheKey: "11111111-1111-4111-8111-111111111111.png",
          },
          {
            id: "video-1",
            kind: "video",
            status: "ready",
            mime: "video/mp4",
            cacheKey: "22222222-2222-4222-8222-222222222222.mp4",
          },
        ])}
      />,
    );

    expect(html).toContain('<img src="/api/media/11111111-1111-4111-8111-111111111111.png"');
    expect(html).toContain('alt="Generated image 1"');
    expect(html).toContain('<video controls="" preload="metadata"');
    expect(html).toContain('src="/api/media/22222222-2222-4222-8222-222222222222.mp4"');
    expect(html).not.toContain("provider.example");
  });

  it("renders generation progress before media is ready", () => {
    const html = renderToStaticMarkup(
      <MediaMessage
        message={message([
          { id: "video-1", kind: "video", status: "generating", progress: 42, providerJobId: "job-1" },
        ])}
      />,
    );

    expect(html).toContain("Generating video");
    expect(html).toContain("42%");
    expect(html).not.toContain("<video");
  });

  it("renders a retry action for failed generation", () => {
    const html = renderToStaticMarkup(
      <MediaMessage
        message={message([
          { id: "image-1", kind: "image", status: "failed", error: "Provider rejected the prompt" },
        ])}
        onRetry={() => {}}
      />,
    );

    expect(html).toContain("Provider rejected the prompt");
    expect(html).toContain("Retry");
  });

  it("marks ready media as externally reopenable", () => {
    const html = renderToStaticMarkup(
      <MediaMessage
        message={message([
          {
            id: "video-1",
            kind: "video",
            status: "ready",
            cacheKey: "22222222-2222-4222-8222-222222222222.mp4",
          },
        ])}
        requestedMediaId="video-1"
        openRequestId="request-1"
      />,
    );

    expect(html).toContain('data-media-id="video-1"');
    expect(html).toContain("Open video viewer");
  });

  it("renders videos in the shared viewer shell", () => {
    const html = renderToStaticMarkup(
      <MediaViewer
        media={{
          id: "video-1",
          kind: "video",
          status: "ready",
          cacheKey: "22222222-2222-4222-8222-222222222222.mp4",
        }}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Generated video viewer");
    expect(html).toContain("<video");
  });
});
