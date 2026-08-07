/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import { stableAppWindowInstanceId } from "../../../../packages/daemon/src/lib/app-window-state.ts";
import { deriveConnectionHealth } from "../runtime/connection-health.ts";
import { terminalIssueFaultLabel } from "../runtime/connection-recovery.ts";
import type { DesktopConnectionHealth } from "../runtime/connection-health.ts";
import { MirrorPaneNode } from "./mirror-pane-node.tsx";
import {
  WIDGET_MARKER_CONCEAL_PREFIX,
  WIDGET_MARKER_CONCEAL_SUFFIX,
  widgetMarkerAnnouncement,
} from "@tmux-ide/contracts";
import { PaneMirrorController, type PaneMirrorControllerState } from "./pane-mirror-controller.ts";
import {
  createRecordingMirrorRendererFactory,
  createScriptedPaneStream,
} from "./mirror-pane-fixture.ts";

const PANE_A = "pane.workspace.a1";

const disposers: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function seedBatch(text: string, held: readonly string[] = []) {
  const encoder = new TextEncoder();
  return {
    reset: { cols: 100, rows: 30 },
    seed: encoder.encode(text),
    held: held.map((chunk) => encoder.encode(chunk)),
    cursor: { x: 1, y: 2 },
  };
}

function mountNodeHarness(
  options: { readonly faultLabelFor?: (code: string) => string | null } = {},
) {
  const stream = createScriptedPaneStream();
  const rendering = createRecordingMirrorRendererFactory();
  const [controllerState, setControllerState] = createSignal<PaneMirrorControllerState | null>(
    null,
  );
  const controller = new PaneMirrorController({
    transport: stream.transport,
    workspaceName: "workspace-a",
    panes: [PANE_A],
    onStateChanged: setControllerState,
  });
  setControllerState(controller.state());
  const connection = (): DesktopConnectionHealth =>
    deriveConnectionHealth(controllerState()?.transport ?? null, { ok: true });
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(
    () => (
      <MirrorPaneNode
        pane={PANE_A}
        title="Agent A"
        state={controllerState()?.panes.get(PANE_A) ?? { kind: "connecting" }}
        connection={connection()}
        faultLabel={(() => {
          const fault = controllerState()?.fault;
          return fault && options.faultLabelFor ? options.faultLabelFor(fault.code) : null;
        })()}
        registerSink={(sink) => controller.registerPaneSink(PANE_A, sink)}
        onRetry={() => controller.retry()}
        rendererFactory={rendering.factory}
      />
    ),
    host,
  );
  disposers.push(() => {
    dispose();
    controller.dispose();
  });
  controller.start();
  return { stream, rendering, controller, host };
}

describe("mirror pane node", () => {
  it("applies a seed-batch as exactly ONE render commit", async () => {
    const h = mountNodeHarness();
    await flush();
    await h.stream.latest().emit(PANE_A, {
      type: "seed-batch",
      batch: seedBatch("screen", ["held-1", "held-2"]),
    });
    await flush();
    const commits = h.rendering.renderers[0]!.commits;
    expect(commits).toEqual([
      {
        kind: "seed-commit",
        reset: { cols: 100, rows: 30 },
        seed: "screen",
        held: ["held-1", "held-2"],
        cursor: { x: 1, y: 2 },
      },
    ]);
    const node = h.host.querySelector(".mirror-pane-node")!;
    expect(node.getAttribute("data-state")).toBe("live");
    expect(node.getAttribute("data-grid")).toBe("100x30");
    expect(node.getAttribute("data-painted")).toBe("true");
  });

  /*
   * The mirror's own detection point (m49.7).
   *
   * A mirror pane is repainted from `capture-pane` whenever its lease is
   * renewed, so on this path a marker can arrive inside a SEED with no delta
   * behind it at all. Bug this catches: detection wired only to live output, so
   * a widget renders while a pane streams and then vanishes — or never appears
   * — the moment the stream re-seeds, which is exactly when a user reconnects.
   */
  it("renders a widget from a marker that arrived in a seed batch", async () => {
    const h = mountNodeHarness();
    await flush();
    const renderer = h.rendering.renderers[0]!;
    const announcement = widgetMarkerAnnouncement("markdown", { text: "# Seeded\n\nBody." });
    renderer.setCellRows([
      {
        cells: [
          ...announcement
            .replaceAll(WIDGET_MARKER_CONCEAL_PREFIX, "")
            .replaceAll(WIDGET_MARKER_CONCEAL_SUFFIX, "")
            .trimEnd(),
        ],
        wrapped: false,
      },
    ]);
    await h.stream.latest().emit(PANE_A, {
      type: "seed-batch",
      batch: seedBatch(announcement),
    });
    await flush();

    const node = h.host.querySelector(".mirror-pane-node")!;
    await vi.waitFor(() => expect(node.getAttribute("data-widget")).toBe("markdown"));
    expect(node.querySelector(".widget-surface h1")?.textContent).toBe("Seeded");
    // The emulator is still mounted and still streaming underneath it.
    expect(node.querySelector(".mirror-pane-node__viewport")).not.toBeNull();

    // A later seed without the marker takes the widget away again.
    renderer.setCellRows([{ cells: [..."$ "], wrapped: false }]);
    await h.stream.latest().emit(PANE_A, { type: "seed-batch", batch: seedBatch("$ ") });
    await flush();
    await vi.waitFor(() => expect(node.getAttribute("data-widget")).toBe(null));
  });

  /*
   * A reseed that truncated the marker leaves the pane a PANE (m49.7).
   *
   * The marker can outrun the seed window — `capture-pane -S -2000` — so a
   * reconnect can deliver its tail without its head. Bug this catches: a
   * detector that recovers "enough" of a marker to render something. Half a
   * payload is strictly worse than none: the user loses the pane and the text
   * that was in it, with nothing on screen saying why.
   */
  it("stays a plain terminal when a seed delivered only part of a marker", async () => {
    const h = mountNodeHarness();
    await flush();
    const renderer = h.rendering.renderers[0]!;
    const announcement = widgetMarkerAnnouncement("markdown", {
      text: "a document long enough that its marker wraps well past one row",
    });
    const line = announcement
      .replaceAll(WIDGET_MARKER_CONCEAL_PREFIX, "")
      .replaceAll(WIDGET_MARKER_CONCEAL_SUFFIX, "")
      .trimEnd();
    const characters = [...line];
    const columns = 40;
    const rows = [];
    for (let offset = 0; offset < characters.length; offset += columns) {
      rows.push({ cells: characters.slice(offset, offset + columns), wrapped: offset > 0 });
    }
    expect(rows.length).toBeGreaterThan(2);
    // Head gone: exactly what a window that scrolled past the marker returns.
    renderer.setCellRows(rows.slice(2));

    await h.stream.latest().emit(PANE_A, { type: "seed-batch", batch: seedBatch(line) });
    await flush();

    const node = h.host.querySelector(".mirror-pane-node")!;
    // Give the debounced scan the same room the passing case gets, so this
    // cannot pass merely by being asserted too early.
    await new Promise((done) => setTimeout(done, 80));
    expect(node.getAttribute("data-widget")).toBe(null);
    expect(node.querySelector(".widget-surface")).toBeNull();
    expect(node.getAttribute("data-painted")).toBe("true");
  });

  it("writes live deltas and cursor moves after the seed", async () => {
    const h = mountNodeHarness();
    await flush();
    const session = h.stream.latest();
    await session.emit(PANE_A, { type: "seed-batch", batch: seedBatch("screen") });
    await session.emit(PANE_A, { type: "output", bytes: new TextEncoder().encode("delta") });
    session.emit(PANE_A, { type: "cursor", x: 7, y: 8 });
    await flush();
    const kinds = h.rendering.renderers[0]!.commits.map((commit) => commit.kind);
    expect(kinds).toEqual(["seed-commit", "write", "cursor"]);
  });

  it("shows the honest ended state when the pane closes", async () => {
    const h = mountNodeHarness();
    await flush();
    const session = h.stream.latest();
    await session.emit(PANE_A, { type: "seed-batch", batch: seedBatch("screen") });
    session.emit(PANE_A, { type: "closed" });
    await flush();
    const node = h.host.querySelector(".mirror-pane-node")!;
    expect(node.getAttribute("data-state")).toBe("ended");
    expect(node.textContent).toContain("Pane ended");
  });

  it("shows and clears the flow-paused indicator", async () => {
    const h = mountNodeHarness();
    await flush();
    const session = h.stream.latest();
    await session.emit(PANE_A, { type: "seed-batch", batch: seedBatch("screen") });
    session.emit(PANE_A, { type: "flow", state: "paused", reason: "backpressure" });
    await flush();
    expect(h.host.querySelector(".mirror-pane-node__flow")?.textContent).toContain("Stream paused");
    session.emit(PANE_A, { type: "flow", state: "resumed", reason: "backpressure" });
    await flush();
    expect(h.host.querySelector(".mirror-pane-node__flow")).toBeNull();
  });

  it("re-letterboxes the render when the canvas resizes its card", async () => {
    // The deck shrinks its nodes to stay on screen, so the card's size changes
    // under a mirror that never votes on size: the fit has to follow it.
    const callbacks: ResizeObserverCallback[] = [];
    class StubResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    const h = mountNodeHarness();
    await flush();
    await h.stream.latest().emit(PANE_A, { type: "seed-batch", batch: seedBatch("screen") });
    await flush();
    expect(callbacks).toHaveLength(1);
    callbacks[0]!([], {} as ResizeObserver);
    expect(h.rendering.renderers[0]!.commits.at(-1)).toEqual({ kind: "fit" });
  });

  it("derives a reconnecting overlay from a live stream drop", async () => {
    const h = mountNodeHarness();
    await flush();
    const session = h.stream.latest();
    await session.emit(PANE_A, { type: "seed-batch", batch: seedBatch("screen") });
    session.end({ code: "stream-closed", reason: "socket dropped", retryable: true });
    await flush();
    const node = h.host.querySelector(".mirror-pane-node")!;
    expect(node.getAttribute("data-connection")).toBe("reconnecting");
    expect(node.textContent).toContain("Reconnecting to the pane stream");
  });
});

describe("mirror node identity", () => {
  it("derives the durable node id from the terminal source identity", () => {
    const id = stableAppWindowInstanceId({ kind: "terminal", terminalSourceId: PANE_A });
    expect(id).toBe(stableAppWindowInstanceId({ kind: "terminal", terminalSourceId: PANE_A }));
    expect(id).toMatch(/^window-terminal-pane\.workspace\.a1-0-/u);
  });

  it("names the cause behind a stopped stream when the vocabulary knows it", async () => {
    const h = mountNodeHarness({ faultLabelFor: terminalIssueFaultLabel });
    await flush();
    h.stream.latest().end({
      code: "interactive-viewer-conflict",
      reason: "A requested pane already has an interactive viewer.",
      retryable: false,
    });
    await flush();
    const text = h.host.querySelector(".mirror-pane-node__state")!.textContent ?? "";
    expect(text).toContain("Pane stream stopped");
    expect(text).toContain("A requested pane already has an interactive viewer.");
    expect(text).toContain("Cause: another viewer already holds that pane.");
  });
});
