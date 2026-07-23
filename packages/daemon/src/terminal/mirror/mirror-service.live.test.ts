/**
 * MirrorService LIVE verification (m43 card 1) against a real tmux server on
 * an isolated `-L` socket (zz- prefixed, PID-scoped, killed in afterAll).
 *
 * Scenarios (the card's acceptance):
 *  1. 3-pane session → three independent subscribers each get an atomic seed
 *     and only their own pane's deltas; input round-trips.
 *  2. Flood one pane with a stalled reader → `%pause` observed; after the
 *     sticky-set recovery the quiet sibling keeps flowing and the flooded
 *     pane gets a fresh atomic seed.
 *  3. Dispose leaves no clients attached and never wedges the server
 *     (kill-server still works afterwards).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";
import type { MirrorPaneEvent } from "./events.ts";
import { MirrorService } from "./mirror-service.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `zz-m43-mirror-${process.pid}-${randomUUID().slice(0, 8)}`;
const session = "zz-mirror-src";
const dec = new TextDecoder();

function runTmux(argv: readonly string[]): string {
  return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMUX: "" },
  }).trimEnd();
}

interface Transcript {
  events: MirrorPaneEvent[];
  onEvent: (event: MirrorPaneEvent) => void;
}

function transcript(): Transcript {
  const events: MirrorPaneEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

function textOf(events: readonly MirrorPaneEvent[]): string {
  return events
    .filter((event) => event.type === "seed" || event.type === "delta")
    .map((event) => dec.decode((event as { data: Uint8Array }).data))
    .join("");
}

function deltaTextAfter(events: readonly MirrorPaneEvent[], fromIndex: number): string {
  return events
    .slice(fromIndex)
    .filter((event) => event.type === "delta")
    .map((event) => dec.decode((event as { data: Uint8Array }).data))
    .join("");
}

describe.skipIf(!hasTmux)("MirrorService live", () => {
  vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

  afterAll(() => {
    spawnSync("tmux", ["-L", socketName, "kill-server"], {
      stdio: "ignore",
      env: { ...process.env, TMUX: "" },
    });
    // kill-server does not always unlink the socket file on macOS.
    try {
      rmSync(
        join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, socketName),
      );
    } catch {
      // best effort
    }
  });

  it("serves three independent pane subscribers, survives a flood stall, and disposes clean", async () => {
    // ── Build the source session: one window, three titled `sh` panes (a
    // deterministic shell — a slow user zsh would still be starting when the
    // seed captures run) ────────────────────────────────────────────────────
    runTmux(["new-session", "-d", "-s", session, "-x", "200", "-y", "50", "sh"]);
    runTmux(["split-window", "-d", "-t", session, "sh"]);
    runTmux(["split-window", "-d", "-t", session, "sh"]);
    runTmux(["select-layout", "-t", session, "tiled"]);
    const runtimePanes = runTmux(["list-panes", "-t", session, "-F", "#{pane_id}"]).split("\n");
    expect(runtimePanes).toHaveLength(3);
    const titles = ["mirror-live-A", "mirror-live-B", "mirror-live-C"] as const;
    runtimePanes.forEach((pane, index) => {
      runTmux(["select-pane", "-t", pane, "-T", titles[index]!]);
    });
    // Distinct pre-subscribe content (arithmetic so the echoed command line
    // cannot double-count the marker); wait until each marker is ON SCREEN so
    // the seed capture provably contains it.
    const markers = ["SEED_A_42", "SEED_B_42", "SEED_C_42"] as const;
    runTmux(["send-keys", "-t", runtimePanes[0]!, "echo SEED_A_$((21*2))", "Enter"]);
    runTmux(["send-keys", "-t", runtimePanes[1]!, "echo SEED_B_$((21*2))", "Enter"]);
    runTmux(["send-keys", "-t", runtimePanes[2]!, "echo SEED_C_$((21*2))", "Enter"]);
    await vi.waitFor(
      () => {
        runtimePanes.forEach((pane, index) => {
          expect(runTmux(["capture-pane", "-p", "-t", pane])).toContain(markers[index]!);
        });
      },
      { timeout: 15_000 },
    );

    // ── Identity join through a throwaway channel (describe releases it) ──
    let lastIo: MirrorControlChannel | null = null;
    const service = new MirrorService({
      createIo: (target, handlers) => {
        lastIo = new MirrorControlChannel({
          session: target,
          handlers,
          socketName,
          configFile: "/dev/null",
        });
        return lastIo;
      },
    });
    const described = await service.describeSession(session);
    expect(described.panes).toHaveLength(3);
    const idByTitle = new Map(described.panes.map((pane) => [pane.title, pane.semanticPaneId]));
    expect([...idByTitle.keys()].sort()).toEqual([...titles].sort());
    // The join stamped the panes durably.
    for (const pane of runtimePanes) {
      expect(runTmux(["show-options", "-p", "-t", pane, "@tmux_ide_pane_id"])).toContain(
        "@tmux_ide_pane_id",
      );
    }
    // Runtime addresses never cross the boundary.
    expect(JSON.stringify(described)).not.toMatch(/%[0-9]/);

    // ── Scenario 1: three subscribers, atomic seeds, isolated deltas ──────
    const a = transcript();
    const b = transcript();
    const c = transcript();
    const subA = await service.subscribe({
      session,
      semanticPaneId: idByTitle.get(titles[0])!,
      onEvent: a.onEvent,
    });
    const subB = await service.subscribe({
      session,
      semanticPaneId: idByTitle.get(titles[1])!,
      onEvent: b.onEvent,
    });
    const subC = await service.subscribe({
      session,
      semanticPaneId: idByTitle.get(titles[2])!,
      onEvent: c.onEvent,
    });

    await vi.waitFor(
      () => {
        for (const [t, marker] of [
          [a, "SEED_A_42"],
          [b, "SEED_B_42"],
          [c, "SEED_C_42"],
        ] as const) {
          const types = t.events.map((event) => event.type);
          expect(types[0]).toBe("reset");
          expect(types[1]).toBe("seed");
          expect(types.indexOf("cursor")).toBeGreaterThan(types.indexOf("seed"));
          expect(textOf(t.events)).toContain(marker);
        }
      },
      { timeout: 15_000 },
    );
    // One capture from one instant: the marker appears exactly once per seed.
    const seedA = textOf(a.events.filter((event) => event.type === "seed"));
    expect(seedA.split("SEED_A_42").length - 1).toBe(1);
    expect(seedA).not.toContain("SEED_B_42");

    // Deltas route only to their own pane's subscriber.
    const aBefore = a.events.length;
    const cBefore = c.events.length;
    runTmux(["send-keys", "-t", runtimePanes[1]!, "echo DELTA_B_$((21*2))", "Enter"]);
    await vi.waitFor(
      () => {
        expect(textOf(b.events)).toContain("DELTA_B_42");
      },
      { timeout: 10_000 },
    );
    expect(deltaTextAfter(a.events, aBefore)).not.toContain("DELTA_B_42");
    expect(deltaTextAfter(c.events, cBefore)).not.toContain("DELTA_B_42");

    // Input path: coalesced literals + named key, semantic address only.
    subC.sendText("echo LIVE_INPUT_$((6*7))");
    subC.sendKey("Enter");
    await vi.waitFor(
      () => {
        expect(textOf(c.events)).toContain("LIVE_INPUT_42");
      },
      { timeout: 10_000 },
    );

    // ── Scenario 2: flood + stalled reader → %pause → sticky recovery ─────
    const floodIo = lastIo!;
    const floodStart = a.events.length;
    runTmux(["send-keys", "-t", runtimePanes[0]!, "seq 1 999999999", "Enter"]);
    // The flood is demonstrably flowing before the reader stalls.
    await vi.waitFor(
      () => {
        expect(a.events.length).toBeGreaterThan(floodStart);
      },
      { timeout: 10_000 },
    );
    floodIo.stallReaderForTest();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    floodIo.resumeReaderForTest();

    // The flooded pane must observe backpressure and come back with a fresh
    // atomic seed batch strictly AFTER the pause (paused → resumed → reset/
    // seed). Scan the whole transcript in order — under ambient load tmux may
    // pause the client from the flood alone, even before the explicit stall.
    await vi.waitFor(
      () => {
        const pausedIndex = a.events.findIndex(
          (event) =>
            event.type === "flow" && event.state === "paused" && event.reason === "backpressure",
        );
        expect(pausedIndex).toBeGreaterThanOrEqual(0);
        const afterPause = a.events.slice(pausedIndex);
        expect(afterPause.some((event) => event.type === "flow" && event.state === "resumed")).toBe(
          true,
        );
        expect(afterPause.some((event) => event.type === "reset")).toBe(true);
        expect(afterPause.some((event) => event.type === "seed")).toBe(true);
      },
      { timeout: 30_000 },
    );
    runTmux(["send-keys", "-t", runtimePanes[0]!, "C-c", ""]);

    // The quiet sibling keeps flowing after recovery (sticky-set recipe): if
    // tmux paused it too, the recovery continued+reseeded it. The marker is
    // typed only after the resume, so its delivery proves the pane is live.
    runTmux(["send-keys", "-t", runtimePanes[1]!, "echo AFTER_RECOVERY_$((21*2))", "Enter"]);
    await vi.waitFor(
      () => {
        expect(textOf(b.events)).toContain("AFTER_RECOVERY_42");
      },
      { timeout: 15_000 },
    );

    // Fall-behind telemetry was retained from %extended-output framing.
    const telemetry = service.ageTelemetry(session);
    expect(telemetry).not.toBeNull();

    // ── Scenario 3: dispose hygiene ────────────────────────────────────────
    await subA.close();
    await subB.close();
    await subC.close();
    await service.dispose();
    await vi.waitFor(
      () => {
        expect(runTmux(["list-clients", "-t", session])).toBe("");
      },
      { timeout: 10_000 },
    );
    // The server is not wedged: it still answers, and kill-server (afterAll)
    // will succeed.
    expect(runTmux(["list-sessions", "-F", "#{session_name}"])).toContain(session);
  });
});
