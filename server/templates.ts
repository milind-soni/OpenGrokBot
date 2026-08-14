import type { TaskTemplateConfig } from "./config.ts";

export function normalizeTemplate(raw: unknown, existingId?: string): TaskTemplateConfig {
  if (!raw || typeof raw !== "object") throw new Error("Template is required");
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 100) : "";
  const instructions = typeof value.instructions === "string" ? value.instructions.trim().slice(0, 20_000) : "";
  if (!name || !instructions) throw new Error("A template needs a name and instructions");
  return {
    // IDs are harness-owned: callers must not be able to create a template
    // whose route cannot address it, or collide with an existing template.
    id: existingId ?? crypto.randomUUID(),
    name,
    instructions,
    description: typeof value.description === "string" ? value.description.trim().slice(0, 500) : "",
    title: typeof value.title === "string" ? value.title.trim().slice(0, 120) : "",
    computer: ["cloud", "local", "off"].includes(String(value.computer))
      ? (value.computer as TaskTemplateConfig["computer"])
      : undefined,
  };
}

/** Catalog data is safe to put in the renderer; workflow text stays local. */
export function templateSnapshot(item: TaskTemplateConfig) {
  const { instructions: _instructions, ...safe } = item;
  return safe;
}
