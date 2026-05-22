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
export * from "./tmux.ts";
export * from "./workspace.ts";
export * from "./routes.ts";
export * from "./client.ts";
export * from "./ws-v3-protocol.ts";
export * from "./actions-contract.ts";
export * from "./actions-errors.ts";
export * from "./chat-thread.ts";
export * from "./chat-timeline.ts";
export * from "./git.ts";
export * from "./github.ts";
export * from "./terminals.ts";
export * from "./notes-contract.ts";
