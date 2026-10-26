import { describe, it, expect, vi } from "vitest";
import {
  createNativeSurfaceContextResolver,
  NativeSurfaceLocationSchema,
} from "./native-surface-context.ts";
import type { NativeTerminalInventoryPaneSnapshot } from "../terminal/attachments/native-runtime.ts";
import { analyzeTrustedSemanticPaneCatalog } from "../terminal/attachments/semantic-pane-catalog.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";
const target = {
  socketPath: "/tmp/private/t.sock",
  serverPid: "123",
  sessionId: "$1",
  runtimePaneId: "%2",
};
const generation = "12345678-1234-4234-8234-123456789012";
function fixture() {
  const workspace = { sessionName: "session" } as ReturnType<WorkspaceRegistry["get"]>;
  let birth = "1";
  let reads = 0;
  let changed = false;
  const run = vi.fn<(args: readonly string[], signal: AbortSignal) => Promise<string>>(
    async () => Object.values(target).join("\t") + "\n",
  );
  const resolve = createNativeSurfaceContextResolver({
    generation,
    assertOpen() {},
    run,
    registry: { get: () => workspace },
    catalog: async () => [
      { sessionName: "session", liveSessionId: "live-session.01234567890123456789", paneCount: 1 },
    ],
    inventory: {
      discoverTerminalInventory: async () => {
        if (++reads === 2 && changed) birth = "2";
        const pane = {
          workspaceName: "workspace",
          sessionName: "session",
          sessionId: "$1",
          windowId: "@1",
          runtimePaneId: "%2",
          semanticPaneId: "pane.source",
          windowStamp: "window.source",
          windowPaneCount: 1,
          sessionWindowCount: 1,
          nativePaneBirthId: birth,
        } as NativeTerminalInventoryPaneSnapshot;
        return {
          panes: [pane],
          catalog: analyzeTrustedSemanticPaneCatalog([
            {
              workspaceName: pane.workspaceName,
              sessionId: pane.sessionId,
              windowId: pane.windowId,
              runtimePaneId: pane.runtimePaneId,
              semanticPaneId: pane.semanticPaneId,
              windowStamp: pane.windowStamp,
              windowPaneCount: pane.windowPaneCount,
              sessionWindowCount: pane.sessionWindowCount,
            },
          ]),
        };
      },
    },
  });
  return {
    resolve,
    run,
    change: () => {
      changed = true;
    },
  };
}
describe("native surface launch context", () => {
  it("maps the exact observed tmux location to a stable semantic source", async () => {
    const f = fixture();
    await expect(f.resolve(target)).resolves.toEqual({
      generation,
      workspaceName: "workspace",
      liveSessionId: "live-session.01234567890123456789",
      pane: "pane.source",
    });
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[0]?.[0]).toEqual([
      "display-message",
      "-p",
      "-t",
      "%2",
      "#{socket_path}\t#{pid}\t#{session_id}\t#{pane_id}",
    ]);
  });
  it.each(["socketPath", "serverPid", "sessionId", "runtimePaneId"] as const)(
    "rejects mismatched %s rather than choosing another pane",
    async (key) => {
      const f = fixture();
      f.run.mockResolvedValue(Object.values({ ...target, [key]: "different" }).join("\t"));
      await expect(f.resolve(target)).rejects.toThrow();
    },
  );
  it("rejects a replaced pane during discovery", async () => {
    const f = fixture();
    f.change();
    await expect(f.resolve(target)).rejects.toThrow();
  });
  it("rejects cancellation and malformed selectors before invoking tmux", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(f.resolve(target, abort.signal)).rejects.toThrow();
    for (const runtimePaneId of ["%2; kill-server", "", "2", "%02"])
      expect(NativeSurfaceLocationSchema.safeParse({ ...target, runtimePaneId }).success).toBe(
        false,
      );
    expect(f.run).not.toHaveBeenCalled();
  });
});
