import { describe, expect, it, vi } from "vitest";
import type { CanonicalDaemonInfo, WorkspaceOpenPreparedResult } from "@tmux-ide/contracts";

import { OpenTuiWorkspaceHandoffClient } from "./workspace-open-handoff-client.ts";

const daemon: CanonicalDaemonInfo = {
  pid: 1,
  port: 6060,
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-13T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner",
};

function prepared(token: string, revision: number, workspaceName: string) {
  return {
    operationId: crypto.randomUUID(),
    daemonInstanceId: daemon.instanceId,
    phase: "prepared",
    prepareToken: token,
    preparedRevision: revision,
    outcome: "reopened",
    workspaceName,
    previousWorkspaceName: null,
    proof: {
      semanticPaneId: "pane.editor",
      paneCount: 1,
      terminalRevision: 1,
      terminalStateHash: "0000000000000001",
    },
  } satisfies WorkspaceOpenPreparedResult;
}

describe("OpenTuiWorkspaceHandoffClient", () => {
  it("keeps only the latest prepare and cancels a late superseded proof", async () => {
    let resolveFirst!: (value: WorkspaceOpenPreparedResult) => void;
    const first = new Promise<WorkspaceOpenPreparedResult>((resolve) => (resolveFirst = resolve));
    const dispatch = vi.fn(async (_daemon, name) => {
      if (name === "workspace.open.prepare") {
        if (dispatch.mock.calls.length === 1) return await first;
        return prepared("22222222-2222-4222-8222-222222222222", 2, "workspace.beta");
      }
      return { phase: "cancelled" };
    });
    const client = new OpenTuiWorkspaceHandoffClient({
      readDaemon: () => daemon,
      dispatch: dispatch as never,
    });

    const obsolete = client.prepare({ source: { kind: "project", projectDir: "/alpha" } });
    await Promise.resolve();
    const latest = client.prepare({ source: { kind: "project", projectDir: "/beta" } });
    resolveFirst(prepared("33333333-3333-4333-8333-333333333333", 1, "workspace.alpha"));

    expect(await obsolete).toBeNull();
    expect((await latest)?.workspaceName).toBe("workspace.beta");
    expect(dispatch.mock.calls.some(([, name]) => name === "workspace.open.cancel")).toBe(true);
  });

  it("commits only its current proof and cancels it on retirement", async () => {
    const candidate = prepared("44444444-4444-4444-8444-444444444444", 1, "workspace.alpha");
    const dispatch = vi.fn(async (_daemon, name) => {
      if (name === "workspace.open.prepare") return candidate;
      if (name === "workspace.open.commit") return { phase: "committed" };
      return { phase: "cancelled" };
    });
    const client = new OpenTuiWorkspaceHandoffClient({
      readDaemon: () => daemon,
      dispatch: dispatch as never,
    });
    expect(await client.prepare({ source: { kind: "project", projectDir: "/alpha" } })).toBe(
      candidate,
    );
    expect(await client.commit(candidate)).toBe(true);
    expect(await client.commit(candidate)).toBe(false);

    await client.prepare({ source: { kind: "project", projectDir: "/alpha" } });
    client.dispose();
    await Promise.resolve();
    expect(dispatch.mock.calls.some(([, name]) => name === "workspace.open.cancel")).toBe(true);
  });

  it("cancels a failed commit so the host can retain its previous frame", async () => {
    const candidate = prepared("55555555-5555-4555-8555-555555555555", 1, "workspace.beta");
    const dispatch = vi.fn(async (_daemon, name) => {
      if (name === "workspace.open.prepare") return candidate;
      if (name === "workspace.open.commit") return null;
      return { phase: "cancelled" };
    });
    const client = new OpenTuiWorkspaceHandoffClient({
      readDaemon: () => daemon,
      dispatch: dispatch as never,
    });
    expect(await client.prepare({ source: { kind: "project", projectDir: "/beta" } })).toBe(
      candidate,
    );
    expect(await client.commit(candidate)).toBe(false);
    expect(dispatch.mock.calls.map(([, name]) => name)).toEqual([
      "workspace.open.prepare",
      "workspace.open.commit",
      "workspace.open.cancel",
    ]);
    expect(await client.commit(candidate)).toBe(false);
  });
});
