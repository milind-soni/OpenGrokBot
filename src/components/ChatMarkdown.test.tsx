import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatMarkdown } from "./ChatMarkdown";

describe("ChatMarkdown HTML creations", () => {
  it("renders streaming HTML in a compact expandable creation card", () => {
    const code = Array.from({ length: 12 }, (_, index) => `<div>Line ${index + 1}</div>`).join("\n");
    const html = renderToStaticMarkup(<ChatMarkdown text={`Building\n\`\`\`html\n${code}`} streaming />);

    expect(html).toContain("Building creation");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("max-h-[9.75rem]");
    expect(html).toContain("Expand");
  });

  it("honors expansion state owned by the chat while streaming text changes", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={"```html\n<main>Still writing"}
        streaming
        streamingHtmlExpanded
        onStreamingHtmlExpandedChange={() => {}}
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Collapse");
    expect(html).not.toContain("max-h-[9.75rem]");
  });

  it("renders completed HTML as a collapsed card with a permanent Open action", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={"```html\n<main>Hidden source</main>\n```"}
        messageId="m-1"
        onPreviewArtifact={() => {}}
      />,
    );

    expect(html).toContain("HTML creation");
    expect(html).toContain(">Open<");
    expect(html).toContain("View code");
    expect(html).not.toContain("&lt;main&gt;Hidden source&lt;/main&gt;");
  });

  it("labels the selected creation as reopenable without hiding its action", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={"```html\n<p>Ready</p>\n```"}
        messageId="m-2"
        selectedArtifactId="m-2:0"
        onPreviewArtifact={() => {}}
      />,
    );
    expect(html).toContain(">Reopen<");
  });
});
