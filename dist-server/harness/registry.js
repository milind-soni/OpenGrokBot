// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { findCliCandidates } from "../env-path.js";
/** The `cli` field off a driver's default config, when it has one — the
 * placeholder an override input shows when nothing is set. */
function cliDefaultOf(driver) {
    if (!driver)
        return undefined;
    try {
        const cfg = driver.defaultConfig();
        return typeof cfg?.cli === "string" ? cfg.cli : undefined;
    }
    catch {
        return undefined;
    }
}
/** Raw `config.cli` straight from disk — shadow snapshots can't decode, so
 * this is the only faithful way to echo back what was configured. */
function cliOfRaw(raw) {
    const cli = raw?.cli;
    return typeof cli === "string" && cli ? cli : undefined;
}
export class ProviderRegistry {
    byId = new Map();
    /** decoded per-instance `cli` overrides, for describe() — drivers spawn
     * from their own config; this map only reports what was configured */
    cliByInstance = new Map();
    driversByKind;
    constructor(drivers) {
        this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
    }
    async load(configs) {
        for (const [instanceId, entry] of Object.entries(configs)) {
            const driver = this.driversByKind.get(entry.driver);
            if (!driver) {
                this.byId.set(instanceId, {
                    instanceId,
                    shadow: {
                        instanceId,
                        driverKind: entry.driver,
                        displayName: entry.displayName,
                        cli: cliOfRaw(entry.config),
                        shadow: true,
                        reason: `unknown driver "${entry.driver}" — kept as configured, unavailable here`,
                    },
                });
                continue;
            }
            try {
                const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
                // Override detection is on the RAW config, never the decoded one:
                // decodeConfig fills in the driver default ("claude", "codex", …),
                // so reading `cli` there would flag every instance as overridden.
                const rawCli = cliOfRaw(entry.config);
                if (rawCli)
                    this.cliByInstance.set(instanceId, rawCli);
                const live = await driver.create({
                    instanceId,
                    displayName: entry.displayName ?? driver.metadata.displayName,
                    environment: entry.environment ?? {},
                    enabled: entry.enabled ?? true,
                    config,
                });
                this.byId.set(instanceId, { instanceId, live });
            }
            catch (e) {
                this.byId.set(instanceId, {
                    instanceId,
                    shadow: {
                        instanceId,
                        driverKind: entry.driver,
                        displayName: entry.displayName ?? driver.metadata.displayName,
                        cli: cliOfRaw(entry.config),
                        shadow: true,
                        reason: e instanceof Error ? e.message : String(e),
                    },
                });
            }
        }
    }
    get(instanceId) {
        return this.byId.get(instanceId)?.live ?? null;
    }
    entries() {
        return [...this.byId.values()];
    }
    instances() {
        return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
    }
    /** instance snapshots for the model picker: id, driver, models, health */
    async describe() {
        // Multiple instances may share a driver. Scan each default binary once
        // per response instead of repeating filesystem work for every row.
        const candidatesByName = new Map();
        const candidatesFor = (driver) => {
            const name = cliDefaultOf(driver);
            if (!name)
                return [];
            const cached = candidatesByName.get(name);
            if (cached)
                return cached;
            const found = findCliCandidates(name);
            candidatesByName.set(name, found);
            return found;
        };
        return Promise.all(this.entries().map(async (entry) => {
            const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live.driverKind);
            if (entry.shadow) {
                return {
                    instanceId: entry.instanceId,
                    driverKind: entry.shadow.driverKind,
                    displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
                    snapshot: { state: "unavailable", reason: entry.shadow.reason },
                    models: { default: "", options: [] },
                    capabilities: { computerMcp: false, agentsMcp: false },
                    // an unknown driver has no driver record, hence no install path
                    access: driver?.metadata.access ?? "subscription",
                    install: driver?.install,
                    cli: entry.shadow.cli,
                    cliDefault: cliDefaultOf(driver),
                    // a shadow is exactly the "your CLI is broken, pick another"
                    // case where the detected-path dropdown matters most
                    cliCandidates: candidatesFor(driver),
                };
            }
            const inst = entry.live;
            let snapshot;
            try {
                await inst.refreshModels?.();
                snapshot = await inst.snapshot();
            }
            catch (e) {
                snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
            }
            return {
                instanceId: inst.instanceId,
                driverKind: inst.driverKind,
                displayName: inst.displayName ?? inst.driverKind,
                snapshot,
                models: inst.models,
                capabilities: {
                    computerMcp: inst.adapter.capabilities.computerMcp === true,
                    agentsMcp: inst.adapter.capabilities.agentsMcp === true,
                    effortLevels: inst.adapter.capabilities.effortLevels,
                },
                access: driver?.metadata.access ?? "subscription",
                install: driver?.install,
                cli: this.cliByInstance.get(inst.instanceId),
                cliDefault: cliDefaultOf(driver),
                // every copy of the driver's default binary on the augmented PATH —
                // the dropdown's "detected" entries. Snapshotted per describe() so a
                // newly installed CLI shows up on the next refresh.
                cliCandidates: candidatesFor(driver),
            };
        }));
    }
    async disposeAll() {
        await Promise.allSettled(this.instances().map((i) => i.dispose()));
        this.byId.clear();
        this.cliByInstance.clear();
    }
}
