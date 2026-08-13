const activeKey = (botId, task) => `${botId}:${task}`;
export class SpecialistRunManager {
    byThread = new Map();
    activeTasks = new Map();
    timeoutMs;
    constructor(timeoutMs = 4 * 60_000) {
        this.timeoutMs = timeoutMs;
    }
    start(input) {
        const key = activeKey(input.botId, input.task);
        if (this.activeTasks.has(key)) {
            throw new Error(`this bot is already generating an ${input.task}`);
        }
        let resolve;
        let reject;
        const result = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        const timer = setTimeout(() => {
            void input.interrupt().catch(() => { });
            this.fail(input.runtimeThreadId, new Error(`${input.task} generation timed out`));
        }, this.timeoutMs);
        timer.unref?.();
        const run = { ...input, result, resolve, reject, timer };
        this.byThread.set(input.runtimeThreadId, run);
        this.activeTasks.set(key, input.runtimeThreadId);
        return run;
    }
    forThread(runtimeThreadId) {
        return this.byThread.get(runtimeThreadId);
    }
    setMediaPipeline(runtimeThreadId, messageId, pipeline) {
        const run = this.byThread.get(runtimeThreadId);
        if (!run)
            return;
        run.mediaMessageId = messageId;
        run.mediaPipeline = pipeline;
        void pipeline.catch((error) => this.fail(runtimeThreadId, error instanceof Error ? error : new Error(String(error))));
    }
    turnCompleted(runtimeThreadId, ok) {
        const run = this.byThread.get(runtimeThreadId);
        if (!run)
            return;
        if (!ok)
            return this.fail(runtimeThreadId, new Error(`${run.task} specialist failed`));
        if (!run.mediaMessageId || !run.mediaPipeline) {
            return this.fail(runtimeThreadId, new Error(`${run.task} specialist finished without generated media`));
        }
        void run.mediaPipeline
            .then(() => {
            const current = this.byThread.get(runtimeThreadId);
            if (!current?.mediaMessageId)
                return;
            this.remove(current);
            current.resolve({ messageId: current.mediaMessageId, task: current.task });
        })
            .catch(() => { });
    }
    fail(runtimeThreadId, error) {
        const run = this.byThread.get(runtimeThreadId);
        if (!run)
            return;
        this.remove(run);
        run.reject(error);
    }
    async cancelPrimary(botId, primaryTurnId) {
        const matches = [...this.byThread.values()].filter((run) => run.botId === botId && run.primaryTurnId === primaryTurnId);
        for (const run of matches)
            this.fail(run.runtimeThreadId, new Error(`${run.task} generation cancelled`));
        await Promise.all(matches.map((run) => run.interrupt().catch(() => { })));
    }
    async cancelAll(reason = "specialist generation cancelled") {
        const runs = [...this.byThread.values()];
        for (const run of runs)
            this.fail(run.runtimeThreadId, new Error(reason));
        await Promise.all(runs.map((run) => run.interrupt().catch(() => { })));
    }
    remove(run) {
        clearTimeout(run.timer);
        this.byThread.delete(run.runtimeThreadId);
        this.activeTasks.delete(activeKey(run.botId, run.task));
    }
}
