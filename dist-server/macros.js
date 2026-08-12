// Macros — recorded input sequences, persisted to ~/.openmausbot/macros.json.
// A macro is an array of {t, type, ...} actions exactly as emitted by the
// Electron recorder; replay happens in Electron main (SendInput) and is
// triggered from the renderer. The server owns storage + listing only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { newId } from "./contracts.js";
const MACROS_FILE = join(DATA_DIR, "macros.json");
export class MacroStore {
    macros = [];
    constructor() {
        mkdirSync(DATA_DIR, { recursive: true });
        try {
            const raw = JSON.parse(readFileSync(MACROS_FILE, "utf8"));
            this.macros = Array.isArray(raw) ? raw : [];
        }
        catch {
            this.macros = [];
        }
    }
    save() {
        writeFileSync(MACROS_FILE, JSON.stringify(this.macros, null, 2));
    }
    all() {
        return this.macros;
    }
    forBot(botId) {
        return this.macros.filter((m) => m.botId === botId);
    }
    get(id) {
        return this.macros.find((m) => m.id === id) ?? null;
    }
    create(botId, name, actions) {
        if (!Array.isArray(actions) || !actions.length) {
            throw Object.assign(new Error("no recorded actions"), { status: 400 });
        }
        const macro = {
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
    remove(id) {
        const before = this.macros.length;
        this.macros = this.macros.filter((m) => m.id !== id);
        const removed = this.macros.length !== before;
        if (removed)
            this.save();
        return removed;
    }
}
