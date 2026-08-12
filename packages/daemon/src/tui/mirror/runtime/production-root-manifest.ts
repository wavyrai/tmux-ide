/**
 * Source roots that together constitute the production OpenTUI application.
 * Architecture audits must inspect this complete manifest instead of assuming
 * the public entry contains the production root implementation.
 */
export const OPENTUI_PRODUCTION_ROOT_SOURCES = [
  "packages/daemon/src/tui/mirror/app.tsx",
  "packages/daemon/src/tui/mirror/runtime/application-entry.ts",
  "packages/daemon/src/tui/mirror/runtime/application-root.tsx",
] as const;

export type OpenTuiProductionRootSource = (typeof OPENTUI_PRODUCTION_ROOT_SOURCES)[number];
