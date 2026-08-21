/**
 * Bootstrap roots for the production OpenTUI application. Architecture audits
 * start here and follow the transitive local import graph, including literal
 * dynamic feature imports; this list is not itself the complete source graph.
 *
 * This manifest is test support, not an engine dependency on the TUI adapter.
 */
export const OPENTUI_PRODUCTION_ROOT_SOURCES = [
  "packages/daemon/src/tui/mirror/app.tsx",
  "packages/daemon/src/tui/mirror/runtime/application-entry.ts",
  "packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx",
] as const;

/** The single Solid root that a production bundle is allowed to load. */
export const OPENTUI_PRODUCTION_APPLICATION_ROOT =
  "packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx" as const;

/**
 * Runtime modules removed from the production boot graph by the M59.3 cutover.
 * The source files can remain temporarily for isolated compatibility tests, but
 * reaching one from `app.tsx` is a production architecture regression.
 */
export const OPENTUI_RETIRED_PRODUCTION_MODULES = [
  "packages/daemon/src/tui/mirror/runtime/application-root.tsx",
  "packages/daemon/src/tui/mirror/application-shell-daemon-runtime.ts",
  "packages/daemon/src/tui/mirror/runtime/terminal-workspace-adapter.ts",
  "packages/daemon/src/tui/mirror/runtime/pane-scoped-terminal-owner.ts",
  "packages/daemon/src/tui/mirror/runtime/terminal-authority-input.ts",
  "packages/daemon/src/tui/mirror/runtime/workspace-open-handoff-client.ts",
] as const;

/** Renderer and lifecycle seams that must stay reachable from the tiny root. */
export const OPENTUI_REQUIRED_PRODUCTION_MODULES = [
  "packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx",
  "packages/daemon/src/tui/mirror/runtime/application-bootstrap.ts",
  "packages/daemon/src/tui/mirror/runtime/application-lifecycle.ts",
  "packages/daemon/src/tui/mirror/runtime/terminal-fast-lane-renderer-adapter.ts",
  "packages/daemon/src/tui/mirror/runtime/pane-scoped-terminal-surface.tsx",
  "packages/daemon/src/tui/mirror/runtime/host-local-tmux-adapter.ts",
] as const;

export type OpenTuiProductionRootSource = (typeof OPENTUI_PRODUCTION_ROOT_SOURCES)[number];
