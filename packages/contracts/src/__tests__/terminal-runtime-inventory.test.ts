import { describe, expect, it } from "vitest";

import {
  TerminalRuntimeInventoryProjectionV1SchemaZ,
  TerminalRuntimeInventoryResourceV1SchemaZ,
} from "../terminal-runtime-inventory.ts";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "../daemon-wire.ts";

const daemon = {
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "1.0.0",
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  startedAt: "2026-08-17T10:00:00.000Z",
};

describe("terminal runtime inventory contract", () => {
  it("accepts only sorted semantic topology with opaque product/session identities", () => {
    expect(
      TerminalRuntimeInventoryResourceV1SchemaZ.parse({
        version: 1,
        daemon,
        resource: {
          workspaceName: "alpha",
          workspaceId: "workspace.0123456789abcdefabcd",
          sessionId: "session.0123456789abcdefabcd",
          resourceRevision: 4,
          semanticPaneIds: ["pane.a", "pane.b"],
        },
      }).resource.semanticPaneIds,
    ).toEqual(["pane.a", "pane.b"]);
  });

  it.each(["$3", "/Users/person/project", "session\nsecret", "plain-session"])(
    "rejects raw/control/path session identity %j",
    (sessionId) => {
      expect(
        TerminalRuntimeInventoryProjectionV1SchemaZ.safeParse({
          workspaceName: "alpha",
          workspaceId: "workspace.0123456789abcdefabcd",
          sessionId,
          resourceRevision: 0,
          semanticPaneIds: [],
        }).success,
      ).toBe(false);
    },
  );

  it("rejects duplicate or unsorted pane identities", () => {
    const base = {
      workspaceName: "alpha",
      workspaceId: "workspace.0123456789abcdefabcd",
      sessionId: "session.0123456789abcdefabcd",
      resourceRevision: 0,
    };
    expect(
      TerminalRuntimeInventoryProjectionV1SchemaZ.safeParse({
        ...base,
        semanticPaneIds: ["pane.b", "pane.a"],
      }).success,
    ).toBe(false);
    expect(
      TerminalRuntimeInventoryProjectionV1SchemaZ.safeParse({
        ...base,
        semanticPaneIds: ["pane.a", "pane.a"],
      }).success,
    ).toBe(false);
  });
});
