// Real markdown for bot bubbles: react-markdown + GFM (tables, task lists,
// strikethrough, autolinks) with a chromed code block — language label, copy
// button, lazy Shiki highlighting. Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a message is still streaming, code blocks render
// as plain <pre> and nothing is cached — partial fences would poison it.
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, ChevronUp, Code2, Copy, PanelRightClose, PanelRightOpen } from "lucide-react";
import { extractHtmlArtifacts, findStreamingHtmlFence, type HtmlArtifact } from "@/lib/html-artifacts";

// tiny highlight cache so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content-hashed, capped, never written while streaming
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

function CodeBlock({
  code,
  lang,
  messageStreaming,
  streamingArtifact,
  artifact,
  selected,
  onPreview,
  streamingExpanded,
  onStreamingExpandedChange,
}: {
  code: string;
  lang: string;
  messageStreaming: boolean;
  streamingArtifact: boolean;
  artifact?: HtmlArtifact;
  selected?: boolean;
  onPreview?: (artifact: HtmlArtifact) => void;
  streamingExpanded?: boolean;
  onStreamingExpandedChange?: (expanded: boolean) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const controlledStreamingExpansion =
    streamingArtifact && streamingExpanded !== undefined && Boolean(onStreamingExpandedChange);
  const expanded = controlledStreamingExpansion ? streamingExpanded : sourceExpanded;
  const setExpanded = (value: boolean | ((current: boolean) => boolean)) => {
    const next = typeof value === "function" ? value(Boolean(expanded)) : value;
    if (controlledStreamingExpansion) onStreamingExpandedChange?.(next);
    else setSourceExpanded(next);
  };

  useEffect(() => {
    if (messageStreaming) return;
    const key = `${lang}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    import("shiki")
      .then((shiki) =>
        shiki.codeToHtml(code, {
          lang: lang || "text",
          theme: "github-dark-default",
        }),
      )
      .then((out) => {
        if (!alive) return;
        if (highlightCache.size >= CACHE_MAX) {
          const first = highlightCache.keys().next().value;
          if (first) highlightCache.delete(first);
        }
        highlightCache.set(key, out);
        setHtml(out);
      })
      .catch(() => {
        /* unknown language or shiki failed — the plain <pre> stays */
      });
    return () => {
      alive = false;
    };
  }, [code, lang, messageStreaming]);

  const copy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const source = html ? (
    <div
      className="overflow-x-auto text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
  );

  if (streamingArtifact) {
    return (
      <div className="my-2 overflow-hidden rounded-lg border border-accent/20 bg-inset">
        <div className="flex items-center justify-between border-b border-hairline/30 px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-accent">
            <Code2 size={13} /> Building artifact…
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={Boolean(expanded)}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {expanded ? "Collapse" : "Expand"}
            </button>
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
              title="Copy code"
            >
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            </button>
          </div>
        </div>
        <div className={expanded ? "min-h-[20rem] max-h-[60vh] overflow-auto" : "max-h-[9.75rem] overflow-auto"}>
          <pre className="p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
        </div>
      </div>
    );
  }

  if (artifact) {
    return (
      <div className="my-2 overflow-hidden rounded-xl border border-accent/20 bg-inset">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Code2 size={17} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-ink">HTML artifact</span>
            <span className="block truncate text-[11px] text-ink-secondary">artifact-{artifact.index + 1}.html</span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {onPreview && (
              <button
                type="button"
                onClick={() => onPreview(artifact)}
                className="flex items-center gap-1 rounded-md bg-accent px-2 py-1.5 text-[11px] font-medium text-white hover:opacity-90"
                title={selected ? "Close HTML preview" : "Open HTML preview"}
              >
                {selected ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
                <span>{selected ? "Close" : "Open"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={Boolean(expanded)}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              {expanded ? "Hide code" : "View code"}
            </button>
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              title="Copy HTML"
            >
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            </button>
          </div>
        </div>
        {expanded && <div className="border-t border-hairline/30">{source}</div>}
      </div>
    );
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between border-b border-hairline/30 px-3 py-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-secondary">{lang || "code"}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Copy code"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </button>
      </div>
      {source}
    </div>
  );
}

interface ChatMarkdownProps {
  text: string;
  streaming?: boolean;
  messageId?: string;
  selectedArtifactId?: string | null;
  onPreviewArtifact?: (artifact: HtmlArtifact) => void;
  streamingHtmlExpanded?: boolean;
  onStreamingHtmlExpandedChange?: (expanded: boolean) => void;
}

function ChatMarkdownComponent({
  text,
  streaming = false,
  messageId,
  selectedArtifactId,
  onPreviewArtifact,
  streamingHtmlExpanded,
  onStreamingHtmlExpandedChange,
}: ChatMarkdownProps) {
  const artifacts = useMemo(
    () => (!streaming && messageId ? extractHtmlArtifacts(text, messageId) : []),
    [messageId, streaming, text],
  );
  const streamingHtml = useMemo(() => (streaming ? findStreamingHtmlFence(text) : null), [streaming, text]);
  return (
    <div className="chat-md min-w-0 [&>*+*]:mt-2">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children, node }: { children?: ReactNode; node?: { position?: { start: { line: number } } } }) {
            // fenced code arrives as <pre><code class="language-x">…</code></pre>
            const child: any = Array.isArray(children) ? children[0] : children;
            const className: string = child?.props?.className ?? "";
            const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
            // children can be a string OR an array of strings/nodes — flatten
            // strings only, so String() never comma-joins an array
            const flat = (n: any): string =>
              typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
            const code = flat(child?.props?.children).replace(/\n$/, "");
            const sourceLine = node?.position?.start.line;
            const htmlLanguage = /^(?:html|htm|html_preview)$/i.test(lang);
            const artifact = htmlLanguage
              ? artifacts.find((candidate) => candidate.sourceLine === sourceLine)
              : undefined;
            const streamingArtifact = Boolean(streamingHtml && htmlLanguage && streamingHtml.sourceLine === sourceLine);
            return (
              <CodeBlock
                code={streamingArtifact ? streamingHtml!.code : code}
                lang={lang}
                messageStreaming={streaming}
                streamingArtifact={streamingArtifact}
                artifact={artifact}
                selected={artifact?.id === selectedArtifactId}
                onPreview={onPreviewArtifact}
                streamingExpanded={streamingHtmlExpanded}
                onStreamingExpandedChange={onStreamingHtmlExpandedChange}
              />
            );
          },
          img({ src, alt }: { src?: string; alt?: string }) {
            return (
              <img
                src={src}
                alt={alt ?? ""}
                loading="lazy"
                className="max-h-96 max-w-full rounded-lg border border-hairline/30"
              />
            );
          },
          code({ children }: { children?: ReactNode }) {
            return (
              <code className="rounded bg-inset px-1 py-px text-[13px]">{children}</code>
            );
          },
          a({ href, children }: { href?: string; children?: ReactNode }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="break-words text-accent underline decoration-accent/40 hover:decoration-accent"
              >
                {children}
              </a>
            );
          },
          table({ children }: { children?: ReactNode }) {
            return (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13.5px]">{children}</table>
              </div>
            );
          },
          th({ children }: { children?: ReactNode }) {
            return (
              <th className="border-b border-hairline/40 px-2 py-1.5 text-left font-semibold">{children}</th>
            );
          },
          td({ children }: { children?: ReactNode }) {
            return <td className="border-b border-hairline/20 px-2 py-1.5 align-top">{children}</td>;
          },
          ul({ children }: { children?: ReactNode }) {
            return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
          },
          ol({ children }: { children?: ReactNode }) {
            return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
          },
          h1({ children }: { children?: ReactNode }) {
            return <div className="mt-2 text-[16px] font-semibold">{children}</div>;
          },
          h2({ children }: { children?: ReactNode }) {
            return <div className="mt-2 text-[15.5px] font-semibold">{children}</div>;
          },
          h3({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 font-semibold">{children}</div>;
          },
          h4({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 font-semibold">{children}</div>;
          },
          h5({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 text-[14px] font-semibold">{children}</div>;
          },
          h6({ children }: { children?: ReactNode }) {
            return <div className="mt-1.5 text-[13.5px] font-semibold text-ink-secondary">{children}</div>;
          },
          blockquote({ children }: { children?: ReactNode }) {
            return (
              <blockquote className="border-l-2 border-hairline pl-3 text-ink-secondary">{children}</blockquote>
            );
          },
          hr() {
            return <hr className="border-hairline/40" />;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownComponent);
