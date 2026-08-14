import { describe, expect, it } from "vitest";

import {
  artifactHeaderMode,
  buildArtifactDocument,
  extractHtmlArtifacts,
  findStreamingHtmlFence,
  toggleArtifactSelection,
} from "./html-artifacts";

describe("HTML artifact extraction", () => {
  it("extracts completed HTML fences with stable message-based IDs", () => {
    expect(extractHtmlArtifacts("Before\n```html\n<h1>Hello</h1>\n```\nAfter", "message-1")).toEqual([
      {
        id: "message-1:0",
        messageId: "message-1",
        index: 0,
        language: "html",
        html: "<h1>Hello</h1>",
        sourceLine: 2,
      },
    ]);
  });

  it("ignores partial fences and non-HTML source", () => {
    expect(extractHtmlArtifacts("```html\n<p>partial", "message-1")).toEqual([]);
    expect(extractHtmlArtifacts("```js\ndocument.body.innerHTML = 'x'\n```", "message-1")).toEqual([]);
    expect(extractHtmlArtifacts("Use <main>inline HTML</main> here", "message-1")).toEqual([]);
  });

  it("supports tilde, case-insensitive, and longer fences", () => {
    const markdown = [
      "~~~~HTM",
      "<pre>``` stays inside</pre>",
      "~~~~",
      "~~~html_preview",
      "<button>Go</button>",
      "~~~",
    ].join("\n");
    expect(extractHtmlArtifacts(markdown, "message-2")).toEqual([
      {
        id: "message-2:0",
        messageId: "message-2",
        index: 0,
        language: "htm",
        html: "<pre>``` stays inside</pre>",
        sourceLine: 1,
      },
      {
        id: "message-2:1",
        messageId: "message-2",
        index: 1,
        language: "html_preview",
        html: "<button>Go</button>",
        sourceLine: 4,
      },
    ]);
  });

  it("identifies the exact unfinished HTML fence at the end of a stream", () => {
    expect(findStreamingHtmlFence("Intro\n```html\n<section>work")).toEqual({
      language: "html",
      code: "<section>work",
      sourceLine: 2,
    });
    expect(findStreamingHtmlFence("```html\nready\n```\ntext\n~~~HTM\n<p>still writing")).toEqual({
      language: "htm",
      code: "<p>still writing",
      sourceLine: 5,
    });
    expect(findStreamingHtmlFence("```js\nwork")).toBeNull();
    expect(findStreamingHtmlFence("```html\nready\n```")).toBeNull();
  });
});

describe("artifact document isolation", () => {
  it("keeps inline scripts interactive while blocking all outbound requests", () => {
    const document = buildArtifactDocument("<script>document.body.textContent='ready'</script>");
    expect(document).toContain("Content-Security-Policy");
    expect(document).toContain("script-src 'unsafe-inline'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("navigate-to 'none'");
    expect(document).toContain("img-src data: blob:");
    expect(document).toContain("media-src data: blob:");
    expect(document).not.toContain("img-src data: blob: http:");
    expect(document).not.toContain("script-src 'unsafe-inline' http:");
    expect(document).not.toContain("connect-src http:");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("inserts metadata into a real head without mistaking script text for markup", () => {
    const input = '<!doctype html><html><body><script>const example = "<head>";</script><p>Hi</p></body></html>';
    const document = buildArtifactDocument(input);
    expect(document.match(/<html/gi)).toHaveLength(1);
    expect(document).toContain('const example = "<head>";');
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("<body"));
  });
});

describe("artifact selection", () => {
  it("keeps the header in close mode when an older artifact is open", () => {
    expect(artifactHeaderMode("message-new:0", "message-old:0")).toBe("close");
    expect(artifactHeaderMode("message-new:0", null)).toBe("open");
    expect(artifactHeaderMode(undefined, null)).toBe("hidden");
  });

  it("closes the selected artifact and switches directly to a different one", () => {
    expect(toggleArtifactSelection("message-1:0", "message-1:0")).toBeNull();
    expect(toggleArtifactSelection("message-1:0", "message-2:0")).toBe("message-2:0");
  });
});
