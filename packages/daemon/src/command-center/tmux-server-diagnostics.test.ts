import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
import { mountTmuxServerRoutes } from "./tmux-servers.ts";
async function fixture() {
  const read = vi.fn(async (_signal?: AbortSignal) => "3.7c");
  const owners = new TmuxServerOwners<NativeTmuxServerOwner>({
    probe: async (selector) => ({
      fingerprint: JSON.stringify(selector),
      authority: { executablePath: "/fixture/tmux", socketSelector: selector },
      valid: () => true,
    }),
    create: async () =>
      ({ readServerVersion: read, dispose: async () => {} }) as unknown as NativeTmuxServerOwner,
  });
  const server = await owners.register({
    label: "fixture",
    selector: { kind: "name", name: "fixture" },
  });
  const app = new Hono();
  mountTmuxServerRoutes(app, { owners, ownerToken: "owner" });
  const path = `/api/v1/tmux-servers/${server.serverId}/${server.generation}/diagnostics`;
  const request = (signal?: AbortSignal, auth = "owner") =>
    app.request(path, { headers: { Authorization: `Bearer ${auth}` }, signal });
  return { owners, server, app, path, read, request };
}
it("requires owner authority and returns only scoped validated metadata", async () => {
  const f = await fixture();
  expect((await f.request(undefined, "wrong")).status).toBe(401);
  expect(f.read).not.toHaveBeenCalled();
  for (const version of ["3.7c", "3.8"]) {
    f.read.mockResolvedValue(version);
    const response = await f.request();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      server: { serverId: f.server.serverId, generation: f.server.generation },
      tmuxVersion: version,
    });
  }
  await f.owners.dispose();
});
it("refuses a retired owner even when its pending read completes", async () => {
  const f = await fixture();
  let release!: (v: string) => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  f.read.mockImplementation(() => {
    entered();
    return new Promise((r) => (release = r));
  });
  const response = f.request();
  await ready;
  await f.owners.remove(f.server.serverId);
  release("3.8");
  expect((await response).status).toBe(404);
  await f.owners.dispose();
});
it("does not leak malformed output and fences cancellation", async () => {
  const f = await fixture();
  for (const bad of ["SECRET/private", "3.8\nSECRET", "3.8-next", "1".repeat(100)]) {
    f.read.mockResolvedValue(bad);
    const r = await f.request();
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("SECRET");
  }
  const abort = new AbortController();
  abort.abort();
  f.read.mockClear();
  expect((await f.request(abort.signal)).status).toBe(503);
  expect(f.read).not.toHaveBeenCalled();
  await f.owners.dispose();
});

it("rejects malformed scope before read and cancellation while read is pending", async () => {
  const f = await fixture();
  const malformed = await f.app.request(f.path.replace(f.server.generation!, "not-a-generation"), {
    headers: { Authorization: "Bearer owner" },
  });
  expect(malformed.status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  f.read.mockImplementation(
    (signal) =>
      new Promise((_resolve, reject) => {
        entered();
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      }),
  );
  const abort = new AbortController();
  const pending = f.request(abort.signal);
  await ready;
  abort.abort();
  expect((await pending).status).toBe(503);
  await f.owners.dispose();
});
