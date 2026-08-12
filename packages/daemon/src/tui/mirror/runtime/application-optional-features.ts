import { OptionalFeatureRegistry } from "./optional-feature-registry.ts";

export interface ApplicationOptionalFeatures {
  readonly files: typeof import("../features/files/feature.tsx");
  readonly changes: typeof import("../features/changes/feature.tsx");
  readonly missionsActivity: typeof import("../features/missions-activity/feature.tsx");
  readonly palette: typeof import("../workspace/command-palette-surface.tsx");
  readonly richPreview: typeof import("../widget-surface.tsx");
}

/** Literal imports keep every optional module discoverable by Bun's compiler. */
export function createApplicationOptionalFeatureRegistry(): OptionalFeatureRegistry<ApplicationOptionalFeatures> {
  return new OptionalFeatureRegistry<ApplicationOptionalFeatures>({
    files: () => import("../features/files/feature.tsx"),
    changes: () => import("../features/changes/feature.tsx"),
    missionsActivity: () => import("../features/missions-activity/feature.tsx"),
    palette: () => import("../workspace/command-palette-surface.tsx"),
    richPreview: () => import("../widget-surface.tsx"),
  });
}
