import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CreationEntry } from "@/lib/creations";
import { CreationsPanel } from "./CreationsPanel";

const entries: CreationEntry[] = [
  {
    id: "html-message:0",
    kind: "html",
    botId: "bot-1",
    botName: "Website Maus",
    threadId: "thread-1",
    messageId: "html-message",
    createdAt: 20,
    title: "artifact-1.html",
    html: "<h1>Do not execute in the library</h1>",
  },
  {
    id: "media-message:image-1",
    kind: "image",
    botId: "bot-1",
    botName: "Website Maus",
    threadId: "thread-1",
    messageId: "media-message",
    createdAt: 10,
    title: "Generated image 1",
    media: { id: "image-1", kind: "image", status: "ready", cacheKey: "cache-image.png" },
  },
  {
    id: "video-message:video-1",
    kind: "video",
    botId: "bot-2",
    botName: "Video Maus",
    threadId: "thread-2",
    messageId: "video-message",
    createdAt: 5,
    title: "Generated video 1",
    media: { id: "video-1", kind: "video", status: "ready", cacheKey: "cache-video.mp4" },
  },
];

describe("CreationsPanel", () => {
  it("renders filters, grouped conversations, and guarded media URLs", () => {
    const html = renderToStaticMarkup(
      <CreationsPanel creations={entries} onOpen={() => {}} onClose={() => {}} />,
    );

    expect(html).toContain("Creations");
    expect(html).toContain("All");
    expect(html).toContain("HTML");
    expect(html).toContain("Images");
    expect(html).toContain("Videos");
    expect(html).toContain("Website Maus");
    expect(html).toContain("Video Maus");
    expect(html).toContain("/api/media/cache-image.png");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("Do not execute in the library");
    expect(html).not.toContain("cache-video.mp4\" autoplay");
  });

  it("renders an explanatory empty state", () => {
    const html = renderToStaticMarkup(
      <CreationsPanel creations={[]} onOpen={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("Your HTML, images, and videos will appear here");
  });
});
