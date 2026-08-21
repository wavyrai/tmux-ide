import { describe, expect, it } from "vitest";

import { semanticMutationResourceChanges } from "./semantic-mutation-resource-changes.ts";

const base = {
  operationId: "10000000-0000-4000-8000-000000000001",
  daemonInstanceId: "20000000-0000-4000-8000-000000000002",
  workspaceName: "alpha",
} as const;

describe("semantic mutation resource changes", () => {
  it("maps applied presentation and topology mutations with their exact operation id", () => {
    expect(
      semanticMutationResourceChanges({
        ...base,
        verb: "workspace.pane.select",
        outcome: "applied",
        semanticPaneId: "pane.beta",
      }),
    ).toEqual([
      { workspaceName: "alpha", resource: "application-shell", causeOperationId: base.operationId },
      {
        workspaceName: "alpha",
        resource: "workspace-missions",
        causeOperationId: base.operationId,
      },
    ]);
    expect(
      semanticMutationResourceChanges({
        ...base,
        verb: "workspace.rename",
        outcome: "applied",
        scope: "window",
        name: "renamed",
      }),
    ).toEqual([
      { workspaceName: "alpha", resource: "application-shell", causeOperationId: base.operationId },
      {
        workspaceName: "alpha",
        resource: "workspace-missions",
        causeOperationId: base.operationId,
      },
    ]);
    expect(
      semanticMutationResourceChanges({
        ...base,
        verb: "workspace.rename",
        outcome: "applied",
        scope: "session",
        name: "renamed-session",
      }).map(({ workspaceName, resource }) => [workspaceName, resource]),
    ).toEqual([
      ["alpha", "application-shell"],
      ["alpha", "workspace-missions"],
      [null, "fleet-catalog"],
      [null, "workspace-catalog"],
    ]);
    expect(
      semanticMutationResourceChanges({
        ...base,
        verb: "workspace.session.kill",
        outcome: "applied",
      }).map(({ workspaceName, resource }) => [workspaceName, resource]),
    ).toEqual([
      ["alpha", "application-shell"],
      ["alpha", "workspace-missions"],
      [null, "fleet-catalog"],
      [null, "workspace-catalog"],
    ]);
  });

  it("emits nothing for replay, unchanged, send, read-shaped, rejected, or malformed outcomes", () => {
    for (const result of [
      { ...base, verb: "workspace.pane.select", outcome: "replayed", semanticPaneId: "pane.beta" },
      { ...base, verb: "workspace.pane.select", outcome: "unchanged", semanticPaneId: "pane.beta" },
      { ...base, verb: "workspace.pane.send", semanticPaneId: "pane.beta", outcome: "applied" },
      undefined,
      { ...base, verb: "workspace.pane.select", outcome: "rejected" },
      { ...base, verb: "workspace.pane.select", outcome: "applied", semanticPaneId: "" },
    ]) {
      expect(semanticMutationResourceChanges(result)).toEqual([]);
    }
  });
});
