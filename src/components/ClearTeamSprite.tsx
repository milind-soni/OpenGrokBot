// A small brand cursor that hangs above Automations. Same face engine as
// the bots. Clicking it turns the arrow into the question — no trash icon.
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";

const ARM_MS = 320;

export function ClearTeamSprite() {
  const { state, dispatch } = useStore();
  const [asking, setAsking] = useState(false);
  const [hovered, setHovered] = useState(false);
  const rootRef = useRef<HTMLButtonElement>(null);
  const armedRef = useRef(false);

  const bots = state.bots;
  useEffect(() => {
    if (bots.length === 0) setAsking(false);
  }, [bots.length]);

  useEffect(() => {
    if (!asking) {
      armedRef.current = false;
      return;
    }
    const arm = window.setTimeout(() => {
      armedRef.current = true;
    }, ARM_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setAsking(false);
    };
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setAsking(false);
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.clearTimeout(arm);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [asking]);

  if (bots.length === 0) return null;

  const face = asking ? "surprised" : hovered ? "curious" : "playful";

  const confirm = () => {
    const ids = bots.map((bot) => bot.id);
    setAsking(false);
    for (const botId of ids) dispatch({ type: "deleteBot", botId });
  };

  return (
    <div className="flex justify-center pb-1 pt-0.5">
      <button
        ref={rootRef}
        type="button"
        aria-label={asking ? "Delete all bots?" : "Clear the team"}
        aria-expanded={asking}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => {
          if (!asking) {
            setAsking(true);
            return;
          }
          if (armedRef.current) confirm();
        }}
        className={cn(
          "relative flex h-11 items-center justify-center overflow-visible rounded-xl",
          asking ? "min-w-[9.5rem] px-2.5" : "w-11",
        )}
      >
        <span
          className={cn(
            "pointer-events-none absolute transition duration-300 ease-out",
            asking ? "scale-50 opacity-0" : "animate-mascot-drift scale-100 opacity-100",
          )}
        >
          <MausAvatar color="green" state={face} size={34} animated />
        </span>
        <span
          className={cn(
            "text-[13px] font-medium tracking-tight text-ink transition duration-300 ease-out",
            asking ? "scale-100 opacity-100" : "pointer-events-none scale-75 opacity-0",
          )}
        >
          delete all bots?
        </span>
      </button>
    </div>
  );
}
