import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RoutineRunOn } from "./routines.ts";

export interface WebhookTrigger {
  id: string;
  endpointId: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastReceivedAt?: number;
  lastRunId?: string;
  deliveryCount: number;
}

export interface WebhookTriggerInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
}

interface StoredWebhookTrigger extends WebhookTrigger {
  secretHash: string;
}

interface DeliveryReceipt {
  key: string;
  runId: string;
  at: number;
}

interface WebhookFile {
  version: 1;
  webhooks: StoredWebhookTrigger[];
  deliveries: DeliveryReceipt[];
}

export interface WebhookEvent {
  payload: unknown;
  contentType?: string;
  eventName?: string;
  userAgent?: string;
  deliveryId?: string;
}

export interface WebhookReceiveResult {
  runId: string;
  deliveryId: string;
  duplicate: boolean;
}

export interface WebhookManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  enqueue: (input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }) => { id: string };
  cancelQueued?: (webhookId: string, message: string) => void;
}

const MAX_DELIVERIES = 2_000;
const MAX_EVENT_CHARS = 48_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(secret: string, expectedHex: string): boolean {
  if (!secret) return false;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newEndpointId(): string {
  return `wh_${randomBytes(12).toString("base64url")}`;
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function cleanInput(input: WebhookTriggerInput): Omit<WebhookTrigger, "id" | "endpointId" | "createdAt" | "updatedAt" | "lastReceivedAt" | "lastRunId" | "deliveryCount"> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
  const botId = String(input.botId ?? "").trim();
  const runOn = input.runOn ?? "maus";
  if (!name) fail(400, "Give the webhook a name");
  if (!prompt) fail(400, "Tell the MAUS what to do when the webhook arrives");
  if (!botId) fail(400, "Choose a MAUS");
  if (runOn !== "maus" && runOn !== "cloud") fail(400, "Choose where this webhook runs");
  return {
    name,
    prompt,
    botId,
    runOn,
    enabled: input.enabled !== false,
  };
}

function withoutLegacyDuration(trigger: StoredWebhookTrigger & { durationMinutes?: unknown }): StoredWebhookTrigger {
  const { durationMinutes: _durationMinutes, ...current } = trigger;
  return current;
}

function publicTrigger(trigger: StoredWebhookTrigger): WebhookTrigger {
  const { secretHash: _secretHash, ...safe } = trigger;
  return { ...safe };
}

function serializePayload(payload: unknown): string {
  let text: string;
  if (typeof payload === "string") text = payload;
  else {
    try {
      text = JSON.stringify(payload, null, 2);
    } catch {
      text = String(payload);
    }
  }
  if (text.length <= MAX_EVENT_CHARS) return text;
  return `${text.slice(0, MAX_EVENT_CHARS)}\n\n[Payload truncated by OpenMausBot]`;
}

function eventPrompt(trigger: StoredWebhookTrigger, event: WebhookEvent, receivedAt: number, deliveryId: string): string {
  const metadata = [
    `Received: ${new Date(receivedAt).toISOString()}`,
    `Delivery ID: ${deliveryId}`,
    event.eventName && `Event: ${event.eventName.slice(0, 200)}`,
    event.contentType && `Content-Type: ${event.contentType.slice(0, 200)}`,
    event.userAgent && `Sender: ${event.userAgent.slice(0, 300)}`,
  ].filter(Boolean);
  return [
    "[USER-CONFIGURED WEBHOOK INSTRUCTIONS]",
    trigger.prompt,
    "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]",
    "",
    "[UNTRUSTED WEBHOOK EVENT DATA]",
    ...metadata,
    "",
    serializePayload(event.payload),
    "[/UNTRUSTED WEBHOOK EVENT DATA]",
  ].join("\n");
}

export class WebhookManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: WebhookManagerOptions;
  private webhooks: StoredWebhookTrigger[] = [];
  private deliveries: DeliveryReceipt[] = [];
  private rate = new Map<string, number[]>();

  constructor(options: WebhookManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "webhooks.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<WebhookFile>;
      this.webhooks = Array.isArray(disk.webhooks) ? disk.webhooks.map(withoutLegacyDuration) : [];
      this.deliveries = Array.isArray(disk.deliveries) ? disk.deliveries.slice(-MAX_DELIVERIES) : [];
    } catch {
      this.webhooks = [];
      this.deliveries = [];
    }
  }

  list(): WebhookTrigger[] {
    return this.webhooks.map(publicTrigger);
  }

  create(input: WebhookTriggerInput): { webhook: WebhookTrigger; secret: string } {
    const clean = cleanInput(input);
    if (this.options.botState(clean.botId) === "missing") fail(400, "That MAUS no longer exists");
    const now = this.now();
    const secret = newSecret();
    const trigger: StoredWebhookTrigger = {
      id: randomUUID(),
      endpointId: newEndpointId(),
      ...clean,
      secretHash: hashSecret(secret),
      createdAt: now,
      updatedAt: now,
      deliveryCount: 0,
    };
    this.webhooks.unshift(trigger);
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  update(id: string, patch: Partial<WebhookTriggerInput>): WebhookTrigger | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const clean = cleanInput({
      name: patch.name ?? trigger.name,
      prompt: patch.prompt ?? trigger.prompt,
      botId: patch.botId ?? trigger.botId,
      runOn: patch.runOn ?? trigger.runOn,
      enabled: patch.enabled ?? trigger.enabled,
    });
    if (this.options.botState(clean.botId) === "missing") fail(400, "That MAUS no longer exists");
    Object.assign(trigger, clean, { updatedAt: this.now() });
    if (patch.enabled === false) {
      this.options.cancelQueued?.(trigger.id, "The webhook was paused before this delivery started");
    }
    this.save();
    this.emit(trigger);
    return publicTrigger(trigger);
  }

  remove(id: string): boolean {
    const at = this.webhooks.findIndex((candidate) => candidate.id === id);
    if (at === -1) return false;
    const [trigger] = this.webhooks.splice(at, 1);
    this.deliveries = this.deliveries.filter((delivery) => !delivery.key.startsWith(`${trigger.endpointId}:`));
    this.rate.delete(trigger.endpointId);
    this.options.cancelQueued?.(trigger.id, "The webhook was deleted before this delivery started");
    this.save();
    this.options.emit?.({ kind: "webhook.deleted", webhookId: id });
    return true;
  }

  rotateSecret(id: string): { webhook: WebhookTrigger; secret: string } | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const secret = newSecret();
    trigger.secretHash = hashSecret(secret);
    trigger.updatedAt = this.now();
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  disableForBot(botId: string): void {
    let changed = false;
    for (const trigger of this.webhooks) {
      if (trigger.botId !== botId || !trigger.enabled) continue;
      trigger.enabled = false;
      trigger.updatedAt = this.now();
      this.options.cancelQueued?.(trigger.id, "The assigned MAUS was deleted");
      this.emit(trigger);
      changed = true;
    }
    if (changed) this.save();
  }

  authorize(endpointId: string, secret: string): boolean {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    return Boolean(trigger && secretMatches(secret, trigger.secretHash));
  }

  receive(endpointId: string, secret: string, event: WebhookEvent): WebhookReceiveResult {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger || !secretMatches(secret, trigger.secretHash)) fail(401, "Invalid webhook URL or secret");
    return this.dispatch(trigger, event);
  }

  test(id: string, payload: unknown = { event: "openmaus.test", message: "Test webhook delivery" }): WebhookReceiveResult | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    return this.dispatch(trigger, {
      payload,
      contentType: "application/json",
      eventName: "openmaus.test",
      userAgent: "OpenMausBot webhook tester",
      deliveryId: `test-${randomUUID()}`,
    });
  }

  private dispatch(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    if (!trigger.enabled) fail(409, "This webhook is paused");
    if (this.options.botState(trigger.botId) === "missing") fail(410, "The assigned MAUS no longer exists");

    const now = this.now();
    const requestedDeliveryId = String(event.deliveryId ?? "").trim().slice(0, 200);
    if (requestedDeliveryId) {
      const key = `${trigger.endpointId}:${requestedDeliveryId}`;
      const duplicate = this.deliveries.find((delivery) => delivery.key === key);
      if (duplicate) return { runId: duplicate.runId, deliveryId: requestedDeliveryId, duplicate: true };
    }

    const recent = (this.rate.get(trigger.endpointId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) fail(429, "Webhook rate limit exceeded");
    recent.push(now);
    this.rate.set(trigger.endpointId, recent);

    const deliveryId = requestedDeliveryId || randomUUID();
    const run = this.options.enqueue({
      webhookId: trigger.id,
      webhookName: trigger.name,
      prompt: eventPrompt(trigger, event, now, deliveryId),
      botId: trigger.botId,
      runOn: trigger.runOn,
      deliveryId,
      receivedAt: now,
    });
    this.deliveries.push({ key: `${trigger.endpointId}:${deliveryId}`, runId: run.id, at: now });
    if (this.deliveries.length > MAX_DELIVERIES) {
      this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
    }
    trigger.lastReceivedAt = now;
    trigger.lastRunId = run.id;
    trigger.deliveryCount += 1;
    trigger.updatedAt = now;
    this.save();
    this.emit(trigger);
    return { runId: run.id, deliveryId, duplicate: false };
  }

  private emit(trigger: StoredWebhookTrigger): void {
    this.options.emit?.({ kind: "webhook", webhook: publicTrigger(trigger) });
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, webhooks: this.webhooks, deliveries: this.deliveries } satisfies WebhookFile, null, 2),
      { mode: 0o600 },
    );
  }
}
