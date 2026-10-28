import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceRegistry } from "./workspace-registry.ts";
import { createNativeBrowserResolver } from "./tmux-native-browser.ts";
import { analyzeTrustedSemanticPaneCatalog } from "../terminal/attachments/semantic-pane-catalog.ts";
import type { NativeTerminalInventoryPaneSnapshot } from "../terminal/attachments/native-runtime.ts";

const rpc = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<null> => null));
vi.mock("./native-browser-rpc.ts", async (original) => ({
  ...(await original<typeof import("./native-browser-rpc.ts")>()),
  nativeBrowserRpc: rpc,
}));
const endpoint = {
  version: 1,
  pid: process.pid,
  instance: "22345678-1234-4234-8234-123456789012",
  pane: "%1",
  socket: "/tmp/isolated-browser.sock",
};
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
  rpc.mockReset();
  rpc.mockResolvedValue(null);
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
  const resolve = createNativeBrowserResolver({
    generation,
    registry,
    catalog,
    inventory: { discoverTerminalInventory },
    run: async (args, signal) => {
      signal.throwIfAborted();
      expect(args.slice(0, 4)).toEqual(["display-message", "-p", "-t", "%1"]);
      hook("observe");
      return `${pane.semanticPaneId}\t${pane.nativePaneBirthId}\t${JSON.stringify(endpoint)}\n`;
    },
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

const signal = () => AbortSignal.timeout(2000);
it("resolves the exact live browser and rechecks ownership after RPC", async () => {
  const f = fixture();
  expect(await f.resolve({ target, command: null }, signal())).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0]?.[0]).toEqual(endpoint);
});
it("rejects stale generation, session, semantic pane and reused pane before RPC", async () => {
  for (const patch of [
    { generation: "32345678-1234-4234-8234-123456789012" },
    { liveSessionId: "live-session.11234567890123456789" },
    { semanticPaneId: "pane-other" },
  ]) {
    const f = fixture();
    await expect(
      f.resolve({ target: { ...target, ...patch }, command: null }, signal()),
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  }
  const f = fixture();
  f.hook((stage) => {
    if (stage === "observe") f.update({ nativePaneBirthId: "2" });
  });
  await expect(f.resolve({ target, command: null }, signal())).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
it("discards an RPC reply if the owner retires or pane changes during IO", async () => {
  for (const retire of [true, false]) {
    const f = fixture();
    rpc.mockImplementationOnce(async () => {
      if (retire) f.retire();
      else f.update({ nativePaneBirthId: "2" });
      return null;
    });
    await expect(f.resolve({ target, command: null }, signal())).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  }
});
it("cancellation cannot invoke the browser", async () => {
  const f = fixture();
  await expect(f.resolve({ target, command: null }, AbortSignal.abort())).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
