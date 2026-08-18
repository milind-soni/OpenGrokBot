interface InstallationRow {
  id: string;
  composio_user_id: string;
  session_id: string | null;
  disabled_at: number | null;
}

interface ComposioSession {
  sessionId: string;
  url: string;
  headers: Record<string, string>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_MCP_BODY = 2 * 1024 * 1024;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseSession(value: unknown): ComposioSession {
  if (!isRecord(value) || typeof value.session_id !== "string" || !isRecord(value.mcp)) {
    throw new Error("Composio returned an invalid session");
  }
  if (typeof value.mcp.url !== "string") throw new Error("Composio returned no MCP URL");
  const url = new URL(value.mcp.url);
  if (url.protocol !== "https:" || (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev"))) {
    throw new Error("Composio returned an untrusted MCP URL");
  }
  const headers: Record<string, string> = {};
  if (isRecord(value.mcp.headers)) {
    for (const [name, header] of Object.entries(value.mcp.headers)) {
      if (typeof header !== "string" || /^(host|cookie|content-length)$/i.test(name)) continue;
      headers[name] = header;
    }
  }
  return { sessionId: value.session_id, url: url.toString(), headers };
}

async function upstreamError(response: Response, fallback: string) {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const nested = isRecord(body.error) ? body.error.message ?? body.error.error : body.error;
    return String(body.message ?? nested ?? fallback).slice(0, 240);
  } catch {
    return text.trim().slice(0, 240) || fallback;
  }
}

function composioRequest(env: Env, path: string, init?: RequestInit) {
  return fetch(`${env.COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "x-api-key": env.COMPOSIO_API_KEY,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

async function getSession(env: Env, sessionId: string) {
  const response = await composioRequest(env, `/tool_router/session/${encodeURIComponent(sessionId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await upstreamError(response, `Session lookup failed (${response.status})`));
  return parseSession(await response.json());
}

async function createSession(env: Env, userId: string) {
  const response = await composioRequest(env, "/tool_router/session", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      manage_connections: {
        enable: true,
        enable_wait_for_connections: true,
        enable_connection_removal: true,
      },
    }),
  });
  if (!response.ok) throw new Error(await upstreamError(response, `Session creation failed (${response.status})`));
  return parseSession(await response.json());
}

async function ensureSession(installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  if (!(await env.SESSION_LIMITER.limit({ key: installation.id })).success) {
    throw new Response(JSON.stringify({ error: "too many connected-app requests" }), { status: 429, headers: JSON_HEADERS });
  }
  let session = installation.session_id ? await getSession(env, installation.session_id) : null;
  if (!session) {
    session = await createSession(env, installation.composio_user_id);
    await env.DB.prepare("UPDATE installations SET session_id = ?, last_seen_at = ? WHERE id = ?")
      .bind(session.sessionId, Date.now(), installation.id)
      .run();
  } else {
    ctx.waitUntil(
      env.DB.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ?")
        .bind(Date.now(), installation.id)
        .run()
        .catch((error: unknown) => console.error(JSON.stringify({ message: "last-seen update failed", id: installation.id, error: String(error) }))),
    );
  }
  return session;
}

async function authenticate(request: Request, env: Env) {
  const token = request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT id, composio_user_id, session_id, disabled_at FROM installations WHERE token_hash = ?",
  ).bind(await sha256(token)).first<InstallationRow>();
  return row && row.disabled_at === null ? row : null;
}

async function register(request: Request, env: Env) {
  if (env.REGISTRATION_MODE !== "open") return json({ error: "registration is temporarily closed" }, 503);
  const fingerprint = `${request.headers.get("cf-connecting-ip") ?? "unknown"}|${request.headers.get("user-agent") ?? "unknown"}`;
  if (!(await env.REGISTRATION_LIMITER.limit({ key: await sha256(fingerprint.slice(0, 512)) })).success) {
    return json({ error: "too many registration attempts" }, 429);
  }
  const installationId = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO installations (id, token_hash, composio_user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(installationId, await sha256(token), `omb_${installationId.replaceAll("-", "")}`, now, now).run();
  console.log(JSON.stringify({ message: "installation registered", installationId }));
  return json({ installationId, token }, 201);
}

async function proxyMcp(request: Request, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_MCP_BODY) return json({ error: "MCP request is too large" }, 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_MCP_BODY) return json({ error: "MCP request is too large" }, 413);
  const session = await ensureSession(installation, env, ctx);
  const response = await fetch(session.url, {
    method: "POST",
    headers: {
      ...session.headers,
      "x-api-key": env.COMPOSIO_API_KEY,
      "content-type": request.headers.get("content-type") ?? "application/json",
      accept: "application/json, text/event-stream",
      ...(request.headers.get("mcp-session-id") ? { "mcp-session-id": request.headers.get("mcp-session-id")! } : {}),
    },
    body,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const headers = new Headers({
    "content-type": response.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  });
  const mcpSession = response.headers.get("mcp-session-id");
  if (mcpSession) headers.set("mcp-session-id", mcpSession);
  return new Response(response.body, { status: response.status, headers });
}

async function catalog(env: Env) {
  const response = await fetch(`${env.COMPOSIO_TOOLKIT_BASE}/toolkits?limit=500&sort_by=usage`, {
    headers: { accept: "application/json", "x-api-key": env.COMPOSIO_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return json({ error: await upstreamError(response, "Catalog unavailable") }, 502);
  return new Response(response.body, {
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "private, max-age=600" },
  });
}

async function connectionStatus(url: URL, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const slugs = [...new Set((url.searchParams.get("services") ?? "").split(",").map((slug) => slug.toLowerCase()).filter(Boolean))].slice(0, 50);
  const session = await ensureSession(installation, env, ctx);
  const response = await composioRequest(
    env,
    `/tool_router/session/${encodeURIComponent(session.sessionId)}/toolkits?${new URLSearchParams({ limit: "50", toolkits: slugs.join(",") })}`,
  );
  if (!response.ok) return json({ error: await upstreamError(response, "Connection status unavailable") }, 502);
  const body = await response.json() as { items?: Array<{ slug?: string; is_no_auth?: boolean; connected_account?: { status?: string } }> };
  const items = new Map((body.items ?? []).map((item) => [item.slug?.toLowerCase(), item]));
  return json({ services: Object.fromEntries(slugs.map((slug) => {
    const item = items.get(slug);
    const status = item?.connected_account?.status ?? (item?.is_no_auth ? "ACTIVE" : "not_connected");
    return [slug, { connected: item?.is_no_auth === true || /^active$/i.test(status), pending: /^(initiated|initializing|pending)$/i.test(status), status }];
  })) });
}

async function authorize(slug: string, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const session = await ensureSession(installation, env, ctx);
  const response = await composioRequest(env, `/tool_router/session/${encodeURIComponent(session.sessionId)}/link`, {
    method: "POST",
    body: JSON.stringify({ toolkit: slug }),
  });
  if (!response.ok) return json({ error: await upstreamError(response, "Authorization unavailable") }, 502);
  const body = await response.json() as { redirect_url?: string };
  if (!body.redirect_url) return json({ error: "Composio returned no authorization link" }, 502);
  const redirect = new URL(body.redirect_url);
  if (redirect.protocol !== "https:" || (redirect.hostname !== "composio.dev" && !redirect.hostname.endsWith(".composio.dev"))) {
    return json({ error: "Composio returned an untrusted authorization link" }, 502);
  }
  return json({ url: redirect.toString() });
}

async function disconnect(slug: string, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const session = await ensureSession(installation, env, ctx);
  const list = await composioRequest(
    env,
    `/tool_router/session/${encodeURIComponent(session.sessionId)}/toolkits?${new URLSearchParams({ limit: "50", toolkits: slug })}`,
  );
  if (!list.ok) return json({ error: await upstreamError(list, "Connection lookup unavailable") }, 502);
  const body = await list.json() as { items?: Array<{ slug?: string; connected_account?: { id?: string } }> };
  const id = body.items?.find((item) => item.slug?.toLowerCase() === slug)?.connected_account?.id;
  if (!id) return json({ removed: 0 });
  const response = await composioRequest(env, `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, { method: "DELETE" });
  if (!response.ok) return json({ error: await upstreamError(response, "Disconnect failed") }, 502);
  return json({ removed: 1 });
}

async function route(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ service: "openmausbot-composio", ready: Boolean(env.COMPOSIO_API_KEY) });
  if (request.method === "POST" && url.pathname === "/v1/installations") return register(request, env);
  if (!url.pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);
  const installation = await authenticate(request, env);
  if (!installation) return json({ error: "unauthorized" }, 401);
  if (request.method === "GET" && url.pathname === "/v1/me") return json({ installationId: installation.id });
  if (request.method === "POST" && url.pathname === "/v1/mcp") return proxyMcp(request, installation, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/catalog") return catalog(env);
  if (request.method === "GET" && url.pathname === "/v1/connectors") return connectionStatus(url, installation, env, ctx);
  const match = url.pathname.match(/^\/v1\/connectors\/([a-z0-9][a-z0-9_-]{0,80})(?:\/(authorize))?$/);
  if (match?.[2] && request.method === "POST") return authorize(match[1], installation, env, ctx);
  if (match && !match[2] && request.method === "DELETE") return disconnect(match[1], installation, env, ctx);
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error(JSON.stringify({ message: "request failed", path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "service unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;

export { parseSession, sha256 };
