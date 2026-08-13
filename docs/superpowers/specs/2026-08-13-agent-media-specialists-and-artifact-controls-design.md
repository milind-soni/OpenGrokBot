# Agent-Controlled Media Specialists and Artifact Controls Design

**Date:** 2026-08-13

**Status:** Approved design

**Scope:** Per-bot image/video specialist models, primary-agent tool orchestration, persistent live HTML expansion, and a chat-header artifact reopen control

## Context

OpenMausBot currently assigns one model selection to each bot. If that selection is an image or video model, the entire user turn routes directly to media generation. This supports explicit media bots, but it does not support a composite bot that uses a local text/coding agent such as Ollama while delegating image or video generation to models on OpenRouter or another configured provider.

The HTML creation experience now renders streaming code in a compact card and completed HTML as a reopenable creation card. However, the streaming card's expanded state is local to a Markdown code-block component that may remount as new tokens change the Markdown tree, so expansion can reset while generation continues. Completed artifacts can be reopened from Creations and their original message, but there is no persistent conversation-level reopen control when that message has scrolled away.

This design adds:

- one optional image specialist and one optional video specialist to each bot;
- real `generate_image` and `generate_video` tools controlled by the bot's primary agent;
- task-filtered specialist selectors inside Bot Settings;
- safe concurrent specialist execution whose output appears in the primary conversation;
- persistent live HTML expand/collapse state;
- a chat-header Artifact button that reopens the newest HTML artifact.

## Product Decisions

The user approved these decisions:

- Specialist configuration belongs inside Bot Settings.
- A bot has one primary agent, at most one image specialist, and at most one video specialist.
- Specialist selections may come from any configured provider.
- The primary agent decides when to call media specialists as tools.
- The system does not infer media intent from prompt keywords.
- Compact HTML remains the default, but users may expand it while it is still streaming.
- The expanded state must remain stable as new tokens arrive.
- The chat header provides a persistent way to reopen the newest artifact.
- Per-message Open/Reopen controls and the Creations library remain available.

## Goals

1. Let one bot combine a preferred text/coding agent with image and video models from other providers.
2. Preserve an agent-directed workflow: the primary model chooses whether and how to invoke media tools.
3. Keep primary and specialist turns isolated so they can run concurrently, even on the same provider instance.
4. Route specialist progress and final media into the primary bot's visible conversation and local media cache.
5. Keep existing single-model bots and direct image/video selections backward compatible.
6. Make live HTML expansion reliable and completed artifacts easy to reopen from anywhere in the chat.

## Non-goals

- Multiple image or video specialists per bot.
- Automatic load balancing, model scoring, or fallback chains among specialists.
- Prompt-keyword classification as a fallback for agents without tool support.
- Image-to-image, image-to-video, media attachments, or specialist editing workflows.
- Moving specialist output into separate hidden bot conversations.
- Exposing raw provider URLs, keys, internal generation tokens, or filesystem paths to the renderer.

## Approaches Considered

### 1. Primary-agent tools with per-task specialists — selected

Store an optional image and video selection on the bot, expose corresponding tools to the primary agent, and execute specialist turns through the existing provider adapters. This keeps configuration in one bot, supports providers independently, and lets the agent decide when media is useful.

### 2. Hidden specialist bots

Create hidden bots and use the existing `ask_bot` path. This reuses peer-agent communication but puts media events and history on the wrong thread, complicates lifecycle and visibility, and exposes hidden implementation details in bot storage.

### 3. Server-side prompt classification

Classify every message as chat, image, or video before dispatch. This is simpler for providers without tool calling, but violates the decision that the primary agent should plan and invoke specialists itself.

## Bot Model Configuration

The existing `modelSelection` remains the primary selection for backward compatibility. Bot records gain optional specialist selections:

```ts
interface BotSpecialists {
  image?: ModelSelection;
  video?: ModelSelection;
}

interface Bot {
  modelSelection: ModelSelection;
  specialists?: BotSpecialists;
}
```

Absence means the corresponding tool is unavailable. Existing persisted bots require no migration and deserialize with no specialists. Duplication copies specialist selections. Bot PATCH validation accepts only `{ instanceId, model }` records for `image` and `video`, and `null` removes a specialist.

The server validates each specialist at execution time rather than trusting stale UI metadata:

- the provider instance must still exist and be available;
- the selected model must be present in that instance's current catalog;
- the model task must match the configured slot (`image` or `video`).

Invalid or unavailable specialists return an actionable tool error and do not silently select another model.

## Bot Settings Experience

The current Model card becomes **Model team** with three rows:

1. **Primary agent** — filters to chat-capable models and CLI agents.
2. **Image specialist** — filters to models whose task is `image`; optional and removable.
3. **Video specialist** — filters to models whose task is `video`; optional and removable.

Each picker browses all configured provider instances, grouped by provider, using the existing model catalog and availability state. The specialist rows show **Not configured** when empty and a Remove action when populated. If a provider becomes unavailable, the saved selection remains visible with an unavailable label so the user can repair it deliberately.

The compact ModelPicker in the chat header continues to represent the primary agent. It does not switch the bot's specialist slots.

## Generation Tool Contract

The primary agent receives only the tools backed by configured specialists:

```ts
generate_image({ prompt: string }): Promise<GenerationToolResult>
generate_video({ prompt: string }): Promise<GenerationToolResult>

interface GenerationToolResult {
  ok: boolean;
  task: "image" | "video";
  mediaMessageId?: string;
  summary: string;
  error?: string;
}
```

The prompt is required, trimmed, and bounded using the existing request-body limit. The tool result contains status and stable message identifiers only; it never returns base64 payloads, local cache paths, provider URLs, or credentials to the primary model.

The primary system prompt states which specialist tools are available and tells the agent to use them when the user requests or would benefit from generated media. It must not claim generation succeeded before the tool returns successfully.

## Tool Delivery

### CLI and ACP primary agents

Claude Code and ACP-based agents receive a new `media` stdio MCP integration alongside the existing agents/computer integrations. The proxy exposes `generate_image` and/or `generate_video` according to environment-provided task permissions. It calls a token-protected loopback internal endpoint and waits for the specialist turn to finish.

The integration reuses the server's per-boot internal token and passes only:

- harness loopback URL;
- calling bot ID;
- allowed specialist task names;
- internal bearer token.

### OpenAI-compatible primary agents

The shared OpenAI-compatible chat driver supplies equivalent standard function-tool schemas in `/chat/completions`. It accumulates streamed tool-call deltas, calls the same protected internal generation endpoint, appends the assistant tool-call message and tool result, and continues the chat-completion loop.

The loop is capped at three media tool calls per user turn. A provider rejection of the standard tools field produces a clear runtime error explaining that the selected primary model/provider does not support tool calling. The system does not fall back to keyword routing.

Direct turns whose selected primary model is itself classified as image or video keep the existing direct-generation behavior for backward compatibility, although Bot Settings filters new primary choices to chat-capable selections.

## Specialist Execution and Event Routing

A primary turn marks the bot busy on its canonical conversation thread. A specialist tool call must not start a second adapter turn with that same runtime thread ID because provider adapters use the thread ID as their active-turn key. It therefore receives a private synthetic runtime thread ID:

```text
specialist:<botId>:<task>:<generationId>
```

The server registers a short-lived specialist-run record before dispatch:

```ts
interface SpecialistRun {
  runtimeThreadId: string;
  visibleThreadId: string;
  botId: string;
  primaryTurnId: string;
  task: "image" | "video";
  mediaMessageId?: string;
  mediaPipeline?: Promise<void>;
  resolve: (result: GenerationToolResult) => void;
}
```

The event bus checks this registry before normal folding. Specialist events follow a dedicated path:

- `item.started`, `item.updated`, and media `item.completed` are rewritten to the visible thread ID and folded through the same durable media-message/cache pipeline as direct generation;
- specialist assistant text, session cursors, permission requests, and screen events are not folded into the primary conversation;
- `runtime.error` settles the media message and tool call with a sanitized failure;
- specialist `turn.completed` waits for the media-cache pipeline, then resolves the tool waiter and removes the run record;
- specialist completion never clears the primary bot's busy state or modifies its primary resume cursor.

Because the specialist uses a unique runtime thread, it may use the same provider instance as the primary agent without colliding with the adapter's active-turn map. One bot may have only one active specialist call at a time per task; duplicate concurrent calls return a busy tool result. The main turn's interrupt aborts any specialist runs it started.

The tool reports success only after at least one output is safely cached and its durable media message is ready. A provider-success/cache-failure combination therefore returns an error instead of letting the primary agent claim a usable creation exists.

The tool waiter has the same bounded four-minute ceiling used by peer-agent communication. Timeout or interruption unregisters the mapping, interrupts the specialist runtime thread, and returns an error to the primary agent. The `primaryTurnId` link ensures interrupting one primary turn cancels only the specialist runs it started.

## Media Persistence and Creations

Specialist output uses the existing `item.started`/`item.updated`/`item.completed` media contract, atomic media cache, MIME validation, guarded `/api/media/:cacheKey` route, and structured media chat message.

As a result:

- progress appears in the primary conversation while the primary agent waits;
- successful media is cached locally before durable readiness;
- image and video viewers work unchanged;
- the creation index derives the output automatically;
- selecting the item from Creations reopens it in its primary bot conversation.

No specialist-specific media storage format is introduced.

## Persistent Live HTML Expansion

The streaming bubble owns expansion state keyed by conversation thread rather than the Markdown `CodeBlock`. `ChatMarkdown` receives controlled streaming-creation props:

```ts
interface StreamingCreationControls {
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
}
```

ChatView stores this state per thread. New token text may rerender or remount Markdown children without resetting it. A new assistant turn defaults to compact. The state is cleared when the stream settles, the turn is interrupted, the user switches to another branch, or a different bot is selected.

Compact mode retains the six-line maximum and internal scrolling. Expanded mode removes the height cap and exposes Collapse. Both controls have `aria-expanded`, remain keyboard operable, and never execute incomplete HTML.

## Chat-Header Artifact Control

When the active conversation contains at least one completed HTML artifact, ChatView adds an **Artifact** button in the header beside the primary ModelPicker. The control includes a panel icon and uses an accessible label:

- **Open latest artifact** when the panel is closed or showing an older artifact;
- **Close artifact** when the newest artifact is already open.

Clicking Open selects the newest completed artifact and opens the existing sandboxed ArtifactPanel. Clicking Close closes the panel without deleting anything. The button is absent when no completed artifact exists. The per-message Open/Reopen button and Creations entry remain unchanged.

## Error Handling and Security

- Internal generation endpoints require the existing per-boot bearer token and remain loopback-only.
- Tool proxies receive no provider credentials; provider adapters retain credential ownership.
- Specialist selection and task capability are revalidated server-side on every call.
- Tool prompts are plain strings with bounded size; no arbitrary provider path, model ID, URL, or thread ID is accepted from the agent.
- Media sources continue through existing SSRF, redirect, MIME, magic-byte, and size checks.
- Unknown tool names, missing specialists, busy specialists, unavailable providers, unsupported tool calling, timeouts, and interruptions return explicit sanitized errors.
- A specialist event cannot change primary busy/session state because it never enters the normal turn-completion fold.

## Testing

1. Store tests cover specialist persistence, optional removal, old bot compatibility, and duplication.
2. Model picker/settings tests cover task filtering across providers, unavailable saved selections, and one selection per specialist slot.
3. Media MCP proxy tests cover advertised tools, authenticated requests, argument validation, disabled tools, and error responses.
4. OpenAI-compatible tests cover function schemas, streamed tool-call accumulation, tool results, continuation, three-call cap, and provider rejection.
5. Server integration tests run a fake primary agent and fake specialist adapter to verify synthetic runtime IDs, visible-thread media folding, primary busy-state isolation, same-instance concurrency, caching, interruption, and timeout cleanup.
6. ChatMarkdown/ChatView tests verify expanded streaming HTML remains expanded across changed text and resets only at the defined lifecycle boundaries.
7. Chat header tests cover absent/open/close behavior and reopening the newest artifact.
8. The full test suite, TypeScript checks, renderer production build, server production build, and diff checks must pass before Electron is relaunched.

## Acceptance Criteria

- Bot Settings exposes Primary agent, Image specialist, and Video specialist selectors.
- Each specialist selector lists matching models from every configured provider and supports removal.
- A primary agent can call its configured image or video specialist as a real tool.
- Specialist media progress and results appear in the same bot conversation and in Creations.
- Primary and specialist turns do not collide or settle each other's busy/session state, including when they share a provider instance.
- Providers that reject tool calling fail explicitly; no keyword-routing fallback occurs.
- Live HTML can be expanded while streaming and stays expanded as tokens arrive.
- The chat header can reopen the newest completed artifact without scrolling to its message.
- Existing direct generation, media caching, artifact sandboxing, and per-message reopen controls continue to work.
