// App Settings → Companion. Turning this on starts the companion sidecar: a
// separate process that opens an authenticated port a paired phone can
// reach. Everything else in the app keeps talking to 127.0.0.1 exactly as
// before, and the harness itself is untouched.
//
// The sidecar is separate on purpose — it is the only thing here that
// listens off this machine, and keeping it out of the harness is what lets
// the harness stay loopback-only. That is an implementation detail from this
// panel's point of view, which is the point: a toggle, a code, a list of
// devices. Nobody should need a terminal to use their phone.
//
// The panel is deliberately blunt about what it does. "Your bots can run
// shell commands" is the honest reason a network switch here deserves a
// sentence of explanation rather than a bare toggle.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Smartphone, Trash2 } from "lucide-react";
import { Card } from "./SettingsPrimitives";

interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

interface CompanionState {
  enabled: boolean;
  port: number;
  devices: Device[];
  pairing: { code: string; expiresAt: number } | null;
  /** Every address a phone could dial, and which of them is which. */
  addresses?: string[];
  /** The tailnet address, when this machine is on one. */
  tailscale?: string;
  /** Its MagicDNS name. Preferred over the address for anything typed into
   * a phone: iOS refuses plain HTTP to 100.64/10, which is CGNAT space and
   * not one of the ranges its local-networking exemption covers, and ATS
   * exceptions match by name rather than by subnet. */
  tailnetName?: string;
  lan?: string | null;
  /** Bonjour: when advertising, the phone finds this computer by name. */
  discovery?: { advertising: boolean; name: string };
  /** Why it is not running, or not answering. */
  error?: string;
}

/** The bridge the preload exposes. Absent in a browser tab — the companion
 * needs a process only the desktop app can start. */
type Bridge = {
  state: () => Promise<CompanionState>;
  start: () => Promise<CompanionState>;
  stop: () => Promise<CompanionState>;
  pairing: (open: boolean) => Promise<CompanionState>;
  revoke: (deviceId: string) => Promise<CompanionState>;
};

const bridge = (): Bridge | null =>
  (globalThis as { ogb?: { companion?: Bridge } }).ogb?.companion ?? null;

const relative = (at: number) => {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

export function CompanionSection() {
  const [state, setState] = useState<CompanionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const companion = bridge();
    if (!companion) return;
    try {
      setState(await companion.state());
    } catch {
      /* the main process is gone; the rest of the app already says so */
    }
  }, []);

  const act = async (call: (companion: Bridge) => Promise<CompanionState>) => {
    const companion = bridge();
    if (!companion) return;
    setBusy(true);
    setError(null);
    try {
      setState(await call(companion));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  // Two cadences, because the panel has two jobs.
  //
  // While a code is on screen it has to count down, and the same tick is what
  // notices the phone on the other end finishing the handshake — one second.
  // The rest of the time it still has to notice the sidecar going away, which
  // it cannot do by sitting still: the process can exit on its own (port
  // taken, crash, a stop from the standalone page) and nothing pushes that
  // here. Polling only during pairing left the panel showing a companion that
  // had not existed for hours. Ten seconds is cheap on loopback and well
  // inside how long anyone looks at a settings pane before believing it.
  const pairing = Boolean(state?.pairing);
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        setNow(Date.now());
        void load();
      },
      pairing ? 1_000 : 10_000,
    );
    return () => window.clearInterval(timer);
  }, [pairing, load]);

  if (!bridge()) {
    return (
      <Card
        title="Companion"
        subtitle="The companion runs as its own process, which only the desktop app can start. Open OpenMausBot on this computer to turn it on."
      >
        <div />
      </Card>
    );
  }

  if (!state) {
    return (
      <Card title="Companion" subtitle="Loading…">
        <Loader2 size={15} className="animate-spin text-ink-secondary" />
      </Card>
    );
  }

  const secondsLeft = state.pairing ? Math.max(0, Math.round((state.pairing.expiresAt - now) / 1000)) : 0;
  // Prefer the tailnet when there is one: it survives changing wifi, works
  // away from home, and gets through a guest network that isolates its
  // clients — the case where a LAN address looks perfectly correct and
  // reaches nothing. The name beats the address because a phone can only
  // use the name.
  const tailnet = state.tailnetName ?? state.tailscale;
  const address = tailnet ?? state.addresses?.[0];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Companion"
        subtitle="Let a phone open your chats, answer approvals, and send new work. Off by default: your bots run commands on this computer, so only pair a device you trust, on a network you trust."
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[14px] text-ink">{state.enabled ? "On" : "Off"}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!state.enabled
                ? "Nothing on this computer is reachable from the network."
                : !address
                  ? `Listening on port ${state.port} — no network address yet.`
                  : tailnet
                    ? `Enter ${tailnet}:${state.port} on your phone — that works from anywhere on your tailnet, on any network.`
                    : state.discovery?.advertising
                      ? // The address is shown even when Bonjour is working.
                        // Discovery can be advertising happily and still not
                        // reach the phone — a guest network that isolates its
                        // clients blocks multicast — and when that happens the
                        // typed address is the way out. Hiding it behind a
                        // failure the panel cannot detect is no help at all.
                        `Your phone will find this computer as "${state.discovery.name}", or you can enter ${address}:${state.port}.`
                      : `Listening on ${address}:${state.port} — enter that on your phone.`}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={state.enabled}
            aria-label="Companion"
            disabled={busy}
            onClick={() => void act((c) => (state.enabled ? c.stop() : c.start()))}
            className={cnSwitch(state.enabled)}
          >
            <span className={cnKnob(state.enabled)} />
          </button>
        </div>
        {state.enabled && tailnet && state.lan && (
          <div className="mt-3 text-[13px] text-ink-secondary">
            On this network only: {state.lan}:{state.port}
          </div>
        )}
        {/* A tailnet address with no name is workable on a laptop and not on
            a phone, so say so rather than letting pairing fail with an
            unexplained policy error. */}
        {state.enabled && state.tailscale && !state.tailnetName && (
          <div className="mt-3 text-[13px] text-ink-secondary">
            You're on a tailnet, but this computer's MagicDNS name couldn't be read from the
            Tailscale app — either MagicDNS is off, or the Tailscale command line tool isn't
            where we looked. iPhones can't connect to a bare tailnet address, so check the
            OpenMausBot log for which paths were tried.
          </div>
        )}
        {state.enabled && !state.tailscale && (
          <div className="mt-3 text-[13px] text-ink-secondary">
            Only reachable on this network. Install Tailscale on both this computer and your phone
            to reach it from anywhere — including networks that stop devices from seeing each other.
          </div>
        )}
        {(error || state.error) && (
          <div className="mt-3 text-[13px] text-danger">{error ?? state.error}</div>
        )}
      </Card>

      {state.enabled && (
        <Card
          title="Pair a phone"
          subtitle={
            state.pairing
              ? state.discovery?.advertising
                ? "Open OpenMausBot on your phone, pick this computer from the list, and enter the code."
                : "Open OpenMausBot on your phone, enter the address below, then the code."
              : "Start pairing, then enter the code on your phone. The code lasts two minutes."
          }
        >
          {state.pairing ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-mono text-[28px] tracking-[0.3em] text-ink">{state.pairing.code}</div>
                <div className="mt-1 text-[13px] text-ink-secondary">
                  Expires in {secondsLeft}s{address ? ` · ${address}:${state.port}` : ""}
                </div>
              </div>
              <button
                disabled={busy}
                onClick={() => void act((c) => c.pairing(false))}
                className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              disabled={busy}
              onClick={() => void act((c) => c.pairing(true))}
              className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
            >
              Start pairing
            </button>
          )}
        </Card>
      )}

      <Card
        title="Paired devices"
        subtitle={
          state.devices.length
            ? "Removing a device signs it out immediately."
            : "No phones are paired yet."
        }
      >
        {state.devices.length > 0 && (
          <ul className="flex flex-col gap-2">
            {state.devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 rounded-lg bg-inset px-3 py-2">
                <Smartphone size={15} className="shrink-0 text-ink-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] text-ink">{device.name}</div>
                  <div className="text-[12px] text-ink-secondary">Last seen {relative(device.lastSeenAt)}</div>
                </div>
                <button
                  disabled={busy}
                  onClick={() => void act((c) => c.revoke(device.id))}
                  aria-label={`Remove ${device.name}`}
                  className="shrink-0 rounded p-1 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-accent" : "bg-raised"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;
