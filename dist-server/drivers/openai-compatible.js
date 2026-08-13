import { newEventId, newId } from "../contracts.js";
import { appendNative } from "./native.js";
const PROBE_TTL_MS = 15_000;
function requiredString(value, fallback, field) {
    if (value === undefined || value === null || value === "")
        return fallback;
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${field} must be a non-empty string`);
    return value.trim();
}
function normalizeBaseUrl(value, fallback) {
    const raw = requiredString(value, fallback, "url");
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error(`url must be an absolute http(s) URL, received ${JSON.stringify(raw)}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`url must use http or https, received ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password)
        throw new Error("url must not contain embedded credentials");
    return parsed.href.replace(/\/+$/, "");
}
function normalizeRelativePath(value, fallback, field) {
    const raw = requiredString(value, fallback, field);
    if (!raw.startsWith("/") ||
        raw.startsWith("//") ||
        raw.includes("?") ||
        raw.includes("#") ||
        raw.split("/").includes("..")) {
        throw new Error(`${field} must be a same-origin relative path beginning with /`);
    }
    return raw.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}
function normalizeModelTasks(value) {
    if (value === undefined || value === null)
        return {};
    if (typeof value !== "object" || Array.isArray(value))
        throw new Error("modelTasks must be an object");
    const tasks = {};
    for (const [id, task] of Object.entries(value)) {
        if (!id.trim() || (task !== "chat" && task !== "image" && task !== "video")) {
            throw new Error("modelTasks values must be chat, image, or video");
        }
        tasks[id.trim()] = task;
    }
    return tasks;
}
function responseText(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return "";
    return value
        .map((part) => {
        if (typeof part === "string")
            return part;
        if (!part || typeof part !== "object")
            return "";
        const text = part.text;
        return typeof text === "string" ? text : "";
    })
        .join("");
}
function errorMessage(value) {
    if (!value || typeof value !== "object")
        return "";
    const error = value.error;
    if (typeof error === "string")
        return error;
    if (error && typeof error === "object") {
        const message = error.message;
        if (typeof message === "string")
            return message;
    }
    return "";
}
async function httpFailure(res) {
    const raw = (await res.text().catch(() => "")).slice(0, 500);
    if (!raw)
        return `HTTP ${res.status}`;
    try {
        const parsed = JSON.parse(raw);
        return `HTTP ${res.status}: ${errorMessage(parsed) || raw.slice(0, 200)}`;
    }
    catch {
        return `HTTP ${res.status}: ${raw.slice(0, 200)}`;
    }
}
function uniqueModels(options) {
    const seen = new Set();
    return options.filter((option) => {
        if (!option.id || seen.has(option.id))
            return false;
        seen.add(option.id);
        return true;
    });
}
function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string" && Boolean(item));
}
function discoveredModel(raw, overrides = {}) {
    if (!raw || typeof raw !== "object")
        return null;
    const item = raw;
    if (typeof item.id !== "string" || !item.id)
        return null;
    const architecture = item.architecture && typeof item.architecture === "object"
        ? item.architecture
        : {};
    const inputModalities = stringArray(item.input_modalities ?? architecture.input_modalities);
    const outputModalities = stringArray(item.output_modalities ?? architecture.output_modalities);
    const task = overrides[item.id] ??
        (outputModalities.includes("video") ? "video" : outputModalities.includes("image") ? "image" : undefined);
    return {
        id: item.id,
        label: typeof item.name === "string" && item.name ? item.name : item.id,
        ...(task ? { task } : {}),
        ...(inputModalities.length ? { inputModalities } : {}),
        ...(outputModalities.length ? { outputModalities } : {}),
    };
}
export function createOpenAICompatibleDriver(spec) {
    const declaredFallbacks = uniqueModels(spec.fallbackModels ?? []);
    const fallbackModels = uniqueModels([
        declaredFallbacks.find((option) => option.id === spec.defaultModel) ?? {
            id: spec.defaultModel,
            label: spec.defaultModel,
        },
        ...declaredFallbacks,
    ]);
    const driverModels = { default: spec.defaultModel, options: fallbackModels };
    const decodeConfig = (raw) => {
        if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
            throw new Error("config must be an object");
        }
        const value = (raw ?? {});
        return {
            url: normalizeBaseUrl(value.url, spec.defaultUrl),
            apiKeyEnv: requiredString(value.apiKeyEnv, spec.defaultApiKeyEnv, "apiKeyEnv"),
            model: requiredString(value.model, spec.defaultModel, "model"),
            modelTasks: normalizeModelTasks(value.modelTasks),
            imagePath: normalizeRelativePath(value.imagePath, spec.imagePath ?? "/images/generations", "imagePath"),
            videoPath: normalizeRelativePath(value.videoPath, spec.videoPath ?? "/videos", "videoPath"),
        };
    };
    return {
        driverKind: spec.driverKind,
        metadata: { displayName: spec.displayName, supportsMultipleInstances: true },
        models: driverModels,
        decodeConfig,
        defaultConfig: () => decodeConfig({}),
        async create(input) {
            const { instanceId, config } = input;
            const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
            const listeners = new Set();
            const active = new Map();
            const models = {
                default: config.model,
                options: uniqueModels([
                    {
                        id: config.model,
                        label: config.model,
                        ...(config.modelTasks[config.model] ? { task: config.modelTasks[config.model] } : {}),
                    },
                    ...fallbackModels.map((model) => ({
                        ...model,
                        ...(config.modelTasks[model.id] ? { task: config.modelTasks[model.id] } : {}),
                    })),
                ]),
            };
            let lastProbe = null;
            let probeInFlight = null;
            const headers = (json = false) => ({
                ...(json ? { "content-type": "application/json" } : {}),
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
                ...(spec.headers ?? {}),
            });
            const emit = (event) => {
                for (const listener of [...listeners])
                    listener(event);
            };
            const base = (threadId, turnId) => ({
                eventId: newEventId(),
                provider: spec.driverKind,
                threadId,
                turnId,
                createdAt: new Date().toISOString(),
            });
            const requireCredential = () => {
                if (spec.apiKeyRequired && !apiKey) {
                    throw new Error(spec.missingCredentialMessage ??
                        `no ${spec.displayName} API key — add it in App Settings or set ${config.apiKeyEnv}`);
                }
            };
            const remoteMediaSource = (url, mime) => {
                let sameOrigin = false;
                try {
                    sameOrigin = new URL(url).origin === new URL(config.url).origin;
                }
                catch {
                    // The cache validates the URL and will surface a bounded error.
                }
                return {
                    type: "url",
                    url,
                    ...(mime ? { mime } : {}),
                    ...(sameOrigin ? { headers: headers() } : {}),
                };
            };
            const discoverModels = async () => {
                const res = await fetch(`${config.url}/models${spec.modelQuery ?? ""}`, {
                    headers: headers(),
                    signal: AbortSignal.timeout(3_000),
                });
                if (!res.ok)
                    throw new Error(await httpFailure(res));
                const payload = (await res.json());
                if (!Array.isArray(payload.data))
                    throw new Error("GET /models returned no data array");
                const discovered = uniqueModels(payload.data.flatMap((raw) => {
                    const model = discoveredModel(raw, config.modelTasks);
                    return model ? [model] : [];
                }));
                for (const [path, output] of [
                    [spec.imageModelsPath, "image"],
                    [spec.videoModelsPath, "video"],
                ]) {
                    if (!path)
                        continue;
                    try {
                        const response = await fetch(`${config.url}${path}`, {
                            headers: headers(),
                            signal: AbortSignal.timeout(3_000),
                        });
                        if (!response.ok)
                            continue;
                        const supplemental = (await response.json());
                        if (!Array.isArray(supplemental.data))
                            continue;
                        for (const raw of supplemental.data) {
                            if (!raw || typeof raw !== "object")
                                continue;
                            const model = discoveredModel({ ...raw, output_modalities: [output] }, config.modelTasks);
                            if (!model)
                                continue;
                            const index = discovered.findIndex((candidate) => candidate.id === model.id);
                            if (index === -1)
                                discovered.push(model);
                            else
                                discovered[index] = { ...discovered[index], ...model };
                        }
                    }
                    catch {
                        // Supplemental media catalogs are additive and may be
                        // unavailable for an account; the primary catalog still works.
                    }
                }
                return discovered;
            };
            const fetchJson = async (path, init) => {
                const target = /^https?:\/\//.test(path) ? path : `${config.url}${path}`;
                const res = await fetch(target, init);
                if (!res.ok)
                    throw new Error(`${spec.displayName} ${await httpFailure(res)}`);
                const payload = await res.json();
                const apiError = errorMessage(payload);
                if (apiError)
                    throw new Error(`${spec.displayName}: ${apiError}`);
                return payload;
            };
            const generateImage = async (threadId, turnId, itemId, prompt, model, signal) => {
                emit({
                    ...base(threadId, turnId),
                    itemId,
                    type: "item.started",
                    itemType: "media",
                    media: [{ id: itemId, kind: "image", status: "generating" }],
                });
                appendNative(threadId, {
                    dir: "out",
                    source: `${spec.driverKind}.images.generate`,
                    msg: { model, prompt },
                });
                const payload = await fetchJson(config.imagePath, {
                    method: "POST",
                    headers: headers(true),
                    body: JSON.stringify({ model, prompt }),
                    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
                });
                const rawItems = Array.isArray(payload.data)
                    ? payload.data
                    : Array.isArray(payload.images)
                        ? payload.images
                        : [];
                const media = rawItems.flatMap((raw, index) => {
                    if (!raw || typeof raw !== "object")
                        return [];
                    const item = raw;
                    const mime = typeof item.media_type === "string"
                        ? item.media_type
                        : typeof item.mime_type === "string"
                            ? item.mime_type
                            : undefined;
                    const source = typeof item.b64_json === "string"
                        ? ({ type: "base64", data: item.b64_json, ...(mime ? { mime } : {}) })
                        : typeof item.url === "string"
                            ? remoteMediaSource(item.url, mime)
                            : null;
                    if (!source)
                        return [];
                    return [
                        {
                            id: `${itemId}-${index}`,
                            kind: "image",
                            status: "ready",
                            ...(mime ? { mime } : {}),
                            ...(typeof item.width === "number" ? { width: item.width } : {}),
                            ...(typeof item.height === "number" ? { height: item.height } : {}),
                            source,
                        },
                    ];
                });
                if (!media.length)
                    throw new Error(`${spec.displayName} returned no generated images`);
                appendNative(threadId, { dir: "in", source: `${spec.driverKind}.images.generate`, msg: payload });
                emit({ ...base(threadId, turnId), itemId, type: "item.completed", itemType: "media", media });
            };
            const videoUrl = (payload) => {
                for (const value of [
                    payload?.content_url,
                    payload?.url,
                    payload?.data?.content_url,
                    payload?.data?.url,
                    payload?.output?.url,
                    payload?.unsigned_urls?.[0],
                    payload?.data?.unsigned_urls?.[0],
                ]) {
                    if (typeof value === "string" && value)
                        return value;
                }
                return null;
            };
            const wait = (ms, signal) => new Promise((resolve, reject) => {
                if (signal.aborted)
                    return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
                const timer = setTimeout(resolve, ms);
                signal.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
                }, { once: true });
            });
            const generateVideo = async (threadId, turnId, itemId, prompt, model, signal) => {
                emit({
                    ...base(threadId, turnId),
                    itemId,
                    type: "item.started",
                    itemType: "media",
                    media: [{ id: itemId, kind: "video", status: "queued" }],
                });
                const payload = await fetchJson(config.videoPath, {
                    method: "POST",
                    headers: headers(true),
                    body: JSON.stringify({ model, prompt }),
                    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
                });
                const jobId = payload?.id ?? payload?.job_id ?? payload?.data?.id;
                if (typeof jobId !== "string" || !jobId) {
                    throw new Error(`${spec.displayName} returned no video job id`);
                }
                appendNative(threadId, {
                    dir: "out",
                    source: `${spec.driverKind}.videos.generate`,
                    msg: { model, prompt, jobId },
                });
                const startedAt = Date.now();
                let pollingTarget = `${config.videoPath}/${encodeURIComponent(jobId)}`;
                if (typeof payload?.polling_url === "string" && payload.polling_url) {
                    const pollingUrl = new URL(payload.polling_url, `${config.url}/`);
                    if (pollingUrl.origin !== new URL(config.url).origin) {
                        throw new Error(`${spec.displayName} returned a cross-origin video polling URL`);
                    }
                    pollingTarget = pollingUrl.href;
                }
                const delays = [500, 1_000, 2_000, 5_000];
                let attempt = 0;
                for (;;) {
                    if (Date.now() - startedAt > 20 * 60_000)
                        throw new Error(`${spec.displayName} video generation timed out`);
                    const statusPayload = await fetchJson(pollingTarget, {
                        method: "GET",
                        headers: headers(),
                        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                    });
                    const status = String(statusPayload?.status ?? statusPayload?.data?.status ?? "generating").toLowerCase();
                    const progressRaw = statusPayload?.progress ?? statusPayload?.data?.progress;
                    const progress = typeof progressRaw === "number" ? progressRaw : undefined;
                    if (["completed", "succeeded", "success", "ready"].includes(status)) {
                        const url = videoUrl(statusPayload);
                        if (!url)
                            throw new Error(`${spec.displayName} completed the video job without a content URL`);
                        const mime = typeof statusPayload?.media_type === "string"
                            ? statusPayload.media_type
                            : typeof statusPayload?.mime_type === "string"
                                ? statusPayload.mime_type
                                : undefined;
                        const media = [
                            {
                                id: itemId,
                                kind: "video",
                                status: "ready",
                                providerJobId: jobId,
                                source: remoteMediaSource(url, mime),
                                ...(mime ? { mime } : {}),
                                ...(typeof statusPayload?.duration === "number"
                                    ? { durationSeconds: statusPayload.duration }
                                    : {}),
                            },
                        ];
                        appendNative(threadId, {
                            dir: "in",
                            source: `${spec.driverKind}.videos.generate`,
                            msg: statusPayload,
                        });
                        emit({ ...base(threadId, turnId), itemId, type: "item.completed", itemType: "media", media });
                        return;
                    }
                    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
                        throw new Error(`${spec.displayName} video generation ${status}: ${errorMessage(statusPayload) || "provider rejected the job"}`);
                    }
                    emit({
                        ...base(threadId, turnId),
                        itemId,
                        type: "item.updated",
                        itemType: "media",
                        media: [
                            {
                                id: itemId,
                                kind: "video",
                                status: "generating",
                                providerJobId: jobId,
                                ...(progress !== undefined ? { progress } : {}),
                            },
                        ],
                    });
                    await wait(delays[Math.min(attempt++, delays.length - 1)], signal);
                }
            };
            const snapshot = async () => {
                if (!input.enabled)
                    return { state: "unavailable", reason: "disabled" };
                if (spec.apiKeyRequired && !apiKey) {
                    return {
                        state: "unavailable",
                        authenticated: false,
                        reason: spec.missingCredentialMessage ??
                            `no ${spec.displayName} API key — add it in App Settings or set ${config.apiKeyEnv}`,
                    };
                }
                if (lastProbe && Date.now() - lastProbe.at < PROBE_TTL_MS)
                    return lastProbe.snapshot;
                if (probeInFlight)
                    return probeInFlight;
                probeInFlight = (async () => {
                    let next;
                    try {
                        const discovered = await discoverModels();
                        if (!discovered.length)
                            throw new Error("GET /models returned an empty model catalog");
                        models.options = uniqueModels([
                            discovered.find((option) => option.id === config.model) ?? {
                                id: config.model,
                                label: config.model,
                                ...(config.modelTasks[config.model] ? { task: config.modelTasks[config.model] } : {}),
                            },
                            ...discovered,
                        ]);
                        next = {
                            state: "available",
                            authenticated: apiKey ? true : undefined,
                            version: `${models.options.length} model${models.options.length === 1 ? "" : "s"}`,
                        };
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        next = {
                            state: "unavailable",
                            authenticated: apiKey ? false : undefined,
                            reason: `cannot reach ${config.url}: ${message}`,
                        };
                    }
                    lastProbe = { at: Date.now(), snapshot: next };
                    probeInFlight = null;
                    return next;
                })();
                return probeInFlight;
            };
            const complete = async (messages, model, opts) => {
                requireCredential();
                const timeout = AbortSignal.timeout(120_000);
                const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
                const res = await fetch(`${config.url}/chat/completions`, {
                    method: "POST",
                    headers: headers(true),
                    body: JSON.stringify({
                        model,
                        messages,
                        stream: opts.stream,
                        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
                        ...(opts.stream ? { stream_options: { include_usage: true } } : {}),
                    }),
                    signal,
                });
                if (!res.ok) {
                    const failure = await httpFailure(res);
                    throw new Error(opts.tools?.length
                        ? `The selected primary model/provider does not support tool calling. ${spec.displayName}: ${failure}`
                        : `${spec.displayName} ${failure}`);
                }
                if (!opts.stream) {
                    const payload = (await res.json());
                    const apiError = errorMessage(payload);
                    if (apiError)
                        throw new Error(`${spec.displayName}: ${apiError}`);
                    return {
                        text: responseText(payload.choices?.[0]?.message?.content),
                        toolCalls: Array.isArray(payload.choices?.[0]?.message?.tool_calls)
                            ? payload.choices[0].message.tool_calls
                            : [],
                        usage: payload.usage
                            ? {
                                input: payload.usage.prompt_tokens ?? 0,
                                output: payload.usage.completion_tokens ?? 0,
                            }
                            : null,
                    };
                }
                if (!res.body)
                    throw new Error(`${spec.displayName} returned an empty streaming response`);
                let text = "";
                let usage = null;
                const streamedToolCalls = new Map();
                const parseLine = (rawLine) => {
                    const line = rawLine.trim();
                    if (!line.startsWith("data:"))
                        return;
                    const data = line.slice(5).trim();
                    if (!data || data === "[DONE]")
                        return;
                    let chunk;
                    try {
                        chunk = JSON.parse(data);
                    }
                    catch {
                        return;
                    }
                    const apiError = errorMessage(chunk);
                    if (apiError)
                        throw new Error(`${spec.displayName}: ${apiError}`);
                    const delta = responseText(chunk.choices?.[0]?.delta?.content);
                    if (delta) {
                        text += delta;
                        opts.onDelta?.(delta);
                    }
                    const reasoning = responseText(chunk.choices?.[0]?.delta?.reasoning_content ??
                        chunk.choices?.[0]?.delta?.reasoning ??
                        chunk.choices?.[0]?.delta?.thinking);
                    if (reasoning)
                        opts.onReasoning?.(reasoning);
                    for (const rawCall of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
                        const index = typeof rawCall?.index === "number" ? rawCall.index : 0;
                        const current = streamedToolCalls.get(index) ?? {
                            id: "",
                            type: "function",
                            function: { name: "", arguments: "" },
                        };
                        if (typeof rawCall?.id === "string")
                            current.id += rawCall.id;
                        if (typeof rawCall?.function?.name === "string")
                            current.function.name += rawCall.function.name;
                        if (typeof rawCall?.function?.arguments === "string") {
                            current.function.arguments += rawCall.function.arguments;
                        }
                        streamedToolCalls.set(index, current);
                    }
                    if (chunk.usage) {
                        usage = {
                            input: chunk.usage.prompt_tokens ?? 0,
                            output: chunk.usage.completion_tokens ?? 0,
                        };
                    }
                };
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buffer += decoder.decode(value, { stream: true });
                    let newline = buffer.indexOf("\n");
                    while (newline !== -1) {
                        parseLine(buffer.slice(0, newline));
                        buffer = buffer.slice(newline + 1);
                        newline = buffer.indexOf("\n");
                    }
                }
                buffer += decoder.decode();
                if (buffer.trim())
                    parseLine(buffer);
                return {
                    text,
                    usage,
                    toolCalls: [...streamedToolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
                };
            };
            const mediaTools = (turn) => (turn.integrations?.media?.tasks ?? []).map((task) => ({
                type: "function",
                function: {
                    name: `generate_${task}`,
                    description: `Generate a ${task} with this bot's configured specialist and place it in the current chat.`,
                    parameters: {
                        type: "object",
                        properties: {
                            prompt: { type: "string", description: `A complete production-ready ${task} prompt.` },
                        },
                        required: ["prompt"],
                    },
                },
            }));
            const callMediaTool = async (turn, task, prompt) => {
                const media = turn.integrations?.media;
                if (!media?.endpoint || !media.token || !media.botId || !media.primaryTurnId) {
                    throw new Error("media specialist endpoint is unavailable");
                }
                const response = await fetch(media.endpoint, {
                    method: "POST",
                    headers: { "content-type": "application/json", authorization: `Bearer ${media.token}` },
                    body: JSON.stringify({
                        botId: media.botId,
                        primaryTurnId: media.primaryTurnId,
                        task,
                        prompt,
                    }),
                });
                const body = (await response.json().catch(() => ({})));
                if (!response.ok)
                    throw new Error(String(body.error ?? `HTTP ${response.status}`));
                return body;
            };
            const sendTurn = async (turn) => {
                requireCredential();
                if (active.has(turn.threadId))
                    throw new Error("a turn is already running on this thread");
                const turnId = newId();
                const abort = new AbortController();
                active.set(turn.threadId, { abort, turnId });
                const messages = [
                    ...(turn.system ? [{ role: "system", content: turn.system }] : []),
                    ...(turn.transcript ?? []).map((message) => ({
                        role: message.role === "assistant" ? "assistant" : "user",
                        content: message.text,
                    })),
                    { role: "user", content: turn.text },
                ];
                const selectedModel = turn.model || models.default;
                const selectedTask = config.modelTasks[selectedModel] ?? models.options.find((option) => option.id === selectedModel)?.task ?? "chat";
                const mediaItemId = selectedTask === "chat" ? null : newId();
                appendNative(turn.threadId, {
                    dir: "out",
                    source: `${spec.driverKind}.chat.completions`,
                    msg: { model: selectedModel, messages },
                });
                emit({ ...base(turn.threadId, turnId), type: "turn.started" });
                emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model: selectedModel });
                void (async () => {
                    try {
                        if (selectedTask === "image") {
                            await generateImage(turn.threadId, turnId, mediaItemId, turn.text, selectedModel, abort.signal);
                            active.delete(turn.threadId);
                            emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
                            return;
                        }
                        if (selectedTask === "video") {
                            await generateVideo(turn.threadId, turnId, mediaItemId, turn.text, selectedModel, abort.signal);
                            active.delete(turn.threadId);
                            emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
                            return;
                        }
                        const tools = mediaTools(turn);
                        const workingMessages = [...messages];
                        let result = null;
                        let inputTokens = 0;
                        let outputTokens = 0;
                        let mediaCalls = 0;
                        for (;;) {
                            result = await complete(workingMessages, selectedModel, {
                                stream: true,
                                signal: abort.signal,
                                tools,
                                onDelta: (delta) => emit({
                                    ...base(turn.threadId, turnId),
                                    type: "content.delta",
                                    streamKind: "assistant_text",
                                    delta,
                                }),
                                onReasoning: (delta) => emit({
                                    ...base(turn.threadId, turnId),
                                    type: "content.delta",
                                    streamKind: "reasoning_text",
                                    delta,
                                }),
                            });
                            if (result.usage) {
                                inputTokens += result.usage.input;
                                outputTokens += result.usage.output;
                            }
                            if (!result.toolCalls.length)
                                break;
                            workingMessages.push({
                                role: "assistant",
                                content: result.text || null,
                                tool_calls: result.toolCalls,
                            });
                            for (const call of result.toolCalls) {
                                mediaCalls += 1;
                                if (mediaCalls > 3)
                                    throw new Error("the model exceeded the three media generations allowed per turn");
                                const task = call.function.name === "generate_image" ? "image" : call.function.name === "generate_video" ? "video" : null;
                                const itemId = call.id || newId();
                                emit({
                                    ...base(turn.threadId, turnId),
                                    itemId,
                                    type: "item.started",
                                    itemType: "tool",
                                    title: call.function.name || "media tool",
                                });
                                let content;
                                let ok = false;
                                try {
                                    if (!task || !turn.integrations?.media?.tasks.includes(task)) {
                                        throw new Error(`unavailable media tool: ${call.function.name}`);
                                    }
                                    const args = JSON.parse(call.function.arguments || "{}");
                                    const prompt = String(args.prompt ?? "").trim();
                                    if (!prompt)
                                        throw new Error(`${call.function.name} needs a prompt`);
                                    const generated = await callMediaTool(turn, task, prompt);
                                    content = JSON.stringify({ ok: true, ...generated, note: `The ${task} is already visible in chat.` });
                                    ok = true;
                                }
                                catch (error) {
                                    content = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
                                }
                                emit({ ...base(turn.threadId, turnId), itemId, type: "item.completed", itemType: "tool", ok });
                                workingMessages.push({ role: "tool", tool_call_id: call.id, content });
                            }
                        }
                        appendNative(turn.threadId, {
                            dir: "in",
                            source: `${spec.driverKind}.chat.completions`,
                            msg: result,
                        });
                        if (result.text.trim()) {
                            emit({
                                ...base(turn.threadId, turnId),
                                type: "item.completed",
                                itemType: "assistant_text",
                                text: result.text,
                            });
                        }
                        if (inputTokens || outputTokens) {
                            emit({
                                ...base(turn.threadId, turnId),
                                type: "thread.token-usage.updated",
                                input: inputTokens,
                                output: outputTokens,
                            });
                        }
                        active.delete(turn.threadId);
                        emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
                    }
                    catch (error) {
                        active.delete(turn.threadId);
                        const aborted = abort.signal.aborted || error.name === "AbortError";
                        if (mediaItemId && selectedTask !== "chat") {
                            const message = aborted
                                ? "Generation cancelled"
                                : error instanceof Error
                                    ? error.message
                                    : String(error);
                            emit({
                                ...base(turn.threadId, turnId),
                                itemId: mediaItemId,
                                type: "item.completed",
                                itemType: "media",
                                media: [
                                    {
                                        id: mediaItemId,
                                        kind: selectedTask,
                                        status: aborted ? "cancelled" : "failed",
                                        error: message.slice(0, 240),
                                    },
                                ],
                            });
                        }
                        else if (!aborted) {
                            emit({
                                ...base(turn.threadId, turnId),
                                type: "runtime.error",
                                message: error instanceof Error ? error.message : String(error),
                            });
                        }
                        emit({
                            ...base(turn.threadId, turnId),
                            type: "turn.completed",
                            ok: false,
                            stopReason: aborted ? "interrupted" : "error",
                            cost: null,
                        });
                    }
                })();
                return { turnId };
            };
            return {
                instanceId,
                driverKind: spec.driverKind,
                displayName: input.displayName,
                enabled: input.enabled,
                models,
                snapshot,
                adapter: {
                    provider: spec.driverKind,
                    capabilities: { sessionModelSwitch: "in-session", transcriptReplay: true, mediaTools: "native" },
                    sendTurn,
                    interruptTurn: async (threadId, turnId) => {
                        const running = active.get(threadId);
                        if (running && (!turnId || running.turnId === turnId))
                            running.abort.abort();
                    },
                    respondToRequest: async () => {
                        throw new Error(`${spec.displayName} has no pending asks`);
                    },
                    hasSession: (threadId) => active.has(threadId),
                    stopAll: async () => {
                        for (const { abort } of active.values())
                            abort.abort();
                    },
                    onEvent: (listener) => {
                        listeners.add(listener);
                        return () => listeners.delete(listener);
                    },
                },
                generateText: async (prompt) => {
                    const result = await complete([{ role: "user", content: prompt }], models.default, { stream: false });
                    return result.text;
                },
                dispose: async () => {
                    for (const { abort } of active.values())
                        abort.abort();
                    active.clear();
                    listeners.clear();
                },
            };
        },
    };
}
