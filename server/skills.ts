import type { SkillConfig } from "./config.ts";

export interface SkillSnapshot { id: string; name: string; description: string; version: string; source: "built-in" | "imported" | "custom" | "taught"; enabled: boolean; }

export function normalizeSkill(raw: unknown, existingId?: string): SkillConfig {
  if (!raw || typeof raw !== "object") throw new Error("Skill configuration is required");
  const input = raw as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
  const instructions = typeof input.instructions === "string" ? input.instructions.trim().slice(0, 20_000) : "";
  if (!name || !instructions) throw new Error("A skill needs a name and instructions");
  const source = ["built-in", "imported", "custom", "taught"].includes(String(input.source)) ? input.source as SkillConfig["source"] : "custom";
  return { id: typeof input.id === "string" && input.id ? input.id.slice(0, 100) : existingId ?? crypto.randomUUID(), name, instructions, description: typeof input.description === "string" ? input.description.trim().slice(0, 500) : "", version: typeof input.version === "string" ? input.version.trim().slice(0, 40) : "1", source, enabled: input.enabled !== false };
}

export function skillSnapshot(skill: SkillConfig): SkillSnapshot { return { id: skill.id, name: skill.name, description: skill.description ?? "", version: skill.version ?? "1", source: skill.source ?? "custom", enabled: skill.enabled !== false }; }

/** Inject only enabled skills explicitly assigned to the current bot. */
export function skillPrompt(items: SkillConfig[] | undefined, ids: string[] | undefined): string {
  if (!ids?.length) return "";
  const available = new Map((items ?? []).filter((skill) => skill.enabled !== false).map((skill) => [skill.id, skill]));
  const selected = ids.flatMap((id) => { const skill = available.get(id); return skill ? [`[Skill: ${skill.name}]\n${skill.instructions}`] : []; });
  return selected.length ? `\n\nFollow these assigned reusable skills when relevant:\n\n${selected.join("\n\n")}` : "";
}
