# Agent Media Specialists and Artifact Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each bot's primary agent invoke one optional image specialist and one optional video specialist from any provider, while making live HTML expansion persistent and adding a chat-header artifact control.

**Architecture:** Keep `modelSelection` as the primary agent and add optional specialist selections to bot storage. Deliver media tools through a token-protected stdio MCP proxy for CLI/ACP agents and standard function tools for OpenAI-compatible agents; both call one internal generation endpoint whose specialist runner remaps synthetic runtime events into the visible conversation without settling the primary turn. Lift live HTML expansion into ChatView and reuse the existing artifact selection state for the header control.

**Tech Stack:** React 19, TypeScript 5.8, Node HTTP, raw stdio MCP/JSON-RPC, OpenAI-compatible chat-completions tools, Vitest 4, existing provider registry/event bus/media cache.

## Global Constraints

- Each bot has one primary agent, at most one image specialist, and at most one video specialist.
- Specialist selections may come from any configured provider but must match the slot's declared task.
- The primary agent decides when to invoke media tools; do not add prompt-keyword routing.
- Existing bots with only `modelSelection` remain valid without migration.
- Specialist runtime events appear in the primary conversation but never settle or overwrite the primary turn/session.
- A specialist tool reports success only after at least one media output is safely cached.
- Tool proxies never receive provider credentials or raw provider media URLs.
- Compact live HTML remains the default and expanded state survives streaming token updates.
- The chat header opens or closes the newest completed HTML artifact.
- Existing direct media routing, Creations, per-message Open/Reopen, and artifact sandboxing remain intact.

---

### Task 1: Persist task-specific bot model selections

**Files:**
- Modify: `server/store.ts`
- Modify: `server/store.test.ts`
- Modify: `server/index.ts`
- Modify: `server/index.test.ts`
- Modify: `src/state/store.tsx`

**Interfaces:**
- Produces `BotSpecialists = { image?: ModelSelection; video?: ModelSelection }` on server and renderer Bot records.
- Produces store/PATCH support for `specialists`, including `{ image: null }` or `{ video: null }` removal semantics.

- [ ] **Step 1: Write failing storage and API tests**

Add tests that create a bot, patch image/video specialists, reload the JSON store, remove image with `null`, and duplicate the bot. Assert old fixture bots without `specialists` still load. Add an index API test that PATCHes:

```ts
{
  specialists: {
    image: { instanceId: "openrouter", model: "image-model" },
    video: { instanceId: "ollamaCloud", model: "video-model" }
  }
}
```

and rejects malformed selections such as missing `instanceId` or a non-object slot.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run server/store.test.ts server/index.test.ts`

Expected: FAIL because Bot and PATCH storage do not support `specialists`.

- [ ] **Step 3: Implement typed merge/removal semantics**

Add:

```ts
export interface BotSpecialists {
  image?: ModelSelection;
  video?: ModelSelection;
}
```

Patch only known slots. A valid selection requires non-empty string `instanceId` and `model`; `null` deletes that slot. Remove `specialists` entirely when both slots are empty. Copy specialists during duplication. Mirror the type in the renderer and include it in bot hydration/updates.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run server/store.test.ts server/index.test.ts && pnpm typecheck`

Expected: storage/API tests and TypeScript pass.

- [ ] **Step 5: Commit bot specialist storage**

```bash
git add server/store.ts server/store.test.ts server/index.ts server/index.test.ts src/state/store.tsx
git commit -m "feat: persist bot media specialists"
```

### Task 2: Add task-filtered selectors to Bot Settings

**Files:**
- Modify: `src/components/ModelPicker.tsx`
- Modify: `src/components/SettingsPanel.tsx`
- Create: `src/lib/model-options.ts`
- Create: `src/lib/model-options.test.ts`
- Create: `src/components/ModelTeam.test.tsx`

**Interfaces:**
- Consumes `ModelTask`, `InstanceInfo`, `ModelSelection`, and `BotSpecialists` from renderer state.
- Produces `modelsForTask(instances, task)` and ModelPicker props `task?: ModelTask`, `selection?: ModelSelection`, `optional?: boolean`, `onSelect?: (selection: ModelSelection | null) => void`.

- [ ] **Step 1: Write failing task-filter tests**

```ts
expect(modelsForTask(instances, "chat").map((x) => x.model.id)).toEqual(["chat-a", "legacy-no-task"]);
expect(modelsForTask(instances, "image").map((x) => x.model.id)).toEqual(["image-a"]);
expect(modelsForTask(instances, "video").map((x) => x.model.id)).toEqual(["video-a"]);
```

Add a server-rendered SettingsPanel test asserting **Model team**, **Primary agent**, **Image specialist**, **Video specialist**, and two **Not configured** states.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/lib/model-options.test.ts src/components/ModelTeam.test.tsx`

Expected: FAIL because the task-filter helper and model-team UI do not exist.

- [ ] **Step 3: Generalize ModelPicker without changing header behavior**

Default props preserve the existing primary picker and `setModel` action. Explicit `task="image"` or `task="video"` filters catalog options; `task="chat"` treats missing task as chat. Optional pickers show **Not configured** and a Remove action. Saved unavailable selections remain the trigger label even when absent from the current catalog.

- [ ] **Step 4: Build the Model team settings card**

Replace the single Model row with three labeled rows. Primary dispatches `setModel`. Specialist changes dispatch `updateBot` with a merged `specialists` patch and persist through the existing bot PATCH wrapper. Do not display task-incompatible models in specialist menus.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run src/lib/model-options.test.ts src/components/ModelTeam.test.tsx && pnpm typecheck`

Expected: UI/helper tests and TypeScript pass.

- [ ] **Step 6: Commit model-team settings**

```bash
git add src/components/ModelPicker.tsx src/components/SettingsPanel.tsx src/lib/model-options.ts src/lib/model-options.test.ts src/components/ModelTeam.test.tsx src/state/store.tsx
git commit -m "feat: configure bot model teams"
```

### Task 3: Add the media-specialist MCP proxy

**Files:**
- Create: `server/drivers/media-proxy.ts`
- Create: `server/drivers/media-proxy.test.ts`
- Modify: `server/contracts.ts`
- Modify: `server/drivers/claude.ts`
- Modify: `server/drivers/claude.test.ts`
- Modify: `server/drivers/acp/core.ts`
- Modify: `server/testing/fake-acp-cli.ts`

**Interfaces:**
- Adds `SendTurnInput.integrations.media?: { command: string; args: string[]; env: Record<string,string> }`.
- MCP tools: `generate_image({prompt})` and `generate_video({prompt})`, filtered by `OMB_MEDIA_TASKS`.
- Proxy POST target: `/api/internal/generate-media` with `{ botId, task, prompt, primaryTurnId }`.

- [ ] **Step 1: Write failing proxy contract tests**

Start a fake authenticated HTTP server and spawn the proxy. Assert `tools/list` exposes only tasks in `OMB_MEDIA_TASKS=image` or both for `image,video`; invalid/empty prompts return `isError`; a valid call forwards the exact bot/task/prompt/primary-turn identifiers and returns the endpoint summary; a 401/error response becomes an MCP error result.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run server/drivers/media-proxy.test.ts`

Expected: FAIL because `media-proxy.ts` does not exist.

- [ ] **Step 3: Implement the raw stdio MCP proxy**

Follow `agents-proxy.ts` framing and size discipline. Read `OMB_HARNESS_URL`, `OMB_BOT_ID`, `OMB_INTERNAL_TOKEN`, `OMB_PRIMARY_TURN_ID`, and comma-separated `OMB_MEDIA_TASKS`. Expose no disabled tool. Require a trimmed prompt with a 20,000-character maximum. Send only the internal request fields and render the JSON result as concise text.

- [ ] **Step 4: Mount media MCP in Claude and ACP drivers**

Claude adds `mcpServers.media`, pre-allows `mcp__media`, and preserves current permission behavior. ACP adds the media stdio record to `acpMcpServers`. Extend existing driver tests/fakes to assert the media server arrives with exact command/args/env.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run server/drivers/media-proxy.test.ts server/drivers/claude.test.ts server/drivers/acp/core.test.ts && pnpm typecheck`

If `server/drivers/acp/core.test.ts` does not exist, use the existing ACP driver test files returned by `rg --files server/drivers | rg 'acp.*test|codex.test|grok.test'`.

Expected: proxy and driver integration tests pass.

- [ ] **Step 6: Commit MCP media tools**

```bash
git add server/drivers/media-proxy.ts server/drivers/media-proxy.test.ts server/contracts.ts server/drivers/claude.ts server/drivers/claude.test.ts server/drivers/acp/core.ts server/testing/fake-acp-cli.ts
git commit -m "feat: expose media specialist tools"
```

### Task 4: Run specialist turns and remap their media events

**Files:**
- Create: `server/specialist-runs.ts`
- Create: `server/specialist-runs.test.ts`
- Modify: `server/index.ts`
- Modify: `server/index.test.ts`
- Modify: `server/media-e2e.test.ts`

**Interfaces:**
- Produces `SpecialistRunManager` with `start`, `routeEvent`, `interruptPrimaryTurn`, and `dispose`.
- Internal route accepts only bot ID, task, prompt, and primary turn ID; it resolves with `GenerationToolResult` after media cache readiness.

- [ ] **Step 1: Write failing manager tests**

Use a fake provider adapter to assert:

- generated runtime thread IDs begin `specialist:<botId>:<task>:` and differ from the visible thread;
- image selection cannot run as video and unavailable instances fail explicitly;
- media start/update/completion callbacks receive the visible thread ID;
- specialist `turn.completed` does not call the primary busy/session callbacks;
- success waits for an injected cache promise;
- same provider instance accepts primary and specialist because thread IDs differ;
- duplicate same-task calls are rejected;
- timeout and primary interruption call `interruptTurn(runtimeThreadId)` and clean the registry.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run server/specialist-runs.test.ts`

Expected: FAIL because the manager does not exist.

- [ ] **Step 3: Implement SpecialistRunManager**

Keep orchestration separate from HTTP and store code. Inject registry lookup, model capability lookup, media-event folding, media-cache completion, and clock/timeout functions. Store `primaryTurnId`, visible/runtime thread IDs, task, adapter, promise resolvers, and media message ID. Resolve success only after `turn.completed.ok` and at least one cached-ready output; sanitize errors to 240 characters.

- [ ] **Step 4: Integrate the event bus and internal endpoint**

Before normal event folding, offer raw events to the manager. Consumed specialist events must not broadcast with synthetic thread IDs or enter normal `turn.completed` handling. Reuse extracted media folding functions so direct and specialist generations share pending messages, cache validation, patches, and Creations behavior. Add authenticated `/api/internal/generate-media`; reject missing specialists, task mismatch, empty/oversized prompts, and primary-turn mismatch.

- [ ] **Step 5: Wire primary-turn media integration and interruption**

When a bot has specialists and its primary adapter supports MCP tools, pass the media proxy integration with allowed tasks. Add exact tool guidance to the system prompt. On the bot interrupt route, interrupt the primary adapter and call `interruptPrimaryTurn(primaryTurnId)`. Dispose all specialist runs on provider reload/shutdown.

- [ ] **Step 6: Run integration tests and typecheck**

Run: `pnpm vitest run server/specialist-runs.test.ts server/index.test.ts server/media-e2e.test.ts && pnpm typecheck`

Expected: all focused server tests and TypeScript pass.

- [ ] **Step 7: Commit specialist routing**

```bash
git add server/specialist-runs.ts server/specialist-runs.test.ts server/index.ts server/index.test.ts server/media-e2e.test.ts
git commit -m "feat: route specialist media into chat"
```

### Task 5: Add standard media function tools to OpenAI-compatible agents

**Files:**
- Modify: `server/contracts.ts`
- Modify: `server/drivers/openai-compatible.ts`
- Modify: `server/drivers/openai-compatible.test.ts`

**Interfaces:**
- Extends `integrations.media` with internal endpoint metadata usable by an in-process driver: `url`, `token`, `botId`, `primaryTurnId`, and `tasks`.
- Produces a bounded chat-completions tool loop with standard assistant `tool_calls` and `role: "tool"` result messages.

- [ ] **Step 1: Write failing OpenAI tool-loop tests**

The fake chat server must stream fragmented `delta.tool_calls` for `generate_image`, assert the driver accumulates its JSON arguments, calls a fake internal generation endpoint once, then sends a second chat-completion request containing the original assistant tool call and matching tool result. Add cases for video, disabled tool names, malformed arguments, three-call cap, abort, and a provider 400 response mentioning unsupported `tools`.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run server/drivers/openai-compatible.test.ts`

Expected: new tool-loop assertions fail while current chat/media tests stay green.

- [ ] **Step 3: Parse streamed tool-call deltas**

Accumulate tool calls by `index`, preserving `id`, function name, and concatenated argument fragments. Return `{ text, usage, toolCalls }` from the internal completion helper. Do not execute unknown tools.

- [ ] **Step 4: Implement the capped continuation loop**

When media tasks exist, send standard function schemas. For each supported call, validate `{prompt:string}`, POST to the internal endpoint with bearer token, append the assistant tool-call message and one tool result per call, then request the next completion. Cap total media calls at three. Convert provider rejection of the tools field into `The selected primary model/provider does not support tool calling.` while retaining the sanitized provider detail.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run server/drivers/openai-compatible.test.ts && pnpm typecheck`

Expected: all OpenAI-compatible tests and TypeScript pass.

- [ ] **Step 6: Commit OpenAI tool calling**

```bash
git add server/contracts.ts server/drivers/openai-compatible.ts server/drivers/openai-compatible.test.ts
git commit -m "feat: let api agents invoke media specialists"
```

### Task 6: Persist live HTML expansion and add the header Artifact button

**Files:**
- Modify: `src/components/ChatMarkdown.tsx`
- Modify: `src/components/ChatMarkdown.test.tsx`
- Modify: `src/components/ChatView.tsx`
- Create: `src/lib/artifact-controls.ts`
- Create: `src/lib/artifact-controls.test.ts`

**Interfaces:**
- Adds controlled props `streamingCreationExpanded?: boolean` and `onStreamingCreationExpandedChange?: (expanded: boolean) => void` to ChatMarkdown.
- Produces `artifactHeaderAction(newestArtifactId, selectedArtifactId)` returning `"hidden" | "open" | "close"`.

- [ ] **Step 1: Write failing controlled-state and header-state tests**

Assert ChatMarkdown renders `aria-expanded="true"` and no six-line cap when passed controlled expanded state, even when text changes between renders. Test helper outcomes: no artifact → hidden; newest not selected → open; older selected → open; newest selected → close. Add static ChatView markup coverage for **Open latest artifact** and **Close artifact** labels.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/components/ChatMarkdown.test.tsx src/lib/artifact-controls.test.ts`

Expected: FAIL because controlled props/helper/header control are missing.

- [ ] **Step 3: Lift streaming expansion state to ChatView**

Streaming CodeBlock uses the controlled value/callback when provided and keeps local state only for settled View code. ChatView stores expansion by thread ID, defaults false for a new stream, and clears it when streaming ends, the user interrupts, the active branch changes, or the selected bot changes.

- [ ] **Step 4: Add the header Artifact button**

Place it beside ModelPicker. Hidden without completed artifacts. Open selects the newest artifact; Close sets the thread selection to null. Use `PanelRightOpen`/`PanelRightClose`, visible **Artifact** text where space allows, and exact accessible labels from the spec.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run src/components/ChatMarkdown.test.tsx src/lib/artifact-controls.test.ts && pnpm typecheck`

Expected: artifact-control tests and TypeScript pass.

- [ ] **Step 6: Commit artifact control fixes**

```bash
git add src/components/ChatMarkdown.tsx src/components/ChatMarkdown.test.tsx src/components/ChatView.tsx src/lib/artifact-controls.ts src/lib/artifact-controls.test.ts
git commit -m "fix: preserve live artifact controls"
```

### Task 7: Full verification, generated server output, and local review

**Files:**
- Regenerate: `dist-server/**` with `pnpm build:server`
- Modify if required: only files owned by Tasks 1–6

**Interfaces:**
- Consumes all preceding tasks.
- Produces a clean verified branch and updated Electron preview; no push or PR.

- [ ] **Step 1: Run the full suite with localhost permission**

Run: `pnpm test`

Expected: every test file and test passes. If sandbox localhost binding returns `EPERM`, rerun the identical command with localhost permission rather than changing tests.

- [ ] **Step 2: Run static and production verification**

Run: `pnpm typecheck && pnpm build && pnpm build:server && git diff --check`

Expected: every command exits 0. Vite's existing large-chunk advisory is non-blocking.

- [ ] **Step 3: Commit regenerated server output if changed**

```bash
git add dist-server
git commit -m "build: refresh server output"
```

Skip the commit only if `git status --short dist-server` is empty.

- [ ] **Step 4: Restart exact local listeners and Electron**

Resolve and terminate only listeners on ports 18799 and 5199 plus the current Electron session. Start:

```bash
OMB_PORT=18799 pnpm dev:server
OGB_PORT=18799 pnpm dev -- --host 127.0.0.1 --port 5199
ELECTRON_START_URL=http://127.0.0.1:5199 OGB_PORT=18799 pnpm dev:desktop
```

Verify `/api/health` and `http://127.0.0.1:5199/` return HTTP 200 and Electron remains running.

- [ ] **Step 5: Hand off the local review checklist**

Ask the user to test: Model team selectors across providers; primary-agent image/video tool calls; same-chat progress/output; Creations reopening; live Expand persistence; and the chat-header Artifact control. Keep `codex/model-providers` unpushed until explicit PR approval.
