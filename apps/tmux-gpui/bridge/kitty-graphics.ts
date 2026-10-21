/**
 * Kitty graphics on the bridge: per-pane image registries from the daemon,
 * placements resolved against the exact snapshots the bridge publishes, and
 * image bytes pulled lazily — only digests a visible placement needs and the
 * native window does not already hold — then forwarded as bounded chunk lines.
 */
import { z } from "zod";
import { resolveKittyImagePlacements } from "../../../packages/core/src/kitty-placeholders.ts";
import {
  TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES,
  TerminalGraphicsBlobSchemaZ,
  TerminalGraphicsDigestSchemaZ,
  TerminalGraphicsPlacementSchemaZ,
  type TerminalGraphicsBlob,
  type TerminalGraphicsState,
} from "../../../packages/contracts/src/terminal-graphics.ts";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";
import type { Layout } from "./topology.ts";
import { contentRect } from "./window-canvas.ts";

/** Digests the native window already holds, handed to each new pane helper. */
export const KITTY_KNOWN_ENV = "TMUX_IDE_KITTY_KNOWN";
export const MAX_KNOWN_DIGESTS = 2048;

/**
 * A placement as the window sees it. `image` names the program's image (pane
 * and kitty image id): when a program redraws that id, the window swaps in the
 * new bytes as soon as they arrive, without a new publication.
 */
export const KeyedPlacementSchemaZ = TerminalGraphicsPlacementSchemaZ.extend({
  image: z.string().min(1).max(600),
}).strict();
export type KeyedPlacement = z.infer<typeof KeyedPlacementSchemaZ>;

export const paneGraphicsSchema = z
  .array(
    z
      .object({
        paneId: z.string().min(1).max(512),
        placements: z.array(KeyedPlacementSchemaZ).max(256),
      })
      .strict(),
  )
  .max(24);
export type PaneGraphics = z.infer<typeof paneGraphicsSchema>;

export const kittyChunkLineSchema = z
  .object({
    kittyImageChunk: TerminalGraphicsBlobSchemaZ.extend({
      image: z.string().min(1).max(600).optional(),
      data: z
        .string()
        .max(Math.ceil(TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES / 3) * 4)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
    }).strict(),
  })
  .strict();

export const kittyMissingSchema = z
  .object({
    kind: z.literal("kitty-missing"),
    digests: z.array(TerminalGraphicsDigestSchemaZ).min(1).max(64),
  })
  .strict();

export function parseKnownDigests(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .filter((digest) => TerminalGraphicsDigestSchemaZ.safeParse(digest).success)
    .slice(0, MAX_KNOWN_DIGESTS);
}

/** Live helper side: one instance per pane-stream connection. */
export function createKittyGraphicsReceiver(options: {
  readonly known: Iterable<string>;
  readonly request: (pane: string, digests: string[]) => void;
  readonly emit: (line: string) => void;
}) {
  const states = new Map<string, TerminalGraphicsState>();
  let takesCellPixels = false;
  let takesPreciseCellPixels = false;
  // Image ids each pane's last publication showed.
  const visible = new Map<string, Set<number>>();
  // Digests the window holds or that are in flight to it.
  const held = new Set(options.known);
  const pull = (pane: string, digests: Iterable<string>) => {
    const missing = [...new Set(digests)].filter((digest) => !held.has(digest));
    if (missing.length === 0) return;
    for (const digest of missing) held.add(digest);
    options.request(pane, missing);
  };
  const imageKey = (pane: string, imageId: number) => `${pane}#${imageId}`;
  return {
    /**
     * Accept new state. Returns true only when placements could have moved
     * (images added or removed, placeholder grids or cursor placements
     * changed); a redraw of a visible image only needs its bytes.
     */
    state(pane: string, state: TerminalGraphicsState): boolean {
      if (state.cellPixels) takesCellPixels = true;
      if (state.preciseCellPixels) takesPreciseCellPixels = true;
      const previous = states.get(pane);
      states.set(pane, state);
      const shown = visible.get(pane);
      if (shown)
        pull(
          pane,
          state.images.filter((image) => shown.has(image.imageId)).map((image) => image.digest),
        );
      if (!previous) return true;
      const shape = (s: TerminalGraphicsState) => {
        const ids = new Map(s.images.map((image) => [image.digest, image.imageId]));
        return JSON.stringify([
          s.images.map((image) => [image.imageId, image.placeholder]),
          s.placements.map(({ digest, ...rest }) => [ids.get(digest), rest]),
        ]);
      };
      return shape(previous) !== shape(state);
    },
    blob(pane: string, blob: TerminalGraphicsBlob, bytes: Uint8Array): void {
      // The daemon pushes redrawn images unasked; never request them again.
      held.add(blob.digest);
      const image = states.get(pane)?.images.find((entry) => entry.digest === blob.digest);
      options.emit(
        JSON.stringify({
          kittyImageChunk: {
            ...blob,
            ...(image ? { image: imageKey(pane, image.imageId) } : {}),
            data: Buffer.from(bytes).toString("base64"),
          },
        }) + "\n",
      );
    },
    /** Placements for one published pane snapshot; pulls missing bytes. */
    placements(pane: string, snapshot: TerminalReplicaSnapshot): KeyedPlacement[] {
      const state = states.get(pane);
      if (!state || state.images.length === 0) {
        visible.delete(pane);
        return [];
      }
      const shown = new Set<number>();
      const placements = resolveKittyImagePlacements(snapshot.grid, state).flatMap(
        ({ placement: p, imageId }) => {
          const clipped = clipPlacement(p, snapshot.rows, snapshot.cols);
          if (!clipped) return [];
          shown.add(imageId);
          return [{ ...clipped, image: imageKey(pane, imageId) }];
        },
      );
      visible.set(pane, shown);
      pull(
        pane,
        placements.map((p) => p.digest),
      );
      return placements;
    },
    /** True once the daemon said it accepts the window's cell pixel size. */
    takesPreciseCellPixels(): boolean {
      return takesPreciseCellPixels;
    },
    takesCellPixels(): boolean {
      return takesCellPixels;
    },
    /** The window evicted or never received these; fetch again when next visible. */
    missing(digests: readonly string[]): void {
      for (const digest of digests) held.delete(digest);
    },
    retire(): void {
      states.clear();
    },
  };
}

/** Clip the target cells while retaining the original source grid. */
function clipPlacement<T extends { row: number; column: number; rows: number; columns: number }>(
  placement: T,
  rows: number,
  columns: number,
): T | null {
  const height = Math.min(placement.rows, rows - placement.row);
  const width = Math.min(placement.columns, columns - placement.column);
  if (height <= 0 || width <= 0) return null;
  return { ...placement, rows: height, columns: width };
}

/** Canvas placements: pane-local placements moved to each pane's content origin. */
export function canvasPlacements(
  layout: Layout | undefined,
  panes: PaneGraphics,
): KeyedPlacement[] {
  if (!layout) return [];
  const placements: KeyedPlacement[] = [];
  for (const { paneId, placements: local } of panes) {
    const pane = layout.panes.find((p) => p.pane === paneId);
    if (!pane) continue;
    const content = contentRect(layout, pane);
    for (const placement of local) {
      const clipped = clipPlacement(placement, content.rows, pane.width);
      if (!clipped) continue;
      placements.push({
        ...clipped,
        row: placement.row + content.top,
        column: placement.column + pane.left,
      });
    }
  }
  return placements;
}

/** Browser side: which digests the window holds (bounded, oldest forgotten first). */
export function createKnownDigests(limit = MAX_KNOWN_DIGESTS) {
  const known = new Set<string>();
  return {
    observe(chunk: TerminalGraphicsBlob & { data: string }): void {
      const length = Buffer.byteLength(chunk.data, "base64");
      if (chunk.offset + length < chunk.total) return;
      known.delete(chunk.digest);
      known.add(chunk.digest);
      while (known.size > limit) known.delete(known.values().next().value!);
    },
    forget(digests: readonly string[]): void {
      for (const digest of digests) known.delete(digest);
    },
    env(): string {
      return [...known].join(",");
    },
  };
}
