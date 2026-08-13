import { describe, expect, it } from "vitest";
import { videoReferences } from "./watch-skill.ts";
describe("watch-skill handoff", () => {
  it("recognizes supported video URLs but ignores normal links", () => expect(videoReferences("see https://youtu.be/demo https://example.com/a https://cdn.x/demo.webm")).toEqual(["https://youtu.be/demo", "https://cdn.x/demo.webm"]));
  it("does not treat prose as a video reference", () => expect(videoReferences("please explain this recording")).toEqual([]));
});
