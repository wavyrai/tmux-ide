import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WorkspaceMultiplexerAuthority,
  WorkspaceMultiplexerError,
} from "../workspace-multiplexer-verbs.ts";
import { WorkspaceRegistry } from "../workspace-registry.ts";

/**
 * Every multiplexer verb against real tmux on an isolated socket.
 *
 * The unit suite proves the decisions; this proves the argv. A verb can pass
 * every fake-backed assertion and still build a target string tmux reads
 * differently — `-t` resolution, format expansion in a renamed window, and
 * whether `kill-pane` on a window's last pane takes the window with it are all
 * facts about tmux, not about this code, and the only way to know them is to
 * ask tmux.
 */
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `tmux-ide-mux-verbs-${process.pid}-${randomUUID().slice(0, 8)}`;
const DAEMON_ID = "30000000-0000-4000-8000-000000000003";

describe.skipIf(!hasTmux)("multiplexer verbs against live tmux", () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

  const root = mkdtempSync(join(tmpdir(), "tmux-ide-mux-verbs-live-"));
  let sessionName: string;
  let editorWindow: string;
  let shellWindow: string;
  let registry: WorkspaceRegistry;
  let authority: WorkspaceMultiplexerAuthority;

  function tmux(args: readonly string[]): string {
    return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");
  }

  /** A pane that outlives the test rather than exiting mid-assertion. */
  const HOLD = "exec sleep 2147483647";

  function stampPane(target: string, semanticPaneId: string): void {
    tmux(["set-option", "-p", "-t", target, "@tmux_ide_pane_id", semanticPaneId]);
  }

  beforeEach(() => {
    sessionName = `zz-mux-${randomUUID().slice(0, 8)}`;
    tmux(["new-session", "-d", "-s", sessionName, "-n", "editor", HOLD]);
    stampPane(`=${sessionName}:editor.0`, "pane.editor");
    tmux(["set-option", "-w", "-t", `=${sessionName}:editor`, "@tmux_ide_window_id", "win.editor"]);
    tmux(["new-window", "-d", "-t", `=${sessionName}:`, "-n", "shell", HOLD]);
    stampPane(`=${sessionName}:shell.0`, "pane.shell");
    tmux(["set-option", "-w", "-t", `=${sessionName}:shell`, "@tmux_ide_window_id", "win.shell"]);
    // Hold the runtime ids: a rename moves the name-based target out from under
    // any assertion that still uses it.
    [editorWindow, shellWindow] = tmux([
      "list-windows",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{window_id}",
    ]).split("\n") as [string, string];

    registry = new WorkspaceRegistry({
      dir: join(root, sessionName),
      listSessions: () => [sessionName],
    });
    registry.add({ name: "live", sessionName, projectDir: root });
    authority = new WorkspaceMultiplexerAuthority({
      daemonInstanceId: DAEMON_ID,
      registry,
      io: {
        runTmux: tmux,
        canonicalProjectDir: () => root,
        isMissingTmuxTarget: (error) =>
          /can't find session|no server running/iu.test(String(error)),
      },
    });
    const [editorPane, shellPane] = tmux([
      "list-panes",
      "-s",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{pane_id}\t#{window_id}\t#{@tmux_ide_pane_id}",
    ]).split("\n");
    authority.adoptPaneInventory(
      [editorPane, shellPane].map((row) => {
        const [runtimePaneId, windowId, semanticPaneId] = row!.split("\t");
        return {
          sessionName,
          runtimePaneId: runtimePaneId!,
          windowId: windowId!,
          semanticPaneId: semanticPaneId!,
        };
      }),
    );
  });

  afterEach(() => {
    spawnSync("tmux", ["-L", socketName, "kill-session", "-t", `=${sessionName}`], {
      stdio: "ignore",
    });
  });

  afterAll(() => {
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  const mutate = async (intent: Record<string, unknown>, operationId = randomUUID()) =>
    authority.mutate({
      operationId,
      expectedDaemonInstanceId: DAEMON_ID,
      intent: { workspaceName: "live", ...intent } as never,
    });

  const panesOf = (window: string): string[] =>
    tmux(["list-panes", "-t", `=${sessionName}:${window}`, "-F", "#{pane_id}"]).split("\n");

  const windowNames = (): string[] =>
    tmux(["list-windows", "-t", `=${sessionName}`, "-F", "#{window_name}"]).split("\n");

  it("splits a window right and the new pane carries a working stamp", async () => {
    tmux(["set-environment", "-g", "NO_COLOR", "1"]);
    tmux(["set-environment", "-t", `=${sessionName}`, "NO_COLOR", "1"]);
    const before = panesOf("editor");
    const result = (await mutate({
      verb: "workspace.window.split",
      semanticPaneId: "pane.editor",
      direction: "right",
      displayTitle: "Logs",
    })) as { semanticPaneId: string };

    const after = panesOf("editor");
    expect(after).toHaveLength(before.length + 1);
    const created = after.find((pane) => !before.includes(pane))!;

    // The stamp is real and the pane answers to it: reading the option back
    // through tmux is what proves the split pane is addressable like any other.
    expect(tmux(["display-message", "-p", "-t", created, "#{@tmux_ide_pane_id}"])).toBe(
      result.semanticPaneId,
    );
    expect(tmux(["display-message", "-p", "-t", created, "#{@ide_name}"])).toBe("Logs");
    expect(tmux(["display-message", "-p", "-t", created, "#{@ide_type}"])).toBe("shell");
    expect(tmux(["show-environment", "-t", `=${sessionName}`, "COLORTERM"])).toBe(
      "COLORTERM=truecolor",
    );
    expect(tmux(["show-environment", "-t", `=${sessionName}`, "NO_COLOR"])).toBe("-NO_COLOR");

    // Right means side by side: same row, different column.
    const [sourceTop, createdTop] = [before[0]!, created].map((pane) =>
      tmux(["display-message", "-p", "-t", pane, "#{pane_top}"]),
    );
    expect(sourceTop).toBe(createdTop);
  });

  it("splits down, stacking the new pane below its source", async () => {
    const before = panesOf("editor");
    await mutate({
      verb: "workspace.window.split",
      semanticPaneId: "pane.editor",
      direction: "down",
    });
    const created = panesOf("editor").find((pane) => !before.includes(pane))!;
    expect(Number(tmux(["display-message", "-p", "-t", created, "#{pane_top}"]))).toBeGreaterThan(
      Number(tmux(["display-message", "-p", "-t", before[0]!, "#{pane_top}"])),
    );
  });

  it("kills a window named by its durable stamp", async () => {
    const result = await mutate({
      verb: "workspace.window.kill",
      target: { by: "window", semanticWindowId: "win.shell" },
    });
    expect(result).toMatchObject({ outcome: "applied", remainingWindowCount: 1 });
    expect(windowNames()).toEqual(["editor"]);
  });

  it("refuses the last window and leaves the session alive", async () => {
    await mutate({
      verb: "workspace.window.kill",
      target: { by: "window", semanticWindowId: "win.shell" },
    });
    const error = await mutate({
      verb: "workspace.window.kill",
      target: { by: "pane", semanticPaneId: "pane.editor" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceMultiplexerError);
    expect((error as WorkspaceMultiplexerError).code).toBe("last_window_refused");
    // The refusal is only worth anything if the session survived it.
    expect(tmux(["has-session", "-t", `=${sessionName}`])).toBe("");
    expect(windowNames()).toEqual(["editor"]);
  });

  it("kills one pane of a split without taking its window", async () => {
    const result = (await mutate({
      verb: "workspace.window.split",
      semanticPaneId: "pane.editor",
      direction: "right",
    })) as { semanticPaneId: string };
    const killed = await mutate({
      verb: "workspace.pane.kill",
      semanticPaneId: result.semanticPaneId,
    });
    expect(killed).toMatchObject({ windowClosed: false, remainingWindowCount: 2 });
    expect(panesOf("editor")).toHaveLength(1);
  });

  it("refuses the session's last pane rather than letting tmux end the session", async () => {
    await mutate({
      verb: "workspace.window.kill",
      target: { by: "window", semanticWindowId: "win.shell" },
    });
    const error = await mutate({
      verb: "workspace.pane.kill",
      semanticPaneId: "pane.editor",
    }).catch((caught: unknown) => caught);
    expect((error as WorkspaceMultiplexerError).code).toBe("last_pane_refused");
    expect(tmux(["has-session", "-t", `=${sessionName}`])).toBe("");
  });

  it("kills the session when that is the verb that was asked for", async () => {
    const result = await mutate({ verb: "workspace.session.kill" });
    expect(result).toMatchObject({ outcome: "applied" });
    expect(
      spawnSync("tmux", ["-L", socketName, "has-session", "-t", `=${sessionName}`], {
        stdio: "ignore",
      }).status,
    ).not.toBe(0);
  });

  it("renames the session and the registry follows it", async () => {
    const renamed = `zz-mux-renamed-${randomUUID().slice(0, 6)}`;
    await mutate({ verb: "workspace.rename", scope: "session", name: renamed });
    expect(registry.get("live")?.sessionName).toBe(renamed);
    expect(tmux(["has-session", "-t", `=${renamed}`])).toBe("");
    sessionName = renamed;
  });

  it("renames a window without letting tmux expand the new name", async () => {
    // A name full of format syntax is the case that turns a rename into an
    // information leak if the argument is not escaped.
    await mutate({
      verb: "workspace.rename",
      scope: "window",
      target: { by: "pane", semanticPaneId: "pane.shell" },
      name: "#{pane_id} #{session_name}",
    });
    expect(tmux(["display-message", "-p", "-t", shellWindow, "#{window_name}"])).toBe(
      "#{pane_id} #{session_name}",
    );
    // A single-pane window's display title follows the window it names.
    expect(tmux(["display-message", "-p", "-t", shellWindow, "#{@ide_name}"])).toBe(
      "#{pane_id} #{session_name}",
    );
  });

  it("renames one pane without changing its window or leaking a tmux format", async () => {
    const name = "Build #{pane_id} monitor";
    const result = await mutate({
      verb: "workspace.rename",
      scope: "pane",
      semanticPaneId: "pane.editor",
      name,
    });

    expect(result).toMatchObject({ outcome: "applied", scope: "pane", name });
    expect(tmux(["display-message", "-p", "-t", editorWindow, "#{window_name}"])).toBe("editor");
    expect(
      tmux([
        "display-message",
        "-p",
        "-t",
        `=${sessionName}:editor.0`,
        "#{@ide_name}\t#{@tmux_ide_name_source}\t#{pane_title}",
      ]),
    ).toBe(`${name}\tmanual\t${name}`);
  });

  it("resizes a live split and reports the geometry tmux actually settled on", async () => {
    await mutate({
      verb: "workspace.window.split",
      semanticPaneId: "pane.editor",
      direction: "right",
    });
    const before = Number(
      tmux(["display-message", "-p", "-t", `=${sessionName}:editor.0`, "#{pane_width}"]),
    );
    const requested = before + 3;
    const result = await mutate({
      verb: "workspace.pane.resize",
      semanticPaneId: "pane.editor",
      axis: "cols",
      cells: requested,
    });
    const settled = Number(
      tmux(["display-message", "-p", "-t", `=${sessionName}:editor.0`, "#{pane_width}"]),
    );

    expect(result).toMatchObject({
      verb: "workspace.pane.resize",
      outcome: "applied",
      axis: "cols",
      cells: settled,
    });
    expect(settled).toBe(requested);
  });

  it("zooms and unzooms a split window through tmux's own flag", async () => {
    await mutate({
      verb: "workspace.window.split",
      semanticPaneId: "pane.editor",
      direction: "right",
    });
    const zoomed = await mutate({
      verb: "workspace.pane.zoom.toggle",
      semanticPaneId: "pane.editor",
    });
    expect(zoomed).toMatchObject({ zoomed: true, outcome: "applied" });
    expect(tmux(["display-message", "-p", "-t", editorWindow, "#{?window_zoomed_flag,1,0}"])).toBe(
      "1",
    );

    const unzoomed = await mutate({
      verb: "workspace.pane.zoom.toggle",
      semanticPaneId: "pane.editor",
      desired: "unzoomed",
    });
    expect(unzoomed).toMatchObject({ zoomed: false, outcome: "applied" });
    expect(tmux(["display-message", "-p", "-t", editorWindow, "#{?window_zoomed_flag,1,0}"])).toBe(
      "0",
    );
  });

  it("moves tmux's own active window and pane, so an attached client follows", async () => {
    // Start focus somewhere else, then ask for the pane in the other window.
    tmux(["select-window", "-t", editorWindow]);
    expect(tmux(["display-message", "-p", "-t", `=${sessionName}:`, "#{window_name}"])).toBe(
      "editor",
    );

    const result = await mutate({ verb: "workspace.pane.select", semanticPaneId: "pane.shell" });
    expect(result).toMatchObject({ outcome: "applied" });
    // This is the assertion gap 1 is about: tmux's cursor, not the app's.
    expect(tmux(["display-message", "-p", "-t", `=${sessionName}:`, "#{window_name}"])).toBe(
      "shell",
    );
    expect(tmux(["display-message", "-p", "-t", shellWindow, "#{@tmux_ide_pane_id}"])).toBe(
      "pane.shell",
    );

    const again = await mutate({ verb: "workspace.pane.select", semanticPaneId: "pane.shell" });
    expect(again).toMatchObject({ outcome: "unchanged" });
  });

  it("guards a warm native target against a stale or duplicate semantic remap", async () => {
    await mutate({ verb: "workspace.pane.select", semanticPaneId: "pane.shell" });
    await mutate({ verb: "workspace.pane.select", semanticPaneId: "pane.editor" });
    stampPane(`=${sessionName}:editor.0`, "pane.shell");
    await expect(
      mutate({ verb: "workspace.pane.select", semanticPaneId: "pane.shell" }),
    ).rejects.toMatchObject({
      code: "mutation_unverified",
      context: { reason: "pane_identity_changed_before_select" },
    });
    expect(tmux(["display-message", "-p", "-t", `=${sessionName}:`, "#{window_name}"])).toBe(
      "editor",
    );
  });

  it("swaps two panes in one window by semantic identity", async () => {
    const created = (await mutate({
      verb: "workspace.window.split",
      semanticPaneId: "pane.editor",
      direction: "right",
    })) as { semanticPaneId: string };
    const before = new Map(
      tmux([
        "list-panes",
        "-t",
        editorWindow,
        "-F",
        "#{@tmux_ide_pane_id}\t#{pane_id}\t#{pane_index}",
      ])
        .split("\n")
        .map((line) => {
          const [semanticPaneId, paneId, paneIndex] = line.split("\t");
          return [semanticPaneId!, { paneId: paneId!, paneIndex: Number(paneIndex) }] as const;
        }),
    );

    const result = await mutate({
      verb: "workspace.pane.swap",
      sourceSemanticPaneId: "pane.editor",
      targetSemanticPaneId: created.semanticPaneId,
    });
    expect(result).toMatchObject({ verb: "workspace.pane.swap", outcome: "applied" });

    const after = new Map(
      tmux([
        "list-panes",
        "-t",
        editorWindow,
        "-F",
        "#{@tmux_ide_pane_id}\t#{pane_id}\t#{pane_index}",
      ])
        .split("\n")
        .map((line) => {
          const [semanticPaneId, paneId, paneIndex] = line.split("\t");
          return [semanticPaneId!, { paneId: paneId!, paneIndex: Number(paneIndex) }] as const;
        }),
    );
    expect(after.get("pane.editor")?.paneId).toBe(before.get("pane.editor")?.paneId);
    expect(after.get(created.semanticPaneId)?.paneId).toBe(
      before.get(created.semanticPaneId)?.paneId,
    );
    expect(after.get("pane.editor")?.paneIndex).toBe(before.get(created.semanticPaneId)?.paneIndex);
    expect(after.get(created.semanticPaneId)?.paneIndex).toBe(before.get("pane.editor")?.paneIndex);
  });

  it("replays a split rather than creating a second pane for one operation id", async () => {
    const operationId = randomUUID();
    const intent = {
      verb: "workspace.window.split",
      semanticPaneId: "pane.editor",
      direction: "right",
    };
    const first = (await mutate(intent, operationId)) as { semanticPaneId: string };
    const paneCount = panesOf("editor").length;
    const second = (await mutate(intent, operationId)) as {
      semanticPaneId: string;
      outcome: string;
    };
    expect(second.outcome).toBe("replayed");
    expect(second.semanticPaneId).toBe(first.semanticPaneId);
    expect(panesOf("editor")).toHaveLength(paneCount);
  });
});
