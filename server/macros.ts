// Macros — recorded input sequences, persisted to ~/.openmausbot/macros.json.
// A macro is an array of {t, type, ...} actions exactly as emitted by the
// Electron recorder; replay happens in Electron main (SendInput) and is
// triggered from the renderer. The server owns storage + listing only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export interface MacroAction {
  t: number;
  type: "move" | "down" | "up" | "wheel" | "key";
  x?: number;
  y?: number;
  button?: string;
  delta?: number;
  vk?: number;
  ext?: boolean;
  down?: boolean;
}

export interface Macro {
  id: string;
  botId: string;
  name: string;
  actions: MacroAction[];
  durationMs: number;
  createdAt: number;
}

const MACROS_FILE = join(DATA_DIR, "macros.json");

export class MacroStore {
  private macros: Macro[] = [];

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      const raw = JSON.parse(readFileSync(MACROS_FILE, "utf8"));
      this.macros = Array.isArray(raw) ? raw : [];
    } catch {
      this.macros = [];
    }
  }

  private save() {
    writeFileSync(MACROS_FILE, JSON.stringify(this.macros, null, 2));
  }

  all(): Macro[] {
    return this.macros;
  }

  forBot(botId: string): Macro[] {
    return this.macros.filter((m) => m.botId === botId);
  }

  get(id: string): Macro | null {
    return this.macros.find((m) => m.id === id) ?? null;
  }

  create(botId: string, name: string, actions: MacroAction[]): Macro {
    if (!Array.isArray(actions) || !actions.length) {
      throw Object.assign(new Error("no recorded actions"), { status: 400 });
    }
    const macro: Macro = {
      id: newId(),
      botId,
      name: String(name ?? "").trim() || "Untitled macro",
      actions,
      durationMs: Math.max(0, actions[actions.length - 1]?.t ?? 0),
      createdAt: Date.now(),
    };
    this.macros.unshift(macro);
    this.save();
    return macro;
  }

  remove(id: string): boolean {
    const before = this.macros.length;
    this.macros = this.macros.filter((m) => m.id !== id);
    const removed = this.macros.length !== before;
    if (removed) this.save();
    return removed;
  }
}
