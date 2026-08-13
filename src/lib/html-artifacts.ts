export interface HtmlArtifact {
  id: string;
  messageId: string;
  index: number;
  language: "html" | "htm" | "html_preview";
  html: string;
}

const HTML_LANGUAGES = new Set<HtmlArtifact["language"]>(["html", "htm", "html_preview"]);

export function extractHtmlArtifacts(markdown: string, messageId: string): HtmlArtifact[] {
  const lines = markdown.split(/\r?\n/);
  const artifacts: HtmlArtifact[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const opening = /^\s{0,3}(`{3,}|~{3,})\s*([^\s]*)?.*$/.exec(lines[lineIndex]!);
    if (!opening) continue;
    const fence = opening[1]!;
    const language = (opening[2] ?? "").toLowerCase();
    const character = fence[0]!;
    const closing = new RegExp(`^\\s{0,3}${character === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    const body: string[] = [];
    let closedAt = -1;
    for (let cursor = lineIndex + 1; cursor < lines.length; cursor++) {
      if (closing.test(lines[cursor]!)) {
        closedAt = cursor;
        break;
      }
      body.push(lines[cursor]!);
    }
    if (closedAt === -1) continue;
    lineIndex = closedAt;
    if (!HTML_LANGUAGES.has(language as HtmlArtifact["language"])) continue;
    const index = artifacts.length;
    artifacts.push({
      id: `${messageId}:${index}`,
      messageId,
      index,
      language: language as HtmlArtifact["language"],
      html: body.join("\n"),
    });
  }
  return artifacts;
}

const ARTIFACT_CSP = [
  "default-src 'none'",
  "img-src data: blob: http: https:",
  "media-src data: blob: http: https:",
  "style-src 'unsafe-inline' http: https:",
  "font-src data: http: https:",
  "script-src 'unsafe-inline' http: https:",
  "connect-src http: https:",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join("; ");

const isolationMetadata =
  `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
  '<meta name="referrer" content="no-referrer">';

export function buildArtifactDocument(html: string): string {
  if (/<html(?:\s|>)/i.test(html)) {
    if (/<head(?:\s|>)/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${isolationMetadata}`);
    }
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${isolationMetadata}</head>`);
  }
  return [
    "<!doctype html>",
    "<html>",
    `<head>${isolationMetadata}<style>html{color-scheme:light dark}body{margin:0}</style></head>`,
    `<body>${html}</body>`,
    "</html>",
  ].join("");
}
