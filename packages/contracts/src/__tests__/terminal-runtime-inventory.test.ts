import { describe, expect, it } from "vitest";

import {
  TerminalRuntimeInventoryProjectionV1SchemaZ,
  TerminalRuntimeInventoryProjectionV2SchemaZ,
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

  it("version 2 lists each window's panes, and only panes it lists (#806)", () => {
    const base = {
      workspaceName: "alpha",
      workspaceId: "workspace.0123456789abcdefabcd",
      sessionId: "session.0123456789abcdefabcd",
      resourceRevision: 0,
      semanticPaneIds: ["pane.a", "pane.b", "pane.c"],
    };
    const windows = [
      { semanticWindowId: "window.one", active: true, semanticPaneIds: ["pane.a", "pane.b"] },
      { semanticWindowId: "window.two", active: false, semanticPaneIds: ["pane.c"] },
    ];
    expect(TerminalRuntimeInventoryProjectionV2SchemaZ.parse({ ...base, windows }).windows).toEqual(
      windows,
    );
    const bad = (value: unknown) =>
      TerminalRuntimeInventoryProjectionV2SchemaZ.safeParse({ ...base, windows: value }).success;
    // A pane the inventory does not list, a pane in two windows, a repeated window, two active.
    expect(bad([{ ...windows[0], semanticPaneIds: ["pane.a", "pane.z"] }])).toBe(false);
    expect(bad([windows[0], { ...windows[1], semanticPaneIds: ["pane.b"] }])).toBe(false);
    expect(bad([windows[0], { ...windows[1], semanticWindowId: "window.one" }])).toBe(false);
    expect(bad([windows[0], { ...windows[1], active: true }])).toBe(false);
    expect(bad([{ ...windows[0], semanticPaneIds: [] }])).toBe(false);
    // A window may be missing (its panes are unverified); version 1 has no windows.
    expect(bad([windows[1]])).toBe(true);
    expect(
      TerminalRuntimeInventoryProjectionV1SchemaZ.safeParse({ ...base, windows }).success,
    ).toBe(false);
  });
});
