import type { CreationKind, CreationEntry } from "./creations";

export interface OpenCreationRequest {
  requestId: string;
  botId: string;
  messageId: string;
  creationId: string;
  kind: CreationKind;
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
