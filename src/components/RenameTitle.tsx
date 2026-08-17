// Double-click a title to rename it in place. Settings still exists for
// the rest of the profile — this is just the fast path for the name.
import { useEffect, useState } from "react";

import { nextRename } from "@/lib/rename";
import { cn } from "@/lib/cn";

export function RenameTitle({
  value,
  onCommit,
  onEditingChange,
  className,
  inputClassName,
}: {
  value: string;
  onCommit: (next: string) => void;
  onEditingChange?: (editing: boolean) => void;
  className?: string;
  inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const setMode = (next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  };

  const finish = (save: boolean) => {
    const next = save ? nextRename(value, draft) : null;
    setMode(false);
    if (next) onCommit(next);
    else setDraft(value);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        aria-label="Rename"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        className={cn("min-w-0 bg-transparent text-ink focus:outline-none", inputClassName)}
      />
    );
  }

  return (
    <span
      className={cn("cursor-text", className)}
      title="Double-click to rename"
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDraft(value);
        setMode(true);
      }}
    >
      {value}
    </span>
  );
}
