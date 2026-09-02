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
  type ResizeIdentity = Readonly<{
    lane: NonNullable<OpenTuiGenerationHostSnapshot["fastLane"]>;
    daemonGeneration: string;
    rendererEpoch: number;
    cols: number;
    rows: number;
  }>;
  let applied: ResizeIdentity | null = null;
  let pending: ResizeIdentity | null = null;
  const same = (left: ResizeIdentity | null, right: ResizeIdentity): boolean =>
    left?.lane === right.lane &&
    left.daemonGeneration === right.daemonGeneration &&
    left.rendererEpoch === right.rendererEpoch &&
    left.cols === right.cols &&
    left.rows === right.rows;

  return Object.freeze({
    adopt(dimensions, semantic, generation) {
      if (disposed) return;
      if (
        semantic === null ||
        generation?.status !== "live" ||
        generation.daemonGeneration === null ||
        generation.fastLane === null
      ) {
        applied = null;
        pending = null;
        return;
      }
      const viewport = applicationShellViewport(dimensions, true);
      const lane = generation.fastLane;
      const target = Object.freeze({
        lane,
        daemonGeneration: generation.daemonGeneration,
        rendererEpoch: generation.rendererEpoch,
        cols: viewport.width,
        rows: viewport.height,
      });
      if (same(applied, target) || same(pending, target)) return;
      pending = target;
      void lane.lane.resize({ cols: viewport.width, rows: viewport.height }).then(
        (outcome) => {
          if (disposed || pending !== target) return;
          pending = null;
          if (outcome.status === "applied") applied = target;
        },
        () => {
          if (pending === target) pending = null;
        },
      );
    },
    dispose() {
      disposed = true;
      applied = null;
      pending = null;
    },
  });
}
