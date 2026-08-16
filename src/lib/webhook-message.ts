export interface WebhookMessageView {
  task: string;
  eventName?: string;
  payload?: string;
  details: string[];
}

/** Convert the model-safe webhook prompt into the smaller view shown in chat.
 * The stored message stays untouched, preserving the trust boundary for model
 * context and follow-up turns. */
export function webhookMessageView(text: string): WebhookMessageView | null {
  const markers = [
    "AUTHENTICATED WEBHOOK TASK",
    "USER-CONFIGURED WEBHOOK INSTRUCTIONS",
    "DEFAULT WEBHOOK INSTRUCTIONS",
  ];
  let task = "";
  for (const marker of markers) {
    const match = text.match(new RegExp(`\\[${marker}\\]\\n([\\s\\S]*?)\\n\\[\\/${marker}\\]`));
    if (match?.[1]) {
      task = match[1].trim();
      break;
    }
  }

  const eventData = text.match(/\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/)?.[1];
  if (!task || !eventData) return null;

  const splitAt = eventData.indexOf("\n\n");
  const metadata = splitAt >= 0 ? eventData.slice(0, splitAt) : eventData;
  const payload = (splitAt >= 0 ? eventData.slice(splitAt + 2) : "").trim();
  const eventName = metadata.match(/^Event:\s*(.+)$/m)?.[1]?.trim();
  const details: string[] = [];

  if (payload) {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      for (const key of ["service", "environment", "repository", "branch"]) {
        const value = parsed?.[key];
        if (typeof value === "string" && value.trim() && value.trim() !== task && !details.includes(value.trim())) details.push(value.trim());
        if (details.length === 2) break;
      }
    } catch {
      // Plain text and truncated payloads are still available behind View payload.
    }
  }

  return { task, eventName, payload: payload || undefined, details };
}
