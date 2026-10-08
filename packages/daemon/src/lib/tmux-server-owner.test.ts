import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createNativeTmuxServerCatalog } from "./tmux-server-owner.ts";
import { WorkspaceIdSchemaZ } from "@tmux-ide/contracts";
import {
  discoverWorkspaceRegistrySemanticPanes,
  discoverWorkspaceRegistryTerminalInventory,
} from "../terminal/attachments/native-runtime.ts";
import { SemanticPaneCatalog } from "../terminal/attachments/semantic-pane-catalog.ts";
import type { TmuxAttachmentCommandRunner } from "../terminal/attachments/tmux-view-executor.ts";
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

it("adopts spaced native names without poisoning healthy strict terminal inventories", async () => {
  const dir = mkdtempSync("/tmp/tmux-owner-catalog-");
  directories.push(dir);
  const registry = new WorkspaceRegistry({ dir, listSessions: () => [] });
  const names = ["prototyper mgt", "sfora"];
  const catalog = createNativeTmuxServerCatalog(registry, async () =>
    names.map((name, i) => `22\t$${i}\t1234\t${name}\t%${i}\t${dir}`).join("\n"),
  );
  await catalog();
  const separator = "|tmux-ide-field-v2|";
  const runner: TmuxAttachmentCommandRunner = {
    run(command) {
      if (command.argv[0] === "list-sessions")
        return {
          status: "ok",
          stdout: names
            .map((name, i) => [name, `$${i}`, "tmux-ide-session-v2"].join(separator))
            .join("\n"),
        };
      const id = command.argv[command.argv.indexOf("-t") + 1];
      const i = Number(id?.slice(1));
      return {
        status: "ok",
        stdout: [
          names[i],
          `$${i}`,
          `@${i}`,
          `%${i}`,
          "1",
          "1",
          `pane.${i}`,
          "0",
          "Shell",
          "sh",
          "1",
          "1",
          "",
          "",
          "terminal",
          "",
          dir,
          `window.${i}`,
          "0",
          "",
          "tmux-ide-pane-v2",
        ].join(separator),
      };
    },
  };
  const inventory = await discoverWorkspaceRegistryTerminalInventory(registry, runner);
  expect(inventory.catalog.invalidRuntimeProof).toBe(false);
  expect(inventory.catalog.rows).toHaveLength(2);
  const semantic = new SemanticPaneCatalog({
    discover: () => discoverWorkspaceRegistrySemanticPanes(registry, runner),
  });
  for (const [i, name] of names.entries()) {
    const workspace = registry.list().find((row) => row.sessionName === name)!;
    expect(WorkspaceIdSchemaZ.safeParse(workspace.name).success).toBe(true);
    await expect(
      semantic.resolve({ workspaceName: workspace.name, semanticPaneId: `pane.${i}` }),
    ).resolves.toMatchObject({ source: { sessionId: `$${i}`, runtimePaneId: `%${i}` } });
  }
  const first = registry.list().map(({ name, sessionName }) => ({ name, sessionName }));
  await catalog();
  expect(registry.list().map(({ name, sessionName }) => ({ name, sessionName }))).toEqual(first);
});

it("keeps deterministic aliases distinct across collisions and volatile rename retirement", async () => {
  const dir = mkdtempSync("/tmp/tmux-owner-catalog-");
  directories.push(dir);
  const registry = new WorkspaceRegistry({ dir, listSessions: () => [] });
  let names = ["prototyper mgt", "prototyper-mgt", "prototyper  mgt", "constructor"];
  const catalog = createNativeTmuxServerCatalog(registry, async () =>
    names.map((name, i) => `22\t$${i}\t1234\t${name}\t%${i}\t${dir}`).join("\n"),
  );
  await catalog();
  const old = registry.list().find((row) => row.sessionName === names[0])!;
  expect(new Set(registry.list().map((row) => row.name)).size).toBe(4);
  expect(registry.list().every((row) => WorkspaceIdSchemaZ.safeParse(row.name).success)).toBe(true);
  // A durable record may deliberately occupy the first deterministic candidate.
  registry.remove(old.name);
  registry.add({ name: old.name, sessionName: "durable-other", projectDir: dir });
  await catalog();
  const replacement = registry.list().find((row) => row.sessionName === names[0])!;
  expect(replacement.name).not.toBe(old.name);
  expect(registry.get(old.name)?.sessionName).toBe("durable-other");
  const snapshot = registry.list().map((row) => [row.name, row.sessionName]);
  await catalog();
  expect(registry.list().map((row) => [row.name, row.sessionName])).toEqual(snapshot);
  names = ["renamed native", ...names.slice(1)];
  await catalog();
  expect(registry.has(replacement.name)).toBe(false);
  expect(registry.list().some((row) => row.sessionName === "renamed native")).toBe(true);
  expect(registry.get(old.name)?.sessionName).toBe("durable-other");
});
