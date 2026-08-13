export type SpecialistTask = "image" | "video";
export type SpecialistTerminalStatus = "failed" | "cancelled";

export interface SpecialistTerminalOutcome {
  status: SpecialistTerminalStatus;
  error: string;
  messageId?: string;
}

export interface SpecialistRunInput {
  runtimeThreadId: string;
  visibleThreadId: string;
  botId: string;
  primaryTurnId: string;
  task: SpecialistTask;
  interrupt: () => Promise<void>;
  onTerminal?: (outcome: SpecialistTerminalOutcome) => void;
}

export interface SpecialistRun extends SpecialistRunInput {
  result: Promise<{ messageId: string; task: SpecialistTask }>;
  mediaMessageId?: string;
  mediaPipeline?: Promise<void>;
  resolve: (value: { messageId: string; task: SpecialistTask }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const activeKey = (botId: string, task: SpecialistTask) => `${botId}:${task}`;

export class SpecialistRunManager {
  private readonly byThread = new Map<string, SpecialistRun>();
  private readonly activeTasks = new Map<string, string>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 4 * 60_000) {
    this.timeoutMs = timeoutMs;
  }

  start(input: SpecialistRunInput): SpecialistRun {
    const key = activeKey(input.botId, input.task);
    if (this.activeTasks.has(key)) {
      throw new Error(`this bot is already generating an ${input.task}`);
    }
    let resolve!: SpecialistRun["resolve"];
    let reject!: SpecialistRun["reject"];
    const result = new Promise<{ messageId: string; task: SpecialistTask }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => {
      void input.interrupt().catch(() => {});
      this.fail(input.runtimeThreadId, new Error(`${input.task} generation timed out`));
    }, this.timeoutMs);
    timer.unref?.();
    const run: SpecialistRun = { ...input, result, resolve, reject, timer };
    this.byThread.set(input.runtimeThreadId, run);
    this.activeTasks.set(key, input.runtimeThreadId);
    return run;
  }

  forThread(runtimeThreadId: string): SpecialistRun | undefined {
    return this.byThread.get(runtimeThreadId);
  }

  setMediaPipeline(runtimeThreadId: string, messageId: string, pipeline: Promise<void>) {
    const run = this.byThread.get(runtimeThreadId);
    if (!run) return;
    run.mediaMessageId = messageId;
    run.mediaPipeline = pipeline;
    void pipeline.catch((error) => this.fail(runtimeThreadId, error instanceof Error ? error : new Error(String(error))));
  }

  turnCompleted(runtimeThreadId: string, ok: boolean) {
    const run = this.byThread.get(runtimeThreadId);
    if (!run) return;
    if (!ok) return this.fail(runtimeThreadId, new Error(`${run.task} specialist failed`));
    if (!run.mediaMessageId || !run.mediaPipeline) {
      return this.fail(runtimeThreadId, new Error(`${run.task} specialist finished without generated media`));
    }
    void run.mediaPipeline
      .then(() => {
        const current = this.byThread.get(runtimeThreadId);
        if (!current?.mediaMessageId) return;
        this.remove(current);
        current.resolve({ messageId: current.mediaMessageId, task: current.task });
      })
      .catch(() => {});
  }

  fail(runtimeThreadId: string, error: Error, status: SpecialistTerminalStatus = "failed") {
    const run = this.byThread.get(runtimeThreadId);
    if (!run) return;
    try {
      run.onTerminal?.({ status, error: error.message, messageId: run.mediaMessageId });
    } catch {
      // Lifecycle cleanup must still complete if transcript persistence fails.
    }
    this.remove(run);
    run.reject(error);
  }

  async cancelPrimary(botId: string, primaryTurnId: string): Promise<void> {
    const matches = [...this.byThread.values()].filter(
      (run) => run.botId === botId && run.primaryTurnId === primaryTurnId,
    );
    for (const run of matches) {
      this.fail(run.runtimeThreadId, new Error(`${run.task} generation cancelled`), "cancelled");
    }
    await Promise.all(matches.map((run) => run.interrupt().catch(() => {})));
  }

  async cancelMessage(botId: string, messageId: string): Promise<boolean> {
    const run = [...this.byThread.values()].find(
      (candidate) => candidate.botId === botId && candidate.mediaMessageId === messageId,
    );
    if (!run) return false;
    this.fail(run.runtimeThreadId, new Error(`${run.task} generation cancelled`), "cancelled");
    await run.interrupt().catch(() => {});
    return true;
  }

  async cancelAll(reason = "specialist generation cancelled"): Promise<void> {
    const runs = [...this.byThread.values()];
    for (const run of runs) this.fail(run.runtimeThreadId, new Error(reason), "cancelled");
    await Promise.all(runs.map((run) => run.interrupt().catch(() => {})));
  }

  private remove(run: SpecialistRun) {
    clearTimeout(run.timer);
    this.byThread.delete(run.runtimeThreadId);
    this.activeTasks.delete(activeKey(run.botId, run.task));
  }
}
