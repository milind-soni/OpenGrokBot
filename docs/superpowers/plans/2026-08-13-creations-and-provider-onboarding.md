# Creations and Provider Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an app-wide Creations library, compact and reopenable HTML creation cards, and optional OpenRouter/Ollama Cloud/OpenAI-compatible setup during onboarding.

**Architecture:** Derive a read-only creation index from canonical bot messages, and route open requests through minimal UI state so the library can select the source bot and reuse ChatView's sandboxed artifact/media viewers. Extract reusable provider setup controls from App Settings so onboarding and settings share the same persistence and write-only secret behavior.

**Tech Stack:** React 19, TypeScript 5.8, Tailwind CSS 4, Vitest 4, react-markdown, lucide-react, existing loopback `/api/config` and `/api/media/:cacheKey` APIs.

## Global Constraints

- The sidebar label is exactly **Creations** and appears immediately above Plugins.
- Creations contains completed HTML, image, and video outputs across all bots, grouped by conversation.
- HTML execution remains limited to the existing opaque-origin iframe with `sandbox="allow-scripts"`.
- The streaming HTML viewport shows approximately six lines until explicitly expanded.
- Onboarding provider configuration is optional and always offers **Set up later**.
- Provider secrets remain write-only, use password inputs, and clear after successful save.
- Advanced image/video paths and model-task overrides remain in App Settings only.
- Do not add a second persistence store for creations; derive them from canonical messages.

---

### Task 1: Derive a safe app-wide creation index

**Files:**
- Create: `src/lib/creations.ts`
- Create: `src/lib/creations.test.ts`

**Interfaces:**
- Consumes: `Bot`, `MediaOutput`, `visibleMessages` from `src/state/store.tsx`; `extractHtmlArtifacts` from `src/lib/html-artifacts.ts`.
- Produces: `CreationKind`, `CreationEntry`, and `deriveCreations(bots: Bot[]): CreationEntry[]` sorted newest first.

- [ ] **Step 1: Write failing extraction tests**

```ts
it("derives settled HTML and ready cached media from visible conversations", () => {
  const creations = deriveCreations([botWithHtmlAndMedia]);
  expect(creations.map(({ id, kind }) => ({ id, kind }))).toEqual([
    { id: "media-message:video-1", kind: "video" },
    { id: "media-message:image-1", kind: "image" },
    { id: "html-message:0", kind: "html" },
  ]);
});

it("omits failed, pending, uncached, and inactive-branch outputs", () => {
  expect(deriveCreations([botWithInvalidOutputs]).map((item) => item.id)).toEqual(["visible-html:0"]);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run src/lib/creations.test.ts`

Expected: FAIL because `src/lib/creations.ts` does not exist.

- [ ] **Step 3: Implement the pure index**

```ts
export type CreationKind = "html" | "image" | "video";

export interface CreationEntry {
  id: string;
  kind: CreationKind;
  botId: string;
  botName: string;
  threadId: string;
  messageId: string;
  createdAt: number;
  title: string;
  html?: string;
  media?: MediaOutput;
}

export function deriveCreations(bots: Bot[]): CreationEntry[] {
  return bots
    .flatMap((bot) => visibleMessages(bot).flatMap((message) => {
      if (message.role === "bot" && message.kind === "text" && message.text) {
        return extractHtmlArtifacts(message.text, message.id).map((artifact) => ({
          id: artifact.id,
          kind: "html" as const,
          botId: bot.id,
          botName: bot.name,
          threadId: bot.threadId,
          messageId: message.id,
          createdAt: message.at,
          title: `artifact-${artifact.index + 1}.html`,
          html: artifact.html,
        }));
      }
      if (message.role === "bot" && message.kind === "media") {
        return (message.media ?? [])
          .filter((media) => media.status === "ready" && Boolean(media.cacheKey))
          .map((media, index) => ({
            id: `${message.id}:${media.id}`,
            kind: media.kind,
            botId: bot.id,
            botName: bot.name,
            threadId: bot.threadId,
            messageId: message.id,
            createdAt: message.at,
            title: `Generated ${media.kind} ${index + 1}`,
            media,
          }));
      }
      return [];
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run src/lib/creations.test.ts`

Expected: 2 tests pass.

- [ ] **Step 5: Commit the index**

```bash
git add src/lib/creations.ts src/lib/creations.test.ts
git commit -m "feat: derive conversation creations"
```

### Task 2: Add creation navigation state and the Creations panel

**Files:**
- Modify: `src/state/store.tsx`
- Create: `src/lib/creation-navigation.ts`
- Create: `src/lib/creation-navigation.test.ts`
- Create: `src/components/CreationsPanel.tsx`
- Create: `src/components/CreationsPanel.test.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `CreationEntry` and `deriveCreations` from Task 1.
- Produces: `OpenCreationRequest`, `creationOpenRequest`, `openCreationRequest`, `creationsOpen`, actions `toggleCreations` and `openCreation`, and `<CreationsPanel />`.

- [ ] **Step 1: Write failing navigation and panel tests**

```ts
it("builds a repeatable open request without copying creation payloads", () => {
  const first = creationOpenRequest(entry, "request-1");
  const second = creationOpenRequest(entry, "request-2");
  expect(first).toMatchObject({ requestId: "request-1", botId: "bot-1", messageId: "m-1", creationId: entry.id });
  expect(second.requestId).not.toBe(first.requestId);
  expect(JSON.stringify(first)).not.toContain("<html");
  expect(JSON.stringify(first)).not.toContain("cacheKey");
});

it("renders filters, grouped conversations, and guarded media URLs", () => {
  const html = renderToStaticMarkup(<CreationsPanel creations={entries} onOpen={() => {}} onClose={() => {}} />);
  expect(html).toContain("Creations");
  expect(html).toContain("All");
  expect(html).toContain("HTML");
  expect(html).toContain("Images");
  expect(html).toContain("Videos");
  expect(html).toContain("/api/media/cache-image.png");
  expect(html).not.toContain("<iframe");
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm vitest run src/lib/creation-navigation.test.ts src/components/CreationsPanel.test.tsx`

Expected: FAIL because the helper and panel do not exist.

- [ ] **Step 3: Add identifier-only navigation state**

```ts
export interface OpenCreationRequest {
  requestId: string;
  botId: string;
  messageId: string;
  creationId: string;
  kind: CreationKind;
}

export const creationOpenRequest = (entry: CreationEntry, requestId = crypto.randomUUID()): OpenCreationRequest => ({
  requestId,
  botId: entry.botId,
  messageId: entry.messageId,
  creationId: entry.id,
  kind: entry.kind,
});
```

Add `creationsOpen: boolean` and `openCreationRequest: OpenCreationRequest | null` to AppState. `toggleCreations` must close Plugins, Settings, App Settings, and Computer when opening. `openCreation` must select the entry's bot, close Creations, and replace the request even when the same creation is selected twice.

- [ ] **Step 4: Implement the panel and sidebar entry**

`CreationsPanel` accepts derived entries and callbacks, keeps only the active filter locally, groups filtered entries by bot ID, renders HTML as an inert code icon, image thumbnails from `/api/media/:cacheKey`, and video placeholders without autoplay. Add the Sidebar row directly above Plugins and render the panel from `App.tsx`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run src/lib/creation-navigation.test.ts src/components/CreationsPanel.test.tsx && pnpm typecheck`

Expected: focused tests and TypeScript pass.

- [ ] **Step 6: Commit navigation and panel**

```bash
git add src/state/store.tsx src/lib/creation-navigation.ts src/lib/creation-navigation.test.ts src/components/CreationsPanel.tsx src/components/CreationsPanel.test.tsx src/components/Sidebar.tsx src/App.tsx
git commit -m "feat: add creations library"
```

### Task 3: Make HTML generation compact and permanently reopenable

**Files:**
- Modify: `src/lib/html-artifacts.ts`
- Modify: `src/lib/html-artifacts.test.ts`
- Modify: `src/components/ChatMarkdown.tsx`
- Create: `src/components/ChatMarkdown.test.tsx`
- Modify: `src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `OpenCreationRequest` from Task 2 and existing `HtmlArtifact`.
- Produces: `findStreamingHtmlFence(markdown: string): { code: string; language: string } | null`; settled HTML creation card; ChatView consumption of HTML open requests.

- [ ] **Step 1: Write failing parser and render tests**

```ts
it("finds the unfinished HTML fence at the end of a stream", () => {
  expect(findStreamingHtmlFence("Intro\n```html\n<section>work"))
    .toEqual({ language: "html", code: "<section>work" });
  expect(findStreamingHtmlFence("```js\nwork")).toBeNull();
  expect(findStreamingHtmlFence("```html\nready\n```" )).toBeNull();
});

it("renders streaming HTML in a compact expandable creation card", () => {
  const html = renderToStaticMarkup(<ChatMarkdown text={longPartialHtml} streaming />);
  expect(html).toContain("Building creation");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("max-h-");
});

it("renders completed HTML as a collapsed card with a permanent Open action", () => {
  const html = renderToStaticMarkup(<ChatMarkdown text={completeHtml} messageId="m-1" onPreviewArtifact={() => {}} />);
  expect(html).toContain("HTML creation");
  expect(html).toContain("Open");
  expect(html).toContain("View code");
  expect(html).not.toContain("&lt;main&gt;");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/lib/html-artifacts.test.ts src/components/ChatMarkdown.test.tsx`

Expected: FAIL because unfinished-fence detection and compact cards are missing.

- [ ] **Step 3: Implement unfinished HTML detection and compact CodeBlock variants**

Add a streaming-only detector that recognizes `html`, `htm`, and `html_preview` fences only when no matching closing fence has arrived. In `CodeBlock`, add local expanded state. Streaming HTML uses the **Building creation…** label and a six-line `max-height` with internal scrolling. Settled HTML renders a compact **HTML creation** summary card until View code is selected; its Open/Reopen action is always present and calls `onPreview(artifact)`.

- [ ] **Step 4: Consume HTML open requests in ChatView**

When the active request matches the bot and `kind === "html"`, find the stable artifact ID in the derived thread artifacts and set it as selected. Tag message rows with `data-message-id` and call `scrollIntoView({ block: "center" })` after the request is consumed. Track the last request ID in a ref so repeated clicks with new request IDs reopen the same artifact.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run src/lib/html-artifacts.test.ts src/components/ChatMarkdown.test.tsx && pnpm typecheck`

Expected: focused tests and TypeScript pass.

- [ ] **Step 6: Commit compact artifact UX**

```bash
git add src/lib/html-artifacts.ts src/lib/html-artifacts.test.ts src/components/ChatMarkdown.tsx src/components/ChatMarkdown.test.tsx src/components/ChatView.tsx
git commit -m "feat: compact and reopen html creations"
```

### Task 4: Reopen image and video creations from the library

**Files:**
- Modify: `src/components/MediaMessage.tsx`
- Modify: `src/components/MediaMessage.test.tsx`
- Modify: `src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `requestedMediaId?: string` and `openRequestId?: string` from ChatView.
- Produces: media viewer dialog for both images and videos, opened by direct click or an external creation request.

- [ ] **Step 1: Write failing media viewer tests**

```ts
it("marks ready media as externally reopenable", () => {
  const html = renderToStaticMarkup(<MediaMessage message={readyMediaMessage} requestedMediaId="video-1" openRequestId="request-1" />);
  expect(html).toContain('data-media-id="video-1"');
  expect(html).toContain("Open video viewer");
});

it("renders a video in the shared viewer shell", () => {
  const html = renderToStaticMarkup(<MediaViewer media={readyVideo} onClose={() => {}} />);
  expect(html).toContain('role="dialog"');
  expect(html).toContain("Generated video viewer");
  expect(html).toContain("<video");
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `pnpm vitest run src/components/MediaMessage.test.tsx`

Expected: FAIL because the external request props and video viewer do not exist.

- [ ] **Step 3: Implement the shared viewer and request effect**

Export a `MediaViewer` that renders either an image or native `<video controls autoPlay>` from the guarded cache route. Add explicit Open viewer buttons to both inline image and video cards. In `MediaMessage`, react to a new `openRequestId` by selecting the ready output whose ID matches `requestedMediaId`; ignore pending, failed, or uncached outputs.

- [ ] **Step 4: Route media requests from ChatView**

For the message matching an active image/video creation request, resolve the request's creation ID through `deriveCreations([bot])`, then pass its `media.id` as `requestedMediaId` with `openRequestId`. Scroll the source message into view using the same request-consumption behavior as HTML.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run src/components/MediaMessage.test.tsx && pnpm typecheck`

Expected: media tests and TypeScript pass.

- [ ] **Step 6: Commit media reopening**

```bash
git add src/components/MediaMessage.tsx src/components/MediaMessage.test.tsx src/components/ChatView.tsx
git commit -m "feat: reopen media creations"
```

### Task 5: Reuse provider configuration in onboarding

**Files:**
- Create: `src/components/OpenAIEndpointFields.tsx`
- Create: `src/components/ProviderSetupOptions.tsx`
- Create: `src/components/ProviderSetupOptions.test.tsx`
- Modify: `src/components/AppSettingsPanel.tsx`
- Modify: `src/components/Onboarding.tsx`

**Interfaces:**
- Consumes: existing `ApiKeyRow`, `api`, `ConfigStatus`, and Store context.
- Produces: reusable `<OpenAIEndpointFields compact?: boolean />` and `<ProviderSetupOptions />`.

- [ ] **Step 1: Write failing provider-option render tests**

```ts
it("offers every API and network model provider without requiring a key", () => {
  const html = renderToStaticMarkup(<StoreProvider><ProviderSetupOptions /></StoreProvider>);
  expect(html).toContain("OpenRouter");
  expect(html).toContain("Ollama Cloud");
  expect(html).toContain("Custom OpenAI-compatible");
  expect(html).toContain("Set up later in App Settings");
  expect(html).toContain('type="password"');
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `pnpm vitest run src/components/ProviderSetupOptions.test.tsx`

Expected: FAIL because the reusable provider options do not exist.

- [ ] **Step 3: Extract the endpoint fields**

Move the current `OpenAIEndpointFields` from AppSettingsPanel into its own component. Preserve URL/model validation, config adoption, save behavior, and optional bearer-token row. With `compact`, omit image path, video path, and model-task overrides; those remain visible in App Settings.

- [ ] **Step 4: Build optional provider disclosures**

`ProviderSetupOptions` renders collapsed native `<details>` sections for OpenRouter, Ollama Cloud, and Custom OpenAI-compatible. It reuses `ApiKeyRow` for secrets and `OpenAIEndpointFields compact` for the endpoint. Already configured providers display Connected through the existing config flags. The helper text is exactly **Set up later in App Settings**.

- [ ] **Step 5: Add the options to onboarding**

Rename step 1 to **Choose your model providers**, keep the three local CLI status rows, then render the API/network section beneath them in a bounded scroll area. Add a visible **Set up later** action that advances to Permissions in Electron or finishes in a browser. Provider save failures remain inline inside their controls and do not disable either navigation action.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `pnpm vitest run src/components/ProviderSetupOptions.test.tsx && pnpm typecheck`

Expected: provider option tests and TypeScript pass.

- [ ] **Step 7: Commit onboarding changes**

```bash
git add src/components/OpenAIEndpointFields.tsx src/components/ProviderSetupOptions.tsx src/components/ProviderSetupOptions.test.tsx src/components/AppSettingsPanel.tsx src/components/Onboarding.tsx
git commit -m "feat: configure model providers during onboarding"
```

### Task 6: Full regression verification and local review

**Files:**
- Verification-only task; repair regressions only in files already owned by Tasks 1–5.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: verified renderer/server builds and a relaunched Electron preview.

- [ ] **Step 1: Run all tests with localhost permissions**

Run: `pnpm test`

Expected: all test files pass with zero failed and zero skipped tests caused by application errors. If sandboxed localhost binding returns `EPERM`, rerun the identical command with localhost permission rather than changing tests.

- [ ] **Step 2: Run static and production checks**

Run: `pnpm typecheck && pnpm build && pnpm build:server && git diff --check`

Expected: every command exits 0. Vite's existing large-chunk advisory is non-blocking; TypeScript errors or whitespace errors are blocking.

- [ ] **Step 3: Restart the local dev services**

Resolve exact listeners on ports 18799 and 5199, terminate only those process IDs, then start:

```bash
OMB_PORT=18799 pnpm dev:server
OGB_PORT=18799 pnpm dev -- --host 127.0.0.1 --port 5199
```

Verify `/api/health` and `http://127.0.0.1:5199/` return HTTP 200.

- [ ] **Step 4: Relaunch Electron**

```bash
ELECTRON_START_URL=http://127.0.0.1:5199 OGB_PORT=18799 pnpm dev:desktop
```

Expected: Electron remains running and displays the updated OpenMausBot UI.

- [ ] **Step 5: Report the local review checklist**

Ask the user to verify: Creations above Plugins; reopen HTML/image/video items; compact HTML streaming and View code; provider setup now versus Set up later. Do not push or create a PR until the user approves.
