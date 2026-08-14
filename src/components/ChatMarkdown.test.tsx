import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatMarkdown } from "./ChatMarkdown";

describe("ChatMarkdown HTML artifacts", () => {
  it("renders streaming HTML in a compact expandable card", () => {
    const code = Array.from({ length: 12 }, (_, index) => `<div>Line ${index + 1}</div>`).join("\n");
    const html = renderToStaticMarkup(<ChatMarkdown text={`Building\n\`\`\`html\n${code}`} streaming />);

    expect(html).toContain("Building artifact");
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
    expect(html).toContain("min-h-[20rem]");
    expect(html).toContain("max-h-[60vh]");
  });

  it("only marks the unfinished fence as the live artifact", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={"```html\n<main>Finished</main>\n```\nthen\n```html\n<section>Live</section>"}
        streaming
      />,
    );
    expect(html.match(/Building artifact/g)).toHaveLength(1);
    expect(html).toContain("&lt;main&gt;Finished&lt;/main&gt;");
    expect(html).toContain("&lt;section&gt;Live&lt;/section&gt;");
  });

  it("renders completed HTML as a collapsed card with a permanent Open action", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={"```html\n<main>Hidden source</main>\n```"}
        messageId="m-1"
        onPreviewArtifact={() => {}}
      />,
    );

    expect(html).toContain("HTML artifact");
    expect(html).toContain(">Open<");
    expect(html).toContain("View code");
    expect(html).not.toContain("&lt;main&gt;Hidden source&lt;/main&gt;");
  });

  it("labels only the selected artifact as closable", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={"```html\n<p>One</p>\n```\n```html\n<p>Two</p>\n```"}
        messageId="m-2"
        selectedArtifactId="m-2:0"
        onPreviewArtifact={() => {}}
      />,
    );
    expect(html.match(/>Close</g)).toHaveLength(1);
    expect(html.match(/>Open</g)).toHaveLength(1);
    expect(html).not.toContain("Reopen");
  });
});
