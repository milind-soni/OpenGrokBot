# Creations Library and Provider Onboarding Design

**Date:** 2026-08-13

**Status:** Approved design

**Scope:** Compact HTML generation, durable creation reopening, and first-run setup for every supported model provider

## Context

OpenMausBot now detects completed HTML code fences as interactive artifacts and renders generated images and videos as first-class chat messages. A newly completed HTML artifact opens beside its conversation, but closing that panel leaves only an easy-to-miss action inside the original code block. While HTML is streaming, the growing source block also consumes too much vertical space.

The first-run flow currently detects Claude Code, Codex, and Grok Build, but it does not expose the newly supported OpenRouter, Ollama Cloud, or custom OpenAI-compatible providers. Users have to discover those options later in App Settings.

This design adds:

- a persistent **Creations** library above Plugins in the sidebar;
- compact streaming and settled HTML creation cards;
- direct reopening of HTML, image, and video outputs;
- optional provider credentials and endpoint setup during onboarding.

## Product Decisions

The user approved these decisions:

- The sidebar entry is named **Creations**.
- Creations includes HTML artifacts, generated images, and generated videos.
- The library is app-wide and groups items by conversation.
- Streaming HTML remains visible but is constrained to a compact six-line viewport.
- Completed HTML collapses into a small creation card with explicit Open and View code actions.
- OpenRouter, Ollama Cloud, and a custom OpenAI-compatible endpoint appear during onboarding.
- Provider setup is optional; users may enter credentials immediately or choose Set up later.

## Goals

1. Make every generated item discoverable after its original message scrolls out of view.
2. Let users reopen a creation with one click from either the message or sidebar.
3. Keep long HTML generation readable without letting source code dominate the conversation.
4. Present all supported model-provider choices during first-run setup.
5. Preserve the existing write-only treatment of secrets and never block onboarding on provider setup.

## Non-goals

- Editing or versioning creations outside their canonical conversation messages.
- Uploading, tagging, deleting, or manually organizing creations.
- Generating thumbnails on the server.
- Adding direct OpenAI or Anthropic API providers beyond the providers already supported by the application.
- Testing provider credentials with billable generation requests.

## Approaches Considered

### 1. Creations library — selected

Add an app-wide Creations panel with HTML, image, and video entries grouped by conversation. This solves reopening for every output type while keeping the source conversation canonical.

### 2. Generations library

Use the same structure under the name Generations. The label is literal for model output, but it is less natural for hand-authored HTML and future non-generative artifacts.

### 3. Studio workspace

Create a richer workspace for browsing and editing outputs. The name is distinctive, but it implies editing and asset-management capabilities outside this scope.

## Creation Index

The Creations library is a derived view over existing bot messages. It does not introduce a second persistence layer.

```ts
type CreationKind = "html" | "image" | "video";

interface CreationEntry {
  id: string;
  kind: CreationKind;
  botId: string;
  threadId: string;
  messageId: string;
  createdAt: number;
  title: string;
  html?: string;
  media?: MediaOutput;
}
```

HTML entries are derived with the existing fenced-code extractor and keep their stable `messageId:blockIndex` identity. Image and video entries are derived from ready media outputs that have a local cache key. Failed, cancelled, and incomplete media items do not appear in the library.

The derivation lives in a focused, pure helper so Sidebar, CreationsPanel, and tests share one definition. Results are sorted newest first and grouped by bot/conversation at presentation time.

## Creations Panel

The sidebar footer gains a **Creations** row immediately above Plugins. The row uses a compact gallery-style icon and may show the number of available creations.

Selecting it opens a right-side panel consistent with Plugins and App Settings. The panel contains:

- filters for All, HTML, Images, and Videos;
- conversation headings with bot name and creation count;
- compact cards with kind, timestamp, and a safe preview;
- an empty state explaining how HTML, image, and video creations appear.

HTML cards use a non-executing visual placeholder in the list. They never render arbitrary HTML in a thumbnail. Image cards load only from the guarded local `/api/media/:cacheKey` route. Video cards use metadata and a video icon instead of autoplaying multiple videos.

Selecting a card switches to its bot and opens the creation:

- HTML opens in the existing sandboxed side-by-side ArtifactPanel.
- Images open in the existing image viewer.
- Videos open in the existing native video viewer/player.

The panel closes after navigation so the selected creation has the main workspace. If the source message or local media file no longer exists, the entry is omitted rather than presenting a broken action.

## Compact HTML Generation

### Streaming

An in-progress HTML fence renders as a compact code card:

- header label: **Building creation…**;
- maximum visible height of approximately six code lines;
- internal scrolling as source grows;
- Expand and Collapse controls;
- existing streaming-safe plain text rendering, without Shiki caching or artifact execution.

Non-HTML code blocks keep the existing streaming behavior. A partial fence does not open ArtifactPanel or enter Creations.

### Completed

A completed HTML fence defaults to a small creation card instead of displaying the full source. Its controls are:

- **Open** or **Reopen** preview;
- **View code** / **Hide code**;
- Copy HTML.

Expanding code uses the existing syntax-highlighted CodeBlock. Closing ArtifactPanel never disables the creation card's Open action. Selection wording is presentational only; reopening always calls the same artifact-selection handler.

The newest completed artifact still opens automatically once. A user-initiated close remains respected until a newer artifact completes or the user explicitly reopens an existing one.

## Cross-Component Opening

Creations can be opened from outside ChatView, so the selected creation request becomes minimal app UI state rather than local ChatView-only state:

```ts
interface OpenCreationRequest {
  requestId: string;
  botId: string;
  messageId: string;
  creationId: string;
  kind: CreationKind;
}
```

The open action selects the bot, closes CreationsPanel, and publishes the request. The active ChatView consumes the latest request once:

- HTML sets the thread's selected artifact ID.
- Image/video asks MediaMessage to open its existing viewer.
- The conversation scrolls the source message into view when practical.

A unique request ID ensures selecting the same creation twice still reopens it. The request contains identifiers only, not HTML, provider URLs, secrets, or filesystem paths.

## Provider Onboarding

The current engine-detection step becomes **Choose your model providers** and keeps the existing local CLI status rows. Below them, an **API and network providers** section presents:

- OpenRouter with an optional API-key field;
- Ollama Cloud with an optional API-key field;
- Custom OpenAI-compatible with base URL, default model ID, and optional bearer token.

Each provider is collapsed by default unless already configured. Expanding a provider reveals the same write-only inputs and validation rules used by App Settings. Saving calls the existing `/api/config` endpoint, refreshes configuration state, clears the secret input, and shows Connected without echoing the saved value.

The step always offers **Continue** and **Set up later**. Neither action requires a configured API provider, because local CLIs or a future Settings change may provide models. Provider save errors stay inline and do not prevent skipping onboarding.

Advanced image/video paths and per-model task overrides remain in App Settings; onboarding collects only the information needed for a typical first connection.

## Error Handling and Accessibility

- Creations filters and cards are keyboard reachable and have explicit kind/name labels.
- Expand/Collapse and Open/Reopen expose their state through accessible labels and `aria-expanded` where applicable.
- Missing cached media does not crash the panel; the entry is omitted on the next derivation and the viewer shows its existing unavailable state if already open.
- Provider inputs identify validation errors inline and retain non-secret text after a failed save.
- Secret fields use password inputs, disable browser autocomplete, and clear after successful persistence.
- Onboarding remains usable without Electron permissions or a running external provider.

## Testing

1. Pure creation-index tests cover HTML/media extraction, stable IDs, ordering, filtering eligibility, and missing cache keys.
2. ChatMarkdown component tests start red for compact streaming HTML, completed creation cards, code expansion, and persistent reopen controls.
3. CreationsPanel tests cover grouping, filters, safe media URLs, empty state, and opening callbacks.
4. Store/ChatView tests cover repeated open requests, bot selection, panel closure, and HTML versus media routing.
5. Onboarding tests cover provider visibility, optional setup, successful write-only saves, inline errors, and Set up later.
6. The full existing suite, TypeScript checks, renderer build, and server build must pass before relaunching Electron.

## Acceptance Criteria

- Creations appears directly above Plugins in the sidebar.
- It lists completed HTML, image, and video outputs across bots and can reopen each one.
- Streaming HTML occupies no more than a compact code viewport unless expanded.
- Completed HTML shows an obvious Open/Reopen button even after the preview panel has been closed.
- Onboarding exposes OpenRouter, Ollama Cloud, and custom OpenAI-compatible setup with immediate-save and Set up later paths.
- Secrets remain write-only and are never returned to the renderer after saving.
- Existing automatic routing, artifact isolation, media caching, and chat behavior remain intact.
