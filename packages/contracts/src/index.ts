/**
 * @tmux-ide/contracts — shared Zod schemas for the daemon ↔ dashboard
 * boundary. Dashboard, packages/daemon, and any future v2 surfaces all
 * import from this single source of truth.
 *
 * Adding a schema? Put it in either `domain.ts` (runtime data: tasks,
 * missions, sessions, …) or `ide-config.ts` (the on-disk ide.yml
 * shape). Both files are re-exported wholesale below — no manual
 * registration needed.
 *
 * The `lib-internal/` directory holds schema-only helpers (auth, hq)
 * that ide-config depends on — they are exported transitively here
 * so consumers don't have to deep-import.
 */

export * from "./lib-internal/auth.ts";
export * from "./lib-internal/hq.ts";
export * from "./ide-config.ts";
export * from "./domain.ts";
export * from "./mission-projections.ts";
export * from "./tmux.ts";
export * from "./workspace.ts";
export * from "./workspace-state.ts";
export * from "./app-window-state.ts";
export * from "./workspace-config.ts";
export * from "./actions-contract.ts";
export * from "./actions-errors.ts";
export * from "./terminals.ts";
export * from "./control.ts";
export * from "./commands.ts";
