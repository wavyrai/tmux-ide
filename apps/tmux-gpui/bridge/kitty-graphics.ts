/**
 * Kitty graphics on the bridge: per-pane image registries from the daemon,
 * placements resolved against the exact snapshots the bridge publishes, and
 * image bytes pulled lazily — only digests a visible placement needs and the
 * native window does not already hold — then forwarded as bounded chunk lines.
 */
import { z } from "zod";
import { resolveKittyPlacements } from "../../../packages/core/src/kitty-placeholders.ts";
import {
  TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES,
  TerminalGraphicsBlobSchemaZ,
  TerminalGraphicsDigestSchemaZ,
  TerminalGraphicsPlacementSchemaZ,
  type TerminalGraphicsBlob,
  type TerminalGraphicsPlacement,
  type TerminalGraphicsState,
} from "../../../packages/contracts/src/terminal-graphics.ts";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";
import type { Layout } from "./topology.ts";
import { contentRect } from "./window-canvas.ts";

/** Digests the native window already holds, handed to each new pane helper. */
export const KITTY_KNOWN_ENV = "TMUX_IDE_KITTY_KNOWN";
export const MAX_KNOWN_DIGESTS = 2048;

export const paneGraphicsSchema = z
  .array(
    z
      .object({
        paneId: z.string().min(1).max(512),
        placements: z.array(TerminalGraphicsPlacementSchemaZ).max(256),
      })
      .strict(),
  )
  .max(24);
export type PaneGraphics = z.infer<typeof paneGraphicsSchema>;

export const kittyChunkLineSchema = z
  .object({
    kittyImageChunk: TerminalGraphicsBlobSchemaZ.extend({
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
  // Digests the window holds or that are in flight to it.
  const held = new Set(options.known);
  return {
    state(pane: string, state: TerminalGraphicsState): void {
      states.set(pane, state);
    },
    blob(blob: TerminalGraphicsBlob, bytes: Uint8Array): void {
      options.emit(
        JSON.stringify({
          kittyImageChunk: { ...blob, data: Buffer.from(bytes).toString("base64") },
        }) + "\n",
      );
    },
    /** Placements for one published pane snapshot; pulls missing bytes. */
    placements(pane: string, snapshot: TerminalReplicaSnapshot): TerminalGraphicsPlacement[] {
      const state = states.get(pane);
      if (!state || state.images.length === 0) return [];
      const placements = resolveKittyPlacements(snapshot.grid, state).filter(
        (p) => p.row + p.rows <= snapshot.rows && p.column + p.columns <= snapshot.cols,
      );
      const missing = [...new Set(placements.map((p) => p.digest))].filter((d) => !held.has(d));
      if (missing.length > 0) {
        for (const digest of missing) held.add(digest);
        options.request(pane, missing);
      }
      return placements;
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

/** Canvas placements: pane-local placements moved to each pane's content origin. */
export function canvasPlacements(
  layout: Layout | undefined,
  panes: PaneGraphics,
): TerminalGraphicsPlacement[] {
  if (!layout) return [];
  const placements: TerminalGraphicsPlacement[] = [];
  for (const { paneId, placements: local } of panes) {
    const pane = layout.panes.find((p) => p.pane === paneId);
    if (!pane) continue;
    const content = contentRect(layout, pane);
    for (const placement of local) {
      if (
        placement.row + placement.rows > content.rows ||
        placement.column + placement.columns > pane.width
      )
        continue;
      placements.push({
        ...placement,
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
