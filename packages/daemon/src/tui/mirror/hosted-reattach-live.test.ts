import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { defaultNodePtyAdapter } from "../../terminal/NodePtyAdapter.ts";
import type { PtyProcess } from "../../terminal/PtyAdapter.ts";
import { APP_HOST_SESSION, hostedCommandLine, hostCreateArgv, hostSetupArgvs } from "./hosted.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const socketName = `zz-hosted-reattach-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixture = fileURLToPath(
  new URL("../../../test-support/hosted-reattach-fixture.tsx", import.meta.url),
);

type TraceEvent = Readonly<{
  event: string;
  width?: number;
  height?: number;
  pid?: number;
  stdoutColumns?: number | null;
  stdoutRows?: number | null;
  ttySize?: string | null;
  full?: boolean;
  writtenRows?: number;
}>;

function runTmux(argv: readonly string[]): string {
  return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMUX: "" },
  }).trimEnd();
}

function traceEvents(path: string): TraceEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}

function paneGrid(target: string): { width: number; height: number; dead: boolean } {
  const [width, height, dead] = runTmux([
    "display-message",
    "-p",
    "-t",
    target,
    "#{pane_width}\t#{pane_height}\t#{pane_dead}",
  ]).split("\t");
  return { width: Number(width), height: Number(height), dead: dead === "1" };
}

function hostClients(): Array<{
  name: string;
  pid: number;
  tty: string;
  width: number;
  height: number;
  controlMode: string;
  session: string;
}> {
  const output = runTmux([
    "list-clients",
    "-t",
    `=${APP_HOST_SESSION}`,
    "-F",
    "#{client_name}\t#{client_pid}\t#{client_tty}\t#{client_width}\t#{client_height}\t#{client_control_mode}\t#{session_name}",
  ]);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [name, pid, tty, width, height, controlMode, session] = line.split("\t");
    return {
      name: name!,
      pid: Number(pid),
      tty: tty!,
      width: Number(width),
      height: Number(height),
      controlMode: controlMode!,
      session: session!,
    };
  });
}

describe.skipIf(!hasTmux || !hasBun)("hosted OpenTUI detach and reattach", () => {
  vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

  const root = mkdtempSync(join(tmpdir(), "tmux-ide-hosted-reattach-"));
  const tracePath = join(root, "renderer-trace.jsonl");
  const sourceSession = "zz-authoritative-source";
  const sourceMarker = "AUTHORITATIVE-SOURCE-ALIVE";
  const clients: PtyProcess[] = [];

  function attach(
    cols: number,
    rows: number,
  ): {
    client: PtyProcess;
    output: Buffer[];
  } {
    const output: Buffer[] = [];
    const client = defaultNodePtyAdapter.spawnSync(
      {
        shell: "tmux",
        args: ["-L", socketName, "-f", "/dev/null", "attach-session", "-t", `=${APP_HOST_SESSION}`],
        cwd: dirname(fixture),
        cols,
        rows,
        env: { ...process.env, TMUX: "", TERM: "xterm-256color", COLORTERM: "truecolor" },
        name: "xterm-256color",
        encoding: null,
      },
      { onData: (data) => output.push(data) },
    );
    clients.push(client);
    return { client, output };
  }

  function presentationText(output: readonly Buffer[]): string {
    return Buffer.concat(output).toString("utf8");
  }

  async function expectPresented(
    view: { client: PtyProcess; output: Buffer[] },
    expected: { width: number; height: number },
  ): Promise<void> {
    await vi.waitFor(
      () => {
        expect(paneGrid(`=${APP_HOST_SESSION}:0.0`)).toEqual({ ...expected, dead: false });
        expect(presentationText(view.output)).toContain("HOST-CHROME");
        // This is the regression oracle: chrome without this retained marker is
        // the user's blank terminal body, while source truth below stays alive.
        expect(presentationText(view.output)).toContain("RETAINED-PANE-SURFACE");
        expect(
          runTmux(["display-message", "-p", "-t", `${sourceSession}:0.0`, "#{pane_dead}"]),
        ).toBe("0");
        expect(runTmux(["capture-pane", "-p", "-t", `${sourceSession}:0.0`])).toContain(
          sourceMarker,
        );
      },
      { timeout: 20_000, interval: 100 },
    );
  }

  afterAll(() => {
    for (const client of clients) {
      try {
        client.kill("SIGKILL");
      } catch {
        // The isolated server kill below is authoritative cleanup.
      }
    }
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("repaints through reopen, repeated resize, and abrupt viewer death", async () => {
    runTmux([
      "new-session",
      "-d",
      "-s",
      sourceSession,
      `exec sh -c 'printf ${sourceMarker}; sleep 2147483647'`,
    ]);
    const commandLine = hostedCommandLine("bun", ["--conditions=browser", fixture], {
      TMUX_IDE_HOSTED: "1",
      TMUX_IDE_REATTACH_TRACE: tracePath,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
    runTmux(hostCreateArgv({ cwd: dirname(fixture), commandLine }));
    for (const argv of hostSetupArgvs()) runTmux(argv);
    await vi.waitFor(
      () =>
        expect(traceEvents(tracePath).some(({ event }) => event === "renderer-created")).toBe(true),
      { timeout: 20_000, interval: 100 },
    );
    const rendererPid = Number(
      runTmux(["display-message", "-p", "-t", `=${APP_HOST_SESSION}:0.0`, "#{pane_pid}"]),
    );
    expect(traceEvents(tracePath)).toContainEqual(
      expect.objectContaining({ event: "process-start", pid: rendererPid }),
    );

    // Initial viewer: a normal attach. Attaching and painting a viewer does not
    // itself synthesize an OpenTUI focus event; focus is a separate terminal
    // capability edge. Drive that parser edge directly after recording it.
    const first = attach(80, 24);
    await expectPresented(first, { width: 80, height: 24 });
    expect(traceEvents(tracePath).filter(({ event }) => event === "renderer-focus")).toEqual([]);
    runTmux(["send-keys", "-t", `=${APP_HOST_SESSION}:0.0`, "-H", "1b", "5b", "49"]);
    await vi.waitFor(
      () =>
        expect(traceEvents(tracePath).some(({ event }) => event === "renderer-focus")).toBe(true),
      { timeout: 10_000, interval: 50 },
    );

    // A browser/tab close can hide its viewport without disposing the PTY.
    // Keep that 80x24 wrapper attached, deliver blur, then open a differently
    // sized viewer. This is the exact stale-client coexistence observed in the
    // field; the host, root and retained surface must all adopt 132x41.
    runTmux(["send-keys", "-t", `=${APP_HOST_SESSION}:0.0`, "-H", "1b", "5b", "4f"]);
    await vi.waitFor(
      () =>
        expect(traceEvents(tracePath).some(({ event }) => event === "renderer-blur")).toBe(true),
      { timeout: 10_000, interval: 50 },
    );
    const reopened = attach(132, 41);
    await expectPresented(reopened, { width: 132, height: 41 });
    runTmux(["send-keys", "-t", `=${APP_HOST_SESSION}:0.0`, "-H", "1b", "5b", "49"]);
    await vi.waitFor(
      () => {
        const events = traceEvents(tracePath);
        expect(
          events.filter(({ event }) => event === "renderer-focus").length,
        ).toBeGreaterThanOrEqual(2);
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "process-sigwinch",
            pid: rendererPid,
            ttySize: "41 132",
          }),
        );
      },
      { timeout: 20_000, interval: 100 },
    );
    await vi.waitFor(
      () => {
        const events = traceEvents(tracePath);
        expect(events).toContainEqual(
          expect.objectContaining({ event: "root-resize", width: 132, height: 41 }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({ event: "surface-resize", width: 132, height: 40 }),
        );
      },
      { timeout: 10_000, interval: 50 },
    );
    const events = traceEvents(tracePath);
    const signal = events.findLast(({ event }) => event === "process-sigwinch")!;
    expect(signal).toMatchObject({
      pid: rendererPid,
      ttySize: "41 132",
      // Bun's cached stdout geometry is the stale value OpenTUI reads.
      stdoutColumns: 80,
      stdoutRows: 24,
    });
    expect(events.filter(({ event }) => event === "root-resize")).toEqual([
      expect.objectContaining({ width: 80, height: 24 }),
      expect.objectContaining({ width: 132, height: 41 }),
    ]);
    expect(events.filter(({ event }) => event === "surface-resize")).toEqual([
      expect.objectContaining({ width: 80, height: 23 }),
      expect.objectContaining({ width: 132, height: 40 }),
    ]);
    expect(events.filter(({ event, full }) => event === "surface-blit" && full === true)).toEqual([
      expect.objectContaining({ width: 80, height: 23, writtenRows: 23 }),
      expect.objectContaining({ width: 132, height: 40, writtenRows: 40 }),
    ]);
    const fullWalks = events.filter(
      ({ event, full }) => event === "surface-blit" && full === true,
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      traceEvents(tracePath).filter(({ event, full }) => event === "surface-blit" && full === true),
    ).toHaveLength(fullWalks);
    expect(hostClients()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: first.client.pid,
          width: 80,
          height: 24,
          controlMode: "0",
          session: APP_HOST_SESSION,
        }),
        expect.objectContaining({
          pid: reopened.client.pid,
          width: 132,
          height: 41,
          controlMode: "0",
          session: APP_HOST_SESSION,
        }),
      ]),
    );
    // Renderer and source truth outlive both views; only presentation geometry
    // is stale. This rules out pane death, daemon loss and renderer replacement.
    expect(
      Number(runTmux(["display-message", "-p", "-t", `=${APP_HOST_SESSION}:0.0`, "#{pane_pid}"])),
    ).toBe(rendererPid);
    expect(runTmux(["display-message", "-p", "-t", `${sourceSession}:0.0`, "#{pane_dead}"])).toBe(
      "0",
    );

    // Abruptly losing the newest viewer returns geometry to the first live
    // client without replacing either renderer or source truth.
    const initialSizeTransitions = events.filter(
      ({ event, width, height }) => event === "surface-resize" && width === 80 && height === 23,
    ).length;
    reopened.client.kill("SIGKILL");
    await vi.waitFor(
      () => {
        expect(hostClients().map(({ pid }) => pid)).toEqual([first.client.pid]);
        expect(paneGrid(`=${APP_HOST_SESSION}:0.0`)).toEqual({
          width: 80,
          height: 24,
          dead: false,
        });
        expect(
          traceEvents(tracePath).filter(
            ({ event, width, height }) =>
              event === "surface-resize" && width === 80 && height === 23,
          ),
        ).toHaveLength(initialSizeTransitions + 1);
      },
      { timeout: 20_000, interval: 100 },
    );

    // Reopening at the same effective size may need no resize edge; tmux still
    // has to deliver a complete retained presentation to the fresh client.
    const sameSize = attach(80, 24);
    await expectPresented(sameSize, { width: 80, height: 24 });

    // Repeated PTY resizes are the real terminal-drag path. Each authoritative
    // size must reach the root and force exactly one full retained-surface blit.
    for (const size of [
      { width: 100, height: 30 },
      { width: 144, height: 46 },
      { width: 96, height: 28 },
    ]) {
      const fullWalksBefore = traceEvents(tracePath).filter(
        ({ event, full }) => event === "surface-blit" && full === true,
      ).length;
      sameSize.client.resize(size.width, size.height);
      await vi.waitFor(
        () => {
          expect(paneGrid(`=${APP_HOST_SESSION}:0.0`)).toEqual({ ...size, dead: false });
          const next = traceEvents(tracePath);
          expect(next).toContainEqual(expect.objectContaining({ event: "root-resize", ...size }));
          expect(next).toContainEqual(
            expect.objectContaining({
              event: "surface-resize",
              width: size.width,
              height: size.height - 1,
            }),
          );
          expect(
            next.filter(({ event, full }) => event === "surface-blit" && full === true),
          ).toHaveLength(fullWalksBefore + 1);
        },
        { timeout: 20_000, interval: 100 },
      );
    }

    const finalEvents = traceEvents(tracePath);
    expect(finalEvents.filter(({ event }) => event === "process-start")).toHaveLength(1);
    expect(
      Number(runTmux(["display-message", "-p", "-t", `=${APP_HOST_SESSION}:0.0`, "#{pane_pid}"])),
    ).toBe(rendererPid);
    expect(runTmux(["capture-pane", "-p", "-t", `${sourceSession}:0.0`])).toContain(sourceMarker);

    // Ten reopen/close cycles cover both a retained same-size presentation and
    // a differently-sized repaint. Every dead wrapper must leave tmux's client
    // inventory while the one renderer/source identity remains stable. Once a
    // cycle settles, no idle full-blit work is allowed to continue.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const size =
        cycle % 2 === 0
          ? { width: 96, height: 28 }
          : { width: 110 + cycle, height: 32 + (cycle % 3) };
      const viewer = attach(size.width, size.height);
      await expectPresented(viewer, size);
      expect(
        Number(runTmux(["display-message", "-p", "-t", `=${APP_HOST_SESSION}:0.0`, "#{pane_pid}"])),
      ).toBe(rendererPid);

      viewer.client.kill("SIGKILL");
      await vi.waitFor(
        () => {
          expect(hostClients().map(({ pid }) => pid)).not.toContain(viewer.client.pid);
          expect(paneGrid(`=${APP_HOST_SESSION}:0.0`)).toEqual({
            width: 96,
            height: 28,
            dead: false,
          });
        },
        { timeout: 20_000, interval: 50 },
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const settledFullBlits = traceEvents(tracePath).filter(
        ({ event, full }) => event === "surface-blit" && full === true,
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        traceEvents(tracePath).filter(
          ({ event, full }) => event === "surface-blit" && full === true,
        ),
      ).toHaveLength(settledFullBlits);
      expect(runTmux(["capture-pane", "-p", "-t", `${sourceSession}:0.0`])).toContain(sourceMarker);
    }
    expect(traceEvents(tracePath).filter(({ event }) => event === "process-start")).toHaveLength(1);
  });
});
