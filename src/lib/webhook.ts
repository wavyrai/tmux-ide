import { createHmac } from "node:crypto";
import type { OrchestratorEvent, StructuredEvent } from "./event-log.ts";

export interface WebhookConfig {
  url: string;
  events?: string[];
  secret?: string;
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
