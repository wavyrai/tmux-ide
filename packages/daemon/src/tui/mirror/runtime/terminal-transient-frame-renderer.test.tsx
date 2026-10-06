/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { CliRenderEvents } from "@opentui/core";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import { createTerminalFastLane } from "@tmux-ide/daemon-client/terminal-fast-lane";
import type {
  MirrorSubscribeRequest,
  MirrorSubscription,
} from "../../../terminal/mirror/mirror-service.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../../../terminal/session-runtime/terminal-replica-owner.ts";
import { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";
import { registerPaneSurface } from "../pane-surface.tsx";
import {
  renderForTest,
  destroyTestRenderer,
  frameLines,
} from "../testing/renderer-harness.test.ts";
import {
  colorToPackedRgb,
  createSemanticThemeSnapshot,
  createTerminalPaletteProjection,
} from "../theme.ts";

const generation = "00000000-0000-4000-8000-000000000005";
const paneId = "pane.frame";
const foreground = 0x1fad61;
const images = {
  old: { rows: ["SENTINEL", "OLD-A", "old-tail", ""], cursor: [2, 2] },
  narrow: { rows: ["SENTINEL", "NEW-B", "new-row"], cursor: [4, 3] },
  wide: { rows: ["SENTINEL", "WIDE-C", "wide-tail", ""], cursor: [6, 2] },
} as const;
type Image = keyof typeof images;
type Frame = {
  ordinal: number;
  stage: string;
  cols: number;
  rows: number;
  allowed: Image[];
  lines: string[];
  sentinelColors: number[];
  cursor: { x: number; y: number; visible: boolean };
};
function matches(frame: Frame, image: Image): boolean {
  const expected = images[image];
  const lines = Array.from({ length: 4 }, (_, y) =>
    (y < frame.rows ? (expected.rows[y] ?? "").slice(0, frame.cols).padEnd(frame.cols) : "").padEnd(
      12,
    ),
  );
  return (
    JSON.stringify(frame.lines) === JSON.stringify(lines) &&
    frame.cursor.visible &&
    frame.cursor.x === expected.cursor[0] &&
    frame.cursor.y === expected.cursor[1]
  );
}
function checkFrame(frame: Frame): void {
  if (frame.lines.length !== 4 || frame.lines.some((line) => line.length !== 12))
    throw Error("frame dimensions");
  if (
    frame.sentinelColors.length !== 8 ||
    frame.sentinelColors.some((color) => color !== foreground)
  )
    throw Error("sentinel style");
  if (!frame.allowed.some((image) => matches(frame, image)))
    throw Error("mixed grid/cursor or partial frame");
}
function layout(cols: number, rows: number) {
  return {
    type: "layout" as const,
    session: "frame-test",
    semanticWindowId: "window.frame",
    windowName: "frame",
    currentWindow: true,
    cols,
    rows,
    zoomed: false,
    paneBorderStatus: "off" as const,
    panes: [{ semanticPaneId: paneId, left: 0, top: 0, width: cols, height: rows, active: true }],
  };
}
function paintBytes(image: Image): Uint8Array {
  return new TextEncoder().encode(
    "\x1b[2J\x1b[H\x1b[38;2;31;173;97mSENTINEL\x1b[0m" +
      images[image].rows
        .slice(1)
        .map((row, i) => `\x1b[${i + 2};1H${row}`)
        .join(""),
  );
}

it("records every completed native draw across controlled layout/reset/grid/cursor handoffs", async () => {
  registerPaneSurface();
  const receiptRoot = mkdtempSync(join(tmpdir(), "tmux-frame-handoff-"));
  const frames: Frame[] = [],
    errors: string[] = [];
  const operations: unknown[] = [];
  const cleanup: Array<() => void | Promise<void>> = [];
  const cleanupErrors: string[] = [];
  const negativeControls: Frame[] = [];
  let failure: string | undefined;
  let rendererDestroyed = false;
  const bounded = async <T,>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("fixture lifecycle deadline")), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let request!: MirrorSubscribeRequest;
  let reseeds = 0,
    closed = false;
  const mirror = {
    subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
      request = candidate;
      queueMicrotask(() => {
        candidate.onLayout?.(layout(12, 4));
        candidate.onEvent({ type: "reset", cols: 12, rows: 4 });
        candidate.onEvent({ type: "seed", data: paintBytes("old") });
        candidate.onEvent({ type: "cursor", x: 1, y: 1 });
      });
      return {
        session: candidate.session,
        semanticPaneId: candidate.semanticPaneId,
        freeze() {},
        thaw() {},
        reseed() {
          reseeds++;
        },
        sendText() {},
        sendKey() {},
        close: async () => {
          closed = true;
        },
      };
    },
  };
  try {
    const owner = new SessionRuntimeTerminalReplicaOwner(
      generation,
      "frame-test",
      paneId,
      mirror as never,
      {
        incarnation: "frame:0",
        initialRevision: 0,
        onFault: (error) => errors.push(String(error)),
      },
    );
    cleanup.push(() => owner.dispose());
    let deliver: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
    const lane = createTerminalFastLane({
      address: { workspaceName: "frame-test", generation },
      source: {
        subscribe: (_address, listener) => {
          deliver = listener;
          return () => {
            deliver = undefined;
          };
        },
      },
      repair: {
        request: () => {
          errors.push("unexpected repair");
        },
      },
      control: {
        owns: () => true,
        request: async () => true,
        write: async () => "ok",
        resize: async () => "ok",
      },
    });
    cleanup.push(() => lane.dispose());
    const adapter = new TerminalFastLaneRendererAdapter(lane);
    cleanup.push(() => adapter.dispose());
    const [version, setVersion] = createSignal(0);
    const [view, setView] = createSignal({ cols: 12, rows: 4 });
    const release = adapter.subscribePaneVersion(paneId, () => setVersion((v) => v + 1));
    cleanup.push(release);
    let latestRevision = -1;
    const canonical = await bounded(
      owner.subscribe((update) => {
        latestRevision = update.revision;
        deliver?.(update);
      }),
    );
    cleanup.push(() => canonical.close());
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    const setup = await renderForTest(
      () => (
        <pane_surface
          width={view().cols}
          height={view().rows}
          mirror={adapter.renderSource}
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
      { width: 12, height: 4, consoleMode: "disabled" },
    );
    cleanup.push(() => {
      destroyTestRenderer(setup);
      rendererDestroyed = setup.renderer.isDestroyed;
    });
    let stage = "baseline",
      allowed: Image[] = ["old"],
      recording = false;
    const record = () => {
      if (!recording) return;
      try {
        const cursor = setup.renderer.getCursorState();
        const colors = setup
          .captureSpans()
          .lines[0]!.spans.flatMap((span) => [...span.text].map(() => colorToPackedRgb(span.fg)))
          .slice(0, 8);
        const frame: Frame = {
          ordinal: frames.length,
          stage,
          ...view(),
          allowed: [...allowed],
          lines: frameLines(setup.captureCharFrame()),
          sentinelColors: colors,
          cursor: { x: cursor.x, y: cursor.y, visible: cursor.visible },
        };
        frames.push(frame);
        if (frames.length > 128) throw Error("frame receipt limit");
        checkFrame(frame);
      } catch (error) {
        errors.push(String(error));
      }
    };
    setup.renderer.on(CliRenderEvents.FRAME, record);
    cleanup.push(() => {
      recording = false;
      setup.renderer.off(CliRenderEvents.FRAME, record);
    });
    const draw = async (name: string, choices: Image[]) => {
      stage = name;
      allowed = choices;
      const before = frames.length;
      await setup.renderOnce();
      expect(frames.length).toBeGreaterThan(before);
      expect(errors).toEqual([]);
    };
    const settleRevision = async (prior: number) => {
      const deadline = Date.now() + 1000;
      while (latestRevision <= prior && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(latestRevision).toBeGreaterThan(prior);
    };
    await setup.renderOnce();
    recording = true;
    await draw("baseline", ["old"]);
    let previous: Image = "old";
    for (const [next, cols, rows] of [
      ["narrow", 8, 3],
      ["wide", 12, 4],
    ] as const) {
      const observed = layout(cols, rows);
      operations.push({ type: "layout", event: observed });
      stage = `${next}:layout`;
      allowed = [previous];
      request.onLayout?.(observed);
      const target = observed.panes[0]!;
      adapter.setNativePaneGeometries([
        { paneId: target.semanticPaneId, cols: target.width, rows: target.height },
      ]);
      setView({ cols: target.width, rows: target.height });
      await draw(stage, [previous]);
      request.onEvent({ type: "reset", cols, rows });
      operations.push({ type: "reset", cols, rows });
      await draw(`${next}:reset`, [previous]);
      request.onEvent({ type: "seed", data: paintBytes(next) });
      operations.push({ type: "seed", image: next });
      await draw(`${next}:grid-staged`, [previous]);
      const prior = latestRevision;
      stage = `${next}:cursor-admission`;
      allowed = [previous, next];
      request.onEvent({
        type: "cursor",
        x: images[next].cursor[0] - 1,
        y: images[next].cursor[1] - 1,
      });
      operations.push({ type: "cursor", image: next });
      await settleRevision(prior);
      await draw(`${next}:settled`, [next]);
      previous = next;
    }
    expect(reseeds).toBe(2);
    const settled = frames.find((frame) => frame.stage === "narrow:settled")!;
    const corruptCell = structuredClone(settled);
    corruptCell.lines[0] = "?" + corruptCell.lines[0]!.slice(1);
    expect(() => checkFrame(corruptCell)).toThrow("mixed grid/cursor or partial frame");
    const mixedCursor = structuredClone(settled);
    mixedCursor.cursor.x = images.old.cursor[0];
    mixedCursor.cursor.y = images.old.cursor[1];
    expect(() => checkFrame(mixedCursor)).toThrow("mixed grid/cursor or partial frame");
    const corruptStyle = structuredClone(settled);
    corruptStyle.sentinelColors[0] = 0;
    expect(() => checkFrame(corruptStyle)).toThrow("sentinel style");
    negativeControls.push(corruptCell, mixedCursor, corruptStyle);
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    for (const dispose of cleanup.reverse()) {
      try {
        await bounded(Promise.resolve().then(dispose));
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    const source = fileURLToPath(import.meta.url);
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const coreEntry = fileURLToPath(import.meta.resolve("@opentui/core"));
    writeFileSync(
      join(receiptRoot, "receipt.json"),
      JSON.stringify(
        {
          scope:
            "Controlled MirrorService events through real owner, lane, adapter, PaneSurface and native test renderer FRAME completion; no live PTY or physical terminal paint claim.",
          bun: Bun.version,
          sourceSha256: hash(source),
          coreEntry,
          coreEntrySha256: hash(coreEntry),
          sourceHashes: Object.fromEntries(
            [
              "./terminal-fast-lane-renderer-adapter.ts",
              "../pane-surface.tsx",
              "../../../terminal/session-runtime/terminal-replica-owner.ts",
              "../../../../../../pnpm-lock.yaml",
            ].map((path) => [path, hash(fileURLToPath(new URL(path, import.meta.url)))]),
          ),
          frames,
          operations,
          errors,
          negativeControls,
          reseeds,
          failure,
          cleanup: { closed, rendererDestroyed, errors: cleanupErrors },
        },
        null,
        2,
      ),
    );
    console.log(`Transient frame receipt: ${join(receiptRoot, "receipt.json")}`);
    expect(errors).toEqual([]);
    expect(cleanupErrors).toEqual([]);
    expect(closed).toBe(true);
    expect(rendererDestroyed).toBe(true);
  }
}, 10000);
