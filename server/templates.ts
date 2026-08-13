import type { TaskTemplateConfig } from "./config.ts";

export function normalizeTemplate(raw: unknown, existingId?: string): TaskTemplateConfig {
  if (!raw || typeof raw !== "object") throw new Error("Template is required");
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 100) : "";
  const instructions = typeof value.instructions === "string" ? value.instructions.trim().slice(0, 20_000) : "";
  if (!name || !instructions) throw new Error("A template needs a name and instructions");
  return {
    id: existingId ?? (typeof value.id === "string" && value.id ? value.id.slice(0, 100) : crypto.randomUUID()),
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
