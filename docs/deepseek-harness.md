# DeepSeek Harness driver

OpenMausBot can drive DeepSeek models through
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
instead of the claude/codex/grok CLIs. Each bot is backed by a real DeepSeek
agent (e.g. `deepseek-v4-pro`), using the same `DEEPSEEK_API_KEY` that
`dsh web` already reads from `~/.dsh/.credentials.yaml` — no new account or
login.

## How it works

DeepSeek Harness ships an automation-only
[Agent Client Protocol](https://agentclientprotocol.com) server
(`@deepseek-ai/dsh-acp`) over JSON-RPC stdio. The `deepseek` driver rides
OpenMausBot's generic ACP runtime (`server/drivers/acp/core.ts`); its "CLI" is
the bundled `deepseek-acp` launcher, which:

1. reads `DEEPSEEK_API_KEY` from `~/.dsh/.credentials.yaml` (or the environment),
2. boots a built `dsh` checkout's ACP server
   (`packages/examples/acp-demo/lib/bin.js --config examples/acp-agent/cordis.yml`),
3. forwards stdio so the ACP JSON-RPC stream reaches the driver unchanged.

```
bot message → OpenMausBot → deepseek driver → deepseek-acp → dsh ACP server → DeepSeek model
```

## Prerequisites

- a **built** DeepSeek Harness checkout (`pnpm install && pnpm run build`),
  pointed at by `DSH_HOME`;
- `DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml` (the same file `dsh web`
  uses) or in the environment;
- Node 24+ (the OpenMausBot baseline).

## Configuration

Add a DeepSeek instance to `~/.openmausbot/config.json`:

```json
{
  "instances": {
    "deepseek": {
      "driver": "deepseek",
      "config": {
        "cli": "<repo>/server/drivers/acp/deepseek-acp.mjs",
        "workspace": "/absolute/path/to/agent/cwd"
      },
      "environment": {
        "DSH_HOME": "/path/to/deepseek-harness"
      }
    }
  }
}
```

- `cli` — the launcher path (defaults to `deepseek-acp` on `PATH`).
- `workspace` — the agent's working directory; must be absolute. The `dsh`
  agent's bash and filesystem tools are sandboxed to this directory.
- `DSH_HOME` — the built checkout; defaults to `~/deepseek-harness`.

## Models

`deepseek-v4-pro` (default) and `deepseek-v4-flash`. A non-default model is
applied by deriving a config with the `model:` line swapped. The derived
config is written under the checkout's `examples/acp-agent/` (not `/tmp`)
because `dsh`'s pnpm layout resolves the `@deepseek-ai/*` workspace packages
relative to the config file's directory, not the process cwd.

## Conversation history

`dsh`'s ACP server has no `session/load` — every turn is a fresh agent
session. The driver therefore replays the settled transcript inline (the same
shape as the `grok` API driver), so a bot remembers its conversation without
provider-side resume. The harness routes rewinds through that same
transcript-replay path for `deepseek`.

## Limitations

- **No computer / connected-app tooling.** The driver advertises
  `computerMcp`/`agentsMcp` as off because `dsh`'s ACP server rejects
  non-empty `mcpServers`; the UI must never promise tooling the agent cannot
  mount. Chat works fully.
- **Committed answers.** `dsh` streams committed assistant message blocks
  rather than token-level deltas, so replies arrive at message granularity.
- **Model fixed at boot.** The ACP server resolves the model from its config;
  switching a bot's model restarts the ACP server for that turn.
