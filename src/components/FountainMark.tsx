// Fountain (BinaryBourbon/fountain) — the project ships a raster app icon and
// no vector mark, so this is a plain glyph: a basin with three jets of water.
import { cn } from "@/lib/cn";

interface IconProps {
  size?: number;
  className?: string;
}

export function FountainMark({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("text-[#38BDF8]", className)}
      aria-hidden
    >
      {/* jets */}
      <path d="M12 12V4" />
      <path d="M8 12c0-3 1.5-5.5 4-7" />
      <path d="M16 12c0-3-1.5-5.5-4-7" />
      <circle cx="12" cy="3.5" r="0.75" fill="currentColor" stroke="none" />
      {/* basin */}
      <path d="M4 14h16l-1.5 4.5a2 2 0 0 1-1.9 1.5H7.4a2 2 0 0 1-1.9-1.5L4 14z" />
    </svg>
  );
}
