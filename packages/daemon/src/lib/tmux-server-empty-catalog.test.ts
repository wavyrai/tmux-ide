import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceRegistry } from "./workspace-registry.ts";
import { createNativeTmuxServerCatalog } from "./tmux-server-owner.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("witnessed empty catalog removes volatile membership but preserves durable intent", async () => {
  const dir = mkdtempSync("/tmp/tmux-empty-catalog-");
  roots.push(dir);
  const registry = new WorkspaceRegistry({ dir, listSessions: () => [] });
  registry.add({ name: "saved", projectDir: dir });
  registry.add({ name: "expired", projectDir: dir, persistence: "volatile" });
  const before = readFileSync(join(dir, "workspaces.json"), "utf8");
  const calls: string[][] = [];
  const catalog = createNativeTmuxServerCatalog(registry, async (args) => {
    calls.push([...args]);
    return "tmux-ide-empty-catalog-v1\n";
  });
  expect(await catalog()).toEqual([]);
  expect(registry.has("expired")).toBe(false);
  expect(readFileSync(join(dir, "workspaces.json"), "utf8")).toBe(before);
  expect(calls[0]?.slice(0, 4)).toEqual(["-N", "if-shell", "-F", "#{==:#{server_sessions},0}"]);
});
it("errors, unwitnessed empty and malformed output preserve membership", async () => {
  const dir = mkdtempSync("/tmp/tmux-empty-catalog-");
  roots.push(dir);
  const registry = new WorkspaceRegistry({ dir, listSessions: () => [] });
  registry.add({ name: "retained", projectDir: dir, persistence: "volatile" });
  for (const read of [
    async () => {
      throw new Error("unsupported command");
    },
    async () => "invalid",
    async () => "\n",
  ]) {
    await expect(createNativeTmuxServerCatalog(registry, read)()).rejects.toThrow();
    expect(registry.has("retained")).toBe(true);
  }
});
// Soak, 12 Nov: a tmux server that cannot exit answers with no sessions or not
// at all. The owner's watch is told of both, and never changes the result.
it("tells the watch of a server without sessions and of one that does not answer", async () => {
  const dir = mkdtempSync("/tmp/tmux-empty-catalog-");
  roots.push(dir);
  const registry = new WorkspaceRegistry({ dir, listSessions: () => [] });
  const told: string[] = [];
  const watch = (kind: string) => {
    told.push(kind);
    // A watcher that fails, either way, never reaches the caller.
    if (told.length === 1) throw new Error("watch failed");
    return Promise.reject(new Error("watch failed later"));
  };
  const empty = createNativeTmuxServerCatalog(
    registry,
    async () => "tmux-ide-empty-catalog-v1\n",
    undefined,
    watch,
  );
  expect(await empty()).toEqual([]);
  const silent = createNativeTmuxServerCatalog(
    registry,
    async () => {
      throw new Error("no server running");
    },
    undefined,
    watch,
  );
  await expect(silent()).rejects.toThrow("no server running");
  expect(told).toEqual(["no-sessions", "unanswered"]);
  // Output that is merely malformed is not a server in trouble.
  const malformed = createNativeTmuxServerCatalog(
    registry,
    async () => "invalid",
    undefined,
    watch,
  );
  await expect(malformed()).rejects.toThrow();
  expect(told).toHaveLength(2);
});
