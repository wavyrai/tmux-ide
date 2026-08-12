/**
 * Bootstrap roots for the production OpenTUI application. Architecture audits
 * start here and follow the transitive local import graph, including literal
 * dynamic feature imports; this list is not itself the complete source graph.
 */
export const OPENTUI_PRODUCTION_ROOT_SOURCES = [
  "packages/daemon/src/tui/mirror/app.tsx",
  "packages/daemon/src/tui/mirror/runtime/application-entry.ts",
  "packages/daemon/src/tui/mirror/runtime/application-root.tsx",
] as const;

export type OpenTuiProductionRootSource = (typeof OPENTUI_PRODUCTION_ROOT_SOURCES)[number];
