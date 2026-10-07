/* @jsxImportSource @opentui/solid */
/** Opt-in local real-SSH terminal/renderer composition; not remote installation or physical paint. */
import { expect, it } from "bun:test";
import { CliRenderEvents } from "@opentui/core";
import {
  literalStyledFrame,
  styledBytes,
  readCompletedFrame,
  nativeVisualFrame,
  compareVisual,
  type CompletedFrame,
} from "../testing/styled-frame-oracle.ts";
import { readPhysicalFrame } from "../../../terminal/mirror/__tests__/native-physical-cell-oracle.ts";
import { createSignal } from "solid-js";
import { serve } from "@hono/node-server";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  tmuxServerPaneStreamPath,
  type CanonicalDaemonInfo,
} from "@tmux-ide/contracts";
import { createTmuxServerClient } from "@tmux-ide/daemon-client/tmux-server-client";
import { createApp } from "../../../command-center/server.ts";
import { TmuxServerOwners } from "../../../lib/tmux-server-owners.ts";
import {
  createNativeTmuxServerOwner,
  type NativeTmuxServerOwner,
} from "../../../lib/tmux-server-owner.ts";
import { createTmuxServerProbe } from "../../../lib/tmux-server-registration.ts";
import { attachPaneStreamWebSocket } from "../../../server/pane-stream-upgrade.ts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
} from "../../../lib/ssh-daemon-transport.ts";
import { createApplicationDaemonAuthority } from "./application-daemon-authority-owner.ts";
import { createApplicationMachineAuthorityManager } from "./application-machine-authority.ts";
import { applicationRouteConnection } from "./application-route-connection.ts";
import {
  createOpenTuiGenerationHost,
  type OpenTuiGenerationHostSnapshot,
} from "./open-tui-generation-host.ts";
import { createOpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import { registerPaneSurface } from "../pane-surface.tsx";
import {
  renderForTest,
  destroyTestRenderer,
  frameLines,
} from "../testing/renderer-harness.test.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
// @ts-expect-error Private fixture has no public declaration surface.
import * as ownedSsh from "../../../../../../scripts/lib/owned-ssh-fixture.mjs";
const {
  createOwnedSshFixture,
  createMacProcessIdentity,
  ownedProcesses,
  unusedLoopbackPort,
  waitForPort,
} = ownedSsh;

function checkFrame(
  lines: string[],
  cursor: { x: number; y: number; visible: boolean },
  marker: string,
) {
  if (styledNative) expect(lines[0]!.trimEnd()).toBe(marker);
  else expect(lines.map((line) => line.trimEnd())).toEqual([marker, ...Array(7).fill("")]);
  expect(cursor).toMatchObject({ x: 5, y: 3, visible: true });
}

const styledNative = process.env.TMUX_IDE_STYLED_NATIVE_RECONNECT === "1";
const enabled = process.env.TMUX_IDE_OWNED_TERMINAL_SSH === "1" && process.platform === "darwin";
const wait = async (predicate: () => boolean, label: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) throw Error(`Deadline: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const bounded = async <T,>(promise: Promise<T>, ms = 5_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("cleanup deadline")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

it.skipIf(!enabled)(
  "retains a mounted terminal viewer across real SSH forward loss",
  async () => {
    const previousUmask = process.umask(0o077);
    registerPaneSurface();
    const root = mkdtempSync(join(realpathSync(tmpdir()), "v-"));
    const receipt = mkdtempSync("/tmp/tmi-ssh-view-evidence-");
    const cleanup: Array<() => void | Promise<void>> = [];
    const errors: string[] = [];
    const report: Record<string, unknown> = {
      scope: "local owned OpenSSH + production generation host + mounted PaneSurface",
      sourceSha256: createHash("sha256")
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
    };
    const trace: unknown[] = [];
    const allocations: Array<{ disposeFiles(): Promise<void>; diagnostics?(): unknown }> = [];
    let releaseReconnect: (() => void) | undefined;
    let failure: unknown;
    let stopConnections = () => {};
    const paneId = "pane.ssh-view";
    let kernel: { identify(pid: number): Promise<string | null> };
    const tracker = ownedProcesses({
      identify: (pid: number) => kernel.identify(pid),
      list: async () =>
        execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
          .trim()
          .split("\n")
          .map((line) => {
            const [pid, ppid] = line.trim().split(/\s+/).map(Number);
            return { pid, ppid };
          }),
    });
    const executable = realpathSync(
      process.env.TMUX_IDE_TMUX_BIN ?? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const socket = join(root, "native.sock");
    const native = (...args: string[]) =>
      execFileSync(executable, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 3_000,
      }).trimEnd();
    try {
      cleanup.push(async () => {
        for (const a of allocations.reverse()) await a.disposeFiles();
      });
      kernel = await createMacProcessIdentity({
        parent: root,
        onAllocated: (a: (typeof allocations)[number]) => allocations.push(a),
      });
      cleanup.push(async () => {
        report.sshCleanup = await tracker.dispose();
      });
      const node = realpathSync(execFileSync("which", ["node"], { encoding: "utf8" }).trim());
      const control = join(root, "paint"),
        input = join(root, "input"),
        producer = join(root, "producer.cjs");
      writeFileSync(control, "BEFORE_SSH");
      writeFileSync(input, "");
      writeFileSync(
        producer,
        `const fs=require('node:fs');const paint=${styledNative ? styledBytes.toString() : `(s)=>'\\x1b[2J\\x1b[H'+s+'\\x1b[3;5H'`};process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',b=>fs.appendFileSync(${JSON.stringify(input)},b));let old='';setInterval(()=>{const s=fs.readFileSync(${JSON.stringify(control)},'utf8');if(s!==old){old=s;process.stdout.write(paint(s));}},10);`,
      );
      const identityFormat = "#{pid}|#{start_time}|#{session_id}|#{pane_id}|#{pane_pid}";
      const identity = native(
        "new-session",
        "-d",
        "-P",
        "-F",
        identityFormat,
        "-s",
        "ssh-view",
        "-x",
        "40",
        "-y",
        styledNative ? "9" : "8",
        node,
        producer,
      );
      const [serverPid, serverStart, , nativePane, producerPid] = identity.split("|");
      // Install cleanup before any asynchronous kernel lookup or assertion.
      cleanup.push(async () => {
        if (!/^\d+$/.test(serverPid ?? "") || !/^\d+$/.test(serverStart ?? ""))
          throw Error("invalid native cleanup identity");
        const guard = `#{&&:#{==:#{pid},${serverPid}},#{==:#{start_time},${serverStart}}}`;
        expect(
          native("if-shell", "-F", guard, "kill-server", "display-message -p identity-mismatch"),
        ).toBe("");
        await wait(
          () => {
            return [serverPid, producerPid].every((pid) => {
              try {
                process.kill(Number(pid), 0);
                return false;
              } catch (e) {
                return (e as NodeJS.ErrnoException).code === "ESRCH";
              }
            });
          },
          "native process exit",
          3_000,
        );
        report.nativeCleanup = { serverAbsent: true, producerAbsent: true };
      });
      if (styledNative) {
        native("set-option", "-t", "ssh-view", "status", "off");
        native("resize-window", "-t", "ssh-view", "-x", "40", "-y", "9");
        report.styledSetup = native(
          "display-message",
          "-p",
          "-t",
          nativePane!,
          "#{pane_width}|#{pane_height}|#{window-size}|#{status}|#{pane-border-status}",
        );
        await wait(
          () =>
            native("display-message", "-p", "-t", nativePane!, "#{pane_width}|#{pane_height}") ===
            "40|9",
          "styled preadoption native geometry",
        );
      }
      native("set-option", "-p", "-t", nativePane!, "@tmux_ide_pane_id", paneId);
      const serverWitness = await kernel.identify(Number(serverPid));
      const producerWitness = await kernel.identify(Number(producerPid));
      expect(serverWitness).not.toBeNull();
      expect(producerWitness).not.toBeNull();
      await wait(
        () => native("capture-pane", "-p", "-t", nativePane!).includes("BEFORE_SSH"),
        "native baseline",
      );
      const daemonIdentity = {
        environmentId: randomUUID(),
        instanceId: randomUUID(),
        startedAt: new Date().toISOString(),
        productVersion: "owned-ssh-viewer-fixture",
      };
      const authToken = randomUUID();
      let baseUrl = "";
      const owners = new TmuxServerOwners<NativeTmuxServerOwner>({
        probe: createTmuxServerProbe(executable),
        create: (registration, scope, observation) =>
          createNativeTmuxServerOwner({
            ...scope,
            environmentId: daemonIdentity.environmentId,
            tmuxAuthority: observation.authority,
            nativeServerIdentity: observation.nativeServerIdentity,
            stateDirectory: join(root, registration.serverId),
            webSocketUrl: baseUrl.replace("http:", "ws:") + tmuxServerPaneStreamPath(scope),
          }),
      });
      cleanup.push(() => owners.dispose());
      const app = createApp({
        tmuxServerOwners: owners,
        remoteAccess: { ownerToken: authToken },
        daemonIdentity,
        catalogLiveSessions: () => [],
        catalogFleet: () => [],
      });
      const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
      cleanup.push(async () => {
        const address = server.address();
        const closingPort = address && typeof address !== "string" ? address.port : null;
        if (server.listening)
          await new Promise<void>((resolve, reject) => {
            server.close((e) =>
              e && (e as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
                ? reject(e)
                : resolve(),
            );
            (server as Server).closeAllConnections();
          });
        if (closingPort) await waitForPort(closingPort, false);
        report.backendPortClosed = true;
      });
      await wait(() => !!server.address(), "backend ready");
      const port = (server.address() as { port: number }).port;
      baseUrl = `http://127.0.0.1:${port}`;
      const info: CanonicalDaemonInfo = {
        ...daemonIdentity,
        pid: process.pid,
        port,
        bindHostname: "127.0.0.1",
        authToken,
        protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      };
      const registration = await owners.register({
        label: "Private viewer",
        selector: { kind: "path", path: socket },
      });
      if (registration.state !== "online") throw Error("private owner offline");
      const scope = { serverId: registration.serverId, generation: registration.generation };
      const boundary = attachPaneStreamWebSocket(
        server as Server,
        owners.current(scope).paneStreamRuntime.coordinator,
        tmuxServerPaneStreamPath(scope),
      );
      cleanup.push(() => boundary.close());
      const discovery = createTmuxServerClient(
        {
          baseUrl,
          ownerToken: authToken,
          hostClientId: "fixture-discovery",
          origin: "tmux-ide://opentui",
        },
        scope,
      );
      cleanup.push(() => discovery.dispose());
      const selected = (await discovery.sessions()).sessions[0]!;
      const ssh = await createOwnedSshFixture({
        parent: root,
        node,
        targetPort: port,
        processes: tracker,
        handshake: async () => ({ version: 1, daemon: info }),
        onAllocated: (a: (typeof allocations)[number]) => allocations.push(a),
      });
      const tunnels: ReturnType<typeof spawn>[] = [];
      let reconnectGate: Promise<void> | undefined;
      const manager = createApplicationMachineAuthorityManager({
        createOwner: () =>
          createApplicationDaemonAuthority({
            readLocal: () => null,
            isLocalAlive: async () => false,
            observeLocal: async () => () => {},
            verify: probeSshDaemonIdentity,
            retryDelayMs: 50,
            probeIntervalMs: 50,
            connect: async (options) => {
              if (reconnectGate) await reconnectGate;
              const transport = await openSshDaemonTransport(options, {
                spawn: (args) => {
                  const child = tracker.retain(
                    spawn("/usr/bin/ssh", ["-F", ssh.config, ...args], {
                      stdio: ["ignore", "pipe", "pipe"],
                    }),
                  );
                  if (args.includes("-N")) tunnels.push(child);
                  return child;
                },
                allocatePort: unusedLoopbackPort,
                probe: probeSshDaemonIdentity,
              });
              cleanup.push(async () => {
                transport.dispose();
                await transport.closed;
                await waitForPort(Number(new URL(transport.baseUrl).port), false);
                trace.push({
                  type: "transport-cleanup",
                  port: Number(new URL(transport.baseUrl).port),
                  closed: true,
                });
              });
              return transport;
            },
          }),
      });
      stopConnections = () => manager.dispose();
      cleanup.push(() => manager.dispose());
      const machineId = randomUUID();
      manager.initialize([
        { id: machineId, label: "SSH viewer", sshTarget: "target", enabled: true },
      ]);
      const handle = manager.getMachine(machineId)!;
      expect(await handle.ready).toBe(true);
      const presentation = createOpenTuiRuntimeLayoutPresentation();
      cleanup.push(() => presentation.dispose());
      const host = createOpenTuiGenerationHost(
        selected.sessionName,
        presentation,
        applicationRouteConnection(handle, selected.liveSessionId, undefined, scope),
      );
      cleanup.push(() => host.dispose());
      const [snapshot, setSnapshot] = createSignal<OpenTuiGenerationHostSnapshot>(
        host.getSnapshot(),
      );
      const [version, setVersion] = createSignal(0);
      let stopVersion = () => {};
      let subscribedAdapter: unknown;
      cleanup.push(
        host.subscribe((value) => {
          trace.push({
            type: "host",
            status: value.status,
            rendererEpoch: value.rendererEpoch,
            daemonGeneration: value.daemonGeneration,
          });
          setSnapshot(value);
          if (value.adapter !== subscribedAdapter) {
            stopVersion();
            subscribedAdapter = value.adapter;
            stopVersion =
              value.adapter?.subscribePaneVersion(paneId, (n) => setVersion(n)) ?? (() => {});
          }
        }),
      );
      cleanup.push(() => stopVersion());
      expect(await host.start()).toBe(true);
      await wait(
        () => snapshot().status === "live" && !!snapshot().adapter?.paneSelectionSnapshot(paneId),
        "terminal baseline",
      );
      if (styledNative) {
        await wait(
          () =>
            native(
              "display-message",
              "-p",
              "-t",
              nativePane!,
              "#{pane_width}|#{pane_height}|#{pane-border-status}",
            ) === "40|8|top",
          "styled postadoption native geometry",
        );
        report.styledPostadoption = native(
          "display-message",
          "-p",
          "-t",
          nativePane!,
          "#{pane_width}|#{pane_height}|#{window_width}|#{window_height}|#{window-size}|#{status}|#{pane-border-status}",
        );
      }
      const palette = createTerminalPaletteProjection(
        createSemanticThemeSnapshot({ mode: "dark" }),
      );
      const setup = await renderForTest(
        () => (
          <pane_surface
            width={40}
            height={8}
            mirror={snapshot().adapter!.renderSource}
            paneId={paneId}
            paneFocused={true}
            contentVersion={version()}
            defaultFg={0xffffff}
            defaultBg={0}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
          />
        ),
        { width: 40, height: 8, consoleMode: "disabled" },
      );
      cleanup.push(() => destroyTestRenderer(setup));
      const completed: CompletedFrame[] = [];
      const recordFrame = () => {
        const b = setup.renderer.currentRenderBuffer,
          v = b.buffers,
          c = setup.renderer.getCursorState();
        if (completed.length >= 256) throw Error("completed frame receipt bound");
        completed.push({
          cols: b.width,
          rows: b.height,
          char: [...v.char],
          fg: [...v.fg],
          bg: [...v.bg],
          attributes: [...v.attributes],
          text: setup.captureCharFrame(),
          cursor: { x: c.x, y: c.y, visible: c.visible },
        });
      };
      if (styledNative) setup.renderer.on(CliRenderEvents.FRAME, recordFrame);
      cleanup.push(() => setup.renderer.off(CliRenderEvents.FRAME, recordFrame));
      report.completedFrames = completed;
      report.styledNative = styledNative;

      const checkpoint = async (marker: string) => {
        await wait(
          () =>
            snapshot()
              .adapter?.paneSelectionSnapshot(paneId)
              ?.grid.some((row) =>
                row.cells
                  .map((cell) => cell.grapheme)
                  .join("")
                  .includes(marker),
              ) ?? false,
          `canonical ${marker}`,
        );
        if (styledNative) {
          await wait(
            () => native("display-message", "-p", "-t", nativePane!, "#{pane_title}") === marker,
            `native paint fence ${marker}`,
          );
          const raw = native("capture-pane", "-p", "-R", "-S", "0", "-t", nativePane!);
          trace.push({ type: "raw-native-before-comparison", marker, raw });
          compareVisual(
            nativeVisualFrame(readPhysicalFrame(raw, "styled-reconnect")),
            literalStyledFrame(marker),
          );
          const frameCount = completed.length;
          await setup.renderOnce();
          expect(completed.length).toBeGreaterThan(frameCount);
          const actual = readCompletedFrame(completed.at(-1)!);
          compareVisual(actual, literalStyledFrame(marker));
          for (const field of ["text", "width", "fg", "bg", "bold"] as const) {
            const wrong = structuredClone(actual),
              cell = wrong.cells[1]![1]!;
            if (field === "text") cell.text = "?";
            else if (field === "width") cell.width = 9;
            else if (field === "bold") cell.bold = !cell.bold;
            else cell[field] = "fedcba";
            expect(() => compareVisual(wrong, literalStyledFrame(marker))).toThrow(field);
          }
          const badTail = structuredClone(actual);
          badTail.cells[3]![39]!.bg = "000000";
          expect(() => compareVisual(badTail, literalStyledFrame(marker))).toThrow("bg");
          const badCursor = structuredClone(actual);
          badCursor.cursor.x++;
          expect(() => compareVisual(badCursor, literalStyledFrame(marker))).toThrow("cursor");
          if (marker !== "BEFORE_SSH")
            expect(() => compareVisual(actual, literalStyledFrame("BEFORE_SSH"))).toThrow();
          trace.push({
            type: "styled-native-frame",
            marker,
            raw,
            actual,
            negativeControls: marker === "BEFORE_SSH" ? 7 : 8,
          });
        } else await setup.renderOnce();
        const frame = frameLines(setup.captureCharFrame());
        checkFrame(frame, setup.renderer.getCursorState(), marker);
        const corrupted = [...frame];
        corrupted[0] = "WRONG";
        expect(() => checkFrame(corrupted, setup.renderer.getCursorState(), marker)).toThrow();
        expect(native("capture-pane", "-p", "-t", nativePane!).split("\n")[0]).toBe(marker);
        expect(native("display-message", "-p", "-t", nativePane!, identityFormat)).toBe(identity);
        const nativeGeometryCursor = native(
          "display-message",
          "-p",
          "-t",
          nativePane!,
          "#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}",
        );
        expect(nativeGeometryCursor.split("|").slice(2)).toEqual(["4", "2"]);
        trace.push({
          nativeGeometryCursor,
          type: "checkpoint",
          marker,
          frame,
          cursor: setup.renderer.getCursorState(),
          canonical: snapshot().adapter!.paneCanonicalIdentity(paneId),
        });
      };
      await checkpoint("BEFORE_SSH");
      const before = snapshot();
      const oldTunnel = tunnels.at(-1)!;
      const oldEpoch = handle.endpoint().epoch;
      const tunnelWitness = await kernel.identify(oldTunnel.pid!);
      expect(tunnelWitness).not.toBeNull();
      reconnectGate = new Promise<void>((resolve) => {
        releaseReconnect = resolve;
      });
      const stopLoss = await handle.observe((generation) => {
        trace.push({ type: "authority", generation, epoch: handle.endpoint().epoch });
      });
      cleanup.push(stopLoss);
      expect(await kernel.identify(oldTunnel.pid!)).toBe(tunnelWitness);
      oldTunnel.kill("SIGKILL");
      await wait(
        () => oldTunnel.exitCode !== null || oldTunnel.signalCode !== null,
        "SSH forward exit",
      );
      await wait(() => handle.read() === null && snapshot().status !== "live", "viewer revocation");
      // Only scheduling of the next real connect is gated, never handshake success or terminal data.
      writeFileSync(control, "DURING_SSH_OUTAGE");
      await wait(
        () => native("capture-pane", "-p", "-t", nativePane!).includes("DURING_SSH_OUTAGE"),
        "outage output",
      );
      if (styledNative) {
        await setup.renderOnce();
        compareVisual(readCompletedFrame(completed.at(-1)!), literalStyledFrame("BEFORE_SSH"));
      }
      releaseReconnect!();
      reconnectGate = undefined;
      await wait(
        () =>
          snapshot().status === "live" &&
          handle.endpoint().epoch > oldEpoch &&
          tunnels.at(-1) !== oldTunnel,
        "same viewer reconnect",
      );
      await checkpoint("DURING_SSH_OUTAGE");
      expect(snapshot().client).not.toBe(before.client);
      expect(await kernel.identify(oldTunnel.pid!)).toBeNull();
      writeFileSync(control, "AFTER_SSH_RECOVERY");
      await checkpoint("AFTER_SSH_RECOVERY");
      const active = snapshot();
      active.authorityClient!.setPresence("foreground");
      expect(await active.authorityClient!.requestAuthority("input")).not.toBeNull();
      const target = {
        workspaceName: active.client!.getSnapshot().target!.workspaceName,
        semanticPaneId: paneId,
      };
      expect(
        await active.client!.sendTerminalInput(target, { kind: "text", data: "SSH_INPUT_42" }),
      ).toBe("ok");
      expect(await active.client!.sendTerminalInput(target, { kind: "key", data: "Enter" })).toBe(
        "ok",
      );
      await wait(
        () => readFileSync(input).toString("hex") === Buffer.from("SSH_INPUT_42\r").toString("hex"),
        "exact recovered input",
      );
      report.result = {
        identity,
        oldTunnelPid: oldTunnel.pid,
        newTunnelPid: tunnels.at(-1)!.pid,
        oldEpoch,
        newEpoch: handle.endpoint().epoch,
        exactInputHex: readFileSync(input).toString("hex"),
        hostRetained: true,
        nativeBinarySha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      };
      report.passed = true;
    } catch (error) {
      failure = error;
      report.failure = String(error);
      report.failureStack = error instanceof Error ? error.stack : null;
      report.sshDiagnostics = allocations.map((a) => a.diagnostics?.());
    } finally {
      try {
        stopConnections();
      } catch (error) {
        errors.push(String(error));
      }
      releaseReconnect?.();
      for (const dispose of cleanup.reverse()) {
        try {
          await bounded(Promise.resolve().then(dispose), 10_000);
        } catch (error) {
          errors.push(String(error));
        }
      }
      process.umask(previousUmask);
      report.passed = failure === undefined && errors.length === 0;
      report.trace = trace;
      report.cleanupErrors = errors;
      writeFileSync(join(receipt, "receipt.json"), JSON.stringify(report, null, 2));
      if (!errors.length) rmSync(root, { recursive: true, force: true });
      process.stdout.write(`SSH viewer receipt: ${receipt}\n`);
    }
    expect(errors).toEqual([]);
    if (failure) throw failure;
  },
  60_000,
);
