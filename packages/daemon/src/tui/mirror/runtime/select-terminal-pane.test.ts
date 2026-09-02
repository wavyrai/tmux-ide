import { describe, expect, it, vi } from "vitest";

import { selectTerminalPane, type LivePaneSelectionTarget } from "./select-terminal-pane.ts";

function target(
  requestAuthority: () => Promise<unknown | null>,
  ownsRuntimeAuthority?: (authority: "input") => boolean,
): LivePaneSelectionTarget {
  return {
    status: "live",
    daemonGeneration: "generation-a",
    workspaceName: "workspace.alpha",
    client: {
      ...(ownsRuntimeAuthority ? { ownsRuntimeAuthority } : {}),
      requestAuthority: vi.fn(requestAuthority),
      dispatch: vi.fn(async (request) => {
        const operationId = request.operationId ?? "generated-operation";
        return {
          kind: "semantic-intent",
          operationId,
          result: {
            verb: "workspace.pane.select",
            semanticPaneId: request.intent.semanticPaneId,
            workspaceName: request.intent.workspaceName,
            daemonInstanceId: "generation-a",
            operationId,
            outcome: "applied",
          },
        };
      }),
    },
  };
}

describe("selectTerminalPane", () => {
  it("waits for input authority before dispatching selection", async () => {
    let grant!: (lease: unknown) => void;
    const active = target(() => new Promise((resolve) => (grant = resolve)));
    const selecting = selectTerminalPane(active, () => active, "pane.editor");
    expect(active.client.dispatch).not.toHaveBeenCalled();
    grant({ token: "lease" });
    expect(await selecting).toMatchObject({ applied: true, semanticPaneId: "pane.editor" });
    expect(active.client.dispatch).toHaveBeenCalledWith({
      kind: "semantic-intent",
      intent: {
        verb: "workspace.pane.select",
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.editor",
      },
    });
    const fresh = target(async () => ({ token: "lease" }));
    expect(await selectTerminalPane(fresh, () => ({ ...fresh }), "pane.editor")).toMatchObject({
      applied: true,
    });
  });

  it("reuses a current input lease without a redundant authority round trip", async () => {
    const active = target(
      async () => ({ token: "unused" }),
      () => true,
    );
    expect(
      await selectTerminalPane(active, () => active, "pane.editor", "operation-1"),
    ).toMatchObject({ applied: true, operationId: "operation-1" });
    expect(active.client.requestAuthority).not.toHaveBeenCalled();
    expect(active.client.dispatch).toHaveBeenCalledTimes(1);
    expect(active.client.dispatch).toHaveBeenCalledWith({
      kind: "semantic-intent",
      operationId: "operation-1",
      intent: {
        verb: "workspace.pane.select",
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.editor",
      },
    });
  });

  it("does not dispatch after denial or a late generation replacement", async () => {
    const denied = target(async () => null);
    const failures = vi.fn();
    expect(
      await selectTerminalPane(denied, () => denied, "pane.editor", undefined, failures),
    ).toBeNull();
    expect(failures).toHaveBeenCalledWith({
      stage: "authority-request",
      reason: "authority-rejected",
    });
    expect(denied.client.dispatch).not.toHaveBeenCalled();

    let grant!: (lease: unknown) => void;
    const retired = target(() => new Promise((resolve) => (grant = resolve)));
    const replacement = target(async () => ({ token: "new" }));
    let current = retired;
    const selecting = selectTerminalPane(retired, () => current, "pane.editor");
    current = replacement;
    grant({ token: "old" });
    expect(await selecting).toBeNull();
    expect(retired.client.dispatch).not.toHaveBeenCalled();
  });

  it("reports bounded dispatch transport failures without exposing messages", async () => {
    const active = target(
      async () => ({}),
      () => true,
    );
    vi.mocked(active.client.dispatch).mockRejectedValueOnce(
      Object.assign(new Error("sensitive connection detail"), { code: "input-rejected" }),
    );
    const failures = vi.fn();
    expect(
      await selectTerminalPane(active, () => active, "pane.editor", "operation-1", failures),
    ).toBeNull();
    expect(failures).toHaveBeenCalledWith({ stage: "dispatch", reason: "transport-rejected" });

    for (const backendReason of [
      "pane_inventory_not_ready",
      "pane_identity_changed_before_select",
      "pane_not_active",
    ] as const) {
      vi.mocked(active.client.dispatch).mockRejectedValueOnce(
        Object.assign(new Error("sensitive backend detail"), { code: backendReason }),
      );
      expect(
        await selectTerminalPane(active, () => active, "pane.editor", "operation-1", failures),
      ).toBeNull();
      expect(failures).toHaveBeenLastCalledWith({
        stage: "dispatch",
        reason: "transport-rejected",
        backendReason,
      });
    }
  });

  it("requires the production wrapper and exact nested applied result", async () => {
    const cases: unknown[] = [
      {
        verb: "workspace.pane.select",
        operationId: "operation-1",
        semanticPaneId: "pane.editor",
        workspaceName: "workspace.alpha",
        daemonInstanceId: "generation-a",
        outcome: "applied",
      },
      { kind: "semantic-intent", operationId: "operation-1", result: null },
      {
        kind: "semantic-intent",
        operationId: "operation-1",
        result: {
          verb: "workspace.pane.select",
          operationId: "other-operation",
          semanticPaneId: "pane.editor",
          workspaceName: "workspace.alpha",
          daemonInstanceId: "generation-a",
          outcome: "applied",
        },
      },
      {
        kind: "semantic-intent",
        operationId: "operation-1",
        result: {
          verb: "workspace.pane.select",
          operationId: "operation-1",
          semanticPaneId: "pane.other",
          workspaceName: "workspace.alpha",
          daemonInstanceId: "generation-a",
          outcome: "applied",
        },
      },
      {
        kind: "semantic-intent",
        operationId: "operation-1",
        result: {
          verb: "workspace.pane.select",
          operationId: "operation-1",
          semanticPaneId: "pane.editor",
          workspaceName: "workspace.alpha",
          daemonInstanceId: "generation-a",
          outcome: "rejected",
        },
      },
    ];
    for (const result of cases) {
      const active = target(
        async () => ({}),
        () => true,
      );
      vi.mocked(active.client.dispatch).mockResolvedValueOnce(result);
      await expect(
        selectTerminalPane(active, () => active, "pane.editor", "operation-1"),
      ).resolves.toBeNull();
    }
  });
});
