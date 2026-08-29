/* @jsxImportSource @opentui/solid */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { createCliRenderer, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { extend, useKeyboard } from "@opentui/solid";
import { TerminalDeliveryEnvelopeSchemaZ } from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  splitTerminalDeliveryChunks,
} from "@tmux-ide/core";
import { createRenderEffect, type Accessor } from "solid-js";

import {
  PaneSurfaceRenderable,
  type PaneSurfaceOptions,
  type TerminalPaneRenderSource,
} from "../src/tui/mirror/pane-surface.tsx";
import {
  SemanticPaneReplica,
  SemanticTerminalRenderSource,
} from "../src/tui/mirror/semantic-pane-render-source.ts";
import {
  createSemanticThemeSnapshot,
  createTerminalPaletteProjection,
} from "../src/tui/mirror/theme.ts";
import {
  installHostedSizeBridge,
  readControllingTtySize,
  type HostedTtySize,
} from "../src/tui/mirror/runtime/hosted-tty-size-bridge.ts";
import { renderWithTerminalDimensions } from "../src/tui/mirror/runtime/terminal-dimensions-owner.ts";
import {
  TuiApplicationLifecycle,
  installTuiHostSignalShutdown,
} from "../src/tui/mirror/runtime/application-lifecycle.ts";

const tracePath = process.env.TMUX_IDE_REATTACH_TRACE;
if (!tracePath) throw new Error("TMUX_IDE_REATTACH_TRACE is required");

function trace(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  appendFileSync(tracePath, `${JSON.stringify({ event, ...details })}\n`);
}

function ttySize(): string | null {
  try {
    return execFileSync("sh", ["-c", "stty size < /dev/tty"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function processViewport(): Readonly<Record<string, unknown>> {
  return {
    stdoutColumns: process.stdout.columns ?? null,
    stdoutRows: process.stdout.rows ?? null,
    ttySize: ttySize(),
  };
}

process.on("SIGWINCH", () => trace("process-sigwinch", { pid: process.pid, ...processViewport() }));
trace("process-start", { pid: process.pid, ...processViewport() });

class DiagnosticPaneSurfaceRenderable extends PaneSurfaceRenderable {
  constructor(ctx: RenderContext, options: PaneSurfaceOptions) {
    super(ctx, options);
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    trace("surface-resize", { width, height });
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer);
    trace("surface-frame", { width: this.width, height: this.height });
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    diagnostic_pane_surface: typeof DiagnosticPaneSurfaceRenderable;
  }
}

extend({ diagnostic_pane_surface: DiagnosticPaneSurfaceRenderable });

const generation = "00000000-0000-4000-8000-000000000001";
const nonce = "00000000-0000-4000-8000-000000000002";
const transactionId = "00000000-0000-4000-8000-000000000003";
const negotiated = negotiateTerminalDelivery(
  { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
  generation,
  nonce,
);
if (!negotiated.accepted) throw new Error("terminal negotiation failed");

const replica = new SemanticPaneReplica({
  negotiated: negotiated.negotiated,
  workspaceName: "workspace.hosted-reattach",
  semanticPaneId: "pane.fixture",
  ack: () => undefined,
  nack: () => undefined,
});
const snapshot = structuredClone(blankTerminalReplicaSnapshot(200, 80));
const retainedMarker = "RETAINED-PANE-SURFACE";
for (let row = 0; row < snapshot.rows; row += 1) {
  for (let column = 0; column < retainedMarker.length; column += 1) {
    snapshot.grid[row]!.cells[column]!.grapheme = retainedMarker[column]!;
  }
}
const bytes = encodeSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
const chunks = splitTerminalDeliveryChunks(transactionId, bytes);
replica.accept(
  TerminalDeliveryEnvelopeSchemaZ.parse({
    type: "terminal.delivery",
    workspaceName: "workspace.hosted-reattach",
    semanticPaneId: "pane.fixture",
    generation,
    incarnation: `${generation}:1`,
    deliveryNonce: nonce,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-v1",
    frame: "seed",
    baseRevision: null,
    canonicalRevision: 0,
    canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: chunks.length,
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: false,
  }),
);
for (const chunk of chunks) replica.accept(chunk);
const canonicalSource = new SemanticTerminalRenderSource();
canonicalSource.set(replica);
const source: TerminalPaneRenderSource = {
  scrollbackDepth: (paneId) => canonicalSource.scrollbackDepth(paneId),
  cursorState: (paneId) => canonicalSource.cursorState(paneId),
  blitPane: (paneId, buffers, width, height, scrollOffset, defaultFg, defaultBg, options) => {
    const result = canonicalSource.blitPane(
      paneId,
      buffers,
      width,
      height,
      scrollOffset,
      defaultFg,
      defaultBg,
      options,
    );
    trace("surface-blit", {
      width,
      height,
      full: options.full,
      writtenRows: options.dirtyRows.length,
    });
    return result;
  },
};
const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
const renderer = await createCliRenderer({
  autoFocus: false,
  exitOnCtrlC: false,
  targetFps: 30,
  useKittyKeyboard: null,
  consoleMode: "disabled",
});
const lifecycle = new TuiApplicationLifecycle({ destroyRenderer: () => renderer.destroy() });
const hostSignals = installTuiHostSignalShutdown(lifecycle, { hosted: true });
lifecycle.registerCloser("host-death-signals", hostSignals.dispose);
const ttySizeBridge = installHostedSizeBridge({
  hosted: true,
  renderer,
  readSize: () => {
    const size = readControllingTtySize();
    trace("bridge-size-read", {
      size,
      rendererWidth: renderer.width,
      rendererHeight: renderer.height,
    });
    return size;
  },
});
process.once("exit", () => ttySizeBridge.dispose());
renderer.on("focus", () => trace("renderer-focus"));
renderer.on("blur", () => trace("renderer-blur"));
renderer.on("resize", (width, height) => trace("renderer-resize", { width, height }));
renderer.on("frame", () => trace("renderer-frame"));
trace("renderer-created");

function RetainedPaneSurface(props: { dimensions: Accessor<HostedTtySize> }) {
  let paneSurface: DiagnosticPaneSurfaceRenderable | undefined;
  // The standalone Bun fixture does not run the production Solid build plugin,
  // so bind its one custom renderable to the canonical dimensions accessor.
  createRenderEffect(() => {
    const dimensions = props.dimensions();
    if (!paneSurface) return;
    paneSurface.width = dimensions.width;
    paneSurface.height = Math.max(1, dimensions.height - 1);
  });
  return (
    <box width={props.dimensions().width} height={props.dimensions().height} flexDirection="column">
      <text height={1}>
        HOST-CHROME {props.dimensions().width}x{props.dimensions().height}
      </text>
      <diagnostic_pane_surface
        ref={(surface) => (paneSurface = surface)}
        width={props.dimensions().width}
        height={Math.max(1, props.dimensions().height - 1)}
        mirror={source}
        paneId="pane.fixture"
        defaultFg={palette.foreground}
        defaultBg={palette.background}
        terminalPalette={palette}
        searchHl={palette.searchHighlight}
        searchCur={palette.searchCurrent}
        scrollOffset={0}
        paneFocused={true}
        contentVersion={replica.version}
        sourceEpoch={1}
      />
    </box>
  );
}

await renderWithTerminalDimensions(renderer)((dimensions) => {
  createRenderEffect(() => {
    const current = dimensions();
    trace("root-resize", { width: current.width, height: current.height, ...processViewport() });
  });
  useKeyboard((event) => {
    if (!(event.ctrl && event.name === "q")) return;
    // Real hosted Ctrl-Q is intercepted by tmux with exact client context.
    // A direct pane injection has no client identity and is consumed here.
    trace("renderer-ctrl-q-consumed");
  });
  return <RetainedPaneSurface dimensions={dimensions} />;
});
