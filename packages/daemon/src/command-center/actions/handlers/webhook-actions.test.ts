import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { webhookAddHandler, webhookRemoveHandler, webhookTestHandler } from "./webhook-actions.ts";

let dir: string;
let broadcasts: string[];

function writeIdeYml(config: unknown): void {
  writeFileSync(join(dir, "ide.yml"), yaml.dump(config, { lineWidth: -1, noRefs: true }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-webhook-actions-"));
  broadcasts = [];
  writeIdeYml({ name: "demo", rows: [{ panes: [{ title: "Shell" }] }] });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("webhook actions", () => {
  it("adds, tests, and removes webhooks", async () => {
    const deps = {
      cwd: dir,
      broadcastConfigChanged: (sessionName: string) => broadcasts.push(sessionName),
      fetch: async () => new Response("ok", { status: 204 }),
    };
    const added = webhookAddHandler(
      { url: "https://example.com/hook", events: ["completion"], secret: "s" },
      deps,
    );
    expect(added.webhookId).toBe("webhook-0");
    expect(await webhookTestHandler({ webhookId: "webhook-0" }, deps)).toEqual({
      status: 204,
      ok: true,
    });
    expect(webhookRemoveHandler({ webhookId: "webhook-0" }, deps)).toEqual({ deleted: true });
    expect(broadcasts).toHaveLength(2);
  });

  it("raises webhook_not_found for unknown ids", () => {
    expect(() => webhookRemoveHandler({ webhookId: "webhook-9" }, { cwd: dir })).toThrow(
      /not found/,
    );
  });

  it("raises webhook_test_failed for non-2xx responses", async () => {
    webhookAddHandler({ url: "https://example.com/hook" }, { cwd: dir });
    await expect(
      webhookTestHandler(
        { webhookId: "webhook-0" },
        { cwd: dir, fetch: async () => new Response("bad", { status: 500 }) },
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});
