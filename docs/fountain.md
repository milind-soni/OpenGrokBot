# Fountain

[Fountain](https://github.com/BinaryBourbon/fountain) is an optional
OpenMausBot engine, and the one engine whose agents do **not** run on your
machine. OpenMausBot spawns `fountain acp` — the Fountain CLI's
[Agent Client Protocol](https://agentclientprotocol.com) adapter — which
opens a conversation in a sandbox on your Fountain instance and streams it
back. Streaming, resume, and cancellation ride the same ACP runtime as the
other engines; what differs is where the agent lives.

## Setup

1. Install the CLI: `brew install BinaryBourbon/tap/fountain` (or a release
   binary from the
   [releases page](https://github.com/BinaryBourbon/fountain/releases)).
2. Sign in: `fountain auth login`. Point it at your own instance first with
   `FOUNTAIN_BASE_URL=https://your-fountain.example fountain auth login`.
3. Restart OpenMausBot (or refresh Settings → Engines). Fountain appears in
   the picker's Cloud rail — the agents run on your instance, not here.

Credentials are the CLI's, never OpenMausBot's: the driver runs `fountain auth
whoami` to decide whether the engine is signed in, and the child process reads
the saved profile itself. To bypass the saved profile, put `FOUNTAIN_API_KEY`
and `FOUNTAIN_BASE_URL` in the instance's `environment` in `config.json`;
`FOUNTAIN_PROFILE` selects a non-default profile the same way.

## The model picker chooses an agent

A Fountain *agent* already carries its model, runtime (claude, codex,
opencode, …), skills, MCP servers and environment, so there is nothing left
for a model picker to choose. The picker therefore lists **your Fountain
agents** — `fountain agent list --json`, filtered to runtimes that speak ACP
— and the pick becomes `fountain acp --agent <id>`. Switching a bot's "model"
switches which Fountain agent answers.

The catalog is refreshed like any live catalog: a failed listing (signed out,
instance down) keeps the last one rather than emptying the picker.

## Threads survive everything

The ACP session id **is** the Fountain conversation id, and that is what
OpenMausBot stores as the thread's resume cursor. Quitting the app, rebooting,
or moving to another machine changes nothing: the next message reopens the
same conversation with `session/load`, and its transcript is replayed from the
server. The same conversation is visible in Fountain's web UI and
`fountain conv`.

## Per-instance vault and environment

`fountain acp` takes `--vault` (secrets layered over the agent's environment
— an identity the agent posts under, for instance) and `--environment`
(provision from a different environment than the agent's own). Both are
per-*instance* knobs in OpenMausBot, set in the instance's `environment` in
`config.json`:

```json
{
  "instances": {
    "fountain": { "driver": "fountainAgent" },
    "fountain-nostr": {
      "driver": "fountainAgent",
      "displayName": "Fountain (nostr identity)",
      "environment": { "FOUNTAIN_ACP_VAULT": "nostr-identity" }
    }
  }
}
```

`FOUNTAIN_ACP_VAULT` and `FOUNTAIN_ACP_ENVIRONMENT` accept a name or an id.
Two instances pointing at the same agent with different vaults stay separate
engines in the rail — one entry per identity, exactly how the Fountain docs
frame it.

## What does not apply

- **No computer, no connected apps, no peer comms.** `fountain acp` ignores
  the session's `mcpServers` and `cwd` — the sandbox has its own checkout and
  the agent its own MCP configuration — so the driver declares none of
  OpenMausBot's MCP integrations. A Fountain bot is never told it has a
  computer it cannot reach.
- **No approval cards yet.** Permission requests are not forwarded by
  `fountain acp` (sandboxed runtimes run under their own permission mode,
  [fountain#643](https://github.com/BinaryBourbon/fountain/issues/643)).
  "Auto mode" changes nothing for this engine.
- **No reasoning-effort control.** The agent's model and settings belong to
  Fountain.
- **A `gemini`-runtime agent** does not speak ACP and is left out of the
  picker ([fountain#659](https://github.com/BinaryBourbon/fountain/issues/659)).

## Testing

`server/drivers/acp/fountain.test.ts` runs the driver against the shared fake
ACP CLI and needs no Fountain instance. For a live check with your own
credentials, `node --experimental-strip-types server/testing/live-fountain.ts
<agent-id>` runs one turn through the real driver and prints the canonical
events; `fountain acp --agent <name>` by hand proves the CLI starts and finds
its credentials.
