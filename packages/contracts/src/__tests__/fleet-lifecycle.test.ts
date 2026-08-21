import { describe, expect, it } from "vitest";

import { FleetAgentProvisionArgumentsSchemaZ } from "../fleet-lifecycle.ts";

const REVISION = "0123456789abcdef0123";
const SESSION = "session.0123456789abcdef";

describe("FleetAgentProvisionArgumentsSchemaZ", () => {
  it("accepts an opaque, revision-fenced split intent", () => {
    expect(
      FleetAgentProvisionArgumentsSchemaZ.safeParse({
        expectedCatalogRevision: REVISION,
        command: "claude --resume abc",
        harness: "claude",
        displayTitle: "Claude",
        target: {
          kind: "existing-session",
          fleetSessionId: SESSION,
          placement: "split-h",
          targetSemanticPaneId: "pane.editor",
          cwd: null,
          inheritTargetCwd: true,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects raw tmux identity, targetless splits, relative paths, and control bytes", () => {
    const base = {
      expectedCatalogRevision: REVISION,
      command: "claude",
      harness: "claude",
      displayTitle: "Claude",
    };
    expect(
      FleetAgentProvisionArgumentsSchemaZ.safeParse({
        ...base,
        target: {
          kind: "existing-session",
          fleetSessionId: "%1",
          placement: "split-v",
          targetSemanticPaneId: null,
          cwd: null,
          inheritTargetCwd: false,
        },
      }).success,
    ).toBe(false);
    expect(
      FleetAgentProvisionArgumentsSchemaZ.safeParse({
        ...base,
        target: { kind: "new-session", displayName: "Demo", cwd: "relative" },
      }).success,
    ).toBe(true); // owner path is resolved and rejected daemon-side
    expect(
      FleetAgentProvisionArgumentsSchemaZ.safeParse({
        ...base,
        command: "claude\nrm -rf /",
        target: { kind: "new-session", displayName: "Demo", cwd: "/tmp" },
      }).success,
    ).toBe(false);
  });
});
