import type { ModelTask } from "@/state/store";

export function modelSupportsTask(task: ModelTask | undefined, requested: ModelTask): boolean {
  return requested === "chat" ? task === undefined || task === "chat" : task === requested;
}

export function parseModelTaskOverrides(text: string): {
  tasks: Record<string, ModelTask>;
  error: string | null;
} {
  const tasks: Record<string, ModelTask> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    const match = /^([^=]+)=(chat|image|video)$/.exec(line.replace(/\s*=\s*/, "="));
    if (!match || !match[1]!.trim()) {
      return {
        tasks: {},
        error: `Line ${index + 1} must use model=chat, model=image, or model=video.`,
      };
    }
    tasks[match[1]!.trim()] = match[2] as ModelTask;
  }
  return { tasks, error: null };
}

export function formatModelTaskOverrides(tasks: Record<string, ModelTask>): string {
  return Object.entries(tasks)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, task]) => `${model}=${task}`)
    .join("\n");
}
