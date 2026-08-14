import { Loader2, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, useStore } from "@/state/store";

const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

/** A small local template library. The harness deliberately sends only
 * metadata to the renderer; instructions are retained in local config until
 * a bot is created from the template. */
export function TaskTemplatesManager() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [computer, setComputer] = useState<"cloud" | "local" | "off">("off");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = state.config?.templates?.items ?? [];
  const refresh = () => api("/api/config").then((config) => dispatch({ type: "configStatus", config }));

  const create = async () => {
    setError(null);
    setBusy("create");
    try {
      await api("/api/templates", {
        method: "POST",
        body: JSON.stringify({ name, title, instructions, computer }),
      });
      setName("");
      setTitle("");
      setInstructions("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save template");
    } finally {
      setBusy(null);
    }
  };

  const instantiate = async (id: string) => {
    setError(null);
    setBusy(`use:${id}`);
    try {
      const { bot } = await api("/api/bots", { method: "POST", body: JSON.stringify({ templateId: id }) });
      dispatch({ type: "botAdded", bot });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create bot");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    setBusy(`delete:${id}`);
    try {
      await api(`/api/templates/${id}`, { method: "DELETE" });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete template");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Task templates</div>
      <p className="mt-0.5 text-[13px] text-ink-secondary">
        Save a repeatable starting brief, then create a bot with those instructions and computer preference.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        <input aria-label="Template name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Template name" className={inputClass} />
        <input aria-label="Bot title (optional)" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Bot title (optional)" className={inputClass} />
        <textarea
          aria-label="Reusable instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Reusable instructions, expected result, and checks"
          rows={4}
          className={`${inputClass} resize-y`}
        />
        <label className="flex items-center justify-between gap-3 text-[13px] text-ink-secondary">
          Computer preference
          <select aria-label="Computer preference" value={computer} onChange={(event) => setComputer(event.target.value as typeof computer)} className="rounded-md bg-inset px-2 py-1 text-ink">
            <option value="off">Off</option>
            <option value="local">Local</option>
            <option value="cloud">Cloud</option>
          </select>
        </label>
        <button
          onClick={() => void create()}
          disabled={busy !== null || !name.trim() || !instructions.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {busy === "create" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Save template
        </button>
      </div>
      {error && <p role="alert" className="mt-3 text-[13px] text-red-500">{error}</p>}
      {items.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {items.map((item) => (
            <div key={item.id} className="rounded-lg bg-inset px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[13px] font-medium text-ink">{item.name}</div>
                  {item.title && <div className="text-[12px] text-ink-secondary">{item.title}</div>}
                </div>
                <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink-secondary">{item.computer ?? "auto"}</span>
              </div>
              {item.description && <p className="mt-1 text-[12px] text-ink-secondary">{item.description}</p>}
              <div className="mt-2 flex gap-2">
                <button onClick={() => void instantiate(item.id)} disabled={busy !== null} className="inline-flex items-center gap-1 text-[12px] font-medium text-accent disabled:opacity-40">
                  {busy === `use:${item.id}` ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  Use template
                </button>
                <button onClick={() => void remove(item.id)} disabled={busy !== null} aria-label={`Delete ${item.name}`} className="inline-flex items-center gap-1 text-[12px] text-ink-secondary hover:text-red-500 disabled:opacity-40">
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
