import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createNativeTmuxServerCatalog } from "./tmux-server-owner.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
it("refreshes only volatile membership and preserves durable aliases and missing intent", async () => {
  const dir = mkdtempSync("/tmp/tmux-owner-catalog-");
  directories.push(dir);
  const registry = new WorkspaceRegistry({ dir, listSessions: () => [] });
  registry.add({ name: "project-alias", sessionName: "native", projectDir: dir });
  registry.add({ name: "offline-project", sessionName: "offline", projectDir: dir });
  registry.add({ name: "expired", projectDir: dir, persistence: "volatile" });
  const durableBefore = readFileSync(join(dir, "workspaces.json"), "utf8");
  const catalog = createNativeTmuxServerCatalog(
    registry,
    async () =>
      `22\t$0\t1234\tnative\t%0\t${dir}\n22\t$1\t1234\tnew\t%1\t${dir}\n22\t$1\t1234\tnew\t%1\t${dir}`,
  );
  expect((await catalog()).map((row) => [row.sessionName, row.paneCount])).toEqual([
    ["native", 1],
    ["new", 1],
  ]);
  expect(registry.list().map((row) => row.name)).toEqual([
    "project-alias",
    "offline-project",
    "new",
  ]);
  expect(registry.isVolatile("new")).toBe(true);
  expect(readFileSync(join(dir, "workspaces.json"), "utf8")).toBe(durableBefore);
  expect(registry.has("native")).toBe(false);
});
it("fails before reconciliation on unavailable or malformed inventory", async () => {
  const dir = mkdtempSync("/tmp/tmux-owner-catalog-");
  directories.push(dir);
  const registry = new WorkspaceRegistry({ dir });
  registry.add({ name: "live", projectDir: dir, persistence: "volatile" });
  await expect(createNativeTmuxServerCatalog(registry, async () => "invalid")()).rejects.toThrow(
    "Invalid native server catalog",
  );
  await expect(
    createNativeTmuxServerCatalog(registry, async () => {
      throw new Error("offline");
    })(),
  ).rejects.toThrow("offline");
  expect(registry.has("live")).toBe(true);
});

it("does not replace durable workspace intent when a discovered session name collides", async () => {
  const dir = mkdtempSync("/tmp/tmux-owner-catalog-");
  directories.push(dir);
  const registry = new WorkspaceRegistry({ dir });
  registry.add({ name: "collision", sessionName: "other", projectDir: dir });
  const catalog = createNativeTmuxServerCatalog(
    registry,
    async () => `22\t$0\t1234\tcollision\t%0\t${dir}`,
  );
  expect((await catalog())[0]!.sessionName).toBe("collision");
  expect(registry.get("collision")!.sessionName).toBe("other");
  expect(registry.isVolatile("collision")).toBe(false);
});
