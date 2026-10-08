/* @jsxImportSource @opentui/solid */
/** Opt-in local real-SSH terminal/renderer composition; not remote installation or physical paint. */
import { expect, it } from "bun:test";
import { CliRenderEvents } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { ApplicationTerminalWorkspace } from "./application-terminal-workspace.tsx";
import { createApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import {
  literalStyledFrame,
  cropWorkspaceCompletedFrame,
  styledBytes,
  readCompletedFrame,
  nativeVisualFrame,
  compareVisual,
  type CompletedFrame,
} from "../testing/styled-frame-oracle.ts";
import { readPhysicalFrame } from "../../../terminal/mirror/__tests__/native-physical-cell-oracle.ts";
import { createSignal, createMemo, Show } from "solid-js";
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
      const ownedNativePids = [serverPid, producerPid];
      let second:
        | {
            pane: string;
            identity: string;
            input: string;
            control: string;
            pid: number;
            birth: string | null;
          }
        | undefined;
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
            return ownedNativePids.every((pid) => {
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
        report.nativeCleanup = {
          serverAbsent: true,
          producerAbsent: true,
          ownedPids: ownedNativePids.map((pid) => ({ pid, absent: true })),
        };
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
      if (styledNative) {
        const secondControl = join(root, "paint-second"),
          secondInput = join(root, "input-second"),
          secondProducer = join(root, "producer-second.cjs");
        writeFileSync(secondControl, "SECOND_WINDOW");
        writeFileSync(secondInput, "");
        writeFileSync(
          secondProducer,
          readFileSync(producer, "utf8")
            .replace(JSON.stringify(control), JSON.stringify(secondControl))
            .replace(JSON.stringify(input), JSON.stringify(secondInput)),
        );
        const secondIdentity = native(
          "new-window",
          "-d",
          "-P",
          "-F",
          identityFormat,
          "-t",
          "ssh-view",
          "-n",
          "second",
          node,
          secondProducer,
        );
        const parts = secondIdentity.split("|");
        ownedNativePids.push(parts[4]!);
        expect(parts[0]).toBe(serverPid);
        expect(parts[1]).toBe(serverStart);
        expect(parts[3]).toMatch(/^%\d+$/);
        expect(parts[4]).toMatch(/^\d+$/);
        second = {
          pane: parts[3]!,
          identity: secondIdentity,
          input: secondInput,
          control: secondControl,
          pid: Number(parts[4]),
          birth: await kernel.identify(Number(parts[4])),
        };
        expect(second.birth).not.toBeNull();
        report.secondCreation = secondIdentity;
        native("set-option", "-p", "-t", second.pane, "@tmux_ide_pane_id", "pane.ssh-second");
        native("resize-window", "-t", second.pane, "-x", "40", "-y", "9");
      }

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
      const [workspaceLayout, setWorkspaceLayout] = createSignal(presentation.getWindowSnapshot());
      const [focusedPane, setFocusedPane] = createSignal<string | null>(paneId);
      let interaction:
        | ReturnType<typeof createApplicationTerminalInteractionController>
        | undefined;
      cleanup.push(
        presentation.subscribeWindows((value) => {
          interaction?.adoptLayout(value);
          setWorkspaceLayout(value);
        }),
      );
      cleanup.push(() => interaction?.cancelPendingInput());
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
          interaction?.adoptGeneration(value);
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
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const palette = {
        ...createTerminalPaletteProjection(theme),
        foreground: 0xffffff,
        background: 0,
      };
      if (styledNative) {
        interaction = createApplicationTerminalInteractionController({
          generation: snapshot,
          layout: workspaceLayout,
          focusedPane,
          rendererFocused: () => true,
          setFocusedPane,
          diagnosticsEnabled: false,
          diagnose: () => {},
        });
        interaction.adoptGeneration(snapshot());
        interaction.adoptLayout(workspaceLayout());
      }
      let selection: Promise<void> | undefined;

      const [surfaceCols, setSurfaceCols] = createSignal<24 | 40>(40);
      // Same generation ownership as ApplicationShellView: pane subscriptions are stable
      // within a workspace and replaced only when its adapter/renderer epoch changes.
      const rendererSource = createMemo(
        () => ({ adapter: snapshot().adapter!, rendererEpoch: snapshot().rendererEpoch }),
        undefined,
        { equals: (a, b) => a?.adapter === b.adapter && a?.rendererEpoch === b.rendererEpoch },
      );
      const setup = await renderForTest(
        () =>
          styledNative ? (
            <Show when={rendererSource()} keyed>
              {(source) => (
                <ApplicationTerminalWorkspace
                  layout={workspaceLayout}
                  adapter={source.adapter}
                  rendererEpoch={source.rendererEpoch}
                  width={surfaceCols()}
                  height={9}
                  topOffset={1}
                  focusedPane={focusedPane()}
                  rendererFocused={true}
                  theme={theme}
                  palette={palette}
                  onSelectPane={(id) => interaction!.selectPane(id)}
                  onSelectWindowLink={(target) => {
                    selection = interaction!.selectWindowLink(target);
                  }}
                  onWindowPresented={(window, pane, name) =>
                    interaction!.observeWindowPresentation(window, pane, name)
                  }
                />
              )}
            </Show>
          ) : (
            <pane_surface
              width={surfaceCols()}
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
        { width: 40, height: styledNative ? 10 : 8, consoleMode: "disabled" },
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

      const contentFrame = (frame: CompletedFrame) =>
        styledNative ? cropWorkspaceCompletedFrame(frame) : frame;
      const checkpoint = async (
        marker: string,
        cols: 24 | 40 = 40,
        target = { paneId, nativePane: nativePane!, identity },
      ) => {
        await wait(
          () =>
            snapshot()
              .adapter?.paneSelectionSnapshot(target.paneId)
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
            () =>
              native("display-message", "-p", "-t", target.nativePane, "#{pane_title}") === marker,
            `native paint fence ${marker}`,
          );
          const raw = native("capture-pane", "-p", "-R", "-S", "0", "-t", target.nativePane);
          trace.push({ type: "raw-native-before-comparison", marker, raw });
          compareVisual(
            nativeVisualFrame(
              readPhysicalFrame(raw, cols === 24 ? "styled-reconnect-narrow" : "styled-reconnect"),
            ),
            literalStyledFrame(marker, cols),
          );
          const frameCount = completed.length;
          await setup.renderOnce();
          expect(completed.length).toBeGreaterThan(frameCount);
          const actual = readCompletedFrame(contentFrame(completed.at(-1)!));
          compareVisual(actual, literalStyledFrame(marker, cols));
          for (const field of ["text", "width", "fg", "bg", "bold"] as const) {
            const wrong = structuredClone(actual),
              cell = wrong.cells[1]![1]!;
            if (field === "text") cell.text = "?";
            else if (field === "width") cell.width = 9;
            else if (field === "bold") cell.bold = !cell.bold;
            else cell[field] = "fedcba";
            expect(() => compareVisual(wrong, literalStyledFrame(marker, cols))).toThrow(field);
          }
          const badTail = structuredClone(actual);
          badTail.cells[3]![cols - 1]!.bg = "000000";
          expect(() => compareVisual(badTail, literalStyledFrame(marker, cols))).toThrow("bg");
          const badCursor = structuredClone(actual);
          badCursor.cursor.x++;
          expect(() => compareVisual(badCursor, literalStyledFrame(marker, cols))).toThrow(
            "cursor",
          );
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
        const displayed = styledNative ? contentFrame(completed.at(-1)!) : null;
        const frame = frameLines(displayed?.text ?? setup.captureCharFrame());
        const displayedCursor = displayed?.cursor ?? setup.renderer.getCursorState();
        checkFrame(frame, displayedCursor, marker);
        const corrupted = [...frame];
        corrupted[0] = "WRONG";
        expect(() => checkFrame(corrupted, displayedCursor, marker)).toThrow();
        expect(native("capture-pane", "-p", "-t", target.nativePane).split("\n")[0]).toBe(marker);
        expect(native("display-message", "-p", "-t", target.nativePane, identityFormat)).toBe(
          target.identity,
        );
        const nativeGeometryCursor = native(
          "display-message",
          "-p",
          "-t",
          target.nativePane,
          "#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}",
        );
        expect(nativeGeometryCursor.split("|").slice(2)).toEqual(["4", "2"]);
        trace.push({
          nativeGeometryCursor,
          type: "checkpoint",
          marker,
          frame,
          cursor: setup.renderer.getCursorState(),
          canonical: snapshot().adapter!.paneCanonicalIdentity(target.paneId),
        });
      };
      await checkpoint("BEFORE_SSH");
      if (styledNative) {
        const retained = snapshot();
        retained.authorityClient!.setPresence("foreground");
        expect(await retained.authorityClient!.requestAuthority("geometry")).not.toBeNull();
        for (const cols of [40, 24, 40] as const) {
          const previousFrame = structuredClone(completed.at(-1)!);
          expect(await retained.client!.fitViewport(cols, 9)).toBe("ok");
          await wait(
            () =>
              native(
                "display-message",
                "-p",
                "-t",
                nativePane!,
                "#{pane_width}|#{pane_height}|#{window_width}|#{window_height}|#{window-size}|#{pane-border-status}",
              ) === `${cols}|8|${cols}|9|latest|top`,
            "public viewport native convergence",
          );
          await wait(() => {
            const pane = snapshot().adapter?.paneSelectionSnapshot(paneId);
            return pane?.cols === cols && pane?.rows === 8;
          }, "public viewport adapter convergence");
          expect(snapshot().client).toBe(retained.client);
          expect(snapshot().adapter).toBe(retained.adapter);
          expect(snapshot().rendererEpoch).toBe(retained.rendererEpoch);
          expect(retained.client!.ownsRuntimeAuthority("geometry")).toBe(true);
          setup.renderer.resize(cols, 10);
          setSurfaceCols(cols);
          const marker = cols === 24 ? "RESIZE_NARROW" : "BEFORE_SSH";
          writeFileSync(control, marker);
          await checkpoint(marker, cols);
          if (previousFrame.cols !== cols)
            expect(() =>
              compareVisual(
                readCompletedFrame(contentFrame(previousFrame)),
                literalStyledFrame(marker, cols),
              ),
            ).toThrow();
          trace.push({
            type: "public-viewport",
            requested: { cols, rows: 9 },
            geometryAuthorityClientId: retained.client!.runtimeAuthorityClientId("geometry"),
            rendererEpoch: snapshot().rendererEpoch,
            native: native(
              "display-message",
              "-p",
              "-t",
              nativePane!,
              "#{pane_width}|#{pane_height}|#{window-size}|#{pane-border-status}",
            ),
            completed: { cols: completed.at(-1)!.cols, rows: completed.at(-1)!.rows },
          });
        }
      }

      if (styledNative) {
        const retained = snapshot();
        retained.authorityClient!.setPresence("foreground");
        expect(await retained.authorityClient!.requestAuthority("input")).not.toBeNull();
        for (const target of [
          {
            paneId: "pane.ssh-second",
            nativePane: second!.pane,
            identity: second!.identity,
            marker: "SECOND_WINDOW",
            input: second!.input,
            token: "SECOND_INPUT",
          },
          {
            paneId,
            nativePane: nativePane!,
            identity,
            marker: "BEFORE_SSH",
            input,
            token: "FIRST_RETURN_INPUT",
          },
        ]) {
          const windows = workspaceLayout();
          const backing = windows.windows.find((w) =>
            w.panes.some((p) => p.pane === target.paneId),
          );
          expect(backing).toBeDefined();
          const link = windows.windowLinks?.links.find(
            (l) => l.semanticWindowId === backing!.semanticWindowId,
          );
          expect(link).toBeDefined();
          await setup.renderOnce();
          const tab = setup.renderer.root.findDescendantById(`window-tab:${link!.linkId}`);
          expect(tab).toBeDefined();
          const oldFrame = contentFrame(completed.at(-1)!);
          selection = undefined;
          await setup.mockMouse.click(tab!.x + 2, tab!.y, MouseButtons.LEFT);
          expect(selection).toBeDefined();
          await selection;
          await wait(
            () =>
              workspaceLayout().windowLinks?.activeLinkId === link!.linkId &&
              workspaceLayout().current?.semanticWindowId === backing!.semanticWindowId &&
              focusedPane() === target.paneId,
            "public selection convergence",
          );
          expect(
            native(
              "display-message",
              "-p",
              "-t",
              target.nativePane,
              "#{window_active}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane-border-status}",
            ),
          ).toBe("1|1|40|8|top");
          await checkpoint(target.marker, 40, target);
          expect(() =>
            compareVisual(readCompletedFrame(oldFrame), literalStyledFrame(target.marker)),
          ).toThrow();
          expect(snapshot().client).toBe(retained.client);
          expect(snapshot().adapter).toBe(retained.adapter);
          expect(snapshot().rendererEpoch).toBe(retained.rendererEpoch);
          await interaction!.sendInput({ kind: "text", data: target.token });
          await wait(
            () => readFileSync(target.input, "utf8").includes(target.token),
            "selected producer input",
          );
          trace.push({
            type: "public-window-selection",
            pane: target.paneId,
            linkId: link!.linkId,
            window: backing!.semanticWindowId,
            identity: target.identity,
            rendererEpoch: snapshot().rendererEpoch,
          });
        }
        expect(readFileSync(second!.input, "utf8")).toBe("SECOND_INPUT");
        expect(readFileSync(input, "utf8")).toBe("FIRST_RETURN_INPUT");
        trace.push({
          type: "selected-input-bytes",
          first: readFileSync(input).toString("hex"),
          second: readFileSync(second!.input).toString("hex"),
        });
        writeFileSync(input, ""); // Preserve the original later exact SSH input assertion.
        expect(native("display-message", "-p", "-t", second!.pane, identityFormat)).toBe(
          second!.identity,
        );
        expect(await kernel.identify(second!.pid)).toBe(second!.birth);
        expect(await kernel.identify(Number(producerPid))).toBe(producerWitness);
      }
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
        compareVisual(
          readCompletedFrame(contentFrame(completed.at(-1)!)),
          literalStyledFrame("BEFORE_SSH"),
        );
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
      if (second) {
        expect(native("display-message", "-p", "-t", second.pane, identityFormat)).toBe(
          second.identity,
        );
        expect(await kernel.identify(second.pid)).toBe(second.birth);
        expect(await kernel.identify(Number(producerPid))).toBe(producerWitness);
      }
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
