import type { MediaOutput, Message } from "@/state/store";
import { extractHtmlArtifacts, type HtmlArtifact } from "./html-artifacts";

export interface GenerationSource {
  ownerId: string;
  ownerName: string;
  contextTitle: string;
  threadId: string;
  messages: Message[];
}

interface GenerationBase {
  id: string;
  kind: "html" | "image" | "video";
  createdAt: number;
  ownerId: string;
  ownerName: string;
  contextTitle: string;
  threadId: string;
  messageId: string;
}

export interface HtmlGeneration extends GenerationBase {
  kind: "html";
  artifact: HtmlArtifact;
}

export interface MediaGeneration extends GenerationBase {
  kind: "image" | "video";
  output: MediaOutput;
}

export type GenerationItem = HtmlGeneration | MediaGeneration;

export function collectGenerations(sources: GenerationSource[]): GenerationItem[] {
  const items: GenerationItem[] = [];
  for (const source of sources) {
    for (const message of source.messages) {
      const base = {
        createdAt: message.at,
        ownerId: source.ownerId,
        ownerName: message.from?.name ?? source.ownerName,
        contextTitle: source.contextTitle,
        threadId: source.threadId,
        messageId: message.id,
      };
      if (message.role === "bot" && message.kind === "text" && message.text) {
        for (const artifact of extractHtmlArtifacts(message.text, message.id)) {
          items.push({ ...base, id: `html:${artifact.id}`, kind: "html", artifact });
        }
      }
      if (message.role === "bot" && message.kind === "media") {
        for (const output of message.media ?? []) {
          if (output.status !== "ready" || !output.cacheKey) continue;
          items.push({ ...base, id: `media:${output.id}`, kind: output.kind, output });
        }
      }
    }
  }
  return items.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}
