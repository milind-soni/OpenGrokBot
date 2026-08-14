import { describe, expect, it } from "vitest";

import { collectGenerations, type GenerationSource } from "./generations";

describe("collectGenerations", () => {
  it("collects completed HTML and ready cached media across conversations", () => {
    const sources: GenerationSource[] = [
      {
        ownerId: "bot-1",
        ownerName: "Builder",
        contextTitle: "Launch page",
        threadId: "thread-1",
        messages: [
          {
            id: "html-message",
            role: "bot",
            kind: "text",
            text: "Done\n```html\n<h1>Launch</h1>\n```",
            at: 100,
          },
          {
            id: "media-message",
            role: "bot",
            kind: "media",
            at: 200,
            media: [
              { id: "image-ready", kind: "image", status: "ready", cacheKey: "safe.png", mime: "image/png" },
              { id: "video-cancelled", kind: "video", status: "cancelled" },
            ],
          },
        ],
      },
    ];

    expect(collectGenerations(sources)).toEqual([
      expect.objectContaining({ id: "media:image-ready", kind: "image", createdAt: 200, ownerName: "Builder" }),
      expect.objectContaining({ id: "html:html-message:0", kind: "html", createdAt: 100, contextTitle: "Launch page" }),
    ]);
  });

  it("uses stable output IDs and deterministic newest-first ordering", () => {
    const sources: GenerationSource[] = [
      {
        ownerId: "room-1",
        ownerName: "Design room",
        contextTitle: "Design room",
        threadId: "thread-room",
        messages: [{
          id: "media-message",
          role: "bot",
          kind: "media",
          at: 300,
          media: [
            { id: "video-b", kind: "video", status: "ready", cacheKey: "b.mp4", mime: "video/mp4" },
            { id: "image-a", kind: "image", status: "ready", cacheKey: "a.png", mime: "image/png" },
          ],
        }],
      },
    ];

    expect(collectGenerations(sources).map((item) => item.id)).toEqual(["media:image-a", "media:video-b"]);
  });
});
