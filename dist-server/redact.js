// Keeping secrets out of the native protocol log.
//
// The native tee writes every provider message verbatim, which is what makes
// protocol drift diagnosable — but the messages that set a session up carry
// the credentials the agent is handed: the box token and the comms token
// travel inside `session/new`'s mcpServers env, and a Composio consumer key
// travels in an MCP header. Those logs sit in ~/.openmausbot/native as
// ordinary files, are read by anyone debugging, and get pasted into issues.
//
// So the log keeps the SHAPE and loses the VALUES: a redacted entry still
// tells you a token was passed, under which name, and how long it was —
// enough to debug "the proxy got no token" without the token being there.
/** Key names whose value is a credential. Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];
/** `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`. Only
 * treat it as a credential when it stands alone or is a suffix, which is how
 * every real one is spelled (API_KEY, consumer-key, xai_key). */
function isSecretName(name) {
    const lower = name.toLowerCase();
    if (SECRET_KEY_PARTS.some((part) => lower.includes(part)))
        return true;
    return /(^|[_.-])keys?$/.test(lower);
}
const mask = (value) => `«redacted ${value.length} chars»`;
/** Deep copy with credential VALUES replaced. Handles the two shapes that
 * actually carry them: a plain object of env vars ({KEY: "v"}) and the ACP
 * wire shape (env: [{name, value}]). Anything unrecognised is copied as-is. */
export function redactSecrets(input, depth = 0) {
    if (depth > 12 || input === null || typeof input !== "object")
        return input;
    if (Array.isArray(input)) {
        return input.map((item) => {
            // ACP env entries: {name: "OMB_COMMS_TOKEN", value: "…"}
            if (item !== null &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                typeof item.name === "string" &&
                typeof item.value === "string") {
                const entry = item;
                return isSecretName(entry.name) ? { ...entry, value: mask(entry.value) } : entry;
            }
            return redactSecrets(item, depth + 1);
        });
    }
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === "string" && isSecretName(key)) {
            out[key] = mask(value);
            continue;
        }
        out[key] = redactSecrets(value, depth + 1);
    }
    return out;
}
