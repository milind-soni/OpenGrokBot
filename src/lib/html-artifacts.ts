export interface HtmlArtifact {
  id: string;
  messageId: string;
  index: number;
  language: "html" | "htm" | "html_preview";
  html: string;
  sourceLine: number;
}

const HTML_LANGUAGES = new Set<HtmlArtifact["language"]>(["html", "htm", "html_preview"]);

export interface StreamingHtmlFence {
  language: HtmlArtifact["language"];
  code: string;
  sourceLine: number;
}

export function findStreamingHtmlFence(markdown: string): StreamingHtmlFence | null {
  const lines = markdown.split(/\r?\n/);
  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
    const opening = /^\s{0,3}(`{3,}|~{3,})\s*([^\s]*)?.*$/.exec(lines[lineIndex]!);
    if (!opening) continue;
    const fence = opening[1]!;
    const language = (opening[2] ?? "").toLowerCase();
    if (!HTML_LANGUAGES.has(language as HtmlArtifact["language"])) continue;
    const character = fence[0]!;
    const closing = new RegExp(`^\\s{0,3}${character === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    const body = lines.slice(lineIndex + 1);
    if (body.some((line) => closing.test(line))) return null;
    return {
      language: language as HtmlArtifact["language"],
      code: body.join("\n"),
      sourceLine: lineIndex + 1,
    };
  }
  return null;
}

export function extractHtmlArtifacts(markdown: string, messageId: string): HtmlArtifact[] {
  const lines = markdown.split(/\r?\n/);
  const artifacts: HtmlArtifact[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const opening = /^\s{0,3}(`{3,}|~{3,})\s*([^\s]*)?.*$/.exec(lines[lineIndex]!);
    if (!opening) continue;
    const sourceLine = lineIndex + 1;
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
      sourceLine,
    });
  }
  return artifacts;
}

export type ArtifactHeaderMode = "hidden" | "open" | "close";

export function artifactHeaderMode(
  latestArtifactId: string | undefined,
  selectedArtifactId: string | null | undefined,
): ArtifactHeaderMode {
  if (selectedArtifactId) return "close";
  return latestArtifactId ? "open" : "hidden";
}

export function toggleArtifactSelection(selectedArtifactId: string | null, requestedArtifactId: string): string | null {
  return selectedArtifactId === requestedArtifactId ? null : requestedArtifactId;
}

const ARTIFACT_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "navigate-to 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join("; ");

const isolationMetadata =
  `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
  '<meta name="referrer" content="no-referrer">' +
  "<style>html{color-scheme:light dark}body{margin:0}</style>";

function domParsedDocument(html: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const csp = document.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", ARTIFACT_CSP);
  const referrer = document.createElement("meta");
  referrer.setAttribute("name", "referrer");
  referrer.setAttribute("content", "no-referrer");
  const style = document.createElement("style");
  style.textContent = "html{color-scheme:light dark}body{margin:0}";
  document.head.prepend(csp, referrer, style);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

/** Find an actual opening tag while ignoring comments and raw script/style text.
 * The browser path above uses DOMParser; this deterministic fallback keeps the
 * helper safe and testable in Node, where DOMParser is not available. */
function openingTagEnd(source: string, wanted: string): number | null {
  const lower = source.toLowerCase();
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start === -1) return null;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source[start + 1] === "!" || source[start + 1] === "?") {
      const end = source.indexOf(">", start + 2);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }
    const match = /^<\s*(\/?)\s*([a-z][\w:-]*)/i.exec(source.slice(start));
    if (!match) {
      cursor = start + 1;
      continue;
    }
    let end = start + match[0].length;
    let quote = "";
    for (; end < source.length; end++) {
      const character = source[end]!;
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= source.length) return null;
    const closing = Boolean(match[1]);
    const name = match[2]!.toLowerCase();
    if (!closing && name === wanted) return end + 1;
    if (!closing && RAW_TEXT_TAGS.has(name)) {
      const closeStart = lower.indexOf(`</${name}`, end + 1);
      if (closeStart === -1) return null;
      const closeEnd = source.indexOf(">", closeStart + name.length + 2);
      cursor = closeEnd === -1 ? source.length : closeEnd + 1;
    } else {
      cursor = end + 1;
    }
  }
  return null;
}

export function buildArtifactDocument(html: string): string {
  const parsed = domParsedDocument(html);
  if (parsed) return parsed;

  const headEnd = openingTagEnd(html, "head");
  if (headEnd !== null) return `${html.slice(0, headEnd)}${isolationMetadata}${html.slice(headEnd)}`;

  const htmlEnd = openingTagEnd(html, "html");
  if (htmlEnd !== null) {
    return `${html.slice(0, htmlEnd)}<head>${isolationMetadata}</head>${html.slice(htmlEnd)}`;
  }

  return [
    "<!doctype html>",
    "<html>",
    `<head>${isolationMetadata}</head>`,
    `<body>${html}</body>`,
    "</html>",
  ].join("");
}
