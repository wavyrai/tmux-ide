import { describe, expect, it, vi } from "vitest";

import type { HostCapabilities, WorkspaceOpenPreparedResult } from "@tmux-ide/contracts";
import { AtomicWorkspaceOpenController } from "./atomic-workspace-open.ts";

const generation = "10000000-0000-4000-8000-000000000001";
const prepared = (token = "20000000-0000-4000-8000-000000000001"): WorkspaceOpenPreparedResult => ({
  operationId: "30000000-0000-4000-8000-000000000001",
  daemonInstanceId: generation,
  phase: "prepared",
  prepareToken: token,
  preparedRevision: 1,
  outcome: "created",
  workspaceName: "next",
  previousWorkspaceName: "old",
  proof: {
    semanticPaneId: "pane.editor",
    paneCount: 1,
    terminalRevision: 0,
    terminalStateHash: "0123456789abcdef",
  },
});

function workspace(
  overrides: Partial<HostCapabilities["workspace"]> = {},
): HostCapabilities["workspace"] {
  return {
    openProjectDirectory: vi.fn(async () => null),
    prepareProjectDirectory: vi.fn(async () => ({ status: "ok" as const, result: prepared() })),
    commitPreparedOpen: vi.fn(async (decision) => ({
      status: "ok" as const,
      result: {
        operationId: "40000000-0000-4000-8000-000000000001",
        daemonInstanceId: generation,
        phase: "committed" as const,
        ...decision,
        workspaceName: "next",
        previousWorkspaceName: "old",
      },
    })),
    cancelPreparedOpen: vi.fn(async (decision) => ({
      status: "ok" as const,
      result: {
        operationId: "50000000-0000-4000-8000-000000000001",
        daemonInstanceId: generation,
        phase: "cancelled" as const,
        ...decision,
        workspaceName: "next",
        previousWorkspaceName: "old",
      },
    })),
    ...overrides,
  };
}

describe("AtomicWorkspaceOpenController", () => {
  it("commits only after a valid prepared proof", async () => {
    const host = workspace();
    await expect(
      new AtomicWorkspaceOpenController(host, generation).open("old"),
    ).resolves.toMatchObject({ status: "committed", prepared: { workspaceName: "next" } });
    expect(host.commitPreparedOpen).toHaveBeenCalledOnce();
  });

  it("retains the old selection when prepare fails", async () => {
    const host = workspace({
      prepareProjectDirectory: vi.fn(async () => ({
        status: "error" as const,
        error: { code: "request-failed" as const, reason: "no seed" },
      })),
    });
    await expect(new AtomicWorkspaceOpenController(host, generation).open("old")).resolves.toEqual({
      status: "error",
      reason: "no seed",
    });
    expect(host.commitPreparedOpen).not.toHaveBeenCalled();
  });

  it("cancels a superseded prepared switch", async () => {
    let release!: (value: { status: "ok"; result: WorkspaceOpenPreparedResult }) => void;
    const first = new Promise<{ status: "ok"; result: WorkspaceOpenPreparedResult }>((resolve) => {
      release = resolve;
    });
    const host = workspace({
      prepareProjectDirectory: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce({
          status: "ok",
          result: prepared("20000000-0000-4000-8000-000000000002"),
        }),
    });
    const controller = new AtomicWorkspaceOpenController(host, generation);
    const pending = controller.open("old");
    const latest = controller.open("old");
    release({ status: "ok", result: prepared() });
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    await expect(latest).resolves.toMatchObject({ status: "committed" });
    expect(host.cancelPreparedOpen).toHaveBeenCalled();
  });

  it("cancels a proof from another daemon generation", async () => {
    const host = workspace({
      prepareProjectDirectory: vi.fn(async () => ({
        status: "ok" as const,
        result: { ...prepared(), daemonInstanceId: "60000000-0000-4000-8000-000000000001" },
      })),
    });
    await expect(
      new AtomicWorkspaceOpenController(host, generation).open("old"),
    ).resolves.toMatchObject({ status: "error" });
    expect(host.cancelPreparedOpen).toHaveBeenCalledOnce();
  });
});
