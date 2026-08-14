import { describe, expect, it, vi } from "vitest";
import { isComputerAction, isDelegation, normalizeTaskBudget, TaskBudgetGuard } from "./task-budget.ts";

describe("task budgets", () => {
  it("validates bounded explicit budgets and leaves unconfigured tasks alone", () => {
    expect(normalizeTaskBudget({ maxTotalTokens: 30_000, maxToolCalls: 4 })).toEqual({ maxTotalTokens: 30_000, maxToolCalls: 4 });
    expect(normalizeTaskBudget({ maxDurationMs: 999 })).toBeNull();
    expect(normalizeTaskBudget({ maxToolCalls: 0 })).toBeNull();
    expect(normalizeTaskBudget({})).toBeNull();
  });

  it("uses task-local token deltas from cumulative snapshots without inventing absent dimensions", () => {
    const statuses: string[] = [];
    const guard = new TaskBudgetGuard({ maxInputTokens: 10, maxTotalTokens: 15 }, (s) => statuses.push(s.limit), { input: 100, output: 40 });
    guard.noteTokenUsage(108, undefined);
    expect(guard.usage).toEqual({ inputTokens: 8, toolCalls: 0, computerActions: 0, retries: 0, delegations: 0 });
    guard.noteTokenUsage(107, 47); // snapshots cannot reduce task-local input usage
    expect(statuses).toEqual(["input_tokens", "total_tokens"]);
  });

  it("enforces tool and computer-action boundaries once", () => {
    const statuses: string[] = [];
    const guard = new TaskBudgetGuard({ maxToolCalls: 3, maxComputerActions: 2 }, (s) => statuses.push(s.limit));
    guard.noteToolStarted("mcp__computer__screenshot");
    guard.noteToolStarted("mcp__computer__click");
    guard.noteToolStarted("mcp__computer__type_text");
    guard.noteToolStarted("another_tool");
    expect(statuses.filter((x) => x === "computer_actions")).toHaveLength(1);
    expect(guard.usage).toMatchObject({ toolCalls: 4, computerActions: 2 });
  });

  it("counts a retry only when a failed tool is repeated and delegates separately", () => {
    const statuses: string[] = [];
    const guard = new TaskBudgetGuard({ maxRetries: 2, maxDelegations: 1 }, (s) => statuses.push(s.limit));
    guard.noteToolStarted("mcp__computer__click");
    guard.noteToolCompleted("mcp__computer__click", false);
    expect(guard.usage.retries).toBe(0);
    guard.noteToolStarted("mcp__computer__click");
    guard.noteToolCompleted("mcp__computer__click", false);
    guard.noteToolStarted("mcp__computer__click");
    guard.noteToolStarted("mcp__agents__ask_bot");
    expect(statuses).toContain("retries");
    expect(statuses).not.toContain("delegations"); // a task already stopped cannot emit another exhaustion
    expect(isDelegation("mcp__agents__ask_bot")).toBe(true);
    expect(isComputerAction("mcp__computer__click")).toBe(true);
    expect(isComputerAction("mcp__computer__screenshot")).toBe(false);
  });

  it("warns before, then exhausts on a token boundary", () => {
    const statuses: Array<{ kind: string; limit: string }> = [];
    const guard = new TaskBudgetGuard({ maxOutputTokens: 10 }, (s) => statuses.push({ kind: s.kind, limit: s.limit }));
    guard.noteTokenUsage(undefined, 8);
    guard.noteTokenUsage(undefined, 10);
    expect(statuses).toEqual([{ kind: "approaching", limit: "output_tokens" }, { kind: "exhausted", limit: "output_tokens" }]);
  });

  it("cancels the deadline timer when disposed", () => {
    vi.useFakeTimers();
    const exceeded = vi.fn();
    const guard = new TaskBudgetGuard({ maxDurationMs: 5_000 }, exceeded);
    guard.start();
    guard.dispose();
    vi.advanceTimersByTime(5_000);
    expect(exceeded).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("exhausts a provisioning-time deadline exactly once before dispatch", () => {
    vi.useFakeTimers();
    const statuses: Array<{ kind: string; limit: string }> = [];
    const guard = new TaskBudgetGuard({ maxDurationMs: 1_000 }, (status) => statuses.push({ kind: status.kind, limit: status.limit }));
    guard.start();
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    expect(guard.isExhausted).toBe(true);
    expect(statuses).toEqual([{ kind: "exhausted", limit: "duration" }]);
    vi.useRealTimers();
  });
});
