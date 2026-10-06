/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import {
  STOCK_CAPTURE_TAB_UNAVAILABLE,
  type CanonicalTerminalReplicaUpdate,
} from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "@tmux-ide/core";
import { createTerminalFastLane } from "@tmux-ide/daemon-client/terminal-fast-lane";
import { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";
import { PaneScopedTerminalSurface } from "./pane-scoped-terminal-surface.tsx";
import { registerPaneSurface } from "../pane-surface.tsx";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import {
  renderForTest,
  destroyTestRenderer,
  frameLines,
} from "../testing/renderer-harness.test.ts";

it("overlays only unavailable pane, hides old content and recovers its mounted surface in a new generation", async () => {
  registerPaneSurface();
  let generation = "00000000-0000-4000-8000-000000000001";
  const callbacks = new Map<
    string,
    { update: (u: CanonicalTerminalReplicaUpdate) => void; unavailable: (m: string) => void }
  >();
  const lane = createTerminalFastLane({
    address: { workspaceName: "tabs", generation },
    source: {
      subscribe: (a, update, onUnavailable) => {
        callbacks.set(a.semanticPaneId, { update, unavailable: onUnavailable! });
        return () => {};
      },
    },
    repair: {
      request: () => {
        throw Error("unavailable is not transient repair");
      },
    },
    control: {
      owns: () => true,
      request: async () => true,
      write: async () => "ok",
      resize: async () => "ok",
    },
  });
  const adapter = new TerminalFastLaneRendererAdapter(lane);
  const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
  const props = {
    adapter,
    width: 80,
    height: 8,
    defaultFg: 0xffffff,
    defaultBg: 0x203040,
    terminalPalette: palette,
    searchHl: palette.searchHighlight,
    searchCur: palette.searchCurrent,
    scrollOffset: 0,
    paneFocused: false,
    sourceEpoch: 0,
    selRange: null,
    search: null,
  };
  const setup = await renderForTest(
    () => (
      <box flexDirection="row" width={160} height={8}>
        <PaneScopedTerminalSurface {...props} paneId="bad" />
        <PaneScopedTerminalSurface {...props} paneId="good" />
      </box>
    ),
    { width: 160, height: 8, consoleMode: "disabled" },
  );
  const emit = (pane: string, text: string) => {
    const blank = blankTerminalReplicaSnapshot(80, 8);
    const snapshot = {
      ...blank,
      grid: [
        {
          ...blank.grid[0]!,
          cells: blank.grid[0]!.cells.map((c, x) => ({ ...c, grapheme: text[x] ?? "" })),
        },
        ...blank.grid.slice(1),
      ],
    };
    callbacks.get(pane)!.update({
      type: "terminal.seed",
      workspaceName: "tabs",
      semanticPaneId: pane,
      generation,
      incarnation: generation + ":0",
      revision: 0,
      cols: 80,
      rows: 8,
      snapshot,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
    });
  };
  try {
    emit("bad", "OLD BAD CONTENT");
    emit("good", "HEALTHY SIBLING");
    await setup.renderOnce();
    expect(frameLines(setup.captureCharFrame())[0]).toContain("OLD BAD CONTENT");
    const stale = callbacks.get("bad")!;
    stale.unavailable(STOCK_CAPTURE_TAB_UNAVAILABLE);
    await setup.renderOnce();
    const lines = frameLines(setup.captureCharFrame());
    const left = lines
      .map((l) => l.slice(0, 80))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(left).not.toContain("OLD BAD CONTENT");
    expect(left.replace(/\s+/g, "")).toContain(STOCK_CAPTURE_TAB_UNAVAILABLE.replace(/\s+/g, ""));
    expect(lines[0]!.slice(80)).toContain("HEALTHY SIBLING");
    expect(adapter.paneSelectionSnapshot("bad")).toBeNull();
    generation = "00000000-0000-4000-8000-000000000002";
    lane.replaceGeneration({ workspaceName: "tabs", generation });
    emit("bad", "RECOVERED BUNDLED");
    emit("good", "HEALTHY SIBLING");
    stale.unavailable("stale");
    await setup.renderOnce();
    expect(frameLines(setup.captureCharFrame())[0]).toContain("RECOVERED BUNDLED");
    expect(frameLines(setup.captureCharFrame()).join(" ")).not.toContain("saved tab cells");
  } finally {
    destroyTestRenderer(setup);
    adapter.dispose();
    lane.dispose();
  }
});
