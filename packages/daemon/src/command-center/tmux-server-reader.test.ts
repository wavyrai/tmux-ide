import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
import { PaneReaderUnavailable } from "../lib/tmux-pane-reader.ts";
import { mountTmuxServerRoutes } from "./tmux-servers.ts";

async function fixture() {
  const read = vi.fn(async (_input: unknown, _signal: AbortSignal) => ({
    version: 1 as const,
    state: "unchanged" as const,
    name: "notes.md",
    folder: "docs",
    revision: "a".repeat(32),
  }));
  const asset = vi.fn(async (_input: unknown, _signal: AbortSignal) => ({
    version: 1 as const,
    state: "refused" as const,
  }));
  const owners = new TmuxServerOwners<NativeTmuxServerOwner>({
    probe: async (selector) => ({
      fingerprint: JSON.stringify(selector),
      authority: { executablePath: "/fixture/tmux", socketSelector: selector },
      valid: () => true,
    }),
    create: async () =>
      ({
        paneReader: { read, asset },
        dispose: async () => {},
      }) as unknown as NativeTmuxServerOwner,
  });
  const server = await owners.register({ label: "fixture", selector: { kind: "name", name: "f" } });
  const target = {
    generation: server.generation!,
    workspaceName: "project",
    liveSessionId: `live-session.${"b".repeat(20)}`,
    semanticPaneId: "pane.main",
  };
  const app = new Hono();
  mountTmuxServerRoutes(app, { owners, ownerToken: "test-owner" });
  const base = `/api/v1/tmux-servers/${server.serverId}/${server.generation}/reader`;
  const request = (path: string, body: unknown, auth: string | null = "test-owner") =>
    app.request(path, {
      method: "POST",
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return { read, asset, target, base, request, server };
}

it("requires the owner token and returns the resolver's answer uncached", async () => {
  const f = await fixture();
  const body = { target: f.target, have: null, page: null };
  for (const auth of [null, "wrong"])
    expect((await f.request(f.base, body, auth)).status).toBe(401);
  expect(f.read).not.toHaveBeenCalled();
  const response = await f.request(f.base, body);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ state: "unchanged", name: "notes.md" });
  const image = await f.request(`${f.base}/asset`, { target: f.target, src: "a.png", page: null });
  expect(await image.json()).toEqual({ version: 1, state: "refused" });
});
it("rejects bad bodies, stale generations and unavailable readers without detail", async () => {
  const f = await fixture();
  expect((await f.request(f.base, { target: f.target, have: null })).status).toBe(400);
  expect(
    (await f.request(f.base, { target: f.target, have: null, page: null, path: "/etc/passwd" }))
      .status,
  ).toBe(400);
  expect(
    (await f.request(`${f.base}/asset`, { target: f.target, src: "x".repeat(2049), page: null }))
      .status,
  ).toBe(400);
  expect(
    (
      await f.request(f.base, {
        target: { ...f.target, generation: randomUUID() },
        have: null,
        page: null,
      })
    ).status,
  ).toBe(409);
  expect(f.read).not.toHaveBeenCalled();
  f.read.mockRejectedValueOnce(new PaneReaderUnavailable());
  const unavailable = await f.request(f.base, { target: f.target, have: null, page: null });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: { code: "reader-unavailable" } });
  f.asset.mockRejectedValueOnce(new Error("EACCES: /secret/path"));
  const failed = await f.request(`${f.base}/asset`, { target: f.target, src: "a.png", page: null });
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("/secret");
  const foreign = f.base.replace(f.server.serverId, `tmux-server.${"0".repeat(32)}`);
  expect((await f.request(foreign, { target: f.target, have: null, page: null })).status).toBe(404);
});
