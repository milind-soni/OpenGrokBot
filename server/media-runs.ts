import type { MediaKind, MediaOutput } from "./contracts.ts";

export interface ReadyMedia {
  cacheKey: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  providerJobId?: string;
}

interface StartMediaRun {
  botId: string;
  threadId: string;
  messageId: string;
  outputId: string;
  task: MediaKind;
  execute: (
    signal: AbortSignal,
    onProgress: (patch: Pick<MediaOutput, "progress" | "providerJobId">) => void,
  ) => Promise<ReadyMedia>;
  onPatch: (patch: Partial<MediaOutput>) => void;
  onDone: () => void;
}

interface ActiveMediaRun extends StartMediaRun {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  timeout: boolean;
  done: Promise<void>;
}

export class MediaRunCoordinator {
  private readonly active = new Map<string, ActiveMediaRun>();
  private readonly imageTimeoutMs: number;
  private readonly videoTimeoutMs: number;

  constructor(options: { imageTimeoutMs?: number; videoTimeoutMs?: number } = {}) {
    this.imageTimeoutMs = options.imageTimeoutMs ?? 3 * 60_000;
    this.videoTimeoutMs = options.videoTimeoutMs ?? 10 * 60_000;
  }

  start(input: StartMediaRun): ActiveMediaRun {
    if (this.active.has(input.botId)) throw new Error("this bot is already generating media");
    const controller = new AbortController();
    const run: ActiveMediaRun = {
      ...input,
      controller,
      timeout: false,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      done: Promise.resolve(),
    };
    const timeoutMs = input.task === "image" ? this.imageTimeoutMs : this.videoTimeoutMs;
    run.timer = setTimeout(() => {
      if (this.active.get(input.botId) !== run) return;
      run.timeout = true;
      this.active.delete(input.botId);
      controller.abort(new DOMException(`${input.task} generation timed out`, "TimeoutError"));
      input.onPatch({
        status: "failed",
        error: `${input.task[0]!.toUpperCase()}${input.task.slice(1)} generation timed out`,
      });
      input.onDone();
    }, timeoutMs);
    run.timer.unref?.();
    this.active.set(input.botId, run);
    input.onPatch({ status: "generating" });

    run.done = (async () => {
      try {
        const ready = await input.execute(controller.signal, (patch) => {
          if (this.active.get(input.botId) === run && !controller.signal.aborted) input.onPatch(patch);
        });
        if (this.active.get(input.botId) !== run || controller.signal.aborted) return;
        input.onPatch({ status: "ready", error: undefined, ...ready });
      } catch (error) {
        if (this.active.get(input.botId) !== run) return;
        input.onPatch({
          status: "failed",
          error: run.timeout
            ? `${input.task[0]!.toUpperCase()}${input.task.slice(1)} generation timed out`
            : error instanceof Error
              ? error.message
              : String(error),
        });
      } finally {
        if (this.active.get(input.botId) === run) this.finish(run);
      }
    })();
    return run;
  }

  cancel(botId: string, messageId?: string): boolean {
    const run = this.active.get(botId);
    if (!run || (messageId && run.messageId !== messageId)) return false;
    this.active.delete(botId);
    clearTimeout(run.timer);
    run.controller.abort(new DOMException("generation cancelled", "AbortError"));
    run.onPatch({
      status: "cancelled",
      error: `${run.task[0]!.toUpperCase()}${run.task.slice(1)} generation cancelled`,
    });
    run.onDone();
    return true;
  }

  cancelAll(): void {
    for (const botId of [...this.active.keys()]) this.cancel(botId);
  }

  current(botId: string): ActiveMediaRun | undefined {
    return this.active.get(botId);
  }

  private finish(run: ActiveMediaRun) {
    clearTimeout(run.timer);
    this.active.delete(run.botId);
    run.onDone();
  }
}
