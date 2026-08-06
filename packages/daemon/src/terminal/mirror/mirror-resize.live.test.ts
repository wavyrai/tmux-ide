/**
 * A mirror subscriber must survive the window being RESIZED (m50.2).
 *
 * The mirror rests on one promise: a subscriber either receives every byte of
 * its pane or is told it is degraded. Resizing was never a counterexample
 * because, until geometry ownership, nothing tmux-ide did ever resized an origin
 * window — every desktop attachment was size-passive, so a re-tile happened only
 * when a human did it in their own terminal. Now the app resizes the window
 * whenever its own window is dragged, so a re-tile under a live mirror is the
 * ordinary case.
 *
 * ── Why every resize here is client-driven ───────────────────────────────────
 *
 * `resize-window` is NOT a stand-in for what the app does, and using it as one
 * hides the bug: tmux sets the window's `window-size` to `manual` as a side
 * effect, so the window stops following its clients at all. A test written that
 * way passes while proving nothing about the path under test — measured here,
 * after a `resize-window` a freshly attached 120-column client left the window
 * at its pinned 88.
 *
 * So each case drives the size the way the renderer does: by resizing a real
 * attached client's PTY and letting `window-size latest` arbitrate. Each case
 * also gets its OWN session, because a window pinned to manual by one case
 * would silently disarm the next.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { defaultNodePtyAdapter } from "../NodePtyAdapter.ts";
import type { PtyProcess } from "../PtyAdapter.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import type { MirrorPaneEvent } from "./events.ts";
import { MirrorService } from "./mirror-service.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `zz-m50-resize-${process.pid}-${randomUUID().slice(0, 8)}`;
const dec = new TextDecoder();
const tmuxBin = hasTmux ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() : "tmux";

function runTmux(argv: readonly string[]): string {
  return execFileSync(tmuxBin, ["-L", socketName, "-f", "/dev/null", ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMUX: "" },
  }).trimEnd();
}

/** Everything the subscriber has been shown, seeds and deltas alike. */
function textOf(events: readonly MirrorPaneEvent[]): string {
  return events
    .filter((event) => event.type === "seed" || event.type === "delta")
    .map((event) => dec.decode((event as { data: Uint8Array }).data))
    .join("");
}

function windowWidth(session: string): string {
  return runTmux(["display-message", "-p", "-t", `${session}:0`, "#{window_width}"]);
}

describe.skipIf(!hasTmux)("a mirror subscriber survives a window resize", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const services: MirrorService[] = [];
  const clients: PtyProcess[] = [];

  afterAll(async () => {
    for (const client of clients) {
      try {
        client.kill("SIGKILL");
      } catch {
        // The server kill below reaps every client either way.
      }
    }
    for (const service of services) await service.dispose();
    spawnSync(tmuxBin, ["-L", socketName, "kill-server"], { stdio: "ignore" });
  });

  /** A fresh two-pane session with its own mirror service, isolated per case. */
  async function world(session: string) {
    runTmux(["new-session", "-d", "-s", session, "-x", "200", "-y", "50", "exec sh -i"]);
    runTmux(["split-window", "-t", `${session}:0`, "-d", "exec sh -i"]);
    const service = new MirrorService({
      createIo: (target, handlers) =>
        new MirrorControlChannel({
          session: target,
          handlers,
          socketName,
          configFile: "/dev/null",
        }),
    });
    services.push(service);
    const described = await service.describeSession(session);
    expect(described.panes.length).toBeGreaterThanOrEqual(2);
    return { service, semanticPaneId: described.panes[0]!.semanticPaneId };
  }

  /** A real client whose PTY size drives the window, as an owning attach does. */
  function attachClient(session: string, cols: number, rows: number): PtyProcess {
    const client = defaultNodePtyAdapter.spawnSync(
      {
        shell: tmuxBin,
        args: ["-L", socketName, "-f", "/dev/null", "attach", "-t", `=${session}`],
        cwd: "/tmp",
        cols,
        rows,
        env: { ...process.env, TMUX: "", TERM: "xterm-256color" },
        name: "xterm-256color",
        encoding: null,
      },
      { onData: () => undefined, onExit: () => undefined },
    );
    clients.push(client);
    return client;
  }

  /** Produce output in the mirrored pane and require the subscriber to see it. */
  async function requireStreaming(
    session: string,
    events: readonly MirrorPaneEvent[],
    label: string,
  ): Promise<void> {
    const marker = `${label}-${randomUUID().slice(0, 6)}`;
    runTmux(["send-keys", "-t", `${session}:0.0`, `echo ${marker}`, "Enter"]);
    await vi.waitFor(
      () => {
        expect(textOf(events)).toContain(marker);
      },
      { timeout: 20_000, interval: 100 },
    );
  }

  it("keeps streaming while an owning client resizes the window under it", async () => {
    const session = "zz-resize-owned";
    const { service, semanticPaneId } = await world(session);
    const events: MirrorPaneEvent[] = [];
    const sub = await service.subscribe({
      session,
      semanticPaneId,
      onEvent: (event) => events.push(event),
    });

    // Streaming before the resize, so a later failure is the resize and not a
    // subscription that never worked.
    await requireStreaming(session, events, "BEFORE");

    const owner = attachClient(session, 120, 34);
    await vi.waitFor(
      () => {
        expect(windowWidth(session)).toBe("120");
      },
      { timeout: 20_000, interval: 100 },
    );

    /*
     * The drag: a PTY resize on the owning client, which is exactly what the
     * renderer's cell-floored fit sends down the attachment.
     *
     * Bug this catches: the resize parks the subscriber's feed. `PaneFeed`
     * discards deltas while a capture is pending and HOLDS them while the
     * cursor probe is, so a probe that never resolves freezes the mirror
     * permanently — the seed paints, the node looks alive, and it never moves
     * again while the pane it claims to mirror carries on.
     */
    owner.resize(96, 28);
    await vi.waitFor(
      () => {
        expect(windowWidth(session)).toBe("96");
      },
      { timeout: 20_000, interval: 100 },
    );
    await requireStreaming(session, events, "AFTER");

    // A second drag, because the renderer sends a stream of them: a freeze that
    // only appears on the Nth resize is still a freeze.
    owner.resize(140, 40);
    await vi.waitFor(
      () => {
        expect(windowWidth(session)).toBe("140");
      },
      { timeout: 20_000, interval: 100 },
    );
    await requireStreaming(session, events, "AGAIN");

    await sub.close();
  });

  it("keeps streaming when the resize lands WHILE it is subscribing", async () => {
    /*
     * The ordering the desktop produces, which nothing else here covers.
     *
     * Turning the mirror deck on does two things at once: it re-leases the pane
     * stream (a fresh subscribe, which reseeds) and it shrinks the tiled area,
     * which makes the owning attachment resize. So the reseed's two probe
     * replies straddle the re-tile.
     */
    const session = "zz-resize-raced";
    const { service, semanticPaneId } = await world(session);
    const owner = attachClient(session, 160, 44);
    await vi.waitFor(
      () => {
        expect(windowWidth(session)).toBe("160");
      },
      { timeout: 20_000, interval: 100 },
    );

    const events: MirrorPaneEvent[] = [];
    // No await between the resize and the subscribe: the re-tile is in flight
    // while the reseed is issuing its capture and cursor probes.
    owner.resize(92, 30);
    const sub = await service.subscribe({
      session,
      semanticPaneId,
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(
      () => {
        expect(windowWidth(session)).toBe("92");
      },
      { timeout: 20_000, interval: 100 },
    );

    await requireStreaming(session, events, "RACED");
    await sub.close();
  });
});
