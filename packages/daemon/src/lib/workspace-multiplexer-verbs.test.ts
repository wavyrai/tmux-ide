import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseMultiplexerPaneRows,
  resolvePaneRow,
  resolveWindowId,
  windowIdsOf,
  WorkspaceMultiplexerAuthority,
  WorkspaceMultiplexerError,
  type WorkspaceMultiplexerErrorCode,
} from "./workspace-multiplexer-verbs.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";

// ---------------------------------------------------------------------------
// A tmux model just complete enough to answer the queries these verbs make.
//
// The point is not to reimplement tmux — it is that the authority's argv is
// asserted against a model that refuses malformed targets, so a verb that
// builds the wrong command fails here rather than in a live session.
// ---------------------------------------------------------------------------

interface FakePane {
  id: string;
  windowId: string;
  options: Map<string, string>;
  active: boolean;
}

interface FakeWindow {
  id: string;
  name: string;
  zoomed: boolean;
  active: boolean;
  options: Map<string, string>;
}

class FakeTmux {
  sessionName: string;
  alive = true;
  windows: FakeWindow[] = [];
  panes: FakePane[] = [];
  readonly calls: string[][] = [];
  #nextPane = 0;
  #nextWindow = 0;
  /** Argv prefix → thrown error, for failure-path tests. */
  failOn: { match: (args: readonly string[]) => boolean; error: Error } | null = null;

  constructor(sessionName: string) {
    this.sessionName = sessionName;
  }

  addWindow(name: string, paneCount = 1): FakeWindow {
    const window: FakeWindow = {
      id: `@${this.#nextWindow++}`,
      name,
      zoomed: false,
      active: this.windows.length === 0,
      options: new Map(),
    };
    this.windows.push(window);
    for (let index = 0; index < paneCount; index += 1) this.addPane(window.id);
    return window;
  }

  addPane(windowId: string, stamp?: string): FakePane {
    const pane: FakePane = {
      id: `%${this.#nextPane++}`,
      windowId,
      options: new Map(),
      active: !this.panes.some((p) => p.windowId === windowId),
    };
    if (stamp) pane.options.set("@tmux_ide_pane_id", stamp);
    this.panes.push(pane);
    return pane;
  }

  #pane(target: string): FakePane {
    const pane = this.panes.find((p) => p.id === target);
    if (!pane) throw new Error(`no such pane: ${target}`);
    return pane;
  }

  #window(target: string): FakeWindow {
    const window = this.windows.find((w) => w.id === target);
    if (!window) throw new Error(`no such window: ${target}`);
    return window;
  }

  /** Resolve `#{...}` fields for a pane, mirroring tmux's option inheritance. */
  #format(field: string, pane: FakePane): string {
    const window = this.#window(pane.windowId);
    const paneCount = this.panes.filter((p) => p.windowId === pane.windowId).length;
    switch (field) {
      case "#{pane_id}":
        return pane.id;
      case "#{window_id}":
        return pane.windowId;
      case "#{window_name}":
        return window.name;
      case "#{window_panes}":
        return String(paneCount);
      case "#{?window_zoomed_flag,1,0}":
        return window.zoomed ? "1" : "0";
      case "#{?pane_active,1,0}":
        return pane.active ? "1" : "0";
      case "#{?window_active,1,0}":
        return window.active ? "1" : "0";
      case "#{session_name}":
        return this.sessionName;
      default: {
        const option = /^#\{(@[a-z_]+)\}$/u.exec(field)?.[1];
        if (!option) throw new Error(`unsupported format: ${field}`);
        return pane.options.get(option) ?? window.options.get(option) ?? "";
      }
    }
  }

  run = (args: readonly string[]): string => {
    this.calls.push([...args]);
    if (this.failOn?.match(args)) throw this.failOn.error;
    const [command] = args;
    switch (command) {
      case "has-session": {
        if (!this.alive || args[2] !== `=${this.sessionName}`) throw new Error("no such session");
        return "";
      }
      case "kill-session": {
        if (!this.alive || args[2] !== `=${this.sessionName}`) throw new Error("no such session");
        this.alive = false;
        this.windows = [];
        this.panes = [];
        return "";
      }
      case "rename-session": {
        if (args[2] !== `=${this.sessionName}`) throw new Error("no such session");
        this.sessionName = args[3]!.replaceAll("##", "#");
        return "";
      }
      case "rename-window": {
        this.#window(args[2]!).name = args[3]!.replaceAll("##", "#");
        return "";
      }
      case "list-panes": {
        if (args[1] !== "-s" || args[2] !== "-t" || args[3] !== `=${this.sessionName}`) {
          throw new Error("unsupported list-panes");
        }
        const fields = args[5]!.split("\t");
        return this.panes
          .map((pane) => fields.map((field) => this.#format(field, pane)).join("\t"))
          .join("\n");
      }
      case "display-message": {
        const pane =
          this.panes.find((p) => p.id === args[3]) ??
          this.panes.find((p) => p.windowId === args[3]) ??
          (args[3] === `=${this.sessionName}` ? this.panes[0] : undefined);
        if (!pane) throw new Error(`no such target: ${args[3]}`);
        return args[4]!
          .split("\t")
          .map((field) => this.#format(field, pane))
          .join("\t");
      }
      case "set-option": {
        if (args[1] !== "-p") throw new Error("unsupported set-option");
        this.#pane(args[3]!).options.set(args[4]!, args[5]!);
        return "";
      }
      case "split-window": {
        const source = this.#pane(args[7]!);
        const pane = this.addPane(source.windowId);
        return `${pane.id}\t${source.windowId}`;
      }
      case "kill-window": {
        const window = this.#window(args[2]!);
        this.windows = this.windows.filter((w) => w.id !== window.id);
        this.panes = this.panes.filter((p) => p.windowId !== window.id);
        return "";
      }
      case "kill-pane": {
        const pane = this.#pane(args[2]!);
        this.panes = this.panes.filter((p) => p.id !== pane.id);
        if (!this.panes.some((p) => p.windowId === pane.windowId)) {
          this.windows = this.windows.filter((w) => w.id !== pane.windowId);
        }
        return "";
      }
      case "resize-pane": {
        const window = this.#window(this.#pane(args[3]!).windowId);
        window.zoomed = !window.zoomed;
        return "";
      }
      case "select-window": {
        for (const window of this.windows) window.active = window.id === args[2];
        return "";
      }
      case "select-pane": {
        const pane = this.#pane(args[2]!);
        for (const other of this.panes) {
          if (other.windowId === pane.windowId) other.active = other.id === pane.id;
        }
        return "";
      }
      default:
        throw new Error(`unsupported tmux command: ${command}`);
    }
  };
}

const DAEMON_ID = "11111111-1111-4111-8111-111111111111";

async function expectRefusal(
  promise: Promise<unknown>,
  code: WorkspaceMultiplexerErrorCode,
): Promise<WorkspaceMultiplexerError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceMultiplexerError);
  expect((error as WorkspaceMultiplexerError).code).toBe(code);
  return error as WorkspaceMultiplexerError;
}

describe("pane listing parsing", () => {
  it("reads one well-formed row", () => {
    const rows = parseMultiplexerPaneRows("%1\t@2\tpane.abc\twin.def\t3\t1\t0\top-1");
    expect(rows).toEqual([
      {
        paneId: "%1",
        windowId: "@2",
        semanticPaneId: "pane.abc",
        semanticWindowId: "win.def",
        windowPaneCount: 3,
        windowZoomed: true,
        paneActive: false,
        creationId: "op-1",
      },
    ]);
  });

  it("reads an empty listing as no panes rather than as one blank pane", () => {
    expect(parseMultiplexerPaneRows("")).toEqual([]);
  });

  it("reads absent stamps as null, not as empty strings", () => {
    const [row] = parseMultiplexerPaneRows("%1\t@2\t\t\t1\t0\t1\t");
    expect(row).toMatchObject({
      semanticPaneId: null,
      semanticWindowId: null,
      creationId: null,
      paneActive: true,
    });
  });

  it("refuses a listing whose shape no longer matches", () => {
    expect(() => parseMultiplexerPaneRows("%1\t@2\tpane.abc")).toThrow(WorkspaceMultiplexerError);
    expect(() => parseMultiplexerPaneRows("nope\t@2\ta\tb\t1\t0\t0\t")).toThrow(
      WorkspaceMultiplexerError,
    );
  });
});

describe("semantic target resolution", () => {
  const rows = parseMultiplexerPaneRows(
    ["%1\t@1\tpane.a\twin.1\t2\t0\t1\t", "%2\t@1\tpane.b\twin.1\t2\t0\t0\t"].join("\n"),
  );

  it("resolves a pane by its stamp", () => {
    expect(resolvePaneRow(rows, "pane.b").paneId).toBe("%2");
  });

  it("refuses an unknown stamp", () => {
    expect(() => resolvePaneRow(rows, "pane.z")).toThrow(/semantic identity/u);
  });

  it("refuses a duplicated stamp rather than guessing which pane was meant", () => {
    const duplicated = parseMultiplexerPaneRows(
      ["%1\t@1\tpane.a\twin.1\t1\t0\t1\t", "%2\t@2\tpane.a\twin.2\t1\t0\t0\t"].join("\n"),
    );
    const error = (() => {
      try {
        resolvePaneRow(duplicated, "pane.a");
        return null;
      } catch (caught) {
        return caught as WorkspaceMultiplexerError;
      }
    })();
    expect(error?.code).toBe("ambiguous_target");
  });

  it("names a window either by its own stamp or by a pane inside it", () => {
    expect(resolveWindowId(rows, { by: "window", semanticWindowId: "win.1" })).toBe("@1");
    expect(resolveWindowId(rows, { by: "pane", semanticPaneId: "pane.b" })).toBe("@1");
  });

  it("counts distinct windows once each", () => {
    expect(windowIdsOf(rows)).toEqual(["@1"]);
  });
});

describe("the multiplexer authority", () => {
  let dir: string;
  let registry: WorkspaceRegistry;
  let tmux: FakeTmux;
  let authority: WorkspaceMultiplexerAuthority;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mux-verbs-"));
    registry = new WorkspaceRegistry({ dir, listSessions: () => ["work"] });
    registry.add({ name: "work", sessionName: "work", projectDir: dir });
    tmux = new FakeTmux("work");
    const editor = tmux.addWindow("editor");
    tmux.panes[0]!.options.set("@tmux_ide_pane_id", "pane.one");
    tmux.windows[0]!.options.set("@tmux_ide_window_id", "win.editor");
    const shell = tmux.addWindow("shell");
    tmux.panes[1]!.options.set("@tmux_ide_pane_id", "pane.two");
    tmux.windows[1]!.options.set("@tmux_ide_window_id", "win.shell");
    void editor;
    void shell;
    authority = new WorkspaceMultiplexerAuthority({
      daemonInstanceId: DAEMON_ID,
      registry,
      io: {
        runTmux: tmux.run,
        canonicalProjectDir: (path) => path,
        // The fake raises plain Errors where the bridge raises typed TmuxErrors;
        // this seam is how "the session is simply gone" stays distinguishable
        // from "tmux failed" without the test depending on the bridge.
        isMissingTmuxTarget: (error) => /no such session/u.test(String(error)),
      },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (intent: Record<string, unknown>, operationId = randomUUID()) => ({
    operationId,
    expectedDaemonInstanceId: DAEMON_ID,
    intent: { workspaceName: "work", ...intent } as never,
  });

  it("refuses a request from a different daemon generation", async () => {
    await expectRefusal(
      authority.mutate({
        operationId: randomUUID(),
        expectedDaemonInstanceId: randomUUID(),
        intent: { verb: "workspace.session.kill", workspaceName: "work" },
      }),
      "daemon_instance_mismatch",
    );
  });

  it("refuses an unregistered workspace", async () => {
    await expectRefusal(
      authority.mutate(request({ verb: "workspace.session.kill", workspaceName: "ghost" })),
      "workspace_not_found",
    );
  });

  describe("split", () => {
    it("splits right and stamps the new pane like a created one", async () => {
      const result = await authority.mutate(
        request({
          verb: "workspace.window.split",
          semanticPaneId: "pane.one",
          direction: "right",
        }),
      );
      expect(result).toMatchObject({ verb: "workspace.window.split", outcome: "applied" });
      const split = tmux.calls.find((args) => args[0] === "split-window")!;
      expect(split).toEqual([
        "split-window",
        "-h",
        "-d",
        "-P",
        "-F",
        "#{pane_id}\t#{window_id}",
        "-t",
        "%0",
        "-c",
        dir,
      ]);
      const created = tmux.panes.find((pane) => pane.id === "%2")!;
      expect(created.windowId).toBe("@0");
      expect(created.options.get("@tmux_ide_pane_id")).toBe(
        (result as { semanticPaneId: string }).semanticPaneId,
      );
      expect(created.options.get("@ide_type")).toBe("shell");
      expect(created.options.get("@ide_name")).toBe("Terminal");
    });

    it("splits down with the vertical flag", async () => {
      await authority.mutate(
        request({
          verb: "workspace.window.split",
          semanticPaneId: "pane.one",
          direction: "down",
          displayTitle: "Logs",
        }),
      );
      expect(tmux.calls.find((args) => args[0] === "split-window")![1]).toBe("-v");
      expect(tmux.panes.find((pane) => pane.id === "%2")!.options.get("@ide_name")).toBe("Logs");
    });

    it("kills the pane it made when stamping cannot be verified", async () => {
      tmux.failOn = {
        match: (args) => args[0] === "set-option" && args[4] === "@ide_type",
        error: new Error("option refused"),
      };
      await expectRefusal(
        authority.mutate(
          request({
            verb: "workspace.window.split",
            semanticPaneId: "pane.one",
            direction: "right",
          }),
        ),
        "mutation_failed",
      );
      // The half-built pane must not survive the failure.
      expect(tmux.panes.some((pane) => pane.id === "%2")).toBe(false);
    });

    it("does not split twice for a repeated operation id", async () => {
      const operationId = randomUUID();
      const intent = {
        verb: "workspace.window.split",
        semanticPaneId: "pane.one",
        direction: "right",
      };
      const first = await authority.mutate(request(intent, operationId));
      const paneCount = tmux.panes.length;
      const second = await authority.mutate(request(intent, operationId));
      expect(second).toMatchObject({ outcome: "replayed" });
      expect((second as { semanticPaneId: string }).semanticPaneId).toBe(
        (first as { semanticPaneId: string }).semanticPaneId,
      );
      expect(tmux.panes.length).toBe(paneCount);
    });

    it("refuses to reuse an operation id for a different intent", async () => {
      const operationId = randomUUID();
      await authority.mutate(
        request(
          { verb: "workspace.window.split", semanticPaneId: "pane.one", direction: "right" },
          operationId,
        ),
      );
      await expectRefusal(
        authority.mutate(
          request(
            { verb: "workspace.window.split", semanticPaneId: "pane.one", direction: "down" },
            operationId,
          ),
        ),
        "operation_conflict",
      );
    });
  });

  describe("kill", () => {
    it("kills a window and reports what is left", async () => {
      const result = await authority.mutate(
        request({
          verb: "workspace.window.kill",
          target: { by: "window", semanticWindowId: "win.shell" },
        }),
      );
      expect(result).toMatchObject({ outcome: "applied", remainingWindowCount: 1 });
      expect(tmux.windows.map((window) => window.name)).toEqual(["editor"]);
    });

    it("refuses to kill the session's last window", async () => {
      await authority.mutate(
        request({
          verb: "workspace.window.kill",
          target: { by: "window", semanticWindowId: "win.shell" },
        }),
      );
      const error = await expectRefusal(
        authority.mutate(
          request({
            verb: "workspace.window.kill",
            target: { by: "window", semanticWindowId: "win.editor" },
          }),
        ),
        "last_window_refused",
      );
      expect(error.message).toMatch(/Close the session instead/u);
      expect(tmux.windows).toHaveLength(1);
    });

    it("kills a pane and says when that closed its window too", async () => {
      const result = await authority.mutate(
        request({ verb: "workspace.pane.kill", semanticPaneId: "pane.two" }),
      );
      expect(result).toMatchObject({ windowClosed: true, remainingWindowCount: 1 });
    });

    it("kills one pane of a split without closing the window", async () => {
      tmux.addPane("@1").options.set("@tmux_ide_pane_id", "pane.three");
      const result = await authority.mutate(
        request({ verb: "workspace.pane.kill", semanticPaneId: "pane.three" }),
      );
      expect(result).toMatchObject({ windowClosed: false, remainingWindowCount: 2 });
      expect(tmux.windows).toHaveLength(2);
    });

    it("refuses the last pane of the last window instead of ending the session", async () => {
      await authority.mutate(
        request({
          verb: "workspace.window.kill",
          target: { by: "window", semanticWindowId: "win.shell" },
        }),
      );
      await expectRefusal(
        authority.mutate(request({ verb: "workspace.pane.kill", semanticPaneId: "pane.one" })),
        "last_pane_refused",
      );
      expect(tmux.sessionName).toBe("work");
      expect(tmux.panes).toHaveLength(1);
    });

    it("kills the session when that is what was actually asked for", async () => {
      const result = await authority.mutate(request({ verb: "workspace.session.kill" }));
      expect(result).toMatchObject({ verb: "workspace.session.kill", outcome: "applied" });
      expect(tmux.alive).toBe(false);
    });

    it("reports an already-dead session as unchanged rather than claiming the kill", async () => {
      tmux.alive = false;
      const result = await authority.mutate(request({ verb: "workspace.session.kill" }));
      expect(result).toMatchObject({ outcome: "unchanged" });
    });
  });

  describe("rename", () => {
    it("renames the session and moves the registry with it", async () => {
      const result = await authority.mutate(
        request({ verb: "workspace.rename", scope: "session", name: "rebuilt" }),
      );
      expect(result).toMatchObject({ outcome: "applied", scope: "session", name: "rebuilt" });
      expect(tmux.sessionName).toBe("rebuilt");
      // The workspace name is identity and never moves; only the session does.
      expect(registry.get("work")?.sessionName).toBe("rebuilt");
    });

    it("renames a window and follows the display title of its only pane", async () => {
      await authority.mutate(
        request({
          verb: "workspace.rename",
          scope: "window",
          target: { by: "pane", semanticPaneId: "pane.one" },
          name: "Notes",
        }),
      );
      expect(tmux.windows[0]!.name).toBe("Notes");
      expect(tmux.panes[0]!.options.get("@ide_name")).toBe("Notes");
    });

    it("leaves per-pane titles alone when the window is split", async () => {
      const extra = tmux.addPane("@0");
      extra.options.set("@tmux_ide_pane_id", "pane.extra");
      extra.options.set("@ide_name", "Server");
      await authority.mutate(
        request({
          verb: "workspace.rename",
          scope: "window",
          target: { by: "window", semanticWindowId: "win.editor" },
          name: "Work",
        }),
      );
      expect(tmux.windows[0]!.name).toBe("Work");
      expect(extra.options.get("@ide_name")).toBe("Server");
    });

    it("escapes a name tmux would otherwise format-expand", async () => {
      await authority.mutate(
        request({
          verb: "workspace.rename",
          scope: "window",
          target: { by: "pane", semanticPaneId: "pane.one" },
          name: "#{pane_id}",
        }),
      );
      const rename = tmux.calls.find((args) => args[0] === "rename-window")!;
      expect(rename[3]).toBe("##{pane_id}");
      expect(tmux.windows[0]!.name).toBe("#{pane_id}");
    });

    it("reports an unchanged session rename without touching tmux", async () => {
      const result = await authority.mutate(
        request({ verb: "workspace.rename", scope: "session", name: "work" }),
      );
      expect(result).toMatchObject({ outcome: "unchanged" });
      expect(tmux.calls.some((args) => args[0] === "rename-session")).toBe(false);
    });
  });

  describe("zoom and select", () => {
    it("zooms and unzooms with the toggle", async () => {
      const zoomed = await authority.mutate(
        request({ verb: "workspace.pane.zoom.toggle", semanticPaneId: "pane.one" }),
      );
      expect(zoomed).toMatchObject({ outcome: "applied", zoomed: true });
      const unzoomed = await authority.mutate(
        request({ verb: "workspace.pane.zoom.toggle", semanticPaneId: "pane.one" }),
      );
      expect(unzoomed).toMatchObject({ outcome: "applied", zoomed: false });
    });

    it("is idempotent when an absolute zoom state is requested twice", async () => {
      const first = await authority.mutate(
        request({
          verb: "workspace.pane.zoom.toggle",
          semanticPaneId: "pane.one",
          desired: "zoomed",
        }),
      );
      const second = await authority.mutate(
        request({
          verb: "workspace.pane.zoom.toggle",
          semanticPaneId: "pane.one",
          desired: "zoomed",
        }),
      );
      expect(first).toMatchObject({ outcome: "applied", zoomed: true });
      expect(second).toMatchObject({ outcome: "unchanged", zoomed: true });
      expect(tmux.windows[0]!.zoomed).toBe(true);
    });

    it("selects the window as well as the pane so an attached client follows", async () => {
      const result = await authority.mutate(
        request({ verb: "workspace.pane.select", semanticPaneId: "pane.two" }),
      );
      expect(result).toMatchObject({ outcome: "applied" });
      // Both halves ran, and in the order that leaves the pane active.
      const verbs = tmux.calls.map((args) => args[0]);
      expect(verbs.indexOf("select-window")).toBeLessThan(verbs.indexOf("select-pane"));
      expect(tmux.windows.find((window) => window.id === "@1")!.active).toBe(true);
      expect(tmux.panes.find((pane) => pane.id === "%1")!.active).toBe(true);
    });

    it("reports selecting the already-focused pane as unchanged", async () => {
      const result = await authority.mutate(
        request({ verb: "workspace.pane.select", semanticPaneId: "pane.one" }),
      );
      expect(result).toMatchObject({ outcome: "unchanged" });
    });

    it("refuses a pane that no longer carries the requested stamp", async () => {
      tmux.panes[0]!.options.delete("@tmux_ide_pane_id");
      await expectRefusal(
        authority.mutate(request({ verb: "workspace.pane.select", semanticPaneId: "pane.one" })),
        "pane_not_found",
      );
    });
  });

  it("replays a remembered refusal instead of re-running it", async () => {
    const operationId = randomUUID();
    const intent = { verb: "workspace.pane.select", semanticPaneId: "pane.absent" };
    await expectRefusal(authority.mutate(request(intent, operationId)), "pane_not_found");
    const callCount = tmux.calls.length;
    await expectRefusal(authority.mutate(request(intent, operationId)), "pane_not_found");
    expect(tmux.calls.length).toBe(callCount);
  });

  it("stops admitting verbs once disposed", async () => {
    await authority.dispose();
    await expectRefusal(
      authority.mutate(request({ verb: "workspace.session.kill" })),
      "workspace_unavailable",
    );
  });
});
