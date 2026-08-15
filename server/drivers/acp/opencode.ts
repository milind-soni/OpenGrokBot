// OpenCode harness support — `opencode acp` over ACP stdio, riding the generic
// runtime in acp/core.ts. Verified against opencode 1.18.18.
//
// Two things set OpenCode apart from the other ACP harnesses:
//
// 1. It is provider-plural. The model list is whatever the user has
//    credentials for — 471 entries on a configured machine, 7 (the free
//    OpenCode Zen ones) on a virgin HOME — so the catalog is discovered at
//    runtime instead of compiled in. And `opencode acp` takes no -m, so the
//    model is set with session/set_config_option (support.selectModel).
//
// 2. Its default permission policy allows everything: the `build` agent
//    carries {permission:"*", action:"allow", pattern:"*"}, so a bot would run
//    shell commands with no approval card at all — a real gap against the
//    claude and codex drivers. See ASK_POLICY below.

/** Parse `opencode models`: one provider-qualified id per line, no decoration.
 *  Measured on 1.18.18: 471 lines, all matching, no ANSI. Anything that does
 *  not match is dropped rather than guessed at — if the format ever grows a
 *  header, the catalog goes empty and the engine reports itself unavailable,
 *  which is noisy but never a lie. */
export function parseModels(stdout: string): Array<{ id: string; label: string }> {
  const models: Array<{ id: string; label: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!/^[\w.-]+\/\S+$/.test(line)) continue;
    models.push({ id: line, label: line.slice(line.indexOf("/") + 1) });
  }
  return models;
}
