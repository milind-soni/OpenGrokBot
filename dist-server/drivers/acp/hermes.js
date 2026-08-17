// Hermes Agent — Nous Research's `hermes acp` CLI. Custom-only: Hermes is
// a BYOK/local harness. ACP ignores `hermes -m` (cmd_acp does not forward
// it), and setting OPENAI_API_KEY makes provider:auto resolve to OpenRouter
// without an OpenRouter key — that is the "HTTP 401: Missing Authentication
// header" failure. Inject writes providers.<host> and session/set_model
// `custom:<host>:<model>` instead.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.js";
import { createAcpDriver } from "./core.js";
const EMPTY = { default: "", options: [] };
function hermesHome(env) {
    return env.HERMES_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".hermes");
}
function quoteYaml(value) {
    if (/^[\w./:+-]+$/.test(value))
        return value;
    return JSON.stringify(value);
}
function upsertHermesProvider(text, hostId, baseUrl, apiKey) {
    const block = [`  ${hostId}:`, `    base_url: ${quoteYaml(baseUrl)}`, `    api_key: ${quoteYaml(apiKey)}`, ""].join("\n");
    if (/^providers:\s*$/m.test(text)) {
        const replaced = replaceHermesHostBlock(text, hostId, block);
        if (replaced !== null)
            return replaced;
        return text.replace(/^providers:\s*$/m, `providers:\n${block.trimEnd()}`);
    }
    const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
    return `${prefix}\nproviders:\n${block}`;
}
/** Replace `  hostId:` through the next sibling 2-space key or a top-level key. */
function replaceHermesHostBlock(text, hostId, block) {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line === `  ${hostId}:`);
    if (start < 0)
        return null;
    let end = start + 1;
    while (end < lines.length) {
        const line = lines[end];
        if (/^  \S/.test(line) || /^\S/.test(line))
            break;
        end++;
    }
    while (end > start + 1 && lines[end - 1] === "")
        end--;
    return [...lines.slice(0, start), ...block.replace(/\n$/, "").split("\n"), ...lines.slice(end)].join("\n");
}
/** Register an OpenAI-compatible host so ACP can `session/set_model custom:host:model`. */
export function ensureHermesInjectProvider(modelId, env = process.env) {
    const inject = decodeInjectId(modelId);
    if (!inject)
        return modelId;
    const host = localHost(inject.host);
    if (!host)
        return modelId;
    const dir = hermesHome(env);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.yaml");
    let text = "";
    try {
        text = readFileSync(path, "utf8");
    }
    catch {
        text = "";
    }
    const next = upsertHermesProvider(text, inject.host, host.baseUrl, hostApiKey(host, env));
    if (next !== text)
        writeFileSync(path, next);
    return hermesAcpModelId(modelId) ?? modelId;
}
/** ACP session/set_model id. Hermes parse_model_input treats `custom:name:model`. */
export function hermesAcpModelId(modelId) {
    const inject = decodeInjectId(modelId);
    if (!inject)
        return null;
    return `custom:${inject.host}:${inject.model}`;
}
async function resolveModels(env) {
    const catalog = await mergeLocalInject(EMPTY, env);
    return { default: catalog.options[0]?.id ?? "", options: catalog.options };
}
async function applySetting(request, method, params, what) {
    try {
        await request(method, params);
    }
    catch (e) {
        throw new Error(`Hermes rejected ${what} via ${method}: ${e.message}`);
    }
}
const support = {
    driverKind: "hermesAgent",
    displayName: "Hermes",
    access: "custom",
    models: EMPTY,
    resolveModels,
    resolveTurnModel: (model, env) => {
        if (!model)
            return model;
        ensureHermesInjectProvider(model, env);
        return model;
    },
    defaultCli: "hermes",
    nativeSource: "hermes.acp",
    loginNote: "Hermes CLI is not installed",
    install: {
        command: {
            darwin: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
            linux: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
            win32: "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
        },
        docsUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
        signInCommand: "hermes setup",
    },
    spawnArgs: () => ["acp"],
    transformEnv: (env) => {
        // A leftover OPENAI_API_KEY makes Hermes auto-resolve to OpenRouter and
        // send no Authorization header. ACP also reloads ~/.hermes/.env, so the
        // named custom provider + session/set_model is the real route.
        delete env.OPENAI_API_KEY;
        delete env.OPENROUTER_API_KEY;
    },
    pickAuthMethod: () => null,
    authFailure: "continue",
    isAuthenticated: () => true,
    async configureSession({ request, sessionId, turn }) {
        // Decode only — resolveTurnModel already wrote the named provider using
        // the instance HOME. Calling ensure* again here would hit process.env
        // and rewrite the user's real ~/.hermes/config.yaml.
        const native = hermesAcpModelId(turn.model);
        if (!native)
            return;
        await applySetting(request, "session/set_model", { sessionId, modelId: native }, `model "${native}"`);
    },
    buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};
export const HermesAgentDriver = createAcpDriver(support);
