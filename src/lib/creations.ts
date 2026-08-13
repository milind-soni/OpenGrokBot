import { extractHtmlArtifacts } from "@/lib/html-artifacts";
import { visibleMessages, type Bot, type MediaOutput } from "@/state/store";

export type CreationKind = "html" | "image" | "video";

export interface CreationEntry {
  id: string;
  kind: CreationKind;
  botId: string;
  botName: string;
  threadId: string;
  messageId: string;
  createdAt: number;
  title: string;
  html?: string;
  media?: MediaOutput;
}

export function deriveCreations(bots: Bot[]): CreationEntry[] {
  return bots
    .flatMap((bot) =>
      visibleMessages(bot).flatMap((message): CreationEntry[] => {
        if (message.role === "bot" && message.kind === "text" && message.text) {
          return extractHtmlArtifacts(message.text, message.id).map((artifact) => ({
            id: artifact.id,
            kind: "html",
            botId: bot.id,
            botName: bot.name,
            threadId: bot.threadId,
            messageId: message.id,
            createdAt: message.at,
            title: `artifact-${artifact.index + 1}.html`,
            html: artifact.html,
          }));
        }

        if (message.role === "bot" && message.kind === "media") {
          return (message.media ?? [])
            .filter((media) => media.status === "ready" && Boolean(media.cacheKey))
            .map((media, index): CreationEntry => ({
              id: `${message.id}:${media.id}`,
              kind: media.kind,
              botId: bot.id,
              botName: bot.name,
              threadId: bot.threadId,
              messageId: message.id,
              createdAt: message.at,
              title: `Generated ${media.kind} ${index + 1}`,
              media,
            }))
            .reverse();
        }

        return [];
      }),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}
