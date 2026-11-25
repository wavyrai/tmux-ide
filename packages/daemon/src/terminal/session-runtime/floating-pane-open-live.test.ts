/**
 * #882: a session that holds a floating pane (tmux 3.7+) or a modal pane
 * (tmux 3.8) must still open. The pane is listed but not placed: the tiled
 * layout stays exact, and the inventory the app opens from attaches the tiled
 * panes only.
 *
 * Runs against `tmux` on PATH and, when set, TMUX_IDE_BOUNDARY_TEST_BINARY
 * (tmux-ide's bundled build). A case runs only on a tmux that accepts its
 * `new-pane` flags. Each case owns a private `-S` socket.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { projectTerminalRuntimeInventoryV2 } from "../../command-center/resources/terminal-runtime-inventory.ts";
import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { WorkspaceTerminalInventoryRuntime } from "../attachments/native-runtime.ts";
import type { MirrorLayoutEvent } from "../mirror/events.ts";
import { SessionRuntimeRegistry } from "./registry.ts";

const onPath = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
const binaries = [
  ...new Set([onPath, process.env.TMUX_IDE_BOUNDARY_TEST_BINARY ?? ""].filter(Boolean)),
];

/** Whether this tmux accepts the flags; probed on a throwaway server. */
function supports(executable: string, flags: readonly string[]): boolean {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ti-float-probe-"));
  const socket = join(root, "tmux.sock");
  const run = (...args: string[]) =>
    spawnSync(executable, ["-S", socket, "-f", "/dev/null", ...args], {
      env: { HOME: root, PATH: "/usr/bin:/bin", TMUX: "" },
      encoding: "utf8",
    });
  try {
    if (run("new-session", "-d", "-s", "p", "exec sleep 30").status !== 0) return false;
    return run("new-pane", "-d", "-t", "p", ...flags, "exec sleep 30").status === 0;
  } finally {
    run("kill-server");
    rmSync(root, { recursive: true, force: true });
  }
}

// The bundled build has floating panes but no modal ones; stock 3.8 has both.
const cases = binaries
  .flatMap((executable) => [
    { executable, kind: "floating", flags: ["-x", "40", "-y", "10", "-X", "10", "-Y", "5"] },
    { executable, kind: "modal", flags: ["-O", "-x", "50", "-y", "10"] },
  ])
  .filter(({ executable, flags }) => supports(executable, flags));

if (cases.length === 0) it.skip("needs a tmux with floating panes (3.7 or later)", () => undefined);

it.for(cases)(
  "opens a session holding a $kind pane through MirrorService and the inventory ($executable)",
  async ({ executable, flags }) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ti-float-open-"));
    const socket = join(root, "tmux.sock");
    const env = { HOME: root, PATH: "/usr/bin:/bin", TMUX: "" };
    const run = (...args: string[]) =>
      execFileSync(executable, ["-S", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
      }).trim();
    let runtime: SessionRuntimeRegistry | undefined;
    let inventory: WorkspaceTerminalInventoryRuntime | undefined;
    let serverPid: number | undefined;
    try {
      run("new-session", "-d", "-s", "f", "-x", "120", "-y", "40", "exec sleep 300");
      serverPid = Number(run("display-message", "-p", "-t", "f", "#{pid}"));
      run("split-window", "-d", "-h", "-t", "f:0", "exec sleep 300");
      run("new-pane", "-d", "-t", "f:0", ...flags, "exec sleep 300");
      const panes = run("list-panes", "-t", "f:0", "-F", "#{pane_id} #{pane_floating_flag}")
        .split("\n")
        .map((line) => line.split(" "));
      expect(panes.map(([, floating]) => floating)).toEqual(["0", "0", "1"]);
      run("set-option", "-w", "-t", "f:0", "@tmux_ide_window_id", "window.f");
      for (const [index, [id]] of panes.entries())
        run("set-option", "-p", "-t", id!, "@tmux_ide_pane_id", `pane.f${index}`);

      const workspaces = new WorkspaceRegistry({
        dir: join(root, "registry"),
        listSessions: () => ["f"],
      });
      workspaces.add({ name: "f", sessionName: "f", projectDir: root });
      runtime = new SessionRuntimeRegistry({
        generation: randomUUID(),
        mirror: { executable, socketPath: socket },
      });
      inventory = new WorkspaceTerminalInventoryRuntime({
        readCommandExecutor: (file, argv, options) =>
          new Promise((resolve, reject) => {
            execFile(
              file,
              [...argv],
              {
                cwd: options.cwd,
                env: options.env,
                maxBuffer: options.maxBuffer,
                timeout: options.timeoutMs,
                signal: options.signal,
                encoding: "utf8",
              },
              (error, stdout) => (error ? reject(error) : resolve(stdout)),
            );
          }),
        registry: workspaces,
        sessionRuntimeRegistry: runtime,
        tmuxAuthority: {
          executablePath: executable,
          socketSelector: { kind: "path", path: socket },
          trustedCwd: root,
        },
      });
      await inventory.whenReady();

      // The inventory resource the app opens from: the tiled panes attach.
      // The first read lists panes from tmux; once the session is qualified,
      // the next read comes from the mirror's trusted inventory.
      for (const read of ["tmux list", "trusted mirror"]) {
        const snapshot = await inventory.discoverTerminalRuntimeSession("f");
        expect(snapshot?.catalogIssue ?? null, read).toBeNull();
        const resource = projectTerminalRuntimeInventoryV2(snapshot!, 0);
        expect([...resource.semanticPaneIds].sort(), read).toEqual(["pane.f0", "pane.f1"]);
        expect(resource.windows, read).toEqual([
          { semanticWindowId: "window.f", active: true, semanticPaneIds: ["pane.f0", "pane.f1"] },
        ]);
        expect(runtime.hasProofQualifiedInventory("f"), read).toBe(true);
      }

      // MirrorService: the float is listed, marked floating, and not placed.
      const authority = await runtime.describeSessionAuthority("f");
      expect(
        authority.description.panes
          .map((pane) => [pane.semanticPaneId, pane.floating === true])
          .sort(),
      ).toEqual([
        ["pane.f0", false],
        ["pane.f1", false],
        ["pane.f2", true],
      ]);
      const layouts: MirrorLayoutEvent[] = [];
      const subscription = await runtime.subscribeLayout("f", (event) => layouts.push(event), {
        expectedRuntimeSessionId: authority.runtimeSessionId,
        expectedSemanticPaneIds: ["pane.f0", "pane.f1"],
      });
      try {
        await expect.poll(() => layouts.length).toBeGreaterThan(0);
        // The tiled panes keep tmux's own rectangles; the float has none.
        const tiled = run(
          "list-panes",
          "-t",
          "f:0",
          "-F",
          "#{@tmux_ide_pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_floating_flag}",
        )
          .split("\n")
          .filter((line) => line.endsWith(" 0"))
          .map((line) => line.slice(0, -2))
          .sort();
        const placed = layouts
          .at(-1)!
          .panes.map((pane) =>
            [pane.semanticPaneId, pane.left, pane.top, pane.width, pane.height].join(" "),
          )
          .sort();
        expect(placed).toEqual(tiled);
        expect(tiled.map((line) => line.split(" ")[0])).toEqual(["pane.f0", "pane.f1"]);

        // Closing the float from a shell removes it from the listing.
        run("kill-pane", "-t", panes[2]![0]!);
        await expect
          .poll(
            async () =>
              (await runtime!.describeSessionAuthority("f")).description.panes
                .map((pane) => pane.semanticPaneId)
                .sort(),
            { timeout: 5_000 },
          )
          .toEqual(["pane.f0", "pane.f1"]);
      } finally {
        await subscription.close();
      }
    } finally {
      inventory?.dispose();
      await runtime?.dispose();
      if (serverPid) {
        spawnSync(executable, ["-S", socket, "kill-server"], { env });
        await expect
          .poll(() => {
            try {
              process.kill(serverPid!, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          })
          .toBe(true);
        if (existsSync(socket)) rmSync(socket);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
