# Remote ACP engine

The **Remote ACP** engine (`driver: "remoteAcp"`) runs a bot on any command that
speaks the [Agent Client Protocol](https://agentclientprotocol.com) on stdio for
an agent that **executes somewhere else** — a hosted sandbox service's CLI, an
agent on another machine over `ssh`, an agent inside a container. Nothing about
the provider is built in: the instance's config says how to start the bridge,
how to list what the picker can choose, and how to tell whether it is signed in.

It rides the same ACP core as the local engines (Grok Build, Gemini CLI, Kimi,
Droid, OpenCode, Qwen, Hermes): streaming, tool events, resume, cancellation and
permission cards all work the same way when the bridge implements them.

## Setup

Remote ACP has no default instance — there is no command it could run without
being told which one. Add an entry to `~/.openmausbot/config.json` under
`instances` and restart the app. The minimum is the binary:

```json
{
  "instances": {
    "remote-agent": {
      "driver": "remoteAcp",
      "displayName": "My remote agent",
      "config": { "cli": "my-agent-cli", "args": ["acp"] }
    }
  }
}
```

The instance shows up in the Cloud rail of the model picker under its
`displayName`. Like every engine, the binary path can also be overridden later
from **Settings → Engines** (that writes `config.cli`).

### Config reference

All keys sit under the instance's `config`. Every argv field is an array of
strings **after** the binary, never a shell string, so paths with spaces and
arguments with quotes need no escaping.

| Key | Type | Meaning |
|---|---|---|
| `cli` | string | The bridge binary (name on PATH or absolute path). |
| `args` | string[] | Arguments that enter ACP stdio mode. `{model}` is replaced with the picker's choice; see [Picking](#picking-an-agent-model-or-profile). Default `[]`. |
| `catalog` | string[] | Arguments that print the picker catalog as JSON; see [Catalog](#the-catalog-command). Omit for a bridge with nothing to list. |
| `models` | `(string \| {id, label})[]` | Static picker entries, listed ahead of whatever `catalog` returns. |
| `authCheck` | string[] | Arguments whose exit status answers "signed in?" (0 = yes). Omit to trust the bridge. |
| `authMethod` | string | ACP `authenticate` method id to call when the agent advertises it. Omit to never call `authenticate` — most bridges hold their own credentials. |
| `mcp` | `{agents?, computer?, composio?}` | Which local MCP integrations to forward into the session. **All `false` unless set**; see [What does not apply](#what-does-not-apply-and-why). |
| `fullAuto` | boolean | Approve every permission request the bridge forwards, instead of showing a card. |
| `workspace` | string | `cwd` handed to the bridge and to `session/new`. Most remote agents ignore it. |

Environment variables for the bridge (API keys, base URLs, profiles) go in the
instance's `environment`, exactly like the other engines:

```json
"environment": { "FOUNTAIN_API_KEY": "fk_…", "FOUNTAIN_BASE_URL": "https://fountain.example" }
```

A malformed entry (a string where an array is expected, a model row without an
`id`) does not run on a guess: the instance appears as unavailable with the
offending key named in the reason.

## Picking an agent, model, or profile

ACP has no field for "which agent" — each bridge takes that on its command line.
Put `{model}` in `args` where the pick belongs, as its own argument or inside one:

```json
"args": ["acp", "--agent", "{model}"]
"args": ["acp", "--agent={model}"]
"args": ["-T", "devbox", "gemini", "--experimental-acp", "-m", "{model}"]
```

When nothing is picked (an empty catalog, or the picker left blank) the
`{model}` argument is dropped, and so is a directly preceding option
(`--agent`, `-m`) that would otherwise dangle — the bridge then runs on its own
default, or says it has none, in its own words.

## The catalog command

`catalog` runs at startup and on picker refresh with the instance environment,
and must print JSON: an array, or an object whose `data`, `models`, `agents` or
`items` is one, of rows with a string `id` and optionally a `label` or `name`:

```json
[{ "id": "a42e…", "name": "homelab-builder", "runtime": "claude" }, { "id": "gpt-5" }]
```

The id is what lands in `{model}`; the label is `label`, else `name`, else the
id. Extra fields are ignored. A row marked `"acp": false` — the remote side's
way of saying this entry cannot be driven over the protocol — is left out, so
the picker never offers something that fails at `session/new`. A failing
command (signed out, remote down) keeps the last catalog instead of emptying the
picker.

## Worked example: Fountain

[Fountain](https://github.com/BinaryBourbon/fountain) runs agents in sandboxes
on a hosted or self-hosted instance; its CLI's `fountain acp` speaks ACP on
stdio and a Fountain *agent* (model + runtime + skills + MCP servers +
environment) is the unit the picker chooses. One instance per identity or
environment, as Fountain's own `--vault`/`--environment` flags frame it:

```json
{
  "instances": {
    "fountain": {
      "driver": "remoteAcp",
      "displayName": "Fountain",
      "config": {
        "cli": "fountain",
        "args": ["acp", "--agent", "{model}"],
        "catalog": ["agent", "list", "--json"],
        "authCheck": ["auth", "whoami"]
      }
    },
    "fountain-staging": {
      "driver": "remoteAcp",
      "displayName": "Fountain (staging)",
      "config": {
        "cli": "fountain",
        "args": ["acp", "--agent", "{model}", "--environment", "staging"],
        "catalog": ["agent", "list", "--json"]
      },
      "environment": { "FOUNTAIN_API_KEY": "fk_…", "FOUNTAIN_BASE_URL": "https://staging.fountain.example" }
    }
  }
}
```

Install with `brew install BinaryBourbon/tap/fountain`, sign in with
`fountain auth login` (or set `FOUNTAIN_API_KEY` in `environment`), and the
agents of that instance list in the picker. Fountain's ACP session id is its
conversation id, so a thread resumes on the server after a restart — even from
another machine. See Fountain's
[`fountain acp` reference](https://github.com/BinaryBourbon/fountain/blob/main/docs/integrations/acp.md)
for what the adapter does and does not forward.

## Other shapes

An ACP agent on another machine, over ssh (the agent's own credentials live
there; `-T` keeps stdio clean):

```json
"config": { "cli": "ssh", "args": ["-T", "devbox", "gemini", "--experimental-acp", "-m", "{model}"], "models": ["gemini-2.5-pro", "gemini-2.5-flash"] }
```

An agent in a running container:

```json
"config": { "cli": "docker", "args": ["exec", "-i", "agent-box", "opencode", "acp"] }
```

A bridge whose catalog needs reshaping — wrap it in a script that prints the
contract above; `catalog` is just argv.

## What does not apply, and why

- **No local MCP by default.** The agent runs elsewhere and never sees this
  machine, so the bot is not told it has a computer, a Composio connection or
  peer bots its driver cannot hand it — and no tokens for those are ever sent
  to the bridge. A bridge that *does* forward `mcpServers` to where the agent
  runs (an ssh box that can reach your services) can opt back in per mount:
  `"mcp": { "agents": true }`.
- **Permission cards** appear only if the bridge forwards
  `session/request_permission`. Sandboxed runtimes usually run under their own
  permission mode instead.
- **No effort control, no in-session model switch.** The pick is made on the
  command line when the bridge starts.
- **Install/sign-in buttons** in Settings → Engines know nothing about your
  bridge; install and sign it in yourself. A configured `authCheck` is what
  makes the picker say "not signed in" rather than failing the first turn.

## Testing

`server/drivers/acp/remote.test.ts` covers config decoding, the catalog
contract, argv substitution, the sign-in probe, MCP gating, and a full turn
through the shared fake ACP CLI — no remote service or credential is needed.
