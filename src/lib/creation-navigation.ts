import type { CreationKind, CreationEntry } from "./creations";

export interface OpenCreationRequest {
  requestId: string;
  botId: string;
  messageId: string;
  creationId: string;
  kind: CreationKind;
}

export function artifactHeaderMode(
  newestArtifactId: string | undefined,
  selectedArtifactId: string | null,
): "hidden" | "open" | "close" {
  if (!newestArtifactId) return "hidden";
  return newestArtifactId === selectedArtifactId ? "close" : "open";
}

export function creationOpenRequest(
  entry: CreationEntry,
  requestId: string = crypto.randomUUID(),
): OpenCreationRequest {
  return {
    requestId,
    botId: entry.botId,
    messageId: entry.messageId,
    creationId: entry.id,
    kind: entry.kind,
  };
}
