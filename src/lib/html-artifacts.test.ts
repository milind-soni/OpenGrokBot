import { describe, expect, it } from "vitest";

import { buildArtifactDocument, extractHtmlArtifacts, findStreamingHtmlFence } from "./html-artifacts";

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

  it("finds only an unfinished HTML fence at the end of a stream", () => {
    expect(findStreamingHtmlFence("Intro\n```html\n<section>work")).toEqual({
      language: "html",
      code: "<section>work",
    });
    expect(findStreamingHtmlFence("~~~HTM\n<p>still writing")).toEqual({
      language: "htm",
      code: "<p>still writing",
    });
    expect(findStreamingHtmlFence("```js\nwork")).toBeNull();
    expect(findStreamingHtmlFence("```html\nready\n```" )).toBeNull();
  });
});

describe("artifact document isolation", () => {
  it("wraps fragments with a restrictive CSP and no-referrer policy", () => {
    const document = buildArtifactDocument("<script>document.body.textContent='ready'</script>");
    expect(document).toContain("Content-Security-Policy");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("object-src 'none'");
    expect(document).toContain('<meta name="referrer" content="no-referrer">');
    expect(document).toContain("<script>document.body.textContent='ready'</script>");
    expect(document).not.toContain("allow-same-origin");
  });

  it("injects isolation metadata into a complete document without nesting HTML", () => {
    const document = buildArtifactDocument("<!doctype html><html><head><title>Demo</title></head><body>Hi</body></html>");
    expect(document.match(/<html/gi)).toHaveLength(1);
    expect(document).toContain("<title>Demo</title>");
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("</head>"));
  });
});
