// computer-proxy — a minimal MCP stdio server the claude CLI spawns
// (agentcal's permission-proxy pattern, dedicated entry file so there is
// no argv-dispatch fork-bomb hazard). It gives the agent its bot's cloud
// computer (box.ascii.dev) as CUA-grade tools.
//
// Transport: every action goes through the box's REST run-command
// endpoint (no inbound port on the box, no tunnel), so a round trip is
// expensive (~TLS + shell spawn). The whole design is therefore built
// around ONE round trip per step:
//
//   act + settle + capture + base64 all run in a single shell command,
//   and the resulting frame rides back in the SAME tool result as an MCP
//   image block ("act and observe"). The agent never needs a follow-up
//   screenshot call, which halves the model inferences per UI step —
//   the same shape Anthropic's own computer-use loop uses.
//
// Other latency rules that live here:
//   - JPEG, not PNG (5-10x fewer bytes, identical vision tokens), and
//     the downscale only runs when the display is wider than the model's
//     coordinate space.
//   - Coordinate scaling happens box-side in shell arithmetic, so there
//     is no separate "what size is the display" round trip per turn.
//   - Frames come back inline in stdout when small enough; the files API
//     is only a fallback (one extra hop) for big ones.
//   - computer_batch runs a whole mechanical sequence (click, type, tab,
//     type, Enter) in one round trip with one frame at the end.
//
// stdout is the MCP channel — never console.log here.
const BOX_API = process.env.OGB_BOX_API ?? "https://ascii.dev/api/box/v1";
const boxId = process.env.OGB_BOX_ID ?? "";
const token = process.env.OGB_BOX_TOKEN ?? "";

/** The coordinate space the model sees: frames are downscaled to this
 * width, and clicks are scaled back up to the real display box-side. */
const SHOT_WIDTH = 1280;
const JPEG_QUALITY = 75;
const SHOT_PATH = "/tmp/ogb-shot.jpg";
/** How long the desktop gets to repaint before the fused capture. */
const SETTLE_MS = 350;
/** Gap between batched actions so focus changes land before typing. */
const ACTION_GAP_MS = 120;
/** Frames larger than this come back over the files API instead of
 * inline stdout (keeps us clear of the command endpoint's stdout cap). */
const INLINE_MAX_BYTES = 400_000;

interface RunOut {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Boxes archive themselves when idle (billing pauses, the disk survives),
 * which can happen mid-conversation — after that every command comes back
 * 409 machine_not_running. Wake it and carry on rather than handing the
 * agent a cryptic failure it can only guess at. */
async function resumeBox(): Promise<boolean> {
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${BOX_API}/boxes/${boxId}/resume`, { method: "POST", headers: auth }).catch(() => null);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${BOX_API}/boxes/${boxId}`, { headers: auth }).catch(() => null);
    const body: any = await res?.json().catch(() => null);
    const state = body?.box?.state;
    if (state && ["idle", "ready", "running"].includes(state)) return true;
    if (state === "error") return false;
  }
  return false;
}

async function runOnBox(command: string, timeoutMs = 60_000, allowWake = true): Promise<RunOut> {
  const res = await fetch(`${BOX_API}/boxes/${boxId}/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => null);
  if (res.status === 409 && allowWake) {
    const code = body?.code ?? body?.error?.code ?? "";
    if (/machine_not_running|box_starting|not_running|starting/i.test(String(code))) {
      const woke = await resumeBox();
      if (woke) return runOnBox(command, timeoutMs, false);
      return { ok: false, exitCode: null, stdout: "", stderr: "the computer is asleep and did not wake in time" };
    }
  }
  return {
    ok: res.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? String(body?.message ?? (res.ok ? "" : `HTTP ${res.status}`)),
  };
}

const ENV = 'export DISPLAY=${DISPLAY:-:0}';
/** Resolve the real display size into $W/$H for box-side click scaling. */
const GEOMETRY = [
  "g=$(xdotool getdisplaygeometry 2>/dev/null)",
  'W=${g%% *}',
  'H=${g##* }',
  `case "$W" in ''|*[!0-9]*) W=${SHOT_WIDTH}; H=0;; esac`,
].join("; ");

/** Shell that turns a screenshot-space coordinate into a display one.
 * The capture only downscales when the display is WIDER than the model's
 * space, so scaling must be conditional on exactly the same test — on a
 * 1024-wide desktop the frame is native size and a blind /1280 would put
 * every click at 80% of where the model aimed. */
function scaled(varName: string, value: number): string {
  const v = Math.round(value);
  return `if [ "$W" -gt ${SHOT_WIDTH} ] 2>/dev/null; then ${varName}=$(( ${v} * W / ${SHOT_WIDTH} )); else ${varName}=${v}; fi`;
}

/** act → settle → capture → hash → (inline base64 if small). One hop. */
function captureBlock(settleMs = SETTLE_MS): string {
  return [
    settleMs > 0 ? `sleep ${(settleMs / 1000).toFixed(2)}` : "true",
    `f=${SHOT_PATH}`,
    `rm -f "$f" 2>/dev/null || true`,
    `scrot -o -q ${JPEG_QUALITY} "$f" 2>/dev/null || import -window root -quality ${JPEG_QUALITY} "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 -q:v 6 "$f" >/dev/null 2>&1`,
    // only re-encode when the display is bigger than the model's space —
    // ImageMagick startup is the most expensive step in the old pipeline
    `if [ "$W" -gt ${SHOT_WIDTH} ] 2>/dev/null && command -v convert >/dev/null 2>&1; then convert "$f" -thumbnail ${SHOT_WIDTH}x -quality ${JPEG_QUALITY} "$f" 2>/dev/null || true; fi`,
    `if [ ! -s "$f" ]; then echo SHOT_FAILED; exit 0; fi`,
    'echo "GEOM $W $H"',
    'echo "HASH $(md5sum "$f" 2>/dev/null | cut -d\' \' -f1)"',
    's=$(stat -c%s "$f" 2>/dev/null || echo 0)',
    // SIZE is what makes the inline path safe: the frame is only trusted
    // when the bytes we decoded match the bytes the box says it wrote
    'echo "SIZE $s"',
    `if [ "$s" -gt 0 ] && [ "$s" -le ${INLINE_MAX_BYTES} ]; then echo "B64 $(base64 -w0 "$f" 2>/dev/null || base64 "$f" | tr -d '\\n')"; fi`,
  ].join("; ");
}

/** A frame is only trusted when the bytes are a WHOLE image. Checking the
 * magic number alone is not enough: the box's command stdout has been
 * observed truncating a payload, and a truncated JPEG still starts with a
 * valid header — it just renders as a grey half-frame for the model. So
 * every frame must also end with its terminator, and (when the box told
 * us how many bytes it wrote) match that length exactly. */
function wholeImage(bytes: Buffer, expectedBytes?: number): boolean {
  if (bytes.length < 512) return false;
  if (expectedBytes && bytes.length !== expectedBytes) return false;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (jpeg) {
    // EOI marker, allowing for trailing padding some encoders append
    const tail = bytes.subarray(Math.max(0, bytes.length - 32));
    return tail.includes(Buffer.from([0xff, 0xd9]));
  }
  if (png) {
    const tail = bytes.subarray(Math.max(0, bytes.length - 12));
    return tail.includes(Buffer.from("IEND", "ascii"));
  }
  return false;
}

/** Big frames (and any inline read that came back malformed) are fetched
 * over HTTP: raw artifact bytes first, the files API's base64-in-JSON
 * envelope second. Both are validated — an error page served with a 200
 * must fall through, not reach the model as an "image". */
async function fetchFrame(expectedBytes?: number): Promise<string | null> {
  const auth = { authorization: `Bearer ${token}` };
  try {
    const res = await fetch(
      `${BOX_API}/boxes/${boxId}/artifacts?path=${encodeURIComponent(SHOT_PATH)}`,
      { headers: auth, signal: AbortSignal.timeout(30_000) },
    );
    if (res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (wholeImage(bytes, expectedBytes)) return bytes.toString("base64");
    }
  } catch {
    /* fall through to the files API */
  }
  try {
    const res = await fetch(
      `${BOX_API}/boxes/${boxId}/files?path=${encodeURIComponent(SHOT_PATH)}&encoding=base64`,
      { headers: auth, signal: AbortSignal.timeout(30_000) },
    );
    const body: any = await res.json().catch(() => null);
    const content = body?.content;
    if (!res.ok || typeof content !== "string" || !content) return null;
    return wholeImage(Buffer.from(content, "base64"), expectedBytes) ? content : null;
  } catch {
    return null;
  }
}

interface Frame {
  data: string;
  mime: string;
  hash: string | null;
  geometry: { width: number; height: number } | null;
}

let inlineWorks = true; // flipped off for the proxy's life on first garbage
let lastFrameHash: string | null = null;

async function frameFrom(out: RunOut): Promise<Frame | null> {
  if (/SHOT_FAILED/.test(out.stdout)) return null;
  let hash: string | null = null;
  let geometry: Frame["geometry"] = null;
  let inline = "";
  let size = 0;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("HASH ")) hash = line.slice(5).trim() || null;
    else if (line.startsWith("SIZE ")) size = Number(line.slice(5).trim()) || 0;
    else if (line.startsWith("GEOM ")) {
      const [w, h] = line.slice(5).trim().split(/\s+/).map(Number);
      if (Number.isFinite(w) && w > 0) geometry = { width: w, height: Number.isFinite(h) ? h : 0 };
    } else if (line.startsWith("B64 ")) inline = line.slice(4).trim();
  }
  if (inline && inlineWorks) {
    const bytes = Buffer.from(inline, "base64");
    if (wholeImage(bytes, size || undefined)) return { data: inline, mime: "image/jpeg", hash, geometry };
    // stdout mangled it (the failure this channel is known for) — never
    // hand a partial frame to the model; fetch it and stop trusting stdout
    inlineWorks = false;
  }
  const fetched = await fetchFrame(size || undefined);
  if (!fetched) return null;
  return { data: fetched, mime: "image/jpeg", hash, geometry };
}

const send = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};
const text = (id: unknown, t: string, isError = false): void =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) } });

/** An action result: the text plus the frame the action produced. When
 * the pixels are byte-identical to the frame the model just saw, the
 * image is dropped — it already has it, and it costs ~1.2k tokens. */
function observed(id: unknown, note: string, frame: Frame | null) {
  if (!frame) {
    return text(id, `${note}\n(couldn't capture the screen — call screenshot to retry)`);
  }
  const unchanged = frame.hash != null && frame.hash === lastFrameHash;
  lastFrameHash = frame.hash ?? lastFrameHash;
  if (unchanged) {
    // deliberately does NOT suggest repeating the action: the action may
    // well have landed, and re-clicking a button that already submitted
    // is the expensive kind of wrong
    return text(
      id,
      `${note}\n(the screen is identical to the frame you already have, so no new image is attached. Don't repeat the action — if you expected a change, it may still be rendering: call screenshot again in a moment, or re-check your coordinates against that frame.)`,
    );
  }
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        { type: "text", text: note },
        { type: "image", data: frame.data, mimeType: frame.mime },
      ],
    },
  });
}

const OBSERVE_PROPS = {
  observe: {
    type: "boolean",
    description:
      "default true — return a fresh screenshot with the result. Set false only when chaining mechanical steps you don't need to see.",
  },
  settle_ms: { type: "number", description: "wait before the screenshot, default 350, max 3000" },
};

const TOOLS = [
  {
    name: "screenshot",
    description:
      "See the bot's cloud computer screen (returns an image). The desktop runs Chrome and a full Linux GUI. You usually do NOT need this after acting — click, type_text, press_key, scroll and open_url already return the resulting screen.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description:
      "Click on the computer's screen and return the resulting screen. Use pixel coordinates exactly as they appear in the last frame you were given — any scaling to the real display is handled for you.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"], description: "default left" },
        double: { type: "boolean", description: "double-click" },
        ...OBSERVE_PROPS,
      },
      required: ["x", "y"],
    },
  },
  {
    name: "type_text",
    description: "Type text at the current focus and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, ...OBSERVE_PROPS },
      required: ["text"],
    },
  },
  {
    name: "press_key",
    description:
      'Press a key or chord and return the resulting screen. xdotool syntax: "Return", "Tab", "ctrl+c", "alt+F4", "ctrl+shift+t".',
    inputSchema: {
      type: "object",
      properties: { keys: { type: "string" }, ...OBSERVE_PROPS },
      required: ["keys"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the screen up or down by N clicks and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        clicks: { type: "number", description: "default 3" },
        ...OBSERVE_PROPS,
      },
      required: ["direction"],
    },
  },
  {
    name: "computer_batch",
    description:
      "Run several UI actions in ONE go and return the screen at the end — much faster than separate calls (one round trip, one screenshot). Use it for mechanical sequences you can predict without looking in between, e.g. click a field, type, Tab, type, press Return. Stop the batch before anything whose outcome you need to see first.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "in order; each is {action: click|type_text|press_key|scroll|wait, ...its params}",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["click", "type_text", "press_key", "scroll", "wait"] },
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right"] },
              double: { type: "boolean" },
              text: { type: "string" },
              keys: { type: "string" },
              direction: { type: "string", enum: ["up", "down"] },
              clicks: { type: "number" },
              ms: { type: "number", description: "wait: milliseconds, max 5000" },
            },
            required: ["action"],
          },
        },
        ...OBSERVE_PROPS,
      },
      required: ["actions"],
    },
  },
  {
    name: "computer_exec",
    description:
      "Run a shell command on the bot's cloud computer (Linux, passwordless sudo, X11 desktop). Returns stdout/stderr/exit code — and, unlike the UI tools, no screenshot unless you ask for one.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        observe: {
          type: "boolean",
          description: "default false — set true to also return a screenshot (e.g. after launching a GUI app)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "open_url",
    description: "Open a URL in the computer's own Chrome and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, ...OBSERVE_PROPS },
      required: ["url"],
    },
  },
];

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const settleOf = (args: any) => Math.min(Math.max(Number(args?.settle_ms) || SETTLE_MS, 0), 3000);
const wantsFrame = (args: any) => args?.observe !== false;

/** One action → the shell that performs it (scaling clicks box-side). */
function actionShell(a: any): string | { error: string } {
  const kind = String(a?.action ?? "");
  if (kind === "click") {
    const x = Math.round(Number(a.x));
    const y = Math.round(Number(a.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: "click needs numeric x,y" };
    const btn = a.button === "right" ? 3 : 1;
    const rep = a.double ? "--repeat 2 --delay 60 " : "";
    return `${scaled("CX", x)}; ${scaled("CY", y)}; xdotool mousemove $CX $CY click ${rep}${btn}`;
  }
  if (kind === "type_text") {
    const t = String(a.text ?? "");
    if (!t) return { error: "type_text needs text" };
    return `xdotool type --delay 8 ${shellQuote(t)}`;
  }
  if (kind === "press_key") {
    const keys = String(a.keys ?? "").replace(/[^\w+]/g, "");
    if (!keys) return { error: "press_key needs keys" };
    return `xdotool key ${keys}`;
  }
  if (kind === "scroll") {
    const clicks = Math.min(Math.max(Math.round(Number(a.clicks) || 3), 1), 20);
    const btn = a.direction === "up" ? 4 : 5;
    return `xdotool click --repeat ${clicks} ${btn}`;
  }
  if (kind === "wait") {
    const ms = Math.min(Math.max(Number(a.ms) || 500, 0), 5000);
    return `sleep ${(ms / 1000).toFixed(2)}`;
  }
  return { error: `unknown action ${kind || "(missing)"}` };
}

/** The whole point: one round trip carries geometry, the actions, the
 * settle, the capture and the frame bytes. */
async function actAndObserve(
  id: unknown,
  actions: any[],
  note: string,
  args: any,
  timeoutMs = 60_000,
): Promise<void> {
  const parts: string[] = [];
  for (const a of actions) {
    const shell = actionShell(a);
    if (typeof shell !== "string") return text(id, shell.error, true);
    // X11 needs a beat between steps — a click that focuses a field and
    // an immediate type will drop leading characters
    if (parts.length) parts.push(`sleep ${(ACTION_GAP_MS / 1000).toFixed(2)}`);
    parts.push(shell);
  }
  const observe = wantsFrame(args);
  // The actions run in a guarded group so a failing xdotool is REPORTED
  // rather than silently swallowed by the capture that follows it — but
  // the capture still runs, so the model always gets to see the state it
  // ended up in. Joining with ";" alone made a failed action look
  // identical to one that did nothing.
  const guarded = `if { ${parts.join("; ")}; }; then ACT=ok; else ACT=failed; fi`;
  const command = [ENV, GEOMETRY, guarded, observe ? captureBlock(settleOf(args)) : "true", 'echo "ACT $ACT"'].join(
    "; ",
  );
  const out = await runOnBox(command, timeoutMs);
  const acted = /^ACT ok$/m.test(out.stdout);
  if (!acted && !out.stdout.includes("GEOM")) {
    return text(
      id,
      `${note.replace(/^./, (c) => c.toLowerCase())} failed: ${out.stderr.slice(0, 200) || `exit ${out.exitCode}`}`,
      true,
    );
  }
  const full = acted ? note : `${note}\n(the action reported an error: ${out.stderr.slice(0, 160) || "no detail"})`;
  if (!observe) return text(id, full, !acted);
  return observed(id, full, await frameFrom(out));
}

async function call(id: unknown, name: string, args: any) {
  if (name === "screenshot") {
    const out = await runOnBox([ENV, GEOMETRY, captureBlock(0)].join("; "), 60_000);
    const frame = await frameFrom(out);
    if (!frame) {
      return text(id, `screenshot failed: ${out.stderr.slice(0, 200) || "capture produced no frame"}`, true);
    }
    // an explicit look always returns pixels, even if nothing moved
    lastFrameHash = frame.hash ?? lastFrameHash;
    return send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "image", data: frame.data, mimeType: frame.mime }] },
    });
  }
  if (name === "click") {
    const x = Math.round(Number(args.x));
    const y = Math.round(Number(args.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return text(id, "click needs numeric x,y", true);
    const what = `${args.double ? "double-clicked" : args.button === "right" ? "right-clicked" : "clicked"} ${x},${y}`;
    return actAndObserve(id, [{ ...args, action: "click" }], what, args);
  }
  if (name === "type_text") {
    const t = String(args.text ?? "");
    if (!t) return text(id, "nothing to type", true);
    return actAndObserve(id, [{ action: "type_text", text: t }], `typed ${t.length} chars`, args, 120_000);
  }
  if (name === "press_key") {
    const keys = String(args.keys ?? "").replace(/[^\w+]/g, "");
    if (!keys) return text(id, "press_key needs keys", true);
    return actAndObserve(id, [{ action: "press_key", keys }], `pressed ${keys}`, args);
  }
  if (name === "scroll") {
    const clicks = Math.min(Math.max(Math.round(Number(args.clicks) || 3), 1), 20);
    const direction = args.direction === "up" ? "up" : "down";
    return actAndObserve(id, [{ action: "scroll", direction, clicks }], `scrolled ${direction} ${clicks}`, args);
  }
  if (name === "computer_batch") {
    const actions = Array.isArray(args.actions) ? args.actions.slice(0, 24) : [];
    if (!actions.length) return text(id, "computer_batch needs a non-empty actions array", true);
    const summary = actions
      .map((a: any) =>
        a.action === "click"
          ? `click ${Math.round(Number(a.x))},${Math.round(Number(a.y))}`
          : a.action === "type_text"
            ? `type ${String(a.text ?? "").length} chars`
            : a.action === "press_key"
              ? `key ${a.keys}`
              : a.action === "scroll"
                ? `scroll ${a.direction ?? "down"}`
                : `wait ${Math.min(Number(a.ms) || 500, 5000)}ms`,
      )
      .join(" → ");
    return actAndObserve(id, actions, `ran ${actions.length} actions: ${summary}`, args, 180_000);
  }
  if (name === "computer_exec") {
    const command = String(args.command ?? "").slice(0, 4000);
    const out = await runOnBox(command, 120_000);
    const note = `exit ${out.exitCode}\n${out.stdout.slice(-6000)}${out.stderr ? `\n[stderr]\n${out.stderr.slice(-2000)}` : ""}`;
    if (args.observe !== true) return text(id, note);
    const shot = await runOnBox([ENV, GEOMETRY, captureBlock()].join("; "), 60_000);
    return observed(id, note, await frameFrom(shot));
  }
  if (name === "open_url") {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//.test(url)) return text(id, "only http(s) URLs", true);
    const q = shellQuote(url.replace(/'/g, "%27"));
    const observe = wantsFrame(args);
    // launch, then poll for a browser window instead of a blind sleep —
    // a fast page returns in a fraction of the old fixed 3s
    const command = [
      ENV,
      GEOMETRY,
      `(google-chrome ${q} || chromium ${q} || chromium-browser ${q} || xdg-open ${q}) >/dev/null 2>&1 &`,
      'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do xdotool search --onlyvisible --class "chrom" >/dev/null 2>&1 && break; sleep 0.25; done',
      observe ? captureBlock(600) : "true",
    ].join("; ");
    const out = await runOnBox(command, 60_000);
    if (!observe) return text(id, `opened ${url}`);
    return observed(id, `opened ${url}`, await frameFrom(out));
  }
  return text(id, `unknown tool ${name}`, true);
}

async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-computer", version: "3" },
      },
    });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    try {
      return await call(msg.id, msg.params?.name, msg.params?.arguments ?? {});
    } catch (e) {
      return text(msg.id, `computer tool failed: ${(e as Error).message}`, true);
    }
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => process.exit(0));
