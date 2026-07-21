import { afterEach, describe, expect, it } from "bun:test";
import {
  ApplicationShellProjectionInputV1SchemaZ,
  projectApplicationShellV1,
} from "@tmux-ide/contracts";
import { _setTmuxRunner } from "../discovery.ts";
import { createApp } from "../server.ts";
import { _setExecutor } from "../../widgets/lib/pane-comms.ts";
import { projectApplicationShellResource } from "./application-shell.ts";

const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

function liveSession() {
  return {
    name: "product\nworkspace",
    dir: "/Users/example/Product Workspace",
    panes: [
      {
        semanticPaneId: "pane.pm",
        index: 0,
        title: "Project manager",
        currentCommand: "claude",
        active: false,
        role: "lead",
        name: "Fable",
        type: "agent",
      },
      {
        semanticPaneId: null,
        index: 1,
        title: "Implementer",
        currentCommand: "codex",
        active: true,
        role: "teammate",
        name: "Codex",
        type: "agent",
      },
    ],
  } as const;
}

describe("application-shell resource projector", () => {
  it("builds one immutable canonical input from live semantic pane facts", () => {
    const first = projectApplicationShellResource(liveSession());
    const second = projectApplicationShellResource(liveSession());

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(ApplicationShellProjectionInputV1SchemaZ.parse(first)).toEqual(first);
    expect(() => projectApplicationShellV1(first)).not.toThrow();
    expect(first.workspace.sidebar.agents).toEqual([
      expect.objectContaining({ name: "Fable", harness: "claude-code", paneId: "pane.pm" }),
      expect.objectContaining({ name: "Codex", harness: "codex" }),
    ]);
    expect(first.focus.appFocusedPaneId).toBe(first.workspace.sidebar.agents[1]!.paneId);
    expect(first.focus.terminalInputPaneId).toBeNull();
    expect(JSON.stringify(first)).not.toContain("%1");
    expect(JSON.stringify(first)).not.toContain("/Users/example");
    expect(first.project.name).toBe("product workspace");
  });

  it("publishes absent dock capabilities as disabled zero-count facts", () => {
    const result = projectApplicationShellResource(liveSession());

    expect(result.dock.tools.map(({ id }) => id)).toEqual([
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    for (const tool of result.dock.tools) {
      expect(tool.disabledReason).toContain("not available");
      expect(tool.unreadCount).toBe(0);
    }
    expect(result.dock.tools[0]!.data).toEqual({
      kind: "files",
      selectedResourceId: null,
      fileCount: 0,
    });
    expect(result.dock.tools[1]!.data).toEqual({
      kind: "changes",
      selectedResourceId: null,
      changeCount: 0,
    });
    expect(result.dock.tools[2]!.data).toEqual(
      expect.objectContaining({
        kind: "missions",
        title: "Missions unavailable",
        status: "disconnected",
        goalCount: 0,
        taskCount: 0,
      }),
    );
    expect(result.dock.tools[3]!.data).toEqual({
      kind: "activity",
      eventCount: 0,
      latestEventLabel: null,
    });
  });

  it("falls back deterministically for invalid or duplicated stamps without publishing tmux ids", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      panes: session.panes.map((pane) => ({ ...pane, semanticPaneId: "%7" })),
    });
    const paneIds = result.workspace.sidebar.agents.map((agent) => agent.paneId);

    expect(new Set(paneIds).size).toBe(2);
    expect(paneIds.every((paneId) => paneId?.startsWith("pane.discovered."))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("%7");
  });

  it("does not invent application focus when tmux reports no active pane", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      panes: session.panes.map((pane) => ({ ...pane, active: false })),
    });

    expect(result.focus).toMatchObject({
      windowActivity: "inactive",
      focusZone: "primary-navigation",
      appFocusedPaneId: null,
      terminalInputPaneId: null,
      layoutSelectedPaneId: null,
    });
    expect(result.workspace.sidebar.agents.map((agent) => agent.paneId)).toContain("pane.pm");
  });
});

describe("GET /api/project/:name/application-shell", () => {
  it("returns a validated browser-safe runtime input and keeps auth/CORS middleware", async () => {
    restorers.push(
      _setTmuxRunner((args) => {
        if (args[0] === "list-sessions") return "product";
        if (args[0] === "display-message") return "/repo/product";
        if (args[0] === "list-panes") return "%7\tpane.implementer";
        return "";
      }),
    );
    restorers.push(
      _setExecutor((_command, args) =>
        args[0] === "list-panes"
          ? "%7\t0\tImplementer\tcodex\t120\t40\t1\tteammate\tCodex\tagent"
          : "",
      ),
    );
    const app = createApp({
      remoteAccess: { bindHostname: "0.0.0.0", token: "secret" },
    });

    const denied = await app.request("/api/project/product/application-shell", {
      headers: { origin: "https://desktop.invalid" },
    });
    expect(denied.status).toBe(401);

    const response = await app.request("/api/project/product/application-shell", {
      headers: {
        authorization: "Bearer secret",
        origin: "https://desktop.invalid",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await response.json();
    expect(ApplicationShellProjectionInputV1SchemaZ.parse(body)).toEqual(body);
    expect(body.workspace.sidebar.agents[0]).toEqual(
      expect.objectContaining({ name: "Codex", paneId: "pane.implementer" }),
    );
    expect(JSON.stringify(body)).not.toContain("%7");
  });

  it("returns the established 404 envelope for an unknown session", async () => {
    restorers.push(_setTmuxRunner(() => ""));
    restorers.push(_setExecutor(() => ""));
    const response = await createApp().request("/api/project/missing/application-shell");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });
});
