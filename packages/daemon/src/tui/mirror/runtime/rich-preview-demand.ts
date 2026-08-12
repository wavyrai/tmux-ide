import type { SemanticPaneCanonicalSnapshot } from "../semantic-pane-render-source.ts";
import type { RichPlacementProjection } from "../rich-placement-projection.ts";

export interface RichPreviewCanonicalDemand {
  readonly canonical: SemanticPaneCanonicalSnapshot;
  readonly placements: readonly RichPlacementProjection[];
}

/** Lightweight root policy: no optional feature or IO is touched without visible terminal demand. */
export function collectRichPreviewCanonicalDemand(input: {
  readonly admitted: boolean;
  readonly terminalsVisible: boolean;
  readonly paneIds: readonly string[];
  readonly placementsFor: (paneId: string) => readonly RichPlacementProjection[];
  readonly canonicalFor: (paneId: string) => SemanticPaneCanonicalSnapshot | null;
}): readonly RichPreviewCanonicalDemand[] {
  if (!input.admitted || !input.terminalsVisible) return [];
  return input.paneIds.flatMap((paneId) => {
    const placements = input
      .placementsFor(paneId)
      .filter((placement) => placement.visible && placement.hostRect !== null);
    if (placements.length === 0) return [];
    const canonical = input.canonicalFor(paneId);
    return canonical ? [{ canonical, placements }] : [];
  });
}
