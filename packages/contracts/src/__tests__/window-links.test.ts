import {
  WorkspaceWindowLinkSelectArgumentsSchemaZ,
  WorkspaceWindowLinkUnlinkArgumentsSchemaZ,
  WorkspacePaneSelectWithWindowLinkArgumentsSchemaZ,
  WorkspacePaneSelectArgumentsSchemaZ,
  WorkspaceMultiplexerIntentSchemaZ,
} from "../workspace-multiplexer.ts";
import { describe, expect, it } from "vitest";
import {
  WINDOW_LINK_MAX_LINKS,
  WindowLinkTargetSchemaZ,
  WindowLinkTopologySchemaZ,
} from "../window-links.ts";
import {
  PaneStreamLayoutSnapshotV2FrameSchemaZ,
  PaneStreamLayoutSnapshotFrameSchemaZ,
  PaneStreamLayoutSnapshotV1FrameSchemaZ,
  PaneStreamServerFrameSchemaZ,
  PANE_STREAM_PROTOCOL_VERSION,
} from "../pane-stream.ts";

const linkId = (index: number) => `window-link.${index.toString(16).padStart(32, "0")}`;
const topology = () => ({
  liveSessionId: `live-session.${"a".repeat(20)}`,
  linkRevision: 1,
  activeLinkId: linkId(1),
  links: [
    { linkId: linkId(1), semanticWindowId: "window.one", displayIndex: 0 },
    { linkId: linkId(2), semanticWindowId: "window.one", displayIndex: 1 },
  ],
});
const layout = (window = "window.one", pane: string | null = "pane.one", currentWindow = true) => ({
  type: "layout" as const,
  semanticWindowId: window,
  windowName: "shell",
  currentWindow,
  cols: 80,
  rows: 24,
  zoomed: false,
  panes: [{ pane, left: 0, top: 0, width: 80, height: 24, active: true }],
});
const snapshot = () => ({
  type: "layout-snapshot" as const,
  topologyEpoch: 1,
  layouts: [layout()],
  windowLinks: topology(),
});

describe("window link contracts", () => {
  it("allows multiple links sharing one unique backing and pane", () => {
    expect(WindowLinkTopologySchemaZ.safeParse(topology()).success).toBe(true);
    expect(PaneStreamLayoutSnapshotV2FrameSchemaZ.safeParse(snapshot()).success).toBe(true);
    expect(
      PaneStreamLayoutSnapshotV2FrameSchemaZ.safeParse({
        ...snapshot(),
        windowLinks: { ...topology(), activeLinkId: linkId(2) },
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate handles/indexes and missing active links", () => {
    const original = topology();
    for (const invalid of [
      { ...original, links: [original.links[0], { ...original.links[1], linkId: linkId(1) }] },
      { ...original, links: [original.links[0], { ...original.links[1], displayIndex: 0 }] },
      { ...original, activeLinkId: linkId(3) },
      { ...original, links: [] },
    ])
      expect(WindowLinkTopologySchemaZ.safeParse(invalid).success).toBe(false);
  });

  it("bounds topology size and integer revisions/indexes", () => {
    const links = Array.from({ length: WINDOW_LINK_MAX_LINKS }, (_, index) => ({
      linkId: linkId(index + 1),
      semanticWindowId: "window.one",
      displayIndex: index,
    }));
    expect(WindowLinkTopologySchemaZ.safeParse({ ...topology(), links }).success).toBe(true);
    expect(
      WindowLinkTopologySchemaZ.safeParse({
        ...topology(),
        links: [
          ...links,
          {
            linkId: linkId(WINDOW_LINK_MAX_LINKS + 1),
            semanticWindowId: "window.one",
            displayIndex: WINDOW_LINK_MAX_LINKS,
          },
        ],
      }).success,
    ).toBe(false);
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(
        WindowLinkTopologySchemaZ.safeParse({ ...topology(), linkRevision: value }).success,
      ).toBe(false);
      expect(
        WindowLinkTopologySchemaZ.safeParse({
          ...topology(),
          links: [{ ...links[0], displayIndex: value }],
        }).success,
      ).toBe(false);
    }
  });

  it("accepts only opaque targets and rejects native or display action addresses", () => {
    const target = {
      liveSessionId: topology().liveSessionId,
      linkId: linkId(1),
      expectedSemanticWindowId: "window.one",
      linkRevision: 0,
    };
    expect(WindowLinkTargetSchemaZ.safeParse(target).success).toBe(true);
    for (const invalid of [
      { ...target, linkId: "@0" },
      { ...target, linkId: "/tmp/tmux/socket" },
      { ...target, linkId: "window-link.abc" },
      { ...target, liveSessionId: "$0" },
      { ...target, expectedSemanticWindowId: "@0" },
      { ...target, displayIndex: 0 },
      { ...target, linkRevision: -1 },
      { ...target, linkRevision: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(WindowLinkTargetSchemaZ.safeParse(invalid).success).toBe(false);
  });

  it("requires a complete join and a matching active backing", () => {
    const second = layout("window.two", "pane.two", false);
    for (const invalid of [
      { ...snapshot(), layouts: [layout("window.two")] },
      { ...snapshot(), layouts: [layout(), second] },
      {
        ...snapshot(),
        layouts: [layout("window.one", "pane.one", false), { ...second, currentWindow: true }],
        windowLinks: {
          ...topology(),
          links: [
            ...topology().links,
            { linkId: linkId(3), semanticWindowId: "window.two", displayIndex: 2 },
          ],
        },
      },
    ])
      expect(PaneStreamLayoutSnapshotV2FrameSchemaZ.safeParse(invalid).success).toBe(false);
  });

  it("preserves unique backing/pane and exactly-one-current invariants", () => {
    for (const layouts of [
      [layout(), layout()],
      [layout(), layout("window.two", "pane.one", false)],
      [layout("window.one", null)],
      [{ ...layout(), semanticWindowId: null }],
      [layout("window.one", "pane.one", false)],
      [layout(), layout("window.two", "pane.two", true)],
    ])
      expect(
        PaneStreamLayoutSnapshotV2FrameSchemaZ.safeParse({ ...snapshot(), layouts }).success,
      ).toBe(false);
  });

  it("requires v2 topology and refuses the old v1 shape", () => {
    const v1 = { type: "layout-snapshot", topologyEpoch: 1, layouts: [layout()] };
    expect(PANE_STREAM_PROTOCOL_VERSION).toBe(2);
    expect(PaneStreamLayoutSnapshotV1FrameSchemaZ.safeParse(v1).success).toBe(true);
    expect(PaneStreamLayoutSnapshotFrameSchemaZ.safeParse(v1).success).toBe(false);
    expect(PaneStreamLayoutSnapshotV2FrameSchemaZ.safeParse(v1).success).toBe(false);
    expect(PaneStreamLayoutSnapshotFrameSchemaZ.safeParse(snapshot()).success).toBe(true);
    expect(PaneStreamServerFrameSchemaZ.safeParse(snapshot()).success).toBe(true);
    expect(
      PaneStreamLayoutSnapshotV2FrameSchemaZ.safeParse({ ...snapshot(), unexpected: true }).success,
    ).toBe(false);
  });
});

describe("window link action arguments", () => {
  const target = () => ({
    liveSessionId: topology().liveSessionId,
    linkId: linkId(1),
    expectedSemanticWindowId: "window.one",
    linkRevision: 1,
  });

  it("accepts opaque select/unlink targets and explicit-link pane selection", () => {
    for (const schema of [
      WorkspaceWindowLinkSelectArgumentsSchemaZ,
      WorkspaceWindowLinkUnlinkArgumentsSchemaZ,
    ]) {
      expect(schema.safeParse({ workspaceName: "project", target: target() }).success).toBe(true);
    }
    expect(
      WorkspacePaneSelectWithWindowLinkArgumentsSchemaZ.safeParse({
        workspaceName: "project",
        semanticPaneId: "pane.one",
        windowLink: target(),
      }).success,
    ).toBe(true);
  });

  it("rejects native addresses, display indexes, command/force flags and unknown fields", () => {
    for (const schema of [
      WorkspaceWindowLinkSelectArgumentsSchemaZ,
      WorkspaceWindowLinkUnlinkArgumentsSchemaZ,
    ]) {
      const args = { workspaceName: "project", target: target() };
      for (const invalid of [
        { ...args, target: "@0" },
        { ...args, target: { ...target(), linkId: "@0" } },
        { ...args, target: { ...target(), expectedSemanticWindowId: "@0" } },
        { ...args, target: { ...target(), displayIndex: 0 } },
        { ...args, target: { ...target(), runtimeSessionId: "$0" } },
        { ...args, displayIndex: 0 },
        { ...args, command: "kill-server" },
        { ...args, force: true },
        { ...args, socketPath: "/tmp/tmux/socket" },
        { ...args, workspaceName: "" },
      ])
        expect(schema.safeParse(invalid).success).toBe(false);
    }
    const args = { workspaceName: "project", semanticPaneId: "pane.one", windowLink: target() };
    for (const invalid of [
      { ...args, semanticPaneId: "%0" },
      { ...args, command: "select-pane -t %0" },
      { ...args, windowLink: { ...target(), linkId: "project:0" } },
      { workspaceName: "project", semanticPaneId: "pane.one" },
    ])
      expect(WorkspacePaneSelectWithWindowLinkArgumentsSchemaZ.safeParse(invalid).success).toBe(
        false,
      );
  });

  it("accepts registered link verbs and explicit-link pane selection", () => {
    const args = { workspaceName: "project", target: target() };
    for (const verb of ["workspace.window.link.select", "workspace.window.link.unlink"]) {
      expect(WorkspaceMultiplexerIntentSchemaZ.safeParse({ verb, ...args }).success).toBe(true);
    }
    expect(
      WorkspacePaneSelectArgumentsSchemaZ.safeParse({
        workspaceName: "project",
        semanticPaneId: "pane.one",
        windowLink: target(),
      }).success,
    ).toBe(true);
  });
});
