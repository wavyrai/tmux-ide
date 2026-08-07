/* @vitest-environment happy-dom */
import {
  ApplicationShellProjectionInputV3SchemaZ,
  type AgentGraphOverlay,
  type ApplicationShellProjectionInputV1,
} from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import { projectLiveWorkspace, sanitizeAgentGraphOverlay } from "./live-app-composition.tsx";
import { createDefaultDomShellInput, createDefaultDomPaneFrames } from "../experience/dom-shell.ts";
import { agentGraphCanvasOverlay } from "../experience/agent-graph-canvas-fixture.ts";

/**
 * A coherent V3 shell input (empty durable windows, agent terminals wired to the
 * default sidebar agents) that mirrors how the live host projects the resource.
 * The optional `overlay` rides along exactly like the daemon's additive field.
 */
function v3Input(overlay?: AgentGraphOverlay): ApplicationShellProjectionInputV1 {
  const input = createDefaultDomShellInput();
  const paneFrames = createDefaultDomPaneFrames();
  return ApplicationShellProjectionInputV3SchemaZ.parse({
    ...input,
    terminalInventory: {
      activeResourceId: input.focus.appFocusedPaneId,
      resources: paneFrames.map((frame) => ({
        id: frame.pane.id,
        title: frame.title,
        kind: "agent" as const,
        active: frame.pane.id === input.focus.appFocusedPaneId,
        attachability: { status: "available" as const, semanticPaneId: frame.pane.id },
      })),
    },
    appWindows: {
      version: 1,
      revision: 0,
      updatedAt: "2026-07-22T15:30:00.000Z",
      windows: {},
      dockRoot: null,
      dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
      floatingOrder: [],
      focusedWindowId: null,
      activeLayoutId: null,
      layouts: {},
    },
    ...(overlay ? { agentGraphOverlay: overlay } : {}),
  }) as ApplicationShellProjectionInputV1;
}

/** A V3 shell input carrying a raw (unvalidated) overlay for the malformed case. */
function v3InputWithRawOverlay(rawOverlay: unknown): ApplicationShellProjectionInputV1 {
  return { ...v3Input(), agentGraphOverlay: rawOverlay } as ApplicationShellProjectionInputV1;
}

describe("sanitizeAgentGraphOverlay", () => {
  it("passes a valid overlay through untouched", () => {
    const overlay = agentGraphCanvasOverlay("nodes-only")!;
    const input = v3Input(overlay);
    const result = sanitizeAgentGraphOverlay(input);
    expect(result).toBe(input);
    expect((result as { agentGraphOverlay?: unknown }).agentGraphOverlay).toEqual(overlay);
  });

  it("leaves an input without an overlay untouched", () => {
    const input = v3Input();
    expect(sanitizeAgentGraphOverlay(input)).toBe(input);
  });

  it("drops a malformed overlay while preserving the rest of the read", () => {
    const input = v3InputWithRawOverlay({ nodes: "not-a-record" });
    const result = sanitizeAgentGraphOverlay(input);
    expect("agentGraphOverlay" in result).toBe(false);
    // The remaining V3 shell read is intact and still strictly valid.
    expect(() => ApplicationShellProjectionInputV3SchemaZ.parse(result)).not.toThrow();
    expect(result.workspace).toEqual(input.workspace);
  });
});

describe("projectLiveWorkspace overlay threading", () => {
  it("returns ready and carries a valid overlay on the projected input", () => {
    const overlay = agentGraphCanvasOverlay("spawned-edges")!;
    const projection = projectLiveWorkspace(v3Input(overlay));
    expect(projection.status).toBe("ready");
    if (projection.status !== "ready") throw new Error("expected ready");
    expect((projection.input as { agentGraphOverlay?: unknown }).agentGraphOverlay).toEqual(
      overlay,
    );
  });

  it("returns ready with no overlay when the resource omits one", () => {
    const projection = projectLiveWorkspace(v3Input());
    expect(projection.status).toBe("ready");
    if (projection.status !== "ready") throw new Error("expected ready");
    expect("agentGraphOverlay" in projection.input).toBe(false);
  });

  it("rejects a malformed overlay without killing the shell read", () => {
    // A bad edge that references an unknown node fails the overlay refine.
    const projection = projectLiveWorkspace(
      v3InputWithRawOverlay({
        nodes: {},
        edges: [{ from: "window.a", to: "window.b", kind: "spawned" }],
        groups: [],
      }),
    );
    expect(projection.status).toBe("ready");
    if (projection.status !== "ready") throw new Error("expected ready");
    expect("agentGraphOverlay" in projection.input).toBe(false);
    // The surviving read remains a strictly valid V3 shell resource.
    expect(() => ApplicationShellProjectionInputV3SchemaZ.parse(projection.input)).not.toThrow();
  });

  it("still rejects a genuinely incoherent core read", () => {
    const input = v3Input();
    const duplicated = {
      ...input,
      workspace: {
        ...input.workspace,
        sidebar: {
          ...input.workspace.sidebar,
          agents: [
            ...input.workspace.sidebar.agents,
            ...input.workspace.sidebar.agents.slice(0, 1),
          ],
        },
      },
    } as ApplicationShellProjectionInputV1;
    expect(projectLiveWorkspace(duplicated).status).toBe("rejected");
  });
});
