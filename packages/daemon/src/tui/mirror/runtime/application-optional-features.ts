import { OptionalFeatureRegistry } from "./optional-feature-registry.ts";

export interface ApplicationOptionalFeatures {
  readonly files: typeof import("../features/files/feature.tsx");
  readonly changes: typeof import("../features/changes/feature.tsx");
  readonly missionsActivity: typeof import("../features/missions-activity/feature.tsx");
  readonly dialogs: typeof import("../features/dialogs/feature.tsx");
  readonly settings: typeof import("../features/settings/feature.ts");
  readonly palette: typeof import("../features/palette/feature.ts");
  readonly richPreview: typeof import("../features/rich-preview/feature.tsx");
}

/** Literal imports keep every optional module discoverable by Bun's compiler. */
export function createApplicationOptionalFeatureRegistry(): OptionalFeatureRegistry<ApplicationOptionalFeatures> {
  return new OptionalFeatureRegistry<ApplicationOptionalFeatures>({
    files: () => import("../features/files/feature.tsx"),
    changes: () => import("../features/changes/feature.tsx"),
    missionsActivity: () => import("../features/missions-activity/feature.tsx"),
    dialogs: () => import("../features/dialogs/feature.tsx"),
    settings: () => import("../features/settings/feature.ts"),
    palette: () => import("../features/palette/feature.ts"),
    richPreview: () => import("../features/rich-preview/feature.tsx"),
  });
}
