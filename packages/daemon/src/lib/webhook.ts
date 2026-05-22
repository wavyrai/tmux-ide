import { createHmac } from "node:crypto";
import { readConfig, writeConfig } from "./yaml-io.ts";
import type { OrchestratorEvent, StructuredEvent } from "./event-log.ts";

export interface WebhookConfig {
  url: string;
  events?: string[];
  secret?: string;
}

export interface WebhookWithId extends WebhookConfig {
  webhookId: string;
}

function webhookIdForIndex(index: number): string {
  return `webhook-${index}`;
}

function parseWebhookId(webhookId: string): number | null {
  const match = /^webhook-(\d+)$/.exec(webhookId);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

export function addWebhookConfig(dir: string, webhook: WebhookConfig): WebhookWithId {
  const { config } = readConfig(dir);
  config.orchestrator = config.orchestrator ?? {};
  config.orchestrator.webhooks = config.orchestrator.webhooks ?? [];
  config.orchestrator.webhooks.push(webhook);
  writeConfig(dir, config);
  return {
    webhookId: webhookIdForIndex(config.orchestrator.webhooks.length - 1),
    ...webhook,
  };
}

export function removeWebhookConfig(dir: string, webhookId: string): boolean {
  const index = parseWebhookId(webhookId);
  const { config } = readConfig(dir);
  const webhooks = config.orchestrator?.webhooks ?? [];
  if (index == null || !webhooks[index]) return false;
  webhooks.splice(index, 1);
  writeConfig(dir, config);
  return true;
}

export function getWebhookConfig(dir: string, webhookId: string): WebhookWithId | null {
  const index = parseWebhookId(webhookId);
  const { config } = readConfig(dir);
  const webhook = index == null ? null : (config.orchestrator?.webhooks ?? [])[index];
  return webhook ? { webhookId, ...webhook } : null;
}

export async function testWebhookConfig(
  webhook: WebhookConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; ok: boolean }> {
  const event: StructuredEvent = {
    type: "webhook.test",
    timestamp: new Date().toISOString(),
    message: "Test webhook from tmux-ide",
  };
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "tmux-ide-webhook/1.0",
  };
  if (webhook.secret) {
    const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");
    headers["X-Signature-256"] = `sha256=${signature}`;
  }
  const res = await fetchImpl(webhook.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, ok: res.ok };
}

/**
 * Fire webhooks for an event. Fire-and-forget — never blocks the caller.
 * Failures are silently ignored (logged only in debug mode).
 */
export function fireWebhooks(
  webhooks: WebhookConfig[],
  event: OrchestratorEvent | StructuredEvent,
): void {
  const eventType = event.type;

  for (const hook of webhooks) {
    // Filter by event type if configured
    if (hook.events && hook.events.length > 0 && !hook.events.includes(eventType)) {
      continue;
    }

    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "tmux-ide-webhook/1.0",
    };

    // HMAC-SHA256 signing
    if (hook.secret) {
      const signature = createHmac("sha256", hook.secret).update(body).digest("hex");
      headers["X-Signature-256"] = `sha256=${signature}`;
    }

    // Fire-and-forget with 5s timeout
    fetch(hook.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // Silently ignore webhook failures
      if (process.env.TMUX_IDE_DEBUG === "1") {
        process.stderr.write(`Webhook failed: ${hook.url}\n`);
      }
    });
  }
}
