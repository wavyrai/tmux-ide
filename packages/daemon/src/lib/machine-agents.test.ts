import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { loadLocalSourceImportGraph } from "../../test-support/source-import-graph.ts";
import { createMachineAgents } from "./machine-agents.ts";

describe("shared fleet agent boundary", () => {
  it("bundles against the narrow roster export without a renderer barrel", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./machine-agents.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const imports = Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.map((i) => i.path),
    );
    expect(imports).toContain("@tmux-ide/presentation/home-agent-roster");
    expect(imports).not.toContain("@tmux-ide/presentation");
    expect(
      Object.keys(result.metafile.inputs).filter((path) => /\/(?:tui|widgets)\//u.test(path)),
    ).toEqual([]);
  });
  it("has no local import path into TUI discovery, renderer or singleton owners", async () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const graph = await loadLocalSourceImportGraph(root, [
      "packages/daemon/src/lib/machine-agents.ts",
    ]);
    expect(graph.files.filter((path) => path.includes("/tui/"))).toEqual([]);
    expect(graph.files).toContain("packages/daemon/src/lib/home-agent-observer.ts");
    expect(graph.files).toContain("packages/daemon/src/lib/home-agent-transport.ts");
  });
  it("uses only the supplied catalog and manager and disposes its subscription", () => {
    let subscribed = 0;
    let stopped = 0;
    const snapshot = { selectedMachineId: "local", groups: [] };
    const agents = createMachineAgents({
      manager: {
        getMachine: () => {
          throw new Error("empty catalog must not discover any machine");
        },
      },
      catalog: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          subscribed++;
          listener(snapshot);
          return () => {
            stopped++;
          };
        },
      },
    });
    expect(subscribed).toBe(0);
    agents.start();
    agents.start();
    expect(subscribed).toBe(1);
    expect(agents.getSnapshot()).toEqual([]);
    agents.dispose();
    agents.dispose();
    expect(stopped).toBe(1);
  });
  // PR #383's journey: "is it current" answers no while the roster re-reads.
  it("waits for a re-read in progress before saying a row is not current", async () => {
    const row = {
      key: "k",
      sessionName: "s",
      agentId: "agent.a",
      paneId: "pane.a",
      daemonInstanceId: "d",
      liveSessionId: "l",
    } as never;
    const state = { current: true, refreshing: [] as string[] };
    const listeners = new Set<(snapshot: unknown) => void>();
    const observed = () => ({
      phase: "live",
      rows: [row],
      loadingSessions: 0,
      refreshingSessionKeys: state.refreshing,
    });
    const handle = {
      read: () => ({ instanceId: "d", startedAt: 1, bindHostname: "127.0.0.1", port: 1 }),
      endpoint: () => ({ epoch: 1 }),
    };
    const group = { id: "11111111-1111-4111-8111-111111111111", state: "ready", sessions: [] };
    const agents = createMachineAgents({
      catalog: {
        getSnapshot: () =>
          ({ selectedMachineId: "11111111-1111-4111-8111-111111111111", groups: [group] }) as never,
        subscribe: (listener) => {
          listener({
            selectedMachineId: "11111111-1111-4111-8111-111111111111",
            groups: [group],
          } as never);
          return () => {};
        },
      },
      manager: { getMachine: () => handle as never },
      createObserver: () =>
        ({
          getSnapshot: observed,
          isCurrentTarget: () => state.current,
          subscribe: (listener: (snapshot: unknown) => void) => {
            listeners.add(listener);
            listener(observed());
            return () => listeners.delete(listener);
          },
          adoptCatalog: () => {},
          setActive: () => {},
          invalidate: () => {},
          retry: () => {},
          loadMore: () => {},
          dispose: () => {},
        }) as never,
    });
    agents.start();
    const signal = new AbortController().signal;
    expect(agents.isCurrentTarget("11111111-1111-4111-8111-111111111111", row)).toBe(true);
    expect(agents.isRefreshing("11111111-1111-4111-8111-111111111111")).toBe(false);
    await expect(
      agents.whenCurrentTarget("11111111-1111-4111-8111-111111111111", row, signal),
    ).resolves.toBe(true);

    // A re-read starts: not current, but not gone either.
    state.current = false;
    state.refreshing = ["s"];
    expect(agents.isRefreshing("11111111-1111-4111-8111-111111111111")).toBe(true);
    const waiting = agents.whenCurrentTarget("11111111-1111-4111-8111-111111111111", row, signal);
    let settled: boolean | null = null;
    void waiting.then((value) => (settled = value));
    await Promise.resolve();
    expect(settled).toBeNull();
    state.current = true;
    state.refreshing = [];
    for (const listener of [...listeners]) listener(observed());
    await expect(waiting).resolves.toBe(true);

    // Not current and nothing being read: gone, at once. Unknown machine: the same.
    state.current = false;
    await expect(
      agents.whenCurrentTarget("11111111-1111-4111-8111-111111111111", row, signal),
    ).resolves.toBe(false);
    await expect(
      agents.whenCurrentTarget("22222222-2222-4222-8222-222222222222", row, signal),
    ).resolves.toBe(false);
    expect(agents.isRefreshing("22222222-2222-4222-8222-222222222222")).toBe(false);
    agents.dispose();
  });
});
