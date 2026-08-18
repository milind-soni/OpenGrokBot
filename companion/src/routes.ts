// What a paired device is allowed to ask for.
//
// The default is deny, and that direction is the whole point: the sidecar
// sits in front of an API it does not own and cannot see the future of. A
// route that appears in the harness later is closed to phones until someone
// decides otherwise, because the alternative is that every upstream release
// silently widens what a lost phone can reach.
//
// This file used to claim that and not do it — it listed refusals and let
// everything else under `/api/` through. In the time between writing it and
// noticing, upstream added webhook triggers, connected-app authorisation and
// routines, all of which a paired phone could drive: minting an
// internet-reachable trigger, rotating a signing secret out from under
// whatever was sending to it, disconnecting a Google account. None of that
// was a decision anyone made. It was the default.
//
// So the list below is the surface, derived from what the app actually
// calls. Adding a feature to the phone means adding its route here, on
// purpose, in a diff someone can read. That cost is the feature.

/** A refusal to send back, or null to let the request through. */
export interface Denial {
  status: number;
  error: string;
}

/** One request, reduced to what the allowlist decides on. */
export interface RouteRequest {
  path: string;
  method: string;
  /** Whether the bearer token on the request matched a paired device. */
  authenticated: boolean;
}

/** The one companion route that crosses into full interactive desktop
 * control. Both the allowlist and capability gate consume this classifier so
 * their security decisions cannot drift apart. */
export const CLOUD_DESKTOP_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/join$/,
} as const;

export function isCloudDesktopJoin(method: string, path: string): boolean {
  return method === CLOUD_DESKTOP_JOIN_ROUTE.method && CLOUD_DESKTOP_JOIN_ROUTE.path.test(path);
}

/** Every request the iOS app makes, and nothing else.
 *
 * Ids are `[\w-]+`, matching the harness's own route patterns. The paths
 * arrive undecoded and are anchored at both ends, so an encoded traversal
 * fails to match and is denied rather than forwarded — the failure mode of
 * a strict pattern is a closed door, which is the one to have. */
const ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  // liveness — not used by the app, but it is the first thing anyone curls
  // when pairing will not work, and it discloses nothing
  { method: "GET", path: /^\/api\/health$/ },
  // configured-or-not booleans. The write side is refused below: reading
  // which providers are set up is not reading their keys.
  { method: "GET", path: /^\/api\/config$/ },
  { method: "GET", path: /^\/api\/events$/ },
  { method: "GET", path: /^\/api\/instances$/ },

  // the fleet, and making a bot
  { method: "GET", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  // Full cloud desktop access. The route is narrow and the proxy applies a
  // second, per-device capability check before it reaches the harness.
  CLOUD_DESKTOP_JOIN_ROUTE,

  // rooms
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/read$/ },

  // a transcript, its images, and answering an approval
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/export$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { method: "GET", path: /^\/api\/search$/ },
];

/** Route families worth naming in the refusal.
 *
 * Everything not allowed is denied either way; this only decides whether the
 * person gets a sentence or a 404. These are the ones someone might
 * reasonably expect to work from the phone, where "no route" would read as a
 * bug in the companion rather than a decision about where host configuration
 * happens. Order matters only in that the first match wins. */
const EXPLAINED: ReadonlyArray<{ path: RegExp; error: string }> = [
  {
    path: /^\/api\/(companion|devices)(\/|$)/,
    // Losing the phone must not mean losing the ability to lock it out.
    error: "companion settings are managed on your computer",
  },
  { path: /^\/api\/config$/, error: "API keys can only be changed on your computer" },
  { path: /^\/api\/local-computer(\/|$)/, error: "the Local VM is set up on your computer" },
  {
    // Creating one exposes an endpoint to the internet, and rotating a
    // secret breaks whatever was sending to it. Neither belongs on a device
    // that lives in a pocket.
    path: /^\/api\/webhooks(\/|$)/,
    error: "webhooks are set up on your computer",
  },
  { path: /^\/api\/connectors(\/|$)/, error: "connected apps are set up on your computer" },
  { path: /^\/api\/routines(\/|$)/, error: "routines are set up on your computer" },
  { path: /^\/api\/teams(\/|$)/, error: "teams are imported and exported on your computer" },
];

/** Why this request may not go through, or null when it may.
 *
 * Default deny: the answer for anything not on the list is "no route", which
 * is what keeps a stolen token from mapping the API. An allowlist rather than
 * a blocklist is the property this whole module exists for, and the one that
 * quietly stopped being true once before. */
export function denyReason({ path, method, authenticated }: RouteRequest): Denial | null {
  // Pairing is the one thing a device does before it has a credential.
  if (method === "POST" && path === "/api/pair") return null;

  if (!authenticated) {
    return { status: 401, error: "pair this device from the OpenMausBot companion on your computer" };
  }

  if (ALLOWED.some((route) => route.method === method && route.path.test(path))) return null;

  const explained = EXPLAINED.find((family) => family.path.test(path));
  if (explained) return { status: 403, error: explained.error };

  // Everything else, including routes the harness really does have. Saying
  // "no route" rather than "not allowed" keeps the sidecar from enumerating
  // the API to anyone holding a stolen token — and it is what the peer-agent
  // endpoints under /api/internal/ always got, since off this machine they
  // genuinely do not exist.
  return { status: 404, error: `no route: ${method} ${path}` };
}
