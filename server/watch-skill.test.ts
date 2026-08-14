import { describe, expect, it } from "vitest";
import { videoReferences } from "./watch-skill.ts";
describe("watch-skill handoff", () => {
  it("recognizes supported video URLs but ignores normal links", () => expect(videoReferences("see https://youtu.be/demo https://example.com/a https://cdn.x/demo.webm")).toEqual(["https://youtu.be/demo", "https://cdn.x/demo.webm"]));
  it("does not treat prose as a video reference", () => expect(videoReferences("please explain this recording")).toEqual([]));

  it("accepts provider video paths but rejects ordinary supported-host pages", () => {
    expect(videoReferences("https://youtube.com/channel/example https://vimeo.com/12345 https://twitch.tv/videos/77 https://loom.com/share/abc"))
      .toEqual(["https://vimeo.com/12345", "https://twitch.tv/videos/77", "https://loom.com/share/abc"]);
  });

  it("keeps direct video queries while removing surrounding prose punctuation", () => {
    expect(videoReferences("Watch (https://cdn.example/demo.webm?download=1), then reply."))
      .toEqual(["https://cdn.example/demo.webm?download=1"]);
  });
});
