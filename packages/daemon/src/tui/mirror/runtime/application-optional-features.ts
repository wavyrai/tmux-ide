import { OptionalFeatureRegistry } from "./optional-feature-registry.ts";

export interface ApplicationOptionalFeatures {
  readonly files: typeof import("../features/files/feature.tsx");
  readonly changes: typeof import("../features/changes/feature.tsx");
  readonly missions: typeof import("../missions-surface.tsx");
  readonly activity: typeof import("../activity-surface.tsx");
  readonly palette: typeof import("../workspace/command-palette-surface.tsx");
  readonly richPreview: typeof import("../widget-surface.tsx");
}

/** Literal imports keep every optional module discoverable by Bun's compiler. */
export function createApplicationOptionalFeatureRegistry(): OptionalFeatureRegistry<ApplicationOptionalFeatures> {
  return new OptionalFeatureRegistry<ApplicationOptionalFeatures>({
    files: () => import("../features/files/feature.tsx"),
    changes: () => import("../features/changes/feature.tsx"),
    missions: () => import("../missions-surface.tsx"),
    activity: () => import("../activity-surface.tsx"),
    palette: () => import("../workspace/command-palette-surface.tsx"),
    richPreview: () => import("../widget-surface.tsx"),
  });
}
