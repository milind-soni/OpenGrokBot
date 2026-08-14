import type { MediaKind } from "./contracts.ts";

const CREATION_VERB = /\b(?:create|generate|make|draw|render|produce|design|animate)\b/i;
const IMAGE_NOUN = /\b(?:image|picture|photo|photograph|illustration|artwork|logo|poster)\b/i;
const VIDEO_NOUN = /\b(?:video|clip|animation|movie|film)\b/i;
const CODE_DISCUSSION = /\b(?:code|script|function|library|api|explain|how does|how do)\b/i;

export function detectMediaIntent(text: string): MediaKind | null {
  if (!CREATION_VERB.test(text) || CODE_DISCUSSION.test(text)) return null;
  if (VIDEO_NOUN.test(text)) return "video";
  if (IMAGE_NOUN.test(text)) return "image";
  return null;
}

export function mediaPromptOptions(prompt: string): {
  aspectRatio?: string;
  durationSeconds?: number;
} {
  const aspectRatio = /\b(1:1|16:9|9:16|4:3|3:4|21:9|9:21)\b/.exec(prompt)?.[1];
  const durationRaw = /\b(\d{1,2})\s*(?:seconds?|secs?|s)\b/i.exec(prompt)?.[1];
  const duration = durationRaw ? Number(durationRaw) : undefined;
  return {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(duration && duration >= 1 && duration <= 30 ? { durationSeconds: duration } : {}),
  };
}
