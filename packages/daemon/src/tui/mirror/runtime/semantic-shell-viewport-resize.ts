import type { ApplicationShellProjectionV1 } from "@tmux-ide/contracts";

import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import { applicationShellViewport } from "./application-shell-viewport.ts";

type Dimensions = Readonly<{ width: number; height: number }>;

/**
 * Owns the one semantic-shell viewport resize for the current generation.
 * Provisional local chrome is intentionally not terminal geometry authority.
 */
export function createSemanticShellViewportResizeOwner(): Readonly<{
  adopt(
    dimensions: Dimensions,
    semantic: ApplicationShellProjectionV1 | null,
    generation: OpenTuiGenerationHostSnapshot | null,
  ): void;
  dispose(): void;
}> {
  let disposed = false;
  let last: Readonly<{
    lane: NonNullable<OpenTuiGenerationHostSnapshot["fastLane"]>;
    daemonGeneration: string;
    rendererEpoch: number;
    cols: number;
    rows: number;
  }> | null = null;

  return Object.freeze({
    adopt(dimensions, semantic, generation) {
      if (disposed) return;
      if (
        semantic === null ||
        generation?.status !== "live" ||
        generation.daemonGeneration === null ||
        generation.fastLane === null
      ) {
        last = null;
        return;
      }
      const viewport = applicationShellViewport(dimensions, true);
      const lane = generation.fastLane;
      if (
        last?.lane === lane &&
        last.daemonGeneration === generation.daemonGeneration &&
        last.rendererEpoch === generation.rendererEpoch &&
        last.cols === viewport.width &&
        last.rows === viewport.height
      )
        return;
      last = Object.freeze({
        lane,
        daemonGeneration: generation.daemonGeneration,
        rendererEpoch: generation.rendererEpoch,
        cols: viewport.width,
        rows: viewport.height,
      });
      void lane.lane.resize({ cols: viewport.width, rows: viewport.height });
    },
    dispose() {
      disposed = true;
      last = null;
    },
  });
}
