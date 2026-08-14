import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";

export function SkillsManager() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const items = state.config?.skills?.items ?? [];
  const refresh = () => api("/api/config").then((config: ConfigStatus) => dispatch({ type: "configStatus", config }));
  const refreshAfterWrite = async () => {
    try { await refresh(); }
    catch { setError("Skill saved, but could not refresh the library."); }
  };
  const add = async () => {
    setError(null); setMutating(true);
    try {
      await api("/api/skills", { method: "POST", body: JSON.stringify({ name, description, instructions }) });
      setName(""); setDescription(""); setInstructions("");
      await refreshAfterWrite();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save skill"); }
    finally { setMutating(false); }
  };
  const toggle = async (id: string, enabled: boolean) => {
    setError(null); setMutating(true);
    try { await api(`/api/skills/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !enabled }) }); await refreshAfterWrite(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update skill"); }
    finally { setMutating(false); }
  };
  const remove = async (id: string) => {
    setError(null); setMutating(true);
    try { await api(`/api/skills/${id}`, { method: "DELETE" }); await refreshAfterWrite(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not remove skill"); }
    finally { setMutating(false); }
  };
  const input = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return <div className="mt-4 rounded-xl bg-card p-4">
    <div className="text-[15px] font-medium text-ink">Skills library</div>
    <div className="mt-0.5 text-[13px] text-ink-secondary">Reusable local instructions. Enable and assign them per bot.</div>
    <div className="mt-3 flex flex-col gap-2">
      <label className="text-[12px] text-ink-secondary">Skill name<input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Skill name" /></label>
      <label className="text-[12px] text-ink-secondary">Description<input className={input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this skill helps with" /></label>
      <label className="text-[12px] text-ink-secondary">Instructions<textarea className={`${input} min-h-[76px] resize-y`} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Instructions the selected bot should follow" /></label>
      <button disabled={mutating || !name.trim() || !instructions.trim()} onClick={() => void add()} className="flex items-center justify-center gap-1 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"><Plus size={14} /> Add skill</button>
    </div>
    {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    <div className="mt-3 flex flex-col gap-2">{items.length === 0 && <div className="rounded-lg bg-inset px-3 py-2 text-[13px] text-ink-secondary">No skills yet.</div>}{items.map((skill) => <div key={skill.id} className="flex items-start justify-between gap-2 rounded-lg bg-inset px-3 py-2"><div><div className="text-[13px] font-medium text-ink">{skill.name}</div><div className="text-[11px] text-ink-secondary">{skill.description || `${skill.source} · v${skill.version}`}</div></div><div className="flex gap-1"><button disabled={mutating} onClick={() => void toggle(skill.id, skill.enabled)} className="rounded px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised">{skill.enabled ? "On" : "Off"}</button><button disabled={mutating} onClick={() => void remove(skill.id)} className="rounded p-1 text-danger hover:bg-raised" aria-label={`Remove ${skill.name}`}><Trash2 size={14} /></button></div></div>)}</div>
  </div>;
}
