// App Settings → Vault. Where a user stores the sign-ins a bot may use to
// reach the user's own accounts (Gmail → Drive/Sheets, and the long tail of
// password sites) inside an isolated computer, WITHOUT the OAuth plugin.
//
// The renderer only ever sees metadata: the origin, the username, whether a
// TOTP seed is set, and the scope (which bots, which contexts). The password
// itself lives in Electron main, encrypted by the OS keystore, and is shown
// back only through an OS-auth-gated reveal. The model never sees it at all —
// a fill (a later phase) types it into the isolated computer without the
// secret ever crossing into the harness or a tool call.
//
// See docs/superpowers/specs/2026-08-19-bot-credential-vault-design.md.
import { useEffect, useState } from "react";
import { Eye, KeySquare, Loader2, Plus, ShieldCheck, Trash2, Wand2 } from "lucide-react";
import { useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { MausAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import type { MausColor } from "@/lib/mascot";

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

const CONTEXT_LABEL: Record<VaultContext, string> = { vm: "Local VM", box: "Cloud box" };

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function VaultSection() {
  const { state } = useStore();
  const bridge = window.ogb?.vault;
  const [entries, setEntries] = useState<VaultEntryMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<VaultEntryMeta | "new" | null>(null);
  const bots = state.bots.filter((b) => !b.hidden);

  const load = () => {
    bridge
      ?.list()
      .then((e) => (setEntries(e), setError(null)))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!bridge) {
    return (
      <Card title="Vault" subtitle="Sign-ins your bots may use inside an isolated computer.">
        <div className="text-[13px] text-ink-secondary">
          The vault needs the desktop app — it stores passwords in your operating system's keychain. It isn't available in the browser.
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Vault"
      subtitle="Sign-ins a bot may use to reach your own accounts inside an isolated computer. Passwords are stored in your OS keychain and never shown to the AI."
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2 rounded-xl border border-hairline/40 bg-inset/50 px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-secondary">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#38d591]" />
          <span>
            The model never sees these passwords. When a bot signs in, the app types the credential straight into the isolated computer — it never enters a prompt, a tool result, or the transcript. Fills happen only in a Local VM or Cloud box, never your own browser.
          </span>
        </div>

        {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}

        {editing ? (
          <VaultForm
            entry={editing === "new" ? null : editing}
            bots={bots}
            onDone={(changed) => {
              setEditing(null);
              if (changed) load();
            }}
          />
        ) : (
          <>
            {entries === null ? (
              <div className="flex items-center gap-2 py-4 text-ink-secondary">
                <Loader2 size={15} className="animate-spin" /> Loading…
              </div>
            ) : entries.length === 0 ? (
              <div className="rounded-xl border border-dashed border-hairline/50 px-4 py-6 text-center text-[13px] text-ink-secondary">
                No sign-ins yet. Add one to let a bot log in on your behalf inside a VM.
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-hairline/20">
                {entries.map((entry) => (
                  <VaultRow key={entry.id} entry={entry} bots={bots} onEdit={() => setEditing(entry)} onChanged={load} onError={setError} />
                ))}
              </div>
            )}
            <button
              onClick={() => setEditing("new")}
              className="mt-1 flex items-center justify-center gap-1.5 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:brightness-110"
            >
              <Plus size={15} /> Add a sign-in
            </button>
          </>
        )}
      </div>
    </Card>
  );
}

function VaultRow({
  entry,
  bots,
  onEdit,
  onChanged,
  onError,
}: {
  entry: VaultEntryMeta;
  bots: Array<{ id: string; name: string; color: MausColor }>;
  onEdit: () => void;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const allowed = entry.allowedBots.length === 0 ? "Any bot" : bots.filter((b) => entry.allowedBots.includes(b.id)).map((b) => b.name).join(", ") || "specific bots";

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await window.ogb!.vault!.testFill!(entry.id, "password");
      setTestResult(
        r.outcome === "filled"
          ? `Filled into the focused field on ${r.origin}.`
          : r.outcome === "no-match"
            ? `The open page (${r.origin ?? "?"}) doesn't match this entry (${r.entryOrigin ?? entry.origin}).`
            : r.outcome === "no-origin"
              ? `Couldn't read the page origin — ${r.reason ?? ""}`
              : `${r.outcome}${r.reason ? ` — ${r.reason}` : ""}`,
      );
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex items-start gap-3 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
        <KeySquare size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
          {hostOf(entry.origin)}
          {entry.hasTotp && <span className="rounded bg-inset px-1.5 py-0.5 text-[10px] font-normal text-ink-secondary">2FA</span>}
        </div>
        <div className="mt-0.5 text-[12.5px] text-ink-secondary">{entry.username || "no username"}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
          <span className="rounded bg-inset px-1.5 py-0.5">{allowed}</span>
          {entry.contexts.map((c) => (
            <span key={c} className="rounded bg-inset px-1.5 py-0.5">
              {CONTEXT_LABEL[c]}
            </span>
          ))}
          {entry.askEveryFill && <span className="rounded bg-inset px-1.5 py-0.5">asks each time</span>}
        </div>
        {revealed !== null && <div className="mt-1.5 rounded-lg bg-inset px-2.5 py-1.5 font-mono text-[12px] text-ink">{revealed}</div>}
        {testResult && <div className="mt-1.5 rounded-lg bg-inset px-2.5 py-1.5 text-[11.5px] text-ink-secondary">{testResult}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          title="Reveal (asks for your fingerprint)"
          onClick={() =>
            revealed !== null
              ? setRevealed(null)
              : window.ogb!.vault!.reveal(entry.id).then((r) => setRevealed(r.secret)).catch((e) => onError(e instanceof Error ? e.message : String(e)))
          }
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Eye size={15} />
        </button>
        <button
          title="Test fill into the focused browser field"
          disabled={testing}
          onClick={() => void runTest()}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
        >
          {testing ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
        </button>
        <button onClick={onEdit} className="rounded-md px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">
          Edit
        </button>
        <button
          title="Delete"
          onClick={() => window.ogb!.vault!.remove(entry.id).then(onChanged).catch((e) => onError(e instanceof Error ? e.message : String(e)))}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

function VaultForm({
  entry,
  bots,
  onDone,
}: {
  entry: VaultEntryMeta | null;
  bots: Array<{ id: string; name: string; color: MausColor }>;
  onDone: (changed: boolean) => void;
}) {
  const [origin, setOrigin] = useState(entry ? hostOf(entry.origin) : "");
  const [username, setUsername] = useState(entry?.username ?? "");
  const [secret, setSecret] = useState("");
  const [totpSeed, setTotpSeed] = useState("");
  const [allowedBots, setAllowedBots] = useState<string[]>(entry?.allowedBots ?? []);
  const [contexts, setContexts] = useState<VaultContext[]>(entry?.contexts ?? ["vm", "box"]);
  const [askEveryFill, setAskEveryFill] = useState(entry?.askEveryFill ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = <T,>(list: T[], v: T, set: (l: T[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.ogb!.vault!.upsert({
        id: entry?.id,
        origin: origin.trim(),
        username: username.trim(),
        secret,
        totpSeed: totpSeed.trim() || undefined,
        allowedBots,
        contexts: contexts.length ? contexts : ["vm", "box"],
        askEveryFill,
      });
      onDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-hairline/40 bg-inset/40 p-4">
      <div className="text-[14px] font-medium text-ink">{entry ? "Edit sign-in" : "New sign-in"}</div>
      <label className="block">
        <span className="mb-1 block text-[12px] text-ink-secondary">Site</span>
        <input className={inputCls} value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="accounts.google.com" autoFocus />
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] text-ink-secondary">Username / email</span>
        <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="you@gmail.com" />
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] text-ink-secondary">Password{entry ? " · leave blank to keep" : ""}</span>
        <input className={cn(inputCls, "font-mono")} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••••" />
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] text-ink-secondary">
          2FA seed <span className="font-normal">· optional, the TOTP secret from the site's authenticator setup</span>
        </span>
        <input className={cn(inputCls, "font-mono")} value={totpSeed} onChange={(e) => setTotpSeed(e.target.value)} placeholder="JBSWY3DPEHPK3PXP" />
      </label>

      <div>
        <span className="mb-1.5 block text-[12px] text-ink-secondary">Which bots may use it</span>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setAllowedBots([])}
            className={cn("rounded-lg border px-2.5 py-1 text-[12px]", allowedBots.length === 0 ? "border-accent/70 bg-accent/10 text-ink" : "border-hairline/50 text-ink-secondary hover:bg-raised/60")}
          >
            Any bot
          </button>
          {bots.map((b) => (
            <button
              key={b.id}
              onClick={() => toggle(allowedBots, b.id, setAllowedBots)}
              className={cn("flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px]", allowedBots.includes(b.id) ? "border-accent/70 bg-accent/10 text-ink" : "border-hairline/50 text-ink-secondary hover:bg-raised/60")}
            >
              <MausAvatar color={b.color} state="idle" size={16} animated={false} />
              {b.name}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-1.5 block text-[12px] text-ink-secondary">Where it may be used</span>
        <div className="flex gap-1.5">
          {(["vm", "box"] as VaultContext[]).map((c) => (
            <button
              key={c}
              onClick={() => toggle(contexts, c, setContexts)}
              className={cn("rounded-lg border px-2.5 py-1 text-[12px]", contexts.includes(c) ? "border-accent/70 bg-accent/10 text-ink" : "border-hairline/50 text-ink-secondary hover:bg-raised/60")}
            >
              {CONTEXT_LABEL[c]}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-secondary/70">Never your own browser — only an isolated computer.</p>
      </div>

      <label className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
        <input type="checkbox" checked={askEveryFill} onChange={(e) => setAskEveryFill(e.target.checked)} />
        Ask me to approve every sign-in
      </label>

      {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={() => onDone(false)} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={saving || !origin.trim() || (!entry && !secret)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {entry ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}
