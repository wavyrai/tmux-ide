import { afterEach, describe, expect, it } from "bun:test";
import {
  ApplicationShellProjectionInputV1SchemaZ,
  ApplicationShellResourceV1SchemaZ,
  ApplicationShellResourceV2SchemaZ,
  projectApplicationShellV1,
} from "@tmux-ide/contracts";
import { createApp } from "../server.ts";
import { _setTmuxRunner } from "../discovery.ts";
import { _setExecutor } from "../../widgets/lib/pane-comms.ts";
import { projectApplicationShellResource } from "./application-shell.ts";

const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

function liveSession() {
  return {
    name: "product\nworkspace",
    runtimeSessionId: "$4",
    dir: "/Users/example/Product Workspace",
    catalogIssue: "missing-semantic-stamp" as const,
    panes: [
      {
        runtimePaneId: "%11",
        semanticPaneId: "pane.pm",
        index: 0,
        title: "Project manager",
        currentCommand: "claude",
        active: false,
        windowPaneCount: 1,
        role: "lead",
        name: "Fable",
        type: "agent",
      },
      {
        runtimePaneId: "%12",
        semanticPaneId: null,
        index: 1,
        title: "Implementer",
        currentCommand: "codex",
        active: true,
        windowPaneCount: 1,
        role: "teammate",
        name: "Codex",
        type: "agent",
      },
    ],
  } as const;
}

describe("application-shell resource projector", () => {
  it("builds one immutable canonical input with correlated terminal resources", () => {
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
    const fallbackId = first.workspace.sidebar.agents[1]!.paneId!;
    expect(first.focus.appFocusedPaneId).toBe(fallbackId);
    expect(first.terminalInventory).toEqual({
      activeResourceId: fallbackId,
      resources: [
        {
          id: "pane.pm",
          title: "Fable",
          kind: "agent",
          active: false,
          attachability: { status: "unavailable", reason: "missing-semantic-stamp" },
        },
        {
          id: fallbackId,
          title: "Codex",
          kind: "agent",
          active: true,
          attachability: { status: "unavailable", reason: "missing-semantic-stamp" },
        },
      ],
    });
    const encoded = JSON.stringify(first);
    expect(encoded).not.toMatch(/%1[12]/u);
    expect(encoded).not.toContain("$4");
    expect(encoded).not.toContain("/Users/example");
    expect(encoded).not.toContain("currentCommand");
    expect(JSON.stringify(first.terminalInventory)).not.toMatch(/claude|codex/u);
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

  it("keeps duplicate stamps visible, uniquely keyed, and explicitly unavailable", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      catalogIssue: "duplicate-semantic-stamp",
      panes: session.panes.map((pane) => ({ ...pane, semanticPaneId: "pane.duplicate" })),
    });
    const resources = result.terminalInventory!.resources;

    expect(new Set(resources.map(({ id }) => id)).size).toBe(2);
    expect(resources.every(({ id }) => id.startsWith("terminal.discovered."))).toBe(true);
    expect(resources.map(({ attachability }) => attachability)).toEqual([
      { status: "unavailable", reason: "duplicate-semantic-stamp" },
      { status: "unavailable", reason: "duplicate-semantic-stamp" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/%1[12]/u);
  });

  it("keeps fallback identity durable across title, command, and index refreshes", () => {
    const before = projectApplicationShellResource(liveSession());
    const session = liveSession();
    const after = projectApplicationShellResource({
      ...session,
      panes: session.panes.map((pane, index) =>
        index === 1
          ? {
              ...pane,
              index: 9,
              title: "Renamed shell",
              currentCommand: "zsh",
              name: null,
              type: null,
            }
          : pane,
      ),
    });

    expect(after.terminalInventory!.resources[1]!.id).toBe(
      before.terminalInventory!.resources[1]!.id,
    );
    expect(after.terminalInventory!.resources[1]!.title).toBe("Renamed shell");
    expect(after.terminalInventory!.resources[1]!.id).not.toBe("Renamed shell");
  });

  it("keeps malformed stamps and multi-pane windows unavailable", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      catalogIssue: "invalid-runtime-proof",
      panes: [
        { ...session.panes[0], semanticPaneId: "%7" },
        { ...session.panes[1], semanticPaneId: "pane.valid" },
      ],
    });

    expect(result.terminalInventory!.resources.map(({ attachability }) => attachability)).toEqual([
      { status: "unavailable", reason: "invalid-runtime-proof" },
      { status: "unavailable", reason: "invalid-runtime-proof" },
    ]);

    const multiPane = projectApplicationShellResource({
      ...session,
      catalogIssue: null,
      panes: [{ ...session.panes[0], windowPaneCount: 2 }],
    });
    expect(multiPane.terminalInventory.resources[0]!.attachability).toEqual({
      status: "unavailable",
      reason: "not-single-pane-window",
    });
  });

  it("never promotes the reserved fallback namespace to attachment authority", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      catalogIssue: null,
      panes: [
        {
          ...session.panes[0],
          semanticPaneId: "terminal.discovered.user-authored",
          active: true,
        },
      ],
    });
    const resource = result.terminalInventory.resources[0]!;

    expect(resource.id).toMatch(/^terminal\.discovered\.[a-f0-9]{20}$/u);
    expect(resource.id).not.toBe("terminal.discovered.user-authored");
    expect(resource.attachability).toEqual({
      status: "unavailable",
      reason: "invalid-runtime-proof",
    });
  });

  it("falls back for every semantic stamp outside attachment target grammar", () => {
    const session = liveSession();
    for (const semanticPaneId of [
      "pane:colon",
      "constructor",
      "__proto__",
      ".leading-dot",
      `pane.${"x".repeat(124)}`,
    ]) {
      const result = projectApplicationShellResource({
        ...session,
        catalogIssue: null,
        panes: [{ ...session.panes[0], semanticPaneId, active: true }],
      });
      const resource = result.terminalInventory.resources[0]!;
      expect(resource.id).toMatch(/^terminal\.discovered\.[a-f0-9]{20}$/u);
      expect(resource.id).not.toBe(semanticPaneId);
      expect(resource.attachability).toEqual({
        status: "unavailable",
        reason: "invalid-runtime-proof",
      });
    }
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
    expect(result.terminalInventory!.activeResourceId).toBeNull();
    expect(result.terminalInventory!.resources.every(({ active }) => !active)).toBe(true);
  });
});

describe("GET /api/project/:name/application-shell", () => {
  it("keeps standalone default and explicit V1 discovery while V2 fails closed", async () => {
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
    const app = createApp();

    for (const path of [
      "/api/project/product/application-shell",
      "/api/project/product/application-shell?version=1",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const body = ApplicationShellResourceV1SchemaZ.parse(await response.json());
      expect(body.resource.workspace.sidebar.agents[0]).toEqual(
        expect.objectContaining({ name: "Codex", paneId: "pane.implementer" }),
      );
      expect(Object.hasOwn(body.resource, "terminalInventory")).toBe(false);
      expect(JSON.stringify(body)).not.toContain("%7");
    }

    const v2 = await app.request("/api/project/product/application-shell?version=2");
    expect(v2.status).toBe(503);
    expect(await v2.json()).toEqual({ error: "Session discovery unavailable" });
  });

  it("defaults old callers to V1 and gives negotiated callers a strict V2 inventory", async () => {
    const requests: string[] = [];
    const app = createApp({
      remoteAccess: { bindHostname: "0.0.0.0", token: "secret" },
      daemonIdentity: {
        productVersion: "2.8.0",
        instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
        startedAt: "2026-07-21T00:00:00.000Z",
      },
      applicationShellInventoryBackend: {
        async discoverApplicationShellSession(name) {
          requests.push(name);
          return { ...liveSession(), name: "product" };
        },
      },
    });

    const denied = await app.request("/api/project/product/application-shell", {
      headers: { origin: "https://desktop.invalid" },
    });
    expect(denied.status).toBe(401);

    const legacyResponse = await app.request("/api/project/product/application-shell", {
      headers: {
        authorization: "Bearer secret",
        origin: "https://desktop.invalid",
      },
    });
    expect(legacyResponse.status).toBe(200);
    expect(legacyResponse.headers.get("access-control-allow-origin")).toBe("*");
    const legacy = ApplicationShellResourceV1SchemaZ.parse(await legacyResponse.json());
    expect(legacy.daemon.instanceId).toBe("9bcf33b0-c837-4a94-b5e8-c0977f54464f");
    expect(Object.hasOwn(legacy.resource, "terminalInventory")).toBe(false);

    const response = await app.request("/api/project/product/application-shell?version=2", {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    const body = ApplicationShellResourceV2SchemaZ.parse(await response.json());
    expect(body.resource.workspace.sidebar.agents[0]).toEqual(
      expect.objectContaining({ name: "Fable", paneId: "pane.pm" }),
    );
    expect(body.resource.terminalInventory.resources).toHaveLength(2);
    expect(body.resource.terminalInventory.resources[1]).toEqual(
      expect.objectContaining({
        title: "Codex",
        kind: "agent",
        attachability: { status: "unavailable", reason: "missing-semantic-stamp" },
      }),
    );
    expect(JSON.stringify(body)).not.toMatch(/%[79]/u);
    expect(requests).toEqual(["product", "product"]);
  });

  it("returns the established 404 envelope for an unknown session", async () => {
    const response = await createApp({
      applicationShellInventoryBackend: { discoverApplicationShellSession: async () => null },
    }).request("/api/project/missing/application-shell");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("distinguishes failed tmux discovery from an empty session", async () => {
    const response = await createApp({
      applicationShellInventoryBackend: {
        discoverApplicationShellSession: async () => {
          throw new Error("tmux unavailable");
        },
      },
    }).request("/api/project/product/application-shell?version=2");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Session discovery unavailable" });
  });
});
