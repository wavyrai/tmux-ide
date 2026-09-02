import { describe, expect, it, vi } from "vitest";

import { resizeTerminalPane, type LivePaneResizeTarget } from "./resize-terminal-pane.ts";

const operationId = "123e4567-e89b-42d3-a456-426614174000";
function fixture() {
  const client = {
    ownsRuntimeAuthority: vi.fn(() => false),
    requestAuthority: vi.fn(async () => ({ id: "lease" })),
    dispatch: vi.fn(async () => ({
      kind: "semantic-intent",
      operationId,
      result: {
        operationId,
        verb: "workspace.pane.resize",
        daemonInstanceId: "daemon-a",
        workspaceName: "workspace-a",
        semanticPaneId: "pane-a",
        axis: "cols",
        cells: 41,
        outcome: "applied",
      },
    })),
  };
  const target: LivePaneResizeTarget = {
    status: "live",
    daemonGeneration: "daemon-a",
    workspaceName: "workspace-a",
    connection: {},
    clientGeneration: 1,
    rendererEpoch: 1,
    client,
  };
  let current: LivePaneResizeTarget | null = target;
  return {
    client,
    target,
    current: () => current,
    setCurrent: (value: LivePaneResizeTarget | null) => (current = value),
  };
}

describe("resizeTerminalPane", () => {
  it("acquires geometry and validates the exact production wrapper", async () => {
    const { client, target, current } = fixture();
    await expect(
      resizeTerminalPane(target, current, {
        operationId,
        semanticPaneId: "pane-a",
        axis: "cols",
        cells: 41,
      }),
    ).resolves.toEqual({
      operationId,
      semanticPaneId: "pane-a",
      axis: "cols",
      requestedCells: 41,
      cells: 41,
      outcome: "applied",
    });
    expect(client.requestAuthority).toHaveBeenCalledOnce();
    expect(client.dispatch).toHaveBeenCalledWith({
      kind: "semantic-intent",
      operationId,
      intent: {
        verb: "workspace.pane.resize",
        workspaceName: "workspace-a",
        semanticPaneId: "pane-a",
        axis: "cols",
        cells: 41,
      },
    });
  });

  it("preserves an exact native row request through the production wrapper", async () => {
    const { client, target, current } = fixture();
    client.dispatch.mockResolvedValueOnce({
      kind: "semantic-intent",
      operationId,
      result: {
        operationId,
        verb: "workspace.pane.resize",
        daemonInstanceId: "daemon-a",
        workspaceName: "workspace-a",
        semanticPaneId: "pane-a",
        axis: "rows",
        cells: 19,
        outcome: "applied",
      },
    });
    await expect(
      resizeTerminalPane(target, current, {
        operationId,
        semanticPaneId: "pane-a",
        axis: "rows",
        cells: 19,
      }),
    ).resolves.toMatchObject({ axis: "rows", requestedCells: 19, cells: 19 });
    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ axis: "rows", cells: 19 }),
      }),
    );
  });

  it("refuses null grants, replacement races, raw results, and mismatched receipts", async () => {
    for (const arrange of [
      ({ client }) => client.requestAuthority.mockResolvedValueOnce(null),
      ({ client, setCurrent }) => {
        client.requestAuthority.mockImplementationOnce(async () => {
          setCurrent(null);
          return { id: "lease" };
        });
      },
      ({ client }) => client.dispatch.mockResolvedValueOnce({ verb: "workspace.pane.resize" }),
      ({ client }) =>
        client.dispatch.mockResolvedValueOnce({
          kind: "semantic-intent",
          operationId,
          result: {
            operationId,
            verb: "workspace.pane.resize",
            daemonInstanceId: "daemon-a",
            workspaceName: "workspace-a",
            semanticPaneId: "pane-b",
            axis: "cols",
            cells: 41,
            outcome: "applied",
          },
        }),
    ]) {
      const value = fixture();
      arrange(value as never);
      const failures = vi.fn();
      await expect(
        resizeTerminalPane(
          value.target,
          value.current,
          { operationId, semanticPaneId: "pane-a", axis: "cols", cells: 41 },
          failures,
        ),
      ).resolves.toBeNull();
      expect(failures).toHaveBeenCalledOnce();
    }
  });

  it("does not let a throwing failure sink alter the refusal", async () => {
    const { client, target, current } = fixture();
    client.requestAuthority.mockResolvedValueOnce(null);
    await expect(
      resizeTerminalPane(
        target,
        current,
        { operationId, semanticPaneId: "pane-a", axis: "cols", cells: 41 },
        () => {
          throw new Error("sink");
        },
      ),
    ).resolves.toBeNull();
  });
});
