import type { Message } from "@/state/store";

export interface TimelineEvent {
  id: string;
  at: number;
  label: string;
  state: "complete" | "failed" | "observed";
  kind: "task" | "tool" | "screen" | "result";
}

/** Turn an already-persisted transcript into a compact, honest timeline. It
 * deliberately derives only from events the harness has recorded — this UI
 * never guesses that an action or result happened. */
export function timelineEvents(messages: Message[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const message of messages) {
    if (message.kind === "text" && message.role === "user" && message.text?.trim()) {
      events.push({ id: message.id, at: message.at, label: "Task started", state: "observed", kind: "task" });
    } else if (message.kind === "activity" && message.tool) {
      const failed = message.tool.ok === false || message.tool.name.startsWith("error:");
      events.push({
        id: message.id,
        at: message.at,
        label: failed ? message.tool.name.replace(/^error:\s*/i, "") : message.tool.name,
        state: failed ? "failed" : "complete",
        kind: "tool",
      });
    } else if (message.kind === "screen") {
      events.push({ id: message.id, at: message.at, label: "Screen observed", state: "observed", kind: "screen" });
    } else if (message.kind === "text" && message.role === "bot" && message.text?.trim()) {
      events.push({ id: message.id, at: message.at, label: "Response recorded", state: "complete", kind: "result" });
    }
  }
  return events;
}
