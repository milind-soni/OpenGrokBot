// Auto mode: when a bot may answer its own permission requests.
//
// Two ways in — the bot is in auto mode, or the user pressed "Always
// allow" for that one tool — and one way out: anything that reads as
// destructive stops and asks a human anyway.
//
// The guard is deliberately tiny and literal. It is NOT a security
// boundary (an agent set on damage has a thousand spellings for `rm`);
// it is a "you probably didn't mean to hand THIS one over unattended"
// backstop for the obvious catastrophes. Real containment is the
// sandbox and the bot's own computer, not a regex.

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r -f
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
];

// Not destructive, but exactly what you don't hand over unattended: a
// bot reading your keys is quiet, permanent, and unrecoverable.
const SENSITIVE = [
  /(^|[\s/"'])\.env(\.|$|["'\s])/i,
  /\.ssh\/|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
];

export function looksSensitive(text: string): boolean {
  return SENSITIVE.some((re) => re.test(text));
}

export function looksDestructive(text: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(text));
}

/** The key an "Always allow" remembers.
 *
 * A bare tool name is far too coarse for a command runner: remembering
 * "Bash" would hand the bot a permanent unattended shell, which is the
 * opposite of what someone pressing "always allow" on `git status`
 * intends. Command tools are therefore keyed by their program —
 * `Bash:git`, `Bash:npm` — so the grant is as narrow as the thing you
 * actually looked at. Computed once, server-side, and echoed back by the
 * client so the two sides can never disagree about what was granted. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "run_command", "computer_exec", "terminal"]);

export function approvalKey(tool: string, summary: string): string {
  const bare = tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
  if (!COMMAND_TOOLS.has(bare)) return tool;
  // first bare word of the command, skipping env assignments and sudo
  const words = summary.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || words[i] === "sudo")) i += 1;
  const program = (words[i] ?? "").split("/").pop()?.replace(/[^\w.-]/g, "") ?? "";
  return program ? `${tool}:${program}` : tool;
}

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

/** Why this request may be answered without the human, or null to ask.
 * The returned string becomes the chip in the transcript, so an
 * auto-approved action is never invisible. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
  },
): string | null {
  // Auto mode is something a person switched on for turns they are present
  // for. A webhook turn begins with nobody watching, on a payload someone
  // else wrote, so it does not inherit that decision — the guard below is a
  // pattern list its own comment calls "not a security boundary", and it
  // must not stand in for a human at 3am.
  if (context?.unattended) return null;
  // the guards come first, so an "always allow" can never widen into them
  if (looksDestructive(summary) || looksDestructive(tool)) return null;
  if (looksSensitive(summary)) return null;
  const key = approvalKey(tool, summary);
  if (bot.alwaysAllow?.includes(key)) return `auto-approved ${key} (always allowed)`;
  if (bot.autoApprove) return `auto-approved ${tool}`;
  return null;
}
