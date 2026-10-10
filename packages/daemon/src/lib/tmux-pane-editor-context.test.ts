import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceRegistry } from "./workspace-registry.ts";
import { createPaneEditorContextResolver } from "./tmux-pane-editor-context.ts";
import { analyzeTrustedSemanticPaneCatalog } from "../terminal/attachments/semantic-pane-catalog.ts";
import type { NativeTerminalInventoryPaneSnapshot } from "../terminal/attachments/native-runtime.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const generation = "12345678-1234-4234-8234-123456789012";
const target = {
  generation,
  workspaceName: "checkout",
  liveSessionId: "live-session.01234567890123456789",
  semanticPaneId: "pane-main",
};
function fixture() {
  const root = mkdtempSync("/tmp/pane-editor-context-");
  roots.push(root);
  const registry = new WorkspaceRegistry({ dir: root, listSessions: () => [] });
  registry.add({ name: "checkout", sessionName: "Native Unicode 工作 ", projectDir: root });
  let retired = false;
  let pane: NativeTerminalInventoryPaneSnapshot = {
    workspaceName: "checkout",
    sessionName: "Native Unicode 工作 ",
    sessionId: "$1",
    windowId: "@1",
    runtimePaneId: "%1",
    semanticPaneId: "pane-main",
    windowStamp: "window-main",
    windowPaneCount: 1,
    sessionWindowCount: 1,
    index: 0,
    title: "pane",
    currentCommand: "sh",
    active: true,
    role: null,
    name: null,
    type: null,
    missionStamp: null,
    dir: `${root}/source`,
    nativePaneBirthId: "1",
  };
  let reads = 0;
  let hook: (stage: string) => void = () => undefined;
  const catalog = vi.fn(async () => {
    hook("catalog");
    return [
      { liveSessionId: target.liveSessionId, sessionName: "Native Unicode 工作 ", paneCount: 1 },
    ];
  });
  const discoverTerminalInventory = vi.fn(async (signal?: AbortSignal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    hook(`inventory-${++reads}`);
    const row = { ...pane };
    const {
      workspaceName,
      semanticPaneId,
      sessionId,
      windowId,
      runtimePaneId,
      windowStamp,
      windowPaneCount,
      sessionWindowCount,
    } = row;
    return {
      panes: [row],
      catalog: analyzeTrustedSemanticPaneCatalog([
        {
          workspaceName,
          semanticPaneId,
          sessionId,
          windowId,
          runtimePaneId,
          windowStamp,
          windowPaneCount,
          sessionWindowCount,
        },
      ]),
    };
  });
  const resolve = createPaneEditorContextResolver({
    generation,
    registry,
    catalog,
    inventory: { discoverTerminalInventory },
    assertOpen: () => {
      if (retired) throw new Error("retired");
    },
  });
  return {
    root,
    registry,
    resolve,
    catalog,
    discoverTerminalInventory,
    retire: () => {
      retired = true;
    },
    update: (patch: Partial<NativeTerminalInventoryPaneSnapshot>) => {
      pane = { ...pane, ...patch };
    },
    hook: (value: typeof hook) => {
      hook = value;
    },
  };
}

it("resolves the exact live pane cwd using shared containment, without a saved-layout fallback", async () => {
  const f = fixture();
  const result = await f.resolve(target);
  expect(result).toEqual({
    ...target,
    cwd: { kind: "project-relative", path: "source" },
    directory: `${f.root}/source`,
  });
  f.update({ dir: "/outside/Unicode 工作 " });
  expect(await f.resolve(target)).toEqual({
    ...target,
    cwd: { kind: "absolute", path: "/outside/Unicode 工作 " },
    directory: "/outside/Unicode 工作 ",
  });
  f.update({ dir: "" });
  await expect(f.resolve(target)).rejects.toThrow("unavailable");
  f.update({ dir: "relative" });
  await expect(f.resolve(target)).rejects.toThrow("unavailable");
});

it("keeps valid stock tmux observations usable without fabricating native birth proof", async () => {
  const f = fixture();
  f.update({ nativePaneBirthId: null });
  expect((await f.resolve(target)).directory).toBe(`${f.root}/source`);
});

it("preserves trailing-space checkout paths and represents literal backslashes losslessly", async () => {
  const f = fixture();
  const workspace = f.registry.get("checkout")!;
  workspace.projectDir = `${f.root}/checkout `;
  f.update({ dir: `${workspace.projectDir}/source ` });
  expect(await f.resolve(target)).toEqual({
    ...target,
    cwd: { kind: "project-relative", path: "source " },
    directory: `${workspace.projectDir}/source `,
  });
  f.update({ dir: `${workspace.projectDir}/literal\\name` });
  expect(await f.resolve(target)).toEqual({
    ...target,
    cwd: { kind: "absolute", path: `${workspace.projectDir}/literal\\name` },
    directory: `${workspace.projectDir}/literal\\name`,
  });
  workspace.projectDir = "relative-root";
  await expect(f.resolve(target)).rejects.toThrow("unavailable");
});

it.each(["dir", "runtimePaneId", "sessionId", "windowId", "nativePaneBirthId"] as const)(
  "refuses %s changes across the live reads",
  async (key) => {
    const f = fixture();
    f.hook((stage) => {
      if (stage === "inventory-2")
        f.update({
          [key]:
            key === "dir"
              ? "/changed"
              : key === "runtimePaneId"
                ? "%2"
                : key === "sessionId"
                  ? "$2"
                  : key === "windowId"
                    ? "@2"
                    : "2",
        });
    });
    await expect(f.resolve(target)).rejects.toThrow("unavailable");
  },
);

it.each(["catalog", "inventory-1", "inventory-2"])(
  "refuses retirement during %s",
  async (stage) => {
    const f = fixture();
    f.hook((current) => {
      if (current === stage) f.retire();
    });
    await expect(f.resolve(target)).rejects.toThrow("retired");
  },
);

it("refuses recreated sessions and checkout replacement even under unchanged display names", async () => {
  const f = fixture();
  f.catalog
    .mockResolvedValueOnce([
      { liveSessionId: target.liveSessionId, sessionName: "Native Unicode 工作 ", paneCount: 1 },
    ])
    .mockResolvedValueOnce([
      {
        liveSessionId: "live-session.ffffffffffffffffffff",
        sessionName: "Native Unicode 工作 ",
        paneCount: 1,
      },
    ]);
  await expect(f.resolve(target)).rejects.toThrow("unavailable");
  const g = fixture();
  g.hook((stage) => {
    if (stage === "inventory-1") {
      g.registry.remove("checkout");
      g.registry.add({ name: "checkout", sessionName: "Native Unicode 工作 ", projectDir: g.root });
    }
  });
  await expect(g.resolve(target)).rejects.toThrow("unavailable");
});

it("rejects wrong generation, unknown pane, invalid caller fields and cancellation without fallback", async () => {
  const f = fixture();
  await expect(
    f.resolve({ ...target, generation: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
  ).rejects.toThrow();
  expect(f.catalog).not.toHaveBeenCalled();
  await expect(f.resolve({ ...target, semanticPaneId: "missing" })).rejects.toThrow("unavailable");
  const signal = AbortSignal.abort();
  await expect(f.resolve(target, signal)).rejects.toThrow();
  const withPath = { ...target, directory: "/caller/supplied" };
  await expect(f.resolve(withPath)).rejects.toThrow();
});
