// Landing on a message: after a search hit, scroll the row into view and
// flash it. Rows are wrapped in `display: contents` (no box of their own),
// so the wrapper carries data-mid and its last child — the bubble/chip,
// after any day separator — is what gets scrolled and highlighted.
import { useEffect } from "react";
import { useStore } from "@/state/store";

const FLASH_CLASSES = ["ring-2", "ring-accent/70", "rounded-2xl", "transition-shadow"];

export function useFocusMessage(threadId: string, ready: boolean) {
  const { state } = useStore();
  const focus = state.focusMessage;
  useEffect(() => {
    if (!focus || focus.threadId !== threadId || !ready) return;
    // messages may land a tick after the task switch; try briefly
    let tries = 0;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    let target: HTMLElement | null = null;
    const attempt = () => {
      if (cancelled) return;
      const wrapper = document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(focus.messageId)}"]`);
      target = wrapper?.lastElementChild as HTMLElement | null;
      if (!target) {
        if (tries++ < 20) retryTimer = setTimeout(attempt, 100);
        return;
      }
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      target.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
      target.classList.add(...FLASH_CLASSES);
      flashTimer = setTimeout(() => target?.classList.remove(...FLASH_CLASSES), 1800);
    };
    attempt();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (flashTimer) clearTimeout(flashTimer);
      target?.classList.remove(...FLASH_CLASSES);
    };
  }, [focus?.nonce, focus?.threadId, focus?.messageId, threadId, ready]);
}
