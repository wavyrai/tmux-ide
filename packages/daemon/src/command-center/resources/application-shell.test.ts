import { afterEach, describe, expect, it } from "bun:test";
import {
  ApplicationShellProjectionInputV1SchemaZ,
  ApplicationShellResourceV1SchemaZ,
  projectApplicationShellV1,
} from "@tmux-ide/contracts";
import {
  ApplicationShellDiscoveryError,
  _setTmuxRunner,
  discoverApplicationShellSession,
} from "../discovery.ts";
import { createApp } from "../server.ts";
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
          attachability: { status: "available", semanticPaneId: "pane.pm" },
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
      panes: [
        { ...session.panes[0], semanticPaneId: "%7" },
        { ...session.panes[1], semanticPaneId: "pane.valid", windowPaneCount: 2 },
      ],
    });

    expect(result.terminalInventory!.resources.map(({ attachability }) => attachability)).toEqual([
      { status: "unavailable", reason: "invalid-semantic-stamp" },
      { status: "unavailable", reason: "not-single-pane-window" },
    ]);
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

describe("application-shell all-window discovery", () => {
  const context = "$4\tproduct\t/repo/product";
  const baseRow =
    "$4\tproduct\t%7\t@1\tpane.valid\t0\tTerminal\tzsh\t1\t1\t1\t\t\t\tapplication-shell-v1";

  function mockedDiscovery(
    paneRows: string | Error,
    options: { readonly context?: string; readonly afterSessionId?: string } = {},
  ): () => void {
    return _setTmuxRunner((args) => {
      if (args[0] === "list-sessions") return "product\nproduct-other";
      if (args[0] === "display-message" && args.at(-1)!.includes("pane_current_path")) {
        return options.context ?? context;
      }
      if (args[0] === "list-panes") {
        if (paneRows instanceof Error) throw paneRows;
        return paneRows;
      }
      if (args[0] === "display-message") return options.afterSessionId ?? "$4";
      return "";
    });
  }

  it("uses exact all-window discovery and preserves a genuinely empty result", () => {
    const calls: string[][] = [];
    restorers.push(
      _setTmuxRunner((args) => {
        calls.push(args);
        if (args[0] === "list-sessions") return "product\nproduct-other";
        if (args[0] === "display-message" && args.at(-1)!.includes("pane_current_path")) {
          return context;
        }
        if (args[0] === "list-panes") return "";
        if (args[0] === "display-message") return "$4";
        return "";
      }),
    );
    expect(discoverApplicationShellSession("product")).toEqual({
      name: "product",
      runtimeSessionId: "$4",
      dir: "/repo/product",
      panes: [],
    });
    expect(calls.some((args) => args.join("\0").includes("list-panes\0-s\0-t\0=product"))).toBe(
      true,
    );
  });

  it("fails the whole snapshot for malformed, duplicate, cross-session, or failed rows", () => {
    const cases: Array<string | Error> = [
      `${baseRow}\n${baseRow}`,
      baseRow.replace("\tproduct\t", "\tother\t"),
      baseRow.replace("\tTerminal\t", "\tbad\\qtitle\t"),
      baseRow.replace("\tTerminal\t", "\tbad\\12title\t"),
      baseRow.replace("\tTerminal\t", '\t"unterminated\t'),
      baseRow.replace("\tTerminal\t", "\ttruncated\\\t"),
      new Error("tmux failed"),
    ];
    for (const rows of cases) {
      const restore = mockedDiscovery(rows);
      expect(() => discoverApplicationShellSession("product")).toThrow(
        ApplicationShellDiscoveryError,
      );
      restore();
    }
  });

  it("rejects control-bearing or oversized cwd facts and session-generation races", () => {
    const cases = [
      { context: '$4\tproduct\t"/repo\\nprivate"' },
      { context: `$4\tproduct\t${"a".repeat(17_000)}` },
      { afterSessionId: "$5" },
    ];
    for (const options of cases) {
      const restore = mockedDiscovery(baseRow, options);
      expect(() => discoverApplicationShellSession("product")).toThrow(
        ApplicationShellDiscoveryError,
      );
      restore();
    }
  });
});

describe("GET /api/project/:name/application-shell", () => {
  it("returns all-window browser-safe resources and keeps auth/CORS middleware", async () => {
    restorers.push(
      _setTmuxRunner((args) => {
        if (args[0] === "list-sessions") return "product";
        if (args[0] === "display-message" && args.at(-1)!.includes("pane_current_path")) {
          return "$4\tproduct\t/repo/product";
        }
        if (args[0] === "list-panes") {
          expect(args.join("\0")).toContain("list-panes\0-s\0-t\0=product");
          return [
            "$4\tproduct\t%7\t@1\tpane.implementer\t0\tImplementer\tcodex\t1\t1\t1\tteammate\tCodex\tagent\tapplication-shell-v1",
            "$4\tproduct\t%9\t@2\t\t0\tShell\tzsh\t0\t1\t1\t\t\t\tapplication-shell-v1",
          ].join("\n");
        }
        if (args[0] === "display-message") return "$4";
        return "";
      }),
    );
    const app = createApp({
      remoteAccess: { bindHostname: "0.0.0.0", token: "secret" },
      daemonIdentity: {
        productVersion: "2.8.0",
        instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
        startedAt: "2026-07-21T00:00:00.000Z",
      },
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
    const body = ApplicationShellResourceV1SchemaZ.parse(await response.json());
    expect(body.daemon.instanceId).toBe("9bcf33b0-c837-4a94-b5e8-c0977f54464f");
    expect(body.resource.workspace.sidebar.agents[0]).toEqual(
      expect.objectContaining({ name: "Codex", paneId: "pane.implementer" }),
    );
    expect(body.resource.terminalInventory!.resources).toHaveLength(2);
    expect(body.resource.terminalInventory!.resources[1]).toEqual(
      expect.objectContaining({
        title: "Shell",
        kind: "terminal",
        attachability: { status: "unavailable", reason: "missing-semantic-stamp" },
      }),
    );
    expect(JSON.stringify(body)).not.toMatch(/%[79]/u);
  });

  it("returns the established 404 envelope for an unknown session", async () => {
    restorers.push(_setTmuxRunner(() => ""));
    const response = await createApp().request("/api/project/missing/application-shell");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("distinguishes failed tmux discovery from an empty session", async () => {
    restorers.push(
      _setTmuxRunner(() => {
        throw new Error("tmux unavailable");
      }),
    );
    const response = await createApp().request("/api/project/product/application-shell");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Session discovery unavailable" });
  });
});
