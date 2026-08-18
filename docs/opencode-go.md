# OpenCode Go

OpenCode Go is an optional OpenMausBot engine. OpenMausBot runs the maintained
OpenCode CLI through its ACP stdio interface, so sessions, streaming, coding
tools, permission requests, MCP integrations, resume, and cancellation use the
same runtime as the other ACP engines.

## Setup

1. Install the official CLI using the
   [OpenCode installation guide](https://opencode.ai/docs/).
2. Create or obtain an OpenCode Go API key according to the live
   [OpenCode Go documentation](https://opencode.ai/docs/go/).
3. Open OpenMausBot Settings → Connections and save the key under **OpenCode
   Go API key**.

The key is stored locally as write-only configuration. OpenMausBot reports only
whether it is configured, never the value. A key saved in OpenMausBot is
injected as `OPENCODE_API_KEY` only into the OpenCode child process; it is not
sent to the renderer, logs, analytics, snapshots, error messages, or command
arguments.

OpenCode Go remains unavailable until both the `opencode` executable and the
credential are present. It is never selected as a runnable default while either
requirement is missing. Users may instead manage OpenCode's own login flow with
`opencode auth login`; OpenMausBot does not edit OpenCode auth/config files.

## Models

The model picker refreshes the public catalog from
`https://opencode.ai/zen/go/v1/models`. IDs are normalized to the full
`opencode-go/<model-id>` form required by ACP. If the catalog is unavailable,
the last successful catalog is used, followed by a small static fallback. The
catalog is mutable; current names, pricing, limits, and retention terms remain
defined by the live OpenCode documentation.

Before every prompt, ACP receives `session/set_config_option` with
`configId: "model"` and the exact selected provider-qualified model ID.

## Testing

Normal unit and ACP protocol tests do not require a subscription. Live tests,
if added, must be explicitly enabled and must never print credentials or upload
native protocol logs from a credentialed run.
