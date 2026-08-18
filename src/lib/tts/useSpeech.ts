import { useSyncExternalStore } from "react";

import { speaker, type SpeechSnapshot } from "./index";

/** Live speaker state. useSyncExternalStore rather than a context: the
 * speaker is a window-wide singleton with no provider to hang off, and only
 * the components that actually render voice UI should re-render when an
 * utterance changes. */
export function useSpeech(): SpeechSnapshot {
  return useSyncExternalStore(
    (fn) => speaker.subscribe(fn),
    () => speaker.state,
    () => speaker.state,
  );
}
