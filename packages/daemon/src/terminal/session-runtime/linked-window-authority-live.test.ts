import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { WorkspaceTerminalInventoryRuntime } from "../attachments/native-runtime.ts";
import { SessionRuntimeRegistry } from "./registry.ts";

const executable = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
it.skipIf(!executable).each([
  [false, false, false],
  [true, false, false],
  [true, true, false],
  [true, false, true],
])(
  "does not grant competing physical-window geometry after linking (qualified first: %s, duplicate identities: %s, unretained peer: %s)",
  async (warm, duplicateIdentities, unretainedPeer) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ti-link-authority-"));
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
      for (const name of ["alpha", "beta"]) {
        run("new-session", "-d", "-s", name, "-x", "100", "-y", "30", "exec sleep 300");
        serverPid ??= Number(run("display-message", "-p", "-t", name, "#{pid}"));
        run("set-option", "-w", "-t", `${name}:0`, "@tmux_ide_window_id", `window.${name}`);
        run("set-option", "-p", "-t", `${name}:0`, "@tmux_ide_pane_id", `pane.${name}`);
      }
      const physicalWindow = run("display-message", "-p", "-t", "alpha:0", "#{window_id}");
      const workspaces = new WorkspaceRegistry({
        dir: join(root, "registry"),
        listSessions: () => ["alpha", "beta"],
      });
      for (const name of ["alpha", "beta"])
        workspaces.add({ name, sessionName: name, projectDir: root });
      runtime = new SessionRuntimeRegistry({
        generation: randomUUID(),
        mirror: { executable, socketPath: socket },
      });
      let inventoryReads = 0;
      inventory = new WorkspaceTerminalInventoryRuntime({
        readCommandExecutor: (file, argv, options) => {
          inventoryReads++;
          return new Promise((resolve, reject) => {
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
          });
        },
        registry: workspaces,
        sessionRuntimeRegistry: runtime,
        tmuxAuthority: {
          executablePath: executable,
          socketSelector: { kind: "path", path: socket },
          trustedCwd: root,
        },
      });
      await inventory.whenReady();
      if (warm) {
        for (const name of unretainedPeer ? ["alpha"] : ["alpha", "beta"]) {
          expect((await inventory.discoverTerminalRuntimeSession(name))?.catalogIssue).toBeNull();
          expect(runtime.hasProofQualifiedInventory(name)).toBe(true);
        }
      }
      const clients = [
        runtime.connect("alpha", "opentui", randomUUID()),
        runtime.connect("beta", "opentui", randomUUID()),
      ];
      const prior = warm ? await runtime.describeTrustedSessionInventoryCandidate("alpha") : null;
      if (warm) {
        const readsBefore = inventoryReads;
        expect(readsBefore).toBeGreaterThan(0);
        for (let read = 0; read < 3; read++)
          await runtime.describeTrustedSessionInventoryCandidate("alpha");
        expect(inventoryReads, "steady trusted reads must not rescan registered peers").toBe(
          readsBefore,
        );
      }
      const oldController = warm ? clients[0]!.acquireController() : null;
      if (warm) {
        run("new-window", "-d", "-t", "alpha:2", "exec sleep 300");
        await expect.poll(async () => (await clients[0]!.describe()).panes.length).toBe(2);
        await expect
          .poll(() => runtime!.isTrustedSessionInventoryCandidateCurrent("alpha", prior!.token))
          .toBe(true);
        clients[0]!.fitViewport(oldController!, 108, 31, "window.alpha");
        await expect
          .poll(() => run("display-message", "-p", "-t", "alpha:0", "#{window_width}"))
          .toBe("108");
      }
      if (duplicateIdentities) {
        run("set-option", "-w", "-t", "beta:0", "@tmux_ide_window_id", "window.alpha");
        run("set-option", "-p", "-t", "beta:0", "@tmux_ide_pane_id", "pane.alpha");
      }
      run("link-window", "-d", "-s", "alpha:0", "-t", "beta:1");
      expect(run("display-message", "-p", "-t", "beta:1", "#{window_id}")).toBe(physicalWindow);
      if (warm) {
        // Wait for authority revocation driven by the topology event. A
        // refused session need not publish newly linked semantic identities.
        await expect
          .poll(() => runtime!.isTrustedSessionInventoryCandidateCurrent("alpha", prior!.token), {
            timeout: 5000,
          })
          .toBe(false);
      }
      const admitted = await Promise.all(
        ["alpha", "beta"].map((name) => inventory!.discoverTerminalRuntimeSession(name)),
      );
      if (duplicateIdentities) {
        expect(run("show-option", "-wqv", "-t", "alpha:0", "@tmux_ide_window_id")).toBe(
          "window.alpha",
        );
        expect(run("show-option", "-pqv", "-t", "alpha:0", "@tmux_ide_pane_id")).toBe("pane.alpha");
      }
      expect(admitted.map((session) => session?.catalogIssue)).toEqual([
        "duplicate-runtime-pane-binding",
        "duplicate-runtime-pane-binding",
      ]);
      const owners = clients.map((client) => {
        client.updatePresence("foreground");
        try {
          client.acquireController();
          return client.acquireAuthority("geometry");
        } catch (error) {
          expect(String(error)).toMatch(/Linked windows|ownership is being verified/);
          return null;
        }
      });
      if (warm) {
        expect(owners).toEqual([null, null]);
        expect(runtime.isTrustedSessionInventoryCandidateCurrent("alpha", prior!.token)).toBe(
          false,
        );
        expect(() => clients[0]!.fitViewport(oldController!, 120, 30)).toThrow(
          /Linked windows|ownership is being verified/,
        );
      }
      const resized: string[] = [];
      for (let index = 0; index < clients.length; index++) {
        if (admitted[index]?.catalogIssue !== null || !owners[index]) continue;
        const client = clients[index]!;
        const cols = index === 0 ? 126 : 86;
        try {
          client.fitViewportWithAuthority(owners[index]!, cols, 35, "window.alpha");
        } catch (error) {
          if (!(error instanceof Error) || error instanceof TypeError) throw error;
          expect(error.message).toMatch(/linked|shared|geometry|authority|lease/u);
          continue;
        }
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          if (run("display-message", "-p", "-t", "alpha:0", "#{window_width}") === String(cols)) {
            resized.push(client.session);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(
        resized.length,
        "independent leases resized the same physical window",
      ).toBeLessThanOrEqual(1);
      if (warm) {
        run("unlink-window", "-t", "beta:1");
        await expect
          .poll(
            async () => {
              try {
                const snapshot = await inventory!.discoverTerminalRuntimeSession("alpha");
                return (
                  snapshot?.catalogIssue === null && runtime!.hasProofQualifiedInventory("alpha")
                );
              } catch {
                return false;
              }
            },
            { timeout: 5000 },
          )
          .toBe(true);
        expect(runtime.isTrustedSessionInventoryCandidateCurrent("alpha", prior!.token)).toBe(
          false,
        );
        expect(() => clients[0]!.fitViewport(oldController!, 120, 30)).toThrow();
        const fresh = clients[0]!.acquireController();
        clients[0]!.fitViewport(fresh, 112, 32, "window.alpha");
        await expect
          .poll(() => run("display-message", "-p", "-t", "alpha:0", "#{window_width}"))
          .toBe("112");
        const recovered = await runtime.describeTrustedSessionInventoryCandidate("alpha");
        run("link-window", "-d", "-s", "alpha:0", "-t", "beta:1");
        await expect
          .poll(() => runtime!.isTrustedSessionInventoryCandidateCurrent("alpha", recovered.token))
          .toBe(false);
        // A pending topology proof also rejects tokens temporarily. Confirm
        // the still-linked inventory before replacing beta, so this checks
        // permanent revocation of an observed conflict rather than racing the
        // membership reader against link removal.
        await runtime.verifyWindowOwnership();
        expect(runtime.isTrustedSessionInventoryCandidateCurrent("alpha", recovered.token)).toBe(
          false,
        );
        expect(() => clients[0]!.fitViewport(fresh, 124, 34)).toThrow(
          /Linked windows|ownership is being verified/,
        );
        expect(() => clients[0]!.acquireController()).toThrow(
          /Linked windows|ownership is being verified/,
        );
        expect(() => clients[1]!.acquireController()).toThrow(
          /Linked windows|ownership is being verified/,
        );
        const retiredSessionId = run("display-message", "-p", "-t", "beta", "#{session_id}");
        run("kill-session", "-t", "beta");
        await runtime.retireSession("beta");
        run("new-session", "-d", "-s", "beta", "exec sleep 300");
        run("set-option", "-w", "-t", "beta:0", "@tmux_ide_window_id", "window.beta");
        run("set-option", "-p", "-t", "beta:0", "@tmux_ide_pane_id", "pane.beta");
        expect(run("display-message", "-p", "-t", "beta", "#{session_id}")).not.toBe(
          retiredSessionId,
        );
        await expect
          .poll(
            async () => {
              try {
                return (
                  (await inventory!.discoverTerminalRuntimeSession("beta"))?.catalogIssue ===
                    null &&
                  (await inventory!.discoverTerminalRuntimeSession("alpha"))?.catalogIssue === null
                );
              } catch {
                return false;
              }
            },
            { timeout: 5000 },
          )
          .toBe(true);
        expect(runtime.isTrustedSessionInventoryCandidateCurrent("alpha", recovered.token)).toBe(
          false,
        );
        expect(() => clients[0]!.fitViewport(fresh, 124, 34)).toThrow();
        const replacement = runtime.connect("beta", "opentui", randomUUID());
        replacement.updatePresence("foreground");
        replacement.fitViewport(replacement.acquireController(), 92, 29, "window.beta");
        await expect
          .poll(() => run("display-message", "-p", "-t", "beta:0", "#{window_width}"))
          .toBe("92");
        expect(() => clients[1]!.acquireController()).toThrow();
      }
    } finally {
      inventory?.dispose();
      await runtime?.dispose();
      if (serverPid) {
        run("kill-server");
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
      rmSync(root, { recursive: true });
    }
  },
  15000,
);
