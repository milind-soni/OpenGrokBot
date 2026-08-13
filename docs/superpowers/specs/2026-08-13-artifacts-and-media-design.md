# HTML Artifacts and Generated Media Design

**Date:** 2026-08-13
**Status:** Approved design
**Scope:** HTML artifact previews plus image/video generation and display for OpenRouter and configurable OpenAI-compatible providers

## Context

OpenMausBot currently treats completed provider output as assistant text. Markdown images can render, but generated image and video responses are not normalized, persisted, or presented as first-class chat content. HTML fenced code is shown as source only.

This design adds:

- automatic routing based on the selected model's generation capability;
- first-class image and video messages with durable local caching;
- an automatically opened, side-by-side preview for generated HTML artifacts;
- shared provider contracts that support OpenRouter and configurable OpenAI-compatible endpoints.

The user approved these product decisions:

- Routing is automatic when an image or video model is selected.
- HTML previews use a side-by-side artifact workspace.
- A newly completed HTML artifact opens automatically.
- Generated media is cached in local app data so it survives restarts and expiring provider URLs.

## Goals

1. Make image and video model output appear naturally in the existing conversation timeline.
2. Route a turn to chat, image generation, or video generation without a separate mode switch.
3. Support OpenRouter's native media APIs and reusable OpenAI-compatible conventions.
4. Preserve generated media durably without inflating thread JSON with base64 payloads.
5. Render generated HTML interactively without giving it access to the OpenMausBot document or Electron host.
6. Keep the existing text-provider and transcript-replay behavior unchanged.

## Non-goals

- Image editing, image-to-image, or image-to-video inputs in the first implementation.
- Uploading arbitrary user attachments.
- Audio-generation UI.
- Treating ordinary prose that happens to contain HTML tags as an artifact.
- Guessing generation intent from prompt keywords.
- Supporting provider-specific video APIs that cannot be expressed by the configurable media adapter.

## Approaches Considered

### 1. OpenRouter-only adapters

Implement image and video paths directly in the OpenRouter wrapper. This is the smallest change, but it duplicates normalization logic and does not satisfy the requirement for other compatible providers.

### 2. Pure generic OpenAI-compatible media transport

Assume every provider publishes complete capability metadata and identical endpoints. This keeps the driver simple but fails against real `/models` implementations that expose only model identifiers or use a separate video catalog.

### 3. Capability-driven hybrid — selected

Extend the shared OpenAI-compatible driver with a common media contract, then provide provider-specific discovery and endpoint defaults where needed. OpenRouter supplies richer discovery and native routes; a generic endpoint consumes metadata when present and exposes manual capability/path overrides when it is absent.

This approach keeps routing and response normalization shared without pretending all providers have identical discovery APIs.

## Model Catalog and Automatic Routing

The model catalog will carry an explicit task in addition to its identifier and label:

```ts
type ModelTask = "chat" | "image" | "video";

interface ModelOption {
  id: string;
  label: string;
  task?: ModelTask;
  inputModalities?: Array<"text" | "image" | "audio" | "video">;
  outputModalities?: Array<"text" | "image" | "audio" | "video">;
}
```

`task` is the routing field. Modalities are descriptive metadata for the picker and future attachment support. A selected model routes as follows:

| Task | Request path |
| --- | --- |
| `chat` or absent | Existing `/chat/completions` path |
| `image` | Provider image-generation operation |
| `video` | Provider video-generation operation and status polling |

Unknown models remain `chat` for backward compatibility. Routing never inspects prompt wording. The model picker displays a compact Image or Video badge for non-chat tasks.

### OpenRouter discovery

OpenRouter discovery will:

1. Request the complete model catalog including output modalities.
2. Classify models that produce video as `video`, models that produce images as `image`, and remaining models as `chat`.
3. Merge the dedicated video-model catalog so video-only models are selectable.
4. Deduplicate by model ID while preserving the richer capability record.

OpenRouter currently documents a dedicated image-generation endpoint and an asynchronous video-generation API with a separate video model list:

- <https://openrouter.ai/docs/guides/overview/multimodal/image-generation>
- <https://openrouter.ai/docs/guides/overview/multimodal/video-generation>
- <https://openrouter.ai/docs/api/api-reference/video-generation/list-videos-models>

### Generic OpenAI-compatible discovery

The generic endpoint will preserve recognized task/modality metadata returned by `/models`. Because many compatible servers return only an ID, settings will also allow per-model task overrides and configurable relative paths:

```ts
interface OpenAICompatibleConfig {
  url: string;
  apiKeyEnv: string;
  model: string;
  modelTasks?: Record<string, ModelTask>;
  imagePath?: string; // default: /images/generations
  videoPath?: string; // default: /videos
}
```

Paths must be relative to the validated provider base URL. They may not contain credentials or resolve to a different origin. OpenAI's current model reference exposes `/v1/images/generations` and `/v1/videos` as the conventional media routes:

- <https://developers.openai.com/api/docs/models/gpt-image-2>
- <https://developers.openai.com/api/docs/models/sora-2>

Ollama and vLLM instances that expose text-only model catalogs remain chat providers unless their server returns media capability metadata or the user explicitly overrides a model task.

## Provider Runtime

### Image generation

An image turn sends the user's text as the generation prompt and the selected model ID. The shared normalizer accepts:

- base64 image payloads with an explicit or inferred media type;
- HTTPS or configured-provider URLs;
- one or multiple generated images;
- optional revised prompt and provider metadata.

OpenRouter uses its `/images` operation. Generic providers default to `/images/generations` and can override the relative path.

### Video generation

A video turn creates a job and emits a visible pending media item immediately. The driver polls the provider's job endpoint with capped exponential backoff until the job succeeds, fails, times out, or the user interrupts the turn.

The normalized status sequence is:

```text
queued -> generating -> downloading -> ready
                         \-> failed
queued/generating --------------------> cancelled
```

Provider progress values are retained when available. Polling honors the existing abort controller, sets a bounded overall timeout, and never starts a second poller for the same job.

### Runtime events

The provider event union will gain structured media events rather than encoding media in assistant Markdown:

```ts
type MediaKind = "image" | "video";
type MediaStatus = "queued" | "generating" | "downloading" | "ready" | "failed" | "cancelled";

interface MediaOutput {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  mime?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  progress?: number;
  cacheKey?: string;
  providerUrl?: string;
  error?: string;
}
```

The concrete runtime additions are:

- `item.started` with `itemType: "media"`, kind, and normalized media ID;
- `item.updated` with `itemType: "media"` and the latest status/progress;
- `item.completed` with `itemType: "media"` and one or more normalized outputs.

The server folds these events into one durable bot message per generation turn. Existing assistant-text events are unchanged.

## Message Storage and Media Cache

The message union will add a structured media form:

```ts
interface MediaMessage {
  role: "bot";
  kind: "media";
  text?: string;
  media: MediaOutput[];
}
```

Thread JSON stores metadata and opaque `cacheKey` values only. It does not store raw base64, arbitrary file paths, or provider credentials.

The server owns a media cache under the existing OpenMausBot app-data directory. Each successful generation is written atomically into a generated thread/message directory. Cache operations enforce:

- generated IDs instead of provider filenames;
- canonical-path containment checks;
- MIME allowlists and magic-byte verification;
- configurable download limits, defaulting to 25 MiB per image and 512 MiB per video;
- maximum redirect count;
- rejection of non-HTTP(S) remote URLs;
- private/link-local address rejection unless the resolved URL belongs to the explicitly configured provider origin;
- cleanup of partial files after errors or interruption.

A guarded route on the existing loopback-only server resolves unguessable cache keys and streams files with an exact content type, content length, range support for video seeking, `nosniff`, and a restrictive content-security policy. The route never accepts filesystem paths from the renderer.

Remote media is downloaded as soon as a provider marks the generation complete, before a potentially signed URL expires. Base64 output is decoded through the same validation and atomic-write path.

Cache cleanup is reference-aware. Startup removes stale partial files, and an explicit Clear Generated Media control may remove completed assets after confirmation. Referenced completed assets are not silently evicted by age; if a configured total cache ceiling is reached, new generation fails with an actionable storage message rather than deleting conversation media. Orphaned files that are not referenced by any thread may be removed after a seven-day grace period.

## Chat Media Experience

### Images

- Render inline within the assistant message at the natural aspect ratio.
- Use a bounded maximum height and preserve the full image without cropping.
- Open a larger accessible viewer on click.
- Provide download and copy controls.
- Present multiple images as a responsive grid.

### Videos

- Render an inline native video player with playback controls.
- Show the provider's progress, or an indeterminate generating state when none is supplied.
- Preserve the pending item in the timeline during long-running generation.
- Provide retry for failures and download after completion.
- Use HTTP range requests from the local cache so seeking does not load the entire video into memory.

The UI will not inject provider URLs directly into raw HTML. It consumes only normalized server objects and the guarded local media route after caching completes.

## HTML Artifact Experience

### Detection and identity

Only completed fenced code blocks labeled `html`, `htm`, or `html_preview` are artifacts. Each artifact is derived from the assistant message and identified by message ID plus block index, so the HTML source remains part of the canonical conversation rather than being duplicated in a second store.

Artifact extraction runs while rendering, but automatic opening waits until the assistant message is complete and the closing fence exists. If a response contains several HTML blocks, the newest block opens; every block retains a Preview/Reopen action.

### Side-by-side layout

- Opening an artifact divides the main workspace into chat and preview regions.
- The default split favors chat slightly; a keyboard-accessible draggable divider resizes it.
- The most recent width is persisted as a UI preference.
- Switching threads restores that thread's selected artifact when it still exists.
- Closing the panel returns the chat to full width without deleting the artifact.
- Narrow windows use a full-window preview with an explicit back action.

The preview toolbar includes the artifact name, refresh, copy HTML, download HTML, and close controls.

### Isolation

Artifacts render through `iframe.srcdoc` with a sandboxed opaque origin. The iframe may execute scripts for interactive prototypes but does not receive `allow-same-origin`, a host bridge, popups, downloads, or top-level navigation rights.

An injected CSP disables forms, popups, top-level navigation, and access to local-file URLs. Inline/generated scripts and explicitly referenced HTTP(S) assets may run so interactive prototypes and common web assets work; the preview toolbar clearly indicates that external resources can make network requests. The iframe's opaque origin and sandbox prevent those resources from reading the parent DOM or invoking Electron APIs. The app never uses `dangerouslySetInnerHTML` for the surrounding chat document. Messages from the iframe are ignored unless a future, separately designed bridge defines a narrow schema and origin-independent capability token.

## Error Handling

- Missing model capability: route as chat and allow a settings override.
- Unsupported image/video endpoint: retain a failed media message with the provider's sanitized error and Retry.
- Video poll timeout: retain the provider job ID in opaque metadata for diagnostics but stop polling.
- Cache validation failure: do not display the remote URL; report that the generated asset could not be stored safely.
- Missing cached file after restart: show an unavailable placeholder rather than silently deleting message history.
- Artifact parse failure: keep the HTML source visible and leave the prior preview open.

Provider error bodies and URLs are bounded before persistence and must not expose authorization headers or API keys.

## Compatibility and Migration

- `task` is optional in model catalogs, so every existing driver compiles as chat-only during incremental migration.
- Existing text messages and persisted thread files remain valid.
- Existing Markdown image rendering remains available for ordinary assistant-authored links; generated media uses the structured message path.
- The generic driver's existing `url`, `apiKeyEnv`, and `model` config values remain unchanged. New media settings are optional.
- Compiled `dist-server` output must be regenerated after source changes, matching the repository's current distribution pattern.

## Verification Strategy

### Unit tests

- OpenRouter and generic model capability normalization.
- Task override precedence and unknown-model chat fallback.
- Route selection for chat, image, and video tasks.
- Image response parsing for base64, URL, MIME type, and multiple outputs.
- Video job creation, progress updates, success, failure, timeout, and interruption.
- Media cache size limits, signature checks, redirects, private-host policy, atomic cleanup, and path containment.
- Reference-aware cache cleanup, total-cache exhaustion, and stale partial-file removal.
- Runtime-event folding into structured media messages.
- HTML fence extraction, stable artifact IDs, and automatic selection of the newest completed artifact.

### Component tests

- Image grid, viewer controls, alt text, keyboard operation, and failed state.
- Video pending/progress/player/retry states.
- Model task badges and generic task overrides.
- Artifact automatic opening, switching, resizing, closing, and reopening.
- Responsive fallback from split view to the full-window preview.

### Integration tests

- Mock OpenRouter image and asynchronous video endpoints end to end.
- Mock generic OpenAI-compatible image/video endpoints with path overrides.
- Restart persistence with cached image and range-served video.
- Generated scripts cannot read the parent DOM, invoke Electron APIs, open popups, or navigate the host.

### Repository checks

- Full test suite.
- TypeScript typecheck.
- Renderer build.
- Server distribution build.
- Manual Electron smoke test covering one HTML artifact, one image response, one video response, thread switching, restart persistence, and cancellation.

## Delivery Boundary

Implementation stays on `codex/model-providers` until the user finishes the Electron smoke test. No push or pull request is created without the user's confirmation.
