# Generated Image and Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically route selected image/video models to generation APIs, cache their output, and render durable media messages in chat.

**Architecture:** Extend model catalogs and runtime events with explicit media types, then keep provider request normalization in the shared OpenAI-compatible driver. The server folds media events into structured messages and owns a guarded filesystem cache; the React client receives only metadata and loopback cache URLs.

**Tech Stack:** TypeScript 5.8, Node.js 24 APIs, Vitest, React 19, Tailwind CSS 4, OpenAI-compatible HTTP APIs, SSE

## Global Constraints

- Routing is determined by the selected model's declared task, never prompt keywords.
- Unknown or unannotated models remain chat models.
- Existing text messages, provider drivers, and saved thread files remain valid.
- Store cache keys only; never persist base64 media, arbitrary paths, credentials, or authorization headers.
- Default limits are 25 MiB per image and 512 MiB per video.
- Media downloads accept HTTP(S) only and private/link-local destinations only for the configured provider origin.
- Source changes must regenerate matching `dist-server` output.
- No push or pull request before the user approves the Electron smoke test.

---

## File Structure

- Modify `server/contracts.ts`: canonical model capability, media output, and runtime event types.
- Modify `server/drivers/openai-compatible.ts`: capability discovery, automatic routing, image generation, and video polling.
- Modify `server/drivers/openrouter.ts`: OpenRouter discovery and media endpoint defaults.
- Modify `server/drivers/openai-endpoint.ts`: generic configurable task/path defaults.
- Modify `server/config.ts`: persist generic task overrides and endpoint paths.
- Create `server/media-cache.ts`: validated atomic media storage, cleanup, and range helpers.
- Create `server/media-cache.test.ts`: filesystem and validation tests.
- Modify `server/store.ts`: structured media message persistence.
- Modify `server/index.ts`: media event folding and guarded cache streaming route.
- Modify `server/drivers/openai-compatible.test.ts`: provider discovery/routing/normalization tests.
- Modify `server/store.test.ts` and `server/index.test.ts`: persistence and serving integration tests.
- Create `src/components/MediaMessage.tsx`: image, video, pending, failure, viewer, and download UI.
- Modify `src/components/ChatView.tsx`: render structured media messages.
- Modify `src/components/ModelPicker.tsx`: task badges.
- Modify `src/components/AppSettingsPanel.tsx`: generic media task/path overrides.
- Modify `src/state/store.tsx`: client model/message/config shapes and SSE folding.
- Modify `README.md`: document automatic media routing and generic override syntax.

### Task 1: Canonical capability and media contracts

**Files:**
- Modify: `server/contracts.ts`
- Modify: `src/state/store.tsx`
- Test: `server/drivers/openai-compatible.test.ts`

**Interfaces:**
- Produces: `ModelTask`, `ModelOption`, `MediaKind`, `MediaStatus`, `MediaSource`, and `MediaOutput`.
- Produces: media variants of `item.started`, `item.updated`, and `item.completed`.
- Consumes: existing `RuntimeEventBase`, `ModelCatalog`, and persisted `Message` shapes.

- [ ] **Step 1: Add a failing catalog compatibility test**

Add an image-capable and video-capable model to the fake `/models` payload and assert the live catalog keeps routing metadata:

```ts
expect(instance.models.options).toContainEqual({
  id: "image-model",
  label: "Image model",
  task: "image",
  outputModalities: ["text", "image"],
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run server/drivers/openai-compatible.test.ts`

Expected: FAIL because `ModelOption` and discovery currently retain only `id` and `label`.

- [ ] **Step 3: Define the shared contracts**

Export these shapes from `server/contracts.ts` and reuse them in the client mirror:

```ts
export type ModelTask = "chat" | "image" | "video";
export type MediaKind = "image" | "video";
export type MediaStatus = "queued" | "generating" | "downloading" | "ready" | "failed" | "cancelled";

export interface ModelOption {
  id: string;
  label: string;
  task?: ModelTask;
  inputModalities?: string[];
  outputModalities?: string[];
}

export type MediaSource =
  | { type: "base64"; data: string; mime?: string }
  | { type: "url"; url: string; mime?: string };

export interface MediaOutput {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  mime?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  progress?: number;
  cacheKey?: string;
  source?: MediaSource;
  providerJobId?: string;
  error?: string;
}
```

Change `ModelCatalog.options` to `ModelOption[]`. Add media event variants with `itemId`, `media`, and status/progress fields. Add `kind: "media"` and `media?: MediaOutput[]` to both server and client `Message` definitions without removing any legacy fields.

- [ ] **Step 4: Make the focused test compile and pass**

Run: `pnpm vitest run server/drivers/openai-compatible.test.ts`

Expected: PASS for existing chat behavior and the new capability assertion.

- [ ] **Step 5: Commit the contract slice**

```bash
git add server/contracts.ts src/state/store.tsx server/drivers/openai-compatible.test.ts server/drivers/openai-compatible.ts
git commit -m "feat: add media generation contracts"
```

### Task 2: Provider discovery and automatic media routing

**Files:**
- Modify: `server/drivers/openai-compatible.ts`
- Modify: `server/drivers/openrouter.ts`
- Modify: `server/drivers/openai-endpoint.ts`
- Modify: `server/config.ts`
- Modify: `server/config.test.ts`
- Test: `server/drivers/openai-compatible.test.ts`

**Interfaces:**
- Consumes: `ModelTask`, `ModelOption`, `MediaOutput`, and media runtime events from Task 1.
- Produces: `OpenAICompatibleConfig.modelTasks`, `imagePath`, and `videoPath`.
- Produces: `OpenAICompatibleDriverSpec.modelQuery`, `videoModelsPath`, `imagePath`, and `videoPath`.

- [ ] **Step 1: Extend the fake API with image and asynchronous video endpoints**

Use deterministic fixtures:

```ts
if (request.url === "/v1/images/generations") {
  return json(res, 200, { data: [{ b64_json: TINY_PNG_BASE64, media_type: "image/png" }] });
}
if (request.method === "POST" && request.url === "/v1/videos") {
  return json(res, 200, { id: "video-job-1", status: "queued" });
}
if (request.method === "GET" && request.url === "/v1/videos/video-job-1") {
  return json(res, 200, { id: "video-job-1", status: "completed", content_url: `${baseUrl}/video.mp4` });
}
```

Add one test selecting an image task and one selecting a video task. Assert that no `/chat/completions` request occurs, media lifecycle events are emitted, and the final event contains a base64 or URL source respectively.

- [ ] **Step 2: Run the route tests and verify failure**

Run: `pnpm vitest run server/drivers/openai-compatible.test.ts`

Expected: FAIL because every selected model currently routes to chat completions.

- [ ] **Step 3: Decode safe media configuration**

Accept `modelTasks` values only from `chat`, `image`, and `video`. Normalize `imagePath` and `videoPath` as same-origin relative paths beginning with `/`; reject absolute URLs, credentials, query-only values, `..` segments, and fragments.

Use these defaults:

```ts
imagePath: "/images/generations",
videoPath: "/videos",
```

Add config tests for valid overrides, invalid task values, and cross-origin/parent traversal attempts.

- [ ] **Step 4: Preserve discovered capability metadata**

Implement a pure classifier with override precedence:

```ts
export function inferModelTask(
  id: string,
  outputModalities: string[],
  overrides: Record<string, ModelTask>,
): ModelTask {
  if (overrides[id]) return overrides[id];
  if (outputModalities.includes("video")) return "video";
  if (outputModalities.includes("image")) return "image";
  return "chat";
}
```

Read modalities from top-level `output_modalities` and OpenRouter's `architecture.output_modalities`. Query OpenRouter's `/models?output_modalities=all`, merge `/videos/models`, and mark the latter as `video`. Generic providers use their returned metadata plus `modelTasks` overrides.

- [ ] **Step 5: Add image generation**

For an image task, POST `{ model, prompt }` to the configured image path. Normalize every `data[]` item containing `b64_json` or `url` into `MediaOutput`, emit `item.started`, then emit `item.completed` with the outputs. Reject an empty or unrecognized response with a bounded provider error.

- [ ] **Step 6: Add interruptible video polling**

POST `{ model, prompt }` to the video path, retain the returned job ID, and poll `${videoPath}/${encodeURIComponent(jobId)}`. Map provider statuses to the canonical status union. Use 500 ms, 1 s, 2 s, then capped 5 s delays and a 20-minute total ceiling. Every delay must listen to the active turn's abort signal. Emit `item.updated` only when status or progress changes and return a URL source from `content_url`, `url`, or completed `data`.

- [ ] **Step 7: Configure provider-specific defaults**

OpenRouter uses:

```ts
modelQuery: "?output_modalities=all",
videoModelsPath: "/videos/models",
imagePath: "/images",
videoPath: "/videos",
```

The generic endpoint uses the conventional defaults. Ollama Cloud remains chat unless discovery reports media output.

- [ ] **Step 8: Run provider and config tests**

Run: `pnpm vitest run server/drivers/openai-compatible.test.ts server/config.test.ts`

Expected: PASS, including chat regression, task overrides, image route, video polling, failure, and interruption.

- [ ] **Step 9: Commit provider routing**

```bash
git add server/contracts.ts server/config.ts server/config.test.ts server/drivers/openai-compatible.ts server/drivers/openai-compatible.test.ts server/drivers/openrouter.ts server/drivers/openai-endpoint.ts
git commit -m "feat: route image and video models"
```

### Task 3: Validated media cache

**Files:**
- Create: `server/media-cache.ts`
- Create: `server/media-cache.test.ts`
- Modify: `server/config.ts`

**Interfaces:**
- Consumes: `MediaKind` and `MediaSource` from Task 1.
- Produces: `createMediaCache(options)`, `MediaCache.store(source, context)`, `MediaCache.resolve(cacheKey)`, `MediaCache.removeStalePartials()`, and `parseRange(header, size)`.

- [ ] **Step 1: Write cache tests using an isolated temporary directory**

Cover base64 PNG storage, magic-byte mismatch, oversize input, atomic cleanup after a failed write, opaque key resolution, traversal rejection, stale `.part` cleanup, and byte-range parsing:

```ts
const stored = await cache.store(
  { type: "base64", data: TINY_PNG_BASE64, mime: "image/png" },
  { threadId: "thread-1", messageId: "message-1", kind: "image", providerOrigin: new URL("http://127.0.0.1:11434") },
);
expect(cache.resolve(stored.cacheKey)).toMatchObject({ mime: "image/png" });
expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
```

- [ ] **Step 2: Run cache tests and verify failure**

Run: `pnpm vitest run server/media-cache.test.ts`

Expected: FAIL because the cache module does not exist.

- [ ] **Step 3: Implement atomic local storage**

Create generated cache keys from safe UUID components, stream/decode into a `.part` file, enforce limits while writing, verify PNG/JPEG/WebP/GIF/MP4/WebM signatures, rename atomically, and return `{ cacheKey, mime, bytes }`. Resolve keys only after canonical containment under `MEDIA_DIR`.

- [ ] **Step 4: Implement guarded remote downloads**

Resolve DNS before each request and redirect. Reject loopback/private/link-local IPs unless the original URL origin equals the configured provider origin. Limit redirects to three, strip authorization when the origin changes, enforce content length and streamed byte count, and accept only recognized image/video MIME types.

- [ ] **Step 5: Implement cleanup and range helpers**

Delete `.part` files older than 24 hours at startup. Keep completed referenced files. Expose strict single-range parsing for `bytes=start-end`, suffix ranges, invalid ranges, and unsatisfiable ranges.

- [ ] **Step 6: Run cache tests**

Run: `pnpm vitest run server/media-cache.test.ts`

Expected: PASS with no leftover partial files.

- [ ] **Step 7: Commit the cache**

```bash
git add server/config.ts server/media-cache.ts server/media-cache.test.ts
git commit -m "feat: add durable media cache"
```

### Task 4: Fold media events and serve cached assets

**Files:**
- Modify: `server/store.ts`
- Modify: `server/store.test.ts`
- Modify: `server/index.ts`
- Modify: `server/index.test.ts`

**Interfaces:**
- Consumes: `MediaOutput` events from Task 2 and `MediaCache` from Task 3.
- Produces: persisted `kind: "media"` messages and `GET /api/media/:cacheKey` with range support.

- [ ] **Step 1: Write persistence and event-folding tests**

Persist a media message, construct a fresh `Store`, and assert status, dimensions, and cache key survive while `source` is stripped. In the server integration fixture, emit `item.started`, `item.updated`, and `item.completed` and assert SSE sends message creation followed by patches.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm vitest run server/store.test.ts server/index.test.ts`

Expected: FAIL because media messages and the media route do not exist.

- [ ] **Step 3: Add server-side media folding**

Track `itemId -> messageId` like tool items. On start, append a queued media message. On update, patch its status/progress. On completion, mark it downloading, cache every source, strip every raw source/provider URL before persistence and SSE broadcast, then patch ready or failed. Do not broadcast runtime media sources in the generic runtime frame.

- [ ] **Step 4: Add the cache streaming route**

Implement `GET /api/media/:cacheKey`. Return `404` for unknown keys, `416` for an unsatisfiable range, `206` with `Content-Range` for valid ranges, and `200` otherwise. Always send `Accept-Ranges: bytes`, `X-Content-Type-Options: nosniff`, the verified MIME type, and exact content length.

- [ ] **Step 5: Run persistence and server tests**

Run: `pnpm vitest run server/store.test.ts server/index.test.ts server/media-cache.test.ts`

Expected: PASS, including a range request whose body equals the selected bytes.

- [ ] **Step 6: Commit server integration**

```bash
git add server/store.ts server/store.test.ts server/index.ts server/index.test.ts server/media-cache.ts
git commit -m "feat: persist and serve generated media"
```

### Task 5: Chat media UI and provider settings

**Files:**
- Create: `src/components/MediaMessage.tsx`
- Modify: `src/components/ChatView.tsx`
- Modify: `src/components/ModelPicker.tsx`
- Modify: `src/components/AppSettingsPanel.tsx`
- Modify: `src/state/store.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: client `Message.media`, model `task`, and `/api/media/:cacheKey` from prior tasks.
- Produces: `MediaMessage` React component and generic provider task/path settings.

- [ ] **Step 1: Mirror the server wire types in the client store**

Add `MediaOutput`, `ModelTask`, task-aware model options, and the `media` message kind. Preserve unknown fields while hydrating. Extend safe config status with `modelTasks`, `imagePath`, and `videoPath` but never echo the key.

- [ ] **Step 2: Render media lifecycle states**

Create `MediaMessage.tsx` with these exact branches:

```tsx
if (media.every((item) => item.status === "failed" || item.status === "cancelled")) return <MediaFailure ... />;
if (media.some((item) => item.status !== "ready")) return <MediaProgress ... />;
return kind === "video" ? <VideoPlayer ... /> : <ImageGrid ... />;
```

Use native `<video controls preload="metadata">`, lazy `<img>`, descriptive alt text, a keyboard-accessible image viewer, and same-origin download links. Multiple images form a responsive grid. Retry dispatches the existing last-user-message regeneration path.

- [ ] **Step 3: Wire chat rendering**

Add a `case "media"` branch in `ChatView` and pass `onRetry` only for the active branch's latest failed media message while the bot is idle. Media bubbles use up to 85% transcript width so landscape content remains usable.

- [ ] **Step 4: Add model task badges**

Display a compact Image or Video badge in the model list and the selected-model button. Do not badge chat or unknown models. Include the task text in the model button's accessible title.

- [ ] **Step 5: Add generic task/path settings**

Add image path and video path inputs plus a textarea using one override per line:

```text
stable-diffusion-xl=image
wan-2.2=video
```

Parse only `model=chat|image|video`, show a local validation message for invalid lines, and serialize valid values to `modelTasks` in `PUT /api/config`.

- [ ] **Step 6: Document media routing**

Explain picker badges, automatic routing, the conventional generic paths, override syntax, local caching, size defaults, and the fact that vLLM/Ollama remain chat-only unless their server reports or is assigned a media task.

- [ ] **Step 7: Run UI typecheck and focused server tests**

Run: `pnpm typecheck`

Run: `pnpm vitest run server/drivers/openai-compatible.test.ts server/media-cache.test.ts server/store.test.ts server/index.test.ts`

Expected: all commands PASS.

- [ ] **Step 8: Commit the client experience**

```bash
git add src/components/MediaMessage.tsx src/components/ChatView.tsx src/components/ModelPicker.tsx src/components/AppSettingsPanel.tsx src/state/store.tsx README.md
git commit -m "feat: display generated media in chat"
```

### Task 6: Distribution build and media regression gate

**Files:**
- Modify: `dist-server/**` through the repository build command

**Interfaces:**
- Consumes: all source changes from Tasks 1–5.
- Produces: distributable server JavaScript and a verified renderer bundle.

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm test`

Expected: all tests PASS.

- [ ] **Step 2: Run static verification**

Run: `pnpm typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Build renderer and server distribution**

Run: `pnpm build`

Run: `pnpm build:server`

Expected: both commands PASS and `dist-server` reflects the media source modules.

- [ ] **Step 4: Commit generated server output**

```bash
git add dist-server
git commit -m "build: compile media generation server"
```
