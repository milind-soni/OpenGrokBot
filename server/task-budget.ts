/** Central, provider-neutral budgets for one running task. Values are counted
 * only from canonical runtime events; missing provider telemetry stays absent
 * rather than becoming a guessed usage number. */
export interface TaskBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxToolCalls?: number;
  maxComputerActions?: number;
  maxRetries?: number;
  maxDelegations?: number;
  maxDurationMs?: number;
}

export interface TaskBudgetUsage {
  inputTokens?: number;
  outputTokens?: number;
  toolCalls: number;
  computerActions: number;
  retries: number;
  delegations: number;
}

export type BudgetLimit = "input_tokens" | "output_tokens" | "total_tokens" | "tool_calls" | "computer_actions" | "retries" | "delegations" | "duration";
export type BudgetStatus = { kind: "approaching" | "exhausted"; limit: BudgetLimit; usage: TaskBudgetUsage; budget: TaskBudget };

const LIMITS: Array<[keyof TaskBudget, BudgetLimit, number, number]> = [
  ["maxInputTokens", "input_tokens", 1, 10_000_000], ["maxOutputTokens", "output_tokens", 1, 10_000_000],
  ["maxTotalTokens", "total_tokens", 1, 10_000_000], ["maxToolCalls", "tool_calls", 1, 10_000],
  ["maxComputerActions", "computer_actions", 1, 10_000], ["maxRetries", "retries", 1, 10_000],
  ["maxDelegations", "delegations", 1, 100], ["maxDurationMs", "duration", 1_000, 24 * 60 * 60_000],
];

export function normalizeTaskBudget(raw: unknown): TaskBudget | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const result: TaskBudget = {};
  for (const [key, , min, max] of LIMITS) {
    if (value[key] === undefined) continue;
    const number = Math.round(Number(value[key]));
    if (!Number.isFinite(number) || number < min || number > max) return null;
    result[key] = number;
  }
  return Object.keys(result).length ? result : null;
}

export function isComputerAction(title: string | undefined) {
  return Boolean(title && /computer.*(click|type|press|scroll|exec|open_url)|mcp__computer__(click|type|press|scroll|exec|open_url)/i.test(title));
}

export function isDelegation(title: string | undefined) {
  return Boolean(title && /ask_bot/i.test(title));
}

export class TaskBudgetGuard {
  private readonly budget: TaskBudget;
  private readonly onStatus: (status: BudgetStatus) => void;
  private readonly usageValue: TaskBudgetUsage = { toolCalls: 0, computerActions: 0, retries: 0, delegations: 0 };
  private readonly warned = new Set<BudgetLimit>();
  private exhausted: BudgetLimit | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(budget: TaskBudget, onStatus: (status: BudgetStatus) => void) {
    this.budget = budget;
    this.onStatus = onStatus;
  }

  start() {
    if (this.budget.maxDurationMs) this.timer = setTimeout(() => this.exceed("duration"), this.budget.maxDurationMs);
    this.timer?.unref?.();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  noteTokenUsage(input: number | undefined, output: number | undefined) {
    // Providers may omit either dimension. Usage events are snapshots, so a
    // later smaller value must not lower observed consumption or fabricate it.
    if (Number.isFinite(input)) this.usageValue.inputTokens = Math.max(this.usageValue.inputTokens ?? 0, Math.max(0, input!));
    if (Number.isFinite(output)) this.usageValue.outputTokens = Math.max(this.usageValue.outputTokens ?? 0, Math.max(0, output!));
    this.check();
  }

  noteToolStarted(title?: string) {
    this.usageValue.toolCalls += 1;
    if (isComputerAction(title)) this.usageValue.computerActions += 1;
    if (isDelegation(title)) this.usageValue.delegations += 1;
    this.check();
  }

  noteFailedTool() {
    this.usageValue.retries += 1;
    this.check();
  }

  get usage(): TaskBudgetUsage { return { ...this.usageValue }; }

  private check() {
    const values: Array<[BudgetLimit, number | undefined, number | undefined]> = [
      ["input_tokens", this.usageValue.inputTokens, this.budget.maxInputTokens],
      ["output_tokens", this.usageValue.outputTokens, this.budget.maxOutputTokens],
      ["total_tokens", this.usageValue.inputTokens === undefined && this.usageValue.outputTokens === undefined ? undefined : (this.usageValue.inputTokens ?? 0) + (this.usageValue.outputTokens ?? 0), this.budget.maxTotalTokens],
      ["tool_calls", this.usageValue.toolCalls, this.budget.maxToolCalls],
      ["computer_actions", this.usageValue.computerActions, this.budget.maxComputerActions],
      ["retries", this.usageValue.retries, this.budget.maxRetries],
      ["delegations", this.usageValue.delegations, this.budget.maxDelegations],
    ];
    for (const [limit, usage, max] of values) {
      if (usage === undefined || max === undefined) continue;
      if (usage >= max) return this.exceed(limit);
      if (usage >= Math.max(1, Math.floor(max * 0.8)) && !this.warned.has(limit)) {
        this.warned.add(limit);
        this.onStatus({ kind: "approaching", limit, usage: this.usage, budget: this.budget });
      }
    }
  }

  private exceed(limit: BudgetLimit) {
    if (this.exhausted) return;
    this.exhausted = limit;
    this.dispose();
    this.onStatus({ kind: "exhausted", limit, usage: this.usage, budget: this.budget });
  }
}
