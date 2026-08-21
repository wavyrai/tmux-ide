import { OptionalFeatureRegistry } from "./optional-feature-registry.ts";

export interface ApplicationOptionalFeatures {
  readonly home: typeof import("../features/home/feature.tsx");
  readonly files: typeof import("../features/files/feature.tsx");
  readonly changes: typeof import("../features/changes/feature.tsx");
  readonly missionsActivity: typeof import("../features/missions-activity/feature.tsx");
  readonly dialogs: typeof import("../features/dialogs/feature.tsx");
  readonly settings: typeof import("../features/settings/feature.ts");
  readonly palette: typeof import("../features/palette/feature.ts");
  readonly richPreview: typeof import("../features/rich-preview/feature.tsx");
  readonly performanceHud: typeof import("../features/performance-hud/feature.tsx");
}

/** Literal imports keep each admitted module discoverable by Bun's compiler. */
export function createApplicationOptionalFeatureRegistry(): OptionalFeatureRegistry<ApplicationOptionalFeatures> {
  return new OptionalFeatureRegistry<ApplicationOptionalFeatures>({
    home: () => import("../features/home/feature.tsx"),
    dialogs: () => import("../features/dialogs/feature.tsx"),
    settings: () => import("../features/settings/feature.ts"),
    palette: () => import("../features/palette/feature.ts"),
    richPreview: () => import("../features/rich-preview/feature.tsx"),
    performanceHud: () => import("../features/performance-hud/feature.tsx"),
  });
}
