import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  addWebhookConfig,
  getWebhookConfig,
  removeWebhookConfig,
  testWebhookConfig,
} from "../../../lib/webhook.ts";
import { broadcastConfigChanged as broadcastConfigChangedDefault } from "../../ws-events.ts";
import { ActionError } from "../errors.ts";
import type { ActionInput, ActionResult } from "../contract.ts";
import { resolveProjectContext, type ProjectContextDeps } from "./_project-context.ts";

interface WebhookActionDeps extends ProjectContextDeps {
  broadcastConfigChanged?: (sessionName: string) => void;
  fetch?: typeof fetch;
}

function assertIdeYml(dir: string): void {
  if (!existsSync(join(dir, "ide.yml"))) {
    throw new ActionError({
      code: "ide_yml_missing",
      message: "ide.yml was not found",
      details: { dir },
    });
  }
}

export function webhookAddHandler(
  input: ActionInput<"webhook.add">,
  deps: WebhookActionDeps = {},
): ActionResult<"webhook.add"> {
  const context = resolveProjectContext(input, deps);
  assertIdeYml(context.dir);
  const { webhookId, ...webhook } = addWebhookConfig(context.dir, {
    url: input.url,
    events: input.events,
    secret: input.secret,
  });
  (deps.broadcastConfigChanged ?? broadcastConfigChangedDefault)(context.sessionName);
  return { webhookId, webhook };
}

export function webhookRemoveHandler(
  input: ActionInput<"webhook.remove">,
  deps: WebhookActionDeps = {},
): ActionResult<"webhook.remove"> {
  const context = resolveProjectContext(input, deps);
  assertIdeYml(context.dir);
  if (!removeWebhookConfig(context.dir, input.webhookId)) {
    throw new ActionError({
      code: "webhook_not_found",
      message: `Webhook "${input.webhookId}" not found`,
      details: { webhookId: input.webhookId },
    });
  }
  (deps.broadcastConfigChanged ?? broadcastConfigChangedDefault)(context.sessionName);
  return { deleted: true };
}

export async function webhookTestHandler(
  input: ActionInput<"webhook.test">,
  deps: WebhookActionDeps = {},
): Promise<ActionResult<"webhook.test">> {
  const context = resolveProjectContext(input, deps);
  assertIdeYml(context.dir);
  const webhook = getWebhookConfig(context.dir, input.webhookId);
  if (!webhook) {
    throw new ActionError({
      code: "webhook_not_found",
      message: `Webhook "${input.webhookId}" not found`,
      details: { webhookId: input.webhookId },
    });
  }

  try {
    const result = await testWebhookConfig(webhook, deps.fetch);
    if (!result.ok) {
      throw new ActionError({
        code: "webhook_test_failed",
        message: `Webhook test failed with HTTP ${result.status}`,
        details: { webhookId: input.webhookId, status: result.status },
      });
    }
    return { status: result.status, ok: true };
  } catch (err) {
    if (err instanceof ActionError) throw err;
    throw new ActionError({
      code: "webhook_test_failed",
      message: `Webhook test failed: ${(err as Error).message ?? String(err)}`,
      details: { webhookId: input.webhookId },
      cause: err,
    });
  }
}
